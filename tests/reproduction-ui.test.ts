import { describe, expect, it } from 'vitest';
import type { Finding, InvestigationRecord } from '../src/domain.ts';
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

  it('production settlement propagates every fresh classification unchanged', () => {
    const s = new ReproductionSession();
    const settle = (report: Parameters<ReproductionSession['settleFreshReport']>[2]) => {
      s.resetForRun('run-a');
      const token = s.beginFresh('run-a', 1, 'f-a');
      const kind = s.settleFreshReport(token, 'run-a', report, 1, 'f-a');
      return { kind, fresh: s.fresh, text: describeFreshReplay(s.fresh) };
    };
    const matched = [{ behaviorMatched: true, replayedResult: {} }];
    const mismatched = [{ behaviorMatched: false, replayedResult: {} }];
    expect(settle({ sourceIdentical: true, reproduced: true, exactReproductionClaimed: true, outcomes: matched }).kind).toBe('success');
    // Same source, behaviour matched, context unknown: not a mismatch banner.
    const unverified = settle({ sourceIdentical: true, reproduced: false, exactReproductionClaimed: false, contextStatus: 'unknown', outcomes: matched });
    expect(unverified.kind).toBe('context-unverified');
    expect(unverified.fresh).toEqual({ kind: 'context-unverified' });
    expect(unverified.text).toContain('behaviour matched, but replay context is unverified');
    expect(settle({ sourceIdentical: true, reproduced: false, exactReproductionClaimed: false, outcomes: mismatched }).kind).toBe('mismatch');
    expect(settle({ sourceIdentical: false, reproduced: false, exactReproductionClaimed: false, outcomes: matched }).kind).toBe('source-changed');
    const both = settle({ sourceIdentical: false, reproduced: false, exactReproductionClaimed: false, outcomes: mismatched });
    expect(both.kind).toBe('source-changed-mismatch');
    expect(both.text).toContain('mismatch and source changed');
    // Successful settlement keeps the report for the fresh-trace view.
    expect(s.freshReport).not.toBeNull();
  });

  it('production settlement drops stale results and errors after selection changes', () => {
    const s = new ReproductionSession();
    s.resetForRun('run-a');
    const report = { sourceIdentical: true, reproduced: true, exactReproductionClaimed: true, outcomes: [{ behaviorMatched: true, replayedResult: {} }] };
    // Deliberate experiment change while pending: late success and late error are dropped.
    const t1 = s.beginFresh('run-a', 0, null);
    s.selectExperiment(1);
    expect(s.settleFreshReport(t1, 'run-a', report, 0, null)).toBeNull();
    expect(s.settleFreshError(t1, 'run-a', 'HTTP 500', 0, null)).toBe(false);
    expect(s.fresh).toEqual({ kind: 'idle' });
    // Wrong finding scope is stale even with the current token.
    const t2 = s.beginFresh('run-a', 1, 'f-a');
    expect(s.settleFreshReport(t2, 'run-a', report, 1, 'other-finding')).toBeNull();
    // A current error settles as an error with its message.
    expect(s.settleFreshError(t2, 'run-a', 'HTTP 400', 1, 'f-a')).toBe(true);
    expect(s.fresh).toEqual({ kind: 'error', message: 'HTTP 400' });
    expect(s.freshReport).toBeNull();
    // Repeated rerun for the same selection works and replaces the error.
    const t3 = s.beginFresh('run-a', 1, 'f-a');
    expect(s.settleFreshReport(t3, 'run-a', report, 1, 'f-a')).toBe('success');
  });

  it('newly opened runs default to the first resolvable finding without overriding later selection', () => {
    const exp = (index?: number) => ({
      ...(index === undefined ? {} : { index }),
      experiment: { hypothesis: 'h', expectedInvariant: 'inv', steps: [] },
      result: { schemaVersion: 1, experiment: { hypothesis: 'h', expectedInvariant: 'inv', steps: [] }, sourceHash: 's', trace: [], snapshot: {}, violations: [], rejections: [], valid: true },
      replayVerified: true, cleanControlPassed: true,
    });
    const finding = (id: string, experimentIndex: number): Finding => ({
      id, title: id, hypothesis: 'h', experimentIndex,
      violation: { id: `v-${id}`, invariant: 'inv', step: 0, message: 'm', evidence: {} },
      sourceHash: 's', reproduced: true, cleanControlPassed: true,
      replay: { hypothesis: 'h', expectedInvariant: 'inv', steps: [] },
    });
    const record = (over: Partial<InvestigationRecord>): InvestigationRecord => ({
      schemaVersion: 1, id: 'run-a', provider: 'mock', model: 'm', mode: 'mock', variant: 'candidate-a',
      status: 'completed', startedAt: '', sourceHash: 's', experiments: [], findings: [],
      usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, errors: [],
      contextAudit: { sourcePaths: [], contractHash: 'h', promptVersion: '1' }, ...over,
    } as InvestigationRecord);

    // First finding is in experiment 2 (position 1), not the no-finding first experiment.
    const s = new ReproductionSession();
    const rec = record({ experiments: [exp(1), exp(2)] as InvestigationRecord['experiments'], findings: [finding('f-late', 2)] });
    expect(s.syncToRun(rec.id)).toBe(true);
    expect(s.applyDefaultFindingSelection(rec)).toBe(1);
    expect(s.selectedFinding?.id).toBe('f-late');
    expect(s.experimentPosition).toBe(1);
    // Same-run polling must not re-apply the default over a deliberate selection:
    // syncToRun reports no change, which is what gates applyDefaultFindingSelection in app.ts.
    s.selectExperiment(0);
    s.clearFinding();
    expect(s.syncToRun(rec.id)).toBe(false);
    expect(s.selectedFinding).toBeNull();
    expect(s.experimentPosition).toBeNull();

    // Legacy index-free record defaults through one-based resolution.
    const legacy = record({ id: 'run-legacy', experiments: [exp(), exp()] as InvestigationRecord['experiments'], findings: [finding('f-legacy', 2)] });
    expect(s.syncToRun(legacy.id)).toBe(true);
    expect(s.applyDefaultFindingSelection(legacy)).toBe(1);
    expect(s.selectedFinding?.id).toBe('f-legacy');

    // Unresolvable first finding is skipped; no findings keeps the safe fallback.
    const skipped = record({ id: 'run-skip', experiments: [exp(5)] as InvestigationRecord['experiments'], findings: [finding('f-missing', 99), finding('f-ok', 5)] });
    expect(s.syncToRun(skipped.id)).toBe(true);
    expect(s.applyDefaultFindingSelection(skipped)).toBe(0);
    expect(s.selectedFinding?.id).toBe('f-ok');
    const none = record({ id: 'run-none', experiments: [exp(1)] as InvestigationRecord['experiments'], findings: [finding('f-missing', 99)] });
    expect(s.syncToRun(none.id)).toBe(true);
    expect(s.applyDefaultFindingSelection(none)).toBe(0);
    expect(s.selectedFinding).toBeNull();
    expect(s.applyDefaultFindingSelection(record({ experiments: [], findings: [] }))).toBe(0);
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
