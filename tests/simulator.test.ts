import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Action, Experiment, TargetVariant } from '../src/domain.ts';
import { TARGET_VARIANTS } from '../src/domain.ts';
import {
  computeSourceHash,
  executeExperiment,
  getContract,
  getSourceBundle,
  parseExperiment,
} from '../src/simulator/index.ts';

describe('Simulator Contract and Bundle Separation', () => {
  it('exports system contract with neutral documentation and no defect hints', () => {
    const contract = getContract();
    expect(contract.name).toBe('ChaosPilot Trading Gateway');
    expect(contract.operations.length).toBeGreaterThanOrEqual(7);
    expect(contract.messages.length).toBeGreaterThanOrEqual(6);
    expect(contract.invariants.length).toBeGreaterThanOrEqual(7);
    expect(contract.limits.maxQuantity).toBe(1_000_000);

    const serialized = JSON.stringify(contract).toLowerCase();
    expect(serialized).not.toContain('candidate-a');
    expect(serialized).not.toContain('candidate-b');
    expect(serialized).not.toContain('defect');
    expect(serialized).not.toMatch(/\bfault\b/);
    expect(serialized).not.toContain('bug');
  });

  it('provides isolated source bundles with neutral filenames and exact hash matching', () => {
    for (const variant of TARGET_VARIANTS) {
      const bundle = getSourceBundle(variant);
      expect(bundle.hash).toBeDefined();
      expect(bundle.files).toHaveLength(3);

      const paths = bundle.files.map((f) => f.path).sort();
      expect(paths).toEqual(['credit-manager.ts', 'decoder.ts', 'order-engine.ts']);

      // Hash matches computeSourceHash
      expect(computeSourceHash(bundle.files)).toBe(bundle.hash);

      // Verify no leaked answer keys or hidden variant switches in source files
      for (const file of bundle.files) {
        for (const candidate of TARGET_VARIANTS) {
          if (candidate !== 'clean') {
            expect(file.content).not.toContain(candidate);
          }
        }

        expect(file.content).not.toContain('defect');
        expect(file.content).not.toContain('oracle');
      }

      // Hash matches execution result
      const exp: Experiment = {
        hypothesis: 'test hash',
        expectedInvariant: 'credit_non_negative',
        steps: [],
      };
      const result = executeExperiment(exp, variant);
      expect(result.sourceHash).toBe(bundle.hash);
    }
  });

  it('ensures different variants have distinct source hashes', () => {
    const hashes = TARGET_VARIANTS.map((v) => getSourceBundle(v).hash);
    const uniqueHashes = new Set(hashes);
    expect(uniqueHashes.size).toBe(TARGET_VARIANTS.length);
  });
});

describe('Experiment Parser Validation', () => {
  it('parses valid experiment with all action types and accepts arbitrary JSON payloads', () => {
    const raw = {
      hypothesis: 'Arbitrary payloads and actions',
      expectedInvariant: 'credit_non_negative',
      steps: [
        { op: 'send', id: 'm1', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 100 } },
        { op: 'send', id: 'm2', to: 'client', payload: 'scalar-string-payload' },
        { op: 'send', id: 'm3', to: 'client', payload: null },
        { op: 'send', id: 'm4', to: 'client', payload: [1, 2, 3] },
        { op: 'duplicate', messageId: 'm1', id: 'm1-dup', delay: 2 },
        { op: 'advance', ticks: 5 },
        { op: 'deliver', messageId: 'm1' },
        { op: 'drain' },
        { op: 'fill', messageId: 'm5', orderId: 'ord-1', executionId: 'exec-1', quantity: 5, delay: 1 },
        { op: 'confirm_cancel', messageId: 'm6', orderId: 'ord-1', delay: 1 },
      ],
    };

    const parsed = parseExperiment(raw);
    expect(parsed.hypothesis).toBe('Arbitrary payloads and actions');
    expect(parsed.steps).toHaveLength(10);
  });

  it('rejects malformed experiments and invalid actions', () => {
    expect(() => parseExperiment(null)).toThrow();
    expect(() => parseExperiment({ hypothesis: 'missing invariant', steps: [] })).toThrow();
    expect(() =>
      parseExperiment({
        hypothesis: 'h',
        expectedInvariant: 'inv',
        steps: [{ op: 'unknown_op' }],
      }),
    ).toThrow();
    expect(() =>
      parseExperiment({
        hypothesis: 'h',
        expectedInvariant: 'inv',
        steps: [{ op: 'send', id: 's1', to: 'invalid_channel', payload: {} }],
      }),
    ).toThrow();
    expect(() =>
      parseExperiment({
        hypothesis: 'h',
        expectedInvariant: 'inv',
        steps: [{ op: 'advance', ticks: -1 }],
      }),
    ).toThrow();
    expect(() =>
      parseExperiment({
        hypothesis: 'h',
        expectedInvariant: 'inv',
        steps: [{ op: 'fill', messageId: 'm1', orderId: 'o1', executionId: 'e1', quantity: 0 }],
      }),
    ).toThrow();
  });
});

