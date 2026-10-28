import { depthFromBook, type MarketSnapshot } from './homepage-market.ts';

// Original market-fabric frame. All regions are fixed in this coordinate
// space regardless of the clean grid image's own dimensions.
export const FRAME_W = 1511;
export const FRAME_H = 1041;
export interface Region { x: number; y: number; w: number; h: number }
export const REGIONS: Record<'book' | 'candles' | 'depth' | 'volume' | 'histogram', Region> = {
  book: { x: 970, y: 88, w: 260, h: 234 },
  candles: { x: 600, y: 100, w: 347, h: 390 },
  depth: { x: 1250, y: 98, w: 230, h: 239 },
  volume: { x: 1240, y: 495, w: 225, h: 175 },
  histogram: { x: 450, y: 700, w: 495, h: 50 },
};

export type CanvasRect = Region;
export interface MarketTransform { scale: number; bgDocX: number; bgDocY: number; canvasDocX: number; canvasDocY: number }

/** Map cached document bounds into the backdrop's drawing space. */
export function copyExclusion(copy: CanvasRect, scroll: { x: number; y: number }, fixed: boolean): CanvasRect {
  return {
    x: copy.x - (fixed ? scroll.x : 0) - 16,
    y: copy.y - (fixed ? scroll.y : 0) - 8,
    w: copy.w + 32,
    h: copy.h + 16,
  };
}

/** Reproduce the body background placement (CSS in homepage.css) in document
 *  coordinates, then express it relative to the market canvas. */
export function computeMarketTransform(viewportW: number, viewportH: number, scrollY: number, canvasDoc: { x: number; y: number }, mediaWidth = viewportW): MarketTransform {
  let scale: number; let bgDocX: number; let bgDocY: number;
  if (mediaWidth <= 700) {
    scale = 900 / FRAME_H;
    const imgW = FRAME_W * scale;
    bgDocX = (viewportW - imgW) * 0.7;
    bgDocY = 520;
  } else {
    scale = Math.max(viewportW / FRAME_W, viewportH / FRAME_H);
    const imgW = FRAME_W * scale;
    bgDocX = mediaWidth <= 1024 ? 0 : (viewportW - imgW) / 2;
    bgDocY = scrollY; // background-attachment: fixed, positioned at viewport top
  }
  return { scale, bgDocX, bgDocY, canvasDocX: canvasDoc.x, canvasDocY: canvasDoc.y };
}

export function originalToCanvas(t: MarketTransform, ox: number, oy: number): { x: number; y: number } {
  return { x: t.bgDocX + ox * t.scale - t.canvasDocX, y: t.bgDocY + oy * t.scale - t.canvasDocY };
}
export function mapRegion(t: MarketTransform, r: Region): CanvasRect {
  const p = originalToCanvas(t, r.x, r.y);
  return { x: p.x, y: p.y, w: r.w * t.scale, h: r.h * t.scale };
}

const TEAL = '105,199,219';
const GREEN = '86,196,150';
const CORAL = '224,122,106';
const fmt = (c: number) => (c / 100).toFixed(2);

