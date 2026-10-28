import {
  TARGET_VARIANTS,
  type TargetVariant,
  type InvestigationRecord,
  type Experiment,
  type ExperimentResult,
  type SourceBundle,
  type SystemContract,
} from './domain.ts';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { compareSemanticReplay } from './evidence.ts';
export {
  SEEDED_TRADING_BRIEF,
  validateSystemId,
  validateSystemBrief,
  computeSnapshotHash,
  resolveSystemPath,
  ensureSeededSystem,
  getSystemBrief,
  listSystemBriefs,
  saveSystemBrief,
  createSystemSnapshot,
  type SaveSystemOptions,
} from './systems/index.ts';

export interface RunSummary {
  id: string;
  provider: string;
  model: string;
  mode: 'live' | 'mock';
  variant: TargetVariant;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  startedAt: string;
  finishedAt?: string;
  findingsCount: number;
  experimentsCount: number;
  sourceHash: string;
  /** Minimal pinned brief metadata, present only when the record carries a snapshot. */
  systemBrief?: {
    id: string;
    name: string;
    revision: number;
    adapterId: string;
    hash: string;
  };
}

export interface ReplayExperimentOutcome {
  index: number;
  originalViolationsCount: number;
  replayedViolationsCount: number;
  violationsMatched: boolean;
  traceMatched?: boolean;
  snapshotMatched?: boolean;
  rejectionsMatched?: boolean;
  validityMatched?: boolean;
  exactMatched?: boolean;
  mismatches?: string[];
  valid: boolean;
  replayedResult: ExperimentResult;
}

export interface ReplayReport {
  runId: string;
  variant: TargetVariant;
  originalSourceHash: string;
  currentSourceHash: string;
  sourceIdentical: boolean;
  exactReproductionClaimed: boolean;
  reproduced: boolean;
  experimentsTotal: number;
  experimentsReproduced: number;
  outcomes: ReplayExperimentOutcome[];
  timestamp: string;
  note?: string;
  /** Present only on selected-experiment replay reports. */
  scope?: 'experiment';
  /** Zero-based array position of the selected experiment, when scoped. */
  experimentPosition?: number;
}

export interface SimulatorApi {
  getSourceBundle(variant: TargetVariant): SourceBundle;
  executeExperiment(experiment: Experiment, variant: TargetVariant): ExperimentResult;
  getContract?(): SystemContract;
}

let cachedSimulatorApi: SimulatorApi | null = null;

export function setSimulatorApi(api: SimulatorApi | null): void {
  cachedSimulatorApi = api;
}

