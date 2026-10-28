import type { DeliveryObservation, TraceEntry } from '../domain.ts';
import type { Envelope, ProcessResult, TargetSnapshot } from './types.ts';
import { decodePayload } from './variants/clean/decoder.ts';

/** Decode independently of the target's acceptance, including faulty decoders. */
export function observeDelivery(
  envelope: Envelope, result: ProcessResult, snapshot: TargetSnapshot,
  trace: TraceEntry[], step: number, action: DeliveryObservation['action'], exception: boolean,
): DeliveryObservation {
  const payload = decodePayload(envelope.to, envelope.payload);
  return {
    traceIndex: trace.length, step, action, messageId: envelope.id, channel: envelope.to,
    messageType: payload?.type ?? null, payloadValid: payload !== null,
    status: exception ? 'exception' : result.accepted ? 'accepted' : 'rejected',
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    usedCredit: snapshot.usedCredit, reservedCredit: snapshot.reservedCredit,
    ...(snapshot.credit ? { creditLimit: snapshot.credit.limit } : {}),
  };
}
