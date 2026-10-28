import { describe, expect, it } from 'vitest';
import {
  advanceMarket, createMarket, depthFromBook, getSnapshot,
  CANDLE_BUCKET_MS, MAX_CANDLES, START_PRICE_CENTS,
} from '../src/web/homepage-market.ts';
import { computeMarketTransform, copyExclusion, drawMarket, mapRegion, originalToCanvas, REGIONS, FRAME_W, FRAME_H } from '../src/web/homepage-market-renderer.ts';

function invariants(seed = 42, steps = 300, dt = 700) {
  const m = createMarket(seed);
  for (let i = 0; i < steps; i++) {
    advanceMarket(m, dt);
    const s = getSnapshot(m);
    expect(s.bids.length).toBe(9); expect(s.asks.length).toBe(9);
    for (let j = 1; j < 9; j++) {
      expect(s.bids[j]!.priceCents).toBeLessThan(s.bids[j - 1]!.priceCents);
      expect(s.asks[j]!.priceCents).toBeGreaterThan(s.asks[j - 1]!.priceCents);
    }
    expect(s.bids[0]!.priceCents).toBeLessThan(s.asks[0]!.priceCents);
    expect(s.spreadCents).toBeGreaterThan(0);
    for (const l of [...s.bids, ...s.asks]) {
      expect(Number.isInteger(l.priceCents)).toBe(true); expect(l.size).toBeGreaterThan(0);
      expect(Number.isFinite(l.priceCents + l.size)).toBe(true);
    }
    expect(s.candles.length).toBeLessThanOrEqual(MAX_CANDLES);
    s.candles.forEach((c, j) => {
      expect(c.highCents).toBeGreaterThanOrEqual(Math.max(c.openCents, c.closeCents));
      expect(c.lowCents).toBeLessThanOrEqual(Math.min(c.openCents, c.closeCents));
      expect(c.volume).toBeGreaterThanOrEqual(0);
      for (const v of [c.openCents, c.highCents, c.lowCents, c.closeCents, c.volume]) expect(Number.isFinite(v)).toBe(true);
      if (j > 0) expect(c.openCents).toBe(s.candles[j - 1]!.closeCents);
    });
    if (s.lastTrade) expect(s.candles[s.candles.length - 1]!.closeCents).toBe(s.lastTrade.priceCents);
  }
  return m;
}

