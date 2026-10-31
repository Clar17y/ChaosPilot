import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ExperimentResult, RequirementRuleResult, SystemBriefSnapshot, TargetVariant } from '../domain.ts';
import { resolveAdapter } from '../adapters/index.ts';
import { evaluateRequirementRules } from '../requirements/evaluator.ts';
import { canonicalJson } from '../evidence.ts';
import { expectedMilestones, type ScenarioDefinition } from './catalog.ts';
import type { FunctionalAssertionResult, FunctionalAssertionStatus, FunctionalEvaluatorIdentity, FunctionalScenarioResult } from './types.ts';

export const FUNCTIONAL_EVALUATOR_ID = 'functional-evaluator';
export const FUNCTIONAL_EVALUATOR_VERSION = 2;

export function getFunctionalEvaluatorIdentity(): FunctionalEvaluatorIdentity {
  // Hash the actual implementation and expected facts, rather than an unchanged label.
  const hash = crypto.createHash('sha256');
  for (const file of ['./evaluator', './catalog', '../requirements/evaluator']) {
    const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    hash.update(readFileSync(new URL(file + extension, import.meta.url)));
  }
  return { id: FUNCTIONAL_EVALUATOR_ID, version: FUNCTIONAL_EVALUATOR_VERSION, hash: hash.digest('hex') };
}

export function aggregateFunctionalStatus(statuses: FunctionalAssertionStatus[]): FunctionalAssertionStatus {
  if (!statuses.length) return 'inconclusive';
  return statuses.includes('invalid') ? 'invalid' : statuses.includes('fail') ? 'fail'
    : statuses.includes('inconclusive') ? 'inconclusive' : 'pass';
}
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const amount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

