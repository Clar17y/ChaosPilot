import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import { startTarget } from '../../src/target-api/target.ts';

describe('Target listener UI asset serving and security boundary', () => {
  let targetHandle: Awaited<ReturnType<typeof startTarget>> | undefined;

  afterEach(async () => {
    if (targetHandle) {
      await targetHandle.close();
      targetHandle = undefined;
    }
  });

  it('serves target-ui.html at root / and /index.html with strict loopback host', async () => {
    targetHandle = await startTarget({ variant: 'clean' });
    const { endpoint } = targetHandle;

    const res = await fetch(`${endpoint}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const text = await res.text();
    expect(text).toContain('SYNTHETIC TARGET TRADING TERMINAL');
    expect(text).toContain('target-ui.js');

    const resIndex = await fetch(`${endpoint}/index.html`);
    expect(resIndex.status).toBe(200);
    expect(resIndex.headers.get('content-type')).toContain('text/html');
  });

  it('serves target-ui.css and target-ui.js', async () => {
    targetHandle = await startTarget({ variant: 'clean' });
    const { endpoint } = targetHandle;

    const resCss = await fetch(`${endpoint}/target-ui.css`);
    expect(resCss.status).toBe(200);
    expect(resCss.headers.get('content-type')).toContain('text/css');
    const css = await resCss.text();
    expect(css).toContain('target-terminal-body');

    const resJs = await fetch(`${endpoint}/target-ui.js`);
    expect(resJs.status).toBe(200);
    expect(resJs.headers.get('content-type')).toContain('application/javascript');
    const js = await resJs.text();
    expect(js).toContain('TargetUiController');
  });

  it('rejects cross-origin and invalid-host requests to UI assets with 403', async () => {
    targetHandle = await startTarget({ variant: 'clean' });
    const { endpoint } = targetHandle;
    const url = new URL('/target-ui.html', endpoint);

    // Cross-origin request
    const crossOriginStatus = await new Promise<number>((resolve) => {
      const req = http.request(
        url,
        { method: 'GET', headers: { Origin: 'http://malicious-site.com' } },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.end();
    });
    expect(crossOriginStatus).toBe(403);

    // Cross-site sec-fetch-site
    const crossSiteStatus = await new Promise<number>((resolve) => {
      const req = http.request(
        url,
        { method: 'GET', headers: { 'Sec-Fetch-Site': 'cross-site' } },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.end();
    });
    expect(crossSiteStatus).toBe(403);

    // Host spoofing
    const hostSpoofStatus = await new Promise<number>((resolve) => {
      const req = http.request(
        url,
        { method: 'GET', headers: { Host: 'localhost:8080' } },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.end();
    });
    expect(hostSpoofStatus).toBe(403);
  });

  it('allows same-site top-level document navigation from the workspace origin but nothing broader', async () => {
    targetHandle = await startTarget({ variant: 'clean' });
    const { endpoint } = targetHandle;
    const rawStatus = (path: string, headers: Record<string, string>) => new Promise<number>((resolve) => {
      const req = http.request(new URL(path, endpoint), { method: 'GET', headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.end();
    });
    const navigate = { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
    // The real workspace -> target page link navigation succeeds.
    expect(await rawStatus('/', navigate)).toBe(200);
    expect(await rawStatus('/target-ui.html', navigate)).toBe(200);
    // The exception is only for document paths, not the API or assets.
    expect(await rawStatus('/events', navigate)).toBe(403);
    expect(await rawStatus('/target-ui.js', navigate)).toBe(403);
    // Same-site fetch/XHR (not a navigation) stays denied everywhere.
    expect(await rawStatus('/', { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' })).toBe(403);
    expect(await rawStatus('/events', { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' })).toBe(403);
    // Cross-site navigation and navigation carrying a foreign Origin stay denied.
    expect(await rawStatus('/', { ...navigate, 'Sec-Fetch-Site': 'cross-site' })).toBe(403);
    expect(await rawStatus('/', { ...navigate, Origin: 'http://127.0.0.1:9999' })).toBe(403);
  });

  it('rejects non-allowlisted static paths with 404', async () => {
    targetHandle = await startTarget({ variant: 'clean' });
    const { endpoint } = targetHandle;

    const res = await fetch(`${endpoint}/package.json`);
    expect(res.status).toBe(404);

    const resTraversal = await fetch(`${endpoint}/../src/server.ts`);
    expect(resTraversal.status).toBe(404);
  });
});
