import type {
  TargetVariant,
  ProviderKind,
  Experiment,
  ExperimentRecord,
  ExperimentResult,
  Violation,
  InvestigationRecord,
  InvestigationOptions,
  Usage,
  Action,
} from './domain.ts';
import { getSimulatorApi, type SimulatorApi } from './storage.ts';
import { compareSemanticReplay } from './evidence.ts';

export const MAX_EXPERIMENTS_LIMIT = 20;

export interface BaselineTrialResult {
  trial: number;
  seed: number;
  variant: TargetVariant;
  experimentCount: number;
  validCount: number;
  invalidCount: number;
  rawViolationsCount?: number;
  violationsCount: number;
  distinctInvariantsViolated: string[];
  findingsCount: number;
  confirmedInvariants: string[];
  experiments: ExperimentRecord[];
  cleanControlPassed: boolean;
  discoveredAtExperiment?: number;
}

export interface ProviderTrialResult {
  trial: number;
  seed: number;
  variant: TargetVariant;
  provider: ProviderKind;
  model: string;
  mode: 'live' | 'mock';
  status?: 'running' | 'completed' | 'cancelled' | 'failed';
  errorReason?: string;
  experimentCount: number;
  validCount: number;
  invalidCount: number;
  rawViolationsCount?: number;
  violationsCount: number;
  distinctInvariantsViolated: string[];
  findingsCount: number;
  confirmedInvariants?: string[];
  usage: Usage;
  record?: InvestigationRecord;
}

export interface EvaluationReport {
  schemaVersion: 1;
  id: string;
  timestamp: string;
  config: {
    variant: TargetVariant;
    provider: ProviderKind;
    maxExperiments: number;
    trials: number;
    seeds: number[];
  };
  provenance: {
    providerMode: 'live' | 'mock';
    mockResultsNeverImplyLivePerformance: boolean;
    sourceHash: string;
  };
  baseline: {
    totalExperiments: number;
    validPlans: number;
    invalidPlans: number;
    trialsWithDiscoveries: number;
    trialsWithViolations: number;
    uniqueInvariantsFound: string[];
    rawInvariantsViolated: string[];
    trials: BaselineTrialResult[];
  };
  provider: {
    totalExperiments: number;
    validPlans: number;
    invalidPlans: number;
    trialsWithDiscoveries: number;
    trialsWithViolations: number;
    uniqueInvariantsFound: string[];
    rawInvariantsViolated: string[];
    totalUsage: Usage;
    trials: ProviderTrialResult[];
  };
  comparison: {
    equalExperimentLimit: number;
    baselineDiscoveryRate: number;
    providerDiscoveryRate: number;
    baselineViolationRate?: number;
    providerViolationRate?: number;
    baselineInvalidRate: number;
    providerInvalidRate: number;
    efficiencyNotes: string;
  };
}

export interface EvaluationOptions {
  variant?: TargetVariant;
  provider?: ProviderKind;
  maxExperiments?: number;
  trials?: number;
  seeds?: number[];
  simulator?: SimulatorApi;
  investigationRunner?: (options: InvestigationOptions) => Promise<InvestigationRecord>;
}

/**
 * Deterministic pseudo-random number generator (Mulberry32).
 */
