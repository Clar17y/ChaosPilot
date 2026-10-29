import { describe, expect, it, vi } from 'vitest';
import type { Action, Experiment, TargetVariant } from '../src/domain.ts';
import * as inventory from '../src/inventory/index.ts';
import { InventoryOracle } from '../src/inventory/oracle.ts';
import { runInvestigation } from '../src/investigation/index.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { inventoryProposal } from '../src/providers/inventory-mock.ts';
import { SEEDED_INVENTORY_BRIEF, createSystemSnapshot } from '../src/systems/index.ts';
import { buildInvestigationPrompt } from '../src/investigation/prompt.ts';
import type { SimulatorApi } from '../src/investigation/index.ts';
import type { ExperimentResult, Violation } from '../src/domain.ts';
import { compareSemanticReplay } from '../src/evidence.ts';
import { replayRun, replaySelectedExperiment } from '../src/storage.ts';
import { continuationSettingLabel, findingCategoryLabel, targetVariantLabel } from '../src/web/presentation.ts';

function plan(steps: Action[]): Experiment { return { hypothesis: 'probe', expectedInvariant: 'inventory_transition_consistency', steps }; }
function run(payloads: Record<string, unknown>[], variant: TargetVariant) {
  const steps: Action[] = payloads.map((p, i) => ({ op: 'send', id: `m${i}`, to: p.type === 'stock' ? 'stock' : p.type === 'ship' ? 'shipments' : 'reservations', payload: p }));
  steps.push({ op: 'drain' });
  return inventory.executeExperiment(plan(steps), variant);
}
const stock = { type: 'stock', id: 's', sku: 'item', quantity: 10 };
const reserve = { type: 'reserve', id: 'r', reservationId: 'r', sku: 'item', quantity: 10 };

async function snapshot() { return createSystemSnapshot(structuredClone(SEEDED_INVENTORY_BRIEF)); }

