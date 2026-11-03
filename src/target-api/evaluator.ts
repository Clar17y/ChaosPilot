import type { ExperimentResult, SystemBriefSnapshot } from '../domain.ts';
import { evaluateRequirementRules } from '../requirements/evaluator.ts';
import { CATALOG } from './catalog.ts';
import { same } from './identity.ts';
import type { Assertion, BusinessEvent, Command, JourneyEvidence, Observation, Receipt, Status } from './types.ts';

export function aggregate(statuses: Status[]): Status {
  return statuses.includes('cancelled') ? 'cancelled' : statuses.includes('inconclusive') || !statuses.length ? 'inconclusive'
    : statuses.includes('fail') ? 'fail' : 'pass';
}
function required(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail);
}
function validateResult(event: BusinessEvent, command: Command, sourceHash: string, step: number): ExperimentResult {
  const r = event.result;
  required(r && r.schemaVersion === 1 && r.sourceHash === sourceHash && r.executionComplete === true && r.valid === true
    && Array.isArray(r.rejections) && !r.rejections.length && Array.isArray(r.violations)
    && Array.isArray(r.deliveryObservations) && Array.isArray(r.trace), 'Missing, invalid or incomplete executor evidence');
  required(r.trace.length === step + 1 && r.experiment.steps.length === step + 1
    && r.trace.every((t, i) => t.step === i && t.time === 0 && t.action === r.experiment.steps[i]?.op), 'Incomplete ordered logical horizon');
  const deliveries = r.trace.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.action === 'deliver');
  required(r.deliveryObservations!.length === deliveries.length && deliveries.every(({ entry, index }) => {
    const observations = r.deliveryObservations!.filter(o => o.traceIndex === index);
    const observation = observations[0];
    const action = r.experiment.steps[index];
    const payload = entry.payload as Record<string, unknown> | undefined;
    return observations.length === 1 && observation?.step === entry.step && observation.action === 'deliver'
      && observation.messageId === entry.messageId && action?.op === 'deliver' && action.messageId === entry.messageId
      && observation.payloadValid === true && observation.messageType === payload?.type;
  }), 'Extra, duplicate or misbound typed delivery facts');
  const trace = r.trace[step]!;
  const obs = r.deliveryObservations.filter(d => d.step === step);
  const o = obs[0];
  required(event.deliveryStep === step && event.messageId === `http-${event.sequence}`
    && trace.action === 'deliver' && trace.messageId === event.messageId && obs.length === 1
    && o?.traceIndex === step && o.action === 'deliver' && o.messageId === event.messageId && o.payloadValid === true
    && o.status === event.status && same(o.reason ?? null, event.reason ?? null)
    && same(r.snapshot.target, trace.state), 'Misbound delivery/state observation');
  const payload = trace.payload as Record<string, unknown>;
  required(payload && typeof payload === 'object', 'Missing payload');
  const expectedType = command.kind === 'setup' ? 'credit_limit' : command.kind === 'order' ? 'new_order' : 'execution';
  required(o.messageType === expectedType && o.channel === (command.kind === 'setup' ? 'credit' : command.kind === 'order' ? 'client' : 'reports')
    && payload.type === expectedType, 'Wrong delivery protocol');
  if (command.kind === 'setup') required(payload.limit === command.limit && payload.version === 1, 'Setup identity mismatch');
  else required(payload.orderId === command.orderId && payload.quantity === command.quantity
    && (command.kind !== 'execution' || payload.executionId === command.executionId && payload.price === 10 && payload.occurredAt === 0), 'Order/execution identity mismatch');
  required(same(payload, r.trace[step - 1]?.payload) || r.trace[step - 1]?.action === 'duplicate', 'Scheduling and delivery payload mismatch');
  return r;
}

/** Re-evaluates actual wire observations, independent fixed business expectations and existing oracle facts.
 * Missing observations make the result inconclusive, never a product pass. */
