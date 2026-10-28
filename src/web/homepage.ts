import { HOMEPAGE_EVENTS, createTimeline, advanceTimeline, nextEvent, pauseTimeline, resumeTimeline, setReducedMotion, presentationFor, type TimelineState } from './homepage-events.ts';
import { drawScene, injectedTagPosition, interceptFor, pointOnLane, streamLanes } from './homepage-scene.ts';
import { advanceMarket, createMarket, getSnapshot } from './homepage-market.ts';
import { computeMarketTransform, copyExclusion, drawMarket, type CanvasRect, type MarketTransform } from './homepage-market-renderer.ts';

const $ = <T extends Element>(s: string) => document.querySelector<T>(s);

let state: TimelineState = createTimeline({
  reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  initialEventIndex: Math.floor(Math.random() * HOMEPAGE_EVENTS.length),
});
let rafId: number | null = null;
let lastTs = 0;
let visible = !document.hidden;
let onScreen = true;
let cachedW = 0;
let cachedH = 0;
let presentationKey = '';

const seedBuf = new Uint32Array(1);
window.crypto?.getRandomValues(seedBuf);
const market = createMarket((seedBuf[0] ?? 1) | 0);
let marketTransform: MarketTransform | null = null;
let lastMarketVersion = -1;
let marketW = 0;
let marketH = 0;
let marketExclusions: CanvasRect[] = [];
let copyDocumentBounds: CanvasRect | null = null;

const marketCanvas = $<HTMLCanvasElement>('#scene-market');
const back = $<HTMLCanvasElement>('#scene-back');
const front = $<HTMLCanvasElement>('#scene-front');
const titleEl = $<HTMLElement>('#event-title');
const explEl = $<HTMLElement>('#event-explanation');
const counterEl = $<HTMLElement>('#event-counter');
const incomingEl = $<HTMLElement>('#incoming-label');
const injectedEl = $<HTMLElement>('.tag-injected');
const outgoingEl = $<HTMLElement>('#outgoing-label');
const pauseBtn = $<HTMLButtonElement>('#btn-pause');
const nextBtn = $<HTMLButtonElement>('#btn-next');
const catalogEl = $<HTMLElement>('#event-catalog');
const statusEl = $<HTMLElement>('#event-status');

function announceManualChange(action: string) {
  if (!statusEl) return;
  const event = HOMEPAGE_EVENTS[state.eventIndex]!;
  statusEl.textContent = `${action}. Event ${state.eventIndex + 1} of ${HOMEPAGE_EVENTS.length}: ${event.title}. ${event.explanation} Input: ${event.incomingLabel}. Outcome: ${event.outgoingLabel}.`;
}

function syncCaption() {
  const p = presentationFor(state);
  const key = `${state.eventIndex}:${p.phase}`;
  if (presentationKey === key) return;
  presentationKey = key;
  if (titleEl) titleEl.textContent = p.title;
  if (explEl) explEl.textContent = p.explanation;
  if (counterEl) counterEl.textContent = p.counter;
  if (incomingEl) incomingEl.textContent = p.incomingLabel;
  if (outgoingEl) outgoingEl.textContent = p.outgoingLabel;
  if (injectedEl) injectedEl.textContent = p.isOutcome ? p.event.title : 'Injected message';
  const color = p.event.intervention === 'amber' ? 'var(--amber)' : 'var(--coral)';
  if (outgoingEl) { outgoingEl.style.color = color; outgoingEl.style.borderColor = color; }
  document.querySelector<HTMLElement>('.scene-bar')?.style.setProperty('--event-color', color);
  positionSceneLabels();
}

