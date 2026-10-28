import { describe, expect, it, vi } from 'vitest';
import type { Action, Experiment, ProviderContext, TargetVariant } from '../src/domain.ts';
import * as inventory from '../src/inventory/index.ts';
import { InventoryService } from '../src/inventory/variants/clean/service.ts';
import { InventoryOracle } from '../src/inventory/oracle.ts';
import { parseExperiment as tradingParser } from '../src/simulator/parser.ts';
import { runInvestigation } from '../src/investigation/index.ts';
import { buildInvestigationPrompt, PROMPT_TEMPLATE_HASH } from '../src/investigation/prompt.ts';
import { INVENTORY_PROMPT_TEMPLATE_HASH } from '../src/investigation/inventory-prompt.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { MetaProvider } from '../src/providers/meta.ts';
import { SEEDED_INVENTORY_BRIEF, createSystemSnapshot, computeSnapshotHash } from '../src/systems/index.ts';
import { inventoryProposal } from '../src/providers/inventory-mock.ts';

function plan(steps: Action[]): Experiment { return { hypothesis: 'Inventory boundary probe', expectedInvariant: 'stock_conservation', steps }; }
function event(payload: Record<string, unknown>, id: string): Action {
  return { op: 'send', id, to: payload.type === 'stock' ? 'stock' : payload.type === 'ship' ? 'shipments' : 'reservations', payload };
}
function run(payloads: Record<string, unknown>[], variant: TargetVariant = 'clean') {
  return inventory.executeExperiment(plan([...payloads.map((p, i) => event(p, `m${i}`)), { op: 'drain' }]), variant);
}
const stock = { type: 'stock', id: 's', sku: 'item', quantity: 10 };
const reserve = { type: 'reserve', id: 'r', reservationId: 'r', sku: 'item', quantity: 10 };
const ship = { type: 'ship', id: 'f', reservationId: 'r', quantity: 4 };
const cancel = { type: 'cancel', id: 'c', reservationId: 'r' };

