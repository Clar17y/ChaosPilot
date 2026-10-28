export interface InventoryState {
  stock: Record<string, { received: number; onHand: number }>;
  reservations: Record<string, { sku: string; quantity: number; remaining: number; shipped: number; cancelled: number }>;
  accepted: Record<string, string>;
}

export class InventoryService {
  private state: InventoryState = { stock: Object.create(null), reservations: Object.create(null), accepted: Object.create(null) };

  snapshot(): InventoryState { return structuredClone(this.state); }

  receive(channel: string, input: unknown): 'accepted' | 'duplicate' | 'rejected' {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return 'rejected';
    const p = input as Record<string, unknown>;
    const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64 && v.trim() === v;
    const quantity = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 1000000;
    if (!text(p.id)) return 'rejected';
    const shapes: Record<string, [string, string[]]> = {
      stock: ['stock', ['id', 'type', 'sku', 'quantity']],
      reserve: ['reservations', ['id', 'type', 'reservationId', 'sku', 'quantity']],
      cancel: ['reservations', ['id', 'type', 'reservationId']],
      ship: ['shipments', ['id', 'type', 'reservationId', 'quantity']],
    };
    const shape = typeof p.type === 'string' && Object.hasOwn(shapes, p.type) ? shapes[p.type] : undefined;
    if (!shape || shape[0] !== channel || Object.keys(p).length !== shape[1].length || !shape[1].every(k => Object.hasOwn(p, k))) return 'rejected';
    const identity = JSON.stringify([channel, ...Object.keys(p).sort().map(k => [k, p[k]])]);
    if (Object.hasOwn(this.state.accepted, p.id)) return this.state.accepted[p.id] === identity ? 'duplicate' : 'rejected';
    if (p.type === 'stock') {
      if (!text(p.sku) || !quantity(p.quantity)) return 'rejected';
      const old = this.state.stock[p.sku] ?? { received: 0, onHand: 0 };
      if (old.received + p.quantity > 1000000) return 'rejected';
      this.state.stock[p.sku] = { received: old.received + p.quantity, onHand: old.onHand + p.quantity };
    } else if (p.type === 'reserve') {
      if (!text(p.sku) || !text(p.reservationId) || !quantity(p.quantity) || Object.hasOwn(this.state.reservations, p.reservationId)) return 'rejected';
      const onHand = this.state.stock[p.sku]?.onHand ?? 0;
      const reserved = Object.values(this.state.reservations).filter(r => r.sku === p.sku).reduce((n, r) => n + r.remaining, 0);
      const available = onHand - Math.min(0, reserved);
      if (p.quantity > available) return 'rejected';
      this.state.reservations[p.reservationId] = { sku: p.sku, quantity: p.quantity, remaining: p.quantity, shipped: 0, cancelled: 0 };
    } else {
      if (!text(p.reservationId)) return 'rejected';
      const r = this.state.reservations[p.reservationId];
      if (!r || r.remaining <= 0) return 'rejected';
      if (p.type === 'cancel') {
        r.cancelled += r.remaining;
        r.remaining = 0;
      } else {
        if (!quantity(p.quantity) || p.quantity > r.remaining) return 'rejected';
        const stock = this.state.stock[r.sku]!;
        if (p.quantity > stock.onHand) return 'rejected';
        r.remaining -= p.quantity;
        r.shipped += p.quantity;
        stock.onHand -= p.quantity;
      }
    }
    this.state.accepted[p.id] = identity;
    return 'accepted';
  }
}
