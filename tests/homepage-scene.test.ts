import { describe, expect, it } from 'vitest';
import { HOMEPAGE_EVENTS, EVENT_CYCLE_MS, IMPACT_MS, OUTCOME_MS, MAX_ACTIVE_INSTANCES, createTimeline, advanceTimeline, nextEvent, pauseTimeline, resumeTimeline, setReducedMotion, phaseAt, presentationFor } from '../src/web/homepage-events.ts';
import { pointOnCubic, pointOnLane, streamLanes, junctionPoints, interventionPath, scenePacketsAt, scenePacketsForInstances, interceptFor, MAX_PACKETS, TRAVEL_MS, DOWNSTREAM_MS, streamSchedule, STREAM_PERIOD_MS, injectedTagPosition, INJECTED_TAG_WIDTH, INJECTED_TAG_HEIGHT } from '../src/web/homepage-scene.ts';

describe('homepage event catalog', () => {
  it('has at least 32 distinct concise events mapped to a small motif set', () => {
    expect(HOMEPAGE_EVENTS.length).toBeGreaterThanOrEqual(32);
    expect(new Set(HOMEPAGE_EVENTS.map(e => e.id)).size).toBe(HOMEPAGE_EVENTS.length);
    expect(new Set(HOMEPAGE_EVENTS.map(e => e.title)).size).toBe(HOMEPAGE_EVENTS.length);
    const motifs = new Set(HOMEPAGE_EVENTS.map(e => e.motif));
    expect(motifs.size).toBeLessThanOrEqual(6);
    expect(motifs.size).toBeGreaterThanOrEqual(4);
    for (const e of HOMEPAGE_EVENTS) {
      expect(e.title.length).toBeGreaterThan(3);
      expect(e.explanation.length).toBeGreaterThan(10);
      expect(e.incomingLabel).toBeTruthy();
      expect(e.outgoingLabel).toBeTruthy();
    }
    expect(HOMEPAGE_EVENTS.map(e => e.title)).toContain('Credit exceeded');
    expect(HOMEPAGE_EVENTS.map(e => e.title)).toContain('Duplicate fill detected');
  });
  it('does not reveal candidate variant labels', () => {
    const all = HOMEPAGE_EVENTS.map(e => `${e.id} ${e.title} ${e.explanation}`).join(' ');
    expect(all).not.toMatch(/candidate-[a-i]/i);
  });
});

describe('timeline', () => {
  it('starts the selected event consistently and continues through the catalog', () => {
    for (const eventIndex of [0, 17, HOMEPAGE_EVENTS.length - 1]) {
      for (const reducedMotion of [false, true]) {
        const start = createTimeline({ initialEventIndex: eventIndex, reducedMotion });
        expect(start.eventIndex).toBe(eventIndex);
        expect(start.instances[0]!.eventIndex).toBe(eventIndex);
        expect(presentationFor(start).event).toBe(HOMEPAGE_EVENTS[eventIndex]);
        expect(presentationFor(start).counter).toBe(`Event ${eventIndex + 1} of ${HOMEPAGE_EVENTS.length}`);
        expect(presentationFor(nextEvent(start)).event).toBe(HOMEPAGE_EVENTS[(eventIndex + 1) % HOMEPAGE_EVENTS.length]);
        if (!reducedMotion) {
          expect(advanceTimeline(start, EVENT_CYCLE_MS).eventIndex).toBe((eventIndex + 1) % HOMEPAGE_EVENTS.length);
        } else {
          expect(presentationFor(start).title).toBe(HOMEPAGE_EVENTS[eventIndex]!.title);
        }
      }
    }
  });
  it('caption changes only on outcome, not before impact', () => {
    let s = createTimeline();
    s = advanceTimeline(s, IMPACT_MS - 1);
    expect(phaseAt(s.elapsedMs)).toBe('input');
    expect(presentationFor(s).isOutcome).toBe(false);
    if (s.elapsedMs < OUTCOME_MS) s = advanceTimeline(s, OUTCOME_MS - s.elapsedMs);
    expect(presentationFor(s).isOutcome).toBe(true);
    expect(presentationFor(s).event.id).toBe(HOMEPAGE_EVENTS[s.eventIndex]!.id);
  });
  it('wraps at loop boundary to next event', () => {
    let s = createTimeline();
    s = advanceTimeline(s, EVENT_CYCLE_MS);
    expect(s.eventIndex).toBe(1);
    expect(s.elapsedMs).toBeLessThan(EVENT_CYCLE_MS);
  });
  it('pause freezes and resume has no wall-clock jump', () => {
    let s = advanceTimeline(createTimeline(), 1000);
    const frozen = pauseTimeline(s);
    expect(advanceTimeline(frozen, 5000)).toBe(frozen);
    const resumed = resumeTimeline(frozen);
    const after = advanceTimeline(resumed, 100);
    expect(after.elapsedMs).toBe(1100);
  });
  it('reduced motion never auto-advances but manual next works', () => {
    let s = createTimeline({ reducedMotion: true });
    expect(s.playing).toBe(false);
    expect(advanceTimeline(s, 10000)).toBe(s);
    const n = nextEvent(s);
    expect(n.eventIndex).toBe(1);
    expect(n.activeTimeMs).toBe(s.activeTimeMs);
    expect(resumeTimeline(s).playing).toBe(false);
  });
  it('preference change to reduced stops motion; clearing does not auto-play', () => {
    let s = setReducedMotion(createTimeline(), true);
    expect(s.playing).toBe(false);
    s = setReducedMotion(s, false);
    expect(s.playing).toBe(false);
    expect(s.reducedMotion).toBe(false);
  });
});

