import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { TraceEntry, Violation } from '../src/domain.ts';
import { buildStageProjection, creditBarGeometry, diffRecordedStates, formatRecordedValue, visiblePositionForTracePosition } from '../src/web/replay-stage.ts';
import { StagePacketAnimator } from '../src/web/stage-animation.ts';
import { buildTraceSteps, groupUnimportantSteps, PlaybackController, type PlaybackTimers } from '../src/web/reproduction-player.ts';
import { liveActivity } from '../src/web/reproduction-view.ts';
import type { StateAdapterKind } from '../src/web/snapshot.ts';

interface CaseData { id: string; trace: TraceEntry[]; violations: Violation[] }
const cases = (JSON.parse(readFileSync(new URL('../docs/design/replay-lab/cases.json', import.meta.url), 'utf8')) as { cases: CaseData[] }).cases;
function kindFor(id: string): StateAdapterKind { return id.startsWith('trading-') ? 'trading' : id.startsWith('inventory-') ? 'inventory' : 'unknown'; }
function proj(id: string) { const c = cases.find(x => x.id === id)!; return { c, p: buildStageProjection(c.trace, c.violations, kindFor(id)) }; }

describe('approved 32-example projection', () => {
  it('covers 13 fault, 13 clean and six edge examples with one frame per trace entry', () => {
    expect(cases).toHaveLength(32);
    expect(cases.filter(c => !c.id.endsWith('-clean') && !c.id.startsWith('synthetic-'))).toHaveLength(13);
    expect(cases.filter(c => c.id.endsWith('-clean'))).toHaveLength(13);
    expect(cases.filter(c => c.id.startsWith('synthetic-'))).toHaveLength(6);
    for (const c of cases) {
      const p = buildStageProjection(c.trace, c.violations, kindFor(c.id));
      expect(p.frames, c.id).toHaveLength(c.trace.length);
      // Clean controls never acquire failure styling.
      if (c.violations.length === 0) expect(p.frames.every(f => !f.isViolation), c.id).toBe(true);
      // Every fault case is explained at a unique or group-level recorded action.
      if (c.violations.length > 0) expect(p.findingTracePosition !== null || p.groupFindingTracePosition !== null, c.id).toBe(true);
    }
  });

  it('credit capacity: 100 used + 100 reserved reaches 200 against a 100 limit on a fixed scale', () => {
    const { p } = proj('trading-candidate-c');
    const f = p.frames[p.findingTracePosition!]!;
    expect(f.visual.kind).toBe('capacity');
    expect(f.visual.credit).toMatchObject({ used: 100, reserved: 100, total: 200, limit: 100 });
    expect(f.visual.credit!.limitPct).toBe(50);
    expect(f.visual.credit!.totalPct).toBe(100);
    expect(p.scaleMax).toBeGreaterThanOrEqual(200);
  });

  it('credit inconsistency and signed negatives keep recorded values', () => {
    const f = proj('trading-candidate-f').p.frames.find(x => x.visual.comparison.some(r => r.label === 'Used credit'))!;
    expect(f.visual.comparison).toContainEqual(expect.objectContaining({ label: 'Used credit', before: 70, after: 30 }));
    const b = proj('trading-candidate-b').p;
    const neg = b.frames.find(x => x.visual.credit?.negative.includes('reserved'))!;
    expect(neg.visual.credit!.reserved).toBeLessThan(0);
    expect(neg.visual.credit!.reservedPct).toBeLessThan(0);
  });

  it('version regression, lifecycle quantities, duplicate identity and price/quantity conflicts', () => {
    const v = proj('trading-candidate-d').p.frames.find(x => x.visual.kind === 'version')!;
    expect(v.visual.versionChanges).toContainEqual(expect.objectContaining({ before: 2, after: 1, regressed: true }));
    const life = proj('trading-candidate-i').p.frames.find(x => x.visual.kind === 'lifecycle')!;
    expect(life.visual.statusChanges.map(d => d.after)).toContain('FILLED');
    expect(life.visual.quantities.map(d => `${d.path}=${String(d.after)}`).join(' ')).toContain('6');
    const dup = proj('trading-candidate-a').p.frames.find(x => x.visual.kind === 'identity' && (x.visual.occurrences ?? 0) >= 2)!;
    expect(dup.visual.occurrences).toBeGreaterThanOrEqual(2);
    const conflict = proj('trading-candidate-h').p.frames.flatMap(x => x.visual.conflicts).find(c => c.field === 'quantity');
    expect(conflict).toBeTruthy();
    expect(conflict!.eventValue).not.toBe(conflict!.recordedValue);
  });

  it('inventory balances and recorded expected/observed comparisons', () => {
    const a = proj('inventory-candidate-a').p;
    const over = a.frames.flatMap(f => f.visual.stockRows).find(r => r.sku === 'item' && r.reservedRemaining === 14)!;
    expect(over).toMatchObject({ onHand: 10, overReserved: true, available: -4 });
    const withComparison = a.frames.find(f => f.visual.comparison.length > 0);
    expect(withComparison).toBeTruthy();
    const b = proj('inventory-candidate-b').p;
    expect(b.frames.some(f => f.visual.comparison.some(r => JSON.stringify(r.before) !== JSON.stringify(r.after)))).toBe(true);
  });

  it('generic fallback, missing state and distinct recorded values', () => {
    const unknown = proj('synthetic-unknown-fields').p;
    expect(unknown.frames.some(f => f.visual.kind === 'diff')).toBe(true);
    const missing = proj('synthetic-missing-state').p;
    expect(missing.frames.some(f => !f.stateKnown && f.visual.kind === 'not-recorded')).toBe(true);
    const afterGap = missing.frames.find(f => f.stateStatus === 'first-recorded' && f.tracePosition > 0);
    expect(afterGap?.diffs.every(d => d.kind === 'first-recorded')).toBe(true);
    expect(formatRecordedValue(undefined)).toBe('not recorded');
    expect(formatRecordedValue(null)).toBe('null');
    expect(formatRecordedValue(false)).toBe('false');
    expect(formatRecordedValue(0)).toBe('0');
    expect(diffRecordedStates(undefined, { a: 0, b: false, c: null })).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'a', after: 0, kind: 'first-recorded' })]));
    expect(diffRecordedStates({ a: 1 }, undefined)).toEqual([]);
    // Duplicate outcome stays neutral: no recorded violation, no failure frame.
    const dup = proj('synthetic-duplicate-neutral').p;
    expect(dup.frames.every(f => !f.isViolation)).toBe(true);
    // Empty trace: no frames and no finding target.
    const empty = proj('synthetic-empty').p;
    expect(empty.frames).toEqual([]); expect(empty.findingTracePosition).toBeNull();
  });

  it('unknown adapter never acquires trading/inventory domain meaning from familiar keys', () => {
    const { c } = proj('trading-candidate-c');
    const p = buildStageProjection(c.trace, c.violations, 'unknown');
    expect(p.frames.every(f => f.visual.kind !== 'capacity' && f.visual.kind !== 'stock')).toBe(true);
    expect(p.frames.every(f => f.visual.credit === null)).toBe(true);
  });

  it('group-level findings appear only at their recorded action and tracePosition resolves in the matching view', () => {
    const amb = proj('synthetic-ambiguous').p;
    expect(amb.findingTracePosition).toBeNull();
    expect(amb.groupFindingTracePosition).not.toBeNull();
    expect(amb.frames.filter(f => f.isGroupFinding).every(f => f.tracePosition === amb.groupFindingTracePosition || amb.frames[f.tracePosition]!.groupViolations.length > 0)).toBe(true);
    const { c } = proj('trading-candidate-c');
    const { steps } = buildTraceSteps(c.trace, c.violations);
    const grouped = groupUnimportantSteps(steps);
    const visible = grouped ?? steps;
    const pos = visiblePositionForTracePosition(visible, amb.groupFindingTracePosition);
    expect(pos === null || visible[pos]).toBeTruthy();
    // A step's raw tracePosition indexes the same trace's frames, not its visible position.
    for (const s of visible) if (!s.isGroup) expect(buildStageProjection(c.trace, c.violations, 'trading').frames[s.tracePosition]!.tracePosition).toBe(s.tracePosition);
  });
});

