import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSystemSnapshot, saveSystemBrief, SEEDED_TRADING_BRIEF } from '../src/systems/index.ts';
import { runFunctionalBaselines } from '../src/functional/runner.ts';
import {
  getFunctionalRun,
  listFunctionalRuns,
  resolveFunctionalRunPath,
  saveFunctionalRun,
  validateFunctionalRunId,
} from '../src/functional/storage.ts';
import { getRun, listRuns } from '../src/storage.ts';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual };
});

describe('functional storage and persistence', () => {
  let tmpDir: string;
  let runsDir: string;
  let systemsDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chaospilot-functional-test-'));
    runsDir = path.join(tmpDir, 'runs');
    systemsDir = path.join(tmpDir, 'systems');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('validates functional run IDs strictly', () => {
    expect(validateFunctionalRunId('fnrun_123_abc')).toBe(true);
    expect(validateFunctionalRunId('functional-run-001')).toBe(true);
    expect(validateFunctionalRunId('')).toBe(false);
    expect(validateFunctionalRunId('   ')).toBe(false);
    expect(validateFunctionalRunId('../traversal')).toBe(false);
    expect(validateFunctionalRunId('foo/bar')).toBe(false);
    expect(validateFunctionalRunId('ledger_usage')).toBe(false);
    expect(validateFunctionalRunId('fnrun..test')).toBe(false);
  });

  it('rejects path traversal attempts', () => {
    expect(() => resolveFunctionalRunPath(runsDir, '../secret')).toThrow(/Invalid functional run ID/);
  });

  it('persists functional records separately under runs/functional without touching regular runs', async () => {
    const snapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const record = await runFunctionalBaselines({
      variant: 'clean',
      systemSnapshot: snapshot,
    });

    const savedPath = await saveFunctionalRun(record, runsDir);
    expect(savedPath).toContain(path.join('runs', 'functional', record.id, 'record.json'));

    // Functional run is readable via getFunctionalRun
    const retrieved = await getFunctionalRun(record.id, runsDir);
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(record.id);
    expect(retrieved?.status).toBe('pass');
    expect(retrieved?.variant).toBe('clean');

    // Functional run is NOT exposed as an ordinary exploratory investigation run
    const ordinaryRun = await getRun(record.id, runsDir);
    expect(ordinaryRun).toBeNull();

    const ordinaryRunsList = await listRuns(runsDir);
    expect(ordinaryRunsList.some((r) => r.id === record.id)).toBe(false);

    // Functional run is returned in listFunctionalRuns
    const functionalList = await listFunctionalRuns(runsDir);
    expect(functionalList.length).toBe(1);
    expect(functionalList[0]!.id).toBe(record.id);
    expect(functionalList[0]!.type).toBe('functional-baseline');
  });

  it('enforces atomic non-overwriting publication', async () => {
    const snapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const record = await runFunctionalBaselines({
      variant: 'clean',
      systemSnapshot: snapshot,
    });

    await saveFunctionalRun(record, runsDir);

    // Attempting to overwrite the same ID must throw
    await expect(saveFunctionalRun(record, runsDir)).rejects.toThrow(/Cannot overwrite existing functional run/);
  });

  it('brief edited after saved run leaves historical run record unchanged', async () => {
    // 1. Save initial brief at revision 1
    const brief = await saveSystemBrief(SEEDED_TRADING_BRIEF, systemsDir, { mode: 'create' });
    const snapshot = await createSystemSnapshot(brief);
    expect(snapshot.brief.revision).toBe(1);

    // 2. Run and save functional baseline
    const record = await runFunctionalBaselines({
      variant: 'clean',
      systemSnapshot: snapshot,
    });
    await saveFunctionalRun(record, runsDir);

    // 3. Edit brief to revision 2
    const updatedBrief = await saveSystemBrief(
      { ...brief, name: 'Renamed Trading Gateway', overview: 'Updated overview' },
      systemsDir,
      { mode: 'update', expectedRevision: 1 },
    );
    expect(updatedBrief.revision).toBe(2);

    // 4. Retrieve historical run: historical revision remains 1 and name remains original!
    const reloaded = await getFunctionalRun(record.id, runsDir);
    expect(reloaded).toBeDefined();
    expect(reloaded!.systemBrief.revision).toBe(1);
    expect(reloaded!.systemBrief.name).toBe('ChaosPilot Trading Gateway');
    expect(reloaded!.systemSnapshot.brief.revision).toBe(1);
  });

  it('lists functional runs sorted newest first and ignores temporary or invalid files', async () => {
    const snapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const record1 = await runFunctionalBaselines({
      variant: 'clean',
      systemSnapshot: snapshot,
    });
    record1.id = 'fnrun_1001';
    record1.startedAt = '2026-10-31T10:00:00.000Z';
    await saveFunctionalRun(record1, runsDir);

    const record2 = await runFunctionalBaselines({
      variant: 'clean',
      systemSnapshot: snapshot,
    });
    record2.id = 'fnrun_1002';
    record2.startedAt = '2026-10-31T12:00:00.000Z';
    await saveFunctionalRun(record2, runsDir);

    // Write a temporary file and an invalid file in runs/functional
    const fnDir = path.join(runsDir, 'functional');
    await fs.writeFile(path.join(fnDir, '.tmp-unrelated.tmp'), 'ignore me');
    await fs.writeFile(path.join(fnDir, 'corrupt.json'), 'not valid json');

    const list = await listFunctionalRuns(runsDir);
    expect(list.length).toBe(2);
    // Newest first: record2 was 12:00, record1 was 10:00
    expect(list[0]!.id).toBe('fnrun_1002');
    expect(list[1]!.id).toBe('fnrun_1001');
  });
  it('atomically rejects simultaneous same-ID writers and exposes one complete winner', async () => {
    const snapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const a = await runFunctionalBaselines({ variant: 'clean', systemSnapshot: snapshot });
    const b = await runFunctionalBaselines({ variant: 'candidate-c', systemSnapshot: snapshot }); b.id = a.id;
    const outcomes = await Promise.allSettled([saveFunctionalRun(a, runsDir), saveFunctionalRun(b, runsDir)]);
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(o => o.status === 'rejected')).toHaveLength(1);
    const winner = await getFunctionalRun(a.id, runsDir);
    expect(winner).toEqual(outcomes[0]!.status === 'fulfilled' ? a : b);
    expect(await fs.readdir(path.join(runsDir, 'functional'))).toEqual([a.id]);
  });

  it('preserves a destination created immediately before publication and keeps unfinished records invisible', async () => {
    const snapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const loser = await runFunctionalBaselines({ variant: 'clean', systemSnapshot: snapshot });
    const winner = await runFunctionalBaselines({ variant: 'candidate-c', systemSnapshot: snapshot }); winner.id = loser.id;
    const finalPath = resolveFunctionalRunPath(runsDir, loser.id);
    const rename = fs.rename;
    let intercepted = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === path.dirname(finalPath)) {
        intercepted = true;
        expect(await getFunctionalRun(loser.id, runsDir)).toBeNull();
        expect(await listFunctionalRuns(runsDir)).toEqual([]);
        await fs.mkdir(path.dirname(finalPath));
        await fs.writeFile(finalPath, JSON.stringify(winner));
      }
      return rename(from, to);
    });
    await expect(saveFunctionalRun(loser, runsDir)).rejects.toThrow(/Cannot overwrite/);
    expect(intercepted).toBe(true);
    expect(await getFunctionalRun(winner.id, runsDir)).toEqual(winner);
    expect(await fs.readdir(path.join(runsDir, 'functional'))).toEqual([winner.id]);
  });

  it('rejects malformed or internally contradictory purported saved passes', async () => {
    const record = await runFunctionalBaselines({ variant: 'clean', systemSnapshot: await createSystemSnapshot(SEEDED_TRADING_BRIEF) });
    await saveFunctionalRun(record, runsDir);
    const mutations: ((r: any) => void)[] = [
      r => { r.variant = 'candidate-c'; }, r => { r.summary.passed = 999; }, r => { r.scenarios = []; },
      r => { r.scenarios[0].assertions = []; }, r => { r.scenarios[0].executionComplete = false; },
      r => { r.scenarios[0].trace[5].messageId = 'other'; },
      r => { r.scenarios[0].sourceHash = 'other'; }, r => { r.scenarios[0].expectedSourceHash = 'other'; },
      r => { r.scenarios[0].experiment.steps = []; }, r => { r.systemBrief.revision++; },
      r => { r.systemSnapshot.brief.overview = 'changed'; }, r => { r.scenarios[0].violations = null; },
      r => { r.scenarios[0].trace[5].state.orders['ord-baseline-1'].status = 'CANCELLED'; },
      r => { r.finishedAt = 'invalid'; }, r => { r.evaluator = {}; }, r => { r.contract = {}; },
    ];
    for (const mutate of mutations) {
      const corrupt = structuredClone(record); mutate(corrupt);
      await fs.writeFile(resolveFunctionalRunPath(runsDir, record.id), JSON.stringify(corrupt));
      expect(await getFunctionalRun(record.id, runsDir)).toBeNull();
      expect(await listFunctionalRuns(runsDir)).toEqual([]);
    }
  });

});