describe('Replay, Determinism, Ties and Input Handling', () => {
  it('produces identical deterministic semantic traces and snapshots on replay', () => {
    const experiment: Experiment = {
      hypothesis: 'Replay determinism',
      expectedInvariant: 'credit_non_negative',
      steps: [
        { op: 'send', id: 'm-quote', to: 'market', payload: { type: 'quote', id: 'q-1', version: 1, price: 50 }, delay: 0 },
        { op: 'send', id: 'm-credit', to: 'credit', payload: { type: 'credit_limit', id: 'c-1', version: 1, limit: 5000 }, delay: 0 },
        { op: 'deliver', messageId: 'm-quote' },
        { op: 'deliver', messageId: 'm-credit' },
        { op: 'send', id: 'm-order', to: 'client', payload: { type: 'new_order', id: 'o-msg-1', orderId: 'ord-100', quantity: 10, quoteId: 'q-1' } },
        { op: 'deliver', messageId: 'm-order' },
        { op: 'fill', messageId: 'm-fill', orderId: 'ord-100', executionId: 'exec-1', quantity: 4, delay: 2 },
        { op: 'advance', ticks: 2 },
        { op: 'deliver', messageId: 'm-fill' },
      ],
    };

    const run1 = executeExperiment(experiment, 'clean');
    const run2 = executeExperiment(experiment, 'clean');

    expect(run1.valid).toBe(true);
    expect(run1.violations).toHaveLength(0);
    expect(run1.trace).toEqual(run2.trace);
    expect(run1.snapshot).toEqual(run2.snapshot);
  });

  it('breaks ties deterministically by insertion sequence during drain', () => {
    const experiment: Experiment = {
      hypothesis: 'Tie breaking by insertion order',
      expectedInvariant: 'credit_non_negative',
      steps: [
        // Both scheduled with same dueTime = 0
        { op: 'send', id: 'm-first', to: 'market', payload: { type: 'quote', id: 'q-first', version: 1, price: 10 }, delay: 0 },
        { op: 'send', id: 'm-second', to: 'market', payload: { type: 'quote', id: 'q-second', version: 2, price: 20 }, delay: 0 },
        { op: 'drain' },
      ],
    };

    const result = executeExperiment(experiment, 'clean');
    expect(result.valid).toBe(true);

    const deliveries = result.trace.filter((t) => t.action === 'drain:deliver');
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]?.messageId).toBe('m-first');
    expect(deliveries[1]?.messageId).toBe('m-second');

    // Final active quote price should be from the second update
    const targetState = result.snapshot as { target: { quote: { price: number } } };
    expect(targetState.target.quote.price).toBe(20);
  });

  it('handles message delay and delivery reordering', () => {
    const experiment: Experiment = {
      hypothesis: 'Delay and reordering',
      expectedInvariant: 'credit_non_negative',
      steps: [
        // m-delayed has delay 5; m-immediate has delay 0
        { op: 'send', id: 'm-delayed', to: 'market', payload: { type: 'quote', id: 'q-old', version: 1, price: 10 }, delay: 5 },
        { op: 'send', id: 'm-immediate', to: 'market', payload: { type: 'quote', id: 'q-new', version: 2, price: 20 }, delay: 0 },
        { op: 'drain' },
      ],
    };

    const result = executeExperiment(experiment, 'clean');
    expect(result.valid).toBe(true);

    const deliveries = result.trace.filter((t) => t.action === 'drain:deliver');
    expect(deliveries).toHaveLength(2);
    // m-immediate must be delivered first at time 0
    expect(deliveries[0]?.messageId).toBe('m-immediate');
    expect(deliveries[0]?.time).toBe(0);
    // m-delayed delivered second after time advances to 5
    expect(deliveries[1]?.messageId).toBe('m-delayed');
    expect(deliveries[1]?.time).toBe(5);

    // Because version 1 was delivered after version 2, version 1 is stale and ignored!
    const targetState = result.snapshot as { target: { quote: { version: number; price: number } } };
    expect(targetState.target.quote.version).toBe(2);
    expect(targetState.target.quote.price).toBe(20);
  });

  it('creates duplicate envelopes with new transport IDs via duplicate action', () => {
    const experiment: Experiment = {
      hypothesis: 'Duplicate envelope creation',
      expectedInvariant: 'credit_non_negative',
      steps: [
        { op: 'send', id: 'm-orig', to: 'market', payload: { type: 'quote', id: 'q-1', version: 1, price: 50 } },
        { op: 'duplicate', messageId: 'm-orig', id: 'm-dup', delay: 1 },
        { op: 'deliver', messageId: 'm-orig' },
        { op: 'advance', ticks: 1 },
        { op: 'deliver', messageId: 'm-dup' },
      ],
    };

    const result = executeExperiment(experiment, 'clean');
    expect(result.valid).toBe(true);
    expect(result.rejections).toHaveLength(0);

    const targetState = result.snapshot as { target: { quote: { id: string } } };
    expect(targetState.target.quote.id).toBe('q-1');
  });

  it('safely handles scalar, null, array and malformed payloads without state mutation', () => {
    const experiment: Experiment = {
      hypothesis: 'Malformed payload robustness',
      expectedInvariant: 'credit_non_negative',
      steps: [
        { op: 'send', id: 'm-scalar-num', to: 'market', payload: 12345 },
        { op: 'send', id: 'm-scalar-str', to: 'client', payload: 'bad payload' },
        { op: 'send', id: 'm-null', to: 'credit', payload: null },
        { op: 'send', id: 'm-arr', to: 'reports', payload: [1, 2, 3] },
        { op: 'send', id: 'm-wrong-chan', to: 'credit', payload: { type: 'quote', id: 'q1', version: 1, price: 10 } },
        { op: 'send', id: 'm-missing-fields', to: 'market', payload: { type: 'quote' } },
        { op: 'drain' },
      ],
    };

    const result = executeExperiment(experiment, 'clean');
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);

    const targetState = result.snapshot as { target: { quote: unknown; credit: unknown } };
    expect(targetState.target.quote).toBeNull();
    expect(targetState.target.credit).toBeNull();
  });

  it('safely handles prototype-like identities without prototype pollution or crashes', () => {
    const experiment: Experiment = {
      hypothesis: 'Prototype key safety',
      expectedInvariant: 'credit_non_negative',
      steps: [
        { op: 'send', id: 'q', to: 'market', payload: { type: 'quote', id: '__proto__', version: 1, price: 10 } },
        { op: 'send', id: 'c', to: 'credit', payload: { type: 'credit_limit', id: 'constructor', version: 1, limit: 1000 } },
        { op: 'deliver', messageId: 'q' },
        { op: 'deliver', messageId: 'c' },
        {
          op: 'send',
          id: 'ord-proto',
          to: 'client',
          payload: { type: 'new_order', id: 'o1', orderId: '__proto__', quantity: 5, quoteId: '__proto__' },
        },
        {
          op: 'send',
          id: 'ord-ctor',
          to: 'client',
          payload: { type: 'new_order', id: 'o2', orderId: 'constructor', quantity: 5, quoteId: '__proto__' },
        },
        {
          op: 'send',
          id: 'ord-tostr',
          to: 'client',
          payload: { type: 'new_order', id: 'o3', orderId: 'toString', quantity: 5, quoteId: '__proto__' },
        },
        { op: 'drain' },
      ],
    };

    const result = executeExperiment(experiment, 'clean');
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);

    const targetState = result.snapshot as {
      target: { orders: Record<string, unknown>; reservedCredit: number };
    };
    expect(targetState.target.orders['__proto__']).toBeDefined();
    expect(targetState.target.orders['constructor']).toBeDefined();
    expect(targetState.target.orders['toString']).toBeDefined();
    expect(targetState.target.reservedCredit).toBe(150);
  });

  it('records explicit rejections for invalid test actions and sets valid=false without creating findings', () => {
    const experiment: Experiment = {
      hypothesis: 'Invalid test actions',
      expectedInvariant: 'credit_non_negative',
      steps: [
        // Deliver non-existent message
        { op: 'deliver', messageId: 'non-existent' },
        // Deliver before due time
        { op: 'send', id: 'm-future', to: 'market', payload: { type: 'quote', id: 'q', version: 1, price: 10 }, delay: 10 },
        { op: 'deliver', messageId: 'm-future' },
        // Duplicate non-existent message
        { op: 'duplicate', messageId: 'ghost', id: 'ghost-dup' },
        // Fill unknown order
        { op: 'fill', messageId: 'f1', orderId: 'unknown-ord', executionId: 'e1', quantity: 5 },
        // Confirm cancel unknown order
        { op: 'confirm_cancel', messageId: 'c1', orderId: 'unknown-ord' },
      ],
    };

    const result = executeExperiment(experiment, 'clean');
    expect(result.valid).toBe(false);
    expect(result.rejections.length).toBe(5);
    // Invalid test actions do NOT count as invariant violations
    expect(result.violations).toHaveLength(0);
  });
});

