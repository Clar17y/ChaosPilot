import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type * as http from 'node:http';
import { ChaosPilotServer } from '../src/server.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { getContract } from '../src/inventory/contract.ts';
import { computeSnapshotHash } from '../src/systems/index.ts';
import { canonicalJson } from '../src/evidence.ts';
import { listRuns } from '../src/storage.ts';

// The real HTTP handlers are exercised directly (no socket listener), so this
// file runs in sandboxes that forbid binding loopback ports.
let runsDir: string;
let instance: ChaosPilotServer;
let listener: (...args: unknown[]) => void;
let providerFactoryCalls = 0;

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chaospilot-inventory-api-'));
  providerFactoryCalls = 0;
  instance = new ChaosPilotServer({
    runsDir,
    providerFactory: (kind) => {
      providerFactoryCalls++;
      if (kind !== 'mock') throw new Error('Unsupported test provider');
      return new MockProvider();
    },
  });
  const server = instance.createHttpServer();
  listener = server.listeners('request')[0] as typeof listener;
});

afterEach(async () => {
  await fs.rm(runsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload)] : []) as any;
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1', 'content-type': 'application/json' };
  req.socket = { localPort: 80 };
  let status = 0;
  let text = '';
  const done = new Promise<void>((resolve) => {
    const res: Partial<http.ServerResponse> & { end: (chunk?: unknown) => void } = {
      writeHead(code: number) { status = code; return res as http.ServerResponse; },
      end(chunk?: unknown) { if (chunk) text += String(chunk); resolve(); return res as http.ServerResponse; },
    };
    listener(req, res);
  });
  await done;
  return { status, json: text ? JSON.parse(text) : null };
}

describe('Inventory HTTP API', () => {
  it('serves the saved inventory system snapshot with matching revision, adapter, contract and hash', async () => {
    const { status, json } = await call('GET', '/api/systems/inventory-reservation/snapshot');
    expect(status).toBe(200);
    expect(json.brief.id).toBe('inventory-reservation');
    expect(json.brief.adapterId).toBe('inventory-reservation');
    expect(json.brief.revision).toBe(1);
    expect(canonicalJson(json.contract)).toBe(canonicalJson(getContract()));
    expect(json.hash).toBe(computeSnapshotHash(json.brief, json.contract));
  });

  it('lists the seeded inventory system alongside trading', async () => {
    const { status, json } = await call('GET', '/api/systems');
    expect(status).toBe(200);
    expect(json.map((s: any) => s.id)).toEqual(expect.arrayContaining(['trading-gateway', 'inventory-reservation']));
  });

  it('returns adapter-specific targets and contract, rejecting unknown adapters', async () => {
    expect((await call('GET', '/api/targets?adapterId=inventory-reservation')).json).toEqual(['clean', 'inventory-candidate-a']);
    expect((await call('GET', '/api/targets')).json).toContain('candidate-a');
    expect((await call('GET', '/api/targets?adapterId=nope')).status).toBe(400);
    const contract = await call('GET', '/api/contract?adapterId=inventory-reservation');
    expect(contract.json.name).toBe('Inventory reservation service');
    expect((await call('GET', '/api/contract?adapterId=nope')).status).toBe(503);
  });

  it('status keeps legacy trading targetVariants and adds per-adapter mapping from backend definitions', async () => {
    const { status, json } = await call('GET', '/api/status');
    expect(status).toBe(200);
    // Legacy field: unchanged trading list for existing clients.
    expect(json.targetVariants).toContain('candidate-a');
    expect(json.targetVariants).not.toContain('inventory-candidate-a');
    expect(json.targetVariantsByAdapter).toEqual({
      'synthetic-trading': json.targetVariants,
      'inventory-reservation': ['clean', 'inventory-candidate-a'],
    });
    // Dedicated endpoint remains authoritative and agrees with the mapping.
    expect((await call('GET', '/api/targets?adapterId=synthetic-trading')).json).toEqual(json.targetVariants);
    expect((await call('GET', '/api/targets?adapterId=inventory-reservation')).json).toEqual(json.targetVariantsByAdapter['inventory-reservation']);
  });

  it('rejects a cross-adapter variant before constructing a provider', async () => {
    const { status, json } = await call('POST', '/api/investigation/start', {
      systemId: 'inventory-reservation', variant: 'candidate-a', provider: 'mock',
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/Unsupported variant/);
    expect(providerFactoryCalls).toBe(0);
  });

  it('runs an offline inventory investigation end to end and replays it over HTTP', async () => {
    const started = await call('POST', '/api/investigation/start', {
      systemId: 'inventory-reservation', variant: 'inventory-candidate-a', provider: 'mock', expectedRevision: 1,
    });
    expect(started.status).toBe(202);
    expect(started.json.systemBrief).toMatchObject({ id: 'inventory-reservation', revision: 1 });
    const runId = started.json.id as string;

    await vi.waitFor(async () => {
      expect(instance.getActiveInvestigation()).toBeNull();
      expect(await listRuns(runsDir)).toHaveLength(1);
    }, { timeout: 15000 });

    const record = await call('GET', `/api/runs/${runId}`);
    expect(record.status).toBe(200);
    expect(record.json.variant).toBe('inventory-candidate-a');
    expect(record.json.contextAudit.adapterId).toBe('inventory-reservation');
    expect(record.json.findings.length).toBeGreaterThan(0);
    expect(record.json.proposalAttempts.every((a: any) => a.requestSent === false)).toBe(true);

    const replay = await call('POST', `/api/runs/${runId}/replay`);
    expect(replay.status).toBe(200);
    expect(replay.json.exactReproductionClaimed).toBe(true);
  });

  it('rejects an unconfigured system before constructing a provider', async () => {
    const created = await call('POST', '/api/systems', {
      schemaVersion: 1, id: 'unconfigured-one', revision: 1, name: 'Unconfigured',
      overview: 'No adapter yet', requirements: ['TBD'], adapterId: 'unconfigured',
      updatedAt: new Date().toISOString(),
    });
    expect(created.status).toBe(201);
    const { status } = await call('POST', '/api/investigation/start', {
      systemId: 'unconfigured-one', variant: 'clean', provider: 'mock',
    });
    expect(status).toBe(400);
    expect(providerFactoryCalls).toBe(0);
  });
});
