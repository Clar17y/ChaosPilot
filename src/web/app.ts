import { initFunctionalWorkspaceView } from './functional.ts';
import type {
  InvestigationRecord,
  ExperimentRecord,
  Finding,
  Violation,
  TargetVariant,
  ProviderKind,
  RequirementRule,
  SystemBrief,
  SystemContract,
} from '../domain.ts';
import type { RunSummary, ReplayReport } from '../storage.ts';
import { extractInventorySnapshotDisplay, extractSnapshotDisplay, stateKindForRecord, statePresentationFor } from './snapshot.ts';
import { clampSelectedIndex, continuationSettingLabel, findingCategoryLabel, formatContractEntry, replayOutcome, tabIndexForKey, targetVariantLabel } from './presentation.ts';
import { RequestPreflight } from './preflight.ts';
import { describeProposals, describeRunOutcome } from './proposals.ts';
import {
  buildReproductionModel,
  buildRerunTrace,
  creditBarLayout,
  describeFreshReplay,
  explainStep,
  fmtCredit,
  isCreditAdmissionViolation,
  pinnedRuleText,
  PlaybackController,
  resolveExperimentPosition,
  type PlaybackStep,
  type ReproductionModel,
} from './reproduction-player.ts';
import { conciseFindingTitle, recordedDifferences } from './finding-story.ts';
import {
  effectiveAdapterId,
  executableCheckCount,
  groupRunsByRevision,
  hasRunDetail,
  inspectionScope,
  launchBlockedReason as launchBlockedReasonPure,
  partitionRuns,
  RequestSequencer,
  runOutcomeLabel,
  classifyStartFailure,
  InvestigationLifecycle,

  adapterLabel,
  contractChecksVisible,
    contractListsVisible,
    isExecutableAdapter,
    shouldClearInspectionOnSelection,
    stopControlState,
    TargetSelectionSession,
    type SnapshotLoadState,
    type TargetLoadState,
  type WorkspaceView,
} from './workspace.ts';
import { replayWaitsForSave, ReproductionSession } from './reproduction-state.ts';
import { FindingExplanationSession, reportStatusToUi, reportStateText } from './finding-explanations.ts';
import { ChallengeSession, renderChallengePanel } from './challenges.ts';
import { activeUnattributedViolations, detailVisibility, evidenceHeading, liveActivity, NO_STEP_CREDIT_TEXT, replayBehaviourStatus, timelineRenderKey, unattributedText } from './reproduction-view.ts';
import { buildStageProjection, formatRecordedValue, visiblePositionForTracePosition, type StageFrame, type StageProjection } from './replay-stage.ts';
import { StagePacketAnimator } from './stage-animation.ts';
import {
  effectiveWorkspaceSystemId,
  executeDeferredStop,
  fetchSystemBriefs,
  loadAdapterTargets,
  loadSystemContract,
  parseApiErrorResponse,
  requestInvestigationStop,
  StatusRequestCoordinator,
  type StopPostResult,
} from './request-boundaries.ts';

interface ServerStatusResponse {
  active: boolean;
  status: 'idle' | 'starting' | 'running' | 'stopping';
  id?: string;
  startedAt?: string;
  currentRecord?: InvestigationRecord | null;
  metaKeyConfigured: boolean;
  targetVariants?: string[];
  targetVariantsByAdapter?: Record<string, string[]>;
}

// State
let pollTimer: ReturnType<typeof setInterval> | null = null;
let currentInvestigationRecord: InvestigationRecord | null = null;
let selectedExperimentIndex = 0;
let consecutivePollErrors = 0;
const MAX_POLL_ERRORS = 5;
let isInspectingHistory = false;
let isInvestigationActive = false;
let isLaunchRequestPending = false;
const statusCoordinator = new StatusRequestCoordinator();

// System Briefs State
let loadedSystems: SystemBrief[] = [];
let selectedSystem: SystemBrief | null = null;
let isDraftMode = false;
let hasUnsavedSystemEdits = false;
let isSystemSavePending = false;
let draftRequirementRules: RequirementRule[] = [];

// Workspace view / history state
/* current view is tracked by the visible panel and aria-current */
let lastRunSummaries: RunSummary[] = [];
let contractCheckCount = 0;
let metaKeyConfigured = false;
let activeRecordBriefId: string | null = null;
let activeRecordId: string | null = null;
let serverRunStatus: string = 'idle';
let lastFocusedElement: HTMLElement | null = null;
const historySequencer = new RequestSequencer();
const recordSequencer = new RequestSequencer();
const snapshotSequencer = new RequestSequencer();
let snapshotState: SnapshotLoadState = 'none';
let snapshotSystemId: string | null = null;
let snapshotIdentity: { id: string; revision: number; adapterId: string } | null = null;
const targetSequencer = new RequestSequencer();
const targetSelection = new TargetSelectionSession();
const lifecycle = new InvestigationLifecycle();
let latestLiveRecord: InvestigationRecord | null = null;
// Reproduction player state (recorded playback only; fresh replay is separate).
// Run-scoped: see ReproductionSession for reset/preserve and late-result rules.
const reproSession = new ReproductionSession();
const reportSession = new FindingExplanationSession();
const challengeSession = new ChallengeSession(() => {
  const host = document.getElementById('challenge-panel');
  if (host) renderChallengePanel(host, challengeSession);
});
const reproPlayback = new PlaybackController(0, () => renderReproductionDetail());
let reproModel: ReproductionModel | null = null;
let reproShowFull = false;
let reproUseRerun = false;
let reproRerunSteps: PlaybackStep[] = [];
let reproRerunUnattributed: Violation[] = [];
type ExperimentReplayReport = ReplayReport & { scope?: string; experimentPosition?: number };
let reproStage: StageProjection | null = null;
let lastStageRenderKey = '';
const packetAnimator = new StagePacketAnimator({
  request: (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : 0),
  cancel: (h) => { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(h); },
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  isHidden: () => typeof document !== 'undefined' && document.hidden,
  prefersReducedMotion: () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  onProgress: (t) => { const packet = document.getElementById('repro-packet') as unknown as SVGCircleElement | null; if (!packet) return; if (t < 0 || t >= 1) { packet.setAttribute('opacity', '0'); return; } packet.setAttribute('cx', String(167 + (833 - 167) * t)); packet.setAttribute('opacity', '1'); },
});
function cancelStagePacket(): void { packetAnimator.cancel(); }
function animateStagePacket(): void { packetAnimator.start(); }
function effectiveSteps(): PlaybackStep[] { if (!reproModel) return []; if (reproUseRerun) return reproRerunSteps; return reproShowFull ? reproModel.allSteps : reproModel.steps; }
function clearFreshView(): void { reproUseRerun = false; reproRerunSteps = []; reproRerunUnattributed = []; }
function onReproRunChanged(rec?: InvestigationRecord | null): void { reproPlayback.stop(); cancelStagePacket(); lastStageRenderKey = ''; clearFreshView(); reproShowFull = false; selectedExperimentIndex = reproSession.applyDefaultFindingSelection(rec ?? currentInvestigationRecord); }

// DOM Elements - Controls
const targetSelect = document.getElementById('target-select') as HTMLSelectElement;
const providerSelect = document.getElementById('provider-select') as HTMLSelectElement;
const maxExperimentsInput = document.getElementById('max-experiments-input') as HTMLInputElement;
const continueAfterFindingsInput = document.getElementById('continue-after-findings-input') as HTMLInputElement | null;
const btnLaunch = document.getElementById('btn-launch') as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
const btnStopGlobal = document.getElementById('btn-stop-global') as HTMLButtonElement | null;
const btnStopDashboard = document.getElementById('btn-stop-dashboard') as HTMLButtonElement | null;
const btnRefreshHistory = document.getElementById('btn-refresh-history') as HTMLButtonElement;
const provenanceBadge = document.getElementById('provenance-badge') as HTMLElement;
const provenanceLabel = document.getElementById('provenance-label') as HTMLElement;
const statusPill = document.getElementById('status-pill') as HTMLElement;
const statusText = document.getElementById('status-text') as HTMLElement;
const metaKeyHint = document.getElementById('meta-key-hint') as HTMLElement;
const alertBanner = document.getElementById('alert-banner') as HTMLElement;
const alertMessage = document.getElementById('alert-message') as HTMLElement;
const alertClose = document.getElementById('alert-close') as HTMLButtonElement;

// System Workspace DOM Elements
const systemSelect = document.getElementById('system-select') as HTMLSelectElement;
const btnNewSystem = document.getElementById('btn-new-system') as HTMLButtonElement;
const systemRevisionBadge = document.getElementById('system-revision-badge') as HTMLElement;
const systemAdapterBadge = document.getElementById('system-adapter-badge') as HTMLElement;
const systemSaveStatus = document.getElementById('system-save-status') as HTMLElement;
const systemIdInput = document.getElementById('system-id-input') as HTMLInputElement;
const systemNameInput = document.getElementById('system-name-input') as HTMLInputElement;
const systemAdapterSelect = document.getElementById('system-adapter-select') as HTMLSelectElement;
const systemOverviewInput = document.getElementById('system-overview-input') as HTMLTextAreaElement;
const systemRequirementsInput = document.getElementById('system-requirements-input') as HTMLTextAreaElement;
const requirementRuleSelect = document.getElementById('requirement-rule-select') as HTMLSelectElement | null;
const requirementRuleReviewed = document.getElementById('requirement-rule-reviewed') as HTMLInputElement | null;
const btnAttachRequirementRule = document.getElementById('btn-attach-requirement-rule') as HTMLButtonElement | null;
const requirementRuleStatus = document.getElementById('requirement-rule-status') as HTMLElement | null;
const requirementRuleList = document.getElementById('requirement-rule-list') as HTMLElement | null;
const btnSaveSystem = document.getElementById('btn-save-system') as HTMLButtonElement;
const btnDiscardSystem = document.getElementById('btn-discard-system') as HTMLButtonElement;
const systemFeedback = document.getElementById('system-feedback') as HTMLElement;
const adapterReadinessLabel = document.getElementById('adapter-readiness-label') as HTMLElement;
const invariantsList = document.getElementById('invariants-list') as HTMLElement;
const rawContractView = document.getElementById('raw-contract-view') as HTMLElement;

// Metric Elements
const metricStatus = document.getElementById('metric-status') as HTMLElement;
const metricExperiments = document.getElementById('metric-experiments') as HTMLElement;
const metricFindings = document.getElementById('metric-findings') as HTMLElement;
const metricUsage = document.getElementById('metric-usage') as HTMLElement;
const dashRunId = document.getElementById('dash-run-id') as HTMLElement;
const dashSystemBrief = document.getElementById('dash-system-brief') as HTMLElement;
const dashTarget = document.getElementById('dash-target') as HTMLElement;
const dashTime = document.getElementById('dash-time') as HTMLElement;
const dashModel = document.getElementById('dash-model') as HTMLElement;

// Tab counts
const countFindings = document.getElementById('count-findings') as HTMLElement;
const countExperiments = document.getElementById('count-experiments') as HTMLElement;
const countProposals = document.getElementById('count-proposals') as HTMLElement;
const proposalsContainer = document.getElementById('proposals-container') as HTMLElement;
const proposalSummary = document.getElementById('proposal-summary') as HTMLElement;
const runNotes = document.getElementById('run-notes') as HTMLElement;

// Tab containers
const findingsContainer = document.getElementById('findings-container') as HTMLElement;
const experimentsContainer = document.getElementById('experiments-container') as HTMLElement;
const traceContainer = document.getElementById('trace-container') as HTMLElement;
const traceTitle = document.getElementById('trace-title') as HTMLElement;
const traceExpSelectorLabel = document.getElementById('trace-exp-selector-label') as HTMLElement;
const creditStateTable = document.getElementById('credit-state-table') as HTMLElement;
const ordersStateTable = document.getElementById('orders-state-table') as HTMLElement;
const historyTbody = document.getElementById('history-tbody') as HTMLElement;

// Replay Modal
const replayModal = document.getElementById('replay-modal') as HTMLElement;
const replayReportBody = document.getElementById('replay-report-body') as HTMLElement;
const btnCloseReplay = document.getElementById('btn-close-replay') as HTMLButtonElement;

function showAlert(message: string): void {
  alertMessage.textContent = message;
  alertBanner.classList.remove('hidden');
}

function hideAlert(): void {
  alertBanner.classList.add('hidden');
  alertMessage.textContent = '';
}

function announce(message: string): void {
  const el = document.getElementById('announcement');
  if (el) el.textContent = message;
}

function showView(view: WorkspaceView, focusHeading = true): void {
  if (view !== 'investigations') {
    reproPlayback.stop(); cancelStagePacket(); lastStageRenderKey = '';
    reproSession.invalidateFresh();
    clearFreshView();
    renderReproduction();
  }
  // panel visibility + aria-current below reflect the current view
  document.querySelectorAll<HTMLElement>('[data-view-panel]').forEach(panel => {
    panel.classList.toggle('hidden', panel.dataset.viewPanel !== view);
  });
  document.querySelectorAll<HTMLButtonElement>('.nav-btn[data-view]').forEach(btn => {
    if (btn.dataset.view === view) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  if (focusHeading) {
    document.getElementById(`title-${view}`)?.focus();
  }
  if (view === 'findings') renderFindingsView();
  if (view === 'overview' || view === 'prepare') renderWorkspaceSummaries();
}

function selectedTargetIdentity(): { id: string; revision: number; adapterId: string } | null {
  return selectedSystem
    ? { id: selectedSystem.id, revision: selectedSystem.revision, adapterId: selectedSystem.adapterId }
    : null;
}
function effectiveTargetState(): TargetLoadState {
  return targetSelection.effectiveStateFor(selectedTargetIdentity(), !isDraftMode && !hasUnsavedSystemEdits);
}
function scopedVariants(): string[] {
  return targetSelection.scopedVariantsFor(selectedTargetIdentity(), !isDraftMode && !hasUnsavedSystemEdits);
}
function resetTargetChoices(state: TargetLoadState = 'idle'): void {
  targetSequencer.invalidate();
  // Capture the displayed choice before the select is emptied below; a later
  // empty display must not overwrite it (TargetSelectionSession guards that).
  targetSelection.reset(state, targetSelect?.value || null);
  refreshTargetChoices();
}
function snapshotReadyForSelected(): boolean {
  return Boolean(selectedSystem) && snapshotState === 'ready' && snapshotSystemId === selectedSystem?.id
    && snapshotIdentity !== null && snapshotIdentity.id === selectedSystem?.id
    && snapshotIdentity.revision === selectedSystem?.revision && snapshotIdentity.adapterId === selectedSystem?.adapterId
    && !isDraftMode && !hasUnsavedSystemEdits;
}
function effectiveSnapshotState(): SnapshotLoadState {
  if (isDraftMode || !selectedSystem) return 'none';
  if (hasUnsavedSystemEdits) return 'none';
  if (snapshotSystemId !== selectedSystem.id) return snapshotState === 'loading' ? 'loading' : 'none';
  if (snapshotState === 'ready' && !snapshotReadyForSelected()) return 'error';
  return snapshotState;
}
function refreshTargetChoices(): void { updateTargetChoices(scopedVariants()); }
function checkCount(): number {
  if (!snapshotReadyForSelected()) return 0;
  return executableCheckCount(effectiveAdapter(), contractCheckCount);
}

const normalizeRequirementText = (text: string): string => text.trim().replace(/\s+/g, ' ');
function currentRequirementLines(): string[] {
  return (systemRequirementsInput?.value ?? '').split('\n').map(normalizeRequirementText).filter(Boolean);
}
function renderRequirementRulePanel(): void {
  const lines = currentRequirementLines();
  const uniqueLines = [...new Set(lines)];
  const adapter = systemAdapterSelect?.value ?? selectedSystem?.adapterId ?? 'unconfigured';
  if (requirementRuleSelect) {
    const previous = requirementRuleSelect.value;
    requirementRuleSelect.textContent = '';
    for (const text of uniqueLines) {
      const opt = document.createElement('option');
      opt.value = text;
      opt.textContent = text;
      requirementRuleSelect.appendChild(opt);
    }
    if (uniqueLines.includes(previous)) requirementRuleSelect.value = previous;
    requirementRuleSelect.disabled = isSystemSavePending || adapter !== 'synthetic-trading' || lines.length === 0;
  }
  if (btnAttachRequirementRule) btnAttachRequirementRule.disabled = isSystemSavePending || adapter !== 'synthetic-trading';
  if (requirementRuleReviewed) requirementRuleReviewed.disabled = isSystemSavePending || adapter !== 'synthetic-trading';
  const notes: string[] = [];
  if (adapter !== 'synthetic-trading') notes.push('Requirement rules support synthetic-trading only; explicitly remove attached rules before switching adapter.');
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const rule of draftRequirementRules) {
    const count = counts.get(rule.requirement) ?? 0;
    if (count === 0) notes.push(`Stale rule: linked requirement text was renamed or removed — remove it, or remap by removing and attaching the new text: "${rule.requirement}"`);
    else if (count > 1) notes.push(`Ambiguous rule: linked requirement text now appears ${count} times — deduplicate it or remove the rule: "${rule.requirement}"`);
  }
  if (requirementRuleStatus) requirementRuleStatus.textContent = notes.join(' ');
  if (requirementRuleList) {
    requirementRuleList.textContent = '';
    if (!draftRequirementRules.length) {
      const li = document.createElement('li');
      li.textContent = 'No deterministic rule attached. All requirements above are unverified context.';
      requirementRuleList.appendChild(li);
    }
    for (const rule of draftRequirementRules) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `Credit limit for accepted orders → "${rule.requirement}" (reviewed)`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-secondary btn-xs';
      remove.textContent = 'Remove rule';
      remove.disabled = isSystemSavePending;
      remove.addEventListener('click', () => {
        if (isSystemSavePending) return;
        draftRequirementRules = draftRequirementRules.filter(r => r.requirement !== rule.requirement);
        markUnsavedEdits();
      });
      li.append(label, document.createTextNode(' '), remove);
      requirementRuleList.appendChild(li);
    }
  }
}

