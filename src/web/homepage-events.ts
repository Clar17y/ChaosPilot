export type MotionMotif = 'duplicate' | 'delay' | 'reorder' | 'reject' | 'corrupt' | 'mismatch';

export interface HomepageEvent {
  id: string;
  title: string;
  explanation: string;
  motif: MotionMotif;
  incomingLabel: string;
  outgoingLabel: string;
  intervention: 'coral' | 'amber';
  /** Readonly mapping to the source rule/invariant this scenario illustrates (not shown as UI schema). */
  sourceRule: string;
}

export const EVENT_CYCLE_MS = 9600;
export const IMPACT_MS = 3000;
export const OUTCOME_MS = 3600;

export const HOMEPAGE_EVENTS: readonly HomepageEvent[] = [
  { id: 'credit-exceeded', title: 'Credit exceeded', explanation: 'A new order would push reserved plus used credit past the active limit.', motif: 'reject', incomingLabel: 'order.created', outgoingLabel: 'order.rejected', intervention: 'coral' , sourceRule: 'credit_limit_respected' },
  { id: 'duplicate-fill', title: 'Duplicate fill detected', explanation: 'The same execution arrives twice and must only change state once.', motif: 'duplicate', incomingLabel: 'fill.report', outgoingLabel: 'fill.duplicate', intervention: 'amber' , sourceRule: 'execution_idempotency' },
  { id: 'stale-quote', title: 'Stale quote detected', explanation: 'An older quote version tries to replace the active quote; orders that already locked a price keep that price.', motif: 'mismatch', incomingLabel: 'quote.v1', outgoingLabel: 'quote.stale', intervention: 'amber' , sourceRule: 'version_monotonicity: replaces active quote only, locked prices unchanged' },
  { id: 'credit-out-of-order', title: 'Credit update out of order', explanation: 'An earlier credit-limit version arrives after a newer one.', motif: 'reorder', incomingLabel: 'credit.update', outgoingLabel: 'credit.reordered', intervention: 'amber' , sourceRule: 'version_monotonicity' },
  { id: 'price-mismatch', title: 'Execution price mismatch', explanation: 'A fill reports a price different from the locked quote price.', motif: 'mismatch', incomingLabel: 'fill.report', outgoingLabel: 'price.mismatch', intervention: 'coral' , sourceRule: 'input_integrity_no_mutation' },
  { id: 'conflicting-execution-id', title: 'Conflicting execution ID', explanation: 'A known execution ID returns with different quantity or price.', motif: 'corrupt', incomingLabel: 'fill.report', outgoingLabel: 'execution.conflict', intervention: 'coral' , sourceRule: 'execution_idempotency' },
  { id: 'order-overfilled', title: 'Order overfilled', explanation: 'Reported fills add up to more than the original order quantity.', motif: 'duplicate', incomingLabel: 'fill.report', outgoingLabel: 'order.overfilled', intervention: 'coral' , sourceRule: 'quantity_conservation' },
  { id: 'reservation-released-twice', title: 'Reservation released twice', explanation: 'One cancellation tries to release the same reserved credit two times.', motif: 'duplicate', incomingLabel: 'cancel.ack', outgoingLabel: 'release.duplicate', intervention: 'amber' , sourceRule: 'credit_non_negative' },
  { id: 'negative-credit', title: 'Negative credit balance', explanation: 'A release larger than the reservation would drive reserved credit below zero.', motif: 'corrupt', incomingLabel: 'cancel.ack', outgoingLabel: 'credit.negative', intervention: 'amber' , sourceRule: 'credit_non_negative' },
  { id: 'partial-fill-miscounted', title: 'Partial fill miscounted', explanation: 'Split fills are totalled as if only the latest fill had happened.', motif: 'mismatch', incomingLabel: 'fill.partial', outgoingLabel: 'fill.miscounted', intervention: 'coral' , sourceRule: 'credit_exposure_consistency' },
  { id: 'order-closed-early', title: 'Order closed too early', explanation: 'A partial fill marks the order filled while quantity still remains.', motif: 'reject', incomingLabel: 'fill.partial', outgoingLabel: 'order.closed_early', intervention: 'coral' , sourceRule: 'lifecycle_consistency' },
  { id: 'quantity-conservation', title: 'Quantity conservation broken', explanation: 'Filled, cancelled and remaining quantities no longer sum to the order size.', motif: 'corrupt', incomingLabel: 'order.created', outgoingLabel: 'quantity.broken', intervention: 'amber' , sourceRule: 'quantity_conservation' },
  { id: 'used-credit-overwritten', title: 'Used credit overwritten', explanation: 'A second partial fill replaces used credit instead of adding to it.', motif: 'mismatch', incomingLabel: 'fill.partial', outgoingLabel: 'credit.overwritten', intervention: 'coral' , sourceRule: 'credit_exposure_consistency' },
  { id: 'reserved-credit-mismatch', title: 'Reserved credit mismatch', explanation: 'Reserved credit no longer matches all unreconciled quantity — open orders plus earlier fills still in transit — at locked prices.', motif: 'mismatch', incomingLabel: 'order.created', outgoingLabel: 'credit.mismatch', intervention: 'amber' , sourceRule: 'credit_exposure_consistency: all unreconciled quantity' },
  { id: 'duplicate-cancellation', title: 'Duplicate cancellation', explanation: 'The same cancellation is confirmed twice for one order.', motif: 'duplicate', incomingLabel: 'cancel.request', outgoingLabel: 'cancel.duplicate', intervention: 'amber' , sourceRule: 'cancellation idempotency' },
  { id: 'late-fill-after-cancel', title: 'Late fill after cancellation', explanation: 'A fill that occurred before cancellation is delivered late, after the cancel acknowledgement — a valid fact delivered out of order.', motif: 'delay', incomingLabel: 'fill.report', outgoingLabel: 'fill.late', intervention: 'amber' , sourceRule: 'valid facts before cancellation remain binding' },
  { id: 'missing-quote', title: 'Missing quote', explanation: 'An order references a quote when no active quote exists.', motif: 'reject', incomingLabel: 'order.created', outgoingLabel: 'quote.missing', intervention: 'coral' , sourceRule: 'input_integrity_no_mutation' },
  { id: 'missing-credit-limit', title: 'Missing credit limit', explanation: 'An order arrives before any credit limit has been set.', motif: 'reject', incomingLabel: 'order.created', outgoingLabel: 'credit.missing', intervention: 'coral' , sourceRule: 'credit_limit_respected' },
  { id: 'unknown-order', title: 'Unknown order reference', explanation: 'A report names an order the gateway has never accepted.', motif: 'reject', incomingLabel: 'fill.report', outgoingLabel: 'order.unknown', intervention: 'coral' , sourceRule: 'input_integrity_no_mutation' },
  { id: 'malformed-payload', title: 'Malformed payload', explanation: 'A message that cannot be decoded must be rejected without changing state.', motif: 'corrupt', incomingLabel: 'message.raw', outgoingLabel: 'payload.malformed', intervention: 'coral' , sourceRule: 'input_integrity_no_mutation' },
  { id: 'missing-field', title: 'Missing required field', explanation: 'A required field such as quantity or price is absent from the payload.', motif: 'reject', incomingLabel: 'message.raw', outgoingLabel: 'field.missing', intervention: 'coral' , sourceRule: 'input_integrity_no_mutation' },
  { id: 'invalid-quantity', title: 'Invalid quantity', explanation: 'A quantity of zero or less cannot reserve credit or fill an order.', motif: 'reject', incomingLabel: 'order.created', outgoingLabel: 'quantity.invalid', intervention: 'coral' , sourceRule: 'positive safe integer quantity' },
  { id: 'invalid-timestamp', title: 'Invalid timestamp', explanation: 'A report timestamp outside the valid range cannot be reconciled.', motif: 'corrupt', incomingLabel: 'fill.report', outgoingLabel: 'timestamp.invalid', intervention: 'amber' , sourceRule: 'safe integer timestamp range' },
  { id: 'wrong-channel', title: 'Wrong message channel', explanation: 'A quote delivered on the client channel is not a market quote.', motif: 'reject', incomingLabel: 'quote.wrong_channel', outgoingLabel: 'channel.rejected', intervention: 'coral' , sourceRule: 'channel and message type must match' },
  { id: 'replayed-quote-version', title: 'Replayed quote version', explanation: 'The current quote version is delivered again as if it were new.', motif: 'duplicate', incomingLabel: 'quote.replay', outgoingLabel: 'quote.duplicate', intervention: 'amber' , sourceRule: 'version_monotonicity' },
  { id: 'stale-credit-limit', title: 'Stale credit limit', explanation: 'An older credit limit tries to replace the limit already in force.', motif: 'mismatch', incomingLabel: 'credit.update', outgoingLabel: 'credit.stale', intervention: 'amber' , sourceRule: 'version_monotonicity' },
  { id: 'rejected-input-changed-state', title: 'Rejected input changed state', explanation: 'Input that was rejected must leave balances and orders untouched.', motif: 'corrupt', incomingLabel: 'message.raw', outgoingLabel: 'state.changed', intervention: 'coral' , sourceRule: 'input_integrity_no_mutation' },
  { id: 'poisoned-idempotency-key', title: 'Poisoned idempotency key', explanation: 'A rejected conflicting report consumes its execution key, so a later valid report reusing that key is blocked.', motif: 'corrupt', incomingLabel: 'fill.report', outgoingLabel: 'key.poisoned', intervention: 'coral' , sourceRule: 'rejected report consumes execution key' },
  { id: 'cancellation-quantity-mismatch', title: 'Cancellation quantity mismatch', explanation: 'Cancelled quantity differs from the quantity the venue confirmed.', motif: 'mismatch', incomingLabel: 'cancel.ack', outgoingLabel: 'cancel.mismatch', intervention: 'amber' , sourceRule: 'quantity_conservation' },
  { id: 'duplicate-quote-delivery', title: 'Duplicate quote delivery', explanation: 'The identical quote update is delivered twice in a row.', motif: 'duplicate', incomingLabel: 'quote.update', outgoingLabel: 'quote.duplicate', intervention: 'amber' , sourceRule: 'version_monotonicity' },
  { id: 'fill-after-final-cancel', title: 'Fill after final cancellation', explanation: 'An execution that occurred after cancellation is reported — unlike the valid late delivery of a fill that occurred before it.', motif: 'delay', incomingLabel: 'fill.report', outgoingLabel: 'fill.after_cancel', intervention: 'amber' , sourceRule: 'execution after cancellation is not a late delivery' },
  { id: 'reservation-leaked', title: 'Credit reservation leaked', explanation: 'Credit is still reserved for confirmed cancelled quantity after cancellation is final, instead of being released.', motif: 'delay', incomingLabel: 'cancel.ack', outgoingLabel: 'credit.leaked', intervention: 'amber' , sourceRule: 'reserved credit for confirmed cancelled quantity' },
  { id: 'execution-report-duplicated', title: 'Execution report duplicated', explanation: 'Transport redelivery repeats a report the gateway already processed.', motif: 'duplicate', incomingLabel: 'fill.report', outgoingLabel: 'report.duplicate', intervention: 'coral' , sourceRule: 'execution_idempotency' },
  { id: 'filled-beyond-reservation', title: 'Order filled beyond reservation', explanation: 'Filled value grows past the credit originally reserved for the order.', motif: 'duplicate', incomingLabel: 'fill.report', outgoingLabel: 'fill.beyond_reserve', intervention: 'coral' , sourceRule: 'credit_exposure_consistency' },
  { id: 'cancelled-exceeds-order', title: 'Cancelled quantity exceeds order', explanation: 'Confirmed cancelled quantity is larger than the order itself.', motif: 'corrupt', incomingLabel: 'cancel.ack', outgoingLabel: 'cancel.exceeds', intervention: 'amber' , sourceRule: 'quantity_conservation' },
  { id: 'quote-price-changed-after-lock', title: 'Quote price changed after lock', explanation: 'A later quote must not reprice an order that already locked its price.', motif: 'reorder', incomingLabel: 'quote.update', outgoingLabel: 'price.relocked', intervention: 'amber' , sourceRule: 'locked price immutable for accepted orders' },
  { id: 'zero-cancel-status', title: 'Zero cancellation relabels filled order', explanation: 'A cancellation confirming zero quantity must not relabel a fully filled order as cancelled.', motif: 'mismatch', incomingLabel: 'cancel.ack', outgoingLabel: 'status.relabelled', intervention: 'amber', sourceRule: 'a zero cancellation never relabels a fully filled order' },
  { id: 'future-timestamp', title: 'Future report timestamp', explanation: 'A report timestamped ahead of current logical time cannot be reconciled as an occurred fact.', motif: 'corrupt', incomingLabel: 'fill.report', outgoingLabel: 'timestamp.future', intervention: 'amber', sourceRule: 'safe integer timestamp within occurred range' },
  { id: 'cancel-predates-fill', title: 'Cancellation predates accepted fill', explanation: 'A cancellation whose time is earlier than an already accepted fill cannot predate that fill.', motif: 'reorder', incomingLabel: 'cancel.ack', outgoingLabel: 'cancel.predates_fill', intervention: 'amber', sourceRule: 'cancellation cannot predate an accepted execution' },
  { id: 'fractional-quantity', title: 'Fractional quantity', explanation: 'A quantity that is not a whole number cannot reserve credit or fill an order.', motif: 'reject', incomingLabel: 'order.created', outgoingLabel: 'quantity.fractional', intervention: 'coral', sourceRule: 'quantity is a positive safe integer' },
  { id: 'unsafe-numeric-range', title: 'Unsafe numeric range', explanation: 'A price, quantity or timestamp beyond the safe integer range cannot be processed exactly.', motif: 'corrupt', incomingLabel: 'message.raw', outgoingLabel: 'number.unsafe', intervention: 'coral', sourceRule: 'numeric fields are safe integers within range' },
  { id: 'missing-business-id', title: 'Missing business identifier', explanation: 'A report without its business execution identifier cannot be deduplicated or reconciled.', motif: 'reject', incomingLabel: 'fill.report', outgoingLabel: 'execution_id.missing', intervention: 'coral', sourceRule: 'required business identifiers are non-empty strings' },
];

