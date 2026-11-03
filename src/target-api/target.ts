import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import type { Action, Experiment, TargetVariant } from '../domain.ts';
import { assertAdapterVariant } from '../adapters/index.ts';
import { executeExperiment } from '../simulator/index.ts';
import type { TargetSnapshot } from '../simulator/types.ts';
import type { BusinessEvent, Command, Observation, OrderView, Receipt } from './types.ts';
import type { TargetUiProvenance, TargetUiThresholds } from '../target-ui/types.ts';

const id = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(v);
const number = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 1000;
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const staticUiFiles: Record<string, { relative: string; fallback?: string; contentType: string }> = {
  '/': { relative: 'public/target-ui.html', contentType: 'text/html; charset=utf-8' },
  '/index.html': { relative: 'public/target-ui.html', contentType: 'text/html; charset=utf-8' },
  '/target-ui.html': { relative: 'public/target-ui.html', contentType: 'text/html; charset=utf-8' },
  '/target-ui.css': { relative: 'public/target-ui.css', contentType: 'text/css; charset=utf-8' },
  '/target-ui.js': { relative: 'dist/web/target-ui.js', fallback: 'public/target-ui.js', contentType: 'application/javascript; charset=utf-8' },
  '/target-ui.js.map': { relative: 'dist/web/target-ui.js.map', contentType: 'application/json; charset=utf-8' },
  '/target-ui/freshness.js': { relative: 'dist/target-ui/freshness.js', contentType: 'application/javascript; charset=utf-8' },
  '/target-ui/validation.js': { relative: 'dist/target-ui/validation.js', contentType: 'application/javascript; charset=utf-8' },
  '/target-ui/freshness.js.map': { relative: 'dist/target-ui/freshness.js.map', contentType: 'application/json; charset=utf-8' },
};

export const commandPath = (command: Command): string => command.kind === 'setup' ? '/setup' : command.kind === 'order' ? '/orders' : '/executions';
export function parseCommand(path: string, raw: unknown): Command {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected command object');
  const c = raw as Record<string, unknown>;
  const kind = path === '/setup' ? 'setup' : path === '/orders' ? 'order' : path === '/executions' ? 'execution' : null;
  const keys = kind === 'setup' ? ['requestId', 'kind', 'limit'] : kind === 'order' ? ['requestId', 'kind', 'orderId', 'quantity'] : ['requestId', 'kind', 'orderId', 'executionId', 'quantity'];
  if (
    !kind ||
    c.kind !== kind ||
    Object.keys(c).length !== keys.length ||
    Object.keys(c).some((k) => !keys.includes(k)) ||
    !id(c.requestId) ||
    (kind === 'setup' ? !number(c.limit) : (!id(c.orderId) || !number(c.quantity))) ||
    (kind === 'execution' && !id(c.executionId))
  ) {
    throw new Error('Invalid bounded command');
  }
  return structuredClone(c) as unknown as Command;
}
export function orderViews(state: TargetSnapshot): Record<string, OrderView> {
  return Object.fromEntries(Object.entries(state.orders).map(([key, order]) => [key, { ...order,
    businessStatus: order.status === 'OPEN' && order.filledQuantity > 0 ? 'PARTIALLY_FILLED' : order.status }]));
}

export interface TargetOptions {
  variant: TargetVariant;
  uiContext?: { provenance?: TargetUiProvenance; thresholds?: TargetUiThresholds };
  /** Local validation seams; never exposed by CLI or control HTTP. */
  processingDelayMs?: number;
  execute?: typeof executeExperiment;
}
export interface TargetHandle {
  endpoint: string; instanceId: string;
  close(): Promise<void>;
  diagnostics(): { closed: boolean; queued: number; processed: number; timer: boolean; sockets: number };
}

/** An isolated real listener. Each queued command extends a bounded deterministic history.
 * Folding history avoids changing synchronous simulator/adapter business-source identities. */
