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

/** Executable check availability is configuration, never coverage or a result. */
export function executableCheckCount(adapterId: string | null | undefined, contractCheckCount: number): number {
  if (adapterId !== 'synthetic-trading') return 0;
  return Math.max(0, contractCheckCount);
}

export interface LaunchGuardState {
  isLaunchRequestPending: boolean;
  isInvestigationActive: boolean;
  isSystemSavePending: boolean;
  isDraftMode: boolean;
  hasUnsavedSystemEdits: boolean;
  selectedAdapterId: string | null;
  hasSelectedSystem: boolean;
}

/** Returns a human reason launch is blocked, or null when launch may proceed. */
export function launchBlockedReason(state: LaunchGuardState): string | null {
  if (state.isLaunchRequestPending) return 'STARTING INVESTIGATION';
  if (state.isInvestigationActive) return 'INVESTIGATION IN PROGRESS';
  if (state.isSystemSavePending) return 'SAVING SYSTEM PROFILE';
  if (state.isDraftMode) return 'SAVE THE NEW SYSTEM PROFILE BEFORE RUNNING';
  if (state.hasUnsavedSystemEdits) return 'SAVE OR DISCARD YOUR REQUIREMENT EDITS BEFORE RUNNING';
  if (!state.hasSelectedSystem) return 'SELECT A SAVED SYSTEM PROFILE';
  if (state.selectedAdapterId !== 'synthetic-trading') return 'RUN DISABLED: UNCONFIGURED ADAPTER';
  return null;
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
