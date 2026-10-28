import type { RunSummary } from '../storage.ts';

export type WorkspaceView = 'overview' | 'brief' | 'capabilities' | 'prepare' | 'investigations' | 'findings';

export const WORKSPACE_VIEWS: readonly WorkspaceView[] = [
  'overview', 'brief', 'capabilities', 'prepare', 'investigations', 'findings',
];

export interface RunPartition {
  /** Runs pinned to the selected system. */
  scoped: RunSummary[];
  /** Records with no system snapshot: never silently assigned to a system. */
  legacy: RunSummary[];
  /** Runs pinned to a different system. */
  other: RunSummary[];
}

export function partitionRuns(runs: readonly RunSummary[], selectedSystemId: string | null): RunPartition {
  const scoped: RunSummary[] = [];
  const legacy: RunSummary[] = [];
  const other: RunSummary[] = [];
  for (const run of runs) {
    if (!run.systemBrief) legacy.push(run);
    else if (selectedSystemId !== null && run.systemBrief.id === selectedSystemId) scoped.push(run);
    else other.push(run);
  }
  return { scoped, legacy, other };
}

export interface RevisionGroup {
  revision: number | null; // null = legacy / unavailable
  runs: RunSummary[];
}

/** Groups scoped runs by their pinned brief revision, newest revision first; legacy last. */
export function groupRunsByRevision(runs: readonly RunSummary[]): RevisionGroup[] {
  const byRevision = new Map<number | null, RunSummary[]>();
  for (const run of runs) {
    const key = run.systemBrief ? run.systemBrief.revision : null;
    const bucket = byRevision.get(key);
    if (bucket) bucket.push(run);
    else byRevision.set(key, [run]);
  }
  return [...byRevision.entries()]
    .map(([revision, groupRuns]) => ({ revision, runs: groupRuns }))
    .sort((a, b) => {
      if (a.revision === null) return 1;
      if (b.revision === null) return -1;
      return b.revision - a.revision;
    });
}

/** Adapters with a deterministic executable contract on this server. Keep in step with src/adapters/index.ts; an adapter becomes executable only when the backend can save, snapshot and run it. */
export const EXECUTABLE_ADAPTER_IDS = ['synthetic-trading', 'inventory-reservation'] as const;
export const INVENTORY_ADAPTER_ID = 'inventory-reservation';
export const TRADING_ADAPTER_ID = 'synthetic-trading';
export const ADAPTER_LABELS: Record<string, string> = {
  'synthetic-trading': 'Synthetic trading',
  'inventory-reservation': 'Synthetic inventory reservation',
  unconfigured: 'No adapter configured',
};
export function isExecutableAdapter(adapterId: string | null | undefined): boolean {
  return adapterId === TRADING_ADAPTER_ID || adapterId === INVENTORY_ADAPTER_ID;
}
export function adapterLabel(adapterId: string | null | undefined): string {
  return ADAPTER_LABELS[adapterId ?? ''] ?? 'No adapter configured';
}
export type TargetLoadState = 'idle' | 'loading' | 'ready' | 'error';

export type TargetVariantsValidation =
  | { ok: true; variants: string[] }
  | { ok: false; reason: string };

/** Validates a per-adapter `/api/targets` payload. No variant is invented here. */
export function validateTargetVariantsResponse(data: unknown): TargetVariantsValidation {
  if (!Array.isArray(data)) return { ok: false, reason: 'target response is not a list' };
  const variants: string[] = [];
  for (const item of data) {
    if (typeof item !== 'string' || !item.trim() || item !== item.trim()) {
      return { ok: false, reason: 'target response contains an invalid variant' };
    }
    if (variants.includes(item)) return { ok: false, reason: 'target response contains a duplicate variant' };
    variants.push(item);
  }
  return { ok: true, variants };
}

/**
 * Target choices for an executable adapter are exactly the validated list
 * returned by that adapter's dedicated targets endpoint. The second argument
 * is that scoped response, never a global status list. Non-executable
 * adapters and malformed payloads offer nothing.
 */
