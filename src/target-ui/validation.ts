import type { Observation, Receipt } from '../target-api/types.ts';

export const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
export const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
export const positive = (v: unknown): v is number => count(v) && v > 0 && v <= 1000;
export const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
export function validReceipt(v: unknown, instanceId: string | null, requestId: string): v is Receipt {
  return object(v) && text(v.instanceId) && (!instanceId || v.instanceId === instanceId) && text(v.receiptId)
    && v.requestId === requestId && count(v.sequence) && v.sequence > 0 && v.status === 'queued';
}
/** Browser-safe shape and correlation checks before any event/display/freshness mutation. */
export function validObservation(v: unknown, instanceId: string | null, lastSequence = 0): v is Observation {
  if (!object(v) || !text(v.instanceId) || instanceId && v.instanceId !== instanceId || !count(v.processed)
    || v.processed < lastSequence || !count(v.queued) || v.processed + v.queued > 32 || !Array.isArray(v.events)
    || v.events.length !== v.processed || !object(v.orders) || !object(v.state) || !object(v.state.orders)) return false;
  const receipts = new Set(), requests = new Set();
  if (!v.events.every((e: unknown, i: number) => {
    if (!object(e) || e.instanceId !== v.instanceId || e.sequence !== i + 1 || e.eventId !== `${v.instanceId}:${i + 1}`
      || !text(e.requestId) || !text(e.receiptId) || receipts.has(e.receiptId) || requests.has(e.requestId)
      || !object(e.command) || e.command.requestId !== e.requestId || !['accepted', 'rejected', 'error'].includes(e.status)
      || !['setup', 'order', 'execution'].includes(e.command.kind)
      || (e.command.kind === 'setup' ? !positive(e.command.limit) : !text(e.command.orderId) || !positive(e.command.quantity))
      || e.command.kind === 'execution' && !text(e.command.executionId)) return false;
    receipts.add(e.receiptId); requests.add(e.requestId); return true;
  })) return false;
  return Object.entries(v.orders).every(([key, o]) => object(o) && o.orderId === key && positive(o.initialQuantity)
    && count(o.filledQuantity) && count(o.remainingQuantity) && count(o.cancelledQuantity)
    && o.initialQuantity === o.filledQuantity + o.remainingQuantity + o.cancelledQuantity
    && ['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED'].includes(o.businessStatus)
    && object(v.state.orders[key]) && ['initialQuantity', 'filledQuantity', 'remainingQuantity', 'cancelledQuantity'].every(k => o[k] === v.state.orders[key][k]));
}
