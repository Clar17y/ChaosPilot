import type { ExperimentResult, SystemBriefSnapshot, TargetVariant } from '../domain.ts';
import { computeContractHash } from '../evidence.ts';
import { adaptCreditEvidenceToScenarioCheck, COVERAGE_EVALUATOR, prepareCoverage, validateCoveragePlan } from '../coverage/index.ts';
import type { CoveragePlan, CoveragePreparationInput, CoverageScenarioSuggestion, CoverageTraceReference, ScenarioCheckEvidence } from '../coverage/types.ts';
import { isRecoveryEvaluatorIdentity, recoveryEvaluatorAvailable } from '../recovery/oracle.ts';

/** Trusted execution context. Neither browser hashes nor today's profile replace the pinned snapshot. */
export function coveragePreparation(snapshot: SystemBriefSnapshot, variant: TargetVariant, sourceHash: string): CoveragePreparationInput {
  return {
    context: { systemId: snapshot.brief.id, revision: snapshot.brief.revision, snapshotHash: snapshot.hash,
      adapterId: snapshot.brief.adapterId, variant, sourceHash, contractHash: computeContractHash(snapshot.contract) },
    requirements: snapshot.brief.requirements, requirementRules: snapshot.brief.requirementRules,
    contractRuleIds: snapshot.contract?.invariants.map(i => i.id) ?? [],
  };
}

export function pinCoveragePlan(input: unknown, snapshot: SystemBriefSnapshot | undefined, variant: TargetVariant, sourceHash: string): CoveragePlan {
  if (!snapshot) throw new Error('Coverage requires a pinned system brief snapshot');
  const checked = validateCoveragePlan(input, coveragePreparation(snapshot, variant, sourceHash));
  if (!checked.valid || !checked.plan) throw new Error(`Invalid coverage plan: ${checked.errors.join('; ')}`);
  return checked.plan;
}

/** Public goals only. The plan context includes the private runtime variant. */
export function reviewedCoverageGoals(plan: CoveragePlan, snapshot: SystemBriefSnapshot): CoverageScenarioSuggestion[] {
  const prepared = prepareCoverage(coveragePreparation(snapshot, plan.context.variant as TargetVariant, plan.context.sourceHash));
  return plan.intentions.map(i => ({ ...prepared.suggestions.find(s => s.scenarioId === i.scenarioId)!, links: structuredClone(i.links) }));
}

