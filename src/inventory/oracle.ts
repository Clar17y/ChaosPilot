import type { Violation } from '../domain.ts';
import { canonicalJson } from '../evidence.ts';
import type { InventoryState } from './variants/clean/service.ts';

function eventFingerprint(channel: string, payload: Record<string, unknown>): string {
  return JSON.stringify([channel, ...Object.keys(payload).sort().map(key => [key, payload[key]])]);
}

// Independent specification reducer: no calls into target validation or transitions.
export class InventoryOracle {
  private receipts = new Map<string, number>();
  private onHand = new Map<string, number>();
  private orders = new Map<string, { sku: string; quantity: number; remaining: number; shipped: number; cancelled: number }>();
  private events = new Map<string, string>();
  private usedViolationIds = new Set<string>();
  private previousActual: InventoryState | null = null;
  private activeCategory: string | null = null;

  private uniqueViolationId(base: string): string {
    if (!this.usedViolationIds.has(base)) { this.usedViolationIds.add(base); return base; }
    for (let n = 2; ; n++) { const candidate = `${base}-${n}`; if (!this.usedViolationIds.has(candidate)) { this.usedViolationIds.add(candidate); return candidate; } }
  }

  private apply(channel: string, raw: unknown): string {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'rejected';
    const p = raw as Record<string, unknown>;
    const keys = Object.keys(p).sort().join(',');
    const id = (v: unknown): v is string => typeof v === 'string' && v.trim() === v && v.length >= 1 && v.length <= 64;
    const qty = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= 1000000;
    if (!id(p.id)) return 'rejected';
    const kind = p.type;
    if (!(kind === 'stock' && channel === 'stock' && keys === 'id,quantity,sku,type'
      || kind === 'reserve' && channel === 'reservations' && keys === 'id,quantity,reservationId,sku,type'
      || kind === 'cancel' && channel === 'reservations' && keys === 'id,reservationId,type'
      || kind === 'ship' && channel === 'shipments' && keys === 'id,quantity,reservationId,type')) return 'rejected';
    const fingerprint = eventFingerprint(channel, p);
    if (this.events.has(p.id)) return this.events.get(p.id) === fingerprint ? 'duplicate' : 'rejected';
    if (kind === 'stock') {
      if (!id(p.sku) || !qty(p.quantity) || (this.receipts.get(p.sku) ?? 0) + p.quantity > 1000000) return 'rejected';
      this.receipts.set(p.sku, (this.receipts.get(p.sku) ?? 0) + p.quantity);
      this.onHand.set(p.sku, (this.onHand.get(p.sku) ?? 0) + p.quantity);
    } else if (kind === 'reserve') {
      if (!id(p.sku) || !id(p.reservationId) || !qty(p.quantity) || this.orders.has(p.reservationId)) return 'rejected';
      // Availability is on-hand minus outstanding remaining, using the
      // balances this reducer was seeded with -- never a conservation
      // identity (received - shipped) that a corrupted seed may violate.
      const reserved = [...this.orders.values()].filter(r => r.sku === p.sku).reduce((n, r) => n + r.remaining, 0);
      if (p.quantity > (this.onHand.get(p.sku) ?? 0) - reserved) return 'rejected';
      this.orders.set(p.reservationId, { sku: p.sku, quantity: p.quantity, remaining: p.quantity, shipped: 0, cancelled: 0 });
    } else {
      if (!id(p.reservationId)) return 'rejected';
      const r = this.orders.get(p.reservationId);
      if (!r || r.remaining <= 0) return 'rejected';
      if (kind === 'cancel') { r.cancelled += r.remaining; r.remaining = 0; }
      else {
        if (!qty(p.quantity) || p.quantity > r.remaining || p.quantity > (this.onHand.get(r.sku) ?? 0)) return 'rejected';
        r.remaining -= p.quantity;
        r.shipped += p.quantity;
        this.onHand.set(r.sku, (this.onHand.get(r.sku) ?? 0) - p.quantity);
      }
    }
    this.events.set(p.id, fingerprint);
    return 'accepted';
  }

  private categoryFor(channel: string, payload: unknown, events: Map<string, string> = this.events): string {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return 'inventory_transition';
    const p = payload as Record<string, unknown>;
    if (typeof p.id === 'string' && events.has(p.id)) {
      const fingerprint = eventFingerprint(channel, p);
      if (events.get(p.id) === fingerprint) return p.type === 'ship' ? 'duplicate_shipment' : 'duplicate_event';
    }
    if (p.type === 'cancel') return 'cancellation_release';
    if (p.type === 'ship') return 'shipment_quantity';
    if (p.type === 'reserve') return 'reservation_availability';
    if (p.type === 'stock') return 'stock_receipt';
    return 'inventory_transition';
  }