function renderWorkspaceSummaries(): void {
  const name = isDraftMode ? (systemNameInput?.value || 'New system') : (selectedSystem?.name ?? 'No system selected');
  const overview = isDraftMode ? systemOverviewInput?.value ?? '' : (selectedSystem?.overview ?? '');
  const requirements = isDraftMode
    ? (systemRequirementsInput?.value.split('\n').map(r => r.trim()).filter(Boolean) ?? [])
    : (selectedSystem?.requirements ?? []);
  const requirementRules = isDraftMode ? draftRequirementRules : (selectedSystem?.requirementRules ?? []);
  const adapter = effectiveAdapter() ?? 'unconfigured';
  document.getElementById('trading-demo-guide')?.classList.toggle('hidden', adapter !== 'synthetic-trading');
  const revision = isDraftMode ? null : (selectedSystem?.revision ?? null);
  const checks = checkCount();

  const set = (id: string, text: string) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  const titleOverview = document.getElementById('title-overview');
  if (titleOverview) titleOverview.textContent = name;
  set('overview-purpose', overview || 'No business purpose saved yet.');
  set('overview-revision', revision === null ? 'Unsaved draft' : `Current brief · revision ${revision}`);
  set('overview-adapter', isExecutableAdapter(adapter) ? `${adapterLabel(adapter)} adapter` : 'No adapter configured');
  set('overview-readiness', isExecutableAdapter(adapter) && snapshotReadyForSelected() ? 'Ready for supported scope' : isExecutableAdapter(adapter) ? 'Contract not confirmed' : 'Draft · adapter unconfigured');
  set('overview-check-count', String(checks));
  set('overview-context-count', String(requirements.length));
  const { scoped } = partitionRuns(lastRunSummaries, workspaceSystemId());
  set('overview-run-count', String(scoped.length));

  set('prepare-revision', revision === null ? 'Unsaved draft: save before launch' : `Brief revision ${revision}`);
  set('prepare-adapter', isExecutableAdapter(adapter) ? adapterLabel(adapter) : 'Adapter unconfigured');
  set('prepare-purpose', overview || 'No business purpose saved yet.');
  set('prepare-overview', overview || 'No business purpose saved yet.');
  const configuredRuleTexts = new Set(requirementRules.map(r => r.requirement));
  const unverifiedCount = requirements.filter(r => !configuredRuleTexts.has(normalizeRequirementText(r))).length;
  const ruleCount = requirementRules.length;
  set('prepare-counts', `${checks} built-in checks · ${ruleCount} linked requirement ${ruleCount === 1 ? 'check' : 'checks'} · ${unverifiedCount} unverified requirements`);
  set('prepare-meta-readiness', metaKeyConfigured
    ? 'Meta: backend reports a configured key.'
    : 'Meta: backend reports no configured key.');
  const reqList = document.getElementById('prepare-requirements');
  if (reqList) {
    reqList.textContent = '';
    if (!requirements.length) {
      const li = document.createElement('li');
      li.textContent = 'None recorded.';
      reqList.appendChild(li);
    }
    for (const text of requirements) {
      const li = document.createElement('li');
      li.textContent = configuredRuleTexts.has(normalizeRequirementText(text))
        ? `${text} — configured deterministic rule attached`
        : `${text} — unverified (context only)`;
      reqList.appendChild(li);
    }
  }
  const ruleList = document.getElementById('prepare-requirement-rules');
  if (ruleList) {
    ruleList.textContent = '';
    if (!requirementRules.length) {
      const li = document.createElement('li');
      li.textContent = 'None. No requirement rule will be pinned to the next run.';
      ruleList.appendChild(li);
    }
    for (const rule of requirementRules) {
      const li = document.createElement('li');
      li.textContent = `Credit limit for accepted orders: "${rule.requirement}" — used plus reserved credit must stay within the limit.`;
      ruleList.appendChild(li);
    }
  }
  const dirtyNote = document.getElementById('prepare-dirty-note');
  dirtyNote?.classList.toggle('hidden', !(hasUnsavedSystemEdits || isDraftMode));

  const overviewRun = document.getElementById('overview-run');
  if (overviewRun) {
    overviewRun.textContent = '';
    const latest = scoped[0];
    if (!latest) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No saved investigations for this system yet.';
      overviewRun.appendChild(p);
    } else {
      const p = document.createElement('p');
      p.textContent = `${latest.id} · ${runOutcomeLabel(latest.status)} · brief revision ${latest.systemBrief?.revision ?? 'unavailable'} · ${latest.experimentsCount} experiments executed · ${latest.findingsCount} findings`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-secondary btn-xs';
      btn.textContent = 'Open run';
      btn.addEventListener('click', () => { showView('investigations'); void openRun(latest.id); });
      overviewRun.append(p, btn);
    }
  }
}

function renderFindingsView(): void {
  if (reportSession.syncToEvidence(currentInvestigationRecord)) { void refreshReportStatus(); } else { renderReportPanel(); }
  const container = document.getElementById('findings-view-container');
  if (container) {
    container.textContent = '';
    const { scoped, legacy } = partitionRuns(lastRunSummaries, workspaceSystemId());
    const withFindings = [
      ...scoped.filter(r => r.findingsCount > 0).map(r => ({ run: r, legacy: false })),
      ...legacy.filter(r => r.findingsCount > 0).map(r => ({ run: r, legacy: true })),
    ];
    if (!withFindings.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No saved runs with findings for this system yet. A written requirement is not a verified result.';
      container.appendChild(p);
    }
    for (const { run, legacy: isLegacy } of withFindings) {
      const row = document.createElement('div');
      row.className = 'row finding-index-row';
      const textWrap = document.createElement('div');
      textWrap.className = 'finding-index-text';
      const heading = document.createElement('p');
      heading.className = 'finding-index-heading';
      heading.textContent = `${run.variant} · ${runOutcomeLabel(run.status)} · ${run.findingsCount} finding(s)`;
      const meta = document.createElement('p');
      meta.className = 'muted finding-index-meta';
      meta.textContent = `${run.id}${isLegacy ? ' · Legacy / system unavailable' : ` · brief revision ${run.systemBrief?.revision ?? 'unavailable'}`}`;
      textWrap.append(heading, meta);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-secondary btn-xs';
      btn.textContent = 'Inspect run and reproductions';
      btn.addEventListener('click', () => { showView('investigations'); void openRun(run.id); });
      row.append(textWrap, btn);
      container.appendChild(row);
    }
  }
  const opened = document.getElementById('findings-opened-summary');
  if (opened) {
    opened.textContent = '';
    const rec = currentInvestigationRecord;
    if (!rec) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No run is currently opened.';
      opened.appendChild(p);
    } else if (inspectionScope(rec.systemBrief?.brief.id ?? null, workspaceSystemId()) !== 'selected' && !(lifecycle.inspectedIsLive && lifecycle.inspectedId === rec.id)) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = inspectionScope(rec.systemBrief?.brief.id ?? null, workspaceSystemId()) === 'legacy' ? `Opened run ${rec.id} · Legacy / system unavailable: not findings for ${selectedSystem?.name ?? 'the selected system'}. Open it in Investigations to inspect it under its own identity.` : `Opened run ${rec.id} belongs to system ${rec.systemBrief?.brief.id}, not ${isDraftMode ? 'the unsaved draft' : `the selected system (${selectedSystem?.name ?? 'none'})`}. Its findings are not shown here as selected-system findings; open it in Investigations to inspect it under its own identity.`; opened.appendChild(p); } else if (!rec.findings.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = `Opened run ${rec.id} has no findings.`;
      opened.appendChild(p);
    } else {
      const provenance = document.createElement('details');
      const summary = document.createElement('summary'); summary.textContent = 'Opened run identity and provenance';
      const ids = document.createElement('p'); ids.className = 'muted';
      ids.textContent = `Run ${rec.id} · system ${rec.systemBrief?.brief.id ?? 'legacy / unavailable'} · brief revision ${rec.systemBrief?.brief.revision ?? 'unavailable'} · ${rec.provider}/${rec.mode} · ${rec.model} · source ${rec.sourceHash}`;
      provenance.append(summary, ids); opened.appendChild(provenance);
      for (const [index, f] of rec.findings.entries()) {
        const card = document.createElement('article'); card.className = 'opened-finding';
        const title = document.createElement('h3'); title.textContent = conciseFindingTitle(f);
        const why = document.createElement('p'); why.textContent = `What was tested: ${f.hypothesis || 'No hypothesis was recorded.'}`;
        const rule = pinnedRuleText(rec, f.violation?.invariant ?? null);
        const expected = document.createElement('p'); expected.textContent = `Expected: ${rule.ruleText ?? rule.ruleLabel}`;
        const observed = document.createElement('p'); observed.textContent = `Observed: ${f.violation?.message || 'No violation description was recorded.'}`;
        const differences = recordedDifferences(f.violation);
        const comparison = document.createElement('p');
        comparison.textContent = differences.rows.slice(0, 2).map(row => `${row.label}: expected ${row.expected}, observed ${row.observed}`).join(' · ');
        const status = document.createElement('p'); status.className = 'muted';
        status.textContent = `Recorded reproduction: ${f.reproduced === true ? 'verified' : f.reproduced === false ? 'not verified' : 'unknown'} · Clean control: ${f.cleanControlPassed === true ? 'passed' : f.cleanControlPassed === false ? 'not passed' : 'unknown'}`;
        const go = document.createElement('button'); go.type = 'button'; go.className = 'btn btn-secondary btn-xs'; go.textContent = 'Inspect recorded reproduction'; go.setAttribute('aria-label', `Go to reproduction for finding: ${f.title}`);
        go.addEventListener('click', () => { showView('investigations'); openReproductionForFinding(f); });
        const explain = document.createElement('button'); explain.type = 'button'; explain.className = 'btn btn-primary btn-xs'; explain.textContent = 'Explain this finding';
        explain.setAttribute('aria-label', `Explain finding ${index + 1}: ${conciseFindingTitle(f)}`);
        explain.addEventListener('click', () => {
          if (reportSession.state.kind === 'saved') { openSavedReport(false, index + 1); return; }
          document.getElementById('explanation-report-panel')?.scrollIntoView({ block: 'start' });
          document.getElementById('btn-report-meta')?.focus();
          announce('Choose how to create a report explaining every finding in this run.');
        });
        card.append(title, why, expected, observed);
        if (comparison.textContent) card.appendChild(comparison);
        const challenge = document.createElement('button'); challenge.type = 'button'; challenge.className = 'btn btn-secondary btn-xs';
        challenge.textContent = 'Inspect challenge with Muse';
        challenge.setAttribute('aria-label', `Inspect paid Muse challenge for finding ${index + 1}: ${conciseFindingTitle(f)}`);
        challenge.addEventListener('click', () => {
          const rec = currentInvestigationRecord;
          if (!rec || resolveExperimentPosition(rec, f) < 0) {
            showAlert('The experiment for this finding is not present in the opened run, so its challenge cannot be opened.');
            return;
          }
          showView('investigations');
          openReproductionForFinding(f, false);
          const panel = document.getElementById('challenge-panel');
          panel?.scrollIntoView({ block: 'start' });
          const museBtn = document.getElementById('btn-challenge-muse') as HTMLButtonElement | null;
          if (museBtn && !museBtn.disabled) {
            museBtn.focus();
          } else if (panel) {
            if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
            panel.focus();
          }
        });
        card.append(status, explain, go, challenge); opened.appendChild(card);
      }
    }
  }
}

function renderReportPanel(): void {
  const statusEl = document.getElementById('explanation-report-status');
  const rec = currentInvestigationRecord;
  const scope = rec ? inspectionScope(rec.systemBrief?.brief.id ?? null, workspaceSystemId()) : null;
  const identity = rec ? `${rec.variant} · ${scope === 'legacy' ? 'Legacy / system unavailable' : rec.systemBrief?.brief.name ?? rec.systemBrief?.brief.id ?? 'system unavailable'}${scope === 'other' ? ' (another system)' : ''}` : '';
  const canAct = Boolean(rec && rec.status !== 'running' && rec.findings.length && !['loading', 'unavailable'].includes(reportSession.state.kind));
  for (const id of ['btn-report-meta', 'btn-report-offline']) { const b = document.getElementById(id) as HTMLButtonElement | null; if (b) b.disabled = !canAct || reportSession.state.kind === 'generating'; }
  const saved = reportSession.state.kind === 'saved';
  for (const id of ['btn-report-view', 'btn-report-download']) { const b = document.getElementById(id) as HTMLButtonElement | null; if (b) b.disabled = !saved; }
  if (statusEl) statusEl.textContent = !rec ? 'No run is currently opened.' : `${identity}: ${reportStateText(reportSession.state)}`;
  document.getElementById('explanation-report-panel')?.setAttribute('aria-busy', String(['loading', 'generating'].includes(reportSession.state.kind)));
}
async function refreshReportStatus(): Promise<void> {
  const rec = currentInvestigationRecord;
  if (!rec) { reportSession.resetForRun(null); renderReportPanel(); return; }
  reportSession.syncToRun(rec.id);
  if (rec.status === 'running') { reportSession.state = reportStatusToUi({ terminal: false, findingsCount: rec.findings.length }); renderReportPanel(); return; }
  const token = reportSession.begin(rec.id, 'loading'); renderReportPanel();
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(rec.id)}/explanation-report/status`);
    const data = res.ok ? await res.json() : null;
    if (!reportSession.settle(token, rec.id, reportStatusToUi(data))) return;
    if (reportSession.state.kind === 'generating') setTimeout(() => { if (reportSession.isCurrent(token, rec.id)) void refreshReportStatus(); }, 1000);
  } catch { if (!reportSession.settle(token, rec.id, { kind: 'error', message: 'Could not check for a saved report.' })) return; }
  renderReportPanel();
}
async function createReport(mode: 'meta' | 'offline'): Promise<void> {
  const rec = currentInvestigationRecord; if (!rec) return;
  if (reportSession.state.kind === 'generating' || rec.status === 'running' || !rec.findings.length) return;
  const token = reportSession.begin(rec.id, 'generating'); renderReportPanel();
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(rec.id)}/explanation-report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `Report creation failed (${res.status})`);
    if (!reportSession.settle(token, rec.id, { kind: 'saved', generatedAt: String(data.generatedAt ?? ''), mode: String(data.mode ?? mode), model: String(data.model ?? '') })) return;
    announce('Findings report saved. You can view or download it again without a model call.');
  } catch (e) { if (!reportSession.settle(token, rec.id, { kind: 'error', message: e instanceof Error ? e.message : String(e) })) return; }
  renderReportPanel();
}
function openSavedReport(download: boolean, findingNumber?: number): void {
  const rec = currentInvestigationRecord; if (!rec || reportSession.state.kind !== 'saved') return;
  const fragment = !download && findingNumber !== undefined ? `#finding-${findingNumber}` : '';
  window.open(`/api/runs/${encodeURIComponent(rec.id)}/explanation-report${download ? '?download=1' : ''}${fragment}`, '_blank', 'noopener');
}

function updateActiveOtherSystemNotice(): void {
  const wrap = document.getElementById('active-other-system');
  const text = document.getElementById('active-other-system-text');
  if (!wrap || !text) return;
  const show = Boolean(
    activeRecordId && activeRecordBriefId && (selectedSystem || isDraftMode) && activeRecordBriefId !== workspaceSystemId()
  );
  wrap.classList.toggle('hidden', !show);
  if (show) {
    text.textContent = `An investigation is active for a different system (${activeRecordBriefId})${isDraftMode ? ' than the unsaved draft' : ''}. One global investigation remains enforced.`;
  }
}

