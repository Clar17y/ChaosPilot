import type { Finding, InvestigationRecord } from '../domain.ts';
import { resolveExperimentPositionForIndex } from '../experiment-identity.ts';
import type {
  RegressionDefinitionDetail,
  RegressionDefinitionRecord,
  RegressionDefinitionSummary,
  RegressionPreviewResult,
  RegressionRunRecord,
  RegressionRunSummary,
} from '../regressions/types.ts';
import { challengeRecordHash } from './challenges.ts';
import {
  functionalRunOutcomeLabel,
  partitionRegressionDefinitions,
  partitionRegressionRuns,
  regressionCaptureBlockedReason,
  regressionExecutionBlockedReason,
  type SnapshotLoadState,
  type TargetLoadState,
} from './workspace.ts';

export interface RegressionWorkspaceContext {
  systemId: string | null;
  revision: number | null;
  hasSelectedSystem: boolean;
  selectedAdapterId: string | null;
  isDraftMode: boolean;
  hasUnsavedSystemEdits: boolean;
  isSystemSavePending?: boolean;
  snapshotState?: SnapshotLoadState;
  targetState?: TargetLoadState;
  selectedVariant?: string | null;
  allowedVariants?: readonly string[];
}

export interface RegressionViewState {
  context: RegressionWorkspaceContext | null;
  runId: string | null;
  findingId: string | null;
  findingTitle: string | null;
  findingConfirmed: boolean;
  waitsForSave: boolean;
  previewPending: boolean;
  savePending: boolean;
  reviewedConsent: boolean;
  preview: RegressionPreviewResult | null;
  savedDefinition: RegressionDefinitionRecord | null;
  captureError: string | null;
  captureBlockedReason: string | null;
  canSaveCapture: boolean;
  runPending: boolean;
  runError: string | null;
  listError: string | null;
  definitions: RegressionDefinitionSummary[];
  runs: RegressionRunSummary[];
  selectedDefinitionId: string | null;
  definitionDetail: RegressionDefinitionDetail | null;
  runRecord: RegressionRunRecord | null;
  executionBlockedReason: string | null;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

function resolveConfirmedFinding(
  record: InvestigationRecord | null,
  findingId: string | null,
): { finding: Finding | null; confirmed: boolean } {
  if (!record || !findingId) return { finding: null, confirmed: false };
  const matches = record.findings.filter(f => f?.id === findingId);
  if (matches.length !== 1) return { finding: null, confirmed: false };
  const finding = matches[0]!;
  const pos = resolveExperimentPositionForIndex(record.experiments, finding.experimentIndex);
  const exp = pos >= 0 ? record.experiments[pos] : undefined;
  const confirmed =
    finding.reproduced === true &&
    finding.cleanControlPassed === true &&
    exp?.replayVerified === true &&
    exp?.cleanControlPassed === true &&
    exp?.result?.valid === true &&
    exp?.result?.executionComplete !== false;
  return { finding, confirmed };
}

/**
 * Single owner for workspace context, finding selection, preview/save consent,
 * and saved regression execution/history transitions.
 */
export class RegressionController {
  readonly state: RegressionViewState = {
    context: null,
    runId: null,
    findingId: null,
    findingTitle: null,
    findingConfirmed: false,
    waitsForSave: false,
    previewPending: false,
    savePending: false,
    reviewedConsent: false,
    preview: null,
    savedDefinition: null,
    captureError: null,
    captureBlockedReason: 'SELECT A SAVED SYSTEM PROFILE',
    canSaveCapture: false,
    runPending: false,
    runError: null,
    listError: null,
    definitions: [],
    runs: [],
    selectedDefinitionId: null,
    definitionDetail: null,
    runRecord: null,
    executionBlockedReason: 'SELECT A SAVED SYSTEM PROFILE',
  };

  private generation = 0;
  private captureSeq = 0;
  private inspectionSeq = 0;
  private listSeq = 0;
  private findingSelectionKey = '';
  private findingRecord: InvestigationRecord | null = null;

  constructor(
    private readonly fetchFn: Fetch,
    private readonly render: (state: RegressionViewState) => void,
  ) {}

  setContext(context: RegressionWorkspaceContext): void {
    if (JSON.stringify(context) === JSON.stringify(this.state.context)) return;
    this.generation++;
    this.captureSeq++;
    this.inspectionSeq++;
    this.listSeq++;
    Object.assign(this.state, {
      context: structuredClone(context),
      previewPending: false,
      savePending: false,
      reviewedConsent: false,
      preview: null,
      savedDefinition: null,
      captureError: null,
      runPending: false,
      runError: null,
      listError: null,
      definitions: [],
      runs: [],
      selectedDefinitionId: null,
      definitionDetail: null,
      runRecord: null,
    });
    this.publish();
    if (context.systemId && !context.isDraftMode) {
      void this.loadList();
    }
  }