describe('new inventory fault variants', () => {
  it('clean preserves accounting under partial ship, cancel/re-reserve and duplicate/conflicting shipment ids', () => {
    const dup = run([stock, reserve, { type: 'ship', id: 'f', reservationId: 'r', quantity: 4 }, { type: 'ship', id: 'f', reservationId: 'r', quantity: 4 }, { type: 'ship', id: 'f', reservationId: 'r', quantity: 5 }], 'clean');
    expect(dup.violations).toEqual([]);
    expect(dup.trace.filter(t => t.outcome === 'duplicate')).toHaveLength(1);
    expect(dup.snapshot.target).toMatchObject({ stock: { item: { received: 10, onHand: 6 } }, reservations: { r: { shipped: 4, remaining: 6 } } });
    const seq = run([stock, { ...reserve, quantity: 7 }, { type: 'ship', id: 'f', reservationId: 'r', quantity: 2 }, { type: 'cancel', id: 'c', reservationId: 'r' }, { type: 'reserve', id: 'r2', reservationId: 'r2', sku: 'item', quantity: 6 }], 'clean');
    expect(seq.violations).toEqual([]);
    expect(seq.snapshot.target).toMatchObject({ reservations: { r: { shipped: 2, cancelled: 5, remaining: 0 }, r2: { remaining: 6 } } });
  });

  it('cancellation candidate differs only on cancellation probe; shipment candidate only on duplicate probe', () => {
    for (const [variant, probeIdx, category] of [['inventory-candidate-b', 0, 'cancellation_release'], ['inventory-candidate-c', 2, 'duplicate_shipment']] as const) {
      const fault = inventory.executeExperiment(inventoryProposal(probeIdx)!, variant);
      expect(fault.violations.map(v => v.category)).toContain(category);
      expect(inventory.executeExperiment(inventoryProposal(probeIdx)!, 'clean').violations).toEqual([]);
      for (const other of [0, 1, 2].filter(i => i !== probeIdx)) {
        // candidate-b is clean on duplicate probe; candidate-c is clean on cancellation probe
        if (variant === 'inventory-candidate-b' && other === 2) expect(inventory.executeExperiment(inventoryProposal(other)!, variant).violations).toEqual([]);
        if (variant === 'inventory-candidate-c' && other === 0) expect(inventory.executeExperiment(inventoryProposal(other)!, variant).violations).toEqual([]);
      }
    }
    // invalid boundaries still rejected on new variants
    expect(run([{ ...stock, quantity: 0 }], 'inventory-candidate-d').violations).toEqual([]);
    expect(run([stock, { ...reserve, quantity: 11 }], 'inventory-candidate-c').snapshot.target).toMatchObject({ reservations: {} });
  });

  it('combined candidate exhibits both categories in separate mock experiments', async () => {
    const record = await runInvestigation({ variant: 'inventory-candidate-d', systemBrief: await snapshot(), provider: new MockProvider(), maxExperiments: 5, continueAfterFindings: true });
    expect(record.continueAfterFindings).toBe(true);
    expect(record.findings.map(f => f.category)).toEqual(['cancellation_release', 'duplicate_shipment']);
    expect(record.findings.map(f => f.experimentIndex)).toEqual([1, 3]);
    expect(record.findings.every(f => f.reproduced && f.cleanControlPassed)).toBe(true);
    expect(record.experiments.map(e => e.cleanControlPassed)).toEqual([true, false, true]);
  });

  it('source bundles for new variants do not leak catalog labels and prompt stays clean', async () => {
    for (const v of ['inventory-candidate-b', 'inventory-candidate-c', 'inventory-candidate-d'] as const) {
      const bundle = inventory.getSourceBundle(v);
      expect(bundle.files[0]!.content).not.toMatch(/candidate|fault|duplicate_shipment|cancellation_release|inventory-mock/);
      const prompt = buildInvestigationPrompt({ contract: inventory.getContract(), source: bundle, history: [], experimentNumber: 1, maxExperiments: 3, systemBrief: await snapshot() });
      expect(prompt.userMessage).not.toMatch(/inventory-candidate|Scripted|inventory-mock/);
    }
  });
});

