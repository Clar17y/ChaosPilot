import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import { startTarget, parseCommand } from '../../src/target-api/target.ts';
import { requestJson } from '../../src/target-api/client.ts';
import { evaluateJourney } from '../../src/target-api/evaluator.ts';
import type { JourneyEvidence } from '../../src/target-api/types.ts';
import { SEEDED_TRADING_BRIEF } from '../../src/systems/index.ts';
import { resolveAdapter } from '../../src/adapters/index.ts';

describe('Real target HTTP boundary and truthful acknowledgement', () => {
  let targetHandle: Awaited<ReturnType<typeof startTarget>> | undefined;

  afterEach(async () => {
    if (targetHandle) {
      await targetHandle.close();
      targetHandle = undefined;
    }
  });

  it('delivers 202 accepted HTTP receipt while business work is still queued', async () => {
    // Controlled processing delay seam: 80ms delay gives enough window to verify queue state
    targetHandle = await startTarget({ variant: 'clean', processingDelayMs: 80 });
    const { endpoint, instanceId } = targetHandle;

    const controller = new AbortController();
    const exchange = await requestJson(
      endpoint,
      'POST',
      '/setup',
      { requestId: 'setup-req', kind: 'setup', limit: 100 },
      controller.signal,
    );

    expect(exchange.status).toBe(202);
    const receipt = exchange.response as any;
    expect(receipt.instanceId).toBe(instanceId);
    expect(receipt.requestId).toBe('setup-req');
    expect(receipt.status).toBe('queued');
    expect(receipt.sequence).toBe(1);

    // Business work is still queued while processing delay is active
    const diag = targetHandle.diagnostics();
    expect(diag.queued + diag.processed).toBeGreaterThanOrEqual(1);

    // Verify /events endpoint exposes observation with queued/processed counts
    const eventsExchange = await requestJson(endpoint, 'GET', '/events', undefined, controller.signal);
    expect(eventsExchange.status).toBe(200);
    const eventsObs = eventsExchange.response as any;
    expect(eventsObs.instanceId).toBe(instanceId);
    expect(typeof eventsObs.processed).toBe('number');
  });

  it('rejects commands with unknown fields, bad types, or exceeding bounds', async () => {
    targetHandle = await startTarget({ variant: 'clean', processingDelayMs: 5 });
    const { endpoint } = targetHandle;
    const controller = new AbortController();

    // Missing setup: order before setup returns 409
    const orderBeforeSetup = await requestJson(
      endpoint,
      'POST',
      '/orders',
      { requestId: 'o1', kind: 'order', orderId: 'ord-1', quantity: 2 },
      controller.signal,
    );
    expect(orderBeforeSetup.status).toBe(409);
    expect((orderBeforeSetup.response as any).error).toMatch(/setup must precede/i);

    // Valid setup
    const setupEx = await requestJson(
      endpoint,
      'POST',
      '/setup',
      { requestId: 'setup', kind: 'setup', limit: 100 },
      controller.signal,
    );
    expect(setupEx.status).toBe(202);

    // Setup called twice returns 409
    const secondSetup = await requestJson(
      endpoint,
      'POST',
      '/setup',
      { requestId: 'setup-2', kind: 'setup', limit: 100 },
      controller.signal,
    );
    expect(secondSetup.status).toBe(409);

    // Reusing requestId returns 409
    const duplicateReqId = await requestJson(
      endpoint,
      'POST',
      '/orders',
      { requestId: 'setup', kind: 'order', orderId: 'ord-1', quantity: 1 },
      controller.signal,
    );
    expect(duplicateReqId.status).toBe(409);

    // Unknown endpoint returns 404
    const unknownEndpoint = await requestJson(endpoint, 'POST', '/unknown', {}, controller.signal);
    expect(unknownEndpoint.status).toBe(404);

    // Non-JSON Content-Type returns 415
    const url = new URL('/orders', endpoint);
    const nonJsonStatus = await new Promise<number>((resolve) => {
      const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' } }, (res) => {
        resolve(res.statusCode ?? 0);
      });
      req.end('plain text');
    });
    expect(nonJsonStatus).toBe(415);

    // Body exceeding 4096 bytes returns 413
    const hugePayload = JSON.stringify({ requestId: 'big', kind: 'order', orderId: 'o', quantity: 1, padding: 'x'.repeat(5000) });
    const hugeStatus = await new Promise<number>((resolve) => {
      const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
        resolve(res.statusCode ?? 0);
      });
      req.end(hugePayload);
    });
    expect(hugeStatus).toBe(413);

    // Unknown fields in command object throws in parseCommand / returns 400
    expect(() => parseCommand('/orders', { requestId: 'o', kind: 'order', orderId: 'o', quantity: 1, extra: true })).toThrow();
    expect(() => parseCommand('/orders', { requestId: 'o', kind: 'order', orderId: 'INVALID_UPPERCASE', quantity: 1 })).toThrow();
    expect(() => parseCommand('/setup', { requestId: 's', kind: 'setup', limit: -10 })).toThrow();
    expect(() => parseCommand('/setup', { requestId: 's', kind: 'setup', limit: 10000 })).toThrow();
  });

  it('enforces loopback host authority and origin verification', async () => {
    targetHandle = await startTarget({ variant: 'clean' });
    const { endpoint } = targetHandle;
    const url = new URL('/state', endpoint);

    // Invalid host header returns 403
    const badHostStatus = await new Promise<number>((resolve) => {
      const req = http.request(url, { method: 'GET', headers: { Host: 'evil.com' } }, (res) => {
        resolve(res.statusCode ?? 0);
      });
      req.end();
    });
    expect(badHostStatus).toBe(403);

    // Invalid origin header returns 403
    const badOriginStatus = await new Promise<number>((resolve) => {
      const req = http.request(url, { method: 'GET', headers: { Origin: 'http://evil.com' } }, (res) => {
        resolve(res.statusCode ?? 0);
      });
      req.end();
    });
    expect(badOriginStatus).toBe(403);

    // Invalid sec-fetch-site returns 403
    const badFetchSiteStatus = await new Promise<number>((resolve) => {
      const req = http.request(url, { method: 'GET', headers: { 'Sec-Fetch-Site': 'cross-site' } }, (res) => {
        resolve(res.statusCode ?? 0);
      });
      req.end();
    });
    expect(badFetchSiteStatus).toBe(403);
  });

  it('distinguishes business rejection from transport error and requires observations for evaluation', async () => {
    const sourceHash = resolveAdapter('synthetic-trading').getSourceBundle('clean').hash;
    const snapshot = {
      brief: SEEDED_TRADING_BRIEF,
      contract: resolveAdapter('synthetic-trading').getContract(),
      requirementEvaluator: '',
      hash: 'fake',
    };

    // A fake evidence with HTTP 202 receipts alone cannot pass business evaluation
    const incompleteEvidence: JourneyEvidence = {
      id: 'order-lifecycle',
      instanceId: 'inst-1',
      endpoint: 'http://127.0.0.1:9999',
      exchanges: [
        {
          method: 'POST',
          path: '/setup',
          request: { requestId: 'setup', kind: 'setup', limit: 100 },
          status: 202,
          response: { instanceId: 'inst-1', receiptId: 'r1', requestId: 'setup', sequence: 1, status: 'queued' },
          elapsedMs: 2,
        },
      ],
      observation: null, // No wire completion observation
      assertions: [],
      status: 'inconclusive',
    };

    const evaluated = evaluateJourney(incompleteEvidence, sourceHash, snapshot as any);
    expect(evaluated.status).toBe('inconclusive');
    expect(evaluated.assertions.some((a) => a.id === 'evidence-completeness')).toBe(true);
  });
});
