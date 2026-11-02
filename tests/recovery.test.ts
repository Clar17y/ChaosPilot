import { describe, expect, it } from 'vitest';
import type { Channel, Experiment } from '../src/domain.ts';
import {
  createRecoveryTarget,
  executeExperiment,
  getContract,
  getRecoveryEvaluatorIdentity,
  getSourceBundle,
  MAX_TICKS,
  parseExperiment,
  RECOVERY_DEADLINE_TICKS,
  type RecoveryProcessResult,
  type RecoverySnapshot,
  type RecoveryTarget,
} from '../src/recovery/index.ts';

function setupOrderSteps(orderId = 'ord-1', quantity = 10, price = 100, limit = 5000): Experiment['steps'] {
  return [
    { op: 'send', id: `q-${orderId}`, to: 'market', payload: { type: 'quote', id: `quote-${orderId}`, version: 1, price } },
    { op: 'send', id: `c-${orderId}`, to: 'credit', payload: { type: 'credit_limit', id: `cred-${orderId}`, version: 1, limit } },
    { op: 'drain' },
    {
      op: 'send',
      id: `o-${orderId}`,
      to: 'client',
      payload: { type: 'new_order', id: `new-${orderId}`, orderId, quantity, quoteId: `quote-${orderId}` },
    },
    { op: 'drain' },
  ];
}

