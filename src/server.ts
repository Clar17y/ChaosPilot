import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type {
  TargetVariant,
  ProviderKind,
  InvestigationRecord,
  InvestigationOptions,
  ExperimentProvider,
} from './domain.ts';
import {
  saveRun,
  getRun,
  listRuns,
  deleteRun,
  replayRun,
  validateRunId,
  getSimulatorApi,
} from './storage.ts';

export interface ActiveInvestigationState {
  id: string;
  status: 'running' | 'stopping';
  startedAt: string;
  abortController: AbortController;
  record: InvestigationRecord | null;
  promise: Promise<void>;
}

export interface ServerOptions {
  runsDir?: string;
  investigationRunner?: (options: InvestigationOptions) => Promise<InvestigationRecord>;
  providerFactory?: (kind: ProviderKind) => ExperimentProvider;
  publicDir?: string;
  distDir?: string;
}

const ALLOWED_LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function parseHost(hostHeader: string | undefined): { hostname: string; port: number | null } | null {
  if (!hostHeader) return null;
  const trimmed = hostHeader.trim();
  if (trimmed.startsWith('[')) {
    const closeIdx = trimmed.indexOf(']');
    if (closeIdx === -1) return null;
    const hostname = trimmed.slice(0, closeIdx + 1).toLowerCase();
    const rest = trimmed.slice(closeIdx + 1);
    if (rest === '') return { hostname, port: null };
    if (rest.startsWith(':')) {
      const port = Number(rest.slice(1));
      if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
      return { hostname, port };
    }
    return null;
  }
  const parts = trimmed.split(':');
  if (parts.length === 1) {
    return { hostname: parts[0]!.toLowerCase(), port: null };
  }
  if (parts.length === 2) {
    const port = Number(parts[1]);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
    return { hostname: parts[0]!.toLowerCase(), port };
  }
  return null;
}

export class ChaosPilotServer {
  private activeInvestigation: ActiveInvestigationState | null = null;
  private startingController: AbortController | null = null;
  private latestRecord: InvestigationRecord | null = null;
  private runsDir: string;
  private publicDir: string;
  private distDir: string;
  private runnerOverride?: (options: InvestigationOptions) => Promise<InvestigationRecord>;
  private providerFactoryOverride?: (kind: ProviderKind) => ExperimentProvider;

  constructor(options: ServerOptions = {}) {
    this.runsDir = options.runsDir || 'runs';
    this.publicDir = options.publicDir || path.resolve(process.cwd(), 'public');
    this.distDir = options.distDir || path.resolve(process.cwd(), 'dist');
    this.runnerOverride = options.investigationRunner;
    this.providerFactoryOverride = options.providerFactory;
  }

  public getActiveInvestigation(): ActiveInvestigationState | null {
    return this.activeInvestigation;
  }

  public getLatestRecord(): InvestigationRecord | null {
    return this.latestRecord;
  }

  /**
   * Validates Host header against allowed loopback hosts and actual server port on ALL requests.
   */
  private isAllowedHost(req: http.IncomingMessage): boolean {
    const hostHeader = req.headers['host'];
    if (!hostHeader || typeof hostHeader !== 'string') return false;
    const parsed = parseHost(hostHeader);
    if (!parsed) return false;
    if (!ALLOWED_LOOPBACK_HOSTNAMES.has(parsed.hostname)) return false;

    const actualPort = req.socket?.localPort;
    if (actualPort !== undefined) {
      if (parsed.port !== null) {
        if (parsed.port !== actualPort) return false;
      } else {
        if (actualPort !== 80) return false;
      }
    }
    return true;
  }

  /**
   * Checks origin / host headers for mutating requests to enforce strict same-origin protection.
   */
  private checkSameOrigin(req: http.IncomingMessage): boolean {
    const actualPort = req.socket?.localPort;
    const hostHeader = req.headers['host'] || '';
    const parsedHost = parseHost(hostHeader);
    if (!parsedHost || !ALLOWED_LOOPBACK_HOSTNAMES.has(parsedHost.hostname)) {
      return false;
    }

    const secFetchSite = req.headers['sec-fetch-site'];
    if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
      return false;
    }

    const origin = req.headers['origin'];
    if (origin) {
      try {
        const originUrl = new URL(origin);
        if (originUrl.protocol !== 'http:') return false;
        if (!ALLOWED_LOOPBACK_HOSTNAMES.has(originUrl.hostname.toLowerCase())) return false;
        const originPort = originUrl.port ? Number(originUrl.port) : 80;
        if (actualPort !== undefined && originPort !== actualPort) return false;
        if (parsedHost.port !== null && originPort !== parsedHost.port) return false;
        if (parsedHost.hostname !== originUrl.hostname.toLowerCase()) return false;
      } catch {
        return false;
      }
    }