describe('inventory stage preserves unknown quantities', () => {
  function rows(state: Record<string, unknown>) {
    const trace: TraceEntry[] = [{ step: 0, time: 0, action: 'deliver', outcome: 'processed', payload: { type: 'receive', sku: 'item' }, state }];
    const visual = buildStageProjection(trace, [], 'inventory').frames[0]!.visual;
    expect(visual.kind).toBe('stock');
    return visual.stockRows;
  }
  const stock = { item: { received: 20, onHand: 10 } };

  it.each([
    ['missing remaining', { sku: 'item' }],
    ['null remaining', { sku: 'item', remaining: null }],
    ['text remaining', { sku: 'item', remaining: '4' }],
    ['nonfinite remaining', { sku: 'item', remaining: Infinity }],
    ['fractional remaining', { sku: 'item', remaining: 0.5 }],
    ['unsafe remaining', { sku: 'item', remaining: Number.MAX_SAFE_INTEGER + 1 }],
    ['missing SKU', { remaining: 4 }],
    ['empty SKU', { sku: '', remaining: 4 }],
    ['padded SKU', { sku: ' item ', remaining: 4 }],
    ['non-string SKU', { sku: 7, remaining: 4 }],
    ['malformed reservation', null],
  ])('keeps reservation and availability unknown for %s', (_label, reservation) => {
    expect(rows({ stock, reservations: { r1: reservation } })).toEqual([
      { sku: 'item', received: 20, onHand: 10, reservedRemaining: null, available: null, overReserved: null },
    ]);
  });

  it('distinguishes absent reservation data from a recorded empty table and preserves signed balances', () => {
    for (const reservations of [undefined, null, 'unavailable']) {
      expect(rows({ stock, reservations })[0]).toMatchObject({ reservedRemaining: null, available: null, overReserved: null });
    }
    expect(rows({ stock, reservations: {} })[0]).toMatchObject({ reservedRemaining: 0, available: 10, overReserved: false });
    expect(rows({ target: { stock, reservations: { r: { sku: 'item', remaining: 14 } } } })[0])
      .toMatchObject({ reservedRemaining: 14, available: -4, overReserved: true });
    expect(rows({ stock, reservations: { r: { sku: 'item', remaining: -4 } } })[0])
      .toMatchObject({ reservedRemaining: -4, available: 14, overReserved: false });
  });

  it('propagates unsafe arithmetic and unknown stock without dropping recorded rows', () => {
    expect(rows({ stock, reservations: { a: { sku: 'item', remaining: Number.MAX_SAFE_INTEGER }, b: { sku: 'item', remaining: 1 } } })[0])
      .toMatchObject({ reservedRemaining: null, available: null, overReserved: null });
    for (const onHand of [10.5, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER]) {
      expect(rows({ stock: { item: { onHand } }, reservations: { r: { sku: 'item', remaining: 1 } } })[0])
        .toMatchObject({ onHand, reservedRemaining: 1, available: null, overReserved: null });
    }
    expect(rows({ stock: { ...stock, bad: null }, reservations: {} })).toEqual([
      { sku: 'item', received: 20, onHand: 10, reservedRemaining: 0, available: 10, overReserved: false },
      { sku: 'bad', received: null, onHand: null, reservedRemaining: 0, available: null, overReserved: null },
    ]);
  });

  it('isolates a malformed quantity to its SKU, but an unknown SKU makes all reservation totals unknown', () => {
    const multipleStock = { ...stock, other: { onHand: 8 } };
    expect(rows({ stock: multipleStock, reservations: { r: { sku: 'item', remaining: null } } }))
      .toEqual([
        { sku: 'item', received: 20, onHand: 10, reservedRemaining: null, available: null, overReserved: null },
        { sku: 'other', received: null, onHand: 8, reservedRemaining: 0, available: 8, overReserved: false },
      ]);
    const unknownSku = rows({ stock: multipleStock, reservations: { r: { remaining: 4 } } });
    expect(unknownSku).toHaveLength(2);
    expect(unknownSku.every(row => row.reservedRemaining === null && row.available === null && row.overReserved === null)).toBe(true);
  });
});

