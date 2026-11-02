import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type * as http from 'node:http';
import type { Experiment, InvestigationRecord, ProviderContext } from '../src/domain.ts';
import { ChaosPilotServer } from '../src/server.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { buildCoveragePlan, projectCoverage } from '../src/coverage/index.ts';
import { coveragePreparation, recordScenarioChecks } from '../src/investigation/coverage-evidence.ts';
import { recoveryProposal } from '../src/providers/recovery-mock.ts';
import { runInvestigation } from '../src/investigation/index.ts';
import { SEEDED_RECOVERY_BRIEF, SEEDED_TRADING_BRIEF, createSystemSnapshot } from '../src/systems/index.ts';
import { resolveAdapter } from '../src/adapters/index.ts';
import { getSourceBundle } from '../src/recovery/index.ts';
import * as recovery from '../src/recovery/index.ts';
import type { ExecutionReportPayload } from '../src/simulator/types.ts';
import { listRuns, replayRun, replaySelectedExperiment } from '../src/storage.ts';

let runsDir: string;
let instance: ChaosPilotServer;
let listener: (...args: unknown[]) => void;
let providerCalls: number;
let contexts: ProviderContext[];
let firstPublished: InvestigationRecord | null;

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chaospilot-coverage-integration-'));
  providerCalls = 0; contexts = []; firstPublished = null;
  instance = new ChaosPilotServer({ runsDir, providerFactory: () => {
    providerCalls++;
    const mock = new MockProvider();
    return { kind: mock.kind, model: mock.model, async propose(context, signal, audit) {
      contexts.push(structuredClone(context));
      firstPublished ??= structuredClone(instance.getActiveInvestigation()!.record);
      return mock.propose(context, signal, audit);
    } };
  } });
  listener = instance.createHttpServer().listeners('request')[0] as typeof listener;
});
afterEach(async () => { await fs.rm(runsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload)] : []) as any;
  Object.assign(req, { method, url, headers: { host: '127.0.0.1', 'content-type': 'application/json' }, socket: { localPort: 80 } });
  let status = 0, text = '';
  await new Promise<void>(resolve => {
    const res = { writeHead(code: number) { status = code; return res; }, end(chunk?: unknown) { if (chunk) text += String(chunk); resolve(); return res; } };
    listener(req, res as unknown as http.ServerResponse);
  });
  return { status, json: text ? JSON.parse(text) : null };
}
async function prepare(variant = 'recovery-candidate-a') {
  const response = await call('POST', '/api/coverage/prepare', { systemId: 'trading-recovery', expectedRevision: 1, adapterId: 'synthetic-trading-recovery', variant });
  expect(response.status).toBe(200);
  const snapshot = (await call('GET', '/api/systems/trading-recovery/snapshot')).json;
  const preparation = coveragePreparation(snapshot, variant as any, response.json.context.sourceHash);
  const plan = buildCoveragePlan({ preparation, intentions: response.json.suggestions.map((s: any) => ({ scenarioId: s.scenarioId, links: s.links, reviewed: true })) }).plan!;
  expect(plan).toBeDefined();
  return { response, preparation, plan, snapshot };
}
async function start(variant = 'recovery-candidate-a', continueAfterFindings = false) {
  const prepared = await prepare(variant);
  const launched = await call('POST', '/api/investigation/start', { systemId: 'trading-recovery', expectedRevision: 1, variant, provider: 'mock', maxExperiments: 2, coveragePlan: prepared.plan, continueAfterFindings });
  expect(launched.status).toBe(202);
  expect(launched.json.coveragePlan).toEqual(prepared.plan);
  await vi.waitFor(async () => {
    expect(instance.getActiveInvestigation()).toBeNull();
    expect((await listRuns(runsDir)).some(r => r.id === launched.json.id)).toBe(true);
  }, { timeout: 15000 });
  const record = (await call('GET', `/api/runs/${launched.json.id}`)).json as InvestigationRecord;
  return { ...prepared, launched, record };
}
function project(record: InvestigationRecord) {
  return projectCoverage({ runId: record.id, plan: record.coveragePlan,
    preparation: coveragePreparation(record.systemBrief!, record.variant, record.sourceHash),
    experiments: record.experiments.map(e => ({ index: e.index, valid: e.result.valid, executionComplete: e.result.executionComplete,
      sourceHash: e.result.sourceHash, trace: e.result.trace, checks: e.result.scenarioCheckEvidence ?? [] })),
    findings: record.findings.map(f => ({ id: f.id, experimentIndex: f.experimentIndex, sourceHash: f.sourceHash, violationId: f.violation.id,
      invariant: f.violation.invariant, reproduced: f.reproduced, cleanControlPassed: f.cleanControlPassed })), stop: { status: record.status, reason: record.stopReason } });
}