describe('scene geometry', () => {
  it('cubic endpoints are exact', () => {
    const c = { p0: { x: 0, y: 0 }, p1: { x: 10, y: 0 }, p2: { x: 10, y: 10 }, p3: { x: 20, y: 10 } };
    expect(pointOnCubic(c, 0)).toEqual({ x: 0, y: 0 });
    expect(pointOnCubic(c, 1)).toEqual({ x: 20, y: 10 });
  });
  it('packets are bounded, finite, and outgoing transforms differ by motif after impact', () => {
    const w = 1200, h = 600;
    const kinds = new Set<string>();
    for (let idx = 0; idx < HOMEPAGE_EVENTS.length; idx++) {
      const pk = scenePacketsAt(IMPACT_MS + TRAVEL_MS + 1000, idx, w, h);
      expect(pk.length).toBeLessThanOrEqual(MAX_PACKETS);
      for (const p of pk) { expect(Number.isFinite(p.x)).toBe(true); expect(Number.isFinite(p.y)).toBe(true); }
      for (const p of pk) if (p.kind !== 'stream' && p.kind !== 'intervention') kinds.add(p.kind);
    }
    expect(kinds.size).toBeGreaterThanOrEqual(5); // duplicate, delay, reorder, reject, corrupt, mismatch
  });
  it('before impact there is no transformed outgoing packet', () => {
    const pk = scenePacketsAt(500, 0, 1200, 600);
    expect(pk.some(p => ['duplicate', 'delay', 'reorder', 'reject', 'corrupt', 'mismatch'].includes(p.kind))).toBe(false);
  });
  it('lanes are connected segments spanning the whole scene with exact joins', () => {
    const w = 1200, h = 730;
    const lanes = streamLanes(w, h);
    expect(lanes.length).toBeGreaterThanOrEqual(5);
    for (const lane of lanes) {
      expect(lane.length).toBe(3);
      expect(lane[0]!.p0.x).toBeLessThan(0);
      expect(lane[lane.length - 1]!.p3.x).toBeGreaterThan(w);
      for (let s = 1; s < lane.length; s++) expect(lane[s]!.p0).toEqual(lane[s - 1]!.p3);
      for (const seg of lane) expect(seg.p0.x).toBeLessThanOrEqual(seg.p1.x); // x never runs backward
      expect(pointOnLane(lane, 0)).toEqual(lane[0]!.p0);
      expect(pointOnLane(lane, 1)).toEqual(lane[lane.length - 1]!.p3);
      for (const join of [1 / 3, 2 / 3]) {
        const a = pointOnLane(lane, join - 0.001); const b = pointOnLane(lane, join + 0.001);
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(5);
      }
      // A packet sampled along the lane moves monotonically rightward.
      let prevX = -Infinity;
      for (let t = 0; t <= 1.0001; t += 0.05) { const p = pointOnLane(lane, Math.min(1, t)); expect(p.x).toBeGreaterThanOrEqual(prevX - 0.001); prevX = p.x; }
    }
    expect(junctionPoints(w, h).length).toBe(lanes.length * 2);
  });
  it('ordinary blue traffic stays below the desktop copy until its rising right-hand exits', () => {
    const w = 1487, h = 666;
    for (const lane of streamLanes(w, h)) {
      for (let t = 0; t <= 1; t += 0.01) {
        const point = pointOnLane(lane, t);
        if (point.x < 684) expect(point.y).toBeGreaterThanOrEqual(420);
      }
      expect(pointOnLane(lane, 1).x).toBeGreaterThan(w);
    }
  });
  it('finite bounded packets for all 42 events at representative dimensions', () => {
    for (const [w, h] of [[320, 380], [390, 380], [768, 730], [1024, 730], [1487, 730]] as const) {
      for (let idx = 0; idx < HOMEPAGE_EVENTS.length; idx++) {
        for (const age of [0, 1500, IMPACT_MS, IMPACT_MS + 1200, IMPACT_MS + DOWNSTREAM_MS]) {
          const pk = scenePacketsAt(age, idx, w, h);
          expect(pk.length).toBeLessThanOrEqual(MAX_PACKETS);
          for (const p of pk) { expect(Number.isFinite(p.x)).toBe(true); expect(Number.isFinite(p.y)).toBe(true); }
        }
      }
    }
  });
  it('has 42 events each with a source-rule mapping', () => {
    expect(HOMEPAGE_EVENTS.length).toBe(42);
    for (const e of HOMEPAGE_EVENTS) expect(e.sourceRule.length).toBeGreaterThan(3);
  });
  it('corrected explanations use source-accurate wording', () => {
    const byId = new Map(HOMEPAGE_EVENTS.map((e) => [e.id, e]));
    expect(byId.get('stale-quote')!.explanation).toContain('already locked a price keep');
    expect(byId.get('reserved-credit-mismatch')!.explanation).toContain('fills still in transit');
    expect(byId.get('reservation-leaked')!.explanation).toContain('confirmed cancelled quantity');
    expect(byId.get('fill-after-final-cancel')!.explanation).toContain('occurred after cancellation');
    expect(byId.get('poisoned-idempotency-key')!.explanation).toContain('later valid report');
  });
  it('stream packets travel the full lane width before any impact', () => {
    const pk = scenePacketsAt(500, 0, 1200, 600);
    expect(pk.filter((p) => p.kind === 'stream').every((p) => p.layer === 'behind')).toBe(true);
    expect(pk.filter((p) => p.kind === 'stream').every((p) => p.size >= 6)).toBe(true);
    // Over a horizon the same continuous stream occupies both halves of the scene.
    const xs: number[] = [];
    for (let ms = 0; ms < STREAM_PERIOD_MS; ms += 733) xs.push(...scenePacketsForInstances([], ms, 1200, 600).filter((p) => p.kind === 'stream').map((p) => p.x));
    expect(Math.min(...xs)).toBeLessThan(1200 * 0.2);
    expect(Math.max(...xs)).toBeGreaterThan(1200 * 0.8);
  });
  it('intervention packet is removed after impact (transformed, not stuck)', () => {
    expect(scenePacketsAt(IMPACT_MS - 100, 0, 1200, 600).some((p) => p.kind === 'intervention')).toBe(true);
    expect(scenePacketsAt(IMPACT_MS + 500, 0, 1200, 600).some((p) => p.kind === 'intervention')).toBe(false);
  });
  it('stream clock is continuous across an event boundary', () => {
    const before = scenePacketsAt(EVENT_CYCLE_MS - 16, 0, 1200, 600, EVENT_CYCLE_MS - 16).filter((p) => p.kind === 'stream');
    const afterById = new Map(scenePacketsAt(16, 1, 1200, 600, EVENT_CYCLE_MS + 16).filter((p) => p.kind === 'stream').map((p) => [p.id, p]));
    const matched = before.filter((p) => afterById.has(p.id));
    expect(matched.length).toBeGreaterThan(0);
    const jump = Math.max(...matched.map((p) => { const q = afterById.get(p.id)!; return Math.hypot(p.x - q.x, p.y - q.y); }));
    expect(jump).toBeLessThan(30);
  });
  it('pointOnLane clamps t to the lane ends', () => {
    const lane = streamLanes(1200, 600)[0]!;
    expect(pointOnLane(lane, -1)).toEqual(pointOnLane(lane, 0));
    expect(pointOnLane(lane, 2)).toEqual(pointOnLane(lane, 1));
    expect(pointOnLane(lane, 1).x).toBeGreaterThan(1200);
  });
});