describe('playback lifetime against the production controller', () => {
  function fakeTimers() {
    let cb: (() => void) | null = null;
    const timers: PlaybackTimers = { set: (fn) => { cb = fn; return 1; }, clear: () => { cb = null; } };
    return { timers, fire: () => cb?.(), has: () => cb !== null };
  }
  it('stale callbacks are inert after pause/seek and play-at-end restarts', () => {
    const fake = fakeTimers(); let changes = 0;
    const pc = new PlaybackController(3, () => changes++, fake.timers, 10);
    pc.play(); fake.fire(); expect(pc.position).toBe(0);
    const staleFire = fake.fire; pc.pause(); staleFire(); expect(pc.position).toBe(0);
    pc.select(2); expect(pc.atEnd).toBe(true); pc.play(); expect(pc.position).toBe(-1);
    pc.handleHidden(); expect(pc.playing).toBe(false);
    pc.play(); pc.handleReducedMotion(true); expect(pc.playing).toBe(false);
    pc.setCount(0); expect(pc.position).toBe(-1); pc.play(); expect(pc.playing).toBe(false);
    pc.dispose(); expect(pc.playing).toBe(false);
  });
});

describe('repair: ceiling, signed geometry, unknown adapter', () => {
  it('limit is not rendered as expected value; actual 200 vs limit 100 stays in bar/legend model', () => {
    const { p } = proj('trading-candidate-c');
    for (const f of p.frames) for (const r of f.visual.comparison) { expect(r.label).not.toMatch(/against recorded limit/i); expect(!(r.before === 100 && r.after === 200)).toBe(true); }
    const f = p.frames[p.findingTracePosition!]!;
    expect(f.visual.credit).toMatchObject({ total: 200, limit: 100 });
    expect(f.visual.credit!.bar).toMatchObject({ mode: 'stacked', limitPct: 50 });
  });
  it('signed geometry: used 40 + reserved -40 = total 0 is not 80 positive units', () => {
    const bar = creditBarGeometry(40, -40, 0, 100, 100)!;
    expect(bar.mode).toBe('signed'); expect(bar.zeroPct).toBe(50);
    const used = bar.segments.find(s => s.label === 'used')!; const res = bar.segments.find(s => s.label === 'reserved')!; const tot = bar.segments.find(s => s.label === 'total')!;
    expect(used).toMatchObject({ left: 50, width: 20, negative: false });
    expect(res).toMatchObject({ width: 20, negative: true }); expect(res.left + res.width).toBe(50);
    expect(tot.width).toBe(0);
    expect(used.width + res.width).not.toBe(80);
    // Missing stays unknown: no segment for null.
    expect(creditBarGeometry(null, -40, null, null, 100)!.segments.map(s => s.label)).toEqual(['reserved']);
    expect(creditBarGeometry(null, null, null, null, 100)).toBeNull();
    // Negative alone is geometry, not failure: projection frame need not be violation.
    const b = proj('trading-candidate-b').p; const neg = b.frames.find(x => x.visual.credit?.bar?.mode === 'signed');
    expect(neg).toBeTruthy();
  });
  it('unknown adapter with version/status/executionId and familiar invariants stays generic', () => {
    const trace: TraceEntry[] = [
      { step: 0, time: 0, action: 'deliver', payload: { type: 'execution', executionId: 'e1', id: 'e1' }, outcome: 'accepted', state: { version: 2, status: 'OPEN', usedCredit: 10, nested: { flag: false, n: 0, z: null } } },
      { step: 1, time: 1, action: 'deliver', payload: { type: 'execution', executionId: 'e1', id: 'e1' }, outcome: 'duplicate', state: { version: 1, status: 'FILLED', usedCredit: 20, nested: { flag: true, n: 1, z: null } } },
    ] as unknown as TraceEntry[];
    const violations: Violation[] = [{ id: 'v1', invariant: 'version_monotonic credit_limit execution_idempotency', step: 1, message: 'x', evidence: {} } as Violation];
    const p = buildStageProjection(trace, violations, 'unknown');
    expect(p.frames.every(f => f.visual.kind === 'diff' || f.visual.kind === 'not-recorded')).toBe(true);
    expect(p.frames.every(f => f.visual.credit === null && f.visual.stockRows.length === 0 && f.visual.versionChanges.length === 0)).toBe(true);
    // Generic diff keeps false/0/null distinct and shows version as plain field.
    const diffs = p.frames[1]!.diffs; expect(diffs).toContainEqual(expect.objectContaining({ path: 'version', before: 2, after: 1 }));
    // Missing snapshot breaks continuity: next known is first-recorded.
    const gapped: TraceEntry[] = [trace[0]!, { ...trace[1]!, state: undefined } as unknown as TraceEntry, trace[1]!];
    const gp = buildStageProjection(gapped, [], 'unknown');
    expect(gp.frames[1]!.visual.kind).toBe('not-recorded');
    expect(gp.frames[2]!.diffs.every(d => d.kind === 'first-recorded')).toBe(true);
  });
});