describe('Pinned coverage across preparation, execution, publication and replay', () => {
  it('prepares real saved hashes and public mappings without a provider', async () => {
    const { response, preparation } = await prepare();
    expect(response.json.context).toEqual(preparation.context);
    expect(response.json.suggestions.map((s: any) => s.scenarioId)).toEqual(['recovery-by-deadline', 'recovery-retry-idempotence']);
    expect(providerCalls).toBe(0);
    expect(instance.getActiveInvestigation()).toBeNull();
    expect(await listRuns(runsDir)).toEqual([]);
    expect((await call('POST', '/api/coverage/prepare', { systemId: 'trading-recovery', expectedRevision: 99, adapterId: 'synthetic-trading-recovery', variant: 'clean' })).status).toBe(409);
    expect((await call('POST', '/api/coverage/prepare', { systemId: 'trading-recovery', expectedRevision: 1, adapterId: 'synthetic-trading', variant: 'clean' })).status).toBe(400);
  });

  it('rejects forged context, stale revision, unreviewed goals and unknown evaluators before model construction', async () => {
    const { plan } = await prepare();
    const mutations = [
      (p: any) => { p.context.sourceHash = 'forged'; }, (p: any) => { p.context.variant = 'clean'; },
      (p: any) => { p.context.revision = 99; }, (p: any) => { p.context.contractHash = 'forged'; },
      (p: any) => { p.evaluator.version++; }, (p: any) => { p.intentions[0].reviewed = false; },
    ];
    for (const mutate of mutations) {
      const bad = structuredClone(plan); mutate(bad);
      expect((await call('POST', '/api/investigation/start', { systemId: 'trading-recovery', expectedRevision: 1, variant: 'recovery-candidate-a', coveragePlan: bad })).status).toBe(400);
    }
    expect((await call('POST', '/api/investigation/start', { systemId: 'trading-recovery', expectedRevision: 99, variant: 'recovery-candidate-a', coveragePlan: plan })).status).toBe(409);
    expect(providerCalls).toBe(0);
    expect(await listRuns(runsDir)).toEqual([]);
  });

  it('pins the plan before first inference and records a real confirmed deadline failure while retry stays planned', async () => {
    const { record, plan } = await start();
    expect(firstPublished?.coveragePlan).toEqual(plan);
    expect(firstPublished?.experiments).toEqual([]);
    expect(record.coveragePlan).toEqual(plan);
    expect(record.findings).toHaveLength(1);
    const rows = project(record).rows;
    expect(rows.find(r => r.scenarioId === 'recovery-by-deadline')?.status).toBe('confirmed');
    expect(rows.find(r => r.scenarioId === 'recovery-retry-idempotence')?.status).toBe('planned');
    const check = record.experiments[0]!.result.scenarioCheckEvidence![0]!;
    expect(check.violationId).toBe(record.findings[0]!.violation.id);
    expect(check.facts).toMatchObject({ acceptedAtTick: 0, reconnectTick: 0, deadlineTick: 5, horizonTick: 5,
      expected: { applicationCount: 1, filledQuantity: 4, usedCredit: 400 }, observed: { applicationCount: 0, filledQuantity: 0, usedCredit: 0 } });
    expect(check.traceRefs.some(r => r.tick === 5)).toBe(true);
  });

  it('clean execution positively exercises deadline and retry with actual completion and delivery trace refs', async () => {
    const { record } = await start('clean');
    expect(record.findings).toEqual([]);
    const projection = project(record);
    expect(projection.rows.filter(r => r.scenarioId !== null).map(r => r.status)).toEqual(['exercised', 'exercised']);
    const check = record.experiments[0]!.result.scenarioCheckEvidence![0]!;
    expect(check.facts).toMatchObject({ completionTick: 1, horizonTick: 1, deadlineTick: 5 });
    expect(check.traceRefs.some(r => r.tick === 1)).toBe(true);
  });

  it('exposes public goals on every provider request without private plan or history context', async () => {
    await start('recovery-candidate-a', true);
    expect(contexts).toHaveLength(2);
    for (const context of contexts) {
      expect(context.reviewedScenarios?.map(s => s.scenarioId)).toEqual(['recovery-by-deadline', 'recovery-retry-idempotence']);
      expect(JSON.stringify(context)).not.toContain('recovery-candidate-a');
      expect(context).not.toHaveProperty('coveragePlan');
      expect(context.history.every(h => h.result.scenarioCheckEvidence === undefined)).toBe(true);
    }
  });

  it.each(['clean', 'recovery-candidate-a'] as const)('binds distinct acceptance, reconnect and check ticks for %s coverage and replay', async variant => {
    const { plan, snapshot } = await prepare(variant);
    const experiment = recoveryProposal(0)!;
    const fillAt = experiment.steps.findIndex(s => s.op === 'fill');
    experiment.steps.splice(fillAt, 0, { op: 'advance', ticks: 2 });
    const reconnectAt = experiment.steps.findIndex(s => s.op === 'reconnect');
    experiment.steps.splice(reconnectAt, 0, { op: 'advance', ticks: 1 });
    const record = await runInvestigation({ variant, systemBrief: snapshot, coveragePlan: plan, maxExperiments: 1,
      provider: { kind: 'mock', model: 'distinct-ticks', async propose() { return { experiment, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } }; } } });
    const row = project(record).rows.find(r => r.scenarioId === 'recovery-by-deadline')!;
    expect(row.status).toBe(variant === 'clean' ? 'exercised' : 'confirmed');
    const result = record.experiments[0]!.result;
    const check = result.scenarioCheckEvidence!.find(c => c.scenarioId === 'recovery-by-deadline')!;
    expect(check.facts).toMatchObject({ acceptedAtTick: 2, reconnectTick: 3, deadlineTick: 8 });
    expect(check.traceRefs.some(ref => ref.tick === 3 && result.trace[ref.traceIndex]?.action === 'connection:reconnect')).toBe(true);
    expect((await replayRun(record, runsDir)).exactReproductionClaimed).toBe(true);
    expect((await replaySelectedExperiment(record, 0, runsDir)).exactReproductionClaimed).toBe(true);
  });

  it('reopening is read-only and whole/selected replay rebuild pinned checks; tampering and evaluator drift cannot claim exactness', async () => {
    const { record } = await start();
    const requests = contexts.length;
    await call('GET', '/api/runs'); await call('GET', `/api/runs/${record.id}`);
    expect(contexts).toHaveLength(requests);
    for (const suffix of ['/replay', '/experiments/0/replay']) {
      const replay = await call('POST', `/api/runs/${record.id}${suffix}`);
      expect(replay.status).toBe(200);
      expect(replay.json.exactReproductionClaimed).toBe(true);
      expect(replay.json.outcomes[0].scenarioChecksMatched).toBe(true);
      expect(replay.json.outcomes[0].replayedResult.scenarioCheckEvidence).toEqual(record.experiments[0]!.result.scenarioCheckEvidence);
    }
    const tampered = structuredClone(record);
    tampered.experiments[0]!.result.scenarioCheckEvidence![0]!.outcome = 'passed';
    expect((await replayRun(tampered, runsDir)).exactReproductionClaimed).toBe(false);
    const drifted = structuredClone(record); drifted.coveragePlan!.evaluator.version++;
    expect((await replaySelectedExperiment(drifted, 0, runsDir)).exactReproductionClaimed).toBe(false);
  });

  it('cancellation preserves the reviewed plan with unexercised goals before any request', async () => {
    const snapshot = await createSystemSnapshot(structuredClone(SEEDED_RECOVERY_BRIEF));
    const preparation = coveragePreparation(snapshot, 'clean', getSourceBundle('clean').hash);
    const { plan } = buildCoveragePlan({ preparation, intentions: [{ scenarioId: 'recovery-by-deadline', reviewed: true, links: [{ kind: 'contract-rule', ruleId: 'recovery_deadline' }] }] });
    const controller = new AbortController(); controller.abort();
    const record = await runInvestigation({ variant: 'clean', provider: new MockProvider(), systemBrief: snapshot, coveragePlan: plan, signal: controller.signal });
    expect(record.status).toBe('cancelled'); expect(record.coveragePlan).toEqual(plan);
    expect(record.experiments).toEqual([]);
    expect(project(record).rows.find(r => r.scenarioId === 'recovery-by-deadline')?.status).toBe('planned');
  });

  it('records genuine reviewed credit deliveries and rebuilds them on exact legacy-adapter replay', async () => {
    const brief = structuredClone(SEEDED_TRADING_BRIEF);
    const requirement = brief.requirements[2]!;
    brief.requirementRules = [{ requirement, preset: 'accepted-order-credit-limit', reviewed: true }];
    const snapshot = await createSystemSnapshot(brief);
    const preparation = coveragePreparation(snapshot, 'clean', resolveAdapter('synthetic-trading').getSourceBundle('clean').hash);
    const { plan } = buildCoveragePlan({ preparation, intentions: [{ scenarioId: 'accepted-order-credit-limit', reviewed: true, links: [{ kind: 'requirement-text', text: requirement }] }] });
    const record = await runInvestigation({ variant: 'clean', provider: new MockProvider(), systemBrief: snapshot, coveragePlan: plan, maxExperiments: 1 });
    const checks = record.experiments[0]!.result.scenarioCheckEvidence!;
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every(c => c.facts.kind === 'credit-admission' && c.experimentIndex === 1)).toBe(true);
    expect(project(record).rows.find(r => r.scenarioId === 'accepted-order-credit-limit')?.status).toBe('exercised');
    const replay = await replayRun(record, runsDir);
    expect(replay.exactReproductionClaimed).toBe(true);
    expect(replay.outcomes[0]!.scenarioChecksMatched).toBe(true);
  });

  it.each(['advance', 'drain'] as const)('keeps confirmed deadline coverage and exact replay when %s jumps beyond the deadline', async clock => {
    const { plan, snapshot } = await prepare();
    const experiment = recoveryProposal(0)!;
    experiment.steps.splice(-1, 1, ...(clock === 'advance' ? [{ op: 'advance', ticks: 10 } as const] : [
      { op: 'send', id: 'later-credit', to: 'credit', delay: 10, payload: { type: 'credit_limit', id: 'c2', version: 2, limit: 2000 } } as const,
      { op: 'drain' } as const,
    ]));
    const record = await runInvestigation({ variant: 'recovery-candidate-a', systemBrief: snapshot, coveragePlan: plan, maxExperiments: 1,
      provider: { kind: 'mock', model: 'test', async propose() { return { experiment, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } }; } } });
    expect(project(record).rows.find(r => r.scenarioId === 'recovery-by-deadline')?.status).toBe('confirmed');
    const result = record.experiments[0]!.result;
    const ob = result.recovery!.obligations[0]!;
    expect(ob.checkedTick).toBe(5);
    expect(result.trace[ob.checkTraceIndex]).toMatchObject({ time: 5, action: 'recovery:deadline' });
    expect((await replayRun(record, runsDir)).exactReproductionClaimed).toBe(true);
  });

  it.each(['offline', 'before', 'after'] as const)('records a real failed retry %s reconciliation and matches the actual idempotency finding', async phase => {
    const { plan, snapshot } = await prepare();
    const experiment: Experiment = phase === 'after' ? recoveryProposal(0)! : recoveryProposal(1)!;
    if (phase === 'after') experiment.steps.splice(-1, 1, { op: 'advance', ticks: 1 },
      { op: 'duplicate', messageId: 'm-fill-1', id: 'm-fill-dup-1' }, { op: 'deliver', messageId: 'm-fill-dup-1' });
    if (phase === 'offline') experiment.steps.splice(-2);
    // Adversarial target seam: actual raw oracle observations, not hand-written checks.
    const simulator = { ...recovery, executeExperiment(input: Experiment, variant: any) {
      if (variant === 'clean') return recovery.executeExperiment(input, variant);
      const target = recovery.createRecoveryTarget('clean');
      let duplicateAt: number | undefined, report: ExecutionReportPayload | undefined;
      const bad: recovery.RecoveryTarget = { ...target,
        setConnected: target.setConnected.bind(target), nextDueTick: target.nextDueTick.bind(target), runDue: target.runDue.bind(target),
        processMessage(channel, payload, tick) { const response = target.processMessage(channel, payload, tick);
          if (response.duplicate) { duplicateAt = tick; report = response.report; } return response; },
        getSnapshot() { const s = target.getSnapshot(); if (duplicateAt !== undefined && report) {
          const order = s.orders[report.orderId]!; order.filledQuantity += report.quantity; order.remainingQuantity -= report.quantity;
          s.usedCredit += report.quantity * report.price; s.reservedCredit -= report.quantity * report.price;
          s.applications.push({ key: JSON.stringify([report.orderId, report.executionId]), report: { ...report }, tick: duplicateAt });
        } return s; },
      };
      return recovery.executeExperiment(input, variant, bad);
    } };
    const record = await runInvestigation({ variant: 'recovery-candidate-a', systemBrief: snapshot, coveragePlan: plan, maxExperiments: 1, simulator,
      provider: { kind: 'mock', model: 'test', async propose() { return { experiment, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } }; } } });
    const result = record.experiments[0]!.result;
    expect(result.recovery!.retries[0]!.status).toBe('failed');
    const check = result.scenarioCheckEvidence!.find(c => c.scenarioId === 'recovery-retry-idempotence')!;
    expect(check.outcome).toBe('failed');
    expect(check.facts).toMatchObject({ retryCheck: { status: 'failed', before: result.recovery!.retries[0]!.before, after: result.recovery!.retries[0]!.after } });
    expect(record.findings.some(f => f.violation.id === check.violationId && f.violation.invariant === 'execution_idempotency')).toBe(true);
    expect(project(record).rows.find(r => r.scenarioId === 'recovery-retry-idempotence')?.status).toBe('confirmed');
    const withoutFinding = structuredClone(record); withoutFinding.findings = [];
    expect(project(withoutFinding).rows.find(r => r.scenarioId === 'recovery-retry-idempotence')?.status).toBe('failed-unconfirmed');
    expect((await replayRun(record, runsDir, simulator)).exactReproductionClaimed).toBe(true);
  });

  it('credits connected retries from genuine recorded coverage and confirms a connected double application', async () => {
    const connectedExperiment = (): Experiment => {
      const experiment = recoveryProposal(1)!;
      experiment.steps = experiment.steps.filter(s => s.op !== 'disconnect' && s.op !== 'reconnect' && s.op !== 'advance');
      return experiment;
    };
    const providerFor = (experiment: Experiment) => ({ kind: 'mock' as const, model: 'test',
      async propose() { return { experiment, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } }; } });

    const cleanPrepared = await prepare('clean');
    const cleanRecord = await runInvestigation({ variant: 'clean', systemBrief: cleanPrepared.snapshot,
      coveragePlan: cleanPrepared.plan, maxExperiments: 1, provider: providerFor(connectedExperiment()) });
    const cleanResult = cleanRecord.experiments[0]!.result;
    expect(cleanResult.recovery!.obligations).toEqual([]);
    expect(cleanResult.recovery!.retries[0]).toMatchObject({ status: 'passed',
      expected: { filledQuantity: 4, remainingQuantity: 6, usedCredit: 400, reservedCredit: 600, applicationCount: 1 } });
    const cleanCheck = cleanResult.scenarioCheckEvidence!.find(c => c.scenarioId === 'recovery-retry-idempotence')!;
    expect(cleanCheck.outcome).toBe('passed');
    expect(cleanCheck.facts).toMatchObject({ acceptedDuringDisconnection: false, retryObserved: true,
      retryCheck: { status: 'passed', expected: { applicationCount: 1, filledQuantity: 4 } } });
    expect(cleanCheck.facts).not.toHaveProperty('reconnectTick');
    const cleanRows = project(cleanRecord).rows;
    expect(cleanRows.find(r => r.scenarioId === 'recovery-retry-idempotence')?.status).toBe('exercised');
    expect(cleanRows.find(r => r.scenarioId === 'recovery-by-deadline')?.status).toBe('planned');

    const { plan, snapshot } = await prepare();
    const simulator = { ...recovery, executeExperiment(input: Experiment, variant: any) {
      if (variant === 'clean') return recovery.executeExperiment(input, variant);
      const target = recovery.createRecoveryTarget('clean');
      let duplicateAt: number | undefined, report: ExecutionReportPayload | undefined;
      const bad: recovery.RecoveryTarget = { ...target,
        setConnected: target.setConnected.bind(target), nextDueTick: target.nextDueTick.bind(target), runDue: target.runDue.bind(target),
        processMessage(channel, payload, tick) { const response = target.processMessage(channel, payload, tick);
          if (response.duplicate) { duplicateAt = tick; report = response.report; } return response; },
        getSnapshot() { const s = target.getSnapshot(); if (duplicateAt !== undefined && report) {
          const order = s.orders[report.orderId]!; order.filledQuantity += report.quantity; order.remainingQuantity -= report.quantity;
          s.usedCredit += report.quantity * report.price; s.reservedCredit -= report.quantity * report.price;
          s.applications.push({ key: JSON.stringify([report.orderId, report.executionId]), report: { ...report }, tick: duplicateAt });
        } return s; },
      };
      return recovery.executeExperiment(input, variant, bad);
    } };
    const record = await runInvestigation({ variant: 'recovery-candidate-a', systemBrief: snapshot, coveragePlan: plan,
      maxExperiments: 1, simulator, provider: providerFor(connectedExperiment()) });
    const result = record.experiments[0]!.result;
    expect(result.recovery!.retries[0]!.status).toBe('failed');
    const check = result.scenarioCheckEvidence!.find(c => c.scenarioId === 'recovery-retry-idempotence')!;
    expect(check.outcome).toBe('failed');
    expect(record.findings.some(f => f.violation.id === check.violationId && f.violation.invariant === 'execution_idempotency')).toBe(true);
    expect(project(record).rows.find(r => r.scenarioId === 'recovery-retry-idempotence')?.status).toBe('confirmed');
    const withoutClean = structuredClone(record);
    withoutClean.findings.forEach(f => { f.cleanControlPassed = false; });
    expect(project(withoutClean).rows.find(r => r.scenarioId === 'recovery-retry-idempotence')?.status).toBe('failed-unconfirmed');
    expect((await replayRun(record, runsDir, simulator)).exactReproductionClaimed).toBe(true);
  });

  it('does not derive verified coverage from missing, unknown or malformed raw producer identity/schema', async () => {
    const { plan, snapshot } = await prepare('clean');
    const genuine = recovery.executeExperiment(recoveryProposal(0)!, 'clean');
    recordScenarioChecks(genuine, plan, snapshot, 1);
    expect(genuine.scenarioCheckEvidence!.some(c => c.outcome === 'passed')).toBe(true);
    for (const mutate of [
      (raw: any) => { delete raw.evaluator; }, (raw: any) => { raw.evaluator.version++; },
      (raw: any) => { raw.evaluator = null; }, (raw: any) => { raw.schemaVersion++; },
    ]) {
      const result = recovery.executeExperiment(recoveryProposal(0)!, 'clean'); mutate(result.recovery);
      recordScenarioChecks(result, plan, snapshot, 1);
      expect(result.scenarioCheckEvidence).toEqual([]);
    }
  });
});
