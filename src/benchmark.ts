import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeContractHash } from './evidence.ts';
import {
  TARGET_VARIANTS,
  type TargetVariant,
  type ProviderKind,
  type Usage,
  type InvestigationRecord,
  type ExperimentProvider,
  type InvestigationOptions,
  type SystemContract,
  type SourceBundle,
} from './domain.ts';
import {
  runBaselineTrial,
  createPrng,
  generateBaselineExperiment,
  type BaselineTrialResult,
} from './evaluation.ts';
import {
  PROMPT_VERSION,
  PROMPT_TEMPLATE_HASH,
  SYSTEM_PROMPT_TEMPLATE,
  buildInvestigationPrompt,
} from './investigation/prompt.ts';
import {
  BudgetLedger,
  calculateWorstCaseCost,
} from './providers/budget.ts';
import {
  saveBenchmarkReport,
} from './storage.ts';

export type BenchmarkPhase = 'calibration' | 'heldout';

export const ALLOWED_META_MODELS = new Set<string>([
  'muse-wonder-1.0',
  'muse-spark-1.3',
]);

export const DEFAULT_META_CONFIG: Record<string, string | number> = {
  reasoning: 'low',
  reasoningEffort: 'low',
  maxOutputTokens: 4096,
  maxPromptBytes: 32768,
  timeoutMs: 90000,
  requestTimeoutMs: 90000,
};

export interface BenchmarkFreezeManifest {
  schemaVersion: 1;
  capturedAt: string;
  baseline: {
    file: string;
    sha256: string;
    description: string;
    runtimeFile?: string;
    runtimeSha256?: string;
    functions?: {
      runBaselineTrial: string;
      createPrng: string;
      generateBaselineExperiment: string;
    };
  };
  prompt: {
    version: string;
    templateHash: string;
    moduleFile?: string;
    moduleSha256?: string;
    dynamicPromptHash?: string;
  };
}

export interface ModelArmTrialResult {
  trial: number;
  seed: number;
  target: TargetVariant;
  model: string;
  armIndex: number;
  armOrder: string[];
  providerCallCount: number | null;
  confirmedNetworkRequests: number | null;
  uncertainNetworkRequests: number | null;
  executedExperimentCount: number;
  validPlanCount: number;
  invalidPlanCount: number;
  invalidResponseCount: number;
  truncationCount: number;
  findingTrial: boolean;
  rawViolatedInvariantIds: string[];
  verifiedInvariantIds: string[];
  usage: Usage;
  unknownUsageCount: number;
  elapsedMs: number;
  timeToFirstVerifiedFindingMs: number | null;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  errorReason?: string;
  initialPromptHash?: string;
  initialRequestHash?: string;
  comparabilityStatus: 'comparable' | 'incomplete' | 'violated' | 'mock-offline';
  comparabilityNote?: string;
  record?: InvestigationRecord;
  metricsComplete?: boolean;
}

export interface TargetSummary {
  target: TargetVariant;
  totalTrials: number;
  validExecutedZeroViolationCount: number;
  rawViolationTrialCount: number;
  noExecutionCount: number;
  findingsCount: number;
}

export interface ModelArmSummary {
  model: string;
  totalTrials: number;
  completedTrials: number;
  failedTrials: number;
  cancelledTrials: number;
  trialsWithFindings: number;
  uniqueVerifiedInvariants: string[];
  uniqueRawInvariantsViolated: string[];
  totalProviderCalls: number;
  totalConfirmedNetworkRequests: number;
  totalUncertainNetworkRequests: number;
  totalExecutedExperiments: number;
  totalValidPlans: number;
  totalInvalidPlans: number;
  totalInvalidResponses: number;
  totalTruncations: number;
  totalUsage: Usage;
  totalUnknownUsageCount: number;
  meanElapsedMs: number;
  targetSummaries: TargetSummary[];
}

export interface BaselineSummary {
  totalTrials: number;
  trialsWithDiscoveries: number;
  trialsWithViolations: number;
  uniqueInvariantsFound: string[];
  uniqueRawInvariantsViolated: string[];
  totalExperiments: number;
  validPlans: number;
  invalidPlans: number;
  trials: BaselineTrialResult[];
}

export interface BenchmarkReport {
  schemaVersion: 1;
  kind: 'benchmark';
  id: string;
  timestamp: string;
  phase: BenchmarkPhase;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  stopReason?: string;
  config: {
    targets: TargetVariant[];
    models: string[];
    trials: number;
    maxExperiments: number;
    seeds: number[];
    provider: ProviderKind;
    configuration: Record<string, string | number>;
    freezePath?: string;
  };
  provenance: {
    providerMode: 'live' | 'mock';
    mockResultsNeverImplyLivePerformance: boolean;
    baselineIdentity: {
      file: string;
      sha256: string;
      runtimeSha256?: string;
      functions?: {
        runBaselineTrial: string;
        createPrng: string;
        generateBaselineExperiment: string;
      };
    };
    promptVersion: string;
    promptTemplateHash: string;
    promptModuleSha256?: string;
    dynamicPromptHash?: string;
    targetSourceHashes: Record<string, string>;
    targetContractHashes: Record<string, string>;
    humanEffort: 'unmeasured';
  };
  baseline: BaselineSummary;
  arms: Record<
    string,
    {
      model: string;
      summary: ModelArmSummary;
      trials: ModelArmTrialResult[];
    }
  >;
  comparability: {
    status: 'comparable' | 'incomplete' | 'violated' | 'mock-offline';
    notes: string[];
  };
}

export interface BenchmarkSimulatorApi {
  getContract(): SystemContract;
  getSourceBundle(variant: TargetVariant): SourceBundle;
  parseExperiment?(input: unknown): any;
  executeExperiment?(experiment: any, variant: TargetVariant): any;
}

export interface BenchmarkOptions {
  id?: string;
  phase?: BenchmarkPhase;
  targets?: TargetVariant[];
  models?: string[];
  provider?: ProviderKind;
  trials?: number;
  maxExperiments?: number;
  seeds?: number[];
  freezePath?: string;
  configuration?: Record<string, string | number>;
  benchmarksDir?: string;
  signal?: AbortSignal;
  onUpdate?: (report: BenchmarkReport) => void | Promise<void>;
  // Dependency injection:
  simulator?: BenchmarkSimulatorApi;
  runner?: (options: InvestigationOptions & { simulator?: any }) => Promise<InvestigationRecord>;
  providerFactory?: (
    kind: ProviderKind,
    model: string,
    config?: Record<string, string | number>
  ) => ExperimentProvider;
  budgetLedger?: BudgetLedger;
  now?: () => number;
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function getFreezePathsAndIdentities() {
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFilePath);
  const isJs = currentFilePath.endsWith('.js');