export function targetVariantsForAdapter(adapterId: string | null | undefined, adapterTargets: readonly string[] = []): string[] {
  if (!isExecutableAdapter(adapterId)) return [];
  const validated = validateTargetVariantsResponse([...adapterTargets]);
  return validated.ok ? validated.variants : [];
}

export function defaultTargetVariant(variants: readonly string[]): string | null {
  if (variants.includes('inventory-candidate-a')) return 'inventory-candidate-a';
  if (variants.includes('candidate-a')) return 'candidate-a';
  return variants.find(v => v !== 'clean') ?? variants[0] ?? null;
}

/** Preserves a still-supported selection; otherwise chooses the supported default. */
export function resolveSelectedTargetVariant(current: string | null | undefined, variants: readonly string[]): string | null {
  if (current && variants.includes(current)) return current;
  return defaultTargetVariant(variants);
}

export interface TargetSelectionIdentity {
  id: string;
  revision: number;
  adapterId: string;
}

/**
 * Production target-selection state for the desktop.
 *
 * The DOM select is emptied whenever targets reload (selection change,
 * loading, dirty edits), so the user's confirmed choice cannot be recovered
 * from the select at the moment the new list arrives. This session captures
 * that choice before any clear, keeps it while targets are unconfirmed
 * (loading/empty/error/dirty), and re-resolves it only against a newly
 * confirmed list for the identity that list was fetched for. A preference is
 * honoured only for the adapter it was chosen under; a different adapter, or
 * a list that no longer contains the choice, falls back to the supported
 * default. Stale-response protection stays with the caller's sequencer and
 * `isCurrentSelection` guard: terminal callbacks here are only invoked for
 * non-stale outcomes by `loadAdapterTargets`.
 */
export class TargetSelectionSession {
  state: TargetLoadState = 'idle';
  variants: string[] = [];
  identity: TargetSelectionIdentity | null = null;
  /** Confirmed selection to display/launch with; null while unconfirmed. */
  selection: string | null = null;
  private preferredVariant: string | null = null;
  private preferredAdapterId: string | null = null;

  get preferred(): string | null {
    return this.preferredVariant;
  }

  /** Records an explicit user choice; only confirmed options may be chosen. */
  select(variant: string | null | undefined): void {
    if (!variant || this.state !== 'ready' || !this.identity) return;
    if (!this.variants.includes(variant)) return;
    this.preferredVariant = variant;
    this.preferredAdapterId = this.identity.adapterId;
    this.selection = variant;
  }

  /**
   * Captures the selection currently displayed in the select before it is
   * cleared. The displayed options belong to this session's current identity,
   * so a value captured here is attributed to that identity's adapter, never
   * to a newer system the caller may already have selected. An empty display
   * (already cleared) never overwrites a captured preference.
   */
  captureDisplayedSelection(displayedValue: string | null | undefined): void {
    if (!displayedValue) return;
    const adapterId = this.identity?.adapterId ?? this.preferredAdapterId;
    if (!adapterId) return;
    // Only a value the confirmed list actually offered can become a preference.
    if (this.state === 'ready' && this.variants.length && !this.variants.includes(displayedValue)) return;
    this.preferredVariant = displayedValue;
    this.preferredAdapterId = adapterId;
  }

  /** Starts an unconfirmed load for `identity`; any confirmed choice is kept for re-resolution. */
  beginLoad(identity: TargetSelectionIdentity, displayedValue?: string | null): void {
    this.captureDisplayedSelection(displayedValue);
    this.state = 'loading';
    this.variants = [];
    this.identity = { ...identity };
    this.selection = null;
  }

  /** Clears confirmed choices (loading/dirty/draft) without forgetting the captured choice. */
  reset(state: TargetLoadState = 'idle', displayedValue?: string | null): void {
    this.captureDisplayedSelection(displayedValue);
    this.state = state;
    this.variants = [];
    this.identity = null;
    this.selection = null;
  }

