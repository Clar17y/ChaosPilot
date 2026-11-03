import { describe, it, expect } from 'vitest';
import { evaluateTargetUiJourney } from '../../src/target-ui/evaluator.ts';
import type { TargetUiEvidence } from '../../src/target-ui/types.ts';

const INSTANCE = 'inst-1';
const HASH = 'a'.repeat(64);

function makeEvidence(): TargetUiEvidence {
  const setupCmd = { requestId: 'setup-1', kind: 'setup', limit: 100 } as const;
  const orderCmd = { requestId: 'ord-req-1', kind: 'order', orderId: 'order-1', quantity: 10 } as const;
  const execCmd = { requestId: 'exec-req-1', kind: 'execution', orderId: 'order-1', executionId: 'exec-1', quantity: 10 } as const;
  const events: any[] = [
    { instanceId: INSTANCE, eventId: `${INSTANCE}:1`, receiptId: 'rec-setup', requestId: 'setup-1', sequence: 1, status: 'accepted', command: structuredClone(setupCmd), messageId: 'http-1', deliveryStep: 3, result: null },
    { instanceId: INSTANCE, eventId: `${INSTANCE}:2`, receiptId: 'rec-order', requestId: 'ord-req-1', sequence: 2, status: 'accepted', command: structuredClone(orderCmd), messageId: 'http-2', deliveryStep: 5, result: null },
    { instanceId: INSTANCE, eventId: `${INSTANCE}:3`, receiptId: 'rec-exec', requestId: 'exec-req-1', sequence: 3, status: 'accepted', command: structuredClone(execCmd), messageId: 'http-3', deliveryStep: 7, result: null },
  ];
  const orderState = (filled: number) => ({
    orderId: 'order-1', quoteId: 'quote-1', status: filled === 10 ? 'FILLED' : 'OPEN',
    initialQuantity: 10, filledQuantity: filled, remainingQuantity: 10 - filled, cancelledQuantity: 0,
  });
  const observation = (processed: number, filled: number | null) => ({
    instanceId: INSTANCE,
    processed,
    queued: 0,
    events: structuredClone(events.slice(0, processed)),
    state: {
      quote: { id: 'quote-1', version: 1, price: 10 },
      credit: { version: 1, limit: 100 },
      reservedCredit: 0, usedCredit: 0,
      orders: filled === null ? {} : { 'order-1': orderState(filled) },
    },
    orders: filled === null ? {} : {
      'order-1': { ...orderState(filled), businessStatus: filled === 10 ? 'FILLED' : 'OPEN' },
    },
  });
  const dom = (over: Record<string, unknown> = {}) => ({
    orderId: 'order-1', transportStatus: 'acknowledged', transportReceiptId: 'rec-order', transportSequence: 2,
    businessStatus: 'OPEN', quantity: 10, filledQuantity: 0, remainingQuantity: 10, ...over,
  }) as any;
  const obs = (phase: string, timestampMs: number, domOrder: any, freshness: any, appliedSequence: number, upstreamProcessed: number): any => ({
    phase, timestampMs, domOrder,
    domFreshness: freshness,
    upstreamProcessed, upstreamQueued: 0,
    instanceId: INSTANCE, requestId: 'ord-req-1', appliedSequence, freshnessThresholdMs: 2000,
  });
  return {
    id: 'ui-journey-test',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:05.000Z',
    variant: 'clean',
    instanceId: INSTANCE,
    endpoint: 'http://127.0.0.1:4567',
    orderId: 'order-1',
    requestId: 'ord-req-1',
    receiptId: 'rec-order',
    systemBriefId: 'trading-gateway',
    systemBriefRevision: 1,
    sourceHash: HASH,
    provenance: {
      systemSnapshot: { brief: { id: 'trading-gateway', revision: 1, adapterId: 'synthetic-trading' }, contract: { rules: [] } } as any,
      sourceHash: HASH, contractHash: 'b'.repeat(64), uiHash: 'c'.repeat(64), evaluatorHash: 'd'.repeat(64),
    },
    resumeAtMs: 500,
    thresholds: { freshnessThresholdMs: 2000, convergenceDeadlineMs: 5000 },
    exchanges: [
      { method: 'POST', path: '/setup', requestBody: structuredClone(setupCmd), responseStatus: 202, responseBody: { instanceId: INSTANCE, receiptId: 'rec-setup', requestId: 'setup-1', sequence: 1, status: 'queued' }, timestampMs: 10, source: 'browser' },
      { method: 'POST', path: '/orders', requestBody: structuredClone(orderCmd), responseStatus: 202, responseBody: { instanceId: INSTANCE, receiptId: 'rec-order', requestId: 'ord-req-1', sequence: 2, status: 'queued' }, timestampMs: 30, source: 'browser' },
      { method: 'POST', path: '/executions', requestBody: structuredClone(execCmd), responseStatus: 202, responseBody: { instanceId: INSTANCE, receiptId: 'rec-exec', requestId: 'exec-req-1', sequence: 3, status: 'queued' }, timestampMs: 320, source: 'runner' },
      { method: 'GET', path: '/state', responseStatus: 200, responseBody: observation(3, 10), timestampMs: 350, source: 'runner' },
      { method: 'GET', path: '/events', responseStatus: 200, responseBody: observation(3, 10), timestampMs: 650, source: 'runner' },
    ],
    events: structuredClone(events) as any,
    uiObservations: [
      obs('after-order-transport', 100, dom({ transportStatus: 'queued', businessStatus: 'IDLE' }), { status: 'fresh', reason: 'none', label: 'FRESH', ageMs: 10 }, 1, 1),
      obs('while-held', 300, dom(), { status: 'stale', reason: 'held', label: 'STALE (HELD)', ageMs: 150 }, 2, 2),
      obs('after-resume', 600, dom({ businessStatus: 'FILLED', filledQuantity: 10, remainingQuantity: 0 }), { status: 'fresh', reason: 'none', label: 'FRESH', ageMs: 5 }, 3, 3),
    ],
    status: 'inconclusive',
    classification: 'inconclusive-wire',
    reasons: [],
  };
}

