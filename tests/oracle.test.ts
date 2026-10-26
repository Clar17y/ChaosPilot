import { describe, expect, it } from 'vitest';
import { Oracle } from '../src/simulator/oracle.ts';
import type { TargetSnapshot, VenueOrder } from '../src/simulator/types.ts';

function createCleanSnapshot(overrides?: Partial<TargetSnapshot>): TargetSnapshot {
  return {
    quote: { id: 'q-1', version: 1, price: 100 },
    credit: { version: 1, limit: 10_000 },
    reservedCredit: 1_000,
    usedCredit: 0,
    orders: {
      'ord-1': {
        orderId: 'ord-1',
        quoteId: 'q-1',
        price: 100,
        initialQuantity: 10,
        remainingQuantity: 10,
        filledQuantity: 0,
        cancelledQuantity: 0,
        cancellationRequested: false,
        status: 'OPEN',
      },
    },
    ...overrides,
  };
}

describe('Independent Oracle Invariant Checks', () => {
  it('permits valid, consistent transitions with zero violations', () => {
    const oracle = new Oracle();
    const snapshot = createCleanSnapshot();
    const venueOrders: Record<string, VenueOrder> = {
      'ord-1': {
        orderId: 'ord-1',
        initialQuantity: 10,
        remainingQuantity: 10,
        filledQuantity: 0,
        cancelledQuantity: 0,
        price: 100,
      },
    };

    const violations = oracle.evaluateTransition({
      step: 0,
      targetSnapshot: snapshot,
      venueOrders,
    });

    expect(violations).toHaveLength(0);
    expect(oracle.getViolations()).toHaveLength(0);
  });

  it('detects negative reserved credit balance', () => {
    const oracle = new Oracle();
    const snapshot = createCleanSnapshot({ reservedCredit: -100 });

    const violations = oracle.evaluateTransition({
      step: 1,
      targetSnapshot: snapshot,
      venueOrders: {},
    });

    const nonNegative = violations.find((v) => v.invariant === 'credit_non_negative');
    expect(nonNegative).toBeDefined();
    expect(nonNegative?.message).toContain('Reserved credit is negative: -100');
    expect(nonNegative?.step).toBe(1);
    expect(nonNegative?.evidence).toMatchObject({ reservedCredit: -100 });
  });

  it('detects negative used credit balance', () => {
    const oracle = new Oracle();
    const snapshot = createCleanSnapshot({ usedCredit: -50 });

    const violations = oracle.evaluateTransition({
      step: 1,
      targetSnapshot: snapshot,
      venueOrders: {},
    });

    const nonNegative = violations.find((v) => v.invariant === 'credit_non_negative');
    expect(nonNegative).toBeDefined();
    expect(nonNegative?.message).toContain('Used credit is negative: -50');
  });

  it('detects credit reservation mismatch against active order commitments', () => {
    const oracle = new Oracle();
    // 10 units @ $100 = $1,000 expected reservation, but target has $800
    const snapshot = createCleanSnapshot({ reservedCredit: 800 });

    const violations = oracle.evaluateTransition({
      step: 2,
      targetSnapshot: snapshot,
      venueOrders: {},
    });

    const consistency = violations.find((v) => v.invariant === 'credit_exposure_consistency');
    expect(consistency).toBeDefined();
    expect(consistency?.evidence).toMatchObject({
      targetReservedCredit: 800,
      expectedReservation: 1000,
      difference: -200,
    });
  });

  it('detects order quantity conservation violations and negative remaining quantity', () => {
    const oracle = new Oracle();
    const snapshot = createCleanSnapshot({
      orders: {
        'ord-1': {
          orderId: 'ord-1',
          quoteId: 'q-1',
          price: 100,
          initialQuantity: 10,
          remainingQuantity: -2,
          filledQuantity: 8,
          cancelledQuantity: 0,
          cancellationRequested: false,
          status: 'OPEN',
        },
      },
      reservedCredit: -200,
      usedCredit: 800,
    });

    const violations = oracle.evaluateTransition({
      step: 3,
      targetSnapshot: snapshot,
      venueOrders: {},
    });

    const conservation = violations.filter((v) => v.invariant === 'order_quantity_conservation');
    expect(conservation.length).toBeGreaterThanOrEqual(1);
    const negRemaining = conservation.find((v) => v.message.includes('negative'));
    expect(negRemaining).toBeDefined();
    expect(negRemaining?.orderId).toBe('ord-1');
  });

  it('detects order overfill exceeding initial quantity', () => {
    const oracle = new Oracle();
    const snapshot = createCleanSnapshot({
      orders: {
        'ord-1': {
          orderId: 'ord-1',
          quoteId: 'q-1',
          price: 100,
          initialQuantity: 10,
          remainingQuantity: 0,
          filledQuantity: 15,
          cancelledQuantity: 0,
          cancellationRequested: false,
          status: 'FILLED',
        },
      },
      reservedCredit: 0,
      usedCredit: 1500,
    });

    const violations = oracle.evaluateTransition({
      step: 4,
      targetSnapshot: snapshot,
      venueOrders: {},
    });

    const overfill = violations.find((v) => v.invariant === 'no_overfill');
    expect(overfill).toBeDefined();
    expect(overfill?.evidence).toMatchObject({
      orderId: 'ord-1',
      filledQuantity: 15,
      initialQuantity: 10,
    });
  });

  it('detects target filled quantity exceeding confirmed venue executions', () => {
    const oracle = new Oracle();
    const snapshot = createCleanSnapshot({
      orders: {
        'ord-1': {
          orderId: 'ord-1',
          quoteId: 'q-1',
          price: 100,
          initialQuantity: 10,
          remainingQuantity: 5,
          filledQuantity: 5,
          cancelledQuantity: 0,
          cancellationRequested: false,
          status: 'OPEN',
        },
      },
      reservedCredit: 500,
      usedCredit: 500,
    });
    // Venue only confirmed 3 filled units, but target recorded 5 without delivered reports
    const venueOrders: Record<string, VenueOrder> = {
      'ord-1': {
        orderId: 'ord-1',
        initialQuantity: 10,
        remainingQuantity: 7,
        filledQuantity: 3,
        cancelledQuantity: 0,
        price: 100,
      },
    };

    const violations = oracle.evaluateTransition({
      step: 5,
      targetSnapshot: snapshot,
      venueOrders,
    });

    const venueIntegrity = violations.find((v) => v.invariant === 'venue_execution_integrity');
    expect(venueIntegrity).toBeDefined();
    expect(venueIntegrity?.evidence).toMatchObject({
      orderId: 'ord-1',
      targetFilled: 5,
      allowedFilled: 3,
    });
  });

  it('detects duplicate execution report redelivery mutation', () => {
    const oracle = new Oracle();
    const prevSnapshot = createCleanSnapshot({
      orders: {
        'ord-1': {
          orderId: 'ord-1',
          quoteId: 'q-1',
          price: 100,
          initialQuantity: 10,
          remainingQuantity: 5,
          filledQuantity: 5,
          cancelledQuantity: 0,
          cancellationRequested: false,
          status: 'OPEN',
        },
      },
      reservedCredit: 500,
      usedCredit: 500,
    });

    // Mutated on redelivery
    const currSnapshot = createCleanSnapshot({
      orders: {
        'ord-1': {
          orderId: 'ord-1',
          quoteId: 'q-1',
          price: 100,
          initialQuantity: 10,
          remainingQuantity: 0,
          filledQuantity: 10,
          cancelledQuantity: 0,
          cancellationRequested: false,
          status: 'FILLED',
        },
      },
      reservedCredit: 0,
      usedCredit: 1000,
    });

    const violations = oracle.evaluateTransition({
      step: 6,
      targetSnapshot: currSnapshot,
      previousSnapshot: prevSnapshot,
      venueOrders: {},
      deliveredExecution: { orderId: 'ord-1', executionId: 'exec-dup-1' },
      isDuplicateExecutionDelivery: true,
    });

    const idempotency = violations.find((v) => v.invariant === 'execution_idempotency');
    expect(idempotency).toBeDefined();
    expect(idempotency?.evidence).toMatchObject({
      orderId: 'ord-1',
      executionId: 'exec-dup-1',
      previousFilled: 5,
      currentFilled: 10,
    });
  });

  it('detects version regression on quote or credit updates', () => {
    const oracle = new Oracle();
    const prevSnapshot = createCleanSnapshot({
      quote: { id: 'q-1', version: 5, price: 100 },
      credit: { version: 4, limit: 10_000 },
    });
    const currSnapshot = createCleanSnapshot({
      quote: { id: 'q-2', version: 3, price: 105 },
      credit: { version: 4, limit: 10_000 },
    });

    const violations = oracle.evaluateTransition({
      step: 7,
      targetSnapshot: currSnapshot,
      previousSnapshot: prevSnapshot,
      venueOrders: {},
    });

    const versionMonotonicity = violations.find((v) => v.invariant === 'version_monotonicity');
    expect(versionMonotonicity).toBeDefined();
    expect(versionMonotonicity?.evidence).toMatchObject({
      previousVersion: 5,
      currentVersion: 3,
    });
  });

  it('preserves earlier transient violations across multi-step evaluation', () => {
    const oracle = new Oracle();

    // Step 1: invalid negative credit
    oracle.evaluateTransition({
      step: 1,
      targetSnapshot: createCleanSnapshot({ reservedCredit: -50 }),
      venueOrders: {},
    });

    expect(oracle.getViolations()).toHaveLength(2); // negative credit + exposure inconsistency

    // Step 2: clean step
    oracle.evaluateTransition({
      step: 2,
      targetSnapshot: createCleanSnapshot({ reservedCredit: 1000 }),
      venueOrders: {},
    });

    // Earlier violations must still be preserved in history!
    expect(oracle.getViolations()).toHaveLength(2);
    expect(oracle.getViolations()[0]?.step).toBe(1);
  });

  // --- NEW FOCUSED INDEPENDENT ORACLE CHECKS ---

  it('detects bad admission exceeding current credit limit (credit_limit_respected)', () => {
    const oracle = new Oracle();
    const prevSnapshot = createCleanSnapshot({
      credit: { version: 1, limit: 1000 },
      reservedCredit: 800,
      usedCredit: 0,
    });

    // New order ord-2 admitted for 5 @ 100 = 500 notional (total 1300 > 1000)
    const currSnapshot: TargetSnapshot = {
      ...prevSnapshot,
      reservedCredit: 1300,
      orders: {
        ...prevSnapshot.orders,
        'ord-2': {
          orderId: 'ord-2',
          quoteId: 'q-1',
          price: 100,
          initialQuantity: 5,
          remainingQuantity: 5,
          filledQuantity: 0,
          cancelledQuantity: 0,
          cancellationRequested: false,
          status: 'OPEN',
        },
      },
    };

    const violations = oracle.evaluateTransition({
      step: 8,
      targetSnapshot: currSnapshot,
      previousSnapshot: prevSnapshot,
    });

    const creditLimitRespected = violations.find((v) => v.invariant === 'credit_limit_respected');
    expect(creditLimitRespected).toBeDefined();
    expect(creditLimitRespected?.evidence).toMatchObject({
      orderId: 'ord-2',
      limit: 1000,
      previousExposure: 800,
      orderNotional: 500,
    });
  });

  it('detects wrong used credit mismatching accepted unique execution effects', () => {
    const oracle = new Oracle();
    // Target has 5 filled @ $100 -> expected used credit is 500, but target recorded 750
    const snapshot = createCleanSnapshot({
      orders: {
        'ord-1': {
          orderId: 'ord-1',
          quoteId: 'q-1',
          price: 100,
          initialQuantity: 10,
          remainingQuantity: 5,
          filledQuantity: 5,
          cancelledQuantity: 0,
          cancellationRequested: false,
          status: 'OPEN',
        },
      },
      reservedCredit: 500,
      usedCredit: 750,
    });

    const violations = oracle.evaluateTransition({
      step: 9,
      targetSnapshot: snapshot,
    });

    const consistency = violations.find(
      (v) => v.invariant === 'credit_exposure_consistency' && v.message.includes('used credit'),
    );
    expect(consistency).toBeDefined();
    expect(consistency?.evidence).toMatchObject({
      targetUsedCredit: 750,
      expectedUsedCredit: 500,
      difference: 250,
    });
  });

  it('detects same-version quote mutation (version_monotonicity)', () => {
    const oracle = new Oracle();
    const prevSnapshot = createCleanSnapshot({
      quote: { id: 'q-1', version: 2, price: 100 },
    });
    // Target mutated price from 100 to 120 while keeping version at 2
    const currSnapshot = createCleanSnapshot({
      quote: { id: 'q-1-mutated', version: 2, price: 120 },
    });

    const violations = oracle.evaluateTransition({
      step: 10,
      targetSnapshot: currSnapshot,
      previousSnapshot: prevSnapshot,
    });

    const versionMonotonicity = violations.find((v) => v.invariant === 'version_monotonicity');
    expect(versionMonotonicity).toBeDefined();
    expect(versionMonotonicity?.message).toContain('Quote mutated on same version 2');
    expect(versionMonotonicity?.evidence).toMatchObject({
      version: 2,
      previousPrice: 100,
      currentPrice: 120,
    });
  });

  it('detects state mutation following rejected message (input_integrity_no_mutation)', () => {
    const oracle = new Oracle();
    const prevSnapshot = createCleanSnapshot();
    // Target supposedly rejected the message, but mutates reserved credit
    const currSnapshot = createCleanSnapshot({ reservedCredit: 1200 });

    const violations = oracle.evaluateTransition({
      step: 11,
      targetSnapshot: currSnapshot,
      previousSnapshot: prevSnapshot,
      processResult: { accepted: false, reason: 'Malformed payload' },
    });

    const inputViolation = violations.find((v) => v.invariant === 'input_integrity_no_mutation');
    expect(inputViolation).toBeDefined();
    expect(inputViolation?.message).toContain('Target state mutated after rejected message');
  });

  it('detects conflicting duplicate business ID mutation (execution_idempotency)', () => {
    const oracle = new Oracle();
    const prevSnapshot = createCleanSnapshot({
      orders: {
        'ord-1': {
          orderId: 'ord-1',
          quoteId: 'q-1',
          price: 100,
          initialQuantity: 10,
          remainingQuantity: 5,
          filledQuantity: 5,
          cancelledQuantity: 0,
          cancellationRequested: false,
          status: 'OPEN',
        },
      },
      reservedCredit: 500,
      usedCredit: 500,
    });

    // Mutated on conflicting ID delivery
    const currSnapshot = createCleanSnapshot({
      orders: {
        'ord-1': {
          orderId: 'ord-1',
          quoteId: 'q-1',
          price: 100,
          initialQuantity: 10,
          remainingQuantity: 2,
          filledQuantity: 8,
          cancelledQuantity: 0,
          cancellationRequested: false,
          status: 'OPEN',
        },
      },
      reservedCredit: 200,
      usedCredit: 800,
    });

    const violations = oracle.evaluateTransition({
      step: 12,
      targetSnapshot: currSnapshot,
      previousSnapshot: prevSnapshot,
      deliveredExecution: { orderId: 'ord-1', executionId: 'exec-1', quantity: 3, price: 90 },
      hasConflictingExecutionContent: true,
    });

    const idempotency = violations.find((v) => v.invariant === 'execution_idempotency');
    expect(idempotency).toBeDefined();
    expect(idempotency?.message).toContain('Conflicting execution');
  });

  it('permits coherent fabricated fill without hidden venue fact with ZERO violations', () => {
    const oracle = new Oracle();
    const prevSnapshot = createCleanSnapshot();

    // Coherent fill of 4 units arrives via reports channel
    const currSnapshot = createCleanSnapshot({
      orders: {
        'ord-1': {
          orderId: 'ord-1',
          quoteId: 'q-1',
          price: 100,
          initialQuantity: 10,
          remainingQuantity: 6,
          filledQuantity: 4,
          cancelledQuantity: 0,
          cancellationRequested: false,
          status: 'OPEN',
        },
      },
      reservedCredit: 600,
      usedCredit: 400,
    });

    // Venue has no record of this fill (raw coherent injection)
    const venueOrders: Record<string, VenueOrder> = {
      'ord-1': {
        orderId: 'ord-1',
        initialQuantity: 10,
        remainingQuantity: 10,
        filledQuantity: 0,
        cancelledQuantity: 0,
        price: 100,
      },
    };

    const violations = oracle.evaluateTransition({
      step: 13,
      targetSnapshot: currSnapshot,
      previousSnapshot: prevSnapshot,
      venueOrders,
      processResult: { accepted: true },
      deliveredExecution: {
        orderId: 'ord-1',
        executionId: 'exec-fabricated-1',
        quantity: 4,
        price: 100,
        occurredAt: 5,
      },
      isDuplicateExecutionDelivery: false,
    });

    // Must NOT label coherent fabricated report a defect!
    expect(violations).toHaveLength(0);
    expect(oracle.getViolations()).toHaveLength(0);
  });
});


