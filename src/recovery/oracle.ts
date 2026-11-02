import { createHash } from 'node:crypto';
import type { Channel, Violation } from '../domain.ts';
import { canonicalJson } from '../evidence.ts';
import type { ExecutionReportPayload, VenueOrder } from '../simulator/types.ts';
import { RECOVERY_DEADLINE_TICKS } from './contract.ts';
import {
  isRecoveryEvaluatorIdentity,
  type RecoveryEvaluatorIdentity,
  type RecoveryEvidence,
  type RecoveryFacts,
  type RecoveryIngress,
  type RecoveryObligation,
  type RecoveryProcessResult,
  type RecoveryRetryCheck,
  type RecoverySnapshot,
  type RecoveryStatus,
} from './types.ts';

export { isRecoveryEvaluatorIdentity };

const RECOVERY_EVALUATOR_DESCRIPTOR = {
  id: 'recovery-oracle-v2',
  version: 2 as const,
  deadlineTicks: RECOVERY_DEADLINE_TICKS,
  schemaVersion: 1 as const,
};

export const RECOVERY_EVALUATOR_IDENTITY: RecoveryEvaluatorIdentity = {
  id: RECOVERY_EVALUATOR_DESCRIPTOR.id,
  version: RECOVERY_EVALUATOR_DESCRIPTOR.version,
  hash: createHash('sha256').update(canonicalJson(RECOVERY_EVALUATOR_DESCRIPTOR)).digest('hex'),
};

export function getRecoveryEvaluatorIdentity(): RecoveryEvaluatorIdentity {
  return { ...RECOVERY_EVALUATOR_IDENTITY };
}

export function recoveryEvaluatorAvailable(identity?: unknown): boolean {
  if (identity === undefined) return true;
  if (!isRecoveryEvaluatorIdentity(identity)) return false;
  return (
    identity.id === RECOVERY_EVALUATOR_IDENTITY.id &&
    identity.version === RECOVERY_EVALUATOR_IDENTITY.version &&
    identity.hash === RECOVERY_EVALUATOR_IDENTITY.hash
  );
}

interface ExpectedOrderState {
  orderId: string;
  quoteId: string;
  price: number;
  initialQuantity: number;
}

interface AcceptedReportRecord {
  key: string;
  report: ExecutionReportPayload;
  acceptedTick: number;
  disconnected: boolean;
}

function extractExecutionReportPayload(raw: unknown): ExecutionReportPayload | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  if (
    p['type'] === 'execution' &&
    typeof p['id'] === 'string' &&
    typeof p['orderId'] === 'string' &&
    typeof p['executionId'] === 'string' &&
    typeof p['quantity'] === 'number' &&
    Number.isSafeInteger(p['quantity']) &&
    typeof p['price'] === 'number' &&
    Number.isSafeInteger(p['price']) &&
    typeof p['occurredAt'] === 'number' &&
    Number.isSafeInteger(p['occurredAt'])
  ) {
    return {
      type: 'execution',
      id: p['id'],
      orderId: p['orderId'],
      executionId: p['executionId'],
      quantity: p['quantity'],
      price: p['price'],
      occurredAt: p['occurredAt'],
    };
  }
  return undefined;
}

function wireError(channel: Channel, raw: unknown, currentTick: number): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'Payload must be an object';
  const p = raw as Record<string, unknown>;
  if (p['type'] === 'cancel_order' || p['type'] === 'cancel_ack') {
    return 'Cancellation messages are unsupported in recovery v1';
  }
  const schemas: Record<string, { channel: Channel; strings: string[]; numbers: Record<string, [number, number]> }> = {
    quote: { channel: 'market', strings: ['id'], numbers: { version: [1, Number.MAX_SAFE_INTEGER], price: [1, 10_000_000] } },
    credit_limit: { channel: 'credit', strings: ['id'], numbers: { version: [1, Number.MAX_SAFE_INTEGER], limit: [0, 1_000_000_000] } },
    new_order: { channel: 'client', strings: ['id', 'orderId', 'quoteId'], numbers: { quantity: [1, 1_000_000] } },
    execution: { channel: 'reports', strings: ['id', 'orderId', 'executionId'], numbers: { quantity: [1, 1_000_000], price: [1, 10_000_000], occurredAt: [0, currentTick] } },
  };
  const typeVal = p['type'];
  const schema = typeof typeVal === 'string' && Object.hasOwn(schemas, typeVal) ? schemas[typeVal] : undefined;
  if (!schema || schema.channel !== channel) return 'Unknown message type or wrong channel';
  for (const field of schema.strings) {
    const val = p[field];
    if (!Object.hasOwn(p, field) || typeof val !== 'string' || val.trim().length === 0) return `Invalid ${field}`;
  }
  for (const [field, [min, max]] of Object.entries(schema.numbers)) {
    const value = p[field];
    if (!Object.hasOwn(p, field) || typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      return `Invalid ${field}`;
    }
  }
  return undefined;
}

