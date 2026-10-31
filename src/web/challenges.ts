import type { InvestigationRecord } from '../domain.ts';
import type { ChallengeRecord, ChallengeView } from '../challenges/types.ts';
import { parseApiErrorResponse, type ApiResponseLike } from './request-boundaries.ts';

type ChallengeFetch = (url: string, init?: RequestInit) => Promise<ApiResponseLike>;

// Browser equivalent of evidenceHashOf: no server/Node imports in the browser module graph.
export async function challengeRecordHash(record: InvestigationRecord): Promise<string> {
  const canonical = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  };
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(record)));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
}

/** Owns fetch, cancellation, saved-version and run/finding selection boundaries used by the app. */
export class ChallengeSession {
  view: ChallengeView | null = null;
  state: 'idle' | 'loading' | 'ready' | 'generating' | 'error' | 'cancelled' = 'idle';
  notice = '';
  runId: string | null = null;
  findingId: string | null = null;
  waitsForSave = false;
  private record: InvestigationRecord | null = null;
  private selection = '';
  private seq = 0;
  private controller: AbortController | null = null;
  private poll: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly changed: () => void, private readonly fetchFn: ChallengeFetch = (url, init) => fetch(url, init)) {}

  select(record: InvestigationRecord | null, findingId: string | null, waitsForSave = false): void {
    const selection = record && findingId ? JSON.stringify([record, findingId, waitsForSave]) : '';
    if (this.selection === selection) return;
    this.seq++; this.controller?.abort(); this.controller = null; clearTimeout(this.poll);
    this.selection = selection; this.record = record ? structuredClone(record) : null;
    this.runId = record?.id ?? null; this.findingId = findingId; this.waitsForSave = waitsForSave; this.view = null;
    this.state = 'idle'; this.notice = !findingId ? 'Select a confirmed finding to challenge it.' : waitsForSave ? 'Wait for the terminal run to finish saving.' : '';
    this.changed();
    if (record && findingId && !waitsForSave) void this.refresh();
  }
  private url(): string { return `/api/runs/${encodeURIComponent(this.runId!)}/challenges`; }
  private schedule(token: number): void {
    clearTimeout(this.poll);
    if (this.view?.inFlight) this.poll = setTimeout(() => { if (this.seq === token) void this.refresh(); }, 1000);
  }
  async refresh(): Promise<void> {
    if (!this.record || !this.findingId || this.state === 'generating' || this.waitsForSave) return;
    const record = this.record;
    const token = ++this.seq;
    const clearPrompt = this.state === 'cancelled' || this.state === 'error' || this.notice.includes('Refresh');
    this.state = 'loading'; this.changed();
    try {
      const expectedHash = await challengeRecordHash(record);
      if (token !== this.seq) return;
      const response = await this.fetchFn(`${this.url()}?findingId=${encodeURIComponent(this.findingId)}`);
      if (!response.ok) throw new Error(await parseApiErrorResponse(response));
      const view = await response.json() as ChallengeView;
      if (token !== this.seq) return;
      if (!view || view.evidenceHash !== expectedHash || typeof view.runRevision !== 'string') {
        this.view = null;
        throw new Error('Saved run evidence changed. Reload the run before challenging this finding.');
      }
      this.view = view; this.state = 'ready'; if (clearPrompt) this.notice = ''; this.schedule(token);
    } catch (error) {
      if (token !== this.seq) return;
      this.view = null; this.state = 'error'; this.notice = error instanceof Error ? error.message : String(error);
    }
    this.changed();
  }
  get canGenerate(): boolean { return this.state === 'ready' && this.view?.available === true && !this.view.inFlight; }
  async generate(): Promise<void> {
    if (!this.canGenerate || !this.view || !this.findingId) return;
    const view = this.view;
    const token = ++this.seq;
    clearTimeout(this.poll);
    const controller = new AbortController(); this.controller = controller;
    this.state = 'generating'; this.notice = ''; this.changed();
    try {
      const response = await this.fetchFn(this.url(), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ mode: 'meta', findingId: this.findingId, interpret: true, expectedEvidenceHash: view.evidenceHash, expectedRunRevision: view.runRevision }),
      });
      if (!response.ok) throw new Error(await parseApiErrorResponse(response));
      const result = await response.json() as ChallengeRecord;
      if (token !== this.seq) return;
      if (result.binding?.runId !== this.runId || result.binding?.findingId !== this.findingId || result.binding?.evidenceHash !== view.evidenceHash || result.binding?.runRevision !== view.runRevision) throw new Error('Challenge response identity mismatch. Refresh saved evidence.');
      this.notice = result.status === 'completed' ? 'Challenge finished. Observations are separate from model interpretation.' : `Challenge ${result.status}.`;
    } catch (error) {
      if (token !== this.seq) return;
      this.notice = controller.signal.aborted ? 'Challenge cancelled. Completed evidence remains saved; remote usage may be unknown.' : error instanceof Error ? error.message : String(error);
    }
    if (token !== this.seq) return;
    this.controller = null; this.state = 'ready';
    await this.refresh();
  }
  cancel(): void {
    if (this.state !== 'generating') return;
    this.controller?.abort(); this.controller = null; ++this.seq;
    this.state = 'cancelled';
    this.notice = 'Challenge cancelled. Completed evidence remains saved; remote usage may be unknown. Refresh to inspect retained evidence.';
    this.changed();
  }
}

