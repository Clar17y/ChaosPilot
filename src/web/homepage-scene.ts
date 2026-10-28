import { HOMEPAGE_EVENTS, IMPACT_MS, type HomepageEvent, type ScenarioInstance, type TimelineState } from './homepage-events.ts';

export const TRAVEL_MS = 2200;
export const EXIT_MS = 2600;
/** Time for a transformed packet to travel from its intercept to the right edge. */
export const DOWNSTREAM_MS = TRAVEL_MS + EXIT_MS;

export interface Pt { x: number; y: number }
export interface Cubic { p0: Pt; p1: Pt; p2: Pt; p3: Pt }
export interface Packet { x: number; y: number; color: string; size: number; layer: 'behind' | 'front'; kind: string; trail?: Pt; id?: string; opacity?: number }

export const CYAN = '#69c7db';
export const CORAL = '#e07a6a';
export const AMBER = '#d9a84e';
export const MAX_PACKETS = 90;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function pointOnCubic(c: Cubic, t: number): Pt {
  const tt = clamp01(t);
  const u = 1 - tt;
  const a = u * u * u, b = 3 * u * u * tt, d = 3 * u * tt * tt, e = tt * tt * tt;
  return { x: a * c.p0.x + b * c.p1.x + d * c.p2.x + e * c.p3.x, y: a * c.p0.y + b * c.p1.y + d * c.p2.y + e * c.p3.y };
}

// --- Distributed lane geometry (Exchange Fabric) ---
// Each lane is three connected cubic segments: low entry across the lower
// art zone, a middle segment through a distributed junction, then a rising
// exit to the right edge. Segment joins are exact shared points, so a packet
// evaluated with pointOnLane travels the whole width without a centre stop.
const LANE_START_Y = [0.68, 0.76, 0.84, 0.95, 0.88, 0.72, 0.80, 0.91];
const LANE_MID_Y = [0.72, 0.74, 0.77, 0.83, 0.80, 0.70, 0.75, 0.82];
const LANE_JUNCTIONS: readonly Pt[] = [
  { x: 0.53, y: 0.66 }, { x: 0.60, y: 0.60 }, { x: 0.67, y: 0.55 },
  { x: 0.56, y: 0.80 }, { x: 0.64, y: 0.74 }, { x: 0.71, y: 0.58 },
  { x: 0.62, y: 0.58 }, { x: 0.75, y: 0.71 },
];
const LANE_EXIT_Y = [0.40, 0.50, 0.58, 0.92, 0.82, 0.46, 0.54, 0.70];

export function streamLanes(w: number, h: number): Cubic[][] {
  // Tablet copy occupies more of the width; keep the complete river beneath it.
  const yAt = (fraction: number) => h * (w > 700 && w <= 1100 ? 0.73 + (fraction - 0.55) * 0.48 : fraction);
  return LANE_START_Y.map((startYf, i) => {
    const junction = LANE_JUNCTIONS[i]!;
    const join1: Pt = { x: w * (0.34 + (i % 3) * 0.03), y: yAt(LANE_MID_Y[i]!) };
    const junctionPt: Pt = { x: w * junction.x, y: yAt(junction.y) };
    const startY = yAt(startYf);
    const exitY = yAt(LANE_EXIT_Y[i]!);
    return [
      {
        p0: { x: -20, y: startY },
        p1: { x: w * 0.14, y: startY - h * 0.01 },
        p2: { x: w * 0.26, y: join1.y + h * 0.02 },
        p3: join1,
      },
      {
        p0: join1,
        p1: { x: join1.x + w * 0.10, y: join1.y },
        p2: { x: junctionPt.x - w * 0.08, y: junctionPt.y + h * 0.03 },
        p3: junctionPt,
      },
      {
        p0: junctionPt,
        p1: { x: junctionPt.x + w * 0.12, y: junctionPt.y - h * 0.02 },
        p2: { x: w * 0.88, y: exitY + h * 0.04 },
        p3: { x: w + 20, y: exitY },
      },
    ];
  });
}

/** Point at t in [0,1] along a lane's connected segments (equal weight per segment). */
export function pointOnLane(segments: readonly Cubic[], t: number): Pt {
  const scaled = clamp01(t) * segments.length;
  const index = Math.min(segments.length - 1, Math.floor(scaled));
  return pointOnCubic(segments[index]!, scaled - index);
}

/** All segment joins across the lanes: the small distributed routing junctions. */
export function junctionPoints(w: number, h: number): Pt[] {
  return streamLanes(w, h).flatMap((segments) => segments.slice(1).map((s) => s.p0));
}

