import type { Channel } from '../domain.ts';
import type { ExecutionReportPayload } from '../simulator/types.ts';
import { TargetEngine, decodePayload } from './business.ts';
import type { RecoveryApplication, RecoveryProcessResult, RecoverySnapshot, RecoveryTarget } from './types.ts';

export class ReportInbox implements RecoveryTarget {
  private readonly business = new TargetEngine();
  private connected = true;
  private retryTick: number | undefined;
  private readonly accepted = new Map<string, ExecutionReportPayload>();
  protected readonly backlog = new Map<string, ExecutionReportPayload>();
  private readonly applications = new Map<string, RecoveryApplication>();

  protected onReconnect(): void {}

  public setConnected(connected: boolean, tick: number): void {
    if (connected === this.connected) return;
    this.connected = connected;
    if (connected) {
      this.onReconnect();
      this.retryTick = this.backlog.size ? tick + 1 : undefined;
    } else {
      this.retryTick = undefined;
    }
  }

  public processMessage(channel: Channel, raw: unknown, tick: number): RecoveryProcessResult {
    const payload = decodePayload(channel, raw);
    if (!payload || payload.type === 'cancel_order' || payload.type === 'cancel_ack') {
      return { accepted: false, reason: 'Invalid payload or unsupported cancellation' };
    }
    if (payload.type !== 'execution') return this.business.processMessage(channel, payload);
    if (payload.occurredAt > tick) return { accepted: false, reason: 'Execution occurrence is in the future' };
    const key = JSON.stringify([payload.orderId, payload.executionId]);
    const existing = this.accepted.get(key);
    if (existing) {
      if (existing.quantity !== payload.quantity || existing.price !== payload.price || existing.occurredAt !== payload.occurredAt) {
        return { accepted: false, reason: 'Conflicting execution content' };
      }
      return { accepted: true, duplicate: true, report: { ...existing } };
    }
    const order = this.business.getSnapshot().orders[payload.orderId];
    const pending = [...this.backlog.values()].filter(r => r.orderId === payload.orderId).reduce((sum, r) => sum + r.quantity, 0);
    // Include every accepted identity, including work awaiting reconciliation.
    const committed = [...this.accepted.values()].filter(r => r.orderId === payload.orderId).reduce((sum, r) => sum + r.quantity, 0);
    if (!order || payload.price !== order.price || committed + payload.quantity > order.initialQuantity || payload.quantity + pending > order.remainingQuantity) {
      return { accepted: false, reason: 'Execution is inconsistent with order quantity or locked price' };
    }
    this.accepted.set(key, { ...payload });
    if (this.connected) this.apply(key, payload, tick);
    else this.backlog.set(key, { ...payload });
    return { accepted: true, duplicate: false, report: { ...payload } };
  }

  private apply(key: string, report: ExecutionReportPayload, tick: number): void {
    const result = this.business.processMessage('reports', report);
    if (!result.accepted) throw new Error(`Reconciliation rejected: ${result.reason}`);
    this.applications.set(key, { key, report: { ...report }, tick });
    this.backlog.delete(key);
  }

  public nextDueTick(): number | undefined { return this.retryTick; }
  public runDue(tick: number): void {
    if (!this.connected || this.retryTick === undefined || tick < this.retryTick) return;
    for (const [key, report] of this.backlog) this.apply(key, report, tick);
    this.retryTick = undefined;
  }
  public getSnapshot(): RecoverySnapshot {
    return { ...this.business.getSnapshot(), connected: this.connected, applications: structuredClone([...this.applications.values()]) };
  }
}
