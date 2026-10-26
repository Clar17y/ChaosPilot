import type { SystemContract } from '../domain.ts';

export const MAX_TICKS = 1_000_000;

export function getContract(): SystemContract {
  return {
    name: 'ChaosPilot Trading Gateway',
    description:
      'Deterministic single-account trading gateway with credit reservation, quote locking, and venue execution reconciliation. Fresh instances begin with no orders, no active quote, and no credit limit. Quotes lock execution prices for subsequent orders; orders reserve quantity * locked price against active credit limit. Valid execution reports convert reserved credit to used credit. Confirmed cancellations release only explicitly cancelled quantity. Status is FILLED when filledQuantity equals initialQuantity, otherwise CANCELLED for positive confirmed cancelledQuantity, otherwise OPEN. remainingQuantity is unreconciled quantity (including earlier execution reports still in transit), not executable leaves after cancellation; cancellationRequested is diagnostic only. A zero cancellation never relabels a fully filled order. Cancellation cannot predate an already accepted execution. Valid business facts occurring before or at cancellation remain binding even if delivered out of order. Coherent fabricated reports on the reports channel adhere to identical public consistency rules as venue-generated reports. Identical business facts are processed idempotently; conflicting duplicate IDs or inconsistent quantities/prices/business timestamps are rejected with zero mutation.',
    operations: [
      {
        op: 'send',
        description: 'Schedules a message to a channel for future delivery. Permits fabricated reports subject to public business consistency rules.',
        parameters: {
          id: 'Unique envelope identifier string',
          to: 'Destination channel: market, credit, client, or reports',
          payload: 'Message payload object',
          delay: 'Optional tick delay before delivery eligibility (default: 0)',
        },
      },
      {
        op: 'duplicate',
        description: 'Creates a duplicate envelope of an existing message with a new transport ID.',
        parameters: {
          messageId: 'Identifier of existing envelope to duplicate',
          id: 'New unique envelope identifier string',
          delay: 'Optional tick delay before delivery eligibility (default: 0)',
        },
      },
      {
        op: 'deliver',
        description: 'Delivers a specific scheduled message to the target gateway if due time has arrived.',
        parameters: {
          messageId: 'Identifier of due envelope to deliver',
        },
      },
      {
        op: 'advance',
        description: 'Advances simulation logical time by a number of ticks.',
        parameters: {
          ticks: 'Positive integer number of ticks to advance',
        },
      },
      {
        op: 'drain',
        description: 'Sequentially delivers all pending envelopes ordered by due time then insertion sequence, advancing logical time.',
      },
      {
        op: 'fill',
        identity: 'Reusing an orderId/executionId with identical quantity reissues the original fact and occurrence time; conflicting quantities are rejected.',
        description: 'Records an execution fact at the logical venue and schedules a corresponding execution report to the gateway.',
        parameters: {
          messageId: 'Unique report envelope identifier string',
          orderId: 'Venue order identifier to fill',
          executionId: 'Unique business execution identifier',
          quantity: 'Positive integer quantity to fill',
          delay: 'Optional delivery delay for execution report',
        },
      },
      {
        op: 'confirm_cancel',
        identity: 'A repeated venue cancellation reissues the original cancellation fact and occurrence time.',
        description: 'Records a cancellation fact at the logical venue and schedules a corresponding cancel acknowledgement report.',
        parameters: {
          messageId: 'Unique report envelope identifier string',
          orderId: 'Venue order identifier to cancel',
          delay: 'Optional delivery delay for cancel acknowledgement',
        },
      },
    ],
    messages: [
      {
        channel: 'market',
        type: 'quote',
        description: 'Market quote update broadcasting instrument price for subsequent order locking. Version must be strictly greater than active version.',
        fields: {
          id: 'Quote identifier string',
          version: 'Monotonically increasing integer version',
          price: 'Positive safe integer price',
        },
      },
      {
        channel: 'credit',
        type: 'credit_limit',
        description: 'Credit update setting the maximum permitted aggregate exposure (reserved + used). Lower limits do not invalidate existing exposure but block new orders. Version must be strictly greater than active version.',
        fields: {
          id: 'Credit update identifier string',
          version: 'Monotonically increasing integer version',
          limit: 'Non-negative safe integer credit limit',
        },
      },
      {
        channel: 'client',
        type: 'new_order',
        description: 'Client order submission referencing an active locked quote. Requires active quote and sufficient credit headroom.',
        fields: {
          id: 'Client message identifier string',
          orderId: 'Unique client order identifier string',
          quantity: 'Positive safe integer quantity',
          quoteId: 'Identifier of quote to lock price from',
        },
      },
      {
        channel: 'client',
        type: 'cancel_order',
        description: 'Client cancellation request for an open order.',
        fields: {
          id: 'Client message identifier string',
          orderId: 'Client order identifier to cancel',
        },
      },
      {
        channel: 'reports',
        type: 'execution',
        description: 'Execution report from venue or raw coherent injection confirming partial or full fill. Must match locked price and cannot exceed remaining unfulfilled quantity.',
        fields: {
          id: 'Report envelope identifier string',
          orderId: 'Order identifier matching the execution',
          executionId: 'Business execution idempotency identifier tupled with orderId',
          quantity: 'Filled quantity in this execution',
          price: 'Locked execution price matching order',
          occurredAt: 'Logical timestamp when execution occurred at venue',
        },
      },
      {
        channel: 'reports',
        type: 'cancel_ack',
        description: 'Cancellation acknowledgement from venue or raw coherent injection confirming cancelled quantity. Releases reservation for confirmed cancelled quantity only.',
        fields: {
          id: 'Report envelope identifier string',
          orderId: 'Order identifier matching the cancellation',
          cancelledQuantity: 'Confirmed quantity cancelled at venue, not exceeding remaining quantity',
          occurredAt: 'Logical timestamp when cancellation occurred at venue',
        },
      },
    ],
    invariants: [
      {
        id: 'credit_non_negative',
        description: 'Reserved credit and used credit balances must remain non-negative at all times.',
      },
      {
        id: 'credit_limit_respected',
        description: 'Aggregate exposure (reserved + used) must not exceed credit limit when an order is accepted, and orders require an active credit limit and quote.',
      },
      {
        id: 'credit_exposure_consistency',
        description: 'Reserved credit must strictly match unreconciled quantity valued at locked order price, and used credit must match accepted unique executed quantity valued at locked order price.',
      },
      {
        id: 'order_quantity_conservation',
        description: 'For each order, filledQuantity + remainingQuantity + cancelledQuantity must equal initialQuantity.',
      },
      {
        id: 'lifecycle_consistency',
        description: 'FILLED means filledQuantity equals initialQuantity; otherwise positive confirmed cancellation means CANCELLED, and all other orders are OPEN. Unreconciled quantity can remain reserved after cancellation for earlier reports in transit.',
      },
      {
        id: 'no_overfill',
        description: 'Filled quantity on any order must not exceed the initial order quantity.',
      },
      {
        id: 'venue_execution_integrity',
        description: 'Reported filled quantity must not exceed cumulative confirmed executed quantity from venue and delivered reports.',
      },
      {
        id: 'execution_idempotency',
        description: 'Identical execution business IDs must be processed idempotently; conflicting duplicate IDs must reject without mutation.',
      },
      {
        id: 'version_monotonicity',
        description: 'Market and credit updates must only apply if their version is strictly greater than the current version; same or lower versions must not mutate state.',
      },
      {
        id: 'input_integrity_no_mutation',
        description: 'Malformed or rejected payloads must not mutate business state or poison future idempotency keys.',
      },
    ],
    limits: {
      maxQuantity: 1_000_000,
      maxPrice: 10_000_000,
      maxCreditLimit: 1_000_000_000,
      maxTicks: MAX_TICKS,
    },
  };
}
