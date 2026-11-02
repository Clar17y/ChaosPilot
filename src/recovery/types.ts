import type { Channel } from '../domain.ts';
import type { ExecutionReportPayload, ProcessResult, TargetSnapshot } from '../simulator/types.ts';

export type RecoveryStatus = 'passed' | 'failed' | 'not-exercised' | 'inconclusive' | 'invalid';
export interface RecoveryEvaluatorIdentity { id: string; version: number; hash: string }
export interface RecoveryApplication {
  key: string;
  report: ExecutionReportPayload;
  tick: number;
}
export interface RecoverySnapshot extends TargetSnapshot {
  connected: boolean;
  applications: RecoveryApplication[];
}
export interface RecoveryIngress {
  traceIndex: number;
  step: number;
  tick: number;
  messageId: string;
  status: 'accepted' | 'rejected' | 'exception';
  disconnected: boolean;
  duplicate: boolean;
  report?: ExecutionReportPayload;
  reason?: string;
}
export interface RecoveryFacts {
  filledQuantity: number;
  remainingQuantity: number;
  reservedCredit: number;
  usedCredit: number;
  applicationCount: number;
}
export interface RecoveryObligation {
  key: string;
  report: ExecutionReportPayload;
  acceptedTick: number;
  acceptanceTraceIndex: number;
  reconnectTick?: number;
  deadlineTick?: number;
  completionTick?: number;
  deadlineMissed: boolean;
  status: RecoveryStatus;
  checkedTick: number;
  checkTraceIndex: number;
  expected?: RecoveryFacts;
  observed?: RecoveryFacts;
}
export interface RecoveryRetryCheck {
  key: string;
  traceIndex: number;
  tick: number;
  status: RecoveryStatus;
  before?: RecoveryFacts;
  after?: RecoveryFacts;
  /** Independent expected accounting from the oracle's accepted-delivery history. */
  expected?: RecoveryFacts;
}
/** Raw deterministic observations. Coverage projects these; a proposal goal is not evidence. */
export interface RecoveryEvidence {
  schemaVersion: 1;
  evaluator: RecoveryEvaluatorIdentity;
  horizonTick: number;
  executionComplete: boolean;
  status: RecoveryStatus;
  idempotenceStatus: RecoveryStatus;
  ingress: RecoveryIngress[];
  obligations: RecoveryObligation[];
  retries: RecoveryRetryCheck[];
}
export interface RecoveryProcessResult extends ProcessResult {
  report?: ExecutionReportPayload;
  duplicate?: boolean;
}
export interface RecoveryTarget {
  processMessage(channel: Channel, payload: unknown, tick: number): RecoveryProcessResult;
  setConnected(connected: boolean, tick: number): void;
  nextDueTick(): number | undefined;
  runDue(tick: number): void;
  getSnapshot(): RecoverySnapshot;
}

export function isRecoveryEvaluatorIdentity(value: unknown): value is RecoveryEvaluatorIdentity {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as RecoveryEvaluatorIdentity).id === 'string' &&
    (value as RecoveryEvaluatorIdentity).id.length > 0 &&
    typeof (value as RecoveryEvaluatorIdentity).version === 'number' &&
    Number.isSafeInteger((value as RecoveryEvaluatorIdentity).version) &&
    typeof (value as RecoveryEvaluatorIdentity).hash === 'string' &&
    (value as RecoveryEvaluatorIdentity).hash.length > 0
  );
}
