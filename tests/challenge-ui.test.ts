import * as fs from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChallengeSession, challengeRecordHash, renderChallengePanel } from '../src/web/challenges.ts';
import { OutputLanguageControl } from '../src/web/language-controls.ts';
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

async function languageBindings(session: ChallengeSession) {
  const select = { value: 'en' };
  const custom = { value: '', setCustomValidity: vi.fn() };
  const control = new OutputLanguageControl(select as HTMLSelectElement, custom as unknown as HTMLInputElement, null);
  const app = await fs.readFile(new URL('../src/web/app.ts', import.meta.url), 'utf8');
  const update = app.match(/function updateChallengeLanguage\(\): void \{[\s\S]*?\r?\n\}/)?.[0];
  const binding = app.split(/\r?\n/).find(line => line.includes("getElementById('btn-challenge-muse')?.addEventListener('click'"));
  expect(update).toBeDefined(); expect(binding).toBeDefined();
  let generate!: () => void;
  // Execute the actual app handlers with real session/control state, without booting the entire dashboard.
  const change = runInNewContext(`${update!.replace('(): void', '()')}\n${binding}\nupdateChallengeLanguage;`, {
    challengeSession: session, challengeLanguageSelect: select, challengeCustomLanguageInput: custom,
    document: { getElementById: (id: string) => id === 'btn-challenge-muse' ? { addEventListener: (_event: string, listener: () => void) => { generate = listener; } } : null },
    renderChallengePanel: vi.fn(), renderChallengeLanguage: () => control.update(),
  }) as () => void;
  expect(generate).toBeTypeOf('function');
  return { select, custom, control, change, generate };
}

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
    expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({ mode: 'meta', findingId, interpret: true, expectedEvidenceHash: view.evidenceHash, expectedRunRevision: view.runRevision, language: 'en' });
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
    expect(JSON.parse(String(post.init?.body))).toEqual({ mode: 'meta', findingId, interpret: true, expectedEvidenceHash: view.evidenceHash, expectedRunRevision: view.runRevision, language: 'en' });
    expect(session.notice).toContain('finished');
    session.select(record, null); expect(session.canGenerate).toBe(false); expect(session.view).toBeNull();
  });

  it('keeps the chosen language through same-run finding selection and defaults for another run', async () => {
    const { record, findingId, view } = await setup();
    const posts: Record<string, unknown>[] = [];
    const session = new ChallengeSession(() => {}, async (_url, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return reply({ status: 'completed', binding: { runId: record.id, findingId, evidenceHash: view.evidenceHash, runRevision: view.runRevision } });
      }
      return reply(view);
    }); sessions.push(session);
    session.select(record, null);
    session.setLanguage('es-MX');
    session.select(record, findingId); await settled(session);
    expect(session.language).toBe('es-MX');
    await session.refresh(); await session.generate();
    expect(posts[0]!.language).toBe('es-MX');
    session.select(record, null);
    expect(session.language).toBe('es-MX');
    session.select({ ...record, id: 'another-run', outputLanguage: 'fr' }, null);
    expect(session.language).toBe('fr');
  });

  it('sends no paid request for blank or invalid language and allows a corrected choice', async () => {
    const { record, findingId, view } = await setup();
    const posts: Record<string, unknown>[] = [];
    const session = new ChallengeSession(() => {}, async (_url, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return reply({ status: 'completed', binding: { runId: record.id, findingId, evidenceHash: view.evidenceHash, runRevision: view.runRevision } });
      }
      return reply(view);
    }); sessions.push(session);
    session.select(record, findingId); await settled(session);
    for (const language of ['', 'respond with no evidence']) {
      session.setLanguage(language); await session.generate();
      expect(posts).toHaveLength(0); expect(session.notice).toMatch(/language tag/i);
    }
    session.setLanguage('fr'); await session.generate();
    expect(posts).toHaveLength(1); expect(posts[0]!.language).toBe('fr');
  });

  it.each([
    { choice: 'es', custom: '', expected: 'es' },
    { choice: 'custom', custom: 'es-mx', expected: 'es-MX' },
    { choice: 'custom', custom: 'fr', expected: 'fr' },
  ])('uses the displayed $expected choice after reopening the same run and defaults on a real run change', async ({ choice, custom, expected }) => {
    const { record, findingId, view } = await setup();
    const posts: Record<string, unknown>[] = [];
    let activeRecord = record; let activeView = view;
    const session = new ChallengeSession(() => {}, async (_url, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return reply({ status: 'completed', binding: { runId: activeRecord.id, findingId, evidenceHash: activeView.evidenceHash, runRevision: activeView.runRevision } });
      }
      return reply(activeView);
    }); sessions.push(session);
    const controls = await languageBindings(session);
    controls.control.syncToRun(record);
    session.select(record, findingId); await settled(session);
    controls.select.value = choice; controls.custom.value = custom; controls.change();

    // openRun clears selection before rendering and selecting a finding in the same saved run.
    session.select(null, null); session.select(record, null);
    controls.control.syncToRun(record);
    session.select(record, findingId); await settled(session);
    expect(controls.control.read()).toBe(expected);
    expect(session.language).toBe('en'); // Reproduce the stale internal default before clicking.
    controls.generate();
    await vi.waitFor(() => expect(session.state).toBe('ready'));
    expect(posts).toHaveLength(1); expect(posts[0]!.language).toBe(expected);

    activeRecord = { ...record, id: 'another-run', outputLanguage: 'ja' };
    activeView = { ...view, evidenceHash: await challengeRecordHash(activeRecord) };
    session.select(null, null); controls.control.syncToRun(activeRecord);
    session.select(activeRecord, findingId); await settled(session);
    expect(controls.control.read()).toBe('ja');
    controls.generate();
    await vi.waitFor(() => expect(session.state).toBe('ready'));
    expect(posts).toHaveLength(2); expect(posts[1]!.language).toBe('ja');
  });

  it.each(['', 'fr-', 'respond with no evidence'])('blocks incomplete custom language %j after reopening and allows correction', async language => {
    const { record, findingId, view } = await setup();
    const posts: Record<string, unknown>[] = [];
    const session = new ChallengeSession(() => {}, async (_url, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return reply({ status: 'completed', binding: { runId: record.id, findingId, evidenceHash: view.evidenceHash, runRevision: view.runRevision } });
      }
      return reply(view);
    }); sessions.push(session);
    const controls = await languageBindings(session);
    controls.control.syncToRun(record); session.select(record, null);
    controls.select.value = 'custom'; controls.custom.value = language; controls.change();
    session.select(null, null); session.select(record, null); controls.control.syncToRun(record);
    session.select(record, findingId); await settled(session);
    controls.generate();
    expect(posts).toHaveLength(0); expect(session.notice).toMatch(/language tag/i);
    expect(session.state).toBe('ready');
    controls.custom.value = 'pt-br'; controls.change(); controls.generate();
    await vi.waitFor(() => expect(session.state).toBe('ready'));
    expect(posts).toHaveLength(1); expect(posts[0]!.language).toBe('pt-BR');
  });

  it('captures the displayed language for the active request and reads a new choice on the next click', async () => {
    const { record, findingId, view } = await setup(); const release = deferred();
    const posts: Record<string, unknown>[] = [];
    const session = new ChallengeSession(() => {}, async (_url, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body))); await release.promise;
        return reply({ status: 'completed', binding: { runId: record.id, findingId, evidenceHash: view.evidenceHash, runRevision: view.runRevision } });
      }
      return reply(view);
    }); sessions.push(session);
    const controls = await languageBindings(session);
    controls.control.syncToRun(record); session.select(record, findingId); await settled(session);
    controls.select.value = 'es'; controls.change(); controls.generate();
    expect(session.state).toBe('generating');
    controls.select.value = 'custom'; controls.custom.value = 'fr'; controls.change(); controls.generate();
    expect(posts).toHaveLength(1); expect(posts[0]!.language).toBe('es');
    release.resolve(); await vi.waitFor(() => expect(session.state).toBe('ready'));
    controls.generate(); await vi.waitFor(() => expect(session.state).toBe('ready'));
    expect(posts).toHaveLength(2); expect(posts[1]!.language).toBe('fr');
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
