import type { Experiment } from '../domain.ts';
import type { FunctionalCatalogItem } from './types.ts';

export interface ScenarioDefinition {
  id: string;
  name: string;
  description: string;
  adapterId: 'synthetic-trading';
  milestones: string[];
  hypothesis: string;
  expectedInvariant: string;
  buildExperiment: () => Experiment;
}

export const SCENARIO_LIFECYCLE_PARTIAL_FILL_CANCEL: ScenarioDefinition = {
  id: 'trading-lifecycle-partial-fill-cancel',
  name: 'Order Lifecycle: Acceptance, Partial Fill & Cancellation',
  description:
    'Exercises a complete 4-unit order lifecycle at price 10: initial acceptance reserves 40, partial fill of 2 units consumes 20 and retains 20 reservation, client cancellation request retains the 20 reservation, and venue cancellation acknowledgement releases the remaining 20 reservation while leaving 20 used credit.',
  adapterId: 'synthetic-trading',
  milestones: [
    'order-acceptance',
    'partial-fill',
    'cancellation-request',
    'cancellation-confirmation',
  ],
  hypothesis:
    'A 4-unit order at price 10 follows exact reservation and release accounting across partial fill and cancellation milestones.',
  expectedInvariant:
    'Credit commitments and order quantities match milestone states at acceptance, partial fill, cancel request, and cancel confirmation.',
  buildExperiment: (): Experiment => ({
    hypothesis:
      'A 4-unit order at price 10 follows exact reservation and release accounting across partial fill and cancellation milestones.',
    expectedInvariant:
      'Credit commitments and order quantities match milestone states at acceptance, partial fill, cancel request, and cancel confirmation.',
    steps: [
      {
        op: 'send',
        id: 'msg-quote-1',
        to: 'market',
        payload: { type: 'quote', id: 'quote-1', version: 1, price: 10 },
      },
      { op: 'deliver', messageId: 'msg-quote-1' },
      {
        op: 'send',
        id: 'msg-credit-1',
        to: 'credit',
        payload: { type: 'credit_limit', id: 'credit-1', version: 1, limit: 100 },
      },
      { op: 'deliver', messageId: 'msg-credit-1' },
      // Step 4 & 5: New Order (4 units at 10 -> reserves 40)
      {
        op: 'send',
        id: 'msg-order-1',
        to: 'client',
        payload: {
          type: 'new_order',
          id: 'msg-order-1',
          orderId: 'ord-baseline-1',
          quoteId: 'quote-1',
          quantity: 4,
        },
      },
      { op: 'deliver', messageId: 'msg-order-1' }, // Step 5 -> Milestone: order-acceptance
      // Step 6 & 7: Fill 2 units (consumes 20, leaves 20 reserved)
      {
        op: 'fill',
        messageId: 'msg-fill-1',
        orderId: 'ord-baseline-1',
        executionId: 'exec-baseline-1',
        quantity: 2,
      },
      { op: 'deliver', messageId: 'msg-fill-1' }, // Step 7 -> Milestone: partial-fill
      // Step 8 & 9: Cancellation Request (client request alone does not release reservation)
      {
        op: 'send',
        id: 'msg-cancel-req-1',
        to: 'client',
        payload: {
          type: 'cancel_order',
          id: 'msg-cancel-req-1',
          orderId: 'ord-baseline-1',
        },
      },
      { op: 'deliver', messageId: 'msg-cancel-req-1' }, // Step 9 -> Milestone: cancellation-request
      // Step 10 & 11: Venue Cancellation Confirmation (releases remaining 20 reservation)
      {
        op: 'confirm_cancel',
        messageId: 'msg-cancel-ack-1',
        orderId: 'ord-baseline-1',
      },
      { op: 'deliver', messageId: 'msg-cancel-ack-1' }, // Step 11 -> Milestone: cancellation-confirmation
    ],
  }),
};

