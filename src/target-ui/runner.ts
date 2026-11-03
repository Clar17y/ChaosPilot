import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Browser, Page } from 'puppeteer-core';
import type { TargetVariant } from '../domain.ts';
import { startTarget, type TargetHandle } from '../target-api/target.ts';
import { evaluateTargetUiJourney, type EvaluationResult } from './evaluator.ts';
import { createSeededUiProvenance } from './provenance.ts';
import { validObservation } from './validation.ts';
import type { TargetUiEvidence, TargetUiObservationRecord, TargetUiProvenance, TargetUiWireExchange } from './types.ts';

export interface RunBrowserJourneyOptions {
  variant?: TargetVariant;
  screenshotsDir?: string;
  convergenceDeadlineMs?: number;
  freshnessThresholdMs?: number;
  timeoutMs?: number;
  provenance?: TargetUiProvenance;
  signal?: AbortSignal;
}

export interface BrowserJourneyOutcome {
  evidence: TargetUiEvidence;
  evaluation: EvaluationResult;
  screenshots: { phase: string; path: string }[];
}

export function findBrowserExecutable(): string | null {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.EDGE_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean) as string[];
  return candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } }) ?? null;
}

type RunErrorKind = NonNullable<TargetUiEvidence['runError']>['kind'];
class JourneyError extends Error {
  constructor(readonly kind: RunErrorKind, message: string) { super(message); }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface DomRead {
  nowMs: number;
  orderId: string; businessStatus: string; transportStatus: string;
  receiptId: string; receiptSeq: string;
  quantity: string; filledQuantity: string; remainingQuantity: string;
  freshnessLabel: string; freshnessStale: boolean; ageText: string;
  instanceId: string; requestId: string; appliedSequence: number; freshnessThresholdMs: number;
  upstreamProcessed: number; upstreamQueued: number;
}

async function readDom(page: Page): Promise<DomRead> {
  return page.evaluate(() => {
    const text = (id: string) => document.getElementById(id)?.textContent?.trim() ?? '';
    const badge = document.getElementById('badge-freshness');
    const ctrl = (window as any).__TARGET_UI__;
    const state = ctrl?.getState?.() ?? {};
    const evidence = ctrl?.getEvidence?.() ?? {};
    const upstream = text('display-upstream').match(/P:\s*(\d+)\s*\/\s*Q:\s*(\d+)/);
    return {
      nowMs: performance.now(),
      orderId: text('disp-order-id'),
      businessStatus: text('disp-business-status-text'),
      transportStatus: text('disp-transport-status'),
      receiptId: text('disp-receipt-id'),
      receiptSeq: text('disp-receipt-seq'),
      quantity: text('disp-requested-qty'),
      filledQuantity: text('disp-filled-qty'),
      remainingQuantity: text('disp-remaining-qty'),
      freshnessLabel: badge?.textContent?.trim() ?? '',
      freshnessStale: badge?.classList.contains('badge-stale') ?? false,
      ageText: text('display-age'),
      instanceId: evidence.instanceId ?? state.instanceId ?? '',
      requestId: evidence.requestId ?? state.trackedRequestId ?? '',
      appliedSequence: state.freshness?.lastAppliedSequence ?? 0,
      freshnessThresholdMs: state.freshness?.freshnessThresholdMs ?? 0,
      upstreamProcessed: upstream ? Number(upstream[1]) : 0,
      upstreamQueued: upstream ? Number(upstream[2]) : 0,
    };
  });
}

function toObservation(phase: string, dom: DomRead, fallback: { instanceId: string; requestId: string }): TargetUiObservationRecord {
  const qty = Number(dom.quantity), filled = Number(dom.filledQuantity), remaining = Number(dom.remainingQuantity);
  const seq = dom.receiptSeq.replace(/^#/, '');
  const validOrder = dom.orderId && dom.orderId !== 'No Order Submitted'
    && ['IDLE', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'ERROR'].includes(dom.businessStatus)
    && ['NONE', 'QUEUED', 'ACKNOWLEDGED', 'FAILED'].includes(dom.transportStatus)
    && [qty, filled, remaining].every(v => Number.isSafeInteger(v) && v >= 0);
  return {
    phase,
    timestampMs: dom.nowMs,
    domOrder: validOrder ? {
      orderId: dom.orderId,
      transportStatus: dom.transportStatus.toLowerCase() as any,
      transportReceiptId: dom.receiptId === '-' || !dom.receiptId ? null : dom.receiptId,
      transportSequence: seq === '-' || !seq ? null : Number(seq),
      businessStatus: dom.businessStatus as any,
      quantity: qty, filledQuantity: filled, remainingQuantity: remaining,
    } : null,
    domFreshness: {
      status: dom.freshnessStale ? 'stale' : 'fresh',
      reason: dom.freshnessStale ? (dom.freshnessLabel.includes('HELD') ? 'held' : 'age-exceeded') : 'none',
      label: dom.freshnessLabel || (dom.freshnessStale ? 'STALE' : 'FRESH'),
      ageMs: Number(dom.ageText.replace(/ms$/, '')) || 0,
    },
    upstreamProcessed: dom.upstreamProcessed,
    upstreamQueued: dom.upstreamQueued,
    instanceId: dom.instanceId || fallback.instanceId,
    requestId: dom.requestId || fallback.requestId,
    appliedSequence: dom.appliedSequence,
    freshnessThresholdMs: dom.freshnessThresholdMs,
  };
}

/**
 * Real browser journey. Journey failures (missing browser, timeout, abort,
 * transport loss, DOM mismatch) return classified partial evidence with
 * cleanup instead of throwing away what was recorded.
 */
export async function runTargetUiBrowserJourney(options: RunBrowserJourneyOptions = {}): Promise<BrowserJourneyOutcome> {
  const variant = options.variant ?? 'clean';
  const convergenceDeadlineMs = options.convergenceDeadlineMs ?? 5000;
  const freshnessThresholdMs = options.freshnessThresholdMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 25_000;
  for (const [name, v] of [['convergenceDeadlineMs', convergenceDeadlineMs], ['freshnessThresholdMs', freshnessThresholdMs], ['timeoutMs', timeoutMs]] as const) {
    if (!Number.isSafeInteger(v) || v <= 0 || v > 120_000) throw new Error(`Invalid ${name}`);
  }
  const provenance = options.provenance ?? await createSeededUiProvenance(variant);
  const runId = `ui-journey-${randomUUID().slice(0, 8)}`;
  const screenshotsDir = path.join(options.screenshotsDir ?? path.resolve(process.cwd(), '.llm-output/issue13-repair/screenshots'), runId);
  const startedAt = new Date().toISOString();
  const overallDeadline = Date.now() + timeoutMs;
  const screenshots: { phase: string; path: string }[] = [];
  const observations: TargetUiObservationRecord[] = [];
  const runnerExchanges: TargetUiWireExchange[] = [];
  let browserEvidence: any = null;
  let finalEvents: any[] = [];
  let target: TargetHandle | undefined;
  let browser: Browser | undefined;
  let journeyPage: Page | undefined;
  let endpoint = '', instanceId = '', orderRequestId = '', resumeAtMs: number | undefined;
  let runError: TargetUiEvidence['runError'];

  const remaining = () => overallDeadline - Date.now();
  const guard = () => {
    if (options.signal?.aborted) throw new JourneyError('cancelled', `Aborted: ${String(options.signal.reason ?? 'cancelled')}`);
    if (remaining() <= 0) throw new JourneyError('timeout', `Overall journey deadline of ${timeoutMs}ms exceeded`);
  };
  const opTimeout = (cap: number) => Math.max(1, Math.min(cap, remaining()));

  try {
    await fsp.mkdir(screenshotsDir, { recursive: true });
    const executablePath = findBrowserExecutable();
    if (!executablePath) throw new JourneyError('browser', 'No Chrome or Edge executable found (checked CHROME_BIN/EDGE_BIN and standard install paths)');
    guard();
    target = await startTarget({ variant, processingDelayMs: 15, uiContext: { provenance, thresholds: { freshnessThresholdMs, convergenceDeadlineMs } } });
    endpoint = target.endpoint;
    instanceId = target.instanceId;
    const puppeteer = (await import('puppeteer-core')).default;
    try {
      browser = await puppeteer.launch({ executablePath, headless: true, args: ['--disable-dev-shm-usage', '--disable-gpu'], defaultViewport: { width: 1280, height: 900 }, timeout: opTimeout(15_000) });
    } catch (err) {
      throw new JourneyError('browser', `Browser launch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const page = await browser.newPage();
    journeyPage = page;
    const browserNow = async () => page.evaluate(() => performance.now());
    const snap = async (phase: string) => {
      const file = path.join(screenshotsDir, `${phase}.png`);
      await page.screenshot({ path: file as `${string}.png` });
      screenshots.push({ phase, path: file });
      browserEvidence = await page.evaluate(() => (window as any).__TARGET_UI__?.getEvidence() ?? null);
    };
    const nodeFetch = async (method: 'GET' | 'POST', p: string, body?: unknown) => {
      guard();
      const started = performance.now();
      let status = 0, data: unknown, error: string | undefined;
      try {
        const res = await fetch(`${endpoint}${p}`, {
          method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.any([AbortSignal.timeout(opTimeout(3000)), ...(options.signal ? [options.signal] : [])]),
        });
        status = res.status;
        try { data = await res.json(); } catch { data = undefined; }
      } catch (err) { error = err instanceof Error ? err.message : String(err); }
      runnerExchanges.push({ method, path: p, requestBody: body, responseStatus: status, responseBody: data, timestampMs: await browserNow(), elapsedMs: performance.now() - started, source: 'runner', error });
      if (error) throw new JourneyError(options.signal?.aborted ? 'cancelled' : 'transport', `Runner ${method} ${p} failed: ${error}`);
      return { status, data: data as any };
    };

    await page.goto(endpoint, { waitUntil: 'domcontentloaded', timeout: opTimeout(5000) });
    await page.waitForFunction(() => {
      const t = document.getElementById('display-instance-id')?.textContent?.trim();
      return t && t !== '-';
    }, { timeout: opTimeout(5000) });

    await page.click('#btn-submit-setup');
    await page.waitForFunction(() => document.getElementById('feedback-setup')?.textContent?.includes('queued'), { timeout: opTimeout(5000) });
    await page.waitForFunction(() => /P:\s*[1-9]/.test(document.getElementById('display-upstream')?.textContent ?? ''), { timeout: opTimeout(5000) });
    await snap('phase-1-setup');
    guard();

    await page.click('#btn-submit-order');
    // The controller reads the rendered DOM synchronously after the receipt is
    // displayed, before polling can replace QUEUED with the settled business state.
    // Consume that immutable capture rather than racing a transient visible label.
    await page.waitForFunction(() => (window as any).__TARGET_UI__?.getEvidence().uiObservations
      .some((o: TargetUiObservationRecord) => o.phase === 'after-order-transport'), { timeout: opTimeout(5000) });
    const transportObservation = await page.evaluate(() => (window as any).__TARGET_UI__.getEvidence().uiObservations
      .find((o: TargetUiObservationRecord) => o.phase === 'after-order-transport')) as TargetUiObservationRecord;
    orderRequestId = transportObservation.requestId ?? '';
    observations.push(transportObservation);
    await page.waitForFunction(() => document.getElementById('disp-business-status-text')?.textContent?.trim() === 'OPEN', { timeout: opTimeout(5000) });
    await snap('phase-2-order-open');
    guard();

    await page.click('#btn-toggle-hold');
    await page.waitForFunction(() => {
      const b = document.getElementById('badge-freshness');
      return b?.classList.contains('badge-stale') && b.textContent?.includes('STALE');
    }, { timeout: opTimeout(5000) });

    // Fill from the Node side; the exchange is recorded, then upstream FILLED is
    // proved by recorded GETs while the page is still held.
    const fill = await nodeFetch('POST', '/executions', { requestId: 'fill-req-1', kind: 'execution', orderId: 'order-1', executionId: 'exec-1', quantity: 10 });
    if (fill.status !== 202) throw new JourneyError('transport', `Direct executions request failed with HTTP ${fill.status}`);
    let upstreamFilled = false;
    while (Date.now() < overallDeadline) {
      guard();
      const { status, data } = await nodeFetch('GET', '/state');
      if (status === 200 && validObservation(data, instanceId, 0) && data.queued === 0 && data.orders['order-1']?.businessStatus === 'FILLED') { upstreamFilled = true; finalEvents = data.events; break; }
      if (status === 200 && data && !validObservation(data, instanceId, 0)) throw new JourneyError('transport', 'Malformed upstream observation while held');
      await sleep(40);
    }
    if (!upstreamFilled) throw new JourneyError('timeout', 'Upstream target did not reach FILLED while UI was held');

    const heldDom = await readDom(page);
    // Hemisphere check is recorded, not hidden: evaluator judges the observation.
    observations.push(toObservation('while-held', heldDom, { instanceId, requestId: orderRequestId }));
    await snap('phase-3-held-stale');
    guard();

    resumeAtMs = await page.evaluate(() => {
      const t = performance.now();
      (document.getElementById('btn-toggle-hold') as HTMLButtonElement).click();
      return t;
    });
    let converged = false;
    let lastDom: DomRead | undefined;
    while (true) {
      guard();
      lastDom = await readDom(page);
      if (lastDom.businessStatus === 'FILLED' && lastDom.filledQuantity === '10' && lastDom.remainingQuantity === '0' && !lastDom.freshnessStale) { converged = true; break; }
      if (lastDom.nowMs - resumeAtMs > convergenceDeadlineMs) break;
      await sleep(40);
    }
    if (lastDom) observations.push(toObservation('after-resume', lastDom, { instanceId, requestId: orderRequestId }));
    await snap('phase-4-resumed');
    if (!converged) throw new JourneyError('timeout', `DOM did not converge to FILLED within ${convergenceDeadlineMs}ms of resume`);

    const finalGet = await nodeFetch('GET', '/events');
    if (finalGet.status === 200 && validObservation(finalGet.data, instanceId, 0)) finalEvents = finalGet.data.events;
    browserEvidence = await page.evaluate(() => (window as any).__TARGET_UI__?.getEvidence() ?? null).catch(() => null);
  } catch (err) {
    runError = err instanceof JourneyError
      ? { kind: err.kind, message: err.message }
      : { kind: options.signal?.aborted ? 'cancelled' : 'browser', message: err instanceof Error ? err.message : String(err) };
    // Preserve whatever the browser recorded before the failure.
    if (journeyPage) {
      try {
        browserEvidence = await journeyPage.evaluate(() => (window as any).__TARGET_UI__?.getEvidence() ?? null) ?? browserEvidence;
      } catch { /* partial evidence stays partial */ }
    }
  } finally {
    if (browser) { try { await browser.close(); } catch { /* already gone */ } }
    if (target) { try { await target.close(); } catch { /* already gone */ } }
  }

  const exchanges = [...(Array.isArray(browserEvidence?.exchanges) ? browserEvidence.exchanges : []), ...runnerExchanges]
    .sort((a: TargetUiWireExchange, b: TargetUiWireExchange) => a.timestampMs - b.timestampMs);
  const orderExchange = exchanges.find((e: any) => e.method === 'POST' && e.path === '/orders');
  const evidence: TargetUiEvidence = {
    id: runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    variant,
    instanceId: instanceId || browserEvidence?.instanceId || '',
    endpoint,
    systemBriefId: provenance.systemSnapshot.brief.id,
    systemBriefRevision: provenance.systemSnapshot.brief.revision,
    sourceHash: provenance.sourceHash,
    provenance,
    resumeAtMs,
    runError,
    orderId: 'order-1',
    requestId: orderRequestId || browserEvidence?.requestId || orderExchange?.requestBody?.requestId || '',
    receiptId: browserEvidence?.receiptId ?? orderExchange?.responseBody?.receiptId ?? null,
    thresholds: { freshnessThresholdMs, convergenceDeadlineMs },
    exchanges,
    events: finalEvents.length ? finalEvents : (Array.isArray(browserEvidence?.events) ? browserEvidence.events : []),
    uiObservations: observations,
    status: 'inconclusive',
    classification: 'inconclusive-wire',
    reasons: [],
    screenshots,
  };
  const evaluation = evaluateTargetUiJourney(evidence);
  evidence.status = evaluation.status;
  evidence.classification = evaluation.classification;
  evidence.reasons = evaluation.reasons;
  if (evidence.finishedAt < evidence.startedAt) evidence.finishedAt = evidence.startedAt;
  return { evidence, evaluation, screenshots };
}