function effectiveAdapter(): string | null { return effectiveAdapterId({ isDraftMode, hasUnsavedSystemEdits, draftAdapterId: systemAdapterSelect?.value ?? null, savedAdapterId: selectedSystem?.adapterId ?? null }); }
function workspaceSystemId(): string | null { return effectiveWorkspaceSystemId({ isDraftMode, selectedSystemId: selectedSystem?.id ?? null }); }
function syncStopControls(): void { const s = stopControlState({ isStartPending: lifecycle.startPending, isInvestigationActive, serverStatus: serverRunStatus }); for (const b of [btnStop, btnStopGlobal, btnStopDashboard]) { if (!b) continue; b.disabled = !s.enabled; b.textContent = s.label; b.classList.toggle('hidden', !s.visible && b !== btnStop); } const bar = document.getElementById('global-active-run'); const txt = document.getElementById('global-active-text'); if (bar) bar.classList.toggle('hidden', !s.visible); if (bar && txt && s.visible) { const sys = activeRecordBriefId ? `system ${activeRecordBriefId}` : 'system unavailable (legacy)'; txt.textContent = lifecycle.startPending && !isInvestigationActive ? 'Investigation starting…' : `Investigation ${serverRunStatus} · ${activeRecordId ?? ''} · ${sys}`; } updateActiveOtherSystemNotice(); }
function updateInspectionNotice(): void { const el = document.getElementById('inspection-notice'); if (!el) return; const rec = currentInvestigationRecord; if (!rec) { el.classList.add('hidden'); el.textContent = ''; return; } const scope = inspectionScope(rec.systemBrief?.brief.id ?? null, workspaceSystemId()); if (scope === 'selected') { el.classList.add('hidden'); el.textContent = ''; return; } el.classList.remove('hidden'); el.textContent = scope === 'legacy' ? `Viewing run ${rec.id} · Legacy / system unavailable: not assigned to ${isDraftMode ? 'the unsaved draft' : (selectedSystem?.name ?? 'the selected system')}.` : `Viewing run ${rec.id} from system ${rec.systemBrief?.brief.id}, not ${isDraftMode ? 'the unsaved draft' : `the selected system (${selectedSystem?.name ?? 'none'})`}. Its findings are shown under that run's identity.`; }
function renderEmptyDashboard(message: string): void { challengeSession.select(null, null); reproPlayback.stop(); cancelStagePacket(); lastStageRenderKey = ""; reproSession.clear(); clearFreshView(); reproShowFull = false; reproModel = null; const empty = document.getElementById('dashboard-empty'); const detail = document.getElementById('dashboard-detail'); const right = document.getElementById('dashboard-header-right'); if (empty) { empty.textContent = message; empty.classList.remove('hidden'); } detail?.classList.add('hidden'); right?.classList.add('hidden'); dashRunId.textContent = 'No investigation selected'; if (dashSystemBrief) dashSystemBrief.textContent = ''; dashTarget.textContent = ''; dashTime.textContent = ''; dashModel.textContent = ''; applyStatePresentation(); updateInspectionNotice(); }
function openActiveRun(): void { recordSequencer.invalidate(); showView('investigations'); const target = lifecycle.openActiveTarget(); if (!target) { if (isLaunchRequestPending) renderEmptyDashboard('Investigation is starting.'); return; } const rec = latestLiveRecord && latestLiveRecord.id === target.id ? latestLiveRecord : (currentInvestigationRecord && currentInvestigationRecord.id === target.id ? currentInvestigationRecord : null); if (rec) { resetReproductionSelection(); selectedExperimentIndex = 0; isInspectingHistory = false; currentInvestigationRecord = rec; renderActiveRecord(rec); renderFindingsView(); return; } renderEmptyDashboard('Investigation is starting.'); }
function updateProvenanceBadge(mode: 'mock' | 'live' | 'replay'): void {
  provenanceBadge.className = 'provenance-badge';
  if (mode === 'live') {
    provenanceBadge.classList.add('badge-live');
    provenanceLabel.textContent = 'Provenance: Live (Meta API)';
  } else if (mode === 'replay') {
    provenanceBadge.classList.add('badge-replay');
    provenanceLabel.textContent = 'Provenance: Replay (deterministic)';
  } else {
    provenanceBadge.classList.add('badge-mock');
    provenanceLabel.textContent = 'Provenance: Mock (scripted)';
  }
}

function updateStatusPill(status: string): void {
  statusPill.className = 'status-pill';
  const norm = status.toLowerCase();
  statusText.textContent = norm.toUpperCase();

  if (norm === 'running') {
    statusPill.classList.add('status-running');
  } else if (norm === 'stopping') {
    statusPill.classList.add('status-stopping');
  } else if (norm === 'completed') {
    statusPill.classList.add('status-completed');
  } else if (norm === 'failed' || norm === 'cancelled') {
    statusPill.classList.add('status-failed');
  } else {
    statusPill.classList.add('status-idle');
  }
}

function updateTargetChoices(variants: string[]): void {
  if (!targetSelect) return;
  // Capture before clearing: after a reset/loading clear this is empty and
  // must not erase the choice captured earlier (session ignores empties).
  targetSelection.captureDisplayedSelection(targetSelect.value || null);
  const currentVal = targetSelect.value;
  const existingOptions = Array.from(targetSelect.options).map(o => o.value);
  const isSame = existingOptions.length === variants.length &&
    existingOptions.every((v, i) => v === variants[i]);

  if (isSame && targetSelect.options.length > 0) return;

  while (targetSelect.firstChild) {
    targetSelect.removeChild(targetSelect.firstChild);
  }

  for (const v of variants) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = targetVariantLabel(v);
    targetSelect.appendChild(opt);
  }

  // The confirmed session selection (resolved against the newly fetched list
  // for its adapter) wins; the just-cleared DOM value is not a fallback.
  const resolved = targetSelection.selection && variants.includes(targetSelection.selection)
    ? targetSelection.selection
    : null;
  if (resolved) targetSelect.value = resolved;
  else if (currentVal && variants.includes(currentVal)) targetSelect.value = currentVal;
}

async function fetchStatus(): Promise<void> {
  await statusCoordinator.run(
    async () => {
      const res = await fetch('/api/status', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as ServerStatusResponse;
    },
    (data) => { applyStatusResponse(data); },
    () => {
      consecutivePollErrors++;
      if (consecutivePollErrors > MAX_POLL_ERRORS && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
        showAlert('Polling suspended due to network or server errors.');
      }
    },
  );
}

function applyStatusResponse(data: ServerStatusResponse): void {
    consecutivePollErrors = 0;
    isInvestigationActive = data.active; serverRunStatus = data.status;
    metaKeyConfigured = Boolean(data.metaKeyConfigured);
    if (data.active && data.currentRecord) {
      activeRecordId = data.currentRecord.id;
      activeRecordBriefId = data.currentRecord.systemBrief?.brief.id ?? null;
    } else if (!data.active) {
      activeRecordId = null;
      activeRecordBriefId = null;
    } else if (data.id) {
      activeRecordId = data.id;
    }
    updateActiveOtherSystemNotice();

    // Status target fields are discovery/compat data only. They must not
    // replace the selected system's scoped choices from /api/targets, even
    // while a target request is pending or a run is active for another system.

    // Update launch and stop controls
    if (data.active) {
      syncStopControls();
      if (!isInspectingHistory) {
        updateStatusPill(data.status);
        metricStatus.textContent = data.status.toUpperCase();
      }
    } else {
      serverRunStatus = data.currentRecord?.status ?? 'idle'; syncStopControls();
      if (!isInspectingHistory) {
        const status = data.currentRecord?.status ?? 'idle';
        updateStatusPill(status);
        metricStatus.textContent = status.toUpperCase();
      }
    }
    updateRunReadiness();

    // Toggle hint for meta key
    if (providerSelect.value === 'meta' && !data.metaKeyConfigured) {
      metaKeyHint.classList.remove('hidden');
    } else {
      metaKeyHint.classList.add('hidden');
    }

    if (data.currentRecord) { latestLiveRecord = data.currentRecord; lifecycle.noteStatus({ id: data.currentRecord.id, status: data.currentRecord.status, systemId: data.currentRecord.systemBrief?.brief.id ?? null }); } else if (data.active && data.id) { lifecycle.noteStatus({ id: data.id, status: data.status, systemId: activeRecordBriefId }); }
    isInspectingHistory = Boolean(lifecycle.inspectedId && !lifecycle.inspectedIsLive);
    const pollDecision = isDraftMode && !lifecycle.inspectedIsLive && lifecycle.pollDecision(workspaceSystemId()) === 'render-live' ? (lifecycle.inspectedId ? 'preserve-inspection' as const : 'none' as const) : lifecycle.pollDecision(workspaceSystemId());
    if (data.currentRecord && pollDecision === 'render-live') {
      currentInvestigationRecord = data.currentRecord;
      renderActiveRecord(data.currentRecord); renderFindingsView();
    }

    if (data.currentRecord && pollDecision === 'none' && !lifecycle.inspectedId && currentInvestigationRecord?.id === data.currentRecord.id) { currentInvestigationRecord = null; lifecycle.clearInspection(); renderEmptyDashboard('An investigation for another system is available from the banner above. Open a saved run for the selected system, or open the active run explicitly.'); }
    // Bounded polling control: if not active, slow down polling
    if (!data.active && !isLaunchRequestPending && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      loadHistory();
    }
}

function startPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  consecutivePollErrors = 0;
  pollTimer = setInterval(fetchStatus, 800);
}

function renderActiveRecord(rec: InvestigationRecord): void { if (reproSession.syncToRun(rec.id)) { onReproRunChanged(rec); } if (!hasRunDetail(rec.id)) { renderEmptyDashboard('No investigation selected.'); return; } document.getElementById('dashboard-empty')?.classList.add('hidden'); document.getElementById('dashboard-detail')?.classList.remove('hidden'); document.getElementById('dashboard-header-right')?.classList.remove('hidden'); updateInspectionNotice(); syncStopControls();
  const outcome = document.getElementById('run-outcome-summary');
  if (outcome) {
    const summary = describeRunOutcome(rec);
    outcome.replaceChildren();
    outcome.classList.toggle('hidden', summary === null);
    if (summary) {
      const heading = document.createElement('h3'); heading.textContent = summary.heading;
      const reason = document.createElement('p'); reason.textContent = summary.reason;
      const metrics = document.createElement('p'); metrics.className = 'run-outcome-metrics'; metrics.textContent = summary.metrics;
      const notice = document.createElement('p'); notice.textContent = summary.notice;
      outcome.append(heading, reason, metrics, notice);
    }
  }
  dashRunId.textContent = `Run ID: ${rec.id}`;

  if (dashSystemBrief) {
    if (rec.systemBrief) {
      const brief = rec.systemBrief.brief;
      const hashShort = rec.systemBrief.hash ? rec.systemBrief.hash.slice(0, 8) : '';
      dashSystemBrief.textContent = `Brief: ${brief.name} (Rev ${brief.revision}, ${hashShort})`;
      dashSystemBrief.title = `Full Hash: ${rec.systemBrief.hash}\nAdapter: ${brief.adapterId}`;
    } else {
      dashSystemBrief.textContent = 'Legacy run: no system brief snapshot recorded';
      dashSystemBrief.title = '';
    }
  }
  const pinnedDetails = document.getElementById('run-system-snapshot');
  pinnedDetails?.classList.toggle('hidden', !rec.systemBrief);
  if (rec.systemBrief) {
    const overview = document.getElementById('run-system-overview');
    const requirements = document.getElementById('run-system-requirements');
    const contract = document.getElementById('run-system-contract');
    if (overview) overview.textContent = rec.systemBrief.brief.overview;
    const pinnedRuleTexts = new Set((rec.systemBrief.brief.requirementRules ?? []).map(r => r.requirement));
    if (requirements) {
      requirements.textContent = '';
      for (const text of rec.systemBrief.brief.requirements) {
        const item = document.createElement('li');
        item.textContent = pinnedRuleTexts.has(normalizeRequirementText(text))
          ? `${text} — configured deterministic rule pinned to this run`
          : `${text} — unverified (context only)`;
        requirements.appendChild(item);
      }
      if (!rec.systemBrief.brief.requirements.length) requirements.textContent = 'None recorded.';
    }
    const pinnedRulesEl = document.getElementById('run-system-requirement-rules');
    if (pinnedRulesEl) {
      pinnedRulesEl.textContent = '';
      const rules = rec.systemBrief.brief.requirementRules ?? [];
      if (!rules.length) {
        const item = document.createElement('li');
        item.textContent = 'None pinned to this run.';
        pinnedRulesEl.appendChild(item);
      }
      for (const rule of rules) {
        const item = document.createElement('li');
        item.textContent = `Credit limit for accepted orders: "${rule.requirement}" (reviewed)`;
        pinnedRulesEl.appendChild(item);
      }
    }
    const evaluatorEl = document.getElementById('run-system-evaluator');
    if (evaluatorEl) {
      const ev = rec.systemBrief.requirementEvaluator;
      evaluatorEl.textContent = ev
        ? `Check version ${ev.version} is pinned to this run. Later brief edits do not change it.`
        : 'No requirement check pinned to this run.';
    }
    if (contract) contract.textContent = `${rec.systemBrief.contract?.invariants.length ?? 0} available deterministic checks in the pinned contract. Snapshot hash: ${rec.systemBrief.hash}`;
  }

  dashTarget.textContent = `Variant: ${rec.variant} · ${continuationSettingLabel(rec.continueAfterFindings)}`;
  dashTime.textContent = `Started: ${new Date(rec.startedAt).toLocaleTimeString()}`;
  dashModel.textContent = `Model: ${rec.model}`;

  updateProvenanceBadge(rec.mode);
  updateStatusPill(rec.status);
  {
    const activity = liveActivity({ recordStatus: rec.status, serverStatus: serverRunStatus, pendingProposals: (rec.proposalAttempts ?? []).filter(a => a.status === 'pending').length, experiments: rec.experiments.length, findings: rec.findings.length, isActive: isInvestigationActive && rec.id === activeRecordId });
    const host = document.getElementById('live-activity');
    if (host) { host.classList.toggle('is-active', activity.live); host.classList.toggle('is-terminal', activity.terminal); host.dataset.tone = activity.tone; host.classList.toggle('is-completed', activity.tone === 'completed'); host.classList.toggle('is-failed', activity.tone === 'failed'); host.classList.toggle('is-cancelled', activity.tone === 'cancelled'); }
    const label = document.getElementById('live-activity-label'); if (label) label.textContent = activity.label;
    const detail = document.getElementById('live-activity-detail'); if (detail) detail.textContent = activity.detail;
  }
  metricStatus.textContent = rec.status.toUpperCase();
  metricExperiments.textContent = `${rec.experiments.length} executed`;
  metricFindings.textContent = `${rec.findings.length}`;

  const proposalDisplay = describeProposals(rec);
  countFindings.textContent = `${rec.findings.length}`;
  countExperiments.textContent = `${rec.experiments.length}`;

  if (rec.usage) {
    const cost = (rec.usage.estimatedCostUsd || 0).toFixed(4);
    const unknown = proposalDisplay.unknownCost;
    metricUsage.textContent = unknown
      ? `Reported ${rec.usage.inputTokens} in / ${rec.usage.outputTokens} out ($${cost} reported; some usage unknown)`
      : `${rec.usage.inputTokens} in / ${rec.usage.outputTokens} out ($${cost})`;
  }

  renderFindings(rec.findings);
  renderExperiments(rec.experiments);
  renderProposals(rec, proposalDisplay);
  renderSelectedExperimentTrace();
  renderReproduction();
}

function renderProposals(rec: InvestigationRecord, display = describeProposals(rec)): void {
  // display supplied once by renderActiveRecord (SIM-02)
  countProposals.textContent = display.count === null ? 'Not recorded' : String(display.count);
  proposalSummary.textContent = display.summary + (display.unknownCost
    ? ' Some request usage is unknown. Reported token costs exclude it; the application retains a conservative allowance.' : '');
  const notes: string[] = [];
  if (rec.stopReason) notes.push(`Stop/failure reason: ${rec.stopReason}`);
  for (const err of rec.errors ?? []) notes.push(`Error: ${err}`);
  if (rec.status === 'cancelled') notes.push('This run was stopped. It is not a clean pass.');
  if (rec.status === 'failed') notes.push('This run failed. It is not a clean pass and does not show that no defects exist.');
  runNotes.textContent = notes.join('\n');

  const openKeys = new Set(
    Array.from(proposalsContainer.querySelectorAll<HTMLDetailsElement>('details[data-proposal-key]'))
      .filter(el => el.open)
      .map(el => el.dataset.proposalKey)
  );

  proposalsContainer.textContent = '';
  const attempts = rec.proposalAttempts ?? [];
  for (const attempt of attempts) {
    const key = `attempt-${attempt.index}`;
    const card = document.createElement('div');
    card.className = 'proposal-card';
    card.dataset.proposalKey = key;

    const heading = document.createElement('h4');
    heading.textContent = `Attempt ${attempt.index}: ${attempt.status.toUpperCase()} (${attempt.durationMs !== undefined ? `${attempt.durationMs}ms` : 'in flight'})`;
    card.appendChild(heading);

    const facts = document.createElement('p');
    const sent = attempt.requestSent === true ? 'attempted' : attempt.requestSent === false ? 'not sent' : 'not recorded';
    facts.textContent = `Experiment slot ${attempt.experimentNumber}, correction ${attempt.correctionNumber}. Network request: ${sent}. Usage: ${attempt.usageKnown ? 'reported' : 'unknown'}.`;
    card.appendChild(facts);
    if (attempt.error) {
      const error = document.createElement('p');
      error.textContent = attempt.error;
      card.appendChild(error);
    }
    if (attempt.response?.contentTruncated) {
      const note = document.createElement('p');
      note.textContent = 'The saved response preview was shortened. This is separate from the model’s output limit.';
      card.appendChild(note);
    }
    for (const [label, data, suffix] of [
      ['Prepared request audit', attempt.request, 'request'],
      ['Visible model response', attempt.response, 'response']
    ] as const) {
      if (!data) continue;
      const section = document.createElement('details');
      const sectionKey = `${key}-${suffix}`;
      section.dataset.proposalKey = sectionKey;
      section.open = openKeys.has(sectionKey);
      const title = document.createElement('summary');
      title.textContent = label;
      const content = document.createElement('pre');
      content.textContent = JSON.stringify(data, null, 2);
      section.append(title, content);
      card.appendChild(section);
    }
    proposalsContainer.appendChild(card);
  }
}

