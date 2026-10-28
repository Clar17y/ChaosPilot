import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { InvestigationRecord, SystemContract, TargetVariant } from '../src/domain.ts';
import { runInvestigation } from '../src/investigation/index.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { SEEDED_INVENTORY_BRIEF, SEEDED_TRADING_BRIEF, computeSnapshotHash, createSystemSnapshot } from '../src/systems/index.ts';
import { getRun, replayRun, saveRun, type SimulatorApi } from '../src/storage.ts';
import { computeContractHash } from '../src/evidence.ts';
import * as inventory from '../src/inventory/index.ts';
import * as trading from '../src/simulator/index.ts';

let runsDir: string;

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chaospilot-inventory-replay-'));
});
afterEach(async () => {
  await fs.rm(runsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function inventoryRecord(variant: 'clean' | 'inventory-candidate-a' = 'inventory-candidate-a'): Promise<InvestigationRecord> {
  const systemBrief = await createSystemSnapshot(structuredClone(SEEDED_INVENTORY_BRIEF));
  return runInvestigation({ variant, systemBrief, provider: new MockProvider() });
}

async function tradingRecord(simulator?: Parameters<typeof runInvestigation>[0]['simulator']): Promise<InvestigationRecord> {
  const systemBrief = await createSystemSnapshot(structuredClone(SEEDED_TRADING_BRIEF));
  return runInvestigation({ variant: 'candidate-a', systemBrief, provider: new MockProvider(), maxExperiments: 2, simulator });
}

function tradingSimulator(overrides: { cleanHash?: string; cleanUnavailable?: boolean } = {}): SimulatorApi & { parseExperiment: typeof trading.parseExperiment } {
  return {
    getContract: () => trading.getContract(),
    getSourceBundle: (variant: TargetVariant) => {
      if (variant === 'clean' && overrides.cleanUnavailable) throw new Error('clean bundle unavailable');
      const bundle = trading.getSourceBundle(variant);
      if (variant === 'clean' && overrides.cleanHash) return { ...bundle, hash: overrides.cleanHash };
      return bundle;
    },
    parseExperiment: trading.parseExperiment,
    executeExperiment: (experiment, variant) => trading.executeExperiment(experiment, variant),
  };
}

const rawHash = (contract: unknown) => crypto.createHash('sha256').update(JSON.stringify(contract), 'utf8').digest('hex');

/** Deep-reverses object key order, producing a canonically equal contract. */
function reorder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorder);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([k, v]) => [k, reorder(v)]));
  }
  return value;
}

/** Real inventory adapter with selected current-context overrides. */
function inventorySimulator(overrides: {
  contract?: SystemContract;
  cleanHash?: string;
  cleanUnavailable?: boolean;
} = {}): SimulatorApi {
  return {
    getContract: () => overrides.contract ?? inventory.getContract(),
    getSourceBundle: (variant: TargetVariant) => {
      if (variant === 'clean' && overrides.cleanUnavailable) throw new Error('clean bundle unavailable');
      const bundle = inventory.getSourceBundle(variant);
      if (variant === 'clean' && overrides.cleanHash) return { ...bundle, hash: overrides.cleanHash };
      return bundle;
    },
    executeExperiment: (experiment, variant) => inventory.executeExperiment(experiment, variant),
  };
}

/** Simulates an internally consistent older prompt in the saved record. */
function withOldPrompt(record: InvestigationRecord): InvestigationRecord {
  const old = structuredClone(record);
  old.contextAudit.promptVersion = '0.9';
  old.contextAudit.promptTemplateHash = 'a'.repeat(64);
  for (const attempt of old.proposalAttempts ?? []) {
    if (attempt.request) {
      attempt.request.promptVersion = '0.9';
      attempt.request.promptTemplateHash = 'a'.repeat(64);
    }
  }
  return old;
}

function check(report: Awaited<ReturnType<typeof replayRun>>, kind: string) {
  return report.contextChecks?.find(c => c.kind === kind);
}