describe('Coupled Credit and Lifecycle Accounting', () => {
  it('manages overlapping admissions and enforces credit limit', () => {
    const experiment: Experiment = {
      hypothesis: 'Overlapping admissions',
      expectedInvariant: 'credit_limit_respected',
      steps: [
        { op: 'send', id: 'q', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 100 } },
        { op: 'send', id: 'c', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 1500 } },
        { op: 'deliver', messageId: 'q' },
        { op: 'deliver', messageId: 'c' },
        // Order 1: 10 @ $100 = $1,000 (leaves $500)
        { op: 'send', id: 'o1', to: 'client', payload: { type: 'new_order', id: 'm-o1', orderId: 'ord-1', quantity: 10, quoteId: 'q1' } },
        { op: 'deliver', messageId: 'o1' },
        // Order 2: 5 @ $100 = $500 (leaves $0)
        { op: 'send', id: 'o2', to: 'client', payload: { type: 'new_order', id: 'm-o2', orderId: 'ord-2', quantity: 5, quoteId: 'q1' } },
        { op: 'deliver', messageId: 'o2' },
        // Order 3: 1 @ $100 = $100 (exceeds remaining credit $0 -> target rejects order)
        { op: 'send', id: 'o3', to: 'client', payload: { type: 'new_order', id: 'm-o3', orderId: 'ord-3', quantity: 1, quoteId: 'q1' } },
        { op: 'deliver', messageId: 'o3' },
      ],
    };

    const result = executeExperiment(experiment, 'clean');
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);

    const target = (result.snapshot as { target: { reservedCredit: number; orders: Record<string, unknown> } }).target;
    expect(target.reservedCredit).toBe(1500);
    expect(target.orders['ord-1']).toBeDefined();
    expect(target.orders['ord-2']).toBeDefined();
    expect(target.orders['ord-3']).toBeUndefined();
  });

  it('processes partial fill followed by cancellation correctly on clean', () => {
    const experiment: Experiment = {
      hypothesis: 'Partial fill + cancel',
      expectedInvariant: 'credit_exposure_consistency',
      steps: [
        { op: 'send', id: 'q', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 100 } },
        { op: 'send', id: 'c', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 5000 } },
        { op: 'deliver', messageId: 'q' },
        { op: 'deliver', messageId: 'c' },
        // Order for 10 units = $1,000 reserved
        { op: 'send', id: 'o1', to: 'client', payload: { type: 'new_order', id: 'm-o1', orderId: 'ord-1', quantity: 10, quoteId: 'q1' } },
        { op: 'deliver', messageId: 'o1' },
        // Partial fill of 4 units
        { op: 'fill', messageId: 'rep-fill', orderId: 'ord-1', executionId: 'exec-1', quantity: 4, delay: 0 },
        { op: 'deliver', messageId: 'rep-fill' },
        // Cancel remaining 6 units
        { op: 'confirm_cancel', messageId: 'rep-cancel', orderId: 'ord-1', delay: 0 },
        { op: 'deliver', messageId: 'rep-cancel' },
      ],
    };

    const result = executeExperiment(experiment, 'clean');
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);

    const target = (
      result.snapshot as {
        target: {
          reservedCredit: number;
          usedCredit: number;
          orders: Record<string, { filledQuantity: number; remainingQuantity: number; cancelledQuantity: number }>;
        };
      }
    ).target;

    expect(target.reservedCredit).toBe(0);
    expect(target.usedCredit).toBe(400);
    expect(target.orders['ord-1']?.filledQuantity).toBe(4);
    expect(target.orders['ord-1']?.remainingQuantity).toBe(0);
    expect(target.orders['ord-1']?.cancelledQuantity).toBe(6);
  });

  it('handles credit limit cuts without invalidating existing exposure', () => {
    const experiment: Experiment = {
      hypothesis: 'Credit limit cuts',
      expectedInvariant: 'credit_non_negative',
      steps: [
        { op: 'send', id: 'q', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 100 } },
        { op: 'send', id: 'c1', to: 'credit', payload: { type: 'credit_limit', id: 'c-up1', version: 1, limit: 1000 } },
        { op: 'deliver', messageId: 'q' },
        { op: 'deliver', messageId: 'c1' },
        // Order uses $800 of credit
        { op: 'send', id: 'o1', to: 'client', payload: { type: 'new_order', id: 'm-o1', orderId: 'ord-1', quantity: 8, quoteId: 'q1' } },
        { op: 'deliver', messageId: 'o1' },
        // Credit cut: limit lowered to $300 (below current $800 exposure)
        { op: 'send', id: 'c2', to: 'credit', payload: { type: 'credit_limit', id: 'c-up2', version: 2, limit: 300 } },
        { op: 'deliver', messageId: 'c2' },
        // New order for $100 rejected because exposure ($800) >= limit ($300)
        { op: 'send', id: 'o2', to: 'client', payload: { type: 'new_order', id: 'm-o2', orderId: 'ord-2', quantity: 1, quoteId: 'q1' } },
        { op: 'deliver', messageId: 'o2' },
      ],
    };

    const result = executeExperiment(experiment, 'clean');
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);

    const target = (
      result.snapshot as {
        target: { credit: { limit: number }; reservedCredit: number; orders: Record<string, unknown> };
      }
    ).target;
    expect(target.credit.limit).toBe(300);
    expect(target.reservedCredit).toBe(800);
    expect(target.orders['ord-2']).toBeUndefined();
  });

  it('handles double cancellation without double-releasing credit on clean', () => {
    const experiment: Experiment = {
      hypothesis: 'Double cancellation idempotency',
      expectedInvariant: 'credit_exposure_consistency',
      steps: [
        { op: 'send', id: 'q', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 10 } },
        { op: 'send', id: 'c', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 1000 } },
        { op: 'deliver', messageId: 'q' },
        { op: 'deliver', messageId: 'c' },
        // Order 10 @ $10 = $100 reserved
        { op: 'send', id: 'o1', to: 'client', payload: { type: 'new_order', id: 'm-o1', orderId: 'ord-1', quantity: 10, quoteId: 'q1' } },
        { op: 'deliver', messageId: 'o1' },
        // Venue confirms cancel of all 10 units
        { op: 'confirm_cancel', messageId: 'rep-cancel-1', orderId: 'ord-1', delay: 0 },
        { op: 'deliver', messageId: 'rep-cancel-1' },
        // Duplicate cancellation report delivered with new envelope ID but same report id
        { op: 'duplicate', messageId: 'rep-cancel-1', id: 'rep-cancel-dup', delay: 0 },
        { op: 'deliver', messageId: 'rep-cancel-dup' },
      ],
    };

    const result = executeExperiment(experiment, 'clean');
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);

    const target = (
      result.snapshot as {
        target: {
          reservedCredit: number;
          orders: Record<string, { filledQuantity: number; remainingQuantity: number; cancelledQuantity: number }>;
        };
      }
    ).target;

    expect(target.reservedCredit).toBe(0);
    expect(target.orders['ord-1']?.cancelledQuantity).toBe(10);
    expect(target.orders['ord-1']?.remainingQuantity).toBe(0);
  });

  it('ignores stale quote and credit limit updates without mutating active state', () => {
    const experiment: Experiment = {
      hypothesis: 'Stale version rejection',
      expectedInvariant: 'version_monotonicity',
      steps: [
        { op: 'send', id: 'q2', to: 'market', payload: { type: 'quote', id: 'q-v2', version: 2, price: 50 } },
        { op: 'send', id: 'c3', to: 'credit', payload: { type: 'credit_limit', id: 'c-v3', version: 3, limit: 5000 } },
        { op: 'deliver', messageId: 'q2' },
        { op: 'deliver', messageId: 'c3' },
        // Stale quote version 1
        { op: 'send', id: 'q1', to: 'market', payload: { type: 'quote', id: 'q-v1', version: 1, price: 40 } },
        { op: 'deliver', messageId: 'q1' },
        // Equal quote version 2
        { op: 'send', id: 'q2-dup', to: 'market', payload: { type: 'quote', id: 'q-v2-dup', version: 2, price: 99 } },
        { op: 'deliver', messageId: 'q2-dup' },
        // Stale credit version 2
        { op: 'send', id: 'c2', to: 'credit', payload: { type: 'credit_limit', id: 'c-v2', version: 2, limit: 100 } },
        { op: 'deliver', messageId: 'c2' },
      ],
    };

    const result = executeExperiment(experiment, 'clean');
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);

    const target = (
      result.snapshot as {
        target: { quote: { version: number; price: number }; credit: { version: number; limit: number } };
      }
    ).target;

    expect(target.quote.version).toBe(2);
    expect(target.quote.price).toBe(50);
    expect(target.credit.version).toBe(3);
    expect(target.credit.limit).toBe(5000);
  });
});

