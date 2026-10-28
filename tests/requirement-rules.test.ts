import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type * as http from 'node:http';
import type {
  Experiment,
  ExperimentProvider,
  ExperimentResult,
  ProviderReply,
  SystemBrief,
  SystemBriefSnapshot,
} from '../src/domain.ts';
import {
  SEEDED_TRADING_BRIEF,
  computeSnapshotHash,
  createSystemSnapshot,
  getSystemBrief,
  saveSystemBrief,
  validateSystemBrief,
} from '../src/systems/index.ts';
import { canonicalJson } from '../src/evidence.ts';
import { executeExperiment } from '../src/simulator/executor.ts';
import { getContract, getSourceBundle, parseExperiment } from '../src/simulator/index.ts';
import { evaluateRequirementRules } from '../src/requirements/evaluator.ts';
import { reviewedCreditRule } from '../src/requirements/config.ts';
import { getRequirementEvaluatorIdentity, requirementEvaluatorAvailable } from '../src/requirements/identity.ts';
import { runInvestigation, type SimulatorApi } from '../src/investigation/index.ts';
import { replayRun, replaySelectedExperiment } from '../src/storage.ts';
import { ChaosPilotServer } from '../src/server.ts';
import { MockProvider } from '../src/providers/mock.ts';

const REQ = 'Total commitments include both used and reserved credit. New order admission respects the current limit.';
const OTHER_REQ = 'Quotes are versioned; older versions must not change state.';

function briefWithRules(overrides: Partial<SystemBrief> = {}): SystemBrief {
  return {
    ...structuredClone(SEEDED_TRADING_BRIEF),
    requirements: [REQ, OTHER_REQ],
    requirementRules: [reviewedCreditRule(REQ)],
    ...overrides,
  };
}

async function snapshotWithRules(): Promise<SystemBriefSnapshot> {
  return createSystemSnapshot(briefWithRules());
}

function evaluate(result: ExperimentResult, snapshot: SystemBriefSnapshot) {
  return evaluateRequirementRules(result, snapshot, 1)[0]!;
}

const passingExperiment: Experiment = {
  hypothesis: 'accepted order within limit',
  expectedInvariant: 'credit_limit_respected',
  steps: [
    { op: 'send', id: 'q', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 100 } },
    { op: 'send', id: 'c', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 1500 } },
    { op: 'deliver', messageId: 'q' },
    { op: 'deliver', messageId: 'c' },
    { op: 'send', id: 'o1', to: 'client', payload: { type: 'new_order', id: 'm-o1', orderId: 'ord-1', quantity: 10, quoteId: 'q1' } },
    { op: 'deliver', messageId: 'o1' },
  ],
};

/** candidate-c ignores used credit in admission: order 2 is accepted after a full fill and breaches the limit. */
const failingExperiment: Experiment = {
  hypothesis: 'used credit ignored on second admission',
  expectedInvariant: 'credit_limit_respected',
  steps: [
    { op: 'send', id: 'q', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 100 } },
    { op: 'send', id: 'c', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 1500 } },
    { op: 'deliver', messageId: 'q' },
    { op: 'deliver', messageId: 'c' },
    { op: 'send', id: 'o1', to: 'client', payload: { type: 'new_order', id: 'm-o1', orderId: 'ord-1', quantity: 10, quoteId: 'q1' } },
    { op: 'deliver', messageId: 'o1' },
    { op: 'fill', messageId: 'f1', orderId: 'ord-1', executionId: 'e1', quantity: 10 },
    { op: 'deliver', messageId: 'f1' },
    { op: 'send', id: 'o2', to: 'client', payload: { type: 'new_order', id: 'm-o2', orderId: 'ord-2', quantity: 10, quoteId: 'q1' } },
    { op: 'deliver', messageId: 'o2' },
  ],
};

