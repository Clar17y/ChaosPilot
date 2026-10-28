import type { SystemContract } from '../domain.ts';

export const CHANNELS = ['stock', 'reservations', 'shipments'] as const;
export const LIMITS = { maxActions: 100, maxMessages: 100, maxTicks: 1000, maxQuantity: 1000000 };

export function getContract(): SystemContract {
  return {
    name: 'Inventory reservation service',
    description: 'Fresh empty inventory per experiment. Delivery order determines business order. No wall clock, persistence, loss, or latency guarantee.',
    operations: [
      { op: 'send', fields: 'id, to (stock|reservations|shipments), payload, optional delay (0..1000)' },
      { op: 'duplicate', fields: 'messageId (any previously enqueued message), new id, optional delay' },
      { op: 'deliver', fields: 'messageId; queued and due at current logical time' },
      { op: 'advance', fields: 'ticks (1..1000); moves clock without delivering' },
      { op: 'drain', fields: 'deliver all pending in due-time/enqueue order, advancing logical time' },
    ],
    messages: [
      { channel: 'stock', type: 'stock', fields: 'id, sku, quantity (positive safe integer <= 1000000); additive receipt; per-SKU received total <= 1000000' },
      { channel: 'reservations', type: 'reserve', fields: 'id, reservationId, sku, quantity; new reservationId; quantity <= onHand minus all remaining reservations for sku' },
      { channel: 'reservations', type: 'cancel', fields: 'id, reservationId; release all remaining quantity; requires remaining > 0' },
      { channel: 'shipments', type: 'ship', fields: 'id, reservationId, quantity; consume remaining reservation and onHand; partial shipments allowed' },
      { semantics: 'Only listed payload fields are supported. Identifiers are nonempty trimmed strings <= 64 characters. Accepted event ids are global: identical redelivery is a no-op, conflicting reuse is rejected. Rejected events do not consume ids. Reservation ids cannot be reused, including after completion/cancellation. Unknown, completed and cancelled references are rejected. No implicit retries of rejected messages.' },
    ],
    invariants: [
      { id: 'stock_conservation', description: 'received = onHand + shipped; 0 <= sum(remaining reservations) <= onHand for each SKU.' },
      { id: 'inventory_transition_consistency', description: 'Independent reference transitions match target state, outcomes and accepted event identities; quantity = remaining + shipped + cancelled per reservation.' },
    ],
    limits: { ...LIMITS },
  };
}