describe('Discriminating Candidate Fault Scenarios', () => {
  const candidateAExperiment: Experiment = {
    hypothesis: 'Missing execution deduplication on redelivery (Candidate A)',
    expectedInvariant: 'execution_idempotency',
    steps: [
      { op: 'send', id: 'q', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 10 } },
      { op: 'send', id: 'c', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 1000 } },
      { op: 'deliver', messageId: 'q' },
      { op: 'deliver', messageId: 'c' },
      // Order 10 @ $10 = $100 reserved
      { op: 'send', id: 'o1', to: 'client', payload: { type: 'new_order', id: 'm-o1', orderId: 'ord-1', quantity: 10, quoteId: 'q1' } },
      { op: 'deliver', messageId: 'o1' },
      // Venue fills 5 units
      { op: 'fill', messageId: 'rep-fill-1', orderId: 'ord-1', executionId: 'exec-idemp-1', quantity: 5, delay: 0 },
      { op: 'deliver', messageId: 'rep-fill-1' },
      // Duplicate execution report delivered with new envelope transport ID but SAME executionId
      { op: 'duplicate', messageId: 'rep-fill-1', id: 'rep-fill-redelivered', delay: 0 },
      { op: 'deliver', messageId: 'rep-fill-redelivered' },
    ],
  };

  it('Candidate A FAILS on execution report redelivery while Clean and Candidate B PASS', () => {
    // 1. Clean control must PASS with zero violations
    const cleanResult = executeExperiment(candidateAExperiment, 'clean');
    expect(cleanResult.valid).toBe(true);
    expect(cleanResult.violations).toHaveLength(0);

    // 2. Candidate A must FAIL with reproducible execution idempotency violations
    const candidateAResult = executeExperiment(candidateAExperiment, 'candidate-a');
    expect(candidateAResult.valid).toBe(true);
    expect(candidateAResult.violations.length).toBeGreaterThan(0);
    const idempotencyViolation = candidateAResult.violations.find((v) => v.invariant === 'execution_idempotency');
    expect(idempotencyViolation).toBeDefined();
    expect(idempotencyViolation?.evidence).toMatchObject({
      executionId: 'exec-idemp-1',
      orderId: 'ord-1',
    });

    // 3. Candidate B must PASS this test (independent defects)
    const candidateBResult = executeExperiment(candidateAExperiment, 'candidate-b');
    expect(candidateBResult.valid).toBe(true);
    expect(candidateBResult.violations).toHaveLength(0);
  });

  const candidateBExperiment: Experiment = {
    hypothesis: 'Cancel acknowledgement arriving before delayed execution report (Candidate B)',
    expectedInvariant: 'credit_non_negative',
    steps: [
      { op: 'send', id: 'q', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 10 } },
      { op: 'send', id: 'c', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 1000 } },
      { op: 'deliver', messageId: 'q' },
      { op: 'deliver', messageId: 'c' },
      // Order 10 @ $10 = $100 reserved
      { op: 'send', id: 'o1', to: 'client', payload: { type: 'new_order', id: 'm-o1', orderId: 'ord-1', quantity: 10, quoteId: 'q1' } },
      { op: 'deliver', messageId: 'o1' },
      // Venue fills 4 units, but execution report has delay: 5 (delayed in flight)
      { op: 'fill', messageId: 'rep-fill-delayed', orderId: 'ord-1', executionId: 'exec-1', quantity: 4, delay: 5 },
      // Venue confirms cancel of remaining 6 units with delay: 0 (delivered immediately)
      { op: 'confirm_cancel', messageId: 'rep-cancel-early', orderId: 'ord-1', delay: 0 },
      // Cancel ack arrives FIRST
      { op: 'deliver', messageId: 'rep-cancel-early' },
      // Later, advance time and deliver delayed fill report
      { op: 'advance', ticks: 5 },
      { op: 'deliver', messageId: 'rep-fill-delayed' },
    ],
  };

  it('Candidate B FAILS on cancel ack delivered before delayed fill while Clean and Candidate A PASS', () => {
    // 1. Clean control must PASS with zero violations
    const cleanResult = executeExperiment(candidateBExperiment, 'clean');
    expect(cleanResult.valid).toBe(true);
    expect(cleanResult.violations).toHaveLength(0);

    const cleanTarget = (
      cleanResult.snapshot as { target: { reservedCredit: number; usedCredit: number } }
    ).target;
    expect(cleanTarget.reservedCredit).toBe(0);
    expect(cleanTarget.usedCredit).toBe(40);

    // 2. Candidate B must FAIL with credit_non_negative / credit_exposure_consistency violations
    const candidateBResult = executeExperiment(candidateBExperiment, 'candidate-b');
    expect(candidateBResult.valid).toBe(true);
    expect(candidateBResult.violations.length).toBeGreaterThan(0);
    const creditViolation = candidateBResult.violations.find((v) => v.invariant === 'credit_non_negative');
    expect(creditViolation).toBeDefined();
    expect(creditViolation?.evidence).toMatchObject({
      reservedCredit: -40,
    });

    // 3. Candidate A must PASS this test (independent defects)
    const candidateAResult = executeExperiment(candidateBExperiment, 'candidate-a');
    expect(candidateAResult.valid).toBe(true);
    expect(candidateAResult.violations).toHaveLength(0);
  });
});

