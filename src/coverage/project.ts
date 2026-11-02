import { COVERAGE_EVALUATOR } from './identity.ts';
import { amount, CREDIT_EVALUATOR, isRecord, linkKey, normalize, sameContext, sameIdentity, text } from './catalog.ts';
import { prepareCoverage } from './prepare.ts';
import { validateCoveragePlan } from './plan.ts';
import type { CoverageExperimentInput, CoverageFindingInput, CoveragePlan, CoverageProjection, CoverageProjectionInput, CoverageRecoveryFacts, CoverageRow, CoverageStatus, RecoveryAccountingFacts, ScenarioCheckEvidence } from './types.ts';

type Result = { status: CoverageStatus; reason: string; findingId?: string };
const inconclusive = (reason: string): Result => ({ status: 'inconclusive', reason });
function accounting(v: unknown): v is RecoveryAccountingFacts {
  return isRecord(v) && ['filledQuantity', 'remainingQuantity', 'usedCredit', 'reservedCredit', 'applicationCount'].every(k => amount(v[k]))
    && Number.isSafeInteger(Number(v.filledQuantity) + Number(v.remainingQuantity))
    && Number.isSafeInteger(Number(v.usedCredit) + Number(v.reservedCredit));
}
function recoveryTruth(f: CoverageRecoveryFacts, retry: boolean): boolean | null {
  if (![f.reportId, f.executionId, f.orderId].every(text) || !amount(f.acceptedAtTick) || !amount(f.horizonTick)
    || f.horizonTick < f.acceptedAtTick || typeof f.acceptedDuringDisconnection !== 'boolean') return null;
  if (f.acceptedDuringDisconnection !== true) return null;
  if (!amount(f.reconnectTick) || f.reconnectTick < f.acceptedAtTick || !amount(f.deadlineTick)
    || !Number.isSafeInteger(f.reconnectTick + 5) || f.deadlineTick !== f.reconnectTick + 5 || f.horizonTick < f.reconnectTick) return null;
  if (!accounting(f.expected) || f.expected.applicationCount !== 1 || !accounting(f.observed)) return null;
  if (f.completionTick !== undefined && (!amount(f.completionTick) || f.completionTick < f.reconnectTick || f.completionTick > f.horizonTick)) return null;
  if (retry && f.retryObserved !== true) return null;
  const matches = (Object.keys(f.expected) as (keyof RecoveryAccountingFacts)[])
    .filter(k => ['filledQuantity', 'remainingQuantity', 'usedCredit', 'reservedCredit', 'applicationCount'].includes(k))
    .every(k => f.expected[k] === f.observed![k]);
  if (retry) return matches;
  if (f.completionTick !== undefined) return matches && f.completionTick <= f.deadlineTick;
  // Lost backlog has no completion tick. The inclusive deadline is checked
  // after processing everything due at that horizon. Reconciled accounting
  // without a recorded completion tick is ambiguous, not a failed check.
  return f.horizonTick >= f.deadlineTick ? (matches ? null : false) : null;
}
function evaluate(check: ScenarioCheckEvidence, experiment: CoverageExperimentInput, plan: CoveragePlan,
  findings: readonly CoverageFindingInput[], duplicate: boolean, ambiguousExperiment: boolean): Result {
  if (ambiguousExperiment || !amount(experiment.index) || !amount(check.experimentIndex) || check.experimentIndex !== experiment.index)
    return inconclusive('Missing, duplicate or mismatched experiment identity');
  if (check.schemaVersion !== 1 || !text(check.id) || duplicate || typeof check.detail !== 'string')
    return inconclusive('Malformed or duplicate check identity');
  if (!sameIdentity(check.evaluator, COVERAGE_EVALUATOR) || !sameContext(check.context, plan.context) || experiment.sourceHash !== plan.context.sourceHash)
    return inconclusive('Check evaluator, pinned context or experiment source mismatch');
  if (experiment.valid === false) return { status: 'invalid', reason: 'Harness experiment is invalid' };
  if (experiment.valid !== true || typeof experiment.executionComplete !== 'boolean') return inconclusive('Experiment validity or execution completion was not recorded');
  if (!['reached', 'not-reached', 'unknown'].includes(check.trigger) || !['passed', 'failed', 'not-checked', 'inconclusive'].includes(check.outcome))
    return inconclusive('Unknown trigger or outcome');
  if (!isRecord(check.facts) || (check.scenarioId === 'accepted-order-credit-limit' ? check.facts.kind !== 'credit-admission' : check.facts.kind !== 'recovery'))
    return inconclusive('Scenario and observed facts family mismatch');
  if (check.trigger === 'unknown') return inconclusive('Trigger could not be established');
  if (check.trigger === 'not-reached') {
    const unreached = check.facts.kind === 'credit-admission' ? check.facts.deliveryStatus === 'rejected'
      : check.facts.acceptedDuringDisconnection === false || check.scenarioId === 'recovery-retry-idempotence' && check.facts.retryObserved === false;
    return unreached && check.outcome === 'not-checked' ? { status: 'planned', reason: 'The scenario trigger was not reached' } : inconclusive('Unreached claim conflicts with recorded facts');
  }
  if (!Array.isArray(check.traceRefs) || !check.traceRefs.length || !Array.isArray(experiment.trace))
    return inconclusive('Missing exact trace references');
  for (const ref of check.traceRefs) {
    if (!isRecord(ref) || !amount(ref.traceIndex) || !amount(ref.step) || !amount(ref.tick)
      || (ref.messageId !== undefined && !text(ref.messageId))) return inconclusive('Malformed trace reference');
    const entry = experiment.trace[ref.traceIndex];
    if (!entry || entry.step !== ref.step || entry.time !== ref.tick
      || (ref.messageId !== undefined && entry.messageId !== ref.messageId))
      return inconclusive('Trace reference does not match its indexed step, simulated tick and message');
  }
  let passed: boolean | null = null;
  if (check.facts.kind === 'credit-admission') {
    const f = check.facts;
    const intention = plan.intentions.find(i => i.scenarioId === check.scenarioId);
    if (!text(f.requirement) || !intention?.links.some(l => linkKey(l) === linkKey({ kind: 'requirement-text', text: normalize(f.requirement) }))
      || !sameIdentity(f.requirementEvaluator, CREDIT_EVALUATOR) || !text(f.messageId) || f.payloadValid !== true || f.deliveryStatus !== 'accepted'
      || !check.traceRefs.some(r => r.messageId === f.messageId)) return inconclusive('Original reviewed credit rule or actual accepted delivery is missing');
    if (amount(f.usedCredit) && amount(f.reservedCredit) && amount(f.creditLimit) && Number.isSafeInteger(f.usedCredit + f.reservedCredit))
      passed = f.usedCredit + f.reservedCredit <= f.creditLimit;
  } else {
    const f = check.facts;
    if (check.scenarioId === 'recovery-retry-idempotence' && f.retryObserved === false && check.outcome === 'not-checked')
      return { status: 'planned', reason: 'No actual retry was observed' };
    const recordedTicks = new Set(check.traceRefs.map(ref => ref.tick));
    if (!recordedTicks.has(f.horizonTick) || (f.completionTick !== undefined && !recordedTicks.has(f.completionTick)))
      return inconclusive('Recovery horizon or completion has no matching recorded trace reference');
    passed = recoveryTruth(f, check.scenarioId === 'recovery-retry-idempotence');
  }
  if (passed === null || check.outcome === 'not-checked' || check.outcome === 'inconclusive')
    return inconclusive('Required observations or a completed applicable check are missing');
  if ((check.outcome === 'passed') !== passed) return inconclusive('Contradictory check facts and claimed outcome');
  if (passed) return check.violationId === undefined ? { status: 'exercised', reason: 'Reached trigger and recorded facts satisfy the applicable check' }
    : inconclusive('Passing check carries a contradictory violation identity');
  const compatible = check.scenarioId === 'accepted-order-credit-limit' ? ['credit_limit_respected']
    : check.scenarioId === 'recovery-by-deadline' ? ['recovery_deadline'] : ['recovery_deadline', 'recovery_retry_idempotence'];
  const matches = findings.filter(f => isRecord(f) && text(f.id) && text(check.violationId) && f.violationId === check.violationId
    && f.experimentIndex === check.experimentIndex && f.sourceHash === plan.context.sourceHash && compatible.includes(f.invariant)
    && f.reproduced === true && f.cleanControlPassed === true);
  const finding = matches.length === 1 ? matches[0] : undefined;
  if (finding && findings.filter(f => f?.id === finding.id).length === 1)
    return { status: 'confirmed', reason: 'Failed check matches a saved reproduced finding with a passing clean control', findingId: finding.id };
  return { status: 'failed-unconfirmed', reason: 'Recorded check failed; no unique matching finding passed both replay and clean control' };
}
const priority: Record<CoverageStatus, number> = { suggested: 0, unsupported: 0, planned: 1, exercised: 2, invalid: 3, inconclusive: 4, 'failed-unconfirmed': 5, confirmed: 6 };
export function projectCoverage(input: CoverageProjectionInput): CoverageProjection {
  const base: CoverageProjection = { runId: input?.runId, state: 'incompatible', context: null, stop: input?.stop, rows: [], warnings: [] };
  if (input?.plan === undefined || input?.plan === null) return { ...base, state: 'legacy', warnings: ['Legacy investigation record: no coverage plan was pinned at launch.'] };
  const validation = validateCoveragePlan(input.plan, input.preparation!);
  if (!validation.valid || !validation.plan) return { ...base, warnings: validation.errors };
  const plan = validation.plan;
  const preparation = prepareCoverage(input.preparation!);
  const experiments = Array.isArray(input.experiments) ? input.experiments : [];
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const rows: CoverageRow[] = preparation.suggestions.map(suggestion => {
    const intention = plan.intentions.find(i => i.scenarioId === suggestion.scenarioId);
    const row: CoverageRow = { scenarioId: suggestion.scenarioId, title: suggestion.title, links: structuredClone(intention?.links ?? suggestion.links),
      status: intention ? 'planned' : 'suggested', reason: intention ? 'Reviewed intention; no reached check recorded' : 'Suggested scenario was not selected for this run',
      evidence: [], experimentIndices: [], findingIds: [] };
    if (!intention) return row;
    for (const experiment of experiments) {
      if (!experiment || !Array.isArray(experiment.checks)) continue;
      for (const raw of experiment.checks) {
        if (!isRecord(raw) || raw.scenarioId !== intention.scenarioId) continue;
        const check = raw as unknown as ScenarioCheckEvidence;
        const result = evaluate(check, experiment, plan, findings, experiment.checks.filter((c: ScenarioCheckEvidence) => c?.id === check.id).length !== 1,
          experiments.filter(e => e?.index === experiment.index).length !== 1);
        if (priority[result.status] >= priority[row.status]) { row.status = result.status; row.reason = result.reason; }
        // Only well-shaped data goes to the evidence renderer; malformed checks
        // still produce an inconclusive row, never an exception or a pass.
        if (isRecord(check.facts) && Array.isArray(check.traceRefs) && check.traceRefs.every(isRecord)) row.evidence.push(structuredClone(check));
        if (amount(experiment.index)) row.experimentIndices.push(experiment.index);
        if (result.findingId) row.findingIds.push(result.findingId);
      }
    }
    row.experimentIndices = [...new Set(row.experimentIndices)];
    row.findingIds = [...new Set(row.findingIds)];
    return row;
  });
  rows.push(...preparation.contextOnly.map(requirement => ({ scenarioId: null, title: requirement, links: [{ kind: 'requirement-text' as const, text: requirement }],
    status: 'unsupported' as const, reason: 'Context-only requirement; no reviewed executable mapping', evidence: [], experimentIndices: [], findingIds: [] })));
  return { ...base, state: 'ready', context: { ...plan.context }, rows };
}