function positionSceneLabels() {
  if (!injectedEl || cachedW === 0 || cachedH === 0) return;
  // Measure only on resize/phase changes. Labels follow the scene while reserving
  // the complete copy area and clearance around previously placed labels.
  const scene = back?.getBoundingClientRect();
  if (!scene) return;
  const occupied: CanvasRect[] = [];
  for (const selector of ['.hero-copy', '.scene-bar']) {
    const protectedRect = $<HTMLElement>(selector)?.getBoundingClientRect();
    if (protectedRect) occupied.push({ x: protectedRect.left - scene.left, y: protectedRect.top - scene.top, w: protectedRect.width, h: protectedRect.height });
  }
  const intersects = (a: CanvasRect, b: CanvasRect) => a.x < b.x + b.w + 12 && a.x + a.w + 12 > b.x && a.y < b.y + b.h + 12 && a.y + a.h + 12 > b.y;
  const place = (el: HTMLElement | null, preferred: { x: number; y: number }) => {
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    const bound = (x: number, y: number): CanvasRect => ({ x: Math.max(8, Math.min(cachedW - w - 8, x)), y: Math.max(8, Math.min(cachedH - h - 8, y)), w, h });
    const candidates = [bound(preferred.x, preferred.y)];
    for (const dy of [0, 40, -40, 80, -80, 120, -120]) {
      for (const dx of [0, 100, -100, 200, -200]) candidates.push(bound(preferred.x + dx, preferred.y + dy));
    }
    for (const y of [0.08, 0.25, 0.42, 0.60, 0.76, 0.90]) {
      for (const x of [0, 0.25, 0.5, 0.75, 1]) candidates.push(bound(x * (cachedW - w - 16) + 8, y * cachedH));
    }
    candidates.sort((a, b) => Math.hypot(a.x - preferred.x, a.y - preferred.y) - Math.hypot(b.x - preferred.x, b.y - preferred.y));
    const chosen = candidates.find(a => occupied.every(b => !intersects(a, b))) ?? candidates[0]!;
    el.style.left = `${chosen.x}px`; el.style.top = `${chosen.y}px`; el.style.right = 'auto';
    occupied.push(chosen);
  };
  place(injectedEl, injectedTagPosition(state.eventIndex, cachedW, cachedH, injectedEl.offsetWidth, injectedEl.offsetHeight));
  const mobile = cachedW <= 700, tablet = cachedW <= 1100;
  place(incomingEl, { x: mobile || tablet ? 16 : cachedW * 0.31, y: cachedH * (mobile ? 0.80 : tablet ? 0.77 : 0.65) });
  const intercept = interceptFor(state.eventIndex, cachedW, cachedH);
  const event = HOMEPAGE_EVENTS[state.eventIndex]!;
  const endpoint = pointOnLane(streamLanes(cachedW, cachedH)[intercept.laneIndex]!, event.motif === 'reject' ? intercept.t + 0.05 : 0.93);
  place(outgoingEl, mobile ? { x: cachedW - (outgoingEl?.offsetWidth ?? 160) - 16, y: cachedH * 0.10 }
    : { x: endpoint.x - (outgoingEl?.offsetWidth ?? 160) / 2, y: endpoint.y + 32 });
  const color = HOMEPAGE_EVENTS[state.eventIndex]!.intervention === 'amber' ? 'var(--amber)' : 'var(--coral)';
  injectedEl.style.color = color;
  injectedEl.style.borderColor = color;
}

