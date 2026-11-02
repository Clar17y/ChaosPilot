import type { Experiment } from '../domain.ts';

// Scripted offline fixture. Never included in the model-visible source bundle.
export function recoveryProposal(index: number): Experiment | null {
  if (index === 0) {
    return {
      hypothesis:
        '[Scripted Offline Recovery] Execution report accepted while disconnected must be reconciled into order quantities, credit exposure, and application records within 5 ticks after reconnect.',
      expectedInvariant: 'recovery_deadline',
      steps: [
        { op: 'send', id: 'm-quote-1', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 100 } },
        { op: 'send', id: 'm-credit-1', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 1000 } },
        { op: 'drain' },
        { op: 'send', id: 'm-order-1', to: 'client', payload: { type: 'new_order', id: 'o1', orderId: 'ord-1', quantity: 10, quoteId: 'q1' } },
        { op: 'drain' },
        { op: 'disconnect' },
        { op: 'fill', messageId: 'm-fill-1', orderId: 'ord-1', executionId: 'exec-1', quantity: 4 },
        { op: 'deliver', messageId: 'm-fill-1' },
        { op: 'reconnect' },
        { op: 'advance', ticks: 5 },
      ],
    };
  }
  if (index === 1) {
    return {
      hypothesis:
        '[Scripted Offline Recovery Retry] Duplicate delivery of an execution report accepted while disconnected must be idempotent without double fill, credit mutation, or deadline reset.',
      expectedInvariant: 'execution_idempotency',
      steps: [
        { op: 'send', id: 'm-quote-1', to: 'market', payload: { type: 'quote', id: 'q1', version: 1, price: 100 } },
        { op: 'send', id: 'm-credit-1', to: 'credit', payload: { type: 'credit_limit', id: 'c1', version: 1, limit: 1000 } },
        { op: 'drain' },
        { op: 'send', id: 'm-order-1', to: 'client', payload: { type: 'new_order', id: 'o1', orderId: 'ord-1', quantity: 10, quoteId: 'q1' } },
        { op: 'drain' },
        { op: 'disconnect' },
        { op: 'fill', messageId: 'm-fill-1', orderId: 'ord-1', executionId: 'exec-1', quantity: 4 },
        { op: 'duplicate', messageId: 'm-fill-1', id: 'm-fill-dup-1' },
        { op: 'deliver', messageId: 'm-fill-1' },
        { op: 'deliver', messageId: 'm-fill-dup-1' },
        { op: 'reconnect' },
        { op: 'advance', ticks: 5 },
      ],
    };
  }
  return null;
}
