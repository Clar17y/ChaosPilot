import * as crypto from 'node:crypto';
import {
  assertAdapterVariant,
  resolveAdapter,
  type AdapterRegistration,
} from '../adapters/index.ts';
import { parseChallengeExperiment } from '../challenges/index.ts';
import type { Experiment, InvestigationRecord, TargetVariant } from '../domain.ts';
import { canonicalJson, compareSemanticReplay, computeContractHash } from '../evidence.ts';
import { resolveExperimentPositionForIndex } from '../experiment-identity.ts';
import { evidenceHashOf } from '../explanations/index.ts';
import { evaluateRequirementRules } from '../requirements/evaluator.ts';
import {
  getRun,
  getRunRevision,
  replaySelectedExperiment,
  withRunMutation,
} from '../storage.ts';
import { computeSnapshotHash, validateSystemBrief } from '../systems/index.ts';
import {
  REGRESSION_EVALUATOR_ID,
  REGRESSION_EVALUATOR_VERSION,
  computeRegressionContentHash,
  computeRegressionDefinitionId,
  computeRegressionReviewToken,
  deriveRegressionExpectations,
  evaluateRegressionExecution,
  getRegressionEvaluatorIdentity,
} from './evaluator.ts';
import {
  checkOriginStatus,
  getRegressionDefinition,
  getRegressionDefinitionDetail,
  getRegressionRun,
  isValidRegressionDefinitionRecord,
  isValidRegressionRunRecord,
  listRegressionDefinitions,
  listRegressionRuns,
  resolveRegressionDefinitionPath,
  resolveRegressionDefinitionsDir,
  resolveRegressionRunPath,
  resolveRegressionRunsDir,
  resolveRegressionsDir,
  saveRegressionDefinition,
  saveRegressionRun,
  toRegressionRunSummary,
  validateRegressionId,
  validateRegressionRunId,
} from './storage.ts';
import type {
  RegressionDefinitionRecord,
  RegressionExpectedOutcomes,
  RegressionOrigin,
  RegressionPreviewResult,
  RegressionRunRecord,
} from './types.ts';

export class RegressionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegressionValidationError';
  }
}

export class RegressionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegressionNotFoundError';
  }
}

export class RegressionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegressionConflictError';
  }
}

export class RegressionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegressionUnavailableError';
  }
}

export interface RegressionAdapterOptions {
  runsDir?: string;
  signal?: AbortSignal;
  adapterResolver?: (adapterId: string) => AdapterRegistration;
}