  selectFinding(
    record: InvestigationRecord | null,
    findingId: string | null,
    waitsForSave = false,
  ): void {
    const key = record && findingId ? JSON.stringify([record, findingId, waitsForSave]) : '';
    if (key === this.findingSelectionKey) return;
    this.findingSelectionKey = key;
    this.captureSeq++;
    this.findingRecord = record ? structuredClone(record) : null;
    const { finding, confirmed } = resolveConfirmedFinding(this.findingRecord, findingId);
    Object.assign(this.state, {
      runId: record?.id ?? null,
      findingId,
      findingTitle: finding?.title ?? null,
      findingConfirmed: confirmed,
      waitsForSave,
      previewPending: false,
      savePending: false,
      reviewedConsent: false,
      preview: null,
      savedDefinition: null,
      captureError: null,
    });
    this.publish();
  }

  setReviewedConsent(reviewed: boolean): void {
    if (
      !this.state.preview ||
      !this.state.preview.available ||
      this.state.previewPending ||
      this.state.savePending ||
      this.state.captureBlockedReason !== null
    ) {
      this.state.reviewedConsent = false;
      this.publish();
      return;
    }
    this.state.reviewedConsent = Boolean(reviewed);
    this.publish();
  }

  private computeCaptureBlockedReason(): string | null {
    const c = this.state.context;
    if (!c) return 'SELECT A SAVED SYSTEM PROFILE';
    return regressionCaptureBlockedReason({
      isSystemSavePending: c.isSystemSavePending,
      isDraftMode: c.isDraftMode,
      hasUnsavedSystemEdits: c.hasUnsavedSystemEdits,
      hasSelectedSystem: c.hasSelectedSystem,
      selectedSystemId: c.systemId,
      selectedAdapterId: c.selectedAdapterId,
      snapshotState: c.snapshotState,
      isCapturePending: this.state.previewPending || this.state.savePending,
      hasInspectedRun: Boolean(this.findingRecord),
      inspectedRunTerminal: Boolean(this.findingRecord && this.findingRecord.status !== 'running'),
      inspectedRunSystemId: this.findingRecord?.systemBrief?.brief.id ?? null,
      waitsForSave: this.state.waitsForSave,
      hasSelectedFinding: Boolean(this.state.findingId),
      findingConfirmed: this.state.findingId ? this.state.findingConfirmed : undefined,
    });
  }

  private computeExecutionBlockedReason(): string | null {
    const c = this.state.context;
    if (!c) return 'SELECT A SAVED SYSTEM PROFILE';
    return regressionExecutionBlockedReason({
      isSystemSavePending: c.isSystemSavePending,
      snapshotState: c.snapshotState,
      targetState: c.targetState,
      isRegressionRunPending: this.state.runPending,
      isDraftMode: c.isDraftMode,
      hasUnsavedSystemEdits: c.hasUnsavedSystemEdits,
      selectedAdapterId: c.selectedAdapterId,
      hasSelectedSystem: c.hasSelectedSystem,
      selectedVariant: c.selectedVariant,
      allowedVariants: c.allowedVariants,
      hasSelectedDefinition: Boolean(this.state.selectedDefinitionId),
    });
  }

  private publish(): void {
    this.state.captureBlockedReason = this.computeCaptureBlockedReason();
    this.state.canSaveCapture =
      this.state.captureBlockedReason === null &&
      this.state.preview?.available === true &&
      this.state.reviewedConsent === true &&
      !this.state.previewPending &&
      !this.state.savePending;
    this.state.executionBlockedReason = this.computeExecutionBlockedReason();
    this.render(this.state);
  }

  private async json(url: string, init?: RequestInit): Promise<any> {
    const res = await this.fetchFn(url, init);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data;
  }

