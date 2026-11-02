import { describe, expect, it } from 'vitest';
import {
  COVERAGE_EVALUATOR, RECOVERY_ADAPTER_ID, buildCoveragePlan, prepareCoverage, projectCoverage,
  type CoverageContext, type CoverageExperimentInput, type CoverageFindingInput,
  type CoveragePreparationInput, type CoverageRecoveryFacts, type ScenarioCheckEvidence,
} from '../src/coverage/index.ts';

const context: CoverageContext = {
  systemId: 'recovery-gateway', revision: 1, snapshotHash: 'snap-r', adapterId: RECOVERY_ADAPTER_ID,
  variant: 'candidate-a', sourceHash: 'source-r', contractHash: 'contract-r',
};
const preparation: CoveragePreparationInput = {
  context, requirements: ['Target must recover after disconnect'], contractRuleIds: ['recovery_deadline'],
};
const plan = buildCoveragePlan({
  preparation,
  intentions: [
    { scenarioId: 'recovery-by-deadline', reviewed: true, links: [{ kind: 'contract-rule', ruleId: 'recovery_deadline' }] },
    { scenarioId: 'recovery-retry-idempotence', reviewed: true, links: [{ kind: 'contract-rule', ruleId: 'recovery_deadline' }] },
  ],
}).plan!;
const accounting = { filledQuantity: 10, remainingQuantity: 0, usedCredit: 1000, reservedCredit: 0, applicationCount: 1 };
const trace = [5, 10, 13, 14, 15, 16, 20].map((time, step) => ({ step, time }));
function facts(over: Partial<CoverageRecoveryFacts> = {}): CoverageRecoveryFacts {
  return {
    kind: 'recovery', reportId: 'rep-1', executionId: 'exec-1', orderId: 'ord-1', acceptedAtTick: 5,
    acceptedDuringDisconnection: true, reconnectTick: 10, deadlineTick: 15, horizonTick: 20, completionTick: 14,
    expected: { ...accounting }, observed: { ...accounting }, ...over,
  };
}
function check(scenarioId: ScenarioCheckEvidence['scenarioId'], f: CoverageRecoveryFacts, over: Partial<ScenarioCheckEvidence> = {}): ScenarioCheckEvidence {
  return {
    schemaVersion: 1, id: `check-${scenarioId}`, scenarioId, evaluator: COVERAGE_EVALUATOR, context,
    experimentIndex: 0, trigger: 'reached', outcome: 'passed',
    traceRefs: trace.flatMap((entry, traceIndex) => [f.acceptedAtTick, f.reconnectTick, f.horizonTick, f.completionTick].includes(entry.time)
      ? [{ traceIndex, step: entry.step, tick: entry.time }] : []),
    facts: f, detail: 'recorded', ...over,
  };
}
function project(checks: ScenarioCheckEvidence[], findings: CoverageFindingInput[] = [], stop: { status: 'completed' | 'cancelled'; reason?: string } = { status: 'completed' }, executionComplete = true) {
  const exp: CoverageExperimentInput = { index: 0, valid: true, executionComplete, sourceHash: context.sourceHash, trace, checks };
  return projectCoverage({ runId: 'rec-1', plan, preparation, experiments: [exp], findings, stop });
}
const row = (p: ReturnType<typeof project>, id: string) => p.rows.find(r => r.scenarioId === id)!;

describe('recovery preparation', () => {
  it('both intentions link the recovery_deadline obligation; retry prefers an explicit retry rule', () => {
    const prep = prepareCoverage(preparation);
    expect(prep.suggestions.map(s => s.links)).toEqual([
      [{ kind: 'contract-rule', ruleId: 'recovery_deadline' }], [{ kind: 'contract-rule', ruleId: 'recovery_deadline' }]]);
    const withRetry = prepareCoverage({ ...preparation, contractRuleIds: ['recovery_deadline', 'recovery_retry_idempotence'] });
    expect(withRetry.suggestions[1].links).toEqual([{ kind: 'contract-rule', ruleId: 'recovery_retry_idempotence' }]);
    // The public execution_idempotency rule, when the contract actually has it,
    // wins over the legacy fallbacks.
    const withExecution = prepareCoverage({ ...preparation, contractRuleIds: ['recovery_deadline', 'recovery_retry_idempotence', 'execution_idempotency'] });
    expect(withExecution.suggestions[1].links).toEqual([{ kind: 'contract-rule', ruleId: 'execution_idempotency' }]);
    const executionOnly = prepareCoverage({ ...preparation, contractRuleIds: ['execution_idempotency'] });
    expect(executionOnly.suggestions.map(s => s.scenarioId)).toEqual(['recovery-retry-idempotence']);
    expect(prepareCoverage({ ...preparation, contractRuleIds: ['some_retry_thing'] }).suggestions).toEqual([]);
    expect(prep.contextOnly).toEqual(preparation.requirements);
  });
});