describe('Clean Robustness and Business Identities', () => {
  it('rejects overfill and wrong price without state mutation on clean', () => {
    const experiment: Experiment = {
      hypothesis: 'Overfill and wrong price rejection',
      expectedInvariant: 'credit_exposure_consistency',
      steps: [
        { op: 'send', id: 'q', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 100 } },
        { op: 'send', id: 'c', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 5000 } },
        { op: 'deliver', messageId: 'q' },
        { op: 'deliver', messageId: 'c' },
        // Order for 10 @ $100 = $1000 reserved
        { op: 'send', id: 'o', to: 'client', payload: { type: 'new_order', id: 'm-o', orderId: 'ord-1', quantity: 10, quoteId: 'q1' } },
        { op: 'deliver', messageId: 'o' },
        // Execution with WRONG price: 90 instead of 100
        {
          op: 'send',
          id: 'rep-bad-price',
          to: 'reports',
          payload: { type: 'execution', id: 'rep-1', orderId: 'ord-1', executionId: 'e-bad-price', quantity: 5, price: 90, occurredAt: 1 },
        },
        { op: 'deliver', messageId: 'rep-bad-price' },
        // Execution with OVERFILL quantity: 15 exceeds remaining 10
        {
          op: 'send',
          id: 'rep-overfill',
          to: 'reports',
          payload: { type: 'execution', id: 'rep-2', orderId: 'ord-1', executionId: 'e-overfill', quantity: 15, price: 100, occurredAt: 2 },
        },
        { op: 'deliver', messageId: 'rep-overfill' },
      ],
    };

    const result = executeExperiment(experiment, 'clean');
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);

    const target = (result.snapshot as { target: { reservedCredit: number; usedCredit: number; orders: Record<string, any> } }).target;
    expect(target.reservedCredit).toBe(1000);
    expect(target.usedCredit).toBe(0);
    expect(target.orders['ord-1']?.filledQuantity).toBe(0);
    expect(target.orders['ord-1']?.remainingQuantity).toBe(10);
  });

  it('rejects conflicting execution payload for same execution identity without state mutation', () => {
    const experiment: Experiment = {
      hypothesis: 'Conflicting execution ID rejection',
      expectedInvariant: 'execution_idempotency',
      steps: [
        { op: 'send', id: 'q', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 100 } },
        { op: 'send', id: 'c', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 5000 } },
        { op: 'deliver', messageId: 'q' },
        { op: 'deliver', messageId: 'c' },
        // Order for 10 @ $100
        { op: 'send', id: 'o', to: 'client', payload: { type: 'new_order', id: 'm-o', orderId: 'ord-1', quantity: 10, quoteId: 'q1' } },
        { op: 'deliver', messageId: 'o' },
        // First execution e1: 4 units @ $100
        {
          op: 'send',
          id: 'rep-1',
          to: 'reports',
          payload: { type: 'execution', id: 'r1', orderId: 'ord-1', executionId: 'e1', quantity: 4, price: 100, occurredAt: 1 },
        },
        { op: 'deliver', messageId: 'rep-1' },
        // Conflicting duplicate execution e1: 6 units @ $100 (different quantity!)
        {
          op: 'send',
          id: 'rep-conflict',
          to: 'reports',
          payload: { type: 'execution', id: 'r2', orderId: 'ord-1', executionId: 'e1', quantity: 6, price: 100, occurredAt: 2 },
        },
        { op: 'deliver', messageId: 'rep-conflict' },
      ],
    };

    const result = executeExperiment(experiment, 'clean');
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);

    const target = (result.snapshot as { target: { reservedCredit: number; usedCredit: number; orders: Record<string, any> } }).target;
    // State remains from first fill (4 units), not mutated by conflicting fill
    expect(target.usedCredit).toBe(400);
    expect(target.reservedCredit).toBe(600);
    expect(target.orders['ord-1']?.filledQuantity).toBe(4);
    expect(target.orders['ord-1']?.remainingQuantity).toBe(6);
  });

  it('safely handles colon-containing identities with collision-free tuple identity', () => {
    const experiment: Experiment = {
      hypothesis: 'Colon-containing IDs collision freedom',
      expectedInvariant: 'execution_idempotency',
      steps: [
        { op: 'send', id: 'q', to: 'market', payload: { type: 'quote', id: 'q:1', version: 1, price: 50 } },
        { op: 'send', id: 'c', to: 'credit', payload: { type: 'credit_limit', id: 'c:1', version: 1, limit: 5000 } },
        { op: 'deliver', messageId: 'q' },
        { op: 'deliver', messageId: 'c' },
        // Two orders with colon-containing names that would collide if concatenated naively:
        // 'ord:1' + 'e' vs 'ord' + ':1e' or 'ord' + '1:e'
        { op: 'send', id: 'o1', to: 'client', payload: { type: 'new_order', id: 'm1', orderId: 'ord:1', quantity: 10, quoteId: 'q:1' } },
        { op: 'send', id: 'o2', to: 'client', payload: { type: 'new_order', id: 'm2', orderId: 'ord', quantity: 10, quoteId: 'q:1' } },
        { op: 'deliver', messageId: 'o1' },
        { op: 'deliver', messageId: 'o2' },
        // Execution for ord:1 with executionId 2
        {
          op: 'send',
          id: 'rep-1',
          to: 'reports',
          payload: { type: 'execution', id: 'r1', orderId: 'ord:1', executionId: '2', quantity: 3, price: 50, occurredAt: 1 },
        },
        // Execution for ord with executionId 1:2
        {
          op: 'send',
          id: 'rep-2',
          to: 'reports',
          payload: { type: 'execution', id: 'r2', orderId: 'ord', executionId: '1:2', quantity: 4, price: 50, occurredAt: 2 },
        },
        { op: 'deliver', messageId: 'rep-1' },
        { op: 'deliver', messageId: 'rep-2' },
      ],
    };

    const result = executeExperiment(experiment, 'clean');
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);

    const target = (result.snapshot as { target: { orders: Record<string, any> } }).target;
    expect(target.orders['ord:1']?.filledQuantity).toBe(3);
    expect(target.orders['ord']?.filledQuantity).toBe(4);
  });

  it('does not re-release credit when cancel acknowledgement is reissued under a different envelope', () => {
    const experiment: Experiment = {
      hypothesis: 'Reissued cancel ack idempotency under different envelope',
      expectedInvariant: 'credit_exposure_consistency',
      steps: [
        { op: 'send', id: 'q', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 10 } },
        { op: 'send', id: 'c', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 1000 } },
        { op: 'deliver', messageId: 'q' },
        { op: 'deliver', messageId: 'c' },
        // Order for 10 @ $10 = $100 reserved
        { op: 'send', id: 'o', to: 'client', payload: { type: 'new_order', id: 'm-o', orderId: 'ord-1', quantity: 10, quoteId: 'q1' } },
        { op: 'deliver', messageId: 'o' },
        // Venue cancel ack arrives under envelope 1
        {
          op: 'send',
          id: 'cancel-env-1',
          to: 'reports',
          payload: { type: 'cancel_ack', id: 'report-c1', orderId: 'ord-1', cancelledQuantity: 10, occurredAt: 1 },
        },
        { op: 'deliver', messageId: 'cancel-env-1' },
        // Reissued cancel ack arrives under completely new transport envelope 2 with new report id
        {
          op: 'send',
          id: 'cancel-env-2',
          to: 'reports',
          payload: { type: 'cancel_ack', id: 'report-c2', orderId: 'ord-1', cancelledQuantity: 10, occurredAt: 1 },
        },
        { op: 'deliver', messageId: 'cancel-env-2' },
      ],
    };

    const result = executeExperiment(experiment, 'clean');
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);

    const target = (result.snapshot as { target: { reservedCredit: number; orders: Record<string, any> } }).target;
    // Credit is released once, remaining at 0 without double-releasing into negative
    expect(target.reservedCredit).toBe(0);
    expect(target.orders['ord-1']?.cancelledQuantity).toBe(10);
    expect(target.orders['ord-1']?.remainingQuantity).toBe(0);
  });

  it('rejects malformed execution first report then accepts valid fill with same ID with ZERO findings on clean', () => {
    const experiment: Experiment = {
      hypothesis: 'Malformed first report followed by valid report with same execution ID',
      expectedInvariant: 'execution_idempotency',
      steps: [
        { op: 'send', id: 'q', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 100 } },
        { op: 'send', id: 'c', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 5000 } },
        { op: 'deliver', messageId: 'q' },
        { op: 'deliver', messageId: 'c' },
        // Order for 10 @ $100 = $1000 reserved
        { op: 'send', id: 'o', to: 'client', payload: { type: 'new_order', id: 'm-o', orderId: 'ord-1', quantity: 10, quoteId: 'q1' } },
        { op: 'deliver', messageId: 'o' },
        // Malformed execution report: quantity 999999 exceeds order quantity, but uses real ID 'exec-shared-1'
        {
          op: 'send',
          id: 'rep-bad',
          to: 'reports',
          payload: { type: 'execution', id: 'm-bad', orderId: 'ord-1', executionId: 'exec-shared-1', quantity: 999999, price: 100, occurredAt: 1 },
        },
        { op: 'deliver', messageId: 'rep-bad' },
        // Legitimate execution report with the SAME execution ID 'exec-shared-1'
        {
          op: 'send',
          id: 'rep-good',
          to: 'reports',
          payload: { type: 'execution', id: 'm-good', orderId: 'ord-1', executionId: 'exec-shared-1', quantity: 5, price: 100, occurredAt: 2 },
        },
        { op: 'deliver', messageId: 'rep-good' },
      ],
    };

    const result = executeExperiment(experiment, 'clean');
    expect(result.valid).toBe(true);
    // Malformed report must NOT poison idempotency; clean must have ZERO findings!
    expect(result.violations).toHaveLength(0);

    const target = (result.snapshot as { target: { reservedCredit: number; usedCredit: number; orders: Record<string, any> } }).target;
    expect(target.orders['ord-1']?.filledQuantity).toBe(5);
    expect(target.orders['ord-1']?.remainingQuantity).toBe(5);
    expect(target.usedCredit).toBe(500);
    expect(target.reservedCredit).toBe(500);
  });

  it('preserves valid earlier fills arriving after cancellation acknowledgement on clean', () => {
    const experiment: Experiment = {
      hypothesis: 'Preserve earlier fill arriving after cancel ack',
      expectedInvariant: 'order_quantity_conservation',
      steps: [
        { op: 'send', id: 'q', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 10 } },
        { op: 'send', id: 'c', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 1000 } },
        { op: 'deliver', messageId: 'q' },
        { op: 'deliver', messageId: 'c' },
        // Order 10 @ $10 = $100 reserved
        { op: 'send', id: 'o', to: 'client', payload: { type: 'new_order', id: 'm-o', orderId: 'ord-1', quantity: 10, quoteId: 'q1' } },
        { op: 'deliver', messageId: 'o' },
        // Cancel ack for 6 units delivered at logical time 0 (occurredAt: 0)
        {
          op: 'send',
          id: 'rep-cancel',
          to: 'reports',
          payload: { type: 'cancel_ack', id: 'c-ack-1', orderId: 'ord-1', cancelledQuantity: 6, occurredAt: 0 },
        },
        { op: 'deliver', messageId: 'rep-cancel' },
        // Delayed fill of 4 units that occurred at logical time 0 (prior to or concurrent with cancel)
        {
          op: 'send',
          id: 'rep-fill-delayed',
          to: 'reports',
          payload: { type: 'execution', id: 'f-ack-1', orderId: 'ord-1', executionId: 'e-late', quantity: 4, price: 10, occurredAt: 0 },
          delay: 5,
        },
        { op: 'advance', ticks: 5 },
        { op: 'deliver', messageId: 'rep-fill-delayed' },
      ],
    };

    const result = executeExperiment(experiment, 'clean');
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);

    const target = (result.snapshot as { target: { reservedCredit: number; usedCredit: number; orders: Record<string, any> } }).target;
    expect(target.reservedCredit).toBe(0);
    expect(target.usedCredit).toBe(40);
    expect(target.orders['ord-1']?.filledQuantity).toBe(4);
    expect(target.orders['ord-1']?.cancelledQuantity).toBe(6);
    expect(target.orders['ord-1']?.remainingQuantity).toBe(0);
  });

  it('populates TraceEntry.businessTime for report actions', () => {
    const experiment: Experiment = {
      hypothesis: 'TraceEntry.businessTime population',
      expectedInvariant: 'credit_non_negative',
      steps: [
        { op: 'send', id: 'q', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 10 } },
        { op: 'send', id: 'c', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 1000 } },
        { op: 'deliver', messageId: 'q' },
        { op: 'deliver', messageId: 'c' },
        { op: 'send', id: 'o', to: 'client', payload: { type: 'new_order', id: 'm-o', orderId: 'ord-1', quantity: 10, quoteId: 'q1' } },
        { op: 'deliver', messageId: 'o' },
        { op: 'fill', messageId: 'f1', orderId: 'ord-1', executionId: 'e1', quantity: 5, delay: 2 },
        { op: 'advance', ticks: 2 },
        { op: 'deliver', messageId: 'f1' },
      ],
    };

    const result = executeExperiment(experiment, 'clean');
    expect(result.valid).toBe(true);

    const fillTrace = result.trace.find((t) => t.action === 'fill');
    expect(fillTrace).toBeDefined();
    expect(fillTrace?.businessTime).toBeDefined();

    const deliverTrace = result.trace.find((t) => t.action === 'deliver' && t.messageId === 'f1');
    expect(deliverTrace).toBeDefined();
    expect(deliverTrace?.businessTime).toBeDefined();
  });
});

