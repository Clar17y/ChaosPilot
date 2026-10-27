import { describe, expect, it } from 'vitest';
import type { Finding } from '../src/domain.ts';
import { replayWaitsForSave, ReproductionSession } from '../src/web/reproduction-state.ts';
import { describeFreshReplay } from '../src/web/reproduction-player.ts';

// These tests exercise the production ReproductionSession that app.ts uses
// for every open/launch/poll/select path, not a reimplemented harness.

const findingA: Finding = {
  id: 'f-a', title: 'A finding', hypothesis: 'h', experimentIndex: 1,
  violation: { id: 'v-a', invariant: 'credit_limit_respected', step: 8, message: 'm', evidence: {} },
  sourceHash: 's', reproduced: true, cleanControlPassed: true,
  replay: { hypothesis: 'h', expectedInvariant: 'credit_limit_respected', steps: [] },
};

describe('replay availability while a run is being saved', () => {
  it('waits for a running or finishing run, then permits replay after saving completes', () => {
    expect(replayWaitsForSave({ id: 'run-a', status: 'running' }, true, 'run-a')).toBe(true);
    expect(replayWaitsForSave({ id: 'run-a', status: 'completed' }, true, 'run-a')).toBe(true);
    expect(replayWaitsForSave({ id: 'run-a', status: 'cancelled' }, true, 'run-a')).toBe(true);
    expect(replayWaitsForSave({ id: 'run-a', status: 'failed' }, true, 'run-a')).toBe(true);
    expect(replayWaitsForSave({ id: 'run-a', status: 'completed' }, false, null)).toBe(false);
  });

  it('allows a saved run to be replayed while a different run is active', () => {
    expect(replayWaitsForSave({ id: 'run-a', status: 'completed' }, true, 'run-b')).toBe(false);
    expect(replayWaitsForSave({ id: 'run-a', status: 'running' }, false, null)).toBe(true);
  });
});

describe('reproduction session run scoping', () => {
  it('saved A with a successful replay does not leak into launched/opened B', () => {
    const s = new ReproductionSession();
    s.resetForRun('run-a');
    s.selectFinding(findingA);
    const token = s.beginFresh('run-a');
    expect(s.settleFresh(token, 'run-a', { kind: 'success' })).toBe(true);
    expect(describeFreshReplay(s.fresh)).toContain('reproduced exactly');

    // Launch B (app.ts launch handler calls resetReproductionSelection).
    s.clear();
    expect(s.selectedFinding).toBeNull();
    expect(s.fresh).toEqual({ kind: 'idle' });
    expect(s.runId).toBeNull();

    // Open active B: syncing to B must not resurrect A's state.
    expect(s.syncToRun('run-b')).toBe(true);
    expect(s.selectedFinding).toBeNull();
    expect(s.fresh).toEqual({ kind: 'idle' });
  });

  it('a pending replay for A cannot settle after opening B (success or error)', () => {
    const s = new ReproductionSession();
    s.resetForRun('run-a');
    const token = s.beginFresh('run-a');
    s.resetForRun('run-b');
    expect(s.settleFresh(token, 'run-a', { kind: 'success' })).toBe(false);
    expect(s.settleFresh(token, 'run-a', { kind: 'error', message: 'HTTP 500' })).toBe(false);
    expect(s.fresh).toEqual({ kind: 'idle' });
    expect(s.runId).toBe('run-b');
  });

  it('same-run polling refresh preserves a valid selection and playback key', () => {
    const s = new ReproductionSession();
    s.resetForRun('run-a');
    s.selectFinding(findingA);
    s.renderedKey = 'run-a|0|f-a|key-events|4';
    expect(s.syncToRun('run-a')).toBe(false);
    expect(s.selectedFinding?.id).toBe('f-a');
    expect(s.renderedKey).toBe('run-a|0|f-a|key-events|4');
    // A different run resets both.
    expect(s.syncToRun('run-b')).toBe(true);
    expect(s.selectedFinding).toBeNull();
    expect(s.renderedKey).toBe('');
  });

  it('changing finding/experiment or navigating away drops a pending replay', () => {
    const s = new ReproductionSession();
    s.resetForRun('run-a');
    const t1 = s.beginFresh('run-a');
    s.clearFinding(); // experiment/finding change in app.ts
    expect(s.fresh).toEqual({ kind: 'idle' });
    expect(s.settleFresh(t1, 'run-a', { kind: 'success' })).toBe(false);

    const t2 = s.beginFresh('run-a');
    s.invalidateFresh(); // navigating away from Investigations in app.ts
    expect(s.settleFresh(t2, 'run-a', { kind: 'success' })).toBe(false);
    expect(s.fresh).toEqual({ kind: 'idle' });

    // Returning and starting a genuinely new replay for the same run works.
    const t3 = s.beginFresh('run-a');
    expect(s.settleFresh(t3, 'run-a', { kind: 'mismatch' })).toBe(true);
    expect(s.fresh).toEqual({ kind: 'mismatch' });
  });

  it('selecting a finding invalidates a replay started for the previous selection', () => {
    const s = new ReproductionSession();
    s.resetForRun('run-a');
    const token = s.beginFresh('run-a');
    s.selectFinding(findingA);
    expect(s.settleFresh(token, 'run-a', { kind: 'success' })).toBe(false);
    expect(s.selectedFinding?.id).toBe('f-a');
  });
});
