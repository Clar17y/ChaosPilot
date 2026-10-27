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

/** Adapters this branch's server can actually execute. Its brief validation
 * (src/domain.ts, src/systems) only accepts 'synthetic-trading' | 'unconfigured',
 * so inventory-reservation is deliberately NOT executable here. Do not add an
 * adapter here until the backend can save, snapshot and run it. */
export const INVENTORY_ADAPTER_ID = 'inventory-reservation';
export const TRADING_ADAPTER_ID = 'synthetic-trading';
export const ADAPTER_LABELS: Record<string, string> = {
  'synthetic-trading': 'Synthetic trading',
  'inventory-reservation': 'Synthetic inventory reservation (not available on this server)',
  unconfigured: 'No adapter configured',
};
export function isExecutableAdapter(adapterId: string | null | undefined): boolean {
  return adapterId === TRADING_ADAPTER_ID;
}
export function adapterLabel(adapterId: string | null | undefined): string {
  return ADAPTER_LABELS[adapterId ?? ''] ?? 'No adapter configured';
}
/**
 * Target choices scoped to an adapter. Only synthetic-trading is executable
 * on this branch, so only it gets choices, from the server-reported list.
 * Every other adapter (including inventory-reservation) gets none. A global
 * status poll therefore cannot overwrite another system's choices.
 */
export function targetVariantsForAdapter(adapterId: string | null | undefined, serverVariants: readonly string[] = []): string[] {
  if (adapterId === TRADING_ADAPTER_ID) return serverVariants.filter(v => v !== 'inventory-candidate-a');
  return [];
}
export function defaultTargetVariant(variants: readonly string[]): string | null {
  if (variants.includes('candidate-a')) return 'candidate-a';
  return variants[0] ?? null;
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
}

/** Returns a human reason launch is blocked, or null when launch may proceed. */
export function launchBlockedReason(state: LaunchGuardState): string | null {
  if (state.isLaunchRequestPending) return 'STARTING INVESTIGATION';
  if (state.isInvestigationActive) return 'INVESTIGATION IN PROGRESS';
  if (state.isSystemSavePending) return 'SAVING SYSTEM PROFILE';
  if (state.isDraftMode) return 'SAVE THE NEW SYSTEM PROFILE BEFORE RUNNING';
  if (state.hasUnsavedSystemEdits) return 'SAVE OR DISCARD YOUR REQUIREMENT EDITS BEFORE RUNNING';
  if (!state.hasSelectedSystem) return 'SELECT A SAVED SYSTEM PROFILE';
  if (!isExecutableAdapter(state.selectedAdapterId)) {
    return state.selectedAdapterId === INVENTORY_ADAPTER_ID
      ? 'RUN DISABLED: INVENTORY ADAPTER NOT AVAILABLE ON THIS SERVER'
      : 'RUN DISABLED: UNCONFIGURED ADAPTER';
  }
  if (state.snapshotState !== undefined && state.snapshotState !== 'ready') {
    if (state.snapshotState === 'loading') return 'LOADING SYSTEM CONTRACT';
    if (state.snapshotState === 'error') return 'SYSTEM CONTRACT UNAVAILABLE';
    return 'SYSTEM CONTRACT NOT CONFIRMED';
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
    case 'cancelled': return 'Stopped — not a clean pass';
    case 'failed': return 'Failed — not a clean pass';
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
