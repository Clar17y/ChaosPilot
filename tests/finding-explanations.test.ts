import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InvestigationRecord } from '../src/domain.ts';
import { buildRunEvidence, generateReport, validateNarration, buildExplanationPrompt, evidenceHashOf } from '../src/explanations/index.ts';
import { MetaProvider } from '../src/providers/meta.ts';
import { metaExplanationTransport } from '../src/explanations/meta-transport.ts';
import { BudgetLedger } from '../src/providers/budget.ts';
import { saveRun, getFindingReport, saveFindingReport, deleteRun, getRun } from '../src/storage.ts';
import { ChaosPilotServer } from '../src/server.ts';
import { FindingExplanationSession, reportStatusToUi } from '../src/web/finding-explanations.ts';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const dirs: string[] = [];
async function tmpDir(): Promise<string> { const d = await fs.mkdtemp(path.join(process.cwd(), '.tmp-explain-')); dirs.push(d); return d; }
afterEach(async () => { vi.restoreAllMocks(); instances.clear(); await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });

function record(id: string, overrides: Partial<InvestigationRecord> = {}): InvestigationRecord {
  const exp = (index: number, hypothesis: string) => ({
    index, replayVerified: true, cleanControlPassed: true,
    experiment: { hypothesis, expectedInvariant: `invariant-${index}`, steps: [{ op: 'send', id: `m${index}`, to: 'market' as const, payload: { x: '<script>alert(1)</script>' } }] },
    result: { schemaVersion: 1 as const, experiment: { hypothesis, expectedInvariant: `invariant-${index}`, steps: [] }, sourceHash: 's', trace: [{ step: 1, time: 1, action: 'send', outcome: 'accepted', state: {} }], snapshot: {}, violations: [], rejections: [], valid: false },
  });
  return {
    schemaVersion: 1, id, provider: 'mock', model: 'mock', mode: 'mock', variant: 'candidate-a', status: 'completed',
    startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', sourceHash: 'src-hash',
    experiments: [exp(10, 'Duplicate delivery breaks invariant'), exp(30, 'Second hypothesis')],
    findings: [
      { id: 'f-1', title: 'First <img src=x onerror=alert(1)>', hypothesis: 'Duplicate delivery breaks invariant', experimentIndex: 30, violation: { id: 'v1', invariant: 'invariant-30', message: 'Observed <script>bad</script> violation', step: 1 }, sourceHash: 'src-hash', reproduced: true, cleanControlPassed: true, replay: { hypothesis: 'h', expectedInvariant: 'i', steps: [] } },
      { id: 'f-2', title: 'Second', hypothesis: 'Second hypothesis', experimentIndex: 10, violation: { id: 'v2', invariant: 'invariant-10', message: 'Observed two', step: 1 }, sourceHash: 'src-hash', reproduced: false, cleanControlPassed: false, replay: { hypothesis: 'h', expectedInvariant: 'i', steps: [] } },
    ],
    usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, errors: [], contextAudit: { sourcePaths: [], contractHash: 'c', promptVersion: '1' }, ...overrides,
  };
}
type ApiResult = { status: number; text: string; json: Record<string, unknown>; headers: { get(n: string): string | null } };
const instances = new Map<string, ChaosPilotServer>();
async function start(dir: string, transport?: unknown): Promise<string> {
  const id = `srv-${instances.size + 1}`; instances.set(id, new ChaosPilotServer({ runsDir: dir, systemsDir: path.join(dir, 'systems'), ...(transport ? { explanationTransport: transport as never } : {}) }));
  return id;
}
async function req(base: string, p: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}, responseEvents?: EventEmitter): Promise<ApiResult> {
  const srv = instances.get(base)!; const server = srv.createHttpServer();
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const headersOut: Record<string, string> = {};
    const fakeRes: Record<string, unknown> = {
      statusCode: 200,
      once(event: string, listener: (...args: unknown[]) => void) { responseEvents?.once(event, listener); return this; },
      off(event: string, listener: (...args: unknown[]) => void) { responseEvents?.off(event, listener); return this; },
      writeHead(status: number, h: Record<string, string>) { (this as { statusCode: number }).statusCode = status; Object.assign(headersOut, Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))); return this; },
      end(body?: string | Buffer) { if (body) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body))); const text = Buffer.concat(chunks).toString('utf8'); let json: Record<string, unknown> = {}; try { json = JSON.parse(text); } catch { /* html */ } resolve({ status: (this as { statusCode: number }).statusCode, text, json, headers: { get: (n: string) => headersOut[n.toLowerCase()] ?? null } }); },
    };
    const fakeReq: Record<string, unknown> = {
      method: init.method ?? 'GET', url: p, headers: { host: '127.0.0.1:4310', ...(init.headers ?? {}) }, socket: { localPort: 4310 },
      on(event: string, cb: (...a: unknown[]) => void) { if (event === 'end') queueMicrotask(() => cb()); if (event === 'data' && init.body) queueMicrotask(() => cb(Buffer.from(init.body!))); return this; },
      resume() { return this; },
    };
    (server as unknown as { emit(e: string, ...a: unknown[]): void }).emit('request', fakeReq, fakeRes);
  });
}
const post = (base: string, p: string, body: unknown) => req(base, p, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4310' }, body: JSON.stringify(body) });

describe('evidence & narration', () => {
  it('resolves non-contiguous explicit indices, covers every finding, escapes HTML', async () => {
    const rec = record('run-evidence-1');
    const ev = buildRunEvidence(rec);
    expect(ev.findings.map(f => f.experimentPosition)).toEqual([1, 0]);
    const out = await generateReport(rec, { mode: 'offline', generatedAt: '2026-01-02T00:00:00.000Z' });
    expect(out.html).toContain('Offline scripted explanation — not Muse');
    expect(out.html).toContain('Finding 1'); expect(out.html).toContain('Finding 2');
    expect(out.html).not.toContain('<script>alert(1)</script>'); expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).not.toContain('<img src=x'); expect(out.html).toContain('Expected (recorded)');
    expect(out.html).toContain(ev.evidenceHash);
  });
  it('legacy fallback and ambiguous/unresolved notes are truthful', () => {
    const legacy = record('run-legacy-01'); legacy.experiments.forEach(e => { delete (e as { index?: number }).index; }); legacy.findings[0]!.experimentIndex = 2; legacy.findings[1]!.experimentIndex = 99;
    const ev = buildRunEvidence(legacy);
    expect(ev.findings[0]!.resolution).toBe('legacy'); expect(ev.findings[1]!.resolution).toBe('unresolved');
    expect(ev.findings[1]!.notes.join(' ')).toMatch(/could not be uniquely resolved/);
  });
  it('validates exact narration correspondence and rejects mismatches/truncation', async () => {
    const ev = buildRunEvidence(record('run-evidence-2'));
    const good = JSON.stringify({ findings: ev.findings.map(f => ({ findingId: f.findingId, headline: 'h', whyTested: 'w', whatHappened: 'x', interpretation: 'i' })) });
    expect(validateNarration(good, ev)).toHaveLength(2);
    expect(() => validateNarration(JSON.stringify({ findings: [{ findingId: 'wrong', headline: 'h', whyTested: 'w', whatHappened: 'x', interpretation: 'i' }] }), ev)).toThrow(/exactly|correspond/);
    await expect(generateReport(record('run-evidence-2'), { mode: 'meta', transport: { generate: async () => ({ content: '{"findings":[]}' }) } })).rejects.toThrow(/exactly/);
  });
  it('refuses oversize prompts instead of dropping findings', () => {
    const rec = record('run-evidence-3'); rec.findings[0]!.hypothesis = 'x'.repeat(5000);
    expect(() => buildExplanationPrompt(buildRunEvidence(rec), 500)).toThrow(/exceeds maximum/);
  });
});