describe('continuity: stream never resets when scenarios are injected', () => {
  const streamOf = (s: ReturnType<typeof createTimeline>) => scenePacketsForInstances(s.instances, s.activeTimeMs, 1200, 600).filter((p) => p.kind === 'stream');
  it('manual Next at the same active time leaves base stream positions identical', () => {
    const s = advanceTimeline(createTimeline(), 4000);
    const before = streamOf(s);
    const after = streamOf(nextEvent(s));
    expect(after).toEqual(before);
  });
  it('playing Next starts a new injection at its entry, not at its outcome', () => {
    const s = nextEvent(advanceTimeline(createTimeline(), 4000));
    expect(s.elapsedMs).toBe(0);
    expect(presentationFor(s).isOutcome).toBe(false);
    const pk = scenePacketsForInstances(s.instances, s.activeTimeMs, 1200, 600);
    expect(pk.some((p) => p.kind === 'intervention')).toBe(true);
  });
  it('old in-flight effect keeps its packets at the same position across Next', () => {
    const s = advanceTimeline(createTimeline(), 4200);
    const motif = HOMEPAGE_EVENTS[0]!.motif;
    const before = scenePacketsForInstances(s.instances, s.activeTimeMs, 1200, 600).filter((p) => p.kind === motif);
    expect(before.length).toBeGreaterThan(0);
    const after = scenePacketsForInstances(nextEvent(s).instances, s.activeTimeMs, 1200, 600).filter((p) => p.kind === motif);
    for (const p of before) expect(after.some((q) => q.x === p.x && q.y === p.y)).toBe(true);
  });
  it('old and new instances coexist, then the old one expires', () => {
    let s = nextEvent(advanceTimeline(createTimeline(), 4000));
    expect(s.instances.length).toBe(2);
    s = advanceTimeline(s, 7000);
    expect(s.instances.some((i) => i.eventIndex === 0)).toBe(false);
    expect(s.instances.some((i) => i.eventIndex === 1)).toBe(true);
  });
  it('rapid Next burst stays bounded with no clock reset', () => {
    let s = advanceTimeline(createTimeline(), 1000);
    for (let i = 0; i < 12; i++) s = nextEvent(s);
    expect(s.instances.length).toBeLessThanOrEqual(MAX_ACTIVE_INSTANCES);
    expect(s.activeTimeMs).toBe(1000);
  });
  it('automatic cycle boundary moves the stream only naturally', () => {
    let s = advanceTimeline(createTimeline(), EVENT_CYCLE_MS - 16);
    const before = streamOf(s);
    s = advanceTimeline(s, 32);
    const afterById = new Map(streamOf(s).map((p) => [p.id, p]));
    const matched = before.filter((p) => afterById.has(p.id));
    expect(matched.length).toBeGreaterThan(0);
    const jump = Math.max(...matched.map((p) => { const q = afterById.get(p.id)!; return Math.hypot(p.x - q.x, p.y - q.y); }));
    expect(jump).toBeLessThan(30);
    expect(s.eventIndex).toBe(1);
    expect(s.elapsedMs).toBeLessThan(100);
  });
  it('paused and reduced Next are static: clock and base traffic unchanged', () => {
    for (const base of [pauseTimeline(advanceTimeline(createTimeline(), 2000)), createTimeline({ reducedMotion: true })]) {
      const n = nextEvent(base);
      expect(n.activeTimeMs).toBe(base.activeTimeMs);
      expect(n.playing).toBe(false);
      expect(presentationFor(n).isOutcome).toBe(true);
      expect(streamOf(n)).toEqual(streamOf(base));
    }
  });
  it('finishing prior effect never steals the newly selected caption', () => {
    let s = nextEvent(advanceTimeline(createTimeline(), 4000));
    s = advanceTimeline(s, OUTCOME_MS);
    const p = presentationFor(s);
    expect(p.event.id).toBe(HOMEPAGE_EVENTS[1]!.id);
    expect(p.title).toBe(HOMEPAGE_EVENTS[1]!.title);
    expect(s.instances.length).toBeGreaterThan(1);
  });
  it('intercepts are distributed along lanes, and every ingress ends exactly there moving rightward', () => {
    const xs = new Set<number>(); const lanesUsed = new Set<number>();
    for (let idx = 0; idx < HOMEPAGE_EVENTS.length; idx++) {
      const { point, t, laneIndex } = interceptFor(idx, 1200, 600);
      xs.add(Math.round(point.x)); lanesUsed.add(laneIndex);
      expect(point.x).toBeGreaterThan(1200 * 0.30);
      expect(point.x).toBeLessThan(1200 * 0.85); // leave visible downstream travel after each junction
      expect(t).toBeGreaterThan(0.35); expect(t).toBeLessThan(0.75);
      expect(point).toEqual(pointOnLane(streamLanes(1200, 600)[laneIndex]!, t));
      const path = interventionPath(1200, 600, HOMEPAGE_EVENTS[idx]!.intervention, idx);
      expect(path.p3).toEqual(point);
      expect(path.p0.x).toBeLessThan(point.x);
      let prevX = -Infinity;
      for (let s = 0; s <= 1.0001; s += 0.05) { const p = pointOnCubic(path, Math.min(1, s)); expect(p.x).toBeGreaterThanOrEqual(prevX - 0.001); prevX = p.x; }
      // The transformed packet starts exactly where the intervention ended.
      const motif = HOMEPAGE_EVENTS[idx]!.motif;
      const first = scenePacketsForInstances([{ eventIndex: idx, startMs: 0 }], IMPACT_MS, 1200, 600).find((p) => p.kind === motif);
      expect(first).toBeTruthy();
      expect(Math.hypot(first!.x - point.x, first!.y - point.y)).toBeLessThan(2);
    }
    expect(xs.size).toBeGreaterThanOrEqual(6);
    expect(lanesUsed.size).toBeGreaterThanOrEqual(4);
  });
  it('changed packets travel from intercept continuously to the right edge', () => {
    const idx = HOMEPAGE_EVENTS.findIndex((e) => e.motif === 'duplicate');
    const at = (age: number) => scenePacketsForInstances([{ eventIndex: idx, startMs: 0 }], age, 1200, 600).filter((p) => p.kind === 'duplicate');
    const early = at(IMPACT_MS + 150); const mid = at(IMPACT_MS + 1150); const late = at(IMPACT_MS + DOWNSTREAM_MS - 600);
    expect(early.length).toBeGreaterThan(0); expect(mid.length).toBeGreaterThan(0); expect(late.length).toBeGreaterThan(0);
    expect(mid[0]!.x).toBeGreaterThan(early[0]!.x);
    expect(late[0]!.x).toBeGreaterThan(1200 * 0.80);
    const nearEnd = at(IMPACT_MS + DOWNSTREAM_MS - 100);
    expect(nearEnd[0]!.x).toBeGreaterThan(1200 * 0.90);
  });
  it('delay motif stalls at the intercept before continuing', () => {
    const idx = HOMEPAGE_EVENTS.findIndex((e) => e.motif === 'delay');
    const { point } = interceptFor(idx, 1200, 600);
    const at = (age: number) => scenePacketsForInstances([{ eventIndex: idx, startMs: 0 }], age, 1200, 600).filter((p) => p.kind === 'delay');
    const a = at(IMPACT_MS + 100); const b = at(IMPACT_MS + 700); const c = at(IMPACT_MS + 1600);
    expect(a[0]).toMatchObject({ x: point.x, y: point.y });
    expect(b[0]).toMatchObject({ x: point.x, y: point.y });
    expect(Math.hypot(c[0]!.x - point.x, c[0]!.y - point.y)).toBeGreaterThan(5);
  });
});

