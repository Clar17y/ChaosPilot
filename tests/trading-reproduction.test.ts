import { describe, expect, it } from 'vitest';
import type { InvestigationRecord, TraceEntry } from '../src/domain.ts';
import { buildReproductionModel, buildRerunSteps, classifyFreshReplay, groupUnimportantSteps, buildTraceSteps } from '../src/web/reproduction-player.ts';
import { ReproductionSession } from '../src/web/reproduction-state.ts';

function rec(trace: TraceEntry[], opts: { invariant?: string; violations?: unknown[]; contract?: unknown } = {}): InvestigationRecord {
  const invariant = opts.invariant ?? 'no_overfill';
  return {
    schemaVersion: 1, id: 'run-x', provider: 'mock', model: 'm', mode: 'mock', variant: 'candidate-a', status: 'completed',
    startedAt: '2026-01-01T00:00:00Z', sourceHash: 'srcX',
    experiments: [{ index: 7, experiment: { hypothesis: 'h', expectedInvariant: invariant, steps: [] },
      result: { schemaVersion: 1, experiment: { hypothesis: 'h', expectedInvariant: invariant, steps: [] }, sourceHash: 'srcX', trace, snapshot: {}, violations: opts.violations ?? [], rejections: [], valid: true },
      replayVerified: false, cleanControlPassed: false }],
    findings: [], usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, errors: [],
    contextAudit: { sourcePaths: [], contractHash: 'h', promptVersion: '1' },
    ...(opts.contract !== undefined ? { systemBrief: { brief: { schemaVersion: 1, id: 's', revision: 3, name: 'Sys', overview: '', requirements: [], adapterId: 'synthetic-trading', updatedAt: '' }, contract: opts.contract, hash: 'bh' } } : {}),
  } as unknown as InvestigationRecord;
}
const e = (step: number, outcome: string, payload: unknown, state: Record<string, unknown> = {}): TraceEntry => ({ step, time: step, action: 'deliver', payload, outcome, state });

