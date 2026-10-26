import type { Channel, ValidPayload } from '../../types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getSafeString(obj: Record<string, unknown>, key: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return null;
  const val = obj[key];
  return typeof val === 'string' && val.length > 0 ? val : null;
}

function getSafePositiveInteger(obj: Record<string, unknown>, key: string): number | null {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return null;
  const val = obj[key];
  return typeof val === 'number' && Number.isSafeInteger(val) && val > 0 ? val : null;
}

function getSafeNonNegativeInteger(obj: Record<string, unknown>, key: string): number | null {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return null;
  const val = obj[key];
  return typeof val === 'number' && Number.isSafeInteger(val) && val >= 0 ? val : null;
}

export function decodePayload(channel: Channel, payload: unknown): ValidPayload | null {
  if (!isRecord(payload)) return null;

  const type = getSafeString(payload, 'type');
  if (!type) return null;

  switch (channel) {
    case 'market': {
      if (type !== 'quote') return null;
      const id = getSafeString(payload, 'id');
      const version = getSafePositiveInteger(payload, 'version');
      const price = getSafePositiveInteger(payload, 'price');
      if (!id || version === null || price === null || price > 10_000_000) return null;
      return { type: 'quote', id, version, price };
    }

    case 'credit': {
      if (type !== 'credit_limit') return null;
      const id = getSafeString(payload, 'id');
      const version = getSafePositiveInteger(payload, 'version');
      const limit = getSafeNonNegativeInteger(payload, 'limit');
      if (!id || version === null || limit === null || limit > 1_000_000_000) return null;
      return { type: 'credit_limit', id, version, limit };
    }

    case 'client': {
      if (type === 'new_order') {
        const id = getSafeString(payload, 'id');
        const orderId = getSafeString(payload, 'orderId');
        const quantity = getSafePositiveInteger(payload, 'quantity');
        const quoteId = getSafeString(payload, 'quoteId');
        if (!id || !orderId || quantity === null || quantity > 1_000_000 || !quoteId) return null;
        return { type: 'new_order', id, orderId, quantity, quoteId };
      }
      if (type === 'cancel_order') {
        const id = getSafeString(payload, 'id');
        const orderId = getSafeString(payload, 'orderId');
        if (!id || !orderId) return null;
        return { type: 'cancel_order', id, orderId };
      }
      return null;
    }

    case 'reports': {
      if (type === 'execution') {
        const id = getSafeString(payload, 'id');
        const orderId = getSafeString(payload, 'orderId');
        const executionId = getSafeString(payload, 'executionId');
        const quantity = getSafePositiveInteger(payload, 'quantity');
        const price = getSafePositiveInteger(payload, 'price');
        const occurredAt = getSafeNonNegativeInteger(payload, 'occurredAt');
        if (!id || !orderId || !executionId || quantity === null || quantity > 1_000_000 || price === null || price > 10_000_000 || occurredAt === null) {
          return null;
        }
        return { type: 'execution', id, orderId, executionId, quantity, price, occurredAt };
      }
      if (type === 'cancel_ack') {
        const id = getSafeString(payload, 'id');
        const orderId = getSafeString(payload, 'orderId');
        const cancelledQuantity = getSafeNonNegativeInteger(payload, 'cancelledQuantity');
        const occurredAt = getSafeNonNegativeInteger(payload, 'occurredAt');
        if (!id || !orderId || cancelledQuantity === null || cancelledQuantity > 1_000_000 || occurredAt === null) {
          return null;
        }
        return { type: 'cancel_ack', id, orderId, cancelledQuantity, occurredAt };
      }
      return null;
    }

    default:
      return null;
  }
}