export async function prepareRegressionCapture(
  record: InvestigationRecord,
  findingId: string,
  revision: string,
  runsDir = 'runs',
  options: RegressionAdapterOptions = {},
): Promise<{
  definitionId: string;
  contentHash: string;
  reviewToken: string;
  experiment: Experiment;
  origin: RegressionOrigin;
  expected: RegressionExpectedOutcomes;
  evaluator: ReturnType<typeof getRegressionEvaluatorIdentity>;
}> {
  const { signal } = options;
  signal?.throwIfAborted();

  if (record.status === 'running') {
    throw new RegressionConflictError(
      'Save as regression requires a terminal saved run. Wait for saving to finish.',
    );
  }

  const matches = record.findings.filter(f => f?.id === findingId);
  if (matches.length !== 1) {
    throw new RegressionUnavailableError('Finding is missing or ambiguous');
  }
  const finding = matches[0]!;

  const position = resolveExperimentPositionForIndex(
    record.experiments,
    finding.experimentIndex,
  );
  if (position < 0) {
    throw new RegressionUnavailableError(
      'Finding experiment identity cannot be uniquely verified',
    );
  }
  const saved = record.experiments[position]!;

  if (
    finding.reproduced !== true ||
    finding.cleanControlPassed !== true ||
    saved.replayVerified !== true ||
    saved.cleanControlPassed !== true
  ) {
    throw new RegressionUnavailableError(
      'Only a confirmed finding with recorded replay and clean control can be saved as a regression',
    );
  }

  if (
    !saved.result ||
    saved.result.valid !== true ||
    saved.result.executionComplete === false ||
    !Array.isArray(saved.result.violations) ||
    !saved.result.violations.some(v => canonicalJson(v) === canonicalJson(finding.violation))
  ) {
    throw new RegressionUnavailableError(
      'Finding is not supported by a valid completed saved experiment',
    );
  }

  if (
    finding.sourceHash !== record.sourceHash ||
    saved.result.sourceHash !== record.sourceHash
  ) {
    throw new RegressionUnavailableError('Finding source identity cannot be verified');
  }

  if (
    !record.systemBrief ||
    !record.systemBrief.brief ||
    !record.systemBrief.contract ||
    !validateSystemBrief(record.systemBrief.brief).valid
  ) {
    throw new RegressionUnavailableError(
      'Save as regression requires a pinned system brief and contract snapshot on the investigation run',
    );
  }

  const brief = record.systemBrief.brief;
  const pinnedContract = record.systemBrief.contract;
  const expectedSnapshotHash = computeSnapshotHash(
    brief,
    pinnedContract,
    record.systemBrief.requirementEvaluator,
  );
  if (record.systemBrief.hash !== expectedSnapshotHash) {
    throw new RegressionUnavailableError(
      'Pinned system brief snapshot hash cannot be verified',
    );
  }

  const adapterId = brief.adapterId;
  if (record.contextAudit?.adapterId && record.contextAudit.adapterId !== adapterId) {
    throw new RegressionUnavailableError(
      'Pinned system brief adapter does not match recorded context audit adapter',
    );
  }
  if (adapterId !== 'synthetic-trading') {
    throw new RegressionUnavailableError(
      `Adapter '${adapterId}' is not supported for regression capture; only 'synthetic-trading' is currently supported`,
    );
  }

  try {
    assertAdapterVariant(adapterId, record.variant);
  } catch (error) {
    throw new RegressionUnavailableError(
      error instanceof Error ? error.message : 'Unsupported target variant',
    );
  }

  const resolve = options.adapterResolver ?? resolveAdapter;
  const adapter = resolve(adapterId);
  const currentContract = adapter.getContract();
  const currentContractHash = computeContractHash(currentContract);

  if (
    computeContractHash(pinnedContract) !== currentContractHash ||
    canonicalJson(pinnedContract) !== canonicalJson(currentContract) ||
    record.contextAudit?.contractHash !== currentContractHash
  ) {
    throw new RegressionUnavailableError(
      'Regression cannot be verified: contract-hash provenance is missing or changed',
    );
  }

  const invariant = finding.violation?.invariant;
  if (
    typeof invariant !== 'string' ||
    !invariant.trim() ||
    !currentContract.invariants.some(i => i.id === invariant)
  ) {
    throw new RegressionUnavailableError(
      'Selected invariant is not supported by this adapter contract',
    );
  }

  let original: Experiment;
  try {
    original = parseChallengeExperiment(saved.experiment, adapter);
  } catch (error) {
    throw new RegressionUnavailableError(
      error instanceof Error ? error.message : 'Invalid original experiment',
    );
  }

  const cleanSourceHash = record.contextAudit?.cleanSourceHash;
  if (!cleanSourceHash) {
    throw new RegressionUnavailableError(
      'Regression cannot be verified: clean-source provenance is missing or changed',
    );
  }
  if (adapter.getSourceBundle('clean').hash !== cleanSourceHash) {
    throw new RegressionUnavailableError(
      'Regression cannot be verified: clean-source provenance is missing or changed',
    );
  }
  if (adapter.getSourceBundle(record.variant).hash !== record.sourceHash) {
    throw new RegressionUnavailableError(
      'Regression cannot be verified: target-source provenance is missing or changed',
    );
  }

  let replay: Awaited<ReturnType<typeof replaySelectedExperiment>>;
  try {
    replay = await replaySelectedExperiment(record, position, runsDir, undefined, signal);
  } catch (error) {
    if (
      signal?.aborted ||
      (error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message)))
    ) {
      throw error;
    }
    throw new RegressionUnavailableError(
      error instanceof Error
        ? `Regression cannot be verified: ${error.message}`
        : 'Regression cannot be verified: original replay failed',
    );
  }
  signal?.throwIfAborted();
  const checks = replay.contextChecks ?? [];
  for (const kind of ['contract-hash', 'clean-source', 'target-source'] as const) {
    if (!checks.some(c => c.kind === kind && c.status === 'identical')) {
      throw new RegressionUnavailableError(
        `Regression cannot be verified: ${kind} provenance is missing or changed`,
      );
    }
  }
  if (!replay.exactReproductionClaimed) {
    throw new RegressionUnavailableError(
      'Recorded source/context or original replay cannot be verified. Reload current evidence; regression capture is unavailable.',
    );
  }

  if (options.adapterResolver) {
    const customReplay = adapter.executeExperiment(structuredClone(original), record.variant);
    const cmp = compareSemanticReplay(saved.result, customReplay);
    if (
      !cmp.matched ||
      customReplay.sourceHash !== record.sourceHash ||
      customReplay.executionComplete !== saved.result.executionComplete ||
      canonicalJson(customReplay.deliveryObservations ?? null) !==
        canonicalJson(saved.result.deliveryObservations ?? null)
    ) {
      throw new RegressionUnavailableError(
        'Recorded source/context or original replay cannot be verified. Reload current evidence; regression capture is unavailable.',
      );
    }
  }

  const clean = adapter.executeExperiment(structuredClone(original), 'clean');
  if (
    clean.sourceHash !== cleanSourceHash ||
    clean.valid !== true ||
    clean.executionComplete === false ||
    clean.rejections.length > 0 ||
    clean.violations.length > 0
  ) {
    throw new RegressionUnavailableError(
      'Recorded original clean control cannot be independently verified',
    );
  }

  if (record.systemBrief.brief.requirementRules?.length) {
    try {
      const cleanRules = evaluateRequirementRules(
        clean,
        record.systemBrief,
        finding.experimentIndex,
      );
      if (cleanRules.some(r => r.status === 'failed' || r.status === 'inconclusive')) {
        throw new RegressionUnavailableError(
          'Configured requirement rules did not pass cleanly on the clean control',
        );
      }
    } catch (error) {
      if (error instanceof RegressionUnavailableError) throw error;
      throw new RegressionUnavailableError(
        'Configured requirement rules could not be verified on the clean control',
      );
    }
  }

  const derived = deriveRegressionExpectations(original, clean);
  if (!derived.ok) {
    throw new RegressionUnavailableError(derived.reason);
  }

  const origin: RegressionOrigin = {
    runId: record.id,
    runRevision: revision,
    evidenceHash: evidenceHashOf(record),
    findingId: finding.id,
    experimentIndex: finding.experimentIndex,
    experimentPosition: position,
    adapterId: 'synthetic-trading',
    variant: record.variant,
    sourceHash: record.sourceHash,
    cleanSourceHash,
    contractHash: currentContractHash,
    systemBrief: {
      id: brief.id,
      name: brief.name,
      revision: brief.revision,
      adapterId: 'synthetic-trading',
      hash: record.systemBrief.hash,
    },
    systemSnapshot: structuredClone(record.systemBrief),
    contract: structuredClone(pinnedContract),
    finding: structuredClone(finding),
    originalResult: structuredClone(saved.result),
  };

  const evaluator = getRegressionEvaluatorIdentity();
  const contentHash = computeRegressionContentHash({
    origin,
    experiment: original,
    expected: derived.expected,
    evaluator,
  });
  const reviewToken = computeRegressionReviewToken(contentHash);
  const definitionId = computeRegressionDefinitionId(contentHash);

  return {
    definitionId,
    contentHash,
    reviewToken,
    experiment: structuredClone(original),
    origin,
    expected: derived.expected,
    evaluator,
  };
}