describe('homepage market domain', () => {
  it('fixed seed is reproducible, distinct seeds diverge', () => {
    const a = getSnapshot(invariants(7, 50)); const b = getSnapshot(createMarket(7));
    advanceMarket(createMarket(7), 0); // zero-dt no-op exercised below too
    const m1 = createMarket(7); advanceMarket(m1, 35000);
    const m2 = createMarket(7); advanceMarket(m2, 35000);
    expect(getSnapshot(m1)).toEqual(getSnapshot(m2));
    const m3 = createMarket(8); advanceMarket(m3, 35000);
    expect(getSnapshot(m3)).not.toEqual(getSnapshot(m1));
    expect(a.version).toBeGreaterThan(0); expect(b.midCents).toBeDefined();
  });

  it('zero dt changes nothing', () => {
    const m = createMarket(3); const before = getSnapshot(m);
    advanceMarket(m, 0); advanceMarket(m, -5); advanceMarket(m, Number.NaN);
    expect(getSnapshot(m)).toEqual(before);
  });

  it('chunked vs combined elapsed time is identical', () => {
    const total = 123456;
    const one = createMarket(99); advanceMarket(one, total);
    const chunked = createMarket(99);
    for (const dt of [1, 17, 350, 999, 4000, 63, 10000, 7, 500]) advanceMarket(chunked, dt);
    advanceMarket(chunked, total - (1 + 17 + 350 + 999 + 4000 + 63 + 10000 + 7 + 500));
    const many = createMarket(99);
    for (let t = 0; t < total; t += 100) advanceMarket(many, Math.min(100, total - t));
    expect(getSnapshot(chunked)).toEqual(getSnapshot(one));
    expect(getSnapshot(many)).toEqual(getSnapshot(one));
  });

  it('long run keeps book/OHLC invariants (thousands of updates)', { timeout: 60000 }, () => {
    const m = invariants(1234, 2500, 613);
    const s = getSnapshot(m);
    expect(s.version).toBeGreaterThan(1500);
    expect(Math.abs(s.midCents - START_PRICE_CENTS)).toBeLessThanOrEqual(600);
  });

  it('price moves are tick-sized and quantity-only changes occur', () => {
    const m = createMarket(5);
    let sawQtyOnly = false; let sawMove = false;
    let prev = getSnapshot(m);
    for (let i = 0; i < 400; i++) {
      advanceMarket(m, 50);
      const s = getSnapshot(m);
      if (s.version !== prev.version) {
        const d = s.midCents - prev.midCents;
        expect(Math.abs(d)).toBeLessThanOrEqual(2);
        if (d !== 0) sawMove = true;
        if (d === 0 && JSON.stringify(s.bids) !== JSON.stringify(prev.bids)) sawQtyOnly = true;
        prev = s;
      }
    }
    expect(sawMove).toBe(true); expect(sawQtyOnly).toBe(true);
  });

  it('executed trade is at bid/ask or inside the displayed spread at execution', () => {
    const m = createMarket(21);
    let checked = 0;
    for (let i = 0; i < 200 && checked < 40; i++) {
      advanceMarket(m, m.nextEventAtMs - m.timeMs);
      if (m.lastTrade && m.lastTrade.atMs === m.timeMs) {
        expect(m.lastTrade.priceCents).toBeGreaterThanOrEqual(m.bids[0]!.priceCents);
        expect(m.lastTrade.priceCents).toBeLessThanOrEqual(m.asks[0]!.priceCents);
        checked++;
      }
    }
    expect(checked).toBe(40);
  });

  it('keeps resting price levels coherent across a market move', () => {
    const m = createMarket(17);
    for (let i = 0; i < 100; i++) {
      const before = getSnapshot(m);
      advanceMarket(m, m.nextEventAtMs - m.timeMs);
      const delta = m.midCents - before.midCents;
      expect(m.bids.map(l => l.priceCents)).toEqual(before.bids.map(l => l.priceCents + delta));
      expect(m.asks.map(l => l.priceCents)).toEqual(before.asks.map(l => l.priceCents + delta));
    }
  });

  it('invalidates the render when a candle closes between market events', () => {
    const m = createMarket(11);
    m.nextEventAtMs = m.bucketEndsAtMs + 500;
    const version = m.version;
    advanceMarket(m, m.bucketEndsAtMs - m.timeMs);
    expect(m.version).toBe(version + 1);
    expect(m.candles.at(-1)?.volume).toBe(0);
    expect(m.candles.at(-1)?.openCents).toBe(m.candles.at(-2)?.closeCents);
  });

  it('depth is exactly cumulative displayed book; volume accumulates same trades', () => {
    const m = createMarket(31);
    const s = getSnapshot(m);
    const d = depthFromBook(s.bids, s.asks);
    let acc = 0; d.bids.forEach((p, i) => { acc += s.bids[i]!.size; expect(p.cumulative).toBe(acc); expect(p.priceCents).toBe(s.bids[i]!.priceCents); });
    acc = 0; d.asks.forEach((p, i) => { acc += s.asks[i]!.size; expect(p.cumulative).toBe(acc); });

    const m2 = createMarket(77);
    const baseVol = getSnapshot(m2).candles.reduce((n, c) => n + c.volume, 0);
    let tradeSum = 0; let lastAt = getSnapshot(m2).lastTrade?.atMs ?? -1;
    for (let t = 0; t < 30000; t += 50) {
      advanceMarket(m2, 50);
      const snap = getSnapshot(m2);
      if (snap.lastTrade && snap.lastTrade.atMs !== lastAt) { tradeSum += snap.lastTrade.size; lastAt = snap.lastTrade.atMs; }
    }
    const volSum = getSnapshot(m2).candles.reduce((n, c) => n + c.volume, 0);
    expect(volSum - baseVol).toBe(tradeSum);
    expect(tradeSum).toBeGreaterThan(0);
  });

  it('candle rollover connects closes to next opens and history stays bounded', () => {
    const m = createMarket(11);
    advanceMarket(m, CANDLE_BUCKET_MS * MAX_CANDLES * 3);
    const s = getSnapshot(m);
    expect(s.candles.length).toBe(MAX_CANDLES);
    for (let i = 1; i < s.candles.length; i++) expect(s.candles[i]!.openCents).toBe(s.candles[i - 1]!.closeCents);
  });
});

// Independent re-derivation of the CSS body-background rules (homepage.css),
// used to check the renderer transform rather than its own literals.
function expectedBg(vw: number, vh: number) {
  if (vw <= 700) { const scale = 900 / FRAME_H; return { scale, x: (vw - FRAME_W * scale) * 0.7, y: 520 }; }
  const scale = Math.max(vw / FRAME_W, vh / FRAME_H);
  return { scale, x: vw <= 1024 ? 0 : (vw - FRAME_W * scale) / 2, y: 0 };
}