describe('oracle attribution of continuing discrepancies', () => {
  it('cancellation fault then unrelated receipt does not create a stock_receipt finding', () => {
    const result = run([stock, { ...reserve, quantity: 7 }, { type: 'cancel', id: 'c', reservationId: 'r' }, { type: 'stock', id: 's2', sku: 'other', quantity: 5 }], 'inventory-candidate-b');
    expect([...new Set(result.violations.map(v => v.category))]).toEqual(['cancellation_release']);
    expect(result.violations.map(v => v.category)).not.toContain('stock_receipt');
    // Raw evidence is preserved: the recorded final state still shows the discrepancy.
    expect(result.snapshot.target).toMatchObject({ stock: { other: { received: 5 } }, reservations: { r: { remaining: 7 } } });
    expect(result.violations[0]!.evidence).toHaveProperty('expected');
    expect(result.violations[0]!.evidence).toHaveProperty('actual');
  });

  it('duplicate shipment fault then rejected and correct events does not create new categories', () => {
    const result = run([stock, reserve, { type: 'ship', id: 'f', reservationId: 'r', quantity: 4 }, { type: 'ship', id: 'f', reservationId: 'r', quantity: 4 }, { type: 'ship', id: 'f2', reservationId: 'r', quantity: 99 }, { type: 'stock', id: 's2', sku: 'other', quantity: 3 }], 'inventory-candidate-c');
    expect([...new Set(result.violations.map(v => v.category))]).toEqual(['duplicate_shipment']);
  });

  it('investigation confirms only the cancellation finding for the reproduced sequence', async () => {
    const steps: Action[] = [
      { op: 'send', id: 'm1', to: 'stock', payload: { type: 'stock', id: 's', sku: 'item', quantity: 10 } },
      { op: 'send', id: 'm2', to: 'reservations', payload: { type: 'reserve', id: 'r', reservationId: 'r', sku: 'item', quantity: 7 } },
      { op: 'send', id: 'm3', to: 'reservations', payload: { type: 'cancel', id: 'c', reservationId: 'r' } },
      { op: 'send', id: 'm4', to: 'stock', payload: { type: 'stock', id: 's2', sku: 'other', quantity: 5 } },
      { op: 'drain' },
    ];
    const provider = { kind: 'mock' as const, model: 'stub', propose: vi.fn(async () => ({ experiment: plan(steps), usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } })) };
    const record = await runInvestigation({ variant: 'inventory-candidate-b', systemBrief: await snapshot(), provider, maxExperiments: 1 });
    expect(record.findings.map(f => f.category)).toEqual(['cancellation_release']);
    expect(record.experiments[0]!.cleanControlPassed).toBe(true);
  });

  it('reviewed case A: ship of an incorrectly admitted reservation is not a shipment_quantity finding', () => {
    const payloads = [
      stock,
      { type: 'reserve', id: 'e1', reservationId: 'r1', sku: 'item', quantity: 7 },
      { type: 'reserve', id: 'e2', reservationId: 'r2', sku: 'item', quantity: 7 },
      { type: 'ship', id: 'e3', reservationId: 'r2', quantity: 2 },
    ];
    const result = run(payloads, 'inventory-candidate-a');
    expect([...new Set(result.violations.map(v => v.category))]).toEqual(['reservation_availability']);
    // Raw evidence still records the full divergence and the shipped state.
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations.find(v => v.invariant === 'inventory_transition_consistency')!.evidence).toHaveProperty('expected');
    expect(result.snapshot.target).toMatchObject({ reservations: { r2: { shipped: 2, remaining: 5 } } });
    expect(run(payloads, 'clean').violations).toEqual([]);
  });

  it('reported case: correct insufficient-on-hand shipment rejection after over-reservation is not a shipment_quantity finding', async () => {
    const payloads = [
      stock,
      { type: 'reserve', id: 'e1', reservationId: 'r1', sku: 'item', quantity: 7 },
      { type: 'reserve', id: 'e2', reservationId: 'r2', sku: 'item', quantity: 7 },
      { type: 'ship', id: 'e3', reservationId: 'r1', quantity: 7 },
      { type: 'ship', id: 'e4', reservationId: 'r2', quantity: 4 },
    ];
    const result = run(payloads, 'inventory-candidate-a');
    expect(result.trace.map(t => t.outcome).filter(o => o === 'accepted' || o === 'rejected' || o === 'duplicate')).toEqual(['accepted', 'accepted', 'accepted', 'accepted', 'rejected']);
    expect([...new Set(result.violations.map(v => v.category))]).toEqual(['reservation_availability']);
    // Raw trace/evidence remain complete: final state and global expected/actual are recorded.
    expect(result.snapshot.target).toMatchObject({ stock: { item: { received: 10, onHand: 3 } }, reservations: { r1: { shipped: 7, remaining: 0 }, r2: { shipped: 0, remaining: 7 } } });
    const last = result.violations.filter(v => v.invariant === 'inventory_transition_consistency').at(-1)!;
    expect(last.evidence).toMatchObject({ expectedOutcome: 'rejected', outcome: 'rejected' });
    expect(last.evidence).toHaveProperty('expected');
    expect(last.evidence).toHaveProperty('actual');
    expect(run(payloads, 'clean').violations).toEqual([]);

    const steps: Action[] = payloads.map((p, i) => ({ op: 'send', id: `m${i}`, to: p.type === 'stock' ? 'stock' : p.type === 'ship' ? 'shipments' : 'reservations', payload: p }));
    steps.push({ op: 'drain' });
    const provider = { kind: 'mock' as const, model: 'stub', propose: vi.fn(async () => ({ experiment: plan(steps), usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } })) };
    const record = await runInvestigation({ variant: 'inventory-candidate-a', systemBrief: await snapshot(), provider, maxExperiments: 1 });
    expect(record.findings.map(f => f.category)).toEqual(['reservation_availability']);
    expect(record.experiments[0]!.cleanControlPassed).toBe(true);
  });

  it('rejected shipment retries after restock and duplicate redelivery gain no new category', () => {
    const result = run([
      stock,
      { type: 'reserve', id: 'e1', reservationId: 'r1', sku: 'item', quantity: 7 },
      { type: 'reserve', id: 'e2', reservationId: 'r2', sku: 'item', quantity: 7 },
      { type: 'ship', id: 'e3', reservationId: 'r1', quantity: 7 },
      { type: 'ship', id: 'e4', reservationId: 'r2', quantity: 4 },
      { type: 'stock', id: 's2', sku: 'item', quantity: 10 },
      { type: 'ship', id: 'e4', reservationId: 'r2', quantity: 4 },
      { type: 'ship', id: 'e4', reservationId: 'r2', quantity: 4 },
      { type: 'ship', id: 'e4', reservationId: 'r2', quantity: 5 },
    ], 'inventory-candidate-a');
    expect(result.trace.map(t => t.outcome).filter(o => o === 'accepted' || o === 'rejected' || o === 'duplicate')).toEqual(['accepted', 'accepted', 'accepted', 'accepted', 'rejected', 'accepted', 'accepted', 'duplicate', 'rejected']);
    expect([...new Set(result.violations.map(v => v.category))]).toEqual(['reservation_availability']);
    expect(result.snapshot.target).toMatchObject({ stock: { item: { received: 20, onHand: 9 } }, reservations: { r2: { shipped: 4, remaining: 3 } } });
  });

  it('partial ship and re-cancel on a corrupted reservation stay a cancellation attribution', () => {
    const result = run([
      stock, { ...reserve, quantity: 7 },
      { type: 'ship', id: 'f1', reservationId: 'r', quantity: 2 },
      { type: 'cancel', id: 'c1', reservationId: 'r' },
      { type: 'ship', id: 'f2', reservationId: 'r', quantity: 3 },
      { type: 'cancel', id: 'c2', reservationId: 'r' },
    ], 'inventory-candidate-b');
    expect([...new Set(result.violations.map(v => v.category))]).toEqual(['cancellation_release']);
    expect(result.snapshot.target).toMatchObject({ stock: { item: { onHand: 5 } }, reservations: { r: { shipped: 5, cancelled: 7, remaining: 2 } } });
  });

  it('seeded local decisions use actual onHand/remaining when received-minus-shipped disagrees', () => {
    const fp = (channel: string, p: Record<string, unknown>) => JSON.stringify([channel, ...Object.keys(p).sort().map(k => [k, p[k]])]);
    const stockPayload = { type: 'stock', id: 's', sku: 'item', quantity: 10 };

    // onHand below received-minus-shipped: a reserve the conservation
    // identity would admit must be locally rejected, matching the target.
    const low = new InventoryOracle();
    const lowActual = { stock: { item: { received: 10, onHand: 4 } }, reservations: {}, accepted: { s: fp('stock', stockPayload) } };
    const reservePayload = { type: 'reserve', id: 'e1', reservationId: 'r', sku: 'item', quantity: 5 };
    const lowViolations = [
      ...low.check('stock', stockPayload, structuredClone(lowActual), 'accepted', 1),
      ...low.check('reservations', reservePayload, structuredClone(lowActual), 'rejected', 2),
    ];
    expect([...new Set(lowViolations.map(v => v.category))]).toEqual(['stock_receipt']);

    // onHand above received-minus-shipped: a reserve within actual
    // on-hand is locally correct given the target's balances.
    const high = new InventoryOracle();
    const highPre = { stock: { item: { received: 10, onHand: 15 } }, reservations: {}, accepted: { s: fp('stock', stockPayload) } };
    const bigReserve = { type: 'reserve', id: 'e1', reservationId: 'r', sku: 'item', quantity: 12 };
    const highPost = { stock: { item: { received: 10, onHand: 15 } }, reservations: { r: { sku: 'item', quantity: 12, remaining: 12, shipped: 0, cancelled: 0 } }, accepted: { s: fp('stock', stockPayload), e1: fp('reservations', bigReserve) } };
    const highViolations = [
      ...high.check('stock', stockPayload, structuredClone(highPre), 'accepted', 1),
      ...high.check('reservations', bigReserve, structuredClone(highPost), 'accepted', 2),
    ];
    expect([...new Set(highViolations.map(v => v.category))]).toEqual(['stock_receipt']);

    // Missing stock for an existing (incorrectly admitted) reservation:
    // shipment must be locally rejected, not expected to succeed.
    const missing = new InventoryOracle();
    const admitted = { stock: {}, reservations: { r: { sku: 'item', quantity: 5, remaining: 5, shipped: 0, cancelled: 0 } }, accepted: { e1: fp('reservations', reservePayload) } };
    const shipPayload = { type: 'ship', id: 'f', reservationId: 'r', quantity: 3 };
    const missingStep1 = missing.check('reservations', reservePayload, structuredClone(admitted), 'accepted', 1);
    const missingStep2 = missing.check('shipments', shipPayload, structuredClone(admitted), 'rejected', 2);
    expect([...new Set([...missingStep1, ...missingStep2].map(v => v.category))]).toEqual(['reservation_availability']);
    expect(missingStep2.find(v => v.invariant === 'inventory_transition_consistency')!.evidence).toMatchObject({ expectedOutcome: 'rejected', outcome: 'rejected' });
  });

  it('reviewed case A with dotted/special identifiers keeps the same attribution', () => {
    const result = run([
      { type: 'stock', id: 's.1', sku: 'it.em$x', quantity: 10 },
      { type: 'reserve', id: 'e.1', reservationId: 'r.1', sku: 'it.em$x', quantity: 7 },
      { type: 'reserve', id: 'e.2', reservationId: 'r.2', sku: 'it.em$x', quantity: 7 },
      { type: 'ship', id: 'e.3', reservationId: 'r.2', quantity: 2 },
      { type: 'ship', id: 'e.4', reservationId: 'r.1', quantity: 99 },
    ], 'inventory-candidate-a');
    expect([...new Set(result.violations.map(v => v.category))]).toEqual(['reservation_availability']);
  });

  it('reviewed case B: valid cancel after a duplicate shipment is not a cancellation_release finding', async () => {
    const payloads = [
      stock, reserve,
      { type: 'ship', id: 'f', reservationId: 'r', quantity: 4 },
      { type: 'ship', id: 'f', reservationId: 'r', quantity: 4 },
      { type: 'cancel', id: 'c', reservationId: 'r' },
    ];
    const result = run(payloads, 'inventory-candidate-c');
    expect([...new Set(result.violations.map(v => v.category))]).toEqual(['duplicate_shipment']);
    expect(result.snapshot.target).toMatchObject({ reservations: { r: { shipped: 8, cancelled: 2, remaining: 0 } } });
    expect(run(payloads, 'clean').violations).toEqual([]);

    const steps: Action[] = payloads.map((p, i) => ({ op: 'send', id: `m${i}`, to: p.type === 'stock' ? 'stock' : p.type === 'ship' ? 'shipments' : 'reservations', payload: p }));
    steps.push({ op: 'drain' });
    const provider = { kind: 'mock' as const, model: 'stub', propose: vi.fn(async () => ({ experiment: plan(steps), usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } })) };
    const record = await runInvestigation({ variant: 'inventory-candidate-c', systemBrief: await snapshot(), provider, maxExperiments: 1 });
    expect(record.findings.map(f => f.category)).toEqual(['duplicate_shipment']);
    expect(record.experiments[0]!.cleanControlPassed).toBe(true);
  });

  it('ship after a faulty cancel that left remaining stock stays a cancellation attribution', () => {
    const result = run([stock, { ...reserve, quantity: 7 }, { type: 'cancel', id: 'c', reservationId: 'r' }, { type: 'ship', id: 'f', reservationId: 'r', quantity: 2 }], 'inventory-candidate-b');
    expect([...new Set(result.violations.map(v => v.category))]).toEqual(['cancellation_release']);
  });

  it('genuine cancellation and duplicate-shipment faults in one experiment are both detected', () => {
    const result = run([
      stock, { ...reserve, quantity: 7 }, { type: 'ship', id: 'sh1', reservationId: 'r', quantity: 2 }, { type: 'cancel', id: 'c', reservationId: 'r' },
      { type: 'stock', id: 's2', sku: 'other', quantity: 10 }, { type: 'reserve', id: 'r2', reservationId: 'r2', sku: 'other', quantity: 10 },
      { type: 'ship', id: 'f', reservationId: 'r2', quantity: 4 }, { type: 'ship', id: 'f', reservationId: 'r2', quantity: 4 },
    ], 'inventory-candidate-d');
    expect([...new Set(result.violations.map(v => v.category))]).toEqual(['cancellation_release', 'duplicate_shipment']);
  });
});

