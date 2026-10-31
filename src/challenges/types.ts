import type { Action, Experiment, ExperimentResult, TargetVariant, Usage } from '../domain.ts';

export interface ChallengeBinding {
  runId: string;
  findingId: string;
  evidenceHash: string;
  runRevision: string;
  experimentPosition: number;
  adapterId: string;
  target: TargetVariant;
  invariant: string;
  category?: string;
  sourceHash: string;
  cleanSourceHash: string;
  contractHash: string;
  snapshotHash: string | null;
}
export interface ChallengeProposal {
  proposedChange: string;
  experiment: Experiment;
  changes: { step: number; before?: Action; after?: Action }[];
}
export interface ChallengeVariant extends ChallengeProposal {
  candidate?: ExperimentResult;
  replay?: ExperimentResult;
  clean?: ExperimentResult;
  candidateStatus: 'completed' | 'invalid-or-incomplete' | 'source-mismatch' | 'error' | 'unavailable';
  sameInvariant: 'observed' | 'absent' | 'unavailable';
  otherInvariants: string[];
  replayStatus: 'matched' | 'mismatch' | 'error' | 'unavailable';
  replayMismatches: string[];
  cleanStatus: 'passed' | 'failed' | 'invalid-or-incomplete' | 'source-mismatch' | 'error' | 'unavailable';
  reproduced: boolean;
  errors: string[];
}
export interface ChallengeRequest {
  phase: 'proposal' | 'interpretation';
  model?: string;
  status: 'completed' | 'failed' | 'cancelled';
  usage: Usage | null;
  usageKnown: boolean;
  requestSent: boolean | null;
  error?: string;
}
export interface ChallengeRecord {
  schemaVersion: 1;
  id: string;
  binding: ChallengeBinding;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  variants: ChallengeVariant[];
  proposalResponse?: { text: string; bytes: number; truncated: boolean };
  requests: ChallengeRequest[];
  interpretation: { status: 'pending' | 'available' | 'unavailable' | 'cancelled' | 'not-requested'; text?: string; error?: string };
  error?: string;
}
export interface ChallengeView {
  evidenceHash: string;
  runRevision: string;
  available: boolean;
  reason?: string;
  inFlight: boolean;
  stale: boolean;
  current: ChallengeRecord | null;
  latestPartial?: ChallengeRecord | null;
  latestAttempt: ChallengeRecord | null;
}
