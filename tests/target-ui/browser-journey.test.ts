import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { watch } from 'node:fs';
import { findBrowserExecutable, runTargetUiBrowserJourney } from '../../src/target-ui/runner.ts';
import { ChaosPilotServer } from '../../src/server.ts';
import { saveSystemBrief } from '../../src/storage.ts';
import { SEEDED_TRADING_BRIEF } from '../../src/systems/index.ts';

/**
 * Real-browser checks are opt-in: the default suite must not require an
 * installed Chrome/Edge. Set CHAOSPILOT_BROWSER_TESTS=1 (or run the dedicated
 * `npm run ui-journey` command); when opted in, a missing browser fails loudly.
 */
const enabled = process.env.CHAOSPILOT_BROWSER_TESTS === '1';

describe.skipIf(!enabled)('Real target UI browser journey (opt-in)', () => {
  it('requires a real browser executable when opted in', () => {
    expect(findBrowserExecutable(), 'Set CHROME_BIN/EDGE_BIN or install Chrome/Edge').toBeTruthy();
  });

  it('executes genuine browser UI -> HTTP API -> asynchronous event -> DOM convergence', async () => {
    const outcome = await runTargetUiBrowserJourney({
      variant: 'clean',
      convergenceDeadlineMs: 6000,
      freshnessThresholdMs: 2000,
    });
    expect(outcome.evaluation.status, outcome.evaluation.reasons.join('; ')).toBe('pass');
    expect(outcome.evaluation.classification).toBe('verified');
    expect(outcome.evidence.provenance?.systemSnapshot.brief.id).toBe(SEEDED_TRADING_BRIEF.id);
    expect(outcome.evidence.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.evidence.exchanges.some(e => e.path === '/executions' && e.source === 'runner')).toBe(true);
    const held = outcome.evidence.uiObservations.find(o => o.phase === 'while-held');
    expect(held?.domOrder?.businessStatus).toBe('OPEN');
    expect(held?.domFreshness).toMatchObject({ status: 'stale', reason: 'held' });
    const resumed = outcome.evidence.uiObservations.find(o => o.phase === 'after-resume');
    expect(resumed?.domOrder).toMatchObject({ businessStatus: 'FILLED', filledQuantity: 10, remainingQuantity: 0 });
    expect(outcome.screenshots.length).toBeGreaterThanOrEqual(4);
  }, 30_000);

  it.each([
    ['phase-1-setup.png', 1, false],
    ['phase-2-order-open.png', 2, false],
    ['phase-3-held-stale.png', 2, true],
  ] as const)('retains target-page evidence when cancelled after %s', async (phase, minimumPosts, filledWhileHeld) => {
    const outputRoot = path.resolve('.llm-output/issue13-browser-regressions');
    await fs.mkdir(outputRoot, { recursive: true });
    const output = await fs.mkdtemp(path.join(outputRoot, 'capture-'));
    const controller = new AbortController();
    const watcher = watch(output, { recursive: true }, (_event, filename) => {
      if (filename?.toString().endsWith(phase)) controller.abort(new Error(`Cancelled after ${phase}`));
    });
    try {
      const outcome = await runTargetUiBrowserJourney({ screenshotsDir: output, signal: controller.signal });
      expect(controller.signal.aborted).toBe(true);
      expect(outcome.evaluation.status, outcome.evaluation.reasons.join('; ')).toBe('cancelled');
      expect(outcome.evidence.exchanges.filter(e => e.method === 'POST' && e.source === 'browser').length).toBeGreaterThanOrEqual(minimumPosts);
      if (filledWhileHeld) {
        expect(outcome.evidence.exchanges.some(e => e.path === '/executions' && e.source === 'runner')).toBe(true);
        expect(outcome.evidence.uiObservations.some(o => o.phase === 'while-held')).toBe(true);
      }
    } finally { watcher.close(); }
  }, 30_000);
});

describe.skipIf(!enabled)('Workspace -> target page navigation in a real browser (opt-in)', () => {
  let app: ChaosPilotServer | undefined;
  let server: import('node:http').Server | undefined;
  let tempDir = '';

  afterEach(async () => {
    if (app && server) await app.shutdown(server);
    app = undefined; server = undefined;
    if (tempDir) { await fs.rm(tempDir, { recursive: true, force: true }); tempDir = ''; }
  });

  it('follows a same-site document link from the workspace origin to the target terminal', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'target-ui-nav-test-'));
    const systemsDir = path.join(tempDir, 'systems');
    await fs.mkdir(systemsDir, { recursive: true });
    await saveSystemBrief(SEEDED_TRADING_BRIEF, systemsDir, { mode: 'create' });
    app = new ChaosPilotServer({ runsDir: tempDir, systemsDir });
    server = app.createHttpServer();
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const workspace = `http://127.0.0.1:${(server!.address() as import('node:net').AddressInfo).port}`;
    const created = await fetch(`${workspace}/api/target-ui/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemId: SEEDED_TRADING_BRIEF.id, expectedRevision: SEEDED_TRADING_BRIEF.revision, variant: 'clean' }),
    });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as any;

    const executablePath = findBrowserExecutable();
    expect(executablePath).toBeTruthy();
    const puppeteer = (await import('puppeteer-core')).default;
    const browser = await puppeteer.launch({ executablePath: executablePath!, headless: true, args: ['--disable-dev-shm-usage', '--disable-gpu'] });
    try {
      const page = await browser.newPage();
      await page.goto(`${workspace}/workspace`, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      // Same-site cross-port document navigation, exactly like the workspace link.
      const [targetPage] = await Promise.all([
        new Promise<any>((resolve) => browser.once('targetcreated', async (t: any) => resolve(await t.page()))),
        page.evaluate((href: string) => {
          const a = document.createElement('a');
          a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'Open Target UI';
          document.body.appendChild(a);
          a.click();
        }, session.endpoint),
      ]);
      await targetPage.waitForSelector('#display-endpoint', { timeout: 10_000 });
      const heading = await targetPage.evaluate(() => document.querySelector('h1')?.textContent ?? '');
      expect(heading).toContain('SYNTHETIC TARGET TRADING TERMINAL');
      // The workspace origin still cannot fetch the target API cross-origin.
      const fetchBlocked = await page.evaluate(async (endpoint: string) => {
        try { const r = await fetch(`${endpoint}/events`); return r.status; } catch { return 'blocked'; }
      }, session.endpoint);
      expect(fetchBlocked === 'blocked' || fetchBlocked === 403).toBe(true);
    } finally {
      await browser.close();
    }
  }, 30_000);
});
