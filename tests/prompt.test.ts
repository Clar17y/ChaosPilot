import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  PROMPT_VERSION,
  PROMPT_TEMPLATE_HASH,
  buildInvestigationPrompt,
  computePromptHash
} from '../src/investigation/prompt.ts';
import { MetaProvider } from '../src/providers/meta.ts';
import { canonicalJson } from '../src/evidence.ts';
import type { ProviderContext, ProviderRequestAudit, SystemContract, SourceBundle, Experiment } from '../src/domain.ts';

let temporaryDirectory: string;
let ledgerPath: string;
beforeEach(() => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'chaospilot-prompt-audit-'));
  ledgerPath = path.join(temporaryDirectory, 'ledger.json');
});
afterEach(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

describe('Specialised Investigation Brief & Prompt Builder', () => {
  const sampleContract: SystemContract = {
    name: 'TradingVenueContract',
    description: 'System contract for negative testing',
    operations: [{ name: 'send' }, { name: 'fill' }],
    messages: [{ type: 'quote' }, { type: 'credit_limit' }, { type: 'new_order' }],
    invariants: [
      { id: 'credit_limit_respected', description: 'Credit limit must never be exceeded' },
      { id: 'order_lifecycle_coherent', description: 'Order status must advance validly' }
    ],
    limits: { maxExposure: 10000 }
  };

  const sampleSource: SourceBundle = {
    hash: 'bundle-sha-98765',
    files: [
      { path: 'engine.ts', content: 'export function processOrder() { return true; }' },
      { path: 'credit.ts', content: 'export function checkCredit() { return true; }' }
    ]
  };

  const initialContext: ProviderContext = {
    contract: sampleContract,
    source: sampleSource,
    history: [],
    experimentNumber: 1,
    maxExperiments: 5
  };

  describe('Prompt Constants and Pure Builder', () => {
    it('exports PROMPT_VERSION 3.0 and stable PROMPT_TEMPLATE_HASH', () => {
      expect(PROMPT_VERSION).toBe('3.0');
      expect(typeof PROMPT_TEMPLATE_HASH).toBe('string');
      expect(PROMPT_TEMPLATE_HASH).toHaveLength(64);
      expect(PROMPT_TEMPLATE_HASH).toMatch(/^[0-9a-f]{64}$/);
    });

    it('builds deterministic system and user messages', () => {
      const p1 = buildInvestigationPrompt(initialContext);
      const p2 = buildInvestigationPrompt(initialContext);

      expect(p1.systemMessage).toBe(p2.systemMessage);
      expect(p1.userMessage).toBe(p2.userMessage);
      expect(computePromptHash(p1.systemMessage, p1.userMessage)).toBe(
        computePromptHash(p2.systemMessage, p2.userMessage)
      );
    });
  });

  describe('Instruction Brief Requirements', () => {
    it('teaches causal hypotheses, minimal discriminating probes, and expected observation vs invariant', () => {
      const { systemMessage } = buildInvestigationPrompt(initialContext);

      expect(systemMessage).toMatch(/causal.*testable.*hypothes/i);
      expect(systemMessage).toMatch(/minimal.*discriminating/i);
      expect(systemMessage).toMatch(/expected.*observation.*invariant/i);
      expect(systemMessage).toMatch(/single-variable.*probe/i);
    });

    it('prioritises generic distributed failure families without canned sequence', () => {
      const { systemMessage } = buildInvestigationPrompt(initialContext);

      expect(systemMessage).toMatch(/duplication/i);
      expect(systemMessage).toMatch(/reordering/i);
      expect(systemMessage).toMatch(/race.*condition/i);
      expect(systemMessage).toMatch(/partial.*fill/i);
      expect(systemMessage).toMatch(/delay/i);
      expect(systemMessage).toMatch(/idempotency/i);
      // No canned predetermined sequence
      expect(systemMessage).toMatch(/canned|predetermined/i);
    });

    it('teaches observation-driven refinement/refutation and inconclusive stop', () => {
      const { systemMessage } = buildInvestigationPrompt(initialContext);

      expect(systemMessage).toMatch(/refinement.*refutation/i);
      expect(systemMessage).toMatch(/inconclusive.*stop/i);
      expect(systemMessage).toMatch(/done/i);
      expect(systemMessage).toContain('"done": true');
    });

    it('asks for concise hypothesis plus JSON actions and forbids chain-of-thought', () => {
      const { systemMessage } = buildInvestigationPrompt(initialContext);

      expect(systemMessage).toMatch(/concise hypothesis.*JSON/i);
      expect(systemMessage).toMatch(/do not include private reasoning/i);
    });

    it('restricts actions to supported operations without implying unsupported oracles', () => {
      const { systemMessage } = buildInvestigationPrompt(initialContext);

      for (const op of ['send', 'deliver', 'duplicate', 'advance', 'drain', 'fill', 'confirm_cancel']) {
        expect(systemMessage).toContain(`"${op}"`);
      }
      expect(systemMessage).toMatch(/unsupported outage or latency oracles/i);
    });

    it('contains no target variant names, planted defect recipes, or benchmark answer keys', () => {
      const { systemMessage, userMessage } = buildInvestigationPrompt(initialContext);
      const combined = `${systemMessage}\n${userMessage}`;

      // Strictly no variant names in model brief
      expect(combined).not.toContain('candidate-a');
      expect(combined).not.toContain('candidate-b');
      expect(combined).not.toContain('candidate-c');
      expect(combined).not.toContain('variant clean');
      // No benchmark results or answer keys
      expect(combined).not.toContain('planted defect');
      expect(combined).not.toContain('benchmark result');
    });
  });

  describe('Model Parity and Dynamic Context Updates', () => {
    it('guarantees first prompt hash parity across Wonder and Spark while request hashes differ', () => {
      const wonderProvider = new MetaProvider({ model: 'muse-wonder-1.0', apiKey: 'parity-test-key', ledgerPath });
      const sparkProvider = new MetaProvider({ model: 'muse-spark-1.3', apiKey: 'parity-test-key', ledgerPath });

      const wonderPrompt = wonderProvider.serializePrompt(initialContext);
      const sparkPrompt = sparkProvider.serializePrompt(initialContext);

      // System and user messages must be completely identical
      expect(wonderPrompt.systemMessage).toBe(sparkPrompt.systemMessage);
      expect(wonderPrompt.userMessage).toBe(sparkPrompt.userMessage);

      // Prompt hashes must be identical
      const wonderPromptHash = computePromptHash(wonderPrompt.systemMessage, wonderPrompt.userMessage);
      const sparkPromptHash = computePromptHash(sparkPrompt.systemMessage, sparkPrompt.userMessage);
      expect(wonderPromptHash).toBe(sparkPromptHash);

      // Prepared request bodies and request hashes must differ due to model parameter
      const wonderReqBody = {
        model: wonderProvider.model,
        messages: [
          { role: 'system', content: wonderPrompt.systemMessage },
          { role: 'user', content: wonderPrompt.userMessage }
        ],
        max_tokens: 4096,
        reasoning_effort: 'low',
        temperature: 0.2,
        response_format: { type: 'json_object' }
      };
      const sparkReqBody = {
        model: sparkProvider.model,
        messages: [
          { role: 'system', content: sparkPrompt.systemMessage },
          { role: 'user', content: sparkPrompt.userMessage }
        ],
        max_tokens: 4096,
        reasoning_effort: 'low',
        temperature: 0.2,
        response_format: { type: 'json_object' }
      };

      const wonderReqHash = crypto.createHash('sha256').update(canonicalJson(wonderReqBody)).digest('hex');
      const sparkReqHash = crypto.createHash('sha256').update(canonicalJson(sparkReqBody)).digest('hex');

      expect(wonderReqHash).not.toBe(sparkReqHash);
    });

    it('updates user message and prompt hash when history changes while preserving evidence boundary', () => {
      const prompt1 = buildInvestigationPrompt(initialContext);
      const hash1 = computePromptHash(prompt1.systemMessage, prompt1.userMessage);

      const historyExp: Experiment = {
        hypothesis: 'Duplicate fill message',
        expectedInvariant: 'credit_limit_respected',
        steps: [{ op: 'drain' }]
      };

      const contextWithHistory: ProviderContext = {
        ...initialContext,
        experimentNumber: 2,
        history: [{
          experiment: historyExp,
          result: {
            schemaVersion: 1,
            experiment: historyExp,
            sourceHash: sampleSource.hash,
            trace: [{ step: 0, time: 1, action: 'drain', outcome: 'DRAINED', state: {} }],
            snapshot: {
              target: { reservedCredit: 500, usedCredit: 500 },
              logicalTime: 5,
              venue: { secretPrivateOracleState: 'should-never-be-visible' }
            },
            violations: [],
            rejections: [],
            valid: true
          }
        }]
      };

      const prompt2 = buildInvestigationPrompt(contextWithHistory);
      const hash2 = computePromptHash(prompt2.systemMessage, prompt2.userMessage);

      expect(hash2).not.toBe(hash1);
      expect(prompt2.userMessage).toContain('Experiment #1:');
      expect(prompt2.userMessage).toContain('"reservedCredit":500');
      expect(prompt2.userMessage).not.toContain('secretPrivateOracleState');
    });

    it('updates user message and prompt hash when feedback is provided', () => {
      const contextWithFeedback: ProviderContext = {
        ...initialContext,
        feedback: ['Missing steps array in experiment']
      };

      const promptFeedback = buildInvestigationPrompt(contextWithFeedback);
      const promptInitial = buildInvestigationPrompt(initialContext);

      expect(promptFeedback.userMessage).toContain('INVALID PROPOSAL FEEDBACK:');
      expect(promptFeedback.userMessage).toContain('Missing steps array in experiment');

      const hashFeedback = computePromptHash(promptFeedback.systemMessage, promptFeedback.userMessage);
      const hashInitial = computePromptHash(promptInitial.systemMessage, promptInitial.userMessage);
      expect(hashFeedback).not.toBe(hashInitial);
    });

    it('verifies actual outbound body correspondence with requestHash', async () => {
      let sentBody = '';
      const provider = new MetaProvider({
        ledgerPath,
        apiKey: 'body-hash-test-key',
        fetchFn: (async (_url, init) => {
          sentBody = init?.body as string;
          return new Response(JSON.stringify({
            choices: [{
              finish_reason: 'stop',
              message: { content: JSON.stringify({ hypothesis: 'test', expectedInvariant: 'inv', steps: [] }) }
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5 }
          }));
        }) as typeof fetch
      });

      let capturedRequestAudit: ProviderRequestAudit | undefined;
      const reply = await provider.propose(initialContext, undefined, async (audit) => {
        capturedRequestAudit = audit;
      });

      expect(capturedRequestAudit).toBeDefined();
      expect(reply.requestAudit).toBeDefined();
      expect(capturedRequestAudit?.requestHash).toBe(reply.requestAudit?.requestHash);

      // SHA-256 of the actual outbound body string sent to fetch must match requestHash
      const calculatedHash = crypto.createHash('sha256').update(sentBody, 'utf-8').digest('hex');
      expect(capturedRequestAudit?.requestHash).toBe(calculatedHash);
    });

    it('delegates MetaProvider.serializePrompt directly to buildInvestigationPrompt', () => {
      const provider = new MetaProvider({ apiKey: 'test-key', ledgerPath });
      const metaPrompt = provider.serializePrompt(initialContext);
      const sharedPrompt = buildInvestigationPrompt(initialContext);

      expect(metaPrompt.systemMessage).toBe(sharedPrompt.systemMessage);
      expect(metaPrompt.userMessage).toBe(sharedPrompt.userMessage);
    });
  });
});
