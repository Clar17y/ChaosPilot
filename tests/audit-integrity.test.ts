import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { runInvestigation, type SimulatorApi } from '../src/investigation/index.ts';
import { MetaProvider } from '../src/providers/meta.ts';
import { BudgetLedger } from '../src/providers/budget.ts';
import { canonicalJson } from '../src/evidence.ts';
import type { Experiment, ExperimentProvider, ProviderContext } from '../src/domain.ts';

const plan: Experiment = { hypothesis: 'Probe', expectedInvariant: 'quantity', steps: [{ op: 'drain' }] };
const context: ProviderContext = {
  contract: { name: 'Test', description: '', operations: [], messages: [], limits: {}, invariants: [] },
  source: { hash: 's', files: [] }, history: [], experimentNumber: 1, maxExperiments: 1
};
const simulator: SimulatorApi = {
  getContract: () => context.contract,
  getSourceBundle: () => context.source,
  parseExperiment: () => plan,
  executeExperiment: () => ({ schemaVersion: 1, experiment: plan, sourceHash: 's', trace: [], snapshot: {}, violations: [], rejections: [], valid: true })
};
let directory: string;
let ledgerPath: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chaospilot-audit-'));
  ledgerPath = path.join(directory, 'ledger.json');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

it('does not invent an observed request for a legacy provider', async () => {
  const provider: ExperimentProvider = {
    kind: 'mock', model: 'legacy',
    propose: async () => ({ experiment: plan, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } })
  };
  const result = await runInvestigation({ variant: 'clean', maxExperiments: 1, provider, simulator });
  expect(result.proposalAttempts?.[0]?.request).toBeUndefined();
  expect(result.proposalAttempts?.[0]?.requestSent).toBeUndefined();
});

it('keeps an unannotated abort network state and cost unknown', async () => {
  const provider: ExperimentProvider = {
    kind: 'meta', model: 'legacy-remote', propose: async () => { throw new DOMException('Aborted after possible send', 'AbortError'); }
  };
  const result = await runInvestigation({ variant: 'clean', provider, simulator });
  expect(result.proposalAttempts?.[0]).toMatchObject({ status: 'cancelled', usageKnown: false });
  expect(result.proposalAttempts?.[0]?.requestSent).toBeUndefined();
});

it.each([NaN, Infinity, -1, 1.5, 61])('rejects an invalid proposal cap before invoking a provider: %s', async cap => {
  const propose = vi.fn();
  await expect(runInvestigation({ variant: 'clean', provider: { kind: 'mock', model: 'm', propose }, simulator, maxProposalAttempts: cap })).rejects.toThrow(/maxProposalAttempts/);
  expect(propose).not.toHaveBeenCalled();
});

it('honours a zero proposal cap without spending or calling a provider', async () => {
  const propose = vi.fn();
  const result = await runInvestigation({ variant: 'clean', provider: { kind: 'mock', model: 'm', propose }, simulator, maxProposalAttempts: 0 });
  expect(propose).not.toHaveBeenCalled();
  expect(result.proposalAttempts).toEqual([]);
});

it('redacts a configured key from source data before sending and hashing the prompt', async () => {
  let body = '';
  const provider = new MetaProvider({
    apiKey: 'PRIVATE_TEST_TOKEN', ledgerPath,
    fetchFn: async (_input, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(plan) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    }
  });
  const reply = await provider.propose({ ...context, source: { hash: 'key-source', files: [{ path: 'engine.js', content: 'PRIVATE_TEST_TOKEN' }] } });
  expect(body).not.toContain('PRIVATE_TEST_TOKEN');
  expect(JSON.stringify(reply.requestAudit)).not.toContain('PRIVATE_TEST_TOKEN');
  expect(reply.requestAudit?.requestHash).toBe(createHash('sha256').update(body).digest('hex'));
  const sent = JSON.parse(body);
  expect(reply.requestAudit?.promptHash).toBe(createHash('sha256').update(canonicalJson({ systemMessage: sent.messages[0].content, userMessage: sent.messages[1].content })).digest('hex'));
});

it('retains a safe visible response when usage is invalid', async () => {
  const provider = new MetaProvider({
    apiKey: 'PRIVATE_TEST_TOKEN', ledgerPath,
    fetchFn: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'PRIVATE_TEST_TOKEN' } }] }))
  });
  const result = await runInvestigation({ variant: 'clean', provider, simulator });
  expect(result.proposalAttempts?.[0]).toMatchObject({ status: 'failed', requestSent: true, usageKnown: false, response: { content: '[REDACTED_API_KEY]' } });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_TEST_TOKEN');
});

it('preserves reported usage once if allowance settlement fails after a response', async () => {
  const ledger = new BudgetLedger(ledgerPath, 5);
  vi.spyOn(ledger, 'commit').mockImplementation(() => { throw new Error('Simulated settlement failure'); });
  const provider = new MetaProvider({
    apiKey: 'test-only', ledger,
    fetchFn: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(plan) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }))
  });
  const result = await runInvestigation({ variant: 'clean', provider, simulator });
  expect(result.status).toBe('failed');
  expect(result.proposalAttempts?.[0]).toMatchObject({ requestSent: true, usageKnown: true, usage: { inputTokens: 20, outputTokens: 10 }, response: { finishReason: 'stop' } });
  expect(result.usage.inputTokens).toBe(20);
  expect(result.usage.outputTokens).toBe(10);
  expect(ledger.getStatus().spentUsd).toBeGreaterThan(0);
});

it('rejects malformed non-text completion content and redacts finish-reason metadata', async () => {
  const provider = new MetaProvider({
    apiKey: 'PRIVATE_TEST_TOKEN', ledgerPath,
    fetchFn: async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'PRIVATE_TEST_TOKEN', message: { content: { ...plan, hypothesis: 'PRIVATE_TEST_TOKEN' } } }],
      usage: { prompt_tokens: 10, completion_tokens: 10 }
    }))
  });
  const reply = await provider.propose(context);
  expect(reply.experiment).toBeNull();
  expect(reply.validationError).toMatch(/content must be text/);
  expect(JSON.stringify(reply)).not.toContain('PRIVATE_TEST_TOKEN');
});
