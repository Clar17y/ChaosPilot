import * as crypto from 'node:crypto';
import type {
  Experiment,
  ExperimentProvider,
  ProviderContext,
  ProviderKind,
  ProviderReply,
  ProviderRequestAudit,
  ProviderResponseAudit,
  RequestAuditCallback,
  Usage
} from '../domain.ts';
import {
  BudgetLedger,
  MODEL_PRICING,
  calculateCost,
  calculateWorstCaseCost
} from './budget.ts';
import {
  getPromptIdentity,
  buildInvestigationPrompt,
  computePromptHash
} from '../investigation/prompt.ts';
import { canonicalJson } from '../evidence.ts';

export interface MetaProviderOptions {
  model?: string;
  reasoningEffort?: string;
  apiKey?: string;
  baseUrl?: string;
  ledgerPath?: string;
  totalBudgetUsd?: number;
  maxPromptBytes?: number;
  maxOutputTokens?: number;
  requestTimeoutMs?: number;
  fetchFn?: typeof fetch;
  ledger?: BudgetLedger;
}

export const DEFAULT_MAX_PROMPT_BYTES = 131072;
export const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

export class MetaProvider implements ExperimentProvider {
  public readonly kind: ProviderKind = 'meta';
  public readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly maxPromptBytes: number;
  private readonly maxOutputTokens: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly ledger: BudgetLedger;
  private readonly reasoningEffort: string;

  constructor(options: MetaProviderOptions = {}) {
    this.model = options.model || process.env['META_MODEL'] || 'muse-wonder-1.0';
    if (!Object.hasOwn(MODEL_PRICING, this.model)) {
      throw new Error(`Unsupported model: ${this.model}. Supported models: ${Object.keys(MODEL_PRICING).join(', ')}`);
    }

    this.apiKey = options.apiKey || process.env['MODEL_API_KEY'];
    this.baseUrl = (options.baseUrl || 'https://api.meta.ai/v1').replace(/\/+$/, '');
    this.reasoningEffort = options.reasoningEffort ?? process.env['META_REASONING_EFFORT'] ?? 'low';
    if (!['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(this.reasoningEffort)) {
      throw new Error('Invalid META_REASONING_EFFORT: use minimal, low, medium, high, xhigh or max');
    }

    const envPromptBytesStr = process.env['CHAOSPILOT_MAX_PROMPT_BYTES'];
    let envPromptBytes: number | undefined;
    if (envPromptBytesStr !== undefined) {
      const parsed = Number(envPromptBytesStr);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        envPromptBytes = parsed;
      } else {
        throw new Error(`Invalid CHAOSPILOT_MAX_PROMPT_BYTES: "${envPromptBytesStr}". Must be a bounded positive integer.`);
      }
    }
    const resolvedPromptBytes = options.maxPromptBytes ?? envPromptBytes ?? DEFAULT_MAX_PROMPT_BYTES;
    if (!Number.isSafeInteger(resolvedPromptBytes) || resolvedPromptBytes <= 0) {
      throw new Error(`Invalid maxPromptBytes: ${resolvedPromptBytes}. Must be a bounded positive integer.`);
    }
    this.maxPromptBytes = resolvedPromptBytes;

    const envOutputTokensStr = process.env['CHAOSPILOT_MAX_OUTPUT_TOKENS'];
    let envOutputTokens: number | undefined;
    if (envOutputTokensStr !== undefined) {
      const parsed = Number(envOutputTokensStr);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        envOutputTokens = parsed;
      } else {
        throw new Error(`Invalid CHAOSPILOT_MAX_OUTPUT_TOKENS: "${envOutputTokensStr}". Must be a bounded positive integer.`);
      }
    }
    const resolvedOutputTokens = options.maxOutputTokens ?? envOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    if (!Number.isSafeInteger(resolvedOutputTokens) || resolvedOutputTokens <= 0) {
      throw new Error(`Invalid maxOutputTokens: ${resolvedOutputTokens}. Must be a bounded positive integer.`);
    }
    this.maxOutputTokens = resolvedOutputTokens;