export async function previewRegressionFromFinding(
  runId: string,
  findingId: string,
  options: RegressionAdapterOptions & {
    expectedRunRevision?: string;
    expectedEvidenceHash?: string;
  } = {},
): Promise<RegressionPreviewResult> {
  const runsDir = options.runsDir ?? 'runs';
  const { signal } = options;
  signal?.throwIfAborted();

  return withRunMutation(
    runId,
    runsDir,
    async () => {
      const record = await getRun(runId, runsDir);
      if (!record) {
        throw new RegressionNotFoundError('Saved run not found');
      }
      const revision = await getRunRevision(runId, runsDir);
      const evidenceHash = evidenceHashOf(record);

      if (
        (options.expectedRunRevision !== undefined &&
          options.expectedRunRevision !== revision) ||
        (options.expectedEvidenceHash !== undefined &&
          options.expectedEvidenceHash !== evidenceHash)
      ) {
        throw new RegressionConflictError(
          'Run changed since selection. Reload the saved run before previewing regression capture.',
        );
      }

      try {
        const prepared = await prepareRegressionCapture(
          record,
          findingId,
          revision,
          runsDir,
          options,
        );
        const existing = await getRegressionDefinition(prepared.definitionId, runsDir);
        return {
          available: true,
          runId,
          findingId,
          runRevision: revision,
          evidenceHash,
          definitionId: prepared.definitionId,
          contentHash: prepared.contentHash,
          reviewToken: prepared.reviewToken,
          existingDefinitionId: existing ? existing.id : null,
          experiment: prepared.experiment,
          origin: prepared.origin,
          expected: prepared.expected,
          evaluator: prepared.evaluator,
        };
      } catch (error) {
        if (error instanceof RegressionUnavailableError) {
          return {
            available: false,
            runId,
            findingId,
            runRevision: revision,
            evidenceHash,
            reason: error.message,
          };
        }
        throw error;
      }
    },
    signal,
  );
}