export async function startTarget(options: TargetOptions): Promise<TargetHandle> {
  assertAdapterVariant('synthetic-trading', options.variant);
  const delay = options.processingDelayMs ?? 8;
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > 30_000) throw new Error('Invalid processing delay');
  const execute = options.execute ?? executeExperiment;
  const instanceId = randomUUID();
  const experiment: Experiment = { hypothesis: 'Scripted local target HTTP journey', expectedInvariant: 'Public trading contract and fixed accounting milestones', steps: [] };
  let result = execute(experiment, options.variant);
  let closed = false, setupQueued = false, accepted = 0;
  const queue: { command: Command; receipt: Receipt }[] = [];
  const events: BusinessEvent[] = [];
  const requests = new Set<string>();
  const sockets = new Set<Socket>();
  const executions = new Map<string, { messageId: string; quantity: number; payload: Record<string, unknown> }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  function observe(): Observation {
    const state = structuredClone(result.snapshot.target) as TargetSnapshot;
    return { instanceId, processed: events.length, queued: queue.length, events: structuredClone(events), state, orders: orderViews(state) };
  }
  function schedule(): void {
    if (closed || timer || !queue.length) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (closed) return;
      const item = queue.shift()!;
      const { command: c, receipt } = item;
      const messageId = `http-${receipt.sequence}`;
      let deliveryStep = experiment.steps.length;
      let event: BusinessEvent;
      try {
        const send = (to: 'market' | 'credit' | 'client' | 'reports', payload: unknown, message = messageId): Action[] =>
          [{ op: 'send', id: message, to, payload }, { op: 'deliver', messageId: message }];
        let actions: Action[];
        if (c.kind === 'setup') {
          actions = [...send('market', { type: 'quote', id: 'quote-1', version: 1, price: 10 }, `${messageId}-quote`),
            ...send('credit', { type: 'credit_limit', id: 'credit-1', version: 1, limit: c.limit })];
        } else if (c.kind === 'order') {
          actions = send('client', { type: 'new_order', id: messageId, orderId: c.orderId, quoteId: 'quote-1', quantity: c.quantity });
        } else {
          const key = JSON.stringify([c.orderId, c.executionId]);
          const prior = executions.get(key);
          if (!prior) {
            actions = [{ op: 'fill', messageId, orderId: c.orderId, executionId: c.executionId, quantity: c.quantity }, { op: 'deliver', messageId }];
          } else if (prior.quantity === c.quantity) {
            actions = [{ op: 'duplicate', messageId: prior.messageId, id: messageId }, { op: 'deliver', messageId }];
          } else {
            actions = send('reports', { ...prior.payload, id: messageId, quantity: c.quantity });
          }
        }
        deliveryStep += actions.length - 1;
        const next = { ...experiment, steps: [...experiment.steps, ...actions] };
        const nextResult = execute(next, options.variant);
        experiment.steps = next.steps;
        result = nextResult;
        const delivery = result.deliveryObservations?.find(d => d.step === deliveryStep);
        if (c.kind === 'execution' && !executions.has(JSON.stringify([c.orderId, c.executionId]))) {
          const payload = result.trace.find(t => t.step === deliveryStep)?.payload;
          if (payload && typeof payload === 'object') executions.set(JSON.stringify([c.orderId, c.executionId]), { messageId, quantity: c.quantity, payload: payload as Record<string, unknown> });
        }
        event = { instanceId, eventId: `${instanceId}:${receipt.sequence}`, receiptId: receipt.receiptId,
          requestId: c.requestId, sequence: receipt.sequence, command: c, messageId, deliveryStep,
          status: !result.valid || !delivery || delivery.status === 'exception' ? 'error' : delivery.status,
          ...(delivery?.reason ? { reason: delivery.reason } : {}), result: structuredClone(result) };
      } catch (error) {
        event = { instanceId, eventId: `${instanceId}:${receipt.sequence}`, receiptId: receipt.receiptId, requestId: c.requestId,
          sequence: receipt.sequence, command: c, messageId, deliveryStep, status: 'error', reason: String(error), result: null };
      }
      events.push(event);
      schedule();
    }, delay);
  }
  const reply = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    // Exact numeric loopback authority; Origin and browser fetch metadata checked on reads too.
    const authority = `127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const hostValid = req.headers.host === authority;
    const originValid = req.headers.origin === undefined || req.headers.origin === `http://${authority}`;
    const secFetch = req.headers['sec-fetch-site'];
    const documentNavigation = req.method === 'GET' && ['/', '/index.html', '/target-ui.html'].includes(req.url ?? '')
      && secFetch === 'same-site' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document'
      && req.headers.origin === undefined;
    const secFetchValid = !secFetch || secFetch === 'same-origin' || secFetch === 'none' || documentNavigation;
    if (!hostValid || !originValid || !secFetchValid) {
      reply(res, 403, { error: 'Loopback host/origin required' });
      return;
    }
    const path = req.url ?? '';
    if (closed) { reply(res, 503, { error: 'Target closed' }); return; }
    if (req.method === 'GET' && path === '/ui-context') {
      reply(res, 200, { instanceId, variant: options.variant, ...options.uiContext }); return;
    }
    if (req.method === 'GET' && (path === '/state' || path === '/events')) { reply(res, 200, observe()); return; }
    const orderMatch = path.match(/^\/orders\/([a-z][a-z0-9-]{0,47})$/);
    if (req.method === 'GET' && orderMatch) {
      const o = observe(); reply(res, 200, { instanceId, orderId: orderMatch[1], processed: o.processed, order: o.orders[orderMatch[1]!] ?? null }); return;
    }
    const staticEntry = staticUiFiles[path];
    if (req.method === 'GET' && staticEntry) {
      try {
        let content: Buffer;
        try {
          content = await fs.readFile(resolvePath(repoRoot, staticEntry.relative));
        } catch (e) {
          if (staticEntry.fallback) {
            content = await fs.readFile(resolvePath(repoRoot, staticEntry.fallback));
          } else {
            throw e;
          }
        }
        res.writeHead(200, {
          'Content-Type': staticEntry.contentType,
          'Content-Length': content.length,
          'Cache-Control': 'no-store',
          Connection: 'close',
        });
        res.end(content);
        return;
      } catch {
        reply(res, 404, { error: 'Static UI file not found' });
        return;
      }
    }
    if (req.method !== 'POST' || !['/setup', '/orders', '/executions'].includes(path)) { reply(res, 404, { error: 'Unknown target endpoint' }); return; }
    if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') { reply(res, 415, { error: 'JSON required' }); return; }
    try {
      let bytes = 0, body = '';
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 4096) { reply(res, 413, { error: 'Body exceeds 4096 bytes' }); return; }
        body += chunk.toString();
      }
      const command = parseCommand(path, JSON.parse(body));
      if (closed) return;
      if (accepted >= 32) { reply(res, 429, { error: 'Command count bound reached' }); return; }
      if (requests.has(command.requestId)) { reply(res, 409, { error: 'requestId already used; retries require a fresh transport requestId' }); return; }
      if ((command.kind === 'setup' && setupQueued) || (command.kind !== 'setup' && !setupQueued)) { reply(res, 409, { error: 'Exactly one setup must precede orders/executions' }); return; }
      if (command.kind === 'setup') setupQueued = true;
      requests.add(command.requestId);
      const receipt: Receipt = { instanceId, receiptId: randomUUID(), requestId: command.requestId, sequence: ++accepted, status: 'queued' };
      queue.push({ command, receipt });
      reply(res, 202, receipt); // Transport acknowledgement always precedes asynchronous processing.
      schedule();
    } catch (error) { if (!res.headersSent && !res.destroyed) reply(res, 400, { error: String(error) }); }
  });
  server.requestTimeout = 2000; server.headersTimeout = 2000; server.timeout = 2000;
  server.maxConnections = 16;
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const close = async () => {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = undefined; queue.length = 0;
    const done = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const socket of sockets) socket.destroy();
    await done;
    sockets.clear();
  };
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  } catch (error) {
    closed = true; for (const socket of sockets) socket.destroy(); throw error;
  }
  let closing: Promise<void> | undefined;
  return { endpoint: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, instanceId,
    close: () => closing ??= close(), diagnostics: () => ({ closed, queued: queue.length, processed: events.length, timer: timer !== undefined, sockets: sockets.size }) };
}
