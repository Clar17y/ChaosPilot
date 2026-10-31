import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChallengeSession, challengeRecordHash, renderChallengePanel } from '../src/web/challenges.ts';
import { evidenceHashOf } from '../src/explanations/index.ts';
import { challengeFinding, getChallengeView } from '../src/challenges/index.ts';
import { saveRun } from '../src/storage.ts';
import { challengeFixture, deferred, fakeTransport, tempChallengeDir } from './challenge-fixtures.ts';
import type { ChallengeView } from '../src/challenges/types.ts';

const dirs: string[] = [];
const sessions: ChallengeSession[] = [];
afterEach(async () => { sessions.splice(0).forEach(s => s.select(null, null)); vi.unstubAllGlobals(); await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });
async function setup() {
  const dir = await tempChallengeDir(); dirs.push(dir); const record = await challengeFixture(true); await saveRun(record, dir);
  const findingId = record.findings[0]!.id; const view = await getChallengeView(record.id, findingId, dir);
  return { dir, record, findingId, view };
}
const reply = (json: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
async function settled(session: ChallengeSession) { await vi.waitFor(() => expect(session.state).not.toBe('loading')); }

describe('production challenge browser request boundaries', () => {
  it('uses default browser fetch without binding it to the session for loading, refresh and generation', async () => {
    const { record, findingId, view } = await setup();
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', async function (this: unknown, url: string, init?: RequestInit) {
      // Native browser fetch rejects an arbitrary object receiver; Node's fetch does not.
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      calls.push({ url, init });
      return reply(init?.method === 'POST'
        ? { status: 'completed', binding: { runId: record.id, findingId, evidenceHash: view.evidenceHash, runRevision: view.runRevision } }
        : view);
    });
    const session = new ChallengeSession(() => {}); sessions.push(session);
    session.select(record, findingId); await settled(session);
    expect(session.state).toBe('ready'); expect(session.view).toEqual(view);
    await session.refresh();
    expect(session.state).toBe('ready'); expect(session.canGenerate).toBe(true);
    await session.generate();
    expect(session.state).toBe('ready'); expect(session.notice).toContain('finished');
    const base = `/api/runs/${encodeURIComponent(record.id)}/challenges`;
    expect(calls.map(({ url, init }) => [url, init?.method ?? 'GET'])).toEqual([
      [`${base}?findingId=${encodeURIComponent(findingId)}`, 'GET'],
      [`${base}?findingId=${encodeURIComponent(findingId)}`, 'GET'],
      [base, 'POST'],
      [`${base}?findingId=${encodeURIComponent(findingId)}`, 'GET'],
    ]);
    expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({ mode: 'meta', findingId, interpret: true, expectedEvidenceHash: view.evidenceHash, expectedRunRevision: view.runRevision });
    expect(calls[2]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('browser fingerprint matches server evidence identity independent of object key order', async () => {
    const { record } = await setup(); expect(await challengeRecordHash(record)).toBe(evidenceHashOf(record));
    const reordered = Object.fromEntries(Object.entries(record).reverse()) as typeof record;
    expect(await challengeRecordHash(reordered)).toBe(evidenceHashOf(record));
  });

  it('enables explicit paid action only for verified selected saved evidence; sends exact identities', async () => {
    const { record, findingId, view } = await setup(); const calls: { url: string; init?: RequestInit }[] = [];
    const session = new ChallengeSession(() => {}, async (url, init) => { calls.push({ url, init }); return init?.method === 'POST' ? reply({ status: 'completed', binding: { runId: record.id, findingId, evidenceHash: view.evidenceHash, runRevision: view.runRevision } }) : reply(view); }); sessions.push(session);
    session.select(record, findingId, true); expect(session.canGenerate).toBe(false); expect(calls).toHaveLength(0);
    session.select(record, findingId); await settled(session); expect(session.canGenerate).toBe(true);
    await session.generate(); const post = calls.find(c => c.init?.method === 'POST')!;
    expect(JSON.parse(String(post.init?.body))).toEqual({ mode: 'meta', findingId, interpret: true, expectedEvidenceHash: view.evidenceHash, expectedRunRevision: view.runRevision });
    expect(session.notice).toContain('finished');
    session.select(record, null); expect(session.canGenerate).toBe(false); expect(session.view).toBeNull();
  });

  it.each(['run', 'finding', 'evidence', 'clear'] as const)('late generation result cannot settle after %s selection transition', async transition => {
    const { record, findingId, view } = await setup(); const entered = deferred(); const release = deferred();
    const session = new ChallengeSession(() => {}, async (_url, init) => {
      if (init?.method === 'POST') { entered.resolve(); await release.promise; return reply({ status: 'completed', binding: { runId: record.id, findingId, evidenceHash: view.evidenceHash, runRevision: view.runRevision } }); }
      return reply(view);
    }); sessions.push(session);
    session.select(record, findingId); await settled(session);
    const pending = session.generate(); await entered.promise;
    const changed = structuredClone(record);
    if (transition === 'run') changed.id = 'another-run';
    if (transition === 'evidence') changed.findings[0]!.title = 'changed';
    session.select(transition === 'clear' ? null : changed, transition === 'clear' ? null : transition === 'finding' ? 'other-finding' : findingId);
    release.resolve(); await pending;
    expect(session.notice).not.toContain('finished');
    if (transition === 'run') expect(session.runId).toBe('another-run');
    if (transition === 'finding') expect(session.findingId).toBe('other-finding');
    if (transition === 'clear') expect(session.view).toBeNull();
  });

  it('rejects stale saved record before POST and shows why legacy provenance is unavailable', async () => {
    const { record, findingId, view } = await setup(); let posts = 0;
    const session = new ChallengeSession(() => {}, async (_url, init) => { if (init?.method) posts++; return reply({ ...view, evidenceHash: 'different' }); }); sessions.push(session);
    session.select(record, findingId); await settled(session); await session.generate();
    expect(posts).toBe(0); expect(session.notice).toMatch(/Reload/); expect(session.view).toBeNull();
    const unavailable = new ChallengeSession(() => {}, async () => reply({ ...view, available: false, reason: 'clean-source provenance missing' })); sessions.push(unavailable);
    unavailable.select(record, findingId); await settled(unavailable); expect(unavailable.canGenerate).toBe(false); expect(unavailable.view?.reason).toContain('clean-source');
  });

  it('cancellation invalidates a late response and a refresh reloads retained evidence', async () => {
    const { record, findingId, view } = await setup(); const entered = deferred(); const release = deferred(); let aborted = false;
    const session = new ChallengeSession(() => {}, async (_url, init) => {
      if (init?.method === 'POST') { init.signal?.addEventListener('abort', () => { aborted = true; }); entered.resolve(); await release.promise; return reply({ error: 'cancelled' }, 409); }
      return reply(view);
    }); sessions.push(session);
    session.select(record, findingId); await settled(session); const pending = session.generate(); await entered.promise;
    session.cancel(); expect(aborted).toBe(true); expect(session.state).toBe('cancelled'); release.resolve(); await pending;
    expect(session.notice).toContain('usage may be unknown'); expect(session.notice).toContain('Refresh to inspect retained evidence'); expect(session.state).toBe('cancelled');
    await session.refresh(); expect(session.view).toEqual(view); expect(session.state).toBe('ready');
    expect(session.notice).toBe('');
  });

  it('waitsForSave guards refresh in session and disables the refresh button', async () => {
    const { record, findingId, view } = await setup(); let gets = 0;
    const session = new ChallengeSession(() => {}, async () => { gets++; return reply(view); }); sessions.push(session);
    session.select(record, findingId, true);
    expect(session.waitsForSave).toBe(true);
    expect(gets).toBe(0);
    await session.refresh();
    expect(gets).toBe(0);

    const host = new Element('section');
    for (const id of ['challenge-status', 'challenge-results', 'btn-challenge-muse', 'btn-challenge-cancel', 'btn-challenge-refresh']) host.append(new Element(id.startsWith('btn-') ? 'button' : 'div', id));
    vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) });
    renderChallengePanel(host as unknown as HTMLElement, session);
    expect(host.querySelector('#btn-challenge-refresh')!.disabled).toBe(true);

    session.select(record, findingId, false);
    expect(session.waitsForSave).toBe(false);
    await settled(session);
    expect(gets).toBe(1);
    renderChallengePanel(host as unknown as HTMLElement, session);
    expect(host.querySelector('#btn-challenge-refresh')!.disabled).toBe(false);
  });

  it('same selection refresh preserves a pending request; revisiting re-fetches saved evidence', async () => {
    const { record, findingId, view } = await setup(); let gets = 0;
    const session = new ChallengeSession(() => {}, async () => { gets++; return reply(view); }); sessions.push(session);
    session.select(record, findingId); await settled(session); session.select(structuredClone(record), findingId); expect(gets).toBe(1);
    session.select(null, null); session.select(record, findingId); await settled(session); expect(gets).toBe(2);
  });

});