describe('Inventory transitions and independent checks', () => {
  it('starts empty and handles the exact stock limit and partial shipment/cancellation/re-reservation', () => {
    expect(inventory.executeExperiment(plan([]), 'clean').snapshot.target).toEqual({ stock: {}, reservations: {}, accepted: {} });
    const result = run([stock, reserve, ship, cancel, { ...reserve, id: 'r2', reservationId: 'r2', quantity: 6 }]);
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.rejections).toEqual([]);
    expect(result.snapshot.target).toMatchObject({ stock: { item: { received: 10, onHand: 6 } }, reservations: {
      r: { remaining: 0, shipped: 4, cancelled: 6 }, r2: { remaining: 6 },
    } });
  });

  it('accounts for committed and shipped quantities across competing reservations and SKUs', () => {
    const result = run([stock, { ...reserve, quantity: 7 }, ship,
      { ...reserve, id: 'r2', reservationId: 'r2', quantity: 4 },
      { ...reserve, id: 'r3', reservationId: 'r3', quantity: 3 },
      { ...reserve, id: 'r4', reservationId: 'r4', sku: 'absent', quantity: 1 },
      { ...stock, id: 's2', sku: 'other', quantity: 2 },
      { ...reserve, id: 'r5', reservationId: 'r5', sku: 'other', quantity: 2 },
    ]);
    expect(result.violations).toEqual([]);
    expect(result.rejections).toHaveLength(2);
    expect(result.snapshot.target).toMatchObject({ stock: { item: { onHand: 6 } }, reservations: { r: { remaining: 3 }, r3: { remaining: 3 }, r5: { remaining: 2 } } });
  });

  it.each(['clean', 'inventory-candidate-a'] as const)('deduplicates accepted events and rejects conflicting ids in %s', variant => {
    const result = run([stock, stock, { ...stock, quantity: 11 }, reserve, reserve, ship, ship, cancel, cancel,
      { ...cancel, id: 'c2' }, { ...ship, id: 'f2' }, { ...reserve, id: 'r2' }], variant);
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.rejections).toHaveLength(4);
    expect(result.trace.filter(t => t.outcome === 'duplicate')).toHaveLength(4);
  });

  it('rejects out-of-order cancellation/shipment without poisoning ids and allows retry after prerequisites', () => {
    const result = run([cancel, ship, { ...reserve, quantity: 3 }, stock, { ...reserve, quantity: 3 }, { ...ship, quantity: 3 },
      { ...ship, id: 'f2', quantity: 1 }, { ...cancel, id: 'c2' }]);
    expect(result.violations).toEqual([]);
    expect(result.rejections).toHaveLength(5);
    expect(result.snapshot.target).toMatchObject({ reservations: { r: { shipped: 3, remaining: 0 } } });
  });

  it.each([0, -1, 1.5, 1000001, Number.MAX_SAFE_INTEGER, '10', null])('rejects invalid quantity %s without consuming its business identity', quantity => {
    const result = run([{ ...stock, quantity }, stock]);
    expect(result.valid).toBe(true);
    expect(result.rejections).toHaveLength(1);
    expect(result.violations).toEqual([]);
    expect(result.snapshot.target).toMatchObject({ stock: { item: { received: 10 } } });
  });

  it('rejects malformed, extra, unknown and cross-channel payloads; treats special ids as data', () => {
    const result = inventory.executeExperiment(plan([
      { op: 'send', id: 'bad', to: 'stock', payload: null },
      event({ ...stock, extra: true }, 'extra'), event({ ...stock, type: 'unknown' }, 'unknown'),
      { op: 'send', id: 'wrong', to: 'shipments', payload: stock },
      event({ ...stock, id: '__proto__', sku: '__proto__' }, 'special'),
      event({ ...reserve, id: 'constructor', sku: '__proto__', reservationId: '__proto__' }, 'special-reserve'),
      { op: 'drain' },
    ]), 'clean');
    expect(result.valid).toBe(true);
    expect(result.rejections).toHaveLength(4);
    expect(result.violations).toEqual([]);
  });

  it('enforces total receipt bound and supports exact maximum quantity', () => {
    const result = run([{ ...stock, quantity: 1000000 }, { ...stock, id: 'overflow', quantity: 1 }, { ...reserve, quantity: 1000000 }]);
    expect(result.violations).toEqual([]);
    expect(result.rejections).toHaveLength(1);
  });

  it('detects independent corrupted transitions and reproduces over-reservation only on the selected candidate', () => {
    const target = new InventoryService();
    target.receive('stock', stock);
    const corrupted = target.snapshot();
    corrupted.stock.item!.onHand = 12;
    expect(new InventoryOracle().check('stock', stock, corrupted, 'accepted', 1).map(v => v.invariant)).toContain('stock_conservation');
    const probe = inventoryProposal(1)!;
    const fault = inventory.executeExperiment(probe, 'inventory-candidate-a');
    expect(fault.valid).toBe(true);
    expect(fault.violations.map(v => v.invariant)).toContain('stock_conservation');
    expect(inventory.executeExperiment(probe, 'inventory-candidate-a')).toEqual(fault);
    expect(inventory.executeExperiment(probe, 'clean').violations).toEqual([]);
  });
});

