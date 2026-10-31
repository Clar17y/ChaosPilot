import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import type {
  Action,
  Experiment,
  ExperimentResult,
  RequirementRuleResult,
  SystemBriefSnapshot,
  TargetVariant,
} from '../domain.ts';
import { canonicalJson } from '../evidence.ts';
import { aggregateFunctionalStatus } from '../functional/evaluator.ts';
import { evaluateRequirementRules } from '../requirements/evaluator.ts';
import type {
  FunctionalAssertionResult,
  FunctionalAssertionStatus,
  RegressionBusinessStateExpectation,
  RegressionCreditLimitExpectation,
  RegressionDeliveryExpectation,
  RegressionEvaluationResult,
  RegressionEvaluatorIdentity,
  RegressionExpectedOutcomes,
  RegressionOrderStateExpectation,
  RegressionOrigin,
  RegressionQuoteStateExpectation,
  RegressionTraceBinding,
  SupportedRegressionMessageType,
} from './types.ts';

export const REGRESSION_EVALUATOR_ID = 'regression-evaluator';
export const REGRESSION_EVALUATOR_VERSION = 1;

const SUPPORTED_ACTIONS = new Set([
  'send',
  'duplicate',
  'advance',
  'deliver',
  'drain',
  'fill',
  'confirm_cancel',
]);

const SUPPORTED_MESSAGE_TYPES = new Set<SupportedRegressionMessageType>([
  'quote',
  'credit_limit',
  'new_order',
  'cancel_order',
  'execution',
  'cancel_ack',
]);

const object = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const amount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);
const same = (a: unknown, b: unknown): boolean =>
  canonicalJson(a) === canonicalJson(b);

export function getRegressionEvaluatorIdentity(): RegressionEvaluatorIdentity {
  const hash = crypto.createHash('sha256');
  for (const file of ['./evaluator', '../functional/evaluator', '../requirements/evaluator']) {
    const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    hash.update(readFileSync(new URL(file + extension, import.meta.url)));
  }
  return {
    id: REGRESSION_EVALUATOR_ID,
    version: REGRESSION_EVALUATOR_VERSION,
    hash: hash.digest('hex'),
  };
}

export function computeRegressionContentHash(input: {
  origin: RegressionOrigin;
  experiment: Experiment;
  expected: RegressionExpectedOutcomes;
  evaluator: RegressionEvaluatorIdentity;
}): string {
  return crypto
    .createHash('sha256')
    .update(
      canonicalJson({
        origin: input.origin,
        experiment: input.experiment,
        expected: input.expected,
        evaluator: input.evaluator,
      }),
      'utf8',
    )
    .digest('hex');
}

export function computeRegressionReviewToken(contentHash: string): string {
  return `rev-${contentHash}`;
}

export function computeRegressionDefinitionId(contentHash: string): string {
  return `reg-${contentHash.slice(0, 24)}`;
}

interface ParsedTargetBusinessState {
  quote: RegressionQuoteStateExpectation | null;
  creditLimit: RegressionCreditLimitExpectation | null;
  reservedCredit: number;
  usedCredit: number;
  orders: Record<string, RegressionOrderStateExpectation>;
}

const INITIAL_BUSINESS_STATE: ParsedTargetBusinessState = {
  quote: null,
  creditLimit: null,
  reservedCredit: 0,
  usedCredit: 0,
  orders: {},
};

export function parseTargetStateSnapshot(raw: unknown): ParsedTargetBusinessState | null {
  if (!object(raw)) return null;
  if (!amount(raw.reservedCredit) || !amount(raw.usedCredit)) return null;

  let quote: RegressionQuoteStateExpectation | null = null;
  if (raw.quote !== null) {
    if (
      !object(raw.quote) ||
      typeof raw.quote.id !== 'string' ||
      !raw.quote.id ||
      !amount(raw.quote.version) ||
      !amount(raw.quote.price)
    ) {
      return null;
    }
    quote = {
      id: raw.quote.id,
      version: raw.quote.version,
      price: raw.quote.price,
    };
  }

  let creditLimit: RegressionCreditLimitExpectation | null = null;
  if (raw.credit !== null) {
    if (
      !object(raw.credit) ||
      !amount(raw.credit.version) ||
      !amount(raw.credit.limit)
    ) {
      return null;
    }
    creditLimit = {
      version: raw.credit.version,
      limit: raw.credit.limit,
    };
  }

  if (!object(raw.orders)) return null;
  const orders: Record<string, RegressionOrderStateExpectation> = {};
  for (const [orderId, ordVal] of Object.entries(raw.orders)) {
    if (!orderId || !object(ordVal) || ordVal.orderId !== orderId) return null;
    if (
      typeof ordVal.quoteId !== 'string' ||
      !amount(ordVal.price) ||
      !amount(ordVal.initialQuantity) ||
      !amount(ordVal.remainingQuantity) ||
      !amount(ordVal.filledQuantity) ||
      !amount(ordVal.cancelledQuantity) ||
      typeof ordVal.cancellationRequested !== 'boolean' ||
      (ordVal.status !== 'OPEN' && ordVal.status !== 'FILLED' && ordVal.status !== 'CANCELLED')
    ) {
      return null;
    }
    orders[orderId] = {
      orderId,
      quoteId: ordVal.quoteId,
      price: ordVal.price,
      initialQuantity: ordVal.initialQuantity,
      remainingQuantity: ordVal.remainingQuantity,
      filledQuantity: ordVal.filledQuantity,
      cancelledQuantity: ordVal.cancelledQuantity,
      cancellationRequested: ordVal.cancellationRequested,
      status: ordVal.status,
    };
  }

  return {
    quote,
    creditLimit,
    reservedCredit: raw.reservedCredit,
    usedCredit: raw.usedCredit,
    orders,
  };
}