describe('Runtime Source Binding', () => {
  it('reads TypeScript modules in TS mode with neutral filenames and exact hash', () => {
    const bundle = getSourceBundle('clean');
    expect(bundle.files).toHaveLength(3);
    const paths = bundle.files.map((f) => f.path).sort();
    expect(paths).toEqual(['credit-manager.ts', 'decoder.ts', 'order-engine.ts']);

    for (const file of bundle.files) {
      expect(file.content.length).toBeGreaterThan(0);
      expect(file.content).not.toContain('candidate-a');
      expect(file.content).not.toContain('candidate-b');
    }
  });

  it('reads compiled JS modules relative to current module in compiled mode without cwd fallback', async () => {
    const distBundlePath = path.resolve(process.cwd(), 'dist', 'simulator', 'bundle.js');
    if (fs.existsSync(distBundlePath)) {
      const distMod = await import(pathToFileURL(distBundlePath).href);
      const bundle = distMod.getSourceBundle('clean');
      expect(bundle.files).toHaveLength(3);
      const paths = bundle.files.map((f: { path: string }) => f.path).sort();
      expect(paths).toEqual(['credit-manager.js', 'decoder.js', 'order-engine.js']);

      // Content must match the compiled .js on disk exactly
      for (const file of bundle.files) {
        const compiledPath = path.resolve(process.cwd(), 'dist', 'simulator', 'variants', 'clean', file.path);
        const onDisk = fs.readFileSync(compiledPath, 'utf8');
        expect(file.content).toBe(onDisk);
      }
    }
  });

  it('compiled JS bundle reflects compiled code even if source changed without rebuild', async () => {
    const distBundlePath = path.resolve(process.cwd(), 'dist', 'simulator', 'bundle.js');
    if (fs.existsSync(distBundlePath)) {
      const distMod = await import(pathToFileURL(distBundlePath).href);
      const bundle = distMod.getSourceBundle('clean');
      // Must read from dist/simulator/variants/clean, NOT src/
      for (const file of bundle.files) {
        expect(file.path.endsWith('.js')).toBe(true);
      }
    }
  });

  it('throws error immediately when runtime bundle is missing without cwd fallback', () => {
    expect(() => getSourceBundle('non-existent-variant' as any)).toThrow(/Unable to load source bundle file/);
  });
});