describe('Selected adapter scheduling, prompts and preconditions', () => {
  it('bounds plans and rejects unsupported operations and channels in both directions', () => {
    for (const step of [{ op: 'fill' }, { op: 'confirm_cancel' }, { op: 'send', id: 'm', to: 'market', payload: {} }]) expect(() => inventory.parseExperiment(plan([step as Action]))).toThrow();
    expect(() => tradingParser(plan([event(stock, 'm')]))).toThrow();
    expect(() => inventory.parseExperiment(plan(Array(101).fill({ op: 'drain' })))).toThrow();
    for (const step of [{ op: 'advance', ticks: 1001 }, { op: 'send', id: 'm', to: 'stock', payload: {}, delay: -1 }]) expect(() => inventory.parseExperiment(plan([step as Action]))).toThrow();
  });

  it('delivers delayed and duplicated events deterministically while rejecting impossible scheduling', () => {
    const result = inventory.executeExperiment(plan([
      { ...event(stock, 's'), delay: 5 }, { op: 'advance', ticks: 5 }, { op: 'deliver', messageId: 's' },
      { op: 'duplicate', messageId: 's', id: 's2', delay: 3 }, { op: 'drain' },
    ]), 'clean');
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.snapshot.logicalTime).toBe(8);
    expect(result.trace.filter(t => t.action === 'deliver').map(t => t.outcome)).toEqual(['accepted', 'duplicate']);
    for (const steps of [
      [{ op: 'deliver', messageId: 'missing' }],
      [{ ...event(stock, 's'), delay: 1 }, { op: 'deliver', messageId: 's' }],
      [event(stock, 's'), event(stock, 's')],
      [{ op: 'advance', ticks: 1000 }, { op: 'advance', ticks: 1 }],
      [{ op: 'duplicate', messageId: 'missing', id: 'm' }],
    ]) expect(inventory.executeExperiment(plan(steps as Action[]), 'clean').valid).toBe(false);
  });

  it('uses inventory prompt identity for both provider paths without exposing fixture or variant labels', async () => {
    const systemBrief = await createSystemSnapshot(structuredClone(SEEDED_INVENTORY_BRIEF));
    const context: ProviderContext = { contract: inventory.getContract(), source: inventory.getSourceBundle('inventory-candidate-a'), history: [], experimentNumber: 1, maxExperiments: 3, systemBrief };
    const prompt = buildInvestigationPrompt(context);
    expect(new MetaProvider({ apiKey: 'unused' }).serializePrompt(context)).toEqual(prompt);
    expect(prompt.systemMessage).toContain('inventory');
    expect(prompt.systemMessage).not.toMatch(/trading|fill|confirm_cancel|market\|credit/);
    expect(prompt.userMessage).not.toMatch(/inventory-candidate|Scripted|inventory-mock|InventoryOracle|over-reserv/);
    const reply = await new MockProvider().propose(context);
    expect(reply.requestAudit?.promptTemplateHash).toBe(INVENTORY_PROMPT_TEMPLATE_HASH);
    expect(reply.requestAudit?.promptTemplateHash).not.toBe(PROMPT_TEMPLATE_HASH);
    expect(reply.requestSent).toBe(false);
    const record = await runInvestigation({ variant: 'inventory-candidate-a', systemBrief, provider: new MockProvider() });
    expect(record.contextAudit.promptTemplateHash).toBe(INVENTORY_PROMPT_TEMPLATE_HASH);
    expect(record.findings.length).toBeGreaterThan(0);
    expect(record.experiments.every(e => e.result.valid)).toBe(true);
    expect(record.experiments[1]).toMatchObject({ replayVerified: true, cleanControlPassed: true });
    expect(record.proposalAttempts?.every(a => a.request?.promptTemplateHash === INVENTORY_PROMPT_TEMPLATE_HASH && a.requestSent === false)).toBe(true);
    expect((await runInvestigation({ variant: 'clean', systemBrief, provider: new MockProvider() })).findings).toEqual([]);
  });

  it('fails safely before proposal on unknown/unconfigured adapters, cross-adapter variants and tampered hash/contract', async () => {
    const snapshot = await createSystemSnapshot(structuredClone(SEEDED_INVENTORY_BRIEF));
    const provider = { kind: 'mock' as const, model: 'spy', propose: vi.fn() };
    const tampered = structuredClone(snapshot); tampered.contract!.limits.maxQuantity = 9; tampered.hash = computeSnapshotHash(tampered.brief, tampered.contract);
    const cases = [
      { systemBrief: snapshot, variant: 'candidate-a' },
      { systemBrief: { ...snapshot, hash: 'wrong' }, variant: 'clean' },
      { systemBrief: tampered, variant: 'clean' },
      { systemBrief: { ...snapshot, brief: { ...snapshot.brief, adapterId: 'unknown' } }, variant: 'clean' },
      { systemBrief: { ...snapshot, brief: { ...snapshot.brief, adapterId: 'unconfigured' } }, variant: 'clean' },
      { systemBrief: undefined, variant: 'inventory-candidate-a' },
    ];
    for (const c of cases) await expect(runInvestigation({ ...c, provider } as any)).rejects.toThrow();
    expect(provider.propose).not.toHaveBeenCalled();
  });

  it('marks unsupported proposals invalid_plan but target payload rejection executed and valid', async () => {
    const snapshot = await createSystemSnapshot(structuredClone(SEEDED_INVENTORY_BRIEF));
    const provider = { kind: 'mock' as const, model: 'bounded', propose: vi.fn()
      .mockResolvedValueOnce({ experiment: plan([{ op: 'fill' } as Action]), usage: {} })
      .mockResolvedValueOnce({ experiment: plan([event({ type: 'bad' }, 'bad'), { op: 'drain' }]), usage: {} }) };
    const record = await runInvestigation({ variant: 'clean', maxExperiments: 1, provider, systemBrief: snapshot });
    expect(record.proposalAttempts?.map(a => a.status)).toEqual(['invalid_plan', 'executed']);
    expect(record.experiments[0]?.result).toMatchObject({ valid: true, violations: [], rejections: [{ step: 2, reason: 'Target rejected payload: bad' }] });
  });
});