export async function getSimulatorApi(): Promise<SimulatorApi> {
  if (cachedSimulatorApi) {
    return cachedSimulatorApi;
  }
  try {
    // Dynamic import of simulator
    const sim = await import('./simulator/index.ts');
    return sim as unknown as SimulatorApi;
  } catch (err) {
    throw new Error(`Failed to load simulator module: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const isKnownTargetVariant = (v: unknown): v is TargetVariant =>
  typeof v === 'string' && (TARGET_VARIANTS as readonly string[]).includes(v);

const VALID_PROVIDERS = new Set(['mock', 'meta']);
const VALID_MODES = new Set(['live', 'mock']);
const VALID_STATUSES = new Set(['running', 'completed', 'cancelled', 'failed']);

/**
 * Validates that an ID is safe and conforms to generated run ID format.
 * Prevents directory traversal, arbitrary paths, and ledger file access.
 */
export function validateRunId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (trimmed.length < 4 || trimmed.length > 64) return false;
  // Disallow any path separators, parent navigation, or control chars
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return false;
  // Disallow ledger identifiers so private usage ledger is never accessible as a run
  const lower = trimmed.toLowerCase();
  if (lower.includes('ledger')) return false;
  return true;
}

/**
 * Normalizes input run target (supporting safe runs/<id>.json path, <id>.json, or <id>).
 */
export function normalizeRunInput(target: string, runsDir = 'runs'): string | null {
  const trimmed = target.trim();
  if (!trimmed) return null;

  if (trimmed.endsWith('.json') || trimmed.includes('/') || trimmed.includes('\\')) {
    const resolvedPath = path.resolve(trimmed);
    const resolvedRunsDir = path.resolve(runsDir);
    if (resolvedPath.startsWith(resolvedRunsDir + path.sep)) {
      const rel = path.relative(resolvedRunsDir, resolvedPath);
      if (rel.includes(path.sep)) return null;
      const base = path.basename(rel, '.json');
      return validateRunId(base) ? base : null;
    }
    const base = path.basename(trimmed, '.json');
    return validateRunId(base) ? base : null;
  }
  return validateRunId(trimmed) ? trimmed : null;
}

/**
 * Validates full schema, variant, and provenance shape for an InvestigationRecord.
 * Matches filename ID to reject ID mismatches.
 */
export function isValidInvestigationRecord(
  parsed: unknown,
  expectedId?: string
): parsed is InvestigationRecord {
  if (!parsed || typeof parsed !== 'object') return false;
  const r = parsed as Record<string, unknown>;

  if (r.schemaVersion !== 1) return false;
  if (typeof r.id !== 'string' || !validateRunId(r.id)) return false;
  if (expectedId && r.id !== expectedId) return false;

  if (typeof r.variant !== 'string' || !isKnownTargetVariant(r.variant)) return false;
  if (typeof r.provider !== 'string' || !VALID_PROVIDERS.has(r.provider)) return false;
  if (typeof r.mode !== 'string' || !VALID_MODES.has(r.mode)) return false;
  if (typeof r.status !== 'string' || !VALID_STATUSES.has(r.status)) return false;
  if (typeof r.startedAt !== 'string' || !r.startedAt) return false;
  if (typeof r.sourceHash !== 'string' || !r.sourceHash) return false;

  if (!Array.isArray(r.experiments)) return false;
  if (!Array.isArray(r.findings)) return false;

  return true;
}

/**
 * Resolves and verifies that the file path remains strictly inside the runs directory.
 */
function resolveRunPath(runsDir: string, id: string): string {
  if (!validateRunId(id)) {
    throw new Error(`Invalid run ID: ${id}`);
  }
  const resolvedDir = path.resolve(runsDir);
  const resolvedPath = path.resolve(resolvedDir, `${id}.json`);
  if (!resolvedPath.startsWith(resolvedDir + path.sep)) {
    throw new Error(`Path traversal attempt detected for run ID: ${id}`);
  }
  return resolvedPath;
}

/**
 * Saves an InvestigationRecord atomically to the runs directory.
 */
export async function saveRun(record: InvestigationRecord, runsDir = 'runs'): Promise<string> {
  if (!validateRunId(record.id)) {
    throw new Error(`Cannot save run: Invalid run ID "${record.id}"`);
  }

  await fs.mkdir(runsDir, { recursive: true });
  const finalPath = resolveRunPath(runsDir, record.id);
  const tempPath = path.join(
    runsDir,
    `.tmp-${record.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`
  );

  const serialized = JSON.stringify(record, null, 2);
  await fs.writeFile(tempPath, serialized, 'utf8');
  await fs.rename(tempPath, finalPath);

  return finalPath;
}

/**
 * Retrieves a single InvestigationRecord by ID or safe runs path.
 * Returns null if not found, malformed, variant invalid, or ID mismatched.
 */
export async function getRun(idOrPath: string, runsDir = 'runs'): Promise<InvestigationRecord | null> {
  const id = normalizeRunInput(idOrPath, runsDir);
  if (!id || !validateRunId(id)) {
    return null;
  }

  try {
    const filePath = resolveRunPath(runsDir, id);
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content);

    if (!isValidInvestigationRecord(parsed, id)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Lists all valid run records in the runs directory.
 * Safely skips malformed artifacts, invalid variants, ID mismatches, and excludes private usage ledgers.
 */
export async function listRuns(runsDir = 'runs'): Promise<RunSummary[]> {
  try {
    await fs.mkdir(runsDir, { recursive: true });
    const entries = await fs.readdir(runsDir, { withFileTypes: true });
    const summaries: RunSummary[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.json')) continue;
      if (entry.name.startsWith('.')) continue;

      const runId = entry.name.slice(0, -'.json'.length);
      if (!validateRunId(runId)) {
        continue;
      }

      const filePath = path.join(runsDir, entry.name);
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(content);

        if (!isValidInvestigationRecord(parsed, runId)) {
          continue;
        }

        const summary: RunSummary = {
          id: parsed.id,
          provider: parsed.provider,
          model: parsed.model || 'unknown',
          mode: parsed.mode,
          variant: parsed.variant,
          status: parsed.status,
          startedAt: parsed.startedAt,
          finishedAt: parsed.finishedAt,
          findingsCount: parsed.findings.length,
          experimentsCount: parsed.experiments.length,
          sourceHash: parsed.sourceHash,
        };
        const snap = (parsed as InvestigationRecord).systemBrief;
        if (
          snap && typeof snap === 'object' &&
          snap.brief && typeof snap.brief.id === 'string' &&
          typeof snap.brief.revision === 'number'
        ) {
          summary.systemBrief = {
            id: snap.brief.id,
            name: typeof snap.brief.name === 'string' ? snap.brief.name : snap.brief.id,
            revision: snap.brief.revision,
            adapterId: typeof snap.brief.adapterId === 'string' ? snap.brief.adapterId : 'unconfigured',
            hash: typeof snap.hash === 'string' ? snap.hash : '',
          };
        }
        summaries.push(summary);
      } catch {
        continue;
      }
    }

    summaries.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return summaries;
  } catch {
    return [];
  }
}

/**
 * Deletes a run record safely.
 */
export async function deleteRun(id: string, runsDir = 'runs'): Promise<boolean> {
  if (!validateRunId(id)) return false;
  try {
    const filePath = resolveRunPath(runsDir, id);
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}



/**
 * Parses a zero-based experiment array position.
 * Accepts only a nonnegative safe integer or its canonical decimal string
 * form ("0", "1", "12", ...). Rejects negatives, fractions, leading zeros,
 * signs, whitespace, exponent/hex forms, empty/missing values and overflow.
 */
export function parseExperimentPosition(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value + 0 : null;
  }
  if (typeof value === 'string') {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

async function resolveReplayRecord(
  target: string | InvestigationRecord,
  runsDir: string
): Promise<InvestigationRecord> {
  if (typeof target === 'string') {
    const record = await getRun(target, runsDir);
    if (!record) {
      throw new Error(`Cannot replay: Run "${target}" not found or malformed.`);
    }
    return record;
  }
  if (!target || typeof target !== 'object' || !Array.isArray(target.experiments)) {
    throw new Error('Cannot replay: Run record is malformed.');
  }
  return target;
}

function currentSourceIdentity(
  record: InvestigationRecord,
  simulator: SimulatorApi
): { currentSourceHash: string; sourceIdentical: boolean } {
  let currentSourceHash = '';
  try {
    const currentBundle = simulator.getSourceBundle(record.variant);
    currentSourceHash = currentBundle.hash;
  } catch {
    currentSourceHash = 'unavailable';
  }
  const sourceIdentical = Boolean(
    currentSourceHash &&
    currentSourceHash !== 'unavailable' &&
    record.sourceHash &&
    currentSourceHash === record.sourceHash
  );
  return { currentSourceHash, sourceIdentical };
}

function replayOneExperiment(
  record: InvestigationRecord,
  position: number,
  simulator: SimulatorApi
): { outcome: ReplayExperimentOutcome; exactMatched: boolean } {
  const expRecord = record.experiments[position];
  if (
    !expRecord || typeof expRecord !== 'object' ||
    !expRecord.experiment || typeof expRecord.experiment !== 'object' ||
    !expRecord.result || typeof expRecord.result !== 'object'
  ) {
    throw new Error('Cannot replay: Selected experiment is malformed.');
  }
  const replayedResult = simulator.executeExperiment(expRecord.experiment, record.variant);
  if (!replayedResult || typeof replayedResult !== 'object') {
    throw new Error('Cannot replay: Selected experiment execution returned a malformed result.');
  }
  const origResult = expRecord.result;
  const comparison = compareSemanticReplay(origResult, replayedResult);
  const outcome: ReplayExperimentOutcome = {
    index: expRecord.index ?? position,
    originalViolationsCount: (origResult.violations || []).length,
    replayedViolationsCount: (replayedResult.violations || []).length,
    violationsMatched: comparison.violationsMatched,
    traceMatched: comparison.traceMatched,
    snapshotMatched: comparison.snapshotMatched,
    rejectionsMatched: comparison.rejectionsMatched,
    validityMatched: comparison.validityMatched,
    exactMatched: comparison.matched,
    mismatches: comparison.mismatches,
    valid: replayedResult.valid,
    replayedResult,
  };
  return { outcome, exactMatched: comparison.matched };
}

/**
 * Replays an investigation record deterministically using the simulator.
 * Requires source identity AND exact trace, snapshots, violations, rejections,
 * and validity comparison before claiming exact reproduction.
 * Does NOT invoke any model or provider.
 */
export async function replayRun(
  target: string | InvestigationRecord,
  runsDir = 'runs',
  simulatorOverride?: SimulatorApi
): Promise<ReplayReport> {
  const record = await resolveReplayRecord(target, runsDir);
  const simulator = simulatorOverride || (await getSimulatorApi());
  const { currentSourceHash, sourceIdentical } = currentSourceIdentity(record, simulator);

  // Deterministically replay each experiment without model invocation
  const outcomes: ReplayExperimentOutcome[] = [];
  let experimentsReproduced = 0;

  for (let i = 0; i < record.experiments.length; i++) {
    const { outcome, exactMatched } = replayOneExperiment(record, i, simulator);
    if (exactMatched) {
      experimentsReproduced++;
    }
    outcomes.push(outcome);
  }

  const allExactMatched =
    record.experiments.length > 0 &&
    experimentsReproduced === record.experiments.length;

  // Exact reproduction can ONLY be claimed if source is identical AND all exact semantic comparisons match
  const exactReproductionClaimed = sourceIdentical && allExactMatched;
  const reproduced = exactReproductionClaimed;

  let note: string;
  if (!sourceIdentical) {
    note = `Source changed or diverged: original source hash (${record.sourceHash}) does not match current runtime source hash (${currentSourceHash}). Exact reproduction cannot be claimed.`;
  } else if (!allExactMatched) {
    note = `Source identical, but execution trace or snapshot diverged from original run. Exact reproduction failed.`;
  } else {
    note = `Source identical: exact reproduction verified deterministically with no provider invocation (trace, snapshot, violations, rejections, validity all match).`;
  }

  return {
    runId: record.id,
    variant: record.variant,
    originalSourceHash: record.sourceHash,
    currentSourceHash,
    sourceIdentical,
    exactReproductionClaimed,
    reproduced,
    experimentsTotal: record.experiments.length,
    experimentsReproduced,
    outcomes,
    timestamp: new Date().toISOString(),
    note,
  };
}

/**
 * Replays exactly one saved experiment, selected by its zero-based position
 * in the saved experiments array (not the recorded experiment index, so
 * legacy/missing/noncontiguous indices do not affect selection).
 * Requires source identity AND the shared semantic comparison of the selected
 * experiment before claiming exact reproduction. Does NOT invoke any model
 * or provider, does not rerun any clean comparison, and does not mutate or
 * persist saved evidence.
 */
export async function replaySelectedExperiment(
  target: string | InvestigationRecord,
  position: unknown,
  runsDir = 'runs',
  simulatorOverride?: SimulatorApi
): Promise<ReplayReport> {
  const experimentPosition = parseExperimentPosition(position);
  if (experimentPosition === null) {
    throw new Error('Invalid experiment position: expected a nonnegative integer position.');
  }
  const record = await resolveReplayRecord(target, runsDir);
  if (experimentPosition >= record.experiments.length) {
    throw new Error(
      `Experiment position ${experimentPosition} is out of range for run "${record.id}".`
    );
  }
  const simulator = simulatorOverride || (await getSimulatorApi());
  const { currentSourceHash, sourceIdentical } = currentSourceIdentity(record, simulator);

  const { outcome, exactMatched } = replayOneExperiment(record, experimentPosition, simulator);

  const exactReproductionClaimed = sourceIdentical && exactMatched;
  // Keep the existing run-wide count semantics: a counted result includes
  // the recorded result's source hash as well as its trace and outcomes.
  // Behaviour can still match when source identity differs; report that
  // separately without treating it as an exact reproduction.
  const semanticMatched = outcome.traceMatched && outcome.snapshotMatched && outcome.violationsMatched && outcome.rejectionsMatched && outcome.validityMatched;
  const experimentsReproduced = exactMatched ? 1 : 0;

  let note: string;
  if (!sourceIdentical) {
    note = semanticMatched
      ? `Source changed or diverged: original source hash (${record.sourceHash}) does not match current runtime source hash (${currentSourceHash}). The selected experiment semantically matched (trace, snapshot, violations, rejections, validity), but exact reproduction cannot be claimed for the selected experiment. No clean comparison was rerun and no model was invoked.`
      : `Source changed or diverged: original source hash (${record.sourceHash}) does not match current runtime source hash (${currentSourceHash}). The selected experiment did not semantically match, and exact reproduction cannot be claimed for the selected experiment. No clean comparison was rerun and no model was invoked.`;
  } else if (!exactMatched) {
    note = `Source identical, but the selected experiment's saved result and replay did not match exactly. See the mismatch details. No clean comparison was rerun and no model was invoked.`;
  } else {
    note = `Source identical: selected experiment reproduced exactly with no provider invocation (trace, snapshot, violations, rejections, validity all match). No clean comparison was rerun.`;
  }

  return {
    runId: record.id,
    variant: record.variant,
    originalSourceHash: record.sourceHash,
    currentSourceHash,
    sourceIdentical,
    exactReproductionClaimed,
    reproduced: exactReproductionClaimed,
    experimentsTotal: 1,
    experimentsReproduced,
    outcomes: [outcome],
    timestamp: new Date().toISOString(),
    note,
    scope: 'experiment',
    experimentPosition,
  };
}

/** Alias for {@link replaySelectedExperiment}. */
export const replayExperiment = replaySelectedExperiment;

export interface BenchmarkReportSummary {
  id: string;
  kind: 'benchmark';
  phase: string;
  status: string;
  timestamp: string;
  provider: string;
  mode: 'live' | 'mock';
  models: string[];
  targets: TargetVariant[];
  trials: number;
}

export function validateBenchmarkId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (trimmed.length < 4 || trimmed.length > 64) return false;
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  if (lower.includes('ledger')) return false;
  return true;
}

export function normalizeBenchmarkInput(target: string, benchmarksDir = 'runs/benchmarks'): string | null {
  const trimmed = target.trim();
  if (!trimmed) return null;

  if (trimmed.endsWith('.json') || trimmed.includes('/') || trimmed.includes('\\')) {
    const resolvedPath = path.resolve(trimmed);
    const resolvedDir = path.resolve(benchmarksDir);
    if (resolvedPath.startsWith(resolvedDir + path.sep)) {
      const rel = path.relative(resolvedDir, resolvedPath);
      if (rel.includes(path.sep)) return null;
      const base = path.basename(rel, '.json');
      return validateBenchmarkId(base) ? base : null;
    }
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      return null;
    }
    const base = path.basename(trimmed, '.json');
    return validateBenchmarkId(base) ? base : null;
  }
  return validateBenchmarkId(trimmed) ? trimmed : null;
}