describe('clean-control confirmation by invariant', () => {
  const contract = { name: 'T', description: 't', operations: [], messages: [], invariants: [{ id: 'inventory_transition_consistency', description: 'x' }], limits: {} };
  const source = { hash: 'src-hash', files: [{ path: 's.ts', content: 'x' }] };
  const exp: Experiment = { hypothesis: 'probe', expectedInvariant: 'inventory_transition_consistency', steps: [{ op: 'drain' }] };
  const provider = { kind: 'mock' as const, model: 'stub', propose: vi.fn(async () => ({ experiment: structuredClone(exp), usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } })) };
  function sim(opts: { candidate: Violation[]; clean: Violation[]; cleanValid?: boolean; cleanHash?: string; replayDrift?: boolean }): SimulatorApi {
    let candidateCalls = 0;
    const result = (violations: Violation[], valid = true, hash = source.hash): ExperimentResult => ({ schemaVersion: 1, experiment: exp, sourceHash: hash, trace: [], snapshot: { ok: true }, violations, rejections: [], valid });
    return {
      getContract: () => contract,
      getSourceBundle: () => source,
      parseExperiment: (i: unknown) => i as Experiment,
      executeExperiment: (_e, variant) => {
        if (variant === 'clean') return result(opts.clean, opts.cleanValid ?? true, opts.cleanHash ?? source.hash);
        candidateCalls++;
        if (opts.replayDrift && candidateCalls > 1) return result([], true);
        return result(opts.candidate);
      },
    };
  }
  const candViolation: Violation = { id: 'v1', invariant: 'inventory_transition_consistency', category: 'cancellation_release', message: 'm', step: 1, evidence: {} };

  it('clean violation of the same invariant with a different category blocks confirmation', async () => {
    const cleanViolation: Violation = { id: 'v2', invariant: 'inventory_transition_consistency', category: 'stock_receipt', message: 'm', step: 1, evidence: {} };
    const record = await runInvestigation({ variant: 'candidate-a', provider, simulator: sim({ candidate: [candViolation], clean: [cleanViolation] }), maxExperiments: 1 });
    expect(record.findings).toEqual([]);
    expect(record.experiments[0]!.cleanControlPassed).toBe(false);
  });

  it('clean violation of a different invariant does not block confirmation', async () => {
    const cleanViolation: Violation = { id: 'v2', invariant: 'stock_conservation', category: 'stock_receipt', message: 'm', step: 1, evidence: {} };
    const record = await runInvestigation({ variant: 'candidate-a', provider, simulator: sim({ candidate: [candViolation], clean: [cleanViolation] }), maxExperiments: 1 });
    expect(record.findings).toHaveLength(1);
    expect(record.experiments[0]!.cleanControlPassed).toBe(true);
  });

  it('invalid clean, source-drifted clean and candidate replay drift all block confirmation', async () => {
    for (const [label, s] of [
      ['invalid clean', sim({ candidate: [candViolation], clean: [], cleanValid: false })],
      ['source-drifted clean', sim({ candidate: [candViolation], clean: [], cleanHash: 'drifted-hash' })],
      ['candidate replay drift', sim({ candidate: [candViolation], clean: [], replayDrift: true })],
    ] as const) {
      const record = await runInvestigation({ variant: 'candidate-a', provider, simulator: s, maxExperiments: 1 });
      expect(record.findings, label).toEqual([]);
      expect(record.experiments[0]!.cleanControlPassed).toBe(false);
    }
  });
});

