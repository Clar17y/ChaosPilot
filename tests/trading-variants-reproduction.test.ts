import { describe, expect, it } from 'vitest';
import type { ExperimentResult, Finding, InvestigationRecord, TargetVariant } from '../src/domain.ts';
import { executeExperiment, getContract } from '../src/simulator/index.ts';
import { FAULT_CATALOG } from '../src/testing/fault-catalog.ts';
import { buildReproductionModel, explainStep, type ReproductionModel } from '../src/web/reproduction-player.ts';

// Offline scripted evidence only: no provider, application prompt or run storage.
function savedRun(variant: TargetVariant, result: ExperimentResult, clean: ExperimentResult): InvestigationRecord {
  const findings: Finding[] = result.violations.map(violation => ({
    id: `finding-${violation.id}`, title: `Recorded ${violation.invariant}`,
    hypothesis: result.experiment.hypothesis, experimentIndex: 17, violation,
    sourceHash: result.sourceHash, reproduced: false,
    cleanControlPassed: clean.valid && clean.violations.length === 0,
    replay: result.experiment,
  }));
  return {
    schemaVersion: 1, id: `offline-scripted-${variant}`, provider: 'mock',
    model: 'offline scripted fixture (no AI discovery)', mode: 'mock', variant,
    status: 'completed', startedAt: '2026-01-01T00:00:00Z', sourceHash: result.sourceHash,
    // Nonconsecutive indices distinguish array positions from recorded IDs.
    experiments: [
      { index: 4, experiment: clean.experiment, result: clean, replayVerified: false, cleanControlPassed: false },
      { index: 17, experiment: result.experiment, result, replayVerified: false, cleanControlPassed: findings.every(f => f.cleanControlPassed) },
    ],
    findings, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, errors: [],
    contextAudit: { sourcePaths: [], contractHash: 'offline-contract', promptVersion: 'offline-scripted' },
    systemBrief: {
      brief: {
        schemaVersion: 1, id: 'offline-trading', revision: 3, name: 'Offline trading regression',
        overview: 'Scripted simulator evidence', requirements: [], adapterId: 'synthetic-trading',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      // Saved wording detects accidental substitution of today's contract.
      contract: {
        ...getContract(),
        invariants: getContract().invariants.map(rule => ({ ...rule, description: `Saved revision 3: ${rule.description}` })),
      },
      hash: 'offline-saved-brief',
    },
  };
}

function assertCompleteTrace(model: ReproductionModel, result: ExperimentResult): void {
  expect(model.traceCount).toBe(result.trace.length);
  expect(model.hasTrace).toBe(result.trace.length > 0);
  expect(model.allSteps).toHaveLength(result.trace.length);
  model.allSteps.forEach((step, position) => {
    const entry = result.trace[position]!;
    expect(step).toMatchObject({
      position, tracePosition: position, actionIndex: entry.step, time: entry.time,
      action: entry.action, outcome: entry.outcome, messageId: entry.messageId ?? null,
    });
    expect(step.isGroup).not.toBe(true);
    if (entry.payload !== undefined) expect(JSON.parse(step.payloadText)).toEqual(entry.payload);
    expect(JSON.parse(step.stateText)).toEqual(entry.state);
    expect(step.isViolation).toBe(step.violations.length > 0);
  });
  const accounted = [...model.allSteps.flatMap(step => step.violations), ...model.unattributedViolations];
  expect(accounted).toHaveLength(result.violations.length);
  for (const violation of result.violations) {
    expect(accounted.filter(v => v.id === violation.id)).toEqual([violation]);
  }
  expect(model.evidence.violations).toEqual(result.violations);
}

describe('offline scripted trading variants: saved reproduction evidence', () => {
  it('covers exactly nine fault variants with different trace lengths', () => {
    expect(FAULT_CATALOG.map(entry => entry.variant).sort()).toEqual([
      'candidate-a', 'candidate-b', 'candidate-c', 'candidate-d', 'candidate-e',
      'candidate-f', 'candidate-g', 'candidate-h', 'candidate-i',
    ]);
    const lengths = FAULT_CATALOG.map(entry => executeExperiment(entry.knownExperiment, entry.variant).trace.length);
    expect(new Set(lengths).size).toBeGreaterThan(1);
  });

  describe.each(FAULT_CATALOG)('$variant', entry => {
    it('selects every actual violation and preserves its evidence with saved and legacy contracts', () => {
      const result = executeExperiment(entry.knownExperiment, entry.variant);
      const clean = executeExperiment(entry.knownExperiment, 'clean');
      expect(result.valid).toBe(true);
      expect(result.rejections).toEqual([]);
      expect(result.violations.some(v => v.invariant === entry.publicInvariantId)).toBe(true);
      expect(clean.valid).toBe(true);
      expect(clean.violations).toEqual([]);
      const record = savedRun(entry.variant, result, clean);
      const before = structuredClone(record);
      for (const finding of record.findings) {
        for (const legacy of [false, true]) {
          const selectedRecord = legacy ? { ...record, systemBrief: undefined } : record;
          // A deserialized finding must work without oracle object identity.
          const model = buildReproductionModel(selectedRecord, 1, structuredClone(finding))!;
          assertCompleteTrace(model, result);
          expect(model.evidence).toMatchObject({
            invariant: finding.violation.invariant, violationMessage: finding.violation.message,
            expectedInvariant: entry.knownExperiment.expectedInvariant,
            hypothesis: entry.knownExperiment.hypothesis, experimentPosition: 1, experimentIndex: 17,
            sourceHash: result.sourceHash, runId: record.id,
          });
          expect(model.findingTitle).toBe(finding.title);
          if (legacy) {
            expect(model.evidence.ruleText).toBeNull();
            expect(model.evidence.ruleLabel).toContain('unavailable');
          } else {
            const savedRule = record.systemBrief!.contract!.invariants.find(rule => rule.id === finding.violation.invariant)!;
            expect(model.evidence.ruleText).toBe(savedRule.description);
          }
          expect(model.cleanLabel).toContain('passed');
          expect(model.replayLabel).toContain('not verified');
          expect(model.unattributedViolations).toEqual([]);
          // Known recipes have one entry per action, hence an unambiguous
          // oracle location. Do not reuse the production attribution helper.
          for (const violation of result.violations) {
            const positions = result.trace.flatMap((trace, position) => trace.step === violation.step ? [position] : []);
            expect(positions).toHaveLength(1);
            const step = model.allSteps[positions[0]!]!;
            expect(step.violations).toContainEqual(violation);
            expect(step.kind).toBe('processed');
            if (violation.orderId) expect(result.trace[positions[0]!]!.payload).toMatchObject({ orderId: violation.orderId });
            const explanation = explainStep(step, step.violations);
            expect(explanation.observedIsViolation).toBe(true);
            expect(explanation.observed).toContain(violation.message);
            // Preserve errors without prescribing a concise milestone count.
            expect(model.steps.some(visible => visible.tracePosition === step.tracePosition && visible.violations.some(v => v.id === violation.id))).toBe(true);
          }
        }
      }
      expect(record).toEqual(before);
      const cleanModel = buildReproductionModel(record, 0, null)!;
      assertCompleteTrace(cleanModel, clean);
      expect(cleanModel.allSteps.every(step => !step.isViolation)).toBe(true);
      expect(cleanModel.evidence.violationMessage).toBeNull();
      expect(cleanModel.cleanLabel).toContain('not confirmed');
    });
  });

  it('keeps whole-state violations unattributed when a real drain processes multiple messages at one action', () => {
    const entry = FAULT_CATALOG.find(fault => fault.variant === 'candidate-b')!;
    const experiment = {
      ...entry.knownExperiment,
      steps: [...entry.knownExperiment.steps,
        { op: 'send' as const, id: 'later-q2', to: 'market' as const, payload: { type: 'quote', id: 'q2', version: 2, price: 11 } },
        { op: 'send' as const, id: 'later-q3', to: 'market' as const, payload: { type: 'quote', id: 'q3', version: 3, price: 12 } },
        { op: 'drain' as const },
      ],
    };
    const result = executeExperiment(experiment, entry.variant);
    const clean = executeExperiment(experiment, 'clean');
    expect(result.valid).toBe(true);
    expect(clean.violations).toEqual([]);
    const drainIndex = experiment.steps.length - 1;
    const drainViolations = result.violations.filter(v => v.step === drainIndex);
    expect(drainViolations.length).toBeGreaterThan(1);
    expect(result.trace.filter(trace => trace.step === drainIndex).length).toBeGreaterThan(1);
    const record = savedRun(entry.variant, result, clean);
    const finding = record.findings.find(f => f.violation.step === drainIndex)!;
    const model = buildReproductionModel(record, 1, finding)!;
    assertCompleteTrace(model, result);
    expect(model.evidence.violationMessage).toBe(finding.violation.message);
    expect(model.unattributedViolations).toEqual(drainViolations);
    expect(model.allSteps.filter(step => step.actionIndex === drainIndex).every(step => !step.isViolation)).toBe(true);
    expect(model.allSteps.filter(step => step.actionIndex < drainIndex).flatMap(step => step.violations))
      .toEqual(result.violations.filter(v => v.step < drainIndex));
  });
});