describe('Recovery engine and independent oracle (synthetic-trading-recovery)', () => {
  it('only target-accepted execution reports while disconnected create recovery obligations; scheduled, withheld, or rejected reports do not', () => {
    // 1. Scheduled while disconnected, but never delivered (withheld)
    const withheldExp: Experiment = {
      hypothesis: 'Scheduled but undelivered execution report during outage creates no obligation',
      expectedInvariant: 'recovery_deadline',
      steps: [
        ...setupOrderSteps(),
        { op: 'disconnect' },
        { op: 'fill', messageId: 'm-fill-withheld', orderId: 'ord-1', executionId: 'exec-1', quantity: 4, delay: 20 },
        { op: 'reconnect' },
        { op: 'advance', ticks: 5 },
      ],
    };
    const withheldClean = executeExperiment(withheldExp, 'clean');
    const withheldCandidate = executeExperiment(withheldExp, 'recovery-candidate-a');
    expect(withheldClean.valid).toBe(true);
    expect(withheldClean.recovery?.obligations).toHaveLength(0);
    expect(withheldClean.recovery?.ingress).toHaveLength(0);
    expect(withheldClean.recovery?.status).toBe('not-exercised');
    expect(withheldCandidate.recovery?.obligations).toHaveLength(0);
    expect(withheldCandidate.recovery?.status).toBe('not-exercised');
    expect(withheldCandidate.violations).toHaveLength(0);

    // 2. Delivered while disconnected, but rejected by target (wrong price, overfill, future occurredAt, cancellation)
    const rejectedExp: Experiment = {
      hypothesis: 'Rejected reports delivered while disconnected create ingress rejection records but no recovery obligations',
      expectedInvariant: 'input_integrity_no_mutation',
      steps: [
        ...setupOrderSteps('ord-1', 10, 100),
        { op: 'disconnect' },
        {
          op: 'send',
          id: 'm-bad-price',
          to: 'reports',
          payload: { type: 'execution', id: 'm-bad-price', orderId: 'ord-1', executionId: 'e-bad-1', quantity: 2, price: 999, occurredAt: 0 },
        },
        { op: 'deliver', messageId: 'm-bad-price' },
        {
          op: 'send',
          id: 'm-overfill',
          to: 'reports',
          payload: { type: 'execution', id: 'm-overfill', orderId: 'ord-1', executionId: 'e-bad-2', quantity: 25, price: 100, occurredAt: 0 },
        },
        { op: 'deliver', messageId: 'm-overfill' },
        {
          op: 'send',
          id: 'm-future',
          to: 'reports',
          payload: { type: 'execution', id: 'm-future', orderId: 'ord-1', executionId: 'e-bad-3', quantity: 2, price: 100, occurredAt: 50 },
        },
        { op: 'deliver', messageId: 'm-future' },
        {
          op: 'send',
          id: 'm-cancel-ack',
          to: 'reports',
          payload: { type: 'cancel_ack', id: 'm-cancel-ack', orderId: 'ord-1', cancelledQuantity: 2, occurredAt: 0 },
        },
        { op: 'deliver', messageId: 'm-cancel-ack' },
        { op: 'reconnect' },
        { op: 'advance', ticks: 5 },
      ],
    };
    const rejectedRes = executeExperiment(rejectedExp, 'recovery-candidate-a');
    expect(rejectedRes.valid).toBe(true);
    expect(rejectedRes.recovery?.ingress).toHaveLength(4);
    expect(rejectedRes.recovery?.ingress.every((i) => i.status === 'rejected' && i.disconnected)).toBe(true);
    expect(rejectedRes.recovery?.obligations).toHaveLength(0);
    expect(rejectedRes.recovery?.status).toBe('not-exercised');
    expect(rejectedRes.violations).toHaveLength(0);

    // 3. Accepted while connected creates no disconnected recovery obligation
    const connectedExp: Experiment = {
      hypothesis: 'Connected execution report reconciles immediately without creating a disconnected recovery obligation',
      expectedInvariant: 'recovery_deadline',
      steps: [
        ...setupOrderSteps(),
        { op: 'fill', messageId: 'm-fill-conn', orderId: 'ord-1', executionId: 'exec-conn', quantity: 4 },
        { op: 'deliver', messageId: 'm-fill-conn' },
      ],
    };
    const connectedRes = executeExperiment(connectedExp, 'clean');
    expect(connectedRes.valid).toBe(true);
    expect(connectedRes.recovery?.ingress).toHaveLength(1);
    expect(connectedRes.recovery?.ingress[0]).toMatchObject({
      status: 'accepted',
      disconnected: false,
      duplicate: false,
    });
    expect(connectedRes.recovery?.obligations).toHaveLength(0);
    expect(connectedRes.recovery?.status).toBe('not-exercised');
  });

  it('clean variant reconciles accepted disconnected reports after reconnect within 5 ticks with matching order quantities, credit, and application records', () => {
    const exp: Experiment = {
      hypothesis: 'Disconnected accepted execution report reconciles on clean within 5 ticks after reconnect',
      expectedInvariant: 'recovery_deadline',
      steps: [
        ...setupOrderSteps('ord-1', 10, 100, 2000),
        { op: 'advance', ticks: 2 },
        { op: 'disconnect' },
        { op: 'fill', messageId: 'm-fill-1', orderId: 'ord-1', executionId: 'exec-1', quantity: 4 },
        { op: 'deliver', messageId: 'm-fill-1' },
        { op: 'advance', ticks: 3 },
        { op: 'reconnect' },
        { op: 'advance', ticks: 5 },
      ],
    };

    const res = executeExperiment(exp, 'clean');
    expect(res.valid).toBe(true);
    expect(res.executionComplete).toBe(true);
    expect(res.violations).toHaveLength(0);
    expect(res.recovery).toBeDefined();
    expect(res.recovery?.evaluator).toEqual(getRecoveryEvaluatorIdentity());
    expect(res.recovery?.status).toBe('passed');
    expect(res.recovery?.idempotenceStatus).toBe('not-exercised');
    expect(res.recovery?.horizonTick).toBe(10);
    expect(res.recovery?.obligations).toHaveLength(1);

    const ob = res.recovery!.obligations[0]!;
    expect(ob.key).toBe(JSON.stringify(['ord-1', 'exec-1']));
    expect(ob.acceptedTick).toBe(2);
    expect(ob.reconnectTick).toBe(5);
    expect(ob.deadlineTick).toBe(5 + RECOVERY_DEADLINE_TICKS);
    expect(ob.completionTick).toBe(6);
    expect(ob.deadlineMissed).toBe(false);
    expect(ob.status).toBe('passed');
    expect(ob.expected).toEqual({
      filledQuantity: 4,
      remainingQuantity: 6,
      reservedCredit: 600,
      usedCredit: 400,
      applicationCount: 1,
    });
    expect(ob.observed).toEqual(ob.expected);
  });

  it('candidate variant drops disconnected backlog on reconnect and misses the recovery deadline with replayable violation evidence', () => {
    const exp: Experiment = {
      hypothesis: 'Candidate loses disconnected backlog on reconnect and misses reconnectTick + 5 deadline',
      expectedInvariant: 'recovery_deadline',
      steps: [
        ...setupOrderSteps('ord-1', 10, 100, 2000),
        { op: 'advance', ticks: 1 },
        { op: 'disconnect' },
        { op: 'fill', messageId: 'm-fill-1', orderId: 'ord-1', executionId: 'exec-1', quantity: 4 },
        { op: 'deliver', messageId: 'm-fill-1' },
        { op: 'advance', ticks: 2 },
        { op: 'reconnect' },
        { op: 'advance', ticks: 5 },
      ],
    };

    const res = executeExperiment(exp, 'recovery-candidate-a');
    expect(res.valid).toBe(true);
    expect(res.executionComplete).toBe(true);
    expect(res.recovery?.status).toBe('failed');
    expect(res.recovery?.obligations).toHaveLength(1);

    const ob = res.recovery!.obligations[0]!;
    expect(ob.acceptedTick).toBe(1);
    expect(ob.reconnectTick).toBe(3);
    expect(ob.deadlineTick).toBe(8);
    expect(ob.completionTick).toBeUndefined();
    expect(ob.deadlineMissed).toBe(true);
    expect(ob.status).toBe('failed');
    expect(ob.checkedTick).toBe(8);
    expect(ob.expected).toEqual({
      filledQuantity: 4,
      remainingQuantity: 6,
      reservedCredit: 600,
      usedCredit: 400,
      applicationCount: 1,
    });
    expect(ob.observed).toEqual({
      filledQuantity: 0,
      remainingQuantity: 10,
      reservedCredit: 1000,
      usedCredit: 0,
      applicationCount: 0,
    });

    expect(res.violations).toHaveLength(1);
    expect(res.violations[0]).toMatchObject({
      invariant: 'recovery_deadline',
      category: 'recovery_deadline',
      orderId: 'ord-1',
    });
  });

  it('duplicate delivery of an accepted execution report does not apply a second fill, mutate credit, or reset/extend the original deadline', () => {
    const exp: Experiment = {
      hypothesis: 'Duplicate execution retry after reconnect neither double-fills nor extends original deadline',
      expectedInvariant: 'recovery_deadline',
      steps: [
        ...setupOrderSteps('ord-1', 10, 100, 2000),
        { op: 'disconnect' },
        { op: 'fill', messageId: 'm-fill-1', orderId: 'ord-1', executionId: 'exec-1', quantity: 4 },
        { op: 'duplicate', messageId: 'm-fill-1', id: 'm-fill-dup-disconnected' },
        { op: 'duplicate', messageId: 'm-fill-1', id: 'm-fill-dup-post-reconnect', delay: 3 },
        { op: 'deliver', messageId: 'm-fill-1' },
        { op: 'deliver', messageId: 'm-fill-dup-disconnected' },
        { op: 'reconnect' },
        { op: 'advance', ticks: 3 },
        // Deliver duplicate at tick 3 (after reconnect at tick 0, before deadline tick 5)
        { op: 'deliver', messageId: 'm-fill-dup-post-reconnect' },
        // Advance 2 more ticks to original deadline tick 5 (NOT 3 + 5 = 8)
        { op: 'advance', ticks: 2 },
      ],
    };

    const cleanRes = executeExperiment(exp, 'clean');
    expect(cleanRes.valid).toBe(true);
    expect(cleanRes.violations).toHaveLength(0);
    expect(cleanRes.recovery?.obligations).toHaveLength(1);
    expect(cleanRes.recovery?.obligations[0]?.deadlineTick).toBe(5);
    expect(cleanRes.recovery?.obligations[0]?.completionTick).toBe(1);
    expect(cleanRes.recovery?.obligations[0]?.status).toBe('passed');
    expect(cleanRes.recovery?.retries).toHaveLength(2);
    expect(cleanRes.recovery?.retries.every((r) => r.status === 'passed')).toBe(true);
    expect(cleanRes.recovery?.idempotenceStatus).toBe('passed');
    expect(cleanRes.recovery?. obligations[0]?.observed).toEqual({
      filledQuantity: 4,
      remainingQuantity: 6,
      reservedCredit: 600,
      usedCredit: 400,
      applicationCount: 1,
    });

    const candidateRes = executeExperiment(exp, 'recovery-candidate-a');
    expect(candidateRes.valid).toBe(true);
    expect(candidateRes.recovery?.obligations).toHaveLength(1);
    // Original deadline tick 5 was NOT extended to tick 8 by the duplicate retry at tick 3
    expect(candidateRes.recovery?.obligations[0]?.deadlineTick).toBe(5);
    expect(candidateRes.recovery?.obligations[0]?.deadlineMissed).toBe(true);
    expect(candidateRes.recovery?.obligations[0]?.status).toBe('failed');
    expect(candidateRes.recovery?.status).toBe('failed');
    expect(candidateRes.recovery?.idempotenceStatus).toBe('passed');
    expect(candidateRes.violations.some((v) => v.invariant === 'recovery_deadline')).toBe(true);
  });

  it('conflicting execution report with an existing [orderId, executionId] is rejected without state mutation', () => {
    const exp: Experiment = {
      hypothesis: 'Conflicting duplicate executionId with altered quantity or price is rejected without mutating state',
      expectedInvariant: 'execution_idempotency',
      steps: [
        ...setupOrderSteps('ord-1', 10, 100, 2000),
        { op: 'disconnect' },
        { op: 'fill', messageId: 'm-fill-1', orderId: 'ord-1', executionId: 'exec-1', quantity: 4 },
        { op: 'deliver', messageId: 'm-fill-1' },
        {
          op: 'send',
          id: 'm-conflict-qty',
          to: 'reports',
          payload: { type: 'execution', id: 'm-conflict-qty', orderId: 'ord-1', executionId: 'exec-1', quantity: 5, price: 100, occurredAt: 0 },
        },
        { op: 'deliver', messageId: 'm-conflict-qty' },
        { op: 'reconnect' },
        { op: 'advance', ticks: 5 },
      ],
    };

    const cleanRes = executeExperiment(exp, 'clean');
    expect(cleanRes.valid).toBe(true);
    expect(cleanRes.violations).toHaveLength(0);
    expect(cleanRes.recovery?.status).toBe('passed');
    expect(cleanRes.recovery?.idempotenceStatus).toBe('passed');
    expect(cleanRes.recovery?.retries).toHaveLength(1);
    expect(cleanRes.recovery?.retries[0]?.status).toBe('passed');
    expect(cleanRes.recovery?.retries[0]?.before).toEqual(cleanRes.recovery?.retries[0]?.after);
    expect(cleanRes.recovery?.ingress[1]).toMatchObject({
      messageId: 'm-conflict-qty',
      status: 'rejected',
      disconnected: true,
    });
  });

  it('early stop before reconnectTick + 5 or no reconnect produces inconclusive status, not a false deadline failure', () => {
    // 1. Disconnected acceptance without reconnect
    const noReconnectExp: Experiment = {
      hypothesis: 'Stopping while still disconnected is inconclusive, never a proven post-reconnect deadline miss',
      expectedInvariant: 'recovery_deadline',
      steps: [
        ...setupOrderSteps(),
        { op: 'disconnect' },
        { op: 'fill', messageId: 'm-fill-1', orderId: 'ord-1', executionId: 'exec-1', quantity: 4 },
        { op: 'deliver', messageId: 'm-fill-1' },
        { op: 'advance', ticks: 10 },
      ],
    };
    const noReconnectRes = executeExperiment(noReconnectExp, 'recovery-candidate-a');
    expect(noReconnectRes.valid).toBe(true);
    expect(noReconnectRes.violations).toHaveLength(0);
    expect(noReconnectRes.recovery?.status).toBe('inconclusive');
    expect(noReconnectRes.recovery?.obligations[0]).toMatchObject({
      reconnectTick: undefined,
      deadlineTick: undefined,
      deadlineMissed: false,
      status: 'inconclusive',
    });

    // 2. Reconnected at tick 0, stopped at tick 4 (< 5) on candidate
    const earlyStopExp: Experiment = {
      hypothesis: 'Stopping at reconnectTick + 4 before deadline tick 5 is inconclusive on candidate',
      expectedInvariant: 'recovery_deadline',
      steps: [
        ...setupOrderSteps(),
        { op: 'disconnect' },
        { op: 'fill', messageId: 'm-fill-1', orderId: 'ord-1', executionId: 'exec-1', quantity: 4 },
        { op: 'deliver', messageId: 'm-fill-1' },
        { op: 'reconnect' },
        { op: 'advance', ticks: 4 },
      ],
    };
    const earlyCandidate = executeExperiment(earlyStopExp, 'recovery-candidate-a');
    expect(earlyCandidate.valid).toBe(true);
    expect(earlyCandidate.violations).toHaveLength(0);
    expect(earlyCandidate.recovery?.status).toBe('inconclusive');
    expect(earlyCandidate.recovery?.obligations[0]).toMatchObject({
      reconnectTick: 0,
      deadlineTick: 5,
      deadlineMissed: false,
      status: 'inconclusive',
    });

    // On clean, actual evidenced reconciliation at tick 1 (< 5) establishes 'passed' even when stopping at tick 4
    const earlyClean = executeExperiment(earlyStopExp, 'clean');
    expect(earlyClean.valid).toBe(true);
    expect(earlyClean.violations).toHaveLength(0);
    expect(earlyClean.recovery?.status).toBe('passed');
    expect(earlyClean.recovery?.obligations[0]).toMatchObject({
      reconnectTick: 0,
      deadlineTick: 5,
      completionTick: 1,
      deadlineMissed: false,
      status: 'passed',
    });
  });

  it('repeated current connection state is a no-op; a second outage cycle or reconnect with deadline > maxTicks is rejected as invalid', () => {
    // 1. Repeated current connection states are valid no-ops
    const noopExp: Experiment = {
      hypothesis: 'Repeated disconnect while disconnected and repeated reconnect while connected are idempotent no-ops',
      expectedInvariant: 'recovery_deadline',
      steps: [
        ...setupOrderSteps(),
        { op: 'reconnect' }, // already connected
        { op: 'disconnect' },
        { op: 'disconnect' }, // already disconnected
        { op: 'fill', messageId: 'm-fill-1', orderId: 'ord-1', executionId: 'exec-1', quantity: 4 },
        { op: 'deliver', messageId: 'm-fill-1' },
        { op: 'reconnect' },
        { op: 'advance', ticks: 2 },
        { op: 'reconnect' }, // already connected; must not reset deadline
        { op: 'advance', ticks: 3 },
      ],
    };
    const noopClean = executeExperiment(noopExp, 'clean');
    expect(noopClean.valid).toBe(true);
    expect(noopClean.recovery?.status).toBe('passed');
    expect(noopClean.recovery?.obligations[0]?.deadlineTick).toBe(5);

    const noopCandidate = executeExperiment(noopExp, 'recovery-candidate-a');
    expect(noopCandidate.valid).toBe(true);
    expect(noopCandidate.recovery?.obligations[0]?.deadlineTick).toBe(5);
    expect(noopCandidate.recovery?.status).toBe('failed');

    // 2. Second outage cycle after reconnect is invalid
    const secondOutageExp: Experiment = {
      hypothesis: 'Second disconnect after reconnect is rejected as an invalid v1 harness command',
      expectedInvariant: 'recovery_deadline',
      steps: [
        ...setupOrderSteps(),
        { op: 'disconnect' },
        { op: 'reconnect' },
        { op: 'disconnect' },
      ],
    };
    const secondOutageRes = executeExperiment(secondOutageExp, 'clean');
    expect(secondOutageRes.valid).toBe(false);
    expect(secondOutageRes.executionComplete).toBe(false);
    expect(secondOutageRes.recovery?.status).toBe('invalid');
    expect(secondOutageRes.recovery?.idempotenceStatus).toBe('invalid');
    expect(secondOutageRes.rejections[0]?.reason).toMatch(/one outage\/reconnect cycle/);

    // 3. Reconnect with deadline > maxTicks is invalid
    const lateReconnectExp: Experiment = {
      hypothesis: 'Reconnect at tick 996 has deadline 1001 > maxTicks (1000) and is invalid',
      expectedInvariant: 'recovery_deadline',
      steps: [
        ...setupOrderSteps(),
        { op: 'disconnect' },
        { op: 'advance', ticks: MAX_TICKS - RECOVERY_DEADLINE_TICKS + 1 },
        { op: 'reconnect' },
      ],
    };
    const lateReconnectRes = executeExperiment(lateReconnectExp, 'clean');
    expect(lateReconnectRes.valid).toBe(false);
    expect(lateReconnectRes.executionComplete).toBe(false);
    expect(lateReconnectRes.recovery?.status).toBe('invalid');
    expect(lateReconnectRes.rejections[0]?.reason).toMatch(/deadline tick 1001 beyond maxTicks/);

    // 4. Unsupported confirm_cancel is rejected by parser and executor
    expect(() =>
      parseExperiment({
        hypothesis: 'confirm_cancel is unsupported',
        expectedInvariant: 'recovery_deadline',
        steps: [{ op: 'confirm_cancel', messageId: 'c1', orderId: 'ord-1' }],
      }),
    ).toThrow(/confirm_cancel/);
  });

  it('advance (including 0) and drain process due internal recovery work and crossed deadlines in chronological order; empty drain does not move time', () => {
    // 1. Empty drain does not move time; advance(0) is supported; large advance processes retryTick and deadlineTick in chronological order
    const clockExp: Experiment = {
      hypothesis: 'Chronological clock driver processes due work at r+1 and deadline at r+5 across large jumps and drains',
      expectedInvariant: 'recovery_deadline',
      steps: [
        ...setupOrderSteps('ord-1', 10, 100, 2000),
        { op: 'advance', ticks: 0 },
        { op: 'drain' }, // empty drain at tick 0
        { op: 'disconnect' },
        { op: 'fill', messageId: 'm-fill-1', orderId: 'ord-1', executionId: 'exec-1', quantity: 4 },
        { op: 'deliver', messageId: 'm-fill-1' },
        { op: 'reconnect' },
        // Schedule a future quote at tick 10 and drain to jump across tick 1 (reconcile) and tick 5 (deadline)
        { op: 'send', id: 'q-later', to: 'market', payload: { type: 'quote', id: 'quote-2', version: 2, price: 110 }, delay: 10 },
        { op: 'drain' },
        { op: 'drain' }, // empty drain at tick 10 must stay at tick 10
      ],
    };

    const cleanRes = executeExperiment(clockExp, 'clean');
    expect(cleanRes.valid).toBe(true);
    expect(cleanRes.recovery?.horizonTick).toBe(10);
    expect(cleanRes.recovery?.status).toBe('passed');
    // Reconcile happened at tick 1 (not skipped or delayed to tick 10!)
    expect(cleanRes.recovery?.obligations[0]?.completionTick).toBe(1);
    const reconcileEntry = cleanRes.trace.find((t) => t.action === 'reconcile');
    expect(reconcileEntry?.time).toBe(1);

    const candidateRes = executeExperiment(clockExp, 'recovery-candidate-a');
    expect(candidateRes.valid).toBe(true);
    expect(candidateRes.recovery?.horizonTick).toBe(10);
    expect(candidateRes.recovery?.status).toBe('failed');
    // Deadline miss recorded at deadlineTick 5 (not tick 10!)
    expect(candidateRes.recovery?.obligations[0]?.checkedTick).toBe(5);
    expect(candidateRes.recovery?.obligations[0]?.deadlineMissed).toBe(true);
  });

  it('oracle verifies actual order quantities and aggregate credit across all orders rather than trusting target application records alone', () => {
    const exp: Experiment = {
      hypothesis: 'Spoofed application journal or cross-order credit corruption cannot pass the independent recovery oracle',
      expectedInvariant: 'recovery_deadline',
      steps: [
        ...setupOrderSteps('ord-1', 10, 100, 5000),
        { op: 'disconnect' },
        { op: 'fill', messageId: 'm-fill-1', orderId: 'ord-1', executionId: 'exec-1', quantity: 4 },
        { op: 'deliver', messageId: 'm-fill-1' },
        { op: 'reconnect' },
        { op: 'advance', ticks: 5 },
      ],
    };

    // Fake target that records the application in getSnapshot().applications on runDue,
    // but fails to update the underlying order filledQuantity and credit balances!
    const baseTarget = createRecoveryTarget('recovery-candidate-a');
    const spoofedApps: RecoverySnapshot['applications'] = [];
    let pendingDue: number | undefined;
    const spoofedTarget: RecoveryTarget = {
      processMessage(channel: Channel, payload: unknown, tick: number): RecoveryProcessResult {
        const res = baseTarget.processMessage(channel, payload, tick);
        if (res.accepted && res.report && !res.duplicate) {
          spoofedApps.push({
            key: JSON.stringify([res.report.orderId, res.report.executionId]),
            report: structuredClone(res.report),
            tick: tick + 1,
          });
        }
        return res;
      },
      setConnected(connected: boolean, tick: number): void {
        baseTarget.setConnected(connected, tick);
        if (connected) pendingDue = tick + 1;
      },
      nextDueTick(): number | undefined {
        return pendingDue;
      },
      runDue(_tick: number): void {
        pendingDue = undefined;
      },
      getSnapshot(): RecoverySnapshot {
        const snap = baseTarget.getSnapshot();
        return {
          ...snap,
          applications: structuredClone(spoofedApps),
        };
      },
    };

    const spoofedRes = executeExperiment(exp, 'recovery-candidate-a', spoofedTarget);
    expect(spoofedRes.valid).toBe(true);
    expect(spoofedRes.recovery?.obligations[0]?.observed?.applicationCount).toBe(1);
    expect(spoofedRes.recovery?.obligations[0]?.observed?.filledQuantity).toBe(0);
    expect(spoofedRes.recovery?.obligations[0]?.deadlineMissed).toBe(true);
    expect(spoofedRes.recovery?.obligations[0]?.status).toBe('failed');
    expect(spoofedRes.recovery?.status).toBe('failed');
    expect(spoofedRes.violations.some((v) => v.invariant === 'recovery_deadline')).toBe(true);

    // Also verify unhandled target exception in runDue is never classified as passed
    const throwingTarget = createRecoveryTarget('clean');
    const origRunDue = throwingTarget.runDue.bind(throwingTarget);
    throwingTarget.runDue = (tick: number) => {
      origRunDue(tick);
      throw new Error('Simulated crash during recovery');
    };
    const crashRes = executeExperiment(exp, 'clean', throwingTarget);
    expect(crashRes.recovery?.status).toBe('failed');
    expect(crashRes.recovery?.executionComplete).toBe(false);
    expect(crashRes.violations.some((v) => v.invariant === 'input_integrity_no_mutation')).toBe(true);
  });

  it('inclusive deadline seam: completion exactly at reconnect+5 passes; completion at reconnect+6 is a sticky miss', () => {
    // Wrap the clean target so its due recovery work is delayed until a
    // chosen tick after reconnect. Business behaviour is otherwise clean's.
    function delayedTarget(delayTicks: number): RecoveryTarget {
      const inner = createRecoveryTarget('clean');
      let delayedTick: number | undefined;
      return {
        processMessage: (channel, payload, tick) => inner.processMessage(channel, payload, tick),
        setConnected: (connected, tick) => {
          inner.setConnected(connected, tick);
          if (connected && inner.nextDueTick() !== undefined) delayedTick = tick + delayTicks;
        },
        nextDueTick: () => (inner.nextDueTick() === undefined ? undefined : delayedTick ?? inner.nextDueTick()),
        runDue: (tick) => { if (delayedTick === undefined || tick >= delayedTick) inner.runDue(tick); },
        getSnapshot: () => inner.getSnapshot(),
      };
    }
    const exp: Experiment = {
      hypothesis: 'Deadline boundary seam',
      expectedInvariant: 'recovery_deadline',
      steps: [
        ...setupOrderSteps(),
        { op: 'disconnect' },
        { op: 'fill', messageId: 'm-fill-seam', orderId: 'ord-1', executionId: 'exec-seam', quantity: 4 },
        { op: 'deliver', messageId: 'm-fill-seam' },
        { op: 'reconnect' },
        { op: 'advance', ticks: 10 },
      ],
    };

    const onTime = executeExperiment(exp, 'clean', delayedTarget(RECOVERY_DEADLINE_TICKS));
    const onTimeOb = onTime.recovery?.obligations[0];
    expect(onTimeOb?.deadlineTick).toBeDefined();
    expect(onTimeOb?.completionTick).toBe(onTimeOb?.deadlineTick);
    expect(onTimeOb?.deadlineMissed).toBe(false);
    expect(onTimeOb?.status).toBe('passed');
    expect(onTime.violations.some((v) => v.invariant === 'recovery_deadline')).toBe(false);
    expect(onTime.recovery?.status).toBe('passed');

    const late = executeExperiment(exp, 'clean', delayedTarget(RECOVERY_DEADLINE_TICKS + 1));
    const lateOb = late.recovery?.obligations[0];
    expect(lateOb?.deadlineMissed).toBe(true);
    expect(lateOb?.status).toBe('failed');
    // Work did eventually run at deadline+1, but the recorded miss is sticky.
    expect(lateOb?.checkedTick).toBe(lateOb?.deadlineTick);
    expect(late.violations.some((v) => v.invariant === 'recovery_deadline')).toBe(true);
    expect(late.recovery?.status).toBe('failed');
  });

  it('multiple accepted reports while disconnected each get their own obligation and deadline', () => {
    const exp: Experiment = {
      hypothesis: 'Two disconnected fills',
      expectedInvariant: 'recovery_deadline',
      steps: [
        ...setupOrderSteps(),
        { op: 'disconnect' },
        { op: 'fill', messageId: 'm-fill-a', orderId: 'ord-1', executionId: 'exec-a', quantity: 3 },
        { op: 'deliver', messageId: 'm-fill-a' },
        { op: 'fill', messageId: 'm-fill-b', orderId: 'ord-1', executionId: 'exec-b', quantity: 2 },
        { op: 'deliver', messageId: 'm-fill-b' },
        { op: 'reconnect' },
        { op: 'advance', ticks: 5 },
      ],
    };
    const clean = executeExperiment(exp, 'clean');
    expect(clean.recovery?.obligations).toHaveLength(2);
    expect(clean.recovery?.status).toBe('passed');
    expect(clean.recovery?.obligations.every((o) => o.status === 'passed' && !o.deadlineMissed)).toBe(true);
    const candidate = executeExperiment(exp, 'recovery-candidate-a');
    expect(candidate.recovery?.obligations).toHaveLength(2);
    expect(candidate.recovery?.obligations.every((o) => o.deadlineMissed)).toBe(true);
    expect(candidate.violations.filter((v) => v.invariant === 'recovery_deadline')).toHaveLength(2);
  });

  it('reconciles two distinct orders with independent quantities and shared credit totals', () => {
    const exp: Experiment = {
      hypothesis: 'Two orders recover their own fills while sharing one credit account',
      expectedInvariant: 'recovery_deadline',
      steps: [
        ...setupOrderSteps(),
        { op: 'send', id: 'o-ord-2', to: 'client', payload: { type: 'new_order', id: 'new-ord-2', orderId: 'ord-2', quantity: 6, quoteId: 'quote-ord-1' } },
        { op: 'drain' },
        { op: 'disconnect' },
        { op: 'fill', messageId: 'fill-order-1', orderId: 'ord-1', executionId: 'exec-order-1', quantity: 4 },
        { op: 'deliver', messageId: 'fill-order-1' },
        { op: 'fill', messageId: 'fill-order-2', orderId: 'ord-2', executionId: 'exec-order-2', quantity: 2 },
        { op: 'deliver', messageId: 'fill-order-2' },
        { op: 'reconnect' },
        { op: 'advance', ticks: 5 },
      ],
    };
    const clean = executeExperiment(exp, 'clean');
    expect(clean.valid).toBe(true);
    expect(clean.violations).toEqual([]);
    expect(clean.recovery?.status).toBe('passed');
    expect(clean.recovery?.obligations).toHaveLength(2);
    for (const [orderId, filledQuantity, remainingQuantity] of [['ord-1', 4, 6], ['ord-2', 2, 4]] as const) {
      const obligation = clean.recovery!.obligations.find(o => o.report.orderId === orderId)!;
      expect(obligation.status).toBe('passed');
      expect(obligation.expected).toEqual({ filledQuantity, remainingQuantity, usedCredit: 600, reservedCredit: 1000, applicationCount: 1 });
      expect(obligation.observed).toEqual(obligation.expected);
    }
    expect(clean.snapshot).toMatchObject({ target: {
      usedCredit: 600, reservedCredit: 1000,
      orders: { 'ord-1': { filledQuantity: 4, remainingQuantity: 6 }, 'ord-2': { filledQuantity: 2, remainingQuantity: 4 } },
    } });
    const candidate = executeExperiment(exp, 'recovery-candidate-a');
    expect(candidate.valid).toBe(true);
    expect(candidate.recovery?.obligations).toHaveLength(2);
    expect(candidate.recovery?.obligations.every(o => o.deadlineMissed && o.status === 'failed')).toBe(true);
  });

  it('rejects reconciliation when an unrelated order is corrupted despite matching report and aggregate facts', () => {
    const inner = createRecoveryTarget('clean');
    const target: RecoveryTarget = {
      processMessage: (channel, payload, tick) => inner.processMessage(channel, payload, tick),
      setConnected: (connected, tick) => inner.setConnected(connected, tick),
      nextDueTick: () => inner.nextDueTick(),
      runDue: tick => inner.runDue(tick),
      getSnapshot: () => {
        const snapshot = structuredClone(inner.getSnapshot());
        if (snapshot.applications.length && snapshot.orders['ord-2']) {
          snapshot.orders['ord-2'].filledQuantity = 1;
          snapshot.orders['ord-2'].remainingQuantity = 5;
        }
        return snapshot;
      },
    };
    const result = executeExperiment({
      hypothesis: 'An unrelated order cannot be hidden behind a valid application journal and aggregate balances',
      expectedInvariant: 'recovery_deadline',
      steps: [
        ...setupOrderSteps(),
        { op: 'send', id: 'o-ord-2', to: 'client', payload: { type: 'new_order', id: 'new-ord-2', orderId: 'ord-2', quantity: 6, quoteId: 'quote-ord-1' } },
        { op: 'drain' },
        { op: 'disconnect' },
        { op: 'fill', messageId: 'fill-known', orderId: 'ord-1', executionId: 'exec-known', quantity: 4 },
        { op: 'deliver', messageId: 'fill-known' },
        { op: 'reconnect' },
        { op: 'advance', ticks: 5 },
      ],
    }, 'clean', target);
    expect(result.valid).toBe(true);
    const obligation = result.recovery!.obligations[0]!;
    // The report's own quantities, journal and global credit match. The other
    // order still contradicts the independently recorded business events.
    expect(obligation.observed).toEqual(obligation.expected);
    expect(obligation.observed).toEqual({ filledQuantity: 4, remainingQuantity: 6, usedCredit: 400, reservedCredit: 1200, applicationCount: 1 });
    expect(obligation.deadlineMissed).toBe(true);
    expect(obligation.status).toBe('failed');
    expect(result.violations.some(v => v.invariant === 'recovery_deadline')).toBe(true);
  });

  it('model-visible recovery source bundle includes only the selected recovery component and neutral dependencies without variant labels, fault comments, or oracle code', () => {
    const cleanBundle = getSourceBundle('clean');
    const candidateBundle = getSourceBundle('recovery-candidate-a');
    const contract = getContract();

    expect(contract.invariants.some((i) => i.id === 'recovery_deadline')).toBe(true);
    expect(cleanBundle.hash).not.toBe(candidateBundle.hash);

    const expectedPaths = [
      'credit-manager.ts',
      'decoder.ts',
      'inbox.ts',
      'order-engine.ts',
      'recovery-component.ts',
    ];
    expect(cleanBundle.files.map((f) => f.path)).toEqual(expectedPaths);
    expect(candidateBundle.files.map((f) => f.path)).toEqual(expectedPaths);

    for (const bundle of [cleanBundle, candidateBundle]) {
      for (const file of bundle.files) {
        expect(file.path).not.toMatch(/clean|candidate|variant|oracle|mock/i);
        // Word boundaries: JS keyword `default:` must not false-positive on
        // "fault". Explicit variant/oracle labels remain forbidden.
        expect(file.content).not.toMatch(
          /\b(clean|candidate|oracle|deliberate|bug|fault)\b|recovery-candidate|candidate-[a-z]\b|variants\//i,
        );
        // No import of the independent oracle / other variant / mock fixtures.
        expect(file.content).not.toMatch(/from\s+['"][^'"]*(oracle|mock|variants\/)/i);
      }
    }
    // Selected component differs between bundles; shared deps are identical.
    const byPath = (b: typeof cleanBundle) => Object.fromEntries(b.files.map((f) => [f.path, f.content]));
    expect(byPath(candidateBundle)['recovery-component.ts']).not.toBe(byPath(cleanBundle)['recovery-component.ts']);
    expect(byPath(candidateBundle)['inbox.ts']).toBe(byPath(cleanBundle)['inbox.ts']);
  });
});
