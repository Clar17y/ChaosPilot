import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ExperimentRecord, Finding, InvestigationRecord, TraceEntry } from '../src/domain.ts';
import {
  buildReproductionModel,
  buildTraceSteps,
  classifyStep,
  creditBarLayout,
  creditFromState,
  describeFreshReplay,
  explainStep,
  isCreditAdmissionViolation,
  PlaybackController,
  resolveExperimentPosition,
  type PlaybackTimers,
} from '../src/web/reproduction-player.ts';

function state(limit: number | null, reserved: number, used: number): Record<string, unknown> {
  return {
    quote: { id: 'q1', version: 1, price: 1 },
    credit: limit === null ? null : { version: 1, limit },
    reservedCredit: reserved,
    usedCredit: used,
    orders: {},
  };
}

/** Real-shaped trace for the verified credit-admission scenario: limit 100,
 * first order 100 fills (used 100), second order 100 admitted (reserved 100, total 200). */
function creditTrace(): TraceEntry[] {
  return [
    { step: 0, time: 0, action: 'send', messageId: 'm-q', payload: { type: 'quote', id: 'q1', version: 1, price: 1 }, outcome: 'scheduled', state: state(null, 0, 0) },
    { step: 1, time: 0, action: 'send', messageId: 'm-c', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 100 }, outcome: 'scheduled', state: state(null, 0, 0) },
    { step: 2, time: 0, action: 'drain:deliver', messageId: 'm-q', payload: { type: 'quote', id: 'q1', version: 1, price: 1 }, outcome: 'delivered:processed', state: state(null, 0, 0) },
    { step: 2, time: 0, action: 'drain:deliver', messageId: 'm-c', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 100 }, outcome: 'delivered:processed', state: state(100, 0, 0) },
    // Scheduled send for the second order shares action-index space with later deliveries.
    { step: 5, time: 0, action: 'send', messageId: 'm-o2', payload: { type: 'new_order', id: 'o2', orderId: 'ord-2', quantity: 100, quoteId: 'q1' }, outcome: 'scheduled', state: state(100, 0, 100) },
    { step: 6, time: 0, action: 'fill', messageId: 'm-f1', payload: { type: 'execution', id: 'm-f1', orderId: 'ord-1', executionId: 'e1', quantity: 100, price: 1 }, outcome: 'venue_fill_scheduled', state: state(100, 100, 0) },
    { step: 7, time: 0, action: 'drain:deliver', messageId: 'm-f1', payload: { type: 'execution', id: 'm-f1', orderId: 'ord-1', executionId: 'e1', quantity: 100, price: 1 }, outcome: 'delivered:processed', state: state(100, 0, 100) },
    { step: 8, time: 0, action: 'drain:deliver', messageId: 'm-o2', payload: { type: 'new_order', id: 'o2', orderId: 'ord-2', quantity: 100, quoteId: 'q1' }, outcome: 'delivered:processed', state: state(100, 100, 100) },
    // Another processed entry at the same action index, for a different order.
    { step: 8, time: 0, action: 'drain:deliver', messageId: 'm-o3', payload: { type: 'new_order', id: 'o3', orderId: 'ord-3', quantity: 1, quoteId: 'q1' }, outcome: 'delivered:processed', state: state(100, 100, 100) },
  ];
}

