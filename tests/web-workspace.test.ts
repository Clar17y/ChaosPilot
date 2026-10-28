import { describe, expect, it } from 'vitest';
import { launchBlockedReason, RequestSequencer, WORKSPACE_VIEWS } from '../src/web/workspace.ts';

const ready = {
  isLaunchRequestPending: false,
  isInvestigationActive: false,
  isSystemSavePending: false,
  isDraftMode: false,
  hasUnsavedSystemEdits: false,
  hasSelectedSystem: true,
  selectedAdapterId: 'synthetic-trading' as string | null,
};

describe('workspace launch guards', () => {
  it('allows launch only for a saved synthetic-trading profile with no pending work', () => {
    expect(launchBlockedReason(ready)).toBeNull();
  });

  it('blocks a dirty draft from launching an older saved profile', () => {
    expect(launchBlockedReason({ ...ready, hasUnsavedSystemEdits: true })).toMatch(/SAVE OR DISCARD/);
    expect(launchBlockedReason({ ...ready, isDraftMode: true, hasUnsavedSystemEdits: true })).toMatch(/SAVE THE NEW/);
  });

  it('blocks unconfigured profiles and pending/save/active states', () => {
    expect(launchBlockedReason({ ...ready, selectedAdapterId: 'unconfigured' })).toMatch(/UNCONFIGURED/);
    expect(launchBlockedReason({ ...ready, isLaunchRequestPending: true })).toMatch(/STARTING/);
    expect(launchBlockedReason({ ...ready, isSystemSavePending: true })).toMatch(/SAVING/);
    expect(launchBlockedReason({ ...ready, isInvestigationActive: true })).toMatch(/IN PROGRESS/);
    expect(launchBlockedReason({ ...ready, hasSelectedSystem: false, selectedAdapterId: null })).toMatch(/SELECT/);
  });

  it('blocks launch while per-adapter targets are loading, failed or unloaded', () => {
    const withTargets = { ...ready, snapshotState: 'ready' as const, allowedVariants: ['clean', 'candidate-a'], selectedVariant: 'candidate-a' };
    expect(launchBlockedReason({ ...withTargets, targetState: 'loading' })).toMatch(/LOADING TARGETS/);
    expect(launchBlockedReason({ ...withTargets, targetState: 'error' })).toMatch(/TARGET LIST UNAVAILABLE/);
    expect(launchBlockedReason({ ...withTargets, targetState: 'idle' })).toMatch(/TARGET LIST NOT LOADED/);
    expect(launchBlockedReason({ ...withTargets, targetState: 'ready', allowedVariants: [], selectedVariant: null })).toMatch(/NO TARGET AVAILABLE/);
    expect(launchBlockedReason({ ...withTargets, targetState: 'ready' })).toBeNull();
  });

  it('exposes the six real workspace views', () => {
    expect(WORKSPACE_VIEWS).toEqual(['overview', 'brief', 'capabilities', 'prepare', 'investigations', 'findings']);
  });
});

describe('request ordering', () => {
  it('drops late history/record responses after a newer selection', () => {
    const seq = new RequestSequencer();
    const first = seq.next();
    const second = seq.next();
    expect(seq.isCurrent(first)).toBe(false);
    expect(seq.isCurrent(second)).toBe(true);
    seq.invalidate();
    expect(seq.isCurrent(second)).toBe(false);
  });
});
