import { describe, it, expect } from 'vitest';
import { TargetUiWorkspaceControllerCore, targetUiBlockedReason, type FunctionalContext } from '../../src/web/functional.ts';

const ctx = (over: Partial<FunctionalContext> = {}): FunctionalContext => ({
  systemId: 'trading-gateway', revision: 1, isDraftMode: false, hasUnsavedSystemEdits: false,
  isSystemSavePending: false, hasSelectedSystem: true, selectedAdapterId: 'synthetic-trading',
  selectedVariant: 'clean', allowedVariants: ['clean', 'candidate-a'], targetState: 'ready', snapshotState: 'ready',
  ...over,
});
const sessionFor = (c: FunctionalContext, id = 'sess-1') => ({
  sessionId: id, instanceId: `inst-${id}`, endpoint: 'http://127.0.0.1:4322', variant: c.selectedVariant,
  provenance: { systemSnapshot: { brief: { id: c.systemId, revision: c.revision } } },
});
const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};
const tick = () => new Promise(r => setTimeout(r, 0));

describe('targetUiBlockedReason completeness', () => {
  it('requires a ready snapshot, confirmed revision and confirmed variant membership', () => {
    expect(targetUiBlockedReason(ctx({ snapshotState: 'loading' }))).toMatch(/contract not confirmed/i);
    expect(targetUiBlockedReason(ctx({ revision: null }))).toMatch(/revision not confirmed/i);
    expect(targetUiBlockedReason(ctx({ allowedVariants: ['candidate-a'] }))).toMatch(/valid target variant/i);
    expect(targetUiBlockedReason(ctx())).toBeNull();
  });
});