export function isValidBenchmarkReport(
  parsed: unknown,
  expectedId?: string
): parsed is Record<string, unknown> {
  if (!parsed || typeof parsed !== 'object') return false;
  const r = parsed as Record<string, unknown>;

  if (r.schemaVersion !== 1) return false;
  if (r.kind !== 'benchmark') return false;
  if (typeof r.id !== 'string' || !validateBenchmarkId(r.id)) return false;
  if (expectedId && r.id !== expectedId) return false;

  if (typeof r.status !== 'string' || !VALID_STATUSES.has(r.status)) return false;
  if (typeof r.timestamp !== 'string' || !r.timestamp) return false;
  if (!r.config || typeof r.config !== 'object') return false;
  if (!r.provenance || typeof r.provenance !== 'object') return false;
  if (!r.baseline || typeof r.baseline !== 'object') return false;
  if (!r.arms || typeof r.arms !== 'object') return false;

  return true;
}

function resolveBenchmarkPath(benchmarksDir: string, id: string): string {
  if (!validateBenchmarkId(id)) {
    throw new Error(`Invalid benchmark ID: ${id}`);
  }
  const resolvedDir = path.resolve(benchmarksDir);
  const resolvedPath = path.resolve(resolvedDir, `${id}.json`);
  if (!resolvedPath.startsWith(resolvedDir + path.sep)) {
    throw new Error(`Path traversal attempt detected for benchmark ID: ${id}`);
  }
  return resolvedPath;
}