describe('repair: packet animator lifetime', () => {
  function fakeRaf() { let cb: ((n: number) => void) | null = null; const cancelled: number[] = []; return { deps: { request: (fn: (n: number) => void) => { cb = fn; return 7; }, cancel: (h: number) => { cancelled.push(h); cb = null; }, now: () => 0, durationMs: 100 }, fire: (n: number) => { const c = cb; cb = null; c?.(n); }, cancelled, has: () => cb !== null }; }
  it('pause/cancel makes stale callbacks inert; hidden and reduced-motion cancel; grouped cancel is via cancel()', () => {
    const f = fakeRaf(); const seen: number[] = [];
    const a = new StagePacketAnimator({ ...f.deps, onProgress: t => seen.push(t) });
    a.start(); expect(a.active).toBe(true); f.fire(50); expect(seen).toContain(0.5);
    const stale = f; a.cancel(); expect(a.active).toBe(false); expect(seen[seen.length - 1]).toBe(-1); stale.fire(90); expect(seen.filter(x => x === 0.9)).toHaveLength(0);
    // Start then hidden cancels on next tick.
    let hidden = false; const f2 = fakeRaf(); const seen2: number[] = [];
    const b = new StagePacketAnimator({ ...f2.deps, isHidden: () => hidden, onProgress: t => seen2.push(t) });
    b.start(); hidden = true; b.handleHidden(); expect(b.active).toBe(false);
    b.handleReducedMotion(true); expect(b.active).toBe(false);
    // Reduced-motion start produces no motion.
    const c = new StagePacketAnimator({ ...fakeRaf().deps, prefersReducedMotion: () => true, onProgress: t => seen.push(t) });
    c.start(); expect(c.active).toBe(false); c.dispose(); expect(c.active).toBe(false);
  });
});

describe('repair: DOM hierarchy and disclosures', () => {
  it('stage precedes controls and timeline/details are closed disclosures', () => {
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    expect(html.indexOf('id="repro-stage"')).toBeLessThan(html.indexOf('id="btn-repro-play"'));
    expect(html.indexOf('id="repro-stage"')).toBeLessThan(html.indexOf('id="repro-timeline"'));
    const timelineDetails = html.match(/<details\b[^>]*id="repro-timeline-details"[^>]*>/)?.[0]; expect(timelineDetails).toBeDefined(); expect(timelineDetails).not.toMatch(/\bopen\b/);
    const stepDetails = html.match(/<details\b[^>]*id="repro-step-details"[^>]*>/)?.[0]; expect(stepDetails).not.toMatch(/\bopen\b/);
    const evidenceWrap = html.match(/<details\b[^>]*id="repro-evidence-wrap"[^>]*>/)?.[0]; expect(evidenceWrap).not.toMatch(/\bopen\b/);
    // Legacy credit cards are inside the closed Step details, after its summary.
    expect(html.indexOf('id="repro-step-details"')).toBeLessThan(html.indexOf('id="repro-credit-wrap"'));
    expect(html).toContain('id="repro-source-indicator"');
    const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
    expect(css).toContain('.repro-body{display:block}');
    expect(css).not.toContain('.repro-body{display:grid');
    expect(css).toMatch(/\.live-activity\.is-completed/); expect(css).toMatch(/\.live-activity\.is-failed/);
    expect(css).not.toMatch(/\.live-activity\.is-terminal \.live-activity-dot\{background:var\(--accent-green\)\}/);
  });
});

