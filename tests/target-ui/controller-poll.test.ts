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

  it('displays REJECTED and reason on matching asynchronous credit rejection without adopting old order', async () => {
    let orderRequestId = '';
    const queue: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        orderRequestId = body.requestId;
        return { status: 202, ok: true, json: async () => ({ instanceId: INSTANCE, receiptId: 'rec-2', requestId: body.requestId, sequence: 2, status: 'queued' }) };
      }
      return { status: 200, ok: true, json: async () => queue.shift() };
    }));
    const controller = new TargetUiController({ endpoint: 'http://127.0.0.1:9' });
    await controller.submitOrder('order-1', 10);
    expect(controller.getState().activeOrder).toMatchObject({
      orderId: 'order-1', transportStatus: 'queued', transportReceiptId: 'rec-2', businessStatus: 'IDLE', quantity: 10, remainingQuantity: 10,
    });

    // Rejection event arrives
    const rejObs = {
      instanceId: INSTANCE, processed: 2, queued: 0,
      events: [
        { instanceId: INSTANCE, eventId: `${INSTANCE}:1`, receiptId: 'rec-1', requestId: 'setup-1', sequence: 1, status: 'accepted', command: { kind: 'setup', requestId: 'setup-1', limit: 5 }, messageId: 'm-1', deliveryStep: 0, result: null },
        { instanceId: INSTANCE, eventId: `${INSTANCE}:2`, receiptId: 'rec-2', requestId: orderRequestId, sequence: 2, status: 'rejected', reason: 'Insufficient credit limit', command: { kind: 'order', orderId: 'order-1', quantity: 10, requestId: orderRequestId }, messageId: 'm-2', deliveryStep: 1, result: null },
      ],
      state: { quote: null, credit: { version: 1, limit: 5 }, reservedCredit: 0, usedCredit: 0, orders: {} },
      orders: {},
    };
    queue.push(rejObs);
    await controller.poll();

    const state = controller.getState();
    expect(state.activeOrder).toMatchObject({
      orderId: 'order-1',
      transportStatus: 'acknowledged',
      transportReceiptId: 'rec-2',
      businessStatus: 'REJECTED',
      quantity: 10,
      filledQuantity: 0,
      remainingQuantity: 10,
    });
    controller.destroy();
  });

  it('never adopts previous OPEN/filled quantities when resubmitting existing orderId while pending or rejected', async () => {
    let activeReqId = '';
    let currentReceipt = 'rec-2';
    let currentSeq = 2;
    const queue: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        activeReqId = body.requestId;
        return { status: 202, ok: true, json: async () => ({ instanceId: INSTANCE, receiptId: currentReceipt, requestId: body.requestId, sequence: currentSeq, status: 'queued' }) };
      }
      return { status: 200, ok: true, json: async () => queue.shift() };
    }));
    const controller = new TargetUiController({ endpoint: 'http://127.0.0.1:9' });

    // 1. First order accepted (qty 5)
    await controller.submitOrder('order-1', 5);
    const obsAccepted = {
      instanceId: INSTANCE, processed: 2, queued: 0,
      events: [
        { instanceId: INSTANCE, eventId: `${INSTANCE}:1`, receiptId: 'rec-1', requestId: 'setup-1', sequence: 1, status: 'accepted', command: { kind: 'setup', requestId: 'setup-1', limit: 100 }, messageId: 'm-1', deliveryStep: 0, result: null },
        { instanceId: INSTANCE, eventId: `${INSTANCE}:2`, receiptId: 'rec-2', requestId: activeReqId, sequence: 2, status: 'accepted', command: { kind: 'order', orderId: 'order-1', quantity: 5, requestId: activeReqId }, messageId: 'm-2', deliveryStep: 1, result: null },
      ],
      state: { quote: null, credit: { version: 1, limit: 100 }, reservedCredit: 5, usedCredit: 0, orders: { 'order-1': { orderId: 'order-1', quoteId: 'q-1', status: 'OPEN', initialQuantity: 5, filledQuantity: 0, remainingQuantity: 5, cancelledQuantity: 0, businessStatus: 'OPEN' } } },
      orders: { 'order-1': { orderId: 'order-1', quoteId: 'q-1', status: 'OPEN', initialQuantity: 5, filledQuantity: 0, remainingQuantity: 5, cancelledQuantity: 0, businessStatus: 'OPEN' } },
    };
    queue.push(obsAccepted);
    await controller.poll();
    expect(controller.getState().activeOrder?.businessStatus).toBe('OPEN');
    expect(controller.getState().activeOrder?.quantity).toBe(5);

    // 2. Resubmit same order-1 with quantity 20
    currentReceipt = 'rec-3';
    currentSeq = 3;
    await controller.submitOrder('order-1', 20);
    expect(controller.getState().activeOrder).toMatchObject({
      orderId: 'order-1', transportStatus: 'queued', transportReceiptId: 'rec-3', businessStatus: 'IDLE', quantity: 20, remainingQuantity: 20,
    });

    // 3. Poll while seq 3 is still pending on target (only seq 2 exists in obs.events, old snapshot exists in obs.orders)
    queue.push(obsAccepted);
    await controller.poll();
    // Stays IDLE / queued, preserves new qty 20 instead of adopting old qty 5!
    expect(controller.getState().activeOrder).toMatchObject({
      orderId: 'order-1', transportStatus: 'queued', transportReceiptId: 'rec-3', businessStatus: 'IDLE', quantity: 20, remainingQuantity: 20,
    });

    // 4. Poll when seq 3 is rejected
    const obsRejected = {
      instanceId: INSTANCE, processed: 3, queued: 0,
      events: [
        ...obsAccepted.events,
        { instanceId: INSTANCE, eventId: `${INSTANCE}:3`, receiptId: 'rec-3', requestId: activeReqId, sequence: 3, status: 'rejected', reason: 'Order already exists: order-1', command: { kind: 'order', orderId: 'order-1', quantity: 20, requestId: activeReqId }, messageId: 'm-3', deliveryStep: 2, result: null },
      ],
      state: obsAccepted.state,
      orders: obsAccepted.orders,
    };
    queue.push(obsRejected);
    await controller.poll();

    // Must show REJECTED with new qty 20, NOT the old order's qty 5!
    expect(controller.getState().activeOrder).toMatchObject({
      orderId: 'order-1',
      transportStatus: 'acknowledged',
      transportReceiptId: 'rec-3',
      businessStatus: 'REJECTED',
      quantity: 20,
      filledQuantity: 0,
      remainingQuantity: 20,
    });
    controller.destroy();
  });

  it('displays ERROR and reason on matching error event', async () => {
    let activeReqId = '';
    const queue: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        activeReqId = body.requestId;
        return { status: 202, ok: true, json: async () => ({ instanceId: INSTANCE, receiptId: 'rec-2', requestId: body.requestId, sequence: 2, status: 'queued' }) };
      }
      return { status: 200, ok: true, json: async () => queue.shift() };
    }));
    const controller = new TargetUiController({ endpoint: 'http://127.0.0.1:9' });
    await controller.submitOrder('order-1', 15);

    const errObs = {
      instanceId: INSTANCE, processed: 2, queued: 0,
      events: [
        { instanceId: INSTANCE, eventId: `${INSTANCE}:1`, receiptId: 'rec-1', requestId: 'setup-1', sequence: 1, status: 'accepted', command: { kind: 'setup', requestId: 'setup-1', limit: 100 }, messageId: 'm-1', deliveryStep: 0, result: null },
        { instanceId: INSTANCE, eventId: `${INSTANCE}:2`, receiptId: 'rec-2', requestId: activeReqId, sequence: 2, status: 'error', reason: 'Venue simulator internal fault', command: { kind: 'order', orderId: 'order-1', quantity: 15, requestId: activeReqId }, messageId: 'm-2', deliveryStep: 1, result: null },
      ],
      state: { quote: null, credit: { version: 1, limit: 100 }, reservedCredit: 0, usedCredit: 0, orders: {} },
      orders: {},
    };
    queue.push(errObs);
    await controller.poll();

    expect(controller.getState().activeOrder).toMatchObject({
      orderId: 'order-1',
      transportStatus: 'acknowledged',
      transportReceiptId: 'rec-2',
      businessStatus: 'ERROR',
      quantity: 15,
      filledQuantity: 0,
      remainingQuantity: 15,
    });
    controller.destroy();
  });

  it('an unrelated event never acknowledges the active request', async () => {
    const queue: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        return { status: 202, ok: true, json: async () => ({ instanceId: INSTANCE, receiptId: 'rec-expected', requestId: body.requestId, sequence: 2, status: 'queued' }) };
      }
      return { status: 200, ok: true, json: async () => queue.shift() };
    }));
    const controller = new TargetUiController({ endpoint: 'http://127.0.0.1:9' });
    await controller.submitOrder('order-1', 10);

    // Event with different receiptId
    const wrongObs = {
      instanceId: INSTANCE, processed: 2, queued: 0,
      events: [
        { instanceId: INSTANCE, eventId: `${INSTANCE}:1`, receiptId: 'rec-1', requestId: 'setup-1', sequence: 1, status: 'accepted', command: { kind: 'setup', requestId: 'setup-1', limit: 100 }, messageId: 'm-1', deliveryStep: 0, result: null },
        { instanceId: INSTANCE, eventId: `${INSTANCE}:2`, receiptId: 'rec-wrong', requestId: 'req-wrong', sequence: 2, status: 'accepted', command: { kind: 'order', orderId: 'order-1', quantity: 10, requestId: 'req-wrong' }, messageId: 'm-2', deliveryStep: 1, result: null },
      ],
      state: { quote: null, credit: { version: 1, limit: 100 }, reservedCredit: 10, usedCredit: 0, orders: { 'order-1': { orderId: 'order-1', quoteId: 'q-1', status: 'OPEN', initialQuantity: 10, filledQuantity: 0, remainingQuantity: 10, cancelledQuantity: 0, businessStatus: 'OPEN' } } },
      orders: { 'order-1': { orderId: 'order-1', quoteId: 'q-1', status: 'OPEN', initialQuantity: 10, filledQuantity: 0, remainingQuantity: 10, cancelledQuantity: 0, businessStatus: 'OPEN' } },
    };
    queue.push(wrongObs);
    await controller.poll();

    // Did not acknowledge!
    expect(controller.getState().activeOrder).toMatchObject({
      orderId: 'order-1',
      transportStatus: 'queued',
      transportReceiptId: 'rec-expected',
      businessStatus: 'IDLE',
      quantity: 10,
    });
    controller.destroy();
  });

  async function submittedController(receiptSequence = 2) {
    const queue: any[] = [observation(1)];
    let requestId = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        requestId = JSON.parse(init.body as string).requestId;
        return { status: 202, ok: true, json: async () => ({ instanceId: INSTANCE, receiptId: 'rec-2', requestId, sequence: receiptSequence, status: 'queued' }) };
      }
      return { status: 200, ok: true, json: async () => queue.shift() };
    }));
    const controller = new TargetUiController({ endpoint: 'http://127.0.0.1:9' });
    await controller.submitOrder('order-1', 10);
    return { controller, queue, requestId };
  }

  function settlement(requestId: string, status = 'accepted') {
    const obs = observation(2);
    const event = obs.events[1];
    event.requestId = requestId;
    event.command.requestId = requestId;
    event.status = status;
    event.reason = status === 'rejected' ? 'Insufficient credit limit' : 'Venue fault';
    return obs;
  }

  it.each([
    { name: 'receipt', change: (obs: any) => { obs.events[1].receiptId = 'wrong-receipt'; } },
    { name: 'command kind', change: (obs: any) => { obs.events[1].command = { requestId: obs.events[1].requestId, kind: 'setup', limit: 100 }; } },
    { name: 'order ID', change: (obs: any) => { obs.events[1].command.orderId = 'another-order'; } },
    { name: 'quantity', change: (obs: any) => { obs.events[1].command.quantity = 20; } },
    { name: 'sequence', receiptSequence: 3, change: (_obs: any) => {} },
  ])('does not settle a request whose $name differs, even when the other identities match', async ({ change, receiptSequence }) => {
    const { controller, queue, requestId } = await submittedController(receiptSequence);
    try {
      const obs = settlement(requestId);
      change(obs);
      queue.push(obs);
      await controller.poll();
      expect(controller.getState().activeOrder).toMatchObject({
        transportStatus: 'queued', businessStatus: 'IDLE', quantity: 10, filledQuantity: 0,
      });
    } finally { controller.destroy(); }
  });

  function filledObservation(requestId: string) {
    const obs = settlement(requestId);
    obs.processed = 3;
    obs.events.push({
      instanceId: INSTANCE, eventId: `${INSTANCE}:3`, receiptId: 'rec-3', requestId: 'fill-1', sequence: 3,
      status: 'accepted', command: { requestId: 'fill-1', kind: 'execution', orderId: 'order-1', executionId: 'fill-1', quantity: 10 },
      messageId: 'm-3', deliveryStep: 2, result: null,
    });
    Object.assign(obs.orders['order-1'], { businessStatus: 'FILLED', status: 'FILLED', filledQuantity: 10, remainingQuantity: 0 });
    obs.state.orders = structuredClone(obs.orders);
    return obs;
  }

  it('updates an accepted request through a later fill while preserving its receipt', async () => {
    const { controller, queue, requestId } = await submittedController();
    try {
      queue.push(settlement(requestId));
      await controller.poll();
      expect(controller.getState().activeOrder?.businessStatus).toBe('OPEN');
      queue.push(filledObservation(requestId));
      await controller.poll();
      expect(controller.getState().activeOrder).toMatchObject({
        businessStatus: 'FILLED', transportReceiptId: 'rec-2', quantity: 10, filledQuantity: 10, remainingQuantity: 0,
      });
    } finally { controller.destroy(); }
  });

  it('does not bypass receipt correlation on an already accepted order', async () => {
    const { controller, queue, requestId } = await submittedController();
    try {
      queue.push(settlement(requestId));
      await controller.poll();
      const changedHistory = filledObservation(requestId);
      changedHistory.events[1].receiptId = 'wrong-receipt';
      queue.push(changedHistory);
      await controller.poll();
      expect(controller.getState().activeOrder).toMatchObject({ businessStatus: 'OPEN', filledQuantity: 0, remainingQuantity: 10 });
    } finally { controller.destroy(); }
  });

  it.each(['rejected', 'error'])('holds a settled %s event until resume and then shows its reason', async status => {
    const { controller, queue, requestId } = await submittedController();
    const feedback = { textContent: '' };
    vi.stubGlobal('document', { getElementById: (id: string) => id === 'feedback-order' ? feedback : null });
    try {
      controller.toggleHold();
      const obs = settlement(requestId, status);
      obs.orders = {};
      obs.state.orders = {};
      queue.push(obs);
      await controller.poll();
      expect(controller.getState().activeOrder?.businessStatus).toBe('IDLE');
      expect(controller.getState().freshness.reason).toBe('held');
      queue.push(obs);
      controller.toggleHold();
      await vi.waitFor(() => expect(controller.getState().activeOrder?.businessStatus).toBe(status.toUpperCase()));
      expect(feedback.textContent).toContain(obs.events[1].reason);
    } finally { controller.destroy(); }
  });
});