function extractTargetOrderId(payload: unknown): string | undefined {
  if (!object(payload)) return undefined;
  return typeof payload.orderId === 'string' && payload.orderId.trim() ? payload.orderId : undefined;
}

function validateStepTraceBinding(
  step: Action,
  stepIndex: number,
  entries: { traceIndex: number; entry: ExperimentResult['trace'][number] }[],
): { ok: true; bindings: RegressionTraceBinding[] } | { ok: false; reason: string } {
  if (entries.length === 0) {
    return {
      ok: false,
      reason: `Step ${stepIndex + 1} (${step.op}) produced no trace entries on clean control`,
    };
  }

  if (step.op === 'drain') {
    const bindings: RegressionTraceBinding[] = [];
    if (entries.length === 1 && entries[0]!.entry.action === 'drain') {
      const e = entries[0]!;
      if (e.entry.outcome !== 'drained:empty') {
        return { ok: false, reason: `Unexpected drain outcome at step ${stepIndex + 1}: ${e.entry.outcome}` };
      }
      bindings.push({
        traceIndex: e.traceIndex,
        step: stepIndex,
        action: 'drain',
        expectedOutcome: 'drained:empty',
      });
      return { ok: true, bindings };
    }

    for (const { traceIndex, entry } of entries) {
      if (
        entry.action !== 'drain:deliver' ||
        typeof entry.messageId !== 'string' ||
        !entry.messageId ||
        (!entry.outcome.startsWith('delivered:processed') && !entry.outcome.startsWith('delivered:rejected ('))
      ) {
        return {
          ok: false,
          reason: `Step ${stepIndex + 1} (drain) produced unsupported trace entry at index ${traceIndex}`,
        };
      }
      bindings.push({
        traceIndex,
        step: stepIndex,
        action: 'drain:deliver',
        messageId: entry.messageId,
        ...(entry.payload !== undefined ? { payload: structuredClone(entry.payload) } : {}),
        expectedOutcome: entry.outcome,
      });
    }
    return { ok: true, bindings };
  }

  if (entries.length !== 1) {
    return {
      ok: false,
      reason: `Step ${stepIndex + 1} (${step.op}) produced ${entries.length} trace entries; expected exactly 1`,
    };
  }

  const { traceIndex, entry } = entries[0]!;
  if (entry.action !== step.op) {
    return {
      ok: false,
      reason: `Step ${stepIndex + 1} (${step.op}) produced trace action '${entry.action}'`,
    };
  }

  switch (step.op) {
    case 'send':
      if (
        entry.messageId !== step.id ||
        !same(entry.payload, step.payload) ||
        entry.outcome !== 'scheduled'
      ) {
        return { ok: false, reason: `Step ${stepIndex + 1} (send ${step.id}) did not schedule cleanly` };
      }
      return {
        ok: true,
        bindings: [
          {
            traceIndex,
            step: stepIndex,
            action: 'send',
            messageId: step.id,
            payload: structuredClone(step.payload),
            expectedOutcome: 'scheduled',
          },
        ],
      };

    case 'duplicate':
      if (
        entry.messageId !== step.id ||
        entry.outcome !== `duplicated from ${step.messageId}`
      ) {
        return { ok: false, reason: `Step ${stepIndex + 1} (duplicate ${step.id}) did not bind cleanly` };
      }
      return {
        ok: true,
        bindings: [
          {
            traceIndex,
            step: stepIndex,
            action: 'duplicate',
            messageId: step.id,
            expectedOutcome: entry.outcome,
          },
        ],
      };

    case 'advance':
      if (entry.outcome !== `advanced by ${step.ticks} ticks`) {
        return { ok: false, reason: `Step ${stepIndex + 1} (advance) did not bind cleanly` };
      }
      return {
        ok: true,
        bindings: [
          {
            traceIndex,
            step: stepIndex,
            action: 'advance',
            expectedOutcome: entry.outcome,
          },
        ],
      };

    case 'deliver':
      if (
        entry.messageId !== step.messageId ||
        (!entry.outcome.startsWith('delivered:processed') && !entry.outcome.startsWith('delivered:rejected ('))
      ) {
        return { ok: false, reason: `Step ${stepIndex + 1} (deliver ${step.messageId}) did not deliver cleanly` };
      }
      return {
        ok: true,
        bindings: [
          {
            traceIndex,
            step: stepIndex,
            action: 'deliver',
            messageId: step.messageId,
            ...(entry.payload !== undefined ? { payload: structuredClone(entry.payload) } : {}),
            expectedOutcome: entry.outcome,
          },
        ],
      };

    case 'fill':
      if (
        entry.messageId !== step.messageId ||
        entry.outcome !== 'venue_fill_scheduled' ||
        !object(entry.payload)
      ) {
        return { ok: false, reason: `Step ${stepIndex + 1} (fill ${step.messageId}) did not schedule cleanly on clean control` };
      }
      return {
        ok: true,
        bindings: [
          {
            traceIndex,
            step: stepIndex,
            action: 'fill',
            messageId: step.messageId,
            payload: structuredClone(entry.payload),
            expectedOutcome: 'venue_fill_scheduled',
          },
        ],
      };

    case 'confirm_cancel':
      if (
        entry.messageId !== step.messageId ||
        entry.outcome !== 'venue_cancel_scheduled' ||
        !object(entry.payload)
      ) {
        return { ok: false, reason: `Step ${stepIndex + 1} (confirm_cancel ${step.messageId}) did not schedule cleanly on clean control` };
      }
      return {
        ok: true,
        bindings: [
          {
            traceIndex,
            step: stepIndex,
            action: 'confirm_cancel',
            messageId: step.messageId,
            payload: structuredClone(entry.payload),
            expectedOutcome: 'venue_cancel_scheduled',
          },
        ],
      };
  }
}