class Element {
  children: Element[] = [];
  textContent = '';
  disabled = false;
  attrs: Record<string, string> = {};
  constructor(readonly tag: string, readonly id = '') {}
  set innerHTML(_v: string) { throw new Error('Unsafe HTML rendering'); }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  querySelector(selector: string): Element | null {
    return this.children.find(e => `#${e.id}` === selector) ?? this.children.map(e => e.querySelector(selector)).find(Boolean) ?? null;
  }
  allText(): string { return [this.textContent, ...this.children.map(e => e.allText())].join('\n'); }
  tags(): string[] { return [this.tag, ...this.children.flatMap(e => e.tags())]; }
}

it('renders real saved traces, proposal differences, statuses and model text through text nodes with accessible controls', async () => {
  const { dir, record, findingId } = await setup(); const fake = fakeTransport(record);
  await challengeFinding(record.id, findingId, { runsDir: dir, transport: fake.transport });
  const view = await getChallengeView(record.id, findingId, dir);
  const host = new Element('section');
  for (const id of ['challenge-status', 'challenge-results', 'btn-challenge-muse', 'btn-challenge-cancel', 'btn-challenge-refresh']) host.append(new Element(id.startsWith('btn-') ? 'button' : 'div', id));
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) });
  const session = new ChallengeSession(() => {}); sessions.push(session);
  session.view = view; session.state = 'ready'; session.runId = record.id; session.findingId = findingId;
  renderChallengePanel(host as unknown as HTMLElement, session);
  const rendered = host.allText();
  for (const text of ['Variation 1', 'Actual step differences', 'Hypothesis:', 'Same invariant', 'Replay: matched', 'Clean control: passed', 'full trace', 'interpretation, not deterministic evidence', '<script>Interpretation only</script>']) expect(rendered).toContain(text);
  expect(host.tags()).not.toContain('script'); expect(host.attrs['aria-busy']).toBe('false');
  expect(host.querySelector('#btn-challenge-muse')!.disabled).toBe(false);
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  expect(html).toContain('aria-labelledby="challenge-title"'); expect(html).toContain('Challenge with Muse · paid Meta API'); expect(html).toContain('id="challenge-status" role="status" aria-live="polite"');
});