  applyReady(identity: TargetSelectionIdentity, variants: readonly string[]): string | null {
    const supported = targetVariantsForAdapter(identity.adapterId, variants);
    this.state = 'ready';
    this.variants = [...supported];
    this.identity = { ...identity };
    const candidate = this.preferredAdapterId === identity.adapterId ? this.preferredVariant : null;
    this.selection = resolveSelectedTargetVariant(candidate, supported);
    if (this.selection) {
      this.preferredVariant = this.selection;
      this.preferredAdapterId = identity.adapterId;
    } else {
      this.preferredVariant = null;
      this.preferredAdapterId = null;
    }
    return this.selection;
  }

  /** A valid but empty list is unconfirmed for launch; the choice is kept for a later retry. */
  applyEmpty(identity: TargetSelectionIdentity): void {
    this.state = 'ready';
    this.variants = [];
    this.identity = { ...identity };
    this.selection = null;
  }

  /** A failed load offers nothing and blocks launch; the choice is kept for a later retry. */
  applyError(identity: TargetSelectionIdentity): void {
    this.state = 'error';
    this.variants = [];
    this.identity = { ...identity };
    this.selection = null;
  }

  matchesSelected(selected: TargetSelectionIdentity | null | undefined, clean: boolean): boolean {
    return Boolean(selected) && clean && this.identity !== null
      && this.identity.id === selected?.id
      && this.identity.revision === selected?.revision
      && this.identity.adapterId === selected?.adapterId;
  }

  effectiveStateFor(selected: TargetSelectionIdentity | null | undefined, clean: boolean): TargetLoadState {
    if (!selected || !clean) return 'idle';
    if (!this.matchesSelected(selected, clean)) {
      return this.state === 'loading' && this.identity?.id === selected.id ? 'loading' : 'idle';
    }
    return this.state;
  }

  scopedVariantsFor(selected: TargetSelectionIdentity | null | undefined, clean: boolean): string[] {
    if (!selected || this.effectiveStateFor(selected, clean) !== 'ready') return [];
    return targetVariantsForAdapter(selected.adapterId, this.variants);
  }
}

/** Executable check availability is configuration, never coverage or a result. */
export function executableCheckCount(adapterId: string | null | undefined, contractCheckCount: number): number {
  if (!isExecutableAdapter(adapterId)) return 0;
  return Math.max(0, contractCheckCount);
}

export type SnapshotLoadState = 'none' | 'loading' | 'ready' | 'error' | 'incompatible';

export interface LaunchGuardState {
  isLaunchRequestPending: boolean;
  isInvestigationActive: boolean;
  isSystemSavePending: boolean;
  isDraftMode: boolean;
  hasUnsavedSystemEdits: boolean;
  selectedAdapterId: string | null;
  hasSelectedSystem: boolean;
  /** Optional: when supplied, launch also requires a confirmed snapshot for the selected system. */
  snapshotState?: SnapshotLoadState;
  selectedVariant?: string | null;
  allowedVariants?: readonly string[];
  /** When supplied, launch requires the per-adapter target list to have loaded successfully. */
  targetState?: TargetLoadState;
}

/** Returns a human reason launch is blocked, or null when launch may proceed. */
export function launchBlockedReason(state: LaunchGuardState): string | null {
  if (state.isLaunchRequestPending) return 'STARTING INVESTIGATION';
  if (state.isInvestigationActive) return 'INVESTIGATION IN PROGRESS';
  if (state.isSystemSavePending) return 'SAVING SYSTEM PROFILE';
  if (state.isDraftMode) return 'SAVE THE NEW SYSTEM PROFILE BEFORE RUNNING';
  if (state.hasUnsavedSystemEdits) return 'SAVE OR DISCARD YOUR REQUIREMENT EDITS BEFORE RUNNING';
  if (!state.hasSelectedSystem) return 'SELECT A SAVED SYSTEM PROFILE';
  if (!isExecutableAdapter(state.selectedAdapterId)) return 'RUN DISABLED: UNCONFIGURED ADAPTER';
  if (state.snapshotState !== undefined && state.snapshotState !== 'ready') {
    if (state.snapshotState === 'loading') return 'LOADING SYSTEM CONTRACT';
    if (state.snapshotState === 'error') return 'SYSTEM CONTRACT UNAVAILABLE';
    return 'SYSTEM CONTRACT NOT CONFIRMED';
  }
  if (state.targetState !== undefined) {
    if (state.targetState === 'loading') return 'LOADING TARGETS FOR SELECTED SYSTEM';
    if (state.targetState === 'error') return 'TARGET LIST UNAVAILABLE FOR SELECTED SYSTEM';
    if (state.targetState !== 'ready') return 'TARGET LIST NOT LOADED FOR SELECTED SYSTEM';
  }
  if (state.allowedVariants !== undefined) {
    if (!state.allowedVariants.length) return 'NO TARGET AVAILABLE FOR SELECTED SYSTEM';
    if (!state.selectedVariant || !state.allowedVariants.includes(state.selectedVariant)) {
      return 'TARGET NOT AVAILABLE FOR SELECTED SYSTEM';
    }
  }
  return null;
}

