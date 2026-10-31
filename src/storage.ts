import {
  ALL_TARGET_VARIANTS,
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
import { evidenceHashOf } from './explanations/index.ts';
import { canonicalJson, compareSemanticReplay, computeContractHash, computeLegacyRawContractHash } from './evidence.ts';
import { assertAdapterVariant, resolveAdapter } from './adapters/index.ts';
import { resolveExperimentPositionForIndex } from './experiment-identity.ts';
import { computeSnapshotHash, validateSystemBrief } from './systems/index.ts';
import { getPromptIdentity } from './investigation/prompt.ts';
import { evaluateRequirementRules } from './requirements/evaluator.ts';
import { isRequirementEvaluatorIdentity, requirementEvaluatorAvailable } from './requirements/identity.ts';
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
  /** Trace/snapshot/violations/rejections/validity matched, regardless of source identity. Distinct from exact reproduction. */
  behaviorMatched?: boolean;
  mismatches?: string[];
  valid: boolean;
  replayedResult: ExperimentResult;
  /** Present only when the saved result or pinned snapshot carries requirement-rule evidence. */
  ruleResultsMatched?: boolean;
  deliveryObservationsMatched?: boolean;
}

export type ReplayContextStatus = 'identical' | 'drifted' | 'unknown' | 'unverified-legacy';

export interface ReplayContextCheck {
  kind: 'prompt' | 'contract' | 'contract-hash' | 'clean-source' | 'target-source' | 'system-brief' | 'requirement-evaluator';
  status: ReplayContextStatus;
  detail: string;
  saved?: string;
  current?: string;
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
  contextChecks?: ReplayContextCheck[];
  contextDrift?: string[];
  contextStatus?: 'verified' | 'drifted' | 'unknown' | 'legacy-unknown';
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
  typeof v === 'string' && (ALL_TARGET_VARIANTS as readonly string[]).includes(v);

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