describe('Meta transport ledger accounting', () => {
  it('missing key sends nothing and reserves nothing; fake success commits; invalid usage retains worst case', async () => {
    const dir = await tmpDir(); const ledgerPath = path.join(dir, 'ledger.json');
    const missing = new MetaProvider({ apiKey: '', ledgerPath });
    await expect(missing.completeText('s', 'u')).rejects.toThrow(/Missing MODEL_API_KEY/);
    expect(new BudgetLedger(ledgerPath).getStatus().reservedUsd).toBe(0);
    const okFetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"findings":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const ok = new MetaProvider({ apiKey: 'k-secret', ledgerPath, fetchFn: okFetch as typeof fetch });
    const res = await ok.completeText('s', 'u'); expect(res.content).toContain('findings');
    const st = new BudgetLedger(ledgerPath).getStatus(); expect(st.reservedUsd).toBe(0); expect(st.spentUsd).toBeGreaterThan(0);
    const badFetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }], usage: {} }), { status: 200 });
    const bad = new MetaProvider({ apiKey: 'k-secret', ledgerPath, fetchFn: badFetch as typeof fetch });
    await expect(bad.completeText('s', 'u')).rejects.toThrow(/usage/);
    expect(new BudgetLedger(ledgerPath).getStatus().spentUsd).toBeGreaterThan(st.spentUsd);
  });
});