describe('recovery deadline transitions', () => {
  it('exercised on on-time completion, including completion before the horizon reaches the deadline and at r+5', () => {
    expect(row(project([check('recovery-by-deadline', facts())]), 'recovery-by-deadline').status).toBe('exercised');
    expect(row(project([check('recovery-by-deadline', facts({ horizonTick: 14 }))]), 'recovery-by-deadline').status).toBe('exercised');
    expect(row(project([check('recovery-by-deadline', facts({ completionTick: 15 }))]), 'recovery-by-deadline').status).toBe('exercised');
  });
  it('lost backlog: horizon at/after deadline, unreconciled accounting, no completion => failed, confirmable', () => {
    const lost = check('recovery-by-deadline',
      facts({ completionTick: undefined, horizonTick: 15, observed: { ...accounting, filledQuantity: 0, remainingQuantity: 10, applicationCount: 0 } }),
      { outcome: 'failed', violationId: 'v-lost' });
    expect(row(project([lost]), 'recovery-by-deadline').status).toBe('failed-unconfirmed');
    const finding: CoverageFindingInput = { id: 'f-lost', experimentIndex: 0, sourceHash: context.sourceHash, violationId: 'v-lost', invariant: 'recovery_deadline', reproduced: true, cleanControlPassed: true };
    const confirmed = project([lost], [finding]);
    expect(row(confirmed, 'recovery-by-deadline').status).toBe('confirmed');
    expect(row(confirmed, 'recovery-by-deadline').findingIds).toEqual(['f-lost']);
  });
  it('late completion stays failed; reconciled accounting without a completion tick is inconclusive', () => {
    expect(row(project([check('recovery-by-deadline', facts({ completionTick: 16 }), { outcome: 'failed' })]), 'recovery-by-deadline').status).toBe('failed-unconfirmed');
    expect(row(project([check('recovery-by-deadline', facts({ completionTick: undefined }))]), 'recovery-by-deadline').status).toBe('inconclusive');
  });
  it('does not count a claimed horizon or completion without its recorded trace reference', () => {
    const completed = check('recovery-by-deadline', facts());
    for (const missingTick of [14, 20]) {
      const unreferenced = { ...completed, traceRefs: completed.traceRefs.filter(ref => ref.tick !== missingTick) };
      expect(row(project([unreferenced]), 'recovery-by-deadline').status).toBe('inconclusive');
    }
    const lost = check('recovery-by-deadline', facts({ completionTick: undefined, horizonTick: 15,
      observed: { ...accounting, applicationCount: 0 } }), { outcome: 'failed', violationId: 'v-unobserved' });
    lost.traceRefs = lost.traceRefs.filter(ref => ref.tick !== 15);
    const finding: CoverageFindingInput = { id: 'f-unobserved', experimentIndex: 0, sourceHash: context.sourceHash,
      violationId: 'v-unobserved', invariant: 'recovery_deadline', reproduced: true, cleanControlPassed: true };
    expect(row(project([lost], [finding]), 'recovery-by-deadline').status).toBe('inconclusive');
  });
  it('cancellation preserves unexercised intentions and unresolved pre-deadline checks', () => {
    const stop = { status: 'cancelled' as const, reason: 'User stopped investigation' };
    expect(row(project([], [], stop, false), 'recovery-by-deadline').status).toBe('planned');
    const pending = check('recovery-by-deadline', facts({ completionTick: undefined, horizonTick: 13,
      observed: { ...accounting, applicationCount: 0 } }), { outcome: 'inconclusive' });
    const partial = project([pending], [], stop, false);
    expect(row(partial, 'recovery-by-deadline').status).toBe('inconclusive');
    expect(row(partial, 'recovery-retry-idempotence').status).toBe('planned');
    expect(partial.stop).toEqual(stop);
  });
  it('inconclusive for no reconnect, unresolved before horizon, missing observations, wrong deadline, not-accepted-during-disconnect', () => {
    const cases = [
      facts({ reconnectTick: undefined, deadlineTick: undefined }),
      facts({ completionTick: undefined, horizonTick: 13, observed: { ...accounting, applicationCount: 0 } }),
      facts({ observed: undefined }),
      facts({ deadlineTick: 16 }),
      facts({ acceptedDuringDisconnection: false }),
      facts({ completionTick: 21 }),
      facts({ expected: { ...accounting, applicationCount: 2 } }),
    ];
    for (const f of cases) expect(row(project([check('recovery-by-deadline', f)]), 'recovery-by-deadline').status).toBe('inconclusive');
  });
  it('retry intention stays planned without an actual retry; exercised/failed on observed exactly-once accounting', () => {
    const deadlineOnly = project([check('recovery-by-deadline', facts())]);
    expect(row(deadlineOnly, 'recovery-retry-idempotence').status).toBe('planned');
    const noRetry = check('recovery-retry-idempotence', facts({ retryObserved: false }), { trigger: 'not-reached', outcome: 'not-checked' });
    expect(row(project([noRetry]), 'recovery-retry-idempotence').status).toBe('planned');
    const unchanged = { status: 'passed' as const, before: { ...accounting }, after: { ...accounting } };
    expect(row(project([check('recovery-retry-idempotence', facts({ retryObserved: true, retryCheck: unchanged }))]), 'recovery-retry-idempotence').status).toBe('exercised');
    const double = check('recovery-retry-idempotence', facts({ retryObserved: true, observed: { ...accounting, applicationCount: 2 },
      retryCheck: { status: 'failed', before: { ...accounting }, after: { ...accounting, applicationCount: 2 } } }), { outcome: 'failed' });
    expect(row(project([double]), 'recovery-retry-idempotence').status).toBe('failed-unconfirmed');
  });
  it('requires real retry before/after facts and preserves a mutation even when final accounting matches', () => {
    const missing = check('recovery-retry-idempotence', facts({ retryObserved: true }));
    expect(row(project([missing]), 'recovery-retry-idempotence').status).toBe('inconclusive');
    const changed = check('recovery-retry-idempotence', facts({ retryObserved: true,
      retryCheck: { status: 'failed', before: { ...accounting }, after: { ...accounting, filledQuantity: 11 } } }), { outcome: 'failed', violationId: 'v-retry' });
    const finding = { id: 'f-retry', experimentIndex: 0, sourceHash: context.sourceHash, violationId: 'v-retry', invariant: 'execution_idempotency', reproduced: true, cleanControlPassed: true };
    expect(row(project([changed], [finding]), 'recovery-retry-idempotence').status).toBe('confirmed');
    changed.facts = { ...changed.facts, retryCheck: { status: 'failed', before: accounting, after: accounting } } as CoverageRecoveryFacts;
    expect(row(project([changed], [finding]), 'recovery-retry-idempotence').status).toBe('inconclusive');
  });
  it('credits a connected retry against independent expected accounting without inventing reconnect or deadline facts', () => {
    const connectedFacts = (over: Partial<CoverageRecoveryFacts> = {}): CoverageRecoveryFacts => facts({
      acceptedDuringDisconnection: false, reconnectTick: undefined, deadlineTick: undefined,
      completionTick: undefined, horizonTick: 10, retryObserved: true,
      retryCheck: { status: 'passed', before: { ...accounting }, after: { ...accounting }, expected: { ...accounting } },
      ...over,
    });
    expect(row(project([check('recovery-retry-idempotence', connectedFacts())]), 'recovery-retry-idempotence').status).toBe('exercised');
    // The retry scenario never credits the deadline row for a connected acceptance.
    expect(row(project([check('recovery-by-deadline', connectedFacts())]), 'recovery-by-deadline').status).toBe('inconclusive');

    const mutated = check('recovery-retry-idempotence', connectedFacts({
      observed: { ...accounting, applicationCount: 2 },
      retryCheck: { status: 'failed', before: { ...accounting }, after: { ...accounting, applicationCount: 2 }, expected: { ...accounting } },
    }), { outcome: 'failed', violationId: 'v-connected-retry' });
    expect(row(project([mutated]), 'recovery-retry-idempotence').status).toBe('failed-unconfirmed');
    const finding: CoverageFindingInput = { id: 'f-connected-retry', experimentIndex: 0, sourceHash: context.sourceHash,
      violationId: 'v-connected-retry', invariant: 'execution_idempotency', reproduced: true, cleanControlPassed: true };
    expect(row(project([mutated], [finding]), 'recovery-retry-idempotence').status).toBe('confirmed');
    // Confirmation still needs both replay reproduction and a passing clean control.
    expect(row(project([mutated], [{ ...finding, cleanControlPassed: false }]), 'recovery-retry-idempotence').status).toBe('failed-unconfirmed');

    // Unchanged before/after facts that never matched independent expectations do not pass.
    const unreconciled = { filledQuantity: 0, remainingQuantity: 10, usedCredit: 0, reservedCredit: 1000, applicationCount: 0 };
    const notApplied = check('recovery-retry-idempotence', connectedFacts({
      observed: { ...unreconciled },
      retryCheck: { status: 'passed', before: { ...unreconciled }, after: { ...unreconciled }, expected: { ...accounting } },
    }));
    expect(row(project([notApplied]), 'recovery-retry-idempotence').status).toBe('inconclusive');
    // And a connected retry with no independent expected accounting is unproved.
    const noExpected = check('recovery-retry-idempotence', connectedFacts({
      retryCheck: { status: 'passed', before: { ...accounting }, after: { ...accounting } },
    }));
    expect(row(project([noExpected]), 'recovery-retry-idempotence').status).toBe('inconclusive');
  });
  it('keeps disconnected retries inconclusive before reconnect while preserving actual mutations as failures', () => {
    const pendingFacts = (over: Partial<CoverageRecoveryFacts> = {}): CoverageRecoveryFacts => facts({
      reconnectTick: undefined, deadlineTick: undefined, completionTick: undefined, horizonTick: 10,
      observed: { filledQuantity: 0, remainingQuantity: 10, usedCredit: 0, reservedCredit: 1000, applicationCount: 0 },
      retryObserved: true, ...over,
    });
    const zero = { filledQuantity: 0, remainingQuantity: 10, usedCredit: 0, reservedCredit: 1000, applicationCount: 0 };
    const cleanPending = check('recovery-retry-idempotence', pendingFacts({
      retryCheck: { status: 'passed', before: { ...zero }, after: { ...zero }, expected: { ...accounting } },
    }), { outcome: 'inconclusive' });
    expect(row(project([cleanPending]), 'recovery-retry-idempotence').status).toBe('inconclusive');
    const mutatedPending = check('recovery-retry-idempotence', pendingFacts({
      retryCheck: { status: 'failed', before: { ...zero }, after: { ...zero, filledQuantity: 4, remainingQuantity: 6 }, expected: { ...accounting } },
    }), { outcome: 'failed' });
    expect(row(project([mutatedPending]), 'recovery-retry-idempotence').status).toBe('failed-unconfirmed');
  });
  it('early stop preserves confirmed deadline evidence and the pending retry intention, with stop reason', () => {
    const failed = check('recovery-by-deadline', facts({ observed: { ...accounting, applicationCount: 2 } }), { outcome: 'failed', violationId: 'v-early' });
    const finding: CoverageFindingInput = { id: 'f-early', experimentIndex: 0, sourceHash: context.sourceHash, violationId: 'v-early', invariant: 'recovery_deadline', reproduced: true, cleanControlPassed: true };
    const p = project([failed], [finding], { status: 'cancelled', reason: 'Stopped after first verified finding' }, false);
    expect(row(p, 'recovery-by-deadline').status).toBe('confirmed');
    expect(row(p, 'recovery-retry-idempotence').status).toBe('planned');
    expect(p.stop).toEqual({ status: 'cancelled', reason: 'Stopped after first verified finding' });
  });
});