  return withRunMutation(record.id, runsDir, async () => {
    await advanceRunRevision(record.id, runsDir);
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
  });
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
  return withRunMutation(id, runsDir, async () => {
    try {
      const filePath = resolveRunPath(runsDir, id);
      try {
        await fs.access(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      await advanceRunRevision(id, runsDir);
      await fs.unlink(filePath);
      await deleteFindingReport(id, runsDir).catch(() => false);
      return true;
    } catch {
      return false;
    }
  });
}

export interface FindingReportMeta {
  runId: string;
  evidenceHash: string;
  generatedAt: string;
  mode: 'meta' | 'offline';
  model: string;
  findingIds: string[];
}

function reportsDir(runsDir: string): string { return path.join(path.resolve(runsDir), 'reports'); }
function resolveReportPath(runsDir: string, id: string): string {
  if (!validateRunId(id)) throw new Error('Invalid run ID');
  return path.join(reportsDir(runsDir), `${id}.html`);
}
export function findingReportFilename(id: string): string {
  if (!validateRunId(id)) throw new Error('Invalid run ID');
  return `chaospilot-findings-${id}.html`;
}

/** Cross-process mutation guard. Never break an existing lock or guess its owner died. */
export async function withRunMutation<T>(id: string, runsDir: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!validateRunId(id)) throw new Error('Invalid run ID');
  signal?.throwIfAborted();
  await fs.mkdir(runsDir, { recursive: true });
  const lockPath = path.join(path.resolve(runsDir), `.${id}.mutation.lock`);
  let handle: fs.FileHandle | undefined;
  for (let attempt = 0; !handle; attempt++) {
    signal?.throwIfAborted();
    try { handle = await fs.open(lockPath, 'wx'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt >= 100) throw new Error('Run storage is busy. Retry after the current write finishes; if interrupted, inspect the run mutation lock.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try { signal?.throwIfAborted(); return await action(); }
  finally { await handle.close(); await fs.unlink(lockPath); }
}

/** Call only under withRunMutation. A tombstone survives delete/recreate of identical JSON. */
async function advanceRunRevision(id: string, runsDir: string): Promise<void> {
  await fs.writeFile(path.join(path.resolve(runsDir), `.${id}.revision`), crypto.randomUUID(), 'utf8');
}

/** Call under withRunMutation, alongside getRun, for a consistent saved version. */
export async function getRunRevision(id: string, runsDir: string): Promise<string> {
  if (!validateRunId(id)) throw new Error('Invalid run ID');
  let revision = 'legacy';
  try { revision = await fs.readFile(path.join(path.resolve(runsDir), `.${id}.revision`), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Stat also detects direct file replacement outside saveRun. In-app writes always change revision.
  const stat = await fs.stat(resolveRunPath(runsDir, id), { bigint: true });
  return `${revision}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
}

/** A generation lease prevents duplicate billable calls across server instances. */
export async function withFindingReportGeneration<T>(id: string, runsDir: string, action: () => Promise<T>): Promise<T> {
  if (!validateRunId(id)) throw new Error('Invalid run ID');
  await fs.mkdir(reportsDir(runsDir), { recursive: true });
  const lockPath = `${resolveReportPath(runsDir, id)}.generation.lock`;
  let handle: fs.FileHandle;
  try { handle = await fs.open(lockPath, 'wx'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('A findings report is already being generated for this run. Retry after it finishes; if interrupted, inspect the generation lock.');
    throw error;
  }
  try { return await action(); }
  finally { await handle.close(); await fs.unlink(lockPath); }
}

/** Metadata travels inside the same HTML artifact: a single rename publishes both. */
export async function saveFindingReport(id: string, html: string, meta: FindingReportMeta, runsDir = 'runs', signal?: AbortSignal): Promise<void> {
  if (!validateRunId(id) || meta.runId !== id) throw new Error('Invalid finding report identity');
  await withRunMutation(id, runsDir, async () => {
    const current = await getRun(id, runsDir);
    signal?.throwIfAborted();
    if (!current || current.status === 'running' || !current.findings.length || evidenceHashOf(current) !== meta.evidenceHash) {
      throw new Error('Run was deleted or run evidence changed before publication. No report was saved. Create it again from the current saved run.');
    }
    await fs.mkdir(reportsDir(runsDir), { recursive: true });
    const finalPath = resolveReportPath(runsDir, id);
    const tempPath = `${finalPath}.tmp-${crypto.randomBytes(12).toString('hex')}`;
    const metadata = Buffer.from(JSON.stringify(meta), 'utf8').toString('base64');
    try {
      await fs.writeFile(tempPath, `<!-- chaospilot-report:${metadata} -->\n${html}`, { encoding: 'utf8', flag: 'wx', signal });
      signal?.throwIfAborted();
      await fs.rename(tempPath, finalPath);
    } finally { await fs.rm(tempPath, { force: true }); }
  }, signal);
}
export async function getFindingReport(id: string, runsDir = 'runs'): Promise<{ html: string; meta: FindingReportMeta } | null> {
  if (!validateRunId(id)) return null;
  try {
    const artifact = await fs.readFile(resolveReportPath(runsDir, id), 'utf8');
    const match = /^<!-- chaospilot-report:([A-Za-z0-9+/=]+) -->\n/.exec(artifact);
    if (!match) return null;
    const meta = JSON.parse(Buffer.from(match[1]!, 'base64').toString('utf8')) as FindingReportMeta;
    if (!meta || meta.runId !== id || typeof meta.evidenceHash !== 'string' || !Array.isArray(meta.findingIds)) return null;
    return { html: artifact.slice(match[0].length), meta };
  } catch { return null; }
}
export async function deleteFindingReport(id: string, runsDir = 'runs'): Promise<boolean> {
  if (!validateRunId(id)) return false;
  try { await fs.unlink(resolveReportPath(runsDir, id)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
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
  // Category consistency between saved findings and saved result violations:
  // a finding that retains an oracle category proves the evidence is
  // category-aware, so a result violation with that category removed or
  // changed cannot claim exact replay through the legacy path. This is a
  // consistency check, not tamper resistance.
  const categoryMismatches: string[] = [];
  for (const finding of record.findings ?? []) {
    const expectedCategory = finding?.category ?? finding?.violation?.category;
    if (!expectedCategory || !finding?.violation?.id) continue;
    if (finding.experimentIndex !== undefined && expRecord.index !== undefined && finding.experimentIndex !== expRecord.index) continue;
    const saved = (origResult.violations || []).find(v => v.id === finding.violation.id);
    if (saved && saved.category !== expectedCategory) {
      categoryMismatches.push(`Saved finding category "${expectedCategory}" does not match saved result violation "${saved.id}" category`);
    }
  }
  if (categoryMismatches.length > 0) {
    comparison.mismatches.push(...categoryMismatches);
    comparison.violationsMatched = false;
    comparison.matched = false;
    comparison.details = comparison.mismatches.join('; ');
  }
  // Requirement-rule replay: re-evaluate the fresh execution with the pinned
  // snapshot/evaluator (never current brief configuration) and compare with
  // the saved historical rule outcomes. Legacy results without rule evidence
  // keep their prior replay semantics untouched.
  let ruleResultsMatched: boolean | undefined;
  let deliveryObservationsMatched: boolean | undefined;
  const pinnedRules = record.systemBrief?.brief?.requirementRules;
  const savedRuleResults = origResult.requirementRuleResults;
  if (Array.isArray(origResult.deliveryObservations)) {
    deliveryObservationsMatched = canonicalJson(origResult.deliveryObservations) === canonicalJson(replayedResult.deliveryObservations ?? null);
    if (!deliveryObservationsMatched) comparison.mismatches.push('Delivery observations mismatch between original and replayed execution');
  }
  if (pinnedRules && pinnedRules.length > 0) {
    const evaluator = record.systemBrief?.requirementEvaluator;
    if (!requirementEvaluatorAvailable(evaluator)) {
      ruleResultsMatched = false;
      comparison.mismatches.push('Requirement evaluator is unavailable or has drifted from the pinned identity; exact rule replay cannot be claimed');
    } else {
      try {
        const freshRuleResults = evaluateRequirementRules(replayedResult, record.systemBrief!, expRecord.index ?? position + 1);
        replayedResult.requirementRuleResults = freshRuleResults;
        ruleResultsMatched = canonicalJson(savedRuleResults ?? null) === canonicalJson(freshRuleResults);
        if (!ruleResultsMatched) comparison.mismatches.push('Requirement rule results mismatch between original and replayed execution');
      } catch (err) {
        ruleResultsMatched = false;
        comparison.mismatches.push(`Requirement rule replay failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else if (savedRuleResults && savedRuleResults.length > 0) {
    ruleResultsMatched = false;
    comparison.mismatches.push('Saved requirement rule results have no pinned rule snapshot; rule provenance cannot be verified');
  }
  if (ruleResultsMatched === false || deliveryObservationsMatched === false) {
    comparison.matched = false;
    comparison.details = comparison.mismatches.join('; ');
  }
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
    behaviorMatched: comparison.traceMatched && comparison.snapshotMatched && comparison.violationsMatched && comparison.rejectionsMatched && comparison.validityMatched,
    mismatches: comparison.mismatches,
    valid: replayedResult.valid,
    replayedResult,
    ...(ruleResultsMatched !== undefined ? { ruleResultsMatched } : {}),
    ...(deliveryObservationsMatched !== undefined ? { deliveryObservationsMatched } : {}),
  };
  return { outcome, exactMatched: comparison.matched };
}

interface PreparedReplay {
  record: InvestigationRecord;
  simulator: SimulatorApi;
  adapterId: string;
  hasSnapshot: boolean;
  contextChecks: ReplayContextCheck[];
  gatingChecks: ReplayContextCheck[];
  currentSourceHash: string;
  sourceIdentical: boolean;
}

/**
 * Shared saved-evidence integrity and context gates for full-run and
 * selected-experiment replay: adapter/variant selection, snapshot and
 * plan identity, prompt/contract/clean/target source drift. Executes no
 * experiment, invokes no model and reruns no clean comparison.
 */
async function prepareReplay(
  target: string | InvestigationRecord,
  runsDir = 'runs',
  simulatorOverride?: SimulatorApi
): Promise<PreparedReplay> {
  const record = await resolveReplayRecord(target, runsDir);

  const rawAudit = record.contextAudit as InvestigationRecord['contextAudit'] | undefined;
  const adapterId = record.systemBrief?.brief?.adapterId ?? rawAudit?.adapterId ?? 'synthetic-trading';
  assertAdapterVariant(adapterId, record.variant);
  // Contradictory saved audit identity is rejected for every record, with or
  // without a snapshot; legitimately absent historic fields are not rejected.
  if (rawAudit?.adapterId !== undefined && rawAudit.adapterId !== adapterId) throw new Error('Replay adapter, variant or prompt audit mismatch');
  if (rawAudit?.variant !== undefined && rawAudit.variant !== record.variant) throw new Error('Replay adapter, variant or prompt audit mismatch');
  const hasSnapshot = record.systemBrief !== undefined;
  const audit = record.contextAudit as InvestigationRecord['contextAudit'] | undefined;
  const contextChecks: ReplayContextCheck[] = [];
  // Checks whose drift/unknown state blocks an exact-reproduction claim.
  const gatingChecks: ReplayContextCheck[] = [];
  const addCheck = (check: ReplayContextCheck, gating: boolean) => {
    contextChecks.push(check);
    if (gating) gatingChecks.push(check);
  };

  // Internal integrity of the pinned snapshot itself: a mismatch here means
  // the saved record is inconsistent, regardless of current-code evolution.
  if (hasSnapshot) {
    const snapshot = record.systemBrief!;
    const validated = validateSystemBrief(snapshot?.brief);
    if (!validated.valid) throw new Error(`Invalid replay system brief: ${validated.error}`);
    if (snapshot.hash !== computeSnapshotHash(validated.brief, snapshot.contract, snapshot.requirementEvaluator)) throw new Error('Replay system brief snapshot hash mismatch');
    // Requirement-rule evaluator provenance: only records that pin rules (or
    // carry saved rule outcomes) are gated on it; legacy records are not.
    const pinnedRuleCount = validated.brief.requirementRules?.length ?? 0;
    const savedRuleOutcomes = record.experiments.some(e => (e.result?.requirementRuleResults?.length ?? 0) > 0);
    if (pinnedRuleCount > 0 || savedRuleOutcomes) {
      const evaluator = snapshot.requirementEvaluator;
      if (!isRequirementEvaluatorIdentity(evaluator)) {
        addCheck({ kind: 'requirement-evaluator', status: 'unknown', detail: 'Pinned requirement rules or saved rule outcomes have no valid recorded evaluator identity; exact rule replay cannot be claimed.' }, true);
      } else if (!requirementEvaluatorAvailable(evaluator)) {
        addCheck({ kind: 'requirement-evaluator', status: 'drifted', detail: 'Recorded requirement evaluator identity differs from the current evaluator; exact rule replay cannot be claimed.', saved: `${evaluator.id}@${evaluator.version}:${evaluator.hash}` }, true);
      } else {
        addCheck({ kind: 'requirement-evaluator', status: 'identical', detail: 'Recorded requirement evaluator identity matches the current evaluator.', saved: `${evaluator.id}@${evaluator.version}:${evaluator.hash}` }, true);
      }
    }
    // adapter/variant audit contradictions are checked universally above.
  } else {
    addCheck({ kind: 'system-brief', status: 'unknown', detail: 'Legacy record without a pinned system brief snapshot; brief/contract context was not recorded.' }, false);
    if (record.experiments.some(e => (e.result?.requirementRuleResults?.length ?? 0) > 0)) {
      addCheck({ kind: 'requirement-evaluator', status: 'unknown', detail: 'Saved requirement rule outcomes have no pinned rule snapshot or evaluator identity; exact rule replay cannot be claimed.' }, true);
    }
  }

  const simulator = simulatorOverride || (adapterId === 'synthetic-trading' ? await getSimulatorApi() : resolveAdapter(adapterId));

  // Saved experiment/finding plan identity is internal evidence integrity for
  // every adapter and snapshot mode. Only evidence actually present is
  // checked, so genuinely missing historical optional fields stay compatible.
  for (const exp of record.experiments) {
    if (exp.result?.sourceHash && record.sourceHash && exp.result.sourceHash !== record.sourceHash) throw new Error('Replay experiment source or plan identity mismatch');
    if (exp.experiment !== undefined && exp.result?.experiment !== undefined && canonicalJson(exp.experiment) !== canonicalJson(exp.result.experiment)) throw new Error('Replay experiment source or plan identity mismatch');
  }
  for (const finding of record.findings) {
    if (finding.sourceHash && record.sourceHash && finding.sourceHash !== record.sourceHash) throw new Error('Replay finding source or plan identity mismatch');
    if (finding.replay !== undefined) {
      // A finding that carries a saved plan must resolve to exactly one saved
      // experiment (explicit unique index, or the guarded one-based legacy
      // position when every index is absent) and match its plan. An
      // unmatched, mixed, duplicate or invalid index can neither select a
      // different experiment nor skip this consistency check.
      const position = resolveExperimentPositionForIndex(record.experiments, finding.experimentIndex);
      const exp = position >= 0 ? record.experiments[position] : undefined;
      if (!exp || canonicalJson(finding.replay) !== canonicalJson(exp.experiment)) throw new Error('Replay finding source or plan identity mismatch');
    }
  }

  // --- Context drift vs current code (reported, never aborting replay) ---
  let currentContract: SystemContract | undefined;
  let currentContractKnown = false;
  if (simulator.getContract) {
    try {
      currentContract = simulator.getContract();
      currentContractKnown = true;
    } catch {
      currentContractKnown = false;
    }
  }

  if (hasSnapshot) {
    const snapshot = record.systemBrief!;
    // Prompt: verify saved audit against recorded proposal audits first.
    const proposalRequests = (record.proposalAttempts ?? []).flatMap(a => a.request ? [a.request] : []);
    const distinctProposalPrompts = new Set(proposalRequests.filter(r => r.promptVersion && r.promptTemplateHash).map(r => `${r.promptVersion}|${r.promptTemplateHash}`));
    if (distinctProposalPrompts.size > 1) throw new Error('Replay adapter, variant or prompt audit mismatch: recorded proposal audits disagree on prompt identity');
    for (const req of proposalRequests) {
      if (audit?.promptVersion && req.promptVersion && req.promptVersion !== audit.promptVersion) throw new Error('Replay adapter, variant or prompt audit mismatch');
      if (audit?.promptTemplateHash && req.promptTemplateHash && req.promptTemplateHash !== audit.promptTemplateHash) throw new Error('Replay adapter, variant or prompt audit mismatch');
    }
    const savedPromptVersion = audit?.promptVersion || proposalRequests[0]?.promptVersion;
    const savedPromptHash = audit?.promptTemplateHash || proposalRequests[0]?.promptTemplateHash;
    let promptIdentity: ReturnType<typeof getPromptIdentity> | undefined;
    try { promptIdentity = getPromptIdentity(adapterId); } catch { promptIdentity = undefined; }
    if (!promptIdentity || !savedPromptVersion || !savedPromptHash) {
      addCheck({ kind: 'prompt', status: 'unknown', detail: 'Saved or current prompt identity is incomplete; prompt context cannot be proved identical.', saved: savedPromptHash || savedPromptVersion, current: promptIdentity?.promptTemplateHash }, true);
    } else if (savedPromptVersion === promptIdentity.promptVersion && savedPromptHash === promptIdentity.promptTemplateHash) {
      addCheck({ kind: 'prompt', status: 'identical', detail: 'Saved prompt identity matches the current prompt and recorded proposal audits.', saved: savedPromptHash, current: promptIdentity.promptTemplateHash }, true);
    } else {
      addCheck({ kind: 'prompt', status: 'drifted', detail: `Saved prompt (version ${savedPromptVersion}) differs from the current prompt (version ${promptIdentity.promptVersion}); ${proposalRequests.length ? 'the saved prompt is corroborated by recorded proposal audits.' : 'no proposal audits were recorded to corroborate the saved prompt.'}`, saved: savedPromptHash, current: promptIdentity.promptTemplateHash }, true);
    }

    // Contract content drift (canonical, key-order independent).
    if (!snapshot.contract) {
      addCheck({ kind: 'contract', status: 'unknown', detail: 'Pinned snapshot carries no contract; contract context cannot be compared.' }, true);
    } else if (!currentContractKnown) {
      addCheck({ kind: 'contract', status: 'unknown', detail: 'Current adapter contract is unavailable; contract drift cannot be determined.' }, true);
    } else if (canonicalJson(currentContract) === canonicalJson(snapshot.contract)) {
      addCheck({ kind: 'contract', status: 'identical', detail: 'Saved contract is canonically identical to the current adapter contract.' }, true);
    } else {
      const stripDescription = (c: SystemContract) => { const { description: _d, name: _n, ...rest } = c; return rest; };
      const descriptionOnly = canonicalJson(stripDescription(currentContract!)) === canonicalJson(stripDescription(snapshot.contract));
      addCheck({ kind: 'contract', status: 'drifted', detail: descriptionOnly ? 'Saved contract differs from the current adapter contract in name/description only.' : 'Saved contract differs semantically from the current adapter contract.' }, true);
    }

    // Contract audit hash: canonical for new records, legacy raw for old ones.
    if (snapshot.contract) {
      const auditHash = audit?.contractHash;
      const canonicalSaved = computeContractHash(snapshot.contract);
      if (!auditHash) {
        addCheck({ kind: 'contract-hash', status: 'unknown', detail: 'Recorded contract audit hash is missing; contract provenance cannot be proved.', current: canonicalSaved }, true);
      } else if (auditHash === canonicalSaved) {
        addCheck({ kind: 'contract-hash', status: 'identical', detail: 'Recorded contract audit hash matches the canonical hash of the saved contract.', saved: auditHash, current: canonicalSaved }, true);
      } else if (auditHash === computeLegacyRawContractHash(snapshot.contract)) {
        addCheck({ kind: 'contract-hash', status: 'identical', detail: 'Recorded contract audit hash matches the legacy raw-order hash of the saved contract.', saved: auditHash, current: canonicalSaved }, true);
      } else if (currentContractKnown && canonicalJson(currentContract) === canonicalJson(snapshot.contract) && auditHash === computeLegacyRawContractHash(currentContract)) {
        addCheck({ kind: 'contract-hash', status: 'identical', detail: 'Recorded contract audit hash matches the legacy raw-order hash of the canonically identical executing contract (snapshot key order differs).', saved: auditHash, current: canonicalSaved }, true);
      } else if (currentContractKnown && (auditHash === computeContractHash(currentContract) || auditHash === computeLegacyRawContractHash(currentContract))) {
        throw new Error('Replay contract audit mismatch: recorded contract hash matches the current contract, not the saved snapshot contract');
      } else if (currentContractKnown && canonicalJson(currentContract) === canonicalJson(snapshot.contract)) {
        throw new Error('Replay contract audit mismatch');
      } else {
        addCheck({ kind: 'contract-hash', status: 'unverified-legacy', detail: 'Recorded contract audit hash matches neither the canonical nor a provable legacy raw-order hash of the saved contract, and the historical executing key order cannot be reconstructed because the current contract differs or is unavailable; contract provenance is unverified.', saved: auditHash, current: canonicalSaved }, true);
      }
    }
  }

  // Legacy records without a snapshot: any recorded prompt/contract audit
  // evidence is still compared with the current adapter context. Drift or an
  // unverifiable recorded hash blocks exactness; genuinely absent metadata is
  // reported as unknown without blocking the historical source+execution claim.
  if (!hasSnapshot) {
    const proposalRequests = (record.proposalAttempts ?? []).flatMap(a => a.request ? [a.request] : []);
    const distinctProposalPrompts = new Set(proposalRequests.filter(r => r.promptVersion && r.promptTemplateHash).map(r => `${r.promptVersion}|${r.promptTemplateHash}`));
    if (distinctProposalPrompts.size > 1) throw new Error('Replay adapter, variant or prompt audit mismatch: recorded proposal audits disagree on prompt identity');
    for (const req of proposalRequests) {
      if (audit?.promptVersion && req.promptVersion && req.promptVersion !== audit.promptVersion) throw new Error('Replay adapter, variant or prompt audit mismatch');
      if (audit?.promptTemplateHash && req.promptTemplateHash && req.promptTemplateHash !== audit.promptTemplateHash) throw new Error('Replay adapter, variant or prompt audit mismatch');
    }
    const savedPromptVersion = audit?.promptVersion || proposalRequests.find(r => r.promptVersion)?.promptVersion;
    const savedPromptHash = audit?.promptTemplateHash || proposalRequests.find(r => r.promptTemplateHash)?.promptTemplateHash;
    let promptIdentity: ReturnType<typeof getPromptIdentity> | undefined;
    try { promptIdentity = getPromptIdentity(adapterId); } catch { promptIdentity = undefined; }
    if (!savedPromptVersion && !savedPromptHash) {
      addCheck({ kind: 'prompt', status: 'unknown', detail: 'Legacy record carries no recorded prompt identity; prompt context was not recorded.', current: promptIdentity?.promptTemplateHash }, false);
    } else if (!promptIdentity) {
      addCheck({ kind: 'prompt', status: 'unknown', detail: 'Current prompt identity is unavailable; the recorded prompt identity cannot be verified.', saved: savedPromptHash || savedPromptVersion }, true);
    } else if ((!savedPromptVersion || savedPromptVersion === promptIdentity.promptVersion) && (!savedPromptHash || savedPromptHash === promptIdentity.promptTemplateHash)) {
      addCheck({ kind: 'prompt', status: 'identical', detail: 'Recorded legacy prompt identity matches the current prompt on every recorded field.', saved: savedPromptHash || savedPromptVersion, current: promptIdentity.promptTemplateHash }, true);
    } else {
      addCheck({ kind: 'prompt', status: 'drifted', detail: `Recorded legacy prompt (version ${savedPromptVersion ?? 'unrecorded'}) differs from the current prompt (version ${promptIdentity.promptVersion}).`, saved: savedPromptHash || savedPromptVersion, current: promptIdentity.promptTemplateHash }, true);
    }

    const auditHash = audit?.contractHash;
    if (!auditHash) {
      addCheck({ kind: 'contract-hash', status: 'unknown', detail: 'Legacy record carries no recorded contract audit hash; contract context was not recorded.' }, false);
    } else if (!currentContractKnown) {
      addCheck({ kind: 'contract-hash', status: 'unknown', detail: 'Current adapter contract is unavailable; the recorded legacy contract hash cannot be verified.', saved: auditHash }, true);
    } else if (auditHash === computeContractHash(currentContract) || auditHash === computeLegacyRawContractHash(currentContract)) {
      addCheck({ kind: 'contract-hash', status: 'identical', detail: 'Recorded legacy contract audit hash matches the current adapter contract (canonical or legacy raw-order hash).', saved: auditHash, current: computeContractHash(currentContract) }, true);
    } else {
      addCheck({ kind: 'contract-hash', status: 'unverified-legacy', detail: 'Recorded legacy contract audit hash matches neither the canonical nor the legacy raw-order hash of the current contract; it may reflect contract drift or an unreconstructable historical key order, so contract provenance is unverified.', saved: auditHash, current: computeContractHash(currentContract) }, true);
    }
  }

  // Clean-control source identity. Always reported: a snapshot-backed record
  // without a recorded clean hash is unknown and cannot claim full-context
  // verification; a recorded hash that drifted or cannot be compared blocks
  // exactness in every mode; a genuinely absent legacy hash does not.
  {
    const cleanGating = hasSnapshot || Boolean(audit?.cleanSourceHash);
    if (audit?.cleanSourceHash && record.variant === 'clean' && audit.cleanSourceHash !== record.sourceHash) {
      throw new Error('Replay clean control source identity is internally inconsistent with the recorded clean target source hash');
    }
    if (!audit?.cleanSourceHash) {
      addCheck({ kind: 'clean-source', status: 'unknown', detail: 'No clean-control source hash was recorded; clean-control identity cannot be proved.' }, cleanGating);
    } else {
      let currentCleanHash: string | undefined;
      try { currentCleanHash = simulator.getSourceBundle('clean').hash; } catch { currentCleanHash = undefined; }
      if (!currentCleanHash) {
        addCheck({ kind: 'clean-source', status: 'unknown', detail: 'Current clean-control source is unavailable; clean-control drift cannot be determined.', saved: audit.cleanSourceHash }, cleanGating);
      } else if (currentCleanHash === audit.cleanSourceHash) {
        addCheck({ kind: 'clean-source', status: 'identical', detail: 'Saved clean-control source hash matches the current clean source.', saved: audit.cleanSourceHash, current: currentCleanHash }, cleanGating);
      } else {
        addCheck({ kind: 'clean-source', status: 'drifted', detail: 'Saved clean-control source hash differs from the current clean source.', saved: audit.cleanSourceHash, current: currentCleanHash }, cleanGating);
      }
    }
  }

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
  addCheck({
    kind: 'target-source',
    status: currentSourceHash === 'unavailable' || !currentSourceHash ? 'unknown' : sourceIdentical ? 'identical' : 'drifted',
    detail: sourceIdentical
      ? 'Saved target source hash matches the current target source.'
      : 'Saved target source hash differs from, or cannot be compared with, the current target source.',
    saved: record.sourceHash,
    current: currentSourceHash,
  }, hasSnapshot);

  // 2. Deterministically replay each experiment without model invocation
  return { record, simulator, adapterId, hasSnapshot, contextChecks, gatingChecks, currentSourceHash, sourceIdentical };
}

function replayContextSummary(prep: PreparedReplay): { contextDrift: string[]; gatingBlocked: boolean; contextStatus: NonNullable<ReplayReport['contextStatus']> } {
  const contextDrift = prep.contextChecks.filter(c => c.status !== 'identical').map(c => `${c.kind}: ${c.detail}`);
  const gatingBlocked = prep.gatingChecks.some(c => c.status !== 'identical');
  const contextStatus: NonNullable<ReplayReport['contextStatus']> = prep.gatingChecks.some(c => c.status === 'drifted')
    ? 'drifted'
    : gatingBlocked
      ? 'unknown'
      : !prep.hasSnapshot
        ? 'legacy-unknown'
        : 'verified';
  return { contextDrift, gatingBlocked, contextStatus };
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
  const prep = await prepareReplay(target, runsDir, simulatorOverride);
  const { record, simulator, hasSnapshot, contextChecks, gatingChecks, currentSourceHash, sourceIdentical } = prep;

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

  const { contextDrift, gatingBlocked, contextStatus } = replayContextSummary(prep);

  // Exact reproduction can ONLY be claimed if source is identical, all exact
  // semantic comparisons match, and no applicable saved context has drifted
  // or is unproved. Legacy records without a pinned snapshot keep the
  // historical source+execution definition, reported as legacy-unknown.
  const exactReproductionClaimed = sourceIdentical && allExactMatched && !gatingBlocked;
  const reproduced = exactReproductionClaimed;

  let note: string;
  if (gatingBlocked) {
    const blocked = gatingChecks.filter(c => c.status !== 'identical').map(c => `${c.kind} (${c.status})`).join(', ');
    note = `Replay context differs from or cannot be proved against current context: ${blocked}. Per-experiment outcomes are reported, but exact reproduction cannot be claimed.`;
  } else if (!sourceIdentical) {
    note = `Source changed or diverged: original source hash (${record.sourceHash}) does not match current runtime source hash (${currentSourceHash}). Exact reproduction cannot be claimed.`;
  } else if (!allExactMatched) {
    note = `Source identical, but execution trace or snapshot diverged from original run. Exact reproduction failed.`;
  } else if (!hasSnapshot) {
    note = `Source identical: exact reproduction verified deterministically with no provider invocation (trace, snapshot, violations, rejections, validity all match). Legacy record without a pinned system brief; recorded prompt/contract/clean audit evidence, where present, did not contradict the current context.`;
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
    contextChecks,
    contextDrift,
    contextStatus,
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
  simulatorOverride?: SimulatorApi,
  signal?: AbortSignal,
): Promise<ReplayReport> {
  signal?.throwIfAborted();
  const experimentPosition = parseExperimentPosition(position);
  if (experimentPosition === null) {
    throw new Error('Invalid experiment position: expected a nonnegative integer position.');
  }
  // Identical saved-evidence integrity, adapter selection and context gates
  // as full-run replay; only the selected experiment is executed below.
  const prep = await prepareReplay(target, runsDir, simulatorOverride);
  signal?.throwIfAborted();
  const { record, simulator, contextChecks, gatingChecks, currentSourceHash, sourceIdentical } = prep;
  if (experimentPosition >= record.experiments.length) {
    throw new Error(
      `Experiment position ${experimentPosition} is out of range for run "${record.id}".`
    );
  }

  const { outcome, exactMatched } = replayOneExperiment(record, experimentPosition, simulator);
  const { contextDrift, gatingBlocked, contextStatus } = replayContextSummary(prep);

  const exactReproductionClaimed = sourceIdentical && exactMatched && !gatingBlocked;
  // Keep the existing run-wide count semantics: a counted result includes
  // the recorded result's source hash as well as its trace and outcomes.
  // Behaviour can still match when source identity differs; report that
  // separately without treating it as an exact reproduction.
  const semanticMatched = outcome.traceMatched && outcome.snapshotMatched && outcome.violationsMatched && outcome.rejectionsMatched && outcome.validityMatched;
  const experimentsReproduced = exactMatched ? 1 : 0;

  let note: string;
  if (gatingBlocked) {
    const blocked = gatingChecks.filter(c => c.status !== 'identical').map(c => `${c.kind} (${c.status})`).join(', ');
    note = `Replay context differs from or cannot be proved against current context: ${blocked}. The selected experiment ${semanticMatched ? 'semantically matched (trace, snapshot, violations, rejections, validity)' : 'did not semantically match'}, but exact reproduction cannot be claimed for the selected experiment. No clean comparison was rerun and no model was invoked.`;
  } else if (!sourceIdentical) {
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
    contextChecks,
    contextDrift,
    contextStatus,
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
