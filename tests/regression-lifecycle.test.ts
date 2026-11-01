import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAdapter, type AdapterRegistration } from '../src/adapters/index.ts';
import type { Experiment, InvestigationRecord } from '../src/domain.ts';
import { canonicalJson, computeContractHash } from '../src/evidence.ts';
import { evidenceHashOf } from '../src/explanations/index.ts';
import {
  FUNCTIONAL_EVALUATOR_ID,
  FUNCTIONAL_EVALUATOR_VERSION,
  getFunctionalEvaluatorIdentity,
  runFunctionalBaselines,
  saveFunctionalRun,
} from '../src/functional/index.ts';
import { runInvestigation } from '../src/investigation/index.ts';
import { getPromptIdentity } from '../src/investigation/prompt.ts';
import { MockProvider } from '../src/providers/mock.ts';
import {
  RegressionConflictError,
  captureRegressionFromFinding,
  checkOriginStatus,
  deriveRegressionExpectations,
  evaluateRegressionExecution,
  getRegressionDefinition,
  getRegressionDefinitionDetail,
  getRegressionEvaluatorIdentity,
  getRegressionRun,
  listRegressionDefinitions,
  listRegressionRuns,
  previewRegressionFromFinding,
  runSavedRegression,
} from '../src/regressions/index.ts';
import { ChaosPilotServer } from '../src/server.ts';
import {
  deleteRun,
  getRun,
  getRunRevision,
  saveRun,
  saveSystemBrief,
  withRunMutation,
} from '../src/storage.ts';
import {
  SEEDED_INVENTORY_BRIEF,
  SEEDED_TRADING_BRIEF,
  createSystemSnapshot,
} from '../src/systems/index.ts';
import { api } from './challenge-fixtures.ts';

