import { describe, expect, it } from 'vitest';
import {
  COVERAGE_EVALUATOR, adaptCreditEvidenceToScenarioCheck, buildCoveragePlan, prepareCoverage,
  projectCoverage, validateCoveragePlan,
  type CoverageContext, type CoverageExperimentInput, type CoverageFindingInput,
  type CoveragePreparationInput, type ScenarioCheckEvidence,
} from '../src/coverage/index.ts';
import { CREDIT_EVALUATOR } from '../src/coverage/catalog.ts';
import { getRequirementEvaluatorIdentity } from '../src/requirements/identity.ts';
import { evaluateRequirementRules } from '../src/requirements/evaluator.ts';
import type { ExperimentResult, SystemBriefSnapshot } from '../src/domain.ts';

const context: CoverageContext = {
  systemId: 'trading-gateway', revision: 3, snapshotHash: 'snap-1', adapterId: 'synthetic-trading',
  variant: 'candidate-a', sourceHash: 'source-1', contractHash: 'contract-1',
};
const reqText = 'Orders must not exceed credit limit';
const reqText2 = 'Reserved credit stays within the limit';
const preparation: CoveragePreparationInput = {
  context,
  requirements: [reqText, reqText2, 'Unrelated prose requirement'],
  requirementRules: [
    { requirement: reqText, preset: 'accepted-order-credit-limit', reviewed: true },
    { requirement: reqText2, preset: 'accepted-order-credit-limit', reviewed: true },
  ],
  contractRuleIds: ['credit_limit_respected'],
};
const plan = buildCoveragePlan({
  preparation,
  intentions: [{ scenarioId: 'accepted-order-credit-limit', reviewed: true, links: [{ kind: 'requirement-text', text: reqText }] }],
}).plan!;

function creditCheck(overrides: Partial<ScenarioCheckEvidence> = {}, facts: Record<string, unknown> = {}): ScenarioCheckEvidence {
  return {
    schemaVersion: 1, id: 'check-1', scenarioId: 'accepted-order-credit-limit', evaluator: COVERAGE_EVALUATOR,
    context, experimentIndex: 0, trigger: 'reached', outcome: 'passed',
    traceRefs: [{ traceIndex: 0, step: 1, tick: 10, messageId: 'm1' }],
    facts: {
      kind: 'credit-admission', requirement: reqText, requirementEvaluator: CREDIT_EVALUATOR, messageId: 'm1',
      payloadValid: true, deliveryStatus: 'accepted', usedCredit: 200, reservedCredit: 100, creditLimit: 500, ...facts,
    } as ScenarioCheckEvidence['facts'],
    detail: 'recorded', ...overrides,
  };
}
function experiment(checks: ScenarioCheckEvidence[], overrides: Partial<CoverageExperimentInput> = {}): CoverageExperimentInput {
  return { index: 0, valid: true, executionComplete: true, sourceHash: context.sourceHash, trace: [{ step: 1, time: 10, messageId: 'm1' }], checks, ...overrides };
}
function project(experiments: CoverageExperimentInput[], findings: CoverageFindingInput[] = [], p: unknown = plan) {
  return projectCoverage({ runId: 'run-1', plan: p, preparation, experiments, findings, stop: { status: 'completed' } });
}
const creditRow = (p: ReturnType<typeof project>) => p.rows.find(r => r.scenarioId === 'accepted-order-credit-limit')!;

