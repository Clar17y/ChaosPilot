import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Experiment, ExperimentResult, Finding, InvestigationRecord, SystemContract } from '../src/domain.ts';
import { firstResolvableFindingPosition, resolveExperimentPositionForIndex } from '../src/experiment-identity.ts';
import { resolveExperimentPosition } from '../src/web/reproduction-player.ts';
import { replayRun, replaySelectedExperiment, type SimulatorApi } from '../src/storage.ts';
import { computeContractHash } from '../src/evidence.ts';
import { getPromptIdentity } from '../src/investigation/prompt.ts';

const SOURCE = 'hash-identity-1';
const CONTRACT: SystemContract = {
  name: 'Identity contract', description: 'test', operations: [], messages: [],
  invariants: [{ id: 'inv', description: 'test invariant' }], limits: {},
};

function resultFor(exp: Experiment, marker: string): ExperimentResult {
  return {
    schemaVersion: 1, experiment: exp, sourceHash: SOURCE,
    trace: [{ step: 0, time: 0, action: marker, outcome: 'SENT', state: { marker } }],
    snapshot: { marker }, violations: [{ id: `v-${marker}`, invariant: 'inv', message: `m-${marker}`, step: 0, evidence: {} }],
    rejections: [], valid: true,
  };
}

function makeRecord(indices: (number | undefined)[], findingIndex: number, findingPlanPosition = 1): InvestigationRecord {
  const experiments = indices.map((index, i) => {
    const exp: Experiment = { hypothesis: `hyp-${i}`, expectedInvariant: 'inv', steps: [] };
    const rec = { index: index as number, experiment: exp, result: resultFor(exp, `exp-${i}`), replayVerified: true, cleanControlPassed: true };
    if (index === undefined) delete (rec as { index?: number }).index;
    return rec;
  });
  const finding: Finding = {
    id: 'f-1', title: 'Finding', hypothesis: `hyp-${findingPlanPosition}`, experimentIndex: findingIndex,
    violation: { id: 'v-1', invariant: 'inv', message: 'm', step: 0, evidence: {} },
    sourceHash: SOURCE, reproduced: true, cleanControlPassed: true,
    replay: structuredClone(experiments[findingPlanPosition]!.experiment),
  };
  return {
    schemaVersion: 1, id: 'run_identity_01', provider: 'mock', model: 'mock-scripted', mode: 'mock',
    variant: 'candidate-a', status: 'completed', startedAt: new Date().toISOString(),
    sourceHash: SOURCE, experiments, findings: [finding],
    usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, errors: [],
    contextAudit: {
      sourcePaths: [], contractHash: computeContractHash(CONTRACT),
      promptVersion: getPromptIdentity('synthetic-trading').promptVersion,
      promptTemplateHash: getPromptIdentity('synthetic-trading').promptTemplateHash,
    },
  } as InvestigationRecord;
}

function echoSimulator(calls: string[]): SimulatorApi {
  return {
    getContract: () => CONTRACT,
    getSourceBundle: () => ({ hash: SOURCE, files: [] }),
    executeExperiment: (exp) => { calls.push(exp.hypothesis); return resultFor(exp, `exp-${exp.hypothesis.replace('hyp-', '')}`); },
  };
}

