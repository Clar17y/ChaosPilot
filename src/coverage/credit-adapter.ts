import type { DeliveryObservation, ExperimentResult, RequirementRuleResult, SystemBriefSnapshot } from '../domain.ts';
import { COVERAGE_EVALUATOR } from './identity.ts';
import { allowedLinks, amount, CREDIT_EVALUATOR, linkKey, sameIdentity, validContext, validPreparation } from './catalog.ts';
import type { CoverageContext, ScenarioCheckEvidence } from './types.ts';

/** Execution-time adapter only. Never call this to infer checks on record reopen.
 * Original rule failures remain separate from independent oracle findings. */
export function adaptCreditEvidenceToScenarioCheck(params: {
  context: CoverageContext;
  experimentIndex: number;
  snapshot: SystemBriefSnapshot;
  result: ExperimentResult;
  ruleResult: RequirementRuleResult;
  delivery: DeliveryObservation;
  violationId?: string;
}): ScenarioCheckEvidence | null {
  const { context, experimentIndex, snapshot, result, ruleResult: rule, delivery: d } = params;
  if (!validContext(context) || context.adapterId !== 'synthetic-trading' || !amount(experimentIndex) || !snapshot?.brief || !result || !rule || !d) return null;
  const preparation = { context, requirements: snapshot.brief.requirements, requirementRules: snapshot.brief.requirementRules,
    contractRuleIds: snapshot.contract?.invariants.map(i => i.id) ?? [] };
  if (!validPreparation(preparation) || snapshot.hash !== context.snapshotHash || snapshot.brief.id !== context.systemId
    || snapshot.brief.revision !== context.revision || snapshot.brief.adapterId !== context.adapterId
    || !sameIdentity(snapshot.requirementEvaluator, CREDIT_EVALUATOR) || !sameIdentity(rule.evaluator, CREDIT_EVALUATOR)
    || rule.sourceHash !== context.sourceHash || result.sourceHash !== context.sourceHash || rule.snapshotHash !== snapshot.hash
    || rule.experimentIndex !== experimentIndex || rule.preset !== 'accepted-order-credit-limit'
    || !allowedLinks(preparation, 'accepted-order-credit-limit').some(l => linkKey(l) === linkKey({ kind: 'requirement-text', text: rule.requirement }))
    || result.valid !== true || typeof result.executionComplete !== 'boolean') return null;
  if (!Array.isArray(result.deliveryObservations) || !amount(d.traceIndex) || !amount(d.step)
    || result.deliveryObservations.filter(o => o.traceIndex === d.traceIndex).length !== 1
    || !result.deliveryObservations.some(o => JSON.stringify(o) === JSON.stringify(d))
    || !['deliver', 'drain:deliver'].includes(d.action) || d.channel !== 'client' || d.messageType !== 'new_order'
    || d.payloadValid !== true || !['accepted', 'rejected', 'exception'].includes(d.status)) return null;
  const t = result.trace?.[d.traceIndex];
  if (!t || t.step !== d.step || t.messageId !== d.messageId || t.action !== d.action || !amount(t.time)) return null;
  const events = rule.evidence?.filter(e => e.traceIndex === d.traceIndex && e.step === d.step && e.action === d.action && e.messageId === d.messageId);
  if (events?.length !== 1) return null;
  const event = events[0];
  if (!event) return null;
  let outcome: ScenarioCheckEvidence['outcome'] = 'inconclusive';
  if (d.status === 'exception') {
    // Acceptance is unknown after a target exception; never claim reached.
    if (event.status !== 'inconclusive') return null;
    outcome = 'inconclusive';
  } else if (d.status === 'rejected') {
    if (event.status !== 'target-rejected') return null;
    outcome = 'not-checked';
  } else if (amount(d.usedCredit) && amount(d.reservedCredit) && amount(d.creditLimit) && Number.isSafeInteger(d.usedCredit + d.reservedCredit)) {
    const actual = d.usedCredit + d.reservedCredit <= d.creditLimit ? 'passed' : 'failed';
    if (event.status !== actual || event.usedCredit !== d.usedCredit || event.reservedCredit !== d.reservedCredit || event.creditLimit !== d.creditLimit
      || event.totalCredit !== d.usedCredit + d.reservedCredit) return null;
    outcome = actual;
  } else if (event.status !== 'inconclusive') return null;
  return {
    schemaVersion: 1, id: JSON.stringify(['credit', experimentIndex, rule.requirement, d.traceIndex, d.messageId]),
    scenarioId: 'accepted-order-credit-limit', evaluator: { ...COVERAGE_EVALUATOR }, context: { ...context }, experimentIndex,
    trigger: d.status === 'accepted' ? 'reached' : d.status === 'exception' ? 'unknown' : 'not-reached', outcome,
    traceRefs: [{ traceIndex: d.traceIndex, step: d.step, tick: t.time, messageId: d.messageId }],
    facts: { kind: 'credit-admission', requirement: rule.requirement, requirementEvaluator: { ...rule.evaluator }, messageId: d.messageId,
      payloadValid: d.payloadValid, deliveryStatus: d.status, usedCredit: d.usedCredit, reservedCredit: d.reservedCredit, creditLimit: d.creditLimit },
    ...(outcome === 'failed' && params.violationId ? { violationId: params.violationId } : {}),
    detail: event.detail,
  };
}