export async function captureRegressionFromFinding(
  input: {
    runId: string;
    findingId: string;
    expectedRunRevision: string;
    expectedEvidenceHash: string;
    reviewToken: string;
    definitionId: string;
    contentHash?: string;
    reviewed: boolean;
  },
  options: RegressionAdapterOptions = {},
): Promise<RegressionDefinitionRecord> {
  const runsDir = options.runsDir ?? 'runs';
  const { signal } = options;
  signal?.throwIfAborted();

  if (input.reviewed !== true) {
    throw new RegressionValidationError(
      'Explicit engineer review consent (reviewed: true) is required before saving a regression definition',
    );
  }

  return withRunMutation(
    input.runId,
    runsDir,
    async () => {
      const record = await getRun(input.runId, runsDir);
      if (!record) {
        throw new RegressionNotFoundError('Saved run not found');
      }
      const revision = await getRunRevision(input.runId, runsDir);
      const evidenceHash = evidenceHashOf(record);

      if (
        revision !== input.expectedRunRevision ||
        evidenceHash !== input.expectedEvidenceHash
      ) {
        throw new RegressionConflictError(
          'Run changed or was replaced since preview. Reload and review the current finding before saving.',
        );
      }

      const prepared = await prepareRegressionCapture(
        record,
        input.findingId,
        revision,
        runsDir,
        options,
      );

      if (
        input.reviewToken !== prepared.reviewToken ||
        input.definitionId !== prepared.definitionId ||
        (input.contentHash !== undefined && input.contentHash !== prepared.contentHash)
      ) {
        throw new RegressionValidationError(
          'Review token or definition hash does not match the current reviewed finding preview',
        );
      }

      const recheckRecord = await getRun(input.runId, runsDir);
      if (!recheckRecord) {
        throw new RegressionConflictError(
          'Run was deleted before regression definition could be saved',
        );
      }
      const recheckRevision = await getRunRevision(input.runId, runsDir);
      if (
        recheckRevision !== revision ||
        evidenceHashOf(recheckRecord) !== evidenceHash
      ) {
        throw new RegressionConflictError(
          'Run changed during regression capture. Reload and review the current finding before saving.',
        );
      }

      const definition: RegressionDefinitionRecord = {
        schemaVersion: 1,
        id: prepared.definitionId,
        type: 'regression-definition',
        createdAt: new Date().toISOString(),
        reviewed: true,
        reviewToken: prepared.reviewToken,
        contentHash: prepared.contentHash,
        adapterId: 'synthetic-trading',
        experiment: prepared.experiment,
        origin: prepared.origin,
        expected: prepared.expected,
        evaluator: prepared.evaluator,
      };

      signal?.throwIfAborted();
      try {
        await saveRegressionDefinition(definition, runsDir);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('Cannot overwrite existing regression definition')) {
          throw new RegressionConflictError(msg);
        }
        throw error;
      }
      return definition;
    },
    signal,
  );
}

