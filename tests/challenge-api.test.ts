import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { ChaosPilotServer } from '../src/server.ts';
import { saveRun, deleteRun } from '../src/storage.ts';
import { readChallenges } from '../src/challenges/storage.ts';
import { metaExplanationTransport } from '../src/explanations/meta-transport.ts';
import { MetaProvider } from '../src/providers/meta.ts';
import { BudgetLedger } from '../src/providers/budget.ts';
import { api, challengeFixture, deferred, fakeTransport, proposalFor, tempChallengeDir, usage } from './challenge-fixtures.ts';

const dirs: string[] = [];
async function setup(inventory = false) {
  const dir = await tempChallengeDir(); dirs.push(dir); const record = await challengeFixture(inventory); await saveRun(record, dir);
  const url = `/api/runs/${record.id}/challenges`; const findingId = record.findings[0]!.id;
  return { dir, record, url, findingId, getUrl: `${url}?findingId=${encodeURIComponent(findingId)}` };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });
const body = (findingId: string, view: { evidenceHash: string; runRevision: string }, interpret = true) => ({ mode: 'meta', findingId, expectedEvidenceHash: view.evidenceHash, expectedRunRevision: view.runRevision, interpret });

describe('challenge HTTP boundaries and cross-instance ownership', () => {
  it.each([false, true])('creates and retrieves a challenge through real server handlers inventory=%s', async inventory => {
    const { dir, record, url, findingId, getUrl } = await setup(inventory);
    const fake = fakeTransport(record); const server = new ChaosPilotServer({ runsDir: dir, challengeTransport: fake.transport });
    const view = await api(server, 'GET', getUrl); expect(view.status).toBe(200); expect(view.json.available).toBe(true);
    const made = await api(server, 'POST', url, body(findingId, view.json)); expect(made.status).toBe(201);
    const otherInstance = new ChaosPilotServer({ runsDir: dir });
    const retrieved = await api(otherInstance, 'GET', getUrl); expect(retrieved.json.current).toEqual(made.json); expect(fake.calls).toHaveLength(2);
    await saveRun(record, dir); const stale = await api(otherInstance, 'GET', getUrl);
    expect(stale.json.stale).toBe(true); expect(stale.json.current).toBeNull();
    await deleteRun(record.id, dir); expect((await api(otherInstance, 'GET', getUrl)).status).toBe(404);
  });

  it('rejects missing consent, unknown fields, stale identity, non-JSON and cross-origin calls without paying', async () => {
    const { dir, record, url, findingId, getUrl } = await setup(); const fake = fakeTransport(record);
    const server = new ChaosPilotServer({ runsDir: dir, challengeTransport: fake.transport });
    const view = (await api(server, 'GET', getUrl)).json;
    expect((await api(server, 'POST', url, { findingId })).status).toBe(400);
    expect((await api(server, 'POST', url, { ...body(findingId, view), shell: 'ignored?' })).status).toBe(400);
    expect((await api(server, 'POST', url, body(findingId, view), undefined, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await api(server, 'POST', url, body(findingId, view), undefined, { origin: 'https://example.com' })).status).toBe(403);
    expect((await api(server, 'GET', url)).status).toBe(400);
    await saveRun(record, dir); expect((await api(server, 'POST', url, body(findingId, view))).status).toBe(409);
    expect(fake.calls).toHaveLength(0);
  });

  it('one and two server instances share a finding generation lease, preventing duplicate requests', async () => {
    const { dir, record, url, findingId, getUrl } = await setup(); const entered = deferred(); const release = deferred(); let calls = 0;
    const transport = { generate: async () => { calls++; entered.resolve(); await release.promise; return { content: proposalFor(record), usage }; } };
    const one = new ChaosPilotServer({ runsDir: dir, challengeTransport: transport }); const two = new ChaosPilotServer({ runsDir: dir, challengeTransport: transport });
    const view = (await api(one, 'GET', getUrl)).json; const payload = body(findingId, view, false);
    const pending = api(one, 'POST', url, payload); await entered.promise;
    expect((await api(one, 'POST', url, payload)).status).toBe(409);
    expect((await api(two, 'POST', url, payload)).status).toBe(409);
    expect((await api(two, 'GET', getUrl)).json.inFlight).toBe(true); expect(calls).toBe(1);
    release.resolve(); expect((await pending).status).toBe(201); expect(calls).toBe(1);
    expect((await api(two, 'GET', getUrl)).json.inFlight).toBe(false);
  });

  it('HTTP disconnect during interpretation saves completed traces and unknown usage', async () => {
    const { dir, record, url, findingId, getUrl } = await setup(); const entered = deferred(); const release = deferred(); let calls = 0;
    const transport = { generate: async () => {
      calls++; if (calls === 2) { entered.resolve(); await release.promise; throw Object.assign(new Error('remote abort'), { requestSent: true }); }
      return { content: proposalFor(record), usage };
    } };
    const server = new ChaosPilotServer({ runsDir: dir, challengeTransport: transport }); const close = new EventEmitter();
    const view = (await api(server, 'GET', getUrl)).json;
    const pending = api(server, 'POST', url, body(findingId, view), close);
    await entered.promise; close.emit('close'); release.resolve();
    expect((await pending).status).toBe(409); expect(calls).toBe(2);
    const saved = await readChallenges(record.id, findingId, dir);
    expect(saved.current?.status).toBe('cancelled'); expect(saved.current?.variants[0]?.candidate?.trace.length).toBeGreaterThan(0);
    expect(saved.current?.requests[1]).toMatchObject({ usageKnown: false, usage: null });
  });

  it.each(['delete', 'rewrite'])('cross-instance %s during interpretation cannot publish a new artifact', async kind => {
    const { dir, record, url, findingId, getUrl } = await setup(); const entered = deferred(); const release = deferred(); let calls = 0;
    const one = new ChaosPilotServer({ runsDir: dir, challengeTransport: { generate: async () => {
      if (++calls === 2) { entered.resolve(); await release.promise; return { content: '{"interpretation":"unpublished"}', usage }; }
      return { content: proposalFor(record), usage };
    } } });
    const two = new ChaosPilotServer({ runsDir: dir }); const view = (await api(one, 'GET', getUrl)).json;
    const pending = api(one, 'POST', url, body(findingId, view)); await entered.promise;
    if (kind === 'delete') expect((await api(two, 'DELETE', `/api/runs/${record.id}`)).status).toBe(200);
    else { record.findings[0]!.title += ' updated'; await saveRun(record, dir); }
    release.resolve(); expect((await pending).status).toBe(409);
    const got = await api(two, 'GET', getUrl);
    if (kind === 'delete') expect(got.status).toBe(404);
    else { expect(got.json.current).toBeNull(); expect(got.json.stale).toBe(true); }
  });
});

describe('shared Meta request budget and timeout boundary with fake fetch only', () => {
  it('two challenge calls use shared Meta accounting and configured model, with no live traffic', async () => {
    const { dir, record, url, findingId, getUrl } = await setup(true); const ledgerPath = path.join(dir, '.ledger-test.json'); let calls = 0;
    const provider = new MetaProvider({ apiKey: 'fake-key', ledgerPath, model: 'muse-wonder-1.0', fetchFn: async (_url, init) => {
      const payload = JSON.parse(String(init?.body)); expect(payload.model).toBe('muse-wonder-1.0'); expect(payload.tools).toBeUndefined(); calls++;
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: calls === 1 ? proposalFor(record) : '{"interpretation":"Observed only"}' } }], usage: { prompt_tokens: 30, completion_tokens: 20 } }), { status: 200 });
    } });
    const server = new ChaosPilotServer({ runsDir: dir, challengeTransport: metaExplanationTransport(provider) }); const view = (await api(server, 'GET', getUrl)).json;
    const result = await api(server, 'POST', url, body(findingId, view)); expect(result.status).toBe(201); expect(calls).toBe(2);
    const budget = new BudgetLedger(ledgerPath).getStatus(); expect(budget.reservedUsd).toBe(0); expect(budget.spentUsd).toBeGreaterThan(0);
    expect(result.json.requests.every((r: any) => r.model === provider.model && r.usageKnown)).toBe(true);
  });

  it('prompt limit refuses without fetch; body deadline retains unknown worst-case charge and no experiment', async () => {
    const { dir, record, url, findingId, getUrl } = await setup(); let calls = 0;
    const small = new MetaProvider({ apiKey: 'fake', maxPromptBytes: 10, ledgerPath: path.join(dir, '.small-ledger.json'), fetchFn: async () => { calls++; throw new Error('must not fetch'); } });
    const server = new ChaosPilotServer({ runsDir: dir, challengeTransport: metaExplanationTransport(small) }); const view = (await api(server, 'GET', getUrl)).json;
    const rejected = await api(server, 'POST', url, body(findingId, view)); expect(rejected.status).toBe(422); expect(calls).toBe(0);
    expect(rejected.json.requests[0]).toMatchObject({ requestSent: false, usageKnown: true, usage: null });
    const ledgerPath = path.join(dir, '.timeout-ledger.json');
    const timed = new MetaProvider({ apiKey: 'fake', requestTimeoutMs: 10, ledgerPath, fetchFn: async (_url, init) => {
      calls++;
      return { ok: true, json: () => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })) } as Response;
    } });
    const second = new ChaosPilotServer({ runsDir: dir, challengeTransport: metaExplanationTransport(timed) });
    const failed = await api(second, 'POST', url, body(findingId, view)); expect(calls).toBe(1); expect(failed.status).toBe(422);
    expect(failed.json.variants).toHaveLength(0); expect(failed.json.requests[0]).toMatchObject({ usageKnown: false, usage: null });
    expect(new BudgetLedger(ledgerPath).getStatus().spentUsd).toBeGreaterThan(0);
  });
});

it('loopback HTTP end-to-end: real stored inventory run, fake model, fresh server reload and traces', async context => {
  const { dir, record, url, findingId } = await setup(true);
  const fake = fakeTransport(record); const instance = new ChaosPilotServer({ runsDir: dir, challengeTransport: fake.transport });
  const server = instance.createHttpServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No loopback address');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${base}${url}?findingId=${findingId}`); expect(response.status).toBe(200); const view = await response.json();
    const created = await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body(findingId, view as never)) });
    expect(created.status).toBe(201);
    const got = await fetch(`${base}${url}?findingId=${findingId}`); const saved = await got.json() as any;
    expect(saved.current.variants[0].candidate.trace.length).toBeGreaterThan(0); expect(saved.current.variants[0].reproduced).toBe(true); expect(fake.calls).toHaveLength(2);
    const html = await fetch(`${base}/workspace`); expect(await html.text()).toContain('Challenge with Muse');
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (code === 'EACCES' || code === 'EPERM') context.skip(`Loopback connections denied by environment (${code}); HTTP handler integration tests remain required`);
    throw error;
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