export const SCENARIO_USED_CREDIT_ADMISSION_REJECTION: ScenarioDefinition = {
  id: 'trading-used-credit-admission-rejection',
  name: 'Used Credit Admission & Rejection Without Mutation',
  description:
    'Establishes an existing 20 used credit against a 50 limit, then attempts a new 4-unit order at price 10 (notional 40). Because total commitments (20 used + 40 requested = 60) exceed the 50 limit, the second order must be rejected without mutating business state or existing credit.',
  adapterId: 'synthetic-trading',
  milestones: [
    'first-order-fill',
    'used-credit-admission-rejection',
  ],
  hypothesis:
    'Used credit is strictly accounted in new order admission, rejecting orders exceeding available credit and leaving state unmutated.',
  expectedInvariant:
    'New orders with notional + usedCredit > limit are rejected; existing used credit and order book remain unchanged.',
  buildExperiment: (): Experiment => ({
    hypothesis:
      'Used credit is strictly accounted in new order admission, rejecting orders exceeding available credit and leaving state unmutated.',
    expectedInvariant:
      'New orders with notional + usedCredit > limit are rejected; existing used credit and order book remain unchanged.',
    steps: [
      {
        op: 'send',
        id: 'msg-quote-1',
        to: 'market',
        payload: { type: 'quote', id: 'quote-1', version: 1, price: 10 },
      },
      { op: 'deliver', messageId: 'msg-quote-1' },
      {
        op: 'send',
        id: 'msg-credit-1',
        to: 'credit',
        payload: { type: 'credit_limit', id: 'credit-1', version: 1, limit: 50 },
      },
      { op: 'deliver', messageId: 'msg-credit-1' },
      // First order: 2 units at 10 -> notional 20
      {
        op: 'send',
        id: 'msg-order-1',
        to: 'client',
        payload: {
          type: 'new_order',
          id: 'msg-order-1',
          orderId: 'ord-baseline-a',
          quoteId: 'quote-1',
          quantity: 2,
        },
      },
      { op: 'deliver', messageId: 'msg-order-1' },
      {
        op: 'fill',
        messageId: 'msg-fill-1',
        orderId: 'ord-baseline-a',
        executionId: 'exec-baseline-a',
        quantity: 2,
      },
      { op: 'deliver', messageId: 'msg-fill-1' }, // Step 7 -> Milestone: first-order-fill (used: 20, reserved: 0)
      // Second order: 4 units at 10 -> notional 40. 40 + 20 = 60 > 50 limit!
      {
        op: 'send',
        id: 'msg-order-2',
        to: 'client',
        payload: {
          type: 'new_order',
          id: 'msg-order-2',
          orderId: 'ord-baseline-b',
          quoteId: 'quote-1',
          quantity: 4,
        },
      },
      { op: 'deliver', messageId: 'msg-order-2' }, // Step 9 -> Milestone: used-credit-admission-rejection
    ],
  }),
};

export const SCENARIO_INITIAL_INSUFFICIENT_CREDIT: ScenarioDefinition = {
  id: 'trading-initial-insufficient-credit',
  name: 'Initial Insufficient Credit Rejection Without Mutation',
  description:
    'Attempts to submit a 4-unit order at price 10 (notional 40) against an initial credit limit of 30. The order must be rejected for insufficient credit limit, creating no order and mutating zero credit.',
  adapterId: 'synthetic-trading',
  milestones: [
    'initial-credit-rejection',
  ],
  hypothesis:
    'An order whose notional exceeds the total credit limit is rejected at admission without creating an open order.',
  expectedInvariant:
    'Credit rejection does not mutate credit balances or order state.',
  buildExperiment: (): Experiment => ({
    hypothesis:
      'An order whose notional exceeds the total credit limit is rejected at admission without creating an open order.',
    expectedInvariant:
      'Credit rejection does not mutate credit balances or order state.',
    steps: [
      {
        op: 'send',
        id: 'msg-quote-1',
        to: 'market',
        payload: { type: 'quote', id: 'quote-1', version: 1, price: 10 },
      },
      { op: 'deliver', messageId: 'msg-quote-1' },
      {
        op: 'send',
        id: 'msg-credit-1',
        to: 'credit',
        payload: { type: 'credit_limit', id: 'credit-1', version: 1, limit: 30 },
      },
      { op: 'deliver', messageId: 'msg-credit-1' },
      // Order 4 units at price 10 = notional 40 > limit 30
      {
        op: 'send',
        id: 'msg-order-1',
        to: 'client',
        payload: {
          type: 'new_order',
          id: 'msg-order-1',
          orderId: 'ord-baseline-excess',
          quoteId: 'quote-1',
          quantity: 4,
        },
      },
      { op: 'deliver', messageId: 'msg-order-1' }, // Step 5 -> Milestone: initial-credit-rejection
    ],
  }),
};