describe('Target UI journey evaluator (strict evidence)', () => {
  it('passes a complete correlated positive control and ignores the caller verdict', () => {
    const e = makeEvidence();
    e.status = 'fail'; // caller verdict must not be trusted either way
    const r = evaluateTargetUiJourney(e);
    expect(r.status).toBe('pass');
    expect(r.classification).toBe('verified');
  });

  it('passes when the upstream FILLED proof GET precedes the held DOM read', () => {
    const e = makeEvidence();
    e.exchanges[2]!.timestampMs = 250; // execution
    e.exchanges[3]!.timestampMs = 290; // proof GET, before while-held at 300
    expect(evaluateTargetUiJourney(e).status).toBe('pass');
  });

  it('passes with nondefault thresholds when observations record the same threshold', () => {
    const e = makeEvidence();
    e.thresholds = { freshnessThresholdMs: 750, convergenceDeadlineMs: 3000 };
    for (const o of e.uiObservations) o.freshnessThresholdMs = 750;
    expect(evaluateTargetUiJourney(e).status).toBe('pass');
  });

  it.each([499, 500, 501, 550])('requires held FILLED proof no later than resume at 500ms (proof %sms)', (proofAt) => {
    const e = makeEvidence();
    e.exchanges[3]!.timestampMs = proofAt;
    const result = evaluateTargetUiJourney(e);
    expect(result.status).toBe(proofAt <= 500 ? 'pass' : 'inconclusive');
    if (proofAt > 500) expect(result.reasons[0]).toMatch(/during the held window/);
  });

  it('never passes the acceptance-probe deletion: no events, no execution/GET, only after-resume', () => {
    const e = makeEvidence();
    e.events = [];
    e.exchanges = e.exchanges.filter(x => x.method === 'POST' && ['/setup', '/orders'].includes(x.path));
    e.uiObservations = e.uiObservations.filter(o => o.phase === 'after-resume');
    e.status = 'pass';
    const r = evaluateTargetUiJourney(e);
    expect(r.status).toBe('inconclusive');
    expect(r.classification).toBe('inconclusive-wire');
  });

  it.each([
    ['missing provenance', (e: TargetUiEvidence) => { delete e.provenance; }],
    ['foreign event instance', (e: TargetUiEvidence) => { (e.events[1] as any).instanceId = 'other'; }],
    ['mismatched event receipt', (e: TargetUiEvidence) => { (e.events[1] as any).receiptId = 'foreign'; }],
    ['reordered observations', (e: TargetUiEvidence) => { e.uiObservations.reverse(); }],
    ['non-monotonic exchange timestamps', (e: TargetUiEvidence) => { e.exchanges[3]!.timestampMs = 1; }],
    ['missing execution exchange', (e: TargetUiEvidence) => { e.exchanges = e.exchanges.filter(x => x.path !== '/executions'); }],
    ['missing GET proof', (e: TargetUiEvidence) => { e.exchanges = e.exchanges.filter(x => x.method !== 'GET'); }],
    ['foreign observation instance', (e: TargetUiEvidence) => { e.uiObservations[0]!.instanceId = 'other'; }],
    ['observation threshold not the applied threshold', (e: TargetUiEvidence) => { e.uiObservations[1]!.freshnessThresholdMs = 999; }],
    ['execution quantity does not fill the order', (e: TargetUiEvidence) => { (e.exchanges[2]!.requestBody as any).quantity = 4; (e.events[2] as any).command.quantity = 4; }],
    ['duplicate order exchange', (e: TargetUiEvidence) => { e.exchanges.splice(2, 0, structuredClone(e.exchanges[1]!)); }],
    ['finished before started', (e: TargetUiEvidence) => { e.finishedAt = '2025-01-01T00:00:00.000Z'; }],
    ['missing while-held phase', (e: TargetUiEvidence) => { e.uiObservations = e.uiObservations.filter(o => o.phase !== 'while-held'); }],
  ])('returns inconclusive for %s', (_name, mutate) => {
    const e = makeEvidence();
    mutate(e);
    expect(evaluateTargetUiJourney(e).status).toBe('inconclusive');
  });

  it('fails as ui-failure when DOM is wrong after proved upstream FILLED', () => {
    const e = makeEvidence();
    e.uiObservations[2]!.domOrder!.businessStatus = 'OPEN';
    e.uiObservations[2]!.domOrder!.filledQuantity = 0;
    e.uiObservations[2]!.domOrder!.remainingQuantity = 10;
    const r = evaluateTargetUiJourney(e);
    expect(r).toMatchObject({ status: 'fail', classification: 'ui-failure' });
  });

  it('does not blame the UI when upstream never proved FILLED', () => {
    const e = makeEvidence();
    for (const x of e.exchanges.filter(x => x.method === 'GET')) {
      (x.responseBody as any).orders['order-1'].businessStatus = 'OPEN';
      (x.responseBody as any).orders['order-1'].filledQuantity = 0;
      (x.responseBody as any).orders['order-1'].remainingQuantity = 10;
      (x.responseBody as any).state.orders['order-1'].status = 'OPEN';
      (x.responseBody as any).state.orders['order-1'].filledQuantity = 0;
      (x.responseBody as any).state.orders['order-1'].remainingQuantity = 10;
    }
    e.uiObservations[2]!.domOrder!.businessStatus = 'OPEN';
    e.uiObservations[2]!.domOrder!.filledQuantity = 0;
    e.uiObservations[2]!.domOrder!.remainingQuantity = 10;
    const r = evaluateTargetUiJourney(e);
    expect(r.status).toBe('inconclusive');
    expect(r.classification).toBe('inconclusive-timeout');
  });

  it('fails as ui-failure for premature FILLED on transport, unlabelled stale, held fill, and late convergence', () => {
    const premature = makeEvidence();
    premature.uiObservations[0]!.domOrder!.businessStatus = 'FILLED';
    premature.uiObservations[0]!.domOrder!.filledQuantity = 10;
    premature.uiObservations[0]!.domOrder!.remainingQuantity = 0;
    expect(evaluateTargetUiJourney(premature)).toMatchObject({ status: 'fail', classification: 'ui-failure' });

    const unlabelled = makeEvidence();
    unlabelled.uiObservations[1]!.domFreshness.status = 'fresh';
    unlabelled.uiObservations[1]!.domFreshness.reason = 'none';
    expect(evaluateTargetUiJourney(unlabelled)).toMatchObject({ status: 'fail', classification: 'ui-failure' });

    const heldFill = makeEvidence();
    heldFill.uiObservations[1]!.domOrder!.businessStatus = 'FILLED';
    heldFill.uiObservations[1]!.domOrder!.filledQuantity = 10;
    heldFill.uiObservations[1]!.domOrder!.remainingQuantity = 0;
    expect(evaluateTargetUiJourney(heldFill)).toMatchObject({ status: 'fail', classification: 'ui-failure' });

    const late = makeEvidence();
    late.uiObservations[2]!.timestampMs = 500 + 5001;
    late.exchanges[4]!.timestampMs = 6000;
    expect(evaluateTargetUiJourney(late)).toMatchObject({ status: 'fail', classification: 'ui-failure' });
  });

  it('separates upstream rejection and non-202 from UI failure', () => {
    const rejected = makeEvidence();
    (rejected.events[1] as any).status = 'rejected';
    (rejected.events[1] as any).reason = 'Credit limit exceeded';
    for (const x of rejected.exchanges.filter(x => x.method === 'GET')) (x.responseBody as any).events = structuredClone(rejected.events.slice(0, (x.responseBody as any).processed));
    expect(evaluateTargetUiJourney(rejected)).toMatchObject({ status: 'fail', classification: 'upstream-failure' });

    const non202 = makeEvidence();
    non202.exchanges[1]!.responseStatus = 409;
    non202.exchanges[1]!.responseBody = { error: 'conflict' };
    expect(evaluateTargetUiJourney(non202)).toMatchObject({ status: 'fail', classification: 'upstream-failure' });
  });

  it('classifies recorded run errors without trusting partial evidence', () => {
    const browser = makeEvidence();
    browser.runError = { kind: 'browser', message: 'No Chrome or Edge executable found' };
    expect(evaluateTargetUiJourney(browser)).toMatchObject({ status: 'inconclusive', classification: 'inconclusive-wire' });
    const cancelled = makeEvidence();
    cancelled.runError = { kind: 'cancelled', message: 'Aborted by caller' };
    expect(evaluateTargetUiJourney(cancelled)).toMatchObject({ status: 'cancelled', classification: 'cancelled' });
    const timed = makeEvidence();
    timed.runError = { kind: 'timeout', message: 'deadline exceeded' };
    expect(evaluateTargetUiJourney(timed)).toMatchObject({ status: 'inconclusive', classification: 'inconclusive-timeout' });
  });

  it('rejects malformed inputs wholesale', () => {
    expect(evaluateTargetUiJourney(null).status).toBe('inconclusive');
    expect(evaluateTargetUiJourney({}).status).toBe('inconclusive');
    expect(evaluateTargetUiJourney('pass').status).toBe('inconclusive');
    const e = makeEvidence();
    (e as any).exchanges = 'wire';
    expect(evaluateTargetUiJourney(e).status).toBe('inconclusive');
  });
});