describe('production trust boundaries', () => {
  it('production sources never import demo fixtures or hardcode approved case ids', () => {
    for (const file of ['replay-stage.ts', 'reproduction-player.ts', 'reproduction-view.ts', 'app.ts']) {
      const src = readFileSync(new URL(`../src/web/${file}`, import.meta.url), 'utf8');
      expect(src, file).not.toMatch(/docs\/design\/replay-lab|testing\/fault-catalog|trading-candidate|inventory-candidate|synthetic-(unknown|missing|ambiguous|empty|duplicate|two-entities)/);
      expect(src, file).not.toMatch(/\.innerHTML\s*=/);
    }
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    for (const id of ['repro-stage', 'repro-stage-event', 'repro-stage-system', 'repro-stage-change', 'repro-stage-lens', 'btn-repro-jump', 'repro-scrubber', 'repro-packet', 'live-activity']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('aria-label="Scrub recorded steps"');
  });
});

describe('repair: selected-finding jump target', () => {
  function entry(step: number, orderId: string, state: Record<string, unknown> = { v: step }): TraceEntry {
    return { step, time: step, action: 'deliver', payload: { type: 'execution', orderId, executionId: `e-${step}-${orderId}` }, outcome: 'accepted', state } as unknown as TraceEntry;
  }
  function violation(id: string, step: number, orderId: string): Violation {
    return { id, invariant: 'some_invariant', step, orderId, message: `failure at ${step}`, evidence: {} } as Violation;
  }
  const trace: TraceEntry[] = [entry(0, 'o1'), entry(1, 'o2'), entry(2, 'o1')];
  const first = violation('first', 0, 'o1');
  const later = violation('later', 1, 'o2');
  // Selected copy has a different id/object: matching must be semantic.
  const selectedLater = violation('a-different-id', 1, 'o2');

  it('no selection keeps the first finding; selected later finding wins and all frames stay marked', () => {
    expect(buildStageProjection(trace, [first, later], 'unknown').findingTracePosition).toBe(0);
    const p = buildStageProjection(trace, [first, later], 'unknown', selectedLater);
    expect(p.findingTracePosition).toBe(1);
    expect(p.groupFindingTracePosition).toBeNull();
    expect(p.frames.filter(f => f.isViolation).map(f => f.tracePosition)).toEqual([0, 1]);
  });

  it('resolves the selected finding against the displayed fresh trace, not the original position', () => {
    const freshTrace: TraceEntry[] = [
      { step: 99, time: 0, action: 'send', payload: { type: 'execution', orderId: 'o9' }, outcome: 'scheduled', state: {} } as unknown as TraceEntry,
      entry(0, 'o1'), entry(1, 'o2'),
    ];
    const freshViolations = [violation('fresh-first', 0, 'o1'), violation('fresh-later', 1, 'o2')];
    const p = buildStageProjection(freshTrace, freshViolations, 'unknown', selectedLater);
    expect(p.findingTracePosition).toBe(2);
  });

  it('disables the jump when the selected finding has no evidence in the displayed trace', () => {
    const freshTrace: TraceEntry[] = [entry(0, 'o1'), entry(2, 'o1')];
    const p = buildStageProjection(freshTrace, [first], 'unknown', selectedLater);
    expect(p.findingTracePosition).toBeNull();
    expect(p.groupFindingTracePosition).toBeNull();
    expect(p.frames.some(f => f.isViolation)).toBe(true);
  });

  it('does not mistake the same action or a different failure for the selected finding in a fresh recording', () => {
    const alternatives: Violation[][] = [
      [],
      [first],
      [{ ...later, id: selectedLater.id, invariant: 'another_invariant' }],
      [{ ...later, message: 'a different failure at the same action' }],
      [{ ...later, evidence: { observed: 99 } }],
    ];
    for (const currentViolations of alternatives) {
      const p = buildStageProjection(trace, currentViolations, 'unknown', selectedLater);
      expect(p.findingTracePosition).toBeNull();
      expect(p.groupFindingTracePosition).toBeNull();
    }
    // Group fallback also needs a matching recorded check, not just an action.
    const shared = [entry(1, 'o2'), entry(1, 'o2')];
    expect(buildStageProjection(shared, [], 'unknown', selectedLater).groupFindingTracePosition).toBeNull();
  });

  it('matches recorded evidence regardless of JSON object key order or regenerated IDs', () => {
    const selected = { ...later, evidence: { amount: 10, nested: { x: 1, y: 2 } } };
    const recorded = { ...later, id: 'fresh-id', evidence: { nested: { y: 2, x: 1 }, amount: 10 } };
    expect(buildStageProjection(trace, [recorded], 'unknown', selected).findingTracePosition).toBe(1);
  });

  it('ambiguous shared-action selection resolves as a group at the last same-step entry', () => {
    const shared: TraceEntry[] = [entry(5, 'o1'), entry(5, 'o1'), entry(6, 'o1')];
    const selected = violation('sel', 5, 'o1');
    const p = buildStageProjection(shared, [selected], 'unknown', selected);
    expect(p.findingTracePosition).toBeNull();
    expect(p.groupFindingTracePosition).toBe(1);
    expect(visiblePositionForTracePosition([{ tracePosition: 0 }, { tracePosition: 1 }, { tracePosition: 2 }], p.groupFindingTracePosition)).toBe(1);
  });

  it('selected target resolves in full and grouped visible sequences', () => {
    const longTrace: TraceEntry[] = [
      { step: 10, time: 0, action: 'send', payload: {}, outcome: 'scheduled', state: {} } as unknown as TraceEntry,
      { step: 11, time: 1, action: 'send', payload: {}, outcome: 'scheduled', state: {} } as unknown as TraceEntry,
      { step: 12, time: 2, action: 'send', payload: {}, outcome: 'scheduled', state: {} } as unknown as TraceEntry,
      entry(1, 'o2'),
    ];
    const p = buildStageProjection(longTrace, [later], 'unknown', selectedLater);
    expect(p.findingTracePosition).toBe(3);
    const { steps } = buildTraceSteps(longTrace, [later]);
    expect(visiblePositionForTracePosition(steps, p.findingTracePosition)).toBe(3);
    const grouped = groupUnimportantSteps(steps)!;
    expect(grouped.some(s => s.isGroup)).toBe(true);
    const groupedPos = visiblePositionForTracePosition(grouped, p.findingTracePosition);
    expect(groupedPos).not.toBeNull();
    expect(grouped[groupedPos!]!.tracePosition).toBe(3);
    // A target inside a grouped run resolves to the group step.
    expect(visiblePositionForTracePosition(grouped, 1)).toBe(0);
  });
});

describe('repair: unknown identity baseline', () => {
  function dup(step: number, state: unknown): TraceEntry {
    return { step, time: step, action: 'deliver', payload: { type: 'execution', executionId: 'e1', orderId: 'o1' }, outcome: 'duplicate', state } as unknown as TraceEntry;
  }
  it('first and after-gap identity snapshots have unknown stateChanged; known pairs can be unchanged or changed', () => {
    const trace: TraceEntry[] = [
      dup(0, { count: 1 }),
      dup(1, { count: 1 }),
      dup(2, { count: 2 }),
      dup(3, undefined),
      dup(4, { count: 2 }),
      dup(5, { count: 2 }),
    ];
    const p = buildStageProjection(trace, [], 'trading');
    expect(p.frames.map(f => f.visual.kind)).toContain('identity');
    expect(p.frames[0]!.visual.stateChanged).toBeNull();
    expect(p.frames[1]!.visual.stateChanged).toBe(false);
    expect(p.frames[2]!.visual.stateChanged).toBe(true);
    expect(p.frames[3]!.visual.kind).toBe('not-recorded');
    expect(p.frames[4]!.visual.kind).toBe('identity');
    expect(p.frames[4]!.visual.stateChanged).toBeNull();
    expect(p.frames[4]!.diffs.every(d => d.kind === 'first-recorded')).toBe(true);
    expect(p.frames[5]!.visual.stateChanged).toBe(false);
  });
});

describe('simplify: running prior-delivery lookup preserves identity boundaries', () => {
  function entry(payload: Record<string, unknown>, opts: { action?: string; outcome?: string; state?: unknown } = {}): TraceEntry {
    return { step: 0, time: 0, action: opts.action ?? 'deliver', payload, outcome: opts.outcome ?? 'duplicate', state: opts.state === undefined ? {} : opts.state } as unknown as TraceEntry;
  }
  const base = { type: 'execution', executionId: 'e1', orderId: 'o1' };
  it('counts only exact prior deliveries, with strict type/order/reservation matching and last-delivery conflicts', () => {
    const trace: TraceEntry[] = [
      entry({ ...base, quantity: 10, price: 5 }, { outcome: 'accepted' }),
      entry({ ...base, quantity: 11, price: 5 }),
      entry({ ...base, type: 'new_order', quantity: 99 }),
      entry({ ...base, reservationId: null, quantity: 12 }),
      entry({ ...base, quantity: 13, price: 5 }),
      entry({ ...base, quantity: 14, price: 5 }, { action: 'send' }),
      entry({ ...base, quantity: 15, price: 5 }, { outcome: 'accepted', state: null }),
      entry({ ...base, quantity: 16, price: 5 }),
      entry({ type: 'execution', orderId: 'o1', quantity: 1 }),
      entry({ ...base, orderId: 1, quantity: 20 }),
      entry({ ...base, orderId: '1', quantity: 21 }),
      entry({ ...base, orderId: 1, quantity: 22 }),
    ];
    const p = buildStageProjection(trace, [], 'trading');
    const id = trace.map((_, i) => p.frames[i]!.visual);
    // Frame 0 used a non-identity (accepted/diff) lens but still counts as a prior delivery.
    expect(id[1]).toMatchObject({ kind: 'identity', priorOccurrences: 1, occurrences: 2 });
    expect(id[1]!.conflicts).toEqual([{ field: 'quantity', eventValue: 11, recordedLabel: 'Previous delivery', recordedValue: 10 }]);
    expect(id[2]).toMatchObject({ priorOccurrences: 0, occurrences: 1, conflicts: [] });
    expect(id[3]).toMatchObject({ priorOccurrences: 0, occurrences: 1 });
    // Last matching delivery is frame 1 (quantity 11), not frame 0.
    expect(id[4]).toMatchObject({ priorOccurrences: 2, occurrences: 3 });
    expect(id[4]!.conflicts).toEqual([{ field: 'quantity', eventValue: 13, recordedLabel: 'Previous delivery', recordedValue: 11 }]);
    // A non-delivered identity-lens frame still gets prior + 1, but does not itself count later.
    expect(id[5]).toMatchObject({ priorOccurrences: 3, occurrences: 4 });
    expect(p.frames[6]!.visual.kind).toBe('not-recorded');
    // Frame 6 was missing-state and non-identity, yet delivered: frame 7 counts it and conflicts against it.
    expect(id[7]).toMatchObject({ priorOccurrences: 4, occurrences: 5 });
    expect(id[7]!.conflicts).toEqual([{ field: 'quantity', eventValue: 16, recordedLabel: 'Previous delivery', recordedValue: 15 }]);
    // Missing identity keeps prior 0 and occurrences null; numeric and string order ids stay distinct.
    expect(id[8]).toMatchObject({ priorOccurrences: 0, occurrences: null, eventIdentity: null });
    expect(id[9]).toMatchObject({ priorOccurrences: 0, occurrences: 1 });
    expect(id[10]).toMatchObject({ priorOccurrences: 0, occurrences: 1 });
    expect(id[11]).toMatchObject({ priorOccurrences: 1, occurrences: 2 });
    expect(id[11]!.conflicts).toEqual([{ field: 'quantity', eventValue: 22, recordedLabel: 'Previous delivery', recordedValue: 20 }]);
    // Source isolation: a fresh call starts from zero.
    expect(buildStageProjection(trace, [], 'trading').frames[1]!.visual.priorOccurrences).toBe(1);
  });

  it('preserves conflict order, the four-conflict cap and the locked order-price check', () => {
    const prior = entry({ type: 'execution', executionId: 'e2', orderId: 'o1', alpha: 1, beta: 1, gamma: 1, delta: 1, epsilon: 1, price: 5 }, { outcome: 'accepted', state: { target: { orders: { o1: { price: 99 } } } } });
    const current = entry({ type: 'execution', executionId: 'e2', orderId: 'o1', alpha: 2, beta: 2, gamma: 2, delta: 2, epsilon: 2, price: 7 }, { state: { target: { orders: { o1: { price: 99 } } } } });
    const p = buildStageProjection([prior, current], [], 'trading');
    expect(p.frames[1]!.visual.conflicts.map(c => c.field)).toEqual(['alpha', 'beta', 'gamma', 'delta']);
    // Prior-field conflicts precede the locked-price conflict.
    const prior2 = entry({ type: 'execution', executionId: 'e3', orderId: 'o1', quantity: 1, price: 5 }, { outcome: 'accepted', state: { target: { orders: { o1: { price: 99 } } } } });
    const current2 = entry({ type: 'execution', executionId: 'e3', orderId: 'o1', quantity: 2, price: 7 }, { state: { target: { orders: { o1: { price: 99 } } } } });
    const p2 = buildStageProjection([prior2, current2], [], 'trading');
    expect(p2.frames[1]!.visual.conflicts).toEqual([
      { field: 'quantity', eventValue: 2, recordedLabel: 'Previous delivery', recordedValue: 1 },
      { field: 'price', eventValue: 7, recordedLabel: 'Previous delivery', recordedValue: 5 },
      { field: 'price', eventValue: 7, recordedLabel: 'Order o1 locked price', recordedValue: 99 },
    ]);
  });

  it('object-identity order ids do not collapse, and a large repeated history resolves against its immediate predecessor', () => {
    const shared = { id: 'obj' };
    const trace: TraceEntry[] = [
      entry({ ...base, executionId: 'e9', orderId: shared, quantity: 1 }, { outcome: 'accepted' }),
      entry({ ...base, executionId: 'e9', orderId: { id: 'obj' }, quantity: 2 }),
      entry({ ...base, executionId: 'e9', orderId: shared, quantity: 3 }),
    ];
    const p = buildStageProjection(trace, [], 'trading');
    expect(p.frames[1]!.visual).toMatchObject({ priorOccurrences: 0, occurrences: 1 });
    expect(p.frames[2]!.visual).toMatchObject({ priorOccurrences: 1, occurrences: 2 });
    const many: TraceEntry[] = Array.from({ length: 200 }, (_, i) => entry({ ...base, executionId: 'bulk', quantity: i }, { outcome: i === 199 ? 'duplicate' : 'accepted', state: { n: i } }));
    const bulk = buildStageProjection(many, [], 'trading');
    expect(bulk.frames[199]!.visual).toMatchObject({ priorOccurrences: 199, occurrences: 200 });
    expect(bulk.frames[199]!.visual.conflicts).toEqual([{ field: 'quantity', eventValue: 199, recordedLabel: 'Previous delivery', recordedValue: 198 }]);
  });
});

describe('repair: empty-object generic state transitions', () => {
  it('preserves empty objects as meaningful added/removed/changed values without inventing unchanged diffs', () => {
    expect(diffRecordedStates({}, { session: {} })).toEqual([{ path: 'session', before: undefined, after: {}, kind: 'added' }]);
    expect(diffRecordedStates({ session: {} }, {})).toEqual([{ path: 'session', before: {}, after: undefined, kind: 'removed' }]);
    expect(diffRecordedStates({ session: {} }, { session: {} })).toEqual([]);
    expect(diffRecordedStates({}, {})).toEqual([]);
    expect(diffRecordedStates({ a: {}, b: 0, c: false, d: null }, { a: {}, b: 0, c: false, d: null })).toEqual([]);
    expect(diffRecordedStates({ session: {} }, { session: 1 })).toEqual([{ path: 'session', before: {}, after: 1, kind: 'changed' }]);
    expect(diffRecordedStates({ session: 0 }, { session: {} })).toEqual([{ path: 'session', before: 0, after: {}, kind: 'changed' }]);
    expect(diffRecordedStates({ session: false }, { session: {} })).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'session', kind: 'changed' })]));
    expect(diffRecordedStates({ session: null }, { session: {} })).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'session', kind: 'changed' })]));
    expect(diffRecordedStates({ session: {} }, { session: [] })).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'session', kind: 'changed' })]));
    expect(diffRecordedStates({ session: {} }, { session: { x: 1 } }).length).toBeGreaterThan(0);
    expect(diffRecordedStates({ session: { x: 1 } }, { session: {} }).length).toBeGreaterThan(0);
    expect(diffRecordedStates({}, { a: { b: {} } })).toEqual([{ path: 'a.b', before: undefined, after: {}, kind: 'added' }]);
    expect(diffRecordedStates(undefined, { session: {} })).toEqual([{ path: 'session', before: undefined, after: {}, kind: 'first-recorded' }]);
  });

  it('literal dotted keys do not collide with nested paths', () => {
    expect(diffRecordedStates({ 'a.b': 1, a: { b: 2 } }, { 'a.b': 1, a: { b: 3 } })).toEqual([{ path: 'a.b', before: 2, after: 3, kind: 'changed' }]);
    const swapped = diffRecordedStates({ 'a.b': 1 }, { a: { b: 1 } });
    expect(swapped).toHaveLength(2);
    expect(swapped.map(d => d.kind).sort()).toEqual(['added', 'removed']);
  });

  it('empty-object transitions surface through the production projection', () => {
    const trace: TraceEntry[] = [
      { step: 0, time: 0, action: 'deliver', payload: {}, outcome: 'accepted', state: {} } as unknown as TraceEntry,
      { step: 1, time: 1, action: 'deliver', payload: {}, outcome: 'accepted', state: { session: {} } } as unknown as TraceEntry,
      { step: 2, time: 2, action: 'deliver', payload: {}, outcome: 'accepted', state: {} } as unknown as TraceEntry,
    ];
    const p = buildStageProjection(trace, [], 'unknown');
    expect(p.frames[1]!.diffs).toEqual([{ path: 'session', before: undefined, after: {}, kind: 'added' }]);
    expect(p.frames[2]!.diffs).toEqual([{ path: 'session', before: {}, after: undefined, kind: 'removed' }]);
  });
});

