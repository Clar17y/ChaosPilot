import { describe, it, expect } from 'vitest';
import { runApiJourneys } from '../../src/target-api/runner.ts';
import { SEEDED_TRADING_BRIEF } from '../../src/systems/index.ts';
import { createSystemSnapshot } from '../../src/storage.ts';

describe('Independent order/credit accounting and idempotence', () => {
  it('clean variant passes all 3 catalog journeys with exact business accounting', async () => {
    const systemSnapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const record = await runApiJourneys({
      variant: 'clean',
      systemSnapshot,
      timeoutMs: 8000,
    });

    expect(record.status).toBe('pass');
    expect(record.journeys).toHaveLength(3);

    const [lifecycle, creditRejection, retry] = record.journeys;

    // Journey 1: order lifecycle
    expect(lifecycle!.status).toBe('pass');
    const orderCompleteAssertion = lifecycle!.assertions.find((a) => a.id === '3.orders');
    expect(orderCompleteAssertion?.observed).toEqual({
      'order-1': { quantity: 4, filled: 4, status: 'FILLED' },
    });
    const creditCompleteAssertion = lifecycle!.assertions.find((a) => a.id === '3.credit');
    expect(creditCompleteAssertion?.observed).toEqual({ reserved: 0, used: 40 });

    // Journey 2: credit rejection without mutation
    expect(creditRejection!.status).toBe('pass');
    const rejectedStatus = creditRejection!.assertions.find((a) => a.id === '3.business-status');
    expect(rejectedStatus?.observed).toBe('rejected');
    const noMutation = creditRejection!.assertions.find((a) => a.id === '3.no-business-mutation');
    expect(noMutation?.status).toBe('pass');

    // Journey 3: identical retry idempotence
    expect(retry!.status).toBe('pass');
    const retryCredit = retry!.assertions.find((a) => a.id === '2.credit');
    expect(retryCredit?.observed).toEqual({ reserved: 30, used: 10 });
    const conflictAssertion = retry!.assertions.find((a) => a.id === '4.business-status');
    expect(conflictAssertion?.observed).toBe('rejected');
  });

  it('detects duplicate execution mutation when running candidate-a', async () => {
    const systemSnapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const record = await runApiJourneys({
      variant: 'candidate-a',
      systemSnapshot,
      timeoutMs: 8000,
    });

    // Overall status is fail because journey 3 fails
    expect(record.status).toBe('fail');

    const retryJourney = record.journeys.find((j) => j.id === 'execution-retry');
    expect(retryJourney?.status).toBe('fail');

    // Candidate-a re-applies duplicate execution, mutating filled quantity and used credit
    const oracleAssertion = retryJourney?.assertions.find((a) => a.id === '2.public-oracle');
    expect(oracleAssertion?.status).toBe('fail');
    const violations = oracleAssertion?.observed as any[];
    expect(violations.some((v) => v.invariant === 'execution_idempotency')).toBe(true);

    // Unexercised journeys pass honestly
    const lifecycleJourney = record.journeys.find((j) => j.id === 'order-lifecycle');
    expect(lifecycleJourney?.status).toBe('pass');
  });

  it('detects over-credit violation when running candidate-c', async () => {
    const systemSnapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const record = await runApiJourneys({
      variant: 'candidate-c',
      systemSnapshot,
      timeoutMs: 8000,
    });

    expect(record.status).toBe('fail');

    const creditJourney = record.journeys.find((j) => j.id === 'credit-rejection');
    expect(creditJourney?.status).toBe('fail');

    // Candidate-c accepted order 2 instead of rejecting it
    const businessStatus = creditJourney?.assertions.find((a) => a.id === '3.business-status');
    expect(businessStatus?.status).toBe('fail');
    expect(businessStatus?.observed).toBe('accepted');

    const oracleAssertion = creditJourney?.assertions.find((a) => a.id === '3.public-oracle');
    expect(oracleAssertion?.status).toBe('fail');
    const violations = oracleAssertion?.observed as any[];
    expect(violations.some((v) => v.invariant === 'credit_limit_respected')).toBe(true);
  });
});
