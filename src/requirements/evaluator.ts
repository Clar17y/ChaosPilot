import type { ExperimentResult, RequirementRuleEvidence, RequirementRuleResult, SystemBriefSnapshot } from '../domain.ts';

const expected = 'usedCredit + reservedCredit <= current credit limit' as const;
const knownAmount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** No oracle writes, finding promotion, arbitrary expressions or code execution. */
export function evaluateRequirementRules(result: ExperimentResult, snapshot: SystemBriefSnapshot, experimentIndex: number): RequirementRuleResult[] {
  const evaluator = snapshot.requirementEvaluator;
  if (!evaluator) throw new Error('Requirement evaluator identity is missing');
  return (snapshot.brief.requirementRules ?? []).map(rule => {
    const evidence: RequirementRuleEvidence[] = [];
    let matchedEvents = 0;
    const uncertain = (detail: string) => evidence.push({ status: 'inconclusive', detail, expected });
    const rejections = Array.isArray(result.rejections) ? result.rejections : [];
    const trace = Array.isArray(result.trace) ? result.trace : [];
    const steps = Array.isArray(result.experiment?.steps) ? result.experiment.steps : [];
    if (!result.valid || rejections.length) uncertain('Invalid test commands: experiment execution was not valid.');
    if (result.executionComplete !== true) uncertain('Execution is incomplete or completion was not recorded.');
    if (!Array.isArray(result.deliveryObservations)) uncertain('Required typed delivery observations are missing.');
    const observations = result.deliveryObservations ?? [];
    const deliveryTraces = trace.map((t, index) => ({ t, index })).filter(({ t }) => t.action === 'deliver' || t.action === 'drain:deliver');
    // Scheduler command rejections have no target delivery observation.
    for (const { t, index } of deliveryTraces) {
      if (rejections.some(r => r.step === t.step)) continue;
      if (observations.filter(o => o.traceIndex === index && o.step === t.step && o.messageId === t.messageId && o.action === t.action).length !== 1) uncertain(`Missing or ambiguous delivery observation at trace event ${index}, step ${t.step}.`);
    }
    const reachedSteps = new Set(trace.map(t => t.step));
    if (steps.some((_, i) => !reachedSteps.has(i))) uncertain('Experiment steps are missing from execution evidence.');
    for (const o of observations) {
      const t = trace[o.traceIndex];
      if (!t || t.step !== o.step || t.action !== o.action || t.messageId !== o.messageId) uncertain(`Delivery observation does not match trace event ${o.traceIndex}.`);
      const base = { traceIndex: o.traceIndex, step: o.step, action: o.action, messageId: o.messageId, expected };
      if (o.status === 'exception') {
        evidence.push({ ...base, status: 'inconclusive', detail: `Target exception: ${o.reason ?? 'unknown error'}` });
        continue;
      }
      if (!['accepted', 'rejected'].includes(o.status)) {
        evidence.push({ ...base, status: 'inconclusive', detail: 'Unknown delivery outcome.' });
        continue;
      }
      if (!o.payloadValid) {
        evidence.push({ ...base, status: o.status === 'accepted' ? 'inconclusive' : 'invalid-payload', detail: 'Invalid payload; the valid new_order trigger cannot be established.' });
        continue;
      }
      if (o.channel !== 'client' || o.messageType !== 'new_order') continue;
      if (o.status === 'rejected') {
        evidence.push({ ...base, status: 'target-rejected', detail: `Target rejected new_order: ${o.reason ?? 'no reason recorded'}; accepted-order trigger not reached.` });
        continue;
      }
      matchedEvents++;
      const values = { usedCredit: o.usedCredit, reservedCredit: o.reservedCredit, creditLimit: o.creditLimit };
      if (!knownAmount(o.usedCredit) || !knownAmount(o.reservedCredit) || !knownAmount(o.creditLimit) || !Number.isSafeInteger(o.usedCredit + o.reservedCredit)) {
        evidence.push({ ...base, ...values, status: 'inconclusive', detail: 'Required credit observations are missing or invalid.' });
        continue;
      }
      const totalCredit = o.usedCredit + o.reservedCredit;
      const status = totalCredit <= o.creditLimit ? 'passed' : 'failed';
      evidence.push({ ...base, ...values, totalCredit, status, detail: `${totalCredit} <= ${o.creditLimit} is ${status === 'passed' ? 'true' : 'false'}.` });
    }
    const status = evidence.some(e => e.status === 'failed') ? 'failed'
      : evidence.some(e => e.status === 'inconclusive') ? 'inconclusive'
      : matchedEvents > 0 ? 'passed' : 'not-exercised';
    if (!evidence.length) evidence.push({ status: 'not-exercised', detail: 'No valid accepted new_order delivery was observed.', expected });
    return { requirement: rule.requirement, preset: rule.preset, experimentIndex, sourceHash: result.sourceHash, snapshotHash: snapshot.hash, evaluator: structuredClone(evaluator), status, matchedEvents, evidence };
  });
}
