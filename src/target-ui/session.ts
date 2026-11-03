import { randomUUID } from 'node:crypto';
import type { TargetVariant } from '../domain.ts';
import { assertAdapterVariant } from '../adapters/index.ts';
import { startTarget, type TargetHandle, type TargetOptions } from '../target-api/target.ts';
import type { TargetUiProvenance, TargetUiSession, TargetUiThresholds } from './types.ts';

export interface CreateSessionOptions {
  variant?: TargetVariant;
  ttlMs?: number;
  processingDelayMs?: number;
  signal?: AbortSignal;
  provenance?: TargetUiProvenance;
  thresholds?: TargetUiThresholds;
}
interface ActiveSessionEntry {
  session: TargetUiSession;
  handle: TargetHandle;
  timer: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
}
export class TargetUiSessionManager {
  private readonly sessions = new Map<string, ActiveSessionEntry>();
  private readonly starts = new Set<Promise<TargetUiSession>>();
  private readonly jobs = new Map<Promise<unknown>, AbortController>();
  private isClosed = false;
  private shutdown?: Promise<void>;
  private readonly maxConcurrentSessions: number;
  private readonly maxConcurrentJobs: number;
  private readonly start: (options: TargetOptions) => Promise<TargetHandle>;
  constructor(options: { maxConcurrentSessions?: number; maxConcurrentJobs?: number; startTarget?: (options: TargetOptions) => Promise<TargetHandle> } = {}) {
    this.maxConcurrentSessions = options.maxConcurrentSessions ?? 4;
    this.maxConcurrentJobs = options.maxConcurrentJobs ?? 2;
    for (const value of [this.maxConcurrentSessions, this.maxConcurrentJobs]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 16) throw new Error('Invalid concurrency bound');
    }
    this.start = options.startTarget ?? startTarget;
  }
  createSession(options: CreateSessionOptions = {}): Promise<TargetUiSession> {
    const variant = options.variant ?? 'clean', ttlMs = options.ttlMs ?? 300_000;
    try {
      if (this.isClosed) throw new Error('Session manager is closed');
      options.signal?.throwIfAborted();
      assertAdapterVariant('synthetic-trading', variant);
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 10 || ttlMs > 900_000) throw new Error('Invalid session TTL');
      if (this.sessions.size + this.starts.size >= this.maxConcurrentSessions) throw new Error('Maximum concurrent target UI sessions reached');
    } catch (error) { return Promise.reject(error); }
    // Reserve synchronously, including the entire pending listen/cleanup transition.
    const pending = Promise.resolve().then(async () => {
      const handle = await this.start({ variant, processingDelayMs: options.processingDelayMs ?? 8,
        uiContext: { provenance: options.provenance, thresholds: options.thresholds } });
      try {
        if (this.isClosed) throw new Error('Session manager is closed');
        options.signal?.throwIfAborted();
        const sessionId = randomUUID();
        const session: TargetUiSession = { sessionId, instanceId: handle.instanceId, endpoint: handle.endpoint, variant,
          createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ttlMs).toISOString(), active: true, provenance: options.provenance };
        const timer = setTimeout(() => { void this.closeSession(sessionId).catch(() => {}); }, ttlMs);
        timer.unref?.();
        this.sessions.set(sessionId, { session, handle, timer });
        return structuredClone(session);
      } catch (error) { await handle.close(); throw error; }
    });
    this.starts.add(pending);
    void pending.finally(() => this.starts.delete(pending)).catch(() => {});
    return pending;
  }
  getSession(id: string): TargetUiSession | null {
    const entry = this.sessions.get(id);
    if (!entry || !entry.session.active || Date.parse(entry.session.expiresAt) <= Date.now()) return null;
    return structuredClone(entry.session);
  }
  getHandle(id: string): TargetHandle | null { return this.sessions.get(id)?.handle ?? null; }
  listSessions(): TargetUiSession[] { return [...this.sessions.keys()].flatMap(id => this.getSession(id) ?? []); }
  async closeSession(id: string): Promise<boolean> {
    const entry = this.sessions.get(id);
    if (!entry) return false;
    entry.session.active = false;
    clearTimeout(entry.timer);
    // A failed close retains ownership and can be retried; it is never reported as closed.
    entry.closing ??= entry.handle.close().then(() => { this.sessions.delete(id); }).catch(error => { entry.closing = undefined; throw error; });
    await entry.closing;
    return true;
  }
  runJob<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.isClosed) return Promise.reject(new Error('Session manager is closed'));
    if (this.jobs.size >= this.maxConcurrentJobs) return Promise.reject(new Error('Maximum concurrent browser jobs reached'));
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const job = Promise.resolve().then(() => work(controller.signal));
    this.jobs.set(job, controller);
    void job.finally(() => { this.jobs.delete(job); signal?.removeEventListener('abort', abort); }).catch(() => {});
    return job;
  }
  /** Closes every live session and settles pending starts without closing the manager. */
  async closeAllSessions(): Promise<void> {
    await Promise.allSettled([...this.starts]);
    await Promise.all([...this.sessions.keys()].map(id => this.closeSession(id)));
  }
  closeAll(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.isClosed = true;
    for (const controller of this.jobs.values()) controller.abort(new Error('Server shutdown'));
    return this.shutdown = (async () => {
      await Promise.allSettled([...this.starts, ...this.jobs.keys()]);
      await Promise.all([...this.sessions.keys()].map(id => this.closeSession(id)));
    })();
  }
  diagnostics() { return { activeSessions: this.sessions.size, pendingStarts: this.starts.size, activeJobs: this.jobs.size, isClosed: this.isClosed }; }
}
export const defaultSessionManager = new TargetUiSessionManager();