describe('replay category compatibility and presentation labels', () => {
  const baseResult = (violations: Violation[]): ExperimentResult => ({ schemaVersion: 1, experiment: { hypothesis: 'h', expectedInvariant: 'x', steps: [] }, sourceHash: 'h', trace: [], snapshot: {}, violations, rejections: [], valid: true });
  it('legacy record without category replays against categorised execution; categorised mismatch does not', () => {
    const legacy: Violation = { id: 'v1', invariant: 'inventory_transition_consistency', message: 'm', step: 1, evidence: {} };
    const categorised: Violation = { ...legacy, category: 'cancellation_release' };
    expect(compareSemanticReplay(baseResult([legacy]), baseResult([categorised])).violationsMatched).toBe(true);
    expect(compareSemanticReplay(baseResult([categorised]), baseResult([{ ...legacy, category: 'stock_receipt' }])).violationsMatched).toBe(false);
  });

  it('new category-aware result does not replay exactly after categories are removed or changed', () => {
    const categorised: Violation = { id: 'v1', invariant: 'inventory_transition_consistency', category: 'cancellation_release', message: 'm', step: 1, evidence: {} };
    const aware = (violations: Violation[]): ExperimentResult => ({ ...baseResult(violations), categoryAware: true });
    const stripped: Violation = { id: 'v1', invariant: 'inventory_transition_consistency', message: 'm', step: 1, evidence: {} };
    expect(compareSemanticReplay(aware([stripped]), aware([categorised])).violationsMatched).toBe(false);
    expect(compareSemanticReplay(aware([{ ...categorised, category: 'stock_receipt' }]), aware([categorised])).violationsMatched).toBe(false);
    expect(compareSemanticReplay(aware([categorised]), aware([categorised])).violationsMatched).toBe(true);
  });

  it('saved new run denies exact whole/selected replay after result categories are stripped but finding keeps its category', async () => {
    const record = await runInvestigation({ variant: 'inventory-candidate-b', systemBrief: await snapshot(), provider: new MockProvider(), maxExperiments: 1 });
    expect(record.findings.map(f => f.category)).toEqual(['cancellation_release']);
    expect(record.experiments[0]!.result.categoryAware).toBe(true);
    expect((await replayRun(structuredClone(record), 'runs')).exactReproductionClaimed).toBe(true);

    const tampered = structuredClone(record);
    for (const exp of tampered.experiments) for (const v of exp.result.violations) delete v.category;
    expect(tampered.findings[0]!.category).toBe('cancellation_release');
    expect((await replayRun(tampered, 'runs')).exactReproductionClaimed).toBe(false);
    expect((await replaySelectedExperiment(tampered, 0, 'runs')).exactReproductionClaimed).toBe(false);

    const changed = structuredClone(record);
    for (const exp of changed.experiments) for (const v of exp.result.violations) v.category = 'stock_receipt';
    expect((await replayRun(changed, 'runs')).exactReproductionClaimed).toBe(false);
  });

  it('labels observed categories, legacy fallback, continuation and target choices readably', () => {
    expect(findingCategoryLabel({ category: 'cancellation_release', violation: { invariant: 'x' } as Violation })).toMatch(/Cancellation release/);
    expect(findingCategoryLabel({ violation: { invariant: 'x' } as Violation })).toMatch(/Not recorded/);
    expect(findingCategoryLabel({ category: '<img src=x onerror=alert(1)>', violation: { invariant: 'x' } as Violation })).toContain('<img');
    expect(continuationSettingLabel(true)).toMatch(/on/i);
    expect(continuationSettingLabel(undefined)).toMatch(/off/i);
    expect(targetVariantLabel('inventory-candidate-b')).toBe('Inventory Candidate B');
    expect(targetVariantLabel('candidate-b')).toBe('Candidate B');
    expect(targetVariantLabel('clean')).toBe('Clean control');
  });
});