describe('live activity from real recorded state', () => {
  const base = { serverStatus: 'running', experiments: 2, findings: 1, isActive: true };
  it('pending proposal is preparing; running, stopping and terminal states stay truthful', () => {
    expect(liveActivity({ ...base, recordStatus: 'running', pendingProposals: 1 }).label).toBe('Preparing experiment');
    expect(liveActivity({ ...base, recordStatus: 'running', pendingProposals: 0 }).label).toBe('Running investigation');
    expect(liveActivity({ ...base, recordStatus: 'running', pendingProposals: 0, serverStatus: 'stopping' }).label).toBe('Stopping investigation');
    expect(liveActivity({ ...base, recordStatus: 'completed', pendingProposals: 0, isActive: false }).terminal).toBe(true);
    expect(liveActivity({ ...base, recordStatus: 'failed', pendingProposals: 0 }).label).toBe('Investigation failed');
    expect(liveActivity({ ...base, recordStatus: null, pendingProposals: 0, serverStatus: 'starting', isActive: false }).label).toBe('Waiting to start');
    expect(JSON.stringify(liveActivity({ ...base, recordStatus: 'running', pendingProposals: 0 }))).not.toMatch(/%|percent/);
  });
  it('historical vs live matrix: unrelated server state never makes a historical run live', () => {
    const hist = { ...base, isActive: false };
    for (const serverStatus of ['starting', 'running', 'stopping']) {
      expect(liveActivity({ ...hist, recordStatus: 'completed', pendingProposals: 0, serverStatus }).tone).toBe('completed');
      expect(liveActivity({ ...hist, recordStatus: 'failed', pendingProposals: 0, serverStatus })).toMatchObject({ tone: 'failed', live: false });
      expect(liveActivity({ ...hist, recordStatus: 'cancelled', pendingProposals: 0, serverStatus })).toMatchObject({ tone: 'cancelled', live: false });
      const running = liveActivity({ ...hist, recordStatus: 'running', pendingProposals: 1, serverStatus });
      expect(running).toMatchObject({ live: false, tone: 'neutral' }); expect(running.label).toMatch(/not live/i);
    }
    // Active: pending, no-pending, stopping, and terminal during final save.
    expect(liveActivity({ ...base, recordStatus: 'running', pendingProposals: 2, serverStatus: 'running' }).label).toBe('Preparing experiment');
    expect(liveActivity({ ...base, recordStatus: 'running', pendingProposals: 0, serverStatus: 'running' })).toMatchObject({ label: 'Running investigation', live: true });
    expect(liveActivity({ ...base, recordStatus: 'completed', pendingProposals: 0, serverStatus: 'running' })).toMatchObject({ tone: 'completed', live: false });
    expect(liveActivity({ ...base, recordStatus: null, pendingProposals: 0, serverStatus: 'starting' }).label).toBe('Waiting to start');
  });
});
