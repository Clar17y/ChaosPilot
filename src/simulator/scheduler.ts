import type { Channel } from '../domain.ts';
import type { Envelope } from './types.ts';
import { MAX_TICKS } from './contract.ts';

function structuredClonePayload<T>(val: T): T {
  if (val === undefined || val === null || typeof val !== 'object') {
    return val;
  }
  try {
    return structuredClone(val);
  } catch {
    return JSON.parse(JSON.stringify(val)) as T;
  }
}

export class Scheduler {
  private logicalTime = 0;
  private sequenceCounter = 0;
  private readonly envelopes = new Map<string, Envelope>();

  public getTime(): number {
    return this.logicalTime;
  }

  public advance(ticks: number): void {
    if (!Number.isSafeInteger(ticks) || ticks < 0) throw new RangeError('Invalid logical clock ticks');
    this.setTime(this.logicalTime + ticks);
  }

  public setTime(time: number): void {
    if (!Number.isSafeInteger(time) || time < this.logicalTime || time > MAX_TICKS) {
      throw new RangeError(`Logical time must be monotonic and at most ${MAX_TICKS} ticks`);
    }
    this.logicalTime = time;
  }

  public schedule(
    id: string,
    to: Channel,
    payload: unknown,
    delay?: number,
  ): { success: boolean; reason?: string; envelope?: Envelope } {
    if (this.envelopes.has(id)) {
      return { success: false, reason: `Envelope ID '${id}' already exists` };
    }

    const dueDelay = delay ?? 0;
    if (!Number.isSafeInteger(dueDelay) || dueDelay < 0 || this.logicalTime + dueDelay > MAX_TICKS) {
      return { success: false, reason: `Scheduled time exceeds logical clock bounds (max ${MAX_TICKS} ticks)` };
    }
    const envelope: Envelope = {
      id,
      to,
      payload: structuredClonePayload(payload),
      scheduledAt: this.logicalTime,
      dueTime: this.logicalTime + dueDelay,
      sequence: ++this.sequenceCounter,
      delivered: false,
    };

    this.envelopes.set(id, envelope);
    return { success: true, envelope };
  }

  public duplicate(
    messageId: string,
    newId: string,
    delay?: number,
  ): { success: boolean; reason?: string; envelope?: Envelope } {
    const original = this.envelopes.get(messageId);
    if (!original) {
      return { success: false, reason: `Unknown messageId to duplicate: ${messageId}` };
    }

    if (this.envelopes.has(newId)) {
      return { success: false, reason: `Envelope ID '${newId}' already exists` };
    }

    const dueDelay = delay ?? 0;
    if (!Number.isSafeInteger(dueDelay) || dueDelay < 0 || this.logicalTime + dueDelay > MAX_TICKS) {
      return { success: false, reason: `Scheduled time exceeds logical clock bounds (max ${MAX_TICKS} ticks)` };
    }
    const envelope: Envelope = {
      id: newId,
      to: original.to,
      payload: structuredClonePayload(original.payload),
      scheduledAt: this.logicalTime,
      dueTime: this.logicalTime + dueDelay,
      sequence: ++this.sequenceCounter,
      delivered: false,
    };

    this.envelopes.set(newId, envelope);
    return { success: true, envelope };
  }

  public getEnvelope(id: string): Envelope | undefined {
    return this.envelopes.get(id);
  }

  public markDelivered(id: string): void {
    const envelope = this.envelopes.get(id);
    if (envelope) {
      envelope.delivered = true;
    }
  }

  public getUndeliveredDueEnvelopes(): Envelope[] {
    const due: Envelope[] = [];
    for (const env of this.envelopes.values()) {
      if (!env.delivered && env.dueTime <= this.logicalTime) {
        due.push(env);
      }
    }
    due.sort((a, b) => {
      if (a.dueTime !== b.dueTime) return a.dueTime - b.dueTime;
      return a.sequence - b.sequence;
    });
    return due;
  }

  public getNextUndeliveredEnvelope(): Envelope | undefined {
    let next: Envelope | undefined = undefined;
    for (const env of this.envelopes.values()) {
      if (!env.delivered) {
        if (!next) {
          next = env;
        } else if (env.dueTime < next.dueTime) {
          next = env;
        } else if (env.dueTime === next.dueTime && env.sequence < next.sequence) {
          next = env;
        }
      }
    }
    return next;
  }
}
