import { describe, expect, it } from 'vitest';
import { recordedDifferences } from '../src/web/finding-story.ts';

describe('recorded finding comparisons', () => {
  it('compares recorded outcomes and values without treating matching values as failures', () => {
    const comparison = recordedDifferences({ evidence: {
      expectedOutcome: 'duplicate', outcome: 'accepted',
      expected: { reservations: { r1: { remaining: 6, shipped: 4 } } },
      actual: { reservations: { r1: { remaining: 2, shipped: 8 } } },
    } });
    expect(comparison.rows).toEqual([
      { label: 'Delivery outcome', expected: 'duplicate', observed: 'accepted' },
      { label: 'Reservation r1: remaining', expected: '6', observed: '2' },
      { label: 'Reservation r1: shipped', expected: '4', observed: '8' },
    ]);
    expect(comparison.truncated).toBe(false);
  });

  it('does not invent differences for missing evidence and flags bounded summaries', () => {
    expect(recordedDifferences({ evidence: {} }).rows).toEqual([]);
    const expected = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`field${i}`, i]));
    const actual = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`field${i}`, i + 1]));
    const comparison = recordedDifferences({ evidence: { expected, actual } });
    expect(comparison.rows).toHaveLength(12);
    expect(comparison.truncated).toBe(true);
    expect(recordedDifferences({ evidence: { expected: { a: { x: 1 } }, actual: { a: null } } }).truncated).toBe(true);
  });
});
