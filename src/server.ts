import * as http from 'node:http';
import { MetaProvider } from './providers/meta.ts';
import { readSystemBriefFile, resolveSystemPath } from './systems/index.ts';
import { resolveAdapter, assertAdapterVariant, listRegisteredAdapters } from './adapters/index.ts';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  TARGET_VARIANTS,
  type TargetVariant,
  type ProviderKind,
  type InvestigationRecord,
  type InvestigationOptions,
  type ExperimentProvider,
  type SystemBrief,
} from './domain.ts';
import {
  saveRun,
  getRun,
  listRuns,
  deleteRun,
  replayRun,
  replaySelectedExperiment,
  parseExperimentPosition,
  validateRunId,
  getSimulatorApi,
  isKnownTargetVariant,
  getSystemBrief,
  listSystemBriefs,
  saveSystemBrief,
  createSystemSnapshot,
  validateSystemId,
  validateSystemBrief,
  saveFindingReport,
  getFindingReport,
  withFindingReportGeneration,
  findingReportFilename,
} from './storage.ts';
import { buildRunEvidence, generateReport, type ExplanationMode, type ExplanationTransport } from './explanations/index.ts';
import { metaExplanationTransport } from './explanations/meta-transport.ts';
import { challengeFinding, getChallengeView } from './challenges/index.ts';
import {
  SystemIntegrityError,
  SystemConflictError,
  SystemNotFoundError,
  SystemRevisionConflictError,
  SystemLockTimeoutError,
  SystemLockReleaseError,
} from './systems/index.ts';

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
  systemsDir?: string;
  investigationRunner?: (options: InvestigationOptions) => Promise<InvestigationRecord>;
  providerFactory?: (kind: ProviderKind) => ExperimentProvider;
  explanationTransport?: ExplanationTransport;
  challengeTransport?: ExplanationTransport;
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
  private systemsDir: string;
  private publicDir: string;
  private distDir: string;
  private runnerOverride?: (options: InvestigationOptions) => Promise<InvestigationRecord>;
  private providerFactoryOverride?: (kind: ProviderKind) => ExperimentProvider;
  private explanationTransportOverride?: ExplanationTransport;
  private challengeTransportOverride?: ExplanationTransport;
  private explanationInFlight = new Set<string>();

  constructor(options: ServerOptions = {}) {
    this.runsDir = options.runsDir || 'runs';
    this.systemsDir = options.systemsDir || path.join(this.runsDir, 'systems');
    this.publicDir = options.publicDir || path.resolve(process.cwd(), 'public');
    this.distDir = options.distDir || path.resolve(process.cwd(), 'dist');
    this.runnerOverride = options.investigationRunner;
    this.providerFactoryOverride = options.providerFactory;
    this.explanationTransportOverride = options.explanationTransport;
    this.challengeTransportOverride = options.challengeTransport;
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

  private async serveFile(res: http.ServerResponse, filePath: string, contentType: string): Promise<boolean> {
    try {
      const content = await fs.readFile(filePath);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': content.length,
        'Cache-Control': 'no-cache',
      });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
    return true;
  }

  private async serveStatic(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string
  ): Promise<boolean> {
    // Explicit allowlist of static files only - strictly no path traversal
    if (pathname === '/') {
      return this.serveFile(res, path.join(this.publicDir, 'homepage.html'), 'text/html; charset=utf-8');
    }
    if (pathname === '/homepage.css') {
      return this.serveFile(res, path.join(this.publicDir, 'homepage.css'), 'text/css; charset=utf-8');
    }
    if (pathname === '/how-it-works') {
      return this.serveFile(res, path.join(this.publicDir, 'how-it-works.html'), 'text/html; charset=utf-8');
    }
    if (pathname === '/how-it-works.css') {
      return this.serveFile(res, path.join(this.publicDir, 'how-it-works.css'), 'text/css; charset=utf-8');
    }
    if (pathname === '/assets/homepage/market-fabric.png') {
      return this.serveFile(res, path.join(this.publicDir, 'assets', 'homepage', 'market-fabric.png'), 'image/png');
    }
    if (pathname === '/assets/homepage/market-grid.png') {
      return this.serveFile(res, path.join(this.publicDir, 'assets', 'homepage', 'market-grid.png'), 'image/png');
    }
    if (pathname === '/workspace' || pathname === '/index.html') {
      return this.serveFile(res, path.join(this.publicDir, 'index.html'), 'text/html; charset=utf-8');
    }
    if (pathname === '/styles.css') {
      return this.serveFile(res, path.join(this.publicDir, 'styles.css'), 'text/css; charset=utf-8');
    }

    const jsMatch = pathname.match(/^\/([a-zA-Z0-9_-]+\.(?:js|js\.map))$/);
    if (jsMatch) {
      const fileName = jsMatch[1]!;
      // This pure identity helper is shared by the replay engine and browser.
      // Expose only that shared module, not arbitrary server-side output.
      const primaryPath = fileName === 'experiment-identity.js'
        ? path.join(this.distDir, fileName)
        : path.join(this.distDir, 'web', fileName);
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
            targetVariants: TARGET_VARIANTS,
            targetVariantsByAdapter: Object.fromEntries(listRegisteredAdapters().map((adapterId) => [adapterId, [...resolveAdapter(adapterId).variants]])),
          });
          return;
        }

        // GET /api/contract - Public system contract (never exposes secrets or hidden keys)
        if (method === 'GET' && pathname === '/api/contract') {
          try {
            const adapterId = new URL(req.url || '/', 'http://localhost').searchParams.get('adapterId') ?? 'synthetic-trading';
            const sim = adapterId === 'synthetic-trading' ? await getSimulatorApi() : resolveAdapter(adapterId);
            // In simulator/contract.ts or index.ts
            const contract = sim.getContract ? sim.getContract() : { name: 'ChaosPilot Gateway' };
            this.sendJson(res, 200, contract);
          } catch {
            this.sendJson(res, 503, { error: 'Simulator contract unavailable' });
          }
          return;
        }

        // GET /api/targets - Supported public target variants
        if (method === 'GET' && pathname === '/api/targets') {
          const adapterId = new URL(req.url || '/', 'http://localhost').searchParams.get('adapterId') ?? 'synthetic-trading';
          try { this.sendJson(res, 200, resolveAdapter(adapterId).variants); }
          catch (error) { this.sendJson(res, 400, { error: String(error) }); }
          return;
        }

        // GET /api/systems - List all system briefs
        if (method === 'GET' && pathname === '/api/systems') {
          try {
            const briefs = await listSystemBriefs(this.systemsDir);
            this.sendJson(res, 200, briefs);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (err instanceof SystemLockTimeoutError || err instanceof SystemLockReleaseError) {
              this.sendJson(res, 503, { error: msg });
            } else {
              this.sendJson(res, 500, { error: msg });
            }
          }
          return;
        }

        // POST /api/systems - Create a new system brief
        if (method === 'POST' && pathname === '/api/systems') {
          const contentType = req.headers['content-type'] || '';
          if (!contentType.toLowerCase().includes('application/json')) {
            this.sendJson(res, 415, { error: 'Content-Type must be application/json' });
            return;
          }
          const { data, error, status } = await this.readJsonBody(req);
          if (error) {
            this.sendJson(res, status || 400, { error });
            return;
          }
          const validated = validateSystemBrief(data);
          if (!validated.valid) {
            this.sendJson(res, 400, { error: validated.error });
            return;
          }
          try {
            const saved = await saveSystemBrief(validated.brief, this.systemsDir, { mode: 'create' });
            this.sendJson(res, 201, saved);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (err instanceof SystemLockTimeoutError || err instanceof SystemLockReleaseError) {
              this.sendJson(res, 503, { error: msg });
            } else if (err instanceof SystemConflictError || msg.includes('already exists')) {
              this.sendJson(res, 409, { error: msg });
            } else if (err instanceof SystemIntegrityError) {
              this.sendJson(res, 500, { error: msg });
            } else {
              this.sendJson(res, 400, { error: msg });
            }
          }
          return;
        }

        // System routes with ID: /api/systems/:id and /api/systems/:id/snapshot
        const systemMatch = pathname.match(/^\/api\/systems\/([a-zA-Z0-9_-]+)$/);
        const snapshotMatch = pathname.match(/^\/api\/systems\/([a-zA-Z0-9_-]+)\/snapshot$/);

        if (method === 'GET' && snapshotMatch && snapshotMatch[1]) {
          const id = snapshotMatch[1];
          if (!validateSystemId(id)) {
            this.sendJson(res, 400, { error: 'Invalid system ID' });
            return;
          }
          try {
            const brief = await getSystemBrief(id, this.systemsDir);
            if (!brief) {
              this.sendJson(res, 404, { error: 'System brief not found' });
              return;
            }
            const snapshot = await createSystemSnapshot(brief);
            this.sendJson(res, 200, snapshot);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (err instanceof SystemIntegrityError) {
              this.sendJson(res, 500, { error: msg });
            } else {
              this.sendJson(res, 500, { error: msg });
            }
          }
          return;
        }

        if (method === 'GET' && systemMatch && systemMatch[1]) {
          const id = systemMatch[1];
          if (!validateSystemId(id)) {
            this.sendJson(res, 400, { error: 'Invalid system ID' });
            return;
          }
          try {
            const brief = await getSystemBrief(id, this.systemsDir);
            if (!brief) {
              this.sendJson(res, 404, { error: 'System brief not found' });
              return;
            }
            this.sendJson(res, 200, brief);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (err instanceof SystemIntegrityError) {
              this.sendJson(res, 500, { error: msg });
            } else {
              this.sendJson(res, 500, { error: msg });
            }
          }
          return;
        }

        if (method === 'PUT' && systemMatch && systemMatch[1]) {
          const id = systemMatch[1];
          if (!validateSystemId(id)) {
            this.sendJson(res, 400, { error: 'Invalid system ID' });
            return;
          }
          const contentType = req.headers['content-type'] || '';
          if (!contentType.toLowerCase().includes('application/json')) {
            this.sendJson(res, 415, { error: 'Content-Type must be application/json' });
            return;
          }
          const { data, error, status } = await this.readJsonBody(req);
          if (error) {
            this.sendJson(res, status || 400, { error });
            return;
          }
          const bodyObj = (data || {}) as Record<string, unknown>;
          if (bodyObj.id !== id) {
            this.sendJson(res, 400, { error: 'System ID in payload must match URL path' });
            return;
          }
          const validated = validateSystemBrief(data);
          if (!validated.valid) {
            this.sendJson(res, 400, { error: validated.error });
            return;
          }
          try {
            const saved = await saveSystemBrief(validated.brief, this.systemsDir, {
              mode: 'update',
              expectedRevision: typeof bodyObj.revision === 'number' ? bodyObj.revision : undefined,
            });
            this.sendJson(res, 200, saved);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (err instanceof SystemLockTimeoutError || err instanceof SystemLockReleaseError) {
              this.sendJson(res, 503, { error: msg });
            } else if (err instanceof SystemNotFoundError || msg.includes('not found')) {
              this.sendJson(res, 404, { error: msg });
            } else if (err instanceof SystemRevisionConflictError || msg.includes('Revision conflict')) {
              this.sendJson(res, 409, { error: msg });
            } else if (err instanceof SystemIntegrityError) {
              this.sendJson(res, 500, { error: msg });
            } else {
              this.sendJson(res, 400, { error: msg });
            }
          }
          return;
        }

        // Read-only assessment: no run creation, provider call or ledger reservation.
        if (method === 'POST' && pathname === '/api/investigation/preflight') {
          if (!(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
            this.sendJson(res, 415, { error: 'Preflight requires application/json' });
            return;
          }
          const parsed = await this.readJsonBody(req);
          if (parsed.error) { this.sendJson(res, parsed.status || 400, { error: parsed.error }); return; }
          const body = (parsed.data ?? {}) as Record<string, unknown>;
          if (body.provider === 'mock') {
            this.sendJson(res, 200, { mode: 'mock', assessment: 'not_applicable' });
            return;
          }
          if (body.provider !== 'meta' || typeof body.systemId !== 'string' || !validateSystemId(body.systemId)
            || !Number.isSafeInteger(body.expectedRevision) || !isKnownTargetVariant(body.variant as TargetVariant)) {
            this.sendJson(res, 400, { error: 'Select a saved system revision, supported target and provider for preflight.' });
            return;
          }
          try {
            // Unlike getSystemBrief, this never seeds missing records on disk.
            const brief = await readSystemBriefFile(resolveSystemPath(this.systemsDir, body.systemId), body.systemId);
            if (brief.revision !== body.expectedRevision) {
              this.sendJson(res, 409, { error: 'System revision changed. Reload the saved profile to reassess request size.' });
              return;
            }
            const variant = body.variant as TargetVariant;
            assertAdapterVariant(brief.adapterId, variant);
            const adapter = resolveAdapter(brief.adapterId);
            const snapshot = await createSystemSnapshot(brief);
            // Custom factories may have different serialization; never claim a default assessment for them.
            if (this.providerFactoryOverride) {
              this.sendJson(res, 503, { error: 'Request preflight unavailable for a custom provider factory.' });
              return;
            }
            const prepared = new MetaProvider().prepareRequest({
              contract: adapter.getContract(), source: adapter.getSourceBundle(variant),
              history: [], experimentNumber: 1,
              maxExperiments: Math.min(Math.max(1, Math.floor(Number(body.maxExperiments) || 5)), 20),
              systemBrief: snapshot
            });
            const headroomBytes = prepared.maxPromptBytes - prepared.promptBytes;
            this.sendJson(res, 200, {
              mode: 'live', systemId: brief.id, revision: brief.revision, adapterId: brief.adapterId, variant,
              requestBytes: prepared.promptBytes, limitBytes: prepared.maxPromptBytes,
              maxOutputTokens: prepared.maxOutputTokens, headroomBytes,
              assessment: headroomBytes < 0 ? 'over_limit' : headroomBytes <= prepared.maxPromptBytes * 0.2 ? 'near_limit' : 'fits'
            });
          } catch {
            // Do not expose source, prompt, environment values or credentials through diagnostics.
            this.sendJson(res, 422, { error: 'Request preflight unavailable. Check the saved system revision, adapter, target and server model configuration.' });
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
          const cancelledStart = new Promise<{ data?: unknown; error: string; status: number; code?: string }>(resolve => {
            onStartAbort = () => resolve({ error: 'Investigation start cancelled', status: 409, code: 'START_CANCELLED' });
            abortController.signal.addEventListener('abort', onStartAbort, { once: true });
          });
          try {
            const raced = await Promise.race([this.readJsonBody(req), cancelledStart]);
            const { data, error, status } = raced;
            if (error) {
              this.sendJson(res, status || 400, { error, ...('code' in raced && raced.code ? { code: raced.code } : {}) });
              return;
            }

            const body = (data || {}) as Record<string, unknown>;
            const variant = (body.variant as TargetVariant) || 'candidate-a';
            const providerKind = (body.provider as ProviderKind) || 'mock';
            const maxExperiments = Math.min(
              Math.max(Math.floor(Number(body.maxExperiments) || 5), 1),
              20
            );
            if (body.continueAfterFindings !== undefined && typeof body.continueAfterFindings !== 'boolean') {
              this.sendJson(res, 400, { error: 'continueAfterFindings must be a boolean' });
              return;
            }
            const continueAfterFindings = body.continueAfterFindings === true;

            if (!isKnownTargetVariant(variant)) {
              this.sendJson(res, 400, { error: `Invalid target variant: "${String(variant)}"` });
              return;
            }

            // System brief snapshot resolution
            const systemId = typeof body.systemId === 'string' && body.systemId.trim()
              ? body.systemId.trim()
              : 'trading-gateway';

            if (!validateSystemId(systemId)) {
              this.sendJson(res, 400, { error: `Invalid system ID: "${systemId}"` });
              return;
            }

            let brief: SystemBrief | null = null;
            try {
              brief = await getSystemBrief(systemId, this.systemsDir);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (err instanceof SystemIntegrityError) {
                this.sendJson(res, 500, { error: msg });
                return;
              }
              this.sendJson(res, 500, { error: msg });
              return;
            }
            if (!brief) {
              this.sendJson(res, 404, { error: `System brief "${systemId}" not found` });
              return;
            }

            if (
              typeof body.expectedRevision === 'number' &&
              brief.revision !== body.expectedRevision
            ) {
              this.sendJson(res, 409, {
                error: `Revision conflict: expected revision ${body.expectedRevision}, but current is ${brief.revision}`,
              });
              return;
            }

            if (brief.adapterId === 'unconfigured') {
              this.sendJson(res, 400, {
                error: `Cannot launch investigation: System brief "${brief.name}" has unconfigured adapter.`,
              });
              return;
            }

            try { assertAdapterVariant(brief.adapterId, variant); }
            catch (error) { this.sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) }); return; }
            const systemSnapshot = await createSystemSnapshot(brief);

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
              this.sendJson(res, 409, { error: 'Investigation start cancelled', code: 'START_CANCELLED' });
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
                  continueAfterFindings,
                  provider,
                  signal: abortController.signal,
                  systemBrief: structuredClone(systemSnapshot),
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
              continueAfterFindings,
              systemBrief: {
                id: systemSnapshot.brief.id,
                name: systemSnapshot.brief.name,
                revision: systemSnapshot.brief.revision,
                hash: systemSnapshot.hash,
              },
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

        // POST /api/runs/:id/experiments/:position/replay - Replay one saved experiment by array position
        const selectedReplayMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/experiments\/([^/]+)\/replay$/);
        if (method === 'POST' && selectedReplayMatch && selectedReplayMatch[1]) {
          const id = selectedReplayMatch[1];
          if (!validateRunId(id)) {
            this.sendJson(res, 400, { error: 'Invalid run ID' });
            return;
          }
          const position = parseExperimentPosition(selectedReplayMatch[2]);
          if (position === null) {
            this.sendJson(res, 400, { error: 'Invalid experiment position' });
            return;
          }
          try {
            const report = await replaySelectedExperiment(id, position, this.runsDir);
            this.sendJson(res, 200, report);
          } catch (err) {
            this.sendJson(res, 400, {
              error: err instanceof Error ? err.message : 'Replay failed',
            });
          }
          return;
        }

        // POST /api/runs/:id/replay - Replay specific run deterministically
        const challengeMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/challenges$/);
        if (challengeMatch && (method === 'GET' || method === 'POST')) {
          const id = challengeMatch[1]!;
          if (!validateRunId(id)) { this.sendJson(res, 400, { error: 'Invalid run ID' }); return; }
          const controller = new AbortController();
          const disconnected = () => { if (!res.writableEnded) controller.abort(new DOMException('Challenge cancelled by client disconnect', 'AbortError')); };
          res.once('close', disconnected);
          try {
            if (!(await getRun(id, this.runsDir))) { this.sendJson(res, 404, { error: 'Saved run not found' }); return; }
            if (method === 'GET') {
              const findingId = url.searchParams.get('findingId');
              if (!findingId || findingId.length > 256) { this.sendJson(res, 400, { error: 'A unique findingId is required' }); return; }
              this.sendJson(res, 200, await getChallengeView(id, findingId, this.runsDir));
              return;
            }
            if (!(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) { this.sendJson(res, 415, { error: 'Content-Type must be application/json' }); return; }
            const body = await this.readJsonBody(req);
            if (body.error) { this.sendJson(res, body.status ?? 400, { error: body.error }); return; }
            const data = body.data as Record<string, unknown> | null;
            if (!data || Array.isArray(data) || data.mode !== 'meta' || typeof data.findingId !== 'string' || !data.findingId || data.findingId.length > 256
              || typeof data.expectedEvidenceHash !== 'string' || !data.expectedEvidenceHash
              || typeof data.expectedRunRevision !== 'string' || !data.expectedRunRevision
              || (data.interpret !== undefined && typeof data.interpret !== 'boolean')
              || Object.keys(data).some(k => !['mode', 'findingId', 'interpret', 'expectedEvidenceHash', 'expectedRunRevision'].includes(k))) {
              this.sendJson(res, 400, { error: 'Explicit mode: meta, findingId and the selected saved evidence identity are required. interpret must be boolean. This action uses the paid Meta API.' }); return;
            }
            if (this.activeInvestigation?.id === id) { this.sendJson(res, 409, { error: 'Wait for the terminal run to finish saving' }); return; }
            const result = await challengeFinding(id, data.findingId, {
              runsDir: this.runsDir, transport: this.challengeTransportOverride, signal: controller.signal,
              interpret: data.interpret !== false, expectedEvidenceHash: data.expectedEvidenceHash, expectedRunRevision: data.expectedRunRevision,
            });
            this.sendJson(res, result.status === 'completed' ? 201 : result.status === 'cancelled' ? 409 : 422, result);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.sendJson(res, /already being generated|deleted|changed|terminal|saving/.test(msg) ? 409 : /Missing MODEL_API_KEY/.test(msg) ? 503 : 422, { error: msg });
          } finally { res.off('close', disconnected); }
          return;
        }

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

        // Finding explanation report: status / generate / retrieve (exact saved run only)
        const reportMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/explanation-report$/);
        const reportStatusMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/explanation-report\/status$/);
        if ((method === 'GET' && (reportStatusMatch || reportMatch)) || (method === 'POST' && reportMatch)) {
          const id = (reportStatusMatch ?? reportMatch)![1]!;
          if (!validateRunId(id)) { this.sendJson(res, 400, { error: 'Invalid run ID' }); return; }
          const record = await getRun(id, this.runsDir);
          if (!record) { this.sendJson(res, 404, { error: 'Run not found. A saved report is never served for a deleted or missing run.' }); return; }
          const saved = await getFindingReport(id, this.runsDir);
          const refreshed = await getRun(id, this.runsDir);
          if (!refreshed) { this.sendJson(res, 404, { error: 'Run no longer exists.' }); return; }
          const current = buildRunEvidence(refreshed);
          const stale = Boolean(saved && saved.meta.evidenceHash !== current.evidenceHash);
          if (method === 'GET' && reportStatusMatch) {
            this.sendJson(res, 200, { exists: Boolean(saved), stale, inFlight: this.explanationInFlight.has(id), terminal: refreshed.status !== 'running', status: refreshed.status, findingsCount: refreshed.findings.length, ...(saved ? { generatedAt: saved.meta.generatedAt, mode: saved.meta.mode, model: saved.meta.model, evidenceHash: saved.meta.evidenceHash } : {}), runId: id, currentEvidenceHash: current.evidenceHash });
            return;
          }
          if (method === 'GET' && reportMatch) {
            if (!saved) { this.sendJson(res, 404, { error: 'No saved findings report for this run yet.' }); return; }
            if (stale) { this.sendJson(res, 409, { error: 'Saved report is stale: the run evidence has changed since it was generated. Create a new report; stale evidence is not presented as current.' }); return; }
            const download = url.searchParams.get('download') === '1';
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(saved.html), 'Cache-Control': 'no-store', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', ...(download ? { 'Content-Disposition': `attachment; filename="${findingReportFilename(id)}"` } : { 'Content-Disposition': `inline; filename="${findingReportFilename(id)}"` }) });
            res.end(saved.html);
            return;
          }
          // POST generate
          if (record.status === 'running' || (this.activeInvestigation?.id === id)) { this.sendJson(res, 409, { error: 'Run is still running and has not been saved as a terminal run. Wait for it to finish before creating a report.' }); return; }
          if (!record.findings.length) { this.sendJson(res, 400, { error: 'This run has no recorded findings, so no findings report can be created. No finding was fabricated.' }); return; }
          if (this.explanationInFlight.has(id)) { this.sendJson(res, 409, { error: 'A findings report is already being generated for this run.' }); return; }
          const ct = req.headers['content-type'] || '';
          if (!ct.toLowerCase().includes('application/json')) { this.sendJson(res, 415, { error: 'Content-Type must be application/json' }); return; }
          const { data, error, status } = await this.readJsonBody(req);
          if (error) { this.sendJson(res, status || 400, { error }); return; }
          const mode = ((data ?? {}) as Record<string, unknown>).mode;
          if (mode !== 'meta' && mode !== 'offline') { this.sendJson(res, 400, { error: 'mode must be "meta" (calls Muse via the Meta API and incurs usage) or "offline" (scripted, no model call).' }); return; }
          // Body consumption yields: claim again after it, before any model call.
          if (this.explanationInFlight.has(id)) { this.sendJson(res, 409, { error: 'A findings report is already being generated for this run.' }); return; }
          this.explanationInFlight.add(id);
          const controller = new AbortController();
          const disconnected = () => { if (!res.writableEnded) controller.abort(new DOMException('Report request disconnected', 'AbortError')); };
          res.once?.('close', disconnected);
          try {
            await withFindingReportGeneration(id, this.runsDir, async () => {
              // Source may have changed while the request body or generation lease was read.
              const source = await getRun(id, this.runsDir);
              if (!source || source.status === 'running' || !source.findings.length || buildRunEvidence(source).evidenceHash !== current.evidenceHash) throw new Error('Run was deleted or run evidence changed. Reload the saved run before creating a report.');
              let transport: ExplanationTransport | undefined;
              if (mode === 'meta') {
                transport = this.explanationTransportOverride ?? metaExplanationTransport();
              }
              const generatedAt = new Date().toISOString();
              const generated = await generateReport(source, { mode: mode as ExplanationMode, transport, signal: controller.signal, generatedAt });
              // Recheck exact run/evidence before saving; protects existing report on failure/staleness.
              const again = await getRun(id, this.runsDir);
              if (!again) { this.sendJson(res, 409, { error: 'Run was deleted while the report was generating. No report was saved.' }); return; }
              if (buildRunEvidence(again).evidenceHash !== current.evidenceHash) { this.sendJson(res, 409, { error: 'Run evidence changed while the report was generating. No report was saved; create it again from the current evidence.' }); return; }
              const meta = { runId: id, evidenceHash: generated.evidence.evidenceHash, generatedAt, mode: mode as ExplanationMode, model: generated.model, findingIds: generated.evidence.findings.map(f => f.findingId) };
              controller.signal.throwIfAborted();
              await saveFindingReport(id, generated.html, meta, this.runsDir, controller.signal);
              this.sendJson(res, 201, { ...meta, findingsCount: meta.findingIds.length, usage: generated.usage ?? null });
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const statusCode = /already being generated|deleted|evidence changed/.test(msg) ? 409 : /Missing MODEL_API_KEY/.test(msg) ? 503 : /exceeds maximum|oversize/.test(msg) ? 413 : 422;
            this.sendJson(res, statusCode, { error: msg });
          } finally { res.off?.('close', disconnected); this.explanationInFlight.delete(id); }
          return;
        }

        // DELETE /api/runs/:id - Delete run
        if (method === 'DELETE' && runMatch && runMatch[1]) {
          const id = runMatch[1];
          if (!validateRunId(id)) {
            this.sendJson(res, 400, { error: 'Invalid run ID' });
            return;
          }
          if (this.explanationInFlight.has(id)) { this.sendJson(res, 409, { error: 'A findings report is being generated for this run. Wait for it to finish before deleting the run.' }); return; }
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