describe('irregular base traffic', () => {
  it('arrival gaps and per-packet travel times vary within a lane, with bursts and gaps', () => {
    for (const direction of ['in', 'out'] as const) {
      const entries = streamSchedule(direction, 2, 3);
      expect(entries.length).toBeGreaterThan(4);
      const gaps = entries.slice(1).map((e, i) => e.emitMs - entries[i]!.emitMs);
      expect(new Set(gaps.map((g) => Math.round(g))).size).toBeGreaterThan(3);
      expect(Math.min(...gaps)).toBeLessThan(900); // burst spacing
      expect(Math.max(...gaps)).toBeGreaterThan(1500); // a real gap after a burst
      const travels = entries.map((e) => e.travelMs);
      expect(Math.max(...travels) - Math.min(...travels)).toBeGreaterThan(800);
      for (const t of travels) { expect(t).toBeGreaterThanOrEqual(2600); expect(t).toBeLessThanOrEqual(8000); }
    }
  });
  it('schedule is deterministic and scenario-independent', () => {
    expect(streamSchedule('in', 1, 5)).toEqual(streamSchedule('in', 1, 5));
    const withEvent = scenePacketsAt(5000, 0, 1200, 600).filter((p) => p.kind === 'stream');
    const bare = scenePacketsForInstances([], 5000, 1200, 600).filter((p) => p.kind === 'stream');
    expect(withEvent).toEqual(bare);
  });
  it('retains identical traffic after seeking cycles and resizing', () => {
    const time = STREAM_PERIOD_MS + 500;
    const desktop = scenePacketsForInstances([], time, 1200, 600);
    const mobile = scenePacketsForInstances([], time, 375, 380);
    for (const later of [9 * STREAM_PERIOD_MS, 0, 2 * STREAM_PERIOD_MS]) {
      scenePacketsForInstances([], later, 900, 500);
      expect(scenePacketsForInstances([], time, 1200, 600)).toEqual(desktop);
      expect(scenePacketsForInstances([], time, 375, 380)).toEqual(mobile);
    }
  });
  it('same packet has no discontinuity at the scheduling-window boundary', () => {
    const at = (ms: number) => new Map(scenePacketsForInstances([], ms, 1200, 600).filter((p) => p.id).map((p) => [p.id!, p]));
    const before = at(STREAM_PERIOD_MS - 50);
    const after = at(STREAM_PERIOD_MS + 50);
    const matched = [...before.keys()].filter((id) => after.has(id));
    expect(matched.length).toBeGreaterThan(3); // in-flight packets finish across the boundary
    for (const id of matched) {
      const a = before.get(id)!, b = after.get(id)!;
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(40);
    }
  });
  it('base population stays bounded over a long horizon', () => {
    for (let ms = 0; ms <= STREAM_PERIOD_MS * 3; ms += 977) {
      expect(scenePacketsForInstances([], ms, 1200, 600).length).toBeLessThanOrEqual(MAX_PACKETS);
    }
  });
  it('pause freezes base traffic and resume continues without a jump', () => {
    const s = pauseTimeline(advanceTimeline(createTimeline(), 3000));
    const frozen = scenePacketsForInstances(s.instances, s.activeTimeMs, 1200, 600);
    expect(advanceTimeline(s, 5000)).toBe(s); // paused timeline never advances the clock
    const resumed = advanceTimeline(resumeTimeline(s), 50);
    const after = new Map(scenePacketsForInstances(resumed.instances, resumed.activeTimeMs, 1200, 600).filter((p) => p.id).map((p) => [p.id!, p]));
    const matched = frozen.filter((p) => p.id && after.has(p.id));
    expect(matched.length).toBeGreaterThan(0);
    for (const p of matched) expect(Math.hypot(p.x - after.get(p.id!)!.x, p.y - after.get(p.id!)!.y)).toBeLessThan(40);
  });
});