    const referer = req.headers['referer'];
    if (referer) {
      try {
        const refUrl = new URL(referer);
        if (refUrl.protocol !== 'http:') return false;
        if (!ALLOWED_LOOPBACK_HOSTNAMES.has(refUrl.hostname.toLowerCase())) return false;
        const refPort = refUrl.port ? Number(refUrl.port) : 80;
        if (actualPort !== undefined && refPort !== actualPort) return false;
        if (origin) {
          const originUrl = new URL(origin);
          if (refUrl.origin !== originUrl.origin) return false;
        }
      } catch {
        return false;
      }
    }

    return true;
  }

  /**
   * Bounded body reader to prevent memory exhaustion and parse JSON safely.
   */
  private async readJsonBody(
    req: http.IncomingMessage,
    maxBytes = 64 * 1024
  ): Promise<{ data?: unknown; error?: string; status?: number }> {
    return new Promise((resolve) => {
      let totalBytes = 0;
      let tooLarge = false;
      const chunks: Buffer[] = [];

      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          tooLarge = true;
          req.resume(); // discard remaining body
        } else {
          chunks.push(chunk);
        }
      });

      req.on('end', () => {
        if (tooLarge) {
          resolve({ error: 'Payload too large', status: 413 });
          return;
        }
        if (chunks.length === 0) {
          resolve({ data: {} });
          return;
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          const parsed = JSON.parse(raw);
          resolve({ data: parsed });
        } catch {
          resolve({ error: 'Malformed JSON payload', status: 400 });
        }
      });

      req.on('error', () => {
        resolve({ error: 'Failed to read request body', status: 400 });
      });
    });
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
    });
    res.end(payload);
  }

  private async serveStatic(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string
  ): Promise<boolean> {
    // Explicit allowlist of static files only - strictly no path traversal
    if (pathname === '/' || pathname === '/index.html') {
      const htmlPath = path.join(this.publicDir, 'index.html');
      try {
        const content = await fs.readFile(htmlPath, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(content),
          'Cache-Control': 'no-cache',
        });
        res.end(content);
        return true;
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return true;
      }
    }

    if (pathname === '/styles.css') {
      const cssPath = path.join(this.publicDir, 'styles.css');
      try {
        const content = await fs.readFile(cssPath, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/css; charset=utf-8',
          'Content-Length': Buffer.byteLength(content),
          'Cache-Control': 'no-cache',
        });
        res.end(content);
        return true;
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return true;
      }
    }

    const jsMatch = pathname.match(/^\/([a-zA-Z0-9_-]+\.(?:js|js\.map))$/);
    if (jsMatch) {
      const fileName = jsMatch[1]!;
      const primaryPath = path.join(this.distDir, 'web', fileName);
      const fallbackPath = path.join(this.publicDir, fileName);
      try {
        let content: string;
        try {
          content = await fs.readFile(primaryPath, 'utf8');
        } catch {
          content = await fs.readFile(fallbackPath, 'utf8');
        }
        const contentType = fileName.endsWith('.map')
          ? 'application/json; charset=utf-8'
          : 'application/javascript; charset=utf-8';
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': Buffer.byteLength(content),
          'Cache-Control': 'no-cache',
        });
        res.end(content);
        return true;
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return true;
      }
    }

    return false;
  }

  public createHttpServer(): http.Server {
    const server = http.createServer(async (req, res) => {
      try {
        // 0. Allowed loopback Host header check on ALL requests
        if (!this.isAllowedHost(req)) {
          this.sendJson(res, 403, { error: 'Forbidden: Invalid Host header' });
          return;
        }

        const host = req.headers.host || '127.0.0.1';
        const url = new URL(req.url || '/', `http://${host}`);
        const pathname = url.pathname;
        const method = (req.method || 'GET').toUpperCase();

        // 1. Static allowlist serving
        if (method === 'GET') {
          const handled = await this.serveStatic(req, res, pathname);
          if (handled) return;
        }

        // 2. Same-origin protection for mutating requests
        if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
          if (!this.checkSameOrigin(req)) {
            this.sendJson(res, 403, { error: 'Forbidden: Same-origin check failed' });
            return;
          }
        }

        // 3. API Routes

        // GET /api/status - Get active investigation progress and system info
        if (method === 'GET' && pathname === '/api/status') {
          const active = this.activeInvestigation;
          this.sendJson(res, 200, {
            active: Boolean(active || this.startingController),
            status: active ? active.status : this.startingController ? 'starting' : 'idle',
            id: active?.id,
            startedAt: active?.startedAt,
            currentRecord: active ? active.record : this.startingController ? null : this.latestRecord,
            metaKeyConfigured: Boolean(process.env.MODEL_API_KEY && process.env.MODEL_API_KEY.trim().length > 0),
          });
          return;
        }

        // GET /api/contract - Public system contract (never exposes secrets or hidden keys)
        if (method === 'GET' && pathname === '/api/contract') {
          try {
            const sim = await getSimulatorApi();
            // In simulator/contract.ts or index.ts
            const contract = (sim as any).getContract ? (sim as any).getContract() : { name: 'ChaosPilot Gateway' };
            this.sendJson(res, 200, contract);
          } catch {
            this.sendJson(res, 503, { error: 'Simulator contract unavailable' });
          }
          return;
        }

        // POST /api/investigation/start - Launch an investigation
        if (method === 'POST' && pathname === '/api/investigation/start') {
          // Rule: Single active investigation exclusivity
          if (this.activeInvestigation || this.startingController) {
            this.sendJson(res, 409, {
              error: 'An investigation is already in progress or settling. Second run is rejected.',
              activeId: this.activeInvestigation?.id,
              status: this.activeInvestigation?.status || 'starting',
            });
            return;
          }

          // Rule: JSON-only start
          const contentType = req.headers['content-type'] || '';
          if (!contentType.toLowerCase().includes('application/json')) {
            this.sendJson(res, 415, { error: 'Content-Type must be application/json' });
            return;
          }

          const abortController = new AbortController();
          this.startingController = abortController;
          let onStartAbort!: () => void;
          const cancelledStart = new Promise<{ data?: unknown; error: string; status: number }>(resolve => {
            onStartAbort = () => resolve({ error: 'Investigation start cancelled', status: 409 });
            abortController.signal.addEventListener('abort', onStartAbort, { once: true });
          });
          try {
            const { data, error, status } = await Promise.race([this.readJsonBody(req), cancelledStart]);
            if (error) {
              this.sendJson(res, status || 400, { error });
              return;
            }

            const body = (data || {}) as Record<string, unknown>;
            const variant = (body.variant as TargetVariant) || 'candidate-a';
            const providerKind = (body.provider as ProviderKind) || 'mock';
            const maxExperiments = Math.min(
              Math.max(Number(body.maxExperiments) || 5, 1),
              20
            );

            // Never accept API keys or custom endpoints from the browser
            if (providerKind === 'meta' && (!process.env.MODEL_API_KEY || !process.env.MODEL_API_KEY.trim())) {
              this.sendJson(res, 400, {
                error: 'MODEL_API_KEY is not configured on the server. Meta provider cannot be launched.',
              });
              return;
            }

            const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

            // Prepare runner and provider
            let runner = this.runnerOverride;
            let providerFactory = this.providerFactoryOverride;

            if (!runner) {
              try {
                const invModule = await import('./investigation/index.ts');
                runner = invModule.runInvestigation;
              } catch {
                // Runner not yet imported
              }
            }

            if (!providerFactory) {
              try {
                const provModule = await import('./providers/index.ts');
                providerFactory = provModule.createProvider;
              } catch {
                // Providers not yet imported
              }
            }

            if (!runner || !providerFactory) {
              this.sendJson(res, 503, { error: 'Investigation engine is currently unavailable' });
              return;
            }

            if (abortController.signal.aborted) {
              this.sendJson(res, 409, { error: 'Investigation start cancelled' });
              return;
            }

            const provider = providerFactory(providerKind);

            const active: ActiveInvestigationState = {
              id: runId,
              status: 'running',
              startedAt: new Date().toISOString(),
              abortController,
              record: null,
              promise: Promise.resolve(),
            };
            this.activeInvestigation = active;
            active.promise = Promise.resolve().then(async () => {
              try {
                const resultRecord = await runner!({
                  id: runId,
                  variant,
                  maxExperiments,
                  provider,
                  signal: abortController.signal,
                  onUpdate: (record) => {
                    if (this.activeInvestigation && this.activeInvestigation.id === runId) {
                      this.activeInvestigation.record = record;
                    }
                    this.latestRecord = record;
                  },
                });

                this.latestRecord = resultRecord;
                await saveRun(resultRecord, this.runsDir);
              } catch (err) {
                if (this.activeInvestigation && this.activeInvestigation.record) {
                  // Preserve observations made before failure/cancellation
                  const rec = this.activeInvestigation.record;
                  rec.status = abortController.signal.aborted ? 'cancelled' : 'failed';
                  rec.stopReason = err instanceof Error ? err.message : String(err);
                  rec.finishedAt = new Date().toISOString();
                  this.latestRecord = rec;
                  try {
                    await saveRun(rec, this.runsDir);
                  } catch {
                    // Ignore secondary save errors
                  }
                }
              } finally {
                if (this.activeInvestigation && this.activeInvestigation.id === runId) {
                  this.activeInvestigation = null;
                }
              }
            });

            this.sendJson(res, 202, {
              message: 'Investigation started',
              id: runId,
              variant,
              provider: providerKind,
              maxExperiments,
            });
            return;
          } finally {
            abortController.signal.removeEventListener('abort', onStartAbort);
            if (this.startingController === abortController) this.startingController = null;
          }
        }

        // POST /api/investigation/stop - Stop active investigation
        if (method === 'POST' && pathname === '/api/investigation/stop') {
          if (!this.activeInvestigation && this.startingController) {
            this.startingController.abort();
            this.sendJson(res, 200, { status: 'stopping', message: 'Investigation initialization cancelled' });
            return;
          }
          if (!this.activeInvestigation) {
            this.sendJson(res, 400, { error: 'No active investigation to stop' });
            return;
          }

          if (this.activeInvestigation.status === 'stopping') {
            this.sendJson(res, 200, {
              status: 'stopping',
              message: 'Investigation is already stopping and settling prior observations',
            });
            return;
          }

          this.activeInvestigation.status = 'stopping';
          this.activeInvestigation.abortController.abort();

          this.sendJson(res, 200, {
            status: 'stopping',
            id: this.activeInvestigation.id,
            message: 'Stop signal dispatched. Preserving prior observations.',
          });
          return;
        }

        // GET /api/runs - List persisted runs
        if (method === 'GET' && pathname === '/api/runs') {
          const runs = await listRuns(this.runsDir);
          this.sendJson(res, 200, runs);
          return;
        }

        // GET /api/runs/:id - Get specific run
        const runMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)$/);
        if (method === 'GET' && runMatch && runMatch[1]) {
          const id = runMatch[1];
          if (!validateRunId(id)) {
            this.sendJson(res, 400, { error: 'Invalid run ID' });
            return;
          }
          const record = await getRun(id, this.runsDir);
          if (!record) {
            this.sendJson(res, 404, { error: 'Run not found' });
            return;
          }
          this.sendJson(res, 200, record);
          return;
        }

        // POST /api/runs/:id/replay - Replay specific run deterministically
        const replayMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/replay$/);
        if (method === 'POST' && replayMatch && replayMatch[1]) {
          const id = replayMatch[1];
          if (!validateRunId(id)) {
            this.sendJson(res, 400, { error: 'Invalid run ID' });
            return;
          }
          try {
            const report = await replayRun(id, this.runsDir);
            this.sendJson(res, 200, report);
          } catch (err) {
            this.sendJson(res, 400, {
              error: err instanceof Error ? err.message : 'Replay failed',
            });
          }
          return;
        }

        // DELETE /api/runs/:id - Delete run
        if (method === 'DELETE' && runMatch && runMatch[1]) {
          const id = runMatch[1];
          if (!validateRunId(id)) {
            this.sendJson(res, 400, { error: 'Invalid run ID' });
            return;
          }
          const deleted = await deleteRun(id, this.runsDir);
          if (!deleted) {
            this.sendJson(res, 404, { error: 'Run not found' });
            return;
          }
          this.sendJson(res, 200, { message: 'Run deleted', id });
          return;
        }

        // 404 for any other request
        this.sendJson(res, 404, { error: 'Route not found' });
      } catch (err) {
        this.sendJson(res, 500, {
          error: 'Internal Server Error',
          details: err instanceof Error ? err.message : String(err),
        });
      }
    });

    return server;
  }
}

export function createServer(options: ServerOptions = {}): http.Server {
  const instance = new ChaosPilotServer(options);
  return instance.createHttpServer();
}

/**
 * Entry point when running server directly. Avoids side effects when imported by tests.
 */
function isMain(): boolean {
  if (process.env.NODE_ENV === 'test') return false;
  if (!process.argv[1]) return false;
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const invokedFile = path.resolve(process.argv[1]);
    return currentFile === invokedFile || invokedFile.endsWith('server.js') || invokedFile.endsWith('server.ts');
  } catch {
    return false;
  }
}

if (isMain()) {
  const port = Number(process.env.CHAOSPILOT_PORT || process.env.PORT || 4310);
  const host = process.env.HOST || '127.0.0.1';
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`ChaosPilot server listening on http://${host}:${port}`);
  });
}
