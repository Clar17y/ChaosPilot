import { afterEach, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { requestJson, TargetRequestError } from '../../src/target-api/client.ts';
import * as target from '../../src/target-api/target.ts';
import { runApiJourneys, seal } from '../../src/target-api/runner.ts';
import { createSystemSnapshot } from '../../src/storage.ts';
import { SEEDED_TRADING_BRIEF } from '../../src/systems/index.ts';
import { saveApiJourneyRun, getApiJourneyRun, isValidApiJourneyRecord } from '../../src/target-api/storage.ts';
import { compareApiJourneys } from '../../src/target-api/compare.ts';
import { evaluateJourney } from '../../src/target-api/evaluator.ts';
import { targetApiResultHtml } from '../../src/web/target-api.ts';
vi.mock('../../src/target-api/target.ts', async original => ({ ...await original<typeof import('../../src/target-api/target.ts')>() }));
const servers: http.Server[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); } });
async function serve(handler: http.RequestListener) {
  const s = http.createServer(handler); servers.push(s);
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  return { s, endpoint: `http://127.0.0.1:${(s.address() as any).port}` };
}
async function failure(endpoint: string, signal = new AbortController().signal, timeout = 100) {
  const error = await requestJson(endpoint, 'GET', '/state', undefined, signal, timeout).catch(e => e);
  expect(error).toBeInstanceOf(TargetRequestError); return (error as TargetRequestError).exchange;
}
it.each(['non-json', 'invalid-json'] as const)('captures real %s body and status', async kind => {
  const { endpoint } = await serve((_, res) => { res.writeHead(503, { 'Content-Type': kind === 'non-json' ? 'text/html' : 'application/json' }); res.end('<bad>💥'); });
  const e = await failure(endpoint);
  expect(e.status).toBe(503); expect(e.transportFailure).toMatchObject({ kind, preview: '<bad>💥', receivedBytes: 9, capturedBytes: 9, complete: true, truncated: false });
  expect(Object.isFrozen(e)).toBe(true); expect(Object.isFrozen(e.transportFailure)).toBe(true);
});
it('decodes split UTF-8 JSON and snapshots actual serialized request', async () => {
  const { endpoint } = await serve((_, res) => { res.setHeader('Content-Type', 'application/json'); const b = Buffer.from('"💥"'); res.write(b.subarray(0, 3)); setTimeout(() => res.end(b.subarray(3)), 5); });
  const body = { nested: { n: 1 }, absent: undefined }; const pending = requestJson(endpoint, 'POST', '/setup', body, new AbortController().signal); body.nested.n = 2;
  const e = await pending; expect(e.response).toBe('💥'); expect(e.request).toEqual({ nested: { n: 1 } }); expect(e.transportFailure).toBeUndefined();
});
it('caps oversized response preview and freezes counters against late callbacks', async () => {
  const { endpoint } = await serve((_, res) => { res.setHeader('Content-Type', 'application/json'); res.end('x'.repeat(4 * 1024 * 1024 + 100)); });
  const e = await failure(endpoint, undefined, 1500); const saved = JSON.stringify(e);
  expect(e.transportFailure).toMatchObject({ kind: 'oversize', capturedBytes: 65536, truncated: true, complete: false });
  expect(e.transportFailure!.receivedBytes).toBeGreaterThan(4 * 1024 * 1024); expect(e.transportFailure!.preview.length).toBe(65536);
  await new Promise(r => setTimeout(r, 20)); expect(JSON.stringify(e)).toBe(saved);
});
it.each(['deadline', 'aborted', 'reset'] as const)('retains partial body on %s', async mode => {
  const c = new AbortController();
  const { endpoint } = await serve((_, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"part":'); setTimeout(() => { if (mode === 'reset') res.destroy(); if (mode === 'aborted') c.abort(new Error('stop <now>')); }, 10); });
  const e = await failure(endpoint, c.signal, 60);
  expect(e.status).toBe(200); expect(e.transportFailure).toMatchObject({ kind: mode === 'reset' ? 'network' : mode, preview: '{"part":', receivedBytes: 8, capturedBytes: 8, complete: false, truncated: false });
});
it('records no-header deadline and connection refusal, but preflight has no exchange', async () => {
  let requests = 0; const { endpoint, s } = await serve(() => { requests++; });
  expect((await failure(endpoint)).transportFailure).toMatchObject({ kind: 'deadline', preview: '', complete: false });
  expect((await failure(endpoint)).status).toBe(0);
  const c = new AbortController(); c.abort();
  expect(() => requestJson(endpoint, 'GET', '/state', undefined, c.signal)).toThrow();
  for (const invalid of ['//bad', '///bad', '/\\bad', 'http://127.0.0.1/state', '/state?x=1', '/state#x', ' /state', '/state\n', '/state\r', '/state\t', '/orders//id', '/orders/../state', '/orders/%61']) {
    expect(() => requestJson(endpoint, 'GET', invalid, undefined, new AbortController().signal)).toThrow();
  }
  expect(requests).toBe(2);
  s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); servers.splice(servers.indexOf(s), 1);
  const e = await failure(endpoint); expect(e.status).toBe(0); expect(e.transportFailure).toMatchObject({ kind: 'network', receivedBytes: 0, capturedBytes: 0, preview: '' });
});
it.each(['non-json', 'abort', 'deadline'] as const)('runner retains exactly one actual failed attempt and safely reopens %s', async mode => {
  const c = new AbortController(); let closes = 0;
  vi.spyOn(target, 'startTarget').mockImplementation(async () => {
    const { endpoint, s } = await serve((_, res) => {
      if (mode === 'non-json') { res.writeHead(503, { 'Content-Type': 'text/html' }); res.end('<script>bad</script>'); }
      else if (mode === 'abort') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('<partial>'); setTimeout(() => c.abort(new Error('stop <now>')), 5); }
    });
    return { endpoint, instanceId: 'actual-listener', close: async () => { closes++; s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); servers.splice(servers.indexOf(s), 1); }, diagnostics: () => ({}) } as any;
  });
  const record = await runApiJourneys({ variant: 'clean', systemSnapshot: await createSystemSnapshot(SEEDED_TRADING_BRIEF), signal: c.signal, timeoutMs: 100 });
  expect(record.status).toBe(mode === 'abort' ? 'cancelled' : 'inconclusive'); expect(closes).toBe(mode === 'abort' ? 1 : 3);
  expect(record.journeys.map(j => j.exchanges.length)).toEqual(mode === 'abort' ? [1, 0, 0] : [1, 1, 1]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transport-evidence-'));
  try { await saveApiJourneyRun(record, dir); expect(await getApiJourneyRun(record.id, dir)).toEqual(record); } finally { await fs.rm(dir, { recursive: true }); }
  expect(compareApiJourneys(record, record).status).toBe('blocked');
  const html = targetApiResultHtml(record, null); if (mode !== 'deadline') expect(html).toContain('&lt;'); expect(html).not.toContain('<script>'); expect(html).toContain(mode === 'non-json' ? 'body complete' : 'body incomplete');
  const noHeaders = structuredClone(record); const e = noHeaders.journeys[0]!.exchanges[0]!;
  e.status = 0; Object.assign(e.transportFailure!, { kind: 'deadline', contentType: null, preview: '', receivedBytes: 0, capturedBytes: 0, complete: false });
  seal(noHeaders); expect(isValidApiJourneyRecord(noHeaders)).toBe(true); expect(targetApiResultHtml(noHeaders, null)).toContain('No HTTP response'); expect(targetApiResultHtml(noHeaders, null)).not.toContain('HTTP 0');
  const truncated = structuredClone(noHeaders); const t = truncated.journeys[0]!.exchanges[0]!; t.status = 200; Object.assign(t.transportFailure!, { receivedBytes: 65537, capturedBytes: 65536, preview: 'x'.repeat(65536), truncated: true });
  expect(targetApiResultHtml(truncated, null)).toContain('preview truncated');
  for (const value of [null, { ...e.transportFailure, capturedBytes: -1 }, { ...e.transportFailure, preview: 'invented' }]) {
    const bad = structuredClone(noHeaders); bad.journeys[0]!.exchanges[0]!.transportFailure = value as any; seal(bad); expect(isValidApiJourneyRecord(bad)).toBe(false);
  }
  await fs.mkdir('.llm-output/pr37-transport-fix', { recursive: true });
  if (mode === 'deadline') await fs.writeFile('.llm-output/pr37-transport-fix/actual-no-response-record.json', JSON.stringify(record, null, 2));
  if (mode === 'non-json') await fs.writeFile('.llm-output/pr37-transport-fix/actual-failing-record.json', JSON.stringify(record, null, 2));
});
it.each(['pass', 'fail'] as const)('rejects failure-tagged otherwise complete %s evidence', async status => {
  const r = await runApiJourneys({ variant: 'clean', systemSnapshot: await createSystemSnapshot(SEEDED_TRADING_BRIEF) });
  const j = r.journeys[0]!; j.status = status;
  j.exchanges[0]!.transportFailure = { kind: 'invalid-json', message: 'bad', contentType: 'application/json', preview: '', receivedBytes: 0, capturedBytes: 0, truncated: false, complete: true };
  expect(evaluateJourney(j, r.sourceHash, r.systemSnapshot).status).toBe('inconclusive'); seal(r); expect(isValidApiJourneyRecord(r)).toBe(false);
  j.exchanges[0]!.transportFailure = null as any; expect(evaluateJourney(j, r.sourceHash, r.systemSnapshot).status).toBe('inconclusive');
  delete j.exchanges[0]!.transportFailure; j.exchanges[0]!.status = 0; seal(r); expect(isValidApiJourneyRecord(r)).toBe(false);
});

it('bounds replacement text for invalid UTF-8 bytes', async () => {
  const { endpoint } = await serve((_, res) => { res.setHeader('Content-Type', 'text/plain'); res.end(Buffer.alloc(65536, 255)); });
  const e = await failure(endpoint); expect(Buffer.byteLength(e.transportFailure!.preview)).toBeLessThanOrEqual(65536);
  expect(e.transportFailure).toMatchObject({ capturedBytes: 65536, receivedBytes: 65536, complete: true, truncated: true });
});