export interface SystemSnapshotLike {
  brief: { id: string; adapterId: string; revision?: number };
  contract: { invariants?: unknown; operations?: unknown; messages?: unknown } | null;
  hash: string;
}

export type SnapshotValidation =
  | { ok: true; snapshot: SystemSnapshotLike }
  | { ok: false; reason: string };

export interface ExpectedSystemIdentity {
  id: string;
  revision?: number;
  adapterId?: string;
}

/** Normalizes the legacy string form and the full selected-profile identity. */
export function normalizeExpectedIdentity(
  expected: string | ExpectedSystemIdentity,
  revision?: number,
  adapterId?: string,
): ExpectedSystemIdentity {
  if (typeof expected === 'string') return { id: expected, revision, adapterId };
  return { id: expected.id, revision: revision ?? expected.revision, adapterId: adapterId ?? expected.adapterId };
}

/** Validates a snapshot response belongs to the requested saved system and is compatible with its adapter. */
export function validateSystemSnapshot(
  data: unknown,
  expected: string | ExpectedSystemIdentity,
  expectedRevision?: number,
  expectedAdapterId?: string,
): SnapshotValidation {
  const want = normalizeExpectedIdentity(expected, expectedRevision, expectedAdapterId);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'invalid snapshot response' };
  const s = data as Record<string, unknown>;
  const brief = s.brief as Record<string, unknown> | undefined;
  if (!brief || typeof brief !== 'object' || brief.id !== want.id) return { ok: false, reason: 'snapshot system mismatch' };
  if (want.adapterId !== undefined && brief.adapterId !== want.adapterId) return { ok: false, reason: 'snapshot adapter mismatch' };
  if (want.revision !== undefined && brief.revision !== want.revision) return { ok: false, reason: 'snapshot revision mismatch' };
  if (typeof s.hash !== 'string' || !s.hash) return { ok: false, reason: 'snapshot hash missing' };
  const adapterId = typeof brief.adapterId === 'string' ? brief.adapterId : '';
  const contract = (s.contract ?? null) as SystemSnapshotLike['contract'];
  if (!isExecutableAdapter(adapterId)) {
    return contract === null ? { ok: true, snapshot: data as SystemSnapshotLike } : { ok: false, reason: 'unconfigured system has a contract' };
  }
  if (!contract || typeof contract !== 'object') return { ok: false, reason: 'executable system contract missing' };
  if (!Array.isArray(contract.invariants) || !Array.isArray(contract.operations) || !Array.isArray(contract.messages)) {
    return { ok: false, reason: 'snapshot contract shape invalid' };
  }
  return { ok: true, snapshot: data as SystemSnapshotLike };
}

/** Checks are visible only for an executable adapter with a ready snapshot for the clean saved selection. */
export function contractChecksVisible(state: {
  effectiveAdapterId: string | null | undefined;
  snapshotState?: SnapshotLoadState;
  isDraftMode: boolean;
  hasUnsavedSystemEdits: boolean;
}): boolean {
  if (state.isDraftMode || state.hasUnsavedSystemEdits) return false;
  if (!isExecutableAdapter(state.effectiveAdapterId)) return false;
  return state.snapshotState === undefined || state.snapshotState === 'ready';
}