describe('report API & persistence', () => {
  it('generates offline, persists, serves with CSP, stale/deleted never served as current', async () => {
    const dir = await tmpDir(); const rec = record('run-report-01'); await saveRun(rec, dir);
    const base = await start(dir);
    const created = await post(base, '/api/runs/run-report-01/explanation-report', { mode: 'offline' });
    expect(created.status).toBe(201); expect(created.json.mode).toBe('offline');
    const status = await req(base, '/api/runs/run-report-01/explanation-report/status'); expect(status.json.exists).toBe(true); expect(status.json.stale).toBe(false);
    const got = await req(base, '/api/runs/run-report-01/explanation-report');
    expect(got.status).toBe(200); expect(got.headers.get('content-security-policy')).toContain("script-src 'none'"); expect(got.text).toContain('Finding 1'); expect(got.text).not.toContain('<script>bad</script>');
    // Change evidence -> stale blocked
    rec.findings[0]!.title = 'Changed'; await saveRun(rec, dir);
    const stale = await req(base, '/api/runs/run-report-01/explanation-report'); expect(stale.status).toBe(409);
    // Delete source -> 404, report removed
    const del = await req(base, '/api/runs/run-report-01', { method: 'DELETE', headers: { origin: 'http://127.0.0.1:4310' } }); expect(del.status).toBe(200);
    expect((await req(base, '/api/runs/run-report-01/explanation-report')).status).toBe(404);
    expect(await getFindingReport('run-report-01', dir)).toBeNull();
  });
  it('refuses running/no-finding/missing, meta via fake transport, failure preserves old report, concurrent generate rejected', async () => {
    const dir = await tmpDir();
    await saveRun(record('run-report-02', { status: 'running' }), dir);
    await saveRun(record('run-report-03', { findings: [] }), dir);
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const transport = { generate: async (_s: string, _u: string) => { await gate; const ev = buildRunEvidence(record('run-report-04')); return { content: JSON.stringify({ findings: ev.findings.map(f => ({ findingId: f.findingId, headline: '<b>h</b>', whyTested: 'w', whatHappened: 'x', interpretation: 'i' })) }), usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.01 }, model: 'fake-meta' }; } };
    await saveRun(record('run-report-04'), dir);
    const base = await start(dir, transport);
    expect((await post(base, '/api/runs/run-report-02/explanation-report', { mode: 'offline' })).status).toBe(409);
    expect((await post(base, '/api/runs/run-report-03/explanation-report', { mode: 'offline' })).status).toBe(400);
    expect((await post(base, '/api/runs/run-missing-99/explanation-report', { mode: 'offline' })).status).toBe(404);
    const first = post(base, '/api/runs/run-report-04/explanation-report', { mode: 'meta' });
    await new Promise(r => setTimeout(r, 30));
    expect((await post(base, '/api/runs/run-report-04/explanation-report', { mode: 'offline' })).status).toBe(409);
    release(); const done = await first; expect(done.status).toBe(201);
    const html1 = (await req(base, '/api/runs/run-report-04/explanation-report')).text; expect(html1).toContain('&lt;b&gt;h&lt;/b&gt;');
    const saved = await getFindingReport('run-report-04', dir); expect(saved?.meta.model).toBe('fake-meta');
    // Path traversal-ish id rejected
    expect((await req(base, '/api/runs/..%2Fledger/explanation-report/status')).status).not.toBe(200);
  });
  it('direct storage save/get round-trips', async () => {
    const dir = await tmpDir();
    const rec = record('run-store-01'); await saveRun(rec, dir);
    await saveFindingReport('run-store-01', '<html>x</html>', { runId: 'run-store-01', evidenceHash: evidenceHashOf(rec), generatedAt: 't', mode: 'offline', model: 'offline-scripted', findingIds: ['f-1'] }, dir);
    expect((await getFindingReport('run-store-01', dir))?.html).toContain('x');
  });
});

describe('UI session', () => {
  it('late settle for a switched run is ignored; status mapping covers stale/running/no-findings', () => {
    const s = new FindingExplanationSession(); const t1 = s.begin('run-a', 'generating'); s.resetForRun('run-b');
    expect(s.settle(t1, 'run-a', { kind: 'saved', generatedAt: 't', mode: 'offline', model: 'x' })).toBe(false);
    expect(reportStatusToUi({ terminal: false, findingsCount: 1 }).kind).toBe('unavailable');
    expect(reportStatusToUi({ findingsCount: 0 }).kind).toBe('unavailable');
    expect(reportStatusToUi({ exists: true, stale: true, findingsCount: 1 }).kind).toBe('stale');
    expect(reportStatusToUi({ exists: true, findingsCount: 1, generatedAt: 't', mode: 'offline', model: 'm' }).kind).toBe('saved');
  });
});


