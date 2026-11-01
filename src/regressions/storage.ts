import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TARGET_VARIANTS } from '../domain.ts';
import { canonicalJson, computeContractHash } from '../evidence.ts';
import { evidenceHashOf } from '../explanations/index.ts';
import { getRun, getRunRevision, validateRunId } from '../storage.ts';
import { computeSnapshotHash, validateSystemBrief } from '../systems/index.ts';
import {
  REGRESSION_EVALUATOR_ID,
  REGRESSION_EVALUATOR_VERSION,
  computeRegressionContentHash,
  computeRegressionDefinitionId,
  computeRegressionReviewToken,
  evaluateRegressionExecution,
} from './evaluator.ts';
import type {
  RegressionDefinitionDetail,
  RegressionDefinitionRecord,
  RegressionDefinitionSummary,
  RegressionOriginStatus,
  RegressionRunRecord,
  RegressionRunSummary,
} from './types.ts';

const MAX_SERIALIZED_RECORD_BYTES = 2 * 1024 * 1024;

function validateSafeIdBase(id: string): boolean {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (id !== trimmed) return false;
  if (trimmed.length === 0 || trimmed.length > 128) return false;
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(trimmed)) return false;
  if (lower.includes('ledger') || lower.includes('..')) return false;
  return true;
}

export function validateRegressionId(id: string): boolean {
  if (!validateSafeIdBase(id)) return false;
  return /^reg-[a-f0-9]{24}$/.test(id);
}

export function validateRegressionRunId(id: string): boolean {
  if (!validateSafeIdBase(id)) return false;
  return (
    /^regrun_[0-9]+_[a-f0-9]{8}$/.test(id) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
  );
}

export function resolveRegressionsDir(runsDir = 'runs'): string {
  return path.join(runsDir, 'regressions');
}

export function resolveRegressionDefinitionsDir(runsDir = 'runs'): string {
  return path.join(resolveRegressionsDir(runsDir), 'definitions');
}

export function resolveRegressionRunsDir(runsDir = 'runs'): string {
  return path.join(resolveRegressionsDir(runsDir), 'runs');
}

export function resolveRegressionDefinitionPath(runsDir: string, id: string): string {
  if (!validateRegressionId(id)) {
    throw new Error(`Invalid regression definition ID: "${id}"`);
  }
  const definitionsDir = path.resolve(resolveRegressionDefinitionsDir(runsDir));
  const targetPath = path.resolve(definitionsDir, id, 'record.json');
  if (!targetPath.startsWith(definitionsDir + path.sep)) {
    throw new Error(`Path traversal attempt detected for regression definition ID: "${id}"`);
  }
  return targetPath;
}

export function resolveRegressionRunPath(runsDir: string, id: string): string {
  if (!validateRegressionRunId(id)) {
    throw new Error(`Invalid regression run ID: "${id}"`);
  }
  const regRunsDir = path.resolve(resolveRegressionRunsDir(runsDir));
  const targetPath = path.resolve(regRunsDir, id, 'record.json');
  if (!targetPath.startsWith(regRunsDir + path.sep)) {
    throw new Error(`Path traversal attempt detected for regression run ID: "${id}"`);
  }
  return targetPath;
}

const eq = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