describe('generalized trading walkthrough', () => {
  it('0, 1, several and many events', () => {
    expect(buildReproductionModel(rec([]), 0, null)!.hasTrace).toBe(false);
    expect(buildReproductionModel(rec([]), 0, null)!.allSteps).toHaveLength(0);
    expect(buildReproductionModel(rec([e(0, 'delivered:processed', { type: 'quote', price: 5 })]), 0, null)!.allSteps).toHaveLength(1);
    const many = Array.from({ length: 20 }, (_, i) => e(i, 'delivered:processed', { type: 'quote', price: i }));
    const m = buildReproductionModel(rec(many), 0, null)!;
    expect(m.allSteps).toHaveLength(20); expect(m.traceCount).toBe(20);
    expect(m.allSteps.map(s => s.tracePosition)).toEqual(many.map((_, i) => i));
  });
  it('groups only consecutive scheduled entries and keeps full trace accessible', () => {
    const trace = [e(0,'scheduled',{type:'quote'}),e(1,'scheduled',{type:'quote'}),e(2,'scheduled',{type:'quote'}),e(3,'scheduled',{type:'quote'}), e(4,'delivered:processed',{type:'new_order',orderId:'o1',quantity:1})];
    const m = buildReproductionModel(rec(trace), 0, null)!;
    expect(m.sequence).toBe('grouped'); expect(m.steps.length).toBeLessThan(m.allSteps.length);
    expect(m.steps[0]!.isGroup).toBe(true); expect(m.allSteps).toHaveLength(5);
    expect(groupUnimportantSteps(buildTraceSteps(trace, []).steps)![0]!.groupTracePositions).toEqual([0,1,2,3]);
  });
  it('unknown/incomplete entries remain recorded steps with facts fallback', () => {
    const m = buildReproductionModel(rec([e(0,'mystery_outcome',undefined), e(1,'delivered:processed',{type:'unknown_thing',foo:1})]), 0, null)!;
    expect(m.allSteps).toHaveLength(2); expect(m.allSteps[0]!.kind).toBe('other'); expect(m.allSteps[1]!.facts.join(' ')).toContain('unknown_thing');
  });
  it('non-credit invariants: evidence, pinned rule vs missing, no credit relevance', () => {
    const violations = [{ id:'v', invariant:'no_overfill', step:0, orderId:'o1', message:'Order o1 overfilled', evidence:{} }];
    const withContract = rec([e(0,'delivered:processed',{type:'execution',orderId:'o1',quantity:10})], { violations, contract: { name:'',description:'',operations:[],messages:[],invariants:[{id:'no_overfill',description:'Fills must not exceed order quantity'}],limits:{} } });
    const m = buildReproductionModel(withContract, 0, null)!;
    expect(m.evidence.invariant).toBe('no_overfill'); expect(m.evidence.ruleText).toContain('Fills must not exceed');
    expect(m.evidence.ruleLabel).toBe("Pinned rule (no_overfill) from the run's saved contract"); // no trailing colon: the renderer adds one
    expect(m.evidence.creditRelevant).toBe(false); expect(m.allSteps[0]!.isViolation).toBe(true); expect(m.allSteps[0]!.facts.join(' ')).toContain('Order: o1');
    const legacy = buildReproductionModel(rec([e(0,'delivered:processed',{type:'execution',orderId:'o1'})], { violations }), 0, null)!;
    expect(legacy.evidence.ruleText).toBeNull(); expect(legacy.evidence.ruleLabel).toContain('unavailable');
  });
  it('second non-credit class and ambiguous action stays unattributed', () => {
    const violations = [{ id:'v2', invariant:'execution_idempotency', step:2, orderId:'o1', message:'Duplicate execution mutated state', evidence:{} }];
    const trace=[e(2,'delivered:processed',{type:'execution',orderId:'o1'}), e(2,'delivered:processed',{type:'execution',orderId:'o1'})];
    const m = buildReproductionModel(rec(trace,{violations, invariant:'execution_idempotency'}),0,null)!;
    expect(m.unattributedViolations).toHaveLength(1); expect(m.allSteps.every(s=>!s.isViolation)).toBe(true);
  });
  it('rejection alone is not violation and credit story not forced on non-credit', () => {
    const m = buildReproductionModel(rec([e(0,'delivered:rejected (credit limit)',{type:'new_order',orderId:'o9'})]),0,null)!;
    expect(m.allSteps[0]!.isViolation).toBe(false); expect(m.evidence.creditRelevant).toBe(false);
  });
  it('classifies rerun matched / source-changed / mismatch and builds rerun steps', () => {
    const base={scope:'experiment',experimentPosition:0,experimentsTotal:1,outcomes:[{replayedResult:{trace:[e(0,'delivered:processed',{type:'quote',price:1})],violations:[]}}]};
    expect(classifyFreshReplay({...base,sourceIdentical:true,reproduced:true,exactReproductionClaimed:true})).toBe('success');
    expect(classifyFreshReplay({...base,sourceIdentical:false,reproduced:false,exactReproductionClaimed:false})).toBe('source-changed');
    expect(classifyFreshReplay({...base,sourceIdentical:true,reproduced:false,exactReproductionClaimed:false})).toBe('mismatch');
    expect(buildRerunSteps({...base,sourceIdentical:true,reproduced:true,exactReproductionClaimed:true})).toHaveLength(1);
  });
  it('session scopes pending to run+position+finding', () => {
    const s=new ReproductionSession(); s.resetForRun('r1');
    const tok=s.beginFresh('r1',1,'f1');
    expect(s.isFreshCurrent(tok,'r1',1,'f1')).toBe(true);
    expect(s.isFreshCurrent(tok,'r1',0,'f1')).toBe(false);
    expect(s.settleFresh(tok,'r1',{kind:'success'},null,0,'f1')).toBe(false);
    s.selectExperiment(2);
    expect(s.settleFresh(tok,'r1',{kind:'success'},null,1,'f1')).toBe(false);
    const tok2=s.beginFresh('r1',2,null);
    expect(s.settleFresh(tok2,'r1',{kind:'mismatch'},{sourceIdentical:true,reproduced:false,exactReproductionClaimed:false},2,null)).toBe(true);
    expect(s.freshReport).not.toBeNull();
    s.syncToRun('r1'); expect(s.fresh.kind).toBe('mismatch'); // same-run polling preserves
    s.syncToRun('r2'); expect(s.fresh.kind).toBe('idle'); expect(s.freshReport).toBeNull();
  });
});
