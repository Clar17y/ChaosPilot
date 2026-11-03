import { describe, it, expect, vi } from 'vitest';
import { TargetUiSessionManager } from '../../src/target-ui/session.ts';
import type { TargetHandle } from '../../src/target-api/target.ts';

let counter = 0;
function fakeHandle(closeImpl?: () => Promise<void>): TargetHandle & { closes: number } {
  const n = ++counter;
  const handle = {
    endpoint: `http://127.0.0.1:${41000 + n}`,
    instanceId: `inst-${n}`,
    closes: 0,
    close: async () => { handle.closes++; await closeImpl?.(); },
    diagnostics: () => ({ closed: handle.closes > 0, queued: 0, processed: 0, timer: false, sockets: 0 }),
  };
  return handle as any;
}
const deferred = <T>() => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('TargetUiSessionManager pending-start ownership (injected listener seam)', () => {
  it('reserves capacity for pending starts: concurrent starts at capacity 1 yield one session', async () => {
    const gate = deferred<TargetHandle>();
    const start = vi.fn(() => gate.promise);
    const manager = new TargetUiSessionManager({ maxConcurrentSessions: 1, startTarget: start as any });
    const first = manager.createSession();
    await expect(manager.createSession()).rejects.toThrow(/Maximum concurrent/);
    expect(start).toHaveBeenCalledTimes(1);
    gate.resolve(fakeHandle());
    const session = await first;
    expect(manager.diagnostics()).toMatchObject({ activeSessions: 1, pendingStarts: 0 });
    await manager.closeAll();
    expect(manager.getSession(session.sessionId)).toBeNull();
  });

  it('closeAll during a pending start never publishes a session into the closed manager', async () => {
    const gate = deferred<TargetHandle>();
    const handle = fakeHandle();
    const manager = new TargetUiSessionManager({ startTarget: (() => gate.promise) as any });
    const pending = manager.createSession();
    const closing = manager.closeAll();
    gate.resolve(handle);
    await expect(pending).rejects.toThrow(/Session manager is closed/);
    await closing;
    expect(handle.closes).toBe(1);
    expect(manager.diagnostics()).toMatchObject({ activeSessions: 0, pendingStarts: 0, isClosed: true });
    await expect(manager.createSession()).rejects.toThrow(/Session manager is closed/);
  });

  it('abort during a pending start closes the started listener and frees capacity', async () => {
    const gate = deferred<TargetHandle>();
    const handle = fakeHandle();
    let calls = 0;
    const manager = new TargetUiSessionManager({
      maxConcurrentSessions: 1,
      startTarget: (async () => (++calls === 1 ? gate.promise : fakeHandle())) as any,
    });
    const controller = new AbortController();
    const pending = manager.createSession({ signal: controller.signal });
    controller.abort(new Error('client gone'));
    gate.resolve(handle);
    await expect(pending).rejects.toThrow(/client gone/);
    expect(handle.closes).toBe(1);
    const retry = await manager.createSession();
    expect(retry.sessionId).toBeTruthy();
    await manager.closeAll();
  });

  it('a failed start frees its reservation', async () => {
    let calls = 0;
    const manager = new TargetUiSessionManager({
      maxConcurrentSessions: 1,
      startTarget: (async () => { if (++calls === 1) throw new Error('listen failed'); return fakeHandle(); }) as any,
    });
    await expect(manager.createSession()).rejects.toThrow(/listen failed/);
    expect(manager.diagnostics().pendingStarts).toBe(0);
    await manager.createSession();
    await manager.closeAll();
  });

  it('a failed close retains ownership, reports no success, and can be retried', async () => {
    let failing = true;
    const handle = fakeHandle(async () => { if (failing) throw new Error('close stuck'); });
    const manager = new TargetUiSessionManager({ startTarget: (async () => handle) as any });
    const session = await manager.createSession();
    await expect(manager.closeSession(session.sessionId)).rejects.toThrow(/close stuck/);
    expect(manager.diagnostics().activeSessions).toBe(1);
    failing = false;
    await expect(manager.closeSession(session.sessionId)).resolves.toBe(true);
    await expect(manager.closeSession(session.sessionId)).resolves.toBe(false);
    await manager.closeAll();
  });

  it('closeAllSessions closes listeners but keeps the manager usable', async () => {
    const manager = new TargetUiSessionManager({ startTarget: (async () => fakeHandle()) as any });
    await manager.createSession();
    await manager.closeAllSessions();
    expect(manager.diagnostics()).toMatchObject({ activeSessions: 0, isClosed: false });
    await manager.createSession();
    await manager.closeAll();
  });

  it('bounds browser jobs and aborts them on shutdown', async () => {
    const manager = new TargetUiSessionManager({ maxConcurrentJobs: 1, startTarget: (async () => fakeHandle()) as any });
    const gate = deferred<string>();
    let jobSignal: AbortSignal | undefined;
    const job = manager.runJob(async (signal) => { jobSignal = signal; return gate.promise; });
    await expect(manager.runJob(async () => 'second')).rejects.toThrow(/Maximum concurrent browser jobs/);
    const closing = manager.closeAll();
    expect(jobSignal?.aborted).toBe(true);
    gate.resolve('done');
    await expect(job).resolves.toBe('done');
    await closing;
    expect(manager.diagnostics().activeJobs).toBe(0);
  });

  it('validates bounds and TTL', async () => {
    expect(() => new TargetUiSessionManager({ maxConcurrentSessions: 0 })).toThrow(/Invalid concurrency bound/);
    expect(() => new TargetUiSessionManager({ maxConcurrentJobs: 99 })).toThrow(/Invalid concurrency bound/);
    const manager = new TargetUiSessionManager({ startTarget: (async () => fakeHandle()) as any });
    await expect(manager.createSession({ ttlMs: 5 })).rejects.toThrow(/Invalid session TTL/);
    await expect(manager.createSession({ variant: 'nope' as any })).rejects.toThrow();
    await manager.closeAll();
  });
});