function recordWith(trace: TraceEntry[], overrides: Partial<ExperimentRecord> = {}): InvestigationRecord {
  const expRec: ExperimentRecord = {
    index: 1,
    experiment: { hypothesis: 'credit admission', expectedInvariant: 'credit_limit_respected', steps: [] },
    result: {
      schemaVersion: 1,
      experiment: { hypothesis: 'credit admission', expectedInvariant: 'credit_limit_respected', steps: [] },
      sourceHash: 'src1',
      trace,
      snapshot: { target: state(100, 100, 100) },
      violations: [{
        id: 'v1', invariant: 'credit_limit_respected', step: 8, orderId: 'ord-2',
        message: 'Order ord-2 admitted exceeding credit limit: required exposure 200 exceeds limit 100',
        evidence: { orderId: 'ord-2', limit: 100, previousExposure: 100, orderNotional: 100, totalRequired: 200 },
      }],
      rejections: [],
      valid: true,
    },
    replayVerified: true,
    cleanControlPassed: true,
    ...overrides,
  };
  return {
    schemaVersion: 1, id: 'run-1', provider: 'mock', model: 'scripted-offline', mode: 'mock',
    variant: 'candidate-a', status: 'completed', startedAt: '2026-01-01T00:00:00Z',
    sourceHash: 'src1', experiments: [expRec], findings: [], usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    errors: [], contextAudit: { sourcePaths: [], contractHash: 'h', promptVersion: '1' },
  } as InvestigationRecord;
}

const finding: Finding = {
  id: 'f1', title: 'Violation of credit_limit_respected', hypothesis: 'credit admission',
  experimentIndex: 1,
  violation: {
    id: 'v1', invariant: 'credit_limit_respected', step: 8, orderId: 'ord-2',
    message: 'Order ord-2 admitted exceeding credit limit: required exposure 200 exceeds limit 100',
    evidence: { orderId: 'ord-2', limit: 100, previousExposure: 100, orderNotional: 100, totalRequired: 200 },
  },
  sourceHash: 'src1', reproduced: true, cleanControlPassed: true,
  replay: { hypothesis: 'credit admission', expectedInvariant: 'credit_limit_respected', steps: [] },
};

