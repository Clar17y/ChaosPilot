import type {
  Channel,
  DeliveryObservation,
  Experiment,
  ExperimentResult,
  Finding,
  RequirementRuleResult,
  SystemBriefSnapshot,
  SystemContract,
  TargetVariant,
  TraceEntry,
  Violation,
} from '../domain.ts';
import type {
  FunctionalAssertionEvidence,
  FunctionalAssertionResult,
  FunctionalAssertionStatus,
  FunctionalRunStatus,
} from '../functional/types.ts';

export type {
  FunctionalAssertionEvidence,
  FunctionalAssertionResult,
  FunctionalAssertionStatus,
  FunctionalRunStatus,
};

export interface RegressionEvaluatorIdentity {
  id: 'regression-evaluator';
  version: number;
  hash: string;
}

export interface RegressionReferenceProvenance {
  kind: 'clean-control-reference';
  referenceVariant: 'clean';
  referenceSourceHash: string;
  reviewLabel: 'Proposed reference behavior from clean control — requires engineer review';
  note: string;
}

export interface RegressionTraceBinding {
  traceIndex: number;
  step: number;
  action: 'send' | 'duplicate' | 'advance' | 'deliver' | 'drain:deliver' | 'drain' | 'fill' | 'confirm_cancel';
  messageId?: string;
  payload?: unknown;
  expectedOutcome: string;
}

export interface RegressionOrderStateExpectation {
  orderId: string;
  quoteId: string;
  price: number;
  initialQuantity: number;
  remainingQuantity: number;
  filledQuantity: number;
  cancelledQuantity: number;
  cancellationRequested: boolean;
  status: 'OPEN' | 'FILLED' | 'CANCELLED';
}

export interface RegressionQuoteStateExpectation {
  id: string;
  version: number;
  price: number;
}

export interface RegressionCreditLimitExpectation {
  version: number;
  limit: number;
}

export interface RegressionBusinessStateExpectation {
  quote: RegressionQuoteStateExpectation | null;
  creditLimit: RegressionCreditLimitExpectation | null;
  reservedCredit: number;
  usedCredit: number;
  orders: Record<string, RegressionOrderStateExpectation>;
  absentOrderIds: string[];
  stateUnchangedFromPrevious: boolean;
}

export type SupportedRegressionMessageType =
  | 'quote'
  | 'credit_limit'
  | 'new_order'
  | 'cancel_order'
  | 'execution'
  | 'cancel_ack';

export interface RegressionDeliveryExpectation {
  id: string;
  label: string;
  traceIndex: number;
  step: number;
  action: 'deliver' | 'drain:deliver';
  messageId: string;
  channel: Channel;
  messageType: SupportedRegressionMessageType;
  payloadValid: true;
  expectedStatus: 'accepted' | 'rejected';
  expectedReason?: string;
  targetOrderId?: string;
  expectedState: RegressionBusinessStateExpectation;
}

export interface RegressionExpectedOutcomes {
  referenceProvenance: RegressionReferenceProvenance;
  traceLength: number;
  traceBindings: RegressionTraceBinding[];
  deliveries: RegressionDeliveryExpectation[];
  finalState: RegressionBusinessStateExpectation;
}

export interface RegressionOrigin {
  runId: string;
  runRevision: string;
  evidenceHash: string;
  findingId: string;
  experimentIndex: number;
  experimentPosition: number;
  adapterId: 'synthetic-trading';
  variant: TargetVariant;
  sourceHash: string;
  cleanSourceHash: string;
  contractHash: string;
  systemBrief: {
    id: string;
    name: string;
    revision: number;
    adapterId: 'synthetic-trading';
    hash: string;
  };
  systemSnapshot: SystemBriefSnapshot;
  contract: SystemContract;
  finding: Finding;
  originalResult: ExperimentResult;
}

export interface RegressionOriginStatus {
  runId: string;
  findingId: string;
  available: boolean;
  stale: boolean;
  status: 'verified' | 'deleted' | 'modified' | 'unavailable';
  reason?: string;
}

export interface RegressionDefinitionRecord {
  schemaVersion: 1;
  id: string;
  type: 'regression-definition';
  createdAt: string;
  reviewed: true;
  reviewToken: string;
  contentHash: string;
  adapterId: 'synthetic-trading';
  experiment: Experiment;
  origin: RegressionOrigin;
  expected: RegressionExpectedOutcomes;
  evaluator: RegressionEvaluatorIdentity;
}