describe('finding continuation', () => {
  it('defaults to stopping at first verified finding and does not record the opt-in', async () => {
    const record = await runInvestigation({ variant: 'inventory-candidate-d', systemBrief: await snapshot(), provider: new MockProvider(), maxExperiments: 5 });
    expect(record.findings.map(f => f.category)).toEqual(['cancellation_release']);
    expect(record.experiments).toHaveLength(1);
    expect(record.stopReason).toBe('Verified finding confirmed');
    expect(record.continueAfterFindings).toBeUndefined();
  });

  it('clean exhaustion with continuation yields no findings', async () => {
    const record = await runInvestigation({ variant: 'clean', systemBrief: await snapshot(), provider: new MockProvider(), maxExperiments: 5, continueAfterFindings: true });
    expect(record.findings).toEqual([]);
    expect(record.experiments).toHaveLength(3);
  });

  it('experiment bound with continuation reports the bound after findings', async () => {
    const record = await runInvestigation({ variant: 'inventory-candidate-d', systemBrief: await snapshot(), provider: new MockProvider(), maxExperiments: 1, continueAfterFindings: true });
    expect(record.findings).toHaveLength(1);
    expect(record.stopReason).toBe('Finite experiment bound reached after verified findings');
  });

  it('deduplicates the same category across experiments', async () => {
    const probe = inventoryProposal(0)!;
    const provider = { kind: 'mock' as const, model: 'stub', propose: vi.fn(async () => ({ experiment: structuredClone(probe), usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } })) };
    const record = await runInvestigation({ variant: 'inventory-candidate-b', systemBrief: await snapshot(), provider, maxExperiments: 3, continueAfterFindings: true });
    expect(record.experiments).toHaveLength(3);
    expect(record.findings).toHaveLength(1);
    expect(record.findings[0]!.category).toBe('cancellation_release');
  });

  it('preserves an earlier finding when a later proposal fails', async () => {
    const probe = inventoryProposal(0)!;
    const provider = { kind: 'mock' as const, model: 'stub', propose: vi.fn()
      .mockResolvedValueOnce({ experiment: structuredClone(probe), usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } })
      .mockRejectedValueOnce(new Error('boom')) };
    const record = await runInvestigation({ variant: 'inventory-candidate-b', systemBrief: await snapshot(), provider, maxExperiments: 5, continueAfterFindings: true });
    expect(record.status).toBe('failed');
    expect(record.stopReason).toBe('Provider failed to propose: boom');
    expect(record.findings).toHaveLength(1);
  });

  it('preserves an earlier finding on cancellation after it', async () => {
    const probe = inventoryProposal(0)!;
    const controller = new AbortController();
    const provider = { kind: 'mock' as const, model: 'stub', propose: vi.fn(async () => {
      if (provider.propose.mock.calls.length > 1) { controller.abort(); throw new DOMException('aborted', 'AbortError'); }
      return { experiment: structuredClone(probe), usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } };
    }) };
    const record = await runInvestigation({ variant: 'inventory-candidate-b', systemBrief: await snapshot(), provider, maxExperiments: 5, continueAfterFindings: true, signal: controller.signal });
    expect(record.status).toBe('cancelled');
    expect(record.findings).toHaveLength(1);
  });
});
