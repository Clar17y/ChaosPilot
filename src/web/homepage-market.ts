// Seeded, bounded simulated market. One state drives book, candles, depth
// and volume. Prices are integer cents. All derivation is deterministic for
// a fixed seed and independent of how elapsed time is chunked.

export const START_PRICE_CENTS = 10168;
export const MIN_PRICE_CENTS = 9600;
export const MAX_PRICE_CENTS = 10700;
export const BOOK_LEVELS = 9;
export const CANDLE_BUCKET_MS = 4000;
export const MAX_CANDLES = 48;
export const MIN_EVENT_MS = 350;
export const MAX_EVENT_MS = 1000;

export interface BookLevel { priceCents: number; size: number }
export interface Candle { openCents: number; highCents: number; lowCents: number; closeCents: number; volume: number; trades: number }
export interface Trade { priceCents: number; size: number; side: 'bid' | 'ask'; atMs: number }
export interface DepthPoint { priceCents: number; cumulative: number }
export interface MarketSnapshot {
  bids: BookLevel[]; asks: BookLevel[];
  candles: Candle[]; lastTrade: Trade | null;
  midCents: number; spreadCents: number; timeMs: number; version: number;
}
export interface MarketState {
  rngState: number;
  midCents: number;
  bids: BookLevel[]; asks: BookLevel[];
  candles: Candle[];
  lastTrade: Trade | null;
  timeMs: number;
  nextEventAtMs: number;
  bucketEndsAtMs: number;
  version: number;
}