export async function saveBenchmarkReport<T extends { id: string }>(
  report: T,
  benchmarksDir = 'runs/benchmarks'
): Promise<string> {
  if (!validateBenchmarkId(report.id)) {
    throw new Error(`Cannot save benchmark: Invalid benchmark ID "${report.id}"`);
  }

  await fs.mkdir(benchmarksDir, { recursive: true });
  const finalPath = resolveBenchmarkPath(benchmarksDir, report.id);
  const tempPath = path.join(
    benchmarksDir,
    `.tmp-${report.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`
  );

  const serialized = JSON.stringify(report, null, 2);
  await fs.writeFile(tempPath, serialized, 'utf8');
  await fs.rename(tempPath, finalPath);

  return finalPath;
}

export async function getBenchmarkReport<T = unknown>(
  idOrPath: string,
  benchmarksDir = 'runs/benchmarks'
): Promise<T | null> {
  const id = normalizeBenchmarkInput(idOrPath, benchmarksDir);
  if (!id || !validateBenchmarkId(id)) {
    return null;
  }

  try {
    const filePath = resolveBenchmarkPath(benchmarksDir, id);
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content);

    if (!isValidBenchmarkReport(parsed, id)) {
      return null;
    }

    return parsed as T;
  } catch {
    return null;
  }
}