export const FUNCTIONAL_CATALOG: readonly ScenarioDefinition[] = [
  SCENARIO_LIFECYCLE_PARTIAL_FILL_CANCEL,
  SCENARIO_USED_CREDIT_ADMISSION_REJECTION,
  SCENARIO_INITIAL_INSUFFICIENT_CREDIT,
];

export function getScenarioById(id: string): ScenarioDefinition | undefined {
  return FUNCTIONAL_CATALOG.find((s) => s.id === id);
}

export function listCatalogItems(): FunctionalCatalogItem[] {
  return FUNCTIONAL_CATALOG.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    adapterId: s.adapterId,
    milestones: [...s.milestones],
  }));
}

/** Complete expected business facts, pinned in every result alongside the sequence. */
export interface FunctionalMilestone {
  name: string;
  step: number;
  messageId: string;
  channel: string;
  messageType: string;
  delivery: 'accepted' | 'rejected';
  rejectionReason?: string;
  creditLimit: number;
  credit: { reservedCredit: number; usedCredit: number };
  orderId: string;
  order: Record<string, string | number | boolean> | null;
}
export function expectedMilestones(id: string): FunctionalMilestone[] {
  const order = (status: string, remainingQuantity: number, filledQuantity: number, cancelledQuantity: number, cancellationRequested: boolean) =>
    ({ status, remainingQuantity, filledQuantity, cancelledQuantity, cancellationRequested, price: 10, initialQuantity: remainingQuantity + filledQuantity + cancelledQuantity, quoteId: 'quote-1' });
  const m = (name: string, step: number, messageId: string, channel: string, messageType: string,
    reservedCredit: number, usedCredit: number, orderId: string, expectedOrder: FunctionalMilestone['order'], delivery: FunctionalMilestone['delivery'] = 'accepted'): FunctionalMilestone =>
    ({ name, step, messageId, channel, messageType, delivery, ...(delivery === 'rejected' ? { rejectionReason: 'Insufficient credit limit' } : {}), creditLimit: id === 'trading-lifecycle-partial-fill-cancel' ? 100 : id === 'trading-used-credit-admission-rejection' ? 50 : 30, credit: { reservedCredit, usedCredit }, orderId, order: expectedOrder ? { ...expectedOrder, orderId } : null });
  switch (id) {
    case 'trading-lifecycle-partial-fill-cancel': return [
      m('order-acceptance', 5, 'msg-order-1', 'client', 'new_order', 40, 0, 'ord-baseline-1', order('OPEN', 4, 0, 0, false)),
      m('partial-fill', 7, 'msg-fill-1', 'reports', 'execution', 20, 20, 'ord-baseline-1', order('OPEN', 2, 2, 0, false)),
      m('cancellation-request', 9, 'msg-cancel-req-1', 'client', 'cancel_order', 20, 20, 'ord-baseline-1', order('OPEN', 2, 2, 0, true)),
      m('cancellation-confirmation', 11, 'msg-cancel-ack-1', 'reports', 'cancel_ack', 0, 20, 'ord-baseline-1', order('CANCELLED', 0, 2, 2, true)),
    ];
    case 'trading-used-credit-admission-rejection': return [
      m('first-order-fill', 7, 'msg-fill-1', 'reports', 'execution', 0, 20, 'ord-baseline-a', order('FILLED', 0, 2, 0, false)),
      m('used-credit-admission-rejection', 9, 'msg-order-2', 'client', 'new_order', 0, 20, 'ord-baseline-b', null, 'rejected'),
    ];
    case 'trading-initial-insufficient-credit': return [
      m('initial-credit-rejection', 5, 'msg-order-1', 'client', 'new_order', 0, 0, 'ord-baseline-excess', null, 'rejected'),
    ];
    default: throw new Error(`Unknown functional scenario: ${id}`);
  }
}