  /** Flattened per-path divergence signatures. Numeric leaves use the
   * actual-minus-expected delta, so a residual discrepancy carried through a
   * correctly processed later event keeps the same signature. */
  private divergence(expected: unknown, actual: unknown, outcome: string, expectedOutcome: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (path: string, e: unknown, a: unknown): void => {
      if (typeof e === 'number' && typeof a === 'number') {
        if (e !== a) out.set(path, `delta:${a - e}`);
        return;
      }
      if (e && a && typeof e === 'object' && typeof a === 'object' && !Array.isArray(e) && !Array.isArray(a)) {
        // NUL separator: identifiers may contain dots or other punctuation.
        for (const k of new Set([...Object.keys(e), ...Object.keys(a)])) walk(path ? `${path}\0${k}` : k, (e as Record<string, unknown>)[k], (a as Record<string, unknown>)[k]);
        return;
      }
      if (canonicalJson(e ?? null) !== canonicalJson(a ?? null)) out.set(path, `${canonicalJson(e ?? null)}=>${canonicalJson(a ?? null)}`);
    };
    walk('', expected, actual);
    if (outcome !== expectedOutcome) out.set('$outcome', `${expectedOutcome}=>${outcome}`);
    return out;
  }

  private snapshotExpected(): InventoryState {
    const reservations = Object.fromEntries([...this.orders].map(([key, r]) => [key, { ...r }]));
    const skus = new Set([...this.receipts.keys(), ...this.onHand.keys()]);
    const stock = Object.fromEntries([...skus].map(sku => [sku, {
      received: this.receipts.get(sku) ?? 0, onHand: this.onHand.get(sku) ?? 0,
    }]));
    return { stock, reservations, accepted: Object.fromEntries(this.events) };
  }

  /** Spec reducer seeded verbatim from the target's own prior state:
   * actual received/onHand and quantity/remaining/shipped/cancelled are
   * taken as-is, even when they violate stock conservation, so the local
   * decision for the current operation is judged against the balances
   * the target actually had. */
  private static seededFrom(actual: InventoryState): InventoryOracle {
    const oracle = new InventoryOracle();
    for (const [sku, s] of Object.entries(actual.stock ?? {})) { oracle.receipts.set(sku, s.received); oracle.onHand.set(sku, s.onHand); }
    for (const [id, r] of Object.entries(actual.reservations ?? {})) {
      oracle.orders.set(id, { sku: r.sku, quantity: r.quantity, remaining: r.remaining, shipped: r.shipped, cancelled: r.cancelled });
    }
    for (const [id, fingerprint] of Object.entries(actual.accepted ?? {})) oracle.events.set(id, fingerprint);
    return oracle;
  }

  check(channel: string, payload: unknown, actual: InventoryState, outcome: string, step: number): Violation[] {
    // Local attribution: replay this one transition with the spec reducer
    // seeded from the target's actual prior state. If the target's outcome
    // and resulting state are exactly what the spec produces from that
    // already-possibly-corrupted state, this step is propagation of an
    // earlier discrepancy, not a newly supportable failure. Only a locally
    // incorrect transition earns this event's category. The global expected
    // vs actual evidence below is kept in full either way.
    const preActual: InventoryState = this.previousActual ?? { stock: {}, reservations: {}, accepted: {} };
    const local = InventoryOracle.seededFrom(preActual);
    const category = this.categoryFor(channel, payload, local.events);
    const localPre = local.snapshotExpected();
    const localOutcome = local.apply(channel, payload);
    const localPost = local.snapshotExpected();
    const preDivergence = this.divergence(localPre, preActual, 'same', 'same');
    const postDivergence = this.divergence(localPost, actual, outcome, localOutcome);
    const locallyFaulty = [...postDivergence].some(([path, sig]) => preDivergence.get(path) !== sig);

    const expectedOutcome = this.apply(channel, payload);
    const expected = this.snapshotExpected();
    const violations: Violation[] = [];
    const divergence = this.divergence(expected, actual, outcome, expectedOutcome);
    if (divergence.size === 0) this.activeCategory = null;
    else if (locallyFaulty || this.activeCategory === null) this.activeCategory = category;
    const effectiveCategory = divergence.size > 0 ? (this.activeCategory ?? category) : category;
    if (divergence.size > 0) violations.push({
      id: this.uniqueViolationId(`transition-${step}`), invariant: 'inventory_transition_consistency', category: effectiveCategory, step,
      message: 'Target differs from independent inventory transitions', evidence: { expected, actual, expectedOutcome, outcome },
    });
    this.previousActual = structuredClone(actual);
    for (const [sku, s] of Object.entries(actual.stock)) {
      const rs = Object.values(actual.reservations).filter(r => r.sku === sku);
      const reserved = rs.reduce((n, r) => n + r.remaining, 0);
      const shipped = rs.reduce((n, r) => n + r.shipped, 0);
      if (reserved > s.onHand || reserved < 0 || s.onHand < 0 || s.received !== s.onHand + shipped) violations.push({
        id: this.uniqueViolationId(`stock-${step}-${sku}`), invariant: 'stock_conservation', category: effectiveCategory, step,
        message: 'Inventory commitments exceed stock or quantities are not conserved', evidence: { sku, ...s, reserved, shipped },
      });
    }
    return violations;
  }
}
