import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { ChaosPilotServer } from '../src/server.ts';

// Drive the real HTTP handler without binding a socket (works in restricted sandboxes too).
function request(server: http.Server, urlPath: string): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
  return new Promise((resolve) => {
    const req = new EventEmitter() as unknown as http.IncomingMessage;
    (req as unknown as Record<string, unknown>).method = 'GET';
    (req as unknown as Record<string, unknown>).url = urlPath;
    (req as unknown as Record<string, unknown>).headers = { host: '127.0.0.1' };
    (req as unknown as Record<string, unknown>).socket = { localPort: 80 };
    const chunks: Buffer[] = [];
    let status = 0; let headers: Record<string, unknown> = {};
    const res = new EventEmitter() as unknown as http.ServerResponse;
    (res as unknown as Record<string, unknown>).writeHead = (s: number, h: Record<string, unknown>) => { status = s; headers = h; return res; };
    (res as unknown as Record<string, unknown>).end = (c?: unknown) => { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); resolve({ status, headers, body: Buffer.concat(chunks) }); return res; };
    server.emit('request', req, res);
  });
}
const ct = (r: { headers: Record<string, unknown> }) => String(r.headers['Content-Type'] ?? '');

describe('homepage HTTP routes', () => {
  let server: http.Server;
  beforeAll(() => { server = new ChaosPilotServer({ runsDir: path.join(process.cwd(), 'runs') }).createHttpServer(); });
  afterAll(() => { /* never listened, nothing to close */ });

  it('GET / serves new homepage only (no workspace bootstrap)', async () => {
    const res = await request(server, '/'); expect(res.status).toBe(200); expect(ct(res)).toContain('text/html');
    const body = res.body.toString('utf8');
    expect(body).toContain('Every system has'); expect(body).toContain('/homepage.js');
    expect(body).not.toContain('/app.js'); expect(body).not.toContain('/api/status');
  });
  it('GET /workspace and /index.html preserve original workspace', async () => {
    for (const p of ['/workspace', '/index.html']) {
      const res = await request(server, p); expect(res.status).toBe(200);
      expect(res.body.toString('utf8')).toContain('/app.js');
    }
  });
  it('serves homepage.css, market-fabric binary and compiled homepage module', async () => {
    const css = await request(server, '/homepage.css'); expect(css.status).toBe(200); expect(ct(css)).toContain('text/css');
    expect(css.body.toString('utf8')).toContain('/assets/homepage/market-grid.png');
    const png = await request(server, '/assets/homepage/market-fabric.png'); expect(png.status).toBe(200); expect(ct(png)).toContain('image/png');
    expect(png.body.length).toBeGreaterThan(100); expect(png.body.subarray(0, 4).toString('hex')).toBe('89504e47');
    const grid = await request(server, '/assets/homepage/market-grid.png'); expect(grid.status).toBe(200); expect(ct(grid)).toContain('image/png');
    expect(grid.body.length).toBeGreaterThan(100); expect(grid.body.subarray(0, 4).toString('hex')).toBe('89504e47');
    // Stale crystal/atmosphere assets are no longer allowlisted.
    for (const stale of ['/assets/homepage/crystal.png', '/assets/homepage/atmosphere.png']) {
      const res = await request(server, stale); expect(res.status, stale).toBe(404);
    }
    const js = await request(server, '/homepage.js'); expect(js.status).toBe(200); expect(ct(js)).toContain('javascript');
    const ev = await request(server, '/homepage-events.js'); expect(ev.status).toBe(200);
  });
  it('denies unknown assets, traversal and env', async () => {
    for (const p of ['/assets/homepage/other.png', '/assets/other.png', '/homepage.html', '/.env', '/etc/passwd', '/assets/%2e%2e/package.json']) {
      const res = await request(server, p); expect(res.status, p).toBe(404);
    }
    const trav = await request(server, '/../package.json'); expect(trav.status).toBe(404);
  });
  it('existing endpoints still respond and CTA is plain navigation in source', async () => {
    const res = await request(server, '/api/targets'); expect(res.status).toBe(200);
    const home = (await request(server, '/')).body.toString('utf8');
    expect(home).toContain('href="/workspace"'); expect(home).not.toMatch(/fetch\(|XMLHttpRequest/);
  });
  it('missing asset returns 404 not fabricated content', async () => {
    const res = await request(server, '/assets/homepage/missing.png'); expect(res.status).toBe(404);
  });
});
