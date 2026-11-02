import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  INVENTORY_TARGET_VARIANTS,
  RECOVERY_TARGET_VARIANTS,
  TARGET_VARIANTS,
  type TargetVariant,
} from '../src/domain.ts';
import {
  assertAdapterVariant,
  isRegisteredAdapter,
  listRegisteredAdapters,
  resolveAdapter,
} from '../src/adapters/index.ts';
import { getPromptIdentity, PROMPT_VERSION } from '../src/investigation/prompt.ts';
import { RECOVERY_PROMPT_TEMPLATE_HASH, RECOVERY_PROMPT_VERSION } from '../src/investigation/recovery-prompt.ts';
import { runInvestigation } from '../src/investigation/index.ts';
import { MockProvider } from '../src/providers/mock.ts';
import * as recovery from '../src/recovery/index.ts';
import { previewRegressionFromFinding } from '../src/regressions/index.ts';
import { saveRun } from '../src/storage.ts';
import {
  SEEDED_INVENTORY_BRIEF,
  SEEDED_RECOVERY_BRIEF,
  SEEDED_TRADING_BRIEF,
  createSystemSnapshot,
  validateSystemBrief,
} from '../src/systems/index.ts';

let runsDir: string;
beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chaospilot-recovery-compat-'));
});
afterEach(async () => {
  if (runsDir) await fs.rm(runsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('Recovery adapter compatibility with legacy adapters', () => {
  it('registers recovery additively without changing legacy variant lists', () => {
    expect(listRegisteredAdapters()).toEqual([
      'synthetic-trading', 'inventory-reservation', 'synthetic-trading-recovery',
    ]);
    expect(isRegisteredAdapter('synthetic-trading-recovery')).toBe(true);
    expect(isRegisteredAdapter('unconfigured')).toBe(false);
    expect(resolveAdapter('synthetic-trading').variants).toEqual(TARGET_VARIANTS);
    expect(resolveAdapter('inventory-reservation').variants).toEqual(INVENTORY_TARGET_VARIANTS);
    expect(resolveAdapter('synthetic-trading-recovery').variants).toEqual(RECOVERY_TARGET_VARIANTS);
    expect(TARGET_VARIANTS).not.toContain('recovery-candidate-a');
  });

  it('rejects every cross-adapter variant mismatch before inference/execution', async () => {
    const mismatches: Array<[string, TargetVariant]> = [
      ['synthetic-trading-recovery', 'candidate-a'],
      ['synthetic-trading-recovery', 'inventory-candidate-a'],
      ['synthetic-trading', 'recovery-candidate-a'],
      ['inventory-reservation', 'recovery-candidate-a'],
    ];
    for (const [adapterId, variant] of mismatches) {
      expect(() => assertAdapterVariant(adapterId, variant)).toThrow(
        new RegExp(`Unsupported variant "${variant}" for adapter "${adapterId}"`),
      );
    }
    // Investigation-level preflight: same rejection, and no provider call is
    // needed to prove it (runInvestigation validates before proposing).
    let proposals = 0;
    const provider = new MockProvider();
    const original = provider.propose.bind(provider);
    provider.propose = async (...args: Parameters<typeof original>) => { proposals++; return original(...args); };
    const snapshot = await createSystemSnapshot(structuredClone(SEEDED_RECOVERY_BRIEF));
    await expect(runInvestigation({ variant: 'candidate-a', systemBrief: snapshot, provider }))
      .rejects.toThrow(/Unsupported variant "candidate-a" for adapter "synthetic-trading-recovery"/);
    expect(proposals).toBe(0);
  });

  it('keeps legacy prompt identities and contracts free of recovery semantics', () => {
    expect(getPromptIdentity('synthetic-trading').promptVersion).toBe(PROMPT_VERSION);
    const recoveryIdentity = getPromptIdentity('synthetic-trading-recovery');
    expect(recoveryIdentity.promptVersion).toBe(RECOVERY_PROMPT_VERSION);
    expect(recoveryIdentity.promptTemplateHash).toBe(RECOVERY_PROMPT_TEMPLATE_HASH);
    expect(recoveryIdentity.promptTemplateHash).not.toBe(getPromptIdentity('synthetic-trading').promptTemplateHash);
    expect(recoveryIdentity.promptTemplateHash).not.toBe(getPromptIdentity('inventory-reservation').promptTemplateHash);
    expect(() => getPromptIdentity('nope')).toThrow(/Unsupported prompt adapter/);

    for (const adapterId of ['synthetic-trading', 'inventory-reservation'] as const) {
      const contract = resolveAdapter(adapterId).getContract();
      expect(contract.invariants.map((i) => i.id)).not.toContain('recovery_deadline');
      expect(contract.operations.map((o) => o['op'])).not.toContain('disconnect');
      expect(contract.operations.map((o) => o['op'])).not.toContain('reconnect');
    }
    const recoveryContract = resolveAdapter('synthetic-trading-recovery').getContract();
    expect(recoveryContract.invariants.map((i) => i.id)).toContain('recovery_deadline');
    expect(recoveryContract.operations.map((o) => o['op'])).toEqual(
      expect.arrayContaining(['disconnect', 'reconnect']),
    );
    expect(recoveryContract.operations.map((o) => o['op'])).not.toContain('confirm_cancel');
  });

  it('validates the seeded recovery brief and preserves legacy seeded briefs', () => {
    for (const brief of [SEEDED_TRADING_BRIEF, SEEDED_INVENTORY_BRIEF, SEEDED_RECOVERY_BRIEF]) {
      const validated = validateSystemBrief(structuredClone(brief));
      expect(validated.valid).toBe(true);
    }
    expect(SEEDED_RECOVERY_BRIEF.id).toBe('trading-recovery');
    expect(SEEDED_RECOVERY_BRIEF.adapterId).toBe('synthetic-trading-recovery');
    expect(SEEDED_TRADING_BRIEF.adapterId).toBe('synthetic-trading');
    expect(SEEDED_INVENTORY_BRIEF.adapterId).toBe('inventory-reservation');
  });

  it('legacy executions carry no recovery evidence while recovery executions always do', () => {
    const empty = { hypothesis: 'identity', expectedInvariant: 'x', steps: [] };
    const trading = resolveAdapter('synthetic-trading').executeExperiment(structuredClone(empty), 'clean');
    expect(trading.recovery).toBeUndefined();
    const inventory = resolveAdapter('inventory-reservation').executeExperiment(structuredClone(empty), 'clean');
    expect(inventory.recovery).toBeUndefined();
    for (const variant of RECOVERY_TARGET_VARIANTS) {
      const result = recovery.executeExperiment(structuredClone(empty), variant);
      expect(result.recovery?.schemaVersion).toBe(1);
      expect(result.recovery?.evaluator).toEqual(recovery.RECOVERY_EVALUATOR_IDENTITY);
      // No accepted trigger: honestly not-exercised, never passed.
      expect(result.recovery?.status).toBe('not-exercised');
      expect(result.sourceHash).toBe(recovery.getSourceBundle(variant).hash);
    }
    // Recovery source identities are stable and distinct from each other and
    // from the legacy trading clean bundle.
    expect(recovery.getSourceBundle('clean').hash).not.toBe(recovery.getSourceBundle('recovery-candidate-a').hash);
    expect(recovery.getSourceBundle('clean').hash)
      .not.toBe(resolveAdapter('synthetic-trading').getSourceBundle('clean').hash);
    expect(recovery.getSourceBundle('clean').hash).toBe(recovery.getSourceBundle('clean').hash);
  });

  it('recovery parser is stricter than legacy: confirm_cancel and unknown ops/fields are rejected pre-execution', () => {
    const base = { hypothesis: 'h', expectedInvariant: 'recovery_deadline' };
    expect(() => recovery.parseExperiment({ ...base, steps: [{ op: 'confirm_cancel', messageId: 'c1', orderId: 'o1' }] }))
      .toThrow(/unsupported in synthetic-trading-recovery v1/);
    expect(() => recovery.parseExperiment({ ...base, steps: [{ op: 'explode' }] }))
      .toThrow(/Unsupported recovery action operation/);
    expect(() => recovery.parseExperiment({ ...base, steps: [{ op: 'disconnect', ticks: 1 }] }))
      .toThrow(/Unexpected field 'ticks'/);
    expect(() => recovery.parseExperiment({ ...base, steps: [{ op: 'send', id: 's1', to: 'stock', payload: {} }] }))
      .toThrow(/'to' must be one of/);
    expect(() => recovery.parseExperiment({ ...base, steps: [{ op: 'advance', ticks: -1 }] }))
      .toThrow(/'ticks' must be an integer/);
    expect(() => recovery.parseExperiment('not-an-object')).toThrow(/must be an object/);
    // The legacy trading parser still accepts its own confirm_cancel action.
    expect(() => resolveAdapter('synthetic-trading').parseExperiment({
      ...base, steps: [{ op: 'confirm_cancel', messageId: 'c1', orderId: 'o1' }],
    })).not.toThrow();
  });

  it('an unresolved early stop is inconclusive, not a proven deadline failure', () => {
    // Accepted while disconnected but experiment ends before reconnect/deadline.
    const plan = recovery.parseExperiment({
      hypothesis: 'early stop', expectedInvariant: 'recovery_deadline',
      steps: [
        { op: 'send', id: 'q', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 100 } },
        { op: 'send', id: 'c', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 1000 } },
        { op: 'drain' },
        { op: 'send', id: 'o', to: 'client', payload: { type: 'new_order', id: 'o1', orderId: 'ord-1', quantity: 10, quoteId: 'q1' } },
        { op: 'drain' },
        { op: 'disconnect' },
        { op: 'fill', messageId: 'f1', orderId: 'ord-1', executionId: 'exec-1', quantity: 4 },
        { op: 'deliver', messageId: 'f1' },
        // No reconnect: horizon insufficient to prove a missed deadline.
      ],
    });
    for (const variant of RECOVERY_TARGET_VARIANTS) {
      const result = recovery.executeExperiment(plan, variant);
      expect(result.violations.some((v) => v.invariant === 'recovery_deadline')).toBe(false);
      expect(result.recovery?.status).toBe('inconclusive');
      expect(result.recovery?.obligations[0]?.deadlineMissed).toBe(false);
      expect(result.recovery?.obligations[0]?.reconnectTick).toBeUndefined();
    }
  });

  it('regression capture remains trading-only and is explicitly unavailable for recovery findings', async () => {
    const snapshot = await createSystemSnapshot(structuredClone(SEEDED_RECOVERY_BRIEF));
    const record = await runInvestigation({
      variant: 'recovery-candidate-a', systemBrief: snapshot, provider: new MockProvider(),
    });
    expect(record.findings).toHaveLength(1);
    await saveRun(record, runsDir);
    const preview = await previewRegressionFromFinding(record.id, record.findings[0]!.id, { runsDir });
    expect(preview.available).toBe(false);
    if (!preview.available) {
      expect(preview.reason).toMatch(/not supported for regression capture; only 'synthetic-trading'/);
    }
  });
});
