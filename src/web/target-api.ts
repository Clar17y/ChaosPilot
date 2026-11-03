import type { ApiJourneyRecord, ApiJourneySummary, Comparison } from '../target-api/types.ts';
import type { SnapshotLoadState, TargetLoadState } from './workspace.ts';

export interface TargetApiContext {
  systemId: string | null;
  revision: number | null;
  hasSelectedSystem: boolean;
  isDraftMode: boolean;
  hasUnsavedSystemEdits: boolean;
  isSystemSavePending: boolean;
  selectedAdapterId: string | null;
  selectedVariant: string | null;
  allowedVariants: readonly string[];
  snapshotState?: SnapshotLoadState;
  targetState?: TargetLoadState;
}

export interface TargetApiViewState {
  context: TargetApiContext | null;
  pending: boolean;
  comparePending: boolean;
  error: string | null;
  historyError: string | null;
  history: ApiJourneySummary[];
  record: ApiJourneyRecord | null;
  comparison: Comparison | null;
  blockedReason: string | null;
}

export function targetApiBlockedReason(context: TargetApiContext | null, isPending = false): string | null {
  if (isPending) return 'Target API journey execution in progress…';
  if (!context || !context.hasSelectedSystem || !context.systemId) return 'Select a saved system profile';
  if (context.isDraftMode) return 'Save system profile before running target API journeys';
  if (context.hasUnsavedSystemEdits || context.isSystemSavePending) return 'Save pending profile edits before running target API journeys';
  if (context.selectedAdapterId !== 'synthetic-trading') {
    return `Target API journeys only support synthetic-trading (profile uses "${context.selectedAdapterId ?? 'none'}")`;
  }
  if (context.snapshotState !== 'ready') return 'System snapshot not ready';
  if (context.targetState !== 'ready' || !context.selectedVariant) return 'Select a valid target variant';
  return null;
}

export function outcomeBadgeClass(status: string): string {
  switch (status.toLowerCase()) {
    case 'pass':
    case 'match':
      return 'badge-pass';
    case 'fail':
    case 'different':
      return 'badge-fail';
    case 'blocked':
    case 'cancelled':
      return 'badge-blocked';
    default:
      return 'badge-inconclusive';
  }
}

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const raw = (value: unknown) =>
  `<pre style="overflow:auto;max-height:24rem;max-width:100%;box-sizing:border-box;background:rgba(0,0,0,0.2);padding:8px;border-radius:4px;font-size:12px;margin:4px 0 0 0;">${escapeHtml(
    JSON.stringify(value, null, 2),
  )}</pre>`;