export interface ScenarioInstance {
  eventIndex: number;
  /** Monotonic active-time moment this injection entered the stream. */
  startMs: number;
}

export const MAX_ACTIVE_INSTANCES = 4;
/** Ingress, downstream travel and a short outcome dwell before pruning. */
export const INSTANCE_LIFETIME_MS = EVENT_CYCLE_MS + 600;

export interface TimelineState {
  eventIndex: number;
  /** Age of the newest instance (presentation phase derives from this). */
  elapsedMs: number;
  playing: boolean;
  reducedMotion: boolean;
  /** Monotonic active clock: advances only while playing; drives base stream and every instance. Never resets. */
  activeTimeMs: number;
  instances: readonly ScenarioInstance[];
}

function pruneInstances(instances: readonly ScenarioInstance[], activeTimeMs: number): ScenarioInstance[] {
  const live = instances.filter((i) => activeTimeMs - i.startMs < INSTANCE_LIFETIME_MS);
  return live.slice(-MAX_ACTIVE_INSTANCES);
}

export function createTimeline(opts: { reducedMotion?: boolean } = {}): TimelineState {
  const reduced = opts.reducedMotion ?? false;
  const startMs = reduced ? -OUTCOME_MS : 0;
  return { eventIndex: 0, elapsedMs: reduced ? OUTCOME_MS : 0, playing: !reduced, reducedMotion: reduced, activeTimeMs: 0, instances: [{ eventIndex: 0, startMs }] };
}