describe('rejection is local and forward-only', () => {
  it('joins continuously at impact without teleporting back upstream', () => {
    for (let idx = 0; idx < HOMEPAGE_EVENTS.length; idx++) {
      if (HOMEPAGE_EVENTS[idx]!.motif !== 'reject') continue;
      const at = (age: number) => scenePacketsForInstances([{ eventIndex: idx, startMs: 0 }], age, 1200, 600);
      const before = at(IMPACT_MS - 1).find((p) => p.kind === 'intervention')!;
      const after = at(IMPACT_MS).find((p) => p.kind === 'reject')!;
      const intercept = interceptFor(idx, 1200, 600).point;
      expect(Math.hypot(before.x - after.x, before.y - after.y)).toBeLessThan(2);
      expect(after.x).toBeCloseTo(intercept.x);
      expect(after.y).toBeCloseTo(intercept.y);
      // The leading packet stays the first rejection until its own exit at 1650ms.
      const lead = [0, 150, 500, 899, 900, 1200, 1600].map((age) => at(IMPACT_MS + age).find((p) => p.kind === 'reject')!);
      for (let i = 1; i < lead.length; i++) expect(lead[i]!.x).toBeGreaterThanOrEqual(lead[i - 1]!.x);
      for (let age = 0; age <= 2300; age += 100) {
        for (const packet of at(IMPACT_MS + age).filter((p) => p.kind === 'reject')) expect(packet.x).toBeGreaterThanOrEqual(intercept.x);
      }
    }
  });
  it('red packets never move backward, decelerate into the intercept, then fade while dropping', () => {
    const idx = HOMEPAGE_EVENTS.findIndex((e) => e.motif === 'reject');
    const { point } = interceptFor(idx, 1200, 600);
    const at = (age: number) => scenePacketsForInstances([{ eventIndex: idx, startMs: 0 }], age, 1200, 600).filter((p) => p.kind === 'reject');
    const samples = [150, 500, 900, 1300, 1600].map((a) => at(IMPACT_MS + a));
    for (const s of samples) expect(s.length).toBeGreaterThan(0);
    const track = samples.map((s) => s.find(p => p.id === samples[0]![0]!.id)!);
    for (let i = 1; i < track.length; i++) expect(track[i]!.x).toBeGreaterThanOrEqual(track[i - 1]!.x - 0.001);
    // Approaches the intercept, never retreats anywhere near the left edge.
    const all = samples.flat();
    expect(Math.min(...all.map((p) => p.x))).toBeGreaterThan(point.x - 260);
    // Fade/drop phase: opacity strictly falls and y grows after the intercept stop.
    const exitSamples = [1000, 1300, 1600].map((a) => at(IMPACT_MS + a)[0]).filter(Boolean);
    expect(exitSamples.length).toBeGreaterThan(1);
    expect(exitSamples[exitSamples.length - 1]!.opacity!).toBeLessThan(exitSamples[0]!.opacity!);
    expect(exitSamples[exitSamples.length - 1]!.y).toBeGreaterThan(exitSamples[0]!.y);
    expect(at(IMPACT_MS + 1700)).toEqual([]); // the rejected packet has finished fading
    // Normal cyan throughput continues during a rejection.
    expect(scenePacketsForInstances([{ eventIndex: idx, startMs: 0 }], IMPACT_MS + 1200, 1200, 600).some((p) => p.kind === 'stream')).toBe(true);
  });
});