describe('recorded trace derivation', () => {
  it('uses trace-array position as identity when entries share an action index', () => {
    const model = buildReproductionModel(recordWith(creditTrace()), 0, finding)!;
    expect(model.steps).toHaveLength(9);
    expect(model.steps.map(s => s.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const shared = model.steps.filter(s => s.actionIndex === 8);
    expect(shared.map(s => s.position)).toEqual([7, 8]);
  });

  it('shows four evidence-backed key events for an unambiguous credit-admission story', () => {
    const trace: TraceEntry[] = [
      { step: 0, time: 0, action: 'deliver', payload: { type: 'quote', id: 'q1', price: 1 }, outcome: 'delivered:processed', state: state(null, 0, 0) },
      { step: 1, time: 0, action: 'deliver', payload: { type: 'credit_limit', id: 'c1', limit: 100 }, outcome: 'delivered:processed', state: state(100, 0, 0) },
      { step: 2, time: 0, action: 'deliver', payload: { type: 'new_order', orderId: 'ord-1', quantity: 100 }, outcome: 'delivered:processed', state: state(100, 100, 0) },
      { step: 3, time: 0, action: 'deliver', payload: { type: 'execution', orderId: 'ord-1', quantity: 100 }, outcome: 'delivered:processed', state: state(100, 0, 100) },
      { step: 8, time: 0, action: 'deliver', payload: { type: 'new_order', orderId: 'ord-2', quantity: 100 }, outcome: 'delivered:processed', state: state(100, 100, 100) },
    ];
    const model = buildReproductionModel(recordWith(trace), 0, finding)!;
    expect(model.sequence).toBe('key-events');
    expect(model.steps.map(step => step.tracePosition)).toEqual([1, 2, 3, 4]);
    expect(model.steps.map(step => step.position)).toEqual([0, 1, 2, 3]);
    expect(model.steps[3]!.isViolation).toBe(true);
    expect(model.steps[3]!.credit?.total).toBe(200);

    const otherFinding = { ...finding, violation: { ...finding.violation, invariant: 'no_overfill' } };
    expect(buildReproductionModel(recordWith(trace), 0, otherFinding)!.sequence).toBe('trace');

    const earlierViolation = recordWith(trace);
    earlierViolation.experiments[0]!.result.violations.push({ id: 'early', invariant: 'version_monotonicity', step: 0, message: 'Quote regressed', evidence: {} });
    expect(buildReproductionModel(earlierViolation, 0, finding)!.sequence).toBe('trace');

    const extra = { ...trace[0]!, step: 7 };
    const complex = buildReproductionModel(recordWith([...trace.slice(0, 4), extra, trace[4]!]), 0, finding)!;
    expect(complex.sequence).toBe('trace');
    expect(complex.steps).toHaveLength(6);

    const rejected = { ...trace[0]!, step: 7, outcome: 'delivered:rejected (invalid quote)' };
    const withRejection = buildReproductionModel(recordWith([...trace.slice(0, 4), rejected, trace[4]!]), 0, finding)!;
    expect(withRejection.sequence).toBe('trace');
    expect(withRejection.steps[4]!.kind).toBe('rejected');
  });

  it('selects the actual credit-limit entry when credit arrives before the quote', () => {
    const trace: TraceEntry[] = [
      { step: 0, time: 0, action: 'deliver', payload: { type: 'credit_limit', id: 'c1', limit: 100 }, outcome: 'delivered:processed', state: state(100, 0, 0) },
      { step: 1, time: 0, action: 'deliver', payload: { type: 'quote', id: 'q1', price: 1 }, outcome: 'delivered:processed', state: state(100, 0, 0) },
      { step: 2, time: 0, action: 'deliver', payload: { type: 'new_order', orderId: 'ord-1', quantity: 100 }, outcome: 'delivered:processed', state: state(100, 100, 0) },
      { step: 3, time: 0, action: 'deliver', payload: { type: 'execution', orderId: 'ord-1', quantity: 100 }, outcome: 'delivered:processed', state: state(100, 0, 100) },
      { step: 8, time: 0, action: 'deliver', payload: { type: 'new_order', orderId: 'ord-2', quantity: 100 }, outcome: 'delivered:processed', state: state(100, 100, 100) },
    ];
    const model = buildReproductionModel(recordWith(trace), 0, finding)!;
    expect(model.sequence).toBe('key-events');
    // First key event is the credit entry itself (trace position 0), not the quote at 1.
    expect(model.steps.map(step => step.tracePosition)).toEqual([0, 2, 3, 4]);
    expect(model.steps[0]!.title).toBe('Credit limit set: 100');
  });

  it('falls back to the full trace when the credit entry lacks the recorded limit', () => {
    const trace: TraceEntry[] = [
      { step: 0, time: 0, action: 'deliver', payload: { type: 'credit_limit', id: 'c1', limit: 100 }, outcome: 'delivered:processed', state: state(null, 0, 0) },
      { step: 1, time: 0, action: 'deliver', payload: { type: 'quote', id: 'q1', price: 1 }, outcome: 'delivered:processed', state: state(100, 0, 0) },
      { step: 2, time: 0, action: 'deliver', payload: { type: 'new_order', orderId: 'ord-1', quantity: 100 }, outcome: 'delivered:processed', state: state(100, 100, 0) },
      { step: 3, time: 0, action: 'deliver', payload: { type: 'execution', orderId: 'ord-1', quantity: 100 }, outcome: 'delivered:processed', state: state(100, 0, 100) },
      { step: 8, time: 0, action: 'deliver', payload: { type: 'new_order', orderId: 'ord-2', quantity: 100 }, outcome: 'delivered:processed', state: state(100, 100, 100) },
    ];
    const model = buildReproductionModel(recordWith(trace), 0, finding)!;
    expect(model.sequence).toBe('trace');
    expect(model.steps).toHaveLength(5);
  });

  it('describes a re-fired state violation as recorded at the action, not caused by it', () => {
    const trace: TraceEntry[] = [
      { step: 2, time: 0, action: 'deliver', payload: { type: 'new_order', orderId: 'ord-1', quantity: 10 }, outcome: 'delivered:processed', state: state(100, 0, 0) },
      { step: 5, time: 0, action: 'deliver', payload: { type: 'quote', id: 'q1', price: 1 }, outcome: 'delivered:processed', state: state(100, 0, 0) },
    ];
    const rec = recordWith(trace);
    // Same whole-state invariant recorded at two different actions, as the oracle re-fires it.
    rec.experiments[0]!.result.violations = [
      { id: 's1', invariant: 'credit_exposure_consistency', step: 2, message: 'Reserved credit does not match', evidence: {} },
      { id: 's2', invariant: 'credit_exposure_consistency', step: 5, message: 'Reserved credit does not match', evidence: {} },
    ];
    const model = buildReproductionModel(rec, 0, null)!;
    expect(model.steps.map(s => s.isViolation)).toEqual([true, true]);
    const explanation = explainStep(model.steps[1]!, model.steps[1]!.violations);
    expect(explanation.observed).toContain('recorded at this action');
    expect(explanation.observed).not.toContain('violated at this entry');
    expect(explanation.observed).not.toMatch(/caused/i);
  });

  it('labels a legacy experiment without a recorded index as not recorded, never undefined', () => {
    const rec = recordWith(creditTrace());
    delete (rec.experiments[0] as { index?: number }).index;
    const model = buildReproductionModel(rec, 0, null)!;
    expect(model.experimentLabel).toContain('not recorded');
    expect(model.experimentLabel).not.toContain('undefined');
  });

  it('uses the recorded events from the authentic saved demo finding', () => {
    const report = JSON.parse(readFileSync(new URL('../examples/controlled-v2/bench_heldout_v2_20261026.json', import.meta.url), 'utf8')) as {
      arms: Record<string, { trials: { record?: InvestigationRecord }[] }>;
    };
    const rec = Object.values(report.arms).flatMap(arm => arm.trials.map(trial => trial.record))
      .find(run => run?.id === 'run_bench_1793054622627_3fe2ce');
    expect(rec).toBeDefined();
    const model = buildReproductionModel(rec!, 0, rec!.findings[0]!)!;
    expect(model.sequence).toBe('key-events');
    expect(model.steps.map(step => step.tracePosition)).toEqual([3, 5, 7, 9]);
    expect(model.steps[3]!.actionIndex).toBe(8);
    expect(model.steps[3]!.credit?.total).toBe(200);
    expect(model.steps[3]!.isViolation).toBe(true);
  });

  it('distinguishes scheduled events from processed transitions', () => {
    expect(classifyStep(creditTrace()[0]!)).toBe('scheduled');
    expect(classifyStep(creditTrace()[5]!)).toBe('scheduled'); // venue_fill_scheduled: not yet used credit
    expect(classifyStep(creditTrace()[6]!)).toBe('processed');
    const model = buildReproductionModel(recordWith(creditTrace()), 0, finding)!;
    expect(model.steps[5]!.kindLabel).toContain('not yet processed');
    expect(model.steps[6]!.title).toContain('fill processed');
  });

  it('attributes the violation only to the processed entry for that order', () => {
    const model = buildReproductionModel(recordWith(creditTrace()), 0, finding)!;
    const flagged = model.steps.filter(s => s.isViolation);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.position).toBe(7);
    expect(model.steps[4]!.isViolation).toBe(false); // scheduled send
    expect(model.steps[8]!.isViolation).toBe(false); // same action index, different order
    expect(model.unattributedViolations).toHaveLength(0);
  });

  it('does not attribute a violation to multiple deliveries sharing an action index', () => {
    const trace: TraceEntry[] = [
      { step: 2, time: 0, action: 'drain:deliver', payload: { type: 'quote', id: 'q1', price: 10 }, outcome: 'delivered:processed', state: state(100, 0, 0) },
      { step: 2, time: 0, action: 'drain:deliver', payload: { type: 'credit_limit', id: 'c1', limit: 100 }, outcome: 'delivered:processed', state: state(100, 0, 0) },
    ];
    const rec = recordWith(trace);
    rec.experiments[0]!.result.violations = [{ id: 'ambiguous', invariant: 'version_monotonicity', step: 2, message: 'Version regressed', evidence: {} }];
    const model = buildReproductionModel(rec, 0, null)!;
    expect(model.steps.every(step => !step.isViolation)).toBe(true);
    expect(model.unattributedViolations.map(v => v.id)).toEqual(['ambiguous']);
  });

  it('keeps repeated deliveries for the same order unattributed when either could have failed', () => {
    const trace: TraceEntry[] = [
      { step: 3, time: 0, action: 'drain:deliver', payload: { type: 'execution', orderId: 'ord-1' }, outcome: 'delivered:processed', state: state(100, 0, 10) },
      { step: 3, time: 0, action: 'drain:deliver', payload: { type: 'execution', orderId: 'ord-1' }, outcome: 'delivered:processed', state: state(100, 0, 20) },
    ];
    const rec = recordWith(trace);
    rec.experiments[0]!.result.violations = [{ id: 'same-order', invariant: 'execution_idempotency', step: 3, orderId: 'ord-1', message: 'Duplicate mutated state', evidence: {} }];
    const model = buildReproductionModel(rec, 0, null)!;
    expect(model.steps.every(step => !step.isViolation)).toBe(true);
    expect(model.unattributedViolations.map(v => v.id)).toEqual(['same-order']);
  });

  it('does not mistake a message id for the affected order id', () => {
    const trace: TraceEntry[] = [
      { step: 2, time: 0, action: 'deliver', payload: { type: 'execution', id: 'ord-1' }, outcome: 'delivered:processed', state: state(100, 0, 0) },
    ];
    const rec = recordWith(trace);
    rec.experiments[0]!.result.violations = [{ id: 'unlinked', invariant: 'execution_idempotency', step: 2, orderId: 'ord-1', message: 'Duplicate mutated state', evidence: {} }];
    const model = buildReproductionModel(rec, 0, null)!;
    expect(model.steps[0]!.isViolation).toBe(false);
    expect(model.unattributedViolations.map(v => v.id)).toEqual(['unlinked']);
  });

  it('derives 100/100/200-style credit figures from recorded state', () => {
    const model = buildReproductionModel(recordWith(creditTrace()), 0, finding)!;
    const last = model.steps[7]!;
    expect(last.credit).toEqual({ limit: 100, used: 100, reserved: 100, total: 200, totalExceedsLimit: true });
  });

  it('scales the credit bar against the larger of exposure and limit', () => {
    expect(creditBarLayout(creditFromState(state(100, 100, 100)))).toEqual({ used: 50, reserved: 50, limit: 50 });
    expect(creditBarLayout(creditFromState(state(200, 50, 50)))).toEqual({ used: 25, reserved: 25, limit: 100 });
    expect(creditBarLayout(creditFromState(state(null, 50, 50)))).toEqual({ used: 50, reserved: 50, limit: null });
    expect(creditBarLayout(creditFromState(state(100, -50, 100)))).toBeNull();
    expect(creditBarLayout(creditFromState(state(100, 0, 0)))).toBeNull();
  });

  it('labels the expected outcome hypothetically and the observed violation as an error', () => {
    const model = buildReproductionModel(recordWith(creditTrace()), 0, finding)!;
    const step = model.steps[7]!;
    const explanation = explainStep(step, step.violations);
    expect(explanation.expectedLabel).toContain('would satisfy the rule');
    expect(explanation.expected).not.toMatch(/recorded pass|passed/i);
    expect(explanation.observed).toMatch(/^Error: rule violation recorded at this action/);
    expect(explanation.observedIsViolation).toBe(true);
    expect(isCreditAdmissionViolation(finding.violation)).toBe(true);
  });

  it('does not infer a violation from exposure over a reduced limit alone', () => {
    const trace: TraceEntry[] = [
      { step: 0, time: 0, action: 'drain:deliver', messageId: 'm-c2', payload: { type: 'credit_limit', id: 'c2', version: 2, limit: 50 }, outcome: 'delivered:processed', state: state(50, 0, 100) },
    ];
    const rec = recordWith(trace);
    rec.experiments[0]!.result.violations = [];
    const model = buildReproductionModel(rec, 0, null)!;
    expect(model.steps[0]!.credit!.totalExceedsLimit).toBe(true);
    expect(model.steps[0]!.isViolation).toBe(false);
    const explanation = explainStep(model.steps[0]!, []);
    expect(explanation.observedIsViolation).toBe(false);
    expect(explanation.observed).not.toMatch(/violated/i);
  });

  it('treats a correct recorded rejection as neither a pass nor a defect', () => {
    const trace: TraceEntry[] = [
      { step: 0, time: 0, action: 'deliver', messageId: 'm-o', payload: { type: 'new_order', id: 'o9', orderId: 'ord-9', quantity: 500, quoteId: 'q1' }, outcome: 'delivered:rejected (credit limit)', state: state(100, 0, 0) },
    ];
    const rec = recordWith(trace);
    rec.experiments[0]!.result.violations = [];
    const model = buildReproductionModel(rec, 0, null)!;
    expect(model.steps[0]!.isViolation).toBe(false);
    const explanation = explainStep(model.steps[0]!, model.steps[0]!.violations);
    expect(explanation.observed).toContain('not a recorded pass');
  });

  it('reports missing state and missing trace truthfully', () => {
    const rec = recordWith([]);
    const model = buildReproductionModel(rec, 0, null)!;
    expect(model.hasTrace).toBe(false);
    expect(creditFromState(undefined)).toBeNull();
    expect(creditFromState({})).toBeNull();
    const noState: TraceEntry[] = [{ step: 0, time: 0, action: 'send', outcome: 'scheduled', state: undefined as unknown as Record<string, unknown> }];
    const m2 = buildReproductionModel(recordWith(noState), 0, null)!;
    expect(m2.steps[0]!.credit).toBeNull();
    expect(m2.steps[0]!.stateText).toBe('not recorded');
  });

  it('marks invalid experiments as not target defects and keeps legacy brief wording', () => {
    const rec = recordWith(creditTrace());
    rec.experiments[0]!.result.valid = false;
    rec.experiments[0]!.result.rejections = [{ step: 0, reason: 'bad plan' }];
    const model = buildReproductionModel(rec, 0, null)!;
    expect(model.invalidLabel).toContain('not, by itself, a target defect');
    expect(model.briefLabel).toContain('Legacy brief unavailable');
    expect(model.replayLabel).toContain('verified');
    expect(model.cleanLabel).toContain('not a claim of complete correctness');
  });

  it('does not describe a running investigation as a saved run', () => {
    const rec = recordWith(creditTrace());
    rec.status = 'running';
    const model = buildReproductionModel(rec, 0, null)!;
    expect(model.replayLabel).toContain('during the investigation');
    expect(model.replayLabel).not.toContain('saved');
  });

  it('resolves a finding to its experiment by recorded index', () => {
    const rec = recordWith(creditTrace());
    expect(resolveExperimentPosition(rec, finding)).toBe(0);
  });

  it('uses one-based legacy positions only when explicit experiment indices are absent', () => {
    const rec = recordWith(creditTrace());
    const second = structuredClone(rec.experiments[0]!);
    second.index = 2;
    rec.experiments.push(second);
    const missing = { ...finding, experimentIndex: 3 };
    expect(resolveExperimentPosition(rec, missing)).toBe(-1);
    for (const experiment of rec.experiments) delete (experiment as { index?: number }).index;
    expect(resolveExperimentPosition(rec, finding)).toBe(0);
    expect(resolveExperimentPosition(rec, { ...finding, experimentIndex: 2 })).toBe(1);
  });

  it('keeps untrusted payload text as inert text', () => {
    const trace: TraceEntry[] = [
      { step: 0, time: 0, action: 'send', messageId: 'x', payload: { type: 'new_order', note: '<img src=x onerror=alert(1)>' }, outcome: 'scheduled', state: state(100, 0, 0) },
    ];
    const model = buildReproductionModel(recordWith(trace), 0, null)!;
    expect(model.steps[0]!.payloadText).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('shared trace-step attribution', () => {
  it('keeps multiple violations in recorded order and unmatched checks unattributed, including an empty trace', () => {
    const rec = recordWith(creditTrace());
    rec.experiments[0]!.result.violations = [
      { id: 'first-at-pos', invariant: 'credit_limit_respected', step: 8, orderId: 'ord-2', message: 'first', evidence: { limit: 100, totalRequired: 200 } },
      { id: 'second-at-pos', invariant: 'no_overfill', step: 8, orderId: 'ord-2', message: 'second', evidence: {} },
      { id: 'no-match', invariant: 'version_monotonicity', step: 42, message: 'none', evidence: {} },
    ];
    const model = buildReproductionModel(rec, 0, null)!;
    expect(model.allSteps[7]!.violations.map(v => v.id)).toEqual(['first-at-pos', 'second-at-pos']);
    expect(model.unattributedViolations.map(v => v.id)).toEqual(['no-match']);
    const empty = buildTraceSteps(creditTrace(), []);
    expect(empty.steps.every(s => !s.isViolation)).toBe(true);
    expect(empty.unattributedViolations).toEqual([]);
    expect(buildTraceSteps([], rec.experiments[0]!.result.violations).unattributedViolations.map(v => v.id))
      .toEqual(['first-at-pos', 'second-at-pos', 'no-match']);
  });
});

describe('fresh replay wording', () => {
  it('never claims a new replay from a historical result and separates pending/success/mismatch/error', () => {
    expect(describeFreshReplay({ kind: 'idle' })).toContain('not a new replay');
    expect(describeFreshReplay({ kind: 'pending' })).toContain('does not contact the model');
    expect(describeFreshReplay({ kind: 'pending' })).toContain('does not rerun the clean comparison');
    expect(describeFreshReplay({ kind: 'success' })).toContain('not been overwritten');
    expect(describeFreshReplay({ kind: 'mismatch' })).toContain('mismatch');
    expect(describeFreshReplay({ kind: 'error', message: 'HTTP 500' })).toContain('HTTP 500');
  });
});

describe('playback controller', () => {
  function fakeTimers() {
    let fn: (() => void) | null = null;
    let cleared = 0;
    const timers: PlaybackTimers = {
      set: (f) => { fn = f; return 1; },
      clear: () => { cleared++; fn = null; },
    };
    return { timers, tick: () => fn?.(), clearedCount: () => cleared, hasTimer: () => fn !== null };
  }

  it('starts before the first entry with no fabricated state, and steps previous/next/reset', () => {
    const c = new PlaybackController(3);
    expect(c.position).toBe(-1);
    c.next(); expect(c.position).toBe(0);
    c.next(); expect(c.position).toBe(1);
    c.previous(); expect(c.position).toBe(0);
    c.previous(); expect(c.position).toBe(-1);
    c.next(); c.reset(); expect(c.position).toBe(-1);
  });

  it('handles no trace', () => {
    const c = new PlaybackController(0);
    c.next(); expect(c.position).toBe(-1);
    c.play(); expect(c.playing).toBe(false);
  });

  it('plays with the injected timer, stops at the end, and stops on selection change', () => {
    const fake = fakeTimers();
    const c = new PlaybackController(2, () => {}, fake.timers, 10);
    c.play();
    expect(c.playing).toBe(true);
    fake.tick(); expect(c.position).toBe(0);
    fake.tick(); expect(c.position).toBe(1);
    expect(c.playing).toBe(false);
    expect(fake.hasTimer()).toBe(false);
    c.play(); // restarts from before first entry
    expect(fake.hasTimer()).toBe(true);
    c.setCount(5); // selection/experiment change
    expect(c.playing).toBe(false);
    expect(c.position).toBe(-1);
    expect(fake.hasTimer()).toBe(false);
    c.play(); c.dispose();
    expect(fake.hasTimer()).toBe(false);
  });
});
