import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type * as http from 'node:http';
import { ChaosPilotServer } from '../src/server.ts';
import { MetaProvider } from '../src/providers/meta.ts';
import { resolveAdapter } from '../src/adapters/index.ts';
import { createSystemSnapshot, ensureSeededSystem } from '../src/systems/index.ts';
import { RequestPreflight, type PreflightSelection, type RequestAssessment } from '../src/web/preflight.ts';

let tempDir: string;
beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'chaospilot-readiness-'));
  vi.stubEnv('MODEL_API_KEY', 'preflight-test-secret');
  vi.stubEnv('META_MODEL', 'muse-wonder-1.0');
  vi.stubEnv('META_REASONING_EFFORT', 'low');
  vi.stubEnv('CHAOSPILOT_MAX_PROMPT_BYTES', '32768');
  vi.stubEnv('CHAOSPILOT_MAX_OUTPUT_TOKENS', '4096');
  vi.stubEnv('CHAOSPILOT_BUDGET_LEDGER_PATH', path.join(tempDir, 'ledger.json'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fsp.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function request(server: ChaosPilotServer, body: unknown): Promise<{ status: number; json: any }> {
  const listener = server.createHttpServer().listeners('request')[0] as (...args: unknown[]) => void;
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage;
  req.method = 'POST';
  req.url = '/api/investigation/preflight';
  req.headers = { host: '127.0.0.1', 'content-type': 'application/json' };
  Object.defineProperty(req, 'socket', { value: { localPort: 80 } });
  return new Promise(resolve => {
    let status = 0;
    const res: Partial<http.ServerResponse> = {
      writeHead(code: number) { status = code; return res as http.ServerResponse; },
      end(chunk?: unknown) { resolve({ status, json: chunk ? JSON.parse(String(chunk)) : null }); return res as http.ServerResponse; }
    };
    listener(req, res);
  });
}

it('measures the actual selected request without network calls, budget reservations or prompt disclosure', async () => {
  const brief = await ensureSeededSystem(path.join(tempDir, 'systems'));
  const snapshot = await createSystemSnapshot(brief);
  const adapter = resolveAdapter(brief.adapterId);
  const prepared = new MetaProvider().prepareRequest({
    contract: adapter.getContract(), source: adapter.getSourceBundle('clean'), history: [],
    experimentNumber: 1, maxExperiments: 5, systemBrief: snapshot
  });
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const server = new ChaosPilotServer({ runsDir: tempDir });
  const result = await request(server, { provider: 'meta', systemId: brief.id, expectedRevision: brief.revision, variant: 'clean', maxExperiments: 5 });
  expect(result.status).toBe(200);
  expect(result.json).toMatchObject({ mode: 'live', systemId: brief.id, revision: brief.revision, variant: 'clean', requestBytes: prepared.promptBytes, limitBytes: 32768, maxOutputTokens: 4096 });
  expect(result.json.assessment).toBe(prepared.promptBytes > 32768 ? 'over_limit' : prepared.promptBytes >= 32768 * 0.8 ? 'near_limit' : 'fits');
  expect(JSON.stringify(result.json)).not.toContain('preflight-test-secret');
  expect(JSON.stringify(result.json)).not.toContain(prepared.userMessage.slice(0, 100));
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(tempDir, 'ledger.json'))).toBe(false);
  expect((await fsp.readdir(tempDir)).filter(name => name.startsWith('run_'))).toEqual([]);

  expect((await request(server, { provider: 'meta', systemId: brief.id, expectedRevision: brief.revision + 1, variant: 'clean' })).status).toBe(409);
  expect((await request(server, { provider: 'meta', systemId: brief.id, expectedRevision: brief.revision, variant: 'inventory-candidate-a' })).status).toBe(422);
  expect((await request(server, { provider: 'mock' })).json).toEqual({ mode: 'mock', assessment: 'not_applicable' });
  expect(fetchSpy).not.toHaveBeenCalled();
});

const selection: PreflightSelection = { systemId: 'trading-gateway', expectedRevision: 1, adapterId: 'synthetic-trading', variant: 'clean', provider: 'meta', maxExperiments: 5 };
function assessment(variant: string, requestBytes: number): RequestAssessment {
  return { mode: 'live', systemId: selection.systemId, revision: 1, adapterId: selection.adapterId, variant, requestBytes, limitBytes: 1000, maxOutputTokens: 32768 };
}

it('ignores stale assessments, blocks while checking, and clears an over-limit state on a new selection', async () => {
  const messages: string[] = [];
  const pending: Array<(value: unknown) => void> = [];
  const fetcher = vi.fn(() => new Promise(resolve => pending.push(resolve)));
  const preflight = new RequestPreflight(text => messages.push(text), fetcher);
  const first = preflight.update(selection);
  expect(preflight.checking).toBe(true);
  const second = preflight.update({ ...selection, variant: 'candidate-a' });
  pending[0]!(assessment('clean', 100));
  await first;
  expect(preflight.checking).toBe(true);
  expect(messages.at(-1)).toContain('Checking');
  pending[1]!(assessment('candidate-a', 1001));
  await second;
  expect(preflight.checking).toBe(false);
  expect(preflight.overLimit).toBe(true);
  expect(messages.at(-1)).toContain('exceeds');
  await preflight.update({ ...selection, provider: 'mock' });
  expect(preflight.overLimit).toBe(false);
  expect(messages.at(-1)).toContain('Scripted mock');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('makes an unavailable preflight visible instead of reporting a successful assessment', async () => {
  const messages: string[] = [];
  const preflight = new RequestPreflight(text => messages.push(text), async () => { throw new Error('offline'); });
  await preflight.update(selection);
  expect(preflight.checking).toBe(false);
  expect(preflight.overLimit).toBe(false);
  expect(messages.at(-1)).toContain('headroom are unknown');
});