/** Distributed intercept on a blue lane; spreads across lanes and along the middle segments. */
export function interceptFor(eventIndex: number, w: number, h: number): { laneIndex: number; t: number; point: Pt } {
  const lanes = streamLanes(w, h);
  const laneIndex = ((eventIndex * 5 + 1) % lanes.length + lanes.length) % lanes.length;
  const t = [0.54, 0.74, 0.61, 0.68, 0.57][eventIndex % 5]!;
  return { laneIndex, t, point: pointOnLane(lanes[laneIndex]!, t) };
}

export const INJECTED_TAG_WIDTH = 164;
export const INJECTED_TAG_HEIGHT = 30;

/**
 * Top-left position (scene pixels) for the injected-message tag, placed just
 * above its intercept. Desktop scenes keep it in the lower art zone below the
 * hero copy; mobile scenes sit below the copy so only scene bounds apply.
 * Computed on resize/selection only, never per frame.
 */
export function injectedTagPosition(eventIndex: number, w: number, h: number, measuredWidth?: number, measuredHeight = INJECTED_TAG_HEIGHT): Pt {
  const { point } = interceptFor(eventIndex, w, h);
  const tagW = measuredWidth ?? (w <= 700 ? 148 : INJECTED_TAG_WIDTH);
  const x = Math.max(8, Math.min(point.x - tagW / 2, w - tagW - 8));
  const minTop = w > 1100 ? (x > w * 0.49 ? h * 0.44 : h * 0.65) : w > 700 ? h * 0.69 : h * 0.36;
  const maxTop = Math.max(minTop, h - measuredHeight - h * 0.16);
  const y = w <= 700 ? h * 0.36 : Math.max(minTop, Math.min(point.y - measuredHeight - 34, maxTop));
  return { x, y };
}

/**
 * Local ingress to an intercept: starts left of it (above-left for coral,
 * below-left for amber) with monotonically increasing control-point x, so an
 * injected packet always progresses rightward and ends exactly at the intercept.
 */
export function interventionPath(w: number, h: number, kind: 'coral' | 'amber', eventIndex = 0): Cubic {
  const target = interceptFor(eventIndex, w, h).point;
  if (kind === 'coral') {
    const startX = target.x - w * 0.10;
    const copyFloor = w > 700 && w <= 1100 ? h * 0.70 : w > 1100 && startX < 700 ? h * 0.65 : 0;
    const startY = Math.max(copyFloor, target.y - h * 0.16);
    return {
      p0: { x: startX, y: startY },
      p1: { x: target.x - w * 0.07, y: startY },
      p2: { x: target.x - w * 0.03, y: target.y },
      p3: target,
    };
  }
  return {
    p0: { x: target.x - w * 0.18, y: target.y + h * 0.22 },
    p1: { x: target.x - w * 0.12, y: target.y + h * 0.18 },
    p2: { x: target.x - w * 0.05, y: target.y + h * 0.08 },
    p3: target,
  };
}

function withTrail(packets: Packet[], path: Cubic, t: number, color: string, size: number, layer: Packet['layer'], kind: string, extra: { id?: string; opacity?: number } = {}) {
  const p = pointOnCubic(path, t);
  const trail = pointOnCubic(path, t - 0.025);
  packets.push({ x: p.x, y: p.y, color, size, layer, kind, trail, ...extra });
}

function withLaneTrail(packets: Packet[], lane: readonly Cubic[], t: number, color: string, size: number, kind: string, extra: { id?: string; opacity?: number } = {}) {
  const p = pointOnLane(lane, t);
  const trail = pointOnLane(lane, t - 0.008);
  packets.push({ x: p.x, y: p.y, color, size, layer: 'behind', kind, trail, ...extra });
}

function pushPt(packets: Packet[], p: Pt, back: Pt, color: string, size: number, kind: string, opacity = 1, id?: string) {
  packets.push({ x: p.x, y: p.y, color, size, layer: 'behind', kind, trail: back, opacity, id });
}

// --- Irregular base traffic: seeded schedule over a repeating window ---
export const STREAM_PERIOD_MS = 24000;

