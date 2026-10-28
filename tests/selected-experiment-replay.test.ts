import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ChaosPilotServer } from '../src/server.ts';
import {
  saveRun,
  replayRun,
  replaySelectedExperiment,
  parseExperimentPosition,
  setSimulatorApi,
  type SimulatorApi,
} from '../src/storage.ts';
import type {
  Experiment,
  ExperimentResult,
  InvestigationRecord,
  SystemContract,
} from '../src/domain.ts';
import { computeContractHash } from '../src/evidence.ts';
import { getPromptIdentity } from '../src/investigation/prompt.ts';

const SOURCE = 'hash-abc-123';
/** Contract the instrumented simulator reports; fixture audit hashes it so
 * legacy context gates verify identical instead of blocking exact claims. */
const FAKE_CONTRACT: SystemContract = {
  name: 'Echo contract', description: 'Instrumented test contract',
  operations: [], messages: [], invariants: [{ id: 'inv', description: 'test invariant' }], limits: {},
};

function resultFor(exp: Experiment, marker: string): ExperimentResult {
  return {
    schemaVersion: 1,
    experiment: exp,
    sourceHash: SOURCE,
    trace: [{ step: 0, time: 0, action: marker, outcome: 'SENT', state: { marker } }],
    snapshot: { marker },
    violations: [{ id: `v-${marker}`, invariant: 'inv', message: `m-${marker}`, step: 0, evidence: {} }],
    rejections: [{ step: 1, reason: `r-${marker}` }],
    valid: true,
  };
}

function makeRecord(id: string, indices: (number | undefined)[] = [7, 42]): InvestigationRecord {
  const experiments = indices.map((index, i) => {
    const exp: Experiment = { hypothesis: `hyp-${i}`, expectedInvariant: 'inv', steps: [] };
    const rec: InvestigationRecord['experiments'][number] = {
      index: index as number,
      experiment: exp,
      result: resultFor(exp, `exp-${i}`),
      replayVerified: false,
      cleanControlPassed: false,
    };
    if (index === undefined) delete (rec as { index?: number }).index;
    return rec;
  });
  return {
    schemaVersion: 1, id, provider: 'mock', model: 'mock-scripted', mode: 'mock',
    variant: 'candidate-a', status: 'completed',
    startedAt: new Date(Date.now() - 5000).toISOString(), finishedAt: new Date().toISOString(),
    sourceHash: SOURCE, experiments, findings: [],
    usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, errors: [],
    contextAudit: {
      sourcePaths: ['order-engine.ts'],
      contractHash: computeContractHash(FAKE_CONTRACT),
      promptVersion: getPromptIdentity('synthetic-trading').promptVersion,
      promptTemplateHash: getPromptIdentity('synthetic-trading').promptTemplateHash,
    },
  };
}

/** Instrumented deterministic simulator: echoes the saved result for the executed experiment. */
function echoSimulator(calls: string[], opts: { bundleHash?: string; mutate?: (r: ExperimentResult) => void; throwOn?: string } = {}) {
  const sim: SimulatorApi = {
    getContract: () => FAKE_CONTRACT,
    getSourceBundle: () => ({ hash: opts.bundleHash ?? SOURCE, files: [] }),
    executeExperiment: (exp) => {
      calls.push(exp.hypothesis);
      if (opts.throwOn === exp.hypothesis) throw new Error('simulator execution failed');
      // Find nothing: replayed result is rebuilt from the experiment identity via hypothesis suffix.
      const i = exp.hypothesis.replace('hyp-', '');
      const r = resultFor(exp, `exp-${i}`);
      if (opts.mutate) opts.mutate(r);
      // Results returned by a diverged bundle carry its hash, as the real simulator would.
      if (opts.bundleHash) r.sourceHash = opts.bundleHash;
      return r;
    },
  };
  return sim;
}