export class RecoveryOracle {
  private readonly violations: Violation[] = [];
  private violationCounter = 0;
  private readonly expectedOrders = new Map<string, ExpectedOrderState>();
  private readonly acceptedReports = new Map<string, AcceptedReportRecord>();
  private readonly confirmedDeliveredFills = new Map<string, number>();
  private readonly ingress: RecoveryIngress[] = [];
  private readonly obligations: RecoveryObligation[] = [];
  private readonly retries: RecoveryRetryCheck[] = [];
  private hasTargetException = false;

  public getViolations(): readonly Violation[] {
    return this.violations;
  }

  private pushViolation(v: Omit<Violation, 'id' | 'category'> & { category?: string }): Violation {
    const violation: Violation = {
      id: `violation-${++this.violationCounter}`,
      category: v.category ?? v.invariant,
      ...v,
    };
    this.violations.push(violation);
    return violation;
  }

  public recordTargetFailure(step: number, message: string): Violation {
    this.hasTargetException = true;
    return this.pushViolation({
      invariant: 'input_integrity_no_mutation',
      category: 'input_integrity_no_mutation',
      message,
      step,
      evidence: { error: message },
    });
  }

  private computeExpectedFacts(orderId: string): RecoveryFacts {
    const order = this.expectedOrders.get(orderId);
    // Both ledgers update together for each accepted original business identity.
    const orderFilled = this.confirmedDeliveredFills.get(orderId) ?? 0;
    const orderRemaining = order ? order.initialQuantity - orderFilled : 0;

    let reservedCredit = 0;
    let usedCredit = 0;
    for (const o of this.expectedOrders.values()) {
      const filled = this.confirmedDeliveredFills.get(o.orderId) ?? 0;
      const remaining = o.initialQuantity - filled;
      reservedCredit += remaining * o.price;
      usedCredit += filled * o.price;
    }

    return {
      filledQuantity: orderFilled,
      remainingQuantity: orderRemaining,
      reservedCredit,
      usedCredit,
      applicationCount: 1,
    };
  }

  private computeObservedFacts(snapshot: RecoverySnapshot, orderId: string, key: string, maxTick?: number): RecoveryFacts {
    const order = snapshot.orders[orderId];
    const acceptedRec = this.acceptedReports.get(key);
    const matchingApps = snapshot.applications.filter((app) => {
      if (app.key !== key) return false;
      if (maxTick !== undefined && app.tick > maxTick) return false;
      if (!acceptedRec) return true;
      return (
        app.report.orderId === acceptedRec.report.orderId &&
        app.report.executionId === acceptedRec.report.executionId &&
        app.report.quantity === acceptedRec.report.quantity &&
        app.report.price === acceptedRec.report.price &&
        app.report.occurredAt === acceptedRec.report.occurredAt &&
        app.tick >= acceptedRec.acceptedTick
      );
    });

    return {
      filledQuantity: order ? order.filledQuantity : 0,
      remainingQuantity: order ? order.remainingQuantity : 0,
      reservedCredit: snapshot.reservedCredit,
      usedCredit: snapshot.usedCredit,
      applicationCount: matchingApps.length,
    };
  }

  private isObligationReconciled(snapshot: RecoverySnapshot, expected: RecoveryFacts, observed: RecoveryFacts): boolean {
    if (
      observed.applicationCount !== 1 ||
      observed.filledQuantity !== expected.filledQuantity ||
      observed.remainingQuantity !== expected.remainingQuantity ||
      observed.reservedCredit !== expected.reservedCredit ||
      observed.usedCredit !== expected.usedCredit
    ) {
      return false;
    }

    // Verify every known order matches its expected quantities so credit cannot be spoofed across orders.
    for (const o of this.expectedOrders.values()) {
      const actualOrder = snapshot.orders[o.orderId];
      if (!actualOrder) return false;
      const expectedFilled = this.confirmedDeliveredFills.get(o.orderId) ?? 0;
      const expectedRemaining = o.initialQuantity - expectedFilled;
      if (actualOrder.filledQuantity !== expectedFilled || actualOrder.remainingQuantity !== expectedRemaining) {
        return false;
      }
    }

    return true;
  }