  const runtimeEvalPath = isJs
    ? path.join(currentDir, 'evaluation.js')
    : path.join(currentDir, 'evaluation.ts');
  const sourceEvalPath = path.resolve('src/evaluation.ts');

  const runtimePromptPath = isJs
    ? path.join(currentDir, 'investigation', 'prompt.js')
    : path.join(currentDir, 'investigation', 'prompt.ts');
  const sourcePromptPath = path.resolve('src/investigation/prompt.ts');

  let evalSourceContent = await readFileIfExists(sourceEvalPath);
  if (!evalSourceContent) {
    evalSourceContent = await readFileIfExists(runtimeEvalPath);
  }
  if (!evalSourceContent) {
    throw new Error(`Cannot locate evaluation source at ${sourceEvalPath} or ${runtimeEvalPath}`);
  }
  const baselineSha256 = crypto.createHash('sha256').update(evalSourceContent, 'utf8').digest('hex');

  let runtimeEvalContent = await readFileIfExists(runtimeEvalPath);
  if (!runtimeEvalContent) {
    runtimeEvalContent = evalSourceContent;
  }
  const runtimeSha256 = crypto.createHash('sha256').update(runtimeEvalContent, 'utf8').digest('hex');

  let promptContent = await readFileIfExists(runtimePromptPath);
  if (!promptContent) {
    promptContent = await readFileIfExists(sourcePromptPath);
  }
  if (!promptContent) {
    promptContent = SYSTEM_PROMPT_TEMPLATE;
  }
  const promptModuleSha256 = crypto.createHash('sha256').update(promptContent, 'utf8').digest('hex');

  const functionIdentities = {
    runBaselineTrial: crypto.createHash('sha256').update(runBaselineTrial.toString(), 'utf8').digest('hex'),
    createPrng: crypto.createHash('sha256').update(createPrng.toString(), 'utf8').digest('hex'),
    generateBaselineExperiment: crypto.createHash('sha256').update(generateBaselineExperiment.toString(), 'utf8').digest('hex'),
  };

  const dynamicPromptHash = crypto.createHash('sha256').update(buildInvestigationPrompt.toString(), 'utf8').digest('hex');

  return {
    runtimeEvalPath,
    sourceEvalPath,
    baselineSha256,
    runtimeSha256,
    functionIdentities,
    promptModuleSha256,
    dynamicPromptHash,
    runtimePromptPath,
  };
}