describe('market layout transforms', () => {
  it('tracks copy through desktop scroll, resize at scroll, and return to top', () => {
    const copy = { x: 64, y: 100, w: 620, h: 385 };
    const top = copyExclusion(copy, { x: 0, y: 0 }, true);
    const scrolled = copyExclusion(copy, { x: 0, y: 60 }, true);
    expect(scrolled.y).toBe(32);
    expect(scrolled.y + scrolled.h).toBeGreaterThan(100 - 60 + 385);
    // A resize measures viewport Y=40 while scrolled by 60; caching document
    // bounds must recover the same exclusion rather than offset it twice.
    const measuredAfterResize = { ...copy, y: 40 + 60 };
    expect(copyExclusion(measuredAfterResize, { x: 0, y: 60 }, true)).toEqual(scrolled);
    expect(copyExclusion(measuredAfterResize, { x: 0, y: 0 }, true)).toEqual(top);
  });

  it('keeps mobile copy masks in document space across scrolling and breakpoint changes', () => {
    const copy = { x: 20, y: 135, w: 335, h: 403 };
    const top = copyExclusion(copy, { x: 0, y: 0 }, false);
    expect(copyExclusion(copy, { x: 0, y: 350 }, false)).toEqual(top);
    const fixed = copyExclusion(copy, { x: 0, y: 350 }, true);
    expect(fixed.y).toBe(top.y - 350);
    expect(copyExclusion(copy, { x: 0, y: 350 }, false)).toEqual(top);
  });

  it('keeps fixed desktop and document-anchored mobile regions stable while scrolling', () => {
    for (const width of [390, 1487]) {
      const initial = computeMarketTransform(width, 1058, 0, { x: 0, y: 0 });
      const scrolled = computeMarketTransform(width, 1058, 350, { x: 0, y: width <= 700 ? 0 : 350 });
      for (const region of Object.values(REGIONS)) {
        const a = mapRegion(initial, region), b = mapRegion(scrolled, region);
        for (const key of ['x', 'y', 'w', 'h'] as const) expect(b[key]).toBeCloseTo(a[key], 10);
      }
    }
  });

  it('uses CSS viewport breakpoints independently of the scrollbar width', () => {
    const t = computeMarketTransform(690, 900, 0, { x: 0, y: 0 }, 705);
    expect(t.bgDocY).toBe(0);
    expect(t.scale).toBeCloseTo(900 / FRAME_H);
    const centered = computeMarketTransform(1015, 900, 0, { x: 0, y: 0 }, 1030);
    expect(centered.bgDocX).toBeLessThan(0);
  });

  it.each([1487, 1024, 768, 390, 320])('width %i maps regions per CSS background rules', (vw) => {
    const vh = vw <= 700 ? 700 : 900;
    const canvasDoc = { x: vw <= 700 ? 20 : 64, y: vw <= 700 ? 420 : 76 };
    const scrollY = 0;
    const t = computeMarketTransform(vw, vh, scrollY, canvasDoc);
    const exp = expectedBg(vw, vh);
    expect(t.scale).toBeCloseTo(exp.scale, 10);
    for (const key of Object.keys(REGIONS) as (keyof typeof REGIONS)[]) {
      const r = REGIONS[key]; const mapped = mapRegion(t, r);
      expect(mapped.x).toBeCloseTo(exp.x + r.x * exp.scale - canvasDoc.x, 6);
      expect(mapped.y).toBeCloseTo(exp.y + r.y * exp.scale + (vw <= 700 ? 0 : scrollY) - canvasDoc.y, 6);
      expect(mapped.w).toBeCloseTo(r.w * exp.scale, 6);
      expect(mapped.h).toBeCloseTo(r.h * exp.scale, 6);
      // Region stays inside the background image footprint.
      expect(r.x).toBeGreaterThanOrEqual(0); expect(r.x + r.w).toBeLessThanOrEqual(FRAME_W);
      expect(r.y + r.h).toBeLessThanOrEqual(FRAME_H);
    }
    // Footprint ordering is retained: candles left of book, depth right of
    // book, volume below depth, histogram below candles.
    expect(REGIONS.candles.x + REGIONS.candles.w).toBeLessThan(REGIONS.book.x);
    expect(REGIONS.depth.x).toBeGreaterThan(REGIONS.book.x + REGIONS.book.w);
    expect(REGIONS.volume.y).toBeGreaterThan(REGIONS.depth.y + REGIONS.depth.h);
    expect(REGIONS.histogram.y).toBeGreaterThan(REGIONS.candles.y + REGIONS.candles.h);
    const p = originalToCanvas(t, 0, 0);
    expect(p.x).toBeCloseTo(exp.x - canvasDoc.x, 6);
  });

  it('renderer draws BIDS/ASKS and candle labels from the snapshot', () => {
    const texts: string[] = [];
    const ctx = {
      clearRect() {}, save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
      stroke() {}, fill() {}, fillRect() {}, fillText(v: string) { texts.push(v); },
      set fillStyle(_v: string) {}, set strokeStyle(_v: string) {}, set font(_v: string) {}, set textBaseline(_v: string) {},
    } as unknown as CanvasRenderingContext2D;
    const t = computeMarketTransform(1487, 900, 0, { x: 0, y: 0 });
    drawMarket(ctx, getSnapshot(createMarket(2)), t, 1487, 900);
    expect(texts).toContain('BIDS'); expect(texts).toContain('ASKS');
    expect(texts.length).toBeGreaterThan(20);
  });
});