describe('Inventory saved evidence and replay', () => {
  it('persists a faulty inventory finding and replays it exactly from disk', async () => {
    const record = await inventoryRecord();
    expect(record.findings.length).toBeGreaterThan(0);
    expect(record.contextAudit.adapterId).toBe('inventory-reservation');
    await saveRun(record, runsDir);

    const loaded = await getRun(record.id, runsDir);
    expect(loaded?.variant).toBe('inventory-candidate-a');

    const report = await replayRun(record.id, runsDir);
    expect(report.sourceIdentical).toBe(true);
    expect(report.contextStatus).toBe('verified');
    expect(report.contextDrift).toEqual([]);
    expect(report.exactReproductionClaimed).toBe(true);
    expect(report.experimentsReproduced).toBe(report.experimentsTotal);
    expect(report.outcomes.every(o => o.violationsMatched && o.traceMatched && o.snapshotMatched)).toBe(true);
  });

  it('replays a clean inventory control with no findings', async () => {
    const record = await inventoryRecord('clean');
    expect(record.findings).toEqual([]);
    const report = await replayRun(record, runsDir);
    expect(report.exactReproductionClaimed).toBe(true);
    expect(report.outcomes.every(o => o.replayedViolationsCount === 0)).toBe(true);
  });

  it('refuses an exact claim when the recorded source identity has drifted', async () => {
    const record = await inventoryRecord();
    const drifted = structuredClone(record);
    drifted.sourceHash = 'f'.repeat(64);
    for (const exp of drifted.experiments) exp.result.sourceHash = drifted.sourceHash;
    for (const finding of drifted.findings) finding.sourceHash = drifted.sourceHash;
    const report = await replayRun(drifted, runsDir);
    expect(report.sourceIdentical).toBe(false);
    expect(report.exactReproductionClaimed).toBe(false);
  });

  it('fails closed on internally inconsistent snapshot hash, contract, prompt audit and plan', async () => {
    const record = await inventoryRecord();

    const hashTamper = structuredClone(record);
    hashTamper.systemBrief!.brief.name = 'Renamed after launch';
    await expect(replayRun(hashTamper, runsDir)).rejects.toThrow(/snapshot hash/);

    const contractTamper = structuredClone(record);
    contractTamper.systemBrief!.contract!.limits.maxQuantity = 9;
    contractTamper.systemBrief!.hash = computeSnapshotHash(contractTamper.systemBrief!.brief, contractTamper.systemBrief!.contract);
    await expect(replayRun(contractTamper, runsDir)).rejects.toThrow(/contract/);

    const promptTamper = structuredClone(record);
    promptTamper.contextAudit.promptTemplateHash = '0'.repeat(64);
    await expect(replayRun(promptTamper, runsDir)).rejects.toThrow(/prompt audit/);

    const planTamper = structuredClone(record);
    planTamper.experiments[0]!.experiment.hypothesis = 'Rewritten after the fact';
    await expect(replayRun(planTamper, runsDir)).rejects.toThrow(/plan identity/);

    const auditTamper = structuredClone(record);
    auditTamper.contextAudit.contractHash = '0'.repeat(64);
    await expect(replayRun(auditTamper, runsDir)).rejects.toThrow(/contract audit/);

    const crossedAudit = structuredClone(record);
    crossedAudit.contextAudit.adapterId = 'synthetic-trading';
    await expect(replayRun(crossedAudit, runsDir)).rejects.toThrow(/prompt audit|adapter/);
  });

  it('fails closed when a clean-variant record contradicts its own clean source hash', async () => {
    const record = await inventoryRecord('clean');
    const tampered = structuredClone(record);
    tampered.contextAudit.cleanSourceHash = 'f'.repeat(64);
    await expect(replayRun(tampered, runsDir)).rejects.toThrow(/clean control source|clean.*inconsistent/);
  });

  it('rejects a cross-adapter variant on an inventory record', async () => {
    const record = await inventoryRecord();
    const crossed = structuredClone(record);
    crossed.variant = 'candidate-a';
    await expect(replayRun(crossed, runsDir)).rejects.toThrow(/Unsupported variant/);
  });

  it('resolves a legacy record without a system brief to trading', async () => {
    const legacy = await runInvestigation({ variant: 'candidate-a', provider: new MockProvider() });
    expect(legacy.systemBrief).toBeUndefined();
    expect(legacy.contextAudit.adapterId).toBeUndefined();
    const report = await replayRun(legacy, runsDir);
    expect(report.exactReproductionClaimed).toBe(true);
    expect(report.contextStatus).toBe('legacy-unknown');
    expect(report.note).toMatch(/Legacy record/);
    expect(report.variant).toBe('candidate-a');
  });

  it('reports prompt-only drift with per-experiment outcomes instead of aborting', async () => {
    const old = withOldPrompt(await inventoryRecord());
    await saveRun(old, runsDir);
    const report = await replayRun(old.id, runsDir);
    expect(report.outcomes).toHaveLength(old.experiments.length);
    expect(report.outcomes.every(o => o.exactMatched)).toBe(true);
    expect(check(report, 'prompt')?.status).toBe('drifted');
    expect(report.contextStatus).toBe('drifted');
    expect(report.exactReproductionClaimed).toBe(false);
    expect(report.reproduced).toBe(false);
  });

  it('reports pre-compaction prompt version drift without losing matching experiment replay', async () => {
    const old = await inventoryRecord();
    old.contextAudit.promptVersion = 'inventory-1.0';
    for (const attempt of old.proposalAttempts ?? []) {
      if (attempt.request) attempt.request.promptVersion = 'inventory-1.0';
    }
    const report = await replayRun(old, runsDir);
    expect(report.outcomes).toHaveLength(old.experiments.length);
    expect(report.outcomes.every(outcome => outcome.exactMatched)).toBe(true);
    expect(check(report, 'prompt')?.status).toBe('drifted');
    expect(report.exactReproductionClaimed).toBe(false);
  });

  it('reports contract description-only and semantic drift without aborting', async () => {
    const record = await inventoryRecord();
    const description = await replayRun(record, runsDir, inventorySimulator({
      contract: { ...inventory.getContract(), description: 'Evolved wording' },
    }));
    expect(check(description, 'contract')).toMatchObject({ status: 'drifted' });
    expect(check(description, 'contract')?.detail).toMatch(/description only/);
    expect(description.exactReproductionClaimed).toBe(false);
    expect(description.outcomes).toHaveLength(record.experiments.length);

    const changed = inventory.getContract();
    const semantic = await replayRun(record, runsDir, inventorySimulator({
      contract: { ...changed, limits: { ...changed.limits, maxQuantity: 9 } },
    }));
    expect(check(semantic, 'contract')?.detail).toMatch(/semantically/);
    expect(semantic.exactReproductionClaimed).toBe(false);
    expect(semantic.outcomes.every(o => o.exactMatched)).toBe(true);
  });

  it('reports clean-source drift and clean-source unavailability without aborting', async () => {
    const record = await inventoryRecord();
    const drifted = await replayRun(record, runsDir, inventorySimulator({ cleanHash: 'f'.repeat(64) }));
    expect(check(drifted, 'clean-source')?.status).toBe('drifted');
    expect(drifted.exactReproductionClaimed).toBe(false);
    expect(drifted.outcomes).toHaveLength(record.experiments.length);

    const unavailable = await replayRun(record, runsDir, inventorySimulator({ cleanUnavailable: true }));
    expect(check(unavailable, 'clean-source')?.status).toBe('unknown');
    expect(unavailable.contextStatus).toBe('unknown');
    expect(unavailable.exactReproductionClaimed).toBe(false);
  });

  it('reports combined prompt, contract and clean-source drift together', async () => {
    const old = withOldPrompt(await inventoryRecord());
    const changed = inventory.getContract();
    const report = await replayRun(old, runsDir, inventorySimulator({
      contract: { ...changed, limits: { ...changed.limits, maxQuantity: 9 } },
      cleanHash: 'e'.repeat(64),
    }));
    expect(check(report, 'prompt')?.status).toBe('drifted');
    expect(check(report, 'contract')?.status).toBe('drifted');
    expect(check(report, 'clean-source')?.status).toBe('drifted');
    expect(report.contextDrift?.length).toBeGreaterThanOrEqual(3);
    expect(report.exactReproductionClaimed).toBe(false);
    expect(report.outcomes).toHaveLength(old.experiments.length);
  });

  it('replays a launch-accepted snapshot whose contract keys are reordered', async () => {
    const reordered = reorder(inventory.getContract()) as SystemContract;
    expect(rawHash(reordered)).not.toBe(rawHash(inventory.getContract()));
    const systemBrief = await createSystemSnapshot(structuredClone(SEEDED_INVENTORY_BRIEF), reordered);
    const record = await runInvestigation({ variant: 'inventory-candidate-a', systemBrief, provider: new MockProvider() });
    expect(record.contextAudit.contractHash).toBe(computeContractHash(reordered));
    await saveRun(record, runsDir);
    const report = await replayRun(record.id, runsDir);
    expect(report.exactReproductionClaimed).toBe(true);
    expect(report.contextStatus).toBe('verified');
  });

  it('verifies legacy raw contract hashes in snapshot order and in runtime order', async () => {
    const record = await inventoryRecord();

    const snapshotOrder = structuredClone(record);
    snapshotOrder.contextAudit.contractHash = rawHash(snapshotOrder.systemBrief!.contract);
    expect((await replayRun(snapshotOrder, runsDir)).exactReproductionClaimed).toBe(true);

    const runtimeOrder = structuredClone(record);
    runtimeOrder.systemBrief!.contract = reorder(inventory.getContract()) as SystemContract;
    runtimeOrder.systemBrief!.hash = computeSnapshotHash(runtimeOrder.systemBrief!.brief, runtimeOrder.systemBrief!.contract);
    runtimeOrder.contextAudit.contractHash = rawHash(inventory.getContract());
    expect(runtimeOrder.contextAudit.contractHash).not.toBe(rawHash(runtimeOrder.systemBrief!.contract));
    expect(runtimeOrder.contextAudit.contractHash).not.toBe(computeContractHash(runtimeOrder.systemBrief!.contract!));
    const report = await replayRun(runtimeOrder, runsDir);
    expect(check(report, 'contract-hash')).toMatchObject({ status: 'identical' });
    expect(report.exactReproductionClaimed).toBe(true);
  });

  it('surfaces unverified legacy contract provenance when the historical key order cannot be proved', async () => {
    const record = await inventoryRecord();
    const legacy = structuredClone(record);
    legacy.systemBrief!.contract = reorder(inventory.getContract()) as SystemContract;
    legacy.systemBrief!.hash = computeSnapshotHash(legacy.systemBrief!.brief, legacy.systemBrief!.contract);
    legacy.contextAudit.contractHash = rawHash(inventory.getContract());
    const changed = inventory.getContract();
    const report = await replayRun(legacy, runsDir, inventorySimulator({
      contract: { ...changed, limits: { ...changed.limits, maxQuantity: 9 } },
    }));
    expect(check(report, 'contract-hash')?.status).toBe('unverified-legacy');
    expect(report.exactReproductionClaimed).toBe(false);
    expect(report.outcomes).toHaveLength(record.experiments.length);
  });

  it('reports missing historic clean and prompt metadata as unknown, never exact', async () => {
    const record = await inventoryRecord();
    const stripped = structuredClone(record);
    delete stripped.contextAudit.cleanSourceHash;
    delete stripped.contextAudit.promptTemplateHash;
    stripped.proposalAttempts = [];
    const report = await replayRun(stripped, runsDir);
    expect(check(report, 'clean-source')?.status).toBe('unknown');
    expect(check(report, 'prompt')?.status).toBe('unknown');
    expect(report.exactReproductionClaimed).toBe(false);
    expect(report.outcomes).toHaveLength(record.experiments.length);
  });

  it('reports a legacy duplicate-violation-ID record as non-exact with an ID-specific mismatch', async () => {
    const base = await inventoryRecord();
    const record = structuredClone(base);
    record.experiments = [record.experiments[0]!];
    record.findings = [];
    const violation = { id: 'legacy-base', invariant: 'stock_conservation', message: 'Quantity violated', step: 3, evidence: {} };
    const original = record.experiments[0]!.result;
    original.violations = [structuredClone(violation), structuredClone(violation)];
    const replayedViolations = [structuredClone(violation), { ...structuredClone(violation), id: 'legacy-base-2' }];
    const sim: SimulatorApi = {
      getContract: () => record.systemBrief!.contract!,
      getSourceBundle: (variant: TargetVariant) => ({
        hash: variant === 'clean' ? record.contextAudit.cleanSourceHash! : record.sourceHash,
        files: [],
      }),
      executeExperiment: (experiment) => ({
        schemaVersion: 1, experiment, sourceHash: record.sourceHash,
        trace: structuredClone(original.trace), snapshot: structuredClone(original.snapshot),
        violations: replayedViolations, rejections: structuredClone(original.rejections), valid: original.valid,
      }),
    };
    const report = await replayRun(record, runsDir, sim);
    expect(report.exactReproductionClaimed).toBe(false);
    expect(report.outcomes[0]?.violationsMatched).toBe(false);
    expect(report.outcomes[0]?.mismatches?.join(' ')).toMatch(/violation IDs differ/);
  });

  it('never invokes a provider during replay', async () => {
    let calls = 0;
    class CountingProvider extends MockProvider {
      override async propose(...args: Parameters<MockProvider['propose']>) {
        calls++;
        return super.propose(...args);
      }
    }
    const systemBrief = await createSystemSnapshot(structuredClone(SEEDED_INVENTORY_BRIEF));
    const record = await runInvestigation({ variant: 'inventory-candidate-a', systemBrief, provider: new CountingProvider() });
    const atLaunch = calls;
    expect(atLaunch).toBeGreaterThan(0);
    await replayRun(record, runsDir);
    expect(calls).toBe(atLaunch);
  });
});

