import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Experiment, InvestigationRecord, TargetVariant, TraceEntry } from '../src/domain.ts';
import { runInvestigation } from '../src/investigation/index.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { SEEDED_INVENTORY_BRIEF, createSystemSnapshot } from '../src/systems/index.ts';
import { replayRun, replaySelectedExperiment, saveRun, type SimulatorApi } from '../src/storage.ts';
import * as inventory from '../src/inventory/index.ts';
import {
  buildTraceSteps, classifyFreshReplay, classifyStep, explainStep,
} from '../src/web/reproduction-player.ts';

let runsDir: string;
beforeEach(async () => { runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chaospilot-inv-sel-replay-')); });
afterEach(async () => { await fs.rm(runsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

async function inventoryRecord(variant: 'clean' | 'inventory-candidate-a' = 'inventory-candidate-a'): Promise<InvestigationRecord> {
  const systemBrief = await createSystemSnapshot(structuredClone(SEEDED_INVENTORY_BRIEF));
  return runInvestigation({ variant, systemBrief, provider: new MockProvider() });
}

/** Real inventory adapter with execution counting and optional bundle-hash drift. */
function countingSimulator(calls: { variant: TargetVariant }[], driftHash = false): SimulatorApi {
  return {
    getContract: () => inventory.getContract(),
    getSourceBundle: (variant: TargetVariant) => {
      const bundle = inventory.getSourceBundle(variant);
      return driftHash && variant !== 'clean' ? { ...bundle, hash: 'd'.repeat(64) } : bundle;
    },
    executeExperiment: (experiment, variant) => { calls.push({ variant }); return inventory.executeExperiment(experiment, variant); },
  };
}

describe('inventory mock investigation -> finding -> selected replay', () => {
  it('replays exactly the finding experiment once, with no clean execution, and verifies context', async () => {
    const record = await inventoryRecord();
    expect(record.findings.length).toBeGreaterThan(0);
    await saveRun(record, runsDir);
    const finding = record.findings[0]!;
    const position = record.experiments.findIndex(e => e.index === finding.experimentIndex);
    expect(position).toBeGreaterThanOrEqual(0);

    const calls: { variant: TargetVariant }[] = [];
    const report = await replaySelectedExperiment(record.id, position, runsDir, countingSimulator(calls));
    expect(calls).toEqual([{ variant: 'inventory-candidate-a' }]); // exactly one execution, never clean
    expect(report.scope).toBe('experiment');
    expect(report.experimentPosition).toBe(position);
    expect(report.experimentsTotal).toBe(1);
    expect(report.contextStatus).toBe('verified');
    expect(report.exactReproductionClaimed).toBe(true);
    expect(report.outcomes[0]?.behaviorMatched).toBe(true);
    expect(report.outcomes[0]?.replayedViolationsCount).toBeGreaterThan(0);
    expect(report.note).toContain('No clean comparison was rerun');

    const full = await replayRun(record.id, runsDir);
    expect(full.scope).toBeUndefined();
    expect(full.exactReproductionClaimed).toBe(true);
    expect(full.experimentsTotal).toBe(record.experiments.length);
  });

  it('replays a clean inventory control experiment with no violations', async () => {
    const record = await inventoryRecord('clean');
    expect(record.findings).toEqual([]);
    const calls: { variant: TargetVariant }[] = [];
    const report = await replaySelectedExperiment(record, 0, runsDir, countingSimulator(calls));
    expect(calls).toEqual([{ variant: 'clean' }]);
    expect(report.exactReproductionClaimed).toBe(true);
    expect(report.outcomes[0]?.replayedViolationsCount).toBe(0);
  });

  it('keeps behaviour match distinct from exact reproduction under source drift', async () => {
    const record = await inventoryRecord();
    const calls: { variant: TargetVariant }[] = [];
    const report = await replaySelectedExperiment(record, 1, runsDir, countingSimulator(calls, true));
    expect(report.sourceIdentical).toBe(false);
    expect(report.exactReproductionClaimed).toBe(false);
    expect(report.outcomes[0]?.behaviorMatched).toBe(true);
    expect(report.contextChecks?.find(c => c.kind === 'target-source')?.status).toBe('drifted');
  });

  it('applies the same tamper and cross-adapter gates as full replay, before any execution', async () => {
    const record = await inventoryRecord();
    const calls: { variant: TargetVariant }[] = [];
    const sim = countingSimulator(calls);

    const tampered = structuredClone(record);
    tampered.systemBrief!.hash = 'f'.repeat(64);
    await expect(replaySelectedExperiment(tampered, 0, runsDir, sim)).rejects.toThrow(/snapshot hash mismatch/);
    await expect(replayRun(tampered, runsDir, sim)).rejects.toThrow(/snapshot hash mismatch/);

    const cross = structuredClone(record);
    cross.variant = 'candidate-a';
    await expect(replaySelectedExperiment(cross, 0, runsDir, sim)).rejects.toThrow(/Unsupported variant/);

    await expect(replaySelectedExperiment(record, 99, runsDir, sim)).rejects.toThrow(/out of range/);
    await expect(replaySelectedExperiment(record, -1, runsDir, sim)).rejects.toThrow(/Invalid experiment position/);
    expect(calls).toEqual([]);
  });
});

const overReservePlan: Experiment = {
  hypothesis: 'Competing reservations over-reserve',
  expectedInvariant: 'stock_conservation',
  steps: [
    { op: 'send', id: 'm1', to: 'stock', payload: { type: 'stock', id: 's1', sku: 'item', quantity: 10 } },
    { op: 'send', id: 'm2', to: 'reservations', payload: { type: 'reserve', id: 'r1', reservationId: 'res-1', sku: 'item', quantity: 7 } },
    { op: 'send', id: 'm3', to: 'reservations', payload: { type: 'reserve', id: 'r2', reservationId: 'res-2', sku: 'item', quantity: 7 } },
    { op: 'deliver', messageId: 'm1' },
    { op: 'deliver', messageId: 'm2' },
    { op: 'deliver', messageId: 'm3' },
    { op: 'duplicate', id: 'm4', messageId: 'm1' },
    { op: 'deliver', messageId: 'm4' },
    { op: 'send', id: 'm5', to: 'reservations', payload: { type: 'reserve', id: 'r3', reservationId: 'res-3', sku: 'missing-sku', quantity: 1 } },
    { op: 'deliver', messageId: 'm5' },
  ],
};

describe('inventory playback presentation', () => {
  it('classifies accepted/duplicate/rejected deliveries and attributes a unique violation', () => {
    const result = inventory.executeExperiment(overReservePlan, 'inventory-candidate-a');
    expect(result.violations.length).toBeGreaterThan(0);
    const { steps } = buildTraceSteps(result.trace, result.violations);
    const byOutcome = (o: string) => steps.filter(s => s.outcome === o);
    expect(byOutcome('accepted').length).toBeGreaterThan(0);
    expect(byOutcome('accepted').every(s => s.kind === 'processed')).toBe(true);
    expect(byOutcome('duplicate')).toHaveLength(1);
    expect(byOutcome('duplicate')[0]?.kind).toBe('processed');
    expect(byOutcome('rejected')).toHaveLength(1);
    expect(byOutcome('rejected')[0]?.kind).toBe('rejected');
    expect(classifyStep(result.trace.find(e => e.action === 'send')!)).toBe('scheduled');

    const violationStep = steps.find(s => s.isViolation);
    expect(violationStep?.title).toContain('res-2');
    expect(violationStep?.title).toContain('accepted (recorded)');
    expect(violationStep?.facts.join(' ')).toContain('Recorded stock for SKU item');
    expect(violationStep?.facts.join(' ')).toContain('on hand 10');
    expect(violationStep?.facts.join(' ')).toContain('reserved (remaining) 14');
    expect(violationStep?.facts.join(' ')).not.toContain('credit');

    const explanation = explainStep(violationStep!, violationStep!.violations);
    expect(explanation.observedIsViolation).toBe(true);
    // Expected side carries only the rule constraint; actual recorded
    // figures (on hand 10, reserved remaining 14) are observed evidence.
    expect(explanation.expected).toContain('SKU item');
    expect(explanation.expected).toContain('must not exceed on-hand');
    expect(explanation.expected).not.toContain('14');
    expect(explanation.expected).not.toContain('Recorded evidence');
    expect(explanation.observed).toContain('on hand 10');
    expect(explanation.observed).toContain('reserved (remaining) 14');
    // A rejected delivery with no attributed violation is neither pass nor defect
    // (use the clean control's rejected delivery: candidate state already diverged).
    const cleanSteps = buildTraceSteps(inventory.executeExperiment(overReservePlan, 'clean').trace, []).steps;
    const rejected = cleanSteps.find(s => s.outcome === 'rejected')!;
    expect(explainStep(rejected, rejected.violations).observed).toContain('not a recorded pass');
  });

  it('clean control rejects the over-reservation and records no violation', () => {
    const result = inventory.executeExperiment(overReservePlan, 'clean');
    expect(result.violations).toEqual([]);
    const outcomes = result.trace.filter(e => e.action === 'deliver').map(e => e.outcome);
    expect(outcomes).toContain('rejected');
  });

  it('falls back neutrally for an unknown future-shaped trace', () => {
    const entry: TraceEntry = {
      step: 1, time: 0, action: 'frobnicate', outcome: 'whirred',
      payload: { type: 'gadget', widgetId: 'w1', level: 3 },
      state: { target: { gadgets: { w1: { level: 3 } } } },
    };
    const { steps, unattributedViolations } = buildTraceSteps([entry], []);
    expect(unattributedViolations).toEqual([]);
    expect(steps[0]?.kind).toBe('other');
    expect(steps[0]?.title).toContain('frobnicate: whirred');
    expect(steps[0]?.facts).toContain('widgetId: w1');
    expect(steps[0]?.facts).toContain('level: 3');
    expect(steps[0]?.facts.join(' ')).not.toContain('credit');
    expect(steps[0]?.credit).toBeNull();
    expect(explainStep(steps[0]!, []).observed).toContain('No violation is attributed');
  });

  it('distinguishes context-unverified fresh replay from mismatch and success', () => {
    const base = { sourceIdentical: true, reproduced: false, exactReproductionClaimed: false };
    expect(classifyFreshReplay({ ...base, outcomes: [{ behaviorMatched: true, replayedResult: {} }] })).toBe('context-unverified');
    expect(classifyFreshReplay({ ...base, outcomes: [{ behaviorMatched: false, replayedResult: {} }] })).toBe('mismatch');
    expect(classifyFreshReplay({ ...base, sourceIdentical: false, outcomes: [{ behaviorMatched: true, replayedResult: {} }] })).toBe('source-changed');
    expect(classifyFreshReplay({ ...base, reproduced: true, exactReproductionClaimed: true, outcomes: [{ behaviorMatched: true, replayedResult: {} }] })).toBe('success');
  });

  it('never hides a behaviour mismatch behind source drift or an exact flag behind context gates', () => {
    const base = { sourceIdentical: true, reproduced: false, exactReproductionClaimed: false };
    // Source changed + behaviour mismatched (both via behaviorMatched and via component flags).
    expect(classifyFreshReplay({ ...base, sourceIdentical: false, outcomes: [{ behaviorMatched: false, replayedResult: {} }] })).toBe('source-changed-mismatch');
    expect(classifyFreshReplay({ ...base, sourceIdentical: false, outcomes: [{ traceMatched: false, snapshotMatched: true, violationsMatched: true, rejectionsMatched: true, validityMatched: true, replayedResult: {} }] })).toBe('source-changed-mismatch');
    // Claim flags cannot bypass a drifted/unknown context or mismatched behaviour.
    expect(classifyFreshReplay({ ...base, reproduced: true, exactReproductionClaimed: true, contextStatus: 'drifted', outcomes: [{ behaviorMatched: true, replayedResult: {} }] })).toBe('context-unverified');
    expect(classifyFreshReplay({ ...base, reproduced: true, exactReproductionClaimed: true, contextStatus: 'unknown', outcomes: [{ behaviorMatched: true, replayedResult: {} }] })).toBe('context-unverified');
    expect(classifyFreshReplay({ ...base, reproduced: true, exactReproductionClaimed: true, outcomes: [{ behaviorMatched: false, replayedResult: {} }] })).toBe('mismatch');
    // Source drift overrides claim flags too.
    expect(classifyFreshReplay({ ...base, sourceIdentical: false, reproduced: true, exactReproductionClaimed: true, outcomes: [{ behaviorMatched: true, replayedResult: {} }] })).toBe('source-changed');
  });

  it('keeps reference outcome on the expected side and target outcome on the observed side', () => {
    const { steps } = buildTraceSteps(inventory.executeExperiment(overReservePlan, 'clean').trace, []);
    const step = steps[0]!;
    const transition = (expectedOutcome: string, outcome: string) => ({
      id: 'v-t', invariant: 'inventory_transition_consistency', step: 0,
      message: 'Transition diverged from reference', evidence: { expectedOutcome, outcome },
    });
    const different = explainStep(step, [transition('rejected', 'accepted')]);
    expect(different.expected).toContain('expected delivery outcome rejected');
    expect(different.expected).not.toContain('accepted');
    expect(different.observed).toContain('Recorded target delivery outcome: accepted');
    const equal = explainStep(step, [transition('accepted', 'accepted')]);
    expect(equal.expected).toContain('expected delivery outcome accepted');
    expect(equal.expected).toContain('resulting inventory state');
    expect(equal.observed).toContain('Recorded target delivery outcome: accepted');
    // Missing numeric/outcome evidence keeps the generic honest fallback.
    const generic = explainStep(step, [{ id: 'v-g', invariant: 'stock_conservation', step: 0, message: 'Stock diverged', evidence: {} }]);
    expect(generic.expected).toBeNull();
    expect(generic.observed).toContain('Stock diverged');
    expect(generic.observed).not.toContain('Recorded evidence:');
  });
});