export function evaluateJourney(evidence: JourneyEvidence, sourceHash: string, snapshot: SystemBriefSnapshot): { status: Status; assertions: Assertion[] } {
  const assertions: Assertion[] = [];
  const check = (id: string, expected: unknown, observed: unknown) => assertions.push({ id, expected, observed, status: same(expected, observed) ? 'pass' : 'fail' });
  try {
    const definition = CATALOG.find(c => c.id === evidence.id);
    required(definition, 'Unknown catalog journey');
    required(!evidence.error, evidence.error ?? 'Interrupted journey');
    const commands = definition.checkpoints.flatMap(c => c.commands);
    const posts = evidence.exchanges.filter(e => e.method === 'POST');
    const checkpoints = evidence.exchanges.filter(e => e.method === 'GET' && e.path === '/state');
    required(posts.length === commands.length && checkpoints.length === definition.checkpoints.length, 'Incomplete request/observation horizon');
    required(evidence.exchanges.every(e => e.transportFailure === undefined && e.status === (e.method === 'POST' ? 202 : 200) && Number.isFinite(e.elapsedMs) && e.elapsedMs >= 0), 'Transport error');
    const observation = evidence.observation;
    required(observation && observation.instanceId === evidence.instanceId && observation.processed === commands.length
      && observation.queued === 0 && observation.events.length === commands.length, 'Missing completion observation');
    // Validate every poll and the exact checkpoint protocol before excluding polling cadence.
    let cursor = 0, submitted = 0, processed = 0;
    for (const checkpoint of definition.checkpoints) {
      for (const c of checkpoint.commands) {
        const exchange = evidence.exchanges[cursor++];
        required(exchange?.method === 'POST' && same(exchange.request, c), 'Out-of-order command');
        submitted++;
      }
      let polls = 0, complete = false;
      while (evidence.exchanges[cursor]?.path === '/events') {
        const wire = evidence.exchanges[cursor++]!, o = wire.response as Observation;
        required(wire.method === 'GET' && wire.request === null && o && o.instanceId === evidence.instanceId
          && Number.isSafeInteger(o.processed) && o.processed >= processed && o.processed <= submitted
          && o.queued === submitted - o.processed && same(o.events, observation.events.slice(0, o.processed)), 'Malformed or misbound poll');
        const expectedState = o.processed ? observation.events[o.processed - 1]!.result?.snapshot.target
          : { quote: null, credit: null, reservedCredit: 0, usedCredit: 0, orders: {} };
        required(same(o.state, expectedState), 'Poll state not bound to execution');
        const expectedOrders = Object.fromEntries(Object.entries(o.state.orders).map(([key, order]) => [key, { ...order,
          businessStatus: order.status === 'OPEN' && order.filledQuantity > 0 ? 'PARTIALLY_FILLED' : order.status }]));
        required(same(o.orders, expectedOrders), 'Poll business orders mismatch');
        processed = o.processed; complete = processed === submitted && o.queued === 0; polls++;
      }
      required(polls && complete, 'Missing complete poll horizon');
      const wire = evidence.exchanges[cursor++]!;
      required(wire?.method === 'GET' && wire.path === '/state' && wire.request === null, 'Missing ordered checkpoint');
      const o = wire.response as Observation;
      const expectedOrders = Object.fromEntries(Object.entries(o.state.orders).map(([key, order]) => [key, { ...order,
        businessStatus: order.status === 'OPEN' && order.filledQuantity > 0 ? 'PARTIALLY_FILLED' : order.status }]));
      required(same(o.orders, expectedOrders), 'Checkpoint business orders mismatch');
      for (const key of Object.keys(checkpoint.expected.orders)) {
        const orderWire = evidence.exchanges[cursor++]!;
        required(orderWire?.method === 'GET' && orderWire.path === `/orders/${key}` && orderWire.request === null, 'Missing ordered order observation');
      }
    }
    required(cursor === evidence.exchanges.length, 'Unexpected extra exchange');
    const receipts = new Set<string>(), eventIds = new Set<string>();
    let step = -1;
    for (const [i, c] of commands.entries()) {
      const post = posts[i]!, receipt = post.response as Receipt, event = observation.events[i]!;
      required(same(post.request, c) && post.path === (c.kind === 'setup' ? '/setup' : c.kind === 'order' ? '/orders' : '/executions')
        && receipt?.instanceId === evidence.instanceId && receipt.requestId === c.requestId && receipt.status === 'queued'
        && receipt.sequence === i + 1 && typeof receipt.receiptId === 'string' && receipt.receiptId.length > 0 && !receipts.has(receipt.receiptId), 'Receipt/request identity mismatch');
      required(event?.instanceId === evidence.instanceId && event.requestId === c.requestId && event.receiptId === receipt.receiptId
        && event.sequence === receipt.sequence && same(event.command, c) && event.eventId === `${evidence.instanceId}:${i + 1}`
        && !eventIds.has(event.eventId), 'Event correlation mismatch');
      receipts.add(receipt.receiptId); eventIds.add(event.eventId);
      step += c.kind === 'setup' ? 4 : 2;
      const result = validateResult(event, c, sourceHash, step);
      if (i > 0) {
        const previous = observation.events[i - 1]!.result!;
        required(same(result.trace.slice(0, previous.trace.length), previous.trace)
          && same(result.experiment.steps.slice(0, previous.experiment.steps.length), previous.experiment.steps)
          && same(result.deliveryObservations!.slice(0, previous.deliveryObservations!.length), previous.deliveryObservations), 'Executor history changed between commands');
      }
      const actions = result.experiment.steps;
      const delivery = actions[step];
      required(delivery?.op === 'deliver' && delivery.messageId === event.messageId, 'Misbound executor delivery command');
      if (c.kind === 'setup') required(same(actions, [
        { op: 'send', id: 'http-1-quote', to: 'market', payload: { type: 'quote', id: 'quote-1', version: 1, price: 10 } },
        { op: 'deliver', messageId: 'http-1-quote' },
        { op: 'send', id: 'http-1', to: 'credit', payload: { type: 'credit_limit', id: 'credit-1', version: 1, limit: c.limit } },
        { op: 'deliver', messageId: 'http-1' },
      ]), 'Invalid setup history');
      else {
        const scheduled = actions[step - 1]!;
        if (c.kind === 'order') required(same(scheduled, { op: 'send', id: event.messageId, to: 'client', payload: {
          type: 'new_order', id: event.messageId, orderId: c.orderId, quoteId: 'quote-1', quantity: c.quantity,
        } }), 'Misbound order schedule');
        else {
          const prior = observation.events.slice(0, i).find(e => e.command.kind === 'execution' && e.command.orderId === c.orderId && e.command.executionId === c.executionId);
          if (!prior) required(same(scheduled, { op: 'fill', messageId: event.messageId, orderId: c.orderId, executionId: c.executionId, quantity: c.quantity }), 'Misbound execution schedule');
          else if (prior.command.kind === 'execution' && prior.command.quantity === c.quantity) required(same(scheduled, { op: 'duplicate', messageId: prior.messageId, id: event.messageId }), 'Misbound retry schedule');
          else required(same(scheduled, { op: 'send', id: event.messageId, to: 'reports', payload: {
            ...(prior.result!.trace[prior.deliveryStep]!.payload as object), id: event.messageId, quantity: c.quantity,
          } }), 'Misbound conflicting execution schedule');
        }
      }
    }
    let count = 0;
    for (const [index, checkpoint] of definition.checkpoints.entries()) {
      count += checkpoint.commands.length;
      const wire = checkpoints[index]!, o = wire.response as Observation;
      required(o && o.instanceId === evidence.instanceId && o.processed === count && o.queued === 0
        && same(o.events, observation.events.slice(0, count)) && o.state && o.orders, 'Checkpoint identity/horizon mismatch');
      const event = o.events.at(-1)!;
      required(same(o.state, event.result?.snapshot.target), 'State not bound to execution result');
      const expected = checkpoint.expected;
      check(`${index}.business-status`, expected.status, event.status);
      if (expected.status === 'rejected') check(`${index}.rejection-reason`, true,
        typeof event.reason === 'string' && (evidence.id === 'credit-rejection' ? event.reason.includes('Insufficient credit limit') : /conflict/i.test(event.reason)));
      check(`${index}.credit`, { reserved: expected.reserved, used: expected.used }, { reserved: o.state.reservedCredit, used: o.state.usedCredit });
      const orders = Object.fromEntries(Object.entries(o.orders).map(([key, order]) => [key, { quantity: order.initialQuantity, filled: order.filledQuantity, status: order.businessStatus }]));
      check(`${index}.orders`, expected.orders, orders);
      for (const [key, expectedOrder] of Object.entries(expected.orders)) {
        const order = o.state.orders[key];
        check(`${index}.${key}.quantities`, { remaining: expectedOrder.quantity - expectedOrder.filled, cancelled: 0, price: 10 },
          order ? { remaining: order.remainingQuantity, cancelled: order.cancelledQuantity, price: order.price } : null);
        const orderResponse = evidence.exchanges.find((e, n) => n > evidence.exchanges.indexOf(wire) && e.path === `/orders/${key}`)?.response as { instanceId: string; orderId: string; processed: number; order: unknown } | undefined;
        required(orderResponse && orderResponse.instanceId === evidence.instanceId && orderResponse.orderId === key && orderResponse.processed === count
          && same(orderResponse.order, o.orders[key]), 'Missing or misbound order endpoint observation');
      }
      check(`${index}.public-oracle`, [], event.result!.violations);
      if (snapshot.brief.requirementRules?.length) {
        const rules = evaluateRequirementRules(event.result!, snapshot, index);
        check(`${index}.reviewed-credit-rules`, false, rules.some(r => r.status === 'failed' || r.status === 'inconclusive'));
      }
      if (expected.status === 'rejected') {
        const before = checkpoints[index - 1]?.response as Observation | undefined;
        check(`${index}.no-business-mutation`, before?.state, o.state);
      }
    }
    required(same(checkpoints.at(-1)?.response, observation), 'Final state does not match completed checkpoint');
    check('completion', commands.length, observation.processed);
    return { assertions, status: aggregate(assertions.map(a => a.status)) };
  } catch (error) {
    assertions.push({ id: 'evidence-completeness', expected: 'Bound complete HTTP and business observations', observed: String(error), status: 'inconclusive' });
    return { assertions, status: evidence.status === 'cancelled' ? 'cancelled' : 'inconclusive' };
  }
}