export interface StreamScheduleEntry {
  id: string;
  lane: number;
  direction: 'in' | 'out';
  /** Absolute emission time within its scheduling cycle. */
  emitMs: number;
  travelMs: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic bursty schedule for one lane/cycle: short bursts, longer gaps, per-packet travel times. */
export function streamSchedule(direction: 'in' | 'out', lane: number, cycle: number): StreamScheduleEntry[] {
  const seed = (Math.imul(lane + 1, 374761393) ^ Math.imul(cycle + 101, 668265263) ^ (direction === 'out' ? 0x9e3779b9 : 0x27d4eb2f)) >>> 0;
  const rand = mulberry32(seed);
  const entries: StreamScheduleEntry[] = [];
  let cursor = rand() * 700;
  let ordinal = 0;
  while (cursor < STREAM_PERIOD_MS) {
    const burst = 2 + Math.floor(rand() * 3); // 2-4 packets per burst
    for (let b = 0; b < burst && cursor < STREAM_PERIOD_MS; b++) {
      const travelMs = direction === 'in' ? 3000 + rand() * 5000 : 2600 + rand() * 3400;
      entries.push({ id: `${direction}-${lane}-${cycle}-${ordinal++}`, lane, direction, emitMs: cycle * STREAM_PERIOD_MS + cursor, travelMs });
      cursor += b < burst - 1 ? 340 + rand() * 520 : 2600 + rand() * 3000;
    }
  }
  return entries;
}

// The emission schedule depends only on the 24-second cycle, not on viewport
// geometry. Retain only the current/previous window instead of rebuilding
// sixteen deterministic schedules on every animation frame.
let scheduledCycle = Number.NaN;
let scheduledLanes: StreamScheduleEntry[][] = [];

function baseStreamPackets(packets: Packet[], streamMs: number, w: number, h: number) {
  const lanes = streamLanes(w, h);
  const cycle = Math.floor(streamMs / STREAM_PERIOD_MS);
  if (cycle !== scheduledCycle) {
    scheduledCycle = cycle;
    scheduledLanes = [];
    // Late packets from the previous cycle may still be in flight.
    for (const cyc of [cycle - 1, cycle]) {
      if (cyc < -1) continue;
      for (let lane = 0; lane < lanes.length; lane++) {
        scheduledLanes.push(streamSchedule('in', lane, cyc));
      }
    }
  }
  for (const schedule of scheduledLanes) {
    for (const e of schedule) {
      const age = streamMs - e.emitMs;
      if (age < 0 || age > e.travelMs) continue;
      withLaneTrail(packets, lanes[e.lane]!, age / e.travelMs, CYAN, 7, 'stream', { id: e.id });
    }
  }
}

/** Packets for one injection: join a lane locally at its intercept, then continue rightward along that lane. */
function instancePackets(packets: Packet[], ageMs: number, eventIndex: number, w: number, h: number, instanceId: string) {
  const event: HomepageEvent = HOMEPAGE_EVENTS[((eventIndex % HOMEPAGE_EVENTS.length) + HOMEPAGE_EVENTS.length) % HOMEPAGE_EVENTS.length]!;
  if (ageMs < 0) return;
  const lanes = streamLanes(w, h);
  const { laneIndex, t: interceptT, point: intercept } = interceptFor(eventIndex, w, h);
  const lane = lanes[laneIndex]!;
  const color = event.intervention === 'coral' ? CORAL : AMBER;
  if (ageMs < IMPACT_MS) {
    const path = interventionPath(w, h, event.intervention, eventIndex);
    withTrail(packets, path, clamp01(ageMs / IMPACT_MS), color, 9, 'front', 'intervention', { id: `${instanceId}:main` });
    return;
  }
  let pMs = ageMs - IMPACT_MS;
  const emit = (p: Pt, trail: Pt, tint = color, suffix = 'main', opacity = 1) =>
    pushPt(packets, p, trail, tint, 9, event.motif, opacity, `${instanceId}:${suffix}`);
  if (event.motif === 'delay' && pMs < 800) { emit(intercept, intercept, AMBER); return; }
  if (event.motif === 'delay') pMs -= 800;
  if (event.motif === 'reject') {
    // Continue from the interception point along the lane, slow locally, then
    // drop forward while fading. x never decreases: nothing travels back left.
    const APPROACH_MS = 900, REJECT_EXIT_MS = 750, STOP_T = Math.min(1, interceptT + 0.05);
    if (pMs > APPROACH_MS + REJECT_EXIT_MS) return;
    if (pMs < APPROACH_MS) {
      const u = pMs / APPROACH_MS;
      const ease = 1 - (1 - u) * (1 - u); // ease-out: forward but decelerating
      const t = interceptT + (STOP_T - interceptT) * ease;
      emit(pointOnLane(lane, t), pointOnLane(lane, Math.max(interceptT, t - 0.01)), CORAL);
    } else {
      const v = (pMs - APPROACH_MS) / REJECT_EXIT_MS;
      const stop = pointOnLane(lane, STOP_T);
      const p = { x: stop.x + v * w * 0.02, y: stop.y + v * h * 0.07 };
      emit(p, { x: p.x - w * 0.006, y: p.y - h * 0.012 }, CORAL, 'main', 1 - v);
    }
    return;
  }
  // Position along the same lane from the intercept to the right edge: the
  // transformed packet starts exactly where the intervention ended.
  const laneTAt = (ms: number) => interceptT + (1 - interceptT) * clamp01(ms / DOWNSTREAM_MS);
  const posAt = (ms: number): Pt => pointOnLane(lane, laneTAt(ms));
  if (event.motif === 'duplicate') {
    if (pMs <= DOWNSTREAM_MS) emit(posAt(pMs), posAt(pMs - 60));
    // The copy is born at the original packet and trails it out of the system.
    if (pMs <= DOWNSTREAM_MS + 180) emit(posAt(pMs - 180), posAt(pMs - 240), color, 'copy');
  } else if (event.motif === 'reorder') {
    // Each member has its own exit time: a slower packet must finish its journey.
    const fast = pMs * 1.25, slow = pMs * 0.75;
    if (fast <= DOWNSTREAM_MS) emit(posAt(fast), posAt(fast - 60), AMBER);
    if (slow <= DOWNSTREAM_MS) emit(posAt(slow), posAt(slow - 60), CYAN, 'slow');
  } else if (event.motif === 'corrupt') {
    if (pMs > DOWNSTREAM_MS) return;
    const p = posAt(pMs); const jitter = Math.sin(pMs / 90) * 6;
    emit({ x: p.x, y: p.y + jitter }, posAt(pMs - 60), CORAL);
  } else if (event.motif === 'mismatch') {
    if (pMs > DOWNSTREAM_MS) return;
    emit(posAt(pMs), posAt(pMs - 60), CORAL);
    // A companion splits from the original position, then joins the adjacent exit.
    if (pMs >= DOWNSTREAM_MS / 2) {
      const neighbour = lanes[(laneIndex + 1) % lanes.length]!;
      const start = posAt(DOWNSTREAM_MS / 2), end = pointOnLane(neighbour, 1);
      const branch: Cubic = { p0: start, p1: { x: start.x + (end.x - start.x) * 0.3, y: start.y }, p2: { x: end.x - (end.x - start.x) * 0.25, y: end.y }, p3: end };
      const t = (pMs - DOWNSTREAM_MS / 2) / (DOWNSTREAM_MS / 2);
      emit(pointOnCubic(branch, t), pointOnCubic(branch, t - 0.02), CYAN, 'branch');
    }
  } else {
    if (pMs <= DOWNSTREAM_MS) emit(posAt(pMs), posAt(pMs - 60));
  }
}

/** Deterministic packet field. streamMs is a continuous clock that never resets at event boundaries. */
export function scenePacketsForInstances(instances: readonly ScenarioInstance[], activeTimeMs: number, w: number, h: number, streamMs: number = activeTimeMs): Packet[] {
  const packets: Packet[] = [];
  baseStreamPackets(packets, streamMs, w, h);
  for (const inst of instances) instancePackets(packets, activeTimeMs - inst.startMs, inst.eventIndex, w, h, `${inst.eventIndex}:${inst.startMs}`);
  return packets.slice(0, MAX_PACKETS);
}

export function scenePacketsAt(elapsedMs: number, eventIndex: number, w: number, h: number, streamMs: number = elapsedMs): Packet[] {
  return scenePacketsForInstances([{ eventIndex, startMs: 0 }], elapsedMs, w, h, streamMs);
}

function drawPath(ctx: CanvasRenderingContext2D, c: Cubic, color: string, alpha: number, width = 1.2) {
  ctx.beginPath(); ctx.moveTo(c.p0.x, c.p0.y);
  ctx.bezierCurveTo(c.p1.x, c.p1.y, c.p2.x, c.p2.y, c.p3.x, c.p3.y);
  ctx.strokeStyle = color; ctx.globalAlpha = alpha; ctx.lineWidth = width; ctx.stroke(); ctx.globalAlpha = 1;
}

function shifted(c: Cubic, dy: number): Cubic {
  return { p0: { x: c.p0.x, y: c.p0.y + dy }, p1: { x: c.p1.x, y: c.p1.y + dy }, p2: { x: c.p2.x, y: c.p2.y + dy }, p3: { x: c.p3.x, y: c.p3.y + dy } };
}

export function drawScene(ctxB: CanvasRenderingContext2D, ctxF: CanvasRenderingContext2D, w: number, h: number, state: TimelineState) {
  ctxB.clearRect(0, 0, w, h); ctxF.clearRect(0, 0, w, h);
  const lanes = streamLanes(w, h);
  for (const lane of lanes) {
    for (const segment of lane) {
      drawPath(ctxB, shifted(segment, -6), CYAN, 0.16);
      ctxB.shadowColor = CYAN; ctxB.shadowBlur = 7;
      drawPath(ctxB, segment, CYAN, 0.58, 1.25);
      ctxB.shadowBlur = 0;
      drawPath(ctxB, shifted(segment, 6), CYAN, 0.13);
    }
  }
  // Subtle functional junction indicators at every actual lane join.
  for (const j of junctionPoints(w, h)) {
    ctxB.beginPath(); ctxB.arc(j.x, j.y, 3, 0, Math.PI * 2);
    ctxB.fillStyle = CYAN; ctxB.globalAlpha = 0.55; ctxB.fill(); ctxB.globalAlpha = 1;
  }
  // Per-instance guides fade with that instance's lifetime; base lanes never reconfigure.
  for (const inst of state.instances) {
    const event = HOMEPAGE_EVENTS[((inst.eventIndex % HOMEPAGE_EVENTS.length) + HOMEPAGE_EVENTS.length) % HOMEPAGE_EVENTS.length]!;
    const age = state.activeTimeMs - inst.startMs;
    if (age < 0 || age > IMPACT_MS + DOWNSTREAM_MS + 800) continue;
    const fade = age < IMPACT_MS ? Math.min(1, age / 300) : Math.max(0, 1 - Math.max(0, age - IMPACT_MS) / (DOWNSTREAM_MS + 800));
    drawPath(ctxF, interventionPath(w, h, event.intervention, inst.eventIndex), event.intervention === 'coral' ? CORAL : AMBER, 0.45 * fade);
    const intercept = interceptFor(inst.eventIndex, w, h).point;
    if (event.motif === 'delay' && age > IMPACT_MS && age < IMPACT_MS + 1600) {
      // Small queue ring at the intercept while delayed packets hold there.
      ctxF.beginPath(); ctxF.arc(intercept.x, intercept.y, 11, 0, Math.PI * 2);
      ctxF.strokeStyle = AMBER; ctxF.globalAlpha = 0.5 * fade; ctxF.lineWidth = 1.4; ctxF.stroke(); ctxF.globalAlpha = 1;
    }
    // Local pulse only as the injection joins its lane at the intercept.
    if (age >= IMPACT_MS - 250 && age < IMPACT_MS + 250) {
      const grad = ctxF.createRadialGradient(intercept.x, intercept.y, 0, intercept.x, intercept.y, 46);
      grad.addColorStop(0, 'rgba(224,122,106,0.32)'); grad.addColorStop(1, 'rgba(224,122,106,0)');
      ctxF.fillStyle = grad; ctxF.beginPath(); ctxF.arc(intercept.x, intercept.y, 46, 0, Math.PI * 2); ctxF.fill();
      ctxF.beginPath(); ctxF.arc(intercept.x, intercept.y, 5, 0, Math.PI * 2);
      ctxF.strokeStyle = event.intervention === 'coral' ? CORAL : AMBER; ctxF.globalAlpha = 0.9; ctxF.stroke(); ctxF.globalAlpha = 1;
    }
  }
  for (const pkt of scenePacketsForInstances(state.instances, state.activeTimeMs, w, h)) {
    const ctx = pkt.layer === 'behind' ? ctxB : ctxF;
    const alpha = pkt.opacity ?? 1;
    if (pkt.trail) {
      ctx.strokeStyle = pkt.color; ctx.globalAlpha = 0.55 * alpha; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(pkt.trail.x, pkt.trail.y); ctx.lineTo(pkt.x, pkt.y); ctx.stroke(); ctx.globalAlpha = 1;
    }
    ctx.fillStyle = pkt.color; ctx.globalAlpha = alpha;
    ctx.shadowColor = pkt.color; ctx.shadowBlur = 13;
    ctx.fillRect(pkt.x - pkt.size / 2, pkt.y - pkt.size / 2, pkt.size, pkt.size);
    ctx.shadowBlur = 0; ctx.globalAlpha = 1;
  }
}
