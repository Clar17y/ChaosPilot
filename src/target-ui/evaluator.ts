import type { TargetUiClassification, TargetUiEvidence, TargetUiVerdictStatus } from './types.ts';
import { count, object, positive, text, validObservation, validReceipt } from './validation.ts';

export interface EvaluationResult {
  status: TargetUiVerdictStatus;
  classification: TargetUiClassification;
  reasons: string[];
}

const wire = (reason: string): EvaluationResult => ({ status: 'inconclusive', classification: 'inconclusive-wire', reasons: [reason] });
const timeout = (reason: string): EvaluationResult => ({ status: 'inconclusive', classification: 'inconclusive-timeout', reasons: [reason] });
const uiFail = (reason: string): EvaluationResult => ({ status: 'fail', classification: 'ui-failure', reasons: [reason] });
const upstreamFail = (reason: string): EvaluationResult => ({ status: 'fail', classification: 'upstream-failure', reasons: [reason] });
const hash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const boundedPositive = (v: unknown, max: number): v is number => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= max;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function validDomOrder(v: unknown): boolean {
  return object(v) && text(v.orderId)
    && ['none', 'queued', 'acknowledged', 'failed'].includes(v.transportStatus)
    && (v.transportReceiptId === null || text(v.transportReceiptId))
    && (v.transportSequence === null || (count(v.transportSequence) && v.transportSequence > 0))
    && ['IDLE', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'ERROR'].includes(v.businessStatus)
    && positive(v.quantity) && count(v.filledQuantity) && count(v.remainingQuantity)
    && v.quantity === v.filledQuantity + v.remainingQuantity;
}

/**
 * Independent evaluator. Pass requires complete, structurally valid, exactly
 * correlated wire + event + actual-DOM evidence proving upstream FILLED while
 * the held DOM stayed OPEN, then DOM convergence within the recorded deadline.
 * Caller-supplied verdict fields are ignored; anything missing/corrupt is inconclusive.
 */
