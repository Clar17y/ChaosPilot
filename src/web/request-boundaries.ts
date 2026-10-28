import type { SystemBrief, SystemBriefSnapshot } from '../domain.ts';
import { classifyDeferredStop, normalizeExpectedIdentity, validateSystemSnapshot, validateTargetVariantsResponse, type DeferredStopOutcome, type ExpectedSystemIdentity, type InvestigationLifecycle, type RequestSequencer } from './workspace.ts';

export type { ExpectedSystemIdentity } from './workspace.ts';

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

/** Fetches the selected saved system's own snapshot; throws displayable errors and rejects mismatched/invalid payloads. */
export async function fetchSystemSnapshot(
  fetchFn: SystemsFetch,
  expected: string | ExpectedSystemIdentity,
  expectedRevision?: number,
  expectedAdapterId?: string,
): Promise<SystemBriefSnapshot> {
  const want = normalizeExpectedIdentity(expected, expectedRevision, expectedAdapterId);
  let res: ApiResponseLike;
  try {
    res = await fetchFn(`/api/systems/${encodeURIComponent(want.id)}/snapshot`);
  } catch (err) {
    throw new Error(`Could not reach the server to load the system contract: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(await parseApiErrorResponse(res));
  let data: unknown;
  try { data = await res.json(); } catch { throw new Error(`Invalid snapshot response (HTTP ${res.status}).`); }
  const v = validateSystemSnapshot(data, want);
  if (!v.ok) throw new Error(`Invalid snapshot response: ${v.reason}.`);
  return data as SystemBriefSnapshot;
}

/** Fetches the authoritative per-adapter target list; throws displayable errors for transport, HTTP and malformed payloads. */
export async function fetchAdapterTargets(fetchFn: SystemsFetch, adapterId: string): Promise<string[]> {
  let res: ApiResponseLike;
  try {
    res = await fetchFn(`/api/targets?adapterId=${encodeURIComponent(adapterId)}`);
  } catch (err) {
    throw new Error(`Could not reach the server to load targets for adapter "${adapterId}": ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(await parseApiErrorResponse(res));
  let data: unknown;
  try { data = await res.json(); } catch { throw new Error(`Invalid target response (HTTP ${res.status}).`); }
  const validated = validateTargetVariantsResponse(data);
  if (!validated.ok) throw new Error(`Invalid target response: ${validated.reason}.`);
  return validated.variants;
}

export type AdapterTargetsLoadOutcome = 'ready' | 'empty' | 'error' | 'stale';

export interface AdapterTargetsLoadDeps {
  fetchFn: SystemsFetch;
  adapterId: string;
  sequencer: RequestSequencer;
  /** True only while the captured system identity is still the clean selected profile. */
  isCurrentSelection: () => boolean;
  onLoading?: () => void;
  onReady?: (variants: string[]) => void;
  onEmpty?: () => void;
  onError?: (err: unknown) => void;
}

/**
 * Production per-adapter target load path. A delayed or superseded success or
 * error is stale and has no side effects. Empty is a distinct terminal outcome
 * (valid list, no launchable target), never a fallback.
 */
export async function loadAdapterTargets(deps: AdapterTargetsLoadDeps): Promise<AdapterTargetsLoadOutcome> {
  const token = deps.sequencer.next();
  deps.onLoading?.();
  try {
    const variants = await fetchAdapterTargets(deps.fetchFn, deps.adapterId);
    if (!deps.sequencer.isCurrent(token) || !deps.isCurrentSelection()) return 'stale';
    if (!variants.length) {
      if (deps.onEmpty) deps.onEmpty(); else deps.onReady?.(variants);
      return 'empty';
    }
    deps.onReady?.(variants);
    return 'ready';
  } catch (err) {
    if (!deps.sequencer.isCurrent(token) || !deps.isCurrentSelection()) return 'stale';
    deps.onError?.(err);
    return 'error';
  }
}

export type SystemContractLoadOutcome = 'ready' | 'incompatible' | 'error' | 'stale';

export interface SystemContractLoadDeps {
  fetchFn: SystemsFetch;
  /** Identity captured from the selected saved profile when the request starts. */
  expected: string | ExpectedSystemIdentity;
  sequencer: RequestSequencer;
  /** True only while the captured identity is still the clean selected profile. */
  isCurrentSelection: () => boolean;
  onLoading?: () => void;
  onReady?: (snapshot: SystemBriefSnapshot) => void;
  onIncompatible?: (snapshot: SystemBriefSnapshot) => void;
  onError?: (err: unknown) => void;
}

/**
 * Production load path used by app.ts `fetchSystemContract`. A delayed or
 * superseded response is stale and has no side effects. A response for the
 * current selection whose id/revision/adapter does not match the captured
 * identity is an error, never ready. Every non-stale terminal outcome invokes
 * exactly one side-effect callback so callers refresh launch readiness there
 * without depending on later status polling.
 */
export async function loadSystemContract(deps: SystemContractLoadDeps): Promise<SystemContractLoadOutcome> {
  const token = deps.sequencer.next();
  deps.onLoading?.();
  try {
    const snapshot = await fetchSystemSnapshot(deps.fetchFn, deps.expected);
    if (!deps.sequencer.isCurrent(token) || !deps.isCurrentSelection()) return 'stale';
    if (!snapshot.contract) { deps.onIncompatible?.(snapshot); return 'incompatible'; }
    deps.onReady?.(snapshot);
    return 'ready';
  } catch (err) {
    if (!deps.sequencer.isCurrent(token) || !deps.isCurrentSelection()) return 'stale';
    deps.onError?.(err);
    return 'error';
  }
}
