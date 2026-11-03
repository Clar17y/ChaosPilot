import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ChaosPilotServer } from '../../src/server.ts';
import { saveSystemBrief } from '../../src/storage.ts';
import { SEEDED_TRADING_BRIEF, SEEDED_INVENTORY_BRIEF } from '../../src/systems/index.ts';

describe('Server API routes for target-api journeys', () => {
  let tmpDir: string;
  let testRunsDir: string;
  let testSystemsDir: string;
  let instance: ChaosPilotServer;
  let httpServer: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-target-api-test-'));
    testRunsDir = path.join(tmpDir, 'runs');
    testSystemsDir = path.join(tmpDir, 'systems');
    await fs.mkdir(testSystemsDir, { recursive: true });

    // Seed trading and inventory systems
    await saveSystemBrief(SEEDED_TRADING_BRIEF, testSystemsDir, { mode: 'create' });
    await saveSystemBrief(SEEDED_INVENTORY_BRIEF, testSystemsDir, { mode: 'create' });

    instance = new ChaosPilotServer({
      runsDir: testRunsDir,
      systemsDir: testSystemsDir,
    });
    httpServer = instance.createHttpServer();
    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = httpServer.address() as import('node:net').AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  function request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const req = http.request(
        new URL(path, baseUrl),
        {
          method,
          headers: {
            Connection: 'close',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
            ...headers,
          },
        },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => {
            try {
              const data = text.length > 0 ? JSON.parse(text) : null;
              resolve({ status: res.statusCode ?? 0, data });
            } catch {
              resolve({ status: res.statusCode ?? 0, data: text });
            }
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  it('GET /api/target-api/catalog returns reviewed scenario catalog', async () => {
    const res = await request('GET', '/api/target-api/catalog');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data).toHaveLength(3);
    expect(res.data[0].id).toBe('order-lifecycle');
    expect(res.data[1].id).toBe('credit-rejection');
    expect(res.data[2].id).toBe('execution-retry');
  });

  it('POST /api/target-api/run validates selection, executes journeys, and saves record', async () => {
    // 415 for non-JSON
    const nonJsonRes = await request('POST', '/api/target-api/run', undefined, { 'Content-Type': 'text/plain' });
    expect(nonJsonRes.status).toBe(415);

    // 400 for missing fields
    const missingFields = await request('POST', '/api/target-api/run', { systemId: 'trading-gateway' });
    expect(missingFields.status).toBe(400);

    // 404 for unknown system
    const notFoundRes = await request('POST', '/api/target-api/run', {
      systemId: 'unknown-sys',
      expectedRevision: 1,
      variant: 'clean',
    });
    expect(notFoundRes.status).toBe(404);

    // 409 for revision conflict
    const conflictRes = await request('POST', '/api/target-api/run', {
      systemId: 'trading-gateway',
      expectedRevision: 99,
      variant: 'clean',
    });
    expect(conflictRes.status).toBe(409);

    // 400 for unsupported adapter (inventory-reservation)
    const inventoryRes = await request('POST', '/api/target-api/run', {
      systemId: SEEDED_INVENTORY_BRIEF.id,
      expectedRevision: 1,
      variant: 'clean',
    });
    expect(inventoryRes.status).toBe(400);
    expect(inventoryRes.data.error).toMatch(/only supported for the "synthetic-trading" adapter/i);

    // Valid execution
    const validRes = await request('POST', '/api/target-api/run', {
      systemId: 'trading-gateway',
      expectedRevision: 1,
      variant: 'clean',
    });
    expect(validRes.status).toBe(201);
    expect(validRes.data.id).toMatch(/^apij_/);
    expect(validRes.data.status).toBe('pass');

    // GET /api/target-api/runs lists the run
    const listRes = await request('GET', '/api/target-api/runs');
    expect(listRes.status).toBe(200);
    expect(listRes.data.some((r: any) => r.id === validRes.data.id)).toBe(true);

    // GET /api/target-api/runs/:id returns the record
    const getRes = await request('GET', `/api/target-api/runs/${validRes.data.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.data.id).toBe(validRes.data.id);

    // GET /api/target-api/runs/:id with invalid ID returns 400
    const badIdRes = await request('GET', '/api/target-api/runs/bad%20id%21');
    expect(badIdRes.status).toBe(400);

    // POST /api/target-api/compare compares against saved run
    const compareRes = await request('POST', '/api/target-api/compare', {
      originalRunId: validRes.data.id,
      systemId: 'trading-gateway',
      expectedRevision: 1,
      variant: 'clean',
    });
    expect(compareRes.status).toBe(200);
    expect(compareRes.data.comparison.status).toBe('match');
  });
});
