/** Shared v1 contract. Browser-safe data only; recovery/backend and UI use this schema. */
export type CoverageScenarioId = 'accepted-order-credit-limit' | 'recovery-by-deadline' | 'recovery-retry-idempotence';

export interface CoverageIdentity {
  id: string;
  version: number;
  hash: string;
}

/** Every evidence comparison uses the saved context, never the currently edited profile. */
export interface CoverageContext {
  systemId: string;
  revision: number;
  snapshotHash: string;
  adapterId: string;
  variant: string;
  sourceHash: string;
  contractHash: string;
}

export type CoverageRequirementLink =
  | { kind: 'requirement-text'; text: string }
  | { kind: 'contract-rule'; ruleId: string };

export interface CoveragePlanIntention {
  scenarioId: CoverageScenarioId;
  reviewed: true;
  links: CoverageRequirementLink[];
}

export interface CoveragePlan {
  schemaVersion: 1;
  catalog: CoverageIdentity;
  evaluator: CoverageIdentity;
  context: CoverageContext;
  intentions: CoveragePlanIntention[];
}

export interface CoverageScenarioSuggestion {
  scenarioId: CoverageScenarioId;
  title: string;
  description: string;
  links: CoverageRequirementLink[];
}

export interface CoveragePreparationInput {
  context: CoverageContext;
  requirements: readonly string[];
  /** Existing reviewed credit-rule mappings only; additional prose remains context. */
  requirementRules?: readonly { requirement: string; preset: string; reviewed: boolean }[];
  contractRuleIds: readonly string[];
}

export interface CoveragePreparation {
  context: CoverageContext;
  catalog: CoverageIdentity;
  evaluator: CoverageIdentity;
  suggestions: CoverageScenarioSuggestion[];
  contextOnly: string[];
}

export interface BuildCoveragePlanInput {
  preparation: CoveragePreparationInput;
  intentions: readonly CoveragePlanIntention[];
}

export interface CoveragePlanValidation {
  valid: boolean;
  errors: string[];
  plan?: CoveragePlan;
}

export interface CoverageTraceReference {
  traceIndex: number;
  step: number;
  tick: number;
  messageId?: string;
}

export interface CoverageCreditFacts {
  kind: 'credit-admission';
  requirement: string;
  requirementEvaluator: CoverageIdentity;
  messageId: string;
  payloadValid: boolean;
  deliveryStatus: 'accepted' | 'rejected' | 'exception';
  usedCredit?: number;
  reservedCredit?: number;
  creditLimit?: number;
}

export interface RecoveryAccountingFacts {
  filledQuantity: number;
  remainingQuantity: number;
  usedCredit: number;
  reservedCredit: number;
  applicationCount: number;
}

/** Acceptance is target-owned ingress acceptance, not harness scheduling or acknowledgement. */
export interface CoverageRecoveryFacts {
  kind: 'recovery';
  reportId: string;
  executionId: string;
  orderId: string;
  acceptedAtTick: number;
  acceptedDuringDisconnection: boolean;
  reconnectTick?: number;
  deadlineTick?: number;
  /** Actual checked horizon after processing all work due at that tick. */
  horizonTick: number;
  completionTick?: number;
  retryObserved?: boolean;
  expected: RecoveryAccountingFacts;
  observed?: RecoveryAccountingFacts;
}

/** Recorded during execution. A claimed goal or absent oracle violation is never a check. */
export interface ScenarioCheckEvidence {
  schemaVersion: 1;
  /** Deterministic identity unique within the experiment; duplicate ids are ambiguous. */
  id: string;
  scenarioId: CoverageScenarioId;
  evaluator: CoverageIdentity;
  context: CoverageContext;
  experimentIndex: number;
  trigger: 'reached' | 'not-reached' | 'unknown';
  outcome: 'passed' | 'failed' | 'not-checked' | 'inconclusive';
  traceRefs: CoverageTraceReference[];
  facts: CoverageCreditFacts | CoverageRecoveryFacts;
  /** Independent oracle violation identity, required to match a confirmed finding. */
  violationId?: string;
  detail: string;
}

/** Additive fields for the backend owner to attach to its existing saved record/result. */
export interface CoverageRecordFields {
  coveragePlan?: CoveragePlan;
}
export interface CoverageResultFields {
  scenarioCheckEvidence?: ScenarioCheckEvidence[];
}

export interface CoverageExperimentInput {
  index: number;
  valid: boolean;
  executionComplete?: boolean;
  sourceHash: string;
  trace: readonly { step: number; time: number; messageId?: string }[];
  checks: readonly ScenarioCheckEvidence[];
}

export interface CoverageFindingInput {
  id: string;
  experimentIndex: number;
  sourceHash: string;
  violationId: string;
  invariant: string;
  reproduced: boolean;
  cleanControlPassed: boolean;
}

export type CoverageStatus = 'suggested' | 'planned' | 'exercised' | 'failed-unconfirmed'
  | 'confirmed' | 'inconclusive' | 'invalid' | 'unsupported';

export interface CoverageRow {
  scenarioId: CoverageScenarioId | null;
  title: string;
  status: CoverageStatus;
  reason: string;
  links: CoverageRequirementLink[];
  evidence: ScenarioCheckEvidence[];
  experimentIndices: number[];
  findingIds: string[];
}

export interface CoverageProjectionInput {
  runId: string;
  plan?: unknown;
  /** The run's saved context and requirement links, not today's system snapshot. */
  preparation: CoveragePreparationInput | null;
  experiments: readonly CoverageExperimentInput[];
  findings: readonly CoverageFindingInput[];
  stop: { status: 'running' | 'completed' | 'cancelled' | 'failed'; reason?: string };
}

export interface CoverageProjection {
  runId: string;
  state: 'ready' | 'legacy' | 'incompatible';
  context: CoverageContext | null;
  stop: CoverageProjectionInput['stop'];
  rows: CoverageRow[];
  warnings: string[];
}

/** Pure public function boundaries; implementations are supplied in the next commit. */
export interface CoverageFunctions {
  prepareCoverage(input: CoveragePreparationInput): CoveragePreparation;
  buildCoveragePlan(input: BuildCoveragePlanInput): CoveragePlanValidation;
  validateCoveragePlan(plan: unknown, expected: CoveragePreparationInput): CoveragePlanValidation;
  projectCoverage(input: CoverageProjectionInput): CoverageProjection;
}

/**
 * HTTP agreement: POST /api/coverage/prepare resolves source/contract/snapshot on the server.
 * POST /api/investigation/start accepts coveragePlan and validates/persists it BEFORE inference.
 * GET /api/runs and GET /api/runs/:id remain read-only; detail includes the additive fields above.
 * Errors use the existing { error: string } response. No coverage GET executes a target/model.
 */
export interface CoveragePrepareRequest {
  systemId: string;
  expectedRevision: number;
  adapterId: string;
  variant: string;
}
export type CoveragePrepareResponse = CoveragePreparation;

export interface CoverageLaunchFields {
  coveragePlan: CoveragePlan;
}

export interface CoverageLaunchResponse {
  id: string;
  variant: string;
  provider: 'mock' | 'meta';
  systemBrief: { id: string; name: string; revision: number; hash: string };
  /** Echo the plan attached to the saved run before the first model request. */
  coveragePlan: CoveragePlan;
}