describe('prepareCoverage / plan validation', () => {
  it('preserves every uniquely reviewed mapped credit requirement as a link', () => {
    const prep = prepareCoverage(preparation);
    expect(prep.suggestions).toHaveLength(1);
    expect(prep.suggestions[0].links).toEqual([
      { kind: 'requirement-text', text: reqText }, { kind: 'requirement-text', text: reqText2 }]);
    expect(prep.contextOnly).toEqual(['Unrelated prose requirement']);
  });
  it('no suggestion when unreviewed, duplicated, or on an unsupported adapter', () => {
    expect(prepareCoverage({ ...preparation, requirementRules: preparation.requirementRules!.map(r => ({ ...r, reviewed: false })) }).suggestions).toEqual([]);
    expect(prepareCoverage({ ...preparation, requirements: [reqText, reqText] }).suggestions).toEqual([]);
    const inv = prepareCoverage({ context: { ...context, adapterId: 'inventory-reservation' }, requirements: ['Reserve stock'], contractRuleIds: ['stock'] });
    expect(inv.suggestions).toEqual([]); expect(inv.contextOnly).toEqual(['Reserve stock']);
  });
  it('normalizes whitespace like the existing requirement semantics', () => {
    const prep = prepareCoverage({ ...preparation, requirements: [`  ${reqText.replace(' ', '  ')} `] });
    expect(prep.suggestions[0].links).toEqual([{ kind: 'requirement-text', text: reqText }]);
  });
  it('rejects reviewed=false/missing and never overwrites it to true', () => {
    const bad = buildCoveragePlan({ preparation, intentions: [{ scenarioId: 'accepted-order-credit-limit', reviewed: false, links: [{ kind: 'requirement-text', text: reqText }] } as never] });
    expect(bad.valid).toBe(false); expect(bad.plan).toBeUndefined();
  });
  it('rejects stale text, unknown identities and every pinned-context mismatch', () => {
    expect(buildCoveragePlan({ preparation, intentions: [{ scenarioId: 'accepted-order-credit-limit', reviewed: true, links: [{ kind: 'requirement-text', text: 'edited' }] }] }).valid).toBe(false);
    expect(validateCoveragePlan({ ...plan, catalog: { id: 'x', version: 1, hash: 'y' } }, preparation).valid).toBe(false);
    for (const change of [{ sourceHash: 'x' }, { revision: 9 }, { variant: 'clean' }, { snapshotHash: 'x' }, { contractHash: 'x' }, { adapterId: 'inventory-reservation' }, { systemId: 'x' }]) {
      expect(validateCoveragePlan({ ...plan, context: { ...plan.context, ...change } }, preparation).valid).toBe(false);
    }
  });
  it('empty intentions are a valid suggested/context-only plan; canonical plan does not alias input', () => {
    const empty = buildCoveragePlan({ preparation, intentions: [] });
    expect(empty.valid).toBe(true);
    const aliasCheck = validateCoveragePlan(plan, preparation);
    expect(aliasCheck.plan).not.toBe(plan); expect(aliasCheck.plan!.context).not.toBe(plan.context);
  });
  it('browser-safe credit evaluator identity matches the real requirement evaluator', () => {
    expect(CREDIT_EVALUATOR).toEqual(getRequirementEvaluatorIdentity());
  });
});