describe('injected tag safe region', () => {
  it('stays in the lower art zone and inside the scene for all widths/events', () => {
    for (const [w, h] of [[320, 380], [390, 380], [768, 730], [1024, 730], [1487, 730]] as const) {
      for (let idx = 0; idx < HOMEPAGE_EVENTS.length; idx++) {
        const pos = injectedTagPosition(idx, w, h);
        const tagW = w <= 700 ? 148 : INJECTED_TAG_WIDTH;
        expect(pos.x).toBeGreaterThanOrEqual(0);
        expect(pos.y).toBeGreaterThanOrEqual(0);
        expect(pos.x + tagW).toBeLessThanOrEqual(w);
        expect(pos.y + INJECTED_TAG_HEIGHT).toBeLessThanOrEqual(h - h * 0.10); // clear of the scene bar zone
        if (w > 700 && w <= 1100) expect(pos.y).toBeGreaterThanOrEqual(h * 0.69);
        if (w > 1100 && pos.x < w * 0.49) expect(pos.y).toBeGreaterThanOrEqual(h * 0.65);
      }
    }
  });
});

describe('effect lifetimes and continuous splits', () => {
  it('one injected packet reaches its effect without a jump for every scenario', () => {
    for (const [w, h] of [[350, 380], [1000, 666], [1487, 666]]) {
      for (let idx = 0; idx < HOMEPAGE_EVENTS.length; idx++) {
        const at = (ms: number) => scenePacketsAt(ms, idx, w!, h!).filter(p => p.kind !== 'stream');
        for (const ms of [500, IMPACT_MS - 500, IMPACT_MS - 1]) expect(at(ms)).toHaveLength(1);
        const incoming = at(IMPACT_MS - 1)[0]!;
        const changed = at(IMPACT_MS + 1).find(p => p.id === incoming.id)!;
        expect(changed).toBeTruthy();
        expect(Math.hypot(incoming.x - changed.x, incoming.y - changed.y)).toBeLessThan(2);
        expect(at(10000)).toEqual([]); // complete before instance pruning at 10200ms
      }
    }
  });
  it('duplicates are born at the original, separate smoothly and both exit at the right edge', () => {
    const idx = HOMEPAGE_EVENTS.findIndex(e => e.motif === 'duplicate');
    const at = (ms: number) => scenePacketsAt(IMPACT_MS + ms, idx, 1200, 666).filter(p => p.kind === 'duplicate');
    const birth = at(0);
    expect(birth).toHaveLength(2);
    expect(birth[0]!.x).toBe(birth[1]!.x);
    expect(birth[0]!.y).toBe(birth[1]!.y);
    expect(at(600)[0]!.x).toBeGreaterThan(at(600)[1]!.x);
    expect(at(DOWNSTREAM_MS + 100)).toHaveLength(1);
    expect(at(DOWNSTREAM_MS + 100)[0]!.x).toBeGreaterThan(1200);
    expect(at(DOWNSTREAM_MS + 200)).toEqual([]);
  });
  it('a slower reordered packet stays alive until its own exit', () => {
    const idx = HOMEPAGE_EVENTS.findIndex(e => e.motif === 'reorder');
    const at = (ms: number) => scenePacketsAt(IMPACT_MS + ms, idx, 1200, 666).filter(p => p.kind === 'reorder');
    const slow = at(DOWNSTREAM_MS - 1).find(p => p.id!.endsWith(':slow'))!;
    const next = at(DOWNSTREAM_MS + 1).find(p => p.id === slow.id)!;
    expect(next).toBeTruthy();
    expect(Math.hypot(next.x - slow.x, next.y - slow.y)).toBeLessThan(2);
    expect(at(DOWNSTREAM_MS / 0.75 - 1)[0]!.x).toBeGreaterThan(1200);
    expect(at(DOWNSTREAM_MS / 0.75 + 1)).toEqual([]);
  });
  it('mismatch branches start at their parent and then diverge without teleporting', () => {
    for (let idx = 0; idx < HOMEPAGE_EVENTS.length; idx++) {
      if (HOMEPAGE_EVENTS[idx]!.motif !== 'mismatch') continue;
      const at = (ms: number) => scenePacketsAt(IMPACT_MS + ms, idx, 1200, 666).filter(p => p.kind === 'mismatch');
      const birth = at(DOWNSTREAM_MS / 2);
      expect(birth).toHaveLength(2);
      expect(birth[0]!.x).toBeCloseTo(birth[1]!.x);
      expect(birth[0]!.y).toBeCloseTo(birth[1]!.y);
      const next = at(DOWNSTREAM_MS / 2 + 1).find(p => p.id === birth[1]!.id)!;
      expect(Math.hypot(next.x - birth[1]!.x, next.y - birth[1]!.y)).toBeLessThan(2);
      const split = at(DOWNSTREAM_MS - 100);
      expect(Math.abs(split[0]!.y - split[1]!.y)).toBeGreaterThan(10);
    }
  });
});