const tempDirs: string[] = [];
async function makeTempWorkspace(): Promise<{ runsDir: string; systemsDir: string }> {
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.tmp-regression-lifecycle-'));
  tempDirs.push(dir);
  const runsDir = path.join(dir, 'runs');
  const systemsDir = path.join(dir, 'systems');
  await fs.mkdir(runsDir, { recursive: true });
  await fs.mkdir(systemsDir, { recursive: true });
  await saveSystemBrief(structuredClone(SEEDED_TRADING_BRIEF), systemsDir, { mode: 'create' });
  await saveSystemBrief(structuredClone(SEEDED_INVENTORY_BRIEF), systemsDir, { mode: 'create' });
  return { runsDir, systemsDir };
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function createConfirmedCandidateCRun(
  runsDir: string,
  withPinnedCreditRule = true,
): Promise<InvestigationRecord> {
  const brief = structuredClone(SEEDED_TRADING_BRIEF);
  if (withPinnedCreditRule) {
    brief.requirementRules = [
      {
        requirement:
          'Total commitments include both used and reserved credit. New order admission respects the current limit.',
        preset: 'accepted-order-credit-limit',
        reviewed: true,
      },
    ];
  }
  const systemBrief = await createSystemSnapshot(brief);
  const record = await runInvestigation({
    variant: 'candidate-c',
    systemBrief,
    provider: new MockProvider(),
  });
  expect(record.findings.length).toBeGreaterThan(0);
  await saveRun(record, runsDir);
  return record;
}

describe('Regression lifecycle: capture, positive assertions, and new-source execution', () => {
  it('captures a confirmed candidate-c used-credit finding, fails on candidate-c, passes on clean, and preserves immutable lineage across fresh server instances', async () => {
    const { runsDir, systemsDir } = await makeTempWorkspace();
    const record = await createConfirmedCandidateCRun(runsDir, true);
    const finding = record.findings[0]!;

    // Also save a #8 functional baseline to prove coexistence and unchanged functional evaluator identity
    const baselineRecord = await runFunctionalBaselines({
      variant: 'clean',
      systemSnapshot: record.systemBrief!,
    });
    const baselinePath = await saveFunctionalRun(baselineRecord, runsDir);
    const baselineBytesBefore = await fs.readFile(baselinePath, 'utf8');
    const origRunPath = path.join(runsDir, `${record.id}.json`);
    const origRunBytesBefore = await fs.readFile(origRunPath, 'utf8');

    const funcEvalIdentity = getFunctionalEvaluatorIdentity();
    expect(funcEvalIdentity.id).toBe(FUNCTIONAL_EVALUATOR_ID);
    expect(funcEvalIdentity.version).toBe(FUNCTIONAL_EVALUATOR_VERSION);
    expect(getRegressionEvaluatorIdentity().id).toBe('regression-evaluator');

    const server1 = new ChaosPilotServer({ runsDir, systemsDir });

    // 1. Preview via HTTP
    const previewRes = await api(server1, 'POST', '/api/regressions/preview', {
      runId: record.id,
      findingId: finding.id,
    });
    expect(previewRes.status).toBe(200);
    expect(previewRes.json.available).toBe(true);
    expect(previewRes.json.expected.referenceProvenance.kind).toBe('clean-control-reference');
    expect(previewRes.json.expected.referenceProvenance.reviewLabel).toContain(
      'requires engineer review',
    );

    // Verify the second new_order (m-order-2 / ord-2) is proposed as rejected with Insufficient credit, absentOrderIds=['ord-2'], stateUnchangedFromPrevious=true
    const deliveries = previewRes.json.expected.deliveries;
    const secondOrderDelivery = deliveries.find((d: any) => d.targetOrderId === 'ord-2');
    expect(secondOrderDelivery).toBeDefined();
    expect(secondOrderDelivery.expectedStatus).toBe('rejected');
    expect(secondOrderDelivery.expectedReason).toBe('Insufficient credit limit');
    expect(secondOrderDelivery.expectedState.usedCredit).toBe(100);
    expect(secondOrderDelivery.expectedState.reservedCredit).toBe(0);
    expect(secondOrderDelivery.expectedState.absentOrderIds).toContain('ord-2');
    expect(secondOrderDelivery.expectedState.stateUnchangedFromPrevious).toBe(true);

    // 2. Save reviewed definition via HTTP
    const saveRes = await api(server1, 'POST', '/api/regressions/definitions', {
      runId: record.id,
      findingId: finding.id,
      expectedRunRevision: previewRes.json.runRevision,
      expectedEvidenceHash: previewRes.json.evidenceHash,
      reviewToken: previewRes.json.reviewToken,
      definitionId: previewRes.json.definitionId,
      contentHash: previewRes.json.contentHash,
      reviewed: true,
    });
    expect(saveRes.status).toBe(201);
    const definitionId = saveRes.json.id as string;
    expect(definitionId).toBe(previewRes.json.definitionId);

    // 3. Execute against original faulty target (candidate-c) -> FAIL
    const failRunRes = await api(server1, 'POST', '/api/regressions/run', {
      definitionId,
      variant: 'candidate-c',
      systemId: 'trading-gateway',
      expectedRevision: 1,
    });
    expect(failRunRes.status).toBe(201);
    expect(failRunRes.json.status).toBe('fail');
    expect(failRunRes.json.variant).toBe('candidate-c');
    expect(failRunRes.json.sourceHash).toBe(
      resolveAdapter('synthetic-trading').getSourceBundle('candidate-c').hash,
    );
    expect(failRunRes.json.expectedSourceHash).toBe(failRunRes.json.sourceHash);
    expect(failRunRes.json.origin.sourceHash).toBe(record.sourceHash);

    const failAssertions = failRunRes.json.evaluation.assertions as any[];
    expect(
      failAssertions.some(a => a.id.endsWith('.decision') && a.status === 'fail'),
    ).toBe(true);
    expect(
      failAssertions.some(a => a.id.endsWith('.credit-quote') && a.status === 'fail'),
    ).toBe(true);
    expect(
      failAssertions.some(a => a.id.endsWith('.orders') && a.status === 'fail'),
    ).toBe(true);
    expect(
      failAssertions.some(a => a.id.endsWith('.state-unchanged') && a.status === 'fail'),
    ).toBe(true);
    expect(
      failAssertions.some(
        a => a.id === 'requirements.accepted-order-credit-limit' && a.status === 'fail',
      ),
    ).toBe(true);
    expect(
      failAssertions.some(a => a.id === 'oracle.violations' && a.status === 'fail'),
    ).toBe(true);

    // 4. Execute against corrected/clean comparison target (clean) -> PASS with distinct executing source
    const passRunRes = await api(server1, 'POST', '/api/regressions/run', {
      definitionId,
      variant: 'clean',
      systemId: 'trading-gateway',
      expectedRevision: 1,
    });
    expect(passRunRes.status).toBe(201);
    expect(passRunRes.json.status).toBe('pass');
    expect(passRunRes.json.variant).toBe('clean');
    const cleanSourceHash = resolveAdapter('synthetic-trading').getSourceBundle('clean').hash;
    expect(passRunRes.json.sourceHash).toBe(cleanSourceHash);
    expect(passRunRes.json.expectedSourceHash).toBe(cleanSourceHash);
    // Lineage still points to original candidate-c sourceHash
    expect(passRunRes.json.origin.sourceHash).toBe(record.sourceHash);
    expect(passRunRes.json.origin.sourceHash).not.toBe(passRunRes.json.sourceHash);
    expect(passRunRes.json.summary.failedAssertions).toBe(0);
    expect(passRunRes.json.summary.passedAssertions).toBe(
      passRunRes.json.summary.totalAssertions,
    );

    // 5. Reopen from a fresh server instance and verify zero mutation of original artifacts
    const server2 = new ChaosPilotServer({ runsDir, systemsDir });
    const listDefsRes = await api(server2, 'GET', '/api/regressions/definitions');
    expect(listDefsRes.status).toBe(200);
    expect(listDefsRes.json).toHaveLength(1);
    expect(listDefsRes.json[0].id).toBe(definitionId);
    expect(listDefsRes.json[0].runCount).toBe(2);
    expect(listDefsRes.json[0].originStatus.available).toBe(true);
    expect(listDefsRes.json[0].originStatus.status).toBe('verified');

    const detailRes = await api(
      server2,
      'GET',
      `/api/regressions/definitions/${definitionId}`,
    );
    expect(detailRes.status).toBe(200);
    expect(detailRes.json.definition.id).toBe(definitionId);
    expect(detailRes.json.runs).toHaveLength(2);

    const getFailRun = await api(
      server2,
      'GET',
      `/api/regressions/runs/${failRunRes.json.id}`,
    );
    const getPassRun = await api(
      server2,
      'GET',
      `/api/regressions/runs/${passRunRes.json.id}`,
    );
    expect(getFailRun.status).toBe(200);
    expect(getFailRun.json.status).toBe('fail');
    expect(getPassRun.status).toBe(200);
    expect(getPassRun.json.status).toBe('pass');

    // Original investigation run and #8 functional baseline are byte-for-byte untouched
    expect(await fs.readFile(origRunPath, 'utf8')).toBe(origRunBytesBefore);
    expect(await fs.readFile(baselinePath, 'utf8')).toBe(baselineBytesBefore);
  });

  it('supports a non-fixture sequence with delayed reordering and drain on candidate-b', async () => {
    const { runsDir, systemsDir } = await makeTempWorkspace();
    const tradingAdapter = resolveAdapter('synthetic-trading');
    const drainReorderingExperiment: Experiment = {
      hypothesis: 'Delayed fill drained after cancel ack over-releases reserved credit on candidate-b',
      expectedInvariant: 'credit_non_negative',
      steps: [
        { op: 'send', id: 'q', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 10 } },
        { op: 'send', id: 'c', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 1000 } },
        { op: 'drain' },
        { op: 'send', id: 'o1', to: 'client', payload: { type: 'new_order', id: 'm-o1', orderId: 'ord-1', quantity: 10, quoteId: 'q1' } },
        { op: 'deliver', messageId: 'o1' },
        { op: 'fill', messageId: 'rep-fill-delayed', orderId: 'ord-1', executionId: 'exec-1', quantity: 4, delay: 5 },
        { op: 'confirm_cancel', messageId: 'rep-cancel-early', orderId: 'ord-1', delay: 0 },
        { op: 'drain' },
      ],
    };

    const faultyResult = tradingAdapter.executeExperiment(
      structuredClone(drainReorderingExperiment),
      'candidate-b',
    );
    const cleanResult = tradingAdapter.executeExperiment(
      structuredClone(drainReorderingExperiment),
      'clean',
    );
    expect(faultyResult.violations.length).toBeGreaterThan(0);
    expect(cleanResult.violations).toHaveLength(0);

    const systemBrief = await createSystemSnapshot(structuredClone(SEEDED_TRADING_BRIEF));
    // Place the experiment at array position 1 with experimentIndex 7 and a different finding.replay
    // to prove resolveExperimentPositionForIndex is used rather than array index or finding.replay!
    const dummyExp: Experiment = {
      hypothesis: 'unrelated step',
      expectedInvariant: 'credit_non_negative',
      steps: [{ op: 'drain' }],
    };
    const dummyRes = tradingAdapter.executeExperiment(dummyExp, 'candidate-b');

    const record: InvestigationRecord = {
      schemaVersion: 1,
      id: 'run_drain_reordering_b',
      provider: 'mock',
      model: 'mock-1',
      mode: 'mock',
      variant: 'candidate-b',
      status: 'completed',
      startedAt: '2026-10-31T10:00:00.000Z',
      finishedAt: '2026-10-31T10:00:05.000Z',
      sourceHash: faultyResult.sourceHash,
      experiments: [
        {
          index: 1,
          experiment: dummyExp,
          result: dummyRes,
          replayVerified: true,
          cleanControlPassed: true,
        },
        {
          index: 7,
          experiment: drainReorderingExperiment,
          result: faultyResult,
          replayVerified: true,
          cleanControlPassed: true,
        },
      ],
      findings: [
        {
          id: 'finding-drain-b',
          title: 'Negative reserved credit after drain reordering',
          hypothesis: drainReorderingExperiment.hypothesis,
          experimentIndex: 7,
          category: faultyResult.violations[0]!.category,
          violation: faultyResult.violations[0]!,
          sourceHash: faultyResult.sourceHash,
          reproduced: true,
          cleanControlPassed: true,
          replay: drainReorderingExperiment,
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      errors: [],
      contextAudit: {
        adapterId: 'synthetic-trading',
        variant: 'candidate-b',
        cleanSourceHash: cleanResult.sourceHash,
        sourcePaths: [],
        contractHash: computeContractHash(tradingAdapter.getContract()),
        ...getPromptIdentity('synthetic-trading'),
      },
      systemBrief,
    };
    await saveRun(record, runsDir);

    const preview = await previewRegressionFromFinding(record.id, 'finding-drain-b', {
      runsDir,
    });
    expect(preview.available).toBe(true);
    if (!preview.available) throw new Error('Expected available preview');

    expect(preview.origin.experimentIndex).toBe(7);
    expect(preview.origin.experimentPosition).toBe(1);
    expect(canonicalJson(preview.experiment)).toBe(canonicalJson(drainReorderingExperiment));
    // Verify drain:deliver bindings were captured
    expect(
      preview.expected.traceBindings.filter(b => b.action === 'drain:deliver').length,
    ).toBe(4);

    const def = await captureRegressionFromFinding(
      {
        runId: record.id,
        findingId: 'finding-drain-b',
        expectedRunRevision: preview.runRevision,
        expectedEvidenceHash: preview.evidenceHash,
        reviewToken: preview.reviewToken,
        definitionId: preview.definitionId,
        contentHash: preview.contentHash,
        reviewed: true,
      },
      { runsDir },
    );

    const failRun = await runSavedRegression(
      { definitionId: def.id, variant: 'candidate-b' },
      { runsDir },
    );
    expect(failRun.status).toBe('fail');

    const passRun = await runSavedRegression(
      { definitionId: def.id, variant: 'clean' },
      { runsDir },
    );
    expect(passRun.status).toBe('pass');
  });

  it('rejects unconfirmed, legacy, ambiguous, drifted, stale-preview, missing-consent, and race-modified captures', async () => {
    const { runsDir, systemsDir } = await makeTempWorkspace();
    const baseRecord = await createConfirmedCandidateCRun(runsDir, true);
    const findingId = baseRecord.findings[0]!.id;

    // 1. Running (non-terminal) run rejected with 409
    const runningRecord = structuredClone(baseRecord);
    runningRecord.id = 'run_still_running';
    runningRecord.status = 'running';
    await saveRun(runningRecord, runsDir);
    await expect(
      previewRegressionFromFinding(runningRecord.id, findingId, { runsDir }),
    ).rejects.toThrow(RegressionConflictError);

    // 2. Unconfirmed finding (reproduced: false or cleanControlPassed: false) returns available: false
    const unconfirmedRecord = structuredClone(baseRecord);
    unconfirmedRecord.id = 'run_unconfirmed';
    unconfirmedRecord.findings[0]!.reproduced = false;
    await saveRun(unconfirmedRecord, runsDir);
    const unconfirmedPreview = await previewRegressionFromFinding(
      unconfirmedRecord.id,
      findingId,
      { runsDir },
    );
    expect(unconfirmedPreview.available).toBe(false);
    if (!unconfirmedPreview.available) {
      expect(unconfirmedPreview.reason).toContain('confirmed finding');
    }

    // 3. Legacy run without systemBrief returns available: false
    const legacyRecord = structuredClone(baseRecord);
    legacyRecord.id = 'run_legacy_no_brief';
    delete legacyRecord.systemBrief;
    await saveRun(legacyRecord, runsDir);
    const legacyPreview = await previewRegressionFromFinding(legacyRecord.id, findingId, {
      runsDir,
    });
    expect(legacyPreview.available).toBe(false);
    if (!legacyPreview.available) {
      expect(legacyPreview.reason).toContain('pinned system brief');
    }

    // 4. Ambiguous duplicate findingId or ambiguous experimentIndex returns available: false
    const ambiguousRecord = structuredClone(baseRecord);
    ambiguousRecord.id = 'run_ambiguous_finding';
    ambiguousRecord.findings.push(structuredClone(ambiguousRecord.findings[0]!));
    await saveRun(ambiguousRecord, runsDir);
    const ambPreview = await previewRegressionFromFinding(ambiguousRecord.id, findingId, {
      runsDir,
    });
    expect(ambPreview.available).toBe(false);
    if (!ambPreview.available) {
      expect(ambPreview.reason).toContain('missing or ambiguous');
    }

    const ambExpRecord = structuredClone(baseRecord);
    ambExpRecord.id = 'run_ambiguous_exp';
    ambExpRecord.experiments.push(structuredClone(ambExpRecord.experiments[0]!));
    await saveRun(ambExpRecord, runsDir);
    const ambExpPreview = await previewRegressionFromFinding(
      ambExpRecord.id,
      findingId,
      { runsDir },
    );
    expect(ambExpPreview.available).toBe(false);
    if (!ambExpPreview.available) {
      expect(ambExpPreview.reason).toContain('uniquely verified');
    }

    // 5. Unsupported adapter (inventory-reservation) returns available: false with clear reason
    const invBrief = await createSystemSnapshot(structuredClone(SEEDED_INVENTORY_BRIEF));
    const invRecord = await runInvestigation({
      variant: 'inventory-candidate-a',
      systemBrief: invBrief,
      provider: new MockProvider(),
    });
    await saveRun(invRecord, runsDir);
    const invPreview = await previewRegressionFromFinding(
      invRecord.id,
      invRecord.findings[0]!.id,
      { runsDir },
    );
    expect(invPreview.available).toBe(false);
    if (!invPreview.available) {
      expect(invPreview.reason).toContain('inventory-reservation');
      expect(invPreview.reason).toContain('only \'synthetic-trading\' is currently supported');
    }

    // 6. Source/context/replay drift returns available: false
    const driftedSourceRecord = structuredClone(baseRecord);
    driftedSourceRecord.id = 'run_drifted_source';
    driftedSourceRecord.contextAudit.cleanSourceHash = '0'.repeat(64);
    await saveRun(driftedSourceRecord, runsDir);
    const driftedPreview = await previewRegressionFromFinding(
      driftedSourceRecord.id,
      findingId,
      { runsDir },
    );
    expect(driftedPreview.available).toBe(false);
    if (!driftedPreview.available) {
      expect(driftedPreview.reason).toContain('clean-source provenance');
    }

    // 7. Review consent & token mismatch rejected
    const server = new ChaosPilotServer({ runsDir, systemsDir });
    const validPreview = await previewRegressionFromFinding(baseRecord.id, findingId, {
      runsDir,
    });
    expect(validPreview.available).toBe(true);
    if (!validPreview.available) throw new Error('Expected available');

    const noConsentRes = await api(server, 'POST', '/api/regressions/definitions', {
      runId: baseRecord.id,
      findingId,
      expectedRunRevision: validPreview.runRevision,
      expectedEvidenceHash: validPreview.evidenceHash,
      reviewToken: validPreview.reviewToken,
      definitionId: validPreview.definitionId,
      reviewed: false,
    });
    expect(noConsentRes.status).toBe(400);
    expect(noConsentRes.json.error).toContain('reviewed: true');

    const badTokenRes = await api(server, 'POST', '/api/regressions/definitions', {
      runId: baseRecord.id,
      findingId,
      expectedRunRevision: validPreview.runRevision,
      expectedEvidenceHash: validPreview.evidenceHash,
      reviewToken: `rev-${'a'.repeat(64)}`,
      definitionId: validPreview.definitionId,
      reviewed: true,
    });
    expect(badTokenRes.status).toBe(400);
    expect(badTokenRes.json.error).toContain('Review token');

    // 8. Capture race under mutation lock: while lock is held, replace the run; queued capture fails with 409
    let releaseLock!: () => void;
    const lockWait = new Promise<void>(r => {
      releaseLock = r;
    });
    let lockAcquired!: () => void;
    const acquiredPromise = new Promise<void>(r => {
      lockAcquired = r;
    });

    const mutatingHolder = withRunMutation(baseRecord.id, runsDir, async () => {
      lockAcquired();
      await lockWait;
      const modified = structuredClone(baseRecord);
      modified.errors = ['mutated while capture queued'];
      const runFile = path.join(runsDir, `${baseRecord.id}.json`);
      await fs.writeFile(runFile, JSON.stringify(modified, null, 2), 'utf8');
    });

    await acquiredPromise;
    const queuedSavePromise = api(server, 'POST', '/api/regressions/definitions', {
      runId: baseRecord.id,
      findingId,
      expectedRunRevision: validPreview.runRevision,
      expectedEvidenceHash: validPreview.evidenceHash,
      reviewToken: validPreview.reviewToken,
      definitionId: validPreview.definitionId,
      reviewed: true,
    });
    releaseLock();
    await mutatingHolder;
    const racedSaveRes = await queuedSavePromise;
    expect(racedSaveRes.status, racedSaveRes.text).toBe(409);
    expect(await getRegressionDefinition(validPreview.definitionId, runsDir)).toBeNull();

    // 9. Stale preview after source run deletion returns 404
    await deleteRun(baseRecord.id, runsDir);
    const deletedSaveRes = await api(server, 'POST', '/api/regressions/definitions', {
      runId: baseRecord.id,
      findingId,
      expectedRunRevision: validPreview.runRevision,
      expectedEvidenceHash: validPreview.evidenceHash,
      reviewToken: validPreview.reviewToken,
      definitionId: validPreview.definitionId,
      reviewed: true,
    });
    expect(deletedSaveRes.status).toBe(404);
  });

  it('exercises positive business assertions: rejects missing trigger/milestone, incomplete/exception/invalid evidence, misbound observations, and configured rule failures/errors', async () => {
    const { runsDir } = await makeTempWorkspace();
    const record = await createConfirmedCandidateCRun(runsDir, true);
    const finding = record.findings[0]!;
    const preview = await previewRegressionFromFinding(record.id, finding.id, { runsDir });
    if (!preview.available) throw new Error('Expected available preview');
    const def = await captureRegressionFromFinding(
      {
        runId: record.id,
        findingId: finding.id,
        expectedRunRevision: preview.runRevision,
        expectedEvidenceHash: preview.evidenceHash,
        reviewToken: preview.reviewToken,
        definitionId: preview.definitionId,
        reviewed: true,
      },
      { runsDir },
    );

    const tradingAdapter = resolveAdapter('synthetic-trading');
    const cleanSourceHash = tradingAdapter.getSourceBundle('clean').hash;
    const cleanExec = tradingAdapter.executeExperiment(
      structuredClone(def.experiment),
      'clean',
    );

    // Baseline check: clean execution passes
    const cleanEval = evaluateRegressionExecution(def, cleanExec, cleanSourceHash, 'clean');
    expect(cleanEval.status).toBe('pass');

    // Case A: No old violation (violations: []), but trigger/milestone state is wrong (e.g. usedCredit was reset to 0 on rejection)
    const wrongCreditNoViolation = structuredClone(cleanExec);
    wrongCreditNoViolation.violations = [];
    const lastTrace = wrongCreditNoViolation.trace.at(-1)!;
    (lastTrace.state as any).usedCredit = 0;
    (wrongCreditNoViolation.snapshot as any).target.usedCredit = 0;
    wrongCreditNoViolation.deliveryObservations!.at(-1)!.usedCredit = 0;
    const evalWrongCredit = evaluateRegressionExecution(
      def,
      wrongCreditNoViolation,
      cleanSourceHash,
      'clean',
    );
    expect(evalWrongCredit.status).toBe('fail');

    // Case B: No old violation (violations: []), but trigger step (last delivery) was never reached
    const truncated = structuredClone(cleanExec);
    truncated.violations = [];
    truncated.trace.pop();
    truncated.deliveryObservations!.pop();
    const evalTruncated = evaluateRegressionExecution(
      def,
      truncated,
      cleanSourceHash,
      'clean',
    );
    expect(evalTruncated.status).toBe('inconclusive');

    // Case C: executionComplete = false is never overwritten and cannot pass
    const incomplete = structuredClone(cleanExec);
    incomplete.executionComplete = false;
    const evalIncomplete = evaluateRegressionExecution(
      def,
      incomplete,
      cleanSourceHash,
      'clean',
    );
    expect(evalIncomplete.status).toBe('inconclusive');
    expect(evalIncomplete.executionComplete).toBe(false);

    // Case D: Target exception observation -> inconclusive
    const exceptionObs = structuredClone(cleanExec);
    exceptionObs.deliveryObservations!.at(-1)!.status = 'exception';
    const evalException = evaluateRegressionExecution(
      def,
      exceptionObs,
      cleanSourceHash,
      'clean',
    );
    expect(evalException.status).toBe('inconclusive');

    // Case E: Harness command rejection -> invalid (distinguished from legitimate business rejection)
    const invalidHarness = structuredClone(cleanExec);
    invalidHarness.valid = false;
    invalidHarness.rejections = [{ step: 3, reason: 'Order not found at venue' }];
    const evalInvalid = evaluateRegressionExecution(
      def,
      invalidHarness,
      cleanSourceHash,
      'clean',
    );
    expect(evalInvalid.status).toBe('invalid');

    // Case F: Wrong executing source hash, wrong action/messageId/traceIndex, duplicate observations -> inconclusive
    const evalWrongSource = evaluateRegressionExecution(
      def,
      cleanExec,
      'deadbeef'.repeat(8),
      'clean',
    );
    expect(evalWrongSource.status).toBe('inconclusive');

    const dupObs = structuredClone(cleanExec);
    dupObs.deliveryObservations!.push(structuredClone(dupObs.deliveryObservations!.at(-1)!));
    const evalDupObs = evaluateRegressionExecution(
      def,
      dupObs,
      cleanSourceHash,
      'clean',
    );
    expect(evalDupObs.status).toBe('inconclusive');

    const misboundMsg = structuredClone(cleanExec);
    misboundMsg.deliveryObservations!.at(-1)!.messageId = 'wrong-msg-id';
    const evalMisbound = evaluateRegressionExecution(
      def,
      misboundMsg,
      cleanSourceHash,
      'clean',
    );
    expect(evalMisbound.status).toBe('inconclusive');

    // Case G: Malformed payload in clean result rejected by deriveRegressionExpectations
    const malformedClean = structuredClone(cleanExec);
    malformedClean.deliveryObservations![0]!.payloadValid = false;
    const derivedMalformed = deriveRegressionExpectations(def.experiment, malformedClean);
    expect(derivedMalformed.ok).toBe(false);
    if (!derivedMalformed.ok) {
      expect(derivedMalformed.reason).toContain('malformed message payload');
    }

    // Case H: Configured requirement rule evaluator unavailable (missing requirementEvaluator on snapshot) -> inconclusive, never dropped into pass
    const defBrokenRuleEvaluator = structuredClone(def);
    delete defBrokenRuleEvaluator.origin.systemSnapshot.requirementEvaluator;
    const evalUnavailableRule = evaluateRegressionExecution(
      defBrokenRuleEvaluator,
      cleanExec,
      cleanSourceHash,
      'clean',
    );
    expect(evalUnavailableRule.status).toBe('inconclusive');
    expect(evalUnavailableRule.requirementEvaluationError).toBeDefined();
    expect(
      evalUnavailableRule.assertions.find(a => a.id === 'requirements.available')?.status,
    ).toBe('inconclusive');
  });

  it('accepts a compatible later target source hash, rejects contract drift, and remains usable after the original brief is edited or the original run is deleted', async () => {
    const { runsDir, systemsDir } = await makeTempWorkspace();
    const record = await createConfirmedCandidateCRun(runsDir, true);
    const finding = record.findings[0]!;
    const preview = await previewRegressionFromFinding(record.id, finding.id, { runsDir });
    if (!preview.available) throw new Error('Expected available');
    const def = await captureRegressionFromFinding(
      {
        runId: record.id,
        findingId: finding.id,
        expectedRunRevision: preview.runRevision,
        expectedEvidenceHash: preview.evidenceHash,
        reviewToken: preview.reviewToken,
        definitionId: preview.definitionId,
        reviewed: true,
      },
      { runsDir },
    );

    // 1. Edit the system brief in systems/ to revision 2 with altered prose
    const editedBrief = structuredClone(SEEDED_TRADING_BRIEF);
    editedBrief.revision = 1;
    editedBrief.overview = 'Edited overview prose in revision 2 that must not alter saved regression definition';
    editedBrief.requirements = ['Updated requirement prose in revision 2'];
    const savedBriefRev2 = await saveSystemBrief(editedBrief, systemsDir, {
      mode: 'update',
      expectedRevision: 1,
    });
    expect(savedBriefRev2.revision).toBe(2);

    // 2. Delete the original investigation run from runs/
    await deleteRun(record.id, runsDir);
    expect(await getRun(record.id, runsDir)).toBeNull();

    // 3. Check definition detail & originStatus: definition still loads from its saved origin copy with originStatus.status === 'deleted'
    const detail = await getRegressionDefinitionDetail(def.id, runsDir);
    expect(detail).not.toBeNull();
    expect(detail!.originStatus.available).toBe(false);
    expect(detail!.originStatus.stale).toBe(true);
    expect(detail!.originStatus.status).toBe('deleted');
    expect(detail!.originStatus.reason).toContain('deleted after capture');
    // Definition's pinned brief revision is still 1, not 2!
    expect(detail!.definition.origin.systemBrief.revision).toBe(1);
    expect(detail!.definition.origin.systemSnapshot.brief.overview).toBe(
      SEEDED_TRADING_BRIEF.overview,
    );

    // 4. Execute against a compatible later source version (e.g. candidate-c fixed in v2 with a new sourceHash)
    const baseAdapter = resolveAdapter('synthetic-trading');
    const fixedLaterSourceHash = 'f'.repeat(64);
    const customResolver = (): AdapterRegistration => ({
      ...baseAdapter,
      getSourceBundle: variant =>
        variant === 'candidate-c'
          ? { hash: fixedLaterSourceHash, files: [{ path: 'fixed.ts', content: '// fixed' }] }
          : baseAdapter.getSourceBundle(variant),
      executeExperiment: (exp, variant) => {
        const res = baseAdapter.executeExperiment(
          exp,
          variant === 'candidate-c' ? 'clean' : variant,
        );
        return {
          ...res,
          sourceHash: variant === 'candidate-c' ? fixedLaterSourceHash : res.sourceHash,
        };
      },
    });

    const serverWithLaterSource = new ChaosPilotServer({
      runsDir,
      systemsDir,
      regressionAdapterResolver: customResolver,
    });
    const laterRunRes = await api(serverWithLaterSource, 'POST', '/api/regressions/run', {
      definitionId: def.id,
      variant: 'candidate-c',
      systemId: 'trading-gateway',
      expectedRevision: 2,
    });
    expect(laterRunRes.status).toBe(201);
    expect(laterRunRes.json.status).toBe('pass');
    expect(laterRunRes.json.sourceHash).toBe(fixedLaterSourceHash);
    expect(laterRunRes.json.expectedSourceHash).toBe(fixedLaterSourceHash);
    // Original lineage sourceHash and revision 1 remain preserved
    expect(laterRunRes.json.origin.sourceHash).toBe(record.sourceHash);
    expect(laterRunRes.json.origin.systemBrief.revision).toBe(1);

    // Historical run loads cleanly on a standard server even though its sourceHash was fixedLaterSourceHash
    const standardServer = new ChaosPilotServer({ runsDir, systemsDir });
    const loadedLaterRun = await api(
      standardServer,
      'GET',
      `/api/regressions/runs/${laterRunRes.json.id}`,
    );
    expect(loadedLaterRun.status).toBe(200);
    expect(loadedLaterRun.json.sourceHash).toBe(fixedLaterSourceHash);
    expect(loadedLaterRun.json.status).toBe('pass');

    // 5. Reject wrong adapter variant (inventory-candidate-a) with 400
    const badVariantRes = await api(standardServer, 'POST', '/api/regressions/run', {
      definitionId: def.id,
      variant: 'inventory-candidate-a',
    });
    expect(badVariantRes.status).toBe(400);

    // 6. Reject drifted adapter contract with 422
    const driftedContractResolver = (): AdapterRegistration => ({
      ...baseAdapter,
      getContract: () => ({
        ...baseAdapter.getContract(),
        description: 'Drifted incompatible contract description',
      }),
    });
    const driftedServer = new ChaosPilotServer({
      runsDir,
      systemsDir,
      regressionAdapterResolver: driftedContractResolver,
    });
    const driftedRunRes = await api(driftedServer, 'POST', '/api/regressions/run', {
      definitionId: def.id,
      variant: 'clean',
    });
    expect(driftedRunRes.status).toBe(422);
    expect(driftedRunRes.json.error).toContain('contract has drifted');
  });
});
