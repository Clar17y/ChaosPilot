export type ReportUiState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'generating' }
  | { kind: 'saved'; generatedAt: string; mode: string; model: string }
  | { kind: 'stale' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; message: string };

/** Run-scoped report state: late results for a previous run never paint. */
export class FindingExplanationSession {
  runId: string | null = null;
  state: ReportUiState = { kind: 'idle' };
  private seq = 0;
  private evidenceKey = "";
  syncToEvidence(record: { id: string } | null): boolean {
    const key = JSON.stringify(record);
    if (this.evidenceKey === key) return false;
    this.evidenceKey = key;
    this.resetForRun(record?.id ?? null);
    return true;
  }
  resetForRun(runId: string | null): void { this.runId = runId; this.seq++; this.state = { kind: 'idle' }; }
  syncToRun(runId: string | null): boolean { if (this.runId === runId) return false; this.resetForRun(runId); return true; }
  begin(runId: string, kind: 'loading' | 'generating'): number { this.runId = runId; this.state = { kind }; return ++this.seq; }
  isCurrent(token: number, runId: string): boolean { return token === this.seq && this.runId === runId; }
  settle(token: number, runId: string, state: ReportUiState): boolean { if (!this.isCurrent(token, runId)) return false; this.state = state; return true; }
}
export function reportStatusToUi(s: { exists?: boolean; stale?: boolean; inFlight?: boolean; terminal?: boolean; findingsCount?: number; generatedAt?: string; mode?: string; model?: string } | null): ReportUiState {
  if (!s) return { kind: 'unavailable', message: 'Report status unavailable.' };
  if (s.inFlight) return { kind: 'generating' };
  if (s.terminal === false) return { kind: 'unavailable', message: 'Run is still running. Reports are created only for a saved terminal run.' };
  if (!s.findingsCount) return { kind: 'unavailable', message: 'This run has no recorded findings, so no report can be created.' };
  if (s.stale) return { kind: 'stale' };
  if (s.exists) return { kind: 'saved', generatedAt: s.generatedAt ?? '', mode: s.mode ?? '', model: s.model ?? '' };
  return { kind: 'idle' };
}
export function reportStateText(state: ReportUiState): string {
  switch (state.kind) {
    case 'loading': return 'Checking for a saved report…';
    case 'generating': return 'Creating the report… Do not close this view; a late result for another run will be ignored.';
    case 'saved': return `Saved report available (created ${state.generatedAt || 'at an unknown time'} via ${state.mode === 'offline' ? 'offline scripted explanation — not Muse' : `Muse (${state.model})`}). You can view or download it again without a model call.`;
    case 'stale': return 'A saved report exists but is stale: the run evidence has changed. It is not shown as current — create a new report.';
    case 'unavailable': return state.message;
    case 'error': return `Report error: ${state.message}`;
    default: return 'No saved report for this run yet.';
  }
}