describe('Independent lifecycle and public report constraints', () => {
  it.each([
    { filled: 10, cancelled: 0, remaining: 0, status: 'CANCELLED', expected: 'FILLED' },
    { filled: 0, cancelled: 6, remaining: 4, status: 'OPEN', expected: 'CANCELLED' },
    { filled: 4, cancelled: 0, remaining: 6, status: 'FILLED', expected: 'OPEN' },
    { filled: 0, cancelled: 0, remaining: 10, status: 'CANCELLED', expected: 'OPEN' },
  ] as const)('detects handcrafted wrong status $status for F=$filled/C=$cancelled/R=$remaining', ({ filled, cancelled, remaining, status, expected }) => {
    const snapshot = createCleanSnapshot({ reservedCredit: remaining * 100, usedCredit: filled * 100 });
    Object.assign(snapshot.orders['ord-1']!, { filledQuantity: filled, cancelledQuantity: cancelled, remainingQuantity: remaining, status });
    const violations = new Oracle().evaluateTransition({ step: 17, targetSnapshot: snapshot,
      venueOrders: { 'ord-1': { orderId: 'ord-1', initialQuantity: 10, filledQuantity: filled, cancelledQuantity: cancelled, remainingQuantity: remaining, price: 100 } } });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ invariant: 'lifecycle_consistency', step: 17, evidence: { expectedStatus: expected } });
  });

  it('permits positive cancellation with unreconciled quantity and a zero acknowledgement with full fill in transit', () => {
    for (const cancelled of [0, 6]) {
      const previousSnapshot = createCleanSnapshot();
      const targetSnapshot = createCleanSnapshot({ reservedCredit: (10 - cancelled) * 100 });
      Object.assign(targetSnapshot.orders['ord-1']!, { cancelledQuantity: cancelled, remainingQuantity: 10 - cancelled,
        cancelledAt: 2, status: cancelled > 0 ? 'CANCELLED' : 'OPEN' });
      expect(new Oracle().evaluateTransition({ step: 1, previousSnapshot, targetSnapshot, channel: 'reports',
        payload: { type: 'cancel_ack', id: 'ack', orderId: 'ord-1', cancelledQuantity: cancelled, occurredAt: 2 },
        processResult: { accepted: true } })).toEqual([]);
    }
  });

  it('detects a known positive acknowledgement silently ignored by otherwise self-consistent target state', () => {
    const snapshot = createCleanSnapshot();
    const violations = new Oracle().evaluateTransition({ step: 1, previousSnapshot: snapshot, targetSnapshot: snapshot,
      channel: 'reports', processResult: { accepted: true },
      payload: { type: 'cancel_ack', id: 'ack', orderId: 'ord-1', cancelledQuantity: 6, occurredAt: 2 } });
    expect(violations.some((v) => v.invariant === 'lifecycle_consistency')).toBe(true);
  });

  it.each([null, [], 2, { type: 'execution', id: 'bad' },
    { type: 'execution', id: 'bad', orderId: 'ord-1', executionId: 'e', quantity: -1, price: 100, occurredAt: 1 },
    { type: 'execution', id: 'bad', orderId: 'ord-1', executionId: 'e', quantity: 1, price: 100, occurredAt: 0.5 },
    { type: 'cancel_ack', id: 'bad', orderId: 'ord-1', cancelledQuantity: 1_000_001, occurredAt: 1 },
  ])('detects malformed acceptance even with no visible state mutation: %j', (payload) => {
    const snapshot = createCleanSnapshot();
    const violations = new Oracle().evaluateTransition({ step: 1, previousSnapshot: snapshot, targetSnapshot: snapshot,
      channel: 'reports', payload, processResult: { accepted: true } });
    expect(violations.some((v) => v.message.includes('accepted publicly invalid'))).toBe(true);
  });

  it.each([
    { quantity: 11, price: 100, occurredAt: 1, orderId: 'ord-1' },
    { quantity: 1, price: 101, occurredAt: 1, orderId: 'ord-1' },
    { quantity: 1, price: 100, occurredAt: 1, orderId: 'unknown' },
  ])('detects invalid execution acceptance from public business constraints: %j', (fields) => {
    const snapshot = createCleanSnapshot();
    const violations = new Oracle().evaluateTransition({ step: 1, previousSnapshot: snapshot, targetSnapshot: snapshot,
      channel: 'reports', processResult: { accepted: true }, payload: { type: 'execution', id: 'report', executionId: 'e', ...fields } });
    expect(violations.some((v) => v.message.includes('accepted publicly invalid'))).toBe(true);
  });

  it('detects conflicting timestamp identity acceptance independently, even when target does not mutate', () => {
    const oracle = new Oracle();
    const before = createCleanSnapshot();
    const after = createCleanSnapshot({ reservedCredit: 600, usedCredit: 400 });
    Object.assign(after.orders['ord-1']!, { filledQuantity: 4, remainingQuantity: 6 });
    const execution = { type: 'execution', id: 'report', orderId: 'ord-1', executionId: 'e', quantity: 4, price: 100, occurredAt: 2 };
    expect(oracle.evaluateTransition({ step: 1, previousSnapshot: before, targetSnapshot: after, channel: 'reports',
      payload: execution, processResult: { accepted: true } })).toEqual([]);
    const violations = oracle.evaluateTransition({ step: 2, previousSnapshot: after, targetSnapshot: after, channel: 'reports',
      payload: { ...execution, id: 'new-envelope', occurredAt: 3 }, processResult: { accepted: true } });
    expect(violations.some((v) => v.invariant === 'execution_idempotency')).toBe(true);
  });

  it('does not poison identity after a rejected malformed report and accepts its coherent retry', () => {
    const oracle = new Oracle();
    const before = createCleanSnapshot();
    const report = { type: 'execution', id: 'report', orderId: 'ord-1', executionId: 'e', quantity: 4, price: 100, occurredAt: 2 };
    expect(oracle.evaluateTransition({ step: 1, previousSnapshot: before, targetSnapshot: before, channel: 'reports',
      payload: { ...report, quantity: -1 }, processResult: { accepted: false } })).toEqual([]);
    const after = createCleanSnapshot({ reservedCredit: 600, usedCredit: 400 });
    Object.assign(after.orders['ord-1']!, { filledQuantity: 4, remainingQuantity: 6 });
    expect(oracle.evaluateTransition({ step: 2, previousSnapshot: before, targetSnapshot: after, channel: 'reports',
      payload: report, processResult: { accepted: true } })).toEqual([]);
  });

  it('detects cancellation predating a known execution, and conflicting cancellation reissues', () => {
    const oracle = new Oracle();
    const before = createCleanSnapshot();
    const afterFill = createCleanSnapshot({ reservedCredit: 600, usedCredit: 400 });
    Object.assign(afterFill.orders['ord-1']!, { filledQuantity: 4, remainingQuantity: 6 });
    oracle.evaluateTransition({ step: 1, previousSnapshot: before, targetSnapshot: afterFill, channel: 'reports',
      processResult: { accepted: true }, payload: { type: 'execution', id: 'f', orderId: 'ord-1', executionId: 'e', quantity: 4, price: 100, occurredAt: 2 } });
    const cancel = { type: 'cancel_ack', id: 'c', orderId: 'ord-1', cancelledQuantity: 6, occurredAt: 1 };
    expect(oracle.evaluateTransition({ step: 2, previousSnapshot: afterFill, targetSnapshot: afterFill, channel: 'reports',
      payload: cancel, processResult: { accepted: true } }).some((v) => v.message.includes('predates'))).toBe(true);
    const afterCancel = createCleanSnapshot({ reservedCredit: 0, usedCredit: 400 });
    Object.assign(afterCancel.orders['ord-1']!, { filledQuantity: 4, remainingQuantity: 0, cancelledQuantity: 6, status: 'CANCELLED', cancelledAt: 2 });
    expect(oracle.evaluateTransition({ step: 3, previousSnapshot: afterFill, targetSnapshot: afterCancel, channel: 'reports',
      payload: { ...cancel, occurredAt: 2 }, processResult: { accepted: true } })).toEqual([]);
    expect(oracle.evaluateTransition({ step: 4, previousSnapshot: afterCancel, targetSnapshot: afterCancel, channel: 'reports',
      payload: { ...cancel, cancelledQuantity: 0, occurredAt: 3 }, processResult: { accepted: true } }).some((v) => v.message.includes('Conflicting cancellation'))).toBe(true);
  });

  it('uses known cancellation chronology even if the target drops its cancellation timestamp', () => {
    const oracle = new Oracle();
    const before = createCleanSnapshot();
    const afterCancel = createCleanSnapshot({ reservedCredit: 400 });
    Object.assign(afterCancel.orders['ord-1']!, { cancelledQuantity: 6, remainingQuantity: 4, status: 'CANCELLED', cancelledAt: 2 });
    expect(oracle.evaluateTransition({ step: 1, previousSnapshot: before, targetSnapshot: afterCancel,
      channel: 'reports', processResult: { accepted: true },
      payload: { type: 'cancel_ack', id: 'ack', orderId: 'ord-1', cancelledQuantity: 6, occurredAt: 2 } })).toEqual([]);
    const dropped = structuredClone(afterCancel);
    delete dropped.orders['ord-1']!.cancelledAt;
    expect(oracle.evaluateTransition({ step: 2, previousSnapshot: afterCancel, targetSnapshot: dropped })
      .some((v) => v.invariant === 'lifecycle_consistency')).toBe(true);
    const violations = oracle.evaluateTransition({ step: 3, previousSnapshot: dropped, targetSnapshot: dropped,
      channel: 'reports', processResult: { accepted: true },
      payload: { type: 'execution', id: 'after-cancel', orderId: 'ord-1', executionId: 'e', quantity: 4, price: 100, occurredAt: 3 } });
    expect(violations.some((v) => v.message.includes('after confirmed cancellation'))).toBe(true);
  });

  it('permits a credit cut below existing commitments without a new admission', () => {
    const previousSnapshot = createCleanSnapshot();
    const targetSnapshot = createCleanSnapshot({ credit: { version: 2, limit: 0 } });
    expect(new Oracle().evaluateTransition({ step: 1, previousSnapshot, targetSnapshot, channel: 'credit',
      payload: { type: 'credit_limit', id: 'cut', version: 2, limit: 0 }, processResult: { accepted: true } })).toEqual([]);
  });
});
