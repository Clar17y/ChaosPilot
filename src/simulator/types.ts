export type { Channel } from '../domain.ts';
import type { Channel } from '../domain.ts';

export interface MarketQuotePayload {
  type: 'quote';
  id: string;
  version: number;
  price: number;
}

export interface CreditLimitPayload {
  type: 'credit_limit';
  id: string;
  version: number;
  limit: number;
}

export interface NewOrderPayload {
  type: 'new_order';
  id: string;
  orderId: string;
  quantity: number;
  quoteId: string;
}

export interface CancelOrderPayload {
  type: 'cancel_order';
  id: string;
  orderId: string;
}

export interface ExecutionReportPayload {
  type: 'execution';
  id: string;
  orderId: string;
  executionId: string;
  quantity: number;
  price: number;
  occurredAt: number;
}

export interface CancelAckPayload {
  type: 'cancel_ack';
  id: string;
  orderId: string;
  cancelledQuantity: number;
  occurredAt: number;
}

export type ValidPayload =
  | MarketQuotePayload
  | CreditLimitPayload
  | NewOrderPayload
  | CancelOrderPayload
  | ExecutionReportPayload
  | CancelAckPayload;

export interface OrderRecord {
  orderId: string;
  quoteId: string;
  price: number;
  initialQuantity: number;
  remainingQuantity: number;
  filledQuantity: number;
  cancelledQuantity: number;
  cancellationRequested: boolean;
  status: 'OPEN' | 'FILLED' | 'CANCELLED';
  cancelledAt?: number;
}

export interface TargetSnapshot {
  quote: { id: string; version: number; price: number } | null;
  credit: { version: number; limit: number } | null;
  reservedCredit: number;
  usedCredit: number;
  orders: Record<string, OrderRecord>;
}

export interface ProcessResult {
  accepted: boolean;
  reason?: string;
  orderCreated?: { orderId: string; quantity: number; price: number };
}

export interface TargetEngineInterface {
  processMessage(channel: Channel, payload: unknown): ProcessResult;
  getSnapshot(): TargetSnapshot;
}

export interface Envelope {
  id: string;
  to: Channel;
  payload: unknown;
  scheduledAt: number;
  dueTime: number;
  sequence: number;
  delivered: boolean;
}

export interface VenueOrder {
  orderId: string;
  initialQuantity: number;
  remainingQuantity: number;
  filledQuantity: number;
  cancelledQuantity: number;
  price: number;
}

export interface VenueExecutionFact {
  executionId: string;
  orderId: string;
  quantity: number;
  price: number;
  occurredAt: number;
}

export interface VenueCancelFact {
  orderId: string;
  cancelledQuantity: number;
  occurredAt: number;
}