export async function captureBenchmarkFreeze(customPath?: string): Promise<BenchmarkFreezeManifest> {
  const identities = await getFreezePathsAndIdentities();

  const manifest: BenchmarkFreezeManifest = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    baseline: {
      file: 'src/evaluation.ts',
      sha256: identities.baselineSha256,
      description: 'Frozen conventional generator and PRNG implementation from src/evaluation.ts',
      runtimeFile: path.relative(process.cwd(), identities.runtimeEvalPath).replace(/\\/g, '/'),
      runtimeSha256: identities.runtimeSha256,
      functions: identities.functionIdentities,
    },
    prompt: {
      version: PROMPT_VERSION,
      templateHash: PROMPT_TEMPLATE_HASH,
      moduleFile: path.relative(process.cwd(), identities.runtimePromptPath).replace(/\\/g, '/'),
      moduleSha256: identities.promptModuleSha256,
      dynamicPromptHash: identities.dynamicPromptHash,
    },
  };

  if (customPath) {
    const resolvedPath = path.resolve(customPath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  return manifest;
}

export async function verifyBenchmarkFreeze(freezePath: string): Promise<BenchmarkFreezeManifest> {
  const resolved = path.resolve(freezePath);
  let content: string;
  try {
    content = await fs.readFile(resolved, 'utf8');
  } catch (err) {
    throw new Error(`Benchmark freeze manifest not found at ${resolved}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const manifest = JSON.parse(content) as BenchmarkFreezeManifest;
  if (!manifest || manifest.schemaVersion !== 1 || !manifest.baseline || !manifest.prompt) {
    throw new Error(`Invalid benchmark freeze manifest at ${resolved}`);
  }
  const requiredIdentities = [
    manifest.baseline.sha256, manifest.baseline.runtimeSha256,
    manifest.baseline.functions?.runBaselineTrial, manifest.baseline.functions?.createPrng,
    manifest.baseline.functions?.generateBaselineExperiment, manifest.prompt.templateHash,
    manifest.prompt.moduleSha256, manifest.prompt.dynamicPromptHash,
  ];
  if (requiredIdentities.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('Invalid benchmark freeze manifest: complete source, runtime, function and prompt identities are required. Capture a new manifest before fixture creation.');
  }

  const identities = await getFreezePathsAndIdentities();

  // 1. Source verification
  if (manifest.baseline.sha256 && manifest.baseline.sha256 !== identities.baselineSha256) {
    throw new Error(
      `Benchmark freeze verification failed: baseline generator source drift detected in src/evaluation.ts. ` +
      `Expected sha256 ${manifest.baseline.sha256}, got ${identities.baselineSha256}. Source drift fails visibly.`
    );
  }

  // 2. Runtime verification
  if (manifest.baseline.runtimeSha256 && manifest.baseline.runtimeSha256 !== identities.runtimeSha256) {
    throw new Error(
      `Benchmark freeze verification failed: baseline generator runtime drift detected in ${identities.runtimeEvalPath}. ` +
      `Expected sha256 ${manifest.baseline.runtimeSha256}, got ${identities.runtimeSha256}. Runtime drift fails visibly.`
    );
  }

  // 3. Function identities
  if (manifest.baseline.functions) {
    if (manifest.baseline.functions.runBaselineTrial && manifest.baseline.functions.runBaselineTrial !== identities.functionIdentities.runBaselineTrial) {
      throw new Error(
        `Benchmark freeze verification failed: baseline function identity drift detected for runBaselineTrial. ` +
        `Expected ${manifest.baseline.functions.runBaselineTrial}, got ${identities.functionIdentities.runBaselineTrial}. Source drift fails visibly.`
      );
    }
    if (manifest.baseline.functions.createPrng && manifest.baseline.functions.createPrng !== identities.functionIdentities.createPrng) {
      throw new Error(
        `Benchmark freeze verification failed: baseline function identity drift detected for createPrng. ` +
        `Expected ${manifest.baseline.functions.createPrng}, got ${identities.functionIdentities.createPrng}. Source drift fails visibly.`
      );
    }
    if (manifest.baseline.functions.generateBaselineExperiment && manifest.baseline.functions.generateBaselineExperiment !== identities.functionIdentities.generateBaselineExperiment) {
      throw new Error(
        `Benchmark freeze verification failed: baseline function identity drift detected for generateBaselineExperiment. ` +
        `Expected ${manifest.baseline.functions.generateBaselineExperiment}, got ${identities.functionIdentities.generateBaselineExperiment}. Source drift fails visibly.`
      );
    }
  }

  // 4. Prompt version and template
  if (PROMPT_VERSION !== manifest.prompt.version) {
    throw new Error(
      `Benchmark freeze verification failed: prompt version mismatch. ` +
      `Expected ${manifest.prompt.version}, got ${PROMPT_VERSION}. Source drift fails visibly.`
    );
  }

  if (PROMPT_TEMPLATE_HASH !== manifest.prompt.templateHash) {
    throw new Error(
      `Benchmark freeze verification failed: prompt template drift detected. ` +
      `Expected sha256 ${manifest.prompt.templateHash}, got ${PROMPT_TEMPLATE_HASH}. Source drift fails visibly.`
    );
  }

  // 5. Prompt module bytes & dynamic function identity
  if (manifest.prompt.moduleSha256 && manifest.prompt.moduleSha256 !== identities.promptModuleSha256) {
    throw new Error(
      `Benchmark freeze verification failed: prompt module bytes drift detected. ` +
      `Expected sha256 ${manifest.prompt.moduleSha256}, got ${identities.promptModuleSha256}. Source drift fails visibly.`
    );
  }

  if (manifest.prompt.dynamicPromptHash && manifest.prompt.dynamicPromptHash !== identities.dynamicPromptHash) {
    throw new Error(
      `Benchmark freeze verification failed: dynamic prompt function identity drift detected for buildInvestigationPrompt. ` +
      `Expected sha256 ${manifest.prompt.dynamicPromptHash}, got ${identities.dynamicPromptHash}. Source drift fails visibly.`
    );
  }

  return manifest;
}

function calculateModelArmSummary(trials: ModelArmTrialResult[], model: string, targets: TargetVariant[]): ModelArmSummary {
  let completedTrials = 0;
  let failedTrials = 0;
  let cancelledTrials = 0;
  let trialsWithFindings = 0;
  const verifiedInvariants = new Set<string>();
  const rawInvariants = new Set<string>();
  let totalProviderCalls = 0;
  let totalConfirmedNetworkRequests = 0;
  let totalUncertainNetworkRequests = 0;
  let totalExecutedExperiments = 0;
  let totalValidPlans = 0;
  let totalInvalidPlans = 0;
  let totalInvalidResponses = 0;
  let totalTruncations = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let totalUnknownUsage = 0;
  let totalElapsed = 0;

  for (const t of trials) {
    if (t.status === 'completed') completedTrials++;
    else if (t.status === 'failed') failedTrials++;
    else if (t.status === 'cancelled') cancelledTrials++;

    if (t.findingTrial) trialsWithFindings++;

    for (const inv of t.verifiedInvariantIds) verifiedInvariants.add(inv);
    for (const inv of t.rawViolatedInvariantIds) rawInvariants.add(inv);

    totalProviderCalls += t.providerCallCount || 0;
    totalConfirmedNetworkRequests += t.confirmedNetworkRequests || 0;
    totalUncertainNetworkRequests += t.uncertainNetworkRequests || 0;
    totalExecutedExperiments += t.executedExperimentCount;
    totalValidPlans += t.validPlanCount;
    totalInvalidPlans += t.invalidPlanCount;
    totalInvalidResponses += t.invalidResponseCount;
    totalTruncations += t.truncationCount;

    if (t.usage) {
      totalInputTokens += t.usage.inputTokens || 0;
      totalOutputTokens += t.usage.outputTokens || 0;
      totalCostUsd += t.usage.estimatedCostUsd || 0;
    }
    totalUnknownUsage += t.unknownUsageCount;
    totalElapsed += t.elapsedMs;
  }

  const targetSummaries: TargetSummary[] = targets.map((target) => {
    const targetTrials = trials.filter((t) => t.target === target);
    let validExecutedZeroViolationCount = 0;
    let rawViolationTrialCount = 0;
    let noExecutionCount = 0;
    let findingsCount = 0;

    for (const tt of targetTrials) {
      if (tt.executedExperimentCount === 0) {
        noExecutionCount++;
      } else if (tt.rawViolatedInvariantIds.length > 0) {
        rawViolationTrialCount++;
      } else if (tt.validPlanCount > 0 && tt.rawViolatedInvariantIds.length === 0) {
        validExecutedZeroViolationCount++;
      }

      if (tt.findingTrial) {
        findingsCount++;
      }
    }

    return {
      target,
      totalTrials: targetTrials.length,
      validExecutedZeroViolationCount,
      rawViolationTrialCount,
      noExecutionCount,
      findingsCount,
    };
  });

  return {
    model,
    totalTrials: trials.length,
    completedTrials,
    failedTrials,
    cancelledTrials,
    trialsWithFindings,
    uniqueVerifiedInvariants: Array.from(verifiedInvariants),
    uniqueRawInvariantsViolated: Array.from(rawInvariants),
    totalProviderCalls,
    totalConfirmedNetworkRequests,
    totalUncertainNetworkRequests,
    totalExecutedExperiments,
    totalValidPlans,
    totalInvalidPlans,
    totalInvalidResponses,
    totalTruncations,
    totalUsage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      estimatedCostUsd: Number(totalCostUsd.toFixed(6)),
    },
    totalUnknownUsageCount: totalUnknownUsage,
    meanElapsedMs: trials.length > 0 ? Math.round(totalElapsed / trials.length) : 0,
    targetSummaries,
  };
}

function calculateBaselineSummary(trials: BaselineTrialResult[]): BaselineSummary {
  let trialsWithDiscoveries = 0;
  let trialsWithViolations = 0;
  const uniqueInvariantsFound = new Set<string>();
  const uniqueRawInvariantsViolated = new Set<string>();
  let totalExperiments = 0;
  let validPlans = 0;
  let invalidPlans = 0;

  for (const t of trials) {
    if (t.findingsCount > 0) trialsWithDiscoveries++;
    if (t.violationsCount > 0) trialsWithViolations++;
    for (const inv of t.confirmedInvariants || []) uniqueInvariantsFound.add(inv);
    for (const inv of t.distinctInvariantsViolated || []) uniqueRawInvariantsViolated.add(inv);
    totalExperiments += t.experimentCount;
    validPlans += t.validCount;
    invalidPlans += t.invalidCount;
  }

  return {
    totalTrials: trials.length,
    trialsWithDiscoveries,
    trialsWithViolations,
    uniqueInvariantsFound: Array.from(uniqueInvariantsFound),
    uniqueRawInvariantsViolated: Array.from(uniqueRawInvariantsViolated),
    totalExperiments,
    validPlans,
    invalidPlans,
    trials,
  };
}

function updateTrialResultFromRecord(
  tr: ModelArmTrialResult,
  rec: InvestigationRecord | undefined,
  kind: ProviderKind,
  startTime: number,
  currentTime: number,
  timeToFirstVerifiedFindingMs: number | null
) {
  tr.elapsedMs = Math.max(0, currentTime - startTime);
  if (rec) {
    tr.record = rec;
    tr.usage = rec.usage || { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };

    const attempts = rec.proposalAttempts ?? [];
    if (attempts.length > 0) {
      tr.providerCallCount = attempts.length;
      let confirmed = 0;
      let uncertain = 0;
      let executed = 0;
      let invResponse = 0;
      let invPlan = 0;
      let truncations = 0;
      let unknownUsage = 0;

      for (const a of attempts) {
        if (a.requestSent === true) {
          confirmed++;
        } else if (a.requestSent === undefined || a.requestSent === null) {
          uncertain++;
        }

        if (a.status === 'executed') executed++;
        else if (a.status === 'invalid_response') invResponse++;
        else if (a.status === 'invalid_plan') invPlan++;

        if (a.response?.finishReason === 'length') truncations++;
        if (a.usageKnown === false) unknownUsage++;
      }

      tr.confirmedNetworkRequests = confirmed;
      tr.uncertainNetworkRequests = uncertain;
      tr.executedExperimentCount = executed;
      tr.invalidResponseCount = invResponse;
      tr.invalidPlanCount = invPlan;
      tr.truncationCount = truncations;
      tr.unknownUsageCount = unknownUsage;
      tr.metricsComplete = true;

      tr.initialPromptHash = attempts[0]?.request?.promptHash;
      tr.initialRequestHash = attempts[0]?.request?.requestHash;
    } else {
      if (kind === 'mock') {
        tr.providerCallCount = rec.experiments.length;
        tr.confirmedNetworkRequests = 0;
        tr.uncertainNetworkRequests = 0;
        tr.executedExperimentCount = rec.experiments.length;
        tr.unknownUsageCount = 0;
        tr.metricsComplete = true;
      } else {
        // Live provider with no attempt audits:
        // DO NOT fabricate network counts or call counts!
        tr.providerCallCount = null;
        tr.confirmedNetworkRequests = null;
        tr.uncertainNetworkRequests = null;
        tr.executedExperimentCount = rec.experiments.length;
        tr.unknownUsageCount = 0;
        tr.metricsComplete = false;
      }
    }

    let validCount = 0;
    let invalidCount = 0;
    for (const e of rec.experiments) {
      if (e.result.valid) validCount++;
      else invalidCount++;
    }
    tr.validPlanCount = validCount;
    tr.invalidPlanCount = Math.max(tr.invalidPlanCount, invalidCount);

    const rawInvariants = new Set<string>();
    for (const e of rec.experiments) {
      for (const v of e.result.violations || []) {
        rawInvariants.add(v.invariant);
      }
    }
    tr.rawViolatedInvariantIds = Array.from(rawInvariants);

    const verified = new Set<string>();
    for (const f of rec.findings || []) {
      if (f.reproduced && f.cleanControlPassed) {
        verified.add(f.violation.invariant);
      }
    }
    tr.verifiedInvariantIds = Array.from(verified);
    tr.findingTrial = verified.size > 0;
    tr.timeToFirstVerifiedFindingMs = timeToFirstVerifiedFindingMs;
  }
}

function computeAggregateComparability(
  report: BenchmarkReport,
  plannedTrials: number,
  models: string[],
  targets: TargetVariant[]
): { status: 'comparable' | 'incomplete' | 'violated' | 'mock-offline'; notes: string[] } {
  if (report.config.provider === 'mock') {
    return { status: 'mock-offline', notes: [] };
  }

  const notes: string[] = [];
  let hasViolation = false;
  let hasIncomplete = false;

  const expectedTotalTrials = plannedTrials * models.length * targets.length;
  let executedTotalTrials = 0;

  for (const model of models) {
    const arm = report.arms[model];
    if (!arm) {
      hasIncomplete = true;
      notes.push(`Missing arm for model ${model}`);
      continue;
    }

    for (const t of arm.trials) {
      if (t.status === 'running') {
        hasIncomplete = true;
        continue;
      }
      executedTotalTrials++;
      if (t.comparabilityStatus === 'violated') {
        hasViolation = true;
        if (t.comparabilityNote && !notes.includes(t.comparabilityNote)) {
          notes.push(t.comparabilityNote);
        }
      } else if (t.comparabilityStatus === 'incomplete') {
        hasIncomplete = true;
        if (t.comparabilityNote && !notes.includes(t.comparabilityNote)) {
          notes.push(t.comparabilityNote);
        }
      }
    }
  }

  if (executedTotalTrials < expectedTotalTrials) {
    hasIncomplete = true;
    const note = `Benchmark incomplete: executed ${executedTotalTrials} of ${expectedTotalTrials} expected trials.`;
    if (!notes.includes(note)) notes.push(note);
  }

  if (report.status === 'cancelled' || report.status === 'failed') {
    hasIncomplete = true;
    const note = `Benchmark ${report.status}: ${report.stopReason || 'stopped early'}`;
    if (!notes.includes(note)) notes.push(note);
  }

  if (hasViolation) {
    return { status: 'violated', notes };
  }
  if (hasIncomplete) {
    return { status: 'incomplete', notes };
  }
  return { status: 'comparable', notes };
}

export async function runBenchmark(options: BenchmarkOptions = {}): Promise<BenchmarkReport> {
  const phase: BenchmarkPhase = options.phase || 'calibration';
  const providerKind: ProviderKind = options.provider || 'mock';
  const benchmarksDir = options.benchmarksDir || 'runs/benchmarks';
  const now = options.now || (() => Date.now());

  // 1. Validate Phase Requirements
  if (phase === 'heldout') {
    if (!options.freezePath) {
      throw new Error('Heldout phase requires an existing matching freeze manifest (--freeze <path>).');
    }
    if (!options.targets || options.targets.length === 0) {
      throw new Error('Heldout phase requires explicit selected target(s) (--targets <targets>).');
    }
  }

  // 2. Validate Targets (unique nonempty, valid)
  let targets: TargetVariant[];
  if (options.targets !== undefined) {
    if (!Array.isArray(options.targets) || options.targets.length === 0) {
      throw new Error('targets must be a nonempty array.');
    }
    if (new Set(options.targets).size !== options.targets.length) {
      throw new Error(`Duplicate targets are not permitted: [${options.targets.join(', ')}].`);
    }
    targets = [...options.targets];
  } else {
    targets = ['clean', 'candidate-a', 'candidate-b'];
  }

  for (const t of targets) {
    if (!(TARGET_VARIANTS as readonly string[]).includes(t)) {
      throw new Error(`Invalid target variant: "${t}". Known variants: ${TARGET_VARIANTS.join(', ')}.`);
    }
  }

  // 3. Validate Models (unique nonempty, whitelist)
  let models: string[];
  if (options.models !== undefined) {
    if (!Array.isArray(options.models) || options.models.length === 0) {
      throw new Error('models must be a nonempty array.');
    }
    if (new Set(options.models).size !== options.models.length) {
      throw new Error(`Duplicate models are not permitted: [${options.models.join(', ')}].`);
    }
    models = [...options.models];
  } else {
    models = providerKind === 'meta' ? ['muse-wonder-1.0', 'muse-spark-1.3'] : ['scripted-offline'];
  }
  if (providerKind === 'mock' && (models.length !== 1 || models[0] !== 'scripted-offline')) {
    throw new Error('Mock benchmarking supports only the single scripted-offline arm; real model names require provider meta.');
  }

  for (const m of models) {
    if (!m || typeof m !== 'string' || m.trim().length === 0) {
      throw new Error(`Invalid model name: "${m}". Model name must be a nonempty string.`);
    }
  }

  // 4. Validate Configuration Controls
  const rawConfig = options.configuration || {};
  let effectiveConfig: Record<string, string | number>;

  if (providerKind === 'meta') {
    for (const m of models) {
      if (!ALLOWED_META_MODELS.has(m)) {
        throw new Error(`Unsupported model for provider meta: "${m}". Allowed whitelist: ${Array.from(ALLOWED_META_MODELS).join(', ')}.`);
      }
    }

    const reasoningRaw = rawConfig.reasoningEffort ?? rawConfig.reasoning ?? DEFAULT_META_CONFIG.reasoning;
    const reasoning = String(reasoningRaw);
    if (reasoning !== 'low') {
      throw new Error(`Invalid reasoning setting: "${reasoning}". Must be explicit "low".`);
    }

    const maxOutputTokensRaw = rawConfig.maxOutputTokens ?? DEFAULT_META_CONFIG.maxOutputTokens;
    const maxOutputTokens = Number(maxOutputTokensRaw);
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 8192) {
      throw new Error(`Invalid maxOutputTokens: ${maxOutputTokensRaw}. Range: [1, 8192].`);
    }

    const maxPromptBytesRaw = rawConfig.maxPromptBytes ?? DEFAULT_META_CONFIG.maxPromptBytes;
    const maxPromptBytes = Number(maxPromptBytesRaw);
    if (!Number.isSafeInteger(maxPromptBytes) || maxPromptBytes < 1000 || maxPromptBytes > 131072) {
      throw new Error(`Invalid maxPromptBytes: ${maxPromptBytesRaw}. Range: [1000, 131072].`);
    }

    const timeoutRaw = rawConfig.requestTimeoutMs ?? rawConfig.timeoutMs ?? DEFAULT_META_CONFIG.timeoutMs;
    const timeoutMs = Number(timeoutRaw);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
      throw new Error(`Invalid timeoutMs: ${timeoutRaw}. Range: [1000, 120000].`);
    }

    effectiveConfig = {
      reasoning,
      reasoningEffort: reasoning,
      maxOutputTokens,
      maxPromptBytes,
      timeoutMs,
      requestTimeoutMs: timeoutMs,
    };
  } else {
    effectiveConfig = { ...rawConfig };
  }

  // 5. Validate Trials and maxExperiments
  let trials: number;
  if (options.trials !== undefined) {
    const parsedTrials = Number(options.trials);
    if (!Number.isSafeInteger(parsedTrials) || parsedTrials < 1 || parsedTrials > 10) {
      throw new Error(`Invalid trials: ${options.trials}. Must be an integer from 1 to 10.`);
    }
    trials = parsedTrials;
  } else {
    trials = 2;
  }

  let maxExperiments: number;
  if (options.maxExperiments !== undefined) {
    const parsedMax = Number(options.maxExperiments);
    if (!Number.isSafeInteger(parsedMax) || parsedMax < 1 || parsedMax > 20) {
      throw new Error(`Invalid maxExperiments: ${options.maxExperiments}. Must be an integer from 1 to 20.`);
    }
    maxExperiments = parsedMax;
  } else {
    maxExperiments = 6;
  }

  // 6. Validate Seeds
  let seeds: number[];
  if (options.seeds !== undefined) {
    if (!Array.isArray(options.seeds) || options.seeds.length < trials) {
      throw new Error(`seeds must be an array with at least ${trials} elements.`);
    }
    const chosenSeeds = options.seeds.slice(0, trials);
    for (const s of chosenSeeds) {
      if (!Number.isSafeInteger(s)) {
        throw new Error(`Invalid seed: ${s}. Seeds must be finite safe integers.`);
      }
    }
    if (new Set(chosenSeeds).size !== trials) {
      throw new Error(`Duplicate seeds are not permitted in first ${trials} seeds: [${chosenSeeds.join(', ')}].`);
    }
    seeds = chosenSeeds;
  } else {
    seeds = Array.from({ length: trials }, (_, i) => 1001 + i);
  }

  // 7. Resolve Simulator and Target Hashes
  let sim: any = options.simulator;
  if (!sim) {
    const simMod = await import('./simulator/index.ts');
    sim = simMod;
  }

  const targetSourceHashes: Record<string, string> = {};
  const targetContractHashes: Record<string, string> = {};
  for (const t of targets) {
    try {
      const bundle = sim.getSourceBundle(t);
      targetSourceHashes[t] = bundle.hash;
    } catch {
      targetSourceHashes[t] = 'unknown';
    }
    try {
      const contract = sim.getContract();
      const contractHash = computeContractHash(contract);
      targetContractHashes[t] = contractHash;
    } catch {
      targetContractHashes[t] = 'unknown';
    }
  }

  // 8. Shared Production Budget Check for Live Provider
  const sharedLedger = options.budgetLedger || new BudgetLedger();
  if (providerKind === 'meta') {
    const status = sharedLedger.getStatus();
    const promptBytes = Number(effectiveConfig.maxPromptBytes);
    const outputTokens = Number(effectiveConfig.maxOutputTokens);

    let totalWorstCaseNeeded = 0;
    for (const m of models) {
      const worstCasePerCall = calculateWorstCaseCost(m, promptBytes, outputTokens);
      const callsForArm = trials * targets.length * maxExperiments;
      totalWorstCaseNeeded += callsForArm * worstCasePerCall;
    }

    if (status.remainingUsd < totalWorstCaseNeeded) {
      throw new Error(
        `Insufficient budget in shared production BudgetLedger at ${sharedLedger.getFilePath()}. ` +
        `Required worst-case: $${totalWorstCaseNeeded.toFixed(4)}, available: $${status.remainingUsd.toFixed(4)} ` +
        `(spent: $${status.spentUsd.toFixed(4)}, reserved: $${status.reservedUsd.toFixed(4)}, cap: $${status.totalBudgetUsd.toFixed(4)}). ` +
        `Enforced aggregate cap prevents launching unbudgeted requests.`
      );
    }
  }

  // 9. Initialize Report Structure & Provenance
  const reportId = options.id || `bench_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const freezeIdentities = await getFreezePathsAndIdentities();

  const baselineTrials: BaselineTrialResult[] = [];
  const armsMap: Record<
    string,
    {
      model: string;
      summary: ModelArmSummary;
      trials: ModelArmTrialResult[];
    }
  > = {};

  for (const m of models) {
    armsMap[m] = {
      model: m,
      summary: calculateModelArmSummary([], m, targets),
      trials: [],
    };
  }

  const report: BenchmarkReport = {
    schemaVersion: 1,
    kind: 'benchmark',
    id: reportId,
    timestamp: new Date().toISOString(),
    phase,
    status: 'running',
    config: {
      targets,
      models,
      trials,
      maxExperiments,
      seeds,
      provider: providerKind,
      configuration: effectiveConfig,
      freezePath: options.freezePath,
    },
    provenance: {
      providerMode: providerKind === 'mock' ? 'mock' : 'live',
      mockResultsNeverImplyLivePerformance: providerKind === 'mock',
      baselineIdentity: {
        file: 'src/evaluation.ts',
        sha256: freezeIdentities.baselineSha256,
        runtimeSha256: freezeIdentities.runtimeSha256,
        functions: freezeIdentities.functionIdentities,
      },
      promptVersion: PROMPT_VERSION,
      promptTemplateHash: PROMPT_TEMPLATE_HASH,
      promptModuleSha256: freezeIdentities.promptModuleSha256,
      dynamicPromptHash: freezeIdentities.dynamicPromptHash,
      targetSourceHashes,
      targetContractHashes,
      humanEffort: 'unmeasured',
    },
    baseline: calculateBaselineSummary([]),
    arms: armsMap,
    comparability: {
      status: providerKind === 'mock' ? 'mock-offline' : 'comparable',
      notes: [],
    },
  };

  // Atomically persist pending report BEFORE any calls
  await saveBenchmarkReport(report, benchmarksDir);
  await options.onUpdate?.(structuredClone(report));

  // 10. Freeze Verification Before Calls & Harness
  if (options.freezePath) {
    try {
      await verifyBenchmarkFreeze(options.freezePath);
    } catch (freezeErr) {
      report.status = 'failed';
      report.stopReason = freezeErr instanceof Error ? freezeErr.message : String(freezeErr);
      report.comparability = { status: 'violated', notes: [`Freeze verification failed: ${report.stopReason}`] };
      await saveBenchmarkReport(report, benchmarksDir);
      await options.onUpdate?.(structuredClone(report));
      throw freezeErr;
    }
  }

  // Pre-aborted signal check
  if (options.signal?.aborted) {
    report.status = 'cancelled';
    report.stopReason = 'Benchmark aborted before execution';
    report.comparability = computeAggregateComparability(report, trials, models, targets);
    await saveBenchmarkReport(report, benchmarksDir);
    await options.onUpdate?.(structuredClone(report));
    return report;
  }

  // 11. Execute Conventional Baseline (Once per target & seed)
  try {
    for (const target of targets) {
      for (let t = 0; t < trials; t++) {
        if (options.signal?.aborted) {
          report.status = 'cancelled';
          report.stopReason = 'Benchmark cancelled by user during baseline execution';
          report.comparability = computeAggregateComparability(report, trials, models, targets);
          await saveBenchmarkReport(report, benchmarksDir);
          await options.onUpdate?.(structuredClone(report));
          return report;
        }

        const seed = seeds[t]!;
        const baselineResult = runBaselineTrial(target, seed, maxExperiments, sim);
        baselineTrials.push(baselineResult);
        report.baseline = calculateBaselineSummary(baselineTrials);

        await saveBenchmarkReport(report, benchmarksDir);
        await options.onUpdate?.(structuredClone(report));
      }
    }
  } catch (baselineErr) {
    report.status = 'failed';
    report.stopReason = baselineErr instanceof Error ? baselineErr.message : String(baselineErr);
    report.comparability = computeAggregateComparability(report, trials, models, targets);
    await saveBenchmarkReport(report, benchmarksDir);
    await options.onUpdate?.(structuredClone(report));
    throw baselineErr;
  }

  // 12. Resolve Runner and Provider Factory
  let runner = options.runner;
  if (!runner) {
    const invMod = await import('./investigation/index.ts');
    runner = invMod.runInvestigation;
  }

  let providerFactory = options.providerFactory;
  if (!providerFactory) {
    const provMod = await import('./providers/index.ts');
    providerFactory = (kind: ProviderKind, model: string, config?: Record<string, string | number>) => {
      if (kind === 'meta') {
        const reasoningEffort = String(config?.reasoningEffort ?? config?.reasoning ?? 'low');
        const maxOutputTokens = Number(config?.maxOutputTokens ?? 4096);
        const maxPromptBytes = Number(config?.maxPromptBytes ?? 32768);
        const requestTimeoutMs = Number(config?.requestTimeoutMs ?? config?.timeoutMs ?? 90000);
        return provMod.createProvider('meta', {
          model,
          reasoningEffort,
          maxOutputTokens,
          maxPromptBytes,
          requestTimeoutMs,
          ledger: sharedLedger,
        });
      }
      return provMod.createProvider('mock');
    };
  }

  // Initial prompt hash tracking across ALL models and trials per target
  const initialPromptHashesByTarget: Record<string, string> = {};

  // 13. Execute Model Arms
  for (let t = 0; t < trials; t++) {
    const seed = seeds[t]!;

    if (options.freezePath) {
      try {
        await verifyBenchmarkFreeze(options.freezePath);
      } catch (freezeErr) {
        report.status = 'failed';
        report.stopReason = freezeErr instanceof Error ? freezeErr.message : String(freezeErr);
        report.comparability = { status: 'violated', notes: [`Freeze verification failed: ${report.stopReason}`] };
        await saveBenchmarkReport(report, benchmarksDir);
        await options.onUpdate?.(structuredClone(report));
        throw freezeErr;
      }
    }

    // Deterministic counterbalanced model order
    let armOrder: string[];
    if (models.length === 2) {
      armOrder = t % 2 === 0 ? [models[0]!, models[1]!] : [models[1]!, models[0]!];
    } else {
      armOrder = [...models];
    }

    for (let armIdx = 0; armIdx < armOrder.length; armIdx++) {
      const model = armOrder[armIdx]!;
      const armData = armsMap[model]!;

      for (const target of targets) {
        if (options.signal?.aborted) {
          report.status = 'cancelled';
          report.stopReason = 'Benchmark cancelled by user between arms';
          report.comparability = computeAggregateComparability(report, trials, models, targets);
          await saveBenchmarkReport(report, benchmarksDir);
          await options.onUpdate?.(structuredClone(report));
          return report;
        }

        const t0 = now();
        let timeToFirstVerifiedFindingMs: number | null = null;
        let trialRecord: InvestigationRecord | undefined;

        // Persist ACTIVE trial BEFORE invocation
        const trialResult: ModelArmTrialResult = {
          trial: t + 1,
          seed,
          target,
          model,
          armIndex: armIdx,
          armOrder,
          providerCallCount: null,
          confirmedNetworkRequests: null,
          uncertainNetworkRequests: null,
          executedExperimentCount: 0,
          validPlanCount: 0,
          invalidPlanCount: 0,
          invalidResponseCount: 0,
          truncationCount: 0,
          findingTrial: false,
          rawViolatedInvariantIds: [],
          verifiedInvariantIds: [],
          usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
          unknownUsageCount: 0,
          elapsedMs: 0,
          timeToFirstVerifiedFindingMs: null,
          status: 'running',
          errorReason: undefined,
          initialPromptHash: undefined,
          initialRequestHash: undefined,
          comparabilityStatus: providerKind === 'mock' ? 'mock-offline' : 'comparable',
          comparabilityNote: undefined,
          record: undefined,
          metricsComplete: false,
        };

        armData.trials.push(trialResult);
        armData.summary = calculateModelArmSummary(armData.trials, model, targets);
        report.comparability = computeAggregateComparability(report, trials, models, targets);
        await saveBenchmarkReport(report, benchmarksDir);
        await options.onUpdate?.(structuredClone(report));

        const onRunnerUpdate = async (rec: InvestigationRecord) => {
          trialRecord = rec;
          const currentNow = now();
          if (rec.findings && rec.findings.length > 0) {
            for (const f of rec.findings) {
              if (f.reproduced && f.cleanControlPassed && timeToFirstVerifiedFindingMs === null) {
                timeToFirstVerifiedFindingMs = Math.max(0, currentNow - t0);
                break;
              }
            }
          }
          updateTrialResultFromRecord(
            trialResult,
            rec,
            providerKind,
            t0,
            currentNow,
            timeToFirstVerifiedFindingMs
          );
          armData.summary = calculateModelArmSummary(armData.trials, model, targets);
          report.comparability = computeAggregateComparability(report, trials, models, targets);
          await saveBenchmarkReport(report, benchmarksDir);
          await options.onUpdate?.(structuredClone(report));
        };

        try {
          const providerInstance = providerFactory(providerKind, model, effectiveConfig);

          const returnedRecord = await runner({
            id: `run_bench_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
            variant: target,
            maxExperiments,
            maxProposalAttempts: maxExperiments,
            provider: providerInstance,
            simulator: sim,
            signal: options.signal,
            onUpdate: onRunnerUpdate,
          });

          trialRecord = returnedRecord || trialRecord;
          const currentNow = now();
          if (trialRecord?.findings && trialRecord.findings.length > 0) {
            for (const f of trialRecord.findings) {
              if (f.reproduced && f.cleanControlPassed && timeToFirstVerifiedFindingMs === null) {
                timeToFirstVerifiedFindingMs = Math.max(0, currentNow - t0);
                break;
              }
            }
          }

          updateTrialResultFromRecord(
            trialResult,
            trialRecord,
            providerKind,
            t0,
            currentNow,
            timeToFirstVerifiedFindingMs
          );

          if (trialRecord?.status === 'cancelled') {
            trialResult.status = 'cancelled';
            trialResult.errorReason = trialRecord.stopReason || 'Trial cancelled';
          } else if (trialRecord?.status === 'failed') {
            trialResult.status = 'failed';
            trialResult.errorReason = trialRecord.stopReason || trialRecord.errors?.join('; ') || 'Trial failed';
          } else {
            trialResult.status = 'completed';
          }
        } catch (err) {
          // If runner throws after update, retain its last record
          const currentNow = now();
          if (trialRecord?.findings && trialRecord.findings.length > 0) {
            for (const f of trialRecord.findings) {
              if (f.reproduced && f.cleanControlPassed && timeToFirstVerifiedFindingMs === null) {
                timeToFirstVerifiedFindingMs = Math.max(0, currentNow - t0);
                break;
              }
            }
          }

          updateTrialResultFromRecord(
            trialResult,
            trialRecord,
            providerKind,
            t0,
            currentNow,
            timeToFirstVerifiedFindingMs
          );
          trialResult.status = 'failed';
          trialResult.errorReason = err instanceof Error ? err.message : String(err);
          if (!trialRecord) {
            trialResult.metricsComplete = false;
          }
        }

        // Comparability Assessment for this trial
        if (providerKind === 'mock') {
          trialResult.comparabilityStatus = 'mock-offline';
        } else {
          // Live provider comparability
          const expectedSourceHash = targetSourceHashes[target];
          const expectedContractHash = targetContractHashes[target];

          // 1. Violations dominate
          let violationNote: string | undefined;
          let missingIdentity = !trialRecord?.sourceHash || !trialRecord.contextAudit?.contractHash;
          let currentIdentityProblem: string | undefined;
          // Recheck the actual context after inference; the saved record describes the initial context.
          try {
            const currentHash = sim.getSourceBundle(target).hash;
            if (expectedSourceHash !== 'unknown' && currentHash !== expectedSourceHash) {
              violationNote = `Target sourceHash changed during the trial: expected ${expectedSourceHash}, got ${currentHash}.`;
            }
          } catch (error) {
            missingIdentity = true;
            currentIdentityProblem = `Current target source identity is unavailable after the trial: ${error instanceof Error ? error.message : String(error)}`;
          }
          try {
            const currentHash = computeContractHash(sim.getContract());
            if (expectedContractHash !== 'unknown' && currentHash !== expectedContractHash) {
              violationNote = `Target contractHash changed during the trial: expected ${expectedContractHash}, got ${currentHash}.`;
            }
          } catch (error) {
            missingIdentity = true;
            currentIdentityProblem = `Current target contract identity is unavailable after the trial: ${error instanceof Error ? error.message : String(error)}`;
          }
          const expectedConfiguration: Record<string, string | number> = {
            model, reasoningEffort: String(effectiveConfig.reasoningEffort), temperature: 0.2,
            maxOutputTokens: Number(effectiveConfig.maxOutputTokens),
            maxPromptBytes: Number(effectiveConfig.maxPromptBytes),
            requestTimeoutMs: Number(effectiveConfig.requestTimeoutMs),
          };
          for (const attempt of trialRecord?.proposalAttempts ?? []) {
            const configuration = attempt.request?.configuration;
            if (!configuration) {
              missingIdentity = true;
              continue;
            }
            for (const [key, expected] of Object.entries(expectedConfiguration)) {
              const observed = configuration[key];
              if (observed === undefined) missingIdentity = true;
              else if (observed !== expected) {
                violationNote = `Actual request configuration diverged for ${model}: ${key} expected ${expected}, got ${observed}.`;
              }
            }
          }
          if (expectedSourceHash && expectedSourceHash !== 'unknown' && trialRecord?.sourceHash && trialRecord.sourceHash !== expectedSourceHash) {
            violationNote = `Target sourceHash drifted: expected ${expectedSourceHash}, got ${trialRecord.sourceHash}.`;
          } else if (expectedContractHash && expectedContractHash !== 'unknown' && trialRecord?.contextAudit?.contractHash && trialRecord.contextAudit.contractHash !== expectedContractHash) {
            violationNote = `Target contractHash drifted: expected ${expectedContractHash}, got ${trialRecord.contextAudit.contractHash}.`;
          } else if (trialRecord && trialRecord.model !== model) {
            violationNote = `Trial model diverged from arm model: expected ${model}, got ${trialRecord.model}.`;
          } else if (trialResult.initialPromptHash) {
            const canonicalPromptHash = initialPromptHashesByTarget[target];
            if (!canonicalPromptHash) {
              initialPromptHashesByTarget[target] = trialResult.initialPromptHash;
            } else if (canonicalPromptHash !== trialResult.initialPromptHash) {
              violationNote = `Initial promptHash diverged across models for target ${target}: got ${trialResult.initialPromptHash}, expected ${canonicalPromptHash}.`;
            }
          }

          if (violationNote) {
            trialResult.comparabilityStatus = 'violated';
            trialResult.comparabilityNote = violationNote;
          } else if (
            !trialResult.initialPromptHash ||
            !trialResult.metricsComplete ||
            trialResult.providerCallCount === null ||
            expectedSourceHash === 'unknown' ||
            expectedContractHash === 'unknown' ||
            missingIdentity ||
            !trialRecord
          ) {
            trialResult.comparabilityStatus = 'incomplete';
            if (!trialResult.initialPromptHash) {
              trialResult.comparabilityNote = `Target ${target}, trial ${t + 1}, model ${model} missing initial promptHash audit.`;
            } else if (expectedSourceHash === 'unknown') {
              trialResult.comparabilityNote = `Target ${target} missing resolved source identity.`;
            } else if (expectedContractHash === 'unknown') {
              trialResult.comparabilityNote = `Target ${target} missing resolved contract identity.`;
            } else if (!trialResult.metricsComplete) {
              trialResult.comparabilityNote = `Target ${target}, trial ${t + 1}, model ${model} missing complete attempt metrics.`;
            } else if (missingIdentity) {
              trialResult.comparabilityNote = currentIdentityProblem || `Target ${target}, trial ${t + 1}, model ${model} missing actual source, contract or request configuration identity.`;
            } else {
              trialResult.comparabilityNote = `Target ${target}, trial ${t + 1}, model ${model} incomplete trial record.`;
            }
          } else {
            trialResult.comparabilityStatus = 'comparable';
          }
        }

        armData.summary = calculateModelArmSummary(armData.trials, model, targets);
        report.comparability = computeAggregateComparability(report, trials, models, targets);
        await saveBenchmarkReport(report, benchmarksDir);
        await options.onUpdate?.(structuredClone(report));

        if (options.signal?.aborted) {
          report.status = 'cancelled';
          report.stopReason = 'Benchmark cancelled by user';
          report.comparability = computeAggregateComparability(report, trials, models, targets);
          await saveBenchmarkReport(report, benchmarksDir);
          await options.onUpdate?.(structuredClone(report));
          return report;
        }
      }
    }
  }

  // 14. Finalize Report
  report.status = 'completed';
  report.comparability = computeAggregateComparability(report, trials, models, targets);
  await saveBenchmarkReport(report, benchmarksDir);
  await options.onUpdate?.(structuredClone(report));

  return report;
}
