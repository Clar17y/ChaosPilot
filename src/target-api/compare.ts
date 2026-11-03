import { digest, same } from './identity.ts';
import { currentIdentityError, recordValidationError, semanticRecordError, verifyRecordIntegrity } from './validation.ts';
import type { ApiJourneyRecord, Comparison, JourneyEvidence } from './types.ts';
export { verifyRecordIntegrity };

/** Bindings are checked before projection. Only transport-generated identities and timing are normalized. */
function projection(j: JourneyEvidence): unknown {
  const receipts = new Map(j.observation!.events.map(e => [e.receiptId, `receipt:${e.sequence}`]));
  const events = new Map(j.observation!.events.map(e => [e.eventId, `event:${e.sequence}`]));
  function normalize(v: unknown, key = ''): unknown {
    if (key === 'instanceId' && v === j.instanceId) return 'instance';
    if (key === 'receiptId' && typeof v === 'string') return receipts.get(v) ?? v;
    if (key === 'eventId' && typeof v === 'string') return events.get(v) ?? v;
    if (Array.isArray(v)) return v.map(x => normalize(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x, k)]));
    return v;
  }
  return normalize({ id: j.id, endpoint: new URL(j.endpoint).hostname, status: j.status, assertions: j.assertions,
    observation: j.observation,
    exchanges: j.exchanges.filter(e => e.path !== '/events').map(({ elapsedMs: _, ...e }) => e) });
}
export function compareApiJourneys(original: ApiJourneyRecord, fresh: ApiJourneyRecord): Comparison {
  const base = { originalId: original?.id ?? 'unknown', freshId: fresh?.id, differences: [] as NonNullable<Comparison['differences']> };
  const result = (status: Comparison['status'], reasons: string[], note: string): Comparison => ({ ...base, status, reasons, note });
  const blocked = (reason: string) => result('blocked', [reason], 'Semantic rerun comparison blocked; evidence was not re-verified.');
  for (const [label, record] of [['Original', original], ['Fresh', fresh]] as const) {
    const error = recordValidationError(record);
    if (error) return blocked(`${label} ${error}`);
  }
  if (original.systemSnapshot.hash !== fresh.systemSnapshot.hash) return blocked('System brief snapshot mismatch');
  if (original.variant !== fresh.variant) return blocked('Target variant mismatch');
  if (['cancelled', 'inconclusive'].includes(original.status) || ['cancelled', 'inconclusive'].includes(fresh.status)) return blocked('Cannot verify incomplete or cancelled runs');
  const reasons: string[] = [];
  if (original.sourceHash !== fresh.sourceHash) reasons.push('Target source code hash changed');
  if (original.contractHash !== fresh.contractHash) reasons.push('System contract definition has changed');
  for (const record of [original, fresh]) {
    const unavailable = currentIdentityError(record);
    if (unavailable) return blocked(unavailable);
    const error = semanticRecordError(record);
    if (error) reasons.push(error);
  }
  for (const journey of original.journeys) {
    const other = fresh.journeys.find(j => j.id === journey.id)!;
    if (!same(projection(journey), projection(other))) {
      reasons.push(`Journey "${journey.id}" protocol/business evidence differs`);
      base.differences.push({ journeyId: journey.id, description: 'Validated protocol/business projection differs', expected: digest(projection(journey)), observed: digest(projection(other)) });
    }
  }
  if (reasons.length) return result('different', [...new Set(reasons)], 'Semantic rerun comparison detected differences; no invariant match is claimed.');
  return result('match', [], original.status === 'fail'
    ? 'Semantic rerun comparison identically reproduced the expected failure across runs. Ephemeral loopback ports, request elapsed times, polling and generated UUID bindings are normalized.'
    : 'Semantic rerun comparison verified all business and protocol invariants. Ephemeral loopback ports, request elapsed times, polling and generated UUID bindings are normalized.');
}
