import { describe, expect, it } from 'vitest';
import { runInvestigation, type SimulatorApi } from '../src/investigation/index.ts';
import type { Experiment, ExperimentProvider, ExperimentResult } from '../src/domain.ts';

describe('finding evidence boundaries', () => {
  it.each(['throws', 'invalid'] as const)('does not confirm a finding when the clean control %s', async failure => {
    const experiment: Experiment = {
      hypothesis: 'An execution is applied twice',
      expectedInvariant: 'execution_idempotency',
      steps: [{ op: 'drain' }]
    };
    const result: ExperimentResult = {
      schemaVersion: 1,
      experiment,
      sourceHash: 'candidate-source',
      trace: [],
      snapshot: {},
      violations: [{
        id: 'duplicate', invariant: 'execution_idempotency', message: 'Applied twice', step: 0, evidence: {}
      }],
      rejections: [],
      valid: true
    };
    const simulator: SimulatorApi = {
      getContract: () => ({
        name: 'Evidence boundary', description: '', operations: [], messages: [], limits: {},
        invariants: [{ id: 'execution_idempotency', description: 'Apply once' }]
      }),
      getSourceBundle: () => ({ hash: 'candidate-source', files: [] }),
      parseExperiment: () => experiment,
      executeExperiment: (_experiment, variant) => {
        if (variant !== 'clean') return structuredClone(result);
        if (failure === 'throws') throw new Error('Control failed to execute');
        return { ...structuredClone(result), valid: false, violations: [], rejections: [{ step: 0, reason: 'Invalid control' }] };
      }
    };
    const provider: ExperimentProvider = {
      kind: 'mock', model: 'evidence-test',
      propose: async () => ({ experiment, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } })
    };

    const record = await runInvestigation({ variant: 'candidate-a', maxExperiments: 1, provider, simulator });

    expect(record.experiments).toHaveLength(1);
    expect(record.experiments[0]?.cleanControlPassed).toBe(false);
    expect(record.findings).toEqual([]);
  });
});