export async function runSavedRegression(
  input: {
    definitionId: string;
    variant: TargetVariant;
    systemId?: string;
  },
  options: RegressionAdapterOptions = {},
): Promise<RegressionRunRecord> {
  const runsDir = options.runsDir ?? 'runs';
  const { signal } = options;
  signal?.throwIfAborted();

  if (!validateRegressionId(input.definitionId)) {
    throw new RegressionValidationError(
      `Invalid regression definition ID: "${input.definitionId}"`,
    );
  }

  const definition = await getRegressionDefinition(input.definitionId, runsDir);
  if (!definition) {
    throw new RegressionNotFoundError(
      `Regression definition "${input.definitionId}" not found`,
    );
  }

  if (
    input.systemId !== undefined &&
    input.systemId !== definition.origin.systemBrief.id
  ) {
    throw new RegressionValidationError(
      `Regression definition "${input.definitionId}" belongs to system profile "${definition.origin.systemBrief.id}", not "${input.systemId}"`,
    );
  }

  if (definition.adapterId !== 'synthetic-trading') {
    throw new RegressionValidationError(
      `Unsupported adapter "${definition.adapterId}" on regression definition`,
    );
  }

  try {
    assertAdapterVariant(definition.adapterId, input.variant);
  } catch (error) {
    throw new RegressionValidationError(
      error instanceof Error
        ? error.message
        : `Unsupported target variant "${input.variant}"`,
    );
  }

  const resolve = options.adapterResolver ?? resolveAdapter;
  const adapter = resolve(definition.adapterId);
  const currentContract = adapter.getContract();
  if (
    computeContractHash(currentContract) !== definition.origin.contractHash ||
    canonicalJson(currentContract) !== canonicalJson(definition.origin.contract)
  ) {
    throw new RegressionUnavailableError(
      "Current adapter contract has drifted from the regression definition's pinned contract; cannot execute regression against an incompatible contract",
    );
  }

  const sourceBundle = adapter.getSourceBundle(input.variant);
  const expectedSourceHash = sourceBundle.hash;

  const startedAt = new Date().toISOString();
  signal?.throwIfAborted();
  const executionResult = adapter.executeExperiment(
    structuredClone(definition.experiment),
    input.variant,
  );
  signal?.throwIfAborted();
  const evaluation = evaluateRegressionExecution(
    definition,
    executionResult,
    expectedSourceHash,
    input.variant,
  );
  const finishedAt = new Date().toISOString();

  const assertions = evaluation.assertions;
  const record: RegressionRunRecord = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    type: 'regression-run',
    definitionId: definition.id,
    definitionHash: definition.contentHash,
    adapterId: 'synthetic-trading',
    variant: input.variant,
    sourceHash: evaluation.sourceHash,
    expectedSourceHash,
    status: evaluation.status,
    startedAt,
    finishedAt,
    evaluator: getRegressionEvaluatorIdentity(),
    origin: {
      runId: definition.origin.runId,
      runRevision: definition.origin.runRevision,
      evidenceHash: definition.origin.evidenceHash,
      findingId: definition.origin.findingId,
      experimentIndex: definition.origin.experimentIndex,
      variant: definition.origin.variant,
      sourceHash: definition.origin.sourceHash,
      cleanSourceHash: definition.origin.cleanSourceHash,
      contractHash: definition.origin.contractHash,
      systemBrief: structuredClone(definition.origin.systemBrief),
      systemSnapshot: structuredClone(definition.origin.systemSnapshot),
      contract: structuredClone(definition.origin.contract),
      finding: structuredClone(definition.origin.finding),
    },
    experiment: structuredClone(definition.experiment),
    expected: structuredClone(definition.expected),
    evaluation,
    summary: {
      totalAssertions: assertions.length,
      passedAssertions: assertions.filter(a => a.status === 'pass').length,
      failedAssertions: assertions.filter(a => a.status === 'fail').length,
      inconclusiveAssertions: assertions.filter(a => a.status === 'inconclusive').length,
      invalidAssertions: assertions.filter(a => a.status === 'invalid').length,
    },
  };

  signal?.throwIfAborted();
  await saveRegressionRun(record, runsDir);
  return record;
}

export * from './types.ts';
export {
  REGRESSION_EVALUATOR_ID,
  REGRESSION_EVALUATOR_VERSION,
  checkOriginStatus,
  computeRegressionContentHash,
  computeRegressionDefinitionId,
  computeRegressionReviewToken,
  deriveRegressionExpectations,
  evaluateRegressionExecution,
  getRegressionDefinition,
  getRegressionDefinitionDetail,
  getRegressionEvaluatorIdentity,
  getRegressionRun,
  isValidRegressionDefinitionRecord,
  isValidRegressionRunRecord,
  listRegressionDefinitions,
  listRegressionRuns,
  resolveRegressionDefinitionPath,
  resolveRegressionDefinitionsDir,
  resolveRegressionRunPath,
  resolveRegressionRunsDir,
  resolveRegressionsDir,
  saveRegressionDefinition,
  saveRegressionRun,
  toRegressionRunSummary,
  validateRegressionId,
  validateRegressionRunId,
};