// Canonical clean source plus this compact, hidden map is the entire permitted delta.
// These assertions deliberately compare complete modules, including every shared guard.
describe('Canonical variant derivation', () => {
  it('derives every business module exactly from clean and the two declared mutations', () => {
    const clean = getSourceBundle('clean');
    clean.files = clean.files.map((file) => ({ ...file, content: file.content.replace(/\r\n/g, '\n') }));
    const engine = clean.files.find((file) => file.path === 'order-engine.ts')!.content;
    const withoutDedup = engine
      .replace(/interface ExecutionRecord \{[\s\S]*?\n\}\n\n/, '')
      .replace('  private readonly processedExecutions = new Map<string, ExecutionRecord>();\n', '')
      .replace(/        const executionKey =[\s\S]*?(?=        if \(payload.price !== order.price\))/, '')
      .replace(/        this.processedExecutions.set\([\s\S]*?(?=        this.latestExecutionAt.set\()/, '');
    const wrongRelease = engine.replace(
      'const releaseNotional = releaseQty * order.price;',
      'const releaseNotional = order.remainingQuantity * order.price;',
    );
    expect(withoutDedup).not.toBe(engine);
    expect(wrongRelease).not.toBe(engine);
    for (const [variant, derived] of [['candidate-a', withoutDedup], ['candidate-b', wrongRelease]] as const) {
      expect(getSourceBundle(variant).files.map((file) => ({ ...file, content: file.content.replace(/\r\n/g, '\n') }))).toEqual(clean.files.map((file) => ({
        ...file, content: file.path === 'order-engine.ts' ? derived : file.content,
      })));
    }
  });
});

const allVariants = ['clean', 'candidate-a', 'candidate-b'] as const;
const opening: Action[] = [
  { op: 'send', id: 'quote', to: 'market', payload: { type: 'quote', id: 'q', version: 1, price: 10 } },
  { op: 'send', id: 'credit', to: 'credit', payload: { type: 'credit_limit', id: 'c', version: 1, limit: 100 } },
  { op: 'drain' },
  { op: 'send', id: 'order', to: 'client', payload: { type: 'new_order', id: 'o', orderId: 'o', quantity: 10, quoteId: 'q' } },
  { op: 'drain' },
];
function scenario(steps: Action[], variant: TargetVariant = 'clean') {
  return executeExperiment({ hypothesis: 'Lifecycle and guard parity', expectedInvariant: 'lifecycle_consistency', steps: [...opening, ...steps] }, variant);
}
function report(id: string, payload: Record<string, unknown>): Action[] {
  return [{ op: 'send', id, to: 'reports', payload: { id, orderId: 'o', ...payload } }, { op: 'deliver', messageId: id }];
}
function targetOf(result: ReturnType<typeof scenario>) {
  return result.snapshot.target as import('../src/simulator/types.ts').TargetSnapshot;
}

describe.each(allVariants)('Lifecycle and guard parity: %s', (variant) => {
  it.each([0, 4, 10])('preserves quantity/status for venue fill %i followed by cancel in both delivery orders', (quantity) => {
    for (const cancelFirst of [false, true]) {
      const steps: Action[] = [];
      if (quantity > 0) steps.push({ op: 'fill', messageId: 'fill', orderId: 'o', executionId: 'e', quantity });
      steps.push({ op: 'advance', ticks: 1 }, { op: 'confirm_cancel', messageId: 'ack', orderId: 'o' });
      if (cancelFirst) steps.push({ op: 'deliver', messageId: 'ack' });
      if (quantity > 0) steps.push({ op: 'deliver', messageId: 'fill' });
      if (!cancelFirst) steps.push({ op: 'deliver', messageId: 'ack' });
      const result = scenario(steps, variant);
      expect(result.valid).toBe(true);
      const target = targetOf(result);
      expect(target.orders.o).toMatchObject({ filledQuantity: quantity, cancelledQuantity: 10 - quantity,
        remainingQuantity: 0, status: quantity === 10 ? 'FILLED' : 'CANCELLED' });
      expect(target.usedCredit).toBe(quantity * 10);
      const intentionalFinance = variant === 'candidate-b' && cancelFirst && quantity > 0;
      expect(result.violations.every((v) => ['credit_non_negative', 'credit_exposure_consistency'].includes(v.invariant))).toBe(true);
      expect(target.reservedCredit).toBe(intentionalFinance ? -quantity * 10 : 0);
      expect(result.violations.length > 0).toBe(intentionalFinance);
      if (cancelFirst) {
        const ack = result.trace.find((entry) => entry.messageId === 'ack' && entry.outcome === 'delivered:processed')!;
        expect((ack.state.orders as any).o.status).toBe(quantity === 10 ? 'OPEN' : 'CANCELLED');
        expect((ack.state.orders as any).o.remainingQuantity).toBe(quantity);
      }
    }
  });

  it('rejects oversized/wrong-price reports, including invalid first-use IDs, then admits a coherent retry', () => {
    const result = scenario([
      ...report('oversize', { type: 'execution', executionId: 'same', quantity: 15, price: 10, occurredAt: 0 }),
      ...report('wrong-price', { type: 'execution', executionId: 'same', quantity: 4, price: 11, occurredAt: 0 }),
      ...report('malformed', { type: 'execution', executionId: 'same', quantity: '4', price: 10, occurredAt: 0 }),
      ...report('good', { type: 'execution', executionId: 'same', quantity: 4, price: 10, occurredAt: 0 }),
    ], variant);
    expect(result.violations).toEqual([]);
    expect(targetOf(result).orders.o).toMatchObject({ filledQuantity: 4, remainingQuantity: 6 });
    for (const id of ['oversize', 'wrong-price', 'malformed']) {
      const entry = result.trace.find((entry) => entry.messageId === id && entry.action === 'deliver')!;
      expect(entry.outcome).toContain('rejected');
      expect((entry.state.orders as any).o.filledQuantity).toBe(0);
    }
  });

  it('rejects invalid cancel quantity or chronology without poisoning later acknowledgement', () => {
    const result = scenario([
      ...report('exec', { type: 'execution', executionId: 'first', quantity: 4, price: 10, occurredAt: 2 }),
      ...report('too-much', { type: 'cancel_ack', cancelledQuantity: 7, occurredAt: 2 }),
      ...report('too-early', { type: 'cancel_ack', cancelledQuantity: 6, occurredAt: 1 }),
      ...report('ack', { type: 'cancel_ack', cancelledQuantity: 6, occurredAt: 2 }),
      ...report('reissued', { type: 'cancel_ack', cancelledQuantity: 6, occurredAt: 2 }),
      ...report('conflict', { type: 'cancel_ack', cancelledQuantity: 0, occurredAt: 3 }),
    ], variant);
    expect(result.violations).toEqual([]);
    expect(targetOf(result).orders.o).toMatchObject({ filledQuantity: 4, cancelledQuantity: 6, remainingQuantity: 0, status: 'CANCELLED' });
    expect(targetOf(result).reservedCredit).toBe(0);
    for (const id of ['too-much', 'too-early', 'conflict']) expect(result.trace.find((e) => e.messageId === id && e.action === 'deliver')!.outcome).toContain('rejected');
  });

  it('keeps positive partial cancellation terminal while accepting only earlier or equal-time fills', () => {
    const result = scenario([
      ...report('ack', { type: 'cancel_ack', cancelledQuantity: 6, occurredAt: 2 }),
      ...report('late-invalid', { type: 'execution', executionId: 'retry', quantity: 4, price: 10, occurredAt: 3 }),
      ...report('earlier-good', { type: 'execution', executionId: 'retry', quantity: 4, price: 10, occurredAt: 1 }),
      { op: 'send', id: 'request', to: 'client', payload: { type: 'cancel_order', id: 'request', orderId: 'o' } },
      { op: 'drain' },
    ], variant);
    const target = targetOf(result);
    expect(target.orders.o).toMatchObject({ filledQuantity: 4, cancelledQuantity: 6, remainingQuantity: 0, status: 'CANCELLED', cancellationRequested: true });
    expect(result.trace.find((e) => e.messageId === 'late-invalid' && e.action === 'deliver')!.outcome).toContain('rejected');
    expect(result.violations.length > 0).toBe(variant === 'candidate-b');
    expect(result.violations.every((v) => ['credit_non_negative', 'credit_exposure_consistency'].includes(v.invariant))).toBe(true);
  });

  it('reissues venue facts at later logical time and preserves status after terminal cancel requests', () => {
    const result = scenario([
      { op: 'fill', messageId: 'f1', orderId: 'o', executionId: 'e', quantity: 10 },
      { op: 'deliver', messageId: 'f1' },
      { op: 'confirm_cancel', messageId: 'c1', orderId: 'o' },
      { op: 'deliver', messageId: 'c1' },
      { op: 'advance', ticks: 5 },
      { op: 'fill', messageId: 'f2', orderId: 'o', executionId: 'e', quantity: 10 },
      { op: 'confirm_cancel', messageId: 'c2', orderId: 'o' },
      { op: 'send', id: 'request', to: 'client', payload: { type: 'cancel_order', id: 'request', orderId: 'o' } },
      { op: 'drain' },
    ], variant);
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
    expect(targetOf(result).orders.o).toMatchObject({ filledQuantity: 10, cancelledQuantity: 0, status: 'FILLED', cancellationRequested: true });
    expect(result.trace.find((e) => e.messageId === 'f2' && e.action === 'fill')!.businessTime).toBe(0);
    expect(result.trace.find((e) => e.messageId === 'c2' && e.action === 'confirm_cancel')!.businessTime).toBe(0);
  });

  it('enforces public numeric bounds across all message types without mutation', () => {
    const invalid: [import('../src/domain.ts').Channel, Record<string, unknown>][] = [
      ['market', { type: 'quote', id: 'q2', version: 2, price: 10_000_001 }],
      ['credit', { type: 'credit_limit', id: 'c2', version: 2, limit: 1_000_000_001 }],
      ['client', { type: 'new_order', id: 'large', orderId: 'large', quantity: 1_000_001, quoteId: 'q' }],
      ['reports', { type: 'execution', id: 'large-fill', orderId: 'o', executionId: 'e', quantity: 1_000_001, price: 10, occurredAt: 0 }],
      ['reports', { type: 'cancel_ack', id: 'large-cancel', orderId: 'o', cancelledQuantity: 1_000_001, occurredAt: 0 }],
    ];
    const steps: Action[] = invalid.flatMap(([to, payload], i) => [
      { op: 'send' as const, id: `invalid-${i}`, to, payload }, { op: 'deliver' as const, messageId: `invalid-${i}` },
    ]);
    const result = scenario(steps, variant);
    expect(result.violations).toEqual([]);
    expect(targetOf(result)).toEqual(targetOf(scenario([], variant)));
    expect(result.trace.filter((e) => e.action === 'deliver').every((e) => e.outcome.includes('rejected'))).toBe(true);
  });

  it('grandfathers old exposure after credit cuts but rejects new admissions', () => {
    const result = scenario([
      { op: 'send', id: 'cut', to: 'credit', payload: { type: 'credit_limit', id: 'cut', version: 2, limit: 0 } },
      { op: 'drain' },
      { op: 'fill', messageId: 'fill', orderId: 'o', executionId: 'e', quantity: 4 },
      { op: 'deliver', messageId: 'fill' },
      { op: 'send', id: 'extra', to: 'client', payload: { type: 'new_order', id: 'extra', orderId: 'extra', quantity: 1, quoteId: 'q' } },
      { op: 'drain' },
      { op: 'confirm_cancel', messageId: 'ack', orderId: 'o' }, { op: 'drain' },
    ], variant);
    expect(result.violations).toEqual([]);
    expect(targetOf(result).orders.extra).toBeUndefined();
    expect(targetOf(result)).toMatchObject({ usedCredit: 40, reservedCredit: 0 });
  });
});

it.each(['clean', 'candidate-b'] as const)('%s rejects business identity conflicts in quantity, price AND timestamp', (variant) => {
  const result = scenario([
    ...report('first', { type: 'execution', executionId: 'e', quantity: 4, price: 10, occurredAt: 2 }),
    ...report('timestamp', { type: 'execution', executionId: 'e', quantity: 4, price: 10, occurredAt: 1 }),
    ...report('quantity', { type: 'execution', executionId: 'e', quantity: 3, price: 10, occurredAt: 2 }),
    ...report('price', { type: 'execution', executionId: 'e', quantity: 4, price: 11, occurredAt: 2 }),
    ...report('identical', { type: 'execution', executionId: 'e', quantity: 4, price: 10, occurredAt: 2 }),
  ], variant);
  expect(result.violations).toEqual([]);
  expect(targetOf(result).orders.o.filledQuantity).toBe(4);
  for (const id of ['timestamp', 'quantity', 'price']) expect(result.trace.find((e) => e.messageId === id && e.action === 'deliver')!.outcome).toContain('Conflicting');
});

it('candidate A partial duplicate fits remaining quantity but still violates economic idempotency', () => {
  const steps: Action[] = [
    { op: 'fill', messageId: 'f', orderId: 'o', executionId: 'e', quantity: 4 },
    { op: 'deliver', messageId: 'f' },
    { op: 'duplicate', messageId: 'f', id: 'dup' }, { op: 'deliver', messageId: 'dup' },
  ];
  const result = scenario(steps, 'candidate-a');
  expect(result.valid).toBe(true);
  expect(targetOf(result).orders.o).toMatchObject({ filledQuantity: 8, remainingQuantity: 2 });
  expect(result.violations.some((v) => v.invariant === 'execution_idempotency')).toBe(true);
  expect(scenario(steps, 'clean').violations).toEqual([]);
  expect(scenario(steps, 'candidate-b').violations).toEqual([]);
});

// Each subprocess owns a private copy: no mutation of src/dist shared with other tests.
it('binds source to the loaded runtime for the entire process in TS and compiled modes', () => {
  const scratchRoot = path.resolve('.llm-output/simulator-checks');
  fs.mkdirSync(scratchRoot, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(scratchRoot, 'source-lifetime-'));
  try {
    fs.mkdirSync(path.join(fixture, 'src'));
    fs.cpSync(path.resolve('src/simulator'), path.join(fixture, 'src/simulator'), { recursive: true });
    fs.copyFileSync(path.resolve('src/domain.ts'), path.join(fixture, 'src/domain.ts'));
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
    const compile = spawnSync(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'), '--ignoreConfig',
      path.join(fixture, 'src/simulator/index.ts'), '--outDir', path.join(fixture, 'dist'),
      '--rootDir', path.join(fixture, 'src'), '--module', 'NodeNext', '--target', 'ES2024',
      '--rewriteRelativeImportExtensions', '--skipLibCheck', '--types', 'node'], { encoding: 'utf8', timeout: 30_000 });
    expect(compile.status, compile.stdout + compile.stderr).toBe(0);
    const probe = String.raw`
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { pathToFileURL } from 'node:url';
      const root = process.argv[1];
      const mode = process.argv[2];
      const ext = mode === 'src' ? 'ts' : 'js';
      const runtime = await import(pathToFileURL(path.join(root, mode, 'simulator/index.' + ext)));
      const exp = { hypothesis: 'identity', expectedInvariant: 'identity', steps: [] };
      // Change disk before the very first context/execution call: lazy capture would fail this.
      const coldFile = path.join(root, mode, 'simulator/variants/clean/order-engine.' + ext);
      const coldBefore = fs.readFileSync(coldFile, 'utf8');
      try {
        fs.writeFileSync(coldFile, coldBefore + '\n// changed before first request\n');
        assert.throws(() => runtime.getSourceBundle('clean'), /restart required/);
        assert.throws(() => runtime.executeExperiment(exp, 'clean'), /restart required/);
      } finally { fs.writeFileSync(coldFile, coldBefore); }
      for (const variant of ['clean', 'candidate-a', 'candidate-b', 'candidate-c', 'candidate-d', 'candidate-e', 'candidate-f', 'candidate-g', 'candidate-h', 'candidate-i']) {
        const original = runtime.getSourceBundle(variant);
        const copy = runtime.getSourceBundle(variant); copy.files[0].content = 'caller mutation';
        assert.equal(runtime.getSourceBundle(variant).hash, original.hash);
        assert.equal(runtime.executeExperiment(exp, variant).sourceHash, original.hash);
        for (const moduleName of ['credit-manager', 'decoder', 'order-engine']) {
          const filename = path.join(root, mode, 'simulator/variants', variant, moduleName + '.' + ext);
          const before = fs.readFileSync(filename, 'utf8');
          try {
            fs.writeFileSync(filename, before + '\n// disk revision after runtime import\n');
            assert.throws(() => runtime.getSourceBundle(variant), /restart required/);
            assert.throws(() => runtime.executeExperiment(exp, variant), /restart required/);
            fs.unlinkSync(filename);
            assert.throws(() => runtime.getSourceBundle(variant), /restart required/);
            assert.throws(() => runtime.executeExperiment(exp, variant), /restart required/);
          } finally { fs.writeFileSync(filename, before); }
          assert.equal(runtime.getSourceBundle(variant).hash, original.hash);
        }
      }
      if (mode === 'dist') {
        const ts = path.join(root, 'src/simulator/variants/clean/order-engine.ts');
        const before = fs.readFileSync(ts, 'utf8');
        const original = runtime.getSourceBundle('clean');
        try {
          fs.writeFileSync(ts, before + '\n// unbuilt source change\n');
          assert.deepEqual(runtime.getSourceBundle('clean'), original);
          assert.equal(runtime.executeExperiment(exp, 'clean').sourceHash, original.hash);
        } finally { fs.writeFileSync(ts, before); }
      }
      // Missing business source before startup fails eagerly, without a cwd fallback.
      const missing = path.join(root, mode, 'simulator/variants/clean/decoder.' + ext);
      const missingBefore = fs.readFileSync(missing, 'utf8');
      try {
        fs.unlinkSync(missing);
        const fresh = await import('node:child_process');
        const startup = fresh.spawnSync(process.execPath, ['--input-type=module', '-e',
          'await import(' + JSON.stringify(pathToFileURL(path.join(root, mode, 'simulator/index.' + ext)).href) + ')'],
          { encoding: 'utf8', timeout: 10000 });
        assert.notEqual(startup.status, 0);
        assert.match(startup.stderr, /Unable to load source bundle file|ERR_MODULE_NOT_FOUND/);
      } finally { fs.writeFileSync(missing, missingBefore); }
      console.log(mode + ': loaded-source lifetime checks passed');
    `;
    for (const mode of ['src', 'dist']) {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe, fixture, mode], {
        encoding: 'utf8', timeout: 30_000, cwd: scratchRoot,
      });
      expect(child.status, child.stdout + child.stderr).toBe(0);
      expect(child.stdout).toContain('loaded-source lifetime checks passed');
    }
  } finally {
    // mkdtemp produces a child of our owned scratch directory; never remove shared fixtures.
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}, 60_000);