export function targetApiResultHtml(record: ApiJourneyRecord, comparison: Comparison | null): string {
  let comparisonHtml = '';
  if (comparison) {
    const badgeClass = outcomeBadgeClass(comparison.status);
    let bannerSummary: string;
    if (comparison.status === 'match') {
      bannerSummary =
        record.status === 'fail'
          ? 'Both runs identically reproduced the expected failure.'
          : 'All business invariants and protocol assertions matched identically.';
    } else if (comparison.status === 'blocked') {
      bannerSummary = 'Semantic rerun comparison is blocked for this configuration.';
    } else {
      bannerSummary = 'Semantic rerun comparison detected differences across runs.';
    }

    const reasonsHtml =
      comparison.reasons.length > 0
        ? `<ul style="margin:8px 0 0 16px;padding:0;">${comparison.reasons
            .map((r) => `<li>${escapeHtml(r)}</li>`)
            .join('')}</ul>`
        : `<p class="muted" style="margin:4px 0 0 0;">${escapeHtml(bannerSummary)}</p>`;

    comparisonHtml = `
      <div class="card target-api-comparison" style="margin-bottom:16px;border-left:4px solid var(--border-color);">
        <div class="rowtop" style="display:flex;justify-content:space-between;align-items:center;">
          <h3 style="margin:0;">Rerun comparison against ${escapeHtml(comparison.originalId)}</h3>
          <span class="system-badge ${badgeClass}">${escapeHtml(comparison.status.toUpperCase())}</span>
        </div>
        <p class="muted" style="margin:8px 0 4px 0;font-size:12px;">${escapeHtml(comparison.note)}</p>
        ${reasonsHtml}
      </div>
    `;
  }

  const journeysHtml = record.journeys
    .map((j) => {
      const badgeClass = outcomeBadgeClass(j.status);
      const passedCount = j.assertions.filter((a) => a.status === 'pass').length;
      const errorHtml = j.error
        ? `<div class="alert-banner" style="margin:8px 0;">Error: ${escapeHtml(j.error)}</div>`
        : '';

      const assertionsRows = j.assertions
        .map(
          (a) => `
          <tr>
            <td><span class="system-badge ${outcomeBadgeClass(a.status)}">${escapeHtml(a.status.toUpperCase())}</span></td>
            <td><code>${escapeHtml(a.id)}</code></td>
            <td><code>${escapeHtml(JSON.stringify(a.expected))}</code></td>
            <td><code>${escapeHtml(JSON.stringify(a.observed))}</code></td>
          </tr>
        `,
        )
        .join('');

      const exchangesHtml = j.exchanges
        .map(
          (e, idx) => `
          <div style="font-size:12px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
            <strong>#${idx + 1} ${escapeHtml(e.method)} ${escapeHtml(e.path)}</strong> &rarr; ${e.status === 0 ? 'No HTTP response' : `HTTP ${e.status}`} (${Math.round(e.elapsedMs)}ms)
            ${e.transportFailure ? `<p>Transport failure: ${escapeHtml(e.transportFailure.kind)} &middot; ${escapeHtml(e.transportFailure.message)}<br>Content type: ${escapeHtml(e.transportFailure.contentType ?? 'not received')} &middot; ${e.transportFailure.capturedBytes}/${e.transportFailure.receivedBytes} bytes captured/received &middot; ${e.transportFailure.complete ? 'body complete' : 'body incomplete'}${e.transportFailure.truncated ? ' &middot; preview truncated' : ''}</p><small>Response text preview:</small>${raw(e.transportFailure.preview)}` : ''}
            <details style="margin-top:2px;"><summary>Request / Response payloads</summary>
              <div class="target-api-payload-grid">
                <div><small>Request:</small>${raw(e.request)}</div>
                <div><small>Response:</small>${raw(e.response)}</div>
              </div>
            </details>
          </div>
        `,
        )
        .join('');

      return `
        <article class="card" style="margin-bottom:16px;">
          <div class="rowtop" style="display:flex;justify-content:space-between;align-items:center;">
            <h3 style="margin:0;">Journey: ${escapeHtml(j.id)}</h3>
            <span class="system-badge ${badgeClass}">${escapeHtml(j.status.toUpperCase())}</span>
          </div>
          <p class="muted" style="margin:4px 0 8px 0;font-size:13px;">
            ${passedCount}/${j.assertions.length} assertions passed &bull; ${j.exchanges.length} HTTP exchanges on loopback target
          </p>
          ${errorHtml}
          <div style="overflow-x:auto;margin:8px 0;">
            <table class="data-table" style="width:100%;font-size:12px;border-collapse:collapse;">
              <thead>
                <tr>
                  <th style="text-align:left;width:90px;">Status</th>
                  <th style="text-align:left;">Assertion</th>
                  <th style="text-align:left;">Expected</th>
                  <th style="text-align:left;">Observed</th>
                </tr>
              </thead>
              <tbody>${assertionsRows}</tbody>
            </table>
          </div>
          <details style="margin-top:8px;">
            <summary style="cursor:pointer;font-size:12px;">HTTP Exchanges & Correlated Wire Traffic (${j.exchanges.length})</summary>
            <div style="margin-top:8px;">${exchangesHtml}</div>
          </details>
          <details style="margin-top:6px;">
            <summary style="cursor:pointer;font-size:12px;">Full journey evidence (JSON)</summary>
            <div style="margin-top:6px;">${raw(j)}</div>
          </details>
        </article>
      `;
    })
    .join('');

  return `
    ${comparisonHtml}
    <p style="font-size:13px;margin:0 0 8px 0;">
      Saved run <code>${escapeHtml(record.id)}</code> &bull; ${escapeHtml(record.systemSnapshot.brief.name)} (<code>${escapeHtml(
    record.systemSnapshot.brief.id,
  )}</code>) &bull; revision ${record.systemSnapshot.brief.revision} &bull; target <strong>${escapeHtml(
    record.variant,
  )}</strong>
    </p>
    <details style="margin-bottom:16px;">
      <summary style="cursor:pointer;font-size:12px;">Pinned source, contract, transport & evaluator identities</summary>
      <div style="margin-top:6px;">
        ${raw({
          sourceHash: record.sourceHash,
          transport: record.transport,
          evaluator: record.evaluator,
          contractHash: record.contractHash,
          integrity: record.integrity,
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
        })}
      </div>
    </details>
    <div class="target-api-journeys-list">${journeysHtml}</div>
  `;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

export class TargetApiController {
  readonly state: TargetApiViewState = {
    context: null,
    pending: false,
    comparePending: false,
    error: null,
    historyError: null,
    history: [],
    record: null,
    comparison: null,
    blockedReason: 'Select a saved system profile',
  };

  private generation = 0;
  private inspection = 0;
  private historyRequest = 0;

  constructor(
    private readonly fetchFn: FetchFn,
    private readonly render: (state: TargetApiViewState) => void,
  ) {}

  setContext(context: TargetApiContext): void {
    if (JSON.stringify(context) === JSON.stringify(this.state.context)) return;
    this.generation++;
    this.inspection++;
    this.historyRequest++;
    Object.assign(this.state, {
      context: structuredClone(context),
      pending: false,
      comparePending: false,
      record: null,
      comparison: null,
      error: null,
      historyError: null,
      history: [],
    });
    this.publish();
    if (context.systemId && !context.isDraftMode && context.selectedAdapterId === 'synthetic-trading') {
      void this.loadHistory();
    }
  }

  private publish(): void {
    this.state.blockedReason = targetApiBlockedReason(
      this.state.context,
      this.state.pending || this.state.comparePending,
    );
    this.render(this.state);
  }

  private async json(url: string, init?: RequestInit): Promise<any> {
    const res = await this.fetchFn(url, init);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data;
  }

  async loadHistory(): Promise<void> {
    const generation = this.generation;
    const request = ++this.historyRequest;
    const systemId = this.state.context?.systemId;
    try {
      const runs = (await this.json('/api/target-api/runs')) as ApiJourneySummary[];
      if (generation !== this.generation || request !== this.historyRequest) return;
      this.state.history = systemId ? runs.filter((r) => r.systemBrief.id === systemId) : runs;
      this.state.historyError = null;
    } catch (error) {
      if (generation !== this.generation || request !== this.historyRequest) return;
      this.state.historyError = String(error);
    }
    this.publish();
  }

  async run(): Promise<void> {
    const c = this.state.context;
    if (
      !c ||
      targetApiBlockedReason(c, this.state.pending) ||
      !c.systemId ||
      c.revision === null ||
      !c.selectedVariant
    ) {
      return;
    }

    const generation = this.generation;
    const inspection = ++this.inspection;
    const identity = structuredClone(c);
    this.state.pending = true;
    this.state.error = null;
    this.state.record = null;
    this.state.comparison = null;
    this.publish();

    const isCurrent = () => generation === this.generation && inspection === this.inspection;

    try {
      const record = (await this.json('/api/target-api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemId: identity.systemId,
          expectedRevision: identity.revision,
          variant: identity.selectedVariant,
        }),
      })) as ApiJourneyRecord;

      if (!isCurrent()) return;
      if (
        record.systemSnapshot.brief.id !== identity.systemId ||
        record.systemSnapshot.brief.revision !== identity.revision ||
        record.variant !== identity.selectedVariant
      ) {
        throw new Error('Run response identity does not match launch selection');
      }

      this.state.record = record;
      void this.loadHistory();
    } catch (error) {
      if (isCurrent()) {
        this.state.error = String(error);
      }
    } finally {
      if (isCurrent()) {
        this.state.pending = false;
        this.publish();
      }
    }
  }

  async open(id: string): Promise<void> {
    const generation = this.generation;
    const inspection = ++this.inspection;
    this.historyRequest++;
    this.state.pending = false;
    this.state.comparePending = false;
    this.state.record = null;
    this.state.comparison = null;
    this.state.error = null;
    this.publish();

    const isCurrent = () => generation === this.generation && inspection === this.inspection;

    try {
      const record = (await this.json(`/api/target-api/runs/${encodeURIComponent(id)}`)) as ApiJourneyRecord;
      if (!isCurrent()) return;
      if (record.id !== id || record.systemSnapshot.brief.id !== this.state.context?.systemId) {
        throw new Error('Historical response identity mismatch');
      }
      this.state.record = record;
    } catch (error) {
      if (isCurrent()) {
        this.state.error = String(error);
      }
    } finally {
      if (isCurrent()) {
        this.publish();
      }
    }
  }

  async rerunAndCompare(): Promise<void> {
    const c = this.state.context;
    const originalRecord = this.state.record;
    if (
      !c ||
      !originalRecord ||
      targetApiBlockedReason(c, this.state.comparePending) ||
      !c.systemId ||
      c.revision === null ||
      !c.selectedVariant
    ) {
      return;
    }

    const generation = this.generation;
    const inspection = ++this.inspection;
    const identity = structuredClone(c);
    this.state.comparePending = true;
    this.state.error = null;
    this.publish();

    const isCurrent = () => generation === this.generation && inspection === this.inspection;

    try {
      const result = (await this.json('/api/target-api/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originalRunId: originalRecord.id,
          systemId: identity.systemId,
          expectedRevision: identity.revision,
          variant: identity.selectedVariant,
        }),
      })) as { comparison: Comparison; freshRecord: ApiJourneyRecord };

      if (!isCurrent()) return;
      if (
        result.freshRecord.systemSnapshot.brief.id !== identity.systemId ||
        result.freshRecord.systemSnapshot.brief.revision !== identity.revision ||
        result.freshRecord.variant !== identity.selectedVariant
      ) {
        throw new Error('Compare response identity does not match launch selection');
      }
      this.state.record = result.freshRecord;
      this.state.comparison = result.comparison;
      void this.loadHistory();
    } catch (error) {
      if (isCurrent()) {
        this.state.error = String(error);
      }
    } finally {
      if (isCurrent()) {
        this.state.comparePending = false;
        this.publish();
      }
    }
  }
}

