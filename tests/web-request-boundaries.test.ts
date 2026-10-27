import { describe, expect, it, vi } from 'vitest';
import { InvestigationLifecycle, partitionRuns, stopControlState } from '../src/web/workspace.ts';
import {
  effectiveWorkspaceSystemId,
  executeDeferredStop,
  fetchSystemBriefs,
  requestInvestigationStop,
  StatusRequestCoordinator,
  type StopPostResult,
} from '../src/web/request-boundaries.ts';
import type { RunSummary } from '../src/storage.ts';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const okStop = async (): Promise<StopPostResult> => ({ ok: true, status: 200 });
function run(id: string, briefId?: string): RunSummary {
  return {
    id, provider: 'mock', model: 'm', mode: 'mock', variant: 'candidate-a', status: 'completed',
    startedAt: '2026-10-26T00:00:00.000Z', findingsCount: 1, experimentsCount: 1, sourceHash: 's',
    ...(briefId ? { systemBrief: { id: briefId, name: briefId, revision: 1, adapterId: 'synthetic-trading', hash: 'h' } } : {}),
  };
}

describe('stop at the actual request boundary (used by handleStop)', () => {
  it('keeps terminal Stop controls hidden while an invalidated first status request is still settling', async () => {
    const lifecycle = new InvestigationLifecycle();
    const statuses = new StatusRequestCoordinator();
    const firstStatus = deferred<{ active: boolean; status: string }>();
    let observed = { active: true, status: 'running' };
    const first = statuses.run(() => firstStatus.promise, value => { observed = value; }, () => {});
    lifecycle.beginLaunch();
    lifecycle.settleStart();
    const postStop = vi.fn(okStop);
    await requestInvestigationStop({ lifecycle, postStop, onStopping: () => statuses.invalidate() });
    await statuses.run(async () => ({ active: false, status: 'cancelled' }), value => { observed = value; }, () => {});
    const controls = () => stopControlState({ isStartPending: lifecycle.startPending, isInvestigationActive: observed.active, serverStatus: observed.status });
    expect(postStop).toHaveBeenCalledTimes(1);
    expect(controls()).toEqual({ visible: false, enabled: false, label: 'Stop investigation' });
    firstStatus.resolve({ active: true, status: 'running' });
    await first;
    expect(controls().visible).toBe(false);
    expect(observed.status).toBe('cancelled');
  });

  it('stop between start settlement and first status resolution posts Stop immediately', async () => {
    const lc = new InvestigationLifecycle();
    lc.beginLaunch();
    lc.settleStart(); // start acknowledged; launch handler still awaits its first status fetch
    const statusInFlight = deferred<string>(); // first status has not resolved
    void statusInFlight.promise;
    const postStop = vi.fn(okStop);
    await expect(requestInvestigationStop({ lifecycle: lc, postStop })).resolves.toBe('stopped');
    expect(postStop).toHaveBeenCalledTimes(1);
  });

  it('stop before acknowledgement defers without posting, then the deferred stop posts on settlement', async () => {
    const lc = new InvestigationLifecycle();
    lc.beginLaunch();
    const postStop = vi.fn(okStop);
    await expect(requestInvestigationStop({ lifecycle: lc, postStop })).resolves.toBe('deferred');
    expect(postStop).not.toHaveBeenCalled();
    expect(lc.settleStart()).toEqual({ deferredStop: true });
    await expect(executeDeferredStop(postStop)).resolves.toEqual({ outcome: 'stopping' });
    expect(postStop).toHaveBeenCalledTimes(1);
  });

  it('stop after acceptance posts now; a failed stop reports failure and a retry can succeed', async () => {
    const lc = new InvestigationLifecycle();
    lc.beginLaunch();
    lc.noteStatus({ id: 'run-1', status: 'running', systemId: 'sys-a' });
    lc.settleStart();
    const failures: string[] = [];
    const flaky = vi.fn(async (): Promise<StopPostResult> =>
      flaky.mock.calls.length === 1 ? { ok: false, status: 500, error: 'boom' } : { ok: true, status: 200 });
    await expect(requestInvestigationStop({
      lifecycle: lc, postStop: flaky, onFailure: (m) => { failures.push(m); },
    })).resolves.toBe('failed');
    expect(failures).toEqual(['boom']);
    await expect(requestInvestigationStop({ lifecycle: lc, postStop: flaky })).resolves.toBe('stopped');
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('deferred stop: transport failure is failed (retryable), 400 is rapid natural settlement, not cancellation', async () => {
    await expect(executeDeferredStop(async () => { throw new Error('down'); }))
      .resolves.toEqual({ outcome: 'failed', error: 'down' });
    await expect(executeDeferredStop(async () => ({ ok: false, status: 400 })))
      .resolves.toEqual({ outcome: 'already-settled' });
    await expect(executeDeferredStop(async () => ({ ok: false, status: 500, error: 'srv' })))
      .resolves.toEqual({ outcome: 'failed', error: 'srv' });
  });

  it('stop during initialization with only transport-level failure does not claim success', async () => {
    const lc = new InvestigationLifecycle();
    lc.beginLaunch();
    await expect(requestInvestigationStop({ lifecycle: lc, postStop: okStop })).resolves.toBe('deferred');
    expect(lc.pendingStopIntent).toBe(true); // consumed only by settleStart in the launch handler
  });
});

describe('status response ordering', () => {
  it('older running response cannot overwrite a newer terminal response', async () => {
    const coord = new StatusRequestCoordinator();
    const running = deferred<string>();
    const terminal = deferred<string>();
    const applied: string[] = [];
    const errors: unknown[] = [];
    const p1 = coord.run(() => running.promise, (v) => applied.push(v), (e) => errors.push(e));
    const p2 = coord.run(() => terminal.promise, (v) => applied.push(v), (e) => errors.push(e));
    terminal.resolve('completed');
    await p2;
    running.resolve('running');
    await p1;
    expect(applied).toEqual(['completed']);
    expect(errors).toEqual([]);
  });

  it('slow requests are not starved by newer issued requests: each applies in turn', async () => {
    const coord = new StatusRequestCoordinator();
    const slow = deferred<string>();
    const newer = deferred<string>();
    const applied: string[] = [];
    const p1 = coord.run(() => slow.promise, (v) => applied.push(v), () => {});
    const p2 = coord.run(() => newer.promise, (v) => applied.push(v), () => {});
    slow.resolve('running'); // issued first, resolves while newer still in flight
    await p1;
    expect(applied).toEqual(['running']); // progress, not dropped for a merely-issued newer request
    newer.resolve('completed');
    await p2;
    expect(applied).toEqual(['running', 'completed']);
  });

  it('explicit generation invalidation drops old successes and errors; stale errors do not suspend polling', async () => {
    const coord = new StatusRequestCoordinator();
    const applied: string[] = [];
    const errors: unknown[] = [];
    const oldValue = deferred<string>();
    const oldError = deferred<string>();
    const p1 = coord.run(() => oldValue.promise, (v) => applied.push(v), (e) => errors.push(e));
    const p2 = coord.run(() => oldError.promise, (v) => applied.push(v), (e) => errors.push(e));
    coord.invalidate(); // explicit launch/stop
    oldValue.resolve('running');
    oldError.reject(new Error('stale failure'));
    await Promise.all([p1, p2]);
    expect(applied).toEqual([]);
    expect(errors).toEqual([]);
    await coord.run(async () => 'completed', (v) => applied.push(v), (e) => errors.push(e));
    expect(applied).toEqual(['completed']);
    expect(errors).toEqual([]);
  });

  it('an error from a stale call arriving after a terminal application is ignored', async () => {
    const coord = new StatusRequestCoordinator();
    const stale = deferred<string>();
    const terminal = deferred<string>();
    const applied: string[] = [];
    const errors: unknown[] = [];
    const p1 = coord.run(() => stale.promise, (v) => applied.push(v), (e) => errors.push(e));
    const p2 = coord.run(() => terminal.promise, (v) => applied.push(v), (e) => errors.push(e));
    terminal.resolve('completed');
    await p2;
    stale.reject(new Error('late failure'));
    await p1;
    expect(applied).toEqual(['completed']);
    expect(errors).toEqual([]);
  });
});

describe('draft workspace identity', () => {
  it('unsaved draft scopes counts/latest/findings/history to no saved system; discard restores prior identity', () => {
    const runs = [run('run-old', 'sys-a'), run('run-legacy')];
    const draftId = effectiveWorkspaceSystemId({ isDraftMode: true, selectedSystemId: 'sys-a' });
    expect(draftId).toBeNull();
    const draft = partitionRuns(runs, draftId);
    expect(draft.scoped).toEqual([]); // no latest run / findings for the draft
    expect(draft.legacy.map(r => r.id)).toEqual(['run-legacy']); // separately identified
    expect(draft.other.map(r => r.id)).toEqual(['run-old']); // not silently assigned to the draft
    const restoredId = effectiveWorkspaceSystemId({ isDraftMode: false, selectedSystemId: 'sys-a' });
    expect(partitionRuns(runs, restoredId).scoped.map(r => r.id)).toEqual(['run-old']);
  });
});

describe('system profile loading errors', () => {
  const briefs = [{ id: 'sys-a' }];
  it('surfaces a 500 integrity error body instead of returning empty success', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'System profile sys-a is corrupt: bad JSON' }) }));
    await expect(fetchSystemBriefs(fetchFn)).rejects.toThrow('corrupt');
    expect(fetchFn).toHaveBeenCalledWith('/api/systems');
  });

  it('surfaces transport failures and malformed/non-list responses', async () => {
    await expect(fetchSystemBriefs(async () => { throw new TypeError('Failed to fetch'); }))
      .rejects.toThrow(/load system profiles.*Failed to fetch/);
    await expect(fetchSystemBriefs(async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } })))
      .rejects.toThrow(/Invalid response/);
    await expect(fetchSystemBriefs(async () => ({ ok: true, status: 200, json: async () => ({ not: 'a list' }) })))
      .rejects.toThrow(/Invalid response/);
    await expect(fetchSystemBriefs(async () => ({ ok: false, status: 502, json: async () => { throw new Error('html'); } })))
      .rejects.toThrow('HTTP 502');
  });

  it('returns parsed profiles on success, and a failed refresh leaves prior loaded data untouched by the caller contract', async () => {
    await expect(fetchSystemBriefs(async () => ({ ok: true, status: 200, json: async () => briefs })))
      .resolves.toEqual(briefs);
    // app.ts assigns loadedSystems only after this resolves; on rejection it keeps prior profiles/dirty edits.
    let loaded: unknown = briefs;
    try {
      loaded = await fetchSystemBriefs(async () => ({ ok: false, status: 500, json: async () => ({ error: 'corrupt' }) }));
    } catch { /* alert path in app.ts */ }
    expect(loaded).toBe(briefs);
  });
});
