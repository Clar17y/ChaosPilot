import type { Command } from './types.ts';

export interface Checkpoint {
  commands: Command[];
  expected: { status: 'accepted' | 'rejected'; reserved: number; used: number;
    orders: Record<string, { quantity: number; filled: number; status: string }> };
}
const setup = (limit: number): Command => ({ kind: 'setup', requestId: 'setup', limit });
const order = (requestId: string, orderId: string, quantity: number): Command => ({ kind: 'order', requestId, orderId, quantity });
const fill = (requestId: string, executionId: string, quantity: number): Command => ({ kind: 'execution', requestId, orderId: 'order-1', executionId, quantity });
const facts = (status: 'accepted' | 'rejected', reserved: number, used: number, quantity?: number, filled = 0, businessStatus = 'OPEN'): Checkpoint['expected'] =>
  ({ status, reserved, used, orders: quantity === undefined ? {} : { 'order-1': { quantity, filled, status: businessStatus } } });

/** Reviewed, bounded synthetic journeys. Expectations are independent of the selected target. */
export const CATALOG: readonly { id: string; name: string; checkpoints: Checkpoint[] }[] = [
  { id: 'order-lifecycle', name: 'Accepted order, partial fill and complete fill', checkpoints: [
    { commands: [setup(100)], expected: facts('accepted', 0, 0) },
    { commands: [order('order', 'order-1', 4)], expected: facts('accepted', 40, 0, 4) },
    { commands: [fill('partial', 'execution-1', 2)], expected: facts('accepted', 20, 20, 4, 2, 'PARTIALLY_FILLED') },
    { commands: [fill('complete', 'execution-2', 2)], expected: facts('accepted', 0, 40, 4, 4, 'FILLED') },
  ] },
  { id: 'credit-rejection', name: 'Used credit rejection without business mutation', checkpoints: [
    { commands: [setup(50)], expected: facts('accepted', 0, 0) },
    { commands: [order('order', 'order-1', 2)], expected: facts('accepted', 20, 0, 2) },
    { commands: [fill('complete', 'execution-1', 2)], expected: facts('accepted', 0, 20, 2, 2, 'FILLED') },
    { commands: [order('rejected', 'order-2', 4)], expected: facts('rejected', 0, 20, 2, 2, 'FILLED') },
  ] },
  { id: 'execution-retry', name: 'Identical retries before and after reconciliation, then conflicting report', checkpoints: [
    { commands: [setup(100)], expected: facts('accepted', 0, 0) },
    { commands: [order('order', 'order-1', 4)], expected: facts('accepted', 40, 0, 4) },
    { commands: [fill('first', 'execution-1', 1), fill('queued-retry', 'execution-1', 1)], expected: facts('accepted', 30, 10, 4, 1, 'PARTIALLY_FILLED') },
    { commands: [fill('later-retry', 'execution-1', 1)], expected: facts('accepted', 30, 10, 4, 1, 'PARTIALLY_FILLED') },
    { commands: [fill('conflict', 'execution-1', 2)], expected: facts('rejected', 30, 10, 4, 1, 'PARTIALLY_FILLED') },
  ] },
];