describe('Trading snapshot clean provenance and legacy audit comparison', () => {
  it('records clean provenance for new snapshot-backed trading runs and replays verified', async () => {
    const record = await tradingRecord();
    expect(record.contextAudit.adapterId).toBe('synthetic-trading');
    expect(record.contextAudit.variant).toBe('candidate-a');
    expect(record.contextAudit.cleanSourceHash).toBe(trading.getSourceBundle('clean').hash);
    const report = await replayRun(record, runsDir);
    expect(check(report, 'clean-source')?.status).toBe('identical');
    expect(report.contextStatus).toBe('verified');
    expect(report.exactReproductionClaimed).toBe(true);
  });

  it('reports trading clean drift and unavailability as non-exact with outcomes', async () => {
    const record = await tradingRecord();
    const drifted = await replayRun(record, runsDir, tradingSimulator({ cleanHash: 'f'.repeat(64) }));
    expect(check(drifted, 'clean-source')?.status).toBe('drifted');
    expect(drifted.exactReproductionClaimed).toBe(false);
    expect(drifted.outcomes).toHaveLength(record.experiments.length);

    const unavailable = await replayRun(record, runsDir, tradingSimulator({ cleanUnavailable: true }));
    expect(check(unavailable, 'clean-source')?.status).toBe('unknown');
    expect(unavailable.contextStatus).toBe('unknown');
    expect(unavailable.exactReproductionClaimed).toBe(false);
    expect(unavailable.outcomes).toHaveLength(record.experiments.length);
  });

  it('withholds verified for an old trading snapshot without a clean hash, and when clean was unavailable at launch', async () => {
    const old = await tradingRecord();
    delete old.contextAudit.cleanSourceHash;
    const report = await replayRun(old, runsDir);
    expect(check(report, 'clean-source')?.status).toBe('unknown');
    expect(report.contextStatus).toBe('unknown');
    expect(report.exactReproductionClaimed).toBe(false);
    expect(report.outcomes).toHaveLength(old.experiments.length);
    expect(report.outcomes.every(o => o.exactMatched)).toBe(true);

    const launchedWithoutClean = await tradingRecord(tradingSimulator({ cleanUnavailable: true }));
    expect(launchedWithoutClean.contextAudit.cleanSourceHash).toBeUndefined();
    expect(launchedWithoutClean.contextAudit.adapterId).toBe('synthetic-trading');
    const launchedReport = await replayRun(launchedWithoutClean, runsDir);
    expect(check(launchedReport, 'clean-source')?.status).toBe('unknown');
    expect(launchedReport.exactReproductionClaimed).toBe(false);
  });

  it('rejects contradictory trading result/finding plans and source identities', async () => {
    const record = await tradingRecord();
    const planTamper = structuredClone(record);
    planTamper.experiments[0]!.result.experiment.hypothesis = 'Contradictory saved plan';
    await expect(replayRun(planTamper, runsDir)).rejects.toThrow(/plan identity/);

    const sourceTamper = structuredClone(record);
    sourceTamper.experiments[0]!.result.sourceHash = 'f'.repeat(64);
    await expect(replayRun(sourceTamper, runsDir)).rejects.toThrow(/source or plan identity/);

    expect(record.findings.length).toBeGreaterThan(0);
    const findingTamper = structuredClone(record);
    findingTamper.findings[0]!.replay.hypothesis = 'Contradictory saved finding plan';
    await expect(replayRun(findingTamper, runsDir)).rejects.toThrow(/finding source or plan identity/);

    const findingSourceTamper = structuredClone(record);
    findingSourceTamper.findings[0]!.sourceHash = 'e'.repeat(64);
    await expect(replayRun(findingSourceTamper, runsDir)).rejects.toThrow(/finding source or plan identity/);
  });

  it('rejects contradictory adapter/variant audit fields with and without a snapshot, for both adapters', async () => {
    const snapshotCrossed = await tradingRecord();
    snapshotCrossed.contextAudit.adapterId = 'inventory-reservation';
    await expect(replayRun(snapshotCrossed, runsDir)).rejects.toThrow(/adapter|Unsupported variant/);

    const legacyCrossed = await tradingRecord();
    delete legacyCrossed.systemBrief;
    legacyCrossed.contextAudit.adapterId = 'inventory-reservation';
    legacyCrossed.contextAudit.variant = 'clean';
    await expect(replayRun(legacyCrossed, runsDir)).rejects.toThrow(/adapter|Unsupported variant/);

    const legacyVariant = await runInvestigation({ variant: 'candidate-a', provider: new MockProvider(), maxExperiments: 1 });
    legacyVariant.contextAudit.variant = 'clean';
    await expect(replayRun(legacyVariant, runsDir)).rejects.toThrow(/adapter, variant or prompt audit/);

    const inventoryLegacyVariant = await inventoryRecord();
    delete inventoryLegacyVariant.systemBrief;
    inventoryLegacyVariant.contextAudit.variant = 'clean';
    await expect(replayRun(inventoryLegacyVariant, runsDir)).rejects.toThrow(/adapter, variant or prompt audit/);
  });

  it('verifies matching legacy prompt and canonical/raw contract hashes without a snapshot', async () => {
    const legacy = await runInvestigation({ variant: 'candidate-a', provider: new MockProvider(), maxExperiments: 2 });
    const report = await replayRun(legacy, runsDir);
    expect(check(report, 'prompt')?.status).toBe('identical');
    expect(check(report, 'contract-hash')?.status).toBe('identical');
    expect(check(report, 'clean-source')?.status).toBe('unknown');
    expect(report.contextStatus).toBe('legacy-unknown');
    expect(report.exactReproductionClaimed).toBe(true);

    const rawLegacy = structuredClone(legacy);
    rawLegacy.contextAudit.contractHash = rawHash(trading.getContract());
    const rawReport = await replayRun(rawLegacy, runsDir);
    expect(check(rawReport, 'contract-hash')?.status).toBe('identical');
    expect(rawReport.exactReproductionClaimed).toBe(true);
  });

  it('blocks legacy exactness on prompt drift, contract drift, and combined source drift', async () => {
    const legacy = await runInvestigation({ variant: 'candidate-a', provider: new MockProvider(), maxExperiments: 2 });

    const promptReport = await replayRun(withOldPrompt(legacy), runsDir);
    expect(check(promptReport, 'prompt')?.status).toBe('drifted');
    expect(promptReport.contextStatus).toBe('drifted');
    expect(promptReport.exactReproductionClaimed).toBe(false);
    expect(promptReport.outcomes).toHaveLength(legacy.experiments.length);

    const contractDrift = structuredClone(legacy);
    contractDrift.contextAudit.contractHash = '0'.repeat(64);
    const contractReport = await replayRun(contractDrift, runsDir);
    expect(check(contractReport, 'contract-hash')?.status).toBe('unverified-legacy');
    expect(contractReport.contextStatus).toBe('unknown');
    expect(contractReport.exactReproductionClaimed).toBe(false);
    expect(contractReport.outcomes).toHaveLength(legacy.experiments.length);

    const combined = withOldPrompt(legacy);
    combined.sourceHash = 'f'.repeat(64);
    for (const exp of combined.experiments) exp.result.sourceHash = combined.sourceHash;
    for (const finding of combined.findings) finding.sourceHash = combined.sourceHash;
    const combinedReport = await replayRun(combined, runsDir);
    expect(check(combinedReport, 'prompt')?.status).toBe('drifted');
    expect(combinedReport.sourceIdentical).toBe(false);
    expect(combinedReport.exactReproductionClaimed).toBe(false);
    expect(combinedReport.outcomes).toHaveLength(legacy.experiments.length);
  });

  it('blocks legacy exactness when a recorded clean hash drifted or cannot be compared', async () => {
    const legacy = await runInvestigation({ variant: 'candidate-a', provider: new MockProvider(), maxExperiments: 1 });
    legacy.contextAudit.cleanSourceHash = trading.getSourceBundle('clean').hash;
    const drifted = await replayRun(legacy, runsDir, tradingSimulator({ cleanHash: 'f'.repeat(64) }));
    expect(check(drifted, 'clean-source')?.status).toBe('drifted');
    expect(drifted.exactReproductionClaimed).toBe(false);

    const unavailable = await replayRun(legacy, runsDir, tradingSimulator({ cleanUnavailable: true }));
    expect(check(unavailable, 'clean-source')?.status).toBe('unknown');
    expect(unavailable.exactReproductionClaimed).toBe(false);
  });

  it('keeps genuinely absent legacy metadata compatible and honestly unknown', async () => {
    const legacy = await runInvestigation({ variant: 'candidate-a', provider: new MockProvider(), maxExperiments: 1 });
    legacy.contextAudit.promptVersion = '';
    delete legacy.contextAudit.promptTemplateHash;
    legacy.contextAudit.contractHash = '';
    legacy.proposalAttempts = [];
    const report = await replayRun(legacy, runsDir);
    expect(check(report, 'prompt')?.status).toBe('unknown');
    expect(check(report, 'contract-hash')?.status).toBe('unknown');
    expect(report.contextStatus).toBe('legacy-unknown');
    expect(report.exactReproductionClaimed).toBe(true);
    expect(report.outcomes).toHaveLength(legacy.experiments.length);
  });

  it('still rejects inventory plan tampering identified through the result plan', async () => {
    const record = await inventoryRecord();
    const tampered = structuredClone(record);
    tampered.experiments[0]!.result.experiment.hypothesis = 'Contradictory saved plan';
    await expect(replayRun(tampered, runsDir)).rejects.toThrow(/plan identity/);
  });
});
