import type {
  VenueCancelFact,
  VenueExecutionFact,
  VenueOrder,
} from './types.ts';

export class Venue {
  private readonly orders = new Map<string, VenueOrder>();
  private readonly executions: VenueExecutionFact[] = [];
  private readonly cancels: VenueCancelFact[] = [];

  public registerOrder(orderId: string, quantity: number, price: number): void {
    if (this.orders.has(orderId)) {
      return;
    }
    this.orders.set(orderId, {
      orderId,
      initialQuantity: quantity,
      remainingQuantity: quantity,
      filledQuantity: 0,
      cancelledQuantity: 0,
      price,
    });
  }

  public getOrder(orderId: string): VenueOrder | undefined {
    return this.orders.get(orderId);
  }

  public hasOrder(orderId: string): boolean {
    return this.orders.has(orderId);
  }

  public recordFill(
    orderId: string,
    executionId: string,
    quantity: number,
    occurredAt: number,
  ): { success: boolean; reason?: string; fact?: VenueExecutionFact; price?: number } {
    const order = this.orders.get(orderId);
    if (!order) {
      return { success: false, reason: `Order '${orderId}' not found at venue` };
    }

    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      return { success: false, reason: `Invalid fill quantity: ${quantity}` };
    }

    const existing = this.executions.find((fact) => fact.orderId === orderId && fact.executionId === executionId);
    if (existing) {
      if (existing.quantity !== quantity) {
        return { success: false, reason: 'Conflicting venue execution identity' };
      }
      return { success: true, fact: existing, price: existing.price };
    }
    if (this.cancels.some((fact) => fact.orderId === orderId)) {
      return { success: false, reason: 'Cannot execute after confirmed venue cancellation' };
    }

    if (quantity > order.remainingQuantity) {
      return {
        success: false,
        reason: `Fill quantity ${quantity} exceeds venue remaining ${order.remainingQuantity}`,
      };
    }

    order.remainingQuantity -= quantity;
    order.filledQuantity += quantity;

    const fact: VenueExecutionFact = {
      executionId,
      orderId,
      quantity,
      price: order.price,
      occurredAt,
    };
    this.executions.push(fact);

    return { success: true, fact, price: order.price };
  }

  public recordCancel(
    orderId: string,
    occurredAt: number,
  ): { success: boolean; reason?: string; fact?: VenueCancelFact } {
    const order = this.orders.get(orderId);
    if (!order) {
      return { success: false, reason: `Order '${orderId}' not found at venue` };
    }

    const existing = this.cancels.find((fact) => fact.orderId === orderId);
    if (existing) return { success: true, fact: existing };

    const cancelledQuantity = order.remainingQuantity;
    order.cancelledQuantity += cancelledQuantity;
    order.remainingQuantity = 0;

    const fact: VenueCancelFact = {
      orderId,
      cancelledQuantity,
      occurredAt,
    };
    this.cancels.push(fact);

    return { success: true, fact };
  }

  public getExecutions(): readonly VenueExecutionFact[] {
    return this.executions;
  }

  public getCancels(): readonly VenueCancelFact[] {
    return this.cancels;
  }

  public getSnapshot(): Record<string, unknown> {
    const ordersRecord: Record<string, VenueOrder> = Object.create(null);
    for (const [orderId, order] of this.orders.entries()) {
      ordersRecord[orderId] = { ...order };
    }
    return {
      orders: ordersRecord,
      executions: [...this.executions],
      cancels: [...this.cancels],
    };
  }
}
