import { expect, it } from 'vitest';
import { MetaProvider } from '../src/providers/meta.ts';
import type { Experiment, ProviderContext } from '../src/domain.ts';

it('records bounded model settings without credentials and rejects unsupported reasoning', () => {
  const provider = new MetaProvider({ apiKey: 'not-in-metadata', reasoningEffort: 'low', requestTimeoutMs: 90000 });
  expect(provider.configuration).toMatchObject({ reasoningEffort: 'low', requestTimeoutMs: 90000, maxOutputTokens: 32768, maxPromptBytes: 131072 });
  expect(JSON.stringify(provider.configuration)).not.toContain('not-in-metadata');
  expect(() => new MetaProvider({ reasoningEffort: 'none' })).toThrow(/META_REASONING_EFFORT/);
});

it('provides actual observed business state for the next hypothesis', () => {
  const experiment: Experiment = { hypothesis: 'Partial execution', expectedInvariant: 'credit', steps: [{ op: 'drain' }] };
  const context: ProviderContext = {
    contract: { name: 'Test', description: '', messages: [], operations: [], invariants: [], limits: {} },
    source: { hash: 'test-source', files: [] },
    experimentNumber: 2,
    maxExperiments: 3,
    history: [{
      experiment,
      result: {
        schemaVersion: 1, experiment, sourceHash: 'test-source', trace: [], rejections: [], violations: [], valid: true,
        snapshot: {
          target: { reservedCredit: 600, usedCredit: 400, orders: [{ id: 'o1', filledQuantity: 4 }] },
          logicalTime: 12,
          venue: { hiddenInternalDetail: 'not-an-observable-target-field' }
        }
      }
    }]
  };

  const prompt = new MetaProvider({ apiKey: 'test-only' }).serializePrompt(context).userMessage;

  expect(prompt).toContain('"reservedCredit":600');
  expect(prompt).toContain('"filledQuantity":4');
  expect(prompt).toContain('"logicalTime":12');
  expect(prompt).not.toContain('hiddenInternalDetail');
});