/** A stopped, failed or still-running run is never described as a clean pass. */
export function runOutcomeLabel(status: RunSummary['status']): string {
  switch (status) {
    case 'completed': return 'Completed';
    case 'cancelled': return 'Stopped: not a clean pass';
    case 'failed': return 'Failed: not a clean pass';
    case 'running': return 'Running';
    default: return String(status);
  }
}

/** Adapter that rendering must scope to: an unsaved draft choice wins over the saved profile. */
export function effectiveAdapterId(state: {
  isDraftMode: boolean;
  hasUnsavedSystemEdits: boolean;
  draftAdapterId: string | null | undefined;
  savedAdapterId: string | null | undefined;
}): string | null {
  if (state.isDraftMode || state.hasUnsavedSystemEdits) return state.draftAdapterId ?? null;
  return state.savedAdapterId ?? null;
}

/** Only the synthetic-trading adapter exposes the trading operations/vocabulary/checks. */
export function tradingContractVisible(adapterId: string | null | undefined): boolean {
  return adapterId === 'synthetic-trading';
}

/** Any executable adapter exposes its own snapshot contract lists (not trading by default). */
export function contractListsVisible(adapterId: string | null | undefined): boolean {
  return isExecutableAdapter(adapterId);
}

export type InspectionScope = 'selected' | 'other' | 'legacy';

/** Which system an opened/active record belongs to, relative to the selected workspace. */
export function inspectionScope(
  recordSystemId: string | null | undefined,
  selectedSystemId: string | null | undefined,
): InspectionScope {
  if (!recordSystemId) return 'legacy';
  if (selectedSystemId && recordSystemId === selectedSystemId) return 'selected';
  return 'other';
}

/**
 * On workspace change, a non-active inspected run from another system (or a legacy
 * record) is cleared so its findings are not presented as the new system's.
 * The globally active run is kept (labelled, via the global control bar) and stoppable.
 */
export function shouldClearInspectionOnSelection(state: {
  recordId: string | null;
  recordSystemId: string | null | undefined;
  activeRecordId: string | null;
  selectedSystemId: string | null | undefined;
}): boolean {
  if (!state.recordId) return false;
  if (state.activeRecordId && state.recordId === state.activeRecordId) return false;
  return inspectionScope(state.recordSystemId, state.selectedSystemId) !== 'selected';
}

/**
 * Polling may auto-render the live record only when it belongs to the selected
 * system (or none is selected yet), or when the user explicitly opened it.
 * An other-system/legacy active run stays discoverable via the banner, not the dashboard.
 */
export function shouldAutoRenderActiveRecord(state: {
  recordSystemId: string | null | undefined;
  selectedSystemId: string | null | undefined;
  explicitlyOpened: boolean;
}): boolean {
  if (state.explicitlyOpened) return true;
  if (!state.selectedSystemId) return true;
  return inspectionScope(state.recordSystemId, state.selectedSystemId) === 'selected';
}

export interface StopControlState {
  visible: boolean;
  enabled: boolean;
  label: string;
}

/** One shared stop state for every Stop control (Prepare, dashboard, global bar). */
export function stopControlState(state: {
  isStartPending: boolean;
  isInvestigationActive: boolean;
  serverStatus: string | null | undefined;
}): StopControlState {
  const visible = state.isStartPending || state.isInvestigationActive;
  if (!visible) return { visible: false, enabled: false, label: 'Stop investigation' };
  if (state.serverStatus === 'stopping') return { visible: true, enabled: false, label: 'Stopping…' };
  if (state.isStartPending && !state.isInvestigationActive) {
    return { visible: true, enabled: true, label: 'Stop pending start' };
  }
  return { visible: true, enabled: true, label: 'Stop investigation' };
}

/** Detailed metrics/evidence are shown only when a real record is opened/active. */
export function hasRunDetail(recordId: string | null | undefined): boolean {
  return Boolean(recordId);
}