it('shows a latest partial attempt once alongside earlier completed evidence and labels clean violations accurately', async () => {
  const { dir, record, findingId } = await setup();
  await challengeFinding(record.id, findingId, { runsDir: dir, transport: fakeTransport(record).transport });
  const view = await getChallengeView(record.id, findingId, dir);
  const completed = view.current!;
  const partial = structuredClone(completed);
  partial.id = 'partial-attempt';
  partial.status = 'cancelled';
  const variant = partial.variants[0]!;
  variant.cleanStatus = 'failed';
  variant.reproduced = false;
  variant.clean!.violations = [{ id: 'same', invariant: partial.binding.invariant, message: 'same invariant on clean', step: 1, evidence: {} }];
  view.latestPartial = partial;
  view.latestAttempt = partial;

  const host = new Element('section');
  for (const id of ['challenge-status', 'challenge-results', 'btn-challenge-muse', 'btn-challenge-cancel', 'btn-challenge-refresh']) host.append(new Element(id.startsWith('btn-') ? 'button' : 'div', id));
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) });
  const session = new ChallengeSession(() => {}); sessions.push(session);
  session.view = view; session.state = 'ready'; session.runId = record.id; session.findingId = findingId;
  renderChallengePanel(host as unknown as HTMLElement, session);
  const rendered = host.allText();
  expect(rendered).toContain(`Saved challenge ${completed.id}`);
  expect(rendered.match(/Partial attempt partial-attempt/g)).toHaveLength(1);
  expect(rendered).toContain(`Clean control violations: ${partial.binding.invariant}`);
  expect(rendered).not.toContain(`Clean control violations (unrelated to ${partial.binding.invariant})`);
});
