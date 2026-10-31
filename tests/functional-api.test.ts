import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type * as http from 'node:http';
import { ChaosPilotServer } from '../src/server.ts';
import { saveSystemBrief, SEEDED_INVENTORY_BRIEF, SEEDED_TRADING_BRIEF } from '../src/systems/index.ts';

describe('Functional baselines HTTP API', () => {
  let tmpDir: string;
  let runsDir: string;
  let systemsDir: string;
  let instance: ChaosPilotServer;
  let listener: (req: any, res: any) => void;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chaospilot-fn-api-'));
    runsDir = path.join(tmpDir, 'runs');
    systemsDir = path.join(tmpDir, 'systems');

    await saveSystemBrief(SEEDED_TRADING_BRIEF, systemsDir, { mode: 'create' });

    instance = new ChaosPilotServer({
      runsDir,
      systemsDir,
    });
    const server = instance.createHttpServer();
    listener = server.listeners('request')[0] as typeof listener;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  async function call(
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: any; headers: Record<string, string | number> }> {
    let payload = '';
    if (typeof body === 'string') {
      payload = body;
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
    }

    const req = Readable.from(payload ? [Buffer.from(payload)] : []) as any;
    req.method = method;
    req.url = url;
    req.headers = {
      host: '127.0.0.1',
      origin: 'http://127.0.0.1',
      ...(payload ? { 'content-type': 'application/json' } : {}),
      ...headers,
    };
    req.socket = { localPort: 80 };

    let status = 0;
    let resHeaders: Record<string, string | number> = {};
    let text = '';

    const done = new Promise<void>((resolve) => {
      const res: Partial<http.ServerResponse> & { end: (chunk?: unknown) => void } = {
        writeHead(code: number, headersArg?: any) {
          status = code;
          if (headersArg) resHeaders = { ...headersArg };
          return res as http.ServerResponse;
        },
        end(chunk?: unknown) {
          if (chunk) text += String(chunk);
          resolve();
          return res as http.ServerResponse;
        },
      };
      listener(req, res);
    });

    await done;
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status, json, headers: resHeaders };
  }

  it('GET /api/functional/catalog returns allowlisted deterministic scenarios', async () => {
    const res = await call('GET', '/api/functional/catalog');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json)).toBe(true);
    expect(res.json.length).toBeGreaterThanOrEqual(2);
    expect(res.json.some((s: any) => s.id === 'trading-lifecycle-partial-fill-cancel')).toBe(true);
    expect(res.json.some((s: any) => s.id === 'trading-used-credit-admission-rejection')).toBe(true);
  });

  it('GET /api/functional/runs returns empty list initially and lists runs after execution', async () => {
    const initial = await call('GET', '/api/functional/runs');
    expect(initial.status).toBe(200);
    expect(initial.json).toEqual([]);

    // Run baselines
    const runRes = await call('POST', '/api/functional/run', {
      systemId: 'trading-gateway',
      expectedRevision: 1,
      variant: 'clean',
    });
    expect(runRes.status).toBe(201);
    const runId = runRes.json.id;

    // List runs now contains the saved run
    const listed = await call('GET', '/api/functional/runs');
    expect(listed.status).toBe(200);
    expect(listed.json.length).toBe(1);
    expect(listed.json[0].id).toBe(runId);
    expect(listed.json[0].status).toBe('pass');
    expect(listed.json[0].variant).toBe('clean');

    // GET /api/functional/runs/:id returns full detail
    const detail = await call('GET', `/api/functional/runs/${runId}`);
    expect(detail.status).toBe(200);
    expect(detail.json.id).toBe(runId);
    expect(detail.json.scenarios.length).toBeGreaterThanOrEqual(2);
    expect(detail.json.evaluator.id).toBe('functional-evaluator');
  });

  it('GET /api/functional/runs/:id returns 404 for missing run and 400 for invalid ID', async () => {
    const notFound = await call('GET', '/api/functional/runs/fnrun_does_not_exist');
    expect(notFound.status).toBe(404);

    const invalid = await call('GET', '/api/functional/runs/invalid_ledger_test');
    expect(invalid.status).toBe(400);
  });

  it('POST /api/functional/run rejects stale expectedRevision with 409 Conflict', async () => {
    const res = await call('POST', '/api/functional/run', {
      systemId: 'trading-gateway',
      expectedRevision: 999, // Current is 1
      variant: 'clean',
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/Revision conflict/);
  });

  it('POST /api/functional/run rejects unsupported adapters with 400 Bad Request', async () => {
    // Seed inventory brief
    await saveSystemBrief(SEEDED_INVENTORY_BRIEF, systemsDir, { mode: 'create' });

    const res = await call('POST', '/api/functional/run', {
      systemId: 'inventory-reservation',
      expectedRevision: 1,
      variant: 'clean',
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/only supported for the "synthetic-trading" adapter/);
  });

  it('POST /api/functional/run rejects unsupported variant with 400 Bad Request', async () => {
    const res = await call('POST', '/api/functional/run', {
      systemId: 'trading-gateway',
      expectedRevision: 1,
      variant: 'inventory-candidate-a',
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/Unsupported variant/);
  });

  it('POST /api/functional/run rejects unrecognized payload fields with 400 Bad Request', async () => {
    const res = await call('POST', '/api/functional/run', {
      systemId: 'trading-gateway',
      expectedRevision: 1,
      variant: 'clean',
      arbitraryExperimentCode: 'console.log("hack")',
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/unknown fields/);
  });

  it('POST /api/functional/run enforces same-origin protection', async () => {
    const res = await call(
      'POST',
      '/api/functional/run',
      { systemId: 'trading-gateway', variant: 'clean' },
      { origin: 'http://malicious-attacker.com' },
    );
    expect(res.status).toBe(403);
    expect(res.json.error).toMatch(/Same-origin/);
  });

  it('POST /api/functional/run enforces JSON content-type', async () => {
    const res = await call(
      'POST',
      '/api/functional/run',
      'plain text',
      { 'content-type': 'text/plain' },
    );
    expect(res.status).toBe(415);
  });
  it.each([
    null, [], 42, 'null', '{}',
    { systemId: 42, variant: 42 },
    { systemId: null, expectedRevision: 1, variant: 'clean' },
    { systemId: [], expectedRevision: 1, variant: 'clean' },
    { systemId: 'trading-gateway', expectedRevision: 1, variant: null },
    { systemId: 'trading-gateway', expectedRevision: 1, variant: [] },
    { systemId: 'trading-gateway', expectedRevision: '1', variant: 'clean' },
    { systemId: 'trading-gateway', expectedRevision: null, variant: 'clean' },
    { systemId: 'trading-gateway', variant: 'clean' },
    { systemId: 'trading-gateway', expectedRevision: 1 },
    { expectedRevision: 1, variant: 'clean' },
    { systemId: ' trading-gateway ', expectedRevision: 1, variant: 'clean' },
  ])('rejects malformed selection before execution: %j', async body => {
    const res = await call('POST', '/api/functional/run', body);
    expect(res.status).toBe(400);
    expect((await call('GET', '/api/functional/runs')).json).toEqual([]);
  });

  it('keeps bounded body and exact authoritative context validation', async () => {
    expect((await call('POST', '/api/functional/run', { padding: 'x'.repeat(66000) })).status).toBe(413);
    expect((await call('POST', '/api/functional/run', { systemId: 'missing', expectedRevision: 1, variant: 'clean' })).status).toBe(404);
    expect((await call('POST', '/api/functional/run', { systemId: 'trading-gateway', expectedRevision: 1, variant: 'unknown' })).status).toBe(400);
  });

  it('reopens pinned evidence from a new server instance after the saved brief changes', async () => {
    const run = await call('POST', '/api/functional/run', { systemId: 'trading-gateway', expectedRevision: 1, variant: 'clean' });
    expect(run.status).toBe(201);
    await saveSystemBrief({ ...SEEDED_TRADING_BRIEF, overview: 'Later edited brief' }, systemsDir, { mode: 'update', expectedRevision: 1 });
    instance = new ChaosPilotServer({ runsDir, systemsDir });
    listener = instance.createHttpServer().listeners('request')[0] as typeof listener;
    const reopened = await call('GET', `/api/functional/runs/${run.json.id}`);
    expect(reopened.status).toBe(200); expect(reopened.json).toEqual(run.json);
    expect(reopened.json.systemBrief.revision).toBe(1);
    expect((await call('POST', '/api/functional/run', { systemId: 'trading-gateway', expectedRevision: 1, variant: 'clean' })).status).toBe(409);
  });

  it('serves the production functional browser module and its pure workspace dependency', async () => {
    const functional = await call('GET', '/functional.js');
    expect(functional.status).toBe(200);
    expect(functional.json).toContain('class FunctionalController');
    expect(functional.json).toContain('./workspace.js');
    expect((await call('GET', '/workspace.js')).status).toBe(200);
  });

});