export interface LiveRunRef {
  id: string;
  status: string;
  systemId: string | null;
}

export type PollRenderDecision = 'render-live' | 'preserve-inspection' | 'none';

/**
 * Owning lifecycle state for one investigation: distinguishes the latest live
 * record (from /api/status, not yet persisted) from an explicitly inspected
 * saved record. Polling renders only the same live ID the user opened, or the
 * auto-renderable live record when nothing unrelated is being inspected.
 */
export class InvestigationLifecycle {
  latestLive: LiveRunRef | null = null;
  inspectedId: string | null = null;
  inspectedIsLive = false;
  pendingStopIntent = false;
  startPending = false;

  beginLaunch(): void {
    this.startPending = true;
    this.pendingStopIntent = false;
    this.inspectedId = null;
    this.inspectedIsLive = false;
    this.latestLive = null;
  }

  /** Records the live ref from a status payload; a terminal payload keeps it so Open can render it without a saved-artifact GET. */
  noteStatus(record: LiveRunRef | null): void {
    if (record) this.latestLive = { ...record };
  }

  /** Global Open: use the live ref when present; never GET a not-yet-persisted artifact. */
  openActiveTarget(): LiveRunRef | null {
    if (!this.latestLive) return null;
    this.inspectedId = this.latestLive.id;
    this.inspectedIsLive = true;
    return this.latestLive;
  }

  openLive(id: string): boolean {
    if (!this.latestLive || this.latestLive.id !== id) return false;
    this.inspectedId = id;
    this.inspectedIsLive = true;
    return true;
  }

  openHistory(id: string): void {
    this.inspectedId = id;
    this.inspectedIsLive = false;
  }

  clearInspection(): void {
    this.inspectedId = null;
    this.inspectedIsLive = false;
  }

  pollDecision(selectedSystemId: string | null | undefined): PollRenderDecision {
    if (!this.latestLive) return 'none';
    if (this.inspectedId) {
      return this.inspectedIsLive && this.inspectedId === this.latestLive.id
        ? 'render-live'
        : 'preserve-inspection';
    }
    return shouldAutoRenderActiveRecord({
      recordSystemId: this.latestLive.systemId,
      selectedSystemId: selectedSystemId ?? null,
      explicitlyOpened: false,
    })
      ? 'render-live'
      : 'none';
  }

  requestStop(): 'defer-until-start-settles' | 'stop-now' {
    if (this.startPending) {
      this.pendingStopIntent = true;
      return 'defer-until-start-settles';
    }
    return 'stop-now';
  }

  settleStart(): { deferredStop: boolean } {
    this.startPending = false;
    const deferredStop = this.pendingStopIntent;
    this.pendingStopIntent = false;
    return { deferredStop };
  }
}

export type StartFailureKind = 'intentional-stop' | 'conflict' | 'failure';

/** Only the machine-readable cancellation discriminator (with a pending stop intent) is an intentional stop; other 409s stay failures. */
export function classifyStartFailure(state: {
  status: number;
  code?: string | null;
  stopRequested: boolean;
}): StartFailureKind {
  if (state.stopRequested && state.status === 409 && state.code === 'START_CANCELLED') {
    return 'intentional-stop';
  }
  if (state.status === 409) return 'conflict';
  return 'failure';
}

export type DeferredStopOutcome = 'stopping' | 'already-settled' | 'failed';

/** A 400 "no active" after a deferred stop usually means rapid natural completion; never relabel it cancelled. */
export function classifyDeferredStop(state: { ok: boolean; status: number }): DeferredStopOutcome {
  if (state.ok) return 'stopping';
  if (state.status === 400) return 'already-settled';
  return 'failed';
}

/** Monotonic token used to drop late async responses after a newer selection. */
export class RequestSequencer {
  private current = 0;
  next(): number {
    this.current += 1;
    return this.current;
  }
  isCurrent(token: number): boolean {
    return token === this.current;
  }
  invalidate(): void {
    this.current += 1;
  }
}
