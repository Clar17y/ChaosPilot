import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInvestigation, type SimulatorApi } from '../src/investigation/index.ts';
import { MetaProvider } from '../src/providers/meta.ts';
import { MockProvider } from '../src/providers/mock.ts';
import type {
  Experiment,
  ExperimentProvider,
  ExperimentResult,
  InvestigationRecord,
  ProposalAttempt,
  ProviderContext,
  ProviderReply,
  ProviderRequestAudit,
  SourceBundle,
  SystemContract,
  TargetVariant
} from '../src/domain.ts';

let temporaryDirectory: string;
let ledgerPath: string;
beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'chaospilot-proposal-audit-'));
  ledgerPath = path.join(temporaryDirectory, 'ledger.json');
});
afterEach(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

describe('Proposal Attempts Audit & Lifecycle', () => {
  const dummyContract: SystemContract = {
    name: 'AuditTestVenue',
    description: 'Contract for audit testing',
    operations: [],
    messages: [],
    invariants: [{ id: 'credit_limit_respected', description: 'Credit limit invariant' }],
    limits: { maxExposure: 5000 }
  };

  const dummySource: SourceBundle = {
    hash: 'audit-source-hash-1',
    files: [{ path: 'engine.ts', content: 'export const active = true;' }]
  };

  const validExp: Experiment = {
    hypothesis: 'Testing single-variable execution probe',
    expectedInvariant: 'credit_limit_respected',
    steps: [{ op: 'drain' }]
  };

  function createTestSimulator(options: {
    failParseForIndices?: number[];
    validSimulatorResult?: boolean;
  } = {}): SimulatorApi {
    let parseCount = 0;
    return {
      getContract: () => dummyContract,
      getSourceBundle: (_variant: TargetVariant) => dummySource,
      parseExperiment: (input: unknown) => {
        parseCount++;
        if (options.failParseForIndices?.includes(parseCount)) {
          throw new Error(`Simulator parse syntax rejection on proposal #${parseCount}`);
        }
        if (!input || typeof input !== 'object') {
          throw new Error('Experiment must be an object');
        }
        return input as Experiment;
      },
      executeExperiment: (experiment: Experiment, _variant: TargetVariant): ExperimentResult => {
        return {
          schemaVersion: 1,
          experiment,
          sourceHash: dummySource.hash,
          trace: [],
          snapshot: { state: 'ok' },
          violations: [],
          rejections: options.validSimulatorResult === false ? [{ step: 0, reason: 'Business rejection' }] : [],
          valid: options.validSimulatorResult ?? true
        };
      }
    };
  }

  describe('Durable proposalAttempt creation and status transitions', () => {
    it('creates initial pending attempt before provider call and sets executed status with experimentIndex', async () => {
      let pendingObserved = false;
      const provider: ExperimentProvider = {
        kind: 'mock',
        model: 'audit-model-1',
        propose: async (_ctx, _sig, onRequestAudit) => {
          if (onRequestAudit) {
            await onRequestAudit({
              promptVersion: '2.0',
              promptTemplateHash: 'tmpl-hash-1',
              promptHash: 'p-hash-1',
              requestHash: 'r-hash-1',
              systemMessage: 'sys',
              userMessage: 'usr',
              configuration: { model: 'audit-model-1' }
            });
          }
          return {
            experiment: validExp,
            usage: { inputTokens: 50, outputTokens: 25, estimatedCostUsd: 0.0002 },
            requestSent: true
          };
        }
      };

      const record = await runInvestigation({
        variant: 'clean',
        maxExperiments: 1,
        provider,
        simulator: createTestSimulator(),
        onUpdate: (snapshot) => {
          const attempt = snapshot.proposalAttempts?.[0];
          if (attempt && attempt.status === 'pending') {
            pendingObserved = true;
            expect(attempt.finishedAt).toBeUndefined();
            expect(attempt.durationMs).toBeUndefined();
            expect(attempt.index).toBe(1);
            expect(attempt.experimentNumber).toBe(1);
            expect(attempt.correctionNumber).toBe(0);
          }
        }
      });

      expect(pendingObserved).toBe(true);
      expect(record.proposalAttempts).toBeDefined();
      expect(record.proposalAttempts).toHaveLength(1);

      const attempt = record.proposalAttempts![0]!;
      expect(attempt.status).toBe('executed');
      expect(attempt.index).toBe(1);
      expect(attempt.experimentNumber).toBe(1);
      expect(attempt.correctionNumber).toBe(0);
      expect(attempt.experimentIndex).toBe(1);
      expect(attempt.requestSent).toBe(true);
      expect(attempt.usageKnown).toBe(true);
      expect(attempt.usage).toEqual({ inputTokens: 50, outputTokens: 25, estimatedCostUsd: 0.0002 });
      expect(typeof attempt.startedAt).toBe('string');
      expect(typeof attempt.finishedAt).toBe('string');
      expect(typeof attempt.durationMs).toBe('number');
      expect(attempt.durationMs).toBeGreaterThanOrEqual(0);
      expect(attempt.request?.requestHash).toBe('r-hash-1');
    });

    it('marks attempt status as executed even if simulator result.valid is false', async () => {
      const provider: ExperimentProvider = {
        kind: 'mock',
        model: 'audit-model-2',
        propose: async () => ({
          experiment: validExp,
          usage: { inputTokens: 10, outputTokens: 10, estimatedCostUsd: 0.0001 }
        })
      };

      const record = await runInvestigation({
        variant: 'clean',
        maxExperiments: 1,
        provider,
        simulator: createTestSimulator({ validSimulatorResult: false })
      });

      expect(record.experiments[0]?.result.valid).toBe(false);
      expect(record.proposalAttempts).toHaveLength(1);
      expect(record.proposalAttempts![0]?.status).toBe('executed');
      expect(record.proposalAttempts![0]?.experimentIndex).toBe(1);
    });

    it('records invalid_response on model validation error and invalid_plan on simulator parse error with retries', async () => {
      let callCount = 0;
      const provider: ExperimentProvider = {
        kind: 'mock',
        model: 'retry-model',
        propose: async () => {
          callCount++;
          if (callCount === 1) {
            return {
              experiment: null,
              usage: { inputTokens: 30, outputTokens: 15, estimatedCostUsd: 0.0001 },
              validationError: 'Model response was truncated due to max_tokens limit'
            };
          } else if (callCount === 2) {
            return {
              experiment: { hypothesis: 'Malformed syntax', expectedInvariant: 'inv', steps: [] },
              usage: { inputTokens: 40, outputTokens: 20, estimatedCostUsd: 0.00015 }
            };
          }
          return {
            experiment: validExp,
            usage: { inputTokens: 50, outputTokens: 25, estimatedCostUsd: 0.0002 }
          };
        }
      };

      const record = await runInvestigation({
        variant: 'clean',
        maxExperiments: 1,
        provider,
        simulator: createTestSimulator({ failParseForIndices: [1] }) // Call 2 fails parse
      });

      expect(record.proposalAttempts).toHaveLength(3);

      // Attempt 1: invalid_response
      const att1 = record.proposalAttempts![0]!;
      expect(att1.index).toBe(1);
      expect(att1.experimentNumber).toBe(1);
      expect(att1.correctionNumber).toBe(0);
      expect(att1.status).toBe('invalid_response');
      expect(att1.error).toContain('truncated');
      expect(att1.usageKnown).toBe(true);

      // Attempt 2: invalid_plan
      const att2 = record.proposalAttempts![1]!;
      expect(att2.index).toBe(2);
      expect(att2.experimentNumber).toBe(1);
      expect(att2.correctionNumber).toBe(1);
      expect(att2.status).toBe('invalid_plan');
      expect(att2.error).toContain('Simulator parse syntax rejection');
      expect(att2.usageKnown).toBe(true);

      // Attempt 3: executed
      const att3 = record.proposalAttempts![2]!;
      expect(att3.index).toBe(3);
      expect(att3.experimentNumber).toBe(1);
      expect(att3.correctionNumber).toBe(2);
      expect(att3.status).toBe('executed');
      expect(att3.experimentIndex).toBe(1);

      // Usage is single-accumulated across all 3 proposals: 30 + 40 + 50 = 120 input tokens
      expect(record.usage.inputTokens).toBe(120);
      expect(record.usage.outputTokens).toBe(60);
      expect(record.usage.estimatedCostUsd).toBeCloseTo(0.00045, 5);
    });

    it('records stopped status when provider explicitly stops', async () => {
      const provider: ExperimentProvider = {
        kind: 'mock',
        model: 'stop-model',
        propose: async () => ({
          experiment: null,
          usage: { inputTokens: 20, outputTokens: 10, estimatedCostUsd: 0.00008 },
          summary: 'Inconclusive: hypotheses exhausted'
        })
      };

      const record = await runInvestigation({
        variant: 'clean',
        maxExperiments: 3,
        provider,
        simulator: createTestSimulator()
      });

      expect(record.proposalAttempts).toHaveLength(1);
      const attempt = record.proposalAttempts![0]!;
      expect(attempt.status).toBe('stopped');
      expect(record.stopReason).toBe('Inconclusive: hypotheses exhausted');
      expect(record.status).toBe('completed');
    });
  });

  describe('Failure, spend accounting and callback safety', () => {
    it('records pre-network callback failure without spending budget or network calls', async () => {
      let networkFetchAttempted = false;
      const provider = new MetaProvider({
        ledgerPath,
        apiKey: 'test-secret-key-12345',
        fetchFn: (async () => {
          networkFetchAttempted = true;
          return new Response(JSON.stringify({ choices: [] }));
        }) as typeof fetch
      });

      const badObserver = () => {
        throw new Error('Observer callback synchronous failure before network');
      };

      const record = await runInvestigation({
        variant: 'clean',
        maxExperiments: 2,
        provider: {
          kind: 'meta',
          model: provider.model,
          configuration: provider.configuration,
          propose: async (ctx, sig, onAudit) => {
            // Trigger failure in audit observer
            return provider.propose(ctx, sig, async (audit) => {
              if (onAudit) await onAudit(audit);
              badObserver();
            });
          }
        },
        simulator: createTestSimulator()
      });

      expect(networkFetchAttempted).toBe(false);
      expect(record.status).toBe('failed');
      expect(record.proposalAttempts).toHaveLength(1);

      const attempt = record.proposalAttempts![0]!;
      expect(attempt.status).toBe('failed');
      expect(attempt.requestSent).toBe(false);
      expect(attempt.usageKnown).toBe(true);
      expect(attempt.usage).toEqual({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
      expect(attempt.error).toContain('Observer callback synchronous failure');
    });

    it('preserves unknown usage and requestSent: true on network / timeout errors', async () => {
      const provider: ExperimentProvider = {
        kind: 'mock',
        model: 'network-err-model',
        propose: async () => {
          const err = new Error('HTTP 500 Internal Server Error');
          (err as Error & { requestSent?: boolean }).requestSent = true;
          throw err;
        }
      };

      const record = await runInvestigation({
        variant: 'clean',
        maxExperiments: 2,
        provider,
        simulator: createTestSimulator()
      });

      expect(record.status).toBe('failed');
      expect(record.proposalAttempts).toHaveLength(1);

      const attempt = record.proposalAttempts![0]!;
      expect(attempt.status).toBe('failed');
      expect(attempt.requestSent).toBe(true);
      expect(attempt.usageKnown).toBe(false);
      expect(attempt.error).toContain('HTTP 500');
    });

    it('redacts sensitive API keys from audit, errors, and responses', async () => {
      const secretKey = 'sk-live-chaos-pilot-secret-token-999';
      const provider = new MetaProvider({
        ledgerPath,
        apiKey: secretKey,
        fetchFn: (async () => {
          return new Response(JSON.stringify({
            choices: [{
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  hypothesis: `Hypothesis containing leaked ${secretKey}`,
                  expectedInvariant: 'credit_limit_respected',
                  steps: [{ op: 'drain' }]
                })
              }
            }],
            usage: { prompt_tokens: 100, completion_tokens: 50 }
          }));
        }) as typeof fetch
      });

      const record = await runInvestigation({
        variant: 'clean',
        maxExperiments: 1,
        provider,
        simulator: createTestSimulator()
      });

      const serializedRecord = JSON.stringify(record);
      expect(serializedRecord).not.toContain(secretKey);
      expect(serializedRecord).toContain('[REDACTED_API_KEY]');

      const attempt = record.proposalAttempts![0]!;
      expect(attempt.response?.content).toContain('[REDACTED_API_KEY]');
      expect(attempt.response?.content).not.toContain(secretKey);
    });
  });

  describe('Global cap maxProposalAttempts and cancellation', () => {
    it('honours maxProposalAttempts strictly even when proposals are rejected/invalid', async () => {
      let callCount = 0;
      const provider: ExperimentProvider = {
        kind: 'mock',
        model: 'invalid-model',
        propose: async () => {
          callCount++;
          return {
            experiment: null,
            validationError: `Format error #${callCount}`,
            usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.00005 }
          };
        }
      };

      const record = await runInvestigation({
        variant: 'clean',
        maxExperiments: 5,
        maxProposalAttempts: 2, // Strict global cap of 2
        provider,
        simulator: createTestSimulator()
      });

      expect(callCount).toBe(2);
      expect(record.proposalAttempts).toHaveLength(2);
      expect(record.experiments).toHaveLength(0);
      expect(record.status).toBe('failed');
      expect(record.stopReason).toContain('Maximum proposal attempts reached');
      expect(record.contextAudit.maxProposalAttempts).toBe(2);
    });

    it('stops before experiment execution when signal is aborted after late proposal', async () => {
      const controller = new AbortController();
      let simExecuted = false;

      const provider: ExperimentProvider = {
        kind: 'mock',
        model: 'late-model',
        propose: async () => {
          // Abort during/after proposal
          controller.abort();
          return {
            experiment: validExp,
            usage: { inputTokens: 20, outputTokens: 10, estimatedCostUsd: 0.0001 }
          };
        }
      };

      const sim: SimulatorApi = {
        getContract: () => dummyContract,
        getSourceBundle: () => dummySource,
        parseExperiment: (exp) => exp as Experiment,
        executeExperiment: () => {
          simExecuted = true;
          throw new Error('Should not have reached simulator');
        }
      };

      const record = await runInvestigation({
        variant: 'clean',
        maxExperiments: 3,
        provider,
        simulator: sim,
        signal: controller.signal
      });

      expect(simExecuted).toBe(false);
      expect(record.status).toBe('cancelled');
      expect(record.stopReason).toContain('aborted');
      expect(record.proposalAttempts).toHaveLength(1);
      expect(record.proposalAttempts![0]?.status).toBe('cancelled');
    });

    it('emits immutable snapshots so mutations inside onUpdate do not pollute engine record', async () => {
      const snapshots: InvestigationRecord[] = [];
      const provider = new MockProvider();

      const record = await runInvestigation({
        variant: 'clean',
        maxExperiments: 1,
        provider,
        simulator: createTestSimulator(),
        onUpdate: (snap) => {
          // Mutate snapshot aggressively
          (snap as unknown as { polluted: boolean }).polluted = true;
          if (snap.proposalAttempts && snap.proposalAttempts[0]) {
            snap.proposalAttempts[0].status = 'failed';
          }
          snapshots.push(snap);
        }
      });

      expect((record as unknown as { polluted?: boolean }).polluted).toBeUndefined();
      expect(record.proposalAttempts?.[0]?.status).toBe('executed');
    });

    it('maintains compatibility with legacy providers implementing 2-argument propose', async () => {
      // Legacy provider signature propose(context, signal) without onRequestAudit parameter
      const legacyProvider: ExperimentProvider = {
        kind: 'mock',
        model: 'legacy-two-arg-model',
        propose: async (context: ProviderContext, _signal?: AbortSignal) => {
          return {
            experiment: validExp,
            usage: { inputTokens: 15, outputTokens: 10, estimatedCostUsd: 0.00005 }
          };
        }
      };

      const record = await runInvestigation({
        variant: 'clean',
        maxExperiments: 1,
        provider: legacyProvider,
        simulator: createTestSimulator()
      });

      expect(record.proposalAttempts).toHaveLength(1);
      const attempt = record.proposalAttempts![0]!;
      expect(attempt.status).toBe('executed');
      expect(attempt.request).toBeUndefined();
      expect(attempt.requestSent).toBeUndefined();
    });

    it('asks for a shorter complete experiment after truncation and executes a valid retry', async () => {
      const contexts: ProviderContext[] = [];
      const provider: ExperimentProvider = {
        kind: 'meta', model: 'fake',
        propose: async context => {
          contexts.push(structuredClone(context));
          return contexts.length === 1
            ? { experiment: null, validationError: 'Model response was truncated due to max_tokens limit', responseAudit: { finishReason: 'length' }, requestSent: true, usage: { inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.001 } }
            : { experiment: validExp, requestSent: true, usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.0005 } };
        }
      };
      const record = await runInvestigation({ variant: 'clean', maxExperiments: 1, provider, simulator: createTestSimulator() });
      expect(contexts[1]?.feedback?.join(' ')).toContain('shorter COMPLETE JSON experiment');
      expect(record.status).toBe('completed');
      expect(record.experiments).toHaveLength(1);
      expect(record.proposalAttempts?.map(a => a.status)).toEqual(['invalid_response', 'executed']);
      expect(record.usage.estimatedCostUsd).toBeCloseTo(0.0015);
    });

    it('stops after bounded truncation retries without losing earlier completed experiments or usage', async () => {
      let calls = 0;
      const provider: ExperimentProvider = {
        kind: 'meta', model: 'fake', propose: async () => {
          calls++;
          return calls === 1
            ? { experiment: validExp, requestSent: true, usage: { inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.001 } }
            : { experiment: null, validationError: 'Model response was truncated due to max_tokens limit', responseAudit: { finishReason: 'length' }, requestSent: true, usage: { inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.001 } };
        }
      };
      const record = await runInvestigation({ variant: 'clean', maxExperiments: 3, provider, simulator: createTestSimulator() });
      expect(calls).toBe(4);
      expect(record.status).toBe('failed');
      expect(record.stopReason).toContain('truncated');
      expect(record.experiments).toHaveLength(1);
      expect(record.proposalAttempts?.map(a => a.status)).toEqual(['executed', 'invalid_response', 'invalid_response', 'invalid_response']);
      expect(record.proposalAttempts?.slice(1).map(a => a.experimentNumber)).toEqual([2, 2, 2]);
      expect(record.usage).toEqual({ inputTokens: 40, outputTokens: 80, estimatedCostUsd: 0.004 });
    });

    it('reports exhausted proposal limits and cancellation during a retry without inventing an experiment', async () => {
      const controller = new AbortController();
      let calls = 0;
      const provider: ExperimentProvider = {
        kind: 'meta', model: 'fake', propose: async () => {
          calls++;
          if (calls === 1) return { experiment: validExp, requestSent: true, usage: { inputTokens: 2, outputTokens: 3, estimatedCostUsd: 0.001 } };
          if (calls === 2) return { experiment: null, validationError: 'truncated output', requestSent: true, usage: { inputTokens: 2, outputTokens: 3, estimatedCostUsd: 0.001 } };
          controller.abort();
          throw Object.assign(new DOMException('aborted', 'AbortError'), { requestSent: true, usageKnown: false });
        }
      };
      const capped = await runInvestigation({ variant: 'clean', maxExperiments: 3, maxProposalAttempts: 2, provider, simulator: createTestSimulator() });
      expect(capped.status).toBe('failed');
      expect(capped.stopReason).toContain('Maximum proposal attempts');
      expect(capped.experiments).toHaveLength(1);
      calls = 0;
      const cancelled = await runInvestigation({ variant: 'clean', maxExperiments: 3, provider, simulator: createTestSimulator(), signal: controller.signal });
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.experiments).toHaveLength(1);
      expect(cancelled.proposalAttempts?.map(a => a.status)).toEqual(['executed', 'invalid_response', 'cancelled']);
      expect(cancelled.proposalAttempts?.at(-1)).toMatchObject({ requestSent: true, usageKnown: false });
    });

    it('preserves a verified finding at the proposal cap while distinguishing stop-on-finding from continuation', async () => {
      const sim = createTestSimulator();
      const execute = sim.executeExperiment;
      sim.executeExperiment = (experiment, variant) => {
        const result = execute(experiment, variant);
        result.violations = variant === 'clean' ? [] : [{ id: 'v1', invariant: 'credit_limit_respected', message: 'Violation', step: 0, evidence: {} }];
        return result;
      };
      const provider: ExperimentProvider = { kind: 'mock', model: 'fake', propose: async () => ({ experiment: validExp, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } }) };
      const stopOnFinding = await runInvestigation({ variant: 'candidate-a', maxExperiments: 2, maxProposalAttempts: 1, provider, simulator: sim });
      const continued = await runInvestigation({ variant: 'candidate-a', maxExperiments: 2, maxProposalAttempts: 1, continueAfterFindings: true, provider, simulator: sim });
      expect(stopOnFinding.status).toBe('completed');
      expect(stopOnFinding.findings).toHaveLength(1);
      expect(continued.status).toBe('failed');
      expect(continued.stopReason).toContain('Maximum proposal attempts');
      expect(continued.experiments).toHaveLength(1);
      expect(continued.findings).toHaveLength(1);
    });
  });
});