describe('requirement rule configuration validation', () => {
  it('accepts a reviewed rule bound to unique requirement text', () => {
    const validated = validateSystemBrief(briefWithRules());
    expect(validated.valid).toBe(true);
    if (validated.valid) expect(validated.brief.requirementRules).toEqual([reviewedCreditRule(REQ)]);
  });

  it('rejects unknown fields, unknown presets and unreviewed rules', () => {
    const base = briefWithRules();
    expect(validateSystemBrief({ ...base, requirementRules: [{ requirement: REQ, preset: 'accepted-order-credit-limit', reviewed: true, code: 'x' }] }).valid).toBe(false);
    expect(validateSystemBrief({ ...base, requirementRules: [{ requirement: REQ, preset: 'anything-else', reviewed: true }] }).valid).toBe(false);
    expect(validateSystemBrief({ ...base, requirementRules: [{ requirement: REQ, preset: 'accepted-order-credit-limit', reviewed: false }] }).valid).toBe(false);
  });

  it('rejects rules for the wrong adapter and on adapter switch', () => {
    expect(validateSystemBrief(briefWithRules({ adapterId: 'inventory-reservation' })).valid).toBe(false);
    expect(validateSystemBrief(briefWithRules({ adapterId: 'unconfigured' })).valid).toBe(false);
  });

  it('rejects duplicate, renamed and removed linked requirement text; allows reorder', () => {
    expect(validateSystemBrief(briefWithRules({ requirements: [REQ, REQ] })).valid).toBe(false);
    expect(validateSystemBrief(briefWithRules({ requirements: [`${REQ} (edited)`, OTHER_REQ] })).valid).toBe(false);
    expect(validateSystemBrief(briefWithRules({ requirements: [OTHER_REQ] })).valid).toBe(false);
    expect(validateSystemBrief(briefWithRules({ requirements: [OTHER_REQ, REQ] })).valid).toBe(true);
    // Explicit remap to the renamed text is accepted.
    const renamed = `${REQ} (edited)`;
    expect(validateSystemBrief(briefWithRules({ requirements: [renamed, OTHER_REQ], requirementRules: [reviewedCreditRule(renamed)] })).valid).toBe(true);
  });

  it('rejects two rules for one requirement', () => {
    expect(validateSystemBrief(briefWithRules({ requirementRules: [reviewedCreditRule(REQ), reviewedCreditRule(REQ)] })).valid).toBe(false);
  });

  it('keeps requirementRules absent (not empty) for legacy briefs and preserves their snapshot hash', async () => {
    const legacy: SystemBrief = { ...structuredClone(SEEDED_TRADING_BRIEF) };
    const validated = validateSystemBrief(legacy);
    expect(validated.valid).toBe(true);
    if (validated.valid) expect('requirementRules' in validated.brief).toBe(false);

    const snapshot = await createSystemSnapshot(structuredClone(legacy));
    expect(snapshot.requirementEvaluator).toBeUndefined();
    const historical = crypto.createHash('sha256').update(canonicalJson({ brief: legacy, contract: snapshot.contract }), 'utf8').digest('hex');
    expect(snapshot.hash).toBe(historical);
    expect(snapshot.hash).toBe(computeSnapshotHash(legacy, snapshot.contract));
  });

  it('binds evaluator identity into rule snapshot hashes only', async () => {
    const snapshot = await snapshotWithRules();
    expect(snapshot.requirementEvaluator).toEqual(getRequirementEvaluatorIdentity());
    expect(requirementEvaluatorAvailable(snapshot.requirementEvaluator)).toBe(true);
    expect(snapshot.hash).toBe(computeSnapshotHash(snapshot.brief, snapshot.contract, snapshot.requirementEvaluator));
    expect(snapshot.hash).not.toBe(computeSnapshotHash(snapshot.brief, snapshot.contract));
    const tampered = { ...snapshot.requirementEvaluator!, hash: '0'.repeat(64) };
    expect(computeSnapshotHash(snapshot.brief, snapshot.contract, tampered)).not.toBe(snapshot.hash);
    expect(requirementEvaluatorAvailable(tampered)).toBe(false);
  });

  it('pins a normalized brief that can be launched and replayed', async () => {
    const snapshot = await createSystemSnapshot(briefWithRules({
      name: '  Trading demo  ',
      requirements: [`  ${REQ}  `, OTHER_REQ],
    }));
    expect(snapshot.brief.name).toBe('Trading demo');
    expect(snapshot.brief.requirements[0]).toBe(REQ);
    const record = await runInvestigation({
      variant: 'clean', provider: oneShotProvider(passingExperiment), maxExperiments: 1, systemBrief: snapshot,
    });
    expect(record.experiments[0]!.result.requirementRuleResults?.[0]?.status).toBe('passed');
    expect((await replayRun(record)).exactReproductionClaimed).toBe(true);
  });
});