export function isValidRegressionDefinitionRecord(
  parsed: unknown,
  expectedId?: string,
): parsed is RegressionDefinitionRecord {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const r = parsed as Record<string, unknown>;

  if (r.schemaVersion !== 1) return false;
  if (r.type !== 'regression-definition') return false;
  if (typeof r.id !== 'string' || !validateRegressionId(r.id)) return false;
  if (expectedId && r.id !== expectedId) return false;
  if (r.reviewed !== true) return false;
  if (typeof r.createdAt !== 'string' || !Number.isFinite(Date.parse(r.createdAt))) return false;
  if (r.adapterId !== 'synthetic-trading') return false;
  if (typeof r.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(r.contentHash)) return false;
  if (typeof r.reviewToken !== 'string' || !/^rev-[a-f0-9]{64}$/.test(r.reviewToken)) return false;
  if (!r.experiment || typeof r.experiment !== 'object') return false;
  if (!r.origin || typeof r.origin !== 'object') return false;
  if (!r.expected || typeof r.expected !== 'object') return false;
  if (!r.evaluator || typeof r.evaluator !== 'object') return false;

  try {
    const record = parsed as RegressionDefinitionRecord;
    if (
      record.evaluator.id !== REGRESSION_EVALUATOR_ID ||
      record.evaluator.version !== REGRESSION_EVALUATOR_VERSION ||
      !/^[a-f0-9]{64}$/.test(record.evaluator.hash)
    ) {
      return false;
    }

    const origin = record.origin;
    if (
      !validateRunId(origin.runId) ||
      typeof origin.runRevision !== 'string' ||
      !origin.runRevision.trim() ||
      typeof origin.evidenceHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(origin.evidenceHash) ||
      typeof origin.findingId !== 'string' ||
      !origin.findingId.trim() ||
      !Number.isInteger(origin.experimentIndex) ||
      origin.experimentIndex < 0 ||
      !Number.isInteger(origin.experimentPosition) ||
      origin.experimentPosition < 0 ||
      origin.adapterId !== 'synthetic-trading' ||
      typeof origin.variant !== 'string' ||
      !(TARGET_VARIANTS as readonly string[]).includes(origin.variant) ||
      typeof origin.sourceHash !== 'string' ||
      !origin.sourceHash ||
      typeof origin.cleanSourceHash !== 'string' ||
      !origin.cleanSourceHash ||
      typeof origin.contractHash !== 'string' ||
      !origin.contractHash
    ) {
      return false;
    }

    const brief = origin.systemSnapshot?.brief;
    if (
      !brief ||
      !validateSystemBrief(brief).valid ||
      brief.adapterId !== 'synthetic-trading' ||
      !origin.contract ||
      !Array.isArray(origin.contract.operations) ||
      !Array.isArray(origin.contract.messages) ||
      !Array.isArray(origin.contract.invariants)
    ) {
      return false;
    }

    if (
      !eq(origin.contract, origin.systemSnapshot.contract) ||
      origin.contractHash !== computeContractHash(origin.contract) ||
      origin.systemSnapshot.hash !==
        computeSnapshotHash(brief, origin.contract, origin.systemSnapshot.requirementEvaluator) ||
      !eq(origin.systemBrief, {
        id: brief.id,
        name: brief.name,
        revision: brief.revision,
        adapterId: brief.adapterId,
        hash: origin.systemSnapshot.hash,
      })
    ) {
      return false;
    }

    const finding = origin.finding;
    if (
      !finding ||
      finding.id !== origin.findingId ||
      finding.experimentIndex !== origin.experimentIndex ||
      finding.reproduced !== true ||
      finding.cleanControlPassed !== true ||
      finding.sourceHash !== origin.sourceHash ||
      !finding.violation ||
      typeof finding.violation.invariant !== 'string' ||
      !finding.violation.invariant
    ) {
      return false;
    }

    const originalResult = origin.originalResult;
    if (
      !originalResult ||
      originalResult.valid !== true ||
      originalResult.executionComplete === false ||
      originalResult.sourceHash !== origin.sourceHash ||
      !eq(originalResult.experiment, record.experiment) ||
      !Array.isArray(originalResult.trace) ||
      !Array.isArray(originalResult.violations) ||
      !originalResult.violations.some(v => eq(v, finding.violation))
    ) {
      return false;
    }

    const expected = record.expected;
    if (
      !expected.referenceProvenance ||
      expected.referenceProvenance.kind !== 'clean-control-reference' ||
      expected.referenceProvenance.referenceVariant !== 'clean' ||
      expected.referenceProvenance.referenceSourceHash !== origin.cleanSourceHash ||
      !Number.isInteger(expected.traceLength) ||
      expected.traceLength <= 0 ||
      !Array.isArray(expected.traceBindings) ||
      expected.traceBindings.length !== expected.traceLength ||
      !Array.isArray(expected.deliveries) ||
      expected.deliveries.length === 0 ||
      !expected.finalState ||
      typeof expected.finalState !== 'object'
    ) {
      return false;
    }

    const computedContentHash = computeRegressionContentHash({
      origin: record.origin,
      experiment: record.experiment,
      expected: record.expected,
      evaluator: record.evaluator,
    });
    if (record.contentHash !== computedContentHash) return false;
    if (record.reviewToken !== computeRegressionReviewToken(computedContentHash)) return false;
    if (record.id !== computeRegressionDefinitionId(computedContentHash)) return false;

    return true;
  } catch {
    return false;
  }
}

