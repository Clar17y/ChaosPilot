import type { SystemBrief } from '../domain.ts';
import { classifyDeferredStop, type DeferredStopOutcome, type InvestigationLifecycle } from './workspace.ts';

/** Unsaved drafts have no saved-system identity; the prior saved selection is kept only for discard. */
export function effectiveWorkspaceSystemId(state: {
  isDraftMode: boolean;
  selectedSystemId: string | null | undefined;
}): string | null {
  return state.isDraftMode ? null : (state.selectedSystemId ?? null);
}

export interface ApiResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Server error bodies carry `{ error }`; malformed bodies fall back to the HTTP status, never silence. */
export async function parseApiErrorResponse(res: ApiResponseLike): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      && (body as { error: string }).error) {
      return (body as { error: string }).error;
    }
  } catch { /* fall through to status */ }
  return `HTTP ${res.status}`;
}

export type SystemsFetch = (url: string) => Promise<ApiResponseLike>;

/**
 * Loads system briefs or throws a displayable error. Callers assign the result
 * only on success, so a failed refresh preserves loaded profiles and dirty edits.
 */
export async function fetchSystemBriefs(fetchFn: SystemsFetch): Promise<SystemBrief[]> {
  let res: ApiResponseLike;
  try {
    res = await fetchFn('/api/systems');
  } catch (err) {
    throw new Error(`Could not reach the server to load system profiles: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(await parseApiErrorResponse(res));
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Invalid response when loading system profiles (HTTP ${res.status}).`);
  }
  if (!Array.isArray(data)) {
    throw new Error(`Invalid response when loading system profiles (HTTP ${res.status}): expected a list of profiles.`);
  }
  return data as SystemBrief[];
}

export interface StopPostResult { ok: boolean; status: number; error?: string }

export type StopRequestOutcome = 'deferred' | 'stopped' | 'failed';

/**
 * The one authoritative stop decision: `lifecycle.requestStop()`. A `stop-now`
 * decision posts immediately even while the launch handler's local pending flag
 * is still set after start settlement; only a not-yet-settled start defers.
 */
export async function requestInvestigationStop(deps: {
  lifecycle: InvestigationLifecycle;
  postStop: () => Promise<StopPostResult>;
  onDeferred?: () => void;
  onStopping?: () => void;
  onStopped?: () => void | Promise<void>;
  onFailure?: (message: string) => void | Promise<void>;
}): Promise<StopRequestOutcome> {
  if (deps.lifecycle.requestStop() === 'defer-until-start-settles') {
    deps.onDeferred?.();
    return 'deferred';
  }
  deps.onStopping?.();
  try {
    const result = await deps.postStop();
    if (!result.ok) {
      await deps.onFailure?.(result.error || `HTTP ${result.status}`);
      return 'failed';
    }
    await deps.onStopped?.();
    return 'stopped';
  } catch (err) {
    await deps.onFailure?.(err instanceof Error ? err.message : String(err));
    return 'failed';
  }
}

/** Executes a stop deferred until start settled; 400 means the run already settled naturally. */
export async function executeDeferredStop(
  postStop: () => Promise<StopPostResult>,
): Promise<{ outcome: DeferredStopOutcome; error?: string }> {
  try {
    const result = await postStop();
    const outcome = classifyDeferredStop({ ok: result.ok, status: result.status });
    return outcome === 'failed' ? { outcome, error: result.error || `HTTP ${result.status}` } : { outcome };
  } catch (err) {
    return { outcome: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Ordered status application within a generation. A response is dropped only
 * once a newer response has actually been applied (or the generation was
 * invalidated by an explicit launch/stop) — never merely because a newer
 * request was issued, so slow requests still make progress instead of starving.
 * Stale successes and stale errors are both dropped.
 */
export class StatusRequestCoordinator {
  private generation = 0;
  private issued = 0;
  private applied = 0;

  invalidate(): void {
    this.generation += 1;
    this.issued = 0;
    this.applied = 0;
  }

  async run<T>(
    task: () => Promise<T>,
    onValue: (value: T) => void,
    onError: (err: unknown) => void,
  ): Promise<void> {
    const generation = this.generation;
    const sequence = ++this.issued;
    const isStale = () => generation !== this.generation || sequence <= this.applied;
    try {
      const value = await task();
      if (isStale()) return;
      this.applied = sequence;
      onValue(value);
    } catch (err) {
      if (isStale()) return;
      onError(err);
    }
  }
}
