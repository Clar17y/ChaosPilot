import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MetaProvider } from '../src/providers/meta.ts';
import { buildInvestigationPrompt } from '../src/investigation/prompt.ts';
import { canonicalJson } from '../src/evidence.ts';
import type { Experiment, Observation, ProviderContext } from '../src/domain.ts';

let tempDir: string;
beforeEach(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chaospilot-prompt-sizing-')); });
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(tempDir, { recursive: true, force: true }); });

const experiment: Experiment = { hypothesis: 'A meaningful earlier hypothesis', expectedInvariant: 'credit', steps: [{ op: 'drain' }] };
const initial: ProviderContext = {
  contract: { name: 'Test', description: 'Keep this contract', operations: [], messages: [], invariants: [], limits: {} },
  source: { hash: 'source-hash', files: [{ path: 'target.ts', content: 'const importantSource = true;' }] },
  history: [], experimentNumber: 1, maxExperiments: 5
};
function observation(index: number): Observation {
  return {
    experiment: { ...experiment, hypothesis: `Prior hypothesis ${index}` },
    result: { schemaVersion: 1, experiment, sourceHash: 'source-hash', trace: [], snapshot: { target: { detail: 'x'.repeat(6000) } }, violations: [], rejections: [], valid: true }
  };
}
function mockFetch() {
  return vi.fn(async () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(experiment) } }],
    usage: { prompt_tokens: 200, completion_tokens: 20 }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

it('uses the new defaults and honors explicit and environment overrides', () => {
  vi.stubEnv('CHAOSPILOT_MAX_PROMPT_BYTES', undefined);
  vi.stubEnv('CHAOSPILOT_MAX_OUTPUT_TOKENS', undefined);
  expect(new MetaProvider({ apiKey: 'fake' }).configuration).toMatchObject({ maxPromptBytes: 131072, maxOutputTokens: 32768 });
  vi.stubEnv('CHAOSPILOT_MAX_PROMPT_BYTES', '50000');
  vi.stubEnv('CHAOSPILOT_MAX_OUTPUT_TOKENS', '9000');
  expect(new MetaProvider({ apiKey: 'fake' }).configuration).toMatchObject({ maxPromptBytes: 50000, maxOutputTokens: 9000 });
  expect(new MetaProvider({ apiKey: 'fake', maxPromptBytes: 60000, maxOutputTokens: 10000 }).configuration).toMatchObject({ maxPromptBytes: 60000, maxOutputTokens: 10000 });
});

it('accepts the exact request byte limit and rejects a smaller essential prompt without sending or reserving', async () => {
  const prepared = new MetaProvider({ apiKey: 'fake', maxOutputTokens: 32768 }).prepareRequest(initial);
  const send = mockFetch();
  const exact = new MetaProvider({ apiKey: 'fake', maxOutputTokens: 32768, maxPromptBytes: prepared.promptBytes, ledgerPath: path.join(tempDir, 'exact.json'), fetchFn: send as unknown as typeof fetch });
  const reply = await exact.propose(initial);
  expect(reply.requestSent).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  const rejectSend = mockFetch();
  const tooSmall = new MetaProvider({ apiKey: 'fake', maxOutputTokens: 32768, maxPromptBytes: prepared.promptBytes - 1, ledgerPath: path.join(tempDir, 'rejected.json'), fetchFn: rejectSend as unknown as typeof fetch });
  await expect(tooSmall.propose(initial)).rejects.toMatchObject({ requestSent: false, message: expect.stringContaining('exceeds maximum allowed size') });
  expect(rejectSend).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(tempDir, 'rejected.json'))).toBe(false);
});

it('compacts model-visible history deterministically while preserving the request audit and original observations', async () => {
  const context: ProviderContext = { ...initial, history: [0, 1, 2, 3].map(observation), experimentNumber: 5 };
  const original = structuredClone(context.history);
  const baseline = new MetaProvider({ apiKey: 'fake' }).prepareRequest(initial).promptBytes;
  const send = mockFetch();
  const provider = new MetaProvider({ apiKey: 'fake', maxPromptBytes: baseline + 5000, ledgerPath: path.join(tempDir, 'history.json'), fetchFn: send as unknown as typeof fetch });
  const prepared = provider.prepareRequest(context);
  expect(prepared.promptBytes).toBeLessThanOrEqual(baseline + 5000);
  expect(prepared.historyCompaction).toMatchObject({ totalObservations: 4, summarizedObservations: 4, omittedObservations: 0 });
  expect(prepared.userMessage).toContain('HISTORY COMPACTION');
  expect(prepared.userMessage).toContain('steps, snapshots, traces and detailed evidence are omitted');
  expect(prepared.userMessage).toContain('const importantSource = true;');
  expect(prepared.userMessage).toContain('Keep this contract');
  expect(provider.prepareRequest(context)).toEqual(prepared);
  const reply = await provider.propose(context);
  expect(reply.requestAudit?.historyCompaction).toEqual(prepared.historyCompaction);
  expect(reply.requestAudit?.requestHash).toBe(crypto.createHash('sha256').update(prepared.serializedPayload).digest('hex'));
  expect((send.mock.calls[0] as unknown as [string, RequestInit])[1].body).toBe(prepared.serializedPayload);
  expect(context.history).toEqual(original);
});

it('explicitly discloses omitted old observations when even compact summaries exceed the limit', () => {
  const context: ProviderContext = { ...initial, history: [0, 1, 2, 3].map(observation), experimentNumber: 5 };
  const broad = new MetaProvider({ apiKey: 'fake' });
  const payload = JSON.parse(broad.prepareRequest(context).serializedPayload);
  const prompt = buildInvestigationPrompt(context, { start: context.history.length });
  payload.messages[0].content = prompt.systemMessage;
  payload.messages[1].content = prompt.userMessage;
  const limit = Buffer.byteLength(canonicalJson(payload), 'utf8');
  const provider = new MetaProvider({ apiKey: 'fake', maxPromptBytes: limit });
  const prepared = provider.prepareRequest(context);
  expect(prepared.promptBytes).toBeLessThanOrEqual(limit);
  expect(prepared.historyCompaction?.omittedObservations).toBeGreaterThan(0);
  expect(prepared.userMessage).toContain('earlier observations omitted entirely');
  expect(prepared.userMessage).toContain('Do not assume omitted information was assessed');
  expect(context.history).toHaveLength(4);
});

it('distinguishes a shortened audit preview from a completed model response', async () => {
  const longExperiment = { ...experiment, hypothesis: 'x'.repeat(34000) };
  const visible = JSON.stringify(longExperiment);
  const send = vi.fn(async () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: visible } }],
    usage: { prompt_tokens: 200, completion_tokens: 1000 }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const provider = new MetaProvider({ apiKey: 'fake', ledgerPath: path.join(tempDir, 'preview.json'), fetchFn: send as unknown as typeof fetch });
  const reply = await provider.propose(initial);
  expect(reply.experiment?.hypothesis).toHaveLength(34000);
  expect(reply.validationError).toBeUndefined();
  expect(reply.responseAudit).toMatchObject({ finishReason: 'stop', contentTruncated: true, contentLength: visible.length });
  expect(reply.responseAudit?.content).toHaveLength(32768);
});