describe('requirement rule persistence', () => {
  let systemsDir: string;
  beforeEach(async () => { systemsDir = await fs.mkdtemp(path.join(process.cwd(), '.tmp-chaospilot-rules-')); });
  afterEach(async () => { await fs.rm(systemsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  it('saves atomically with the brief, reads back, and enforces revision conflicts', async () => {
    const brief = briefWithRules({ id: 'rule-system', revision: 1 });
    const saved = await saveSystemBrief(brief, systemsDir, { mode: 'create' });
    expect(saved.requirementRules).toEqual([reviewedCreditRule(REQ)]);
    expect((await getSystemBrief('rule-system', systemsDir))?.requirementRules).toEqual([reviewedCreditRule(REQ)]);

    const updated = await saveSystemBrief({ ...saved, name: 'Renamed' }, systemsDir, { mode: 'update', expectedRevision: saved.revision });
    expect(updated.revision).toBe(saved.revision + 1);
    await expect(saveSystemBrief({ ...saved, name: 'Stale' }, systemsDir, { mode: 'update', expectedRevision: saved.revision }))
      .rejects.toThrow(/Revision conflict/);

    // Removing the rules is an explicit save, after which the field is gone.
    const removed = await saveSystemBrief({ ...updated, requirementRules: undefined }, systemsDir, { mode: 'update' });
    expect('requirementRules' in removed).toBe(false);
  });

  it('rejects saving a stale association after the linked text was renamed', async () => {
    const brief = briefWithRules({ id: 'rule-system-2', revision: 1 });
    const saved = await saveSystemBrief(brief, systemsDir, { mode: 'create' });
    await expect(saveSystemBrief({ ...saved, requirements: [`${REQ} changed`, OTHER_REQ] }, systemsDir, { mode: 'update' }))
      .rejects.toThrow(/missing or ambiguous|remap/);
  });
});

describe('requirement evaluator over typed delivery observations', () => {
  it('passes an accepted delivery within the limit with evidence', async () => {
    const snapshot = await snapshotWithRules();
    const outcome = evaluate(executeExperiment(passingExperiment, 'clean'), snapshot);
    expect(outcome.status).toBe('passed');
    expect(outcome.matchedEvents).toBe(1);
    expect(outcome.evidence.some(e => e.status === 'passed' && e.usedCredit === 0 && e.reservedCredit === 1000 && e.creditLimit === 1500 && e.totalCredit === 1000)).toBe(true);
    expect(outcome.snapshotHash).toBe(snapshot.hash);
    expect(outcome.evaluator).toEqual(snapshot.requirementEvaluator);
  });

  it('passes via drain:deliver', async () => {
    const snapshot = await snapshotWithRules();
    const drainExperiment: Experiment = {
      hypothesis: 'drain delivery', expectedInvariant: 'credit_limit_respected',
      steps: [
        { op: 'send', id: 'q', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 100 } },
        { op: 'send', id: 'c', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 1500 } },
        { op: 'send', id: 'o1', to: 'client', payload: { type: 'new_order', id: 'm-o1', orderId: 'ord-1', quantity: 5, quoteId: 'q1' } },
        { op: 'drain' },
      ],
    };
    const result = executeExperiment(drainExperiment, 'clean');
    expect(result.deliveryObservations?.some(o => o.action === 'drain:deliver' && o.messageType === 'new_order')).toBe(true);
    expect(evaluate(result, snapshot).status).toBe('passed');
  });

  it('fails when one of several accepted events breaches the limit, retaining failing evidence', async () => {
    const snapshot = await snapshotWithRules();
    const outcome = evaluate(executeExperiment(failingExperiment, 'candidate-c'), snapshot);
    expect(outcome.status).toBe('failed');
    expect(outcome.matchedEvents).toBe(2);
    expect(outcome.evidence.some(e => e.status === 'passed')).toBe(true);
    expect(outcome.evidence.some(e => e.status === 'failed' && e.totalCredit === 2000 && e.creditLimit === 1500)).toBe(true);
    // The same experiment on clean: second order is target-rejected, rule still passes on the first event.
    const cleanOutcome = evaluate(executeExperiment(failingExperiment, 'clean'), snapshot);
    expect(cleanOutcome.status).toBe('passed');
    expect(cleanOutcome.evidence.some(e => e.status === 'target-rejected')).toBe(true);
  });

  it('distinguishes target rejection and no trigger as not-exercised', async () => {
    const snapshot = await snapshotWithRules();
    const rejectedOnly: Experiment = {
      hypothesis: 'order too large', expectedInvariant: 'credit_limit_respected',
      steps: [
        { op: 'send', id: 'q', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 100 } },
        { op: 'send', id: 'c', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 100 } },
        { op: 'deliver', messageId: 'q' },
        { op: 'deliver', messageId: 'c' },
        { op: 'send', id: 'o1', to: 'client', payload: { type: 'new_order', id: 'm-o1', orderId: 'ord-1', quantity: 10, quoteId: 'q1' } },
        { op: 'deliver', messageId: 'o1' },
      ],
    };
    const rejected = evaluate(executeExperiment(rejectedOnly, 'clean'), snapshot);
    expect(rejected.status).toBe('not-exercised');
    expect(rejected.evidence.some(e => e.status === 'target-rejected')).toBe(true);

    const noTrigger = evaluate(executeExperiment({ hypothesis: 'h', expectedInvariant: 'i', steps: [{ op: 'drain' }] }, 'clean'), snapshot);
    expect(noTrigger.status).toBe('not-exercised');
    expect(noTrigger.matchedEvents).toBe(0);
  });

  it('never passes on missing credit, missing observations, exceptions, invalid or incomplete execution', async () => {
    const snapshot = await snapshotWithRules();
    const base = executeExperiment(passingExperiment, 'clean');

    const missingCredit = structuredClone(base);
    delete missingCredit.deliveryObservations!.find(o => o.messageType === 'new_order')!.creditLimit;
    expect(evaluate(missingCredit, snapshot).status).toBe('inconclusive');

    const missingObservations = structuredClone(base);
    delete missingObservations.deliveryObservations;
    expect(evaluate(missingObservations, snapshot).status).toBe('inconclusive');

    const exception = structuredClone(base);
    const orderObs = exception.deliveryObservations!.find(o => o.messageType === 'new_order')!;
    orderObs.status = 'exception';
    orderObs.reason = 'boom';
    const exceptionOutcome = evaluate(exception, snapshot);
    expect(exceptionOutcome.status).toBe('inconclusive');
    expect(exceptionOutcome.evidence.some(e => /Target exception/.test(e.detail))).toBe(true);

    const incomplete = structuredClone(base);
    incomplete.executionComplete = false;
    expect(evaluate(incomplete, snapshot).status).toBe('inconclusive');

    const invalid = executeExperiment({ hypothesis: 'bad', expectedInvariant: 'i', steps: [{ op: 'deliver', messageId: 'nope' }] }, 'clean');
    expect(invalid.valid).toBe(false);
    expect(evaluate(invalid, snapshot).status).toBe('inconclusive');
  });

  it('retains a failed status even when another aspect is inconclusive', async () => {
    const snapshot = await snapshotWithRules();
    const result = executeExperiment(failingExperiment, 'candidate-c');
    result.executionComplete = false;
    const outcome = evaluate(result, snapshot);
    expect(outcome.status).toBe('failed');
    expect(outcome.evidence.some(e => e.status === 'failed')).toBe(true);
    expect(outcome.evidence.some(e => e.status === 'inconclusive')).toBe(true);
  });
});