describe('projectCoverage statuses and evidence truth', () => {
  it('legacy without a plan; incompatible with a mismatched plan; malformed input never throws', () => {
    expect(projectCoverage({ runId: 'r', plan: undefined, preparation, experiments: [], findings: [], stop: { status: 'completed' } }).state).toBe('legacy');
    expect(projectCoverage({ runId: 'r', plan, preparation: { ...preparation, context: { ...context, revision: 4 } }, experiments: [], findings: [], stop: { status: 'completed' } }).state).toBe('incompatible');
    expect(project([experiment([null as never, creditCheck()])]).state).toBe('ready');
    expect(project([], [], { garbage: true }).state).toBe('incompatible');
  });
  it('suggested for unselected scenarios, unsupported for context-only prose, planned with zero checks', () => {
    const emptyPlan = buildCoveragePlan({ preparation, intentions: [] }).plan!;
    const suggested = project([], [], emptyPlan);
    expect(creditRow(suggested).status).toBe('suggested');
    const ready = project([]);
    expect(creditRow(ready).status).toBe('planned');
    expect(ready.rows.filter(r => r.status === 'unsupported').map(r => r.title)).toEqual(['Unrelated prose requirement']);
  });
  it('exercised only with reached trigger, exact trace refs and consistent credit facts', () => {
    expect(creditRow(project([experiment([creditCheck()])])).status).toBe('exercised');
  });
  it('inconclusive, never a pass, for weak or contradictory evidence', () => {
    const cases: [string, ScenarioCheckEvidence][] = [
      ['claimed pass over limit', creditCheck({}, { usedCredit: 400, reservedCredit: 200 })],
      ['missing reserved credit (no invented zero)', creditCheck({}, { reservedCredit: undefined })],
      ['negative credit', creditCheck({}, { usedCredit: -1 })],
      ['wrong trace step', creditCheck({ traceRefs: [{ traceIndex: 0, step: 99, tick: 10, messageId: 'm1' }] })],
      ['wrong trace tick', creditCheck({ traceRefs: [{ traceIndex: 0, step: 1, tick: 11, messageId: 'm1' }] })],
      ['unknown trigger', creditCheck({ trigger: 'unknown', outcome: 'inconclusive' })],
      ['coverage evaluator passed as credit evaluator', creditCheck({}, { requirementEvaluator: COVERAGE_EVALUATOR })],
      ['rejected delivery claiming reached', creditCheck({}, { deliveryStatus: 'rejected' })],
      ['failed outcome on passing facts', creditCheck({ outcome: 'failed' })],
      ['passing check carrying violationId', creditCheck({ violationId: 'v1' })],
      ['wrong context hash', creditCheck({ context: { ...context, sourceHash: 'other' } })],
      ['recovery facts for credit scenario', creditCheck({}, { kind: 'recovery' })],
    ];
    for (const [name, check] of cases) {
      expect(creditRow(project([experiment([check])])).status, name).toBe('inconclusive');
    }
    expect(creditRow(project([experiment([creditCheck(), creditCheck()])])).status).toBe('inconclusive'); // duplicate id
    expect(creditRow(project([experiment([creditCheck()], { executionComplete: undefined })])).status).toBe('inconclusive');
    expect(creditRow(project([experiment([creditCheck()], { sourceHash: 'other' })])).status).toBe('inconclusive');
  });
  it('invalid harness experiment produces an invalid row', () => {
    expect(creditRow(project([experiment([creditCheck()], { valid: false })])).status).toBe('invalid');
  });
  it('unreached trigger with consistent not-checked facts stays planned', () => {
    const unreached = creditCheck({ trigger: 'not-reached', outcome: 'not-checked' }, { deliveryStatus: 'rejected' });
    expect(creditRow(project([experiment([unreached])])).status).toBe('planned');
  });
  it('failed-unconfirmed until a unique matching finding passes both gates; then confirmed', () => {
    const failed = creditCheck({ outcome: 'failed', violationId: 'v-credit-1' }, { usedCredit: 500, reservedCredit: 100 });
    const exp = experiment([failed]);
    const finding = (over: Partial<CoverageFindingInput>): CoverageFindingInput => ({
      id: 'f1', experimentIndex: 0, sourceHash: context.sourceHash, violationId: 'v-credit-1',
      invariant: 'credit_limit_respected', reproduced: true, cleanControlPassed: true, ...over });
    expect(creditRow(project([exp])).status).toBe('failed-unconfirmed');
    expect(creditRow(project([exp], [finding({ reproduced: false })])).status).toBe('failed-unconfirmed');
    expect(creditRow(project([exp], [finding({ cleanControlPassed: false })])).status).toBe('failed-unconfirmed');
    expect(creditRow(project([exp], [finding({ invariant: 'other_invariant' })])).status).toBe('failed-unconfirmed');
    expect(creditRow(project([exp], [finding({ experimentIndex: 7 })])).status).toBe('failed-unconfirmed');
    const confirmed = project([exp], [finding({})]);
    expect(creditRow(confirmed).status).toBe('confirmed');
    expect(creditRow(confirmed).findingIds).toEqual(['f1']);
    // Explicit completed evidence survives whole-run cancellation.
    const cancelled = projectCoverage({ runId: 'r', plan, preparation, experiments: [exp], findings: [finding({})], stop: { status: 'cancelled', reason: 'budget' } });
    expect(creditRow(cancelled).status).toBe('confirmed');
    expect(cancelled.stop).toEqual({ status: 'cancelled', reason: 'budget' });
  });
});

