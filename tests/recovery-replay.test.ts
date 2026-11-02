import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { InvestigationRecord } from '../src/domain.ts';
import { compareSemanticReplay } from '../src/evidence.ts';
import { runInvestigation } from '../src/investigation/index.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { RECOVERY_EVALUATOR_IDENTITY } from '../src/recovery/index.ts';
import { getRun, replayRun, replaySelectedExperiment, saveRun } from '../src/storage.ts';
import { SEEDED_RECOVERY_BRIEF, SEEDED_TRADING_BRIEF, createSystemSnapshot } from '../src/systems/index.ts';

let runsDir: string;

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chaospilot-recovery-replay-'));
});

afterEach(async () => {
  await fs.rm(runsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function recoveryRecord(
  variant: 'clean' | 'recovery-candidate-a' = 'recovery-candidate-a',
): Promise<InvestigationRecord> {
  const systemBrief = await createSystemSnapshot(structuredClone(SEEDED_RECOVERY_BRIEF));
  return runInvestigation({ variant, systemBrief, provider: new MockProvider() });
}

function findCheck(
  report: Awaited<ReturnType<typeof replayRun>> | Awaited<ReturnType<typeof replaySelectedExperiment>>,
  kind: string,
) {
  return report.contextChecks?.find((c) => c.kind === kind);
}

describe('Recovery saved evidence, semantic comparison, and replay provenance', () => {
  it('persists a recovery-candidate-a run and replays whole-run and selected-experiment with identical recovery-evaluator provenance', async () => {
    const record = await recoveryRecord('recovery-candidate-a');
    expect(record.findings).toHaveLength(1);
    expect(record.contextAudit.adapterId).toBe('synthetic-trading-recovery');
    await saveRun(record, runsDir);

    const loaded = await getRun(record.id, runsDir);
    expect(loaded?.variant).toBe('recovery-candidate-a');
    expect(loaded?.experiments[0]?.result.recovery?.evaluator).toEqual(RECOVERY_EVALUATOR_IDENTITY);

    const report = await replayRun(record.id, runsDir);
    expect(report.sourceIdentical).toBe(true);
    expect(report.contextStatus).toBe('verified');
    expect(report.contextDrift).toEqual([]);
    expect(report.exactReproductionClaimed).toBe(true);
    expect(report.outcomes.every((o) => o.exactMatched && o.recoveryMatched)).toBe(true);

    const evalCheck = findCheck(report, 'recovery-evaluator');
    expect(evalCheck).toMatchObject({
      kind: 'recovery-evaluator',
      status: 'identical',
      saved: `${RECOVERY_EVALUATOR_IDENTITY.id}@${RECOVERY_EVALUATOR_IDENTITY.version}:${RECOVERY_EVALUATOR_IDENTITY.hash}`,
      current: `${RECOVERY_EVALUATOR_IDENTITY.id}@${RECOVERY_EVALUATOR_IDENTITY.version}:${RECOVERY_EVALUATOR_IDENTITY.hash}`,
    });

    // Selected replay position is zero-based.
    const single = await replaySelectedExperiment(record.id, 0, runsDir);
    expect(single.scope).toBe('experiment');
    expect(single.experimentPosition).toBe(0);
    expect(single.exactReproductionClaimed).toBe(true);
    expect(single.outcomes[0]?.exactMatched).toBe(true);
    expect(single.outcomes[0]?.recoveryMatched).toBe(true);
    expect(findCheck(single, 'recovery-evaluator')?.status).toBe('identical');
  });

  it('replays a clean recovery control run with exact reproduction and zero findings', async () => {
    const record = await recoveryRecord('clean');
    expect(record.findings).toEqual([]);
    const report = await replayRun(record, runsDir);
    expect(report.exactReproductionClaimed).toBe(true);
    expect(report.outcomes.every((o) => o.recoveryMatched && o.replayedViolationsCount === 0)).toBe(
      true,
    );
    expect(findCheck(report, 'recovery-evaluator')?.status).toBe('identical');
  });

  it('detects tampered recovery obligations, retries, or status during semantic replay', async () => {
    const record = await recoveryRecord('recovery-candidate-a');

    // Tamper obligation outcome while keeping evaluator identity untouched.
    const tamperedObligation = structuredClone(record);
    const ob = tamperedObligation.experiments[0]!.result.recovery!.obligations[0]!;
    ob.deadlineMissed = !ob.deadlineMissed;
    ob.status = ob.deadlineMissed ? 'failed' : 'passed';
    const reportObligation = await replayRun(tamperedObligation, runsDir);
    expect(reportObligation.outcomes[0]?.recoveryMatched).toBe(false);
    expect(reportObligation.outcomes[0]?.exactMatched).toBe(false);
    expect(reportObligation.outcomes[0]?.mismatches?.some((m) => /recovery evidence/i.test(m))).toBe(true);
    expect(reportObligation.exactReproductionClaimed).toBe(false);

    // Tamper retry/idempotence evidence (real RecoveryRetryCheck shape).
    const tamperedRetry = structuredClone(record);
    tamperedRetry.experiments[0]!.result.recovery!.retries.push({
      key: '["ord-1","exec-1"]',
      traceIndex: 0,
      tick: 0,
      status: 'passed',
    });
    const reportRetry = await replayRun(tamperedRetry, runsDir);
    expect(reportRetry.outcomes[0]?.recoveryMatched).toBe(false);
    expect(reportRetry.exactReproductionClaimed).toBe(false);

    // Tamper aggregate status.
    const tamperedStatus = structuredClone(record);
    tamperedStatus.experiments[0]!.result.recovery!.status = 'passed';
    const reportStatus = await replayRun(tamperedStatus, runsDir);
    expect(reportStatus.outcomes[0]?.recoveryMatched).toBe(false);
    expect(reportStatus.exactReproductionClaimed).toBe(false);

    // Direct compareSemanticReplay: recovery present on only one side cannot match.
    const expResult = record.experiments[0]!.result;
    const strippedResult = { ...structuredClone(expResult), recovery: undefined };
    const cmp = compareSemanticReplay(expResult, strippedResult);
    expect(cmp.recoveryMatched).toBe(false);
    expect(cmp.matched).toBe(false);
    expect(cmp.mismatches.some((m) => /recovery evidence/i.test(m))).toBe(true);
    const cmpReverse = compareSemanticReplay(strippedResult, expResult);
    expect(cmpReverse.recoveryMatched).toBe(false);
    expect(cmpReverse.matched).toBe(false);
  });

  it('reports recovery-evaluator drift and blocks exact reproduction when recorded evaluator hash or version differs', async () => {
    const record = await recoveryRecord('recovery-candidate-a');
    const drifted = structuredClone(record);
    drifted.experiments[0]!.result.recovery!.evaluator = {
      id: 'recovery-oracle-v1',
      version: 1,
      hash: 'e'.repeat(64),
    };
    await saveRun(drifted, runsDir);

    const report = await replayRun(drifted.id, runsDir);
    expect(findCheck(report, 'recovery-evaluator')?.status).toBe('drifted');
    expect(report.contextStatus).toBe('drifted');
    expect(report.exactReproductionClaimed).toBe(false);
    expect(report.outcomes[0]?.recoveryMatched).toBe(false);

    const single = await replaySelectedExperiment(drifted.id, 0, runsDir);
    expect(findCheck(single, 'recovery-evaluator')?.status).toBe('drifted');
    expect(single.exactReproductionClaimed).toBe(false);
  });

  it('reports recovery-evaluator as unknown and blocks exact reproduction when recorded recovery evidence or evaluator identity is missing', async () => {
    const record = await recoveryRecord('recovery-candidate-a');
    const missingRecovery = structuredClone(record);
    delete missingRecovery.experiments[0]!.result.recovery;
    await saveRun(missingRecovery, runsDir);

    const report = await replayRun(missingRecovery.id, runsDir);
    expect(findCheck(report, 'recovery-evaluator')?.status).toBe('unknown');
    expect(report.exactReproductionClaimed).toBe(false);
    expect(report.outcomes[0]?.recoveryMatched).toBe(false);

    const single = await replaySelectedExperiment(missingRecovery.id, 0, runsDir);
    expect(findCheck(single, 'recovery-evaluator')?.status).toBe('unknown');
    expect(single.exactReproductionClaimed).toBe(false);
  });

  it('preserves exact replay for non-recovery records that do not include recovery evidence', async () => {
    const tradingSnapshot = await createSystemSnapshot(structuredClone(SEEDED_TRADING_BRIEF));
    const tradingRun = await runInvestigation({
      variant: 'candidate-a',
      systemBrief: tradingSnapshot,
      provider: new MockProvider(),
      maxExperiments: 1,
    });
    expect(tradingRun.experiments[0]?.result.recovery).toBeUndefined();

    const report = await replayRun(tradingRun, runsDir);
    expect(report.exactReproductionClaimed).toBe(true);
    // Legacy/non-recovery results keep prior semantics: recoveryMatched is
    // not invented when neither side carries recovery evidence.
    expect(report.outcomes[0]?.recoveryMatched).toBeUndefined();
    expect(report.outcomes[0]?.exactMatched).toBe(true);
    expect(findCheck(report, 'recovery-evaluator')).toBeUndefined();
    const cmp = compareSemanticReplay(
      tradingRun.experiments[0]!.result,
      tradingRun.experiments[0]!.result,
    );
    expect(cmp.recoveryMatched).toBeUndefined();
    expect(cmp.matched).toBe(true);
  });
});