export interface RegressionDefinitionSummary {
  id: string;
  type: 'regression-definition';
  createdAt: string;
  contentHash: string;
  adapterId: 'synthetic-trading';
  title: string;
  invariant: string;
  category?: string;
  hypothesis: string;
  stepCount: number;
  deliveryCount: number;
  origin: {
    runId: string;
    runRevision: string;
    evidenceHash: string;
    findingId: string;
    experimentIndex: number;
    variant: TargetVariant;
    sourceHash: string;
    cleanSourceHash: string;
    contractHash: string;
    systemBrief: {
      id: string;
      name: string;
      revision: number;
      adapterId: 'synthetic-trading';
      hash: string;
    };
  };
  originStatus: RegressionOriginStatus;
  runCount: number;
  latestRun?: RegressionRunSummary | null;
}

export type RegressionPreviewResult =
  | {
      available: true;
      runId: string;
      findingId: string;
      runRevision: string;
      evidenceHash: string;
      definitionId: string;
      contentHash: string;
      reviewToken: string;
      existingDefinitionId: string | null;
      experiment: Experiment;
      origin: RegressionOrigin;
      expected: RegressionExpectedOutcomes;
      evaluator: RegressionEvaluatorIdentity;
    }
  | {
      available: false;
      runId: string;
      findingId: string;
      runRevision: string;
      evidenceHash: string;
      reason: string;
    };

export interface RegressionEvaluationResult {
  variant: TargetVariant;
  sourceHash: string;
  expectedSourceHash: string;
  valid: boolean;
  executionComplete: boolean;
  status: FunctionalAssertionStatus;
  summary: string;
  experiment: Experiment;
  trace: TraceEntry[];
  snapshot: Record<string, unknown>;
  deliveryObservations: DeliveryObservation[];
  rejections: { step: number; reason: string }[];
  violations: Violation[];
  requirementRuleResults?: RequirementRuleResult[];
  requirementEvaluationError?: string;
  assertions: FunctionalAssertionResult[];
}

export interface RegressionRunRecord {
  schemaVersion: 1;
  id: string;
  type: 'regression-run';
  definitionId: string;
  definitionHash: string;
  adapterId: 'synthetic-trading';
  variant: TargetVariant;
  sourceHash: string;
  expectedSourceHash: string;
  status: FunctionalRunStatus;
  startedAt: string;
  finishedAt: string;
  evaluator: RegressionEvaluatorIdentity;
  origin: {
    runId: string;
    runRevision: string;
    evidenceHash: string;
    findingId: string;
    experimentIndex: number;
    variant: TargetVariant;
    sourceHash: string;
    cleanSourceHash: string;
    contractHash: string;
    systemBrief: {
      id: string;
      name: string;
      revision: number;
      adapterId: 'synthetic-trading';
      hash: string;
    };
    systemSnapshot: SystemBriefSnapshot;
    contract: SystemContract;
    finding: Finding;
  };
  experiment: Experiment;
  expected: RegressionExpectedOutcomes;
  evaluation: RegressionEvaluationResult;
  summary: {
    totalAssertions: number;
    passedAssertions: number;
    failedAssertions: number;
    inconclusiveAssertions: number;
    invalidAssertions: number;
  };
}

export interface RegressionRunSummary {
  id: string;
  type: 'regression-run';
  definitionId: string;
  definitionHash: string;
  adapterId: 'synthetic-trading';
  variant: TargetVariant;
  sourceHash: string;
  expectedSourceHash: string;
  status: FunctionalRunStatus;
  startedAt: string;
  finishedAt: string;
  origin: {
    runId: string;
    findingId: string;
    variant: TargetVariant;
    sourceHash: string;
    systemBrief: {
      id: string;
      name: string;
      revision: number;
      adapterId: 'synthetic-trading';
      hash: string;
    };
  };
  summary: {
    totalAssertions: number;
    passedAssertions: number;
    failedAssertions: number;
    inconclusiveAssertions: number;
    invalidAssertions: number;
  };
}

export interface RegressionDefinitionDetail {
  definition: RegressionDefinitionRecord;
  originStatus: RegressionOriginStatus;
  runs: RegressionRunSummary[];
}
