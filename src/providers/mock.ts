import * as crypto from 'node:crypto';
import type {
  Experiment,
  ExperimentProvider,
  ProviderContext,
  ProviderKind,
  ProviderReply,
  ProviderRequestAudit,
  RequestAuditCallback
} from '../domain.ts';
import {
  getPromptIdentity,
  buildInvestigationPrompt,
  computePromptHash
} from '../investigation/prompt.ts';
import { canonicalJson } from '../evidence.ts';

export class MockProvider implements ExperimentProvider {
  public readonly kind: ProviderKind = 'mock';
  public readonly model: string = 'scripted-offline';

  constructor(_options: unknown = {}) {}

  public get configuration(): Record<string, string | number> {
    return { model: this.model };
  }

  public async propose(
    context: ProviderContext,
    signal?: AbortSignal,
    onRequestAudit?: RequestAuditCallback
  ): Promise<ProviderReply> {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
    }

    const { systemMessage, userMessage } = buildInvestigationPrompt(context);
    const promptHash = computePromptHash(systemMessage, userMessage);
    const mockPayload = {
      model: this.model,
      systemMessage,
      userMessage
    };
    const requestHash = crypto.createHash('sha256').update(canonicalJson(mockPayload), 'utf-8').digest('hex');

    const requestAudit: ProviderRequestAudit = {
      promptVersion: getPromptIdentity(context.systemBrief?.brief.adapterId).promptVersion,
      promptTemplateHash: getPromptIdentity(context.systemBrief?.brief.adapterId).promptTemplateHash,
      promptHash,
      requestHash,
      systemMessage,
      userMessage,
      configuration: this.configuration
    };

    if (onRequestAudit) {
      await onRequestAudit(requestAudit);
    }

    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
    }

    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0
    };

    if (context.systemBrief?.brief.adapterId === 'inventory-reservation') {
      const { inventoryProposal } = await import('./inventory-mock.ts');
      const experiment = inventoryProposal(context.history.length);
      return {
        experiment, usage, requestAudit, requestSent: false,
        summary: 'Scripted offline inventory sequence; no autonomous discovery claimed',
        responseAudit: { content: JSON.stringify(experiment ?? { done: true, summary: 'Scripted offline sequence exhausted' }), finishReason: 'stop' },
      };
    }

    const experimentIndex = context.history.length;

    // When a requirement check is configured, start with its existing offline
    // credit-admission fixture. This gives the workspace a reproducible demo
    // against candidate-c without changing mock runs that have no rule.
    if (experimentIndex === 0 && context.systemBrief?.brief.requirementRules?.some(
      rule => rule.preset === 'accepted-order-credit-limit'
    )) {
      const { getFaultCatalogEntry } = await import('../testing/fault-catalog.ts');
      const fixture = getFaultCatalogEntry('candidate-c')!.knownExperiment;
      const experiment: Experiment = {
        ...structuredClone(fixture),
        hypothesis: '[Scripted Offline Credit Check] Test credit admission after an earlier order is filled',
      };
      return {
        experiment,
        usage,
        summary: 'Scripted offline credit check; no autonomous discovery claimed',
        requestAudit,
        responseAudit: { content: JSON.stringify(experiment), finishReason: 'stop' },
        requestSent: false,
      };
    }

    // Sequence of deterministic scripted offline experiments:
    // 0: Normal baseline trading sequence (no defect expected)
    // 1: Duplication defect with partial fill (tests execution message deduplication on candidate-a within quantity bounds)
    // 2: Late fill defect (tests cancel vs fill arrival order on candidate-b)
    // 3+: null (sequence completed)

    if (experimentIndex === 0) {
      const experiment: Experiment = {
        hypothesis: '[Scripted Offline Baseline] Normal order placement and full execution maintains credit reservation and release',
        expectedInvariant: 'credit_limit_respected',
        steps: [
          { op: 'send', id: 'm-quote-1', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 100 } },
          { op: 'send', id: 'm-credit-1', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 1000 } },
          { op: 'drain' },
          { op: 'send', id: 'm-order-1', to: 'client', payload: { type: 'new_order', id: 'o1', orderId: 'ord-1', quantity: 5, quoteId: 'q1' } },
          { op: 'drain' },
          { op: 'fill', messageId: 'm-fill-1', orderId: 'ord-1', executionId: 'exec-1', quantity: 5 },
          { op: 'drain' }
        ]
      };

      return {
        experiment,
        usage,
        summary: 'Scripted offline baseline proposal (no autonomous discovery claimed)',
        requestAudit,
        responseAudit: {
          content: JSON.stringify(experiment),
          finishReason: 'stop'
        },
        requestSent: false
      };
    }

    if (experimentIndex === 1) {
      const experiment: Experiment = {
        hypothesis: '[Scripted Offline Duplication] Execution report redelivery with new messageId causes duplicate balance deduction if business executionId is not deduplicated',
        expectedInvariant: 'credit_limit_respected',
        steps: [
          { op: 'send', id: 'm-quote-1', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 100 } },
          { op: 'send', id: 'm-credit-1', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 1000 } },
          { op: 'drain' },
          { op: 'send', id: 'm-order-1', to: 'client', payload: { type: 'new_order', id: 'o1', orderId: 'ord-1', quantity: 5, quoteId: 'q1' } },
          { op: 'drain' },
          // Partial fill of 2 out of 5 quantity; duplicate fill is 2 more (total 4 <= 5), fitting remaining quantity bounds
          { op: 'fill', messageId: 'm-fill-1', orderId: 'ord-1', executionId: 'exec-dup-1', quantity: 2 },
          { op: 'duplicate', messageId: 'm-fill-1', id: 'm-fill-dup-1' },
          { op: 'drain' }
        ]
      };

      return {
        experiment,
        usage,
        summary: 'Scripted offline execution report duplicate proposal',
        requestAudit,
        responseAudit: {
          content: JSON.stringify(experiment),
          finishReason: 'stop'
        },
        requestSent: false
      };
    }

    if (experimentIndex === 2) {
      const experiment: Experiment = {
        hypothesis: '[Scripted Offline Chronology] When cancel acknowledgement arrives before earlier venue execution, reservation release calculation based on residual quantity corrupts credit',
        expectedInvariant: 'credit_limit_respected',
        steps: [
          { op: 'send', id: 'm-quote-1', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 100 } },
          { op: 'send', id: 'm-credit-1', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 1000 } },
          { op: 'drain' },
          { op: 'send', id: 'm-order-1', to: 'client', payload: { type: 'new_order', id: 'o1', orderId: 'ord-1', quantity: 5, quoteId: 'q1' } },
          { op: 'drain' },
          // Fill occurs at venue first but delivery is delayed (delay 10)
          { op: 'fill', messageId: 'm-fill-late', orderId: 'ord-1', executionId: 'exec-late-1', quantity: 2, delay: 10 },
          // Cancel occurs and delivers earlier (delay 1)
          { op: 'confirm_cancel', messageId: 'm-cancel-early', orderId: 'ord-1', delay: 1 },
          { op: 'drain' }
        ]
      };

      return {
        experiment,
        usage,
        summary: 'Scripted offline late-fill vs cancellation chronology proposal',
        requestAudit,
        responseAudit: {
          content: JSON.stringify(experiment),
          finishReason: 'stop'
        },
        requestSent: false
      };
    }

    return {
      experiment: null,
      usage,
      summary: 'Scripted offline sequence exhausted',
      requestAudit,
      responseAudit: {
        content: JSON.stringify({ done: true, summary: 'Scripted offline sequence exhausted' }),
        finishReason: 'stop'
      },
      requestSent: false
    };
  }
}
