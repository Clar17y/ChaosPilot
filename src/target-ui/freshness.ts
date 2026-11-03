import type {
  FreshnessOptions,
  FreshnessStatus,
  StaleReason,
  TargetUiFreshnessState,
} from './types.ts';

export type FreshnessEngineOptions = FreshnessOptions;

/**
 * Pure freshness engine implementing explicit monotonic age and sequence freshness rules.
 * Retains truthful status during update delays/holds and catches out-of-order or foreign updates.
 */
export class FreshnessEngine {
  private isHeld = false;
  private lastAppliedAtMs: number;
  private lastAppliedSequence = 0;
  private expectedInstanceId: string | null = null;
  private readonly thresholdMs: number;
  private readonly clock: () => number;

  constructor(options: FreshnessEngineOptions = {}) {
    const t = options.freshnessThresholdMs ?? 2000;
    if (!Number.isSafeInteger(t) || t <= 0) {
      throw new Error(`Invalid freshness threshold: ${t}`);
    }
    this.thresholdMs = t;
    this.clock =
      options.clock ??
      (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.lastAppliedAtMs = this.clock();
  }

  setInstanceId(instanceId: string): void {
    this.expectedInstanceId = instanceId;
  }

  getInstanceId(): string | null {
    return this.expectedInstanceId;
  }

  hold(): void {
    this.isHeld = true;
  }

  resume(): void {
    this.isHeld = false;
  }

  getHeld(): boolean {
    return this.isHeld;
  }

  getThresholdMs(): number {
    return this.thresholdMs;
  }

  getLastAppliedSequence(): number {
    return this.lastAppliedSequence;
  }

  /**
   * Evaluates whether an incoming observation can be applied to the display.
   * If held: cannot apply, rejectReason is 'held'.
   * If foreign instance: cannot apply, rejectReason is 'foreign-instance'.
   * If out-of-order sequence (less than last applied): cannot apply, rejectReason is 'out-of-order'.
   */
  checkIncoming(observation: { instanceId: string; processed: number }): {
    canApply: boolean;
    rejectReason: StaleReason | null;
  } {
    if (this.expectedInstanceId && observation.instanceId !== this.expectedInstanceId) {
      return { canApply: false, rejectReason: 'foreign-instance' };
    }
    if (observation.processed < this.lastAppliedSequence) {
      return { canApply: false, rejectReason: 'out-of-order' };
    }
    if (this.isHeld) {
      return { canApply: false, rejectReason: 'held' };
    }
    return { canApply: true, rejectReason: null };
  }

  /**
   * Records that an observation with the given upstream sequence was applied to the UI display.
   * Resets the freshness clock monotonically.
   */
  recordApplied(sequence: number, atMs = this.clock()): void {
    this.lastAppliedSequence = sequence;
    this.lastAppliedAtMs = atMs;
  }

  /**
   * Computes the current freshness snapshot for the UI display.
   */
  getFreshness(nowMs = this.clock()): TargetUiFreshnessState {
    const ageMs = Math.max(0, Math.round(nowMs - this.lastAppliedAtMs));
    let status: FreshnessStatus = 'fresh';
    let reason: StaleReason = 'none';

    if (this.isHeld) {
      status = 'stale';
      reason = 'held';
    } else if (ageMs > this.thresholdMs) {
      status = 'stale';
      reason = 'age-exceeded';
    }

    return {
      status,
      reason,
      isHeld: this.isHeld,
      lastAppliedAtMs: this.lastAppliedAtMs,
      lastAppliedSequence: this.lastAppliedSequence,
      freshnessThresholdMs: this.thresholdMs,
      ageMs,
    };
  }
}
