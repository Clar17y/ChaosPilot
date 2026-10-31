import type { FunctionalCatalogItem, FunctionalRunRecord, FunctionalRunSummary } from '../functional/types.ts';
import { functionalExecutionBlockedReason, functionalRunOutcomeLabel, partitionFunctionalRuns, type FunctionalGuardState } from './workspace.ts';

export interface FunctionalContext extends Omit<FunctionalGuardState, 'isFunctionalRunPending'> {
  systemId: string | null;
  revision: number | null;
}
export interface FunctionalViewState {
  context: FunctionalContext | null;
  pending: boolean;
  error: string | null;
  historyError: string | null;
  history: FunctionalRunSummary[];
  record: FunctionalRunRecord | null;
  blockedReason: string | null;
}
type Fetch = (url: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

/** One owner for context, pending state and every asynchronous functional response. */
export class FunctionalController {
  readonly state: FunctionalViewState = { context: null, pending: false, error: null, historyError: null, history: [], record: null, blockedReason: 'SELECT A SAVED SYSTEM PROFILE' };
  private generation = 0;
  private inspection = 0;
  private historyRequest = 0;
  constructor(private readonly fetchFn: Fetch, private readonly render: (state: FunctionalViewState) => void) {}

  setContext(context: FunctionalContext): void {
    if (JSON.stringify(context) === JSON.stringify(this.state.context)) return;
    this.generation++;
    this.inspection++;
    this.historyRequest++;
    Object.assign(this.state, { context: structuredClone(context), pending: false, record: null, error: null, historyError: null, history: [] });
    this.publish();
    if (context.systemId && !context.isDraftMode) void this.loadHistory();
  }
  private publish(): void {
    const c = this.state.context;
    this.state.blockedReason = c ? functionalExecutionBlockedReason({ ...c, isFunctionalRunPending: this.state.pending }) : 'SELECT A SAVED SYSTEM PROFILE';
    this.render(this.state);
  }
  private async json(url: string, init?: RequestInit): Promise<any> {
    const res = await this.fetchFn(url, init);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data;
  }
  async loadHistory(): Promise<void> {
    const generation = this.generation, request = ++this.historyRequest;
    const systemId = this.state.context?.systemId;
    try {
      const runs = await this.json('/api/functional/runs') as FunctionalRunSummary[];
      if (generation !== this.generation || request !== this.historyRequest) return;
      this.state.history = partitionFunctionalRuns(runs, systemId ?? null).scoped;
      this.state.historyError = null;
    } catch (error) {
      if (generation !== this.generation || request !== this.historyRequest) return;
      this.state.historyError = String(error);
    }
    this.publish();
  }
  async run(): Promise<void> {
    const c = this.state.context;
    // Guard at execution as well as rendering, using the same app-owned context.
    if (!c || functionalExecutionBlockedReason({ ...c, isFunctionalRunPending: this.state.pending }) || !c.systemId || c.revision === null) return;
    const identity = structuredClone(c), generation = this.generation, inspection = ++this.inspection;
    this.state.pending = true; this.state.error = null; this.state.record = null;
    this.publish(); // Pending ownership is established before the first await.
    const current = () => generation === this.generation && inspection === this.inspection;
    try {
      const record = await this.json('/api/functional/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemId: identity.systemId, expectedRevision: identity.revision, variant: identity.selectedVariant }) }) as FunctionalRunRecord;
      if (!current()) return;
      if (record.systemBrief.id !== identity.systemId || record.systemBrief.revision !== identity.revision
        || record.adapterId !== identity.selectedAdapterId || record.variant !== identity.selectedVariant) throw new Error('Run response identity does not match launch');
      this.state.record = record;
      void this.loadHistory();
    } catch (error) {
      if (current()) this.state.error = String(error);
    } finally {
      if (current()) { this.state.pending = false; this.publish(); }
    }
  }
  async open(id: string): Promise<void> {
    if (!this.state.history.some(r => r.id === id)) return;
    const generation = this.generation, inspection = ++this.inspection;
    this.historyRequest++;
    this.state.pending = false; this.state.record = null; this.state.error = null; this.publish();
    const current = () => generation === this.generation && inspection === this.inspection;
    try {
      const record = await this.json(`/api/functional/runs/${encodeURIComponent(id)}`) as FunctionalRunRecord;
      if (!current()) return;
      if (record.id !== id || record.systemBrief.id !== this.state.context?.systemId) throw new Error('Historical response identity mismatch');
      this.state.record = record; // Historical revision and target are shown solely from this record.
    } catch (error) { if (current()) this.state.error = String(error); }
    if (current()) this.publish();
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const raw = (value: unknown) => `<pre style="overflow:auto;max-height:32rem">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;

/** Raw evidence is deliberate: it includes every pinned fact and failure, without interpreting prose as verified. */
export function functionalResultHtml(record: FunctionalRunRecord): string {
  return `<p>Saved run ${escapeHtml(record.id)} · ${escapeHtml(record.systemBrief.name)} (${escapeHtml(record.systemBrief.id)}) · revision ${record.systemBrief.revision} · target ${escapeHtml(record.variant)}</p>
    <p>Context-only brief prose remains unverified.</p>
    <details><summary>Pinned brief, contract, target source and evaluator provenance</summary>${raw({ sourceHash: record.sourceHash, evaluator: record.evaluator,
      startedAt: record.startedAt, finishedAt: record.finishedAt, systemBrief: record.systemBrief, systemSnapshot: record.systemSnapshot, contract: record.contract })}</details>
    ${record.scenarios.map(s => `<article class="card"><h3>${escapeHtml(s.name)} — ${escapeHtml(functionalRunOutcomeLabel(s.status))}</h3><p>${escapeHtml(s.summary)}</p>
      <div style="overflow:auto"><table><thead><tr><th>Status</th><th>Assertion</th><th>Expected</th><th>Actual</th><th>Detail</th></tr></thead><tbody>
      ${s.assertions.map(a => `<tr><td>${escapeHtml(a.status)}</td><td>${escapeHtml(a.name)}</td><td>${escapeHtml(a.expected)}</td><td>${escapeHtml(a.actual)}</td><td>${escapeHtml(a.detail)}</td></tr>`).join('')}
      </tbody></table></div><details><summary>Complete scenario evidence: expected checks, sequence, trace, rejection, oracle and configured rules</summary>${raw(s)}</details></article>`).join('')}`;
}

export function initFunctionalWorkspaceView(onTargetChange: (variant: string) => void): FunctionalController {
  const el = (id: string) => document.getElementById(id);
  const run = el('btn-run-functional') as HTMLButtonElement;
  const target = el('functional-target-select') as HTMLSelectElement;
  const controller = new FunctionalController((url, init) => fetch(url, init), state => {
    const c = state.context;
    run.disabled = state.blockedReason !== null;
    run.title = state.blockedReason ?? '';
    run.textContent = state.pending ? 'Running baselines…' : 'Run baselines';
    const display = el('functional-system-display') as HTMLInputElement;
    display.value = c?.isDraftMode ? 'New profile (draft)' : `${c?.systemId ?? 'No profile'} · revision ${c?.revision ?? 'unconfirmed'}`;
    target.replaceChildren(...(c?.allowedVariants ?? []).map(v => { const option = document.createElement('option'); option.value = v; option.textContent = v; return option; }));
    target.value = c?.selectedVariant ?? '';
    target.disabled = c?.targetState !== 'ready' || c?.isDraftMode === true || c?.hasUnsavedSystemEdits === true || c?.isSystemSavePending === true;
    el('functional-eligibility-banner')?.classList.toggle('hidden', state.blockedReason === null);
    el('functional-eligibility-message')!.textContent = state.blockedReason ?? '';
    el('functional-run-status')!.textContent = state.error ?? (state.pending ? 'Executing allowlisted scenarios…' : '');
    const history = el('functional-history-list')!;
    history.replaceChildren();
    if (state.historyError || !state.history.length) history.textContent = state.historyError ?? 'No saved functional runs for this profile.';
    for (const record of state.history) {
      const row = document.createElement('p');
      row.textContent = `${record.startedAt} · ${record.systemBrief.id} rev ${record.systemBrief.revision} · ${record.variant} · ${functionalRunOutcomeLabel(record.status)} `;
      const open = document.createElement('button'); open.textContent = 'Open'; open.type = 'button';
      open.addEventListener('click', () => { void controller.open(record.id); }); row.append(open); history.append(row);
    }
    el('functional-results-card')!.classList.toggle('hidden', !state.record);
    el('functional-scenarios-container')!.innerHTML = state.record ? functionalResultHtml(state.record) : '';
    el('functional-run-meta')!.textContent = state.record ? `Saved ${state.record.systemBrief.id} rev ${state.record.systemBrief.revision} · ${state.record.variant} · ${state.record.id}` : '';
    el('functional-run-badge')!.textContent = state.record ? functionalRunOutcomeLabel(state.record.status) : '';
    el('functional-stat-scenarios')!.textContent = state.record ? `${state.record.summary.passed}/${state.record.summary.totalScenarios}` : '';
    el('functional-stat-assertions')!.textContent = state.record ? `${state.record.summary.passedAssertions}/${state.record.summary.totalAssertions}` : '';
    el('functional-stat-status')!.textContent = state.record ? functionalRunOutcomeLabel(state.record.status) : '';
  });
  run.addEventListener('click', () => { void controller.run(); });
  target.addEventListener('change', () => onTargetChange(target.value));
  void fetch('/api/functional/catalog').then(async response => {
    if (!response.ok) throw new Error('Catalog unavailable');
    const items = await response.json() as FunctionalCatalogItem[];
    el('functional-catalog-list')!.textContent = items.map(i => `${i.name}: ${i.description}`).join('\n\n');
  }).catch(() => { el('functional-catalog-list')!.textContent = 'Scenario catalog unavailable.'; });
  return controller;
}