describe('presentation mapping', () => {
  it('initial render is an in-flight caption, not the first event outcome', () => {
    const p = presentationFor(createTimeline());
    expect(p.isOutcome).toBe(false);
    expect(p.title).not.toBe(HOMEPAGE_EVENTS[0]!.title);
    expect(p.explanation.length).toBeGreaterThan(10);
    expect(p.outgoingLabel).toBe('awaiting outcome');
    expect(p.incomingLabel).toBe(HOMEPAGE_EVENTS[0]!.incomingLabel);
    expect(p.counter).toBe(`Event 1 of ${HOMEPAGE_EVENTS.length}`);
  });
  it('second event: pre-impact shows its input label, outcome shows its own title/label atomically', () => {
    let s = nextEvent(createTimeline());
    s = { ...s, elapsedMs: 100 };
    const pre = presentationFor(s);
    expect(pre.event.id).toBe(HOMEPAGE_EVENTS[1]!.id);
    expect(pre.incomingLabel).toBe(HOMEPAGE_EVENTS[1]!.incomingLabel);
    expect(pre.outgoingLabel).toBe('awaiting outcome');
    s = { ...s, elapsedMs: OUTCOME_MS };
    const out = presentationFor(s);
    expect(out.title).toBe(HOMEPAGE_EVENTS[1]!.title);
    expect(out.explanation).toBe(HOMEPAGE_EVENTS[1]!.explanation);
    expect(out.outgoingLabel).toBe(HOMEPAGE_EVENTS[1]!.outgoingLabel);
    expect(out.counter).toBe(`Event 2 of ${HOMEPAGE_EVENTS.length}`);
  });
  it('final-to-first rollover keeps caption and labels on the new event', () => {
    let s = { ...createTimeline(), eventIndex: HOMEPAGE_EVENTS.length - 1, elapsedMs: EVENT_CYCLE_MS - 10, activeTimeMs: EVENT_CYCLE_MS - 10, instances: [{ eventIndex: HOMEPAGE_EVENTS.length - 1, startMs: 0 }] };
    s = advanceTimeline(s, 20);
    expect(s.eventIndex).toBe(0);
    const p = presentationFor(s);
    expect(p.event.id).toBe(HOMEPAGE_EVENTS[0]!.id);
    expect(p.incomingLabel).toBe(HOMEPAGE_EVENTS[0]!.incomingLabel);
    expect(p.counter).toBe(`Event 1 of ${HOMEPAGE_EVENTS.length}`);
  });
  it('outcome is readable for about six seconds', () => {
    expect(EVENT_CYCLE_MS - OUTCOME_MS).toBeGreaterThanOrEqual(5500);
    expect(EVENT_CYCLE_MS - OUTCOME_MS).toBeLessThanOrEqual(6500);
  });
  it('reduced-motion initial state and Next while reduced show a meaningful static outcome', () => {
    const s = createTimeline({ reducedMotion: true });
    const p = presentationFor(s);
    expect(p.isOutcome).toBe(true);
    expect(p.title).toBe(HOMEPAGE_EVENTS[0]!.title);
    const n = presentationFor(nextEvent(s));
    expect(n.title).toBe(HOMEPAGE_EVENTS[1]!.title);
    expect(n.outgoingLabel).toBe(HOMEPAGE_EVENTS[1]!.outgoingLabel);
  });
  it('Next while paused shows the new outcome immediately and stays paused', () => {
    const s = nextEvent(pauseTimeline(createTimeline()));
    expect(s.playing).toBe(false);
    expect(presentationFor(s).title).toBe(HOMEPAGE_EVENTS[1]!.title);
  });
});
