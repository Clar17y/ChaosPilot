import { assertAdapterContract } from '../adapters/index.ts';
import { requirementEvaluatorAvailable } from '../requirements/identity.ts';
import { TARGET_VARIANTS, type SystemBriefSnapshot } from '../domain.ts';
import { computeSnapshotHash, validateSystemBrief } from '../systems/index.ts';
import { digest, same, evaluatorIdentity, transportIdentity } from './identity.ts';
import { CATALOG } from './catalog.ts';
import { aggregate, evaluateJourney } from './evaluator.ts';
import type { ApiJourneyRecord, Observation } from './types.ts';

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const hash = (v: unknown): boolean => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const count = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;
const status = (v: unknown): boolean => ['pass', 'fail', 'inconclusive', 'cancelled'].includes(String(v));
const identity = (v: unknown): boolean => object(v) && v.version === 1 && hash(v.hash);
const keys = (v: Record<string, unknown>, allowed: string[]): boolean => Object.keys(v).every(k => allowed.includes(k));
const finite = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
function state(v: unknown): boolean {
  return object(v) && finite(v.reservedCredit) && finite(v.usedCredit) && object(v.orders)
    && (v.quote === null || object(v.quote) && text(v.quote.id) && finite(v.quote.version) && finite(v.quote.price))
    && (v.credit === null || object(v.credit) && finite(v.credit.version) && finite(v.credit.limit))
    && Object.entries(v.orders).every(([key, o]) => object(o) && o.orderId === key && text(o.quoteId) && typeof o.cancellationRequested === 'boolean' && ['OPEN', 'FILLED', 'CANCELLED'].includes(o.status) && ['initialQuantity', 'remainingQuantity', 'filledQuantity', 'cancelledQuantity', 'price'].every(k => finite(o[k])) && text(o.status));
}
function result(v: unknown): boolean {
  return object(v) && v.schemaVersion === 1 && hash(v.sourceHash) && typeof v.valid === 'boolean' && typeof v.executionComplete === 'boolean'
    && object(v.experiment) && text(v.experiment.hypothesis) && text(v.experiment.expectedInvariant) && Array.isArray(v.experiment.steps) && v.experiment.steps.every((s: unknown) => object(s) && text(s.op))
    && Array.isArray(v.trace) && v.trace.every((t: unknown) => object(t) && count(t.step) && finite(t.time) && text(t.action) && state(t.state))
    && object(v.snapshot) && state(v.snapshot.target)
    && Array.isArray(v.violations) && v.violations.every(object) && Array.isArray(v.rejections) && v.rejections.every(object)
    && Array.isArray(v.deliveryObservations) && v.deliveryObservations.every((d: unknown) => object(d) && count(d.step) && count(d.traceIndex) && text(d.action) && text(d.messageId) && text(d.channel) && typeof d.payloadValid === 'boolean' && ['accepted', 'rejected', 'exception'].includes(d.status));
}
function command(v: unknown): boolean {
  return object(v) && text(v.requestId) && (v.kind === 'setup' ? finite(v.limit) : ['order', 'execution'].includes(v.kind) && text(v.orderId) && finite(v.quantity) && (v.kind !== 'execution' || text(v.executionId)));
}
export function isObservation(v: unknown): v is Observation {
  return object(v) && keys(v, ['instanceId', 'processed', 'queued', 'events', 'state', 'orders']) && text(v.instanceId) && count(v.processed) && count(v.queued) && state(v.state) && object(v.orders)
    && Object.values(v.orders).every(o => object(o) && text(o.businessStatus) && ['initialQuantity', 'remainingQuantity', 'filledQuantity', 'cancelledQuantity', 'price'].every(k => finite(o[k])))
    && Array.isArray(v.events) && v.events.every((e: unknown) => object(e) && keys(e, ['instanceId', 'eventId', 'receiptId', 'requestId', 'sequence', 'command', 'status', 'reason', 'messageId', 'deliveryStep', 'result']) && ['instanceId', 'eventId', 'receiptId', 'requestId', 'messageId'].every(k => text(e[k]))
      && count(e.sequence) && count(e.deliveryStep) && command(e.command) && ['accepted', 'rejected', 'error'].includes(e.status) && (e.reason === undefined || typeof e.reason === 'string') && (e.result === null || result(e.result)));
}
export function verifyRecordIntegrity(record: unknown): boolean {
  try { return object(record) && hash(record.integrity) && record.integrity === digest({ ...record, integrity: '' }); } catch { return false; }
}
export function validatePinnedContext(snapshot: SystemBriefSnapshot): void {
  const s: unknown = snapshot;
  if (!object(s) || !object(s.brief) || !validateSystemBrief(s.brief).valid || s.brief.adapterId !== 'synthetic-trading') throw new Error('Invalid synthetic-trading brief');
  const c = s.contract;
  if (!object(c) || !text(c.name) || !text(c.description) || !Array.isArray(c.operations) || !c.operations.every(object)
    || !Array.isArray(c.messages) || !c.messages.every(object) || !Array.isArray(c.invariants) || !c.invariants.every((i: unknown) => object(i) && text(i.id) && text(i.description))
    || !object(c.limits) || !Object.values(c.limits).every(finite)) throw new Error('Invalid pinned contract');
  const e = s.requirementEvaluator;
  if ((e !== undefined && (!object(e) || !text(e.id) || !Number.isSafeInteger(e.version) || e.version < 1 || !hash(e.hash)))
    || (s.brief.requirementRules?.length && !e)) throw new Error('Invalid pinned requirement evaluator');
  if (!hash(s.hash) || s.hash !== computeSnapshotHash(snapshot.brief, snapshot.contract, snapshot.requirementEvaluator)) throw new Error('System brief snapshot mismatch (integrity)');
}
/** Historical identities remain readable. Only the compatible current runtime may re-evaluate them. */
export function recordValidationError(value: unknown, expectedId?: string): string | null {
  try {
    if (!object(value)) return 'Invalid record object';
    const r = value;
    if (!verifyRecordIntegrity(r)) return 'Record integrity failed';
    if (r.schemaVersion !== 1 || r.type !== 'scripted-target-api' || r.adapterId !== 'synthetic-trading' || !(TARGET_VARIANTS as readonly unknown[]).includes(r.variant)) return 'Unsupported schema, adapter or variant';
    if (!text(r.id) || !/^[a-zA-Z0-9_-]{1,128}$/.test(r.id) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(r.id) || /ledger/i.test(r.id) || expectedId !== undefined && r.id !== expectedId) return 'Invalid run identity';
    if (!text(r.startedAt) || !text(r.finishedAt) || !Number.isFinite(Date.parse(r.startedAt)) || !Number.isFinite(Date.parse(r.finishedAt)) || Date.parse(r.finishedAt) < Date.parse(r.startedAt)) return 'Invalid terminal timestamps';
    if (!identity(r.evaluator) || !identity(r.transport) || !hash(r.sourceHash) || !hash(r.contractHash) || !status(r.status)) return 'Invalid identity or status';
    validatePinnedContext(r.systemSnapshot);
    if (r.contractHash !== digest(r.systemSnapshot.contract)) return 'Pinned contract digest mismatch';
    if (!Array.isArray(r.journeys)) return 'Invalid journeys';
    const ids = new Set<string>();
    for (const j of r.journeys) {
      if (!object(j) || !CATALOG.some(c => c.id === j.id) || ids.has(j.id)) return 'Unknown or duplicate catalog journey';
      ids.add(j.id);
      if (!status(j.status) || typeof j.instanceId !== 'string' || typeof j.endpoint !== 'string' || j.error !== undefined && typeof j.error !== 'string'
        || !Array.isArray(j.assertions) || !Array.isArray(j.exchanges) || j.observation !== null && !isObservation(j.observation)) return 'Malformed journey evidence';
      const assertions = new Set();
      for (const a of j.assertions) {
        if (!object(a) || !text(a.id) || assertions.has(a.id) || !['pass', 'fail', 'inconclusive'].includes(a.status) || !('expected' in a) || !('observed' in a)) return 'Malformed or duplicate assertion';
        assertions.add(a.id);
      }
      for (const e of j.exchanges) {
        if (!object(e) || !['GET', 'POST'].includes(e.method) || !text(e.path) || !count(e.status) || e.status < 100 || e.status > 599 || !finite(e.elapsedMs) || e.elapsedMs < 0 || !('request' in e) || !('response' in e)) return 'Malformed exchange';
        if (['inconclusive', 'cancelled'].includes(j.status)) continue;
        if (e.status === 200 && e.method === 'GET' && ['/state', '/events'].includes(e.path) && !isObservation(e.response)) return 'Malformed wire observation';
        if (e.status === 202 && e.method === 'POST' && (!command(e.request) || !object(e.response) || !text(e.response.instanceId) || !text(e.response.receiptId) || !text(e.response.requestId) || !count(e.response.sequence) || e.response.status !== 'queued')) return 'Malformed receipt';
        if (e.status === 200 && e.method === 'GET' && e.path.startsWith('/orders/') && (!object(e.response) || !text(e.response.instanceId) || !text(e.response.orderId) || !count(e.response.processed) || !object(e.response.order))) return 'Malformed order observation';
      }
      if (['pass', 'fail'].includes(j.status) && (!j.instanceId || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(j.endpoint) || j.error || !new URL(j.endpoint).port || !j.observation || !j.assertions.length || aggregate(j.assertions.map((a: any) => a.status)) !== j.status)) return 'Inconsistent terminal journey status';
    }
    if (aggregate(r.journeys.map((j: any) => j.status)) !== r.status || ['pass', 'fail'].includes(r.status) && ids.size !== CATALOG.length) return 'Incomplete catalog or inconsistent aggregate status';
    return null;
  } catch (error) { return `Invalid record: ${String(error)}`; }
}
export function currentIdentityError(r: ApiJourneyRecord): string | null {
  try {
    assertAdapterContract(r.systemSnapshot);
    if (r.systemSnapshot.requirementEvaluator && !requirementEvaluatorAvailable(r.systemSnapshot.requirementEvaluator)) return 'Pinned requirement evaluator is unavailable';
    if (!same(r.evaluator, evaluatorIdentity())) return 'Evaluator implementation has changed or is unavailable';
    if (!same(r.transport, transportIdentity())) return 'HTTP transport implementation has changed or is unavailable';
    return null;
  } catch (error) { return String(error); }
}
export function semanticRecordError(r: ApiJourneyRecord): string | null {
  for (const j of r.journeys) {
    const evaluated = evaluateJourney(j, r.sourceHash, r.systemSnapshot);
    if (evaluated.status !== j.status || !same(evaluated.assertions, j.assertions)) return `Journey "${j.id}" stored assertions/status disagree with re-evaluated wire evidence`;
  }
  return null;
}
