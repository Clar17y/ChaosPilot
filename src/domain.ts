// Integration contracts. Target implementation and hidden evaluation metadata live elsewhere.
export const TARGET_VARIANTS = ['clean', 'candidate-a', 'candidate-b', 'candidate-c', 'candidate-d', 'candidate-e', 'candidate-f', 'candidate-g', 'candidate-h', 'candidate-i'] as const;
const INVENTORY_FAULT_VARIANTS = ['inventory-candidate-a', 'inventory-candidate-b', 'inventory-candidate-c', 'inventory-candidate-d'] as const;
export const INVENTORY_TARGET_VARIANTS = ['clean', ...INVENTORY_FAULT_VARIANTS] as const;
export const ALL_TARGET_VARIANTS = [...TARGET_VARIANTS, ...INVENTORY_FAULT_VARIANTS] as const;
export type TargetVariant = typeof ALL_TARGET_VARIANTS[number];
export type ProviderKind = 'mock' | 'meta';
export type Channel = 'market' | 'credit' | 'client' | 'reports' | 'stock' | 'reservations' | 'shipments';

export type Action =
  | { op: 'send'; id: string; to: Channel; payload: unknown; delay?: number }
  | { op: 'duplicate'; messageId: string; id: string; delay?: number }
  | { op: 'deliver'; messageId: string }
  | { op: 'advance'; ticks: number }
  | { op: 'drain' }
  | { op: 'fill'; messageId: string; orderId: string; executionId: string; quantity: number; delay?: number }
  | { op: 'confirm_cancel'; messageId: string; orderId: string; delay?: number };

export interface Experiment {
  hypothesis: string;
  expectedInvariant: string;
  steps: Action[];
}

export interface SourceBundle {
  hash: string;
  files: { path: string; content: string }[];
}

export interface SystemContract {
  name: string;
  description: string;
  operations: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  invariants: { id: string; description: string }[];
  limits: Record<string, number>;
}

export interface SystemBrief {
  schemaVersion: 1;
  id: string;
  revision: number;
  name: string;
  overview: string;
  // Additional human requirements are context until a deterministic check is configured.
  requirements: string[];
  /** Explicitly reviewed declarative rules, associated by unique normalized text. */
  requirementRules?: RequirementRule[];
  adapterId: 'synthetic-trading' | 'inventory-reservation' | 'unconfigured';
  updatedAt: string;
}

export interface SystemBriefSnapshot {
  brief: SystemBrief;
  contract: SystemContract | null;
  hash: string;
  requirementEvaluator?: RequirementEvaluatorIdentity;
}

export interface RequirementRule {
  requirement: string;
  preset: 'accepted-order-credit-limit';
  reviewed: true;
}

export interface RequirementEvaluatorIdentity {
  id: string;
  version: number;
  hash: string;
}

/** Actual delivery observations; never inferred from human-readable outcomes. */
export interface DeliveryObservation {
  traceIndex: number;
  step: number;
  action: 'deliver' | 'drain:deliver';
  messageId: string;
  channel: Channel;
  messageType: string | null;
  payloadValid: boolean;
  status: 'accepted' | 'rejected' | 'exception';
  reason?: string;
  usedCredit?: number;
  reservedCredit?: number;
  creditLimit?: number;
}

export type RequirementRuleStatus = 'passed' | 'failed' | 'not-exercised' | 'inconclusive';

export interface RequirementRuleEvidence {
  traceIndex?: number;
  step?: number;
  action?: string;
  messageId?: string;
  status: RequirementRuleStatus | 'target-rejected' | 'invalid-payload';
  detail: string;
  usedCredit?: number;
  reservedCredit?: number;
  creditLimit?: number;
  totalCredit?: number;
  expected: 'usedCredit + reservedCredit <= current credit limit';
}

export interface RequirementRuleResult {
  requirement: string;
  preset: RequirementRule['preset'];
  experimentIndex: number;
  sourceHash: string;
  snapshotHash: string;
  evaluator: RequirementEvaluatorIdentity;
  status: RequirementRuleStatus;
  matchedEvents: number;
  evidence: RequirementRuleEvidence[];
}

export interface Violation {
  id: string;
  invariant: string;
  /** Deterministic category from the independent oracle, when available. Groups repeats of the same observable failure. */
  category?: string;
  message: string;
  step: number;
  orderId?: string;
  evidence: Record<string, unknown>;
}

export interface TraceEntry {
  step: number;
  time: number;
  action: string;
  messageId?: string;
  businessTime?: number;
  payload?: unknown;
  outcome: string;
  state: Record<string, unknown>;
}

