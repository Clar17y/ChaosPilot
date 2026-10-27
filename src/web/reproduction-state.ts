import type { Finding, InvestigationRecord } from '../domain.ts';
import type { FreshReplayState } from './reproduction-player.ts';

/** A terminal result can be reported before the server has finished saving it. */
export function replayWaitsForSave(
  record: Pick<InvestigationRecord, 'id' | 'status'>,
  isActive: boolean,
  activeRunId: string | null,
): boolean {
  return record.status === 'running' || (isActive && record.id === activeRunId);
}

/**
 * Run-scoped reproduction selection. Every explicit open/launch resets it;
 * a same-run refresh (polling) preserves it. A fresh-replay result may only
 * settle when its token and run id are still current.
 */
export class ReproductionSession {
  runId: string | null = null;
  selectedFinding: Finding | null = null;
  fresh: FreshReplayState = { kind: 'idle' };
  renderedKey = '';
  private freshSeq = 0;

  /** Explicitly opening or launching a run: drop all prior-run state. */
  resetForRun(runId: string | null): void {
    this.runId = runId;
    this.selectedFinding = null;
    this.fresh = { kind: 'idle' };
    this.freshSeq++;
    this.renderedKey = '';
  }

  clear(): void {
    this.resetForRun(null);
  }

  /** Polling/render path: reset only when the run identity actually changes. */
  syncToRun(runId: string): boolean {
    if (this.runId === runId) return false;
    this.resetForRun(runId);
    return true;
  }

  /** Changing experiment/finding drops any finding claim and pending replay. */
  clearFinding(): void {
    this.selectedFinding = null;
    this.invalidateFresh();
  }

  selectFinding(finding: Finding): void {
    this.selectedFinding = finding;
    this.invalidateFresh();
  }

  /** Invalidate an in-flight replay; a pending state returns to idle. */
  invalidateFresh(): void {
    this.freshSeq++;
    if (this.fresh.kind === 'pending') this.fresh = { kind: 'idle' };
  }

  beginFresh(runId: string): number {
    this.runId = runId;
    this.fresh = { kind: 'pending' };
    return ++this.freshSeq;
  }

  isFreshCurrent(token: number, runId: string): boolean {
    return token === this.freshSeq && this.runId === runId && this.fresh.kind === 'pending';
  }

  settleFresh(token: number, runId: string, next: FreshReplayState): boolean {
    if (!this.isFreshCurrent(token, runId)) return false;
    this.fresh = next;
    return true;
  }
}