function renderFindings(findings: Finding[]): void {
  findingsContainer.textContent = '';
  if (!findings || findings.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No findings are recorded for this investigation. Review its status, experiment results and coverage before drawing conclusions.';
    findingsContainer.appendChild(empty);
    return;
  }

  for (let i = 0; i < findings.length; i++) {
    const f = findings[i]!;
    const card = document.createElement('div');
    card.className = 'finding-card';

    const header = document.createElement('div');
    header.className = 'finding-header';

    const title = document.createElement('h3');
    title.className = 'finding-title';
    title.textContent = `[Finding ${i + 1}] ${f.title}`;

    const badges = document.createElement('div');
    badges.className = 'finding-badges';

    const invariantBadge = document.createElement('span');
    invariantBadge.className = 'pill-badge pill-invariant';
    invariantBadge.textContent = f.violation.invariant;

    const replayBadge = document.createElement('span');
    replayBadge.className = f.reproduced ? 'pill-badge pill-pass' : 'pill-badge pill-fail';
    replayBadge.textContent = f.reproduced ? 'Replay verified' : 'Replay failed';

    const cleanBadge = document.createElement('span');
    cleanBadge.className = f.cleanControlPassed ? 'pill-badge pill-pass' : 'pill-badge pill-fail';
    cleanBadge.textContent = f.cleanControlPassed ? 'Clean control passed' : 'Clean control failed';

    badges.appendChild(invariantBadge);
    badges.appendChild(replayBadge);
    badges.appendChild(cleanBadge);

    header.appendChild(title);
    header.appendChild(badges);

    const body = document.createElement('div');
    body.className = 'finding-body';

    const pHypo = document.createElement('p');
    const strongHypo = document.createElement('strong');
    strongHypo.textContent = 'Hypothesis: ';
    pHypo.appendChild(strongHypo);
    pHypo.appendChild(document.createTextNode(f.hypothesis));

    const pMsg = document.createElement('p');
    const strongMsg = document.createElement('strong');
    strongMsg.textContent = 'Failure Detail: ';
    pMsg.appendChild(strongMsg);
    pMsg.appendChild(document.createTextNode(f.violation.message));

    const pCategory = document.createElement('p');
    const strongCategory = document.createElement('strong');
    strongCategory.textContent = 'Observed category: ';
    pCategory.appendChild(strongCategory);
    pCategory.appendChild(document.createTextNode(findingCategoryLabel(f)));
    pCategory.appendChild(document.createTextNode(', what the oracle observed at this step, not a claimed root cause.'));

    const pStep = document.createElement('p');
    pStep.className = 'finding-meta';
    pStep.textContent = `Discovered at Experiment #${f.experimentIndex}, Step #${f.violation.step}. Source Hash: ${f.sourceHash}`;

    body.appendChild(pHypo);
    body.appendChild(pMsg);
    body.appendChild(pCategory);
    body.appendChild(pStep);

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn btn-primary btn-xs';
    openBtn.textContent = 'Open reproduction player';
    openBtn.setAttribute('aria-label', `Open reproduction player for finding ${i + 1}: ${f.title}`);
    openBtn.addEventListener('click', () => openReproductionForFinding(f));
    body.appendChild(openBtn);

    card.appendChild(header);
    card.appendChild(body);

    findingsContainer.appendChild(card);
  }
}

function renderRequirementRuleResults(experiments: ExperimentRecord[]): void {
  const body = document.getElementById('requirement-rule-results-body');
  if (!body) return;
  body.textContent = '';
  const rows = (experiments ?? []).flatMap((expRec, i) => (expRec.result?.requirementRuleResults ?? []).map(r => ({ r, label: expRec.index || i + 1 })));
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No requirement rule results recorded for this run.';
    body.appendChild(p);
    return;
  }
  for (const { r, label } of rows) {
    const section = document.createElement('article');
    const head = document.createElement('h4');
    head.textContent = `Experiment #${label} · ${r.status.replace('not-exercised', 'not exercised')} · Credit limit for accepted orders`;
    const meta = document.createElement('p');
    meta.textContent = `Requirement: "${r.requirement}" · ${r.matchedEvents} matching ${r.matchedEvents === 1 ? 'order' : 'orders'}`;
    section.append(head, meta);
    const list = document.createElement('ul');
    for (const ev of r.evidence) {
      const li = document.createElement('li');
      const where = ev.traceIndex !== undefined ? `recorded event ${ev.traceIndex + 1}` : 'experiment';
      const detail = ev.status === 'passed' || ev.status === 'failed'
        ? `Used ${ev.usedCredit ?? '?'} + reserved ${ev.reservedCredit ?? '?'} = ${ev.totalCredit ?? '?'}; limit ${ev.creditLimit ?? '?'}.`
        : ev.detail;
      li.textContent = `${ev.status.replace('not-exercised', 'not exercised')} (${where}): ${detail}`;
      list.appendChild(li);
    }
    section.appendChild(list);
    body.appendChild(section);
  }
}

function renderExperiments(experiments: ExperimentRecord[]): void {
  renderRequirementRuleResults(experiments ?? []);
  selectedExperimentIndex = clampSelectedIndex(selectedExperimentIndex, experiments?.length ?? 0);
  // Preserve keyboard focus across rerenders (polling refreshes this list).
  const focusedExperiment = document.activeElement instanceof HTMLButtonElement
    && experimentsContainer.contains(document.activeElement)
    ? document.activeElement.dataset.experimentIndex
    : undefined;
  experimentsContainer.textContent = '';
  if (!experiments || experiments.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No experiments executed yet.';
    experimentsContainer.appendChild(empty);
    return;
  }
  for (let i = 0; i < experiments.length; i++) {
    const expRec = experiments[i]!;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'experiment-item';
    const selected = i === selectedExperimentIndex;
    if (selected) item.classList.add('selected');
    item.setAttribute('aria-pressed', String(selected));
    item.dataset.experimentIndex = String(i);

    const left = document.createElement('span');
    left.className = 'exp-item-left';

    const indexEl = document.createElement('span');
    indexEl.className = 'exp-index';
    indexEl.textContent = `#${expRec.index || i + 1}`;

    const hypEl = document.createElement('span');
    hypEl.className = 'exp-hypothesis';
    hypEl.textContent = expRec.experiment.hypothesis;

    left.append(indexEl, hypEl);

    const right = document.createElement('span');
    right.className = 'experiment-item-right';

    const statusPillEl = document.createElement('span');
    const hasViolations = expRec.result.violations && expRec.result.violations.length > 0;
    if (hasViolations) {
      statusPillEl.className = 'pill-badge pill-fail';
      statusPillEl.textContent = `${expRec.result.violations.length} violation(s)`;
    } else if (expRec.result.valid) {
      statusPillEl.className = 'pill-badge pill-pass';
      statusPillEl.textContent = 'Valid · 0 violations';
    } else {
      statusPillEl.className = 'pill-badge pill-fail';
      statusPillEl.textContent = 'Invalid plan';
    }
    const hint = document.createElement('span');
    hint.className = 'exp-inspect-hint';
    hint.textContent = 'View trace';
    right.append(statusPillEl, hint);
    for (const ruleResult of expRec.result.requirementRuleResults ?? []) {
      const rulePill = document.createElement('span');
      rulePill.className = ruleResult.status === 'passed' ? 'pill-badge pill-pass' : ruleResult.status === 'failed' ? 'pill-badge pill-fail' : 'pill-badge';
      rulePill.textContent = `Check: ${ruleResult.status.replace('not-exercised', 'not exercised')}`;
      right.append(rulePill);
    }

    item.append(left, right);

    item.addEventListener('click', () => {
      reproPlayback.stop(); cancelStagePacket(); lastStageRenderKey = '';
      reproSession.clearFinding();
      reproSession.selectExperiment(i);
      clearFreshView(); reproShowFull = false;
      selectedExperimentIndex = i;
      renderExperiments(experiments);
      renderSelectedExperimentTrace();
      renderReproduction();
      const traceTab = document.getElementById('tab-btn-trace') as HTMLButtonElement | null;
      if (traceTab) activateTab(traceTab, true);
    });

    experimentsContainer.appendChild(item);
  }
  if (focusedExperiment !== undefined) {
    const focusIndex = clampSelectedIndex(Number(focusedExperiment), experiments.length);
    experimentsContainer.querySelector<HTMLButtonElement>(`[data-experiment-index="${focusIndex}"]`)?.focus({ preventScroll: true });
  }
}

/** State tab domain follows the inspected run's pinned adapter, never the selected profile. Returns the active presentation. */
function applyStatePresentation() {
  const presentation = statePresentationFor(stateKindForRecord(currentInvestigationRecord));
  const tabBtn = document.getElementById('tab-btn-state');
  if (tabBtn) tabBtn.textContent = presentation.tabTitle;
  const primary = document.getElementById('state-primary-title');
  if (primary) primary.textContent = presentation.primaryTitle;
  const secondary = document.getElementById('state-secondary-title');
  if (secondary) secondary.textContent = presentation.secondaryTitle;
  return presentation;
}

function appendStateRow(host: HTMLElement, key: string, text: string): void {
  const row = document.createElement('div');
  row.className = 'kv-row';
  const keySpan = document.createElement('span');
  keySpan.textContent = key;
  const valSpan = document.createElement('span');
  valSpan.textContent = text;
  row.appendChild(keySpan);
  row.appendChild(valSpan);
  host.appendChild(row);
}

function appendStateEmpty(host: HTMLElement, text: string): void {
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.textContent = text;
  host.appendChild(empty);
}

function renderSelectedExperimentTrace(): void {
  traceContainer.textContent = '';
  creditStateTable.textContent = '';
  ordersStateTable.textContent = '';
  const statePresentation = applyStatePresentation();

  if (!currentInvestigationRecord || !currentInvestigationRecord.experiments[selectedExperimentIndex]) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No experiment selected.';
    traceContainer.appendChild(empty);
    appendStateEmpty(creditStateTable, statePresentation.primaryEmpty);
    appendStateEmpty(ordersStateTable, statePresentation.secondaryEmpty);
    return;
  }

  const expRec = currentInvestigationRecord.experiments[selectedExperimentIndex]!;
  traceTitle.textContent = `Experiment #${selectedExperimentIndex + 1} Action Trace`;
  traceExpSelectorLabel.textContent = `Hypothesis: ${expRec.experiment.hypothesis}`;

  const trace = expRec.result.trace || [];
  if (trace.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No trace entries recorded for this experiment.';
    traceContainer.appendChild(empty);
  } else {
    for (const entry of trace) {
      const stepEl = document.createElement('div');
      stepEl.className = 'trace-step';

      const sStep = document.createElement('span');
      sStep.className = 'step-num';
      sStep.textContent = `Step ${entry.step}`;

      const sTime = document.createElement('span');
      sTime.className = 'step-time';
      sTime.textContent = `T=${entry.time}${entry.businessTime !== undefined ? ` (Biz ${entry.businessTime})` : ''}`;

      const sAction = document.createElement('span');
      sAction.className = 'step-action';
      sAction.textContent = entry.action;

      const sPayload = document.createElement('span');
      sPayload.className = 'step-payload';
      sPayload.textContent = entry.payload ? JSON.stringify(entry.payload) : (entry.messageId || '-');

      const sOutcome = document.createElement('span');
      sOutcome.className = 'step-outcome';
      sOutcome.textContent = entry.outcome;

      stepEl.appendChild(sStep);
      stepEl.appendChild(sTime);
      stepEl.appendChild(sAction);
      stepEl.appendChild(sPayload);
      stepEl.appendChild(sOutcome);

      traceContainer.appendChild(stepEl);
    }
  }

  // Render snapshot state using the pure display model for the inspected run's domain.
  // All target-derived strings are assigned via textContent (never HTML).
  if (statePresentation.kind === 'inventory') {
    const inventoryModel = extractInventorySnapshotDisplay(expRec.result.snapshot);
    if (!inventoryModel.hasStock) {
      appendStateEmpty(creditStateTable, inventoryModel.stockAvailable ? statePresentation.primaryEmpty : 'Stock state unavailable in snapshot.');
    } else {
      for (const stock of inventoryModel.stock) appendStateRow(creditStateTable, stock.sku, stock.displayText);
    }
    if (!inventoryModel.hasReservations) {
      appendStateEmpty(ordersStateTable, inventoryModel.reservationsAvailable ? statePresentation.secondaryEmpty : 'Reservation state unavailable in snapshot.');
    } else {
      for (const reservation of inventoryModel.reservations) appendStateRow(ordersStateTable, reservation.reservationId, reservation.displayText);
    }
    return;
  }
  if (statePresentation.kind === 'unknown') {
    appendStateEmpty(creditStateTable, statePresentation.primaryEmpty);
    appendStateEmpty(ordersStateTable, statePresentation.secondaryEmpty);
    return;
  }

  const displayModel = extractSnapshotDisplay(expRec.result.snapshot);

  const creditEntries: [string, string][] = [
    ['quotePrice', displayModel.credit.quotePrice],
    ['creditLimit', displayModel.credit.creditLimit],
    ['reservedCredit', displayModel.credit.reservedCredit],
    ['usedCredit', displayModel.credit.usedCredit],
    ['availableCredit', displayModel.credit.availableCredit],
  ];

  for (const [k, val] of creditEntries) appendStateRow(creditStateTable, k, val);

  if (!displayModel.hasOrders) {
    appendStateEmpty(ordersStateTable, statePresentation.secondaryEmpty);
  } else {
    for (const ord of displayModel.orders) appendStateRow(ordersStateTable, ord.orderId, ord.displayText);
  }
}

function reproEl<T extends HTMLElement>(id: string): T | null { return document.getElementById(id) as T | null; }
function clearReproductionDetail(): void { const facts = reproEl('repro-generic-facts'); if (facts) facts.textContent = ''; reproEl('repro-generic-facts-wrap')?.classList.add('hidden'); reproEl('repro-credit-wrap')?.classList.add('hidden'); const credit = reproEl('repro-credit'); if (credit) credit.textContent = NO_STEP_CREDIT_TEXT; reproEl('repro-exposure-bar')?.classList.add('hidden'); const legend = reproEl('repro-exposure-legend'); if (legend) legend.textContent = ''; const unattr = reproEl('repro-unattributed'); if (unattr) { unattr.classList.add('hidden'); unattr.textContent = ''; } }

function resetReproductionSelection(): void {
  challengeSession.select(null, null);
  reproPlayback.stop(); cancelStagePacket(); lastStageRenderKey = '';
  reproSession.clear();
  clearFreshView(); reproShowFull = false;
  reproModel = null;
}

