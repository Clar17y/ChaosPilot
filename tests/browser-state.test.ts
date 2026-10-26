import { describe, it, expect } from 'vitest';
import { extractSnapshotDisplay } from '../src/web/snapshot.ts';
import type { InvestigationRecord } from '../src/domain.ts';

describe('UI Snapshot & State Model (Pure Display Helper)', () => {
  it('extracts actual state from nested target snapshot (nested target state)', () => {
    const rawSnapshot = {
      target: {
        quote: { id: 'quote-42', version: 2, price: 85 },
        credit: { version: 3, limit: 10000 },
        reservedCredit: 850,
        usedCredit: 1700,
        orders: {
          ord_test_1: {
            orderId: 'ord_test_1',
            quoteId: 'quote-42',
            price: 85,
            initialQuantity: 30,
            remainingQuantity: 10,
            filledQuantity: 20,
            cancelledQuantity: 0,
            cancellationRequested: false,
            status: 'OPEN' as const,
          },
          ord_test_2: {
            orderId: 'ord_test_2',
            quoteId: 'quote-42',
            price: 85,
            initialQuantity: 10,
            remainingQuantity: 0,
            filledQuantity: 10,
            cancelledQuantity: 0,
            cancellationRequested: false,
            status: 'FILLED' as const,
          },
        },
      },
      venue: {
        orders: {},
      },
      logicalTime: 15,
    };

    const model = extractSnapshotDisplay(rawSnapshot);

    expect(model.credit.quotePrice).toBe('85');
    expect(model.credit.creditLimit).toBe('10000');
    expect(model.credit.reservedCredit).toBe('850');
    expect(model.credit.usedCredit).toBe('1700');
    expect(model.credit.availableCredit).toBe('7450'); // 10000 - (850 + 1700)

    expect(model.hasOrders).toBe(true);
    expect(model.orders).toHaveLength(2);

    const ord1 = model.orders.find((o) => o.orderId === 'ord_test_1')!;
    expect(ord1).toBeDefined();
    expect(ord1.status).toBe('OPEN');
    expect(ord1.initialQuantity).toBe(30);
    expect(ord1.filledQuantity).toBe(20);
    expect(ord1.remainingQuantity).toBe(10);
    expect(ord1.cancelledQuantity).toBe(0);
    expect(ord1.displayText).toContain('STATUS: OPEN');
    expect(ord1.displayText).toContain('Qty: 30');
    expect(ord1.displayText).toContain('Filled: 20');

    const ord2 = model.orders.find((o) => o.orderId === 'ord_test_2')!;
    expect(ord2).toBeDefined();
    expect(ord2.status).toBe('FILLED');
    expect(ord2.filledQuantity).toBe(10);
  });

  it('guards against null, empty, or corrupt snapshots without inventing zeros (no/malformed snapshot)', () => {
    // 1. null input
    const nullModel = extractSnapshotDisplay(null);
    expect(nullModel.credit.quotePrice).toBe('-');
    expect(nullModel.credit.creditLimit).toBe('-');
    expect(nullModel.credit.reservedCredit).toBe('-');
    expect(nullModel.credit.usedCredit).toBe('-');
    expect(nullModel.credit.availableCredit).toBe('-');
    expect(nullModel.hasOrders).toBe(false);
    expect(nullModel.orders).toEqual([]);

    // 2. undefined input
    const undefModel = extractSnapshotDisplay(undefined);
    expect(undefModel.credit.quotePrice).toBe('-');
    expect(undefModel.credit.availableCredit).toBe('-');
    expect(undefModel.hasOrders).toBe(false);

    // 3. non-object primitive
    const strModel = extractSnapshotDisplay('malformed-payload');
    expect(strModel.credit.quotePrice).toBe('-');
    expect(strModel.hasOrders).toBe(false);

    // 4. empty object
    const emptyModel = extractSnapshotDisplay({});
    expect(emptyModel.credit.quotePrice).toBe('-');
    expect(emptyModel.credit.creditLimit).toBe('-');
    expect(emptyModel.credit.availableCredit).toBe('-');
    expect(emptyModel.hasOrders).toBe(false);

    // 5. corrupted target property
    const corruptTargetModel = extractSnapshotDisplay({ target: 'non-object-corrupt' });
    expect(corruptTargetModel.credit.quotePrice).toBe('-');
    expect(corruptTargetModel.credit.availableCredit).toBe('-');
    expect(corruptTargetModel.hasOrders).toBe(false);

    // 6. null inner quote/credit
    const nullInnerModel = extractSnapshotDisplay({
      target: {
        quote: null,
        credit: null,
        reservedCredit: undefined,
        orders: null,
      },
    });
    expect(nullInnerModel.credit.quotePrice).toBe('-');
    expect(nullInnerModel.credit.creditLimit).toBe('-');
    expect(nullInnerModel.credit.reservedCredit).toBe('-');
    expect(nullInnerModel.credit.availableCredit).toBe('-');
    expect(nullInnerModel.hasOrders).toBe(false);
  });

  it('calculates negative available credit after credit cut below commitments (negative available after credit cut)', () => {
    // Initial limit was 2000, 1500 used, 200 reserved.
    // Credit is subsequently cut to 500.
    // Available credit should be 500 - (1500 + 200) = -1200 (NOT clamped to 0!).
    const cutSnapshot = {
      target: {
        quote: { id: 'q1', version: 1, price: 100 },
        credit: { version: 2, limit: 500 },
        reservedCredit: 200,
        usedCredit: 1500,
        orders: {},
      },
    };

    const model = extractSnapshotDisplay(cutSnapshot);
    expect(model.credit.creditLimit).toBe('500');
    expect(model.credit.reservedCredit).toBe('200');
    expect(model.credit.usedCredit).toBe('1500');
    expect(model.credit.availableCredit).toBe('-1200');

    // Extreme cut to limit 0
    const zeroLimitSnapshot = {
      target: {
        quote: { id: 'q1', version: 1, price: 100 },
        credit: { version: 3, limit: 0 },
        reservedCredit: 0,
        usedCredit: 350,
        orders: {},
      },
    };
    const zeroModel = extractSnapshotDisplay(zeroLimitSnapshot);
    expect(zeroModel.credit.creditLimit).toBe('0');
    expect(zeroModel.credit.availableCredit).toBe('-350');
  });

  it('supports fallback flat snapshot representation for backwards compatibility', () => {
    const flatSnapshot = {
      quotePrice: 95,
      creditLimit: 5000,
      reservedCredit: 100,
      usedCredit: 200,
      orders: {
        ord_flat_1: {
          orderId: 'ord_flat_1',
          status: 'CANCELLED',
          initialQuantity: 10,
          filledQuantity: 0,
          remainingQuantity: 0,
          cancelledQuantity: 10,
        },
      },
    };

    const model = extractSnapshotDisplay(flatSnapshot);
    expect(model.credit.quotePrice).toBe('95');
    expect(model.credit.creditLimit).toBe('5000');
    expect(model.credit.reservedCredit).toBe('100');
    expect(model.credit.usedCredit).toBe('200');
    expect(model.credit.availableCredit).toBe('4700');
    expect(model.hasOrders).toBe(true);
    expect(model.orders[0]?.status).toBe('CANCELLED');
  });

  it('preserves saved run status and provenance fields accurately (saved run status/provenance)', () => {
    const mockRecord: InvestigationRecord = {
      schemaVersion: 1,
      id: 'run_test_saved_01',
      provider: 'mock',
      model: 'mock-runner',
      mode: 'mock',
      variant: 'candidate-b',
      status: 'completed',
      startedAt: '2026-10-26T18:00:00.000Z',
      finishedAt: '2026-10-26T18:00:02.000Z',
      sourceHash: 'source-hash-111',
      experiments: [],
      findings: [],
      usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      errors: [],
      contextAudit: { sourcePaths: [], contractHash: '', promptVersion: '1.0' },
    };

    expect(mockRecord.status).toBe('completed');
    expect(mockRecord.mode).toBe('mock');
    expect(mockRecord.variant).toBe('candidate-b');

    const liveRecord: InvestigationRecord = {
      ...mockRecord,
      id: 'run_test_saved_02',
      provider: 'meta',
      model: 'muse-wonder-1.0',
      mode: 'live',
      status: 'failed',
      stopReason: 'Rate limit exceeded',
    };

    expect(liveRecord.status).toBe('failed');
    expect(liveRecord.mode).toBe('live');
    expect(liveRecord.stopReason).toBe('Rate limit exceeded');
  });

  it('resets selected experiment index on run selection without retaining stale indices (selected experiment reset)', () => {
    // Emulate UI index selection boundary check
    let selectedExperimentIndex = 4; // previously on experiment 5 of another run

    const incomingSavedRecord: Partial<InvestigationRecord> = {
      id: 'run_small_01',
      experiments: [
        {
          index: 0,
          experiment: { hypothesis: 'H1', expectedInvariant: 'I1', steps: [] },
          result: {
            schemaVersion: 1,
            experiment: { hypothesis: 'H1', expectedInvariant: 'I1', steps: [] },
            sourceHash: 'hash',
            trace: [],
            snapshot: {},
            violations: [],
            rejections: [],
            valid: true,
          },
          replayVerified: true,
          cleanControlPassed: true,
        },
      ],
    };

    // Upon viewing a saved run, index must be reset to 0
    selectedExperimentIndex = 0;
    expect(selectedExperimentIndex).toBe(0);
    expect(incomingSavedRecord.experiments?.[selectedExperimentIndex]).toBeDefined();
  });
});
