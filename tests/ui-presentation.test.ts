import { describe, expect, it } from 'vitest';
import { clampSelectedIndex, tabIndexForKey } from '../src/web/presentation.ts';

describe('run-detail tab keyboard navigation', () => {
  it('moves with arrows and wraps at both ends', () => {
    expect(tabIndexForKey(0, 'ArrowRight', 5)).toBe(1);
    expect(tabIndexForKey(4, 'ArrowRight', 5)).toBe(0);
    expect(tabIndexForKey(0, 'ArrowLeft', 5)).toBe(4);
    expect(tabIndexForKey(2, 'ArrowLeft', 5)).toBe(1);
  });

  it('jumps to first/last with Home/End', () => {
    expect(tabIndexForKey(3, 'Home', 5)).toBe(0);
    expect(tabIndexForKey(1, 'End', 5)).toBe(4);
  });

  it('ignores non-navigation keys and empty tablists', () => {
    expect(tabIndexForKey(1, 'Enter', 5)).toBeNull();
    expect(tabIndexForKey(1, 'a', 5)).toBeNull();
    expect(tabIndexForKey(0, 'ArrowRight', 0)).toBeNull();
  });

  it('clamps an out-of-range current index before moving', () => {
    expect(tabIndexForKey(99, 'ArrowRight', 3)).toBe(0);
    expect(tabIndexForKey(-4, 'ArrowLeft', 3)).toBe(2);
  });
});

describe('experiment selection after record refresh', () => {
  it('keeps a still-valid selection', () => {
    expect(clampSelectedIndex(2, 5)).toBe(2);
  });

  it('clamps to the last experiment when the list shrinks', () => {
    expect(clampSelectedIndex(4, 2)).toBe(1);
    expect(clampSelectedIndex(4, 1)).toBe(0);
  });

  it('resets to zero for empty lists and invalid values', () => {
    expect(clampSelectedIndex(3, 0)).toBe(0);
    expect(clampSelectedIndex(-1, 4)).toBe(0);
    expect(clampSelectedIndex(Number.NaN, 4)).toBe(0);
  });
});