export function deriveRegressionExpectations(
  experiment: Experiment,
  cleanResult: ExperimentResult,
): { ok: true; expected: RegressionExpectedOutcomes } | { ok: false; reason: string } {
  if (!experiment || !Array.isArray(experiment.steps) || experiment.steps.length === 0 || experiment.steps.length > 100) {
    return { ok: false, reason: 'Experiment sequence must contain between 1 and 100 steps' };
  }
  for (const [idx, step] of experiment.steps.entries()) {
    if (!step || typeof step.op !== 'string' || !SUPPORTED_ACTIONS.has(step.op)) {
      return { ok: false, reason: `Unsupported action at step ${idx + 1}` };
    }
  }

  if (cleanResult.executionComplete !== true) {
    return { ok: false, reason: 'Clean-control execution did not complete' };
  }
  if (cleanResult.valid !== true || !Array.isArray(cleanResult.rejections) || cleanResult.rejections.length > 0) {
    const firstRej = Array.isArray(cleanResult.rejections) ? cleanResult.rejections[0] : undefined;
    return {
      ok: false,
      reason: `Original sequence is rejected by the harness on clean control${firstRej ? ` at step ${firstRej.step + 1} (${firstRej.reason})` : ''}; cannot derive positive expected business outcomes`,
    };
  }
  if (!Array.isArray(cleanResult.violations) || cleanResult.violations.length > 0) {
    return { ok: false, reason: 'Clean-control execution reported oracle violations; cannot derive reference expectations' };
  }
  if (!Array.isArray(cleanResult.trace) || cleanResult.trace.length === 0 || !Array.isArray(cleanResult.deliveryObservations)) {
    return { ok: false, reason: 'Clean-control execution is missing trace or delivery observations' };
  }

  const trace = cleanResult.trace;
  const observations = cleanResult.deliveryObservations;

  // Verify trace step monotonicity and collect step bindings
  let lastStep = 0;
  for (let i = 0; i < trace.length; i++) {
    const entry = trace[i]!;
    if (!Number.isInteger(entry.step) || entry.step < lastStep || entry.step >= experiment.steps.length) {
      return { ok: false, reason: `Clean-control trace entry ${i} has out-of-order step index` };
    }
    lastStep = entry.step;
  }

  const traceBindings: RegressionTraceBinding[] = [];
  for (let stepIndex = 0; stepIndex < experiment.steps.length; stepIndex++) {
    const step = experiment.steps[stepIndex]!;
    const stepEntries = trace
      .map((entry, traceIndex) => ({ traceIndex, entry }))
      .filter(({ entry }) => entry.step === stepIndex);
    const bound = validateStepTraceBinding(step, stepIndex, stepEntries);
    if (!bound.ok) return bound;
    traceBindings.push(...bound.bindings);
  }

  if (traceBindings.length !== trace.length) {
    return { ok: false, reason: 'Clean-control trace entries could not be completely bound to experiment steps' };
  }

  const deliveryBindings = traceBindings.filter(
    (b): b is RegressionTraceBinding & { action: 'deliver' | 'drain:deliver'; messageId: string } =>
      (b.action === 'deliver' || b.action === 'drain:deliver') && typeof b.messageId === 'string',
  );

  if (deliveryBindings.length === 0) {
    return {
      ok: false,
      reason: 'Experiment does not contain any message deliveries to derive positive business expectations',
    };
  }

  if (observations.length !== deliveryBindings.length) {
    return {
      ok: false,
      reason: 'Clean-control delivery observation count does not match delivered trace entries',
    };
  }

  const deliveries: RegressionDeliveryExpectation[] = [];
  const rejectedNewOrderIds = new Set<string>();

  for (const b of deliveryBindings) {
    const obsMatches = observations.filter(o => o.traceIndex === b.traceIndex);
    if (obsMatches.length !== 1) {
      return {
        ok: false,
        reason: `Clean-control delivery observation at trace index ${b.traceIndex} is missing or ambiguous`,
      };
    }
    const obs = obsMatches[0]!;
    if (obs.step !== b.step || obs.action !== b.action || obs.messageId !== b.messageId) {
      return {
        ok: false,
        reason: `Clean-control delivery observation at trace index ${b.traceIndex} does not match trace metadata`,
      };
    }
    if (obs.payloadValid !== true) {
      return {
        ok: false,
        reason: `Experiment includes malformed message payload at step ${obs.step + 1} (${obs.messageId}); positive business-state regression capture requires valid trading message payloads`,
      };
    }
    if (obs.status !== 'accepted' && obs.status !== 'rejected') {
      return {
        ok: false,
        reason: `Clean-control delivery at step ${obs.step + 1} (${obs.messageId}) ended with status '${obs.status}'`,
      };
    }
    if (
      typeof obs.messageType !== 'string' ||
      !SUPPORTED_MESSAGE_TYPES.has(obs.messageType as SupportedRegressionMessageType)
    ) {
      return {
        ok: false,
        reason: `Unsupported message type '${String(obs.messageType)}' at step ${obs.step + 1} (${obs.messageId})`,
      };
    }
    const messageType = obs.messageType as SupportedRegressionMessageType;

    const currentTrace = trace[b.traceIndex]!;
    const parsedState = parseTargetStateSnapshot(currentTrace.state);
    if (!parsedState) {
      return {
        ok: false,
        reason: `Clean-control state snapshot at trace index ${b.traceIndex} is missing required trading fields`,
      };
    }

    const previousState =
      b.traceIndex === 0
        ? INITIAL_BUSINESS_STATE
        : parseTargetStateSnapshot(trace[b.traceIndex - 1]!.state);
    if (!previousState) {
      return {
        ok: false,
        reason: `Clean-control state snapshot prior to trace index ${b.traceIndex} is unreadable`,
      };
    }

    if (
      (obs.usedCredit !== undefined && obs.usedCredit !== parsedState.usedCredit) ||
      (obs.reservedCredit !== undefined && obs.reservedCredit !== parsedState.reservedCredit) ||
      (obs.creditLimit !== undefined && obs.creditLimit !== parsedState.creditLimit?.limit)
    ) {
      return {
        ok: false,
        reason: `Clean-control delivery observation credit fields at trace index ${b.traceIndex} do not match target state`,
      };
    }

    const targetOrderId = extractTargetOrderId(b.payload);
    if (messageType === 'new_order') {
      if (obs.status === 'rejected' && targetOrderId && !(targetOrderId in parsedState.orders)) {
        rejectedNewOrderIds.add(targetOrderId);
      } else if (obs.status === 'accepted' && targetOrderId && targetOrderId in parsedState.orders) {
        rejectedNewOrderIds.delete(targetOrderId);
      }
    }

    const stateUnchangedFromPrevious = obs.status === 'rejected';
    if (stateUnchangedFromPrevious && !same(parsedState, previousState)) {
      return {
        ok: false,
        reason: `Clean-control rejected delivery at step ${obs.step + 1} (${obs.messageId}) unexpectedly mutated state`,
      };
    }

    const absentOrderIds = [...rejectedNewOrderIds]
      .filter(id => !(id in parsedState.orders))
      .sort();

    const expectedState: RegressionBusinessStateExpectation = {
      quote: parsedState.quote,
      creditLimit: parsedState.creditLimit,
      reservedCredit: parsedState.reservedCredit,
      usedCredit: parsedState.usedCredit,
      orders: parsedState.orders,
      absentOrderIds,
      stateUnchangedFromPrevious,
    };

    const id = `delivery-${b.traceIndex}-${b.messageId}`;
    const label = `Step ${obs.step + 1} (${obs.action} ${obs.messageId}, ${messageType}): expected ${obs.status}${obs.reason ? ` (${obs.reason})` : ''}`;

    deliveries.push({
      id,
      label,
      traceIndex: b.traceIndex,
      step: obs.step,
      action: obs.action,
      messageId: obs.messageId,
      channel: obs.channel,
      messageType,
      payloadValid: true,
      expectedStatus: obs.status,
      ...(obs.status === 'rejected' && typeof obs.reason === 'string' && obs.reason
        ? { expectedReason: obs.reason }
        : {}),
      ...(targetOrderId ? { targetOrderId } : {}),
      expectedState,
    });
  }

  const finalSnapshotTarget = object(cleanResult.snapshot) ? cleanResult.snapshot.target : null;
  const parsedFinal = parseTargetStateSnapshot(finalSnapshotTarget);
  const lastTraceState = parseTargetStateSnapshot(trace[trace.length - 1]!.state);
  if (!parsedFinal || !lastTraceState || !same(parsedFinal, lastTraceState)) {
    return {
      ok: false,
      reason: 'Clean-control final target snapshot is missing or inconsistent with final trace state',
    };
  }

  const finalAbsentOrderIds = [...rejectedNewOrderIds]
    .filter(id => !(id in parsedFinal.orders))
    .sort();

  const finalState: RegressionBusinessStateExpectation = {
    quote: parsedFinal.quote,
    creditLimit: parsedFinal.creditLimit,
    reservedCredit: parsedFinal.reservedCredit,
    usedCredit: parsedFinal.usedCredit,
    orders: parsedFinal.orders,
    absentOrderIds: finalAbsentOrderIds,
    stateUnchangedFromPrevious: false,
  };

  return {
    ok: true,
    expected: {
      referenceProvenance: {
        kind: 'clean-control-reference',
        referenceVariant: 'clean',
        referenceSourceHash: cleanResult.sourceHash,
        reviewLabel: 'Proposed reference behavior from clean control — requires engineer review',
        note: 'Expected outcomes were derived deterministically from the clean-control execution of the original experiment and require explicit engineer review before saving. Clean-control behavior is a reference implementation baseline, not an independently proved universal specification.',
      },
      traceLength: trace.length,
      traceBindings,
      deliveries,
      finalState,
    },
  };
}

