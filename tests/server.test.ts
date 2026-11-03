import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { createServer } from '../src/server.ts';

describe('ChaosPilot Server Core and Integration', () => {
  let server: http.Server | undefined;
  let serverUrl = '';
  let tempDir = '';

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  async function startServer(): Promise<string> {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chaospilot-server-test-'));
    server = createServer({ runsDir: tempDir });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const port = (server!.address() as import('node:net').AddressInfo).port;
    serverUrl = `http://127.0.0.1:${port}`;
    return serverUrl;
  }

  it('starts and responds to status query on loopback', async () => {
    const url = await startServer();
    const res = await fetch(`${url}/api/status`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data).toHaveProperty('active');
  });

  it('serves static workspace HTML and assets on allowlisted paths', async () => {
    const url = await startServer();
    const resWorkspace = await fetch(`${url}/workspace`);
    expect(resWorkspace.status).toBe(200);
    expect(resWorkspace.headers.get('content-type')).toContain('text/html');

    const resStyles = await fetch(`${url}/styles.css`);
    expect(resStyles.status).toBe(200);
    expect(resStyles.headers.get('content-type')).toContain('text/css');
  });

  it('rejects forbidden host header requests with 403', async () => {
    const url = await startServer();
    const res = await new Promise<number>((resolve) => {
      const req = http.request(new URL('/api/status', url), { headers: { Host: 'evil.com' } }, (r) => {
        resolve(r.statusCode ?? 0);
      });
      req.end();
    });
    expect(res).toBe(403);
  });
});
