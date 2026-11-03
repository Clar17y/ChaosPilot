import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { ChaosPilotServer } from '../../src/server.ts';
import { saveSystemBrief } from '../../src/storage.ts';
import { SEEDED_TRADING_BRIEF, SEEDED_INVENTORY_BRIEF } from '../../src/systems/index.ts';

describe('Target UI server routes (provenance-first validation)', () => {
  let app: ChaosPilotServer | undefined;
  let server: http.Server | undefined;
  let tempDir = '';

  afterEach(async () => {
    if (app && server) await app.shutdown(server);
    else if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    app = undefined; server = undefined;
    if (tempDir) { await fs.rm(tempDir, { recursive: true, force: true }); tempDir = ''; }
  });

  async function start(): Promise<string> {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'target-ui-server-test-'));
    const systemsDir = path.join(tempDir, 'systems');
    await fs.mkdir(systemsDir, { recursive: true });
    await saveSystemBrief(SEEDED_TRADING_BRIEF, systemsDir, { mode: 'create' });
    await saveSystemBrief(SEEDED_INVENTORY_BRIEF, systemsDir, { mode: 'create' });
    app = new ChaosPilotServer({ runsDir: tempDir, systemsDir });
    server = app.createHttpServer();
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    return `http://127.0.0.1:${(server!.address() as import('node:net').AddressInfo).port}`;
  }
  const selection = { systemId: SEEDED_TRADING_BRIEF.id, expectedRevision: SEEDED_TRADING_BRIEF.revision, variant: 'clean' };
  const post = (base: string, route: string, body: unknown, contentType = 'application/json') => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'Content-Type': contentType }, body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  it('rejects invalid selections with 4xx before creating any listener or browser job', async () => {
    const base = await start();
    const cases: [string, Response][] = [];
    cases.push(['variant-only legacy body', await post(base, '/api/target-ui/session', { variant: 'clean' })]);
    cases.push(['unknown field', await post(base, '/api/target-ui/session', { ...selection, extra: 1 })]);
    cases.push(['unknown variant', await post(base, '/api/target-ui/session', { ...selection, variant: 'nope' })]);
    cases.push(['revision mismatch', await post(base, '/api/target-ui/session', { ...selection, expectedRevision: 99 })]);
    cases.push(['missing profile', await post(base, '/api/target-ui/session', { ...selection, systemId: 'no-such-system' })]);
    cases.push(['wrong adapter', await post(base, '/api/target-ui/session', { systemId: SEEDED_INVENTORY_BRIEF.id, expectedRevision: SEEDED_INVENTORY_BRIEF.revision, variant: 'clean' })]);
    cases.push(['non-json', await post(base, '/api/target-ui/session', 'hello', 'text/plain')]);
    cases.push(['journey invalid', await post(base, '/api/target-ui/journey', { variant: 'clean' })]);
    for (const [name, res] of cases) {
      expect(res.status, name).toBeGreaterThanOrEqual(400);
      expect(res.status, name).toBeLessThan(500);
      expect(((await res.json()) as any).error, name).toBeTruthy();
    }
    expect(app!.targetUiSessionManager.diagnostics()).toMatchObject({ activeSessions: 0, pendingStarts: 0, activeJobs: 0 });
  });

  it('launches a provenance-pinned session, reports it, and stays usable after close-all-sessions', async () => {
    const base = await start();
    const create = await post(base, '/api/target-ui/session', selection);
    expect(create.status).toBe(201);
    const { session } = (await create.json()) as any;
    expect(session.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(session.provenance.systemSnapshot.brief.id).toBe(SEEDED_TRADING_BRIEF.id);
    expect(session.provenance.systemSnapshot.brief.revision).toBe(SEEDED_TRADING_BRIEF.revision);
    expect(session.provenance.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(session.provenance.contractHash).toMatch(/^[0-9a-f]{64}$/);

    const context = await (await fetch(`${session.endpoint}/ui-context`)).json() as any;
    expect(context.instanceId).toBe(session.instanceId);
    expect(context.provenance.sourceHash).toBe(session.provenance.sourceHash);

    const status = (await (await fetch(`${base}/api/target-ui/session`)).json()) as any;
    expect(status.active).toBe(true);
    expect(status.sessions[0].sessionId).toBe(session.sessionId);

    const closeAll = await fetch(`${base}/api/target-ui/session`, { method: 'DELETE' });
    expect(closeAll.status).toBe(200);
    await expect(fetch(`${session.endpoint}/events`)).rejects.toThrow();

    // Manager is not shut down by DELETE-without-id: a new launch still works.
    const again = await post(base, '/api/target-ui/session', selection);
    expect(again.status).toBe(201);
    const second = ((await again.json()) as any).session;
    const byId = await fetch(`${base}/api/target-ui/session/${second.sessionId}`, { method: 'DELETE' });
    expect(byId.status).toBe(200);
    const missing = await fetch(`${base}/api/target-ui/session/${second.sessionId}`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
  });

  it('server shutdown awaits target UI cleanup', async () => {
    const base = await start();
    const create = await post(base, '/api/target-ui/session', selection);
    const { session } = (await create.json()) as any;
    await app!.shutdown(server!);
    server = undefined;
    expect(app!.targetUiSessionManager.diagnostics()).toMatchObject({ activeSessions: 0, isClosed: true });
    await expect(fetch(`${session.endpoint}/events`)).rejects.toThrow();
    app = undefined;
  });

  it('cancels an active HTTP journey before waiting for its response to drain', async () => {
    const base = await start();
    const manager = app!.targetUiSessionManager;
    const runJob = manager.runJob.bind(manager);
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let stoppedByShutdown = false;
    manager.runJob = <T>(_work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> => runJob(async jobSignal => {
      entered();
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 1000);
        const abort = () => { stoppedByShutdown = true; clearTimeout(timer); resolve(); };
        if (jobSignal.aborted) abort();
        else jobSignal.addEventListener('abort', abort, { once: true });
      });
      return { cancelled: stoppedByShutdown } as T;
    }, signal);
    const response = post(base, '/api/target-ui/journey', selection);
    await started;
    await app!.shutdown(server!);
    expect((await (await response).json()) as unknown).toEqual({ cancelled: true });
    expect(stoppedByShutdown).toBe(true);
    expect(manager.diagnostics()).toMatchObject({ activeJobs: 0, pendingStarts: 0, isClosed: true });
    server = undefined;
    app = undefined;
  });
});
