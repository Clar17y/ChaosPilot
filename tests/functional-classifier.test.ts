import { describe, expect, it, vi, afterEach } from 'vitest';
import { resolveAdapter } from '../src/adapters/index.ts';
import { createSystemSnapshot, SEEDED_TRADING_BRIEF } from '../src/systems/index.ts';
import { FUNCTIONAL_CATALOG } from '../src/functional/catalog.ts';
import { evaluateFunctionalScenario } from '../src/functional/evaluator.ts';
import { runFunctionalBaselines } from '../src/functional/runner.ts';
import * as rules from '../src/requirements/evaluator.ts';
import type { ExperimentResult } from '../src/domain.ts';

const adapter = resolveAdapter('synthetic-trading');
const fresh = (index = 0) => adapter.executeExperiment(adapter.parseExperiment(FUNCTIONAL_CATALOG[index]!.buildExperiment()), 'clean');
const evaluate = async (result: ExperimentResult, index = 0) => evaluateFunctionalScenario(FUNCTIONAL_CATALOG[index]!, result, await createSystemSnapshot(SEEDED_TRADING_BRIEF));
afterEach(() => vi.restoreAllMocks());

describe('functional evidence binding against actual adapter evidence', () => {
  it('verifies all clean milestones, including setup acceptance and explicit credit/quantities', async () => {
    const evaluated = await evaluate(fresh());
    expect(evaluated.status).toBe('pass');
    expect(evaluated.assertions.every(a => a.status === 'pass')).toBe(true);
    expect(evaluated.expectedMilestones.map(m => m.credit)).toEqual([
      { reservedCredit: 40, usedCredit: 0 }, { reservedCredit: 20, usedCredit: 20 },
      { reservedCredit: 20, usedCredit: 20 }, { reservedCredit: 0, usedCredit: 20 },
    ]);
  });
  const incomplete: [string, (r: ExperimentResult) => void][] = [
    ['different source', r => { r.sourceHash = 'other'; }],
    ['empty experiment', r => { r.experiment.steps = []; }],
    ['changed command payload', r => { (r.experiment.steps[4] as any).payload.quantity = 99; }],
    ['trace message mismatch', r => { r.trace[5]!.messageId = 'other'; }],
    ['trace payload mismatch', r => { (r.trace[5]!.payload as any).quantity = 9; }],
    ['send payload mismatch', r => { (r.trace[4]!.payload as any).quantity = 9; }],
    ['trace action mismatch', r => { r.trace[5]!.action = 'send'; }],
    ['observation index out of bounds', r => { r.deliveryObservations![2]!.traceIndex = 999; }],
    ['observation wrong step', r => { r.deliveryObservations![2]!.step = 7; }],
    ['observation wrong action', r => { r.deliveryObservations![2]!.action = 'drain:deliver'; }],
    ['missing observation', r => { r.deliveryObservations!.splice(2, 1); }],
    ['missing all observations', r => { delete r.deliveryObservations; }],
    ['missing trace step', r => { r.trace.splice(5, 1); }],
    ['duplicate trace', r => { r.trace.push(structuredClone(r.trace[5]!)); }],
    ['duplicate delivery', r => { r.deliveryObservations!.push(structuredClone(r.deliveryObservations![2]!)); }],
    ['incomplete execution', r => { r.executionComplete = false; }],
    ['unrecorded completion', r => { delete r.executionComplete; }],
    ['target exception', r => { r.deliveryObservations![2]!.status = 'exception'; }],
    ['invalid payload', r => { r.deliveryObservations![2]!.payloadValid = false; }],
    ['missing credit limit', r => { delete r.trace[5]!.state.credit; }],
    ['missing orders', r => { delete r.trace[5]!.state.orders; }],
    ['invalid orders array', r => { r.trace[5]!.state.orders = []; }],
    ['non-numeric state', r => { r.trace[5]!.state.reservedCredit = '40'; }],
    ['missing oracle collection', r => { delete (r as any).violations; }],
  ];
  it.each(incomplete)('never passes %s', async (_, mutate) => {
    const r = fresh(); mutate(r);
    expect((await evaluate(r)).status).toBe('inconclusive');
  });
  it.each(['payloadValid', 'channel', 'messageType', 'status'] as const)('expected rejection cannot pass with wrong %s', async field => {
    const r = fresh(2); const o = r.deliveryObservations!.at(-1)!;
    if (field === 'payloadValid') o.payloadValid = false;
    else if (field === 'channel') o.channel = 'reports';
    else if (field === 'messageType') o.messageType = 'cancel_ack';
    else (o as any).status = 'invented';
    expect((await evaluate(r, 2)).status).toBe('inconclusive');
  });
  it.each(['OPEN', 'FILLED', 'CANCELLED'])('rejected order present as %s is a failure', async status => {
    const r = fresh(2);
    (r.trace[5]!.state.orders as any)['ord-baseline-excess'] = { status, remainingQuantity: 0, filledQuantity: 0, cancelledQuantity: 4, cancellationRequested: true, price: 10 };
    expect((await evaluate(r, 2)).status).toBe('fail');
  });
  it('rejection cannot mutate the credit configuration', async () => {
    const r = fresh(1); (r.trace[9]!.state.credit as any).limit = 500;
    expect((await evaluate(r, 1)).status).toBe('fail');
  });
  it('rejection must preserve the existing filled order and limit', async () => {
    const r = fresh(1); (r.trace[9]!.state.orders as any)['ord-baseline-a'].filledQuantity = 1;
    expect((await evaluate(r, 1)).assertions.find(a => a.id.endsWith('.unchanged'))?.status).toBe('fail');
  });
  it('completed contradictory credit or lifecycle is failure', async () => {
    for (const field of ['reservedCredit', 'orders']) {
      const r = fresh();
      if (field === 'reservedCredit') r.trace[5]!.state.reservedCredit = 30;
      else (r.trace[5]!.state.orders as any)['ord-baseline-1'].status = 'CANCELLED';
      expect((await evaluate(r)).status).toBe('fail');
    }
  });
  it('invalid harness command differs from a valid expected business rejection', async () => {
    expect((await evaluate(fresh(2), 2)).status).toBe('pass');
    const r = fresh(2); r.valid = false; r.rejections = [{ step: 5, reason: 'Message not found in scheduler' }];
    expect((await evaluate(r, 2)).status).toBe('invalid');
  });
  it('oracle violations prevent pass', async () => {
    const r = fresh(); r.violations.push({ id: 'v', invariant: 'credit', message: 'broken', step: 5, evidence: {} });
    expect((await evaluate(r)).status).toBe('fail');
  });
  it('runner preserves explicit incomplete executor evidence', async () => {
    const execute = adapter.executeExperiment;
    vi.spyOn(adapter, 'executeExperiment').mockImplementation((...args) => ({ ...execute(...args), executionComplete: false }));
    const record = await runFunctionalBaselines({ variant: 'clean', systemSnapshot: await createSystemSnapshot(SEEDED_TRADING_BRIEF) });
    expect(record.status).toBe('inconclusive');
    expect(record.scenarios.every(s => s.executionComplete === false)).toBe(true);
  });
  it('configured failed, missing-context and exception outcomes remain visible', async () => {
    const snapshot = await createSystemSnapshot({ ...SEEDED_TRADING_BRIEF, requirementRules: [{
      requirement: 'Total commitments include both used and reserved credit. New order admission respects the current limit.',
      preset: 'accepted-order-credit-limit', reviewed: true,
    }] });
    const r = fresh(); r.deliveryObservations![2]!.creditLimit = 10;
    expect(evaluateFunctionalScenario(FUNCTIONAL_CATALOG[0]!, r, snapshot).status).toBe('fail');
    delete snapshot.requirementEvaluator;
    const missing = evaluateFunctionalScenario(FUNCTIONAL_CATALOG[0]!, fresh(), snapshot);
    expect(missing.status).toBe('inconclusive'); expect(missing.requirementEvaluationError).toContain('identity');
    vi.spyOn(rules, 'evaluateRequirementRules').mockImplementation(() => { throw new Error('evaluator crashed'); });
    const exception = evaluateFunctionalScenario(FUNCTIONAL_CATALOG[0]!, fresh(), snapshot);
    expect(exception.status).toBe('inconclusive'); expect(exception.requirementEvaluationError).toBe('evaluator crashed');
  });
});