function oneShotProvider(experiment: Experiment): ExperimentProvider {
  let calls = 0;
  return {
    kind: 'mock',
    model: 'rule-test-provider',
    propose: async (): Promise<ProviderReply> => {
      calls++;
      return calls === 1
        ? { experiment, usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 } }
        : { experiment: null, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } };
    },
  };
}

describe('investigation pinning and replay', () => {
  it('demonstrates the check with the offline mock on candidate-c and clean', async () => {
    const snapshot = await snapshotWithRules();
    const faulty = await runInvestigation({
      variant: 'candidate-c', provider: new MockProvider(), maxExperiments: 1, systemBrief: snapshot,
    });
    const clean = await runInvestigation({
      variant: 'clean', provider: new MockProvider(), maxExperiments: 1, systemBrief: snapshot,
    });

    expect(faulty.experiments[0]!.experiment.hypothesis).toMatch(/Scripted Offline Credit Check/);
    expect(faulty.experiments[0]!.result.requirementRuleResults?.[0]?.status).toBe('failed');
    expect(clean.experiments[0]!.result.requirementRuleResults?.[0]?.status).toBe('passed');
    expect((await replayRun(faulty)).exactReproductionClaimed).toBe(true);
  });

  it('pins rule outcomes per experiment, separate from findings, immune to later brief edits', async () => {
    const snapshot = await snapshotWithRules();
    const record = await runInvestigation({
      variant: 'clean', provider: oneShotProvider(passingExperiment), maxExperiments: 1, systemBrief: snapshot,
    });
    // Mutating the source snapshot object afterwards must not change the run.
    snapshot.brief.requirementRules = [];
    expect(record.systemBrief?.brief.requirementRules).toEqual([reviewedCreditRule(REQ)]);
    expect(record.systemBrief?.requirementEvaluator).toEqual(getRequirementEvaluatorIdentity());
    const ruleResults = record.experiments[0]!.result.requirementRuleResults;
    expect(ruleResults?.[0]?.status).toBe('passed');
    expect(record.findings).toHaveLength(0);
  });

  it('rule failure alone does not promote a confirmed finding', async () => {
    const snapshot = await snapshotWithRules();
    // Real execution/observations, but oracle violations stripped: only the rule fails.
    const sim: SimulatorApi = {
      getContract,
      getSourceBundle,
      parseExperiment,
      executeExperiment: (exp, variant) => ({ ...executeExperiment(exp, variant), violations: [] }),
    };
    const record = await runInvestigation({
      variant: 'candidate-c', provider: oneShotProvider(failingExperiment), maxExperiments: 1,
      systemBrief: snapshot, simulator: sim,
    });
    expect(record.experiments[0]!.result.requirementRuleResults?.[0]?.status).toBe('failed');
    expect(record.findings).toHaveLength(0);
    expect(record.experiments[0]!.cleanControlPassed).toBe(false);
  });

  it('refuses to launch when the pinned evaluator has drifted', async () => {
    const snapshot = await snapshotWithRules();
    snapshot.requirementEvaluator = { ...snapshot.requirementEvaluator!, hash: 'f'.repeat(64) };
    snapshot.hash = computeSnapshotHash(snapshot.brief, snapshot.contract, snapshot.requirementEvaluator);
    await expect(runInvestigation({ variant: 'clean', provider: oneShotProvider(passingExperiment), maxExperiments: 1, systemBrief: snapshot }))
      .rejects.toThrow(/evaluator is unavailable or has drifted/);
  });

  it('replays rule outcomes exactly with the pinned evaluator (full and selected)', async () => {
    const snapshot = await snapshotWithRules();
    const record = await runInvestigation({
      variant: 'clean', provider: oneShotProvider(passingExperiment), maxExperiments: 1, systemBrief: snapshot,
    });
    const report = await replayRun(record);
    expect(report.outcomes[0]?.ruleResultsMatched).toBe(true);
    expect(report.outcomes[0]?.deliveryObservationsMatched).toBe(true);
    expect(report.outcomes[0]?.replayedResult.requirementRuleResults?.[0]?.status).toBe('passed');
    expect(report.contextChecks?.some(c => c.kind === 'requirement-evaluator' && c.status === 'identical')).toBe(true);
    expect(report.exactReproductionClaimed).toBe(true);

    const selected = await replaySelectedExperiment(record, 0);
    expect(selected.outcomes[0]?.ruleResultsMatched).toBe(true);
    expect(selected.exactReproductionClaimed).toBe(true);
  });

  it('detects tampered recorded rule outcomes', async () => {
    const snapshot = await snapshotWithRules();
    const record = await runInvestigation({
      variant: 'clean', provider: oneShotProvider(passingExperiment), maxExperiments: 1, systemBrief: snapshot,
    });
    const tampered = structuredClone(record);
    tampered.experiments[0]!.result.requirementRuleResults![0]!.status = 'failed';
    const report = await replayRun(tampered);
    expect(report.outcomes[0]?.ruleResultsMatched).toBe(false);
    expect(report.exactReproductionClaimed).toBe(false);
  });

  it('reports evaluator drift instead of claiming exact rule replay', async () => {
    const snapshot = await snapshotWithRules();
    const record = await runInvestigation({
      variant: 'clean', provider: oneShotProvider(passingExperiment), maxExperiments: 1, systemBrief: snapshot,
    });
    const drifted = structuredClone(record);
    drifted.systemBrief!.requirementEvaluator = { ...drifted.systemBrief!.requirementEvaluator!, hash: 'a'.repeat(64) };
    drifted.systemBrief!.hash = computeSnapshotHash(drifted.systemBrief!.brief, drifted.systemBrief!.contract, drifted.systemBrief!.requirementEvaluator);
    // Keep the saved rule outcomes internally consistent with nothing else changed.
    const report = await replayRun(drifted);
    expect(report.contextChecks?.some(c => c.kind === 'requirement-evaluator' && c.status === 'drifted')).toBe(true);
    expect(report.outcomes[0]?.ruleResultsMatched).toBe(false);
    expect(report.exactReproductionClaimed).toBe(false);
  });

  it('rejects replay when the pinned brief association was tampered with', async () => {
    const snapshot = await snapshotWithRules();
    const record = await runInvestigation({
      variant: 'clean', provider: oneShotProvider(passingExperiment), maxExperiments: 1, systemBrief: snapshot,
    });
    const tampered = structuredClone(record);
    tampered.systemBrief!.brief.requirementRules = [reviewedCreditRule(OTHER_REQ)];
    await expect(replayRun(tampered)).rejects.toThrow(/snapshot hash mismatch/);
  });

  it('preserves legacy replay semantics for records without rule metadata', async () => {
    const record = await runInvestigation({
      variant: 'clean', provider: oneShotProvider(passingExperiment), maxExperiments: 1,
    });
    const legacy = structuredClone(record);
    for (const exp of legacy.experiments) {
      delete exp.result.deliveryObservations;
      delete exp.result.executionComplete;
      delete exp.result.requirementRuleResults;
    }
    const report = await replayRun(legacy);
    expect(report.contextStatus).toBe('legacy-unknown');
    expect(report.contextChecks?.some(c => c.kind === 'requirement-evaluator')).toBe(false);
    expect(report.outcomes[0]?.ruleResultsMatched).toBeUndefined();
    expect(report.exactReproductionClaimed).toBe(true);
  });
});