function rngNext(s: MarketState): number {
  // mulberry32
  s.rngState = (s.rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(s.rngState ^ (s.rngState >>> 15), 1 | s.rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const rngInt = (s: MarketState, lo: number, hi: number) => lo + Math.floor(rngNext(s) * (hi - lo + 1));
const newSize = (s: MarketState) => rngInt(s, 5, 900);

function scheduleNext(s: MarketState): void {
  s.nextEventAtMs = s.timeMs + rngInt(s, MIN_EVENT_MS, MAX_EVENT_MS);
}

function buildBook(s: MarketState): void {
  const spread = rngInt(s, 2, 4);
  const bestBid = s.midCents - Math.floor(spread / 2);
  const bestAsk = bestBid + spread;
  const bids: BookLevel[] = []; const asks: BookLevel[] = [];
  let bp = bestBid; let ap = bestAsk;
  for (let i = 0; i < BOOK_LEVELS; i++) {
    if (i > 0) bp -= rngInt(s, 1, 3);
    bids.push({ priceCents: bp, size: newSize(s) });
  }
  for (let i = 0; i < BOOK_LEVELS; i++) {
    if (i > 0) ap += rngInt(s, 1, 3);
    asks.push({ priceCents: ap, size: newSize(s) });
  }
  s.bids = bids; s.asks = asks;
}

function shiftBook(s: MarketState, delta: number): void {
  // Preserve resting levels as the market moves; do not rebuild the whole book.
  for (const level of [...s.bids, ...s.asks]) level.priceCents += delta;
}

function currentCandle(s: MarketState): Candle {
  let c = s.candles[s.candles.length - 1];
  if (!c) {
    c = { openCents: s.midCents, highCents: s.midCents, lowCents: s.midCents, closeCents: s.midCents, volume: 0, trades: 0 };
    s.candles.push(c);
  }
  return c;
}

function rollCandle(s: MarketState): void {
  const prev = currentCandle(s);
  s.candles.push({ openCents: prev.closeCents, highCents: prev.closeCents, lowCents: prev.closeCents, closeCents: prev.closeCents, volume: 0, trades: 0 });
  while (s.candles.length > MAX_CANDLES) s.candles.shift();
  s.bucketEndsAtMs += CANDLE_BUCKET_MS;
  s.version += 1;
}

function fireEvent(s: MarketState): void {
  // Quantity-only changes are the common case.
  const roll = rngNext(s);
  let priceDelta = 0;
  if (roll >= 0.45 && roll < 0.72) priceDelta = rngNext(s) < 0.5 ? -1 : 1;
  else if (roll >= 0.72 && roll < 0.78) priceDelta = rngNext(s) < 0.5 ? -2 : 2;
  // Mild mean reversion toward the start price.
  if (s.midCents > START_PRICE_CENTS + 120 && priceDelta > 0 && rngNext(s) < 0.7) priceDelta = -priceDelta;
  if (s.midCents < START_PRICE_CENTS - 120 && priceDelta < 0 && rngNext(s) < 0.7) priceDelta = -priceDelta;
  const next = Math.max(MIN_PRICE_CENTS, Math.min(MAX_PRICE_CENTS, s.midCents + priceDelta));
  priceDelta = next - s.midCents;
  s.midCents = next;
  if (priceDelta !== 0) shiftBook(s, priceDelta);
  const changes = rngInt(s, 2, 4);
  for (let i = 0; i < changes; i++) {
    const book = rngNext(s) < 0.5 ? s.bids : s.asks;
    const lvl = book[rngInt(s, 0, book.length - 1)];
    if (lvl) lvl.size = newSize(s);
  }
  // Most events include an executed trade at/inside the displayed spread.
  if (rngNext(s) < 0.75) {
    const bestBid = s.bids[0]!.priceCents; const bestAsk = s.asks[0]!.priceCents;
    const pick = rngNext(s);
    const priceCents = pick < 0.4 ? bestAsk : pick < 0.8 ? bestBid : rngInt(s, bestBid, bestAsk);
    const trade: Trade = { priceCents, size: rngInt(s, 1, 400), side: priceCents >= s.midCents ? 'ask' : 'bid', atMs: s.timeMs };
    s.lastTrade = trade;
    const c = currentCandle(s);
    c.closeCents = priceCents;
    c.highCents = Math.max(c.highCents, priceCents);
    c.lowCents = Math.min(c.lowCents, priceCents);
    c.volume += trade.size; c.trades += 1;
  }
  s.version += 1;
  scheduleNext(s);
}

export function createMarket(seed: number): MarketState {
  const s: MarketState = {
    rngState: seed | 0, midCents: START_PRICE_CENTS, bids: [], asks: [],
    candles: [], lastTrade: null, timeMs: 0, nextEventAtMs: 0, bucketEndsAtMs: CANDLE_BUCKET_MS, version: 0,
  };
  buildBook(s);
  currentCandle(s);
  scheduleNext(s);
  // Warm up bounded history once, through the same event machinery.
  advanceMarket(s, CANDLE_BUCKET_MS * (MAX_CANDLES - 12));
  return s;
}

/** Advance by elapsed active time. Chunking is irrelevant: events and candle
 *  boundaries are processed at their exact scheduled market times. */
export function advanceMarket(s: MarketState, dtMs: number): MarketState {
  if (!Number.isFinite(dtMs) || dtMs <= 0) return s;
  const target = s.timeMs + dtMs;
  for (;;) {
    const nextAt = Math.min(s.nextEventAtMs, s.bucketEndsAtMs);
    if (nextAt > target) break;
    s.timeMs = nextAt;
    if (s.bucketEndsAtMs <= s.nextEventAtMs) rollCandle(s);
    else fireEvent(s);
  }
  s.timeMs = target;
  return s;
}

export function getSnapshot(s: MarketState): MarketSnapshot {
  return {
    bids: s.bids.map((l) => ({ ...l })), asks: s.asks.map((l) => ({ ...l })),
    candles: s.candles.map((c) => ({ ...c })),
    lastTrade: s.lastTrade ? { ...s.lastTrade } : null,
    midCents: s.midCents,
    spreadCents: (s.asks[0]?.priceCents ?? 0) - (s.bids[0]?.priceCents ?? 0),
    timeMs: s.timeMs, version: s.version,
  };
}

/** Cumulative depth derived exactly from the displayed book. */
export function depthFromBook(bids: BookLevel[], asks: BookLevel[]): { bids: DepthPoint[]; asks: DepthPoint[] } {
  let acc = 0;
  const b = bids.map((l) => ({ priceCents: l.priceCents, cumulative: (acc += l.size) }));
  acc = 0;
  const a = asks.map((l) => ({ priceCents: l.priceCents, cumulative: (acc += l.size) }));
  return { bids: b, asks: a };
}
