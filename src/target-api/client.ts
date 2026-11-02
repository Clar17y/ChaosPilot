import * as http from 'node:http';
import type { Exchange } from './types.ts';

/** Private loopback transport, bounded request lifetime and response size, no shared agent sockets. */
export function requestJson(endpoint: string, method: 'GET' | 'POST', path: string, body: unknown, signal: AbortSignal, timeoutMs = 1500): Promise<Exchange> {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !/^\/[a-z0-9/-]+$/.test(path)) throw new Error('Owned numeric loopback endpoint required');
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let timer: ReturnType<typeof setTimeout>;
    const req = http.request(new URL(path, url), { method, agent: false, signal,
      headers: { Connection: 'close', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, res => {
      let text = '', bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) req.destroy(new Error('Response byte bound exceeded'));
        else text += chunk.toString();
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          if (res.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('Non-JSON target observation');
          resolve({ method, path, request: body ?? null, status: res.statusCode ?? 0, response: JSON.parse(text), elapsedMs: performance.now() - started });
        } catch (error) { reject(error); }
      });
    });
    timer = setTimeout(() => req.destroy(new Error('Target request deadline exceeded')), timeoutMs);
    req.once('error', reject);
    req.once('close', () => clearTimeout(timer));
    req.end(payload);
  });
}