describe('parseExperimentPosition', () => {
  it('accepts only nonnegative canonical integers', () => {
    expect(parseExperimentPosition(0)).toBe(0);
    expect(parseExperimentPosition(2)).toBe(2);
    expect(parseExperimentPosition('0')).toBe(0);
    expect(parseExperimentPosition('12')).toBe(12);
    for (const bad of [-1, 1.5, NaN, Infinity, '-1', '-0', '+1', '01', ' 1', '1 ', '1.0', '1e2', '0x1', '', 'abc', null, undefined, {}, [], '999999999999999999999999', Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseExperimentPosition(bad)).toBeNull();
    }
  });
});

describe('replaySelectedExperiment (unit)', () => {
  let tmpDir: string;
  beforeEach(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chaospilot-sel-replay-')); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  it('executes exactly the second experiment by array position, once', async () => {
    const record = makeRecord('run_sel_second');
    await saveRun(record, tmpDir);
    const before = await fs.readFile(path.join(tmpDir, 'run_sel_second.json'), 'utf8');
    const calls: string[] = [];
    const report = await replaySelectedExperiment('run_sel_second', 1, tmpDir, echoSimulator(calls));
    expect(calls).toEqual(['hyp-1']);
    expect(report.scope).toBe('experiment');
    expect(report.experimentPosition).toBe(1);
    expect(report.experimentsTotal).toBe(1);
    expect(report.experimentsReproduced).toBe(1);
    expect(report.reproduced).toBe(true);
    expect(report.exactReproductionClaimed).toBe(true);
    expect(report.sourceIdentical).toBe(true);
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0]?.index).toBe(42); // recorded index preserved in outcome
    expect(report.outcomes[0]?.replayedResult.trace[0]?.action).toBe('exp-1');
    expect(report.note).toContain('No clean comparison was rerun');
    // Saved evidence untouched.
    expect(await fs.readFile(path.join(tmpDir, 'run_sel_second.json'), 'utf8')).toBe(before);
  });

  it('executes the first experiment at position 0 and accepts canonical string positions', async () => {
    await saveRun(makeRecord('run_sel_first'), tmpDir);
    const calls: string[] = [];
    const report = await replaySelectedExperiment('run_sel_first', '0', tmpDir, echoSimulator(calls));
    expect(calls).toEqual(['hyp-0']);
    expect(report.outcomes[0]?.index).toBe(7);
    expect(report.exactReproductionClaimed).toBe(true);
  });

  it('uses array order for legacy missing and noncontiguous recorded indices', async () => {
    await saveRun(makeRecord('run_sel_legacy', [undefined, undefined]), tmpDir);
    const calls: string[] = [];
    const report = await replaySelectedExperiment('run_sel_legacy', 1, tmpDir, echoSimulator(calls));
    expect(calls).toEqual(['hyp-1']);
    expect(report.outcomes[0]?.index).toBe(1); // falls back to array position
    // Recorded index 42 (position 1 in the noncontiguous case) is not a position.
    await saveRun(makeRecord('run_sel_noncontig'), tmpDir);
    await expect(replaySelectedExperiment('run_sel_noncontig', 42, tmpDir, echoSimulator([]))).rejects.toThrow(/out of range/);
  });

  it('refuses exact claim on source drift even when semantics otherwise match', async () => {
    await saveRun(makeRecord('run_sel_drift'), tmpDir);
    const calls: string[] = [];
    const report = await replaySelectedExperiment('run_sel_drift', 1, tmpDir, echoSimulator(calls, { bundleHash: 'other-hash' }));
    expect(calls).toEqual(['hyp-1']);
    expect(report.sourceIdentical).toBe(false);
    expect(report.exactReproductionClaimed).toBe(false);
    expect(report.reproduced).toBe(false);
    expect(report.experimentsReproduced).toBe(0);
    expect(report.note).toContain('Source changed or diverged');
    expect(report.note).toContain('No clean comparison was rerun');
  });

  it('reports matching behaviour under source drift without counting an exact result', async () => {
    await saveRun(makeRecord('run_sel_semantic_drift'), tmpDir);
    const report = await replaySelectedExperiment('run_sel_semantic_drift', 0, tmpDir, echoSimulator([], { bundleHash: 'other-hash' }));
    // Semantic components all match; only the source identity drifted.
    expect(report.outcomes[0]?.traceMatched).toBe(true);
    expect(report.outcomes[0]?.snapshotMatched).toBe(true);
    expect(report.outcomes[0]?.violationsMatched).toBe(true);
    expect(report.outcomes[0]?.exactMatched).toBe(false);
    expect(report.experimentsReproduced).toBe(0);
    expect(report.sourceIdentical).toBe(false);
    expect(report.reproduced).toBe(false);
    expect(report.exactReproductionClaimed).toBe(false);
    expect(report.note).toContain('semantically matched');
    expect(report.note).toContain('exact reproduction cannot be claimed');
    // A semantic mismatch under drift is not counted.
    const mismatch = await replaySelectedExperiment('run_sel_semantic_drift', 0, tmpDir, echoSimulator([], { bundleHash: 'other-hash', mutate: (r) => { r.trace = []; } }));
    expect(mismatch.experimentsReproduced).toBe(0);
    expect(mismatch.reproduced).toBe(false);
    expect(mismatch.exactReproductionClaimed).toBe(false);
  });

  it('uses the same result count as full-run replay when only the current bundle hash differs', async () => {
    const record = makeRecord('run_sel_bundle_drift', [7]);
    const simulator = echoSimulator([]);
    simulator.getSourceBundle = () => ({ hash: 'different-bundle', files: [] });
    const selected = await replaySelectedExperiment(record, 0, tmpDir, simulator);
    const whole = await replayRun(record, tmpDir, simulator);
    expect(selected.outcomes[0]?.exactMatched).toBe(true);
    expect(selected.experimentsReproduced).toBe(whole.experimentsReproduced);
    expect(selected.experimentsReproduced).toBe(1);
    expect(selected.sourceIdentical).toBe(false);
    expect(selected.exactReproductionClaimed).toBe(false);
    expect(selected.reproduced).toBe(false);
  });

  it('refuses exact claim when the source bundle is unavailable', async () => {
    await saveRun(makeRecord('run_sel_nosrc'), tmpDir);
    const sim = echoSimulator([]);
    const throwing: SimulatorApi = { executeExperiment: sim.executeExperiment, getSourceBundle: () => { throw new Error('no bundle'); } };
    const report = await replaySelectedExperiment('run_sel_nosrc', 0, tmpDir, throwing);
    expect(report.currentSourceHash).toBe('unavailable');
    expect(report.sourceIdentical).toBe(false);
    expect(report.exactReproductionClaimed).toBe(false);
  });

  it.each([
    ['trace', (r: ExperimentResult) => { r.trace = []; }, 'traceMatched'],
    ['snapshot', (r: ExperimentResult) => { r.snapshot = { other: 1 }; }, 'snapshotMatched'],
    ['violations', (r: ExperimentResult) => { r.violations = []; }, 'violationsMatched'],
    ['rejections', (r: ExperimentResult) => { r.rejections = []; }, 'rejectionsMatched'],
    ['validity', (r: ExperimentResult) => { r.valid = false; }, 'validityMatched'],
  ] as const)('refuses exact claim on %s mismatch with matching source', async (_name, mutate, flag) => {
    await saveRun(makeRecord('run_sel_mismatch'), tmpDir);
    const report = await replaySelectedExperiment('run_sel_mismatch', 1, tmpDir, echoSimulator([], { mutate }));
    expect(report.sourceIdentical).toBe(true);
    expect(report.exactReproductionClaimed).toBe(false);
    expect(report.reproduced).toBe(false);
    expect(report.outcomes[0]?.[flag]).toBe(false);
    expect(report.outcomes[0]?.exactMatched).toBe(false);
    expect(report.outcomes[0]?.mismatches?.length).toBeGreaterThan(0);
  });

  it('rejects invalid and out-of-range positions without executing', async () => {
    await saveRun(makeRecord('run_sel_badpos'), tmpDir);
    const calls: string[] = [];
    const sim = echoSimulator(calls);
    for (const bad of [-1, 1.5, NaN, '-1', '01', 'abc', '', null, undefined, '999999999999999999999999', 2, 99]) {
      await expect(replaySelectedExperiment('run_sel_badpos', bad, tmpDir, sim)).rejects.toThrow();
    }
    expect(calls).toEqual([]);
  });

  it('rejects unknown and malformed records safely without executing', async () => {
    const calls: string[] = [];
    const sim = echoSimulator(calls);
    await expect(replaySelectedExperiment('run_missing_xx', 0, tmpDir, sim)).rejects.toThrow(/not found or malformed/);
    await fs.writeFile(path.join(tmpDir, 'run_broken_001.json'), '{ broken json');
    await expect(replaySelectedExperiment('run_broken_001', 0, tmpDir, sim)).rejects.toThrow(/not found or malformed/);
    const malformed = makeRecord('run_sel_malformed');
    delete (malformed.experiments[1] as { result?: unknown }).result;
    await expect(replaySelectedExperiment(malformed, 1, tmpDir, sim)).rejects.toThrow(/malformed/);
    expect(calls).toEqual([]);
  });

  it('propagates execution errors and never claims reproduction', async () => {
    await saveRun(makeRecord('run_sel_execerr'), tmpDir);
    await expect(
      replaySelectedExperiment('run_sel_execerr', 1, tmpDir, echoSimulator([], { throwOn: 'hyp-1' }))
    ).rejects.toThrow('simulator execution failed');
  });

  it('keeps full-run replay unchanged: all experiments, experimentsTotal = saved count', async () => {
    await saveRun(makeRecord('run_sel_full'), tmpDir);
    const calls: string[] = [];
    const report = await replayRun('run_sel_full', tmpDir, echoSimulator(calls));
    expect(calls).toEqual(['hyp-0', 'hyp-1']);
    expect(report.scope).toBeUndefined();
    expect(report.experimentPosition).toBeUndefined();
    expect(report.experimentsTotal).toBe(2);
    expect(report.experimentsReproduced).toBe(2);
    expect(report.exactReproductionClaimed).toBe(true);
    expect(report.outcomes).toHaveLength(2);
  });
});