  public onReconnect(tick: number, traceIndex: number, snapshot: RecoverySnapshot): void {
    for (const ob of this.obligations) {
      if (ob.reconnectTick === undefined) {
        ob.reconnectTick = tick;
        ob.deadlineTick = tick + RECOVERY_DEADLINE_TICKS;
        ob.checkedTick = tick;
        ob.checkTraceIndex = traceIndex;
        ob.expected = this.computeExpectedFacts(ob.report.orderId);
        ob.observed = this.computeObservedFacts(snapshot, ob.report.orderId, ob.key, tick);
        if (!ob.deadlineMissed && this.isObligationReconciled(snapshot, ob.expected, ob.observed)) {
          ob.completionTick = tick;
          ob.status = 'passed';
        }
      }
    }
  }

  public nextPendingDeadlineTick(afterTick: number, upToTick: number): number | undefined {
    let earliest: number | undefined;
    for (const ob of this.obligations) {
      if (
        ob.deadlineTick !== undefined &&
        !ob.deadlineMissed &&
        ob.completionTick === undefined &&
        ob.deadlineTick > afterTick &&
        ob.deadlineTick <= upToTick
      ) {
        if (earliest === undefined || ob.deadlineTick < earliest) {
          earliest = ob.deadlineTick;
        }
      }
    }
    return earliest;
  }

  public onTargetWork(
    step: number,
    tick: number,
    traceIndex: number,
    previousSnapshot: RecoverySnapshot,
    targetSnapshot: RecoverySnapshot,
    venueOrders: Record<string, VenueOrder>,
  ): void {
    this.evaluateStateInvariants(step, previousSnapshot, targetSnapshot, venueOrders);
    for (const ob of this.obligations) {
      if (ob.reconnectTick !== undefined && !ob.deadlineMissed && ob.completionTick === undefined) {
        const expected = this.computeExpectedFacts(ob.report.orderId);
        const observed = this.computeObservedFacts(targetSnapshot, ob.report.orderId, ob.key, tick);
        ob.checkedTick = tick;
        ob.checkTraceIndex = traceIndex;
        ob.expected = expected;
        ob.observed = observed;
        if (ob.deadlineTick !== undefined && tick <= ob.deadlineTick && this.isObligationReconciled(targetSnapshot, expected, observed)) {
          ob.completionTick = tick;
          ob.status = 'passed';
        }
      }
    }
  }

  public checkDeadlinesAt(
    step: number,
    tick: number,
    traceIndex: number,
    snapshot: RecoverySnapshot,
  ): RecoveryObligation[] {
    const newlyMissed: RecoveryObligation[] = [];
    for (const ob of this.obligations) {
      if (ob.deadlineTick === undefined || tick < ob.deadlineTick) continue;

      if (!ob.deadlineMissed && ob.completionTick === undefined) {
        const expected = this.computeExpectedFacts(ob.report.orderId);
        const observed = this.computeObservedFacts(snapshot, ob.report.orderId, ob.key, ob.deadlineTick);
        if (tick <= ob.deadlineTick && this.isObligationReconciled(snapshot, expected, observed)) {
          ob.completionTick = tick;
          ob.status = 'passed';
          ob.checkedTick = tick;
          ob.checkTraceIndex = traceIndex;
          ob.expected = expected;
          ob.observed = observed;
          continue;
        }

        // Deadline missed! Sticky failure.
        ob.deadlineMissed = true;
        ob.status = 'failed';
        ob.checkedTick = ob.deadlineTick;
        ob.checkTraceIndex = traceIndex;
        ob.expected = expected;
        ob.observed = observed;
        newlyMissed.push(ob);

        this.pushViolation({
          invariant: 'recovery_deadline',
          category: 'recovery_deadline',
          step,
          orderId: ob.report.orderId,
          message: `Execution report '${ob.report.executionId}' for order '${ob.report.orderId}' accepted while disconnected at tick ${ob.acceptedTick} missed recovery deadline tick ${ob.deadlineTick} after reconnect at tick ${ob.reconnectTick}`,
          evidence: {
            key: ob.key,
            orderId: ob.report.orderId,
            executionId: ob.report.executionId,
            acceptedTick: ob.acceptedTick,
            reconnectTick: ob.reconnectTick,
            deadlineTick: ob.deadlineTick,
            checkedTick: ob.checkedTick,
            expected: ob.expected,
            observed: ob.observed,
          },
        });
      }
    }
    return newlyMissed;
  }