export function createPrng(seed: number): () => number {
  let s = seed >>> 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates structure-aware conventional trading experiments.
 * Uses realistic trading plans with mutation, duplicates, delays,
 * credit adjustments, and both cancel/fill delivery orders.
 * Never reads hidden defect selectors or answer keys.
 *
 * Scenario choice is seeded rather than a fixed order, preserving
 * structure-aware valid workflows and both full/partial duplicate fills
 * and cancel-report orderings.
 */
export function generateBaselineExperiment(seed: number, index: number): Experiment {
  const prng = createPrng(seed + index * 1013);
  const pattern = Math.floor(prng() * 6);

  const quoteId = `quote_s${seed}_i${index}`;
  const creditId = `credit_s${seed}_i${index}`;
  const orderId = `ord_s${seed}_i${index}`;
  const execId = `exec_s${seed}_i${index}`;
  const price = 50 + Math.floor(prng() * 50); // 50 to 99
  const quantity = 10 + Math.floor(prng() * 20); // 10 to 29
  const limit = price * quantity * 4;

  const steps: Action[] = [];

  // Setup basic market quote and credit limit
  steps.push({
    op: 'send',
    id: `m_quote_${index}`,
    to: 'market',
    payload: { type: 'quote', id: quoteId, version: index + 1, price },
  });
  steps.push({
    op: 'send',
    id: `m_credit_${index}`,
    to: 'credit',
    payload: { type: 'credit_limit', id: creditId, version: index + 1, limit },
  });
  steps.push({ op: 'drain' });

  // Add client order
  steps.push({
    op: 'send',
    id: `m_order_${index}`,
    to: 'client',
    payload: { type: 'new_order', id: `cli_ord_${index}`, orderId, quantity, quoteId },
  });
  steps.push({ op: 'drain' });

  switch (pattern) {
    case 0:
      // Full fill happy path
      steps.push({
        op: 'fill',
        messageId: `rep_exec_${index}`,
        orderId,
        executionId: execId,
        quantity,
      });
      steps.push({ op: 'drain' });
      return {
        hypothesis: `Standard full execution preserves credit and order quantity for order ${orderId}`,
        expectedInvariant: 'order_quantity_conservation',
        steps,
      };

    case 1: {
      // Redelivery / duplicate execution report with new transport envelope
      // Varies partial fill quantities and message identities
      const isPartial = prng() < 0.5;
      const fillQty = isPartial ? Math.max(1, Math.floor(quantity / 2)) : quantity;
      const dupExecId = isPartial ? `${execId}_part` : execId;
      const origMsgId = `rep_exec_orig_s${seed}_i${index}`;
      const dupMsgId = `rep_exec_dup_s${seed}_i${index}`;

      steps.push({
        op: 'fill',
        messageId: origMsgId,
        orderId,
        executionId: dupExecId,
        quantity: fillQty,
      });
      steps.push({
        op: 'duplicate',
        messageId: origMsgId,
        id: dupMsgId,
        delay: 2,
      });
      steps.push({ op: 'drain' });
      return {
        hypothesis: `Redelivered execution report with duplicate business ID ${dupExecId} (${isPartial ? 'partial' : 'full'} fill) must be idempotent`,
        expectedInvariant: 'execution_idempotency',
        steps,
      };
    }

    case 2: {
      // Cancellation and fill race: deliver cancellation acknowledgement before earlier execution
      const fillQty = Math.max(1, Math.floor(quantity / 2));
      steps.push({
        op: 'send',
        id: `m_cancel_${index}`,
        to: 'client',
        payload: { type: 'cancel_order', id: `cli_canc_${index}`, orderId },
      });
      // Fill at venue with delay on report
      steps.push({
        op: 'fill',
        messageId: `rep_fill_delayed_${index}`,
        orderId,
        executionId: execId,
        quantity: fillQty,
        delay: 5,
      });
      // Cancel confirmation at venue delivered immediately
      steps.push({
        op: 'confirm_cancel',
        messageId: `rep_cancel_ack_${index}`,
        orderId,
        delay: 0,
      });
      // Deliver cancel_ack first
      steps.push({ op: 'deliver', messageId: `rep_cancel_ack_${index}` });
      // Then deliver delayed fill
      steps.push({ op: 'advance', ticks: 6 });
      steps.push({ op: 'drain' });
      return {
        hypothesis: `Venue cancel acknowledgement arriving before in-flight fill report does not corrupt reservation or exposure`,
        expectedInvariant: 'credit_exposure_consistency',
        steps,
      };
    }

    case 3: {
      // Cancellation and fill race: fill delivered before cancel acknowledgement
      const fillQty = Math.max(1, Math.floor(quantity / 2));
      steps.push({
        op: 'send',
        id: `m_cancel_${index}`,
        to: 'client',
        payload: { type: 'cancel_order', id: `cli_canc_${index}`, orderId },
      });
      steps.push({
        op: 'fill',
        messageId: `rep_fill_${index}`,
        orderId,
        executionId: execId,
        quantity: fillQty,
        delay: 0,
      });
      steps.push({
        op: 'confirm_cancel',
        messageId: `rep_cancel_ack_${index}`,
        orderId,
        delay: 3,
      });
      steps.push({ op: 'drain' });
      return {
        hypothesis: `Fill arriving before cancel acknowledgement correctly releases remaining reservation`,
        expectedInvariant: 'order_quantity_conservation',
        steps,
      };
    }

    case 4: {
      // Credit limit cut below existing commitment followed by fill
      const lowerLimit = Math.floor((price * quantity) / 2);
      steps.push({
        op: 'send',
        id: `m_credit_cut_${index}`,
        to: 'credit',
        payload: { type: 'credit_limit', id: `${creditId}_cut`, version: index + 2, limit: lowerLimit },
      });
      steps.push({ op: 'drain' });
      steps.push({
        op: 'fill',
        messageId: `rep_fill_cut_${index}`,
        orderId,
        executionId: execId,
        quantity,
      });
      steps.push({ op: 'drain' });
      return {
        hypothesis: `Credit reduction below active order commitment permits execution without false violation`,
        expectedInvariant: 'credit_non_negative',
        steps,
      };
    }

    case 5:
    default: {
      // Partial fill then second fill up to total
      const part1 = Math.max(1, Math.floor(quantity / 2));
      const part2 = quantity - part1;
      steps.push({
        op: 'fill',
        messageId: `rep_fill_p1_${index}`,
        orderId,
        executionId: `${execId}_p1`,
        quantity: part1,
      });
      steps.push({
        op: 'fill',
        messageId: `rep_fill_p2_${index}`,
        orderId,
        executionId: `${execId}_p2`,
        quantity: part2,
      });
      steps.push({ op: 'drain' });
      return {
        hypothesis: `Sequential partial fills sum to initial order quantity without overfill`,
        expectedInvariant: 'no_overfill',
        steps,
      };
    }
  }
}

/**
 * Runs a single baseline trial consisting of seeded conventional experiments.
 * Follows the same verification criterion and stop-on-first-verified-finding
 * policy as the provider investigation engine.
 */
export function runBaselineTrial(
  variant: TargetVariant,
  seed: number,
  maxExperiments: number,
  simulator: SimulatorApi
): BaselineTrialResult {
  const experiments: ExperimentRecord[] = [];
  const rawInvariants = new Set<string>();
  const confirmedInvariants = new Set<string>();
  let validCount = 0;
  let invalidCount = 0;
  let rawViolationsCount = 0;
  let cleanControlPassed = true;
  let discoveredAtExperiment: number | undefined;

  for (let i = 0; i < maxExperiments; i++) {
    const experiment = generateBaselineExperiment(seed, i);
    const result = simulator.executeExperiment(experiment, variant);

    if (result.valid) {
      validCount++;
    } else {
      invalidCount++;
    }

    if (result.violations && result.violations.length > 0) {
      rawViolationsCount += result.violations.length;
      for (const v of result.violations) {
        rawInvariants.add(v.invariant);
      }
    }

    let replayVerified = false;
    let cleanPassed = true;
    let confirmedThisExp = false;

    // Findings are evaluated only for valid test plans with violations
    if (result.valid && result.violations && result.violations.length > 0) {
      // 1. Exact deterministic replay check
      let replayResult: ExperimentResult | undefined;
      try {
        replayResult = simulator.executeExperiment(experiment, variant);
      } catch {
        replayResult = undefined;
      }

      if (replayResult) {
        const replayComp = compareSemanticReplay(result, replayResult);
        replayVerified = replayComp.matched;
      }

      // 2. Clean control check: run on clean variant
      if (variant !== 'clean') {
        let cleanResult: ExperimentResult | undefined;
        try {
          cleanResult = simulator.executeExperiment(experiment, 'clean');
        } catch {
          cleanResult = undefined;
        }

        const cleanControlValid = Boolean(cleanResult && cleanResult.valid);
        const cleanInvariants = new Set(
          (cleanResult?.violations || []).map((v: Violation) => v.invariant)
        );

        // Clean controls with same invariant ID or invalid control must NOT become discoveries
        if (cleanControlValid && replayVerified) {
          for (const v of result.violations) {
            const absentOnClean = !cleanInvariants.has(v.invariant);
            if (absentOnClean) {
              confirmedThisExp = true;
              confirmedInvariants.add(v.invariant);
            }
          }
        }
        cleanPassed = confirmedThisExp;
        if (!confirmedThisExp) {
          cleanControlPassed = false;
        }
      } else {
        // Clean variant cannot confirm findings
        cleanPassed = true;
      }
    }

    if (confirmedThisExp && discoveredAtExperiment === undefined) {
      discoveredAtExperiment = i + 1;
    }

    experiments.push({
      index: i,
      experiment,
      result,
      replayVerified,
      cleanControlPassed: cleanPassed,
    });

    // Same stop-on-first-verified-finding policy as provider engine
    if (confirmedThisExp) {
      break;
    }
  }

  return {
    trial: seed,
    seed,
    variant,
    experimentCount: experiments.length,
    validCount,
    invalidCount,
    rawViolationsCount,
    violationsCount: rawViolationsCount,
    distinctInvariantsViolated: Array.from(rawInvariants),
    findingsCount: confirmedInvariants.size,
    confirmedInvariants: Array.from(confirmedInvariants),
    experiments,
    cleanControlPassed,
    discoveredAtExperiment,
  };
}

/**
 * Runs a complete evaluation comparing baseline generator with model/mock provider.
 * Implements bounded trials and seeds, truthful discovery metrics, and explicit provenance.
 */
export async function runEvaluation(options: EvaluationOptions = {}): Promise<EvaluationReport> {
  const variant = options.variant || 'candidate-a';
  const providerKind = options.provider || 'mock';
  // Clamp finite limit consistently to MAX_EXPERIMENTS_LIMIT (20)
  const maxExperiments = Math.min(
    Math.max(Math.floor(Number(options.maxExperiments) || 5), 1),
    MAX_EXPERIMENTS_LIMIT
  );
  const trialCount = Math.min(Math.max(Math.floor(Number(options.trials) || 3), 1), 10);
  const validSeeds = (options.seeds || [])
    .map((s) => Number(s))
    .filter((s) => Number.isSafeInteger(s) && s >= 0);
  const seeds = validSeeds.length > 0
    ? validSeeds.slice(0, trialCount)
    : Array.from({ length: trialCount }, (_, i) => 1000 + i * 137);

  const simulator = options.simulator || (await getSimulatorApi());

  let sourceHash = '';
  try {
    const bundle = simulator.getSourceBundle(variant);
    sourceHash = bundle.hash;
  } catch {
    sourceHash = 'unknown';
  }

  // 1. Run Baseline Trials
  const baselineTrials: BaselineTrialResult[] = [];
  const baselineConfirmedInvariants = new Set<string>();
  const baselineRawInvariants = new Set<string>();
  let baselineTotalExps = 0;
  let baselineValidPlans = 0;
  let baselineInvalidPlans = 0;
  let baselineTrialsWithDiscoveries = 0;
  let baselineTrialsWithViolations = 0;

  for (const seed of seeds) {
    const trialRes = runBaselineTrial(variant, seed, maxExperiments, simulator);
    baselineTrials.push(trialRes);
    baselineTotalExps += trialRes.experimentCount;
    baselineValidPlans += trialRes.validCount;
    baselineInvalidPlans += trialRes.invalidCount;
    if (trialRes.findingsCount > 0) {
      baselineTrialsWithDiscoveries++;
    }
    if (trialRes.violationsCount > 0) {
      baselineTrialsWithViolations++;
    }
    for (const inv of trialRes.confirmedInvariants) {
      baselineConfirmedInvariants.add(inv);
    }
    for (const inv of trialRes.distinctInvariantsViolated) {
      baselineRawInvariants.add(inv);
    }
  }

  // 2. Run Provider Trials (if investigation runner provided or available)
  const providerTrials: ProviderTrialResult[] = [];
  const providerConfirmedInvariants = new Set<string>();
  const providerRawInvariants = new Set<string>();
  let providerTotalExps = 0;
  let providerValidPlans = 0;
  let providerInvalidPlans = 0;
  let providerTrialsWithDiscoveries = 0;
  let providerTrialsWithViolations = 0;
  const totalUsage: Usage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };

  let runner = options.investigationRunner;
  if (!runner) {
    try {
      const invModule = await import('./investigation/index.ts');
      const provModule = await import('./providers/index.ts');
      runner = async (opts) => {
        const provider = provModule.createProvider(providerKind);
        return invModule.runInvestigation({ ...opts, provider });
      };
    } catch {
      runner = undefined;
    }
  }

  if (runner) {
    for (let t = 0; t < seeds.length; t++) {
      const seed = seeds[t]!;
      try {
        const record = await runner({
          variant,
          maxExperiments,
          provider: undefined as any, // provided by wrapper
        });

        const distinctRawInv = Array.from(
          new Set(
            record.experiments.flatMap((e) =>
              (e.result.violations || []).map((v) => v.invariant)
            )
          )
        );

        const confirmedInv = Array.from(
          new Set((record.findings || []).map((f) => f.violation.invariant))
        );

        const validCount = record.experiments.filter((e) => e.result.valid).length;
        const invalidCount = record.experiments.length - validCount;
        const rawViolationsCount = record.experiments.reduce(
          (sum, e) => sum + (e.result.violations ? e.result.violations.length : 0),
          0
        );
        const findingsCount = record.findings ? record.findings.length : 0;

        if (findingsCount > 0) {
          providerTrialsWithDiscoveries++;
        }
        if (rawViolationsCount > 0) {
          providerTrialsWithViolations++;
        }
        for (const inv of confirmedInv) {
          providerConfirmedInvariants.add(inv);
        }
        for (const inv of distinctRawInv) {
          providerRawInvariants.add(inv);
        }

        providerTotalExps += record.experiments.length;
        providerValidPlans += validCount;
        providerInvalidPlans += invalidCount;

        if (record.usage) {
          totalUsage.inputTokens += record.usage.inputTokens || 0;
          totalUsage.outputTokens += record.usage.outputTokens || 0;
          totalUsage.estimatedCostUsd += record.usage.estimatedCostUsd || 0;
        }

        const trialStatus = record.status || 'completed';
        const errorReason =
          trialStatus === 'failed' || trialStatus === 'cancelled'
            ? record.stopReason || (record.errors.length > 0 ? record.errors.join('; ') : undefined)
            : undefined;

        providerTrials.push({
          trial: t + 1,
          seed,
          variant,
          provider: providerKind,
          model: record.model || (trialStatus === 'failed' ? 'error' : 'mock'),
          mode: record.mode || (providerKind === 'mock' ? 'mock' : 'live'),
          status: trialStatus,
          errorReason,
          experimentCount: record.experiments.length,
          validCount,
          invalidCount,
          rawViolationsCount,
          violationsCount: rawViolationsCount,
          distinctInvariantsViolated: distinctRawInv,
          findingsCount,
          confirmedInvariants: confirmedInv,
          usage: record.usage,
          record,
        });
      } catch (err) {
        // Interrupted or failed trial recorded explicitly
        const errorReason = err instanceof Error ? err.message : String(err);
        providerTrials.push({
          trial: t + 1,
          seed,
          variant,
          provider: providerKind,
          model: 'error',
          mode: providerKind === 'mock' ? 'mock' : 'live',
          status: 'failed',
          errorReason,
          experimentCount: 0,
          validCount: 0,
          invalidCount: 0,
          rawViolationsCount: 0,
          violationsCount: 0,
          distinctInvariantsViolated: [],
          findingsCount: 0,
          confirmedInvariants: [],
          usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        });
      }
    }
  }

  // 3. Compile Comparison Metrics
  const baselineDiscoveryRate =
    seeds.length > 0 ? baselineTrialsWithDiscoveries / seeds.length : 0;
  const providerDiscoveryRate =
    seeds.length > 0 ? providerTrialsWithDiscoveries / seeds.length : 0;
  const baselineViolationRate =
    seeds.length > 0 ? baselineTrialsWithViolations / seeds.length : 0;
  const providerViolationRate =
    seeds.length > 0 ? providerTrialsWithViolations / seeds.length : 0;
  const baselineInvalidRate =
    baselineTotalExps > 0 ? baselineInvalidPlans / baselineTotalExps : 0;
  const providerInvalidRate =
    providerTotalExps > 0 ? providerInvalidPlans / providerTotalExps : 0;

  const mode = providerKind === 'mock' ? 'mock' : 'live';

  return {
    schemaVersion: 1,
    id: `eval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    config: {
      variant,
      provider: providerKind,
      maxExperiments,
      trials: seeds.length,
      seeds,
    },
    provenance: {
      providerMode: mode,
      mockResultsNeverImplyLivePerformance: true,
      sourceHash,
    },
    baseline: {
      totalExperiments: baselineTotalExps,
      validPlans: baselineValidPlans,
      invalidPlans: baselineInvalidPlans,
      trialsWithDiscoveries: baselineTrialsWithDiscoveries,
      trialsWithViolations: baselineTrialsWithViolations,
      uniqueInvariantsFound: Array.from(baselineConfirmedInvariants),
      rawInvariantsViolated: Array.from(baselineRawInvariants),
      trials: baselineTrials,
    },
    provider: {
      totalExperiments: providerTotalExps,
      validPlans: providerValidPlans,
      invalidPlans: providerInvalidPlans,
      trialsWithDiscoveries: providerTrialsWithDiscoveries,
      trialsWithViolations: providerTrialsWithViolations,
      uniqueInvariantsFound: Array.from(providerConfirmedInvariants),
      rawInvariantsViolated: Array.from(providerRawInvariants),
      totalUsage,
      trials: providerTrials,
    },
    comparison: {
      equalExperimentLimit: maxExperiments,
      baselineDiscoveryRate,
      providerDiscoveryRate,
      baselineViolationRate,
      providerViolationRate,
      baselineInvalidRate,
      providerInvalidRate,
      efficiencyNotes:
        mode === 'mock'
          ? 'Mock mode was evaluated offline. Offline mock results confirm protocol integration and reproduction verification, but do not imply autonomous AI model discovery performance.'
          : 'Live provider mode evaluated with official Meta API model.',
    },
  };
}