const rendered = new WeakMap<HTMLElement, string>();
/** Uses text nodes for all record/model content, including inspectable JSON and payloads. */
export function renderChallengePanel(host: HTMLElement, session: ChallengeSession): void {
  const find = <T extends HTMLElement>(id: string) => host.querySelector<T>(`#${id}`);
  const status = find('challenge-status');
  const view = session.view;
  const pending = session.state === 'generating' || view?.inFlight === true;
  host.setAttribute('aria-busy', String(pending || session.state === 'loading'));
  const create = find<HTMLButtonElement>('btn-challenge-muse'); if (create) create.disabled = !session.canGenerate;
  const cancel = find<HTMLButtonElement>('btn-challenge-cancel'); if (cancel) cancel.disabled = session.state !== 'generating';
  const refresh = find<HTMLButtonElement>('btn-challenge-refresh'); if (refresh) refresh.disabled = !session.findingId || session.waitsForSave || session.state === 'generating' || session.state === 'loading';
  if (status) status.textContent = [
    session.runId && session.findingId ? `Run ${session.runId} · finding ${session.findingId}.` : '',
    session.notice,
    session.state === 'generating' ? 'Muse challenge in progress…' : view?.inFlight ? 'A challenge for this finding is in progress. Saved evidence will refresh.' : session.state === 'loading' ? 'Checking saved challenge evidence…' : '',
    view?.stale ? 'Earlier challenge evidence is stale and is not displayed as current.' : '',
    view?.reason ?? '',
    view && !view.current && !view.latestAttempt && !view.latestPartial && !pending ? 'No current challenge evidence saved for this finding.' : '',
  ].filter(Boolean).join(' ');
  const results = find('challenge-results');
  if (!results) return;
  const key = JSON.stringify([view?.current, view?.latestPartial, view?.latestAttempt]);
  if (rendered.get(results) === key) return;
  rendered.set(results, key); results.replaceChildren();
  const paragraph = (parent: HTMLElement, value: string) => { const p = document.createElement('p'); p.textContent = value; parent.append(p); };
  const details = (parent: HTMLElement, label: string, value: unknown) => {
    const d = document.createElement('details'); const s = document.createElement('summary'); s.textContent = label;
    const pre = document.createElement('pre'); pre.textContent = JSON.stringify(value, null, 2); d.append(s, pre); parent.append(d);
  };
  const renderArtifact = (current: ChallengeRecord, label: string) => {
    paragraph(results, `${label} ${current.id} · ${current.status} · ${current.startedAt}`);
    if (current.error) paragraph(results, current.error);
    details(results, 'Exact run, finding, experiment and source identities', current.binding);
    current.variants.forEach((variant, i) => {
      const article = document.createElement('article');
      const heading = document.createElement('h4'); heading.textContent = `Variation ${i + 1}`; article.append(heading);
      paragraph(article, `Muse proposed change: ${variant.proposedChange}`);
      paragraph(article, `Hypothesis: ${variant.experiment.hypothesis}`);
      paragraph(article, `Candidate: ${variant.candidateStatus} · Same invariant (${current.binding.invariant}): ${variant.sameInvariant} · Replay: ${variant.replayStatus} · Clean control: ${variant.cleanStatus}`);
      paragraph(article, variant.reproduced ? 'Same invariant reproduced with matching replay and a verified clean comparison. This observation does not prove root cause.' : 'Same invariant reproduction with a verified clean comparison has not been established.');
      if (variant.otherInvariants.length) paragraph(article, `Other observed invariants: ${variant.otherInvariants.join(', ')}`);
      if (variant.clean && variant.clean.violations.length > 0) {
        paragraph(article, `Clean control violations: ${variant.clean.violations.map(v => v.invariant).join(', ')}`);
      }
      for (const error of [...variant.errors, ...variant.replayMismatches]) paragraph(article, error);
      details(article, 'Actual step differences from original experiment', variant.changes);
      details(article, 'Experiment steps', variant.experiment.steps);
      for (const kind of ['candidate', 'replay', 'clean'] as const) if (variant[kind]) details(article, `${kind}: full trace, snapshot, violations and rejections`, variant[kind]);
      results.append(article);
    });
    paragraph(results, `Muse interpretation (${current.interpretation.status}) — interpretation, not deterministic evidence:`);
    paragraph(results, current.interpretation.text ?? current.interpretation.error ?? 'No interpretation available.');
    details(results, 'Challenge model requests and reported usage (null means unknown)', current.requests);
    if (current.proposalResponse) details(results, 'Model proposal response (untrusted text)', current.proposalResponse);
  };
  const current = view?.current;
  if (current) renderArtifact(current, 'Saved challenge');
  const latestPartial = view?.latestPartial;
  if (latestPartial && latestPartial.id !== current?.id) {
    paragraph(results, `Previous partial attempt: ${latestPartial.status}${latestPartial.error ? ` — ${latestPartial.error}` : ''}. Earlier valid evidence is retained.`);
    renderArtifact(latestPartial, 'Partial attempt');
  }
  const latest = view?.latestAttempt;
  if (latest && latest.id !== current?.id && latest.id !== latestPartial?.id) {
    paragraph(results, `Latest attempt: ${latest.status}${latest.error ? ` — ${latest.error}` : ''}. Earlier valid evidence is retained above when available.`);
    renderArtifact(latest, 'Latest attempt');
  }
}