describe('POST /api/runs/:id/experiments/:position/replay (HTTP)', () => {
  let tmpDir: string;
  let server: http.Server;
  let baseUrl: string;
  const calls: string[] = [];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chaospilot-sel-http-'));
    calls.length = 0;
    setSimulatorApi(echoSimulator(calls));
    await saveRun(makeRecord('run_http_sel'), tmpDir);
    const instance = new ChaosPilotServer({ runsDir: tmpDir });
    server = instance.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      baseUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
      resolve();
    }));
  });

  afterEach(async () => {
    setSimulatorApi(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const post = (p: string) => fetch(`${baseUrl}${p}`, { method: 'POST' });

  it('replays only the selected second experiment', async () => {
    const res = await post('/api/runs/run_http_sel/experiments/1/replay');
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(calls).toEqual(['hyp-1']);
    expect(report.scope).toBe('experiment');
    expect(report.experimentPosition).toBe(1);
    expect(report.experimentsTotal).toBe(1);
    expect(report.experimentsReproduced).toBe(1);
    expect(report.exactReproductionClaimed).toBe(true);
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0].replayedResult.trace[0].action).toBe('exp-1');
  });

  it.each(['-1', '1.5', '01', 'abc', '999999999999999999999999', '2'])(
    'rejects invalid/out-of-range position %s with 400 and no execution', async (pos) => {
      const res = await post(`/api/runs/run_http_sel/experiments/${pos}/replay`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeTruthy();
      expect(JSON.stringify(body)).not.toContain(tmpDir);
      expect(calls).toEqual([]);
    }
  );

  it('rejects a missing position and unknown or invalid runs', async () => {
    expect((await post('/api/runs/run_http_sel/experiments/replay')).status).toBe(404);
    expect((await post('/api/runs/run_unknown_99/experiments/0/replay')).status).toBe(400);
    expect((await post('/api/runs/ab/experiments/0/replay')).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('keeps the full-run replay endpoint backwards compatible', async () => {
    const res = await post('/api/runs/run_http_sel/replay');
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(calls).toEqual(['hyp-0', 'hyp-1']);
    expect(report.experimentsTotal).toBe(2);
    expect(report.outcomes).toHaveLength(2);
    expect(report.exactReproductionClaimed).toBe(true);
  });
});
