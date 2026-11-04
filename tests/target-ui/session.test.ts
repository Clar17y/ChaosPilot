import { describe, it, expect, afterEach } from 'vitest';
import { TargetUiSessionManager } from '../../src/target-ui/session.ts';

describe('Target UI Session Manager Lifecycle and Isolation', () => {
  let manager: TargetUiSessionManager | undefined;

  afterEach(async () => {
    if (manager) {
      await manager.closeAll();
      manager = undefined;
    }
  });

  it('creates two isolated target sessions with separate endpoints and instance IDs', async () => {
    manager = new TargetUiSessionManager();
    const session1 = await manager.createSession({ variant: 'clean' });
    const session2 = await manager.createSession({ variant: 'clean' });

    expect(session1.sessionId).not.toBe(session2.sessionId);
    expect(session1.instanceId).not.toBe(session2.instanceId);
    expect(session1.endpoint).not.toBe(session2.endpoint);

    // Both endpoints are reachable
    const res1 = await fetch(`${session1.endpoint}/events`);
    const res2 = await fetch(`${session2.endpoint}/events`);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const body1 = (await res1.json()) as any;
    const body2 = (await res2.json()) as any;
    expect(body1.instanceId).toBe(session1.instanceId);
    expect(body2.instanceId).toBe(session2.instanceId);
  });

  it('handles launch then close and repeated close safely and idempotently', async () => {
    manager = new TargetUiSessionManager();
    const session = await manager.createSession({ variant: 'clean' });
    expect(manager.getSession(session.sessionId)).not.toBeNull();

    const firstClose = await manager.closeSession(session.sessionId);
    expect(firstClose).toBe(true);
    expect(manager.getSession(session.sessionId)).toBeNull();

    // Repeated close should return false without throwing
    const secondClose = await manager.closeSession(session.sessionId);
    expect(secondClose).toBe(false);

    // Endpoint is now closed
    await expect(fetch(`${session.endpoint}/events`)).rejects.toThrow();
  });

  it('enforces maximum concurrent session limits', async () => {
    manager = new TargetUiSessionManager({ maxConcurrentSessions: 2 });
    await manager.createSession();
    await manager.createSession();

    await expect(manager.createSession()).rejects.toThrow(/Maximum concurrent target UI sessions/);
  });

  it('auto-expires sessions after configured TTL', async () => {
    manager = new TargetUiSessionManager();
    // 50ms TTL for testing
    const session = await manager.createSession({ ttlMs: 50 });
    expect(manager.getSession(session.sessionId)).not.toBeNull();

    await new Promise((r) => setTimeout(r, 80));

    expect(manager.getSession(session.sessionId)).toBeNull();
  });

  it('closeAll closes all active sessions cleanly and rejects subsequent sessions', async () => {
    manager = new TargetUiSessionManager();
    const session1 = await manager.createSession();
    const session2 = await manager.createSession();

    expect(manager.listSessions().length).toBe(2);

    await manager.closeAll();
    expect(manager.listSessions().length).toBe(0);
    expect(manager.diagnostics().isClosed).toBe(true);

    await expect(manager.createSession()).rejects.toThrow(/Session manager is closed/);
  });
});
