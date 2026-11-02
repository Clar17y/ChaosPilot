import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import { startTarget } from '../../src/target-api/target.ts';
import { runApiJourneys } from '../../src/target-api/runner.ts';
import { requestJson } from '../../src/target-api/client.ts';
import { SEEDED_TRADING_BRIEF } from '../../src/systems/index.ts';
import { createSystemSnapshot } from '../../src/storage.ts';

describe('Bounded lifecycle and no late work', () => {
  let targetHandle: Awaited<ReturnType<typeof startTarget>> | undefined;

  afterEach(async () => {
    if (targetHandle) {
      await targetHandle.close();
      targetHandle = undefined;
    }
  });

  it('settles all resources, sockets and timers on close', async () => {
    targetHandle = await startTarget({ variant: 'clean', processingDelayMs: 50 });
    const { endpoint, close, diagnostics } = targetHandle;

    const controller = new AbortController();
    await requestJson(
      endpoint,
      'POST',
      '/setup',
      { requestId: 'setup', kind: 'setup', limit: 100 },
      controller.signal,
    );

    const diagBefore = diagnostics();
    expect(diagBefore.closed).toBe(false);

    await close();

    const diagAfter = diagnostics();
    expect(diagAfter.closed).toBe(true);
    expect(diagAfter.queued).toBe(0);
    expect(diagAfter.timer).toBe(false);
    expect(diagAfter.sockets).toBe(0);

    // Subsequent close() call is a no-op / idempotent
    await expect(close()).resolves.toBeUndefined();

    // Requests after close return 503 or connection refused
    const postCloseStatus = await new Promise<number>((resolve) => {
      const req = http.request(
        new URL('/state', endpoint),
        { method: 'GET', headers: { Connection: 'close' } },
        (res) => {
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', () => resolve(503));
      req.end();
    });
    expect([503, 0]).toContain(postCloseStatus);
  });

  it('terminates cleanly on pre-aborted signal', async () => {
    const systemSnapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const controller = new AbortController();
    controller.abort(new Error('Pre-aborted'));

    const record = await runApiJourneys({
      variant: 'clean',
      systemSnapshot,
      signal: controller.signal,
    });

    expect(record.status).toBe('cancelled');
    expect(record.journeys.every((j) => j.status === 'cancelled')).toBe(true);
  });

  it('settles target and cancels remaining work on in-flight abort', async () => {
    const systemSnapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);
    const controller = new AbortController();

    // Abort after 40ms, while first journey is running
    setTimeout(() => controller.abort(new Error('In-flight abort')), 40);

    const record = await runApiJourneys({
      variant: 'clean',
      systemSnapshot,
      signal: controller.signal,
      timeoutMs: 5000,
      targetOptions: { processingDelayMs: 30 },
    });

    expect(record.status).toBe('cancelled');
  });

  it('handles observation deadline timeout without unhandled rejection', async () => {
    const systemSnapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);

    // Give a tiny timeout of 15ms with 100ms processing delay per step
    const record = await runApiJourneys({
      variant: 'clean',
      systemSnapshot,
      timeoutMs: 15,
      targetOptions: { processingDelayMs: 100 },
    });

    // Inconclusive because deadline was exceeded
    expect(['inconclusive', 'cancelled']).toContain(record.status);
    expect(record.journeys.some((j) => j.error?.includes('timed out') || j.status === 'inconclusive')).toBe(true);
  });

  it('runs concurrent journeys on isolated loopback instances without state leakage', async () => {
    const systemSnapshot = await createSystemSnapshot(SEEDED_TRADING_BRIEF);

    const [runA, runB] = await Promise.all([
      runApiJourneys({ variant: 'clean', systemSnapshot, timeoutMs: 8000 }),
      runApiJourneys({ variant: 'clean', systemSnapshot, timeoutMs: 8000 }),
    ]);

    expect(runA.id).not.toBe(runB.id);
    expect(runA.status).toBe('pass');
    expect(runB.status).toBe('pass');

    // Instance IDs are distinct between runs
    const instanceA = runA.journeys[0]?.instanceId;
    const instanceB = runB.journeys[0]?.instanceId;
    expect(instanceA).toBeDefined();
    expect(instanceB).toBeDefined();
    expect(instanceA).not.toBe(instanceB);
  });

  it('enforces request deadline on hanging target requests in client transport', async () => {
    // Spin up an ephemeral HTTP server on 127.0.0.1 that never replies
    const hangingServer = http.createServer((_req, _res) => {
      // Deliberately do not reply or end response
    });
    await new Promise<void>((resolve) => hangingServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (hangingServer.address() as import('node:net').AddressInfo).port;
    const endpoint = `http://127.0.0.1:${port}`;

    const controller = new AbortController();
    try {
      await expect(
        requestJson(endpoint, 'GET', '/state', undefined, controller.signal, 40),
      ).rejects.toThrow(/Target request deadline exceeded/);
    } finally {
      await new Promise<void>((resolve) => hangingServer.close(() => resolve()));
    }
  });

  it('handles processing exception inside schedule without unhandled crash and records error status', async () => {
    const { executeExperiment } = await import('../../src/simulator/index.ts');
    targetHandle = await startTarget({
      variant: 'clean',
      processingDelayMs: 10,
      execute: (exp, variant) => {
        if (exp.steps.length > 0) {
          throw new Error('Simulation fault inside target schedule processing');
        }
        return executeExperiment(exp, variant);
      },
    });
    const { endpoint } = targetHandle;

    const controller = new AbortController();
    const exchange = await requestJson(
      endpoint,
      'POST',
      '/setup',
      { requestId: 'setup', kind: 'setup', limit: 100 },
      controller.signal,
    );
    expect(exchange.status).toBe(202);

    // Wait briefly for schedule() to process and catch the exception
    await new Promise((r) => setTimeout(r, 60));

    const eventsExchange = await requestJson(endpoint, 'GET', '/events', undefined, controller.signal);
    expect(eventsExchange.status).toBe(200);
    const obs = eventsExchange.response as any;
    expect(obs.events).toHaveLength(1);
    expect(obs.events[0]?.status).toBe('error');
    expect(obs.events[0]?.reason).toContain('Simulation fault inside target schedule processing');

    // Diagnostics confirms queue emptied and server can close cleanly
    const diag = targetHandle.diagnostics();
    expect(diag.queued).toBe(0);
    await expect(targetHandle.close()).resolves.toBeUndefined();
  });

  it('cleans up resources gracefully on abrupt client socket destruction', async () => {
    targetHandle = await startTarget({ variant: 'clean', processingDelayMs: 50 });
    const port = new URL(targetHandle.endpoint).port;

    const net = await import('node:net');
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) });
    await new Promise((resolve) => socket.once('connect', resolve));

    expect(targetHandle.diagnostics().sockets).toBeGreaterThanOrEqual(1);

    // Send partial request then abruptly destroy
    socket.write('POST /setup HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nContent-Length: 100\r\n\r\npartial');
    socket.destroy();

    // Give a short moment for close event to clear socket from server's tracked set
    await new Promise((r) => setTimeout(r, 50));
    expect(targetHandle.diagnostics().sockets).toBe(0);
  });
});