function renderReproduction(): void {
  const rec = currentInvestigationRecord;
  if (rec && reproSession.syncToRun(rec.id)) { onReproRunChanged(rec); }
  if (reproSession.selectedFinding && rec && (resolveExperimentPosition(rec, reproSession.selectedFinding) !== selectedExperimentIndex || !rec.findings.some(f => f.id === reproSession.selectedFinding!.id))) reproSession.clearFinding();
  reproModel = rec ? buildReproductionModel(rec, selectedExperimentIndex, reproSession.selectedFinding) : null;
  if (rec && reproModel) {
    const source = reproUseRerun && reproSession.freshReport
      ? reproSession.freshReport.outcomes?.[0]?.replayedResult
      : rec.experiments[selectedExperimentIndex]?.result;
    reproStage = buildStageProjection(source?.trace ?? [], source?.violations ?? [], stateKindForRecord(rec), reproSession.selectedFinding?.violation ?? null);
  } else reproStage = null;
  const waitingForSave = rec ? replayWaitsForSave(rec, isInvestigationActive, activeRecordId) : false;
  challengeSession.select(rec, reproSession.selectedFinding?.id ?? null, waitingForSave);
  const reproEyebrow = reproEl('repro-eyebrow');
  if (reproEyebrow) reproEyebrow.textContent = waitingForSave ? 'Recorded experiments · investigation in progress' : 'Recorded evidence';
  const sourceIndicator = reproEl('repro-source-indicator');
  if (sourceIndicator) sourceIndicator.textContent = reproUseRerun ? 'Fresh rerun recording' : 'Original recording';
  const reproDescription = reproEl('repro-description');
  if (reproDescription) reproDescription.textContent = reproUseRerun ? 'Step through the trace recorded by the just-completed rerun of this experiment. Playing these rerun steps does not execute the target or contact a model. The original recording is still available.' : waitingForSave ? 'Step through the trace recorded so far. This investigation may not have been saved yet. Playing recorded steps does not execute the target or contact a model.' : 'Step through the recorded trace from this investigation to see how the issue unfolded. Playing recorded steps does not execute the target or contact a model.';
  const freshEl = reproEl('repro-fresh-status');
  if (freshEl) freshEl.textContent = waitingForSave
    ? 'Wait for this investigation to finish and be saved before rerunning it.'
    : reproSession.fresh.kind === 'idle' ? 'Rerun to check reproduction.' : describeFreshReplay(reproSession.fresh);
  const rerunBtn = reproEl<HTMLButtonElement>('btn-repro-rerun');
  if (rerunBtn) rerunBtn.disabled = !reproModel || waitingForSave || reproSession.fresh.kind === 'pending';
  // Evidence summary (pinned rule only; never fabricated)
  const evHeading = reproEl('repro-evidence-heading');
  if (evHeading) evHeading.textContent = evidenceHeading(reproUseRerun);
  const evBody = reproEl('repro-evidence-body');
  if (evBody) {
    evBody.textContent = '';
    if (reproModel) {
      const ev = reproModel.evidence;
      // Prominent: the rule, the observed failure and replay status.
      const prominent: [string,string][] = [
        ['Recorded invariant', ev.invariant ?? 'not recorded'],
        ['Observed category (not a claimed root cause)', ev.observedCategory],
        ['Violation (recorded)', ev.violationMessage ?? 'No violation recorded for this experiment'],
        [ev.ruleLabel, ev.ruleText ?? ''],
        ['Original reproduction (historical)', reproModel.replayLabel],
      ];
      // Verbose provenance stays available in expandable detail so the
      // timeline and controls remain easy to reach.
      const detailLines: [string,string][] = [
        ['Expected invariant (experiment)', ev.expectedInvariant ?? 'not recorded'],
        ['Hypothesis', ev.hypothesis],
        ['Clean comparison (historical, not a fresh rerun)', reproModel.cleanLabel],
        ['Run / experiment identity', `Run ${ev.runId} · experiment position ${ev.experimentPosition+1}${ev.experimentIndex!==null?` · recorded experiment #${ev.experimentIndex}`:' · recorded index not recorded'} · source hash ${ev.sourceHash ?? 'not recorded'}`],
        ['Trace', `${reproModel.traceCount} recorded trace entr${reproModel.traceCount===1?'y':'ies'}`],
      ];
      const appendLine = (host: HTMLElement, k: string, v: string) => { const row=document.createElement('p'); const b=document.createElement('strong'); b.textContent=v ? k+': ' : k; row.append(b, document.createTextNode(v)); host.appendChild(row); };
      for (const [k,v] of prominent) appendLine(evBody, k, v);
      const details = document.createElement('details');
      details.className = 'repro-evidence-details';
      const summary = document.createElement('summary');
      summary.textContent = 'More evidence and provenance (hypothesis, clean comparison, identity and hashes)';
      details.appendChild(summary);
      for (const [k,v] of detailLines) appendLine(details, k, v);
      if (ev.violations.length>1) { const extra=document.createElement('p'); extra.textContent=`All recorded violations: ${ev.violations.map(v=>`${v.invariant} at action #${v.step}: ${v.message}`).join(' · ')}`; details.appendChild(extra); }
      evBody.appendChild(details);
    }
  }
  const toggleBtn = reproEl<HTMLButtonElement>('btn-repro-toggle-trace');
  if (toggleBtn) { const concise = reproModel && reproModel.sequence!=='trace'; toggleBtn.disabled = !reproModel || !concise || reproUseRerun; toggleBtn.setAttribute('aria-expanded', String(reproShowFull)); toggleBtn.textContent = reproShowFull ? 'Show concise view' : 'Show complete original trace'; }
  const modeEl = reproEl('repro-trace-mode');
  if (modeEl) modeEl.textContent = !reproModel ? '' : reproUseRerun ? 'Showing fresh rerun trace (labelled rerun). Original recording still available' : reproShowFull ? `Showing complete original trace (${reproModel.traceCount} entries)` : reproModel.sequence==='key-events' ? 'Showing concise key events. Complete original trace available' : reproModel.sequence==='grouped' ? 'Showing concise grouped view. Complete original trace available' : `Showing complete recorded trace (${reproModel.traceCount} entries)`;
  const rerunControls = reproEl('repro-rerun-controls');
  if (rerunControls) rerunControls.classList.toggle('hidden', !(reproSession.freshReport && reproRerunSteps.length>=0 && reproSession.fresh.kind!=='pending' && reproSession.fresh.kind!=='idle'));
  const prov = reproEl('repro-provenance-items') ?? reproEl('repro-provenance');
  reproEl('repro-provenance')?.classList.toggle('hidden', !reproModel);
  const empty = reproEl('repro-empty');
  const body = reproEl('repro-body');
  const invalid = reproEl('repro-invalid');
  if (!reproModel) {
    reproPlayback.setCount(0);
    if (prov) prov.textContent = '';
    empty?.classList.remove('hidden'); body?.classList.add('hidden'); invalid?.classList.add('hidden');
    return;
  }
  if (prov) {
    prov.textContent = '';
    for (const text of [reproModel.modelLabel, `Run ID: ${reproModel.runId}`, reproModel.systemLabel, reproModel.briefLabel, reproModel.targetLabel, reproUseRerun ? 'Trace: fresh rerun trace (not the original recording)' : reproShowFull ? 'Trace: complete original trace' : reproModel.sequence === 'key-events' ? 'Trace: key recorded events; full trace available via Show complete original trace' : reproModel.sequence === 'grouped' ? 'Trace: concise grouped view; full trace available via Show complete original trace' : 'Trace: complete recorded trace', reproModel.replayLabel, reproModel.cleanLabel, reproModel.experimentLabel]) {
      const s = document.createElement('span'); s.textContent = text; prov.appendChild(s);
    }
  }
  if (invalid) {
    invalid.classList.toggle('hidden', reproModel.invalidLabel === null);
    invalid.textContent = reproModel.invalidLabel ?? '';
  }
  const effSteps = effectiveSteps();
  const key = timelineRenderKey({ runId: reproModel.runId, experimentIndex: selectedExperimentIndex, findingId: reproSession.selectedFinding?.id ?? '', sequence: reproModel.sequence, showFull: reproShowFull, useRerun: reproUseRerun, freshKind: reproSession.fresh.kind, steps: effSteps });
  if (key !== reproSession.renderedKey) {
    const prevKey = reproSession.renderedKey; reproSession.renderedKey = key; const sameSelection = prevKey !== '' && prevKey.split('|').slice(0, 4).join('|') === key.split('|').slice(0, 4).join('|');
    if (sameSelection) reproPlayback.refreshCount(effSteps.length); else reproPlayback.setCount(effSteps.length);
    const timeline = reproEl<HTMLOListElement>('repro-timeline');
    if (timeline) {
      timeline.setAttribute('aria-label', reproUseRerun ? 'Fresh rerun steps (playback of the completed rerun)' : 'Recorded steps');
      timeline.textContent = '';
      effSteps.forEach((step) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.reproPosition = String(step.position);
        if (step.isViolation) btn.classList.add('is-violation');
        btn.setAttribute('aria-label', `Show ${reproUseRerun ? 'fresh rerun step' : reproModel!.sequence === 'key-events' && !reproShowFull ? 'key event' : 'recorded step'} ${step.position + 1} of ${effSteps.length}: ${step.title}${step.isViolation ? '. Error: rule violation recorded at this action.' : ''}`);
        const t = document.createElement('span'); t.className = 'repro-tl-title'; t.textContent = `${step.position + 1}. ${step.title}`;
        const sub = document.createElement('span'); sub.className = 'repro-tl-sub';
        sub.textContent = step.isGroup ? `Grouped: ${step.groupCount} entries, expand full trace to inspect` : step.isViolation ? 'Error: rule violation recorded at this action' : step.kind === 'scheduled' ? 'Scheduled: not yet processed' : step.kind === 'rejected' ? 'Recorded rejection' : step.kind === 'processed' ? 'Processed: state after this entry' : step.outcome;
        btn.append(t, sub);
        btn.addEventListener('click', () => { cancelStagePacket(); reproPlayback.select(step.position); });
        li.appendChild(btn);
        timeline.appendChild(li);
      });
    }
  }
  if (empty) {
    const hasEff = effSteps.length>0;
    empty.classList.toggle('hidden', hasEff);
    if (!hasEff) empty.textContent = reproUseRerun ? `The fresh rerun returned no trace entries. The original recording is still available.${reproRerunUnattributed.length ? ` ${unattributedText(reproRerunUnattributed, true)}` : ''}` : 'No trace entries were recorded for this experiment. No playback state can be shown.';
  }
  body?.classList.toggle('hidden', !(effSteps.length>0));
  renderReproductionDetail();
}

function stageEl(tag: string, className: string, text?: string): HTMLElement { const el = document.createElement(tag); el.className = className; if (text !== undefined) el.textContent = text; return el; }
function appendComparison(host: HTMLElement, label: string, before: unknown, after: unknown, beforeLabel: string, afterLabel: string): void {
  const row = stageEl('div', 'repro-comparison');
  const field = stageEl('span', 'repro-comparison-field', label.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\./g, ' · '));
  field.title = label;
  row.appendChild(field);
  const b = stageEl('div', ''); const bs = stageEl('small', '', beforeLabel); const bv = stageEl('strong', '', formatRecordedValue(before)); b.append(bs, bv);
  const a = stageEl('div', ''); const as = stageEl('small', '', afterLabel); const av = stageEl('strong', '', formatRecordedValue(after)); a.append(as, av);
  row.append(b, stageEl('span', 'repro-comparison-arrow', '→'), a);
  host.appendChild(row);
}
function renderStageLens(host: HTMLElement, frame: StageFrame): void {
  const v = frame.visual;
  if (v.kind === 'not-recorded') { host.appendChild(stageEl('p', '', 'State was not recorded for this entry.')); return; }
  if (v.kind === 'capacity' && v.credit) {
    const c = v.credit;
    host.appendChild(stageEl('p', 'repro-lens-label', 'Credit exposure · used + reserved'));
    host.appendChild(stageEl('div', 'repro-lens-big', formatRecordedValue(c.total ?? undefined)));
    const bar = c.bar;
    if (bar && bar.mode === 'signed') {
      // Signed geometry: each component drawn from a zero origin; negative
      // values extend left and are never stacked as positive area.
      for (const seg of bar.segments) {
        const row = stageEl('div', 'repro-signed-row');
        row.appendChild(stageEl('span', 'repro-signed-label', `${seg.label}: ${formatRecordedValue(seg.value)}`));
        const track = stageEl('div', 'repro-signed-track'); track.setAttribute('aria-hidden', 'true');
        const zero = stageEl('span', 'repro-zero'); zero.style.left = `${bar.zeroPct}%`; track.appendChild(zero);
        const el = stageEl('span', `repro-seg repro-seg-${seg.label}${seg.negative ? ' repro-seg-negative' : ''}`); el.style.left = `${seg.left}%`; el.style.width = `${seg.width}%`; track.appendChild(el);
        row.appendChild(track); host.appendChild(row);
      }
      if (bar.limitPct !== null) host.appendChild(stageEl('p', '', `Credit limit ${formatRecordedValue(c.limit ?? undefined)}`));
    } else if (bar) {
      const stack = stageEl('div', 'repro-stack'); stack.setAttribute('aria-hidden', 'true');
      for (const seg of bar.segments) { const el = stageEl('span', `repro-seg repro-seg-${seg.label}`); el.style.left = `${seg.left}%`; el.style.width = `${seg.width}%`; stack.appendChild(el); }
      if (bar.limitPct !== null) { const marker = stageEl('span', 'repro-limit-marker'); marker.style.left = `${Math.max(0, Math.min(100, bar.limitPct))}%`; marker.appendChild(stageEl('span', '', `Limit ${formatRecordedValue(c.limit ?? undefined)}`)); stack.appendChild(marker); }
      host.appendChild(stack);
    } else {
      host.appendChild(stageEl('p', '', 'Some credit values were not recorded.'));
    }
    const legend = stageEl('div', 'repro-legend');
    legend.setAttribute('aria-label', `Used ${formatRecordedValue(c.used ?? undefined)}, reserved ${formatRecordedValue(c.reserved ?? undefined)}, total ${formatRecordedValue(c.total ?? undefined)}, limit ${formatRecordedValue(c.limit ?? undefined)} on a fixed whole-trace scale`);
    for (const [cls, text] of [['repro-seg-used', `Used: ${formatRecordedValue(c.used ?? undefined)}`], ['repro-seg-reserved', `Reserved: ${formatRecordedValue(c.reserved ?? undefined)}`]] as [string, string][]) { const item = stageEl('span', ''); const sw = stageEl('span', 'repro-sw'); sw.style.background = cls === 'repro-seg-used' ? '#39d5e8' : '#f5c86b'; item.append(sw, document.createTextNode(text)); legend.appendChild(item); }
    legend.appendChild(stageEl('span', '', `Total: ${formatRecordedValue(c.total ?? undefined)} · Limit: ${formatRecordedValue(c.limit ?? undefined)}`));
    host.appendChild(legend);
    for (const row of v.comparison) appendComparison(host, row.label, row.before, row.after, 'Expected', 'Observed');
    return;
  }
  if (v.kind === 'stock') {
    host.appendChild(stageEl('p', 'repro-lens-label', 'Inventory balance'));
    for (const r of v.stockRows) {
      const rowEl = stageEl('div', 'repro-stock-row');
      rowEl.setAttribute('aria-label', `SKU ${r.sku}: received ${formatRecordedValue(r.received ?? undefined)}, on hand ${formatRecordedValue(r.onHand ?? undefined)}, reserved remaining ${formatRecordedValue(r.reservedRemaining ?? undefined)}, available ${formatRecordedValue(r.available ?? undefined)}${r.overReserved ? ', over-reserved' : ''}`);
      rowEl.append(stageEl('strong', '', r.sku), stageEl('span', '', `Received ${formatRecordedValue(r.received ?? undefined)}`), stageEl('span', '', `On hand ${formatRecordedValue(r.onHand ?? undefined)}`), stageEl('span', '', `Reserved ${formatRecordedValue(r.reservedRemaining ?? undefined)}`), stageEl('span', '', `Available ${formatRecordedValue(r.available ?? undefined)}${r.overReserved ? ' (over-reserved)' : ''}`));
      host.appendChild(rowEl);
    }
    for (const row of v.comparison) appendComparison(host, row.label, row.before, row.after, 'Expected', 'Observed');
    return;
  }
  if (v.kind === 'version') {
    host.appendChild(stageEl('p', 'repro-lens-label', 'Version change'));
    if (!v.versionChanges.length) host.appendChild(stageEl('p', '', 'No recorded version change at this entry.'));
    for (const row of v.versionChanges) appendComparison(host, `${row.label}${row.regressed ? ' · moved backwards' : ''}`, row.before, row.after, 'Before', 'After');
    return;
  }
  if (v.kind === 'lifecycle') {
    host.appendChild(stageEl('p', 'repro-lens-label', 'Status & quantities'));
    if (!v.statusChanges.length && !v.quantities.length) host.appendChild(stageEl('p', '', 'No recorded status change at this entry.'));
    for (const d of v.statusChanges) appendComparison(host, d.path, d.before, d.after, 'Before', 'After');
    for (const d of v.quantities) appendComparison(host, d.path, d.before, d.after, 'Before', 'After');
    return;
  }
  if (v.kind === 'identity') {
    host.appendChild(stageEl('p', 'repro-lens-label', 'Event deliveries'));
    host.appendChild(stageEl('div', 'repro-lens-big', v.occurrences === null ? 'not recorded' : `${v.occurrences}×`));
    host.appendChild(stageEl('p', '', v.eventIdentity ? `Deliveries so far · ${v.eventIdentity}` : 'No event identity recorded.'));
    host.appendChild(stageEl('p', '', v.stateChanged === null ? 'State change unknown' : v.stateChanged ? 'State changed' : 'State unchanged'));
    for (const c of v.conflicts) appendComparison(host, `Conflicting field: ${c.field}`, c.recordedValue, c.eventValue, c.recordedLabel, 'This event');
    return;
  }
  host.appendChild(stageEl('p', 'repro-lens-label', 'Recorded state change'));
  if (!v.comparison.length) host.appendChild(stageEl('p', '', frame.stateStatus === 'first-recorded' ? 'First recorded state · earlier values unavailable' : 'No recorded state change at this entry.'));
  for (const row of v.comparison) appendComparison(host, row.label, row.before, row.after, 'Before', 'After');
  if (v.changeCount > v.comparison.length) host.appendChild(stageEl('p', '', `${v.changeCount} recorded field changes in total; complete state is in the recorded evidence below.`));
  if (v.negativeChanges.length) host.appendChild(stageEl('p', '', `Signed negative recorded value: ${v.negativeChanges.map(d => `${d.path} = ${formatRecordedValue(d.after)}`).join(', ')}`));
}
function renderStage(step: PlaybackStep | undefined, eff: PlaybackStep[]): void {
  const set = (id: string, text: string) => { const el = reproEl(id); if (el) el.textContent = text; };
  const changeNode = reproEl('repro-stage-change-node'); const marker = reproEl('repro-stage-marker'); const banner = reproEl('repro-stage-banner'); const lens = reproEl('repro-stage-lens');
  const scrubber = reproEl<HTMLInputElement>('repro-scrubber'); const jump = reproEl<HTMLButtonElement>('btn-repro-jump');
  if (scrubber) {
    // The range includes the controller's before-first position, so the first
    // step remains reachable immediately after opening or resetting a replay.
    scrubber.max = String(Math.max(-1, eff.length - 1));
    scrubber.value = String(reproPlayback.position);
    scrubber.disabled = eff.length === 0;
    scrubber.setAttribute('aria-valuetext', eff.length === 0 ? 'No recorded steps'
      : reproPlayback.position < 0 ? 'No step selected' : `Step ${reproPlayback.position + 1} of ${eff.length}`);
  }
  const jumpTarget = reproStage ? (visiblePositionForTracePosition(eff, reproStage.findingTracePosition) ?? visiblePositionForTracePosition(eff, reproStage.groupFindingTracePosition)) : null;
  if (jump) jump.disabled = jumpTarget === null;
  if (lens) lens.textContent = '';
  changeNode?.classList.remove('is-violation', 'is-group'); marker?.classList.remove('is-on', 'is-group'); banner?.classList.remove('is-violation', 'is-group');
  if (!step) {
    cancelStagePacket(); lastStageRenderKey = '';
    set('repro-stage-event', '—'); set('repro-stage-system', reproModel?.systemLabel.replace(/^System:\s*/, '') ?? 'Recorded system'); set('repro-stage-change', '—');
    if (marker) marker.textContent = ''; if (banner) banner.textContent = eff.length ? 'No step selected yet. Play or step to show the first recorded entry.' : 'No trace entries recorded.';
    if (lens) lens.appendChild(stageEl('p', '', 'No recorded state is shown before the first step.'));
    return;
  }
  set('repro-stage-system', reproModel?.systemLabel.replace(/^System:\s*/, '') ?? 'Recorded system');
  if (step.isGroup) {
    cancelStagePacket(); lastStageRenderKey = '';
    set('repro-stage-event', step.title); set('repro-stage-change', 'Grouped summary');
    if (banner) banner.textContent = 'Grouped entries — show complete trace to inspect each one.';
    if (lens) { lens.appendChild(stageEl('p', 'repro-lens-label', 'Grouped recorded entries')); lens.appendChild(stageEl('p', '', step.detail)); }
    return;
  }
  // Resolve the visual frame against the same trace this step belongs to,
  // via its raw tracePosition — never via the visible-sequence index.
  const frame = reproStage?.frames[step.tracePosition];
  if (!frame) { cancelStagePacket(); lastStageRenderKey = ''; set('repro-stage-event', step.title); set('repro-stage-change', step.stateText); return; }
  const outcome = step.outcome?.replace(/^delivered:/, '').replace(/[_-]+/g, ' ');
  set('repro-stage-event', `${frame.eventName} · ${outcome ? outcome.charAt(0).toUpperCase() + outcome.slice(1) : 'Recorded'}`);
  set('repro-stage-change', !frame.stateKnown ? 'State not recorded' : frame.stateStatus === 'first-recorded' ? 'First recorded state' : frame.diffs.length ? `${frame.diffs.length} recorded field change${frame.diffs.length === 1 ? '' : 's'}` : 'No recorded state change');
  const deduped = [...new Map([...frame.violationsHere, ...frame.groupViolations].map(v => [`${v.invariant}|${v.message}`, v])).values()];
  if (frame.isViolation) {
    changeNode?.classList.add('is-violation'); marker?.classList.add('is-on');
    if (marker) marker.textContent = '✕ Finding recorded here';
    if (banner) { banner.classList.add('is-violation'); banner.textContent = `Finding recorded here: ${deduped.map(v => v.message).join(' · ')}`; }
  } else if (frame.isGroupFinding) {
    changeNode?.classList.add('is-group'); marker?.classList.add('is-on', 'is-group');
    if (marker) marker.textContent = '! Finding at this action';
    if (banner) { banner.classList.add('is-group'); banner.textContent = `Finding at this action: ${deduped.map(v => v.message).join(' · ')}`; }
  } else if (banner) banner.textContent = 'No violation recorded';
  if (lens) renderStageLens(lens, frame);
  const stageKey = `${reproSession.renderedKey}|${reproPlayback.position}|${reproUseRerun ? 'rerun' : 'original'}`;
  if (stageKey !== lastStageRenderKey) { lastStageRenderKey = stageKey; animateStagePacket(); }
}

