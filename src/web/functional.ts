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
  return `<p>Saved run ${escapeHtml(record.id)} Â· ${escapeHtml(record.systemBrief.name)} (${escapeHtml(record.systemBrief.id)}) Â· revision ${record.systemBrief.revision} Â· target ${escapeHtml(record.variant)}</p>
    <p>Context-only brief prose remains unverified.</p>
    <details><summary>Pinned brief, contract, target source and evaluator provenance</summary>${raw({ sourceHash: record.sourceHash, evaluator: record.evaluator,
      startedAt: record.startedAt, finishedAt: record.finishedAt, systemBrief: record.systemBrief, systemSnapshot: record.systemSnapshot, contract: record.contract })}</details>
    ${record.scenarios.map(s => `<article class="card"><h3>${escapeHtml(s.name)} â€” ${escapeHtml(functionalRunOutcomeLabel(s.status))}</h3><p>${escapeHtml(s.summary)}</p>
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
    run.textContent = state.pending ? 'Running baselinesâ€¦' : 'Run baselines';
    const display = el('functional-system-display') as HTMLInputElement;
    display.value = c?.isDraftMode ? 'New profile (draft)' : `${c?.systemId ?? 'No profile'} Â· revision ${c?.revision ?? 'unconfirmed'}`;
    target.replaceChildren(...(c?.allowedVariants ?? []).map(v => { const option = document.createElement('option'); option.value = v; option.textContent = v; return option; }));
    target.value = c?.selectedVariant ?? '';
    target.disabled = c?.targetState !== 'ready' || c?.isDraftMode === true || c?.hasUnsavedSystemEdits === true || c?.isSystemSavePending === true;
    el('functional-eligibility-banner')?.classList.toggle('hidden', state.blockedReason === null);
    el('functional-eligibility-message')!.textContent = state.blockedReason ?? '';
    el('functional-run-status')!.textContent = state.error ?? (state.pending ? 'Executing allowlisted scenariosâ€¦' : '');
    const history = el('functional-history-list')!;
    history.replaceChildren();
    if (state.historyError || !state.history.length) history.textContent = state.historyError ?? 'No saved functional runs for this profile.';
    for (const record of state.history) {
      const row = document.createElement('p');
      row.textContent = `${record.startedAt} Â· ${record.systemBrief.id} rev ${record.systemBrief.revision} Â· ${record.variant} Â· ${functionalRunOutcomeLabel(record.status)} `;
      const open = document.createElement('button'); open.textContent = 'Open'; open.type = 'button';
      open.addEventListener('click', () => { void controller.open(record.id); }); row.append(open); history.append(row);
    }
    el('functional-results-card')!.classList.toggle('hidden', !state.record);
    el('functional-scenarios-container')!.innerHTML = state.record ? functionalResultHtml(state.record) : '';
    el('functional-run-meta')!.textContent = state.record ? `Saved ${state.record.systemBrief.id} rev ${state.record.systemBrief.revision} Â· ${state.record.variant} Â· ${state.record.id}` : '';
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

export interface TargetUiWorkspaceController {
  setContext(context: FunctionalContext): void;
}

export interface TargetUiSessionView {
  sessionId: string;
  instanceId: string;
  endpoint: string;
  variant: string;
  createdAt?: string;
  expiresAt?: string;
  provenance?: { systemSnapshot?: { brief?: { id?: string; revision?: number } } };
}

export interface TargetUiJourneyOutcomeView {
  evidence: {
    instanceId: string; finishedAt: string; variant: string;
    exchanges: unknown[]; events: unknown[]; uiObservations: unknown[];
    provenance?: { systemSnapshot?: { brief?: { id?: string; revision?: number } } };
  };
  evaluation: { status: string; classification: string; reasons: string[] };
}

export interface TargetUiViewState {
  context: FunctionalContext | null;
  blockedReason: string | null;
  launchPending: boolean;
  journeyPending: boolean;
  closing: boolean;
  session: TargetUiSessionView | null;
  outcome: TargetUiJourneyOutcomeView | null;
  status: string;
}

export function targetUiBlockedReason(c: FunctionalContext | null): string | null {
  if (!c || !c.systemId || !c.hasSelectedSystem) return 'Select a saved system profile';
  if (c.isDraftMode) return 'Save system profile before launching Target UI';
  if (c.hasUnsavedSystemEdits || c.isSystemSavePending) return 'Save pending profile edits before launching Target UI';
  if (c.selectedAdapterId !== 'synthetic-trading') {
    return `Target UI journey only supports synthetic-trading (profile uses "${c.selectedAdapterId ?? 'none'}")`;
  }
  if (c.snapshotState !== 'ready') return 'System contract not confirmed';
  if (c.revision === null) return 'System revision not confirmed';
  if (c.targetState !== 'ready' || !c.selectedVariant || !(c.allowedVariants ?? []).includes(c.selectedVariant)) return 'Select a valid target variant';
  return null;
}