describe('credit evidence adapter (real evaluator evidence)', () => {
  function genuineResult(overLimit: boolean): { result: ExperimentResult; snapshot: SystemBriefSnapshot } {
    const snapshot: SystemBriefSnapshot = {
      hash: context.snapshotHash, requirementEvaluator: getRequirementEvaluatorIdentity(),
      brief: { schemaVersion: 1, id: context.systemId, revision: context.revision, name: 'GW', overview: '', requirements: preparation.requirements as string[],
        requirementRules: [{ requirement: reqText, preset: 'accepted-order-credit-limit', reviewed: true }], adapterId: 'synthetic-trading', updatedAt: '2026-01-01T00:00:00Z' },
      contract: { name: 'c', description: '', operations: [], messages: [], invariants: [{ id: 'credit_limit_respected', description: '' }], limits: {} },
    };
    const result: ExperimentResult = {
      schemaVersion: 1, experiment: { hypothesis: 'h', expectedInvariant: 'credit_limit_respected', steps: [{ op: 'deliver', messageId: 'm1' }] },
      sourceHash: context.sourceHash, valid: true, executionComplete: true, snapshot: {}, violations: [], rejections: [],
      trace: [{ step: 0, time: 10, action: 'deliver', messageId: 'm1', outcome: 'ok', state: {} },
        { step: 1, time: 12, action: 'deliver', messageId: 'm2', outcome: 'ok', state: {} }],
      deliveryObservations: [
        { traceIndex: 0, step: 0, action: 'deliver', messageId: 'm1', channel: 'client', messageType: 'new_order', payloadValid: true, status: 'accepted',
          usedCredit: overLimit ? 500 : 200, reservedCredit: 100, creditLimit: 500 },
        { traceIndex: 1, step: 1, action: 'deliver', messageId: 'm2', channel: 'client', messageType: 'new_order', payloadValid: true, status: 'accepted',
          usedCredit: 10, reservedCredit: 0, creditLimit: 500 },
      ],
    };
    return { result, snapshot };
  }
  it('adapts event-level evidence per delivery with distinct ids; aggregate failure is not copied', () => {
    const { result, snapshot } = genuineResult(true);
    const [rule] = evaluateRequirementRules(result, snapshot, 0);
    expect(rule.status).toBe('failed'); // one delivery over the limit
    const checks = result.deliveryObservations!.map(delivery =>
      adaptCreditEvidenceToScenarioCheck({ context, experimentIndex: 0, snapshot, result, ruleResult: rule, delivery }));
    expect(checks[0]?.outcome).toBe('failed');
    expect(checks[1]?.outcome).toBe('passed');
    expect(checks[0]?.id).not.toBe(checks[1]?.id);
    const projected = project([experiment(checks.filter((c): c is ScenarioCheckEvidence => c !== null).map(c => ({ ...c, traceRefs: c.traceRefs })),
      { trace: [{ step: 0, time: 10, messageId: 'm1' }, { step: 1, time: 12, messageId: 'm2' }] })]);
    expect(creditRow(projected).status).toBe('failed-unconfirmed');
  });
  it('rejects tampered evaluator, snapshot, channel and trace mismatches', () => {
    const { result, snapshot } = genuineResult(false);
    const [rule] = evaluateRequirementRules(result, snapshot, 0);
    const delivery = result.deliveryObservations![0];
    const base = { context, experimentIndex: 0, snapshot, result, ruleResult: rule, delivery };
    expect(adaptCreditEvidenceToScenarioCheck(base)?.outcome).toBe('passed');
    expect(adaptCreditEvidenceToScenarioCheck({ ...base, ruleResult: { ...rule, evaluator: COVERAGE_EVALUATOR } })).toBeNull();
    expect(adaptCreditEvidenceToScenarioCheck({ ...base, snapshot: { ...snapshot, hash: 'other' } })).toBeNull();
    expect(adaptCreditEvidenceToScenarioCheck({ ...base, delivery: { ...delivery, channel: 'market' } })).toBeNull();
    expect(adaptCreditEvidenceToScenarioCheck({ ...base, delivery: { ...delivery, messageId: 'nope' } })).toBeNull();
    expect(adaptCreditEvidenceToScenarioCheck({ ...base, context: { ...context, sourceHash: 'other' } })).toBeNull();
  });
  it('preserves a genuine client exception as unknown-trigger inconclusive evidence (R-07)', () => {
    const { result, snapshot } = genuineResult(false);
    result.deliveryObservations = [{ ...result.deliveryObservations![0], status: 'exception', reason: 'Target exception: boom' }];
    result.trace = [result.trace[0]];
    const [rule] = evaluateRequirementRules(result, snapshot, 0);
    expect(rule.evidence.some(e => e.status === 'inconclusive')).toBe(true); // actual evaluator output
    const check = adaptCreditEvidenceToScenarioCheck({ context, experimentIndex: 0, snapshot, result, ruleResult: rule, delivery: result.deliveryObservations[0] });
    expect(check).not.toBeNull();
    expect(check!.trigger).toBe('unknown');
    expect(check!.outcome).toBe('inconclusive');
    expect(check!.violationId).toBeUndefined();
    expect((check!.facts as { deliveryStatus: string }).deliveryStatus).toBe('exception');
    expect(creditRow(project([experiment([check!])])).status).toBe('inconclusive');
    // Market-channel exception is not a valid client new_order exception.
    expect(adaptCreditEvidenceToScenarioCheck({ context, experimentIndex: 0, snapshot, result, ruleResult: rule,
      delivery: { ...result.deliveryObservations[0], channel: 'market' } })).toBeNull();
  });
});

