import { normalizeOutputLanguage } from '../output-language.ts';
import type { ApiResponseLike } from './request-boundaries.ts';

export type ReportUiState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'generating' }
  | { kind: 'saved'; generatedAt: string; mode: string; model: string; language?: string }
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

  async create(
    record: { id: string; status: string; findings: unknown[] },
    mode: 'meta' | 'offline',
    language: string,
    changed: () => void,
    fetcher: (url: string, init: RequestInit) => Promise<ApiResponseLike> = (url, init) => fetch(url, init),
  ): Promise<boolean> {
    if (this.state.kind === 'generating' || record.status === 'running' || !record.findings.length) return false;
    const operationLanguage = normalizeOutputLanguage(language);
    const token = this.begin(record.id, 'generating');
    changed();
    try {
      const res = await fetcher(`/api/runs/${encodeURIComponent(record.id)}/explanation-report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, language: operationLanguage }),
      });
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `Report creation failed (${res.status})`);
      if (!this.settle(token, record.id, {
        kind: 'saved', generatedAt: String(data.generatedAt ?? ''), mode: String(data.mode ?? mode),
        model: String(data.model ?? ''), language: normalizeOutputLanguage(data.language ?? operationLanguage),
      })) return false;
      changed();
      return true;
    } catch (error) {
      if (this.settle(token, record.id, { kind: 'error', message: error instanceof Error ? error.message : String(error) })) changed();
      return false;
    }
  }
}
export function reportStatusToUi(s: { exists?: boolean; stale?: boolean; inFlight?: boolean; terminal?: boolean; findingsCount?: number; generatedAt?: string; mode?: string; model?: string; language?: string } | null): ReportUiState {
  if (!s) return { kind: 'unavailable', message: 'Report status unavailable.' };
  if (s.inFlight) return { kind: 'generating' };
  if (s.terminal === false) return { kind: 'unavailable', message: 'Run is still running. Reports are created only for a saved terminal run.' };
  if (!s.findingsCount) return { kind: 'unavailable', message: 'This run has no recorded findings, so no report can be created.' };
  if (s.stale) return { kind: 'stale' };
  if (s.exists) return { kind: 'saved', generatedAt: s.generatedAt ?? '', mode: s.mode ?? '', model: s.model ?? '', language: s.language ?? 'en' };
  return { kind: 'idle' };
}
export function reportStateText(state: ReportUiState): string {
  switch (state.kind) {
    case 'loading': return 'Checking for a saved report…';
    case 'generating': return 'Creating the report… Do not close this view; a late result for another run will be ignored.';
    case 'saved': {
      const langLabel = state.language === 'es' ? 'Español' : (state.language === 'en' ? 'English' : (state.language ?? 'English'));
      return `Saved report available in ${langLabel} (created ${state.generatedAt || 'at an unknown time'} via ${state.mode === 'offline' ? 'offline scripted explanation — not Muse' : `Muse (${state.model})`}). You can view or download it again without a model call.`;
    }
    case 'stale': return 'A saved report exists but is stale: the run evidence has changed. It is not shown as current — create a new report.';
    case 'unavailable': return state.message;
    case 'error': return `Report error: ${state.message}`;
    default: return 'No saved report for this run yet.';
  }
}