export function evaluateRegressionExecution(
  definition: {
    experiment: Experiment;
    expected: RegressionExpectedOutcomes;
    origin: {
      experimentIndex: number;
      systemSnapshot: SystemBriefSnapshot;
      finding: {
        id: string;
        violation: { id: string; invariant: string; category?: string };
      };
    };
  },
  result: ExperimentResult,
  expectedSourceHash: string,
  variant: TargetVariant,
): RegressionEvaluationResult {
  const assertions: FunctionalAssertionResult[] = [];

  function check(
    id: string,
    expected: unknown,
    actual: unknown,
    status: FunctionalAssertionStatus,
    detail: string,
    step?: number,
    traceIndex?: number,
    messageId?: string,
    milestone?: string,
  ): void {
    assertions.push({
      id,
      name: id,
      milestone: milestone ?? id.split('.')[0],
      status,
      expected: JSON.stringify(expected) ?? 'unavailable',
      actual: JSON.stringify(actual) ?? 'unavailable',
      detail,
      evidence: {
        expected,
        actual: actual ?? null,
        detail,
        step,
        traceIndex,
        messageId,
      },
    });
  }

  const trace = Array.isArray(result.trace) ? result.trace : [];
  const observations = Array.isArray(result.deliveryObservations) ? result.deliveryObservations : [];
  const rejections = Array.isArray(result.rejections) ? result.rejections : [];
  const violations = Array.isArray(result.violations) ? result.violations : [];

  const provenanceMatches =
    result.sourceHash === expectedSourceHash && same(result.experiment, definition.experiment);
  check(
    'execution.identity',
    { sourceHash: expectedSourceHash, experiment: definition.experiment },
    { sourceHash: result.sourceHash, experiment: result.experiment },
    provenanceMatches ? 'pass' : 'inconclusive',
    provenanceMatches
      ? 'Selected target source and pinned experiment sequence matched'
      : 'Executed source or experiment sequence did not match the selected target and regression definition',
  );

  check(
    'execution.complete',
    true,
    result.executionComplete ?? null,
    result.executionComplete === true ? 'pass' : 'inconclusive',
    result.executionComplete === true
      ? 'Execution completed'
      : 'Execution completion was not recorded',
  );

  check(
    'execution.valid',
    true,
    result.valid === true && rejections.length === 0,
    result.valid === true && rejections.length === 0 ? 'pass' : 'invalid',
    result.valid === true && rejections.length === 0
      ? 'All harness commands were valid'
      : 'Harness command rejection makes the execution invalid rather than a business pass/fail',
  );

  const evidenceArraysPresent =
    Array.isArray(result.trace) &&
    Array.isArray(result.deliveryObservations) &&
    Array.isArray(result.rejections) &&
    Array.isArray(result.violations);
  check(
    'execution.evidence',
    'Trace, delivery, rejection and oracle arrays',
    evidenceArraysPresent ? 'present' : 'missing',
    evidenceArraysPresent ? 'pass' : 'inconclusive',
    'Required evidence collections must be recorded',
  );

  check(
    'execution.trace-length',
    definition.expected.traceLength,
    trace.length,
    trace.length === definition.expected.traceLength ? 'pass' : 'inconclusive',
    trace.length === definition.expected.traceLength
      ? 'Trace length matched expected sequence'
      : 'Trace length differed from expected sequence; not all expected trace steps were reached cleanly',
  );

  check(
    'execution.delivery-count',
    definition.expected.deliveries.length,
    observations.length,
    observations.length === definition.expected.deliveries.length ? 'pass' : 'inconclusive',
    observations.length === definition.expected.deliveries.length
      ? 'Delivery observation count matched expected deliveries'
      : 'Delivery observation count differed from expected deliveries',
  );

  // Verify every trace step binding
  for (const b of definition.expected.traceBindings) {
    const stepRejected = rejections.some(r => r.step === b.step);
    const entry = trace[b.traceIndex];
    const stepDefinition = definition.experiment.steps[b.step];
    const singleEntryAction = stepDefinition && stepDefinition.op !== 'drain';
    const entriesAtStep = trace.filter(t => t.step === b.step);

    const payloadMatches = b.payload === undefined || (entry !== undefined && same(entry.payload, b.payload));
    const messageMatches = b.messageId === undefined ? entry?.messageId === undefined : entry?.messageId === b.messageId;
    const isDelivery = b.action === 'deliver' || b.action === 'drain:deliver';
    const outcomeMatches = isDelivery
      ? Boolean(
          entry &&
            (entry.outcome.startsWith('delivered:processed') ||
              entry.outcome.startsWith('delivered:rejected (')),
        )
      : entry?.outcome === b.expectedOutcome;

    const bound =
      Boolean(entry) &&
      entry!.step === b.step &&
      entry!.action === b.action &&
      messageMatches &&
      payloadMatches &&
      (!singleEntryAction || entriesAtStep.length === 1) &&
      outcomeMatches;

    check(
      `sequence.trace-${b.traceIndex}`,
      {
        traceIndex: b.traceIndex,
        step: b.step,
        action: b.action,
        ...(b.messageId ? { messageId: b.messageId } : {}),
        ...(isDelivery ? {} : { expectedOutcome: b.expectedOutcome }),
      },
      entry
        ? {
            traceIndex: b.traceIndex,
            step: entry.step,
            action: entry.action,
            ...(entry.messageId ? { messageId: entry.messageId } : {}),
            outcome: entry.outcome,
          }
        : null,
      stepRejected || (entry && entry.outcome.startsWith('rejected:'))
        ? 'invalid'
        : bound
          ? 'pass'
          : 'inconclusive',
      stepRejected
        ? `Harness rejected command at step ${b.step + 1}`
        : bound
          ? `Trace entry ${b.traceIndex} matched step ${b.step + 1} (${b.action})`
          : `Trace entry ${b.traceIndex} did not match expected step ${b.step + 1} (${b.action}) binding`,
      b.step,
      b.traceIndex,
      b.messageId,
      'sequence',
    );
  }

  // Verify every reviewed delivery expectation and business state
  for (const d of definition.expected.deliveries) {
    const milestoneId = d.id;
    const stepRejected = rejections.some(r => r.step === d.step);
    const traceEntry = trace[d.traceIndex];
    const expectedBinding = definition.expected.traceBindings[d.traceIndex];
    const obsAtTrace = observations.filter(o => o.traceIndex === d.traceIndex);
    const obsAtStep =
      d.action === 'deliver' ? observations.filter(o => o.step === d.step) : obsAtTrace;
    const obs = obsAtTrace.length === 1 && obsAtStep.length === 1 ? obsAtTrace[0] : undefined;

    const traceAligned =
      Boolean(traceEntry) &&
      traceEntry!.step === d.step &&
      traceEntry!.action === d.action &&
      traceEntry!.messageId === d.messageId &&
      (expectedBinding?.payload === undefined || same(traceEntry!.payload, expectedBinding.payload));

    const obsAligned =
      Boolean(obs) &&
      obs!.step === d.step &&
      obs!.action === d.action &&
      obs!.messageId === d.messageId &&
      obs!.channel === d.channel &&
      obs!.messageType === d.messageType &&
      obs!.payloadValid === true &&
      (obs!.status === 'accepted' || obs!.status === 'rejected');

    const traceOutcomeMatchesObs =
      Boolean(traceEntry && obs) &&
      ((obs!.status === 'accepted' && traceEntry!.outcome === 'delivered:processed') ||
        (obs!.status === 'rejected' &&
          traceEntry!.outcome === `delivered:rejected (${obs!.reason ?? ''})`));

    const parsedState = traceEntry ? parseTargetStateSnapshot(traceEntry.state) : null;
    const obsCreditMatchesState =
      Boolean(obs && parsedState) &&
      (obs!.usedCredit === undefined || obs!.usedCredit === parsedState!.usedCredit) &&
      (obs!.reservedCredit === undefined || obs!.reservedCredit === parsedState!.reservedCredit) &&
      (obs!.creditLimit === undefined || obs!.creditLimit === parsedState!.creditLimit?.limit);

    const bindingReady =
      !stepRejected &&
      traceAligned &&
      obsAligned &&
      traceOutcomeMatchesObs &&
      Boolean(parsedState) &&
      obsCreditMatchesState;

    check(
      `delivery.${d.traceIndex}.${d.messageId}.binding`,
      {
        traceIndex: d.traceIndex,
        step: d.step,
        action: d.action,
        messageId: d.messageId,
        channel: d.channel,
        messageType: d.messageType,
        payloadValid: true,
      },
      obs
        ? {
            traceIndex: obs.traceIndex,
            step: obs.step,
            action: obs.action,
            messageId: obs.messageId,
            channel: obs.channel,
            messageType: obs.messageType,
            payloadValid: obs.payloadValid,
            status: obs.status,
            statePresent: Boolean(parsedState),
            obsCreditMatchesState,
          }
        : null,
      stepRejected ? 'invalid' : bindingReady ? 'pass' : 'inconclusive',
      stepRejected
        ? `Harness rejected delivery at step ${d.step + 1}`
        : bindingReady
          ? `Delivery observation and state snapshot bound at trace index ${d.traceIndex}`
          : `Delivery observation or state snapshot at trace index ${d.traceIndex} is missing, ambiguous, invalid or inconsistent`,
      d.step,
      d.traceIndex,
      d.messageId,
      milestoneId,
    );

    if (!bindingReady || !obs || !parsedState) {
      check(
        `delivery.${d.traceIndex}.${d.messageId}.decision`,
        {
          status: d.expectedStatus,
          ...(d.expectedReason ? { reason: d.expectedReason } : {}),
        },
        obs ? { status: obs.status, ...(obs.reason ? { reason: obs.reason } : {}) } : null,
        stepRejected ? 'invalid' : 'inconclusive',
        'Cannot evaluate delivery decision without a valid bound delivery observation',
        d.step,
        d.traceIndex,
        d.messageId,
        milestoneId,
      );
      continue;
    }

    const decisionMatches =
      d.expectedStatus === 'accepted'
        ? obs.status === 'accepted'
        : obs.status === 'rejected' &&
          (d.expectedReason ? obs.reason === d.expectedReason : Boolean(obs.reason));

    check(
      `delivery.${d.traceIndex}.${d.messageId}.decision`,
      {
        status: d.expectedStatus,
        ...(d.expectedReason ? { reason: d.expectedReason } : {}),
      },
      {
        status: obs.status,
        ...(obs.reason ? { reason: obs.reason } : {}),
      },
      decisionMatches ? 'pass' : 'fail',
      decisionMatches
        ? `${d.label} matched reviewed decision`
        : `${d.label} did not match reviewed decision (got ${obs.status}${obs.reason ? `: ${obs.reason}` : ''})`,
      d.step,
      d.traceIndex,
      d.messageId,
      milestoneId,
    );

    const expectedCreditQuote = {
      quote: d.expectedState.quote,
      creditLimit: d.expectedState.creditLimit,
      reservedCredit: d.expectedState.reservedCredit,
      usedCredit: d.expectedState.usedCredit,
    };
    const actualCreditQuote = {
      quote: parsedState.quote,
      creditLimit: parsedState.creditLimit,
      reservedCredit: parsedState.reservedCredit,
      usedCredit: parsedState.usedCredit,
    };
    const creditQuoteMatches = same(expectedCreditQuote, actualCreditQuote);

    check(
      `delivery.${d.traceIndex}.${d.messageId}.credit-quote`,
      expectedCreditQuote,
      actualCreditQuote,
      creditQuoteMatches ? 'pass' : 'fail',
      creditQuoteMatches
        ? `Credit and quote state after ${d.messageId} matched reviewed expectations`
        : `Credit or quote state after ${d.messageId} contradicted reviewed expectations`,
      d.step,
      d.traceIndex,
      d.messageId,
      milestoneId,
    );

    const unexpectedPresentAbsentIds = d.expectedState.absentOrderIds.filter(
      id => id in parsedState.orders,
    );
    const ordersMatch =
      same(d.expectedState.orders, parsedState.orders) && unexpectedPresentAbsentIds.length === 0;

    check(
      `delivery.${d.traceIndex}.${d.messageId}.orders`,
      {
        orders: d.expectedState.orders,
        absentOrderIds: d.expectedState.absentOrderIds,
      },
      {
        orders: parsedState.orders,
        unexpectedPresentOrderIds: unexpectedPresentAbsentIds,
      },
      ordersMatch ? 'pass' : 'fail',
      ordersMatch
        ? `Order records after ${d.messageId} matched reviewed expectations`
        : `Order records after ${d.messageId} contradicted reviewed expectations`,
      d.step,
      d.traceIndex,
      d.messageId,
      milestoneId,
    );

    if (d.expectedState.stateUnchangedFromPrevious) {
      const prevState =
        d.traceIndex === 0
          ? INITIAL_BUSINESS_STATE
          : trace[d.traceIndex - 1]
            ? parseTargetStateSnapshot(trace[d.traceIndex - 1]!.state)
            : null;
      if (!prevState) {
        check(
          `delivery.${d.traceIndex}.${d.messageId}.state-unchanged`,
          true,
          null,
          'inconclusive',
          'Prior trace state was unavailable to verify unchanged state after rejection',
          d.step,
          d.traceIndex,
          d.messageId,
          milestoneId,
        );
      } else {
        const unchanged = same(parsedState, prevState);
        check(
          `delivery.${d.traceIndex}.${d.messageId}.state-unchanged`,
          prevState,
          parsedState,
          unchanged ? 'pass' : 'fail',
          unchanged
            ? `Rejected delivery ${d.messageId} preserved prior business state`
            : `Rejected delivery ${d.messageId} mutated business state`,
          d.step,
          d.traceIndex,
          d.messageId,
          milestoneId,
        );
      }
    }
  }

  // Final target snapshot verification
  const finalTargetRaw = object(result.snapshot) ? result.snapshot.target : null;
  const parsedFinal = parseTargetStateSnapshot(finalTargetRaw);
  if (!parsedFinal) {
    check(
      'final.state',
      {
        quote: definition.expected.finalState.quote,
        creditLimit: definition.expected.finalState.creditLimit,
        reservedCredit: definition.expected.finalState.reservedCredit,
        usedCredit: definition.expected.finalState.usedCredit,
        orders: definition.expected.finalState.orders,
        absentOrderIds: definition.expected.finalState.absentOrderIds,
      },
      null,
      'inconclusive',
      'Final target snapshot is missing or unreadable',
      undefined,
      undefined,
      undefined,
      'final',
    );
  } else {
    const unexpectedFinalOrders = definition.expected.finalState.absentOrderIds.filter(
      id => id in parsedFinal.orders,
    );
    const expectedFinalComparable = {
      quote: definition.expected.finalState.quote,
      creditLimit: definition.expected.finalState.creditLimit,
      reservedCredit: definition.expected.finalState.reservedCredit,
      usedCredit: definition.expected.finalState.usedCredit,
      orders: definition.expected.finalState.orders,
    };
    const finalMatches =
      same(expectedFinalComparable, parsedFinal) && unexpectedFinalOrders.length === 0;
    check(
      'final.state',
      {
        ...expectedFinalComparable,
        absentOrderIds: definition.expected.finalState.absentOrderIds,
      },
      {
        ...parsedFinal,
        unexpectedPresentOrderIds: unexpectedFinalOrders,
      },
      finalMatches ? 'pass' : 'fail',
      finalMatches
        ? 'Final target state matched reviewed expectations'
        : 'Final target state contradicted reviewed expectations',
      undefined,
      undefined,
      undefined,
      'final',
    );
  }

  // Pinned requirement rules from the definition's original system brief snapshot
  let requirementRuleResults: RequirementRuleResult[] | undefined;
  let requirementEvaluationError: string | undefined;
  if (definition.origin.systemSnapshot.brief.requirementRules?.length) {
    try {
      requirementRuleResults = evaluateRequirementRules(
        result,
        definition.origin.systemSnapshot,
        definition.origin.experimentIndex,
      );
      for (const rule of requirementRuleResults) {
        const status: FunctionalAssertionStatus =
          rule.status === 'passed'
            ? 'pass'
            : rule.status === 'failed'
              ? 'fail'
              : 'inconclusive';
        check(
          `requirements.${rule.preset}`,
          rule.requirement,
          rule.status,
          status,
          rule.evidence[0]?.detail ?? rule.status,
          undefined,
          undefined,
          undefined,
          'requirements',
        );
      }
    } catch (error) {
      requirementEvaluationError = error instanceof Error ? error.message : String(error);
      check(
        'requirements.available',
        'Requirement rule evaluation completed',
        requirementEvaluationError,
        'inconclusive',
        'Configured requirement rule evaluation was unavailable',
        undefined,
        undefined,
        undefined,
        'requirements',
      );
    }
  }

  // Oracle violation verification
  if (!Array.isArray(result.violations)) {
    check(
      'oracle.violations',
      [],
      null,
      'inconclusive',
      'Oracle violations array was not recorded',
      undefined,
      undefined,
      undefined,
      'oracle',
    );
  } else {
    const originalInvariantRecurred = violations.some(
      v => v.invariant === definition.origin.finding.violation.invariant,
    );
    check(
      'oracle.violations',
      [],
      violations.map(v => ({ id: v.id, invariant: v.invariant, step: v.step, message: v.message })),
      violations.length === 0 ? 'pass' : 'fail',
      violations.length === 0
        ? 'No oracle violations occurred'
        : originalInvariantRecurred
          ? `Original invariant '${definition.origin.finding.violation.invariant}' recurred (${violations.length} violation(s))`
          : `Oracle reported ${violations.length} violation(s): ${violations.map(v => v.invariant).join(', ')}`,
      undefined,
      undefined,
      undefined,
      'oracle',
    );
  }

  const baseStatus = aggregateFunctionalStatus(assertions.map(a => a.status));
  const status: FunctionalAssertionStatus =
    result.valid !== true || rejections.length > 0
      ? 'invalid'
      : result.executionComplete !== true && baseStatus === 'pass'
        ? 'inconclusive'
        : violations.length > 0 && baseStatus === 'pass'
          ? 'fail'
          : baseStatus;

  const passedCount = assertions.filter(a => a.status === 'pass').length;
  return {
    variant,
    sourceHash: result.sourceHash,
    expectedSourceHash,
    valid: result.valid === true,
    executionComplete: result.executionComplete === true,
    status,
    summary: `${passedCount}/${assertions.length} assertions passed (${status})`,
    experiment: result.experiment,
    trace,
    snapshot: object(result.snapshot) ? result.snapshot : {},
    deliveryObservations: observations,
    rejections,
    violations,
    ...(requirementRuleResults ? { requirementRuleResults } : {}),
    ...(requirementEvaluationError ? { requirementEvaluationError } : {}),
    assertions,
  };
}