describe('requirement rules over the HTTP workspace API', () => {
  let runsDir: string;
  let listener: (...args: unknown[]) => void;

  beforeEach(async () => {
    runsDir = await fs.mkdtemp(path.join(process.cwd(), '.tmp-chaospilot-rules-api-'));
    const instance = new ChaosPilotServer({ runsDir, providerFactory: () => new MockProvider() });
    listener = instance.createHttpServer().listeners('request')[0] as typeof listener;
  });
  afterEach(async () => { await fs.rm(runsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = Readable.from(payload ? [Buffer.from(payload)] : []) as any;
    req.method = method;
    req.url = url;
    req.headers = { host: '127.0.0.1', 'content-type': 'application/json' };
    req.socket = { localPort: 80 };
    let status = 0;
    let text = '';
    await new Promise<void>((resolve) => {
      const res: Partial<http.ServerResponse> & { end: (chunk?: unknown) => void } = {
        writeHead(code: number) { status = code; return res as http.ServerResponse; },
        end(chunk?: unknown) { if (chunk) text += String(chunk); resolve(); return res as http.ServerResponse; },
      };
      listener(req, res);
    });
    return { status, json: text ? JSON.parse(text) : null };
  }

  it('saves a reviewed rule, pins it in the snapshot, and rejects bad saves', async () => {
    const current = (await call('GET', '/api/systems/trading-gateway')).json;
    const withRule = { ...current, requirements: [REQ, OTHER_REQ], requirementRules: [reviewedCreditRule(REQ)] };
    const saved = await call('PUT', '/api/systems/trading-gateway', withRule);
    expect(saved.status).toBe(200);
    expect(saved.json.requirementRules).toEqual([reviewedCreditRule(REQ)]);

    const snapshot = await call('GET', '/api/systems/trading-gateway/snapshot');
    expect(snapshot.status).toBe(200);
    expect(snapshot.json.requirementEvaluator).toEqual(getRequirementEvaluatorIdentity());
    expect(snapshot.json.hash).toBe(computeSnapshotHash(snapshot.json.brief, snapshot.json.contract, snapshot.json.requirementEvaluator));

    // Stale revision conflicts.
    expect((await call('PUT', '/api/systems/trading-gateway', withRule)).status).toBe(409);
    // Wrong adapter with an active rule is rejected.
    const wrongAdapter = await call('PUT', '/api/systems/trading-gateway', { ...saved.json, adapterId: 'inventory-reservation' });
    expect(wrongAdapter.status).toBe(400);
    expect(String(wrongAdapter.json.error)).toMatch(/synthetic-trading only/);
    // Unsupported preset smuggling code is rejected.
    const smuggled = await call('PUT', '/api/systems/trading-gateway', { ...saved.json, requirementRules: [{ requirement: REQ, preset: 'eval', reviewed: true, code: '1' }] });
    expect(smuggled.status).toBe(400);
  });
});