function narrationFor(rec: InvestigationRecord, text = 'Plain explanation'): string {
  return JSON.stringify({ findings: buildRunEvidence(rec).findings.map(f => ({ findingId: f.findingId, headline: text, whyTested: text, whatHappened: text, interpretation: text })) });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe('complete evidence boundaries', () => {
  it('does not trim long fields or drop late steps/traces; binds changes outside the visible finding', async () => {
    const rec = record('run-full-evidence');
    rec.findings[0]!.hypothesis = 'x'.repeat(5000) + 'END-HYPOTHESIS';
    rec.experiments[1]!.experiment.steps = Array.from({ length: 60 }, (_, i) => ({ op: 'tick', ms: i }));
    rec.experiments[1]!.result.trace = Array.from({ length: 60 }, (_, i) => ({ step: i, time: i, action: `EVENT-${i}`, outcome: 'observed', state: {} }));
    const ev = buildRunEvidence(rec);
    const prompt = buildExplanationPrompt(ev);
    expect(prompt.userMessage).toContain('END-HYPOTHESIS'); expect(prompt.userMessage).toContain('EVENT-59');
    const html = (await generateReport(rec, { mode: 'offline' })).html;
    expect(html).toContain('EVENT-59'); expect(html).toContain('&quot;ms&quot;: 59');
    rec.contextAudit.contractHash = 'replaced';
    expect(evidenceHashOf(rec)).not.toBe(ev.evidenceHash);
  });
  it('does not choose an ambiguous or mixed index and keeps missing replay distinct from finding reproduction', async () => {
    const rec = record('run-ambiguous'); rec.experiments[1]!.index = 10; rec.findings[0]!.experimentIndex = 10;
    let ev = buildRunEvidence(rec); expect(ev.findings[0]!.experimentPosition).toBe(-1); expect(ev.findings[0]!.steps).toEqual([]);
    expect(ev.findings[0]!.replayVerified).toBeNull(); expect(ev.findings[0]!.reproduced).toBe(true);
    delete (rec.experiments[0] as { index?: number }).index;
    rec.findings[0]!.experimentIndex = 1;
    ev = buildRunEvidence(rec); expect(ev.findings[0]!.resolution).toBe('unresolved');
    rec.experiments = []; rec.findings[0]!.violation.invariant = ''; rec.findings[0]!.hypothesis = '';
    const html = (await generateReport(rec, { mode: 'offline' })).html;
    expect(html).toContain('No expected invariant was recorded'); expect(html).toContain('unknown / not recorded');
    expect(html).toContain('No recorded trace is available');
    const incomplete = record('run-incomplete'); incomplete.experiments[1]!.result.executionComplete = false;
    expect((await generateReport(incomplete, { mode: 'offline' })).html).toContain('Recorded execution is incomplete');
  });
  it.each(['failed', 'cancelled'] as const)('labels %s partial evidence without fabricating execution', async status => {
    const rec = record(`run-${status}`, { status, stopReason: 'Interrupted', experiments: [] });
    const out = await generateReport(rec, { mode: 'offline' });
    expect(out.html).toContain(`This run is ${status}`); expect(out.html).toContain('Interrupted'); expect(out.html).not.toContain('sequence ran');
  });
  it('keeps duplicate finding identifiers in recorded order and validates bad entries', async () => {
    const rec = record('run-duplicate-finding'); rec.findings[1]!.id = rec.findings[0]!.id;
    const ev = buildRunEvidence(rec);
    for (const value of ['{"findings":[null,null]}', '{', 'x'.repeat(524289)]) expect(() => validateNarration(value, ev)).toThrow();
    const html = (await generateReport(rec, { mode: 'offline' })).html;
    expect(html).toContain('First &lt;img'); expect(html).toContain('Second');
  });
});

describe('conservative shared Meta synthesis transport', () => {
  it('serializes synthesis requests identically to investigation requests with the same messages', async () => {
    const dir = await tmpDir(); let sentBody = '';
    const provider = new MetaProvider({ apiKey: 'test-key', ledgerPath: path.join(dir, 'budget.json'), fetchFn: async (_url, init) => {
      sentBody = String(init?.body);
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    } });
    const prepared = provider.prepareRequest({
      contract: { name: 'Example', description: 'test-key is redacted', operations: [], messages: [], invariants: [], limits: {} },
      source: { hash: 'source', files: [] }, history: [], experimentNumber: 1, maxExperiments: 1,
    });
    await provider.completeText(prepared.systemMessage, prepared.userMessage);
    expect(sentBody).toBe(prepared.serializedPayload);
    expect(sentBody).not.toContain('test-key');
  });
  it('rejects oversize before reservation and pre-abort before sending', async () => {
    const dir = await tmpDir(); const ledgerPath = path.join(dir, 'budget.json'); let sent = 0;
    const p = new MetaProvider({ apiKey: 'test-only', ledgerPath, maxPromptBytes: 50, fetchFn: async () => { sent++; throw new Error('must not send'); } });
    await expect(p.completeText('s', 'u'.repeat(100))).rejects.toMatchObject({ requestSent: false });
    const controller = new AbortController(); controller.abort();
    await expect(p.completeText('s', 'u', controller.signal)).rejects.toMatchObject({ requestSent: false });
    expect(sent).toBe(0); expect(new BudgetLedger(ledgerPath).getStatus().spentUsd).toBe(0); expect(new BudgetLedger(ledgerPath).getStatus().reservedUsd).toBe(0);
  });
  it.each(['network', 'timeout', 'http', 'invalid-json', 'invalid-usage', 'over-output'] as const)('retains worst case for %s after sending', async failure => {
    const dir = await tmpDir(); const ledgerPath = path.join(dir, 'budget.json');
    const p = new MetaProvider({ apiKey: 'test-only', ledgerPath, requestTimeoutMs: 15, maxOutputTokens: 100,
      fetchFn: async (_url, init) => {
        if (failure === 'network') throw new Error('Network failed');
        if (failure === 'timeout') return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
        if (failure === 'http') return new Response('', { status: 500 });
        if (failure === 'invalid-json') return new Response('{');
        return new Response(JSON.stringify({ choices: [], usage: failure === 'invalid-usage' ? {} : { prompt_tokens: 1, completion_tokens: 101 } }));
      } });
    await expect(p.completeText('s', 'u')).rejects.toMatchObject({ requestSent: true });
    const state = new BudgetLedger(ledgerPath).getStatus();
    expect(state.reservedUsd).toBe(0); expect(state.spentUsd).toBeGreaterThan(0);
  });
  it.each(['length', 'content_filter', 'stop'] as const)('commits known usage but rejects unusable %s completion', async reason => {
    const dir = await tmpDir(); const ledgerPath = path.join(dir, 'budget.json');
    const p = new MetaProvider({ apiKey: 'test-only', ledgerPath, fetchFn: async () => new Response(JSON.stringify({ choices: [{ finish_reason: reason, message: { content: reason === 'stop' ? '' : '{}' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } })) });
    await expect(p.completeText('s', 'u')).rejects.toMatchObject({ requestSent: true, usageKnown: true });
    expect(new BudgetLedger(ledgerPath).getStatus()).toMatchObject({ reservedUsd: 0, spentUsd: 0.00006 });
  });
  it('forwards cancellation, rejects late results and does not expose a credential in errors', async () => {
    const dir = await tmpDir(); const controller = new AbortController();
    const p = new MetaProvider({ apiKey: 'SECRET-TEST-ONLY', ledgerPath: path.join(dir, 'budget.json'), fetchFn: async () => { controller.abort(); return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); } });
    await expect(p.completeText('s', 'u', controller.signal)).rejects.toMatchObject({ name: 'AbortError', usageKnown: true });
    const unsafe = new MetaProvider({ apiKey: 'SECRET-TEST-ONLY', ledgerPath: path.join(dir, 'budget.json'), fetchFn: async () => { throw new Error('SECRET-TEST-ONLY transport error'); } });
    await expect(unsafe.completeText('s', 'u')).rejects.toThrow('[REDACTED_API_KEY] transport error');
  });
});

describe('report transaction boundaries', () => {
  it.each(['replace', 'delete'] as const)('rejects %s while pending without publishing an orphan', async mutation => {
    const dir = await tmpDir(); const rec = record(`run-pending-${mutation}`); await saveRun(rec, dir);
    const entered = deferred(); const release = deferred();
    const base = await start(dir, { generate: async () => { entered.resolve(); await release.promise; return { content: narrationFor(rec) }; } });
    const pending = post(base, `/api/runs/${rec.id}/explanation-report`, { mode: 'meta' }); await entered.promise;
    if (mutation === 'delete') await deleteRun(rec.id, dir);
    else { rec.experiments[0]!.result.trace.push({ step: 99, action: 'changed', time: 99, outcome: 'new', state: {} }); await saveRun(rec, dir); }
    release.resolve(); expect((await pending).status).toBe(409); expect(await getFindingReport(rec.id, dir)).toBeNull();
  });
  it('preserves an old report after invalid or oversize synthesis and enables retrieval after a reload', async () => {
    const dir = await tmpDir(); const rec = record('run-failure'); await saveRun(rec, dir);
    let response = '{"findings":[]}';
    const base = await start(dir, { generate: async () => ({ content: response }) });
    expect((await post(base, `/api/runs/${rec.id}/explanation-report`, { mode: 'offline' })).status).toBe(201);
    const old = await getFindingReport(rec.id, dir);
    expect((await post(base, `/api/runs/${rec.id}/explanation-report`, { mode: 'meta' })).status).toBe(422);
    expect(await getFindingReport(rec.id, dir)).toEqual(old);
    response = 'x'.repeat(524289);
    expect((await post(base, `/api/runs/${rec.id}/explanation-report`, { mode: 'meta' })).status).toBe(413);
    expect(await getFindingReport(rec.id, dir)).toEqual(old);
    const reload = await start(dir, { generate: async () => { throw new Error('Retrieval must not call model'); } });
    const download = await req(reload, `/api/runs/${rec.id}/explanation-report?download=1`);
    expect(download.status).toBe(200); expect(download.headers.get('content-disposition')).toContain('attachment; filename="chaospilot-findings-run-failure.html"');
    expect(download.text).toContain('Content-Security-Policy'); expect(download.text).not.toMatch(/<script|<img|<iframe|<link/);
  });
  it('claims concurrent requests across two server instances before a second model call', async () => {
    const dir = await tmpDir(); const rec = record('run-shared-lease'); await saveRun(rec, dir);
    const entered = deferred(); const release = deferred(); let calls = 0;
    const transport = { generate: async () => { calls++; entered.resolve(); await release.promise; return { content: narrationFor(rec) }; } };
    const a = await start(dir, transport); const b = await start(dir, transport);
    const first = post(a, `/api/runs/${rec.id}/explanation-report`, { mode: 'meta' }); await entered.promise;
    expect((await post(b, `/api/runs/${rec.id}/explanation-report`, { mode: 'meta' })).status).toBe(409);
    expect((await req(a, `/api/runs/${rec.id}`, { method: 'DELETE' })).status).toBe(409);
    release.resolve(); expect((await first).status).toBe(201); expect(calls).toBe(1);
  });
  it('refuses publication when source disappeared and preserves the previous artifact on a storage lock failure', async () => {
    const dir = await tmpDir(); const rec = record('run-write-failure'); await saveRun(rec, dir);
    const out = await generateReport(rec, { mode: 'offline' });
    const meta = { runId: rec.id, evidenceHash: out.evidence.evidenceHash, generatedAt: 't', mode: 'offline' as const, model: out.model, findingIds: rec.findings.map(f => f.id) };
    await saveFindingReport(rec.id, out.html, meta, dir);
    const old = await getFindingReport(rec.id, dir);
    // Force temp creation failure without touching the existing artifact.
    await fs.mkdir(path.join(dir, `.${rec.id}.mutation.lock`));
    await expect(saveFindingReport(rec.id, 'replacement', meta, dir)).rejects.toThrow(/busy/);
    expect(await getFindingReport(rec.id, dir)).toEqual(old);
    await fs.rmdir(path.join(dir, `.${rec.id}.mutation.lock`));
    await deleteRun(rec.id, dir);
    await expect(saveFindingReport(rec.id, out.html, meta, dir)).rejects.toThrow(/deleted/);
    expect(await getFindingReport(rec.id, dir)).toBeNull();
  });
  it('leaves the previous report byte-for-byte intact when atomic rename fails', async () => {
    const dir = await tmpDir(); const rec = record('run-rename-failure'); await saveRun(rec, dir);
    const base = await start(dir);
    expect((await post(base, `/api/runs/${rec.id}/explanation-report`, { mode: 'offline' })).status).toBe(201);
    const old = await fs.readFile(path.join(dir, 'reports', `${rec.id}.html`), 'utf8');
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error('Simulated report disk failure'));
    const failed = await post(base, `/api/runs/${rec.id}/explanation-report`, { mode: 'offline' });
    expect(failed.status).toBe(422); expect(failed.json.error).toContain('disk failure');
    expect(await fs.readFile(path.join(dir, 'reports', `${rec.id}.html`), 'utf8')).toBe(old);
    expect((await fs.readdir(path.join(dir, 'reports'))).filter(n => n.includes('.tmp-'))).toEqual([]);
    expect((await req(base, `/api/runs/${rec.id}/explanation-report`)).status).toBe(200);
  });
  it('does not replace a report when cancellation occurs while waiting for the publication lock', async () => {
    const dir = await tmpDir(); const rec = record('run-cancel-publishing'); await saveRun(rec, dir);
    const generated = await generateReport(rec, { mode: 'offline' });
    const meta = { runId: rec.id, evidenceHash: generated.evidence.evidenceHash, generatedAt: 't', mode: 'offline' as const, model: generated.model, findingIds: rec.findings.map(f => f.id) };
    await saveFindingReport(rec.id, generated.html, meta, dir);
    const old = await fs.readFile(path.join(dir, 'reports', `${rec.id}.html`), 'utf8');
    const lock = path.join(dir, `.${rec.id}.mutation.lock`);
    await fs.mkdir(lock);
    const controller = new AbortController();
    const pending = saveFindingReport(rec.id, 'replacement', meta, dir, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 40));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await fs.rmdir(lock);
    expect(await fs.readFile(path.join(dir, 'reports', `${rec.id}.html`), 'utf8')).toBe(old);
    expect((await fs.readdir(path.join(dir, 'reports'))).filter(n => n.includes('.tmp-'))).toEqual([]);
  });
  it('forwards a disconnected request to a report waiting for publication', async () => {
    const dir = await tmpDir(); const rec = record('run-disconnect-publishing'); await saveRun(rec, dir);
    const base = await start(dir);
    expect((await post(base, `/api/runs/${rec.id}/explanation-report`, { mode: 'offline' })).status).toBe(201);
    const old = await fs.readFile(path.join(dir, 'reports', `${rec.id}.html`), 'utf8');
    const lock = path.join(dir, `.${rec.id}.mutation.lock`);
    await fs.mkdir(lock);
    const events = new EventEmitter();
    const pending = req(base, `/api/runs/${rec.id}/explanation-report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mode":"offline"}' }, events);
    await vi.waitFor(async () => { await fs.access(path.join(dir, 'reports', `${rec.id}.html.generation.lock`)); });
    await new Promise(resolve => setTimeout(resolve, 50));
    events.emit('close');
    await fs.rmdir(lock);
    expect((await pending).status).not.toBe(201);
    expect(await fs.readFile(path.join(dir, 'reports', `${rec.id}.html`), 'utf8')).toBe(old);
    expect((await fs.readdir(path.join(dir, 'reports'))).filter(n => n.endsWith('.generation.lock'))).toEqual([]);
  });
  it('claims simultaneous same-server requests after both have read their bodies', async () => {
    const dir = await tmpDir(); const rec = record('run-body-race'); await saveRun(rec, dir);
    const entered = deferred(); const release = deferred(); let calls = 0;
    const base = await start(dir, { generate: async () => { calls++; entered.resolve(); await release.promise; return { content: narrationFor(rec) }; } });
    const first = post(base, `/api/runs/${rec.id}/explanation-report`, { mode: 'meta' });
    const second = post(base, `/api/runs/${rec.id}/explanation-report`, { mode: 'meta' });
    expect((await Promise.race([first, second])).status).toBe(409);
    await entered.promise; release.resolve();
    expect((await Promise.all([first, second])).map(r => r.status).sort()).toEqual([201, 409]); expect(calls).toBe(1);
  });
  it('cancels synthesis on response disconnect without publishing or leaving a generation lease', async () => {
    const dir = await tmpDir(); const rec = record('run-disconnected'); await saveRun(rec, dir);
    const entered = deferred(); const events = new EventEmitter(); let aborted = false;
    const base = await start(dir, { generate: async (_system: string, _user: string, signal: AbortSignal) => {
      entered.resolve();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
    } });
    const pending = req(base, `/api/runs/${rec.id}/explanation-report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mode":"meta"}' }, events);
    await entered.promise; events.emit('close'); await pending;
    expect(aborted).toBe(true); expect(await getFindingReport(rec.id, dir)).toBeNull();
    expect((await fs.readdir(path.join(dir, 'reports'))).filter(n => n.endsWith('.generation.lock'))).toEqual([]);
  });
  it('refuses cross-origin writes before transport and rejects traversal', async () => {
    const dir = await tmpDir(); const rec = record('run-origin'); await saveRun(rec, dir); let calls = 0;
    const base = await start(dir, { generate: async () => { calls++; throw new Error('no'); } });
    expect((await req(base, `/api/runs/${rec.id}/explanation-report`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"mode":"meta"}' })).status).toBe(403);
    expect((await req(base, '/api/runs/..%2Fbad/explanation-report')).status).not.toBe(200); expect(calls).toBe(0);
    await expect(saveFindingReport('../bad', '', { runId: '../bad' } as never, dir)).rejects.toThrow(/identity/);
  });
});

describe('mock workflow acceptance', () => {
  it('runs the mock inventory workflow, persists and reloads an offline HTML report for every finding', async () => {
    const dir = await tmpDir(); const base = await start(dir);
    const begun = await post(base, '/api/investigation/start', { systemId: 'inventory-reservation', variant: 'inventory-candidate-d', provider: 'mock', expectedRevision: 1, continueAfterFindings: true });
    expect(begun.status).toBe(202); const id = String(begun.json.id);
    await vi.waitFor(async () => { expect(instances.get(base)!.getActiveInvestigation()).toBeNull(); expect(await getRun(id, dir)).not.toBeNull(); }, { timeout: 15000 });
    const rec = (await getRun(id, dir))!; expect(rec.findings.length).toBe(2);
    expect(rec.proposalAttempts?.every(a => a.requestSent === false)).toBe(true);
    expect((await post(base, `/api/runs/${id}/explanation-report`, { mode: 'offline' })).status).toBe(201);
    const reloaded = await start(dir); const got = await req(reloaded, `/api/runs/${id}/explanation-report`);
    expect(got.status).toBe(200); expect((got.text.match(/<article class="finding"/g) ?? []).length).toBe(rec.findings.length);
    for (const value of ['What was tested and why', 'Recorded action sequence', 'Recorded execution trace', 'Expected (recorded)', 'Observed violation (recorded)', 'Report provenance', 'Offline scripted explanation', '@media print', 'id="finding-2"']) expect(got.text).toContain(value);
    // The readable comparison comes from the oracle's actual expected/actual
    // evidence, not from a guess based on the finding title.
    expect(got.text).toContain('Independent reference transitions match target state');
    expect(got.text).toContain('<th scope="row">Reservation r1: remaining</th><td>0</td><td>5</td>');
    expect(got.text).toContain('<th scope="row">Delivery outcome</th><td>duplicate</td><td>accepted</td>');
    expect(got.text).toContain('Stock receipt for SKU item: quantity 10');
    expect(got.text).toContain(evidenceHashOf(rec));
    expect(await fs.readFile(path.join(dir, 'reports', `${id}.html`), 'utf8')).toContain(got.text);
  });
  it('uses the same Meta transport for structured synthesis with a fake response', async () => {
    const dir = await tmpDir(); const rec = record('run-fake-transport'); let calls = 0;
    const transport = metaExplanationTransport(new MetaProvider({ apiKey: 'test-only-key', ledgerPath: path.join(dir, 'ledger.json'), fetchFn: async (_url, init) => {
      calls++; const body = JSON.parse(String(init?.body)); expect(body.messages[0].content).toContain('UNTRUSTED'); expect(body.messages[1].content).toContain('f-2');
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: narrationFor(rec, '</style><script>alert(1)</script>') } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    } }));
    const generated = await generateReport(rec, { mode: 'meta', transport });
    expect(calls).toBe(1); expect(generated.html).toContain('&lt;/style&gt;&lt;script&gt;'); expect(generated.html).not.toContain('<script>');
    expect(generated.html).toContain('Narration is labelled interpretation');
  });
});


describe('UI evidence transitions', () => {
  it('refreshes a terminal version of the same live run and rejects the prior loading result', () => {
    const session = new FindingExplanationSession();
    const running = record('run-ui', { status: 'running' });
    expect(session.syncToEvidence(running)).toBe(true);
    const old = session.begin(running.id, 'loading');
    expect(session.syncToEvidence(structuredClone(running))).toBe(false);
    expect(session.syncToEvidence({ ...running, status: 'completed' })).toBe(true);
    expect(session.settle(old, running.id, { kind: 'saved', generatedAt: 't', model: 'x', mode: 'offline' })).toBe(false);
    expect(session.state.kind).toBe('idle');
  });
  it('switches system identities without accepting a pending result and supports refresh after error', () => {
    const session = new FindingExplanationSession(); session.syncToEvidence(record('run-ui-a'));
    const old = session.begin('run-ui-a', 'generating'); session.syncToEvidence(record('run-ui-b'));
    expect(session.settle(old, 'run-ui-a', { kind: 'error', message: 'late' })).toBe(false);
    const current = session.begin('run-ui-b', 'loading');
    expect(session.settle(current, 'run-ui-b', reportStatusToUi(null))).toBe(true); expect(session.state.kind).toBe('unavailable');
    const retry = session.begin('run-ui-b', 'loading');
    expect(session.settle(retry, 'run-ui-b', reportStatusToUi({ exists: true, terminal: true, findingsCount: 2, mode: 'offline' }))).toBe(true);
    expect(session.state.kind).toBe('saved');
    session.syncToEvidence(null); expect(session.runId).toBeNull();
  });
});