export type Phase = 'input' | 'impact' | 'outcome';
export function phaseAt(elapsedMs: number): Phase {
  if (elapsedMs < IMPACT_MS) return 'input';
  if (elapsedMs < OUTCOME_MS) return 'impact';
  return 'outcome';
}

/** Advance only when playing and motion allowed; dt is caller-supplied active time (no wall-clock jumps). */
export function advanceTimeline(state: TimelineState, dtMs: number): TimelineState {
  if (!state.playing || state.reducedMotion || dtMs <= 0) return state;
  const activeTimeMs = state.activeTimeMs + dtMs;
  let eventIndex = state.eventIndex;
  let instances: ScenarioInstance[] = [...state.instances];
  if (instances.length === 0) instances = [{ eventIndex, startMs: activeTimeMs - state.elapsedMs }];
  // Auto-cycle: spawn the next injection into the still-flowing stream; older instances finish naturally.
  let latest = instances[instances.length - 1]!;
  while (activeTimeMs - latest.startMs >= EVENT_CYCLE_MS) {
    const startMs = latest.startMs + EVENT_CYCLE_MS;
    eventIndex = (latest.eventIndex + 1) % HOMEPAGE_EVENTS.length;
    latest = { eventIndex, startMs };
    instances.push(latest);
  }
  instances = pruneInstances(instances, activeTimeMs);
  const newest = instances[instances.length - 1]!;
  return { ...state, eventIndex: newest.eventIndex, elapsedMs: activeTimeMs - newest.startMs, activeTimeMs, instances };
}