describe('Inventory violation IDs', () => {
  const stockFor = (sku: string, id: string) => ({ type: 'stock', id, sku, quantity: 10 });
  const reserveFor = (sku: string, id: string) => ({ type: 'reserve', id, reservationId: id, sku, quantity: 7 });

  it('gives repeated violations in one drain unique deterministic IDs and preserves first IDs', () => {
    const payloads = [stock, reserve, { ...reserve, id: 'r2', reservationId: 'r2' }, { ...reserve, id: 'r3', reservationId: 'r3' }];
    const result = run(payloads, 'inventory-candidate-a');
    // Drain is step 5; the second and third reservations each break both invariants.
    expect(result.violations.map(v => v.id)).toEqual(['transition-5', 'stock-5-item', 'transition-5-2', 'stock-5-item-2']);
    expect(new Set(result.violations.map(v => v.id)).size).toBe(result.violations.length);
    expect(inventory.executeExperiment(plan([...payloads.map((p, i) => event(p, `m${i}`)), { op: 'drain' }]), 'inventory-candidate-a')).toEqual(result);
    expect(run(payloads, 'clean').violations).toEqual([]);
  });

  it('keeps the old base ID for a single-occurrence violation', () => {
    const fault = inventory.executeExperiment(inventoryProposal(1)!, 'inventory-candidate-a');
    expect(fault.violations.map(v => v.id)).toEqual(['transition-5', 'stock-5-item']);
  });

  it('keeps same-step violations for different SKUs distinct without suffixes', () => {
    const result = run([
      stockFor('alpha', 'sa'), stockFor('beta', 'sb'),
      reserveFor('alpha', 'ra1'), reserveFor('alpha', 'ra2'),
      reserveFor('beta', 'rb1'), reserveFor('beta', 'rb2'),
    ], 'inventory-candidate-a');
    const stockIds = result.violations.filter(v => v.invariant === 'stock_conservation').map(v => v.id);
    // Later deliveries in the drain re-detect the still-violated alpha SKU before beta breaks.
    expect(stockIds).toEqual(['stock-7-alpha', 'stock-7-alpha-2', 'stock-7-alpha-3', 'stock-7-beta']);
    expect(new Set(result.violations.map(v => v.id)).size).toBe(result.violations.length);
  });

  it('handles a SKU that collides with a generated suffix', () => {
    const result = run([
      stockFor('item', 's1'), stockFor('item-2', 's2'),
      reserveFor('item', 'r1'), reserveFor('item', 'r2'), reserveFor('item', 'r3'),
      reserveFor('item-2', 'r4'), reserveFor('item-2', 'r5'),
    ], 'inventory-candidate-a');
    const stockIds = result.violations.filter(v => v.invariant === 'stock_conservation').map(v => v.id);
    // r3's repeat for "item" claims stock-8-item-2, so the genuine "item-2" violation must move aside.
    expect(stockIds).toEqual(['stock-8-item', 'stock-8-item-2', 'stock-8-item-3', 'stock-8-item-4', 'stock-8-item-2-2']);
    expect(new Set(result.violations.map(v => v.id)).size).toBe(result.violations.length);
    expect(result.violations.filter(v => v.invariant === 'inventory_transition_consistency').map(v => v.id))
      .toEqual(['transition-8', 'transition-8-2', 'transition-8-3', 'transition-8-4']);
  });
});