export function evaluateFunctionalScenario(
  scenario: ScenarioDefinition, result: ExperimentResult, snapshot: SystemBriefSnapshot,
  scenarioIndex = 0, expectedSourceHash = resolveAdapter('synthetic-trading').getSourceBundle('clean').hash, expectedVariant: TargetVariant = 'clean',
): FunctionalScenarioResult {
  const assertions: FunctionalAssertionResult[] = [];
  const expectedExperiment = scenario.buildExperiment();
  const milestones = expectedMilestones(scenario.id);
  function check(id: string, expected: unknown, actual: unknown, status: FunctionalAssertionStatus, detail: string, step?: number, traceIndex?: number, messageId?: string): void {
    assertions.push({ id, name: id, milestone: id.split('.')[0], status,
      expected: JSON.stringify(expected) ?? 'unavailable', actual: JSON.stringify(actual) ?? 'unavailable', detail,
      evidence: { expected, actual: actual ?? null, detail, step, traceIndex, messageId } });
  }
  const trace = Array.isArray(result.trace) ? result.trace : [];
  const observations = Array.isArray(result.deliveryObservations) ? result.deliveryObservations : [];
  const rejections = Array.isArray(result.rejections) ? result.rejections : [];
  const provenanceMatches = result.sourceHash === expectedSourceHash && same(result.experiment, expectedExperiment);
  check('execution.identity', { sourceHash: expectedSourceHash, experiment: expectedExperiment },
    { sourceHash: result.sourceHash, experiment: result.experiment }, provenanceMatches ? 'pass' : 'inconclusive',
    provenanceMatches ? 'Allowlisted sequence and target source matched' : 'Executed source or sequence cannot be bound to the selected baseline');
  check('execution.complete', true, result.executionComplete ?? null, result.executionComplete === true ? 'pass' : 'inconclusive',
    result.executionComplete === true ? 'Execution completed' : 'Execution completion was not recorded');
  check('execution.valid', true, result.valid, result.valid === true && !rejections.length ? 'pass' : 'invalid',
    'An invalid harness command is not an expected business rejection');
  check('execution.evidence', 'Trace, delivery, rejection and oracle arrays', null,
    Array.isArray(result.trace) && Array.isArray(result.deliveryObservations) && Array.isArray(result.rejections) && Array.isArray(result.violations) ? 'pass' : 'inconclusive', 'Required evidence collections must be recorded');

  // Every allowlisted action must be reached exactly once, in sequence. No outcome prose is interpreted.
  for (const [step, command] of expectedExperiment.steps.entries()) {
    const matches = trace.map((t, index) => ({ t, index })).filter(({ t }) => t.step === step);
    const entry = matches[0];
    const messageId = command.op === 'send' ? command.id : 'messageId' in command ? command.messageId : undefined;
    const bound = matches.length === 1 && entry?.index === step && entry.t.action === command.op && entry.t.messageId === messageId
      && (command.op !== 'send' || same(entry.t.payload, command.payload));
    check(`sequence.${step}`, { action: command.op, messageId }, entry ? { action: entry.t.action, messageId: entry.t.messageId } : null,
      bound ? 'pass' : 'inconclusive', bound ? 'Action and message bound to sequence' : 'Missing, duplicate or misbound trace action', step, entry?.index, messageId);
    if (command.op !== 'deliver') continue;
    const obs = observations.filter(o => o.step === step);
    const o = obs[0];
    const producer = expectedExperiment.steps.find(c => c.op === 'send' ? c.id === command.messageId : 'messageId' in c && c.messageId === command.messageId && c.op !== 'deliver');
    const channel = producer?.op === 'send' ? producer.to : 'reports';
    const messageType = producer?.op === 'send' && object(producer.payload) ? producer.payload.type
      : producer?.op === 'fill' ? 'execution' : 'cancel_ack';
    const scheduledTrace = trace.find(t => t.messageId === command.messageId && t.action !== 'deliver');
    const deliveryBound = bound && object(entry?.t.payload) && same(entry?.t.payload, scheduledTrace?.payload) && obs.length === 1 && o?.traceIndex === entry?.index && o?.action === 'deliver'
      && o.messageId === command.messageId && o.channel === channel && o.messageType === messageType && o.payloadValid === true;
    const milestone = milestones.find(m => m.step === step);
    const expected = milestone?.delivery ?? 'accepted';
    const validStatus = o?.status === 'accepted' || o?.status === 'rejected';
    const status: FunctionalAssertionStatus = rejections.some(r => r.step === step) ? 'invalid'
      : !deliveryBound || !validStatus ? 'inconclusive'
      : o.status !== expected || (expected === 'rejected' && !(o.reason ?? '').toLowerCase().includes(milestone?.rejectionReason?.toLowerCase() ?? '\u0000')) ? 'fail' : 'pass';
    check(milestone ? `${milestone.name}.delivery-${expected}` : `setup.${step}.delivery`, { status: expected, channel, messageType, payloadValid: true, ...(milestone?.rejectionReason ? { rejectionReason: milestone.rejectionReason } : {}) }, o ?? null, status,
      status === 'invalid' ? 'An invalid harness command is not an expected business rejection'
      : o?.status === 'exception' ? 'Target threw unhandled exception'
      : !deliveryBound ? 'Missing or unverifiable typed delivery/trace binding' : 'Expected versus actual business delivery', step, entry?.index, command.messageId);
  }
  check('execution.trace-length', expectedExperiment.steps.length, trace.length,
    trace.length === expectedExperiment.steps.length ? 'pass' : 'inconclusive', 'Full allowlisted trace required');
  check('execution.delivery-count', expectedExperiment.steps.filter(s => s.op === 'deliver').length, observations.length,
    observations.length === expectedExperiment.steps.filter(s => s.op === 'deliver').length ? 'pass' : 'inconclusive', 'Exactly one observation per delivery required');

  for (const m of milestones) {
    const traceIndex = trace.findIndex(t => t.step === m.step);
    const t = trace[traceIndex];
    const state = t?.state;
    const orders = object(state) && object(state.orders) ? state.orders : null;
    const order = orders?.[m.orderId];
    const typedOrder = order === undefined || (object(order) && typeof order.status === 'string'
      && ['remainingQuantity', 'filledQuantity', 'cancelledQuantity', 'price'].every(k => amount(order[k])) && typeof order.cancellationRequested === 'boolean');
    const orderKnown = orders !== null && typedOrder;
    const orderMatches = m.order === null ? orders !== null && !Object.hasOwn(orders, m.orderId)
      : object(order) && Object.entries(m.order).every(([key, expected]) => order[key] === expected);
    const mismatches = m.order && object(order) ? Object.entries(m.order).filter(([key, value]) => order[key] !== value)
      .map(([key, value]) => `${key} expected ${JSON.stringify(value)} got ${JSON.stringify(order[key])}`).join('; ') : '';
    check(`${m.name}.${m.order === null ? 'order-not-created' : `order-${m.orderId}`}`, m.order, order ?? null,
      !orderKnown ? 'inconclusive' : orderMatches ? 'pass' : 'fail', mismatches || 'Expected order presence, quantities and lifecycle flags', m.step, traceIndex, m.messageId);
    const creditKnown = object(state) && amount(state.reservedCredit) && amount(state.usedCredit);
    const actualCredit = creditKnown ? { reservedCredit: state.reservedCredit, usedCredit: state.usedCredit } : null;
    check(`${m.name}.credit`, m.credit, actualCredit, !creditKnown ? 'inconclusive' : same(m.credit, actualCredit) ? 'pass' : 'fail', 'Credit accounting at the milestone', m.step, traceIndex, m.messageId);
    const limit = object(state?.credit) ? state.credit.limit : null;
    check(`${m.name}.credit-limit`, m.creditLimit, limit,
      !amount(limit) ? 'inconclusive' : limit === m.creditLimit ? 'pass' : 'fail', 'Configured credit limit at the milestone', m.step, traceIndex, m.messageId);
    if (m.delivery === 'rejected') {
      const before = trace.find(t => t.step === m.step - 1)?.state;
      const business = (s: Record<string, unknown>) => ({ orders: s.orders, reservedCredit: s.reservedCredit, usedCredit: s.usedCredit, credit: s.credit });
      const known = object(before) && object(before.orders) && amount(before.reservedCredit) && amount(before.usedCredit) && object(before.credit) && amount(before.credit.limit) && creditKnown && orders !== null && amount(limit);
      check(`${m.name}.unchanged`, known ? business(before!) : null, known ? business(state!) : null,
        !known ? 'inconclusive' : same(business(before!), business(state!)) ? 'pass' : 'fail', 'Rejection must preserve the entire order book and credit state', m.step, traceIndex, m.messageId);
    }
  }
  let requirementRuleResults: RequirementRuleResult[] | undefined;
  let requirementEvaluationError: string | undefined;
  if (snapshot.brief.requirementRules?.length) {
    try {
      requirementRuleResults = evaluateRequirementRules(result, snapshot, scenarioIndex);
      if (requirementRuleResults.length !== snapshot.brief.requirementRules.length) throw new Error('Configured rule results are missing');
    } catch (error) {
      requirementEvaluationError = error instanceof Error ? error.message : String(error);
    }
    check('requirements.available', 'Configured requirement evaluation', requirementEvaluationError ?? requirementRuleResults,
      requirementEvaluationError ? 'inconclusive' : requirementRuleResults?.some(r => r.status === 'failed') ? 'fail'
      : requirementRuleResults?.some(r => r.status === 'inconclusive') ? 'inconclusive' : 'pass',
      requirementEvaluationError ?? 'Configured requirement rule outcomes (not-exercised means unverified)');
  }
  const violations = Array.isArray(result.violations) ? result.violations : [];
  const status = aggregateFunctionalStatus([...assertions.map(a => a.status), ...(violations.length ? ['fail' as const] : [])]);
  const reasons = assertions.filter(a => a.status !== 'pass').map(a => a.detail);
  if (violations.length) reasons.push(`${violations.length} oracle violation(s) observed`);
  if (requirementRuleResults?.some(r => r.status === 'failed')) reasons.push('Configured requirement rule failed');
  return { variant: expectedVariant, scenarioId: scenario.id, name: scenario.name, description: scenario.description, status,
    summary: status === 'pass' ? `Passed: all ${assertions.length} assertions verified; context-only prose remains unverified.` : reasons.join('; '),
    expectedExperiment, expectedMilestones: milestones, sourceHash: result.sourceHash, expectedSourceHash,
    experiment: result.experiment, trace, deliveryObservations: observations, rejections, violations,
    requirementRuleResults, requirementEvaluationError, assertions, executionComplete: result.executionComplete === true, valid: result.valid === true };
}