export function initTargetApiWorkspaceView(onTargetChange: (variant: string) => void): TargetApiController {
  const el = (id: string) => document.getElementById(id);
  const runBtn = el('btn-run-target-api') as HTMLButtonElement | null;
  const compareBtn = el('btn-compare-target-api') as HTMLButtonElement | null;
  const targetSelect = el('target-api-target-select') as HTMLSelectElement | null;

  const controller = new TargetApiController(
    (url, init) => fetch(url, init),
    (state) => {
      const c = state.context;
      const isBlocked = state.blockedReason !== null;

      if (runBtn) {
        runBtn.disabled = isBlocked;
        runBtn.title = state.blockedReason ?? '';
        runBtn.textContent = state.pending ? 'Running API journeys…' : 'Run API journeys';
      }

      if (compareBtn) {
        const cannotCompare = isBlocked || !state.record;
        compareBtn.disabled = cannotCompare;
        compareBtn.title = state.record
          ? state.blockedReason ?? 'Rerun current variant and compare against opened evidence'
          : 'Run or open a journey record first to enable rerun comparison';
        compareBtn.textContent = state.comparePending ? 'Comparing…' : 'Rerun & Compare';
      }

      const display = el('target-api-system-display') as HTMLInputElement | null;
      if (display) {
        display.value = c?.isDraftMode
          ? 'New profile (draft)'
          : `${c?.systemId ?? 'No profile'} · revision ${c?.revision ?? 'unconfirmed'}`;
      }

      if (targetSelect) {
        targetSelect.replaceChildren(
          ...(c?.allowedVariants ?? []).map((v) => {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v;
            return opt;
          }),
        );
        targetSelect.value = c?.selectedVariant ?? '';
        targetSelect.disabled =
          c?.targetState !== 'ready' ||
          c?.isDraftMode === true ||
          c?.hasUnsavedSystemEdits === true ||
          c?.isSystemSavePending === true;
      }

      const banner = el('target-api-eligibility-banner');
      if (banner) {
        banner.classList.toggle('hidden', state.blockedReason === null);
        const msg = el('target-api-eligibility-message');
        if (msg) msg.textContent = state.blockedReason ?? '';
      }

      const statusEl = el('target-api-run-status');
      if (statusEl) {
        statusEl.textContent =
          state.error ??
          (state.pending
            ? 'Executing real target HTTP journeys on loopback…'
            : state.comparePending
            ? 'Executing fresh journey and comparing evidence…'
            : '');
      }

      const historyEl = el('target-api-history-list');
      if (historyEl) {
        historyEl.replaceChildren();
        if (state.historyError || !state.history.length) {
          historyEl.textContent = state.historyError ?? 'No saved target API journey runs for this profile.';
        } else {
          for (const item of state.history) {
            const row = document.createElement('p');
            row.style.margin = '6px 0';
            row.style.display = 'flex';
            row.style.justifyContent = 'space-between';
            row.style.alignItems = 'center';

            const info = document.createElement('span');
            info.textContent = `${item.startedAt} · rev ${item.systemBrief.revision} · ${item.variant} · ${item.status.toUpperCase()} `;

            const openBtn = document.createElement('button');
            openBtn.textContent = 'Open';
            openBtn.type = 'button';
            openBtn.className = 'btn btn-secondary';
            openBtn.style.padding = '2px 8px';
            openBtn.style.fontSize = '12px';
            openBtn.addEventListener('click', () => {
              void controller.open(item.id);
            });

            row.append(info, openBtn);
            historyEl.append(row);
          }
        }
      }

      const resultsCard = el('target-api-results-card');
      if (resultsCard) {
        resultsCard.classList.toggle('hidden', !state.record);
      }

      const container = el('target-api-journeys-container');
      if (container && state.record) {
        container.innerHTML = targetApiResultHtml(state.record, state.comparison);
      }

      const metaEl = el('target-api-run-meta');
      if (metaEl && state.record) {
        metaEl.textContent = `Saved ${state.record.systemSnapshot.brief.id} rev ${state.record.systemSnapshot.brief.revision} · ${state.record.variant} · ${state.record.id}`;
      }

      const badgeEl = el('target-api-run-badge');
      if (badgeEl && state.record) {
        badgeEl.textContent = state.record.status.toUpperCase();
        badgeEl.className = `system-badge ${outcomeBadgeClass(state.record.status)}`;
      }

      const statJourneys = el('target-api-stat-journeys');
      if (statJourneys && state.record) {
        const passed = state.record.journeys.filter((j) => j.status === 'pass').length;
        statJourneys.textContent = `${passed}/${state.record.journeys.length}`;
      }

      const statAssertions = el('target-api-stat-assertions');
      if (statAssertions && state.record) {
        const total = state.record.journeys.flatMap((j) => j.assertions);
        const passed = total.filter((a) => a.status === 'pass').length;
        statAssertions.textContent = `${passed}/${total.length}`;
      }

      const statStatus = el('target-api-stat-status');
      if (statStatus && state.record) {
        statStatus.textContent = state.record.status.toUpperCase();
      }
    },
  );

  runBtn?.addEventListener('click', () => {
    void controller.run();
  });
  compareBtn?.addEventListener('click', () => {
    void controller.rerunAndCompare();
  });
  targetSelect?.addEventListener('change', () => {
    if (targetSelect.value) onTargetChange(targetSelect.value);
  });

  void fetch('/api/target-api/catalog')
    .then(async (response) => {
      if (!response.ok) throw new Error('Catalog unavailable');
      const items = (await response.json()) as { id: string; name: string; checkpointCount: number }[];
      const catalogEl = el('target-api-catalog-list');
      if (catalogEl) {
        catalogEl.innerHTML = items
          .map(
            (i) =>
              `<div style="margin-bottom:8px;"><strong>${escapeHtml(i.name)}</strong> (<code>${escapeHtml(
                i.id,
              )}</code>)<br><small class="muted">${i.checkpointCount} ordered milestones &bull; real HTTP</small></div>`,
          )
          .join('');
      }
    })
    .catch(() => {
      const catalogEl = el('target-api-catalog-list');
      if (catalogEl) catalogEl.textContent = 'Scenario catalog unavailable.';
    });

  return controller;
}
