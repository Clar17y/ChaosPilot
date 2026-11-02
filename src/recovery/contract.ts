import type { Channel, SystemContract } from '../domain.ts';

export const RECOVERY_CHANNELS: readonly Channel[] = ['market', 'credit', 'client', 'reports'] as const;
export const RECOVERY_DEADLINE_TICKS = 5;
export const MAX_TICKS = 1000;
export const RECOVERY_LIMITS = {
  maxActions: 100,
  maxMessages: 100,
  maxTicks: MAX_TICKS,
  maxQuantity: 1_000_000,
  maxPrice: 10_000_000,
  maxCreditLimit: 1_000_000_000,
  recoveryDeadlineTicks: RECOVERY_DEADLINE_TICKS,
} as const;

export function getContract(): SystemContract {
  return {
    name: 'Trading recovery gateway',
    description:
      'Stateful trading gateway with a recoverable execution-report inbox. Fresh instances start connected at tick 0 with no orders, no active quote, and no credit limit. When connected, accepted execution reports reconcile immediately into order quantities, credit exposure, and target application records. When disconnected, valid execution reports accepted by the target inbox are retained as recovery obligations and must be reconciled after reconnect by reconnectTick + 5 inclusive (with due target recovery work at each tick processed before checking that tick\'s deadline). Scheduling or withholding an envelope in the harness is not target acceptance; invalid or rejected reports create no obligation. Identical duplicate execution deliveries are idempotent and never apply a second fill, mutate credit, or reset an existing recovery deadline; conflicting duplicate execution IDs are rejected without mutation. Recovery v1 supports at most one outage/reconnect cycle per experiment (repeated current connection state is a no-op; a second outage cycle or a reconnect whose deadline exceeds maxTicks is an invalid harness command). Cancellations (cancel_order, cancel_ack, confirm_cancel) are unsupported in v1.',
    operations: [
      {
        op: 'send',
        description: 'Schedules a message to market, credit, client, or reports for future delivery. Scheduling does not constitute target acceptance.',
        parameters: {
          id: 'Unique envelope identifier string (1..64 trimmed characters)',
          to: 'Destination channel: market, credit, client, or reports',
          payload: 'Message payload object',
          delay: `Optional tick delay before delivery eligibility (0..${MAX_TICKS}, default: 0)`,
        },
      },
      {
        op: 'duplicate',
        description: 'Creates a duplicate envelope of an existing scheduled message with a new transport ID.',
        parameters: {
          messageId: 'Identifier of existing envelope to duplicate',
          id: 'New unique envelope identifier string',
          delay: `Optional tick delay before delivery eligibility (0..${MAX_TICKS}, default: 0)`,
        },
      },
      {
        op: 'deliver',
        description: 'Delivers a specific scheduled message to the target at current logical time if due.',
        parameters: {
          messageId: 'Identifier of due envelope to deliver',
        },
      },
      {
        op: 'advance',
        description: 'Advances simulated logical time by ticks (0..maxTicks), running due target recovery work and checking crossed deadlines in chronological order.',
        parameters: {
          ticks: `Integer number of simulated ticks to advance (0..${MAX_TICKS})`,
        },
      },
      {
        op: 'drain',
        description: 'Sequentially delivers all pending envelopes in due-time then insertion order, advancing logical time through intermediate due recovery work and deadlines. Empty drain does not move time.',
      },
      {
        op: 'fill',
        identity: 'Reusing an orderId/executionId with identical quantity reissues the original fact and occurrence time; conflicting quantities are rejected.',
        description: 'Records an execution fact at the logical venue and schedules an execution report to the gateway.',
        parameters: {
          messageId: 'Unique report envelope identifier string',
          orderId: 'Venue order identifier to fill',
          executionId: 'Unique business execution identifier',
          quantity: 'Positive integer quantity to fill',
          delay: `Optional delivery delay for execution report (0..${MAX_TICKS}, default: 0)`,
        },
      },
      {
        op: 'disconnect',
        description: 'Disconnects the target report reconciliation link without advancing time. Idempotent if already disconnected; a second outage after reconnect is invalid in v1.',
      },
      {
        op: 'reconnect',
        description: 'Reconnects the target report reconciliation link without advancing time and sets deadline reconnectTick + 5 for obligations accepted while disconnected. Idempotent if already connected; invalid if reconnectTick + 5 exceeds maxTicks.',
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
        description: 'Credit update setting maximum permitted aggregate exposure (reserved + used). Version must be strictly greater than active version.',
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
        channel: 'reports',
        type: 'execution',
        description: 'Execution report from venue or coherent injection confirming partial or full fill. Accepted while disconnected establishes a recovery obligation due by reconnectTick + 5.',
        fields: {
          id: 'Report envelope identifier string',
          orderId: 'Order identifier matching the execution',
          executionId: 'Business execution idempotency identifier tupled with orderId',
          quantity: 'Filled quantity in this execution',
          price: 'Locked execution price matching order',
          occurredAt: 'Simulated tick when execution occurred at venue (<= delivery tick)',
        },
      },
    ],
    invariants: [
      {
        id: 'recovery_deadline',
        description: 'Every execution report accepted by the target while disconnected must be reconciled into order quantities, aggregate credit balances, and target application records by reconnectTick + 5 inclusive.',
      },
      {
        id: 'execution_idempotency',
        description: 'Identical execution business IDs must be processed idempotently without state mutation or deadline reset; conflicting duplicate IDs must reject without mutation.',
      },
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
        description: 'Reserved credit must match unreconciled order quantity valued at locked price, and used credit must match reconciled executed quantity valued at locked price.',
      },
      {
        id: 'order_quantity_conservation',
        description: 'For each order, filledQuantity + remainingQuantity + cancelledQuantity must equal initialQuantity.',
      },
      {
        id: 'lifecycle_consistency',
        description: 'FILLED means filledQuantity equals initialQuantity; otherwise OPEN in recovery v1.',
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
        id: 'version_monotonicity',
        description: 'Market and credit updates must only apply if their version is strictly greater than the current version.',
      },
      {
        id: 'input_integrity_no_mutation',
        description: 'Malformed, unsupported, or rejected payloads must not mutate business state or poison future idempotency keys.',
      },
    ],
    limits: { ...RECOVERY_LIMITS },
  };
}
