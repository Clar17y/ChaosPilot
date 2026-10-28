import type { Violation } from '../domain.ts';
import { canonicalJson } from '../evidence.ts';
import type { InventoryState } from './variants/clean/service.ts';

// Independent specification reducer: no calls into target validation or transitions.
export class InventoryOracle {
  private receipts = new Map<string, number>();
  private orders = new Map<string, { sku: string; quantity: number; shipped: number; cancelled: number }>();
  private events = new Map<string, string>();
  private usedViolationIds = new Set<string>();

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
    const fingerprint = JSON.stringify([channel, ...Object.keys(p).sort().map(k => [k, p[k]])]);
    if (this.events.has(p.id)) return this.events.get(p.id) === fingerprint ? 'duplicate' : 'rejected';
    if (kind === 'stock') {
      if (!id(p.sku) || !qty(p.quantity) || (this.receipts.get(p.sku) ?? 0) + p.quantity > 1000000) return 'rejected';
      this.receipts.set(p.sku, (this.receipts.get(p.sku) ?? 0) + p.quantity);
    } else if (kind === 'reserve') {
      if (!id(p.sku) || !id(p.reservationId) || !qty(p.quantity) || this.orders.has(p.reservationId)) return 'rejected';
      const committed = [...this.orders.values()].filter(r => r.sku === p.sku).reduce((n, r) => n + r.quantity - r.cancelled, 0);
      if (p.quantity + committed > (this.receipts.get(p.sku) ?? 0)) return 'rejected';
      this.orders.set(p.reservationId, { sku: p.sku, quantity: p.quantity, shipped: 0, cancelled: 0 });
    } else {
      if (!id(p.reservationId)) return 'rejected';
      const r = this.orders.get(p.reservationId);
      if (!r || r.quantity === r.shipped + r.cancelled) return 'rejected';
      if (kind === 'cancel') r.cancelled = r.quantity - r.shipped;
      else {
        if (!qty(p.quantity) || p.quantity > r.quantity - r.shipped - r.cancelled) return 'rejected';
        r.shipped += p.quantity;
      }
    }
    this.events.set(p.id, fingerprint);
    return 'accepted';
  }

  check(channel: string, payload: unknown, actual: InventoryState, outcome: string, step: number): Violation[] {
    const expectedOutcome = this.apply(channel, payload);
    const reservations = Object.fromEntries([...this.orders].map(([key, r]) => [key, { ...r, remaining: r.quantity - r.shipped - r.cancelled }]));
    const stock = Object.fromEntries([...this.receipts].map(([sku, received]) => [sku, {
      received, onHand: received - [...this.orders.values()].filter(r => r.sku === sku).reduce((n, r) => n + r.shipped, 0),
    }]));
    const expected = { stock, reservations, accepted: Object.fromEntries(this.events) };
    const violations: Violation[] = [];
    if (canonicalJson(expected) !== canonicalJson(actual) || outcome !== expectedOutcome) violations.push({
      id: this.uniqueViolationId(`transition-${step}`), invariant: 'inventory_transition_consistency', step,
      message: 'Target differs from independent inventory transitions', evidence: { expected, actual, expectedOutcome, outcome },
    });
    for (const [sku, s] of Object.entries(actual.stock)) {
      const rs = Object.values(actual.reservations).filter(r => r.sku === sku);
      const reserved = rs.reduce((n, r) => n + r.remaining, 0);
      const shipped = rs.reduce((n, r) => n + r.shipped, 0);
      if (reserved > s.onHand || reserved < 0 || s.onHand < 0 || s.received !== s.onHand + shipped) violations.push({
        id: this.uniqueViolationId(`stock-${step}-${sku}`), invariant: 'stock_conservation', step,
        message: 'Inventory commitments exceed stock or quantities are not conserved', evidence: { sku, ...s, reserved, shipped },
      });
    }
    return violations;
  }
}
