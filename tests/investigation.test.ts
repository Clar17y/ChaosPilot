import { describe, it, expect, vi } from 'vitest';
import { runInvestigation, type SimulatorApi } from '../src/investigation/index.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { computeContractHash } from '../src/evidence.ts';
import type {
  Experiment,
  ExperimentProvider,
  ExperimentResult,
  InvestigationRecord,
  ProviderContext,
  ProviderReply,
  SourceBundle,
  SystemContract,
  TargetVariant,
  Violation
} from '../src/domain.ts';

describe('Investigation Test Suite', () => {
  const dummyContract: SystemContract = {
    name: 'TestVenue',
    description: 'Contract for investigation tests',
    operations: [],
    messages: [],
    invariants: [{ id: 'credit_limit_respected', description: 'Credit invariant' }],
    limits: { maxExposure: 5000 }
  };

  const dummySource: SourceBundle = {
    hash: 'src-hash-12345',
    files: [{ path: 'engine.ts', content: 'export const x = 1;' }]
  };

  const dummyValidExperiment: Experiment = {
    hypothesis: 'Valid hypothesis',
    expectedInvariant: 'credit_limit_respected',
    steps: [{ op: 'drain' }]
  };

  function createMockSimulator(options: {
    violationsByVariant?: Partial<Record<TargetVariant, Violation[]>>;
    failParseFirstTimes?: number;
    callCountTracker?: { calls: number };
  } = {}): SimulatorApi {
    let parseAttempts = 0;
    const tracker = options.callCountTracker ?? { calls: 0 };

    return {
      getContract: () => dummyContract,
      getSourceBundle: (_variant: TargetVariant) => dummySource,
      parseExperiment: (input: unknown) => {
        parseAttempts++;
        if (options.failParseFirstTimes && parseAttempts <= options.failParseFirstTimes) {
          throw new Error(`Parse failed on attempt ${parseAttempts}`);
        }
        if (!input || typeof input !== 'object') {
          throw new Error('Input must be an object');
        }
        return input as Experiment;
      },
      executeExperiment: (experiment: Experiment, variant: TargetVariant): ExperimentResult => {
        tracker.calls++;
        const violations = options.violationsByVariant?.[variant] ?? [];
        return {
          schemaVersion: 1,
          experiment,
          sourceHash: dummySource.hash,
          trace: [],
          snapshot: { state: 'ok' },
          violations,
          rejections: [],
          valid: true
        };
      }
    };
  }

  describe('Adaptive proposals and verified findings', () => {
    it('handles ordinary nonfinding before generated failure and confirms finding via replay & clean control', async () => {
      // Experiment 1 has no violation; Experiment 2 has violation on candidate-a, absent on clean
      let proposalCount = 0;
      const spyProvider: ExperimentProvider = {
        kind: 'mock',
        model: 'spy-model',
        propose: async (context: ProviderContext): Promise<ProviderReply> => {
          proposalCount++;
          if (proposalCount === 1) {
            expect(context.history.length).toBe(0);
            return {
              experiment: { hypothesis: 'Exp 1 Normal', expectedInvariant: 'credit_limit_respected', steps: [{ op: 'drain' }] },
              usage: { inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.0001 }
            };
          } else if (proposalCount === 2) {
            expect(context.history.length).toBe(1);
            expect(context.history[0]?.experiment.hypothesis).toBe('Exp 1 Normal');
            return {
              experiment: { hypothesis: 'Exp 2 Defect', expectedInvariant: 'credit_limit_respected', steps: [{ op: 'drain' }] },
              usage: { inputTokens: 15, outputTokens: 25, estimatedCostUsd: 0.0002 }
            };
          }
          return { experiment: null, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } };
        }
      };

      const violation: Violation = {
        id: 'v1',
        invariant: 'credit_limit_respected',
        message: 'Credit exceeded on duplicate fill',
        step: 2,
        evidence: { overage: 500 }
      };

      const sim: SimulatorApi = {
        getContract: () => dummyContract,
        getSourceBundle: () => dummySource,
        parseExperiment: (input: unknown) => input as Experiment,
        executeExperiment: (exp: Experiment, variant: TargetVariant) => {
          if (variant === 'candidate-a' && exp.hypothesis.includes('Exp 2 Defect')) {
            return {
              schemaVersion: 1,
              experiment: exp,
              sourceHash: dummySource.hash,
              trace: [],
              snapshot: {},
              violations: [violation],
              rejections: [],
              valid: true
            };
          }
          return {
            schemaVersion: 1,
            experiment: exp,
            sourceHash: dummySource.hash,
            trace: [],
            snapshot: {},
            violations: [],
            rejections: [],
            valid: true
          };
        }
      };

      const record = await runInvestigation({
        variant: 'candidate-a',
        maxExperiments: 5,
        provider: spyProvider,
        simulator: sim
      });

      expect(record.status).toBe('completed');
      expect(record.experiments.length).toBe(2);
      expect(record.findings.length).toBe(1);

      const finding = record.findings[0]!;
      expect(finding.violation.invariant).toBe('credit_limit_respected');
      expect(finding.reproduced).toBe(true);
      expect(finding.cleanControlPassed).toBe(true);
      expect(finding.experimentIndex).toBe(2);

      // Usage was aggregated correctly
      expect(record.usage.inputTokens).toBe(25);
      expect(record.usage.outputTokens).toBe(45);
      expect(record.usage.estimatedCostUsd).toBeCloseTo(0.0003, 5);
    });

    it('handles bad plan then corrected plan via validation feedback', async () => {
      let attempts = 0;
      let receivedFeedback: string[] | undefined;

      const adaptiveProvider: ExperimentProvider = {
        kind: 'mock',
        model: 'adaptive-model',
        propose: async (context: ProviderContext): Promise<ProviderReply> => {
          attempts++;
          if (attempts === 1) {
            // First proposal is malformed
            return {
              experiment: { hypothesis: 'Malformed', expectedInvariant: 'inv', steps: [] },
              usage: { inputTokens: 5, outputTokens: 5, estimatedCostUsd: 0.00005 }
            };
          }
          // Second proposal receives feedback and provides corrected plan
          receivedFeedback = context.feedback;
          return {
            experiment: dummyValidExperiment,
            usage: { inputTokens: 10, outputTokens: 10, estimatedCostUsd: 0.0001 }
          };
        }
      };

      const sim = createMockSimulator({ failParseFirstTimes: 1 });
      const record = await runInvestigation({
        variant: 'candidate-a',
        maxExperiments: 1,
        provider: adaptiveProvider,
        simulator: sim
      });

      expect(attempts).toBe(2);
      expect(receivedFeedback).toBeDefined();
      expect(receivedFeedback![0]).toContain('Parse failed on attempt 1');
      expect(record.experiments.length).toBe(1);
      expect(record.experiments[0]?.experiment.hypothesis).toBe('Valid hypothesis');
    });

    it('handles provider validationError by providing bounded correction feedback', async () => {
      let proposeCalls = 0;
      let feedbackReceived: string[] | undefined;

      const providerWithValidationError: ExperimentProvider = {
        kind: 'meta',
        model: 'muse-wonder-1.0',
        propose: async (context: ProviderContext): Promise<ProviderReply> => {
          proposeCalls++;
          if (proposeCalls === 1) {
            return {
              experiment: null,
              validationError: 'Model response was truncated due to max_tokens limit',
              usage: { inputTokens: 100, outputTokens: 4096, estimatedCostUsd: 0.08 }
            };
          }
          feedbackReceived = context.feedback;
          return {
            experiment: dummyValidExperiment,
            usage: { inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.0014 }
          };
        }
      };

      const sim = createMockSimulator();
      const record = await runInvestigation({
        variant: 'candidate-a',
        maxExperiments: 1,
        provider: providerWithValidationError,
        simulator: sim
      });

      expect(proposeCalls).toBe(2);
      expect(feedbackReceived).toBeDefined();
      expect(feedbackReceived![0]).toContain('truncated due to max_tokens limit');
      expect(record.experiments.length).toBe(1);
      expect(record.usage.outputTokens).toBe(4146);
    });

    it('ensures fresh simulator execution per proposal', async () => {
      const tracker = { calls: 0 };
      const sim = createMockSimulator({ callCountTracker: tracker });

      let proposals = 0;
      const provider: ExperimentProvider = {
        kind: 'mock',
        model: 'spy',
        propose: async (): Promise<ProviderReply> => {
          proposals++;
          if (proposals <= 3) {
            return {
              experiment: { hypothesis: `Exp ${proposals}`, expectedInvariant: 'inv', steps: [] },
              usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 }
            };
          }
          return { experiment: null, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } };
        }
      };

      const record = await runInvestigation({
        variant: 'clean',
        maxExperiments: 3,
        provider,
        simulator: sim
      });

      expect(record.experiments.length).toBe(3);
      expect(tracker.calls).toBe(3);
    });

    it('rejects candidate finding if violation is also present on clean control (same-invariant comparison)', async () => {
      const genericViolation: Violation = {
        id: 'gen-1',
        invariant: 'bad_test_payload',
        message: 'Fails on all variants',
        step: 1,
        evidence: {}
      };

      // Both candidate-a and clean produce the same violation
      const sim = createMockSimulator({
        violationsByVariant: {
          'candidate-a': [genericViolation],
          'candidate-b': [],
          'clean': [genericViolation]
        }
      });

      const provider: ExperimentProvider = {
        kind: 'mock',
        model: 'spy',
        propose: async (): Promise<ProviderReply> => {
          return {
            experiment: dummyValidExperiment,
            usage: { inputTokens: 10, outputTokens: 10, estimatedCostUsd: 0.0001 }
          };
        }
      };

      const record = await runInvestigation({
        variant: 'candidate-a',
        maxExperiments: 1,
        provider,
        simulator: sim
      });

      expect(record.experiments.length).toBe(1);
      const expRec = record.experiments[0]!;
      expect(expRec.replayVerified).toBe(true);
      expect(expRec.cleanControlPassed).toBe(false);
      expect(record.findings.length).toBe(0);
    });
  });

  describe('Invariant: Evidence equivalence', () => {
    it('changed trace but same violation text: fails replay verification and does not confirm finding', async () => {
      const violation: Violation = {
        id: 'v1',
        invariant: 'credit_limit_respected',
        message: 'Credit exceeded',
        step: 2,
        evidence: {}
      };

      let executionCalls = 0;
      const sim: SimulatorApi = {
        getContract: () => dummyContract,
        getSourceBundle: () => dummySource,
        parseExperiment: (input: unknown) => input as Experiment,
        executeExperiment: (exp: Experiment, variant: TargetVariant): ExperimentResult => {
          executionCalls++;
          if (variant === 'candidate-a') {
            if (executionCalls === 1) {
              // Initial execution trace
              return {
                schemaVersion: 1,
                experiment: exp,
                sourceHash: dummySource.hash,
                trace: [{ step: 1, time: 1, action: 'send', outcome: 'delivered', state: {} }],
                snapshot: { balance: 100 },
                violations: [violation],
                rejections: [],
                valid: true
              };
            } else {
              // Replay execution: same violation text, but different trace!
              return {
                schemaVersion: 1,
                experiment: exp,
                sourceHash: dummySource.hash,
                trace: [{ step: 1, time: 1, action: 'send', outcome: 'reordered', state: {} }],
                snapshot: { balance: 100 },
                violations: [violation],
                rejections: [],
                valid: true
              };
            }
          }
          // Clean control returns clean
          return {
            schemaVersion: 1,
            experiment: exp,
            sourceHash: dummySource.hash,
            trace: [],
            snapshot: {},
            violations: [],
            rejections: [],
            valid: true
          };
        }
      };

      const provider: ExperimentProvider = {
        kind: 'mock',
        model: 'spy',
        propose: async (): Promise<ProviderReply> => ({
          experiment: dummyValidExperiment,
          usage: { inputTokens: 5, outputTokens: 5, estimatedCostUsd: 0.0001 }
        })
      };

      const record = await runInvestigation({
        variant: 'candidate-a',
        maxExperiments: 1,
        provider,
        simulator: sim
      });

      expect(record.experiments.length).toBe(1);
      const expRec = record.experiments[0]!;
      expect(expRec.replayVerified).toBe(false);
      expect(record.findings.length).toBe(0);
    });

    it('same invariant on clean with different message: fails clean control comparison by invariant ID', async () => {
      const candidateViolation: Violation = {
        id: 'c1',
        invariant: 'credit_limit_respected',
        message: 'Exceeded credit by $500 on candidate',
        step: 2,
        evidence: { overage: 500 }
      };

      const cleanViolation: Violation = {
        id: 'cl1',
        invariant: 'credit_limit_respected',
        message: 'Exceeded credit by $100 on clean control (different text)',
        step: 2,
        evidence: { overage: 100 }
      };

      const sim: SimulatorApi = {
        getContract: () => dummyContract,
        getSourceBundle: () => dummySource,
        parseExperiment: (input: unknown) => input as Experiment,
        executeExperiment: (exp: Experiment, variant: TargetVariant): ExperimentResult => {
          if (variant === 'candidate-a') {
            return {
              schemaVersion: 1,
              experiment: exp,
              sourceHash: dummySource.hash,
              trace: [{ step: 1, time: 1, action: 'send', outcome: 'delivered', state: {} }],
              snapshot: {},
              violations: [candidateViolation],
              rejections: [],
              valid: true
            };
          }
          // Clean variant also violates credit_limit_respected, but with different message text!
          return {
            schemaVersion: 1,
            experiment: exp,
            sourceHash: dummySource.hash,
            trace: [{ step: 1, time: 1, action: 'send', outcome: 'delivered', state: {} }],
            snapshot: {},
            violations: [cleanViolation],
            rejections: [],
            valid: true
          };
        }
      };

      const provider: ExperimentProvider = {
        kind: 'mock',
        model: 'spy',
        propose: async (): Promise<ProviderReply> => ({
          experiment: dummyValidExperiment,
          usage: { inputTokens: 5, outputTokens: 5, estimatedCostUsd: 0.0001 }
        })
      };

      const record = await runInvestigation({
        variant: 'candidate-a',
        maxExperiments: 1,
        provider,
        simulator: sim
      });

      expect(record.experiments.length).toBe(1);
      const expRec = record.experiments[0]!;
      expect(expRec.replayVerified).toBe(true);
      // Clean control MUST FAIL because credit_limit_respected is violated on clean too!
      expect(expRec.cleanControlPassed).toBe(false);
      expect(record.findings.length).toBe(0);
    });

    it('repeated transient same invariant: de-duplicates findings by invariant ID', async () => {
      const v1: Violation = {
        id: 'v1',
        invariant: 'credit_limit_respected',
        message: 'First credit violation',
        step: 1,
        evidence: {}
      };
      const v2: Violation = {
        id: 'v2',
        invariant: 'credit_limit_respected',
        message: 'Second credit violation later in run',
        step: 3,
        evidence: {}
      };

      const sim: SimulatorApi = {
        getContract: () => dummyContract,
        getSourceBundle: () => dummySource,
        parseExperiment: (input: unknown) => input as Experiment,
        executeExperiment: (exp: Experiment, variant: TargetVariant): ExperimentResult => {
          if (variant === 'candidate-a') {
            return {
              schemaVersion: 1,
              experiment: exp,
              sourceHash: dummySource.hash,
              trace: [{ step: 1, time: 1, action: 'step', outcome: 'ok', state: {} }],
              snapshot: {},
              violations: [v1, v2], // two violations on same invariant
              rejections: [],
              valid: true
            };
          }
          return {
            schemaVersion: 1,
            experiment: exp,
            sourceHash: dummySource.hash,
            trace: [],
            snapshot: {},
            violations: [],
            rejections: [],
            valid: true
          };
        }
      };

      const provider: ExperimentProvider = {
        kind: 'mock',
        model: 'spy',
        propose: async (): Promise<ProviderReply> => ({
          experiment: dummyValidExperiment,
          usage: { inputTokens: 5, outputTokens: 5, estimatedCostUsd: 0.0001 }
        })
      };

      const record = await runInvestigation({
        variant: 'candidate-a',
        maxExperiments: 1,
        provider,
        simulator: sim
      });

      expect(record.experiments.length).toBe(1);
      // Exactly 1 deduplicated finding for credit_limit_respected
      expect(record.findings.length).toBe(1);
      expect(record.findings[0]?.violation.invariant).toBe('credit_limit_respected');
      // Detailed trace violations are still recorded in experiment result
      expect(record.experiments[0]?.result.violations.length).toBe(2);
    });

    it('source drift: stops safely if source bundle hash changes during run', async () => {
      let getSourceCalls = 0;
      const sim: SimulatorApi = {
        getContract: () => dummyContract,
        getSourceBundle: () => {
          getSourceCalls++;
          if (getSourceCalls === 1) {
            return { hash: 'initial-hash', files: [] };
          }
          // Changed source hash on subsequent call (source drift)
          return { hash: 'drifted-hash', files: [] };
        },
        parseExperiment: (input: unknown) => input as Experiment,
        executeExperiment: () => {
          throw new Error('Should not execute after drift');
        }
      };

      const provider: ExperimentProvider = {
        kind: 'mock',
        model: 'spy',
        propose: async (): Promise<ProviderReply> => ({
          experiment: dummyValidExperiment,
          usage: { inputTokens: 5, outputTokens: 5, estimatedCostUsd: 0.0001 }
        })
      };

      const record = await runInvestigation({
        variant: 'candidate-a',
        maxExperiments: 2,
        provider,
        simulator: sim
      });

      expect(record.status).toBe('failed');
      expect(record.stopReason).toContain('Source drift');
      expect(record.errors.some(e => e.includes('Source drift'))).toBe(true);
    });

    it('simulation exception: catches unexpected simulator errors and preserves record safely', async () => {
      const sim: SimulatorApi = {
        getContract: () => dummyContract,
        getSourceBundle: () => dummySource,
        parseExperiment: (input: unknown) => input as Experiment,
        executeExperiment: () => {
          throw new Error('Venue panic: segmentation fault in simulated memory');
        }
      };

      const provider: ExperimentProvider = {
        kind: 'mock',
        model: 'spy',
        propose: async (): Promise<ProviderReply> => ({
          experiment: dummyValidExperiment,
          usage: { inputTokens: 5, outputTokens: 5, estimatedCostUsd: 0.0001 }
        })
      };

      const record = await runInvestigation({
        variant: 'candidate-a',
        maxExperiments: 2,
        provider,
        simulator: sim
      });

      expect(record.status).toBe('failed');
      expect(record.stopReason).toContain('Simulator exception');
      expect(record.errors.some(e => e.includes('Venue panic'))).toBe(true);
      expect(record.finishedAt).toBeDefined();
    });
  });

  describe('Cancellation and Finite Bounds', () => {
    it('handles pre-aborted signal cleanly without running proposals', async () => {
      const controller = new AbortController();
      controller.abort();

      const proposeSpy = vi.fn();
      const provider: ExperimentProvider = {
        kind: 'mock',
        model: 'spy',
        propose: proposeSpy
      };

      const sim = createMockSimulator();
      const record = await runInvestigation({
        variant: 'candidate-a',
        provider,
        signal: controller.signal,
        simulator: sim
      });

      expect(record.status).toBe('cancelled');
      expect(record.stopReason).toContain('before start');
      expect(proposeSpy).not.toHaveBeenCalled();
    });

    it('handles cancellation during provider proposal', async () => {
      const controller = new AbortController();
      const provider: ExperimentProvider = {
        kind: 'mock',
        model: 'spy',
        propose: async (_context, signal): Promise<ProviderReply> => {
          controller.abort();
          if (signal?.aborted) {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            throw err;
          }
          return { experiment: null, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } };
        }
      };

      const sim = createMockSimulator();
      const record = await runInvestigation({
        variant: 'candidate-a',
        provider,
        signal: controller.signal,
        simulator: sim
      });

      expect(record.status).toBe('cancelled');
      expect(record.stopReason).toContain('during provider proposal');
    });

    it('cancels after late response, preventing experiment dispatch and preserving earlier results', async () => {
      const controller = new AbortController();
      let callCount = 0;

      const provider: ExperimentProvider = {
        kind: 'mock',
        model: 'spy',
        propose: async (): Promise<ProviderReply> => {
          callCount++;
          if (callCount === 1) {
            return {
              experiment: dummyValidExperiment,
              usage: { inputTokens: 5, outputTokens: 5, estimatedCostUsd: 0.00005 }
            };
          }
          controller.abort();
          return {
            experiment: { hypothesis: 'Late Exp', expectedInvariant: 'inv', steps: [] },
            usage: { inputTokens: 5, outputTokens: 5, estimatedCostUsd: 0.00005 }
          };
        }
      };

      const simTracker = { calls: 0 };
      const sim = createMockSimulator({ callCountTracker: simTracker });

      const record = await runInvestigation({
        variant: 'candidate-a',
        maxExperiments: 3,
        provider,
        signal: controller.signal,
        simulator: sim
      });

      expect(record.status).toBe('cancelled');
      expect(simTracker.calls).toBe(1);
      expect(record.experiments.length).toBe(1);
    });

    it('stops at finite experiment bound without claiming correctness', async () => {
      const provider: ExperimentProvider = {
        kind: 'mock',
        model: 'infinite-proposer',
        propose: async (ctx): Promise<ProviderReply> => {
          return {
            experiment: { hypothesis: `Exp ${ctx.experimentNumber}`, expectedInvariant: 'inv', steps: [] },
            usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.00001 }
          };
        }
      };

      const sim = createMockSimulator();
      const record = await runInvestigation({
        variant: 'clean',
        maxExperiments: 3,
        provider,
        simulator: sim
      });

      expect(record.status).toBe('completed');
      expect(record.experiments.length).toBe(3);
      expect(record.findings.length).toBe(0);
      expect(record.stopReason).toContain('does not imply correctness');
    });
  });

  describe('Auditing and Immutable Snapshots', () => {
    it('emits immutable snapshots on onUpdate and records provenance in contextAudit', async () => {
      const updates: InvestigationRecord[] = [];
      const sim = createMockSimulator();
      const provider = new MockProvider();

      const record = await runInvestigation({
        variant: 'candidate-a',
        maxExperiments: 2,
        provider,
        simulator: sim,
        onUpdate: (snap) => {
          updates.push(snap);
          (snap as unknown as { mutated?: boolean }).mutated = true;
        }
      });

      expect(updates.length).toBeGreaterThan(1);
      expect((record as unknown as { mutated?: boolean }).mutated).toBeUndefined();

      expect(record.contextAudit).toBeDefined();
      expect(record.contextAudit.sourcePaths).toEqual(['engine.ts']);
      expect(record.contextAudit.contractHash).toHaveLength(64);
      expect(record.contextAudit.contractHash).toBe(computeContractHash(sim.getContract()));
      expect(record.contextAudit.promptVersion).toBe('3.1');
      expect(record.contextAudit.promptTemplateHash).toBeDefined();
    });
  });

  describe('Real Simulator Integration', () => {
    it('runs MockProvider against real simulator on candidate-a and finds duplicate defect', async () => {
      const provider = new MockProvider();
      const record = await runInvestigation({
        variant: 'candidate-a',
        maxExperiments: 3,
        provider
      });

      expect(record.status).toBe('completed');
      expect(record.experiments.length).toBeGreaterThanOrEqual(2);
      expect(record.findings.length).toBeGreaterThan(0);
      expect(record.findings[0]?.reproduced).toBe(true);
      expect(record.findings[0]?.cleanControlPassed).toBe(true);
    });

    it('runs MockProvider against real simulator on clean variant without false findings', async () => {
      const provider = new MockProvider();
      const record = await runInvestigation({
        variant: 'clean',
        maxExperiments: 3,
        provider
      });

      expect(record.status).toBe('completed');
      expect(record.findings.length).toBe(0);
    });
  });
});
