import { describe, expect, it } from 'vitest';
import { replayOutcome } from '../src/web/presentation.ts';

describe('replay outcome labels', () => {
  it('separates verified, context-unconfirmed, mismatched and empty results', () => {
    expect(replayOutcome({ experimentsTotal: 2, experimentsReproduced: 2, exactReproductionClaimed: true })).toBe('reproduced');
    expect(replayOutcome({ experimentsTotal: 2, experimentsReproduced: 2, exactReproductionClaimed: false })).toBe('unconfirmed');
    expect(replayOutcome({ experimentsTotal: 2, experimentsReproduced: 1, exactReproductionClaimed: false })).toBe('mismatch');
    expect(replayOutcome({ experimentsTotal: 0, experimentsReproduced: 0, exactReproductionClaimed: false })).toBe('empty');
  });
});
