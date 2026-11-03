import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runApiJourneys } from '../../src/target-api/runner.ts';
import {
  saveApiJourneyRun,
  getApiJourneyRun,
  listApiJourneyRuns,
  resolveApiJourneyRunPath,
  validateApiJourneyRunId,
} from '../../src/target-api/storage.ts';
import { compareApiJourneys, verifyRecordIntegrity } from '../../src/target-api/compare.ts';
import { SEEDED_TRADING_BRIEF } from '../../src/systems/index.ts';
import { createSystemSnapshot } from '../../src/storage.ts';

describe('Evidence provenance and rerun honesty', () => {
  const testRunsDir = path.join('runs', 'test-target-api-provenance');

  beforeEach(async () => {
    await fs.mkdir(testRunsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testRunsDir, { recursive: true, force: true });
  });

  it('saves, reloads and verifies record integrity', async () => {
    const systemSnapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const record = await runApiJourneys({
      variant: 'clean',
      systemSnapshot,
      timeoutMs: 8000,
    });

    expect(verifyRecordIntegrity(record)).toBe(true);

    const savedPath = await saveApiJourneyRun(record, testRunsDir);
    expect(savedPath).toContain(record.id);

    // Read back
    const loaded = await getApiJourneyRun(record.id, testRunsDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(record.id);
    expect(loaded!.integrity).toBe(record.integrity);
    expect(loaded!.journeys).toHaveLength(3);

    // List runs
    const summaries = await listApiJourneyRuns(testRunsDir);
    expect(summaries.some((s) => s.id === record.id)).toBe(true);
  });

  it('rejects path traversal and invalid run IDs', () => {
    expect(validateApiJourneyRunId('../etc/passwd')).toBe(false);
    expect(validateApiJourneyRunId('..')).toBe(false);
    expect(validateApiJourneyRunId('nul')).toBe(false);
    expect(validateApiJourneyRunId('ledger_data')).toBe(false);
    expect(validateApiJourneyRunId('')).toBe(false);
    expect(validateApiJourneyRunId('apij_1234')).toBe(true);

    expect(() => resolveApiJourneyRunPath(testRunsDir, '../bad')).toThrow(/Invalid API journey run ID/);
  });

  it('compares identical clean runs across different ephemeral ports as a semantic MATCH', async () => {
    const systemSnapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const run1 = await runApiJourneys({ variant: 'clean', systemSnapshot, timeoutMs: 8000 });
    const run2 = await runApiJourneys({ variant: 'clean', systemSnapshot, timeoutMs: 8000 });

    const comparison = compareApiJourneys(run1, run2);
    expect(comparison.status).toBe('match');
    expect(comparison.reasons).toHaveLength(0);
    expect(comparison.note).toContain('Semantic rerun comparison');
    expect(comparison.note).toContain('Ephemeral loopback ports');
  });

  it('detects tampered integrity as BLOCKED', async () => {
    const systemSnapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const run = await runApiJourneys({ variant: 'clean', systemSnapshot, timeoutMs: 8000 });
    const tampered = structuredClone(run);

    // Alter an assertion result without updating integrity
    tampered.journeys[0]!.assertions[0]!.status = 'fail';

    const comparison = compareApiJourneys(run, tampered);
    expect(comparison.status).toBe('blocked');
    expect(comparison.reasons.some((r) => r.includes('integrity failed'))).toBe(true);
  });

  it('blocks comparison across mismatched systems or variants', async () => {
    const systemSnapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const runClean = await runApiJourneys({ variant: 'clean', systemSnapshot, timeoutMs: 8000 });
    const runCandA = await runApiJourneys({ variant: 'candidate-a', systemSnapshot, timeoutMs: 8000 });

    const comparison = compareApiJourneys(runClean, runCandA);
    expect(comparison.status).toBe('blocked');
    expect(comparison.reasons.some((r) => r.includes('Target variant mismatch'))).toBe(true);
  });

  it('detects changed source or contract hashes', async () => {
    const systemSnapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const run = await runApiJourneys({ variant: 'clean', systemSnapshot, timeoutMs: 8000 });

    const modified = structuredClone(run);
    modified.sourceHash = '0'.repeat(64);
    // Reseal so integrity is valid, but sourceHash differs
    import('../../src/target-api/runner.ts').then((m) => m.seal(modified));
    const { seal } = await import('../../src/target-api/runner.ts');
    seal(modified);

    const comparison = compareApiJourneys(run, modified);
    expect(comparison.status).toBe('different');
    expect(comparison.reasons.some((r) => r.includes('Target source code hash changed'))).toBe(true);
  });

  it('prevents overwriting an existing immutable journey run', async () => {
    const systemSnapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const record = await runApiJourneys({ variant: 'clean', systemSnapshot, timeoutMs: 8000 });
    await saveApiJourneyRun(record, testRunsDir);

    // Attempting to save again with same ID must fail
    await expect(saveApiJourneyRun(record, testRunsDir)).rejects.toThrow(
      /already exists and cannot be overwritten/,
    );

    // Attempting to overwrite with tampered/modified record under same ID must also fail
    const modified = structuredClone(record);
    modified.status = 'fail';
    const { seal } = await import('../../src/target-api/runner.ts');
    seal(modified);

    await expect(saveApiJourneyRun(modified, testRunsDir)).rejects.toThrow(
      /invalid API journey record/,
    );

    // Original file remains unchanged
    const reloaded = await getApiJourneyRun(record.id, testRunsDir);
    expect(reloaded?.status).toBe('pass');
    expect(reloaded?.integrity).toBe(record.integrity);
  });

  it('preserves the winning original when concurrent saves race', async () => {
    const systemSnapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const record = await runApiJourneys({ variant: 'clean', systemSnapshot, timeoutMs: 8000 });

    const results = await Promise.allSettled([
      saveApiJourneyRun(record, testRunsDir),
      saveApiJourneyRun(record, testRunsDir),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(
      /already exists and cannot be overwritten/,
    );

    const reloaded = await getApiJourneyRun(record.id, testRunsDir);
    expect(reloaded?.id).toBe(record.id);
  });

  it('detects extra assertions in fresh run as DIFFERENT (not match)', async () => {
    const systemSnapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const orig = await runApiJourneys({ variant: 'clean', systemSnapshot, timeoutMs: 8000 });
    const fresh = structuredClone(orig);
    fresh.id = 'apij_extra_assertion';
    // Add extra assertion to fresh run
    fresh.journeys[0]!.assertions.push({
      id: 'extra-assertion',
      expected: 'foo',
      observed: 'bar',
      status: 'fail',
    });
    const { seal } = await import('../../src/target-api/runner.ts');
    seal(fresh);

    const comparison = compareApiJourneys(orig, fresh);
    expect(comparison.status).toBe('blocked');
    expect(comparison.reasons.join(' ')).toContain('Inconsistent terminal journey status');
  });

  it('detects extra journeys in fresh run as DIFFERENT', async () => {
    const systemSnapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const orig = await runApiJourneys({ variant: 'clean', systemSnapshot, timeoutMs: 8000 });
    const fresh = structuredClone(orig);
    fresh.id = 'apij_extra_journey';
    fresh.journeys.push({
      id: 'extra-journey-id',
      instanceId: 'inst-extra',
      endpoint: 'http://127.0.0.1:9999',
      exchanges: [],
      observation: null,
      assertions: [],
      status: 'pass',
    });
    const { seal } = await import('../../src/target-api/runner.ts');
    seal(fresh);

    const comparison = compareApiJourneys(orig, fresh);
    expect(comparison.status).toBe('blocked');
    expect(comparison.reasons.join(' ')).toContain('Unknown or duplicate catalog journey');
  });

  it('detects changed expected value in assertion as DIFFERENT', async () => {
    const systemSnapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const orig = await runApiJourneys({ variant: 'clean', systemSnapshot, timeoutMs: 8000 });
    const fresh = structuredClone(orig);
    fresh.id = 'apij_diff_expected';
    fresh.journeys[0]!.assertions[0]!.expected = 'changed-expected-value';
    const { seal } = await import('../../src/target-api/runner.ts');
    seal(fresh);

    const comparison = compareApiJourneys(orig, fresh);
    expect(comparison.status).toBe('different');
    expect(comparison.reasons.some((r) => r.includes('stored assertions/status disagree'))).toBe(true);
  });

  it('blocks comparison when system snapshot hash differs despite same brief id and revision', async () => {
    const systemSnapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const orig = await runApiJourneys({ variant: 'clean', systemSnapshot, timeoutMs: 8000 });
    const fresh = structuredClone(orig);
    fresh.id = 'apij_diff_snapshot';
    fresh.systemSnapshot.hash = 'f'.repeat(64);
    const { seal } = await import('../../src/target-api/runner.ts');
    seal(fresh);

    const comparison = compareApiJourneys(orig, fresh);
    expect(comparison.status).toBe('blocked');
    expect(comparison.reasons.some((r) => r.includes('System brief snapshot mismatch'))).toBe(true);
  });

  it('blocks comparison of inconclusive or cancelled runs without claiming invariant match', async () => {
    const systemSnapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const cancelledA = await runApiJourneys({
      variant: 'clean',
      systemSnapshot,
      signal: AbortSignal.abort(new Error('Pre-aborted A')),
    });
    const cancelledB = await runApiJourneys({
      variant: 'clean',
      systemSnapshot,
      signal: AbortSignal.abort(new Error('Pre-aborted B')),
    });

    const comparison = compareApiJourneys(cancelledA, cancelledB);
    expect(comparison.status).toBe('blocked');
    expect(comparison.reasons.some((r) => r.includes('incomplete or cancelled runs'))).toBe(true);
    expect(comparison.note).not.toContain('verified all business and protocol invariants');
    expect(comparison.note).toContain('blocked');
  });

  it('produces honest note preserving failure when matching two failed runs', async () => {
    const systemSnapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const failA = await runApiJourneys({ variant: 'candidate-a', systemSnapshot, timeoutMs: 8000 });
    const failB = await runApiJourneys({ variant: 'candidate-a', systemSnapshot, timeoutMs: 8000 });

    expect(failA.status).toBe('fail');
    expect(failB.status).toBe('fail');

    const comparison = compareApiJourneys(failA, failB);
    expect(comparison.status).toBe('match');
    expect(comparison.reasons).toHaveLength(0);
    expect(comparison.note).toContain('identically reproduced the expected failure');
    expect(comparison.note).not.toContain('verified all business and protocol invariants');
  });

  it('fails closed when on-disk runtime files drift or are missing', async () => {
    const tempDir = path.join(testRunsDir, 'drift-fixture');
    const targetApiDir = path.join(tempDir, 'target-api');
    await fs.mkdir(targetApiDir, { recursive: true });

    // Copy relevant closure files into isolated temp dir
    const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const filesToCopy = [
      { src: `src/evidence${ext}`, dest: path.join(tempDir, `evidence${ext}`) },
      { src: `src/target-api/types${ext}`, dest: path.join(targetApiDir, `types${ext}`) },
      { src: `src/target-api/target${ext}`, dest: path.join(targetApiDir, `target${ext}`) },
      { src: `src/target-api/client${ext}`, dest: path.join(targetApiDir, `client${ext}`) },
      { src: `src/target-api/runner${ext}`, dest: path.join(targetApiDir, `runner${ext}`) },
      { src: `src/target-api/catalog${ext}`, dest: path.join(targetApiDir, `catalog${ext}`) },
      ...['validation', 'compare'].map(name => ({ src: `src/target-api/${name}${ext}`, dest: path.join(targetApiDir, `${name}${ext}`) })),
      { src: `src/target-api/evaluator${ext}`, dest: path.join(targetApiDir, `evaluator${ext}`) },
      { src: `src/target-api/identity${ext}`, dest: path.join(targetApiDir, `identity${ext}`) },
    ];
    for (const f of filesToCopy) {
      await fs.copyFile(path.resolve(f.src), f.dest);
    }
    // Also copy simulator and requirements dependencies for evaluator
    const simDir = path.join(tempDir, 'simulator');
    await fs.mkdir(path.join(tempDir, 'systems'), { recursive: true });
    await fs.copyFile(path.resolve(`src/systems/index${ext}`), path.join(tempDir, `systems/index${ext}`));
    const reqDir = path.join(tempDir, 'requirements');
    await fs.mkdir(simDir, { recursive: true });
    await fs.mkdir(reqDir, { recursive: true });
    await fs.copyFile(path.resolve(`src/simulator/oracle${ext}`), path.join(simDir, `oracle${ext}`));
    await fs.copyFile(path.resolve(`src/requirements/identity${ext}`), path.join(reqDir, `identity${ext}`));
    await fs.copyFile(path.resolve(`src/requirements/evaluator${ext}`), path.join(reqDir, `evaluator${ext}`));

    const { pathToFileURL } = await import('node:url');
    const identityModuleUrl = pathToFileURL(path.join(targetApiDir, `identity${ext}`)).href;
    const mod = await import(identityModuleUrl);

    // Initial call succeeds
    const idBefore = mod.transportIdentity();
    expect(idBefore.version).toBe(1);
    expect(typeof idBefore.hash).toBe('string');

    const validationFile = path.join(targetApiDir, `validation${ext}`);
    const validationContent = await fs.readFile(validationFile, 'utf8');
    const evaluatorBefore = mod.evaluatorIdentity();
    await fs.writeFile(validationFile, validationContent + '\n// changed semantic helper\n');
    expect(() => mod.evaluatorIdentity()).toThrow(/evaluator runtime source changed on disk; restart required/);
    await fs.unlink(validationFile);
    expect(() => mod.evaluatorIdentity()).toThrow(/evaluator runtime source changed or is missing; restart required/);
    await fs.writeFile(validationFile, validationContent);
    expect(mod.evaluatorIdentity()).toEqual(evaluatorBefore);

    // 1. Drift disk file
    const targetFile = path.join(targetApiDir, `target${ext}`);
    const originalContent = await fs.readFile(targetFile, 'utf8');
    await fs.writeFile(targetFile, originalContent + '\n// modified on disk\n', 'utf8');

    expect(() => mod.transportIdentity()).toThrow(/Target API transport runtime source changed on disk; restart required/);

    // 2. Missing disk file
    await fs.unlink(targetFile);
    expect(() => mod.transportIdentity()).toThrow(/Target API transport runtime source changed or is missing; restart required/);

    // 3. Restore disk file
    await fs.writeFile(targetFile, originalContent, 'utf8');
    const idRestored = mod.transportIdentity();
    expect(idRestored.hash).toBe(idBefore.hash);
  });
});