  async preview(): Promise<void> {
    if (
      this.computeCaptureBlockedReason() !== null ||
      !this.findingRecord ||
      !this.state.findingId
    ) {
      return;
    }
    const record = structuredClone(this.findingRecord);
    const findingId = this.state.findingId;
    const systemId = this.state.context?.systemId ?? null;
    const generation = this.generation;
    const seq = ++this.captureSeq;

    this.state.previewPending = true;
    this.state.savePending = false;
    this.state.reviewedConsent = false;
    this.state.preview = null;
    this.state.savedDefinition = null;
    this.state.captureError = null;
    this.publish(); // Establish pending ownership before the first await.

    const current = () => generation === this.generation && seq === this.captureSeq;
    try {
      const expectedEvidenceHash = await challengeRecordHash(record);
      if (!current()) return;
      const preview = (await this.json('/api/regressions/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: record.id,
          findingId,
          expectedEvidenceHash,
        }),
      })) as RegressionPreviewResult;
      if (!current()) return;
      if (
        !preview ||
        preview.runId !== record.id ||
        preview.findingId !== findingId ||
        preview.evidenceHash !== expectedEvidenceHash ||
        typeof preview.runRevision !== 'string'
      ) {
        throw new Error('Preview response identity does not match the selected finding');
      }
      if (
        preview.available &&
        (preview.origin.runId !== record.id ||
          preview.origin.findingId !== findingId ||
          preview.origin.systemBrief.id !== systemId)
      ) {
        throw new Error('Preview origin identity does not match the selected workspace profile');
      }
      this.state.preview = preview;
    } catch (error) {
      if (current()) {
        this.state.captureError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (current()) {
        this.state.previewPending = false;
        this.publish();
      }
    }
  }

  async save(): Promise<void> {
    if (
      this.computeCaptureBlockedReason() !== null ||
      !this.state.preview ||
      !this.state.preview.available ||
      !this.state.reviewedConsent ||
      this.state.previewPending ||
      this.state.savePending
    ) {
      return;
    }
    const preview = structuredClone(this.state.preview);
    const systemId = this.state.context?.systemId ?? null;
    const generation = this.generation;
    const seq = ++this.captureSeq;

    this.state.savePending = true;
    this.state.captureError = null;
    this.publish(); // Establish pending ownership before the first await.

    const current = () => generation === this.generation && seq === this.captureSeq;
    try {
      const saved = (await this.json('/api/regressions/definitions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: preview.runId,
          findingId: preview.findingId,
          expectedRunRevision: preview.runRevision,
          expectedEvidenceHash: preview.evidenceHash,
          reviewToken: preview.reviewToken,
          definitionId: preview.definitionId,
          contentHash: preview.contentHash,
          reviewed: true,
        }),
      })) as RegressionDefinitionRecord;
      if (!current()) return;
      if (
        saved.id !== preview.definitionId ||
        saved.contentHash !== preview.contentHash ||
        saved.origin.runId !== preview.runId ||
        saved.origin.findingId !== preview.findingId ||
        saved.origin.systemBrief.id !== systemId
      ) {
        throw new Error('Saved regression definition identity does not match reviewed preview');
      }
      this.state.savedDefinition = saved;
      this.state.selectedDefinitionId = saved.id;
      void this.loadList();
    } catch (error) {
      if (current()) {
        this.state.captureError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (current()) {
        this.state.savePending = false;
        this.publish();
      }
    }
  }

  async loadList(): Promise<void> {
    const generation = this.generation;
    const request = ++this.listSeq;
    const systemId = this.state.context?.systemId ?? null;
    try {
      const [definitions, runs] = (await Promise.all([
        this.json('/api/regressions/definitions'),
        this.json('/api/regressions/runs'),
      ])) as [RegressionDefinitionSummary[], RegressionRunSummary[]];
      if (generation !== this.generation || request !== this.listSeq) return;
      const scopedDefs = partitionRegressionDefinitions(definitions, systemId).scoped;
      const scopedRuns = partitionRegressionRuns(runs, systemId).scoped;
      this.state.definitions = scopedDefs;
      this.state.runs = scopedRuns;
      if (
        !this.state.selectedDefinitionId ||
        !scopedDefs.some(d => d.id === this.state.selectedDefinitionId)
      ) {
        this.state.selectedDefinitionId = scopedDefs[0]?.id ?? null;
      }
      this.state.listError = null;
    } catch (error) {
      if (generation !== this.generation || request !== this.listSeq) return;
      this.state.listError = error instanceof Error ? error.message : String(error);
    }
    this.publish();
  }

  selectDefinition(definitionId: string | null): void {
    if (definitionId === this.state.selectedDefinitionId) return;
    if (definitionId !== null && !this.state.definitions.some(d => d.id === definitionId)) return;
    this.inspectionSeq++;
    this.state.selectedDefinitionId = definitionId;
    this.state.runPending = false;
    this.state.runError = null;
    this.state.definitionDetail = null;
    this.state.runRecord = null;
    this.publish();
    if (definitionId) {
      void this.openDefinition(definitionId);
    }
  }

  async openDefinition(definitionId: string): Promise<void> {
    if (!this.state.definitions.some(d => d.id === definitionId)) return;
    const generation = this.generation;
    const inspection = ++this.inspectionSeq;
    this.listSeq++;
    const systemId = this.state.context?.systemId ?? null;

    this.state.selectedDefinitionId = definitionId;
    this.state.runPending = false;
    this.state.runError = null;
    this.state.definitionDetail = null;
    this.state.runRecord = null;
    this.publish();

    const current = () => generation === this.generation && inspection === this.inspectionSeq;
    try {
      const detail = (await this.json(
        `/api/regressions/definitions/${encodeURIComponent(definitionId)}`,
      )) as RegressionDefinitionDetail;
      if (!current()) return;
      if (
        detail.definition?.id !== definitionId ||
        detail.definition?.origin?.systemBrief?.id !== systemId
      ) {
        throw new Error('Definition detail response identity mismatch');
      }
      this.state.definitionDetail = detail;
    } catch (error) {
      if (current()) {
        this.state.runError = error instanceof Error ? error.message : String(error);
      }
    }
    if (current()) this.publish();
  }

  async run(): Promise<void> {
    const c = this.state.context;
    const definitionId = this.state.selectedDefinitionId;
    if (
      !c ||
      !definitionId ||
      this.computeExecutionBlockedReason() !== null ||
      !c.systemId ||
      c.revision === null ||
      !c.selectedVariant
    ) {
      return;
    }
    const identity = structuredClone(c);
    const generation = this.generation;
    const inspection = ++this.inspectionSeq;

    this.state.runPending = true;
    this.state.runError = null;
    this.state.runRecord = null;
    this.publish(); // Establish pending ownership before the first await.

    const current = () => generation === this.generation && inspection === this.inspectionSeq;
    try {
      const record = (await this.json('/api/regressions/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definitionId,
          systemId: identity.systemId,
          expectedRevision: identity.revision,
          variant: identity.selectedVariant,
        }),
      })) as RegressionRunRecord;
      if (!current()) return;
      if (
        record.definitionId !== definitionId ||
        record.origin?.systemBrief?.id !== identity.systemId ||
        record.adapterId !== identity.selectedAdapterId ||
        record.variant !== identity.selectedVariant
      ) {
        throw new Error('Regression run response identity does not match launch');
      }
      this.state.runRecord = record;
      void this.loadList();
    } catch (error) {
      if (current()) {
        this.state.runError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (current()) {
        this.state.runPending = false;
        this.publish();
      }
    }
  }

  async openRun(runId: string): Promise<void> {
    const knownInRuns = this.state.runs.some(r => r.id === runId);
    const knownInDetail = this.state.definitionDetail?.runs.some(r => r.id === runId) === true;
    if (!knownInRuns && !knownInDetail) return;

    const generation = this.generation;
    const inspection = ++this.inspectionSeq;
    this.listSeq++;
    const systemId = this.state.context?.systemId ?? null;

    this.state.runPending = false;
    this.state.runRecord = null;
    this.state.runError = null;
    this.publish();

    const current = () => generation === this.generation && inspection === this.inspectionSeq;
    try {
      const record = (await this.json(
        `/api/regressions/runs/${encodeURIComponent(runId)}`,
      )) as RegressionRunRecord;
      if (!current()) return;
      if (record.id !== runId || record.origin?.systemBrief?.id !== systemId) {
        throw new Error('Historical regression run identity mismatch');
      }
      this.state.runRecord = record;
    } catch (error) {
      if (current()) {
        this.state.runError = error instanceof Error ? error.message : String(error);
      }
    }
    if (current()) this.publish();
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
  `<pre style="overflow:auto;max-height:32rem">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;

export function setHtmlPreservingDisclosures(
  host: HTMLElement,
  cache: WeakMap<HTMLElement, string>,
  key: string,
  html: string,
): void {
  if (cache.get(host) === key) return;
  const openKeys = new Set(
    Array.from(host.querySelectorAll<HTMLDetailsElement>('details[data-disclosure-key]'))
      .filter(d => d.open)
      .map(d => d.dataset.disclosureKey!),
  );
  cache.set(host, key);
  host.innerHTML = html;
  for (const details of Array.from(
    host.querySelectorAll<HTMLDetailsElement>('details[data-disclosure-key]'),
  )) {
    if (details.dataset.disclosureKey && openKeys.has(details.dataset.disclosureKey)) {
      details.open = true;
    }
  }
}

export function regressionPreviewHtml(
  preview: Extract<RegressionPreviewResult, { available: true }>,
  currentWorkspaceRevision: number | null,
): string {
  const originRev = preview.origin.systemBrief.revision;
  const revDiffNotice =
    currentWorkspaceRevision !== null && currentWorkspaceRevision !== originRev
      ? `<p class="note warn">Current workspace profile is revision ${currentWorkspaceRevision}; this regression definition pins original brief revision ${originRev} from run ${escapeHtml(preview.runId)}. It does not claim to verify unpinned prose edits.</p>`
      : '';

  return `<div class="regression-preview-summary">
    <p><strong>${escapeHtml(preview.expected.referenceProvenance.reviewLabel)}</strong></p>
    <p class="muted">${escapeHtml(preview.expected.referenceProvenance.note)}</p>
    ${revDiffNotice}
    <p>Proposed definition ID: <code>${escapeHtml(preview.definitionId)}</code> · Origin run <code>${escapeHtml(preview.runId)}</code> · Finding <code>${escapeHtml(preview.findingId)}</code> (experiment #${preview.origin.experimentIndex}) · Pinned brief <code>${escapeHtml(preview.origin.systemBrief.id)}</code> rev ${originRev} · Original target <code>${escapeHtml(preview.origin.variant)}</code> (<code>${escapeHtml(preview.origin.sourceHash)}</code>) · Clean reference source <code>${escapeHtml(preview.origin.cleanSourceHash)}</code></p>
    ${preview.existingDefinitionId ? `<p class="note">This exact finding and expectation set is already saved as regression definition <code>${escapeHtml(preview.existingDefinitionId)}</code>.</p>` : ''}
    <details data-disclosure-key="preview-deliveries" open>
      <summary>Proposed delivery decisions and business-state assertions (${preview.expected.deliveries.length} delivery milestone(s))</summary>
      <div style="overflow:auto">
        <table>
          <thead><tr><th>Step / Trace</th><th>Message</th><th>Expected Decision</th><th>Expected Credit / Quote</th><th>Expected Orders &amp; Absence</th></tr></thead>
          <tbody>
            ${preview.expected.deliveries
              .map(
                d => `<tr>
              <td>Step ${d.step + 1} (trace ${d.traceIndex}, ${escapeHtml(d.action)})</td>
              <td><code>${escapeHtml(d.messageId)}</code> (${escapeHtml(d.channel)} / ${escapeHtml(d.messageType)})</td>
              <td><strong>${escapeHtml(d.expectedStatus)}</strong>${d.expectedReason ? ` (${escapeHtml(d.expectedReason)})` : ''}${d.expectedState.stateUnchangedFromPrevious ? ' · state unchanged' : ''}</td>
              <td>used=${d.expectedState.usedCredit}, reserved=${d.expectedState.reservedCredit}, limit=${d.expectedState.creditLimit?.limit ?? 'null'}, quote=${d.expectedState.quote ? `${escapeHtml(d.expectedState.quote.id)}@${d.expectedState.quote.price}(v${d.expectedState.quote.version})` : 'null'}</td>
              <td>orders=${escapeHtml(JSON.stringify(d.expectedState.orders))} · absent=${escapeHtml(JSON.stringify(d.expectedState.absentOrderIds))}</td>
            </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </details>
    <details data-disclosure-key="preview-origin">
      <summary>Pinned origin, sequence steps, final state and review token</summary>
      ${raw({
        definitionId: preview.definitionId,
        contentHash: preview.contentHash,
        reviewToken: preview.reviewToken,
        experiment: preview.experiment,
        expectedFinalState: preview.expected.finalState,
        evaluator: preview.evaluator,
        origin: {
          runId: preview.origin.runId,
          runRevision: preview.origin.runRevision,
          evidenceHash: preview.origin.evidenceHash,
          findingId: preview.origin.findingId,
          experimentIndex: preview.origin.experimentIndex,
          variant: preview.origin.variant,
          sourceHash: preview.origin.sourceHash,
          cleanSourceHash: preview.origin.cleanSourceHash,
          contractHash: preview.origin.contractHash,
          systemBrief: preview.origin.systemBrief,
        },
      })}
    </details>
  </div>`;
}

export function regressionDefinitionDetailHtml(
  detail: RegressionDefinitionDetail,
  currentWorkspaceRevision: number | null,
): string {
  const def = detail.definition;
  const originRev = def.origin.systemBrief.revision;
  const revDiffNotice =
    currentWorkspaceRevision !== null && currentWorkspaceRevision !== originRev
      ? `<p class="note warn">Workspace profile is currently at revision ${currentWorkspaceRevision}, whereas this regression definition is permanently pinned to original brief revision ${originRev} (${escapeHtml(def.origin.systemBrief.hash)}). Executing this regression evaluates against the pinned original brief/rules and reviewed expectations, never unpinned prose edits.</p>`
      : `<p class="muted">Pinned original brief revision ${originRev} matches current workspace revision.</p>`;

  const originBadge = detail.originStatus.available
    ? `Origin investigation run ${escapeHtml(detail.originStatus.runId)} verified on disk.`
    : `Origin investigation run ${escapeHtml(detail.originStatus.runId)} is ${escapeHtml(detail.originStatus.status)}: ${escapeHtml(detail.originStatus.reason ?? 'Unavailable on disk; using saved origin snapshot.')}`;

  return `<article class="card" style="margin-top: 12px;">
    <h3>Definition ${escapeHtml(def.id)} — ${escapeHtml(def.origin.finding.title)}</h3>
    <p>Original finding invariant: <code>${escapeHtml(def.origin.finding.violation.invariant)}</code> · Original target: <code>${escapeHtml(def.origin.variant)}</code> (lineage source <code>${escapeHtml(def.origin.sourceHash)}</code>) · Clean reference source: <code>${escapeHtml(def.origin.cleanSourceHash)}</code></p>
    <p>${originBadge}</p>
    ${revDiffNotice}
    <p class="muted">${escapeHtml(def.expected.referenceProvenance.reviewLabel)} — ${escapeHtml(def.expected.referenceProvenance.note)}</p>
    <details data-disclosure-key="def-expectations-${escapeHtml(def.id)}">
      <summary>Reviewed expected delivery outcomes and business states (${def.expected.deliveries.length} delivery milestone(s))</summary>
      ${raw(def.expected)}
    </details>
    <details data-disclosure-key="def-origin-${escapeHtml(def.id)}">
      <summary>Pinned original experiment, violation, trace and brief snapshot</summary>
      ${raw({
        id: def.id,
        contentHash: def.contentHash,
        reviewToken: def.reviewToken,
        createdAt: def.createdAt,
        evaluator: def.evaluator,
        experiment: def.experiment,
        origin: def.origin,
      })}
    </details>
  </article>`;
}

export function regressionRunResultHtml(
  record: RegressionRunRecord,
  currentWorkspaceRevision: number | null,
): string {
  const originRev = record.origin.systemBrief.revision;
  const revDiffNotice =
    currentWorkspaceRevision !== null && currentWorkspaceRevision !== originRev
      ? `<p class="note warn">Current workspace profile is revision ${currentWorkspaceRevision}; this regression execution evaluated against the definition's pinned original brief revision ${originRev}.</p>`
      : '';

  return `<p>Saved regression run <code>${escapeHtml(record.id)}</code> · Definition <code>${escapeHtml(record.definitionId)}</code> · Pinned brief <code>${escapeHtml(record.origin.systemBrief.id)}</code> rev ${originRev}</p>
    <p><strong>Intentional target execution (not historical replay):</strong> Executed against selected target <code>${escapeHtml(record.variant)}</code> (executing source <code>${escapeHtml(record.sourceHash)}</code>, expected executing source <code>${escapeHtml(record.expectedSourceHash)}</code>) · Original finding lineage was <code>${escapeHtml(record.origin.variant)}</code> (lineage source <code>${escapeHtml(record.origin.sourceHash)}</code> from run <code>${escapeHtml(record.origin.runId)}</code>).</p>
    ${revDiffNotice}
    <p>${escapeHtml(record.evaluation.summary)}</p>
    <div style="overflow:auto">
      <table>
        <thead><tr><th>Status</th><th>Assertion</th><th>Expected</th><th>Actual</th><th>Detail</th></tr></thead>
        <tbody>
          ${record.evaluation.assertions
            .map(
              a => `<tr>
            <td>${escapeHtml(a.status)}</td>
            <td>${escapeHtml(a.name)}</td>
            <td>${escapeHtml(a.expected)}</td>
            <td>${escapeHtml(a.actual)}</td>
            <td>${escapeHtml(a.detail)}</td>
          </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>
    <details data-disclosure-key="run-provenance-${escapeHtml(record.id)}">
      <summary>Executing target provenance, original finding lineage and evaluator identity</summary>
      ${raw({
        runId: record.id,
        definitionId: record.definitionId,
        definitionHash: record.definitionHash,
        executingVariant: record.variant,
        executingSourceHash: record.sourceHash,
        expectedExecutingSourceHash: record.expectedSourceHash,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        evaluator: record.evaluator,
        originLineage: {
          runId: record.origin.runId,
          findingId: record.origin.findingId,
          originVariant: record.origin.variant,
          originSourceHash: record.origin.sourceHash,
          cleanSourceHash: record.origin.cleanSourceHash,
          contractHash: record.origin.contractHash,
          systemBrief: record.origin.systemBrief,
          finding: record.origin.finding,
        },
      })}
    </details>
    <details data-disclosure-key="run-evidence-${escapeHtml(record.id)}">
      <summary>Complete execution evidence: trace, delivery observations, snapshot, rejections, oracle violations and requirement rules</summary>
      ${raw(record.evaluation)}
    </details>`;
}

const domCache = new WeakMap<HTMLElement, string>();

export function initRegressionWorkspaceView(options: {
  onTargetChange: (variant: string) => void;
  onOpenFunctionalView?: () => void;
}): RegressionController {
  const el = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T | null;

  const controller = new RegressionController(
    (url, init) => fetch(url, init),
    state => {
      const c = state.context;

      // 1. Capture panel in Investigations
      const capturePanel = el('regression-capture-panel');
      if (capturePanel) {
        capturePanel.setAttribute(
          'aria-busy',
          String(state.previewPending || state.savePending),
        );
      }
      const btnPreview = el<HTMLButtonElement>('btn-regression-preview');
      if (btnPreview) {
        btnPreview.disabled = state.captureBlockedReason !== null || state.previewPending || state.savePending;
        btnPreview.textContent = state.previewPending
          ? 'Previewing expectations…'
          : 'Preview regression expectations';
      }
      const consentCheckbox = el<HTMLInputElement>('regression-review-checkbox');
      if (consentCheckbox) {
        consentCheckbox.checked = state.reviewedConsent;
        consentCheckbox.disabled =
          state.captureBlockedReason !== null ||
          state.preview?.available !== true ||
          state.previewPending ||
          state.savePending;
      }
      const btnSave = el<HTMLButtonElement>('btn-regression-save');
      if (btnSave) {
        btnSave.disabled = !state.canSaveCapture;
        btnSave.textContent = state.savePending
          ? 'Saving regression…'
          : 'Save reviewed regression';
      }
      const btnOpenSaved = el<HTMLButtonElement>('btn-regression-open-saved');
      const openableDefId =
        state.savedDefinition?.id ??
        (state.preview?.available ? state.preview.existingDefinitionId : null) ??
        null;
      if (btnOpenSaved) {
        btnOpenSaved.classList.toggle('hidden', !openableDefId);
      }

      const captureStatus = el('regression-capture-status');
      if (captureStatus) {
        const statusParts: string[] = [];
        if (state.runId && state.findingId) {
          statusParts.push(`Run ${state.runId} · finding ${state.findingId}.`);
        }
        if (state.captureBlockedReason && !state.previewPending && !state.savePending) {
          statusParts.push(state.captureBlockedReason);
        }
        if (state.previewPending) {
          statusParts.push('Verifying replay, clean control and deriving reference expectations…');
        } else if (state.savePending) {
          statusParts.push('Publishing immutable regression definition…');
        }
        if (state.captureError) {
          statusParts.push(state.captureError);
        } else if (state.savedDefinition) {
          statusParts.push(
            `Saved immutable regression definition ${state.savedDefinition.id}. Open Functional tests to run it against any compatible target.`,
          );
        } else if (state.preview && !state.preview.available) {
          statusParts.push(`Unavailable: ${state.preview.reason}`);
        } else if (state.preview?.available) {
          statusParts.push(
            'Review the proposed clean-control expectations below and tick the confirmation box to enable saving.',
          );
        }
        captureStatus.textContent = statusParts.filter(Boolean).join(' ');
      }

      const previewContainer = el('regression-preview-container');
      if (previewContainer) {
        const previewKey = JSON.stringify([
          state.preview?.available ? state.preview : null,
          c?.revision ?? null,
        ]);
        const html =
          state.preview && state.preview.available
            ? regressionPreviewHtml(state.preview, c?.revision ?? null)
            : '';
        setHtmlPreservingDisclosures(previewContainer, domCache, previewKey, html);
      }

      // 2. Regression execution & history in Functional tests view
      const defSelect = el<HTMLSelectElement>('regression-definition-select');
      if (defSelect) {
        const defOptionsKey = JSON.stringify([
          state.definitions.map(d => [d.id, d.title, d.origin.systemBrief.revision, d.origin.variant]),
          state.selectedDefinitionId,
        ]);
        if (domCache.get(defSelect) !== defOptionsKey) {
          domCache.set(defSelect, defOptionsKey);
          defSelect.replaceChildren(
            ...state.definitions.map(d => {
              const opt = document.createElement('option');
              opt.value = d.id;
              opt.textContent = `${d.id} · ${d.title} (orig rev ${d.origin.systemBrief.revision}, ${d.origin.variant})`;
              return opt;
            }),
          );
        }
        defSelect.value = state.selectedDefinitionId ?? '';
        defSelect.disabled =
          !state.definitions.length ||
          state.runPending ||
          c?.isDraftMode === true ||
          c?.hasUnsavedSystemEdits === true ||
          c?.isSystemSavePending === true;
      }

      const regTarget = el<HTMLSelectElement>('regression-target-select');
      if (regTarget) {
        regTarget.replaceChildren(
          ...(c?.allowedVariants ?? []).map(v => {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v;
            return opt;
          }),
        );
        regTarget.value = c?.selectedVariant ?? '';
        regTarget.disabled =
          c?.targetState !== 'ready' ||
          c?.isDraftMode === true ||
          c?.hasUnsavedSystemEdits === true ||
          c?.isSystemSavePending === true ||
          state.runPending;
      }

      const btnRunReg = el<HTMLButtonElement>('btn-run-regression');
      if (btnRunReg) {
        btnRunReg.disabled = state.executionBlockedReason !== null;
        btnRunReg.title = state.executionBlockedReason ?? '';
        btnRunReg.textContent = state.runPending ? 'Running regression…' : 'Run selected regression';
      }

      const btnInspectDef = el<HTMLButtonElement>('btn-inspect-regression-definition');
      if (btnInspectDef) {
        btnInspectDef.disabled = !state.selectedDefinitionId || state.runPending;
      }

      const regRunStatus = el('regression-run-status');
      if (regRunStatus) {
        regRunStatus.textContent =
          state.runError ??
          (state.runPending
            ? 'Executing saved regression against selected target…'
            : state.executionBlockedReason ?? '');
      }

      const defListHost = el('regression-definitions-list');
      if (defListHost) {
        const listKey = JSON.stringify([
          state.listError,
          state.definitions,
          state.selectedDefinitionId,
          c?.revision ?? null,
        ]);
        if (domCache.get(defListHost) !== listKey) {
          domCache.set(defListHost, listKey);
          defListHost.replaceChildren();
          if (state.listError || !state.definitions.length) {
            defListHost.textContent =
              state.listError ?? 'No saved finding regressions for this system profile.';
          } else {
            for (const def of state.definitions) {
              const row = document.createElement('p');
              const revNote =
                c?.revision !== null &&
                c?.revision !== undefined &&
                c.revision !== def.origin.systemBrief.revision
                  ? ` [workspace is rev ${c.revision}; pinned to orig rev ${def.origin.systemBrief.revision}]`
                  : ` [pinned rev ${def.origin.systemBrief.revision}]`;
              const originNote = def.originStatus.available
                ? 'origin verified'
                : `origin ${def.originStatus.status} (${def.originStatus.reason ?? 'using saved snapshot'})`;
              const latestNote = def.latestRun
                ? ` · latest: ${def.latestRun.variant} ${functionalRunOutcomeLabel(def.latestRun.status)}`
                : ' · not yet executed';
              row.textContent = `${def.id} · ${def.title} (${def.invariant}) · orig ${def.origin.variant}${revNote} · ${originNote}${latestNote} `;
              const inspectBtn = document.createElement('button');
              inspectBtn.type = 'button';
              inspectBtn.textContent = 'Inspect definition';
              inspectBtn.addEventListener('click', () => {
                void controller.openDefinition(def.id);
              });
              row.append(inspectBtn);
              defListHost.append(row);
            }
          }
        }
      }

      const defDetailContainer = el('regression-definition-detail-container');
      if (defDetailContainer) {
        const detailKey = JSON.stringify([state.definitionDetail, c?.revision ?? null]);
        const html = state.definitionDetail
          ? regressionDefinitionDetailHtml(state.definitionDetail, c?.revision ?? null)
          : '';
        setHtmlPreservingDisclosures(defDetailContainer, domCache, detailKey, html);
      }

      const runResultsCard = el('regression-results-card');
      if (runResultsCard) {
        runResultsCard.classList.toggle('hidden', !state.runRecord);
      }
      const runResultsContainer = el('regression-run-results-container');
      if (runResultsContainer) {
        const runKey = JSON.stringify([state.runRecord, c?.revision ?? null]);
        const html = state.runRecord
          ? regressionRunResultHtml(state.runRecord, c?.revision ?? null)
          : '';
        setHtmlPreservingDisclosures(runResultsContainer, domCache, runKey, html);
      }
      const runBadge = el('regression-run-badge');
      if (runBadge) {
        runBadge.textContent = state.runRecord
          ? functionalRunOutcomeLabel(state.runRecord.status)
          : '';
      }
      const runMeta = el('regression-run-meta');
      if (runMeta) {
        runMeta.textContent = state.runRecord
          ? `Definition ${state.runRecord.definitionId} (orig rev ${state.runRecord.origin.systemBrief.revision}, ${state.runRecord.origin.variant}) → executed on ${state.runRecord.variant} (${state.runRecord.sourceHash.slice(0, 10)})`
          : '';
      }

      const runsHistoryHost = el('regression-history-list');
      if (runsHistoryHost) {
        const runsKey = JSON.stringify([state.listError, state.runs]);
        if (domCache.get(runsHistoryHost) !== runsKey) {
          domCache.set(runsHistoryHost, runsKey);
          runsHistoryHost.replaceChildren();
          if (state.listError || !state.runs.length) {
            runsHistoryHost.textContent =
              state.listError ?? 'No saved regression executions for this system profile.';
          } else {
            for (const run of state.runs) {
              const row = document.createElement('p');
              row.textContent = `${run.startedAt} · def ${run.definitionId} (orig rev ${run.origin.systemBrief.revision}, orig ${run.origin.variant}) → target ${run.variant} (source ${run.sourceHash.slice(0, 10)}) · ${functionalRunOutcomeLabel(run.status)} `;
              const openBtn = document.createElement('button');
              openBtn.type = 'button';
              openBtn.textContent = 'Open';
              openBtn.addEventListener('click', () => {
                void controller.openRun(run.id);
              });
              row.append(openBtn);
              runsHistoryHost.append(row);
            }
          }
        }
      }
    },
  );

  el<HTMLButtonElement>('btn-regression-preview')?.addEventListener('click', () => {
    void controller.preview();
  });
  el<HTMLInputElement>('regression-review-checkbox')?.addEventListener('change', e => {
    controller.setReviewedConsent((e.target as HTMLInputElement).checked);
  });
  el<HTMLButtonElement>('btn-regression-save')?.addEventListener('click', () => {
    void controller.save();
  });
  el<HTMLButtonElement>('btn-regression-open-saved')?.addEventListener('click', () => {
    const defId =
      controller.state.savedDefinition?.id ??
      (controller.state.preview?.available ? controller.state.preview.existingDefinitionId : null);
    options.onOpenFunctionalView?.();
    if (defId) {
      void controller.openDefinition(defId);
    }
  });
  el<HTMLSelectElement>('regression-definition-select')?.addEventListener('change', e => {
    controller.selectDefinition((e.target as HTMLSelectElement).value || null);
  });
  el<HTMLSelectElement>('regression-target-select')?.addEventListener('change', e => {
    options.onTargetChange((e.target as HTMLSelectElement).value);
  });
  el<HTMLButtonElement>('btn-run-regression')?.addEventListener('click', () => {
    void controller.run();
  });
  el<HTMLButtonElement>('btn-inspect-regression-definition')?.addEventListener('click', () => {
    if (controller.state.selectedDefinitionId) {
      void controller.openDefinition(controller.state.selectedDefinitionId);
    }
  });

  return controller;
}
