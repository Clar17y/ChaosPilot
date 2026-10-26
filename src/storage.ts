import {
  TARGET_VARIANTS,
  type TargetVariant,
  type InvestigationRecord,
  type Experiment,
  type ExperimentResult,
  type SourceBundle,
} from './domain.ts';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { compareSemanticReplay } from './evidence.ts';

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
}

export interface SimulatorApi {
  getSourceBundle(variant: TargetVariant): SourceBundle;
  executeExperiment(experiment: Experiment, variant: TargetVariant): ExperimentResult;
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

        summaries.push({
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
        });
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
  let record: InvestigationRecord | null;
  if (typeof target === 'string') {
    record = await getRun(target, runsDir);
    if (!record) {
      throw new Error(`Cannot replay: Run "${target}" not found or malformed.`);
    }
  } else {
    record = target;
  }

  const simulator = simulatorOverride || (await getSimulatorApi());

  // 1. Check current source bundle hash for the target variant
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

  // 2. Deterministically replay each experiment without model invocation
  const outcomes: ReplayExperimentOutcome[] = [];
  let experimentsReproduced = 0;

  for (let i = 0; i < record.experiments.length; i++) {
    const expRecord = record.experiments[i]!;
    const replayedResult = simulator.executeExperiment(expRecord.experiment, record.variant);
    const origResult = expRecord.result;

    const comparison = compareSemanticReplay(origResult, replayedResult);
    const validityMatched = comparison.validityMatched;
    const vComp = { matched: comparison.violationsMatched };
    const rComp = { matched: comparison.rejectionsMatched };
    const tComp = { matched: comparison.traceMatched };
    const sComp = { matched: comparison.snapshotMatched };
    const mismatches = comparison.mismatches;
    const exactMatched = comparison.matched;

    if (exactMatched) {
      experimentsReproduced++;
    }

    outcomes.push({
      index: expRecord.index ?? i,
      originalViolationsCount: (origResult.violations || []).length,
      replayedViolationsCount: (replayedResult.violations || []).length,
      violationsMatched: vComp.matched,
      traceMatched: tComp.matched,
      snapshotMatched: sComp.matched,
      rejectionsMatched: rComp.matched,
      validityMatched,
      exactMatched,
      mismatches,
      valid: replayedResult.valid,
      replayedResult,
    });
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
