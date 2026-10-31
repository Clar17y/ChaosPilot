import type {
  DeliveryObservation,
  Experiment,
  RequirementRuleResult,
  SystemBriefSnapshot,
  SystemContract,
  TargetVariant,
  TraceEntry,
  Violation,
} from '../domain.ts';

export type FunctionalAssertionStatus = 'pass' | 'fail' | 'inconclusive' | 'invalid';
export type FunctionalRunStatus = 'pass' | 'fail' | 'inconclusive' | 'invalid';

export interface FunctionalAssertionEvidence {
  step?: number;
  traceIndex?: number;
  messageId?: string;
  field?: string;
  expected: unknown;
  actual: unknown;
  detail: string;
}

export interface FunctionalAssertionResult {
  id: string;
  name: string;
  status: FunctionalAssertionStatus;
  milestone?: string;
  expected: string;
  actual: string;
  detail: string;
  evidence?: FunctionalAssertionEvidence;
}

export interface FunctionalScenarioResult {
  variant: TargetVariant;
  sourceHash: string;
  expectedSourceHash: string;
  expectedExperiment: Experiment;
  expectedMilestones: import('./catalog.ts').FunctionalMilestone[];
  valid: boolean;
  requirementEvaluationError?: string;
  scenarioId: string;
  name: string;
  description: string;
  status: FunctionalAssertionStatus;
  summary: string;
  experiment: Experiment;
  trace: TraceEntry[];
  deliveryObservations: DeliveryObservation[];
  rejections: { step: number; reason: string }[];
  violations: Violation[];
  requirementRuleResults?: RequirementRuleResult[];
  assertions: FunctionalAssertionResult[];
  executionComplete: boolean;
}

export interface FunctionalEvaluatorIdentity {
  id: string;
  version: number;
  hash: string;
}

export interface FunctionalRunRecord {
  schemaVersion: 1;
  id: string;
  type: 'functional-baseline';
  adapterId: 'synthetic-trading';
  variant: TargetVariant;
  sourceHash: string;
  status: FunctionalRunStatus;
  startedAt: string;
  finishedAt: string;
  evaluator: FunctionalEvaluatorIdentity;
  systemBrief: {
    id: string;
    name: string;
    revision: number;
    adapterId: string;
    hash: string;
  };
  systemSnapshot: SystemBriefSnapshot;
  contract: SystemContract;
  scenarios: FunctionalScenarioResult[];
  summary: {
    totalScenarios: number;
    passed: number;
    failed: number;
    inconclusive: number;
    invalid: number;
    totalAssertions: number;
    passedAssertions: number;
    failedAssertions: number;
  };
}

export interface FunctionalRunSummary {
  id: string;
  type: 'functional-baseline';
  adapterId: string;
  variant: TargetVariant;
  status: FunctionalRunStatus;
  startedAt: string;
  finishedAt: string;
  sourceHash: string;
  systemBrief: {
    id: string;
    name: string;
    revision: number;
    adapterId: string;
    hash: string;
  };
  summary: {
    totalScenarios: number;
    passed: number;
    failed: number;
    inconclusive: number;
    invalid: number;
  };
}

export interface FunctionalCatalogItem {
  id: string;
  name: string;
  description: string;
  adapterId: string;
  milestones: string[];
}