export async function listBenchmarkReports(
  benchmarksDir = 'runs/benchmarks'
): Promise<BenchmarkReportSummary[]> {
  try {
    await fs.mkdir(benchmarksDir, { recursive: true });
    const entries = await fs.readdir(benchmarksDir, { withFileTypes: true });
    const summaries: BenchmarkReportSummary[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.json')) continue;
      if (entry.name.startsWith('.')) continue;

      const benchId = entry.name.slice(0, -'.json'.length);
      if (!validateBenchmarkId(benchId)) {
        continue;
      }

      const filePath = path.join(benchmarksDir, entry.name);
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(content);

        if (!isValidBenchmarkReport(parsed, benchId)) {
          continue;
        }

        const config = (parsed.config || {}) as Record<string, unknown>;
        const prov = (parsed.provenance || {}) as Record<string, unknown>;

        summaries.push({
          id: parsed.id as string,
          kind: 'benchmark',
          phase: (parsed.phase as string) || 'calibration',
          status: parsed.status as string,
          timestamp: parsed.timestamp as string,
          provider: (config.provider as string) || 'unknown',
          mode: (prov.providerMode as 'live' | 'mock') || 'mock',
          models: Array.isArray(config.models) ? (config.models as string[]) : [],
          targets: Array.isArray(config.targets) ? (config.targets as TargetVariant[]) : [],
          trials: typeof config.trials === 'number' ? config.trials : 0,
        });
      } catch {
        continue;
      }
    }

    summaries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return summaries;
  } catch {
    return [];
  }
}