export function evaluateTargetUiJourney(input: unknown): EvaluationResult {
  if (!object(input)) return wire('No evidence provided');
  const evidence = input as TargetUiEvidence;

  if (evidence.runError) {
    if (!object(evidence.runError) || !text(evidence.runError.message)) return wire('Malformed run error in evidence');
    if (evidence.runError.kind === 'cancelled') return { status: 'cancelled', classification: 'cancelled', reasons: [`Journey execution was cancelled: ${evidence.runError.message}`] };
    if (evidence.runError.kind === 'timeout') return timeout(`Journey did not complete: ${evidence.runError.message}`);
    if (evidence.runError.kind === 'browser' || evidence.runError.kind === 'transport') return wire(`Journey did not complete (${evidence.runError.kind}): ${evidence.runError.message}`);
    return wire('Unknown run error kind in evidence');
  }

  const started = Date.parse(evidence.startedAt), finished = Date.parse(evidence.finishedAt);
  if (!text(evidence.id) || !Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return wire('Missing or non-monotonic evidence start/finish times');
  if (!text(evidence.variant) || !text(evidence.instanceId) || !text(evidence.orderId) || !text(evidence.requestId) || !text(evidence.receiptId)) return wire('Missing evidence identity fields');
  if (typeof evidence.endpoint !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(evidence.endpoint)) return wire('Missing or invalid loopback instance endpoint');

  const { freshnessThresholdMs, convergenceDeadlineMs } = object(evidence.thresholds) ? evidence.thresholds : ({} as any);
  if (!boundedPositive(freshnessThresholdMs, 60_000) || !boundedPositive(convergenceDeadlineMs, 60_000)) return wire('Invalid or corrupted thresholds in evidence');

  // Provenance must be pinned for any verified claim.
  const p = evidence.provenance;
  if (!object(p) || !object(p.systemSnapshot) || !object(p.systemSnapshot.brief)
    || !text(p.systemSnapshot.brief.id) || !boundedPositive(p.systemSnapshot.brief.revision, 1_000_000)
    || p.systemSnapshot.brief.adapterId !== 'synthetic-trading' || !object(p.systemSnapshot.contract)
    || !hash(p.sourceHash) || !hash(p.contractHash) || !hash(p.uiHash) || !hash(p.evaluatorHash)) return wire('Missing or invalid pinned provenance (system snapshot/source/contract/UI/evaluator)');
  if (evidence.systemBriefId !== undefined && evidence.systemBriefId !== p.systemSnapshot.brief.id) return wire('systemBriefId does not match pinned snapshot');
  if (evidence.systemBriefRevision !== undefined && evidence.systemBriefRevision !== p.systemSnapshot.brief.revision) return wire('systemBriefRevision does not match pinned snapshot');
  if (evidence.sourceHash !== undefined && evidence.sourceHash !== p.sourceHash) return wire('sourceHash does not match pinned provenance');

  if (!Array.isArray(evidence.exchanges) || !evidence.exchanges.length || !Array.isArray(evidence.events) || !Array.isArray(evidence.uiObservations)) return wire('Missing exchanges/events/observations arrays');
  for (const e of evidence.exchanges) {
    if (!object(e) || !['GET', 'POST'].includes(e.method) || !text(e.path) || !count(e.responseStatus) || !finite(e.timestampMs)
      || (e.source !== undefined && !['browser', 'runner'].includes(e.source))) return wire('Malformed wire exchange in evidence');
  }
  // Browser-clock exchange timestamps must be ordered as recorded.
  for (let i = 1; i < evidence.exchanges.length; i++) if (evidence.exchanges[i]!.timestampMs < evidence.exchanges[i - 1]!.timestampMs) return wire('Wire exchange timestamps are not monotonic');

  const posts = evidence.exchanges.filter(e => e.method === 'POST');
  const byPath = (path: string) => posts.filter(e => e.path === path);
  const setups = byPath('/setup'), orders = byPath('/orders'), execs = byPath('/executions');
  if (setups.length !== 1 || orders.length !== 1 || execs.length !== 1) return wire('Evidence must contain exactly one setup, one order and one execution exchange');
  const [setupEx, orderEx, execEx] = [setups[0]!, orders[0]!, execs[0]!];
  if (!(setupEx.timestampMs <= orderEx.timestampMs && orderEx.timestampMs <= execEx.timestampMs)) return wire('Command exchanges are out of order');
  for (const [name, ex] of [['Setup', setupEx], ['Order', orderEx], ['Execution', execEx]] as const) {
    if (ex.responseStatus !== 202) return object(ex.responseBody) ? upstreamFail(`${name} returned HTTP ${ex.responseStatus} instead of 202`) : wire(`${name} exchange has no recorded response body`);
    if (!object(ex.requestBody) || !text(ex.requestBody.requestId) || !validReceipt(ex.responseBody, evidence.instanceId, ex.requestBody.requestId)) return wire(`${name} exchange lacks a correlated queued receipt for this instance`);
  }
  const receipts = [setupEx, orderEx, execEx].map(e => e.responseBody as any);
  if (!(receipts[0].sequence < receipts[1].sequence && receipts[1].sequence < receipts[2].sequence)) return wire('Receipt sequences are not strictly increasing');
  if (new Set(receipts.map(r => r.receiptId)).size !== 3 || new Set(receipts.map(r => r.requestId)).size !== 3) return wire('Duplicate receipt or request identities');
  const orderReq = orderEx.requestBody as any, execReq = execEx.requestBody as any, setupReq = setupEx.requestBody as any;
  if (setupReq.kind !== 'setup' || !positive(setupReq.limit)) return wire('Malformed setup command');
  if (orderReq.kind !== 'order' || orderReq.orderId !== evidence.orderId || orderReq.requestId !== evidence.requestId || !positive(orderReq.quantity)) return wire('Order command does not match evidence order/request identity');
  if (execReq.kind !== 'execution' || execReq.orderId !== evidence.orderId || !text(execReq.executionId) || !positive(execReq.quantity)) return wire('Execution command does not match evidence order identity');
  if (receipts[1].receiptId !== evidence.receiptId) return wire('Evidence receiptId does not match the order receipt');
  const expectedQty = orderReq.quantity as number;
  if (execReq.quantity !== expectedQty) return wire('Execution quantity does not fully fill the order; FILLED cannot be proved');

  // Events must be the complete, exactly correlated business record of the three commands.
  const finalSeq = receipts[2].sequence as number;
  if (evidence.events.length !== finalSeq) return wire(`Expected ${finalSeq} business events for the recorded receipts, found ${evidence.events.length}`);
  const commands = [setupReq, orderReq, execReq];
  for (let i = 0; i < evidence.events.length; i++) {
    const ev: any = evidence.events[i];
    if (!object(ev) || ev.instanceId !== evidence.instanceId || ev.sequence !== i + 1 || ev.eventId !== `${evidence.instanceId}:${i + 1}` || !object(ev.command)) return wire('Malformed or foreign business event in evidence');
    const receipt = receipts.find(r => r.sequence === ev.sequence);
    if (!receipt || ev.receiptId !== receipt.receiptId || ev.requestId !== receipt.requestId || !same(ev.command, commands[receipts.indexOf(receipt)])) return wire('Business event does not correlate with its wire exchange');
    if (ev.status === 'rejected' || ev.status === 'error') return upstreamFail(`Upstream target rejected event #${ev.sequence}: ${ev.reason ?? ev.status}`);
    if (ev.status !== 'accepted') return wire('Business event has unknown status');
  }

  // A recorded GET observation must prove upstream convergence to FILLED, drained.
  const gets = evidence.exchanges.filter(e => e.method === 'GET' && (e.path === '/events' || e.path === '/state'));
  if (!gets.length) return wire('No recorded GET state/events exchange proves upstream state');
  const provedFilled = (body: unknown): boolean => validObservation(body, evidence.instanceId, 0)
    && (body as any).processed === finalSeq && (body as any).queued === 0
    && same((body as any).events, evidence.events)
    && object((body as any).orders[evidence.orderId])
    && (body as any).orders[evidence.orderId].businessStatus === 'FILLED'
    && (body as any).orders[evidence.orderId].filledQuantity === expectedQty
    && (body as any).orders[evidence.orderId].remainingQuantity === 0;
  for (const g of gets) if (g.responseStatus === 200 && g.responseBody !== undefined && !validObservation(g.responseBody, evidence.instanceId, 0)) return wire('Recorded GET observation is malformed or foreign');
  const finalGet = gets[gets.length - 1]!;
  const upstreamFilled = finalGet.responseStatus === 200 && provedFilled(finalGet.responseBody);

  // Observations: required phases, in order, on one monotonic clock, fully correlated.
  const obs = evidence.uiObservations;
  for (let i = 0; i < obs.length; i++) {
    const o: any = obs[i];
    if (!object(o) || !text(o.phase) || !finite(o.timestampMs) || o.instanceId !== evidence.instanceId || o.requestId !== evidence.requestId
      || o.freshnessThresholdMs !== freshnessThresholdMs || !count(o.appliedSequence) || !count(o.upstreamProcessed) || !count(o.upstreamQueued)
      || !object(o.domFreshness) || !['fresh', 'stale'].includes(o.domFreshness.status) || !text(o.domFreshness.label) || !finite(o.domFreshness.ageMs)
      || (o.domOrder !== null && !validDomOrder(o.domOrder))) return wire('Malformed, foreign or uncorrelated UI observation');
    if (i > 0 && (o.timestampMs < obs[i - 1]!.timestampMs || o.appliedSequence < (obs[i - 1] as any).appliedSequence || o.upstreamProcessed < obs[i - 1]!.upstreamProcessed)) return wire('UI observations are out of order');
    if (o.domFreshness.status === 'stale' && !o.domFreshness.label.includes('STALE')) return uiFail('DOM freshness label does not disclose stale data');
    if (o.domFreshness.status === 'fresh' && o.domFreshness.ageMs > freshnessThresholdMs) return uiFail('DOM claims FRESH beyond the recorded freshness threshold');
  }
  const idx = (phase: string) => obs.findIndex(o => o.phase === phase);
  const [iTransport, iHeld, iResume] = [idx('after-order-transport'), idx('while-held'), idx('after-resume')];
  if (iTransport < 0 || iHeld < 0) return wire('Missing required transport or while-held UI observation');
  if (iResume < 0) return upstreamFilled ? uiFail('No DOM observation after resume despite proved upstream FILLED') : timeout('No observation recorded after updates resumed (convergence deadline timeout)');
  if (!(iTransport < iHeld && iHeld < iResume)) return wire('Required UI observation phases are out of order');
  const [transportObs, heldObs, resumeObs] = [obs[iTransport]!, obs[iHeld]!, obs[iResume]!];
  if (!finite(evidence.resumeAtMs)) return wire('Missing recorded resume timestamp');
  if (evidence.resumeAtMs! < heldObs.timestampMs || resumeObs.timestampMs < evidence.resumeAtMs!) return wire('Resume timestamp is inconsistent with observation phases');

  // Transport acknowledgement must be visibly distinct from business acceptance.
  if (!transportObs.domOrder || transportObs.domOrder.orderId !== evidence.orderId) return wire('Transport observation has no correlated DOM order');
  if (transportObs.domOrder.transportStatus !== 'queued' || transportObs.domOrder.transportReceiptId !== evidence.receiptId || transportObs.domOrder.transportSequence !== receipts[1].sequence) return wire('Transport observation DOM receipt does not correlate with the wire receipt');
  if (transportObs.domOrder.businessStatus === 'FILLED' || transportObs.domOrder.filledQuantity !== 0) return uiFail('DOM displayed business status FILLED immediately upon HTTP 202 before business event');
  if (transportObs.domOrder.businessStatus !== 'IDLE') return wire('Transport observation must show pending (IDLE) business status');

  // While held: honest stale label, retained pre-fill DOM, while a recorded GET in
  // the held window proves the upstream target already reached FILLED.
  if (heldObs.domFreshness.status !== 'stale' || heldObs.domFreshness.reason !== 'held') return uiFail('UI failed to label retained data STALE while updates were held');
  if (!heldObs.domOrder || heldObs.domOrder.orderId !== evidence.orderId) return wire('Held observation has no correlated DOM order');
  if (heldObs.domOrder.businessStatus !== 'OPEN' || heldObs.domOrder.filledQuantity !== 0 || heldObs.domOrder.remainingQuantity !== expectedQty) return uiFail('UI applied fill update to DOM while updates were held');
  if ((heldObs as any).appliedSequence >= finalSeq) return uiFail('Held DOM had already applied the fill sequence');
  // A proof obtained after resuming cannot establish what happened during hold.
  const heldProof = gets.find(g => g.responseStatus === 200 && g.timestampMs >= execEx.timestampMs && g.timestampMs <= evidence.resumeAtMs! && provedFilled(g.responseBody));
  if (!heldProof) return upstreamFilled ? wire('No recorded GET proves upstream FILLED during the held window') : timeout('Upstream target never proved FILLED state in recorded evidence');

  // Resume convergence within the recorded deadline, matching proved upstream state.
  if (resumeObs.timestampMs - evidence.resumeAtMs! > convergenceDeadlineMs) return uiFail('DOM convergence was recorded after the convergence deadline');
  if (!upstreamFilled) return timeout('Upstream target never proved FILLED state in recorded evidence');
  if (resumeObs.domFreshness.status !== 'fresh') return uiFail('Freshness failed to restore to FRESH after updates resumed');
  const finalOrder = resumeObs.domOrder;
  if (!finalOrder) return uiFail('No active order found in DOM after resume');
  if (finalOrder.orderId !== evidence.orderId || finalOrder.transportReceiptId !== evidence.receiptId || finalOrder.transportSequence !== receipts[1].sequence) return uiFail('Settled DOM displayed mismatched transport receiptId');
  if (finalOrder.businessStatus !== 'FILLED') return uiFail(`Settled DOM displayed business status "${finalOrder.businessStatus}", expected "FILLED"`);
  if (finalOrder.quantity !== expectedQty || finalOrder.filledQuantity !== expectedQty) return uiFail(`Settled DOM displayed filledQuantity ${finalOrder.filledQuantity}, expected ${expectedQty}`);
  if (finalOrder.remainingQuantity !== 0) return uiFail(`Settled DOM displayed remainingQuantity ${finalOrder.remainingQuantity}, expected 0`);
  if ((resumeObs as any).appliedSequence !== finalSeq || resumeObs.upstreamProcessed !== finalSeq || resumeObs.upstreamQueued !== 0) return uiFail('Settled DOM did not apply the final upstream sequence');

  return {
    status: 'pass',
    classification: 'verified',
    reasons: [
      'Transport 202 distinct from business acceptance',
      'Truthful freshness state and stale labeling during update hold',
      'Correct DOM convergence to FILLED with matching quantities upon resume',
      'Correlated instanceId, orderId, requestId, receiptId across wire and DOM',
    ],
  };
}