function syncPauseLabel() {
  if (!pauseBtn) return;
  if (state.reducedMotion) {
    pauseBtn.textContent = 'Motion reduced';
    pauseBtn.disabled = true;
    pauseBtn.title = 'Reduced-motion preference is on; use Next event to step through outcomes.';
  } else {
    pauseBtn.disabled = false;
    pauseBtn.title = '';
    pauseBtn.textContent = state.playing ? 'Pause' : 'Play';
  }
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (const c of [marketCanvas, back, front]) {
    if (!c) continue;
    const r = c.getBoundingClientRect();
    if (c === marketCanvas) {
      marketW = Math.max(1, Math.round(r.width));
      marketH = Math.max(1, Math.round(r.height));
    } else {
      cachedW = Math.max(1, Math.round(r.width));
      cachedH = Math.max(1, Math.round(r.height));
    }
    c.width = Math.max(1, Math.round(r.width * dpr));
    c.height = Math.max(1, Math.round(r.height * dpr));
    const ctx = c.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  refreshMarketTransform();
  const copy = $<HTMLElement>('.hero-copy')?.getBoundingClientRect();
  copyDocumentBounds = copy
    ? { x: copy.left + window.scrollX, y: copy.top + window.scrollY, w: copy.width, h: copy.height }
    : null;
  refreshCopyExclusion();
  positionSceneLabels();
  drawOnce(true);
}

function refreshCopyExclusion() {
  marketExclusions = copyDocumentBounds
    ? [copyExclusion(copyDocumentBounds, { x: window.scrollX, y: window.scrollY }, window.innerWidth > 700)]
    : [];
}

function refreshMarketTransform() {
  // This layer follows the background itself: fixed to the viewport on desktop,
  // absolute at the document origin on mobile. Neither needs scroll-time reads.
  marketTransform = computeMarketTransform(document.documentElement.clientWidth, window.innerHeight, 0, { x: 0, y: 0 }, window.innerWidth);
}

function drawOnce(forceMarket = false) {
  if (!back || !front || cachedW === 0) return;
  const bctx = back.getContext('2d');
  const fctx = front.getContext('2d');
  if (!bctx || !fctx) return;
  drawScene(bctx, fctx, cachedW, cachedH, state);
  const mctx = marketCanvas?.getContext('2d');
  if (mctx && marketTransform && (forceMarket || market.version !== lastMarketVersion)) {
    lastMarketVersion = market.version;
    drawMarket(mctx, getSnapshot(market), marketTransform, marketW, marketH, marketExclusions);
  }
}

function shouldRun() { return state.playing && !state.reducedMotion && visible && onScreen && !document.hidden; }

function frame(ts: number) {
  rafId = null;
  if (!shouldRun()) return;
  if (!lastTs) lastTs = ts;
  const dt = Math.min(ts - lastTs, 100);
  lastTs = ts;
  state = advanceTimeline(state, dt);
  advanceMarket(market, dt);
  syncCaption();
  drawOnce();
  if (shouldRun()) rafId = requestAnimationFrame(frame);
}

/** Central loop lifecycle: exactly one pending callback while eligible, none otherwise. */
function updateLoop() {
  if (shouldRun()) {
    if (rafId === null) { lastTs = 0; rafId = requestAnimationFrame(frame); }
  } else if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

if (catalogEl) {
  catalogEl.innerHTML = HOMEPAGE_EVENTS.map((e, i) => `<li><strong>${i + 1}. ${e.title}</strong>: ${e.explanation}</li>`).join('');
}

pauseBtn?.addEventListener('click', () => {
  if (state.reducedMotion) return;
  state = state.playing ? pauseTimeline(state) : resumeTimeline(state);
  announceManualChange(state.playing ? 'Playing' : 'Paused');
  syncPauseLabel();
  syncCaption();
  drawOnce();
  updateLoop();
});
nextBtn?.addEventListener('click', () => {
  state = nextEvent(state);
  announceManualChange('Selected');
  syncCaption();
  syncPauseLabel();
  drawOnce();
  updateLoop();
});

document.addEventListener('visibilitychange', () => { visible = !document.hidden; updateLoop(); });
window.addEventListener('pagehide', () => { visible = false; updateLoop(); });
window.addEventListener('pageshow', () => {
  visible = !document.hidden;
  syncCaption();
  syncPauseLabel();
  drawOnce();
  updateLoop();
});

const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
mq.addEventListener?.('change', (e) => {
  state = setReducedMotion(state, e.matches);
  syncPauseLabel();
  syncCaption();
  drawOnce();
  updateLoop();
});

const sceneEl = $<HTMLElement>('#scene');
if (sceneEl && 'IntersectionObserver' in window) {
  new IntersectionObserver((entries) => { onScreen = entries[0]?.isIntersecting ?? true; updateLoop(); }, { threshold: 0.05 }).observe(sceneEl);
}

window.addEventListener('resize', resize);
window.addEventListener('scroll', () => {
  if (window.innerWidth <= 700) return; // Copy and canvas both scroll in document space.
  refreshCopyExclusion();
  lastMarketVersion = -1;
  if (!shouldRun()) drawOnce(true); // The existing RAF redraws during playback.
}, { passive: true });
syncCaption();
syncPauseLabel();
resize();
updateLoop();