describe('unreadable scenario evidence (R-03)', () => {
  it('null, non-object, missing-ID and unknown-scenario entries warn and cannot pass or appear unexercised', () => {
    for (const corrupt of [null, 'garbage', { id: 'x' }, { ...creditCheck(), id: 'u1', scenarioId: 'invented-scenario' }] as unknown[]) {
      const p = project([experiment([corrupt] as never)]);
      expect(creditRow(p).status).toBe('inconclusive');
      expect(p.warnings.some(w => w.includes('Unreadable scenario check evidence'))).toBe(true);
    }
    for (const checks of [null, 'not-a-list', 42] as unknown[]) {
      const p = project([experiment(checks as never)]);
      expect(creditRow(p).status).toBe('inconclusive');
      expect(p.warnings.length).toBeGreaterThan(0);
    }
  });
  it('corruption beside a pass downgrades it; beside a confirmed finding the verdict stays with warnings', () => {
    const besidePass = project([experiment([creditCheck(), null] as never)]);
    expect(creditRow(besidePass).status).toBe('inconclusive');
    const failed = creditCheck({ id: 'f-check', outcome: 'failed', violationId: 'v-1' }, { usedCredit: 500, reservedCredit: 100 });
    const finding: CoverageFindingInput = { id: 'f1', experimentIndex: 0, sourceHash: context.sourceHash, violationId: 'v-1', invariant: 'credit_limit_respected', reproduced: true, cleanControlPassed: true };
    const besideConfirmed = project([experiment([failed, null] as never)], [finding]);
    expect(creditRow(besideConfirmed).status).toBe('confirmed');
    expect(besideConfirmed.warnings.length).toBeGreaterThan(0);
    const besideFailed = project([experiment([failed, null] as never)]);
    expect(creditRow(besideFailed).status).toBe('failed-unconfirmed');
  });
  it('genuinely empty or absent evidence remains planned with no warnings; suggested/context-only keep status beside corruption', () => {
    expect(creditRow(project([experiment([])])).status).toBe('planned');
    expect(project([experiment([])]).warnings).toEqual([]);
    expect(creditRow(project([{ ...experiment([]), checks: undefined as never }])).status).toBe('planned');
    const emptyPlan = buildCoveragePlan({ preparation, intentions: [] }).plan!;
    const p = project([experiment([null] as never)], [], emptyPlan);
    expect(creditRow(p).status).toBe('suggested');
    expect(p.warnings.length).toBeGreaterThan(0);
    expect(p.rows.find(r => r.scenarioId === null)?.status).toBe('unsupported');
  });
});
