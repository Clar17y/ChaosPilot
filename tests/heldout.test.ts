import { describe, expect, it } from 'vitest';
import type { Experiment } from '../src/domain.ts';
import {
  computeSourceHash,
  executeExperiment,
  getSourceBundle,
} from '../src/simulator/index.ts';

describe('Held-out target variant validation', () => {
  const reproducerExperiment: Experiment = {
    hypothesis: 'held-out sequence evaluation',
    expectedInvariant: 'credit_limit_respected',
    steps: [
      { op: 'send', id: 'm-quote', to: 'market', payload: { type: 'quote', id: 'q-1', version: 1, price: 100 } },
      { op: 'send', id: 'm-credit', to: 'credit', payload: { type: 'credit_limit', id: 'c-1', version: 1, limit: 100 } },
      { op: 'deliver', messageId: 'm-quote' },
      { op: 'deliver', messageId: 'm-credit' },
      { op: 'send', id: 'm-order-1', to: 'client', payload: { type: 'new_order', id: 'msg-o1', orderId: 'ord-1', quantity: 1, quoteId: 'q-1' } },
      { op: 'deliver', messageId: 'm-order-1' },
      { op: 'fill', messageId: 'm-fill-1', orderId: 'ord-1', executionId: 'exec-1', quantity: 1, delay: 0 },
      { op: 'deliver', messageId: 'm-fill-1' },
      { op: 'send', id: 'm-order-2', to: 'client', payload: { type: 'new_order', id: 'msg-o2', orderId: 'ord-2', quantity: 1, quoteId: 'q-1' } },
      { op: 'deliver', messageId: 'm-order-2' },
    ],
  };

  const normalExperiment: Experiment = {
    hypothesis: 'standard execution within bounds',
    expectedInvariant: 'credit_limit_respected',
    steps: [
      { op: 'send', id: 'm-quote', to: 'market', payload: { type: 'quote', id: 'q-1', version: 1, price: 50 } },
      { op: 'send', id: 'm-credit', to: 'credit', payload: { type: 'credit_limit', id: 'c-1', version: 1, limit: 1000 } },
      { op: 'deliver', messageId: 'm-quote' },
      { op: 'deliver', messageId: 'm-credit' },
      { op: 'send', id: 'm-order-1', to: 'client', payload: { type: 'new_order', id: 'msg-o1', orderId: 'ord-1', quantity: 5, quoteId: 'q-1' } },
      { op: 'deliver', messageId: 'm-order-1' },
      { op: 'fill', messageId: 'm-fill-1', orderId: 'ord-1', executionId: 'exec-1', quantity: 2, delay: 0 },
      { op: 'deliver', messageId: 'm-fill-1' },
      { op: 'confirm_cancel', messageId: 'm-cancel-1', orderId: 'ord-1', delay: 0 },
      { op: 'deliver', messageId: 'm-cancel-1' },
    ],
  };

  it('proves valid experiment triggers public invariant on candidate-c while clean control passes', () => {
    // 1. Clean control must PASS with zero violations and valid=true
    const cleanResult = executeExperiment(reproducerExperiment, 'clean');
    expect(cleanResult.valid).toBe(true);
    expect(cleanResult.rejections).toHaveLength(0);
    expect(cleanResult.violations).toHaveLength(0);

    // 2. Candidate C must be a valid experiment (no engine rejections) but trigger an invariant violation
    const candidateCResult = executeExperiment(reproducerExperiment, 'candidate-c');
    expect(candidateCResult.valid).toBe(true);
    expect(candidateCResult.rejections).toHaveLength(0);
    expect(candidateCResult.violations.length).toBeGreaterThan(0);

    const violation = candidateCResult.violations.find((v) => v.invariant === 'credit_limit_respected');
    expect(violation).toBeDefined();
    expect(violation?.orderId).toBe('ord-2');
  });

  it('produces identical deterministic semantic traces and snapshots on replay', () => {
    const run1 = executeExperiment(reproducerExperiment, 'candidate-c');
    const run2 = executeExperiment(reproducerExperiment, 'candidate-c');

    expect(run1.valid).toBe(true);
    expect(run1.violations).toEqual(run2.violations);
    expect(run1.trace).toEqual(run2.trace);
    expect(run1.snapshot).toEqual(run2.snapshot);
    expect(run1.sourceHash).toBe(run2.sourceHash);
  });

  it('passes normal sequence without violations on candidate-c', () => {
    const normalResult = executeExperiment(normalExperiment, 'candidate-c');
    expect(normalResult.valid).toBe(true);
    expect(normalResult.rejections).toHaveLength(0);
    expect(normalResult.violations).toHaveLength(0);

    const targetSnapshot = normalResult.snapshot as {
      target: {
        reservedCredit: number;
        usedCredit: number;
        orders: Record<string, { filledQuantity: number; cancelledQuantity: number; remainingQuantity: number }>;
      };
    };
    expect(targetSnapshot.target.reservedCredit).toBe(0);
    expect(targetSnapshot.target.usedCredit).toBe(100);
    expect(targetSnapshot.target.orders['ord-1']?.filledQuantity).toBe(2);
    expect(targetSnapshot.target.orders['ord-1']?.cancelledQuantity).toBe(3);
    expect(targetSnapshot.target.orders['ord-1']?.remainingQuantity).toBe(0);
  });

  it('verifies structural mutation: exactly one calculation mutation against clean', () => {
    const cleanBundle = getSourceBundle('clean');
    const cBundle = getSourceBundle('candidate-c');

    const cleanFiles = new Map(cleanBundle.files.map((f) => [f.path, f.content.replace(/\r\n/g, '\n')]));
    const cFiles = new Map(cBundle.files.map((f) => [f.path, f.content.replace(/\r\n/g, '\n')]));

    // decoder.ts and order-engine.ts must be strictly identical
    expect(cFiles.get('decoder.ts')).toBe(cleanFiles.get('decoder.ts'));
    expect(cFiles.get('order-engine.ts')).toBe(cleanFiles.get('order-engine.ts'));

    // credit-manager.ts has exactly one single mutation
    const cleanCredit = cleanFiles.get('credit-manager.ts')!;
    const cCredit = cFiles.get('credit-manager.ts')!;
    expect(cCredit).not.toBe(cleanCredit);

    const reconstructedClean = cCredit.replace(
      'return this.reserved + notional <= this.limit;',
      'return this.reserved + this.used + notional <= this.limit;',
    );
    expect(reconstructedClean).toBe(cleanCredit);
  });

  it('verifies source isolation, neutral filenames, and bundle hash agreement', () => {
    const bundle = getSourceBundle('candidate-c');
    expect(bundle.files).toHaveLength(3);

    const paths = bundle.files.map((f) => f.path).sort();
    expect(paths).toEqual(['credit-manager.ts', 'decoder.ts', 'order-engine.ts']);

    expect(computeSourceHash(bundle.files)).toBe(bundle.hash);

    for (const file of bundle.files) {
      expect(file.content).not.toContain('candidate-a');
      expect(file.content).not.toContain('candidate-b');
      expect(file.content).not.toContain('candidate-c');
      expect(file.content).not.toContain('defect');
      expect(file.content).not.toContain('oracle');
      expect(file.content).not.toContain('mutation');
    }

    const expResult = executeExperiment(reproducerExperiment, 'candidate-c');
    expect(expResult.sourceHash).toBe(bundle.hash);
  });

  it('preserves unchanged source hashes for prior variants', () => {
    const cleanBundle = getSourceBundle('clean');
    const aBundle = getSourceBundle('candidate-a');
    const bBundle = getSourceBundle('candidate-b');
    const cBundle = getSourceBundle('candidate-c');

    const hashes = new Set([cleanBundle.hash, aBundle.hash, bBundle.hash, cBundle.hash]);
    expect(hashes.size).toBe(4);
  });
});
