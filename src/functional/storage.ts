import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TARGET_VARIANTS } from '../domain.ts';
import { canonicalJson } from '../evidence.ts';
import { computeSnapshotHash, validateSystemBrief } from '../systems/index.ts';
import { FUNCTIONAL_CATALOG } from './catalog.ts';
import { aggregateFunctionalStatus, evaluateFunctionalScenario } from './evaluator.ts';
import type { FunctionalRunRecord, FunctionalRunSummary } from './types.ts';

export function validateFunctionalRunId(id: string): boolean {
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

export function resolveFunctionalDir(runsDir = 'runs'): string {
  return path.join(runsDir, 'functional');
}

export function resolveFunctionalRunPath(runsDir: string, id: string): string {
  if (!validateFunctionalRunId(id)) {
    throw new Error(`Invalid functional run ID: "${id}"`);
  }
  const functionalDir = path.resolve(resolveFunctionalDir(runsDir));
  const targetPath = path.resolve(functionalDir, id, 'record.json');
  if (!targetPath.startsWith(functionalDir + path.sep)) {
    throw new Error(`Path traversal attempt detected for functional run ID: "${id}"`);
  }
  return targetPath;
}

export function isValidFunctionalRunRecord(
  parsed: unknown,
  expectedId?: string,
): parsed is FunctionalRunRecord {
  if (!parsed || typeof parsed !== 'object') return false;
  const r = parsed as Record<string, unknown>;

  if (r.schemaVersion !== 1) return false;
  if (r.type !== 'functional-baseline') return false;
  if (typeof r.id !== 'string' || !validateFunctionalRunId(r.id)) return false;
  if (expectedId && r.id !== expectedId) return false;

  if (r.adapterId !== 'synthetic-trading') return false;
  if (typeof r.variant !== 'string' || !(TARGET_VARIANTS as readonly string[]).includes(r.variant)) return false;
  if (typeof r.sourceHash !== 'string' || !r.sourceHash) return false;
  if (!['pass', 'fail', 'inconclusive', 'invalid'].includes(String(r.status))) return false;
  if (typeof r.startedAt !== 'string' || !r.startedAt) return false;
  if (typeof r.finishedAt !== 'string' || !r.finishedAt) return false;

  if (!r.evaluator || typeof r.evaluator !== 'object') return false;
  if (!r.systemBrief || typeof r.systemBrief !== 'object') return false;
  if (!r.systemSnapshot || typeof r.systemSnapshot !== 'object') return false;
  if (!r.contract || typeof r.contract !== 'object') return false;
  if (!Array.isArray(r.scenarios)) return false;
  if (!r.summary || typeof r.summary !== 'object') return false;

  // Shape checks alone cannot establish that a persisted pass has supporting facts.
  try {
    const record = parsed as FunctionalRunRecord;
    const eq = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
    const brief = record.systemSnapshot.brief;
    if (!validateSystemBrief(brief).valid || !record.contract || !Array.isArray(record.contract.operations)
      || !Array.isArray(record.contract.messages) || !Array.isArray(record.contract.invariants)) return false;
    if (!eq(record.contract, record.systemSnapshot.contract)
      || record.systemSnapshot.hash !== computeSnapshotHash(brief, record.contract, record.systemSnapshot.requirementEvaluator)
      || !eq(record.systemBrief, { id: brief.id, name: brief.name, revision: brief.revision, adapterId: brief.adapterId, hash: record.systemSnapshot.hash })
      || brief.adapterId !== record.adapterId) return false;
    if (!Number.isFinite(Date.parse(record.startedAt)) || !Number.isFinite(Date.parse(record.finishedAt))
      || Date.parse(record.finishedAt) < Date.parse(record.startedAt)) return false;
    if (record.evaluator.id !== 'functional-evaluator' || record.evaluator.version !== 2 || !/^[a-f0-9]{64}$/.test(record.evaluator.hash)) return false;
    if (record.scenarios.length !== FUNCTIONAL_CATALOG.length) return false;
    for (const [index, scenario] of record.scenarios.entries()) {
      const definition = FUNCTIONAL_CATALOG[index]!;
      if (scenario.scenarioId !== definition.id || scenario.expectedSourceHash !== record.sourceHash
        || typeof scenario.sourceHash !== 'string' || !Array.isArray(scenario.trace) || !Array.isArray(scenario.assertions)
        || !Array.isArray(scenario.deliveryObservations) || !Array.isArray(scenario.rejections) || !Array.isArray(scenario.violations)
        || typeof scenario.valid !== 'boolean' || typeof scenario.executionComplete !== 'boolean') return false;
      const evaluated = evaluateFunctionalScenario(definition, { schemaVersion: 1, experiment: scenario.experiment,
        sourceHash: scenario.sourceHash, trace: scenario.trace, snapshot: {}, violations: scenario.violations,
        rejections: scenario.rejections, deliveryObservations: scenario.deliveryObservations,
        valid: scenario.valid, executionComplete: scenario.executionComplete }, record.systemSnapshot, index, record.sourceHash, record.variant);
      if (!eq(evaluated, scenario)) return false;
    }
    const assertions = record.scenarios.flatMap(s => s.assertions);
    if (record.status !== aggregateFunctionalStatus(record.scenarios.map(s => s.status))) return false;
    const expectedSummary = {
      totalScenarios: record.scenarios.length,
      passed: record.scenarios.filter(s => s.status === 'pass').length,
      failed: record.scenarios.filter(s => s.status === 'fail').length,
      inconclusive: record.scenarios.filter(s => s.status === 'inconclusive').length,
      invalid: record.scenarios.filter(s => s.status === 'invalid').length,
      totalAssertions: assertions.length,
      passedAssertions: assertions.filter(a => a.status === 'pass').length,
      failedAssertions: assertions.filter(a => a.status === 'fail').length,
    };
    return eq(record.summary, expectedSummary);
  } catch { return false; }
}

export async function saveFunctionalRun(
  record: FunctionalRunRecord,
  runsDir = 'runs',
): Promise<string> {
  if (!validateFunctionalRunId(record.id)) {
    throw new Error(`Cannot save functional run: Invalid run ID "${record.id}"`);
  }

  if (!isValidFunctionalRunRecord(record, record.id)) throw new Error('Cannot save malformed or inconsistent functional run');
  const functionalDir = resolveFunctionalDir(runsDir);
  await fs.mkdir(functionalDir, { recursive: true });

  const finalPath = resolveFunctionalRunPath(runsDir, record.id);

  // A completed, nonempty directory can be atomically renamed into place, but
  // cannot replace an existing completed directory on Windows or POSIX.
  const finalDir = path.dirname(finalPath);
  const tempDir = path.join(functionalDir, `.tmp-${record.id}-${crypto.randomBytes(12).toString('hex')}`);
  const tempPath = path.join(tempDir, 'record.json');
  await fs.mkdir(tempDir);
  try {
    await fs.writeFile(tempPath, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' });
    try { await fs.rename(tempDir, finalDir); }
    catch (error) {
      const exists = await fs.stat(finalDir).then(() => true, () => false);
      if (exists) throw new Error(`Cannot overwrite existing functional run "${record.id}"`);
      throw error;
    }
  } finally {
    // Only remove this writer's known scratch file and now-empty directory.
    await fs.unlink(tempPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(tempDir).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }

  return finalPath;
}

export async function getFunctionalRun(
  id: string,
  runsDir = 'runs',
): Promise<FunctionalRunRecord | null> {
  if (!validateFunctionalRunId(id)) return null;

  try {
    const finalPath = resolveFunctionalRunPath(runsDir, id);
    const content = await fs.readFile(finalPath, 'utf8');
    const parsed = JSON.parse(content);
    if (!isValidFunctionalRunRecord(parsed, id)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function listFunctionalRuns(
  runsDir = 'runs',
): Promise<FunctionalRunSummary[]> {
  const functionalDir = resolveFunctionalDir(runsDir);
  try {
    const entries = await fs.readdir(functionalDir, { withFileTypes: true });
    const summaries: FunctionalRunSummary[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.tmp')) {
        continue;
      }
      const runId = entry.name;
      if (!validateFunctionalRunId(runId)) continue;

      try {
        const fullPath = resolveFunctionalRunPath(runsDir, runId);
        const content = await fs.readFile(fullPath, 'utf8');
        const parsed = JSON.parse(content);
        if (!isValidFunctionalRunRecord(parsed, runId)) continue;

        summaries.push({
          id: parsed.id,
          type: 'functional-baseline',
          adapterId: parsed.adapterId,
          variant: parsed.variant,
          status: parsed.status,
          startedAt: parsed.startedAt,
          finishedAt: parsed.finishedAt,
          sourceHash: parsed.sourceHash,
          systemBrief: {
            id: parsed.systemBrief.id,
            name: parsed.systemBrief.name,
            revision: parsed.systemBrief.revision,
            adapterId: parsed.systemBrief.adapterId,
            hash: parsed.systemBrief.hash,
          },
          summary: {
            totalScenarios: parsed.summary.totalScenarios,
            passed: parsed.summary.passed,
            failed: parsed.summary.failed,
            inconclusive: parsed.summary.inconclusive,
            invalid: parsed.summary.invalid,
          },
        });
      } catch {
        // Skip unparseable files
      }
    }

    // Sort newest first by startedAt
    summaries.sort((a, b) => {
      const timeA = new Date(a.startedAt).getTime() || 0;
      const timeB = new Date(b.startedAt).getTime() || 0;
      return timeB - timeA;
    });

    return summaries;
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'ENOENT') return [];
    throw err;
  }
}
