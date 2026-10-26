import { describe, it, expect } from 'vitest';
import {
  generateBaselineExperiment,
  runBaselineTrial,
  runEvaluation,
  createPrng,
  MAX_EXPERIMENTS_LIMIT,
} from '../src/evaluation.ts';
import { getSimulatorApi, type SimulatorApi } from '../src/storage.ts';
import type {
  Experiment,
  ExperimentResult,
  InvestigationRecord,
  TargetVariant,
  Violation,
} from '../src/domain.ts';

describe('Fair Deterministic Evaluation', () => {
  describe('Fair reproducible baseline (Invariant 3)', () => {
    it('produces identical plans with the same seed (same seeds reproduce)', () => {
      const seed = 42;
      const exp1A = generateBaselineExperiment(seed, 0);
      const exp1B = generateBaselineExperiment(seed, 0);
      expect(exp1A).toEqual(exp1B);

      const exp2A = generateBaselineExperiment(seed, 1);
      const exp2B = generateBaselineExperiment(seed, 1);
      expect(exp2A).toEqual(exp2B);
    });

    it('prng produces deterministic pseudo-random sequences', () => {
      const prng1 = createPrng(1337);
      const seq1 = [prng1(), prng1(), prng1()];

      const prng2 = createPrng(1337);
      const seq2 = [prng2(), prng2(), prng2()];

      expect(seq1).toEqual(seq2);
    });

    it('generates seeded scenario orders rather than fixed index order (seeded scenario choice)', () => {
      // With seeded choice, index 0 across different seeds yields different scenario classes
      const hypothesesAtZero = new Set<string>();
      for (let s = 1000; s < 1030; s++) {
        const exp = generateBaselineExperiment(s, 0);
        hypothesesAtZero.add(exp.expectedInvariant);
      }
      // Multiple different invariant scenarios should appear at index 0
      expect(hypothesesAtZero.size).toBeGreaterThan(1);
    });

    it('generates both full and partial duplicate delivery with varied identities (partial/full duplication)', () => {
      let expDupFull: Experiment | null = null;
      let expDupPart: Experiment | null = null;

      for (let s = 1000; s < 1200; s++) {
        const exp = generateBaselineExperiment(s, 0);
        if (exp.steps.some((st) => st.op === 'duplicate')) {
          if (exp.hypothesis.includes('full fill')) {
            expDupFull = exp;
          } else if (exp.hypothesis.includes('partial fill')) {
            expDupPart = exp;
          }
        }
        if (expDupFull && expDupPart) break;
      }

      expect(expDupFull).toBeDefined();
      expect(expDupPart).toBeDefined();

      const fillFull = expDupFull!.steps.find((s) => s.op === 'fill') as any;
      const fillPart = expDupPart!.steps.find((s) => s.op === 'fill') as any;

      expect(fillFull).toBeDefined();
      expect(fillPart).toBeDefined();
      expect(fillPart.quantity).toBeLessThanOrEqual(fillFull.quantity);
      expect(fillFull.executionId).not.toBe(fillPart.executionId);
    });

    it('exercises both cancellation and fill permutations in lifecycle accounting (both cancellation delivery orders)', async () => {
      const sim = await getSimulatorApi();

      let expCancelFirst: Experiment | null = null;
      let expFillFirst: Experiment | null = null;

      for (let s = 2000; s < 2200; s++) {
        for (let i = 0; i < 6; i++) {
          const exp = generateBaselineExperiment(s, i);
          if (exp.hypothesis.includes('arriving before')) expCancelFirst = exp;
          if (exp.hypothesis.includes('before cancel')) expFillFirst = exp;
          if (expCancelFirst && expFillFirst) break;
        }
        if (expCancelFirst && expFillFirst) break;
      }

      expect(expCancelFirst).toBeDefined();
      expect(expFillFirst).toBeDefined();

      // Both execute validly on clean target
      const res2 = sim.executeExperiment(expCancelFirst!, 'clean');
      const res3 = sim.executeExperiment(expFillFirst!, 'clean');

      expect(res2.valid).toBe(true);
      expect(res3.valid).toBe(true);
      expect(res2.violations).toHaveLength(0);
      expect(res3.violations).toHaveLength(0);
    });

    it('implements same stop-on-first-verified-finding policy for baseline as provider (same stopping rule)', async () => {
      const sim = await getSimulatorApi();
      const seed = 1002;

      // On candidate-a, once defect is verified, baseline stops immediately
      const trialA = runBaselineTrial('candidate-a', seed, 6, sim);
      expect(trialA.findingsCount).toBeGreaterThanOrEqual(1);
      expect(trialA.confirmedInvariants).toContain('execution_idempotency');
      expect(trialA.discoveredAtExperiment).toBeDefined();
      expect(trialA.experimentCount).toBe(trialA.discoveredAtExperiment);
      expect(trialA.experimentCount).toBeLessThanOrEqual(6);
      expect(trialA.cleanControlPassed).toBe(true);

      // On clean variant, no defect finding can be confirmed, so it executes full budget
      const trialClean = runBaselineTrial('clean', seed, 6, sim);
      expect(trialClean.experimentCount).toBe(6);
      expect(trialClean.violationsCount).toBe(0);
      expect(trialClean.findingsCount).toBe(0);
      expect(trialClean.cleanControlPassed).toBe(true);
    });
  });

  describe('Truthful discovery metrics and verification bounds (Invariant 2)', () => {
    it('discriminating test: raw violation with no confirmed findings yields discovery 0 (raw-only violation)', async () => {
      const fakeRunner = async () => {
        return {
          schemaVersion: 1 as const,
          id: 'run-fake-raw-violation',
          provider: 'mock' as const,
          model: 'fake-model',
          mode: 'mock' as const,
          variant: 'candidate-a' as const,
          status: 'completed' as const,
          startedAt: new Date().toISOString(),
          sourceHash: 'fake-hash',
          experiments: [
            {
              index: 1,
              experiment: { hypothesis: 'H', expectedInvariant: 'credit_limit_respected', steps: [] },
              result: {
                schemaVersion: 1 as const,
                experiment: { hypothesis: 'H', expectedInvariant: 'credit_limit_respected', steps: [] },
                sourceHash: 'fake-hash',
                trace: [],
                snapshot: {},
                violations: [
                  {
                    id: 'v1',
                    invariant: 'credit_limit_respected',
                    message: 'Raw violation text',
                    step: 1,
                    evidence: {},
                  },
                ],
                rejections: [],
                valid: true,
              },
              replayVerified: false, // Replay failed!
              cleanControlPassed: false, // Clean also had this!
            },
          ],
          findings: [], // No confirmed findings!
          usage: { inputTokens: 10, outputTokens: 10, estimatedCostUsd: 0 },
          errors: [],
          contextAudit: { sourcePaths: [], contractHash: '', promptVersion: '' },
        };
      };

      const report = await runEvaluation({
        variant: 'candidate-a',
        provider: 'mock',
        trials: 1,
        seeds: [5001],
        investigationRunner: fakeRunner,
      });

      // Raw violations occurred but NO confirmed discoveries
      expect(report.provider.trialsWithViolations).toBe(1);
      expect(report.provider.trialsWithDiscoveries).toBe(0);
      expect(report.comparison.providerDiscoveryRate).toBe(0);
      expect(report.provider.uniqueInvariantsFound).toEqual([]);
      expect(report.provider.rawInvariantsViolated).toContain('credit_limit_respected');
    });

    it('discriminating test: genuine verified finding yields discovery 1 (genuine finding)', async () => {
      const fakeRunner = async () => {
        return {
          schemaVersion: 1 as const,
          id: 'run-fake-genuine',
          provider: 'mock' as const,
          model: 'fake-model',
          mode: 'mock' as const,
          variant: 'candidate-a' as const,
          status: 'completed' as const,
          startedAt: new Date().toISOString(),
          sourceHash: 'fake-hash',
          experiments: [
            {
              index: 1,
              experiment: { hypothesis: 'H', expectedInvariant: 'execution_idempotency', steps: [] },
              result: {
                schemaVersion: 1 as const,
                experiment: { hypothesis: 'H', expectedInvariant: 'execution_idempotency', steps: [] },
                sourceHash: 'fake-hash',
                trace: [],
                snapshot: {},
                violations: [
                  {
                    id: 'v1',
                    invariant: 'execution_idempotency',
                    message: 'Idempotency failure',
                    step: 2,
                    evidence: {},
                  },
                ],
                rejections: [],
                valid: true,
              },
              replayVerified: true,
              cleanControlPassed: true,
            },
          ],
          findings: [
            {
              id: 'f1',
              title: 'Finding 1',
              hypothesis: 'H',
              experimentIndex: 1,
              violation: {
                id: 'v1',
                invariant: 'execution_idempotency',
                message: 'Idempotency failure',
                step: 2,
                evidence: {},
              },
              sourceHash: 'fake-hash',
              reproduced: true,
              cleanControlPassed: true,
              replay: { hypothesis: 'H', expectedInvariant: 'execution_idempotency', steps: [] },
            },
          ],
          usage: { inputTokens: 10, outputTokens: 10, estimatedCostUsd: 0 },
          errors: [],
          contextAudit: { sourcePaths: [], contractHash: '', promptVersion: '' },
        };
      };

      const report = await runEvaluation({
        variant: 'candidate-a',
        provider: 'mock',
        trials: 1,
        seeds: [5002],
        investigationRunner: fakeRunner,
      });

      expect(report.provider.trialsWithDiscoveries).toBe(1);
      expect(report.comparison.providerDiscoveryRate).toBe(1);
      expect(report.provider.uniqueInvariantsFound).toEqual(['execution_idempotency']);
    });

    it('rejects discoveries contaminated by same invariant on clean control (clean same-invariant contamination)', () => {
      const mockViolation: Violation = {
        id: 'v1',
        invariant: 'order_quantity_conservation',
        message: 'Order quantity exceeded',
        step: 2,
        evidence: {},
      };

      const mockCleanViolation: Violation = {
        id: 'cv1',
        invariant: 'order_quantity_conservation', // SAME invariant, different message/step!
        message: 'Completely different clean failure message',
        step: 3,
        evidence: {},
      };

      const controlledSim: SimulatorApi = {
        getSourceBundle: () => ({ hash: 'test-hash', files: [] }),
        executeExperiment: (_exp, variant: TargetVariant): ExperimentResult => {
          if (variant === 'clean') {
            return {
              schemaVersion: 1,
              experiment: _exp,
              sourceHash: 'test-hash',
              trace: [],
              snapshot: {},
              violations: [mockCleanViolation],
              rejections: [],
              valid: true,
            };
          }
          return {
            schemaVersion: 1,
            experiment: _exp,
            sourceHash: 'test-hash',
            trace: [],
            snapshot: {},
            violations: [mockViolation],
            rejections: [],
            valid: true,
          };
        },
      };

      const trial = runBaselineTrial('candidate-a', 6001, 3, controlledSim);
      // Clean control violated same invariant, so cleanControlPassed is FALSE and findingsCount is 0!
      expect(trial.cleanControlPassed).toBe(false);
      expect(trial.findingsCount).toBe(0);
      expect(trial.confirmedInvariants).toHaveLength(0);
    });

    it('rejects discoveries on replay mismatch (replay mismatch)', () => {
      let callCount = 0;
      const nonDeterministicSim: SimulatorApi = {
        getSourceBundle: () => ({ hash: 'test-hash', files: [] }),
        executeExperiment: (_exp): ExperimentResult => {
          callCount++;
          // First execution has violation; replay execution does not!
          const violations = callCount % 2 === 1
            ? [{ id: 'v1', invariant: 'order_quantity_conservation', message: 'fail', step: 1, evidence: {} }]
            : [];
          return {
            schemaVersion: 1,
            experiment: _exp,
            sourceHash: 'test-hash',
            trace: [],
            snapshot: {},
            violations,
            rejections: [],
            valid: true,
          };
        },
      };

      const trial = runBaselineTrial('candidate-a', 7001, 2, nonDeterministicSim);
      // Replay mismatched, so not verified
      expect(trial.findingsCount).toBe(0);
      expect(trial.confirmedInvariants).toHaveLength(0);
    });

    it('preserves status and safe error reason when runner fails or cancels (failed/cancelled provider)', async () => {
      let callCount = 0;
      const multiStatusRunner = async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Simulated transient provider timeout');
        }
        return {
          schemaVersion: 1 as const,
          id: `run_status_${callCount}`,
          provider: 'mock' as const,
          model: 'mock-test',
          mode: 'mock' as const,
          variant: 'candidate-a' as const,
          status: 'cancelled' as const,
          stopReason: 'Investigation aborted by user signal',
          startedAt: new Date().toISOString(),
          sourceHash: 'hash-test',
          experiments: [],
          findings: [],
          usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
          errors: [],
          contextAudit: { sourcePaths: [], contractHash: '', promptVersion: '' },
        };
      };

      const report = await runEvaluation({
        variant: 'candidate-a',
        provider: 'mock',
        maxExperiments: 2,
        trials: 2,
        seeds: [8001, 8002],
        investigationRunner: multiStatusRunner,
      });

      expect(report.provider.trials).toHaveLength(2);

      const failedTrial = report.provider.trials[0]!;
      expect(failedTrial.status).toBe('failed');
      expect(failedTrial.errorReason).toContain('Simulated transient provider timeout');
      expect(failedTrial.model).toBe('error');

      const cancelledTrial = report.provider.trials[1]!;
      expect(cancelledTrial.status).toBe('cancelled');
      expect(cancelledTrial.errorReason).toContain('Investigation aborted by user signal');
    });

    it('normalizes maxExperiments ONCE to 20 for baseline, provider, and config when max50 is requested (max50 requested both effective20)', async () => {
      let capturedMaxInRunner = 0;
      const spyingRunner = async (opts: any) => {
        capturedMaxInRunner = opts.maxExperiments;
        return {
          schemaVersion: 1 as const,
          id: 'spying-run',
          provider: 'mock' as const,
          model: 'mock-spy',
          mode: 'mock' as const,
          variant: 'clean' as const,
          status: 'completed' as const,
          startedAt: new Date().toISOString(),
          sourceHash: 'h',
          experiments: [],
          findings: [],
          usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
          errors: [],
          contextAudit: { sourcePaths: [], contractHash: '', promptVersion: '' },
        };
      };

      const report = await runEvaluation({
        variant: 'clean',
        provider: 'mock',
        maxExperiments: 50, // requested 50
        trials: 1,
        seeds: [9001],
        investigationRunner: spyingRunner,
      });

      // Both effectively clamped to MAX_EXPERIMENTS_LIMIT (20)
      expect(MAX_EXPERIMENTS_LIMIT).toBe(20);
      expect(report.config.maxExperiments).toBe(20);
      expect(report.comparison.equalExperimentLimit).toBe(20);
      expect(capturedMaxInRunner).toBe(20);
      expect(report.baseline.trials[0]?.experimentCount).toBe(20);
    });
  });

  describe('Comparative evaluation reports and provenance', () => {
    it('runs complete comparative evaluation with bounded trials and explicit provenance', async () => {
      const report = await runEvaluation({
        variant: 'candidate-a',
        provider: 'mock',
        maxExperiments: 3,
        trials: 2,
        seeds: [2001, 2002],
      });

      expect(report.schemaVersion).toBe(1);
      expect(report.config.trials).toBe(2);
      expect(report.config.maxExperiments).toBe(3);
      expect(report.baseline.trials).toHaveLength(2);

      // Provenance labeling checks
      expect(report.provenance.providerMode).toBe('mock');
      expect(report.provenance.mockResultsNeverImplyLivePerformance).toBe(true);
      expect(report.comparison.efficiencyNotes).toContain('autonomous AI model discovery');

      // Metrics are well-formed numbers
      expect(report.comparison.baselineDiscoveryRate).toBeGreaterThanOrEqual(0);
      expect(report.comparison.baselineDiscoveryRate).toBeLessThanOrEqual(1);
      expect(report.comparison.baselineInvalidRate).toBeGreaterThanOrEqual(0);
    });

    it('clamps bounded trial counts safely', async () => {
      const report = await runEvaluation({
        variant: 'clean',
        provider: 'mock',
        maxExperiments: 1,
        trials: 99,
      });

      expect(report.config.trials).toBeLessThanOrEqual(10);
    });

    it('validates and clamps finite numeric evaluation bounds and filters invalid seeds', async () => {
      const report = await runEvaluation({
        variant: 'clean',
        provider: 'mock',
        maxExperiments: 999, // Clamped to 20
        trials: 50,          // Clamped to 10
        seeds: [-5, NaN, 1001, 1002, 1003],
      });

      expect(report.config.maxExperiments).toBe(20);
      expect(report.config.trials).toBe(3); // 3 valid seeds
      expect(report.config.seeds.every((s) => Number.isInteger(s) && s >= 0)).toBe(true);
    });
  });
});