    const resolvedTimeout = options.requestTimeoutMs ?? Number(process.env['CHAOSPILOT_REQUEST_TIMEOUT_MS'] ?? 90000);
    if (!Number.isSafeInteger(resolvedTimeout) || resolvedTimeout <= 0 || resolvedTimeout > 120000) {
      throw new Error(`Invalid requestTimeoutMs: ${resolvedTimeout}. Must be an integer from 1 to 120000.`);
    }
    this.requestTimeoutMs = resolvedTimeout;

    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.ledger = options.ledger ?? new BudgetLedger(options.ledgerPath, options.totalBudgetUsd);
  }

  public getLedger(): BudgetLedger {
    return this.ledger;
  }

  public get configuration(): Record<string, string | number> {
    return {
      model: this.model, reasoningEffort: this.reasoningEffort, temperature: 0.2,
      maxPromptBytes: this.maxPromptBytes, maxOutputTokens: this.maxOutputTokens,
      requestTimeoutMs: this.requestTimeoutMs
    };
  }

  private sanitize(text: string): string {
    if (!this.apiKey) return text;
    return text.replaceAll(this.apiKey, '[REDACTED_API_KEY]');
  }

  private auditedError(error: unknown, requestSent: boolean, requestAudit?: ProviderRequestAudit,
    responseAudit?: ProviderResponseAudit, usage?: Usage): Error {
    const safe = new Error(this.sanitize(error instanceof Error ? error.message : 'Unknown provider failure'));
    if (error instanceof Error) safe.name = error.name;
    return Object.assign(safe, {
      requestSent, requestAudit, responseAudit, usage,
      usageKnown: usage !== undefined || !requestSent
    });
  }

  public serializePrompt(context: ProviderContext): { systemMessage: string; userMessage: string } {
    return buildInvestigationPrompt(context);
  }

  /** Pure preparation shared by preflight and propose: no ledger access or network I/O. */
  public prepareRequest(context: ProviderContext) {
    const serialize = (prompt: { systemMessage: string; userMessage: string }) => {
      const systemMessage = this.sanitize(prompt.systemMessage);
      const userMessage = this.sanitize(prompt.userMessage);
      const serializedPayload = canonicalJson({
        model: this.model,
        messages: [{ role: 'system', content: systemMessage }, { role: 'user', content: userMessage }],
        max_tokens: this.maxOutputTokens, reasoning_effort: this.reasoningEffort,
        temperature: 0.2, response_format: { type: 'json_object' }
      });
      return { systemMessage, userMessage, serializedPayload, promptBytes: Buffer.byteLength(serializedPayload, 'utf-8') };
    };
    let prepared = serialize(this.serializePrompt(context));
    let historyCompaction: ProviderRequestAudit['historyCompaction'];
    // Keep the original prompt when it fits. Otherwise summarize, then drop oldest
    // summaries deterministically. Source, contract, brief and feedback stay intact.
    for (let start = 0; prepared.promptBytes > this.maxPromptBytes && start <= context.history.length && context.history.length > 0; start++) {
      prepared = serialize(buildInvestigationPrompt(context, { start }));
      historyCompaction = { totalObservations: context.history.length, summarizedObservations: context.history.length - start, omittedObservations: start };
    }
    return { ...prepared, historyCompaction, maxPromptBytes: this.maxPromptBytes, maxOutputTokens: this.maxOutputTokens };
  }

  public async propose(
    context: ProviderContext,
    signal?: AbortSignal,
    onRequestAudit?: RequestAuditCallback
  ): Promise<ProviderReply> {
    // 1. Pre-aborted check
    if (signal?.aborted) {
      throw this.auditedError(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'), false);
    }

    // 2. Missing API key check (refuse before any reservation or request)
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw this.auditedError(new Error('Missing MODEL_API_KEY environment variable. Application limits do not control whole Meta account.'), false);
    }

    // 3. Serialize and validate prompt bounds
    const { systemMessage, userMessage, serializedPayload, promptBytes, historyCompaction } = this.prepareRequest(context);

    if (promptBytes > this.maxPromptBytes) {
      throw this.auditedError(new Error(`Prompt size (${promptBytes} bytes) exceeds maximum allowed size (${this.maxPromptBytes} bytes), even after available history compaction. Shorten the system brief or select a smaller source bundle, or explicitly raise CHAOSPILOT_MAX_PROMPT_BYTES within your budget. No request was sent.`), false);
    }

    const promptHash = computePromptHash(systemMessage, userMessage);
    const requestHash = crypto.createHash('sha256').update(serializedPayload, 'utf-8').digest('hex');

    const requestAudit: ProviderRequestAudit = {
      promptVersion: getPromptIdentity(context.systemBrief?.brief.adapterId).promptVersion,
      promptTemplateHash: getPromptIdentity(context.systemBrief?.brief.adapterId).promptTemplateHash,
      promptHash,
      requestHash,
      systemMessage,
      userMessage,
      configuration: this.configuration,
      ...(historyCompaction ? { historyCompaction } : {})
    };

    let reservationId: string | undefined;
    let requestSent = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let combinedSignal: AbortSignal | undefined;
    let timeoutController: AbortController | undefined;
    let responseAudit: ProviderResponseAudit | undefined;
    let knownUsage: Usage | undefined;

    try {
      // Callback observer before network and before ledger reservation
      if (onRequestAudit) {
        await onRequestAudit(requestAudit);
      }

      if (signal?.aborted) {
        throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
      }

      // 4. Reserve conservative worst-case budget (persisted atomically before network)
      const worstCaseCost = calculateWorstCaseCost(this.model, this.maxPromptBytes, this.maxOutputTokens);
      reservationId = this.ledger.reserve(worstCaseCost, this.model);

      // 5. Setup timeouts and signals covering BOTH headers and full body consumption
      timeoutController = new AbortController();
      timeoutTimer = setTimeout(() => {
        timeoutController?.abort(new DOMException(`Request timed out after ${this.requestTimeoutMs}ms`, 'TimeoutError'));
      }, this.requestTimeoutMs);

      if (signal) {
        combinedSignal = AbortSignal.any([signal, timeoutController.signal]);
      } else {
        combinedSignal = timeoutController.signal;
      }

      let response: Response;
      let responseData: {
        choices?: Array<{
          finish_reason?: string;
          message?: { content?: string };
        }>;
        usage?: {
          prompt_tokens?: unknown;
          completion_tokens?: unknown;
        };
      };

      try {
        requestSent = true;
        response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`
          },
          body: serializedPayload,
          redirect: 'error',
          signal: combinedSignal
        });

        if (!response.ok) {
          // Unknown billing on HTTP errors: retain worst-case cost
          if (reservationId !== undefined) {
            this.ledger.retainWorstCase(reservationId, `HTTP ${response.status} ${response.statusText}`);
            reservationId = undefined;
          }
          throw new Error(this.sanitize(`Meta API request failed with status ${response.status}`));
        }

        // Keep deadline active through complete body consumption and JSON parsing
        responseData = await response.json() as typeof responseData;
        const visible = responseData?.choices?.[0];
        const visibleContent = typeof visible?.message?.content === 'string' ? this.sanitize(visible.message.content) : undefined;
        responseAudit = {
          content: visibleContent?.slice(0, 32768),
          ...(visibleContent && visibleContent.length > 32768 ? { contentTruncated: true, contentLength: visibleContent.length } : {}),
          finishReason: typeof visible?.finish_reason === 'string' ? this.sanitize(visible.finish_reason) : undefined
        };
      } finally {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = undefined;
        }
      }

      // Validate usage metrics
      const promptTokens = responseData?.usage?.prompt_tokens;
      const completionTokens = responseData?.usage?.completion_tokens;

      if (
        typeof promptTokens !== 'number' ||
        typeof completionTokens !== 'number' ||
        !Number.isSafeInteger(promptTokens) ||
        !Number.isSafeInteger(completionTokens) ||
        promptTokens < 0 ||
        completionTokens < 0
      ) {
        if (reservationId !== undefined) {
          this.ledger.retainWorstCase(reservationId, 'Missing or invalid usage in API response');
          reservationId = undefined;
        }
        throw new Error('API response contained missing or invalid usage metrics');
      }

      if (completionTokens > this.maxOutputTokens) {
        if (reservationId !== undefined) {
          this.ledger.retainWorstCase(reservationId, 'Output tokens exceeded maximum limit');
          reservationId = undefined;
        }
        throw new Error(`Output tokens (${completionTokens}) exceeded maximum allowed limit (${this.maxOutputTokens})`);
      }

      const actualCost = calculateCost(this.model, promptTokens, completionTokens);
      const usage: Usage = {
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        estimatedCostUsd: actualCost
      };
      knownUsage = usage;
      this.ledger.commit(reservationId, actualCost);
      reservationId = undefined;

      const choice = responseData?.choices?.[0];
      const finishReason = choice?.finish_reason;
      const rawContent = choice?.message?.content;
      const sanitizedContent = typeof rawContent === 'string' ? this.sanitize(rawContent) : rawContent;

      let experiment: Experiment | null = null;
      let validationError: string | undefined;
      let summary = '';

      if (!choice) {
        validationError = 'Model response did not include a completion choice';
        summary = 'Missing completion choice';
      } else if (finishReason === 'length') {
        validationError = 'Model response was truncated due to max_tokens limit';
        summary = 'Model response truncated by token limit';
      } else if (rawContent !== undefined && rawContent !== null && typeof rawContent !== 'string') {
        validationError = 'Model response content must be text containing a JSON object';
        summary = 'Unexpected response content type';
      } else if (sanitizedContent === undefined || sanitizedContent === null || (typeof sanitizedContent === 'string' && sanitizedContent.trim() === '')) {
        if (finishReason === 'stop') {
          // Intentional stop with no experiment
          summary = 'Model completed proposals with empty response';
        } else {
          validationError = 'Model returned empty response content without intentional stop';
          summary = 'Empty model response';
        }
      } else {
        try {
          const parsed = typeof sanitizedContent === 'string' ? JSON.parse(sanitizedContent) : sanitizedContent;
          if (parsed && typeof parsed === 'object' && parsed.done === true && typeof parsed.summary === 'string') {
            summary = this.sanitize(parsed.summary);
          } else if (parsed && typeof parsed === 'object' && typeof parsed.hypothesis === 'string' && Array.isArray(parsed.steps)) {
            experiment = parsed;
            summary = this.sanitize(parsed.hypothesis);
          } else {
            validationError = 'Model response did not match Experiment structure: missing hypothesis string or steps array';
            summary = 'Malformed experiment structure';
          }
        } catch (parseErr) {
          validationError = `Failed to parse JSON content from model response: ${parseErr instanceof Error ? this.sanitize(parseErr.message) : String(parseErr)}`;
          summary = 'Malformed JSON in model response';
        }
      }

      responseAudit.validationError = validationError ? this.sanitize(validationError) : undefined;

      return {
        experiment,
        usage,
        summary: this.sanitize(summary),
        validationError: validationError ? this.sanitize(validationError) : undefined,
        requestAudit,
        responseAudit,
        requestSent: true
      };
    } catch (err: unknown) {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }

      const isAbort = (err instanceof Error && err.name === 'AbortError') || (combinedSignal && combinedSignal.aborted);
      const isTimeout = (err instanceof Error && err.name === 'TimeoutError') || (timeoutController && timeoutController.signal.aborted);

      let failure = err;
      if (reservationId !== undefined) {
        try {
          this.ledger.retainWorstCase(reservationId, isAbort || isTimeout
            ? isTimeout ? 'Request timed out' : 'Request aborted'
            : err instanceof Error ? this.sanitize(err.message) : 'Unknown error');
        } catch (ledgerError) {
          const combined = new Error(`${err instanceof Error ? err.message : 'Provider failure'}; allowance persistence failed: ${ledgerError instanceof Error ? ledgerError.message : 'Unknown ledger failure'}`);
          if (err instanceof Error) combined.name = err.name;
          failure = combined;
        }
      }
      throw this.auditedError(failure, requestSent, requestAudit, responseAudit, knownUsage);
    }
  }
}
