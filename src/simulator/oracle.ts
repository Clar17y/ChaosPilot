import type { Channel, Violation } from '../domain.ts';
import type { ProcessResult, TargetSnapshot, VenueOrder } from './types.ts';

export interface OracleTransitionContext {
  step: number;
  targetSnapshot: TargetSnapshot;
  previousSnapshot?: TargetSnapshot;
  venueOrders?: Record<string, VenueOrder>;
  action?: string;
  channel?: Channel;
  payload?: unknown;
  processResult?: ProcessResult;
  deliveredExecution?: {
    orderId: string;
    executionId: string;
    quantity?: number;
    price?: number;
    occurredAt?: number;
  };
  isDuplicateExecutionDelivery?: boolean;
  hasConflictingExecutionContent?: boolean;
}

// Public wire constraints, checked independently of the target decoder.
function wireError(channel: Channel, raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'Payload must be an object';
  const p = raw as Record<string, unknown>;
  const schemas: Record<string, { channel: Channel; strings: string[]; numbers: Record<string, [number, number]> }> = {
    quote: { channel: 'market', strings: ['id'], numbers: { version: [1, Number.MAX_SAFE_INTEGER], price: [1, 10_000_000] } },
    credit_limit: { channel: 'credit', strings: ['id'], numbers: { version: [1, Number.MAX_SAFE_INTEGER], limit: [0, 1_000_000_000] } },
    new_order: { channel: 'client', strings: ['id', 'orderId', 'quoteId'], numbers: { quantity: [1, 1_000_000] } },
    cancel_order: { channel: 'client', strings: ['id', 'orderId'], numbers: {} },
    execution: { channel: 'reports', strings: ['id', 'orderId', 'executionId'], numbers: { quantity: [1, 1_000_000], price: [1, 10_000_000], occurredAt: [0, Number.MAX_SAFE_INTEGER] } },
    cancel_ack: { channel: 'reports', strings: ['id', 'orderId'], numbers: { cancelledQuantity: [0, 1_000_000], occurredAt: [0, Number.MAX_SAFE_INTEGER] } },
  };
  const schema = Object.hasOwn(p, 'type') && typeof p.type === 'string' && Object.hasOwn(schemas, p.type) ? schemas[p.type] : undefined;
  if (!schema || schema.channel !== channel) return 'Unknown message type or wrong channel';
  for (const field of schema.strings) {
    if (!Object.hasOwn(p, field) || typeof p[field] !== 'string' || p[field].length === 0) return `Invalid ${field}`;
  }
  for (const [field, [min, max]] of Object.entries(schema.numbers)) {
    const value = p[field];
    if (!Object.hasOwn(p, field) || typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return `Invalid ${field}`;
  }
  return undefined;
}

export class Oracle {
  private readonly violations: Violation[] = [];
  private violationCounter = 0;
  private readonly acceptedExecutions = new Map<string, { quantity: number; price: number; occurredAt: number }>();
  private readonly acceptedCancels = new Map<string, { quantity: number; occurredAt: number }>();
  private readonly latestExecutionAt = new Map<string, number>();
  private readonly confirmedDeliveredFills = new Map<string, number>();

  public getViolations(): readonly Violation[] {
    return this.violations;
  }

  public recordTargetFailure(step: number, message: string): Violation {
    const violation: Violation = {
      id: `violation-${++this.violationCounter}`,
      invariant: 'input_integrity_no_mutation',
      message,
      step,
      evidence: { error: message },
    };
    this.violations.push(violation);
    return violation;
  }

  public evaluateTransition(context: OracleTransitionContext): Violation[] {
    const newViolations: Violation[] = [];
    const {
      step,
      targetSnapshot,
      previousSnapshot,
      venueOrders,
      processResult,
      deliveredExecution: executionHint,
      isDuplicateExecutionDelivery: duplicateHint,
      hasConflictingExecutionContent: conflictHint,
    } = context;

    let deliveredExecution = executionHint;
    let isDuplicateExecutionDelivery = duplicateHint ?? false;
    let hasConflictingExecutionContent = conflictHint ?? false;
    let publicError: string | undefined;
    if (context.channel !== undefined) {
      publicError = wireError(context.channel, context.payload);
      if (!publicError) {
        const p = context.payload as Record<string, unknown>;
        const orderId = p.orderId as string;
        const previousOrder = previousSnapshot && Object.hasOwn(previousSnapshot.orders, orderId)
          ? previousSnapshot.orders[orderId] : undefined;
        if (p.type === 'execution') {
          const quantity = p.quantity as number;
          const price = p.price as number;
          const occurredAt = p.occurredAt as number;
          const executionId = p.executionId as string;
          const key = JSON.stringify([orderId, executionId]);
          const prior = this.acceptedExecutions.get(key);
          deliveredExecution = { orderId, executionId, quantity, price, occurredAt };
          isDuplicateExecutionDelivery ||= prior !== undefined;
          hasConflictingExecutionContent ||= prior !== undefined && (
            quantity !== prior.quantity || price !== prior.price || occurredAt !== prior.occurredAt
          );
          if (hasConflictingExecutionContent) publicError = 'Conflicting execution business identity';
          else if (!prior) {
            const cancelledAt = this.acceptedCancels.get(orderId)?.occurredAt ?? previousOrder?.cancelledAt;
            if (!previousOrder) publicError = 'Execution references unknown order';
            else if (price !== previousOrder.price) publicError = 'Execution price differs from locked price';
            else if (quantity > previousOrder.remainingQuantity) publicError = 'Execution exceeds unreconciled quantity';
            else if (cancelledAt !== undefined && occurredAt > cancelledAt) publicError = 'Execution occurs after confirmed cancellation';
          }
          if (!publicError && processResult?.accepted && !prior) {
            this.acceptedExecutions.set(key, { quantity, price, occurredAt });
            this.latestExecutionAt.set(orderId, Math.max(this.latestExecutionAt.get(orderId) ?? 0, occurredAt));
          }
        } else if (p.type === 'cancel_ack') {
          const quantity = p.cancelledQuantity as number;
          const occurredAt = p.occurredAt as number;
          const prior = this.acceptedCancels.get(orderId);
          if (prior) {
            if (prior.quantity !== quantity || prior.occurredAt !== occurredAt) publicError = 'Conflicting cancellation business identity';
            else if (processResult?.accepted && previousSnapshot && JSON.stringify(previousSnapshot) !== JSON.stringify(targetSnapshot)) publicError = 'Repeated cancellation mutated state';
          } else {
            if (!previousOrder) publicError = 'Cancellation references unknown order';
            else if (quantity > previousOrder.remainingQuantity) publicError = 'Cancellation exceeds unreconciled quantity';
            else if (occurredAt < (this.latestExecutionAt.get(orderId) ?? 0)) publicError = 'Cancellation predates accepted execution';
          }
          if (!publicError && processResult?.accepted && !prior) this.acceptedCancels.set(orderId, { quantity, occurredAt });
        }
      }
      if (publicError && processResult?.accepted) {
        newViolations.push({
          id: `violation-${++this.violationCounter}`,
          invariant: hasConflictingExecutionContent ? 'execution_idempotency' : 'input_integrity_no_mutation',
          message: `Target accepted publicly invalid message: ${publicError}`,
          step,
          evidence: { channel: context.channel, payload: context.payload, reason: publicError },
        });
      }
    }

    // Track confirmed delivered executions from unique accepted reports
    if (!publicError && deliveredExecution && !isDuplicateExecutionDelivery && !hasConflictingExecutionContent && deliveredExecution.quantity) {
      if (processResult === undefined || processResult.accepted) {
        const currentQty = this.confirmedDeliveredFills.get(deliveredExecution.orderId) ?? 0;
        this.confirmedDeliveredFills.set(deliveredExecution.orderId, currentQty + deliveredExecution.quantity);
      }
    }

    // 1. Credit Non-Negative
    if (targetSnapshot.reservedCredit < 0) {
      newViolations.push({
        id: `violation-${++this.violationCounter}`,
        invariant: 'credit_non_negative',
        message: `Reserved credit is negative: ${targetSnapshot.reservedCredit}`,
        step,
        evidence: {
          reservedCredit: targetSnapshot.reservedCredit,
          usedCredit: targetSnapshot.usedCredit,
        },
      });
    }

    if (targetSnapshot.usedCredit < 0) {
      newViolations.push({
        id: `violation-${++this.violationCounter}`,
        invariant: 'credit_non_negative',
        message: `Used credit is negative: ${targetSnapshot.usedCredit}`,
        step,
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
          // Order newly admitted in this transition
          if (!previousSnapshot.credit) {
            newViolations.push({
              id: `violation-${++this.violationCounter}`,
              invariant: 'credit_limit_respected',
              message: `Order ${orderId} admitted without active credit limit`,
              step,
              orderId,
              evidence: { orderId },
            });
          } else {
            const prevExposure = previousSnapshot.reservedCredit + previousSnapshot.usedCredit;
            const orderNotional = order.initialQuantity * order.price;
            if (prevExposure + orderNotional > previousSnapshot.credit.limit) {
              newViolations.push({
                id: `violation-${++this.violationCounter}`,
                invariant: 'credit_limit_respected',
                message: `Order ${orderId} admitted exceeding credit limit: required exposure ${prevExposure + orderNotional} exceeds limit ${previousSnapshot.credit.limit}`,
                step,
                orderId,
                evidence: {
                  orderId,
                  limit: previousSnapshot.credit.limit,
                  previousExposure: prevExposure,
                  orderNotional,
                  totalRequired: prevExposure + orderNotional,
                },
              });
            }
          }

          if (!previousSnapshot.quote) {
            newViolations.push({
              id: `violation-${++this.violationCounter}`,
              invariant: 'credit_limit_respected',
              message: `Order ${orderId} admitted without active market quote`,
              step,
              orderId,
              evidence: { orderId, quoteId: order.quoteId },
            });
          } else if (previousSnapshot.quote.id !== order.quoteId) {
            newViolations.push({
              id: `violation-${++this.violationCounter}`,
              invariant: 'credit_limit_respected',
              message: `Order ${orderId} admitted referencing inactive quote ${order.quoteId} (active: ${previousSnapshot.quote.id})`,
              step,
              orderId,
              evidence: { orderId, quoteId: order.quoteId, activeQuoteId: previousSnapshot.quote.id },
            });
          } else if (order.price !== previousSnapshot.quote.price) {
            newViolations.push({
              id: `violation-${++this.violationCounter}`,
              invariant: 'credit_limit_respected',
              message: `Order ${orderId} locked price ${order.price} does not match active quote price ${previousSnapshot.quote.price}`,
              step,
              orderId,
              evidence: { orderId, orderPrice: order.price, quotePrice: previousSnapshot.quote.price },
            });
          }
        }
      }
    }

    // 3. Credit Exposure Consistency: Target reservation and used credit must strictly match order calculations
    let expectedReservation = 0;
    let expectedUsedCredit = 0;
    for (const order of Object.values(targetSnapshot.orders)) {
      expectedReservation += order.remainingQuantity * order.price;
      expectedUsedCredit += order.filledQuantity * order.price;
    }

    if (targetSnapshot.reservedCredit !== expectedReservation) {
      newViolations.push({
        id: `violation-${++this.violationCounter}`,
        invariant: 'credit_exposure_consistency',
        message: `Target reserved credit (${targetSnapshot.reservedCredit}) does not match expected open order reservation (${expectedReservation})`,
        step,
        evidence: {
          targetReservedCredit: targetSnapshot.reservedCredit,
          expectedReservation,
          difference: targetSnapshot.reservedCredit - expectedReservation,
        },
      });
    }

    if (targetSnapshot.usedCredit !== expectedUsedCredit) {
      newViolations.push({
        id: `violation-${++this.violationCounter}`,
        invariant: 'credit_exposure_consistency',
        message: `Target used credit (${targetSnapshot.usedCredit}) does not match expected fulfilled quantity valuation (${expectedUsedCredit})`,
        step,
        evidence: {
          targetUsedCredit: targetSnapshot.usedCredit,
          expectedUsedCredit,
          difference: targetSnapshot.usedCredit - expectedUsedCredit,
        },
      });
    }

    // 4. Order Quantity Conservation & Overfill Checks
    for (const order of Object.values(targetSnapshot.orders)) {
      if (order.remainingQuantity < 0) {
        newViolations.push({
          id: `violation-${++this.violationCounter}`,
          invariant: 'order_quantity_conservation',
          message: `Order ${order.orderId} remaining quantity is negative: ${order.remainingQuantity}`,
          step,
          orderId: order.orderId,
          evidence: {
            orderId: order.orderId,
            remainingQuantity: order.remainingQuantity,
          },
        });
      }

      if (order.filledQuantity < 0 || order.cancelledQuantity < 0) {
        newViolations.push({
          id: `violation-${++this.violationCounter}`,
          invariant: 'order_quantity_conservation',
          message: `Order ${order.orderId} filled or cancelled quantity is negative`,
          step,
          orderId: order.orderId,
          evidence: {
            filledQuantity: order.filledQuantity,
            cancelledQuantity: order.cancelledQuantity,
          },
        });
      }

      const totalAccounted = order.filledQuantity + order.remainingQuantity + order.cancelledQuantity;
      if (totalAccounted !== order.initialQuantity) {
        newViolations.push({
          id: `violation-${++this.violationCounter}`,
          invariant: 'order_quantity_conservation',
          message: `Order ${order.orderId} quantity conservation violated: filled(${order.filledQuantity}) + remaining(${order.remainingQuantity}) + cancelled(${order.cancelledQuantity}) = ${totalAccounted} !== initial(${order.initialQuantity})`,
          step,
          orderId: order.orderId,
          evidence: {
            orderId: order.orderId,
            initialQuantity: order.initialQuantity,
            filledQuantity: order.filledQuantity,
            remainingQuantity: order.remainingQuantity,
            cancelledQuantity: order.cancelledQuantity,
            totalAccounted,
          },
        });
      }

      if (order.filledQuantity > order.initialQuantity) {
        newViolations.push({
          id: `violation-${++this.violationCounter}`,
          invariant: 'no_overfill',
          message: `Order ${order.orderId} filled quantity (${order.filledQuantity}) exceeds initial quantity (${order.initialQuantity})`,
          step,
          orderId: order.orderId,
          evidence: {
            orderId: order.orderId,
            filledQuantity: order.filledQuantity,
            initialQuantity: order.initialQuantity,
          },
        });
      }

      const knownCancel = this.acceptedCancels.get(order.orderId);
      const expectedStatus = order.filledQuantity === order.initialQuantity
        ? 'FILLED' : order.cancelledQuantity > 0 ? 'CANCELLED' : 'OPEN';
      if (order.status !== expectedStatus || (knownCancel && (knownCancel.quantity !== order.cancelledQuantity || knownCancel.occurredAt !== order.cancelledAt))) {
        newViolations.push({
          id: `violation-${++this.violationCounter}`,
          invariant: 'lifecycle_consistency',
          message: `Order ${order.orderId} lifecycle disagrees with reconciled quantities or confirmed cancellation`,
          step,
          orderId: order.orderId,
          evidence: { status: order.status, expectedStatus, filledQuantity: order.filledQuantity,
            cancelledQuantity: order.cancelledQuantity, remainingQuantity: order.remainingQuantity,
            knownCancelledQuantity: knownCancel?.quantity },
        });
      }

      // 5. Venue Execution Integrity: Target filled quantity cannot exceed confirmed venue executions or delivered coherent reports
      const venueOrder = venueOrders ? venueOrders[order.orderId] : undefined;
      const confirmedDelivered = this.confirmedDeliveredFills.get(order.orderId) ?? 0;
      const allowedFilled = Math.max(venueOrder ? venueOrder.filledQuantity : 0, confirmedDelivered);

      if (order.filledQuantity > allowedFilled) {
        newViolations.push({
          id: `violation-${++this.violationCounter}`,
          invariant: 'venue_execution_integrity',
          message: `Target filled quantity (${order.filledQuantity}) exceeds confirmed execution quantity (${allowedFilled}) for order ${order.orderId}`,
          step,
          orderId: order.orderId,
          evidence: {
            orderId: order.orderId,
            targetFilled: order.filledQuantity,
            allowedFilled,
            venueFilled: venueOrder?.filledQuantity ?? 0,
            confirmedDelivered,
          },
        });
      }
    }

    // 6. Execution Idempotency
    if (isDuplicateExecutionDelivery && deliveredExecution && previousSnapshot) {
      const prevOrder = previousSnapshot.orders[deliveredExecution.orderId];
      const currOrder = targetSnapshot.orders[deliveredExecution.orderId];
      if (prevOrder && currOrder) {
        if (
          currOrder.filledQuantity > prevOrder.filledQuantity ||
          targetSnapshot.usedCredit > previousSnapshot.usedCredit
        ) {
          newViolations.push({
            id: `violation-${++this.violationCounter}`,
            invariant: 'execution_idempotency',
            message: `Duplicate execution '${deliveredExecution.executionId}' for order '${deliveredExecution.orderId}' resulted in state mutation`,
            step,
            orderId: deliveredExecution.orderId,
            evidence: {
              executionId: deliveredExecution.executionId,
              orderId: deliveredExecution.orderId,
              previousFilled: prevOrder.filledQuantity,
              currentFilled: currOrder.filledQuantity,
              previousUsedCredit: previousSnapshot.usedCredit,
              currentUsedCredit: targetSnapshot.usedCredit,
            },
          });
        }
      }
    }

    if (hasConflictingExecutionContent && deliveredExecution && previousSnapshot) {
      const prevOrder = previousSnapshot.orders[deliveredExecution.orderId];
      const currOrder = targetSnapshot.orders[deliveredExecution.orderId];
      if (
        (currOrder && prevOrder && currOrder.filledQuantity !== prevOrder.filledQuantity) ||
        targetSnapshot.usedCredit !== previousSnapshot.usedCredit
      ) {
        newViolations.push({
          id: `violation-${++this.violationCounter}`,
          invariant: 'execution_idempotency',
          message: `Conflicting execution '${deliveredExecution.executionId}' for order '${deliveredExecution.orderId}' resulted in state mutation`,
          step,
          orderId: deliveredExecution.orderId,
          evidence: {
            executionId: deliveredExecution.executionId,
            orderId: deliveredExecution.orderId,
          },
        });
      }
    }

    // 7. Version Monotonicity check against previous snapshot
    if (previousSnapshot) {
      if (
        previousSnapshot.quote &&
        targetSnapshot.quote &&
        targetSnapshot.quote.version < previousSnapshot.quote.version
      ) {
        newViolations.push({
          id: `violation-${++this.violationCounter}`,
          invariant: 'version_monotonicity',
          message: `Quote version regressed from ${previousSnapshot.quote.version} to ${targetSnapshot.quote.version}`,
          step,
          evidence: {
            previousVersion: previousSnapshot.quote.version,
            currentVersion: targetSnapshot.quote.version,
          },
        });
      }

      if (
        previousSnapshot.quote &&
        targetSnapshot.quote &&
        targetSnapshot.quote.version === previousSnapshot.quote.version
      ) {
        if (
          targetSnapshot.quote.price !== previousSnapshot.quote.price ||
          targetSnapshot.quote.id !== previousSnapshot.quote.id
        ) {
          newViolations.push({
            id: `violation-${++this.violationCounter}`,
            invariant: 'version_monotonicity',
            message: `Quote mutated on same version ${previousSnapshot.quote.version}`,
            step,
            evidence: {
              version: previousSnapshot.quote.version,
              previousPrice: previousSnapshot.quote.price,
              currentPrice: targetSnapshot.quote.price,
            },
          });
        }
      }

      if (
        previousSnapshot.credit &&
        targetSnapshot.credit &&
        targetSnapshot.credit.version < previousSnapshot.credit.version
      ) {
        newViolations.push({
          id: `violation-${++this.violationCounter}`,
          invariant: 'version_monotonicity',
          message: `Credit version regressed from ${previousSnapshot.credit.version} to ${targetSnapshot.credit.version}`,
          step,
          evidence: {
            previousVersion: previousSnapshot.credit.version,
            currentVersion: targetSnapshot.credit.version,
          },
        });
      }

      if (
        previousSnapshot.credit &&
        targetSnapshot.credit &&
        targetSnapshot.credit.version === previousSnapshot.credit.version
      ) {
        if (targetSnapshot.credit.limit !== previousSnapshot.credit.limit) {
          newViolations.push({
            id: `violation-${++this.violationCounter}`,
            invariant: 'version_monotonicity',
            message: `Credit limit mutated on same version ${previousSnapshot.credit.version}`,
            step,
            evidence: {
              version: previousSnapshot.credit.version,
              previousLimit: previousSnapshot.credit.limit,
              currentLimit: targetSnapshot.credit.limit,
            },
          });
        }
      }
    }

    // 8. Input Integrity / No-Mutation on Rejection
    if (previousSnapshot && processResult && !processResult.accepted) {
      const isMutated =
        targetSnapshot.reservedCredit !== previousSnapshot.reservedCredit ||
        targetSnapshot.usedCredit !== previousSnapshot.usedCredit ||
        JSON.stringify(targetSnapshot.quote) !== JSON.stringify(previousSnapshot.quote) ||
        JSON.stringify(targetSnapshot.credit) !== JSON.stringify(previousSnapshot.credit) ||
        JSON.stringify(targetSnapshot.orders) !== JSON.stringify(previousSnapshot.orders);

      if (isMutated) {
        newViolations.push({
          id: `violation-${++this.violationCounter}`,
          invariant: 'input_integrity_no_mutation',
          message: `Target state mutated after rejected message (${processResult.reason ?? 'unknown reason'})`,
          step,
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

    for (const v of newViolations) {
      this.violations.push(v);
    }

    return newViolations;
  }
}