/** Called only on fresh execution, including fresh replay. Never infer coverage on reopen. */
export function recordScenarioChecks(result: ExperimentResult, plan: CoveragePlan, snapshot: SystemBriefSnapshot, experimentIndex: number): void {
  const checks: ScenarioCheckEvidence[] = [];
  const ref = (index: number): CoverageTraceReference | undefined => {
    const t = result.trace[index];
    return t ? { traceIndex: index, step: t.step, tick: t.time, ...(t.messageId ? { messageId: t.messageId } : {}) } : undefined;
  };
  if (plan.intentions.some(i => i.scenarioId === 'accepted-order-credit-limit')) {
    for (const ruleResult of result.requirementRuleResults ?? []) for (const delivery of result.deliveryObservations ?? []) {
      const violation = result.violations.find(v => v.invariant === 'credit_limit_respected' && v.step === delivery.step);
      const check = adaptCreditEvidenceToScenarioCheck({ context: plan.context, experimentIndex, snapshot, result, ruleResult, delivery, violationId: violation?.id });
      if (check) checks.push(check);
    }
  }
  const raw = result.recovery;
  if (raw?.schemaVersion === 1 && isRecoveryEvaluatorIdentity(raw.evaluator) && recoveryEvaluatorAvailable(raw.evaluator) && result.sourceHash === plan.context.sourceHash) {
    for (const ob of raw.obligations) {
      // Missing independent accounting remains unproved; never synthesize zero facts.
      if (!ob.expected) continue;
      const ingress = raw.ingress.find(i => i.traceIndex === ob.acceptanceTraceIndex && i.status === 'accepted' && !i.duplicate);
      if (!ingress || !ingress.report || JSON.stringify([ingress.report.orderId, ingress.report.executionId]) !== ob.key) continue;
      const retries = raw.retries.filter(r => r.key === ob.key);
      for (const intention of plan.intentions) {
        if (intention.scenarioId === 'accepted-order-credit-limit') continue;
        const retry = intention.scenarioId === 'recovery-retry-idempotence';
        const applicableRetries = retry && retries.length ? retries : [undefined];
        for (const retryResult of applicableRetries) {
          const horizon = retryResult ? Math.max(ob.checkedTick, retryResult.tick) : ob.checkedTick;
          const refs = [ref(ob.acceptanceTraceIndex), ref(ob.checkTraceIndex),
            ...result.trace.flatMap((t, index) => t.time === ob.checkedTick || t.time === ob.completionTick
              || t.action === 'connection:reconnect' && t.time === ob.reconnectTick ? [ref(index)] : []),
            ...(retryResult ? [ref(retryResult.traceIndex)] : [])].filter((r): r is CoverageTraceReference => r !== undefined);
          const violation = result.violations.find(v => v.evidence?.key === ob.key &&
            (retry ? v.invariant === 'execution_idempotency' && v.step === result.trace[retryResult?.traceIndex ?? -1]?.step : v.invariant === 'recovery_deadline'));
          let outcome: ScenarioCheckEvidence['outcome'] = ob.status === 'passed' ? 'passed' : ob.status === 'failed' ? 'failed' : 'inconclusive';
          if (retry) outcome = !retryResult ? 'not-checked' : retryResult.status === 'failed' ? 'failed'
            : retryResult.status === 'passed' && ob.status === 'passed' ? 'passed' : 'inconclusive';
          checks.push({ schemaVersion: 1, id: JSON.stringify([intention.scenarioId, experimentIndex, ob.key, retryResult?.traceIndex ?? null]),
            scenarioId: intention.scenarioId, evaluator: { ...COVERAGE_EVALUATOR }, context: { ...plan.context }, experimentIndex,
            trigger: retry && !retryResult ? 'not-reached' : 'reached', outcome,
            traceRefs: [...new Map(refs.map(r => [r.traceIndex, r])).values()],
            facts: { kind: 'recovery', reportId: ingress.messageId, executionId: ob.report.executionId, orderId: ob.report.orderId,
              acceptedAtTick: ob.acceptedTick, acceptedDuringDisconnection: ingress.disconnected,
              reconnectTick: ob.reconnectTick, deadlineTick: ob.deadlineTick, horizonTick: horizon,
              completionTick: ob.completionTick, ...(retry ? { retryObserved: retries.length > 0 } : {}),
              ...(retryResult ? { retryCheck: { status: retryResult.status === 'passed' || retryResult.status === 'failed' ? retryResult.status : 'inconclusive',
                ...(retryResult.before ? { before: { ...retryResult.before } } : {}), ...(retryResult.after ? { after: { ...retryResult.after } } : {}),
                ...(retryResult.expected ? { expected: { ...retryResult.expected } } : {}) } } : {}),
              expected: { ...ob.expected }, ...(ob.observed ? { observed: { ...ob.observed } } : {}) },
            ...(outcome === 'failed' && violation ? { violationId: violation.id } : {}),
            detail: retry ? (retryResult ? 'Recorded duplicate delivery, before/after facts and independent recovery accounting' : 'No duplicate delivery observed')
              : `Independent recovery check at simulated tick ${ob.checkedTick}: ${ob.status}`,
          });
        }
      }
    }
    // Connected acceptances create no recovery obligation, so their retries are
    // emitted per delivery from the authoritative accepted ingress plus the
    // oracle's independent expected accounting. No reconnect/deadline is invented.
    const obligationKeys = new Set(raw.obligations.map(ob => ob.key));
    const factKeys = ['filledQuantity', 'remainingQuantity', 'usedCredit', 'reservedCredit', 'applicationCount'] as const;
    const factsEqual = (a: Record<(typeof factKeys)[number], number>, b: Record<(typeof factKeys)[number], number>) =>
      factKeys.every(k => a[k] === b[k]);
    for (const intention of plan.intentions) {
      if (intention.scenarioId !== 'recovery-retry-idempotence') continue;
      for (const retryResult of raw.retries) {
        if (obligationKeys.has(retryResult.key) || !retryResult.expected || !retryResult.before || !retryResult.after) continue;
        const ingress = raw.ingress.find(i => i.status === 'accepted' && !i.duplicate && i.report
          && JSON.stringify([i.report.orderId, i.report.executionId]) === retryResult.key);
        if (!ingress?.report || ingress.disconnected) continue;
        const refs = [ref(ingress.traceIndex), ref(retryResult.traceIndex)]
          .filter((r): r is CoverageTraceReference => r !== undefined);
        const violation = result.violations.find(v => v.evidence?.key === retryResult.key
          && v.invariant === 'execution_idempotency' && v.step === result.trace[retryResult.traceIndex]?.step);
        const outcome: ScenarioCheckEvidence['outcome'] = retryResult.status === 'failed' ? 'failed'
          : retryResult.status === 'passed' && factsEqual(retryResult.before, retryResult.after)
            && factsEqual(retryResult.after, retryResult.expected) ? 'passed' : 'inconclusive';
        checks.push({ schemaVersion: 1, id: JSON.stringify([intention.scenarioId, experimentIndex, retryResult.key, retryResult.traceIndex]),
          scenarioId: intention.scenarioId, evaluator: { ...COVERAGE_EVALUATOR }, context: { ...plan.context }, experimentIndex,
          trigger: 'reached', outcome,
          traceRefs: [...new Map(refs.map(r => [r.traceIndex, r])).values()],
          facts: { kind: 'recovery', reportId: ingress.messageId, executionId: ingress.report.executionId, orderId: ingress.report.orderId,
            acceptedAtTick: ingress.tick, acceptedDuringDisconnection: false, horizonTick: retryResult.tick,
            retryObserved: true,
            retryCheck: { status: retryResult.status === 'passed' || retryResult.status === 'failed' ? retryResult.status : 'inconclusive',
              before: { ...retryResult.before }, after: { ...retryResult.after }, expected: { ...retryResult.expected } },
            expected: { ...retryResult.expected }, observed: { ...retryResult.after } },
          ...(outcome === 'failed' && violation ? { violationId: violation.id } : {}),
          detail: 'Recorded connected duplicate delivery, before/after facts and independent expected accounting',
        });
      }
    }
  }
  result.scenarioCheckEvidence = checks;
}
