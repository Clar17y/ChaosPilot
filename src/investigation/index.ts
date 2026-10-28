import * as crypto from 'node:crypto';
import { compareSemanticReplay, canonicalJson, computeContractHash } from '../evidence.ts';
import { computeSnapshotHash, validateSystemBrief } from '../systems/index.ts';
import { resolveAdapter, assertAdapterVariant } from '../adapters/index.ts';
import type {
  Experiment,
  ExperimentProvider,
  ExperimentRecord,
  ExperimentResult,
  Finding,
  InvestigationOptions,
  InvestigationRecord,
  Observation,
  ProposalAttempt,
  ProviderContext,
  ProviderReply,
  ProviderRequestAudit,
  ProviderResponseAudit,
  RequestAuditCallback,
  SourceBundle,
  SystemBriefSnapshot,
  SystemContract,
  TargetVariant,
  Usage
} from '../domain.ts';
import {
  getPromptIdentity
} from './prompt.ts';

export {
  PROMPT_VERSION,
  PROMPT_TEMPLATE_HASH,
  buildInvestigationPrompt,
  computePromptHash
} from './prompt.ts';

export interface SimulatorApi {
  getContract(): SystemContract;
  getSourceBundle(variant: TargetVariant): SourceBundle;
  parseExperiment(input: unknown): Experiment;
  executeExperiment(experiment: Experiment, variant: TargetVariant): ExperimentResult;
}

export type ExtendedInvestigationOptions = InvestigationOptions & {
  simulator?: SimulatorApi;
};

async function resolveSimulator(custom?: SimulatorApi, adapterId = 'synthetic-trading'): Promise<SimulatorApi> {
  if (
    custom &&
    typeof custom.getContract === 'function' &&
    typeof custom.getSourceBundle === 'function' &&
    typeof custom.parseExperiment === 'function' &&
    typeof custom.executeExperiment === 'function'
  ) {
    return custom;
  }

  return resolveAdapter(adapterId);
}

function cloneRecord(record: InvestigationRecord): InvestigationRecord {
  return structuredClone(record);
}