export function nextEvent(state: TimelineState): TimelineState {
  const eventIndex = (state.eventIndex + 1) % HOMEPAGE_EVENTS.length;
  if (!state.playing || state.reducedMotion) {
    // Paused/reduced: static outcome for the new selection only; active clock (and base traffic) unchanged.
    return { ...state, eventIndex, elapsedMs: OUTCOME_MS, instances: [{ eventIndex, startMs: state.activeTimeMs - OUTCOME_MS }] };
  }
  // Playing: inject a new instance at its entry point now; in-flight instances keep their start times.
  const instances = pruneInstances([...state.instances, { eventIndex, startMs: state.activeTimeMs }], state.activeTimeMs);
  return { ...state, eventIndex, elapsedMs: 0, instances };
}

export function pauseTimeline(state: TimelineState): TimelineState { return { ...state, playing: false }; }
export function resumeTimeline(state: TimelineState): TimelineState {
  if (state.reducedMotion) return state;
  return { ...state, playing: true };
}
export function setReducedMotion(state: TimelineState, reduced: boolean): TimelineState {
  if (!reduced) return { ...state, reducedMotion: false };
  const elapsedMs = Math.max(state.elapsedMs, OUTCOME_MS);
  return { ...state, reducedMotion: true, playing: false, elapsedMs, instances: [{ eventIndex: state.eventIndex, startMs: state.activeTimeMs - elapsedMs }] };
}
export function currentEvent(state: TimelineState): HomepageEvent { return HOMEPAGE_EVENTS[state.eventIndex]!; }

export interface EventPresentation {
  event: HomepageEvent;
  phase: Phase;
  isOutcome: boolean;
  title: string;
  explanation: string;
  counter: string;
  incomingLabel: string;
  outgoingLabel: string;
}

/** Atomic presentation for a state: every caption/label/counter field derives from one event + phase. */
export function presentationFor(state: TimelineState): EventPresentation {
  const event = currentEvent(state);
  const phase = phaseAt(state.elapsedMs);
  const isOutcome = phase === 'outcome';
  const counter = `Event ${state.eventIndex + 1} of ${HOMEPAGE_EVENTS.length}`;
  if (isOutcome) {
    return { event, phase, isOutcome, title: event.title, explanation: event.explanation, counter, incomingLabel: event.incomingLabel, outgoingLabel: event.outgoingLabel };
  }
  return {
    event,
    phase,
    isOutcome,
    title: 'Injection entering the stream',
    explanation: 'Unexpected input joins the running system. Follow the messages to see how it responds.',
    counter,
    incomingLabel: event.incomingLabel,
    outgoingLabel: 'awaiting outcome',
  };
}