export function isValidRegressionRunRecord(
  parsed: unknown,
  expectedId?: string,
): parsed is RegressionRunRecord {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const r = parsed as Record<string, unknown>;

  if (r.schemaVersion !== 1) return false;
  if (r.type !== 'regression-run') return false;
  if (typeof r.id !== 'string' || !validateRegressionRunId(r.id)) return false;
  if (expectedId && r.id !== expectedId) return false;
  if (typeof r.definitionId !== 'string' || !validateRegressionId(r.definitionId)) return false;
  if (typeof r.definitionHash !== 'string' || !/^[a-f0-9]{64}$/.test(r.definitionHash)) return false;
  if (r.definitionId !== computeRegressionDefinitionId(r.definitionHash)) return false;
  if (r.adapterId !== 'synthetic-trading') return false;
  if (typeof r.variant !== 'string' || !(TARGET_VARIANTS as readonly string[]).includes(r.variant)) return false;
  if (typeof r.sourceHash !== 'string' || !r.sourceHash) return false;
  if (typeof r.expectedSourceHash !== 'string' || !r.expectedSourceHash) return false;
  if (!['pass', 'fail', 'inconclusive', 'invalid'].includes(String(r.status))) return false;
  if (typeof r.startedAt !== 'string' || !r.startedAt) return false;
  if (typeof r.finishedAt !== 'string' || !r.finishedAt) return false;
  if (!r.evaluator || typeof r.evaluator !== 'object') return false;
  if (!r.origin || typeof r.origin !== 'object') return false;
  if (!r.experiment || typeof r.experiment !== 'object') return false;
  if (!r.expected || typeof r.expected !== 'object') return false;
  if (!r.evaluation || typeof r.evaluation !== 'object') return false;
  if (!r.summary || typeof r.summary !== 'object') return false;

  try {
    const record = parsed as RegressionRunRecord;
    if (
      !Number.isFinite(Date.parse(record.startedAt)) ||
      !Number.isFinite(Date.parse(record.finishedAt)) ||
      Date.parse(record.finishedAt) < Date.parse(record.startedAt)
    ) {
      return false;
    }

    if (
      record.evaluator.id !== REGRESSION_EVALUATOR_ID ||
      record.evaluator.version !== REGRESSION_EVALUATOR_VERSION ||
      !/^[a-f0-9]{64}$/.test(record.evaluator.hash)
    ) {
      return false;
    }

    const origin = record.origin;
    const finding = origin.finding;
    if (
      !validateRunId(origin.runId) ||
      typeof origin.runRevision !== 'string' || !origin.runRevision.trim() ||
      typeof origin.evidenceHash !== 'string' || !/^[a-f0-9]{64}$/.test(origin.evidenceHash) ||
      typeof origin.findingId !== 'string' || !origin.findingId.trim() ||
      !Number.isSafeInteger(origin.experimentIndex) || origin.experimentIndex < 0 ||
      !(TARGET_VARIANTS as readonly string[]).includes(origin.variant) ||
      typeof origin.sourceHash !== 'string' || !origin.sourceHash ||
      typeof origin.cleanSourceHash !== 'string' || !origin.cleanSourceHash ||
      !finding || finding.id !== origin.findingId ||
      finding.experimentIndex !== origin.experimentIndex ||
      finding.reproduced !== true || finding.cleanControlPassed !== true ||
      finding.sourceHash !== origin.sourceHash ||
      !finding.violation || typeof finding.violation.invariant !== 'string' ||
      !finding.violation.invariant ||
      record.expected.referenceProvenance?.kind !== 'clean-control-reference' ||
      record.expected.referenceProvenance.referenceVariant !== 'clean' ||
      record.expected.referenceProvenance.referenceSourceHash !== origin.cleanSourceHash
    ) {
      return false;
    }

    const brief = origin.systemSnapshot?.brief;
    if (
      !brief ||
      !validateSystemBrief(brief).valid ||
      brief.adapterId !== 'synthetic-trading' ||
      !record.origin.contract ||
      !eq(record.origin.contract, record.origin.systemSnapshot.contract) ||
      record.origin.contractHash !== computeContractHash(record.origin.contract) ||
      record.origin.systemSnapshot.hash !==
        computeSnapshotHash(brief, record.origin.contract, record.origin.systemSnapshot.requirementEvaluator) ||
      !eq(record.origin.systemBrief, {
        id: brief.id,
        name: brief.name,
        revision: brief.revision,
        adapterId: brief.adapterId,
        hash: record.origin.systemSnapshot.hash,
      })
    ) {
      return false;
    }

    const ev = record.evaluation;
    if (
      ev.variant !== record.variant ||
      ev.expectedSourceHash !== record.expectedSourceHash ||
      typeof ev.sourceHash !== 'string' || ev.sourceHash !== record.sourceHash ||
      typeof ev.valid !== 'boolean' ||
      typeof ev.executionComplete !== 'boolean' ||
      !Array.isArray(ev.trace) ||
      !Array.isArray(ev.deliveryObservations) ||
      !Array.isArray(ev.rejections) ||
      !Array.isArray(ev.violations) ||
      !Array.isArray(ev.assertions)
    ) {
      return false;
    }

    const reevaluated = evaluateRegressionExecution(
      {
        experiment: record.experiment,
        expected: record.expected,
        origin: {
          experimentIndex: record.origin.experimentIndex,
          systemSnapshot: record.origin.systemSnapshot,
          finding: record.origin.finding,
        },
      },
      {
        schemaVersion: 1,
        experiment: ev.experiment,
        sourceHash: ev.sourceHash,
        trace: ev.trace,
        snapshot: ev.snapshot,
        violations: ev.violations,
        rejections: ev.rejections,
        deliveryObservations: ev.deliveryObservations,
        valid: ev.valid,
        executionComplete: ev.executionComplete,
      },
      record.expectedSourceHash,
      record.variant,
    );

    if (!eq(reevaluated, ev)) return false;
    if (record.status !== reevaluated.status) return false;

    const assertions = ev.assertions;
    const expectedSummary = {
      totalAssertions: assertions.length,
      passedAssertions: assertions.filter(a => a.status === 'pass').length,
      failedAssertions: assertions.filter(a => a.status === 'fail').length,
      inconclusiveAssertions: assertions.filter(a => a.status === 'inconclusive').length,
      invalidAssertions: assertions.filter(a => a.status === 'invalid').length,
    };
    return eq(record.summary, expectedSummary);
  } catch {
    return false;
  }
}