export interface ExperimentResult {
  schemaVersion: 1;
  /** True when produced by an oracle that records violation categories.
   * Absent on genuine legacy results; stripped categories on a
   * category-aware result must not be treated as legacy during replay.
   * This is a consistency marker, not tamper resistance. */
  categoryAware?: boolean;
  experiment: Experiment;
  sourceHash: string;
  trace: TraceEntry[];
  snapshot: Record<string, unknown>;
  violations: Violation[];
  rejections: { step: number; reason: string }[];
  valid: boolean;
  deliveryObservations?: DeliveryObservation[];
  executionComplete?: boolean;
  requirementRuleResults?: RequirementRuleResult[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface Observation {
  experiment: Experiment;
  result: ExperimentResult;
}

export interface ProviderContext {
  contract: SystemContract;
  source: SourceBundle;
  history: Observation[];
  experimentNumber: number;
  maxExperiments: number;
  feedback?: string[];
  systemBrief?: SystemBriefSnapshot;
}

export type ProposalAttemptStatus =
  | 'pending'
  | 'executed'
  | 'invalid_response'
  | 'invalid_plan'
  | 'stopped'
  | 'failed'
  | 'cancelled';

export interface ProviderRequestAudit {
  promptVersion: string;
  promptTemplateHash: string;
  promptHash: string;
  requestHash: string;
  systemMessage: string;
  userMessage: string;
  configuration: Record<string, string | number>;
  historyCompaction?: { totalObservations: number; summarizedObservations: number; omittedObservations: number };
}

export interface ProviderResponseAudit {
  content?: string;
  /** The audit stores a bounded preview independently of the model's finish reason. */
  contentTruncated?: boolean;
  contentLength?: number;
  finishReason?: string;
  validationError?: string;
}

export interface ProposalAttempt {
  index: number;
  experimentNumber: number;
  correctionNumber: number;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status: ProposalAttemptStatus;
  request?: ProviderRequestAudit;
  response?: ProviderResponseAudit;
  usage?: Usage;
  usageKnown: boolean;
  requestSent?: boolean;
  error?: string;
  experimentIndex?: number;
}

export interface ProviderReply {
  experiment: Experiment | null;
  usage: Usage;
  summary?: string;
  validationError?: string;
  requestAudit?: ProviderRequestAudit;
  responseAudit?: ProviderResponseAudit;
  requestSent?: boolean;
}

export type RequestAuditCallback = (audit: ProviderRequestAudit) => void | Promise<void>;

export interface ExperimentProvider {
  readonly kind: ProviderKind;
  readonly model: string;
  readonly configuration?: Record<string, string | number>;
  propose(
    context: ProviderContext,
    signal?: AbortSignal,
    onRequestAudit?: RequestAuditCallback
  ): Promise<ProviderReply>;
}

export interface ExperimentRecord {
  index: number;
  experiment: Experiment;
  result: ExperimentResult;
  replayVerified: boolean;
  cleanControlPassed: boolean;
}

export interface Finding {
  id: string;
  title: string;
  hypothesis: string;
  experimentIndex: number;
  /** Oracle category used to group repeats; falls back to the invariant for legacy/generic findings. */
  category?: string;
  violation: Violation;
  sourceHash: string;
  reproduced: boolean;
  cleanControlPassed: boolean;
  replay: Experiment;
}

export interface InvestigationRecord {
  schemaVersion: 1;
  id: string;
  provider: ProviderKind;
  model: string;
  mode: 'live' | 'mock';
  variant: TargetVariant;
  /** Opt-in continuation after verified findings. Absent on legacy records (treated as false). */
  continueAfterFindings?: boolean;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  startedAt: string;
  finishedAt?: string;
  stopReason?: string;
  sourceHash: string;
  experiments: ExperimentRecord[];
  findings: Finding[];
  usage: Usage;
  errors: string[];
  contextAudit: {
    adapterId?: string;
    variant?: TargetVariant;
    cleanSourceHash?: string;
    sourcePaths: string[];
    /** SHA-256 of executing contract: canonical JSON for new records; historical records may carry a legacy raw JSON.stringify hash. */
    contractHash: string;
    promptVersion: string;
    promptTemplateHash?: string;
    providerConfiguration?: Record<string, string | number>;
    maxProposalAttempts?: number;
  };
  proposalAttempts?: ProposalAttempt[];
  systemBrief?: SystemBriefSnapshot;
}

export interface InvestigationOptions {
  id?: string;
  variant: TargetVariant;
  continueAfterFindings?: boolean;
  maxExperiments?: number;
  maxProposalAttempts?: number;
  provider: ExperimentProvider;
  signal?: AbortSignal;
  onUpdate?: (record: InvestigationRecord) => void | Promise<void>;
  systemBrief?: SystemBriefSnapshot;
}