  public evaluateDelivery(context: {
    step: number;
    tick: number;
    traceIndex: number;
    messageId: string;
    channel: Channel;
    payload: unknown;
    previousSnapshot: RecoverySnapshot;
    targetSnapshot: RecoverySnapshot;
    processResult: RecoveryProcessResult;
    targetException: boolean;
    /** The executor's own link state; target snapshots must not redefine it. */
    executorConnected: boolean;
    venueOrders: Record<string, VenueOrder>;
  }): void {
    const {
      step,
      tick,
      traceIndex,
      messageId,
      channel,
      payload,
      previousSnapshot,
      targetSnapshot,
      processResult,
      targetException,
      executorConnected,
      venueOrders,
    } = context;

    // The delivered payload was cloned by the executor before the target saw
    // it, so it is the authoritative business content. Target-returned report
    // content and duplicate claims are claims to check, never inputs.
    const extractedReport = extractExecutionReportPayload(payload);
    const isReportsOrExecution = channel === 'reports' || extractedReport !== undefined;
    const deliveredKey = extractedReport ? JSON.stringify([extractedReport.orderId, extractedReport.executionId]) : undefined;
    const oracleDuplicate = deliveredKey !== undefined && this.acceptedReports.has(deliveredKey);

    if (isReportsOrExecution) {
      this.ingress.push({
        traceIndex,
        step,
        tick,
        messageId,
        status: targetException ? 'exception' : processResult.accepted ? 'accepted' : 'rejected',
        disconnected: !executorConnected,
        duplicate: oracleDuplicate,
        ...(extractedReport ? { report: structuredClone(extractedReport) } : {}),
        ...(processResult.reason ? { reason: processResult.reason } : {}),
      });
    }

    if (extractedReport && !targetException) {
      const reported = processResult.report;
      // A rejection may echo the existing accepted report as diagnostic data;
      // only an accepted delivery claims to have accepted the delivered content.
      const reportMismatch = processResult.accepted && reported !== undefined && (
        reported.orderId !== extractedReport.orderId ||
        reported.executionId !== extractedReport.executionId ||
        reported.quantity !== extractedReport.quantity ||
        reported.price !== extractedReport.price ||
        reported.occurredAt !== extractedReport.occurredAt
      );
      const duplicateMismatch = processResult.accepted && processResult.duplicate !== undefined &&
        processResult.duplicate !== oracleDuplicate;
      if (reportMismatch || duplicateMismatch) {
        this.pushViolation({
          invariant: 'execution_idempotency',
          category: 'execution_idempotency',
          step,
          orderId: extractedReport.orderId,
          message: reportMismatch
            ? `Target returned execution report content that differs from the delivered execution '${extractedReport.executionId}' for order '${extractedReport.orderId}'`
            : `Target claimed duplicate=${String(processResult.duplicate)} for execution '${extractedReport.executionId}' for order '${extractedReport.orderId}', contradicting the recorded accepted-delivery history`,
          evidence: {
            key: deliveredKey,
            orderId: extractedReport.orderId,
            executionId: extractedReport.executionId,
            delivered: structuredClone(extractedReport),
            ...(reported ? { reported: structuredClone(reported) } : {}),
            claimedDuplicate: processResult.duplicate,
            recordedDuplicate: oracleDuplicate,
          },
        });
      }
    }

    let publicError = wireError(channel, payload, tick);
    let hasConflictingExecutionContent = false;
    let deliveredExecution: ExecutionReportPayload | undefined;

    if (!publicError) {
      const p = payload as Record<string, unknown>;
      if (p['type'] === 'new_order') {
        const orderId = p['orderId'] as string;
        const quoteId = p['quoteId'] as string;
        const quantity = p['quantity'] as number;
        if (this.expectedOrders.has(orderId) || previousSnapshot.orders[orderId]) {
          publicError = 'Duplicate order identifier';
        } else if (!previousSnapshot.quote || previousSnapshot.quote.id !== quoteId) {
          publicError = 'Quote not found or inactive';
        } else if (
          !previousSnapshot.credit ||
          previousSnapshot.reservedCredit + previousSnapshot.usedCredit + quantity * previousSnapshot.quote.price >
            previousSnapshot.credit.limit
        ) {
          publicError = 'Insufficient credit limit';
        }
        if (!publicError && processResult.accepted) {
          this.expectedOrders.set(orderId, {
            orderId,
            quoteId,
            price: previousSnapshot.quote!.price,
            initialQuantity: quantity,
          });
        }
      } else if (p['type'] === 'execution' && extractedReport) {
        deliveredExecution = extractedReport;
        const key = JSON.stringify([extractedReport.orderId, extractedReport.executionId]);
        const prior = this.acceptedReports.get(key);

        if (prior) {
          hasConflictingExecutionContent =
            extractedReport.quantity !== prior.report.quantity ||
            extractedReport.price !== prior.report.price ||
            extractedReport.occurredAt !== prior.report.occurredAt;

          const before = this.computeObservedFacts(previousSnapshot, extractedReport.orderId, key, tick);
          const after = this.computeObservedFacts(targetSnapshot, extractedReport.orderId, key, tick);
          const stateMutated =
            canonicalJson(previousSnapshot.orders) !== canonicalJson(targetSnapshot.orders) ||
            previousSnapshot.reservedCredit !== targetSnapshot.reservedCredit ||
            previousSnapshot.usedCredit !== targetSnapshot.usedCredit ||
            canonicalJson(previousSnapshot.applications) !== canonicalJson(targetSnapshot.applications);

          if (hasConflictingExecutionContent) {
            publicError = 'Conflicting execution business identity';
            const failed = Boolean(processResult.accepted) || stateMutated || targetException;
            this.retries.push({
              key,
              traceIndex,
              tick,
              status: failed ? 'failed' : 'passed',
              before,
              after,
              expected: this.computeExpectedFacts(extractedReport.orderId),
            });
            if (failed) {
              this.pushViolation({
                invariant: 'execution_idempotency',
                category: 'execution_idempotency',
                step,
                orderId: extractedReport.orderId,
                message: `Conflicting execution '${extractedReport.executionId}' for order '${extractedReport.orderId}' was accepted or mutated state`,
                evidence: {
                  key,
                  orderId: extractedReport.orderId,
                  executionId: extractedReport.executionId,
                  accepted: processResult.accepted,
                  before,
                  after,
                },
              });
            }
          } else {
            const failed = !processResult.accepted || stateMutated || targetException;
            this.retries.push({
              key,
              traceIndex,
              tick,
              status: failed ? 'failed' : 'passed',
              before,
              after,
              expected: this.computeExpectedFacts(extractedReport.orderId),
            });
            if (stateMutated) {
              this.pushViolation({
                invariant: 'execution_idempotency',
                category: 'execution_idempotency',
                step,
                orderId: extractedReport.orderId,
                message: `Duplicate execution '${extractedReport.executionId}' for order '${extractedReport.orderId}' resulted in state mutation`,
                evidence: {
                  key,
                  orderId: extractedReport.orderId,
                  executionId: extractedReport.executionId,
                  before,
                  after,
                },
              });
            }
          }
        } else {
          // First time seeing this [orderId, executionId]
          const expectedOrder = this.expectedOrders.get(extractedReport.orderId);
          const previousOrder = previousSnapshot.orders[extractedReport.orderId];
          const committedForOrder = this.confirmedDeliveredFills.get(extractedReport.orderId) ?? 0;
          if (!expectedOrder || !previousOrder) {
            publicError = 'Execution references unknown order';
          } else if (extractedReport.price !== expectedOrder.price) {
            publicError = 'Execution price differs from locked price';
          } else if (
            committedForOrder + extractedReport.quantity > expectedOrder.initialQuantity ||
            extractedReport.quantity > previousOrder.remainingQuantity
          ) {
            publicError = 'Execution exceeds unreconciled quantity';
          }

          if (!publicError && processResult.accepted) {
            const acceptedReport = structuredClone(extractedReport);
            this.acceptedReports.set(key, {
              key,
              report: acceptedReport,
              acceptedTick: tick,
              disconnected: !executorConnected,
            });
            this.confirmedDeliveredFills.set(
              acceptedReport.orderId,
              (this.confirmedDeliveredFills.get(acceptedReport.orderId) ?? 0) + acceptedReport.quantity,
            );

            if (!executorConnected) {
              const expected = this.computeExpectedFacts(acceptedReport.orderId);
              const observed = this.computeObservedFacts(targetSnapshot, acceptedReport.orderId, key, tick);
              this.obligations.push({
                key,
                report: acceptedReport,
                acceptedTick: tick,
                acceptanceTraceIndex: traceIndex,
                reconnectTick: undefined,
                deadlineTick: undefined,
                completionTick: undefined,
                deadlineMissed: false,
                status: 'inconclusive',
                checkedTick: tick,
                checkTraceIndex: traceIndex,
                expected,
                observed,
              });
            }
          }
        }
      }
    }

    if (publicError && processResult.accepted && !hasConflictingExecutionContent) {
      this.pushViolation({
        invariant: 'input_integrity_no_mutation',
        category: 'input_integrity_no_mutation',
        step,
        message: `Target accepted publicly invalid message: ${publicError}`,
        evidence: { channel, payload, reason: publicError },
      });
    }

    // Check if any rejected message mutated state
    if (!processResult.accepted && !hasConflictingExecutionContent) {
      const isMutated =
        targetSnapshot.reservedCredit !== previousSnapshot.reservedCredit ||
        targetSnapshot.usedCredit !== previousSnapshot.usedCredit ||
        canonicalJson(targetSnapshot.quote) !== canonicalJson(previousSnapshot.quote) ||
        canonicalJson(targetSnapshot.credit) !== canonicalJson(previousSnapshot.credit) ||
        canonicalJson(targetSnapshot.orders) !== canonicalJson(previousSnapshot.orders) ||
        canonicalJson(targetSnapshot.applications) !== canonicalJson(previousSnapshot.applications);
      if (isMutated) {
        this.pushViolation({
          invariant: 'input_integrity_no_mutation',
          category: 'input_integrity_no_mutation',
          step,
          message: `Target state mutated after rejected message (${processResult.reason ?? 'unknown reason'})`,
          evidence: {
            reason: processResult.reason,
            previousReserved: previousSnapshot.reservedCredit,
            currentReserved: targetSnapshot.reservedCredit,
            previousUsed: previousSnapshot.usedCredit,
            currentUsed: targetSnapshot.usedCredit,
          },
        });
      }
    }

    this.evaluateStateInvariants(step, previousSnapshot, targetSnapshot, venueOrders, deliveredExecution);
  }