export function drawMarket(ctx: CanvasRenderingContext2D, snap: MarketSnapshot, t: MarketTransform, w: number, h: number, exclusions: CanvasRect[] = []): void {
  ctx.clearRect(0, 0, w, h);
  if (snap.candles.length === 0 || snap.bids.length === 0) return;
  const s = t.scale;
  ctx.save();
  // Reserve the copy's actual bounds. Data remains in the original plot areas
  // without painting across the headline when a random price history rises.
  if (exclusions.length > 0) {
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    for (const r of exclusions) ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip('evenodd');
  }
  ctx.font = `${Math.max(7, 12 * s)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = 'top';

  // --- Order book: two tiny monospace columns, 9 rows each ---
  const book = mapRegion(t, REGIONS.book);
  const rowH = book.h / (snap.bids.length + 1);
  ctx.fillStyle = `rgba(${TEAL},0.75)`;
  ctx.fillText('BIDS', book.x, book.y);
  ctx.fillStyle = `rgba(${CORAL},0.8)`;
  const askHeadX = book.x + book.w / 2;
  ctx.fillText('ASKS', askHeadX, book.y);
  snap.bids.forEach((l, i) => {
    const y = book.y + rowH * (i + 1);
    ctx.fillStyle = `rgba(${GREEN},0.62)`;
    ctx.fillText(`${fmt(l.priceCents)} ${l.size}`, book.x, y);
  });
  snap.asks.forEach((l, i) => {
    const y = book.y + rowH * (i + 1);
    ctx.fillStyle = `rgba(${CORAL},0.62)`;
    ctx.fillText(`${fmt(l.priceCents)} ${l.size}`, askHeadX, y);
  });

  // --- Candles (+ tiny price ticks inside the same plot) ---
  const plot = mapRegion(t, REGIONS.candles);
  let lo = Infinity; let hi = -Infinity;
  for (const c of snap.candles) { lo = Math.min(lo, c.lowCents); hi = Math.max(hi, c.highCents); }
  if (!(hi > lo)) { hi = lo + 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const yFor = (p: number) => plot.y + ((hi - p) / (hi - lo)) * plot.h;
  const step = plot.w / Math.max(1, snap.candles.length);
  snap.candles.forEach((c, i) => {
    const cx = plot.x + step * (i + 0.5);
    const up = c.closeCents >= c.openCents;
    ctx.strokeStyle = `rgba(${up ? GREEN : CORAL},0.30)`;
    ctx.fillStyle = `rgba(${up ? GREEN : CORAL},0.30)`;
    ctx.beginPath(); ctx.moveTo(cx, yFor(c.highCents)); ctx.lineTo(cx, yFor(c.lowCents)); ctx.stroke();
    const top = yFor(Math.max(c.openCents, c.closeCents));
    const bot = yFor(Math.min(c.openCents, c.closeCents));
    const bodyW = Math.max(1.5, step * 0.38);
    ctx.fillRect(cx - bodyW / 2, top, bodyW, Math.max(1, bot - top));
  });
  ctx.fillStyle = `rgba(${TEAL},0.55)`;
  for (let i = 0; i <= 3; i++) {
    const p = lo + ((hi - lo) * i) / 3;
    ctx.fillText(fmt(Math.round(p)), plot.x + plot.w - 44 * s, yFor(p));
  }

  // --- Depth: cumulative curves from the exact displayed book ---
  const dep = mapRegion(t, REGIONS.depth);
  const depth = depthFromBook(snap.bids, snap.asks);
  const maxCum = Math.max(1, depth.bids[depth.bids.length - 1]?.cumulative ?? 1, depth.asks[depth.asks.length - 1]?.cumulative ?? 1);
  const minP = snap.bids[snap.bids.length - 1]!.priceCents;
  const maxP = snap.asks[snap.asks.length - 1]!.priceCents;
  const xFor = (p: number) => dep.x + ((p - minP) / Math.max(1, maxP - minP)) * dep.w;
  const drawDepth = (pts: { priceCents: number; cumulative: number }[], color: string) => {
    if (pts.length === 0) return;
    ctx.beginPath();
    ctx.moveTo(xFor(pts[0]!.priceCents), dep.y + dep.h);
    let previousY = dep.y + dep.h - (pts[0]!.cumulative / maxCum) * dep.h;
    for (const pt of pts) {
      ctx.lineTo(xFor(pt.priceCents), previousY);
      previousY = dep.y + dep.h - (pt.cumulative / maxCum) * dep.h;
      ctx.lineTo(xFor(pt.priceCents), previousY);
    }
    ctx.lineTo(xFor(pts[pts.length - 1]!.priceCents), dep.y + dep.h);
    ctx.closePath();
    ctx.fillStyle = `rgba(${color},0.07)`; ctx.fill();
    ctx.strokeStyle = `rgba(${color},0.36)`; ctx.stroke();
  };
  drawDepth([...depth.bids].reverse(), GREEN);
  drawDepth(depth.asks, CORAL);

  // --- Volume: same candles' accumulated trade quantities ---
  const vol = mapRegion(t, REGIONS.volume);
  const maxVol = Math.max(1, ...snap.candles.map((c) => c.volume));
  const vStep = vol.w / Math.max(1, snap.candles.length);
  snap.candles.forEach((c, i) => {
    const bh = (c.volume / maxVol) * vol.h;
    ctx.fillStyle = `rgba(${c.closeCents >= c.openCents ? GREEN : CORAL},0.18)`;
    ctx.fillRect(vol.x + vStep * i + 0.5, vol.y + vol.h - bh, Math.max(1, vStep - 1), bh);
  });

  // --- Subtle low histogram of the same candle volumes ---
  const hist = mapRegion(t, REGIONS.histogram);
  const hStep = hist.w / Math.max(1, snap.candles.length);
  snap.candles.forEach((c, i) => {
    const bh = (c.volume / maxVol) * hist.h;
    ctx.fillStyle = `rgba(${TEAL},0.08)`;
    ctx.fillRect(hist.x + hStep * i + 0.5, hist.y + hist.h - bh, Math.max(1, hStep - 1), bh);
  });
  ctx.restore();
}
