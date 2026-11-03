import * as http from 'node:http';
import type { Exchange, TransportFailure } from './types.ts';

const PREVIEW_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
function freeze(value: unknown): void {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
}
export class TargetRequestError extends Error {
  constructor(message: string, readonly exchange: Exchange) {
    super(message); this.name = 'TargetRequestError'; freeze(exchange);
  }
}

/** Private loopback transport. Only attempted requests produce failure evidence. */
export function requestJson(endpoint: string, method: 'GET' | 'POST', path: string, body: unknown, signal: AbortSignal, timeoutMs = 1500): Promise<Exchange> {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(path)) throw new Error('Owned numeric loopback endpoint required');
  const requestUrl = new URL(path, url);
  if (requestUrl.origin !== url.origin || requestUrl.pathname !== path || requestUrl.search || requestUrl.hash) throw new Error('Canonical owned loopback path required');
  signal.throwIfAborted();
  // Snapshot the actual serialized payload before caller mutation or network callbacks.
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const request = payload === undefined ? null : JSON.parse(payload);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let settled = false, status = 0, contentType: string | null = null, receivedBytes = 0, capturedBytes = 0, complete = false;
    const chunks: Buffer[] = [], preview: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const fail = (kind: TransportFailure['kind'], error: unknown) => {
      if (settled) return;
      settled = true; cleanup();
      const message = error instanceof Error ? error.message : String(error);
      const decoded = new TextDecoder().decode(Buffer.concat(preview), { stream: !complete || capturedBytes < receivedBytes });
      // Replacement characters for invalid UTF-8 must not expand the text beyond the preview cap.
      const previewText = new TextDecoder().decode(Buffer.from(decoded).subarray(0, PREVIEW_LIMIT), { stream: true });
      const exchange: Exchange = { method, path, request, status, response: null, elapsedMs: performance.now() - started,
        transportFailure: { kind, message, contentType, preview: previewText,
          receivedBytes, capturedBytes, truncated: capturedBytes < receivedBytes || Buffer.byteLength(decoded) > PREVIEW_LIMIT, complete } };
      reject(new TargetRequestError(message, exchange));
      req.destroy();
    };
    const abort = () => fail('aborted', signal.reason ?? new Error('Target request aborted'));
    const req = http.request(requestUrl, { method, agent: false,
      headers: { Connection: 'close', ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, res => {
      if (settled) { res.destroy(); return; }
      status = res.statusCode ?? 0; contentType = res.headers['content-type'] ?? null;
      res.on('data', (chunk: Buffer) => {
        if (settled) return;
        receivedBytes += chunk.length;
        const part = chunk.subarray(0, PREVIEW_LIMIT - capturedBytes);
        if (part.length) { preview.push(Buffer.from(part)); capturedBytes += part.length; }
        if (receivedBytes > RESPONSE_LIMIT) { fail('oversize', new Error('Response byte bound exceeded')); return; }
        chunks.push(Buffer.from(chunk));
      });
      res.on('error', error => fail('network', error));
      res.on('aborted', () => fail('network', new Error('Target response aborted')));
      res.on('end', () => {
        if (settled) return;
        complete = true;
        if (contentType?.split(';')[0] !== 'application/json') { fail('non-json', new Error('Non-JSON target observation')); return; }
        let response: unknown;
        try { response = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch (error) { fail('invalid-json', error); return; }
        settled = true; cleanup();
        resolve({ method, path, request, status, response, elapsedMs: performance.now() - started });
      });
      res.on('close', () => { if (!complete) fail('network', new Error('Target response closed before completion')); });
    });
    req.on('error', error => fail('network', error));
    timer = setTimeout(() => fail('deadline', new Error('Target request deadline exceeded')), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    req.end(payload);
  });
}
