import type { Experiment } from '../domain.ts';

// Scripted offline fixture. Never included in the model-visible source bundle.
export function inventoryProposal(index: number): Experiment | null {
  if (index === 2) {
    return {
      hypothesis: 'An identical shipment redelivery must not ship again or change stock.',
      expectedInvariant: 'inventory_transition_consistency',
      steps: [
        { op: 'send', id: 'm1', to: 'stock', payload: { type: 'stock', id: 's1', sku: 'item', quantity: 10 } },
        { op: 'send', id: 'm2', to: 'reservations', payload: { type: 'reserve', id: 'r1', reservationId: 'r1', sku: 'item', quantity: 10 } },
        { op: 'drain' },
        { op: 'send', id: 'm3', to: 'shipments', payload: { type: 'ship', id: 'f1', reservationId: 'r1', quantity: 4 } },
        { op: 'send', id: 'm4', to: 'shipments', payload: { type: 'ship', id: 'f1', reservationId: 'r1', quantity: 4 } },
        { op: 'drain' },
      ],
    };
  }
  if (index > 2) return null;
  const base: Experiment = {
    hypothesis: index === 0 ? 'A partial shipment followed by cancellation preserves inventory quantities.' : 'Competing reservations must respect the available stock after earlier commitments.',
    expectedInvariant: 'stock_conservation',
    steps: [
      { op: 'send', id: 'm1', to: 'stock', payload: { type: 'stock', id: 's1', sku: 'item', quantity: 10 } },
      { op: 'send', id: 'm2', to: 'reservations', payload: { type: 'reserve', id: 'r1', reservationId: 'r1', sku: 'item', quantity: 7 } },
      { op: 'drain' },
    ],
  };
  if (index === 0) base.steps.push(
    { op: 'send', id: 'm3', to: 'shipments', payload: { type: 'ship', id: 's2', reservationId: 'r1', quantity: 2 } },
    { op: 'send', id: 'm4', to: 'reservations', payload: { type: 'cancel', id: 'c1', reservationId: 'r1' } },
    { op: 'drain' },
  );
  else base.steps.push(
    { op: 'send', id: 'm3', to: 'reservations', payload: { type: 'reserve', id: 'r2', reservationId: 'r2', sku: 'item', quantity: 7 } },
    { op: 'drain' },
  );
  return base;
}