const targetUiContextKey = (c: FunctionalContext | null): string => JSON.stringify(c && {
  systemId: c.systemId, revision: c.revision, variant: c.selectedVariant, adapterId: c.selectedAdapterId,
  isDraftMode: c.isDraftMode, hasUnsavedSystemEdits: c.hasUnsavedSystemEdits,
  isSystemSavePending: c.isSystemSavePending ?? false, snapshotState: c.snapshotState, targetState: c.targetState,
});

function sessionMatchesContext(session: any, c: FunctionalContext): session is TargetUiSessionView {
  return !!session && typeof session.sessionId === 'string' && typeof session.instanceId === 'string'
    && typeof session.endpoint === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(session.endpoint)
    && session.variant === c.selectedVariant
    && session.provenance?.systemSnapshot?.brief?.id === c.systemId
    && session.provenance?.systemSnapshot?.brief?.revision === c.revision;
}

/** One owner for target UI launch/status/close/journey responses, guarded by captured context. */
export class TargetUiWorkspaceControllerCore implements TargetUiWorkspaceController {
  readonly state: TargetUiViewState = {
    context: null, blockedReason: 'Select a saved system profile',
    launchPending: false, journeyPending: false, closing: false,
    session: null, outcome: null, status: '',
  };
  private generation = 0;
  private sessionGeneration = 0;
  private sessionKey: string | null = null;
  private readonly inFlight = new Set<AbortController>();
  constructor(
    private readonly fetchFn: Fetch,
    private readonly render: (state: TargetUiViewState) => void,
  ) {}

  private publish(): void {
    this.state.blockedReason = targetUiBlockedReason(this.state.context);
    this.render(this.state);
  }
  private track(): AbortController {
    const controller = new AbortController();
    this.inFlight.add(controller);
    return controller;
  }
  private untrack(controller: AbortController): void { this.inFlight.delete(controller); }
  private async json(controller: AbortController, url: string, init?: RequestInit): Promise<any> {
    const res = await this.fetchFn(url, { ...init, signal: controller.signal });
    let data: any;
    try { data = await res.json(); } catch { data = undefined; }
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data;
  }
  private selection(c: FunctionalContext) {
    return { systemId: c.systemId, expectedRevision: c.revision, variant: c.selectedVariant };
  }

  setContext(context: FunctionalContext): void {
    const next = structuredClone(context);
    if (targetUiContextKey(next) === targetUiContextKey(this.state.context)) {
      this.state.context = next;
      this.publish();
      return; // identical context: never refetch session state on unrelated ticks
    }
    this.generation++;
    for (const controller of this.inFlight) controller.abort(new Error('Target UI context changed'));
    this.inFlight.clear();
    this.state.context = next;
    this.state.outcome = null;
    this.state.launchPending = false;
    this.state.journeyPending = false;
    this.state.status = '';
    const orphan = this.state.session && this.sessionKey !== targetUiContextKey(next) ? this.state.session : null;
    this.publish();
    if (orphan) void this.closeSessionValue(orphan, true);
    else if (!targetUiBlockedReason(next)) void this.checkSession();
  }

  async checkSession(): Promise<void> {
    const c = this.state.context;
    if (!c || targetUiBlockedReason(c) || this.state.launchPending || this.state.closing) return;
    const generation = this.generation, key = targetUiContextKey(c), identity = structuredClone(c);
    const sessionGeneration = ++this.sessionGeneration;
    const controller = this.track();
    try {
      const data = await this.json(controller, '/api/target-ui/session');
      if (generation !== this.generation || sessionGeneration !== this.sessionGeneration) return;
      const sessions: any[] = Array.isArray(data?.sessions) ? data.sessions : (data?.session ? [data.session] : []);
      const match = sessions.find(s => sessionMatchesContext(s, identity)) ?? null;
      if (this.state.session && this.sessionKey !== key) return; // an orphan close owns the card until it settles
      this.state.session = match;
      this.sessionKey = match ? key : null;
    } catch {
      if (generation !== this.generation) return;
      // A failed status check never invents or drops a known live session.
    } finally {
      this.untrack(controller);
    }
    if (generation === this.generation) this.publish();
  }