  public evaluateStateInvariants(
    step: number,
    previousSnapshot: RecoverySnapshot | undefined,
    targetSnapshot: RecoverySnapshot,
    venueOrders?: Record<string, VenueOrder>,
    _deliveredExecution?: ExecutionReportPayload,
  ): void {
    // 1. Credit Non-Negative
    if (targetSnapshot.reservedCredit < 0 || targetSnapshot.usedCredit < 0) {
      this.pushViolation({
        invariant: 'credit_non_negative',
        step,
        message: `Credit balance is negative (reserved=${targetSnapshot.reservedCredit}, used=${targetSnapshot.usedCredit})`,
        evidence: {
          reservedCredit: targetSnapshot.reservedCredit,
          usedCredit: targetSnapshot.usedCredit,
        },
      });
    }

    // 2. Admission Decision & Credit Limit Respected
    if (previousSnapshot) {
      for (const [orderId, order] of Object.entries(targetSnapshot.orders)) {
        if (!previousSnapshot.orders[orderId]) {
          if (!previousSnapshot.credit) {
            this.pushViolation({
              invariant: 'credit_limit_respected',
              step,
              orderId,
              message: `Order ${orderId} admitted without active credit limit`,
              evidence: { orderId },
            });
          } else {
            const prevExposure = previousSnapshot.reservedCredit + previousSnapshot.usedCredit;
            const orderNotional = order.initialQuantity * order.price;
            if (prevExposure + orderNotional > previousSnapshot.credit.limit) {
              this.pushViolation({
                invariant: 'credit_limit_respected',
                step,
                orderId,
                message: `Order ${orderId} admitted exceeding credit limit`,
                evidence: {
                  orderId,
                  limit: previousSnapshot.credit.limit,
                  previousExposure: prevExposure,
                  orderNotional,
                },
              });
            }
          }
          if (!previousSnapshot.quote || previousSnapshot.quote.id !== order.quoteId || order.price !== previousSnapshot.quote.price) {
            this.pushViolation({
              invariant: 'credit_limit_respected',
              step,
              orderId,
              message: `Order ${orderId} admitted without matching active market quote`,
              evidence: { orderId, quoteId: order.quoteId, activeQuote: previousSnapshot.quote },
            });
          }
        }
      }
    }

    // 3. Credit Exposure Consistency
    let expectedReservation = 0;
    let expectedUsedCredit = 0;
    for (const order of Object.values(targetSnapshot.orders)) {
      expectedReservation += order.remainingQuantity * order.price;
      expectedUsedCredit += order.filledQuantity * order.price;
    }

    if (targetSnapshot.reservedCredit !== expectedReservation || targetSnapshot.usedCredit !== expectedUsedCredit) {
      this.pushViolation({
        invariant: 'credit_exposure_consistency',
        step,
        message: `Target credit (reserved=${targetSnapshot.reservedCredit}, used=${targetSnapshot.usedCredit}) does not match order valuation (reserved=${expectedReservation}, used=${expectedUsedCredit})`,
        evidence: {
          targetReservedCredit: targetSnapshot.reservedCredit,
          expectedReservation,
          targetUsedCredit: targetSnapshot.usedCredit,
          expectedUsedCredit,
        },
      });
    }

    // 4. Order Quantity Conservation, Overfill, Lifecycle, and Venue Execution Integrity
    for (const order of Object.values(targetSnapshot.orders)) {
      const totalAccounted = order.filledQuantity + order.remainingQuantity + order.cancelledQuantity;
      if (order.remainingQuantity < 0 || order.filledQuantity < 0 || order.cancelledQuantity < 0 || totalAccounted !== order.initialQuantity) {
        this.pushViolation({
          invariant: 'order_quantity_conservation',
          step,
          orderId: order.orderId,
          message: `Order ${order.orderId} quantity conservation violated`,
          evidence: {
            orderId: order.orderId,
            initialQuantity: order.initialQuantity,
            filledQuantity: order.filledQuantity,
            remainingQuantity: order.remainingQuantity,
            cancelledQuantity: order.cancelledQuantity,
          },
        });
      }

      if (order.filledQuantity > order.initialQuantity) {
        this.pushViolation({
          invariant: 'no_overfill',
          step,
          orderId: order.orderId,
          message: `Order ${order.orderId} filled quantity (${order.filledQuantity}) exceeds initial quantity (${order.initialQuantity})`,
          evidence: {
            orderId: order.orderId,
            filledQuantity: order.filledQuantity,
            initialQuantity: order.initialQuantity,
          },
        });
      }

      const expectedStatus = order.filledQuantity === order.initialQuantity ? 'FILLED' : 'OPEN';
      if (order.status !== expectedStatus) {
        this.pushViolation({
          invariant: 'lifecycle_consistency',
          step,
          orderId: order.orderId,
          message: `Order ${order.orderId} lifecycle status '${order.status}' disagrees with expected '${expectedStatus}'`,
          evidence: {
            orderId: order.orderId,
            status: order.status,
            expectedStatus,
            filledQuantity: order.filledQuantity,
            initialQuantity: order.initialQuantity,
          },
        });
      }

      const venueOrder = venueOrders ? venueOrders[order.orderId] : undefined;
      const confirmedDelivered = this.confirmedDeliveredFills.get(order.orderId) ?? 0;
      const allowedFilled = Math.max(venueOrder ? venueOrder.filledQuantity : 0, confirmedDelivered);
      if (order.filledQuantity > allowedFilled) {
        this.pushViolation({
          invariant: 'venue_execution_integrity',
          step,
          orderId: order.orderId,
          message: `Target filled quantity (${order.filledQuantity}) exceeds confirmed execution quantity (${allowedFilled}) for order ${order.orderId}`,
          evidence: {
            orderId: order.orderId,
            targetFilled: order.filledQuantity,
            allowedFilled,
          },
        });
      }
    }

    // 5. Version Monotonicity
    if (previousSnapshot) {
      if (
        previousSnapshot.quote &&
        targetSnapshot.quote &&
        (targetSnapshot.quote.version < previousSnapshot.quote.version ||
          (targetSnapshot.quote.version === previousSnapshot.quote.version &&
            (targetSnapshot.quote.price !== previousSnapshot.quote.price ||
              targetSnapshot.quote.id !== previousSnapshot.quote.id)))
      ) {
        this.pushViolation({
          invariant: 'version_monotonicity',
          step,
          message: 'Quote version monotonicity violated',
          evidence: { previousQuote: previousSnapshot.quote, currentQuote: targetSnapshot.quote },
        });
      }
      if (
        previousSnapshot.credit &&
        targetSnapshot.credit &&
        (targetSnapshot.credit.version < previousSnapshot.credit.version ||
          (targetSnapshot.credit.version === previousSnapshot.credit.version &&
            targetSnapshot.credit.limit !== previousSnapshot.credit.limit))
      ) {
        this.pushViolation({
          invariant: 'version_monotonicity',
          step,
          message: 'Credit version monotonicity violated',
          evidence: { previousCredit: previousSnapshot.credit, currentCredit: targetSnapshot.credit },
        });
      }
    }
  }