function renderReproductionDetail(): void {
  const model = reproModel;
  if (!model) { clearReproductionDetail(); return; }
  const eff = effectiveSteps();
  if (eff.length===0) { clearReproductionDetail(); }
  const pos = reproPlayback.position;
  const step = pos >= 0 ? eff[pos] : undefined;
  const set = (id: string, text: string) => { const el = reproEl(id); if (el) el.textContent = text; };
  let selectedButton: HTMLButtonElement | null = null;
  document.querySelectorAll<HTMLButtonElement>('[data-repro-position]').forEach(btn => {
    if (Number(btn.dataset.reproPosition) === pos) { btn.setAttribute('aria-current', 'step'); selectedButton = btn; }
    else btn.removeAttribute('aria-current');
  });
  // Keep the active recorded event visible inside the timeline without moving
  // the surrounding page while playback advances.
  const timeline = reproEl<HTMLOListElement>('repro-timeline');
  if (timeline && selectedButton) {
    const itemBounds = (selectedButton as HTMLButtonElement).getBoundingClientRect();
    const listBounds = timeline.getBoundingClientRect();
    if (itemBounds.top < listBounds.top) timeline.scrollTop -= listBounds.top - itemBounds.top;
    else if (itemBounds.bottom > listBounds.bottom) timeline.scrollTop += itemBounds.bottom - listBounds.bottom;
  }
  const playBtn = reproEl<HTMLButtonElement>('btn-repro-play');
  if (playBtn) {
    playBtn.textContent = reproPlayback.playing ? 'Pause recorded playback' : 'Play recorded steps';
    playBtn.setAttribute('aria-pressed', String(reproPlayback.playing));
  }
  const prevBtn = reproEl<HTMLButtonElement>('btn-repro-prev');
  if (prevBtn) prevBtn.disabled = pos < 0;
  const nextBtn = reproEl<HTMLButtonElement>('btn-repro-next');
  if (nextBtn) nextBtn.disabled = pos >= eff.length - 1 && !reproPlayback.playing;
  const unattributed = reproEl('repro-unattributed');
  if (unattributed) {
    const activeUnattributed = activeUnattributedViolations(reproUseRerun, model.unattributedViolations, reproRerunUnattributed);
    unattributed.classList.toggle('hidden', activeUnattributed.length === 0);
    unattributed.textContent = activeUnattributed.length
      ? unattributedText(activeUnattributed, reproUseRerun)
      : '';
  }
  if (!step) {
    const keyEvents = model.sequence === 'key-events';
    set('repro-step-count', `No ${keyEvents ? 'key event' : 'recorded step'} shown yet · ${eff.length} ${keyEvents ? 'key events' : 'recorded steps'}${reproUseRerun ? ' (fresh rerun trace)' : ''}`);
    set('repro-step-title', keyEvents ? 'Before the first key event' : 'Before the first recorded step');
    set('repro-step-kind', 'No recorded state is selected yet.');
    set('repro-step-detail', keyEvents
      ? 'Play or step through the selected key events; the complete sequence remains in the action trace.'
      : 'Press Play recorded steps or Next step to show the first recorded entry exactly as recorded.');
    set('repro-observed-text', 'Nothing has been played yet. No outcome is claimed.');
    reproEl('repro-expected')?.classList.add('hidden');
    reproEl('repro-observed')?.classList.remove('is-violation');
    const noStepVis = detailVisibility(false, model.evidence.creditRelevant); const factsEl0 = reproEl('repro-generic-facts'); if (factsEl0) factsEl0.textContent = ''; reproEl('repro-generic-facts-wrap')?.classList.toggle('hidden', !noStepVis.factsVisible); reproEl('repro-credit-wrap')?.classList.toggle('hidden', !noStepVis.creditVisible); set('repro-credit', '');
    const creditHost = reproEl('repro-credit'); if (creditHost) creditHost.textContent = NO_STEP_CREDIT_TEXT;
    reproEl('repro-exposure-bar')?.classList.add('hidden');
    set('repro-exposure-legend', '');
    set('repro-action', 'not recorded'); set('repro-outcome', 'not recorded'); set('repro-payload', 'not recorded'); set('repro-state', 'not recorded');
    renderStage(undefined, eff);
    return;
  }
  const explanation = explainStep(step, step.violations);
  set('repro-step-count', step.isGroup ? `Grouped summary ${step.position + 1} of ${eff.length} · trace entries ${(step.groupTracePositions ?? []).map(p => p + 1).join(', ')} · not a single recorded entry` : `${reproUseRerun ? 'Fresh rerun step' : model.sequence === 'key-events' && !reproShowFull ? 'Key event' : 'Step'} ${step.position + 1} of ${eff.length} · trace entry ${step.tracePosition + 1} · recorded action #${step.actionIndex} · T=${step.time}`);
  set('repro-step-title', step.title);
  set('repro-step-kind', step.kindLabel);
  set('repro-step-detail', step.detail);
  const expectedBox = reproEl('repro-expected');
  if (expectedBox) {
    expectedBox.classList.toggle('hidden', explanation.expected === null);
    expectedBox.classList.toggle('is-hypothetical', explanation.expected !== null);
    set('repro-expected-label', explanation.expectedLabel ?? '');
    set('repro-expected-text', explanation.expected ?? '');
  }
  const observedBox = reproEl('repro-observed');
  observedBox?.classList.toggle('is-violation', explanation.observedIsViolation);
  set('repro-observed-text', explanation.observed);
  const factsEl = reproEl('repro-generic-facts');
  if (factsEl) { factsEl.textContent=''; const facts = step.isGroup ? step.facts : step.facts; if (!facts.length) { const li=document.createElement('li'); li.textContent='No recorded facts for this entry.'; factsEl.appendChild(li); } for (const f of facts) { const li=document.createElement('li'); li.textContent=f; factsEl.appendChild(li); } }
  const creditWrap = reproEl('repro-credit-wrap');
  if (creditWrap) creditWrap.classList.toggle('hidden', !detailVisibility(true, model.evidence.creditRelevant).creditVisible || !!step.isGroup);
  reproEl('repro-generic-facts-wrap')?.classList.toggle('hidden', !detailVisibility(true, model.evidence.creditRelevant).factsVisible);
  const creditHost = reproEl('repro-credit');
  if (creditHost && model.evidence.creditRelevant) {
    creditHost.textContent = '';
    const c = step.credit;
    const creditAdmissionViolated = step.violations.some(isCreditAdmissionViolation);
    const figures: [string, string][] = c
      ? [['Limit', fmtCredit(c.limit)], ['Total exposure', fmtCredit(c.total)], ['Used', fmtCredit(c.used)], ['Reserved', fmtCredit(c.reserved)]]
      : [['Limit', 'not recorded'], ['Total exposure', 'not recorded'], ['Used', 'not recorded'], ['Reserved', 'not recorded']];
    for (const [label, value] of figures) {
      const box = document.createElement('div'); box.className = 'repro-figure';
      if (label === 'Total exposure' && creditAdmissionViolated) box.classList.add('is-violation');
      const lab = document.createElement('span'); lab.textContent = label;
      const b = document.createElement('b'); b.textContent = value;
      box.append(lab, b); creditHost.appendChild(box);
    }
    const bar = reproEl('repro-exposure-bar');
    const usedEl = reproEl('repro-bar-used'); const resEl = reproEl('repro-bar-reserved');
    const layout = creditBarLayout(c);
    if (c && layout && bar && usedEl && resEl) {
      bar.classList.remove('hidden');
      bar.classList.toggle('has-limit', layout.limit !== null);
      if (layout.limit !== null) bar.style.setProperty('--repro-limit', `${layout.limit}%`);
      usedEl.style.width = `${layout.used}%`;
      resEl.style.width = `${layout.reserved}%`;
      set('repro-exposure-legend', `Used: ${fmtCredit(c.used)} · Reserved: ${fmtCredit(c.reserved)} · Total exposure: ${fmtCredit(c.total)} · Limit: ${fmtCredit(c.limit)}${layout.limit !== null ? ' · Marker shows the limit.' : ''}${creditAdmissionViolated ? ' · Error: this recorded admission violated the credit limit rule.' : ' · Exposure above the limit alone is not shown as a violation; only recorded check evidence is.'}`);
    } else {
      bar?.classList.add('hidden');
      const legend = !c
        ? 'Credit state: not recorded for this entry.'
        : c.used === null || c.reserved === null || c.total === null
          ? 'Recorded credit figures are incomplete for this entry (shown as not recorded above).'
          : c.used < 0 || c.reserved < 0
            ? 'The recorded credit state contains a negative balance; a stacked exposure bar is not available.'
            : 'No credit is used or reserved at this step.';
      set('repro-exposure-legend', legend);
    }
  }
  set('repro-action', `${step.action}${step.messageId ? ` · message ${step.messageId}` : ''}`);
  set('repro-outcome', step.outcome || 'not recorded');
  set('repro-payload', step.payloadText);
  set('repro-state', step.stateText);
  renderStage(step, eff);
  const resetBtn = reproEl<HTMLButtonElement>('btn-repro-reset');
  if (resetBtn) resetBtn.disabled = eff.length === 0;
  if (playBtn) playBtn.disabled = eff.length === 0;
}

function openReproductionForFinding(finding: Finding, focusPlayer = true): void {
  const rec = currentInvestigationRecord;
  if (!rec) return;
  const position = resolveExperimentPosition(rec, finding);
  if (position < 0) { showAlert('The experiment for this finding is not present in the opened run, so its recorded reproduction cannot be shown.'); return; }
  reproPlayback.stop();
  clearFreshView(); reproShowFull=false;
  selectedExperimentIndex = position;
  reproSession.selectFinding(finding, position);
  renderExperiments(rec.experiments);
  renderSelectedExperimentTrace();
  renderReproduction();
  if (focusPlayer) {
    document.getElementById('reproduction-player')?.scrollIntoView({ block: 'start' });
    reproEl('repro-title')?.focus({ preventScroll: true });
  }
  announce(`Opened recorded reproduction for finding: ${finding.title}`);
}

