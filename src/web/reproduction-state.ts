import type { Finding, InvestigationRecord } from '../domain.ts';
import type { ExperimentReplayLike, FreshReplayState } from './reproduction-player.ts';

/** A terminal result can be reported before the server has finished saving it. */
export function replayWaitsForSave(
  record: Pick<InvestigationRecord, 'id' | 'status'>,
  isActive: boolean,
  activeRunId: string | null,
): boolean {
  return record.status === 'running' || (isActive && record.id === activeRunId);
}

export interface FreshScope { runId: string; experimentPosition: number; findingId: string | null }

export class ReproductionSession {
  runId: string | null = null;
  selectedFinding: Finding | null = null;
  experimentPosition: number | null = null;
  fresh: FreshReplayState = { kind: 'idle' };
  freshReport: ExperimentReplayLike | null = null;
  freshScope: FreshScope | null = null;
  renderedKey = '';
  private freshSeq = 0;

  resetForRun(runId: string | null): void {
    this.runId = runId;
    this.selectedFinding = null;
    this.experimentPosition = null;
    this.fresh = { kind: 'idle' };
    this.freshReport = null;
    this.freshScope = null;
    this.freshSeq++;
    this.renderedKey = '';
  }

  clear(): void { this.resetForRun(null); }

  syncToRun(runId: string): boolean {
    if (this.runId === runId) return false;
    this.resetForRun(runId);
    return true;
  }

  clearFinding(): void {
    this.selectedFinding = null;
    this.experimentPosition = null;
    this.invalidateFresh();
  }

  /** Experiment (array position) changed without a finding selection. */
  selectExperiment(position: number): void {
    this.experimentPosition = position;
    this.invalidateFresh();
  }

  selectFinding(finding: Finding, experimentPosition?: number): void {
    this.selectedFinding = finding;
    if (experimentPosition !== undefined) this.experimentPosition = experimentPosition;
    this.invalidateFresh();
  }

  invalidateFresh(): void {
    this.freshSeq++;
    this.freshReport = null;
    this.freshScope = null;
    if (this.fresh.kind === 'pending') this.fresh = { kind: 'idle' };
    // A settled fresh result also belongs to the old selection.
    else if (this.fresh.kind !== 'idle') this.fresh = { kind: 'idle' };
  }

  beginFresh(runId: string, experimentPosition = -1, findingId: string | null = null): number {
    this.runId = runId;
    this.experimentPosition = experimentPosition >= 0 ? experimentPosition : this.experimentPosition;
    this.fresh = { kind: 'pending' };
    this.freshReport = null;
    this.freshScope = { runId, experimentPosition, findingId };
    return ++this.freshSeq;
  }

  scopeKey(): string {
    const s = this.freshScope;
    return s ? `${s.runId}|${s.experimentPosition}|${s.findingId ?? ''}` : '';
  }

  isFreshCurrent(token: number, runId: string, experimentPosition?: number, findingId?: string | null): boolean {
    if (token !== this.freshSeq || this.runId !== runId || this.fresh.kind !== 'pending') return false;
    if (experimentPosition !== undefined && this.freshScope?.experimentPosition !== experimentPosition) return false;
    if (findingId !== undefined && (this.freshScope?.findingId ?? null) !== findingId) return false;
    return true;
  }

  settleFresh(token: number, runId: string, next: FreshReplayState, report?: ExperimentReplayLike | null, experimentPosition?: number, findingId?: string | null): boolean {
    if (!this.isFreshCurrent(token, runId, experimentPosition, findingId)) return false;
    this.fresh = next;
    this.freshReport = report ?? null;
    return true;
  }
}
