import type { SystemBriefSnapshot, TargetVariant } from '../domain.ts';
import type { BusinessEvent } from '../target-api/types.ts';

export interface FreshnessOptions {
  freshnessThresholdMs?: number;
  clock?: () => number;
}

export type FreshnessStatus = 'fresh' | 'stale';

export type StaleReason =
  | 'none'
  | 'held'
  | 'age-exceeded'
  | 'sequence-gap'
  | 'foreign-instance'
  | 'out-of-order';

export interface TargetUiFreshnessState {
  status: FreshnessStatus;
  reason: StaleReason;
  isHeld: boolean;
  lastAppliedAtMs: number;
  lastAppliedSequence: number;
  freshnessThresholdMs: number;
  ageMs: number;
}

export interface TargetUiOrderDisplay {
  orderId: string;
  transportStatus: 'none' | 'queued' | 'acknowledged' | 'failed';
  transportReceiptId: string | null;
  transportSequence: number | null;
  businessStatus: 'IDLE' | 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED' | 'ERROR';
  quantity: number;
  filledQuantity: number;
  remainingQuantity: number;
}

export interface TargetUiWireExchange {
  method: 'GET' | 'POST';
  path: string;
  requestBody?: unknown;
  responseStatus: number;
  responseBody?: unknown;
  /** Monotonic browser-clock completion time (performance.now origin). */
  timestampMs: number;
  elapsedMs?: number;
  source?: 'browser' | 'runner';
  error?: string;
}

export interface TargetUiObservationRecord {
  phase: string;
  timestampMs: number;
  domOrder: TargetUiOrderDisplay | null;
  domFreshness: {
    status: FreshnessStatus;
    reason: StaleReason;
    label: string;
    ageMs: number;
  };
  upstreamProcessed: number;
  upstreamQueued: number;
  instanceId?: string;
  requestId?: string;
  appliedSequence?: number;
  freshnessThresholdMs?: number;
}

export interface TargetUiThresholds {
  freshnessThresholdMs: number;
  convergenceDeadlineMs: number;
}

export type TargetUiVerdictStatus = 'pass' | 'fail' | 'inconclusive' | 'cancelled';

export type TargetUiClassification =
  | 'verified'
  | 'ui-failure'
  | 'upstream-failure'
  | 'inconclusive-wire'
  | 'inconclusive-timeout'
  | 'cancelled';

export interface TargetUiEvidence {
  id: string;
  startedAt: string;
  finishedAt: string;
  variant: TargetVariant;
  instanceId: string;
  endpoint: string;
  systemBriefId?: string;
  systemBriefRevision?: number;
  sourceHash?: string;
  provenance?: TargetUiProvenance;
  resumeAtMs?: number;
  runError?: { kind: 'cancelled' | 'timeout' | 'browser' | 'transport'; message: string };
  thresholds: TargetUiThresholds;
  exchanges: TargetUiWireExchange[];
  events: BusinessEvent[];
  uiObservations: TargetUiObservationRecord[];
  orderId: string;
  requestId: string;
  receiptId: string | null;
  status: TargetUiVerdictStatus;
  classification: TargetUiClassification;
  reasons: string[];
  screenshots?: { phase: string; path: string }[];
}

export interface TargetUiSession {
  sessionId: string;
  instanceId: string;
  endpoint: string;
  variant: TargetVariant;
  createdAt: string;
  expiresAt: string;
  active: boolean;
  provenance?: TargetUiProvenance;
}

export interface TargetUiProvenance {
  systemSnapshot: SystemBriefSnapshot;
  sourceHash: string;
  contractHash: string;
  uiHash: string;
  evaluatorHash: string;
}