async function rerunSavedInvestigation(): Promise<void> {
  const rec = currentInvestigationRecord;
  if (!rec || replayWaitsForSave(rec, isInvestigationActive, activeRecordId) || reproSession.fresh.kind === 'pending') return;
  const runId = rec.id;
  const position = selectedExperimentIndex;
  const findingId = reproSession.selectedFinding?.id ?? null;
  const seq = reproSession.beginFresh(runId, position, findingId);
  clearFreshView();
  renderReproduction();
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/experiments/${encodeURIComponent(String(position))}/replay`, { method: 'POST' });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error((err as { error?: string }).error || `HTTP ${res.status}`); }
    const report = (await res.json()) as ExperimentReplayReport;
    if (!reproSession.settleFreshReport(seq, runId, report, position, findingId)) return;
    const rerunTrace = buildRerunTrace(report); reproRerunSteps = rerunTrace.steps; reproRerunUnattributed = rerunTrace.unattributedViolations;
    reproUseRerun = false;
    renderReproduction();
  } catch (e) {
    if (!reproSession.settleFreshError(seq, runId, e instanceof Error ? e.message : String(e), position, findingId)) return;
    renderReproduction();
  }
}

async function openRun(id: string): Promise<void> {
  const token = recordSequencer.next();
  if (lifecycle.openLive(id) && latestLiveRecord && latestLiveRecord.id === id) { isInspectingHistory = false; resetReproductionSelection(); selectedExperimentIndex = 0; currentInvestigationRecord = latestLiveRecord; renderActiveRecord(latestLiveRecord); renderFindingsView(); announce(`Opened investigation ${id}.`); return; }
  if (activeRecordId && id === activeRecordId) { renderEmptyDashboard('Investigation is starting.'); return; }
  try {
    const runRes = await fetch(`/api/runs/${encodeURIComponent(id)}`);
    if (!runRes.ok) throw new Error(`HTTP ${runRes.status}`);
    const rec: InvestigationRecord = await runRes.json();
    if (!recordSequencer.isCurrent(token)) return;
    lifecycle.openHistory(rec.id); isInspectingHistory = true;
    resetReproductionSelection();
    selectedExperimentIndex = 0;
    currentInvestigationRecord = rec;
    renderActiveRecord(rec);
    renderFindingsView();
    announce(`Opened saved run ${rec.id}.`);
  } catch (err) {
    if (!recordSequencer.isCurrent(token)) return;
    showAlert(`Failed to open run: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function buildRunRow(r: RunSummary, includeBrief: boolean): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const cells: string[] = includeBrief
    ? [r.id, r.systemBrief ? `Rev ${r.systemBrief.revision} - ${r.systemBrief.name}` : 'Legacy / system unavailable', r.variant, `${r.provider} (${r.mode})`, runOutcomeLabel(r.status), `${r.experimentsCount}`, `${r.findingsCount}`, new Date(r.startedAt).toLocaleString()]
    : [r.id, r.variant, `${r.provider} (${r.mode})`, runOutcomeLabel(r.status), `${r.experimentsCount}`, `${r.findingsCount}`, new Date(r.startedAt).toLocaleString()];
  cells.forEach((text, idx) => { const td = document.createElement('td'); if (idx === 0) td.className = 'run-id-cell'; td.textContent = text; tr.appendChild(td); });
  const tdActions = document.createElement('td');
  const actionGroup = document.createElement('div'); actionGroup.className = 'action-btns';
  const btnView = document.createElement('button'); btnView.className = 'btn btn-secondary btn-xs'; btnView.type = 'button'; btnView.textContent = 'View';
  btnView.addEventListener('click', () => { showView('investigations', false); void openRun(r.id); });
  const btnReplay = document.createElement('button'); btnReplay.className = 'btn btn-primary btn-xs'; btnReplay.type = 'button'; btnReplay.textContent = 'Replay';
  btnReplay.addEventListener('click', async (event) => {
    lastFocusedElement = event.currentTarget as HTMLElement; btnReplay.disabled = true;
    try {
      const replayRes = await fetch(`/api/runs/${encodeURIComponent(r.id)}/replay`, { method: 'POST' });
      if (!replayRes.ok) { const err = await replayRes.json(); throw new Error(err.error || 'Replay failed'); }
      showReplayReport(await replayRes.json());
    } catch (e) { showAlert(`Replay failed: ${e instanceof Error ? e.message : String(e)}`); } finally { btnReplay.disabled = false; }
  });
  const btnExport = document.createElement('button'); btnExport.className = 'btn btn-secondary btn-xs'; btnExport.type = 'button'; btnExport.textContent = 'Export JSON';
  btnExport.addEventListener('click', async () => {
    const runRes = await fetch(`/api/runs/${encodeURIComponent(r.id)}`);
    if (runRes.ok) { const jsonText = await runRes.text(); const blob = new Blob([jsonText], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${r.id}.json`; a.click(); URL.revokeObjectURL(url); }
  });
  actionGroup.append(btnView, btnReplay, btnExport); tdActions.appendChild(actionGroup); tr.appendChild(tdActions); return tr;
}
function renderHistory(): void {
  const { scoped, legacy } = partitionRuns(lastRunSummaries, workspaceSystemId());
  const scopeNote = document.getElementById('history-scope-note');
  if (scopeNote) scopeNote.textContent = isDraftMode ? 'Unsaved draft: no saved investigations are scoped to it yet. The previous saved system is retained only so you can discard back to it.' : selectedSystem ? `Scoped to ${selectedSystem.name}. Current saved brief is revision ${selectedSystem.revision}; historical runs keep their pinned revision.` : 'Select a system to scope history.';
  historyTbody.textContent = '';
  if (!scoped.length) {
    const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 9; td.className = 'text-center'; td.textContent = 'No saved investigations for this system yet.'; tr.appendChild(td); historyTbody.appendChild(tr);
  } else {
    for (const group of groupRunsByRevision(scoped)) {
      const header = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 9; td.className = 'revision-group'; td.textContent = group.revision === null ? 'Brief revision unavailable' : `Brief revision ${group.revision}`; header.appendChild(td); historyTbody.appendChild(header);
      for (const r of group.runs) historyTbody.appendChild(buildRunRow(r, true));
    }
  }
  const legacyTbody = document.getElementById('legacy-tbody');
  if (legacyTbody) {
    legacyTbody.textContent = '';
    if (!legacy.length) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 8; td.className = 'text-center'; td.textContent = 'No legacy records.'; tr.appendChild(td); legacyTbody.appendChild(tr); }
    else for (const r of legacy) legacyTbody.appendChild(buildRunRow(r, false));
  }
  renderWorkspaceSummaries(); renderFindingsView();
}
async function loadHistory(): Promise<void> {
  const token = historySequencer.next();
  try {
    const res = await fetch('/api/runs');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const runs: RunSummary[] = await res.json();
    if (!historySequencer.isCurrent(token)) return;
    lastRunSummaries = runs; renderHistory();
  } catch (err) { if (!historySequencer.isCurrent(token)) return; showAlert(`Failed to load history: ${err instanceof Error ? err.message : String(err)}`); }
}

function showReplayReport(report: ReplayReport): void {
  replayReportBody.textContent = '';

  const addLine = (label: string, value: string, highlight?: boolean) => {
    const row = document.createElement('div');
    row.className = 'kv-row';
    const lSpan = document.createElement('span');
    lSpan.textContent = label;
    const vSpan = document.createElement('span');
    vSpan.textContent = value;
    if (highlight) vSpan.className = 'highlight';
    row.appendChild(lSpan);
    row.appendChild(vSpan);
    replayReportBody.appendChild(row);
  };

  addLine('Replayed Run ID:', report.runId);
  addLine('Target Variant:', report.variant);
  addLine('Original Source Hash:', report.originalSourceHash);
  addLine('Current Source Hash:', report.currentSourceHash);
  addLine('Source Identical Match:', report.sourceIdentical ? 'YES' : 'NO (Source changed)');
  addLine('Exact Reproduction Claimed:', report.exactReproductionClaimed ? 'CONFIRMED' : 'CANNOT BE CLAIMED', !report.exactReproductionClaimed);
  const scoped = (report as ExperimentReplayReport).scope === 'experiment';
  const behaviour = scoped ? replayBehaviourStatus(report.outcomes[0]) : 'unavailable';
  const behaviourMatchedCount = report.outcomes.filter(o => replayBehaviourStatus(o) === 'matched').length;
  const allBehaviourMatched = report.outcomes.length > 0 && behaviourMatchedCount === report.outcomes.length;
  addLine(scoped ? 'Scope:' : 'Experiments Matched:', scoped ? `Selected experiment (position ${(report as ExperimentReplayReport).experimentPosition ?? '?'} ) only: no clean comparison or model call` : `${report.experimentsReproduced} / ${report.experimentsTotal}`);
  if (scoped) addLine('Selected experiment behaviour (trace, snapshot, violations, rejections, validity):', behaviour.toUpperCase());
  else if (report.outcomes.length) addLine('Behaviour matched (trace, snapshot, violations, rejections, validity, regardless of source/context):', `${behaviourMatchedCount} / ${report.outcomes.length}`);
  if (report.contextStatus) addLine('Replay Context:', report.contextStatus === 'verified' ? 'VERIFIED' : report.contextStatus === 'drifted' ? 'DRIFTED: exact reproduction cannot be claimed' : report.contextStatus === 'legacy-unknown' ? 'LEGACY: pinned context was not recorded' : 'UNVERIFIED: exact reproduction cannot be claimed', report.contextStatus !== 'verified');
  const outcome = replayOutcome(report);
  addLine('Deterministic Replay Result:', !report.sourceIdentical ? ((scoped ? behaviour === 'matched' : allBehaviourMatched) ? 'BEHAVIOUR MATCHED, SOURCE CHANGED: exact reproduction cannot be claimed' : (scoped ? behaviour === 'different' : report.outcomes.some(o => replayBehaviourStatus(o) === 'different')) ? 'BEHAVIOUR MISMATCH AND SOURCE CHANGED: exact reproduction cannot be claimed' : 'SOURCE CHANGED: exact reproduction cannot be claimed') : outcome === 'reproduced' ? (scoped ? 'SELECTED EXPERIMENT REPRODUCED EXACTLY (verified: identical source and semantic match)' : 'ALL EXPERIMENTS REPRODUCED') : outcome === 'unconfirmed' ? 'EXPERIMENTS MATCHED; EXACT REPLAY UNCONFIRMED' : outcome === 'empty' ? 'NO EXPERIMENTS REPLAYED' : 'MISMATCH DETECTED');
  addLine('Replay Engine:', 'Local Deterministic Simulator (No model invocation)');

  const noteEl = document.createElement('div');
  noteEl.className = 'provenance-notice';
  noteEl.textContent = report.note || '';
  replayReportBody.appendChild(noteEl);

  replayModal.classList.remove('hidden'); btnCloseReplay.focus();
}

// -------------------------------------------------------------
// System Briefs Workspace Logic
// -------------------------------------------------------------

function setSaveStatus(type: 'saved' | 'draft' | 'error', text: string): void {
  if (!systemSaveStatus) return;
  systemSaveStatus.className = `system-save-status status-${type}`;
  systemSaveStatus.textContent = text;
}

function updateAdapterBadge(adapterId: string): void {
  if (!systemAdapterBadge) return;
  systemAdapterBadge.textContent = adapterId;
  systemAdapterBadge.className = isExecutableAdapter(adapterId) ? 'system-badge badge-adapter-exec' : 'system-badge badge-adapter-unconfigured';
  const visible = contractChecksVisible({ effectiveAdapterId: adapterId, snapshotState: effectiveSnapshotState(), isDraftMode, hasUnsavedSystemEdits });
  const listsVisible = visible && contractListsVisible(adapterId);
  document.getElementById('invariants-list')?.classList.toggle('hidden', !visible);
  document.getElementById('raw-contract-view')?.closest('details')?.classList.toggle('hidden', !visible);
  document.getElementById('contract-lists')?.classList.toggle('hidden', !listsVisible);
  document.getElementById('capabilities-scope-note')?.classList.toggle('hidden', listsVisible);
  const heading = document.getElementById('contract-availability-title');
  const description = document.getElementById('contract-availability-description');
  const note = document.getElementById('capabilities-scope-note');
  if (isExecutableAdapter(adapterId) && !visible) {
    if (heading) heading.textContent = `${adapterLabel(adapterId)} Rules & Available Checks`;
    if (description) description.textContent = snapshotState === 'error' ? 'The system contract could not be loaded. Checks are unavailable until it loads successfully.' : 'Loading the selected system contract… Checks are unavailable until it is confirmed.';
    if (note) note.textContent = 'The selected system contract is not confirmed yet, so no operations, messages or checks are shown.';
  } else if (isExecutableAdapter(adapterId)) {
    if (heading) heading.textContent = adapterId === 'inventory-reservation' ? 'Synthetic Inventory Reservation Rules & Available Checks' : 'Synthetic Trading Rules & Available Checks';
    if (description) description.textContent = 'These checks are available to the deterministic verifier for the selected system. Their presence is not evidence that an investigation exercised them. Supplementary prose does not alter these checks.';
  } else {
    if (heading) heading.textContent = 'No Executable Contract Configured';
    if (description) description.textContent = 'This profile can preserve business requirements, but it has no execution adapter or deterministic checks. Investigations are disabled.';
    if (note) note.textContent = 'No adapter is configured for this system, so there is no supported execution contract to show. Operations and message vocabulary from another system are not listed here because they would not run for this system.';
  }
}

const requestPreflight = new RequestPreflight(text => {
  const el = document.getElementById('request-preflight');
  if (el) {
    el.textContent = text;
    el.classList.toggle('warn', requestPreflight.warning);
  }
  updateRunReadiness();
});
function selectedMaxExperiments(): number {
  return Math.min(Math.max(1, Math.floor(Number(maxExperimentsInput.value) || 5)), 20);
}

function updateRequestPreflight(): void {
  functionalController.setContext({
    systemId: selectedSystem?.id ?? null, revision: selectedSystem?.revision ?? null,
    isDraftMode, hasUnsavedSystemEdits, isSystemSavePending,
    hasSelectedSystem: Boolean(selectedSystem), selectedAdapterId: effectiveAdapter(),
    snapshotState: effectiveSnapshotState(), targetState: effectiveTargetState(),
    selectedVariant: targetSelection.selection, allowedVariants: scopedVariants(),
  });
  const validSelection = selectedSystem && !isDraftMode && !hasUnsavedSystemEdits
    && effectiveSnapshotState() === 'ready' && effectiveTargetState() === 'ready'
    && scopedVariants().includes(targetSelect.value);
  void requestPreflight.update(validSelection && selectedSystem ? {
    systemId: selectedSystem.id, expectedRevision: selectedSystem.revision, adapterId: selectedSystem.adapterId,
    variant: targetSelect.value, provider: providerSelect.value,
    maxExperiments: selectedMaxExperiments()
  } : null);
}

function updateRunReadiness(): void {
  updateRequestPreflight();
  const reason = launchBlockedReason();
  btnLaunch.disabled = reason !== null;
  btnLaunch.title = reason ?? '';
  const launchReadiness = document.getElementById('launch-readiness');
  if (launchReadiness) {
    launchReadiness.textContent = reason ? reason.charAt(0) + reason.slice(1).toLowerCase() : '';
    launchReadiness.classList.toggle('hidden', reason === null);
  }
  syncStopControls();
  if (targetSelect) targetSelect.disabled = effectiveTargetState() !== 'ready' || scopedVariants().length === 0;
  if (systemSelect) systemSelect.disabled = isLaunchRequestPending || isSystemSavePending;
  if (btnNewSystem) btnNewSystem.disabled = isLaunchRequestPending || isSystemSavePending;
  renderWorkspaceSummaries();
  if (!adapterReadinessLabel) return;
  adapterReadinessLabel.className = `readiness-label ${reason ? 'readiness-disabled' : 'readiness-ready'}`;
  adapterReadinessLabel.textContent = reason ? reason.charAt(0) + reason.slice(1).toLowerCase() : 'Ready for investigation';
}

function launchBlockedReason(): string | null {
  const reason = launchBlockedReasonPure({
    isLaunchRequestPending,
    isInvestigationActive,
    isSystemSavePending,
    isDraftMode,
    hasUnsavedSystemEdits,
    hasSelectedSystem: Boolean(selectedSystem),
    selectedAdapterId: selectedSystem?.adapterId ?? null,
    snapshotState: effectiveSnapshotState(),
    selectedVariant: targetSelect?.value || null,
    allowedVariants: scopedVariants(),
    targetState: effectiveTargetState(),
  });
  if (reason) return reason;
  if (providerSelect.value === 'meta' && requestPreflight.checking) return 'Checking the initial request size.';
  if (providerSelect.value === 'meta' && requestPreflight.overLimit) return 'The initial request exceeds the configured size limit.';
  return null;
}

function setSystemSavePending(pending: boolean): void {
  isSystemSavePending = pending;
  for (const control of [systemSelect, btnNewSystem, systemIdInput, systemNameInput,
    systemAdapterSelect, systemOverviewInput, systemRequirementsInput, btnSaveSystem, btnDiscardSystem]) {
    control.disabled = pending;
  }
  renderRequirementRulePanel();
  updateRunReadiness();
}

function markUnsavedEdits(): void {
  renderRequirementRulePanel();
  hasUnsavedSystemEdits = true;
  snapshotSequencer.invalidate(); snapshotState = 'none'; snapshotSystemId = null; snapshotIdentity = null;
  setSaveStatus('draft', isDraftMode ? 'New Profile (Draft)' : 'Unsaved Edits (Draft)');
  clearContractDisplay();
  updateAdapterBadge(systemAdapterSelect.value);
  resetTargetChoices();
  updateRunReadiness();
}
function clearContractDisplay(): void {
  contractCheckCount = 0;
  for (const id of ['operations-list', 'messages-list']) {
    const host = document.getElementById(id);
    if (host) { host.textContent = ''; const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'No confirmed contract for the selected system.'; host.appendChild(p); }
  }
  if (invariantsList) invariantsList.textContent = '';
  if (rawContractView) rawContractView.textContent = '';
}

function selectSystem(system: SystemBrief): void { recordSequencer.invalidate(); if (shouldClearInspectionOnSelection({ recordId: currentInvestigationRecord?.id ?? null, recordSystemId: currentInvestigationRecord?.systemBrief?.brief.id ?? null, activeRecordId, selectedSystemId: system.id })) { currentInvestigationRecord = null; lifecycle.clearInspection(); isInspectingHistory = false; resetReproductionSelection(); renderEmptyDashboard('No investigation selected for this system. Open a saved run from its history below.'); }
  selectedSystem = system;
  isDraftMode = false;
  hasUnsavedSystemEdits = false;

  if (systemSelect) systemSelect.value = system.id;
  if (systemIdInput) {
    systemIdInput.value = system.id;
    systemIdInput.readOnly = true;
  }
  if (systemNameInput) systemNameInput.value = system.name;
  if (systemAdapterSelect) systemAdapterSelect.value = system.adapterId;
  if (systemOverviewInput) systemOverviewInput.value = system.overview;
  if (systemRequirementsInput) systemRequirementsInput.value = system.requirements.join('\n');
  draftRequirementRules = structuredClone(system.requirementRules ?? []);
  if (requirementRuleReviewed) requirementRuleReviewed.checked = false;
  renderRequirementRulePanel();

  if (systemRevisionBadge) systemRevisionBadge.textContent = `Rev ${system.revision}`;
  renderHistory();
  updateActiveOtherSystemNotice();
  snapshotSequencer.invalidate();
  snapshotSystemId = system.id;
  snapshotIdentity = null;
  snapshotState = isExecutableAdapter(system.adapterId) ? 'loading' : 'none';
  clearContractDisplay();
  resetTargetChoices(isExecutableAdapter(system.adapterId) ? 'loading' : 'idle');
  updateAdapterBadge(system.adapterId);
  setSaveStatus('saved', 'Saved');
  updateRunReadiness();
  if (isExecutableAdapter(system.adapterId)) { void fetchSystemContract(system.id); void fetchAdapterTargetsForSelected(system); }
  if (systemFeedback) systemFeedback.textContent = ''; updateInspectionNotice(); syncStopControls(); renderFindingsView();
}

function populateSystemSelect(): void {
  if (!systemSelect) return;
  const currentSelectedVal = selectedSystem?.id || systemSelect.value;
  while (systemSelect.firstChild) {
    systemSelect.removeChild(systemSelect.firstChild);
  }
  for (const s of loadedSystems) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.name} (Rev ${s.revision}) [${s.adapterId}]`;
    systemSelect.appendChild(opt);
  }
  if (currentSelectedVal && loadedSystems.some(s => s.id === currentSelectedVal)) {
    systemSelect.value = currentSelectedVal;
  }
}

async function postStopRequest(): Promise<StopPostResult> {
  const res = await fetch('/api/investigation/stop', { method: 'POST' });
  return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: await parseApiErrorResponse(res) };
}

async function loadSystems(): Promise<void> {
  try {
    const systems = await fetchSystemBriefs((url) => fetch(url));
    loadedSystems = systems;

    populateSystemSelect();

    const currentId = selectedSystem?.id;
    if (currentId && loadedSystems.some(s => s.id === currentId)) {
      if (!hasUnsavedSystemEdits) {
        const updated = loadedSystems.find(s => s.id === currentId)!;
        selectSystem(updated);
      }
    } else if (loadedSystems.length > 0) {
      if (!hasUnsavedSystemEdits) {
        selectSystem(loadedSystems[0]!);
      }
    }
  } catch (err) {
    const message = `Failed to load system profiles: ${err instanceof Error ? err.message : String(err)}`;
    showAlert(loadedSystems.length ? `${message} The previously loaded profiles and any unsaved edits have been kept.` : `${message} No system profiles could be loaded.`);
    if (systemFeedback) { systemFeedback.textContent = message; systemFeedback.className = 'action-feedback error'; }
  }
}

async function fetchAdapterTargetsForSelected(system: SystemBrief): Promise<void> {
  const expected = { id: system.id, revision: system.revision, adapterId: system.adapterId };
  await loadAdapterTargets({
    fetchFn: (url) => fetch(url),
    adapterId: system.adapterId,
    sequencer: targetSequencer,
    isCurrentSelection: () => Boolean(
      selectedSystem && selectedSystem.id === expected.id
      && selectedSystem.revision === expected.revision
      && selectedSystem.adapterId === expected.adapterId
      && !isDraftMode && !hasUnsavedSystemEdits,
    ),
    onLoading: () => {
      targetSelection.beginLoad(expected, targetSelect?.value || null);
      refreshTargetChoices(); updateRunReadiness();
    },
    onReady: (variants) => {
      targetSelection.applyReady(expected, variants);
      refreshTargetChoices(); updateRunReadiness();
    },
    onEmpty: () => {
      targetSelection.applyEmpty(expected);
      refreshTargetChoices(); updateRunReadiness();
    },
    onError: () => {
      targetSelection.applyError(expected);
      refreshTargetChoices(); updateRunReadiness();
    },
  });
}

async function fetchSystemContract(systemId: string): Promise<void> {
  const expected = selectedSystem && selectedSystem.id === systemId
    ? { id: systemId, revision: selectedSystem.revision, adapterId: selectedSystem.adapterId }
    : { id: systemId };
  await loadSystemContract({
    fetchFn: (url) => fetch(url),
    expected,
    sequencer: snapshotSequencer,
    isCurrentSelection: () => Boolean(
      selectedSystem && selectedSystem.id === expected.id
      && (expected.revision === undefined || selectedSystem.revision === expected.revision)
      && (expected.adapterId === undefined || selectedSystem.adapterId === expected.adapterId)
      && !isDraftMode && !hasUnsavedSystemEdits,
    ),
    onLoading: () => {
      snapshotState = 'loading'; snapshotSystemId = systemId; snapshotIdentity = null;
      updateAdapterBadge(effectiveAdapter() ?? 'unconfigured'); updateRunReadiness();
    },
    onReady: (snapshot) => {
      snapshotState = 'ready'; snapshotSystemId = snapshot.brief.id;
      snapshotIdentity = { id: snapshot.brief.id, revision: snapshot.brief.revision, adapterId: snapshot.brief.adapterId };
      renderContract(snapshot.contract!);
      updateRunReadiness();
    },
    onIncompatible: () => {
      snapshotState = 'incompatible'; snapshotIdentity = null; clearContractDisplay();
      updateAdapterBadge(effectiveAdapter() ?? 'unconfigured'); updateRunReadiness();
    },
    onError: (err) => {
      snapshotState = 'error'; snapshotIdentity = null; clearContractDisplay();
      updateAdapterBadge(effectiveAdapter() ?? 'unconfigured'); updateRunReadiness();
      if (systemFeedback) {
        systemFeedback.textContent = `System contract unavailable: ${err instanceof Error ? err.message : String(err)} Reselect or reload the system profile to retry.`;
        systemFeedback.className = 'action-feedback error';
      }
    },
  });
}

function renderKeyedList(id: string, items: Record<string, unknown>[] | undefined, label: (item: Record<string, unknown>) => string): void {
  const host = document.getElementById(id);
  if (!host) return;
  host.textContent = '';
  if (!items?.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'None in the public contract.';
    host.appendChild(p);
    return;
  }
  const ul = document.createElement('ul');
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = label(item);
    ul.appendChild(li);
  }
  host.appendChild(ul);
}

function renderContract(contract: SystemContract): void {
  contractCheckCount = Array.isArray(contract.invariants) ? contract.invariants.length : 0;
  renderKeyedList('operations-list', contract.operations, item => formatContractEntry(item));
  renderKeyedList('messages-list', contract.messages, item => formatContractEntry(item)); updateAdapterBadge(effectiveAdapter() ?? 'unconfigured');
  renderWorkspaceSummaries();
  if (rawContractView) {
    rawContractView.textContent = JSON.stringify(contract, null, 2);
  }
  if (invariantsList) {
    invariantsList.textContent = '';
    if (contract.invariants && Array.isArray(contract.invariants)) {
      for (const inv of contract.invariants) {
        const card = document.createElement('div');
        card.className = 'invariant-card';
        const idEl = document.createElement('div');
        idEl.className = 'invariant-id';
        idEl.textContent = inv.id;
        const descEl = document.createElement('div');
        descEl.className = 'invariant-desc';
        descEl.textContent = inv.description;
        card.appendChild(idEl);
        card.appendChild(descEl);
        invariantsList.appendChild(card);
      }
    }
  }
}

// -------------------------------------------------------------
// Event Listeners
// -------------------------------------------------------------

btnLaunch.addEventListener('click', async () => {
  hideAlert();
  const reason = launchBlockedReason();
  const systemToRun = selectedSystem;
  if (reason || !systemToRun) {
    showAlert(reason ?? 'Please select a saved system profile.');
    return;
  }
  recordSequencer.invalidate(); lifecycle.beginLaunch(); latestLiveRecord = null; isInspectingHistory = false; currentInvestigationRecord = null; resetReproductionSelection(); renderEmptyDashboard('Starting investigation…'); serverRunStatus = 'starting';
  selectedExperimentIndex = 0;
  const variant = targetSelect.value as TargetVariant;
  const provider = providerSelect.value as ProviderKind;
  const maxExperiments = selectedMaxExperiments();

  isLaunchRequestPending = true;
  statusCoordinator.invalidate();
  updateRunReadiness();

  try {
    const res = await fetch('/api/investigation/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        variant,
        provider,
        maxExperiments,
        continueAfterFindings: continueAfterFindingsInput?.checked === true,
        systemId: systemToRun.id,
        expectedRevision: systemToRun.revision,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      if (classifyStartFailure({ status: res.status, code: (err as { code?: string }).code ?? null, stopRequested: lifecycle.pendingStopIntent }) === 'intentional-stop') { lifecycle.settleStart(); isInvestigationActive = false; serverRunStatus = 'idle'; renderEmptyDashboard('Investigation stopped before it started.'); announce('Investigation stopped before it started.'); return; }
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    isInvestigationActive = true;
    const { deferredStop } = lifecycle.settleStart(); if (deferredStop) { serverRunStatus = 'stopping'; const deferred = await executeDeferredStop(postStopRequest); if (deferred.outcome === 'failed') { showAlert(`Failed to stop investigation: ${deferred.error ?? 'unknown error'}`); } else if (deferred.outcome === 'stopping') serverRunStatus = 'stopping'; }
    showView('investigations');
    statusCoordinator.invalidate();
    startPolling();
    await fetchStatus();
  } catch (err) {
    showAlert(`Failed to start investigation: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    lifecycle.settleStart();
    isLaunchRequestPending = false;
    updateRunReadiness();
  }
});

async function handleStop(): Promise<void> {
  if (serverRunStatus === 'stopping') return;
  const disableStopControls = () => { for (const b of [btnStop, btnStopGlobal, btnStopDashboard]) if (b) b.disabled = true; };
  await requestInvestigationStop({
    lifecycle,
    postStop: postStopRequest,
    onDeferred: () => { serverRunStatus = 'stopping'; syncStopControls(); disableStopControls(); announce('Stop requested. It will take effect when the start request settles.'); },
    onStopping: () => { statusCoordinator.invalidate(); serverRunStatus = 'stopping'; syncStopControls(); disableStopControls(); },
    onStopped: () => { startPolling(); void fetchStatus(); },
    onFailure: (message) => { showAlert(`Failed to stop investigation: ${message}`); serverRunStatus = isInvestigationActive ? 'running' : 'idle'; syncStopControls(); void fetchStatus(); },
  });
}


btnStop.addEventListener('click', () => { void handleStop(); }); btnStopGlobal?.addEventListener('click', () => { void handleStop(); }); btnStopDashboard?.addEventListener('click', () => { void handleStop(); }); document.getElementById('btn-open-global-run')?.addEventListener('click', openActiveRun);
btnRefreshHistory.addEventListener('click', () => {
  loadHistory();
});
document.getElementById('btn-report-refresh')?.addEventListener('click', () => { void refreshReportStatus(); });
document.getElementById('btn-challenge-muse')?.addEventListener('click', () => { void challengeSession.generate(); });
document.getElementById('btn-challenge-cancel')?.addEventListener('click', () => { challengeSession.cancel(); });
document.getElementById('btn-challenge-refresh')?.addEventListener('click', () => { void challengeSession.refresh(); });
document.getElementById('btn-report-meta')?.addEventListener('click', () => { void createReport('meta'); });
document.getElementById('btn-report-offline')?.addEventListener('click', () => { void createReport('offline'); });
document.getElementById('btn-report-view')?.addEventListener('click', () => openSavedReport(false));
document.getElementById('btn-report-download')?.addEventListener('click', () => openSavedReport(true));

alertClose.addEventListener('click', () => {
  hideAlert();
});

document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(btn => { btn.addEventListener('click', () => showView(btn.dataset.view as WorkspaceView)); });
document.getElementById('btn-open-active-run')?.addEventListener('click', openActiveRun);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !replayModal.classList.contains('hidden')) { replayModal.classList.add('hidden'); lastFocusedElement?.focus(); } });
btnCloseReplay.addEventListener('click', () => { lastFocusedElement?.focus();
  replayModal.classList.add('hidden');
});

providerSelect.addEventListener('change', () => {
  updateRequestPreflight();
  fetchStatus();
});

maxExperimentsInput.addEventListener('input', updateRequestPreflight);

if (targetSelect) {
  targetSelect.addEventListener('change', () => {
    // Explicit choice wins over any earlier captured preference for the next refresh.
    targetSelection.select(targetSelect.value || null);
    updateRequestPreflight();
  });
}

// System Profile selection & editing events
if (systemSelect) {
  systemSelect.addEventListener('change', () => {
    if (hasUnsavedSystemEdits) {
      systemSelect.value = selectedSystem?.id ?? '';
      showAlert('Save or discard your requirement edits before switching systems.');
      return;
    }
    const chosen = loadedSystems.find(s => s.id === systemSelect.value);
    if (chosen) {
      selectSystem(chosen);
    }
  });
}

if (btnNewSystem) {
  btnNewSystem.addEventListener('click', () => {
    if (hasUnsavedSystemEdits) {
      showAlert('Save or discard your requirement edits before creating another system.');
      return;
    }
    isDraftMode = true;
    hasUnsavedSystemEdits = true;
    snapshotSequencer.invalidate(); snapshotState = 'none'; snapshotSystemId = null; snapshotIdentity = null; clearContractDisplay(); resetTargetChoices();
    const newId = `profile-${Date.now().toString(36)}`;
    systemIdInput.value = newId;
    systemIdInput.readOnly = false;
    systemNameInput.value = 'New System Profile';
    systemAdapterSelect.value = 'unconfigured';
    systemOverviewInput.value = '';
    systemRequirementsInput.value = '';
    draftRequirementRules = [];
    if (requirementRuleReviewed) requirementRuleReviewed.checked = false;
    renderRequirementRulePanel();
    systemRevisionBadge.textContent = 'Rev 1 (Draft)'; renderHistory(); renderFindingsView(); showView('brief');
    updateAdapterBadge('unconfigured');
    setSaveStatus('draft', 'New Draft');
    updateRunReadiness();
    systemFeedback.textContent = '';
  });
}

if (btnDiscardSystem) {
  btnDiscardSystem.addEventListener('click', () => {
    if (selectedSystem) {
      selectSystem(selectedSystem);
      systemFeedback.textContent = 'Changes discarded.';
      systemFeedback.className = 'action-feedback';
      setTimeout(() => {
        if (systemFeedback.textContent === 'Changes discarded.') systemFeedback.textContent = '';
      }, 3000);
    }
  });
}

if (btnSaveSystem) {
  btnSaveSystem.addEventListener('click', async () => {
    systemFeedback.textContent = 'Saving...';
    systemFeedback.className = 'action-feedback';

    const id = systemIdInput.value.trim();
    const name = systemNameInput.value.trim();
    const adapterId = systemAdapterSelect.value;
    const overview = systemOverviewInput.value;
    const rawReqs = systemRequirementsInput.value.split('\n');
    const requirements = rawReqs.map(r => r.trim()).filter(r => r.length > 0);

    if (!id || id.length < 3 || id.length > 64 || !/^[a-z0-9_-]+$/.test(id)) {
      systemFeedback.textContent = 'Error: ID must be 3-64 lowercase letters, numbers, dashes or underscores';
      systemFeedback.className = 'action-feedback error';
      return;
    }

    if (!name) {
      systemFeedback.textContent = 'Error: System Name is required';
      systemFeedback.className = 'action-feedback error';
      return;
    }

    const payload = {
      schemaVersion: 1,
      id,
      revision: isDraftMode ? 1 : (selectedSystem ? selectedSystem.revision : 1),
      name,
      overview,
      requirements,
      ...(draftRequirementRules.length ? { requirementRules: structuredClone(draftRequirementRules) } : {}),
      adapterId,
      updatedAt: new Date().toISOString(),
    };

    try {
      setSystemSavePending(true);
      let res: Response;
      if (isDraftMode) {
        res = await fetch('/api/systems', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } else {
        res = await fetch(`/api/systems/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }

      if (res.status === 409) {
        const errJson = await res.json();
        systemFeedback.textContent = `Conflict (409): ${errJson.error || 'Revision conflict'}`;
        systemFeedback.className = 'action-feedback error';
        setSaveStatus('error', 'Revision Conflict (409)');
        showAlert(`System profile save conflict: ${errJson.error || 'A newer revision exists. Please reload.'}`);
        return;
      }

      if (!res.ok) {
        const errJson = await res.json();
        throw new Error(errJson.error || `HTTP ${res.status}`);
      }

      const savedBrief: SystemBrief = await res.json();
      isDraftMode = false;
      hasUnsavedSystemEdits = false;
      await loadSystems();
      selectSystem(savedBrief);

      systemFeedback.textContent = `Saved successfully as Rev ${savedBrief.revision}!`;
      systemFeedback.className = 'action-feedback success';
      setTimeout(() => {
        if (systemFeedback.textContent.includes('Saved successfully')) systemFeedback.textContent = '';
      }, 3000);
    } catch (err) {
      systemFeedback.textContent = `Save failed: ${err instanceof Error ? err.message : String(err)}`;
      systemFeedback.className = 'action-feedback error';
      setSaveStatus('error', 'Save Error');
    } finally {
      setSystemSavePending(false);
    }
  });
}

if (systemNameInput) systemNameInput.addEventListener('input', markUnsavedEdits);
if (systemAdapterSelect) systemAdapterSelect.addEventListener('change', markUnsavedEdits);
if (systemOverviewInput) systemOverviewInput.addEventListener('input', markUnsavedEdits);
if (systemRequirementsInput) systemRequirementsInput.addEventListener('input', markUnsavedEdits);
if (btnAttachRequirementRule) btnAttachRequirementRule.addEventListener('click', () => {
  if (isSystemSavePending) return;
  const requirement = requirementRuleSelect?.value ?? '';
  if (!requirement) { showAlert('Select a requirement line before attaching a rule.'); return; }
  if (!requirementRuleReviewed?.checked) { showAlert('Review the check above, then tick the review box before attaching it.'); return; }
  if (draftRequirementRules.some(r => r.requirement === requirement)) { showAlert('That requirement already has the supported rule attached.'); return; }
  draftRequirementRules = [...draftRequirementRules, { requirement, preset: 'accepted-order-credit-limit', reviewed: true }];
  if (requirementRuleReviewed) requirementRuleReviewed.checked = false;
  markUnsavedEdits();
});

// Tab switching (WAI-ARIA tab pattern: roving tabindex, arrow/Home/End)
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab-btn'));
function activateTab(btn: HTMLButtonElement, moveFocus: boolean): void {
  tabButtons.forEach((b) => {
    const selected = b === btn;
    b.classList.toggle('active', selected);
    b.setAttribute('aria-selected', String(selected));
    b.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
  const targetId = btn.getAttribute('data-tab');
  if (targetId) document.getElementById(targetId)?.classList.add('active');
  if (moveFocus) btn.focus();
}
tabButtons.forEach((btn, index) => {
  btn.addEventListener('click', () => activateTab(btn, false));
  btn.addEventListener('keydown', (event) => {
    const next = tabIndexForKey(index, event.key, tabButtons.length);
    if (next === null) return;
    event.preventDefault();
    const target = tabButtons[next];
    if (target) activateTab(target, true);
  });
});
activateTab(tabButtons.find(b => b.classList.contains('active')) ?? tabButtons[0]!, false);

// Reproduction player controls (recorded playback only)
reproEl<HTMLButtonElement>('btn-repro-prev')?.addEventListener('click', () => { cancelStagePacket(); reproPlayback.previous(); });
reproEl<HTMLButtonElement>('btn-repro-next')?.addEventListener('click', () => { cancelStagePacket(); reproPlayback.next(); });
reproEl<HTMLButtonElement>('btn-repro-reset')?.addEventListener('click', () => { cancelStagePacket(); lastStageRenderKey = ''; reproPlayback.reset(); });
reproEl<HTMLButtonElement>('btn-repro-play')?.addEventListener('click', () => {
  if (reproPlayback.playing) { reproPlayback.pause(); cancelStagePacket(); }
  else reproPlayback.play();
  renderReproductionDetail();
});
reproEl<HTMLButtonElement>('btn-repro-rerun')?.addEventListener('click', () => { void rerunSavedInvestigation(); });
reproEl<HTMLButtonElement>('btn-repro-report')?.addEventListener('click', () => {
  if (!reproSession.freshReport) return;
  lastFocusedElement = reproEl<HTMLButtonElement>('btn-repro-report');
  // The session retains the endpoint report through a narrower evidence type.
  showReplayReport(reproSession.freshReport as ExperimentReplayReport);
});
reproEl<HTMLButtonElement>('btn-repro-jump')?.addEventListener('click', () => {
  if (!reproStage) return;
  const eff = effectiveSteps();
  const target = visiblePositionForTracePosition(eff, reproStage.findingTracePosition) ?? visiblePositionForTracePosition(eff, reproStage.groupFindingTracePosition);
  if (target !== null) { cancelStagePacket(); reproPlayback.select(target); }
});
reproEl<HTMLInputElement>('repro-scrubber')?.addEventListener('input', (event) => {
  const value = Number((event.target as HTMLInputElement).value);
  if (Number.isFinite(value)) { cancelStagePacket(); reproPlayback.select(value); }
});
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const onReduced = (event: MediaQueryListEvent) => { reproPlayback.handleReducedMotion(event.matches); if (event.matches) cancelStagePacket(); renderReproductionDetail(); };
  if (typeof reduced.addEventListener === 'function') reduced.addEventListener('change', onReduced);
}
reproEl<HTMLButtonElement>('btn-repro-toggle-trace')?.addEventListener('click', () => { cancelStagePacket(); lastStageRenderKey = ''; reproShowFull = !reproShowFull; reproUseRerun = false; reproSession.renderedKey=''; reproPlayback.setCount(effectiveSteps().length); renderReproduction(); });
reproEl<HTMLButtonElement>('btn-repro-show-original')?.addEventListener('click', () => { cancelStagePacket(); lastStageRenderKey = ''; reproUseRerun = false; reproSession.renderedKey=''; reproPlayback.setCount(effectiveSteps().length); renderReproduction(); });
reproEl<HTMLButtonElement>('btn-repro-show-rerun')?.addEventListener('click', () => { if (!reproSession.freshReport) return; cancelStagePacket(); lastStageRenderKey = ''; reproUseRerun = true; reproSession.renderedKey=''; reproPlayback.setCount(effectiveSteps().length); renderReproduction(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { reproPlayback.handleHidden(); cancelStagePacket(); renderReproductionDetail(); }
});
activateTab(tabButtons.find(b => b.classList.contains('active')) ?? tabButtons[0]!, false);

const functionalController = initFunctionalWorkspaceView(variant => {
  targetSelection.select(variant);
  targetSelect.value = targetSelection.selection ?? '';
  updateRunReadiness();
});

renderEmptyDashboard('No investigation selected. Open a saved run from history or prepare a new investigation.'); syncStopControls(); showView('overview', false);
// Initialization - showView('overview', false) below
fetchStatus();
loadHistory();
loadSystems();
startPolling();
