import { describe, expect, it } from 'vitest';
import { createSystemSnapshot, SEEDED_TRADING_BRIEF } from '../src/systems/index.ts';
import { runFunctionalBaselines } from '../src/functional/runner.ts';
import { FUNCTIONAL_CATALOG } from '../src/functional/catalog.ts';

describe('functional runner against actual adapters', () => {
  it('runs all catalog scenarios on clean adapter with 100% pass and milestone accounting', async () => {
    const snapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const result = await runFunctionalBaselines({
      variant: 'clean',
      systemSnapshot: snapshot,
    });

    expect(result.status).toBe('pass');
    expect(result.adapterId).toBe('synthetic-trading');
    expect(result.variant).toBe('clean');
    expect(result.sourceHash).toBeTruthy();
    expect(result.evaluator.id).toBe('functional-evaluator');
    expect(result.evaluator.version).toBe(2);
    expect(result.systemBrief.id).toBe('trading-gateway');
    expect(result.systemBrief.revision).toBe(1);

    expect(result.scenarios.length).toBe(FUNCTIONAL_CATALOG.length);
    expect(result.summary.totalScenarios).toBe(FUNCTIONAL_CATALOG.length);
    expect(result.summary.passed).toBe(FUNCTIONAL_CATALOG.length);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.inconclusive).toBe(0);
    expect(result.summary.invalid).toBe(0);

    // Scenario 1: Lifecycle partial fill & cancellation
    const lifecycleScenario = result.scenarios.find(
      (s) => s.scenarioId === 'trading-lifecycle-partial-fill-cancel',
    );
    expect(lifecycleScenario).toBeDefined();
    expect(lifecycleScenario!.status).toBe('pass');

    // Check individual milestone assertions
    // 1. Acceptance
    const acceptDelivery = lifecycleScenario!.assertions.find((a) => a.id === 'order-acceptance.delivery-accepted');
    expect(acceptDelivery?.status).toBe('pass');
    const acceptOrder = lifecycleScenario!.assertions.find((a) => a.id === 'order-acceptance.order-ord-baseline-1');
    expect(acceptOrder?.status).toBe('pass');
    const acceptCredit = lifecycleScenario!.assertions.find((a) => a.id === 'order-acceptance.credit');
    expect(acceptCredit?.status).toBe('pass');

    // 2. Partial fill (4 units at 10 reserve 40, fill 2 consumes 20 / reserves 20)
    const fillDelivery = lifecycleScenario!.assertions.find((a) => a.id === 'partial-fill.delivery-accepted');
    expect(fillDelivery?.status).toBe('pass');
    const fillOrder = lifecycleScenario!.assertions.find((a) => a.id === 'partial-fill.order-ord-baseline-1');
    expect(fillOrder?.status).toBe('pass');
    const fillCredit = lifecycleScenario!.assertions.find((a) => a.id === 'partial-fill.credit');
    expect(fillCredit?.status).toBe('pass');

    // 3. Cancellation request (retains 20 reserved credit)
    const cancelReqDelivery = lifecycleScenario!.assertions.find((a) => a.id === 'cancellation-request.delivery-accepted');
    expect(cancelReqDelivery?.status).toBe('pass');
    const cancelReqCredit = lifecycleScenario!.assertions.find((a) => a.id === 'cancellation-request.credit');
    expect(cancelReqCredit?.status).toBe('pass');

    // 4. Cancellation confirmation (releases remaining 20 reserved, leaves used 20)
    const cancelAckDelivery = lifecycleScenario!.assertions.find((a) => a.id === 'cancellation-confirmation.delivery-accepted');
    expect(cancelAckDelivery?.status).toBe('pass');
    const cancelAckOrder = lifecycleScenario!.assertions.find((a) => a.id === 'cancellation-confirmation.order-ord-baseline-1');
    expect(cancelAckOrder?.status).toBe('pass');
    const cancelAckCredit = lifecycleScenario!.assertions.find((a) => a.id === 'cancellation-confirmation.credit');
    expect(cancelAckCredit?.status).toBe('pass');

    // Scenario 2: Used credit admission rejection
    const usedCreditScenario = result.scenarios.find(
      (s) => s.scenarioId === 'trading-used-credit-admission-rejection',
    );
    expect(usedCreditScenario).toBeDefined();
    expect(usedCreditScenario!.status).toBe('pass');
    const rejectDelivery = usedCreditScenario!.assertions.find((a) => a.id === 'used-credit-admission-rejection.delivery-rejected');
    expect(rejectDelivery?.status).toBe('pass');
    const uncreatedOrder = usedCreditScenario!.assertions.find((a) => a.id === 'used-credit-admission-rejection.order-not-created');
    expect(uncreatedOrder?.status).toBe('pass');
    const unmutatedCredit = usedCreditScenario!.assertions.find((a) => a.id === 'used-credit-admission-rejection.credit');
    expect(unmutatedCredit?.status).toBe('pass');

    // Scenario 3: Initial credit rejection
    const initialRejectScenario = result.scenarios.find(
      (s) => s.scenarioId === 'trading-initial-insufficient-credit',
    );
    expect(initialRejectScenario).toBeDefined();
    expect(initialRejectScenario!.status).toBe('pass');
  });

  it('demonstrates functional failure on supported faulty candidate-c (used-credit bug)', async () => {
    const snapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const result = await runFunctionalBaselines({
      variant: 'candidate-c',
      systemSnapshot: snapshot,
    });

    // Candidate-c ignores used credit in canReserve, improperly accepting the second order!
    expect(result.status).toBe('fail');
    expect(result.summary.failed).toBeGreaterThanOrEqual(1);

    const usedCreditScenario = result.scenarios.find(
      (s) => s.scenarioId === 'trading-used-credit-admission-rejection',
    );
    expect(usedCreditScenario).toBeDefined();
    expect(usedCreditScenario!.status).toBe('fail');

    const rejectDelivery = usedCreditScenario!.assertions.find(
      (a) => a.id === 'used-credit-admission-rejection.delivery-rejected',
    );
    expect(rejectDelivery).toBeDefined();
    expect(rejectDelivery!.status).toBe('fail');
    expect(JSON.parse(rejectDelivery!.actual).status).toBe('accepted');
    expect(rejectDelivery!.detail).toContain('business delivery');
  });

  it('rejects unsupported inventory-reservation and unconfigured adapters', async () => {
    const inventorySnapshot = await createSystemSnapshot({
      ...SEEDED_TRADING_BRIEF,
      id: 'inventory-system',
      adapterId: 'inventory-reservation',
    });

    await expect(
      runFunctionalBaselines({
        variant: 'clean',
        systemSnapshot: inventorySnapshot,
      }),
    ).rejects.toThrow(/only supported for the "synthetic-trading" adapter/);
  });

  it('rejects unsupported variant for synthetic-trading', async () => {
    const snapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    await expect(
      runFunctionalBaselines({
        variant: 'inventory-candidate-a' as any,
        systemSnapshot: snapshot,
      }),
    ).rejects.toThrow(/Unsupported target variant/);
  });
});