  public finalize(params: {
    horizonTick: number;
    valid: boolean;
    executionComplete: boolean;
    finalTraceIndex: number;
    finalSnapshot: RecoverySnapshot;
  }): RecoveryEvidence {
    const { horizonTick, valid, executionComplete, finalTraceIndex, finalSnapshot } = params;
    const clampedTraceIndex = Math.max(0, finalTraceIndex);

    for (const ob of this.obligations) {
      if (!valid) {
        ob.status = 'invalid';
        continue;
      }
      if (ob.deadlineMissed) {
        ob.status = 'failed';
        continue;
      }
      // An obligation already proved reconciled on time keeps that per-obligation
      // fact even when a later unrelated delivery throws; the aggregate status
      // and executionComplete below still record the exception. A later second
      // application is caught by the horizon application-count check.
      if (ob.completionTick !== undefined) {
        // Verify reconciled state still holds at horizon for the application record and credit conservation
        const observedAtHorizon = this.computeObservedFacts(finalSnapshot, ob.report.orderId, ob.key, horizonTick);
        if (observedAtHorizon.applicationCount !== 1) {
          ob.status = 'failed';
          ob.checkedTick = horizonTick;
          ob.checkTraceIndex = clampedTraceIndex;
          ob.observed = observedAtHorizon;
        } else {
          ob.status = 'passed';
        }
        continue;
      }
      if (this.hasTargetException) {
        ob.status = 'failed';
        continue;
      }

      // Neither deadlineMissed nor completed yet: check if reconciled at horizon within deadline
      if (ob.reconnectTick !== undefined && ob.deadlineTick !== undefined && horizonTick <= ob.deadlineTick) {
        const expected = this.computeExpectedFacts(ob.report.orderId);
        const observed = this.computeObservedFacts(finalSnapshot, ob.report.orderId, ob.key, horizonTick);
        ob.checkedTick = horizonTick;
        ob.checkTraceIndex = clampedTraceIndex;
        ob.expected = expected;
        ob.observed = observed;
        if (this.isObligationReconciled(finalSnapshot, expected, observed)) {
          ob.completionTick = horizonTick;
          ob.status = 'passed';
        } else {
          ob.status = 'inconclusive';
        }
      } else {
        ob.checkedTick = horizonTick;
        ob.checkTraceIndex = clampedTraceIndex;
        ob.expected = this.computeExpectedFacts(ob.report.orderId);
        ob.observed = this.computeObservedFacts(finalSnapshot, ob.report.orderId, ob.key, horizonTick);
        ob.status = 'inconclusive';
      }
    }

    let status: RecoveryStatus;
    if (!valid) {
      status = 'invalid';
    } else if (
      this.hasTargetException ||
      this.obligations.some((ob) => ob.status === 'failed') ||
      this.retries.some((r) => r.status === 'failed')
    ) {
      status = 'failed';
    } else if (this.obligations.length === 0) {
      status = 'not-exercised';
    } else if (!executionComplete || this.obligations.some((ob) => ob.status === 'inconclusive')) {
      status = 'inconclusive';
    } else {
      status = 'passed';
    }

    let idempotenceStatus: RecoveryStatus;
    if (!valid) {
      idempotenceStatus = 'invalid';
    } else if (this.hasTargetException || this.retries.some((r) => r.status === 'failed')) {
      idempotenceStatus = 'failed';
    } else if (this.retries.length === 0) {
      idempotenceStatus = 'not-exercised';
    } else {
      idempotenceStatus = 'passed';
    }

    return {
      schemaVersion: 1,
      evaluator: getRecoveryEvaluatorIdentity(),
      horizonTick,
      executionComplete: valid && executionComplete && !this.hasTargetException,
      status,
      idempotenceStatus,
      ingress: structuredClone(this.ingress),
      obligations: structuredClone(this.obligations),
      retries: structuredClone(this.retries),
    };
  }
}
