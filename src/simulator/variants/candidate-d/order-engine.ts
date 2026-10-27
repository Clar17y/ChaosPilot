import type { Channel } from '../../../domain.ts';
import type {
  OrderRecord,
  ProcessResult,
  TargetEngineInterface,
  TargetSnapshot,
} from '../../types.ts';
import { CreditManager } from './credit-manager.ts';
import { decodePayload } from './decoder.ts';

interface ExecutionRecord {
  quantity: number;
  price: number;
  occurredAt: number;
}

interface ConfirmedCancelRecord {
  cancelledQuantity: number;
  occurredAt: number;
}

export class TargetEngine implements TargetEngineInterface {
  private activeQuote: { id: string; version: number; price: number } | null = null;
  private readonly creditManager = new CreditManager();
  private readonly orders = new Map<string, OrderRecord>();
  private readonly processedExecutions = new Map<string, ExecutionRecord>();
  private readonly latestExecutionAt = new Map<string, number>();
  private readonly confirmedCancels = new Map<string, ConfirmedCancelRecord>();

  public processMessage(channel: Channel, rawPayload: unknown): ProcessResult {
    const payload = decodePayload(channel, rawPayload);
    if (!payload) {
      return { accepted: false, reason: 'Malformed or invalid message payload' };
    }

    switch (payload.type) {
      case 'quote': {
        this.activeQuote = {
          id: payload.id,
          version: payload.version,
          price: payload.price,
        };
        return { accepted: true };
      }

      case 'credit_limit': {
        const updated = this.creditManager.updateLimit(payload.version, payload.limit);
        if (!updated) {
          return { accepted: false, reason: 'Stale credit version' };
        }
        return { accepted: true };
      }

      case 'new_order': {
        if (this.orders.has(payload.orderId)) {
          return { accepted: false, reason: 'Duplicate order identifier' };
        }
        if (!this.activeQuote || this.activeQuote.id !== payload.quoteId) {
          return { accepted: false, reason: 'Quote not found or inactive' };
        }

        const price = this.activeQuote.price;
        const notional = payload.quantity * price;

        if (!this.creditManager.canReserve(notional)) {
          return { accepted: false, reason: 'Insufficient credit limit' };
        }

        this.creditManager.reserve(notional);
        const order: OrderRecord = {
          orderId: payload.orderId,
          quoteId: payload.quoteId,
          price,
          initialQuantity: payload.quantity,
          remainingQuantity: payload.quantity,
          filledQuantity: 0,
          cancelledQuantity: 0,
          cancellationRequested: false,
          status: 'OPEN',
        };
        this.orders.set(payload.orderId, order);

        return {
          accepted: true,
          orderCreated: {
            orderId: order.orderId,
            quantity: order.initialQuantity,
            price: order.price,
          },
        };
      }

      case 'cancel_order': {
        const order = this.orders.get(payload.orderId);
        if (!order) {
          return { accepted: false, reason: 'Order not found for cancellation' };
        }
        order.cancellationRequested = true;
        return { accepted: true };
      }

      case 'execution': {
        const order = this.orders.get(payload.orderId);
        if (!order) {
          return { accepted: false, reason: 'Execution for unknown order' };
        }

        const executionKey = JSON.stringify([payload.orderId, payload.executionId]);
        const existing = this.processedExecutions.get(executionKey);
        if (existing) {
          if (existing.quantity === payload.quantity &&
            existing.price === payload.price &&
            existing.occurredAt === payload.occurredAt) {
            return { accepted: true };
          }
          return { accepted: false, reason: 'Conflicting execution content for existing executionId' };
        }

        if (payload.price !== order.price) {
          return { accepted: false, reason: 'Execution price does not match order locked price' };
        }

        if (payload.quantity > order.remainingQuantity) {
          return { accepted: false, reason: 'Execution quantity exceeds remaining quantity' };
        }

        if (order.cancelledAt !== undefined && payload.occurredAt > order.cancelledAt) {
          return { accepted: false, reason: 'Execution occurred after order cancellation' };
        }

        this.processedExecutions.set(executionKey, {
          quantity: payload.quantity,
          price: payload.price,
          occurredAt: payload.occurredAt,
        });

        this.latestExecutionAt.set(
          payload.orderId,
          Math.max(this.latestExecutionAt.get(payload.orderId) ?? 0, payload.occurredAt),
        );

        const fillQty = payload.quantity;
        order.filledQuantity += fillQty;
        order.remainingQuantity -= fillQty;
        order.status = order.filledQuantity === order.initialQuantity
          ? 'FILLED'
          : order.cancelledQuantity > 0 ? 'CANCELLED' : 'OPEN';

        const notional = fillQty * order.price;
        this.creditManager.convertReserveToUsed(notional);

        return { accepted: true };
      }

      case 'cancel_ack': {
        const order = this.orders.get(payload.orderId);
        if (!order) {
          return { accepted: false, reason: 'Cancel acknowledgement for unknown order' };
        }

        const existingCancel = this.confirmedCancels.get(payload.orderId);
        if (existingCancel) {
          if (
            existingCancel.cancelledQuantity === payload.cancelledQuantity &&
            existingCancel.occurredAt === payload.occurredAt
          ) {
            return { accepted: true };
          }
          return { accepted: false, reason: 'Conflicting cancel acknowledgement for order' };
        }

        if (payload.cancelledQuantity > order.remainingQuantity) {
          return { accepted: false, reason: 'Cancelled quantity exceeds remaining quantity' };
        }

        const latestExecutionAt = this.latestExecutionAt.get(payload.orderId);
        if (latestExecutionAt !== undefined && payload.occurredAt < latestExecutionAt) {
          return { accepted: false, reason: 'Cancellation predates an accepted execution' };
        }

        this.confirmedCancels.set(payload.orderId, {
          cancelledQuantity: payload.cancelledQuantity,
          occurredAt: payload.occurredAt,
        });

        const releaseQty = payload.cancelledQuantity;
        const releaseNotional = releaseQty * order.price;
        order.cancelledQuantity += releaseQty;
        order.remainingQuantity -= releaseQty;
        order.cancelledAt = payload.occurredAt;
        order.status = order.filledQuantity === order.initialQuantity
          ? 'FILLED'
          : order.cancelledQuantity > 0 ? 'CANCELLED' : 'OPEN';
        this.creditManager.releaseReserve(releaseNotional);

        return { accepted: true };
      }

      default:
        return { accepted: false, reason: 'Unhandled message type' };
    }
  }

  public getSnapshot(): TargetSnapshot {
    const ordersRecord: Record<string, OrderRecord> = Object.create(null);
    for (const [orderId, order] of this.orders.entries()) {
      ordersRecord[orderId] = { ...order };
    }

    const creditLimit = this.creditManager.getLimit();
    const creditVersion = this.creditManager.getVersion();

    return {
      quote: this.activeQuote ? { ...this.activeQuote } : null,
      credit:
        creditLimit !== null && creditVersion !== null
          ? { version: creditVersion, limit: creditLimit }
          : null,
      reservedCredit: this.creditManager.getReserved(),
      usedCredit: this.creditManager.getUsed(),
      orders: ordersRecord,
    };
  }
}