  async launch(): Promise<void> {
    const c = this.state.context;
    if (!c || targetUiBlockedReason(c) || this.state.launchPending || this.state.journeyPending || this.state.closing || this.state.session) return;
    const identity = structuredClone(c), generation = this.generation, key = targetUiContextKey(c);
    const controller = this.track();
    this.sessionGeneration++;
    this.state.launchPending = true;
    this.state.status = 'Launching target session…';
    this.publish(); // pending ownership before the first await
    try {
      const data = await this.json(controller, '/api/target-ui/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.selection(identity)),
      });
      if (generation !== this.generation) {
        // Late launch for an abandoned context: close the orphan, display nothing.
        if (typeof data?.session?.sessionId === 'string') void this.deleteSession(data.session.sessionId);
        return;
      }
      if (!sessionMatchesContext(data?.session, identity)) {
        if (typeof data?.session?.sessionId === 'string') void this.deleteSession(data.session.sessionId);
        throw new Error('Launch response does not match the selected profile, revision and variant');
      }
      this.state.session = data.session;
      this.sessionKey = key;
      this.state.status = 'Target UI session active';
    } catch (error) {
      if (generation === this.generation && !controller.signal.aborted) this.state.status = `Launch error: ${String(error instanceof Error ? error.message : error)}`;
    } finally {
      this.untrack(controller);
      if (generation === this.generation) { this.state.launchPending = false; this.publish(); }
    }
  }

  private async deleteSession(sessionId: string): Promise<boolean> {
    try {
      const res = await this.fetchFn(`/api/target-ui/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      return res.ok || res.status === 404;
    } catch { return false; }
  }

  async close(): Promise<void> {
    if (this.state.session) await this.closeSessionValue(this.state.session, false);
  }

  private async closeSessionValue(session: TargetUiSessionView, orphan: boolean): Promise<void> {
    if (this.state.closing) return;
    this.sessionGeneration++;
    this.state.closing = true;
    this.state.status = orphan ? 'Closing previous target session…' : 'Closing session…';
    this.publish();
    try {
      const closed = await this.deleteSession(session.sessionId);
      if (!closed) throw new Error('server did not confirm the close');
      if (this.state.session?.sessionId === session.sessionId) {
        this.state.session = null;
        this.sessionKey = null;
      }
      this.state.status = 'Session closed';
    } catch (error) {
      // Failed close stays visible: the listener may still be running.
      this.state.status = `Close failed (${String(error instanceof Error ? error.message : error)}); session may still be active`;
    } finally {
      this.state.closing = false;
      this.publish();
      if (orphan && !this.state.session && this.state.context && !targetUiBlockedReason(this.state.context)) void this.checkSession();
    }
  }

  async runJourney(): Promise<void> {
    const c = this.state.context;
    if (!c || targetUiBlockedReason(c) || this.state.journeyPending || this.state.launchPending) return;
    const identity = structuredClone(c), generation = this.generation;
    const controller = this.track();
    this.state.journeyPending = true;
    this.state.outcome = null;
    this.state.status = 'Executing browser journey (headless Chrome/Edge)…';
    this.publish();
    try {
      const outcome = await this.json(controller, '/api/target-ui/journey', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.selection(identity)),
      });
      if (generation !== this.generation) return; // stale journey result is discarded
      const brief = outcome?.evidence?.provenance?.systemSnapshot?.brief;
      if (!outcome?.evidence || !outcome?.evaluation || outcome.evidence.variant !== identity.selectedVariant
        || brief?.id !== identity.systemId || brief?.revision !== identity.revision) {
        throw new Error('Journey response does not match the selected profile, revision and variant');
      }
      this.state.outcome = outcome as TargetUiJourneyOutcomeView;
      this.state.status = 'Browser journey completed';
    } catch (error) {
      if (generation === this.generation && !controller.signal.aborted) this.state.status = `Journey error: ${String(error instanceof Error ? error.message : error)}`;
    } finally {
      this.untrack(controller);
      if (generation === this.generation) { this.state.journeyPending = false; this.publish(); }
    }
  }
}

export function initTargetUiWorkspaceView(onTargetChange: (variant: string) => void): TargetUiWorkspaceController {
  const el = (id: string) => document.getElementById(id);
  const launchBtn = el('btn-launch-target-ui') as HTMLButtonElement;
  const runJourneyBtn = el('btn-run-target-ui') as HTMLButtonElement;
  const closeBtn = el('btn-close-target-ui') as HTMLButtonElement;
  const targetSelect = el('target-ui-target-select') as HTMLSelectElement;
  const downloadBtn = el('btn-download-target-ui-evidence') as HTMLButtonElement;

  const controller = new TargetUiWorkspaceControllerCore((url, init) => fetch(url, init), state => {
    const c = state.context;
    const busy = state.launchPending || state.journeyPending || state.closing;
    const disabled = state.blockedReason !== null || busy;
    if (launchBtn) {
      launchBtn.disabled = disabled || state.session !== null;
      launchBtn.title = state.blockedReason ?? '';
      launchBtn.textContent = state.launchPending ? 'Launching…' : 'Launch Target UI session';
    }
    if (runJourneyBtn) {
      runJourneyBtn.disabled = disabled;
      runJourneyBtn.title = state.blockedReason ?? '';
      runJourneyBtn.textContent = state.journeyPending ? 'Running journey…' : 'Run Target UI journey';
    }
    if (closeBtn) closeBtn.disabled = state.closing || !state.session;
    const display = el('target-ui-system-display') as HTMLInputElement | null;
    if (display) {
      display.value = c?.isDraftMode ? 'New profile (draft)' : `${c?.systemId ?? 'No profile'} · revision ${c?.revision ?? 'unconfirmed'}`;
    }
    if (targetSelect) {
      targetSelect.replaceChildren(...(c?.allowedVariants ?? []).map(v => {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        return opt;
      }));
      targetSelect.value = c?.selectedVariant ?? '';
      targetSelect.disabled = disabled;
    }
    const banner = el('target-ui-eligibility-banner');
    const msg = el('target-ui-eligibility-message');
    if (banner && msg) {
      banner.classList.toggle('hidden', state.blockedReason === null);
      msg.textContent = state.blockedReason ?? '';
    }
    const statusEl = el('target-ui-run-status');
    if (statusEl) statusEl.textContent = state.status;

    const sessionCard = el('target-ui-active-session-card');
    const openLink = el('link-open-target-ui') as HTMLAnchorElement | null;
    const sessionMeta = el('target-ui-session-meta');
    if (sessionCard) {
      sessionCard.classList.toggle('hidden', !state.session);
      if (state.session && openLink && sessionMeta) {
        openLink.href = state.session.endpoint;
        const port = new URL(state.session.endpoint).port;
        const brief = state.session.provenance?.systemSnapshot?.brief;
        sessionMeta.textContent = `${state.session.endpoint} (port ${port}) · Instance: ${state.session.instanceId.slice(0, 8)}… · Variant: ${state.session.variant} · Profile: ${brief?.id ?? '?'} rev ${brief?.revision ?? '?'}${state.session.expiresAt ? ` · Expires: ${state.session.expiresAt}` : ''}`;
      }
    }

    const resultsCard = el('target-ui-results-card');
    if (resultsCard) {
      resultsCard.classList.toggle('hidden', !state.outcome);
      if (state.outcome) {
        const { evidence, evaluation } = state.outcome;
        el('target-ui-result-meta')!.textContent = `Instance ${evidence.instanceId} · Finished ${evidence.finishedAt}`;
        const badge = el('target-ui-result-badge')!;
        badge.textContent = evaluation.status.toUpperCase();
        badge.className = `system-badge badge-${evaluation.status.toLowerCase()}`;
        el('target-ui-stat-exchanges')!.textContent = String(evidence.exchanges.length);
        el('target-ui-stat-events')!.textContent = String(evidence.events.length);
        el('target-ui-stat-observations')!.textContent = String(evidence.uiObservations.length);
        el('target-ui-stat-classification')!.textContent = evaluation.classification;
        const detailsEl = el('target-ui-journey-details')!;
        const list = document.createElement('ul');
        list.style.cssText = 'margin:8px 0 0 16px;padding:0;';
        for (const reason of evaluation.reasons) {
          const item = document.createElement('li');
          item.textContent = reason;
          list.append(item);
        }
        detailsEl.replaceChildren(list);
      }
    }
  });

  launchBtn?.addEventListener('click', () => { void controller.launch(); });
  closeBtn?.addEventListener('click', () => { void controller.close(); });
  runJourneyBtn?.addEventListener('click', () => { void controller.runJourney(); });
  downloadBtn?.addEventListener('click', () => {
    const evidence = controller.state.outcome?.evidence;
    if (!evidence) return;
    const blob = new Blob([JSON.stringify(evidence, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `target-ui-journey-evidence-${evidence.instanceId ?? 'run'}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
  targetSelect?.addEventListener('change', () => onTargetChange(targetSelect.value));
  return controller;
}