describe('shared experiment identity resolver', () => {
  const exps = (...indices: (number | undefined)[]) => indices.map(index => ({ index }));

  it('resolves explicit noncontiguous and zero-based indices uniquely', () => {
    expect(resolveExperimentPositionForIndex(exps(7, 42), 42)).toBe(1);
    expect(resolveExperimentPositionForIndex(exps(7, 42), 7)).toBe(0);
    expect(resolveExperimentPositionForIndex(exps(0, 1), 0)).toBe(0);
    expect(resolveExperimentPositionForIndex(exps(0, 1), 1)).toBe(1);
  });

  it('uses one-based legacy position only when every index is absent', () => {
    expect(resolveExperimentPositionForIndex(exps(undefined, undefined), 1)).toBe(0);
    expect(resolveExperimentPositionForIndex(exps(undefined, undefined), 2)).toBe(1);
    expect(resolveExperimentPositionForIndex(exps(undefined, 5), 2)).toBe(-1); // mixed: no positional guess
    expect(resolveExperimentPositionForIndex(exps(undefined, 5), 5)).toBe(1); // explicit still resolves
  });

  it('rejects unmatched, duplicate, invalid and out-of-range indices', () => {
    expect(resolveExperimentPositionForIndex(exps(7, 42), 8)).toBe(-1);
    expect(resolveExperimentPositionForIndex(exps(7, 7), 7)).toBe(-1);
    expect(resolveExperimentPositionForIndex(exps(undefined, undefined), 0)).toBe(-1);
    expect(resolveExperimentPositionForIndex(exps(undefined, undefined), 3)).toBe(-1);
    for (const bad of [-1, 1.5, NaN, Infinity, '1', null, undefined, {}]) {
      expect(resolveExperimentPositionForIndex(exps(1, 2), bad)).toBe(-1);
      expect(resolveExperimentPositionForIndex(exps(undefined, undefined), bad)).toBe(-1);
    }
    expect(resolveExperimentPositionForIndex([], 1)).toBe(-1);
    expect(resolveExperimentPositionForIndex(null, 1)).toBe(-1);
  });

  it('player wrapper and first-resolvable helper agree with the shared resolver', () => {
    const record = makeRecord([undefined, undefined], 2);
    expect(resolveExperimentPosition(record, record.findings[0]!)).toBe(1);
    expect(firstResolvableFindingPosition(record)?.position).toBe(1);
    const unresolvableFirst = makeRecord([10, 20], 99);
    unresolvableFirst.findings.push({ ...unresolvableFirst.findings[0]!, id: 'f-2', experimentIndex: 10 });
    expect(firstResolvableFindingPosition(unresolvableFirst)?.finding.id).toBe('f-2');
    expect(firstResolvableFindingPosition(makeRecord([10, 20], 99))).toBeNull();
  });
});

describe('replay plan gate uses the shared resolver (full and selected)', () => {
  let tmpDir: string;
  beforeEach(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chaospilot-identity-')); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  it('legacy all-absent indices: verifies the one-based finding plan and executes', async () => {
    const record = makeRecord([undefined, undefined], 2); // finding belongs to position 1
    const selectedCalls: string[] = [];
    const selected = await replaySelectedExperiment(record, 1, tmpDir, echoSimulator(selectedCalls));
    expect(selectedCalls).toEqual(['hyp-1']);
    expect(selected.exactReproductionClaimed).toBe(true);
    const fullCalls: string[] = [];
    const full = await replayRun(record, tmpDir, echoSimulator(fullCalls));
    expect(fullCalls).toEqual(['hyp-0', 'hyp-1']);
    expect(full.exactReproductionClaimed).toBe(true);
  });

  it('explicit noncontiguous indices: verifies the matched plan and executes', async () => {
    const record = makeRecord([7, 42], 42);
    const calls: string[] = [];
    const report = await replaySelectedExperiment(record, 1, tmpDir, echoSimulator(calls));
    expect(calls).toEqual(['hyp-1']);
    expect(report.exactReproductionClaimed).toBe(true);
  });

  it.each([
    ['legacy tampered plan', () => { const r = makeRecord([undefined, undefined], 2); r.findings[0]!.replay.hypothesis = 'hyp-0'; return r; }],
    ['legacy zero index', () => makeRecord([undefined, undefined], 0)],
    ['legacy out-of-range index', () => makeRecord([undefined, undefined], 3)],
    ['fractional index', () => makeRecord([undefined, undefined], 1.5)],
    ['explicit unmatched index', () => makeRecord([7, 42], 8)],
    ['mixed missing/present with positional index', () => makeRecord([undefined, 42], 2)],
    ['duplicate explicit index', () => makeRecord([42, 42], 42)],
    ['explicit plan pointing at the other experiment', () => makeRecord([7, 42], 7)],
    ['missing experimentIndex with a saved plan', () => { const r = makeRecord([7, 42], 42); delete (r.findings[0] as { experimentIndex?: number }).experimentIndex; return r; }],
  ])('rejects %s before any execution in both scopes', async (_name, build) => {
    const record = build();
    const calls: string[] = [];
    const sim = echoSimulator(calls);
    await expect(replaySelectedExperiment(record, 1, tmpDir, sim)).rejects.toThrow(/finding source or plan identity mismatch/);
    await expect(replayRun(record, tmpDir, sim)).rejects.toThrow(/finding source or plan identity mismatch/);
    expect(calls).toEqual([]);
  });

  it('a finding without a saved replay plan keeps historical replay compatibility', async () => {
    const record = makeRecord([undefined, undefined], 2);
    delete (record.findings[0] as { replay?: Experiment }).replay;
    const calls: string[] = [];
    const report = await replaySelectedExperiment(record, 0, tmpDir, echoSimulator(calls));
    expect(calls).toEqual(['hyp-0']);
    expect(report.exactReproductionClaimed).toBe(true);
  });
});