export async function runInvestigation(options: ExtendedInvestigationOptions): Promise<InvestigationRecord> {
  const id = options.id || `inv-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const variant = options.variant;
  const provider: ExperimentProvider = options.provider;
  const maxExperiments = Math.min(Math.max(1, Math.floor(Number(options.maxExperiments) || 5)), 20);
  const maxProposalAttempts = options.maxProposalAttempts ?? maxExperiments * 3;
  if (!Number.isSafeInteger(maxProposalAttempts) || maxProposalAttempts < 0 || maxProposalAttempts > 60) {
    throw new Error('maxProposalAttempts must be an integer from 0 to 60');
  }

  const adapterId = options.systemBrief?.brief?.adapterId ?? 'synthetic-trading';
  assertAdapterVariant(adapterId, variant);
  const promptIdentity = getPromptIdentity(adapterId);
  const sim = await resolveSimulator(options.simulator, adapterId);
  const contract = sim.getContract();
  const source = sim.getSourceBundle(variant);

  const contractHash = computeContractHash(contract);

  let systemBriefSnapshot: SystemBriefSnapshot | undefined = undefined;
  if (options.systemBrief !== undefined && options.systemBrief !== null) {
    if (
      typeof options.systemBrief !== 'object' ||
      !options.systemBrief.brief ||
      typeof options.systemBrief.brief !== 'object' ||
      typeof options.systemBrief.hash !== 'string' ||
      options.systemBrief.hash.trim().length === 0
    ) {
      throw new Error(
        'Invalid system brief snapshot structure: must contain brief object and non-empty hash string'
      );
    }

    const validated = validateSystemBrief(options.systemBrief.brief);
    if (!validated.valid) {
      throw new Error(`Invalid system brief in snapshot: ${validated.error}`);
    }

    const clonedBrief = structuredClone(validated.brief);
    const clonedContract = options.systemBrief.contract
      ? structuredClone(options.systemBrief.contract)
      : null;

    const computedHash = computeSnapshotHash(clonedBrief, clonedContract);
    if (options.systemBrief.hash !== computedHash) {
      throw new Error(
        `System brief snapshot hash mismatch: supplied hash "${options.systemBrief.hash}" does not match canonical computed hash "${computedHash}"`
      );
    }

    if (clonedBrief.adapterId === 'unconfigured') {
      throw new Error(
        `Cannot run investigation: System brief "${clonedBrief.name}" has unconfigured adapter.`
      );
    }
    if (clonedBrief.adapterId !== 'synthetic-trading' && clonedBrief.adapterId !== 'inventory-reservation') {
      throw new Error(
        `Cannot run investigation: System brief "${clonedBrief.name}" has unsupported adapter "${clonedBrief.adapterId}".`
      );
    }

    if (!clonedContract) {
      throw new Error('System brief for synthetic-trading must have an executing contract');
    }

    const executingContractCanonical = canonicalJson(contract);
    const briefContractCanonical = canonicalJson(clonedContract);
    if (executingContractCanonical !== briefContractCanonical) {
      throw new Error('System brief contract does not match executing simulator contract');
    }

    systemBriefSnapshot = {
      brief: clonedBrief,
      contract: clonedContract,
      hash: computedHash,
    };
  }

  // Record clean-control provenance for inventory and snapshot-backed trading
  // runs so replay can verify it. Omit it when genuinely unavailable.
  const cleanAudit: { adapterId: string; variant: TargetVariant; cleanSourceHash?: string } | Record<string, never> =
    adapterId === 'inventory-reservation' || systemBriefSnapshot
      ? { adapterId, variant, ...((): { cleanSourceHash?: string } => { try { const h = sim.getSourceBundle('clean').hash; return h ? { cleanSourceHash: h } : {}; } catch { return {}; } })() }
      : {};

  const record: InvestigationRecord = {
    schemaVersion: 1,
    id,
    provider: provider.kind,
    model: provider.model,
    mode: provider.kind === 'mock' ? 'mock' : 'live',
    variant,
    status: 'running',
    startedAt: new Date().toISOString(),
    sourceHash: source.hash,
    experiments: [],
    findings: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0
    },
    errors: [],
    proposalAttempts: [],
    systemBrief: systemBriefSnapshot ? structuredClone(systemBriefSnapshot) : undefined,
    contextAudit: {
      ...cleanAudit,
      sourcePaths: source.files.map(f => f.path),
      contractHash,
      promptVersion: promptIdentity.promptVersion,
      promptTemplateHash: promptIdentity.promptTemplateHash,
      providerConfiguration: provider.configuration ? { ...provider.configuration } : undefined,
      maxProposalAttempts
    }
  };

  await options.onUpdate?.(cloneRecord(record));

  // 1. Check pre-aborted signal before any proposal or work
  if (options.signal?.aborted) {
    record.status = 'cancelled';
    record.stopReason = 'Investigation aborted before start';
    record.finishedAt = new Date().toISOString();
    await options.onUpdate?.(cloneRecord(record));
    return record;
  }

  const history: Observation[] = [];
  let feedback: string[] = [];
  let experimentCount = 0;
  const maxProposalRetries = 3;
  let retryCount = 0;

  while (experimentCount < maxExperiments) {
    // Check cancellation at start of iteration
    if (options.signal?.aborted) {
      record.status = 'cancelled';
      record.stopReason = 'Investigation cancelled by user';
      break;
    }

    // Check global proposal attempts cap
    if (maxProposalAttempts !== undefined && record.proposalAttempts!.length >= maxProposalAttempts) {
      record.stopReason = 'Maximum proposal attempts reached';
      break;
    }

    // Source drift check: stop safely if source identity changed during investigation
    const currentSource = sim.getSourceBundle(variant);
    if (currentSource.hash !== record.sourceHash) {
      record.errors.push(`Source drift detected: initial hash ${record.sourceHash}, current hash ${currentSource.hash}`);
      record.status = 'failed';
      record.stopReason = 'Source drift detected during investigation';
      break;
    }

    // Create and persist initial pending attempt BEFORE calling provider
    const attemptIndex = record.proposalAttempts!.length + 1;
    const startedAt = new Date().toISOString();
    const startHr = performance.now();

    const currentAttempt: ProposalAttempt = {
      index: attemptIndex,
      experimentNumber: experimentCount + 1,
      correctionNumber: retryCount,
      startedAt,
      status: 'pending',
      usageKnown: false,
      requestSent: undefined
    };
    record.proposalAttempts!.push(currentAttempt);
    await options.onUpdate?.(cloneRecord(record));

    const finishAttempt = (
      status: ProposalAttempt['status'],
      opts: {
        error?: string;
        experimentIndex?: number;
        requestSent?: boolean;
        usageKnown?: boolean;
      } = {}
    ) => {
      currentAttempt.finishedAt = new Date().toISOString();
      currentAttempt.durationMs = Math.max(0, Math.round(performance.now() - startHr));
      currentAttempt.status = status;
      if (opts.error !== undefined) currentAttempt.error = opts.error;
      if (opts.experimentIndex !== undefined) currentAttempt.experimentIndex = opts.experimentIndex;
      if (opts.requestSent !== undefined) currentAttempt.requestSent = opts.requestSent;
      if (opts.usageKnown !== undefined) currentAttempt.usageKnown = opts.usageKnown;
    };

    let observerFailed = false;
    const onRequestAudit: RequestAuditCallback = async (audit: ProviderRequestAudit) => {
      try {
        currentAttempt.request = audit;
        await options.onUpdate?.(cloneRecord(record));
      } catch (e) {
        observerFailed = true;
        throw e;
      }
    };

    const context: ProviderContext = {
      contract,
      source,
      history,
      experimentNumber: experimentCount + 1,
      maxExperiments,
      feedback: feedback.length > 0 ? [...feedback] : undefined,
      systemBrief: systemBriefSnapshot ? structuredClone(systemBriefSnapshot) : undefined
    };

    let reply: ProviderReply;
    try {
      reply = await provider.propose(context, options.signal, onRequestAudit);
    } catch (err: unknown) {
      const isAbort = Boolean(options.signal?.aborted || (err instanceof Error && err.name === 'AbortError'));
      const errorMsg = err instanceof Error ? err.message : 'Unknown provider error';

      const failure = err as (Error & {
        requestSent?: boolean; requestAudit?: ProviderRequestAudit; responseAudit?: ProviderResponseAudit;
        usageKnown?: boolean; usage?: Usage;
      }) | null | undefined;
      const reqSent = typeof failure?.requestSent === 'boolean' ? failure.requestSent : undefined;
      const isSent = observerFailed ? false : reqSent;
      const knownUsage = failure?.usageKnown === true ? failure.usage : undefined;
      const isUsageKnown = knownUsage !== undefined || isSent === false;
      if (failure?.requestAudit && !currentAttempt.request) currentAttempt.request = failure.requestAudit;
      if (failure?.responseAudit) currentAttempt.response = failure.responseAudit;

      finishAttempt(isAbort ? 'cancelled' : 'failed', {
        error: errorMsg,
        requestSent: isSent,
        usageKnown: isUsageKnown
      });

      if (knownUsage) {
        currentAttempt.usage = knownUsage;
        record.usage.inputTokens += knownUsage.inputTokens;
        record.usage.outputTokens += knownUsage.outputTokens;
        record.usage.estimatedCostUsd = Number((record.usage.estimatedCostUsd + knownUsage.estimatedCostUsd).toFixed(6));
      } else if (isUsageKnown) {
        currentAttempt.usage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
      }

      if (isAbort) {
        record.status = 'cancelled';
        record.stopReason = 'Investigation aborted during provider proposal';
      } else {
        record.errors.push(`Provider proposal failure: ${errorMsg}`);
        record.status = 'failed';
        record.stopReason = 'Provider failed to propose';
      }
      await options.onUpdate?.(cloneRecord(record));
      break;
    }

    if (reply.requestAudit && !currentAttempt.request) {
      currentAttempt.request = reply.requestAudit;
    }
    if (reply.responseAudit) {
      currentAttempt.response = reply.responseAudit;
    }
    if (reply.requestSent !== undefined) {
      currentAttempt.requestSent = reply.requestSent;
    }

    // Accumulate usage metrics across all attempts
    if (reply.usage) {
      currentAttempt.usage = reply.usage;
      currentAttempt.usageKnown = true;
      record.usage.inputTokens += reply.usage.inputTokens ?? 0;
      record.usage.outputTokens += reply.usage.outputTokens ?? 0;
      record.usage.estimatedCostUsd = Number(
        (record.usage.estimatedCostUsd + (reply.usage.estimatedCostUsd ?? 0)).toFixed(6)
      );
    } else {
      currentAttempt.usageKnown = false;
    }

    // Cancellation check after late response: prevent simulation and preserve earlier results
    if (options.signal?.aborted) {
      finishAttempt('cancelled', { error: 'Investigation aborted after proposal' });
      record.status = 'cancelled';
      record.stopReason = 'Investigation aborted after proposal';
      await options.onUpdate?.(cloneRecord(record));
      break;
    }

    // Distinguish malformed/truncated model output from intentional stop:
    // If reply has validationError, provide bounded correction feedback rather than treating as completion
    if (reply.validationError) {
      finishAttempt('invalid_response', { error: reply.validationError });

      if (maxProposalAttempts !== undefined && record.proposalAttempts!.length >= maxProposalAttempts) {
        record.stopReason = 'Maximum proposal attempts reached';
        await options.onUpdate?.(cloneRecord(record));
        break;
      }

      feedback.push(`Validation error: ${reply.validationError}`);
      retryCount++;

      if (retryCount >= maxProposalRetries) {
        record.errors.push(`Proposal rejected after ${maxProposalRetries} correction attempts: ${reply.validationError}`);
        feedback = [];
        retryCount = 0;
        experimentCount++;
      }

      await options.onUpdate?.(cloneRecord(record));
      continue;
    }

    // Intentional stop / completion
    if (reply.experiment === null) {
      finishAttempt('stopped');
      record.stopReason = reply.summary || 'Provider completed proposals';
      await options.onUpdate?.(cloneRecord(record));
      break;
    }

    // Validate proposed experiment with simulator parser
    let parsedExperiment: Experiment;
    try {
      parsedExperiment = sim.parseExperiment(reply.experiment);
      feedback = [];
      retryCount = 0;
    } catch (err: unknown) {
      const parseError = err instanceof Error ? err.message : 'Invalid experiment structure';
      finishAttempt('invalid_plan', { error: parseError });

      if (maxProposalAttempts !== undefined && record.proposalAttempts!.length >= maxProposalAttempts) {
        record.stopReason = 'Maximum proposal attempts reached';
        await options.onUpdate?.(cloneRecord(record));
        break;
      }

      feedback.push(`Validation error: ${parseError}`);
      retryCount++;

      if (retryCount >= maxProposalRetries) {
        record.errors.push(`Proposal rejected after ${maxProposalRetries} correction attempts: ${parseError}`);
        feedback = [];
        retryCount = 0;
        experimentCount++;
      }

      await options.onUpdate?.(cloneRecord(record));
      continue;
    }

    // Check cancellation before dispatching experiment to simulator
    if (options.signal?.aborted) {
      finishAttempt('cancelled', { error: 'Investigation aborted before experiment execution' });
      record.status = 'cancelled';
      record.stopReason = 'Investigation aborted before experiment execution';
      await options.onUpdate?.(cloneRecord(record));
      break;
    }

    // Execute experiment on target candidate variant
    let result: ExperimentResult;
    try {
      result = sim.executeExperiment(parsedExperiment, variant);
      if (result.sourceHash !== source.hash) throw new Error('Execution source identity does not match investigation source');
    } catch (simErr: unknown) {
      const errorMsg = simErr instanceof Error ? simErr.message : String(simErr);
      finishAttempt('failed', { error: `Simulator execution failed: ${errorMsg}` });
      record.errors.push(`Simulator execution failed: ${errorMsg}`);
      record.status = 'failed';
      record.stopReason = `Simulator exception: ${errorMsg}`;
      await options.onUpdate?.(cloneRecord(record));
      break;
    }

    finishAttempt('executed', { experimentIndex: experimentCount + 1 });
    experimentCount++;
    history.push({ experiment: parsedExperiment, result });

    let replayVerified = false;
    let cleanControlPassed = false;

    // Findings are evaluated only for valid test plans with violations
    if (result.valid && result.violations.length > 0) {
      // 1. Exact deterministic replay on the same variant
      let replayResult: ExperimentResult | undefined;
      try {
        replayResult = sim.executeExperiment(parsedExperiment, variant);
      } catch {
        replayResult = undefined;
      }

      if (replayResult) {
        const replayComp = compareSemanticReplay(result, replayResult);
        replayVerified = replayComp.matched;
      }

      // 2. Clean control check: run on clean variant
      let cleanResult: ExperimentResult | undefined;
      try {
        cleanResult = sim.executeExperiment(parsedExperiment, 'clean');
        if (record.contextAudit.cleanSourceHash && cleanResult.sourceHash !== record.contextAudit.cleanSourceHash) cleanResult = undefined;
      } catch {
        cleanResult = undefined;
      }

      const cleanControlValid = Boolean(cleanResult && cleanResult.valid);
      const cleanViolatedInvariantIds = new Set<string>();
      if (cleanResult && cleanResult.valid) {
        for (const cv of cleanResult.violations) {
          cleanViolatedInvariantIds.add(cv.invariant);
        }
      }

      // Confirm findings per violation rather than all-or-nothing
      let anyViolationConfirmed = false;
      if (replayVerified && cleanControlValid) {
        for (const violation of result.violations) {
          const isAbsentOnClean = !cleanViolatedInvariantIds.has(violation.invariant);
          if (isAbsentOnClean) {
            anyViolationConfirmed = true;
            // De-duplicate repeated invariant findings while preserving all detailed trace violations in history
            const alreadyFound = record.findings.some(f => f.violation.invariant === violation.invariant);
            if (!alreadyFound) {
              const finding: Finding = {
                id: `finding-${record.findings.length + 1}-${violation.invariant}`,
                title: `Violation of ${violation.invariant}: ${violation.message}`,
                hypothesis: parsedExperiment.hypothesis,
                experimentIndex: experimentCount,
                violation,
                sourceHash: result.sourceHash,
                reproduced: true,
                cleanControlPassed: true,
                // Independent copy: the saved finding plan must not alias the
                // experiment/result copies, matching persisted JSON semantics.
                replay: structuredClone(parsedExperiment)
              };
              record.findings.push(finding);
            }
          }
        }
      }

      cleanControlPassed = anyViolationConfirmed;
    }

    const expRecord: ExperimentRecord = {
      index: experimentCount,
      experiment: structuredClone(parsedExperiment),
      result,
      replayVerified,
      cleanControlPassed
    };
    record.experiments.push(expRecord);
    await options.onUpdate?.(cloneRecord(record));

    // If verified finding is confirmed, stop investigation
    if (record.findings.length > 0) {
      record.stopReason = 'Verified finding confirmed';
      break;
    }

    // Check if proposal cap reached
    if (maxProposalAttempts !== undefined && record.proposalAttempts!.length >= maxProposalAttempts) {
      record.stopReason = 'Maximum proposal attempts reached';
      break;
    }
  }

  if (record.status === 'running') {
    record.status = 'completed';
    if (!record.stopReason) {
      if (record.findings.length > 0) {
        record.stopReason = 'Verified finding confirmed';
      } else if (maxProposalAttempts !== undefined && record.proposalAttempts!.length >= maxProposalAttempts) {
        record.stopReason = 'Maximum proposal attempts reached';
      } else if (experimentCount >= maxExperiments) {
        record.stopReason = 'Finite experiment bound reached without findings (does not imply correctness)';
      } else {
        record.stopReason = 'Completed';
      }
    }
  }

  record.finishedAt = new Date().toISOString();
  await options.onUpdate?.(cloneRecord(record));
  return record;
}