/** Bind persisted execution headers and expectations to their immutable definition. */
async function hasMatchingDefinition(record: RegressionRunRecord, runsDir: string): Promise<boolean> {
  const definition = await getRegressionDefinition(record.definitionId, runsDir);
  if (!definition || record.definitionHash !== definition.contentHash) return false;
  const { experimentPosition: _position, adapterId: _adapter, originalResult: _result, ...origin } = definition.origin;
  return eq(record.origin, origin) && eq(record.experiment, definition.experiment)
    && eq(record.expected, definition.expected);
}

export async function saveRegressionDefinition(
  record: RegressionDefinitionRecord,
  runsDir = 'runs',
): Promise<string> {
  if (!validateRegressionId(record.id)) {
    throw new Error(`Cannot save regression definition: Invalid ID "${record.id}"`);
  }
  if (!isValidRegressionDefinitionRecord(record, record.id)) {
    throw new Error('Cannot save malformed or inconsistent regression definition');
  }
  const serialized = JSON.stringify(record, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_RECORD_BYTES) {
    throw new Error('Regression definition record exceeds maximum serialized size');
  }

  const definitionsDir = resolveRegressionDefinitionsDir(runsDir);
  await fs.mkdir(definitionsDir, { recursive: true });

  const finalPath = resolveRegressionDefinitionPath(runsDir, record.id);
  const finalDir = path.dirname(finalPath);
  const tempDir = path.join(definitionsDir, `.tmp-${record.id}-${crypto.randomBytes(12).toString('hex')}`);
  const tempPath = path.join(tempDir, 'record.json');
  await fs.mkdir(tempDir);
  try {
    await fs.writeFile(tempPath, serialized, { encoding: 'utf8', flag: 'wx' });
    try {
      await fs.rename(tempDir, finalDir);
    } catch (error) {
      const exists = await fs.stat(finalDir).then(() => true, () => false);
      if (exists) throw new Error(`Cannot overwrite existing regression definition "${record.id}"`);
      throw error;
    }
  } finally {
    await fs.unlink(tempPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    await fs.rmdir(tempDir).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  return finalPath;
}

export async function getRegressionDefinition(
  id: string,
  runsDir = 'runs',
): Promise<RegressionDefinitionRecord | null> {
  if (!validateRegressionId(id)) return null;
  try {
    const finalPath = resolveRegressionDefinitionPath(runsDir, id);
    const content = await fs.readFile(finalPath, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > MAX_SERIALIZED_RECORD_BYTES) return null;
    const parsed = JSON.parse(content);
    if (!isValidRegressionDefinitionRecord(parsed, id)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function checkOriginStatus(
  definition: RegressionDefinitionRecord,
  runsDir = 'runs',
): Promise<RegressionOriginStatus> {
  const { runId, findingId, runRevision, evidenceHash } = definition.origin;
  try {
    const record = await getRun(runId, runsDir);
    if (!record) {
      return {
        runId,
        findingId,
        available: false,
        stale: true,
        status: 'deleted',
        reason:
          'Original investigation run was deleted after capture; using the immutable origin snapshot saved in this regression definition.',
      };
    }
    const currentRevision = await getRunRevision(runId, runsDir);
    const currentEvidenceHash = evidenceHashOf(record);
    if (currentRevision !== runRevision || currentEvidenceHash !== evidenceHash) {
      return {
        runId,
        findingId,
        available: false,
        stale: true,
        status: 'modified',
        reason:
          'Original investigation run was modified or replaced after capture; using the immutable origin snapshot saved in this regression definition.',
      };
    }
    return {
      runId,
      findingId,
      available: true,
      stale: false,
      status: 'verified',
    };
  } catch {
    return {
      runId,
      findingId,
      available: false,
      stale: true,
      status: 'unavailable',
      reason:
        'Original investigation run could not be verified on disk; using the immutable origin snapshot saved in this regression definition.',
    };
  }
}

export async function saveRegressionRun(
  record: RegressionRunRecord,
  runsDir = 'runs',
): Promise<string> {
  if (!validateRegressionRunId(record.id)) {
    throw new Error(`Cannot save regression run: Invalid ID "${record.id}"`);
  }
  if (!isValidRegressionRunRecord(record, record.id)) {
    throw new Error('Cannot save malformed or inconsistent regression run');
  }
  if (!await hasMatchingDefinition(record, runsDir)) {
    throw new Error('Cannot save regression run with a missing or inconsistent definition');
  }
  const serialized = JSON.stringify(record, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_RECORD_BYTES) {
    throw new Error('Regression run record exceeds maximum serialized size');
  }

  const regRunsDir = resolveRegressionRunsDir(runsDir);
  await fs.mkdir(regRunsDir, { recursive: true });

  const finalPath = resolveRegressionRunPath(runsDir, record.id);
  const finalDir = path.dirname(finalPath);
  const tempDir = path.join(regRunsDir, `.tmp-${record.id}-${crypto.randomBytes(12).toString('hex')}`);
  const tempPath = path.join(tempDir, 'record.json');
  await fs.mkdir(tempDir);
  try {
    await fs.writeFile(tempPath, serialized, { encoding: 'utf8', flag: 'wx' });
    try {
      await fs.rename(tempDir, finalDir);
    } catch (error) {
      const exists = await fs.stat(finalDir).then(() => true, () => false);
      if (exists) throw new Error(`Cannot overwrite existing regression run "${record.id}"`);
      throw error;
    }
  } finally {
    await fs.unlink(tempPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    await fs.rmdir(tempDir).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  return finalPath;
}

export async function getRegressionRun(
  id: string,
  runsDir = 'runs',
): Promise<RegressionRunRecord | null> {
  if (!validateRegressionRunId(id)) return null;
  try {
    const finalPath = resolveRegressionRunPath(runsDir, id);
    const content = await fs.readFile(finalPath, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > MAX_SERIALIZED_RECORD_BYTES) return null;
    const parsed = JSON.parse(content);
    if (!isValidRegressionRunRecord(parsed, id)) return null;
    if (!await hasMatchingDefinition(parsed, runsDir)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function toRegressionRunSummary(record: RegressionRunRecord): RegressionRunSummary {
  return {
    id: record.id,
    type: 'regression-run',
    definitionId: record.definitionId,
    definitionHash: record.definitionHash,
    adapterId: record.adapterId,
    variant: record.variant,
    sourceHash: record.sourceHash,
    expectedSourceHash: record.expectedSourceHash,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    origin: {
      runId: record.origin.runId,
      findingId: record.origin.findingId,
      variant: record.origin.variant,
      sourceHash: record.origin.sourceHash,
      systemBrief: { ...record.origin.systemBrief },
    },
    summary: { ...record.summary },
  };
}

export async function listRegressionRuns(
  runsDir = 'runs',
  definitionId?: string,
): Promise<RegressionRunSummary[]> {
  const regRunsDir = resolveRegressionRunsDir(runsDir);
  try {
    const entries = await fs.readdir(regRunsDir, { withFileTypes: true });
    const summaries: RegressionRunSummary[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.tmp')) continue;
      const runId = entry.name;
      if (!validateRegressionRunId(runId)) continue;

      try {
        const parsed = await getRegressionRun(runId, runsDir);
        if (!parsed) continue;
        if (definitionId && parsed.definitionId !== definitionId) continue;
        summaries.push(toRegressionRunSummary(parsed));
      } catch {
        // Ignore unparseable entries
      }
    }

    summaries.sort((a, b) => {
      const timeA = new Date(a.startedAt).getTime() || 0;
      const timeB = new Date(b.startedAt).getTime() || 0;
      return timeB - timeA;
    });

    return summaries;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
}

export async function listRegressionDefinitions(
  runsDir = 'runs',
): Promise<RegressionDefinitionSummary[]> {
  const definitionsDir = resolveRegressionDefinitionsDir(runsDir);
  try {
    const entries = await fs.readdir(definitionsDir, { withFileTypes: true });
    const allRuns = await listRegressionRuns(runsDir);
    const runsByDefinition = new Map<string, RegressionRunSummary[]>();
    for (const run of allRuns) {
      const list = runsByDefinition.get(run.definitionId) ?? [];
      list.push(run);
      runsByDefinition.set(run.definitionId, list);
    }

    const summaries: RegressionDefinitionSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.tmp')) continue;
      const defId = entry.name;
      if (!validateRegressionId(defId)) continue;

      try {
        const fullPath = resolveRegressionDefinitionPath(runsDir, defId);
        const content = await fs.readFile(fullPath, 'utf8');
        if (Buffer.byteLength(content, 'utf8') > MAX_SERIALIZED_RECORD_BYTES) continue;
        const parsed = JSON.parse(content);
        if (!isValidRegressionDefinitionRecord(parsed, defId)) continue;

        const originStatus = await checkOriginStatus(parsed, runsDir);
        const defRuns = runsByDefinition.get(parsed.id) ?? [];
        summaries.push({
          id: parsed.id,
          type: 'regression-definition',
          createdAt: parsed.createdAt,
          contentHash: parsed.contentHash,
          adapterId: parsed.adapterId,
          title: parsed.origin.finding.title,
          invariant: parsed.origin.finding.violation.invariant,
          ...(parsed.origin.finding.category ?? parsed.origin.finding.violation.category
            ? { category: parsed.origin.finding.category ?? parsed.origin.finding.violation.category }
            : {}),
          hypothesis: parsed.experiment.hypothesis,
          stepCount: parsed.experiment.steps.length,
          deliveryCount: parsed.expected.deliveries.length,
          origin: {
            runId: parsed.origin.runId,
            runRevision: parsed.origin.runRevision,
            evidenceHash: parsed.origin.evidenceHash,
            findingId: parsed.origin.findingId,
            experimentIndex: parsed.origin.experimentIndex,
            variant: parsed.origin.variant,
            sourceHash: parsed.origin.sourceHash,
            cleanSourceHash: parsed.origin.cleanSourceHash,
            contractHash: parsed.origin.contractHash,
            systemBrief: { ...parsed.origin.systemBrief },
          },
          originStatus,
          runCount: defRuns.length,
          latestRun: defRuns[0] ?? null,
        });
      } catch {
        // Ignore unparseable entries
      }
    }

    summaries.sort((a, b) => {
      const timeA = new Date(a.createdAt).getTime() || 0;
      const timeB = new Date(b.createdAt).getTime() || 0;
      return timeB - timeA;
    });

    return summaries;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
}

export async function getRegressionDefinitionDetail(
  id: string,
  runsDir = 'runs',
): Promise<RegressionDefinitionDetail | null> {
  const definition = await getRegressionDefinition(id, runsDir);
  if (!definition) return null;
  const [originStatus, runs] = await Promise.all([
    checkOriginStatus(definition, runsDir),
    listRegressionRuns(runsDir, definition.id),
  ]);
  return {
    definition,
    originStatus,
    runs,
  };
}
