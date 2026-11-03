import type { InvestigationRecord } from '../domain.ts';
import type { ChallengeRecord, ChallengeView } from '../challenges/types.ts';
import { parseApiErrorResponse, type ApiResponseLike } from './request-boundaries.ts';
import { cleanupVerificationView, renderWatchVerificationView } from './challenge-verification.ts';
import { normalizeOutputLanguage } from '../output-language.ts';

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
  language = 'en';
  waitsForSave = false;
  private record: InvestigationRecord | null = null;
  private selection = '';
  private seq = 0;
  private controller: AbortController | null = null;
  private poll: ReturnType<typeof setTimeout> | undefined;
  private expectedRevision: string | null = null;
  // select() owns the immutable clone; only cache a successfully computed hash.
  private expectedHash: string | null = null;
  constructor(private readonly changed: () => void, private readonly fetchFn: ChallengeFetch = (url, init) => fetch(url, init)) {}

  select(record: InvestigationRecord | null, findingId: string | null, waitsForSave = false): void {
    const selection = record ? JSON.stringify([record, findingId, waitsForSave]) : '';
    if (this.selection === selection) return;
    this.seq++; this.controller?.abort(); this.controller = null; clearTimeout(this.poll);
    this.selection = selection; this.record = record ? structuredClone(record) : null;
    if (this.runId !== (record?.id ?? null)) this.language = record?.outputLanguage ?? 'en';
    this.runId = record?.id ?? null; this.findingId = findingId; this.waitsForSave = waitsForSave; this.view = null;
    this.expectedRevision = null;
    this.expectedHash = null;
    this.state = 'idle'; this.notice = !findingId ? 'Select a confirmed finding to challenge it.' : waitsForSave ? 'Wait for the terminal run to finish saving.' : '';
    this.changed();
    if (record && findingId && !waitsForSave) void this.refresh();
  }
  setLanguage(lang: string): void {
    if (this.language === lang) return;
    this.language = lang;
    this.changed();
  }
  private url(): string { return `/api/runs/${encodeURIComponent(this.runId!)}/challenges`; }
  private schedule(token: number): void {
    clearTimeout(this.poll);
    if (this.view?.inFlight || this.state === 'generating') {
      this.poll = setTimeout(() => { if (this.seq === token) void this.pollProgress(token); }, 500);
    }
  }
  private async pollProgress(token: number): Promise<void> {
    if (this.seq !== token || !this.record || !this.findingId || this.waitsForSave) return;
    try {
      const expectedHash = this.expectedHash;
      const expectedRevision = this.expectedRevision ?? this.view?.runRevision;
      if (!expectedHash || !expectedRevision) return;

      const response = await this.fetchFn(`${this.url()}?findingId=${encodeURIComponent(this.findingId)}`);
      if (this.seq !== token) return;
      if (response.ok) {
        const view = await response.json() as ChallengeView;
        if (this.seq !== token) return;
        if (
          view &&
          view.evidenceHash === expectedHash &&
          view.runRevision === expectedRevision &&
          typeof view.runRevision === 'string'
        ) {
          this.view = view;
          this.changed();
        }
      }
    } catch {
      // Ignore background poll errors so active POST is not interrupted
    }
    if (this.seq === token && (this.state === 'generating' || this.view?.inFlight)) {
      this.schedule(token);
    }
  }
  async refresh(): Promise<void> {
    if (!this.record || !this.findingId || this.state === 'generating' || this.waitsForSave) return;
    const record = this.record;
    const token = ++this.seq;
    const clearPrompt = this.state === 'cancelled' || this.state === 'error' || this.notice.includes('Refresh');
    this.state = 'loading'; this.changed();
    try {
      const expectedHash = this.expectedHash ?? await challengeRecordHash(record);
      if (token !== this.seq) return;
      const response = await this.fetchFn(`${this.url()}?findingId=${encodeURIComponent(this.findingId)}`);
      if (!response.ok) throw new Error(await parseApiErrorResponse(response));
      const view = await response.json() as ChallengeView;
      if (token !== this.seq) return;
      if (!view || view.evidenceHash !== expectedHash || typeof view.runRevision !== 'string') {
        this.view = null;
        this.expectedRevision = null;
        throw new Error('Saved run evidence changed. Reload the run before challenging this finding.');
      }
      this.expectedRevision = view.runRevision;
      this.expectedHash = expectedHash;
      this.view = view; this.state = 'ready'; if (clearPrompt) this.notice = ''; this.schedule(token);
    } catch (error) {
      if (token !== this.seq) return;
      this.view = null; this.expectedRevision = null; this.state = 'error'; this.notice = error instanceof Error ? error.message : String(error);
    }
    this.changed();
  }
  get canGenerate(): boolean { return this.state === 'ready' && this.view?.available === true && !this.view.inFlight; }
  async generate(): Promise<void> {
    if (!this.canGenerate || !this.view || !this.findingId) return;
    let language: string;
    try {
      if (!this.language.trim()) throw new Error('Enter a custom language tag, such as fr or pt-BR.');
      language = normalizeOutputLanguage(this.language);
    } catch (error) {
      this.notice = error instanceof Error ? error.message : String(error); this.changed(); return;
    }
    const view = this.view;
    const token = ++this.seq;
    clearTimeout(this.poll);
    const controller = new AbortController(); this.controller = controller;
    this.state = 'generating'; this.notice = ''; this.changed();
    this.schedule(token);
    try {
      const response = await this.fetchFn(this.url(), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ mode: 'meta', findingId: this.findingId, interpret: true, expectedEvidenceHash: view.evidenceHash, expectedRunRevision: view.runRevision, language }),
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
    clearTimeout(this.poll);
    this.controller = null; this.state = 'ready';
    await this.refresh();
  }
  cancel(): void {
    if (this.state !== 'generating') return;
    this.controller?.abort(); this.controller = null; ++this.seq;
    clearTimeout(this.poll);
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
  const savedLanguage = view?.current?.language ?? view?.latestAttempt?.language ?? view?.latestPartial?.language;
  if (status) status.textContent = [
    session.runId && session.findingId ? `Run ${session.runId} · finding ${session.findingId}.` : '',
    savedLanguage ? `Saved language: ${savedLanguage === 'es' ? 'Español' : savedLanguage === 'en' ? 'English' : savedLanguage}.` : '',
    session.notice,
    session.state === 'generating' ? 'Muse challenge in progress…' : view?.inFlight ? 'A challenge for this finding is in progress. Saved evidence will refresh.' : session.state === 'loading' ? 'Checking saved challenge evidence…' : '',
    view?.stale ? 'Earlier challenge evidence is stale and is not displayed as current.' : '',
    view?.reason ?? '',
    view && !view.current && !view.latestAttempt && !view.latestPartial && !pending ? 'No current challenge evidence saved for this finding.' : '',
  ].filter(Boolean).join(' ');
  const results = find('challenge-results');
  if (!results) return;
  const key = JSON.stringify([session.runId, session.findingId, view?.current, view?.latestPartial, view?.latestAttempt, view?.inFlight, session.state]);
  if (rendered.get(results) === key) return;
  cleanupVerificationView(results);
  rendered.set(results, key);
  results.replaceChildren();

  if (view && (view.current || view.latestAttempt || view.latestPartial || pending)) {
    renderWatchVerificationView(results, view, () => {
      rendered.delete(results);
      renderChallengePanel(host, session);
    });
  }
}
