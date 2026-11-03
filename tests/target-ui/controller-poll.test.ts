import { describe, it, expect, vi, afterEach } from 'vitest';
import { TargetUiController } from '../../src/web/target-ui.ts';

const INSTANCE = 'inst-1';
function observation(processed: number, over: Record<string, any> = {}): any {
  const commands = [
    { requestId: 'setup-1', kind: 'setup', limit: 100 },
    { requestId: 'ord-req-1', kind: 'order', orderId: 'order-1', quantity: 10 },
  ];
  const filled = processed >= 3 ? 10 : 0;
  const order = processed >= 2 ? {
    'order-1': {
      orderId: 'order-1', quoteId: 'quote-1', status: filled ? 'FILLED' : 'OPEN',
      initialQuantity: 10, filledQuantity: filled, remainingQuantity: 10 - filled, cancelledQuantity: 0,
      businessStatus: filled ? 'FILLED' : 'OPEN',
    },
  } : {};
  return {
    instanceId: INSTANCE, processed, queued: 0,
    events: commands.slice(0, Math.min(processed, 2)).map((command, i) => ({
      instanceId: INSTANCE, eventId: `${INSTANCE}:${i + 1}`, receiptId: `rec-${i + 1}`,
      requestId: command.requestId, sequence: i + 1, status: 'accepted', command,
      messageId: `http-${i + 1}`, deliveryStep: i, result: null,
    })),
    state: { quote: null, credit: { version: 1, limit: 100 }, reservedCredit: 0, usedCredit: 0, orders: structuredClone(order) },
    orders: order,
    ...over,
  };
}

describe('TargetUiController poll validation (DOM-less production path)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function controllerWith(responses: any[]) {
    const queue = [...responses];
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200, ok: true, json: async () => queue.shift(),
    })));
    return new TargetUiController({ endpoint: 'http://127.0.0.1:9' });
  }

  it('applies a valid observation and records correlated exchange evidence', async () => {
    const controller = controllerWith([observation(2)]);
    await controller.poll();
    const state = controller.getState();
    expect(state.instanceId).toBe(INSTANCE);
    expect(state.activeOrder?.businessStatus).toBe('OPEN');
    expect(state.eventsCount).toBe(2);
    expect(state.freshness.lastAppliedSequence).toBe(2);
    expect(controller.getEvidence().status).toBe('inconclusive');
    expect(controller.getEvidence().reasons[0]).toMatch(/Manual interactive capture/);
    controller.destroy();
  });

  it('rejects foreign, malformed and out-of-order observations without mutating display or events', async () => {
    const foreign = observation(2, { instanceId: 'foreign' });
    const malformed = observation(2, { processed: 'two' });
    const older = observation(1);
    const controller = controllerWith([observation(2), foreign, malformed, older]);
    await controller.poll();
    const before = controller.getState();
    await controller.poll(); // foreign
    await controller.poll(); // malformed
    await controller.poll(); // out-of-order
    const after = controller.getState();
    expect(after.activeOrder).toEqual(before.activeOrder);
    expect(after.eventsCount).toBe(before.eventsCount);
    expect(after.freshness.lastAppliedSequence).toBe(2);
    expect(after.freshness.status).toBe('fresh');
    controller.destroy();
  });

  it('records a failed request as an exchange diagnostic and keeps prior state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection reset'); }));
    const controller = new TargetUiController({ endpoint: 'http://127.0.0.1:9' });
    await controller.poll();
    const evidence = controller.getEvidence();
    expect(evidence.exchanges).toHaveLength(1);
    expect(evidence.exchanges[0]).toMatchObject({ responseStatus: 0, error: expect.stringContaining('connection reset') });
    expect(controller.getState().activeOrder).toBeNull();
    controller.destroy();
  });

  it('does not overlap polls', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      await gate;
      return { status: 200, ok: true, json: async () => observation(1) };
    }));
    const controller = new TargetUiController({ endpoint: 'http://127.0.0.1:9' });
    const first = controller.poll();
    const second = controller.poll();
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    controller.destroy();
  });
});
