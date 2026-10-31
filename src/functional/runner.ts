import * as crypto from 'node:crypto';
import type { SystemBriefSnapshot, TargetVariant } from '../domain.ts';
import { resolveAdapter } from '../adapters/index.ts';
import { FUNCTIONAL_CATALOG } from './catalog.ts';
import { evaluateFunctionalScenario, getFunctionalEvaluatorIdentity } from './evaluator.ts';
import type {
  FunctionalRunRecord,
  FunctionalRunStatus,
  FunctionalScenarioResult,
} from './types.ts';

export interface FunctionalRunnerOptions {
  variant: TargetVariant;
  systemSnapshot: SystemBriefSnapshot;
}

export function generateFunctionalRunId(): string {
  return `fnrun_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

export async function runFunctionalBaselines(
  options: FunctionalRunnerOptions,
): Promise<FunctionalRunRecord> {
  const { variant, systemSnapshot } = options;
  const adapterId = systemSnapshot.brief.adapterId;

  if (adapterId !== 'synthetic-trading') {
    throw new Error(
      `Functional baselines are only supported for the "synthetic-trading" adapter; got "${adapterId}"`,
    );
  }

  const adapter = resolveAdapter(adapterId);
  if (!adapter.variants.includes(variant)) {
    throw new Error(`Unsupported target variant "${variant}" for adapter "${adapterId}"`);
  }

  const contract = systemSnapshot.contract ?? adapter.getContract();
  const sourceBundle = adapter.getSourceBundle(variant);
  const startedAt = new Date().toISOString();
  const id = generateFunctionalRunId();

  const scenarioResults: FunctionalScenarioResult[] = [];

  for (let i = 0; i < FUNCTIONAL_CATALOG.length; i++) {
    const scenario = FUNCTIONAL_CATALOG[i]!;
    const rawExperiment = scenario.buildExperiment();
    const experiment = adapter.parseExperiment(rawExperiment);

    const experimentResult = adapter.executeExperiment(experiment, variant);

    const evaluated = evaluateFunctionalScenario(
      scenario,
      experimentResult,
      systemSnapshot,
      i,
      sourceBundle.hash,
      variant,
    );
    scenarioResults.push(evaluated);
  }

  const finishedAt = new Date().toISOString();

  let totalAssertions = 0;
  let passedAssertions = 0;
  let failedAssertions = 0;

  for (const s of scenarioResults) {
    for (const a of s.assertions) {
      totalAssertions++;
      if (a.status === 'pass') passedAssertions++;
      else if (a.status === 'fail') failedAssertions++;
    }
  }

  const passedScenarios = scenarioResults.filter((s) => s.status === 'pass').length;
  const failedScenarios = scenarioResults.filter((s) => s.status === 'fail').length;
  const inconclusiveScenarios = scenarioResults.filter((s) => s.status === 'inconclusive').length;
  const invalidScenarios = scenarioResults.filter((s) => s.status === 'invalid').length;

  let overallStatus: FunctionalRunStatus;
  if (invalidScenarios > 0) {
    overallStatus = 'invalid';
  } else if (failedScenarios > 0) {
    overallStatus = 'fail';
  } else if (inconclusiveScenarios > 0) {
    overallStatus = 'inconclusive';
  } else {
    overallStatus = 'pass';
  }

  const record: FunctionalRunRecord = {
    schemaVersion: 1,
    id,
    type: 'functional-baseline',
    adapterId: 'synthetic-trading',
    variant,
    sourceHash: sourceBundle.hash,
    status: overallStatus,
    startedAt,
    finishedAt,
    evaluator: getFunctionalEvaluatorIdentity(),
    systemBrief: {
      id: systemSnapshot.brief.id,
      name: systemSnapshot.brief.name,
      revision: systemSnapshot.brief.revision,
      adapterId: systemSnapshot.brief.adapterId,
      hash: systemSnapshot.hash,
    },
    systemSnapshot: structuredClone(systemSnapshot),
    contract: structuredClone(contract),
    scenarios: scenarioResults,
    summary: {
      totalScenarios: scenarioResults.length,
      passed: passedScenarios,
      failed: failedScenarios,
      inconclusive: inconclusiveScenarios,
      invalid: invalidScenarios,
      totalAssertions,
      passedAssertions,
      failedAssertions,
    },
  };

  return record;
}