describe('TargetUiWorkspaceControllerCore request boundaries', () => {
  it('does not let a delayed empty status response hide a newly launched session', async () => {
    const status = deferred<any>();
    const c = ctx();
    let posts = 0;
    const core = new TargetUiWorkspaceControllerCore(async (_url, init) => {
      if (init?.method === 'POST') { posts++; return res(201, { session: sessionFor(c) }); }
      return status.promise;
    }, () => {});
    core.setContext(c);
    await core.launch();
    status.resolve(res(200, { sessions: [] }));
    await tick();
    expect(core.state.session?.sessionId).toBe('sess-1');
    await core.launch();
    expect(posts).toBe(1);
  });

  it('does not restore a closed session from a same-context status request', async () => {
    const status = deferred<any>();
    const c = ctx();
    let pendingStatus = false;
    const core = new TargetUiWorkspaceControllerCore(async (_url, init) => {
      if (init?.method === 'POST') return res(201, { session: sessionFor(c) });
      if (init?.method === 'DELETE') return res(200, { closed: true });
      return pendingStatus ? status.promise : res(200, { sessions: [] });
    }, () => {});
    core.setContext(c);
    await tick();
    await core.launch();
    pendingStatus = true;
    const checking = core.checkSession();
    await core.close();
    status.resolve(res(200, { sessions: [sessionFor(c)] }));
    await checking;
    expect(core.state.session).toBeNull();
  });

  it('allows another launch after the server confirms the prior session has expired', async () => {
    const c = ctx();
    let posts = 0;
    const core = new TargetUiWorkspaceControllerCore(async (_url, init) => {
      if (init?.method === 'POST') return res(201, { session: sessionFor(c, `session-${++posts}`) });
      if (init?.method === 'DELETE') return res(404, { closed: false });
      return res(200, { sessions: [] });
    }, () => {});
    core.setContext(c);
    await tick();
    await core.launch();
    await core.close();
    expect(core.state.session).toBeNull();
    await core.launch();
    expect(posts).toBe(2);
  });

  it('sets launch pending before awaiting and ignores duplicate launches', async () => {
    const gate = deferred<any>();
    let posts = 0;
    const renders: boolean[] = [];
    const c = ctx();
    const core = new TargetUiWorkspaceControllerCore(async (url, init) => {
      if (init?.method === 'POST') { posts++; return gate.promise; }
      return res(200, { sessions: [] });
    }, s => renders.push(s.launchPending));
    core.setContext(c);
    await tick();
    const first = core.launch();
    expect(core.state.launchPending).toBe(true);
    expect(renders).toContain(true);
    void core.launch();
    gate.resolve(res(201, { session: sessionFor(c) }));
    await first;
    expect(posts).toBe(1);
    expect(core.state.session?.sessionId).toBe('sess-1');
    expect(core.state.launchPending).toBe(false);
  });

  it('discards a late launch for an abandoned profile and closes the orphan session', async () => {
    const gate = deferred<any>();
    const deletes: string[] = [];
    const first = ctx();
    const second = ctx({ systemId: 'other-system', revision: 2 });
    const core = new TargetUiWorkspaceControllerCore(async (url, init) => {
      if (init?.method === 'POST') return gate.promise;
      if (init?.method === 'DELETE') { deletes.push(url); return res(200, { closed: true }); }
      return res(200, { sessions: [] });
    }, () => {});
    core.setContext(first);
    await tick();
    const launching = core.launch();
    core.setContext(second);
    gate.resolve(res(201, { session: sessionFor(first, 'orphan-1') }));
    await launching;
    await tick();
    expect(core.state.session).toBeNull();
    expect(deletes).toEqual(['/api/target-ui/session/orphan-1']);
  });

  it('clears journey results on profile change and discards a late journey response', async () => {
    const gate = deferred<any>();
    const first = ctx(), second = ctx({ selectedVariant: 'candidate-a' });
    const outcome = (c: FunctionalContext) => ({
      evidence: {
        instanceId: 'inst-9', finishedAt: '2026-01-01T00:00:01Z', variant: c.selectedVariant,
        exchanges: [], events: [], uiObservations: [],
        provenance: { systemSnapshot: { brief: { id: c.systemId, revision: c.revision } } },
      },
      evaluation: { status: 'inconclusive', classification: 'inconclusive-wire', reasons: ['partial'] },
    });
    let journeyImpl: () => Promise<any> = async () => res(200, outcome(first));
    const core = new TargetUiWorkspaceControllerCore(async (url, init) => {
      if (url.endsWith('/journey')) return journeyImpl();
      return res(200, { sessions: [] });
    }, () => {});
    core.setContext(first);
    await tick();
    await core.runJourney();
    expect(core.state.outcome).not.toBeNull();
    journeyImpl = () => gate.promise;
    const running = core.runJourney();
    core.setContext(second);
    expect(core.state.outcome).toBeNull();
    gate.resolve(res(200, outcome(first)));
    await running;
    expect(core.state.outcome).toBeNull();
  });

  it('keeps the session visible when the server does not confirm a close', async () => {
    const c = ctx();
    let deleteStatus = 500;
    const core = new TargetUiWorkspaceControllerCore(async (url, init) => {
      if (init?.method === 'POST') return res(201, { session: sessionFor(c) });
      if (init?.method === 'DELETE') return res(deleteStatus, { closed: deleteStatus === 200 });
      return res(200, { sessions: [] });
    }, () => {});
    core.setContext(c);
    await tick();
    await core.launch();
    await core.close();
    expect(core.state.session?.sessionId).toBe('sess-1');
    expect(core.state.status).toMatch(/Close failed/);
    deleteStatus = 200;
    await core.close();
    expect(core.state.session).toBeNull();
  });

  it('does not refetch session state for an identical context, and only adopts matching sessions', async () => {
    const c = ctx();
    let gets = 0;
    const foreign = sessionFor(ctx({ systemId: 'someone-else' }), 'foreign-1');
    const core = new TargetUiWorkspaceControllerCore(async () => {
      gets++;
      return res(200, { sessions: [foreign, sessionFor(c, 'mine-1')] });
    }, () => {});
    core.setContext(c);
    await tick();
    core.setContext(ctx());
    core.setContext(ctx());
    await tick();
    expect(gets).toBe(1);
    expect(core.state.session?.sessionId).toBe('mine-1');
  });

  it('closes the previous session when the profile target changes', async () => {
    const first = ctx(), second = ctx({ selectedVariant: 'candidate-a' });
    const deletes: string[] = [];
    const core = new TargetUiWorkspaceControllerCore(async (url, init) => {
      if (init?.method === 'POST') return res(201, { session: sessionFor(first) });
      if (init?.method === 'DELETE') { deletes.push(url); return res(200, { closed: true }); }
      return res(200, { sessions: [] });
    }, () => {});
    core.setContext(first);
    await tick();
    await core.launch();
    expect(core.state.session).not.toBeNull();
    core.setContext(second);
    await tick(); await tick();
    expect(deletes).toEqual(['/api/target-ui/session/sess-1']);
    expect(core.state.session).toBeNull();
  });
});
