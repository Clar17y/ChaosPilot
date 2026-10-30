import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFrames, clampIndex, clearedVisualState, createPlaybackController, creditView, dedupeViolations, diffStates, flatten, formatValue, humanEventName, jumpToFinding, selectLens, stepBy, stockView } from './replay-core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'));
const byId = (id) => data.cases.find(c => c.id === id);
const framesOf = (id) => buildFrames(byId(id));

test('32 cases preserved: nine trading known recipes + cleans, inventory, synthetics', () => {
  assert.equal(data.cases.length, 32);
  for (const suffix of ['a','b','c','d','e','f','g','h','i']) {
    assert.ok(byId(`trading-candidate-${suffix}`).violations.length >= 1, suffix);
    assert.equal(byId(`trading-candidate-${suffix}-clean`).violations.length, 0, suffix);
    const { frames, findingFrames } = framesOf(`trading-candidate-${suffix}`);
    assert.ok(findingFrames.length >= 1, `attributed finding ${suffix}`);
    assert.ok(frames[findingFrames[0]].isViolation);
  }
});

test('credit capacity visual: combined used+reserved crosses the 100 limit marker', () => {
  const c = byId('trading-candidate-c');
  const { frames, findingFrames, scale } = framesOf('trading-candidate-c');
  const f = frames[findingFrames[0]], v = f.visual;
  const snap = c.snapshot.target; // independently read final snapshot
  assert.equal(v.used, snap.usedCredit); assert.equal(v.reserved, snap.reservedCredit);
  assert.equal(v.total, 200); assert.equal(v.limit, 100); assert.equal(v.exceeds, true);
  assert.equal(scale, 200); assert.equal(v.scaleMax, 200);
  assert.equal(v.usedPct, 50); assert.equal(v.reservedPct, 50); assert.equal(v.totalPct, 100);
  assert.equal(v.limitPct, 50); // total bar reaches 100%, limit marker at the midpoint
  assert.equal(f.lens, 'capacity');
});

test('negative reserved credit stays signed, never a positive full bar', () => {
  const { frames } = framesOf('trading-candidate-b');
  const f = frames.find(x => x.credit && x.credit.reserved < 0);
  assert.ok(f);
  assert.equal(f.credit.reserved, -40);
  assert.deepEqual(f.visual.negative, ['reserved']);
  assert.equal(f.visual.total, 0);
});

test('version lens: big before/after matches raw recorded states', () => {
  for (const [id, path] of [['trading-candidate-d', 'quote.version'], ['trading-candidate-e', 'credit.version']]) {
    const c = byId(id); const { frames, findingFrames } = framesOf(id);
    const f = frames[findingFrames[0]]; assert.equal(f.lens, 'version', id);
    const ch = f.visual.changes.find(x => x.path === path); assert.ok(ch, id);
    const prev = flatten(c.trace[f.index - 1].state), curr = flatten(c.trace[f.index].state);
    assert.equal(ch.before, prev.get(path)); assert.equal(ch.after, curr.get(path));
    assert.equal(ch.regressed, true);
  }
});

test('lifecycle lens: status plus remaining/filled quantities from raw state', () => {
  const { frames, findingFrames } = framesOf('trading-candidate-i');
  const f = frames[findingFrames[0]]; assert.equal(f.lens, 'lifecycle');
  assert.equal(f.visual.statusChanges[0].after, 'FILLED');
  const rem = f.visual.quantities.find(q => q.path.endsWith('remainingQuantity'));
  assert.equal(rem.after, 6); assert.equal(rem.before, 10);
});

test('identity lens: repeated execution identity, conflicting price, outcomes', () => {
  const a = framesOf('trading-candidate-a').frames;
  const fa = a[framesOf('trading-candidate-a').findingFrames[0]];
  assert.equal(fa.lens, 'identity'); assert.equal(fa.visual.eventIdentity, 'exec-idemp-1');
  assert.ok(fa.visual.occurrences >= 2, 'repeated identity is visible');
  const g = framesOf('trading-candidate-g'); const fg = g.frames[g.findingFrames[0]];
  assert.equal(fg.lens, 'identity');
  assert.ok(fg.visual.conflicts.some(x => x.field === 'price' && x.eventValue === 120 && x.recordedValue === 100),
    JSON.stringify(fg.visual.conflicts));
  const h = framesOf('trading-candidate-h'); const fh = h.frames[h.findingFrames[0]];
  assert.equal(fh.visual.stateChanged, false); // duplicate with no business-state change
  assert.equal(fh.visual.occurrences, 2, 'scheduling is not another delivery');
  assert.deepEqual(fh.visual.conflicts, [{field:'quantity',eventValue:6,recordedPath:'Previous delivery',recordedValue:4}]);
  assert.equal(fa.visual.occurrences, 2);
  assert.deepEqual(fa.visual.conflicts, [], 'unrelated quote IDs are never compared with event IDs');
  // credit-exposure inconsistency is explained by credit values, not a limit claim
  const ff = framesOf('trading-candidate-f'); const ffr = ff.frames[ff.findingFrames[0]];
  assert.equal(ffr.lens, 'capacity'); assert.equal(ffr.visual.exceeds, false);
  assert.equal(ffr.visual.total, ffr.credit.used + ffr.credit.reserved);
  assert.deepEqual(ffr.visual.comparison,[{path:'Used credit',before:70,after:30}]);
  const fb=framesOf('trading-candidate-b');
  assert.deepEqual(fb.frames[fb.findingFrames[0]].visual.comparison,[{path:'Reserved credit',before:40,after:0}]);
});

test('identity comparison respects entity scope and explicitly locked order price', () => {
  const trace = [
    {step:0,action:'deliver',outcome:'accepted',payload:{type:'execution',executionId:'same',orderId:'a',quantity:9,price:90},state:{orders:{a:{price:90},b:{price:100}}}},
    {step:1,action:'deliver',outcome:'duplicate',payload:{type:'execution',executionId:'same',orderId:'b',quantity:2,price:100},state:{orders:{a:{price:90},b:{price:100}}}},
  ];
  const f = buildFrames({trace,violations:[]}).frames[1];
  assert.equal(f.visual.occurrences, 1);
  assert.deepEqual(f.visual.conflicts, []);
});

test('inventory comparison requires a recorded expected/actual pair matching the current state', () => {
  const b=framesOf('inventory-candidate-b');
  const f=b.frames.at(-1);
  assert.ok(f.visual.comparison.some(d=>d.path==='reservations.r1.remaining' && d.before===0 && d.after===5));
  const d=framesOf('inventory-candidate-d');
  assert.deepEqual(d.frames[d.groupFrames[0]].visual.comparison, [], 'no future action snapshot projected onto the first delivery');
});

test('stock lens: over-reservation and inventory group frames match raw state', () => {
  const a = framesOf('inventory-candidate-a'); const fa = a.frames[a.findingFrames[0]];
  assert.equal(fa.lens, 'stock');
  assert.deepEqual([fa.visual.rows[0].onHand, fa.visual.rows[0].reservedRemaining, fa.visual.rows[0].available], [10, 14, -4]);
  assert.equal(fa.visual.rows[0].overReserved, true);
  assert.ok(fa.visual.comparison.every(d=>!d.path.startsWith('accepted.')));
  for (const id of ['inventory-candidate-a','inventory-candidate-b','inventory-candidate-c','inventory-candidate-d']) {
    assert.ok(byId(id).violations.length >= 1, id);
    assert.equal(byId(`${id}-clean`).violations.length, 0, id);
  }
  const d = byId('inventory-candidate-d');
  assert.deepEqual([...new Set(d.violations.map(v => v.category))].sort(), ['cancellation_release','duplicate_shipment']);
});

test('attribution timing: group finding only at its recorded action, never before/after', () => {
  const { frames } = framesOf('synthetic-ambiguous'); // violation at step 2; step 1 is before
  assert.equal(frames[0].isGroupFinding, false);
  assert.equal(frames[1].isGroupFinding, true);
  assert.equal(frames[2].isGroupFinding, true);
  assert.ok(frames.every(f => !f.isViolation));
  const d = framesOf('inventory-candidate-d');
  const firstGroup = d.groupFrames[0];
  assert.ok(d.frames.slice(0, firstGroup).every(f => !f.isGroupFinding), 'no finding banner before the drain action');
  assert.ok(d.frames[firstGroup].isGroupFinding);
  // dedupe: combined case repeats one message/category many times
  assert.ok(dedupeViolations(d.frames[firstGroup].groupViolations).length <= d.frames[firstGroup].groupViolations.length);
  const dup = dedupeViolations([{ invariant: 'x', message: 'm' }, { invariant: 'x', message: 'm' }, { invariant: 'y', message: 'n' }]);
  assert.equal(dup.length, 2);
  assert.ok(byId('inventory-candidate-d').violations.length >= 5, 'original records preserved in evidence');
});

test('state lifecycle: known -> missing -> known, first snapshot, (root) artifact gone', () => {
  const { frames } = framesOf('synthetic-missing-state');
  assert.equal(frames[0].stateStatus, 'first-recorded');
  assert.equal(frames[1].stateKnown, false);
  assert.equal(frames[1].stateStatus, 'not-recorded');
  assert.deepEqual(frames[1].diffs, []);
  assert.equal(frames[1].visual.kind, 'not-recorded');
  assert.equal(frames[2].stateStatus, 'first-recorded'); // first after the gap, not a diff vs invented {}
  assert.ok(frames[2].diffs.every(d => d.kind === 'first-recorded'));
  assert.ok(!frames.flatMap(f => f.diffs).some(d => d.path === '(root)'));
  // a known baseline diff is a real change, distinct from first-recorded
  assert.deepEqual(diffStates({ a: 1 }, { a: 2 }).map(d => d.kind), ['changed']);
  assert.deepEqual(diffStates(undefined, { a: 1 }).map(d => d.kind), ['first-recorded']);
  assert.deepEqual(diffStates({ a: 1 }, null), []);
  assert.deepEqual(diffStates({ a: 1 }, undefined), []);
});

test('legitimate null, false and 0 remain distinct from unavailable', () => {
  const { frames } = framesOf('synthetic-missing-state');
  const get = (p) => frames[0].diffs.find(d => d.path.endsWith(p));
  assert.equal(get('count').after, 0); assert.equal(get('enabled').after, false); assert.equal(get('note').after, null);
  assert.equal(formatValue(0), '0'); assert.equal(formatValue(false), 'false');
  assert.equal(formatValue(null), 'null'); assert.equal(formatValue(undefined), 'not recorded');
  const diffs = diffStates({ a: 'x', b: true, n: { z: 1 }, gone: 5 }, { a: 'y', b: false, n: { z: 2 } });
  assert.deepEqual(diffs.map(d => d.path), ['a','b','gone','n.z']);
  assert.equal(diffs.find(d => d.path === 'gone').after, undefined);
});

test('empty reservations establish zero only when reservations are present', () => {
  const withEmpty = stockView({ stock: { item: { received: 10, onHand: 10 } }, reservations: {} });
  assert.equal(withEmpty[0].reservedRemaining, 0); assert.equal(withEmpty[0].available, 10);
  const absent = stockView({ stock: { item: { received: 10, onHand: 10 } } });
  assert.equal(absent[0].reservedRemaining, null); assert.equal(absent[0].available, null);
  assert.equal(creditView({}), null);
});

test('generic fallback and neutral outcomes', () => {
  const u = framesOf('synthetic-unknown-fields');
  assert.equal(u.frames[1].lens, 'diff');
  assert.equal(u.frames[1].visual.changes[0].after, 2);
  assert.equal(framesOf('synthetic-empty').frames.length, 0);
  const t = framesOf('synthetic-two-entities');
  assert.ok(t.frames[0].visual.negativeChanges.some(d => d.after === -5));
  const dup = framesOf('synthetic-duplicate-neutral');
  assert.equal(dup.frames[1].lens, 'identity'); assert.equal(dup.frames[1].isViolation, false);
  assert.equal(dup.frames[1].visual.stateChanged, false);
  // clean rejected outcome: neutral, no violation styling data
  const rej = buildFrames({ trace: [{ step: 1, action: 'deliver', messageId: 'r1', payload: { type: 'ship', id: 's1' }, outcome: 'rejected', state: { target: { shipped: 0 } } }], violations: [] });
  assert.equal(rej.frames[0].isViolation, false); assert.equal(rej.frames[0].kind, 'rejected');
  assert.equal(humanEventName(rej.frames[0]), 'Ship');
  assert.ok(!humanEventName({ payload: { type: 'new_order' }, action: 'send' }).includes(':'));
});

test('lens dispatch: per-path tests and evidence family, no incidental credit chart', () => {
  const base = { entry: { outcome: 'delivered:processed' }, diffs: [], violationsHere: [], groupViolations: [], credit: null, stock: null };
  assert.equal(selectLens({ ...base, violationsHere: [{ invariant: 'version_monotonicity' }] }), 'version');
  assert.equal(selectLens({ ...base, violationsHere: [{ invariant: 'lifecycle_consistency' }] }), 'lifecycle');
  assert.equal(selectLens({ ...base, entry: { outcome: 'duplicate' } }), 'identity');
  // credit snapshot exists but this frame neither violates nor changes credit -> generic
  assert.equal(selectLens({ ...base, credit: { limit: 1, used: 0, reserved: 0, total: 0 } }), 'diff');
  assert.equal(selectLens({ ...base, credit: { limit: 1, used: 0, reserved: 0, total: 0 }, diffs: [{ path: 'usedCredit', before: 0, after: 1, kind: 'changed' }] }), 'capacity');
  // per-path regex: a path merely containing "version" as substring is not a version field
  assert.equal(selectLens({ ...base, diffs: [{ path: 'aversion', before: 1, after: 2, kind: 'changed' }] }), 'diff');
  assert.equal(selectLens({ ...base, diffs: [{ path: 'credit.version', before: 2, after: 1, kind: 'changed' }] }), 'version');
  // an added status (first sight) is not a lifecycle transition
  assert.equal(selectLens({ ...base, diffs: [{ path: 'orders.o.status', before: undefined, after: 'OPEN', kind: 'added' }] }), 'diff');
});

test('visual models match raw recorded state across every case and lens', () => {
  for (const c of data.cases) {
    const { frames } = buildFrames(c);
    frames.forEach((f, i) => {
      const raw = c.trace[i].state ?? null;
      if (!f.stateKnown) { assert.equal(f.visual.kind, 'not-recorded', c.id); return; }
      assert.deepEqual(f.credit && Object.fromEntries(Object.entries(f.credit).filter(([k]) => k !== 'scaleMax')), creditView(raw) ?? null, `${c.id}@${i}`);
      assert.deepEqual(f.stock, stockView(raw), `${c.id}@${i}`);
      if (f.visual.kind === 'capacity') assert.equal(f.visual.total, f.credit.used + f.credit.reserved, `${c.id}@${i}`);
      if (f.visual.kind === 'version') for (const ch of f.visual.changes) {
        assert.equal(ch.before, flatten(c.trace[i - 1].state).get(ch.path), `${c.id}@${i}`);
        assert.equal(ch.after, flatten(raw).get(ch.path), `${c.id}@${i}`);
      }
      if (f.visual.kind === 'stock') for (const r of f.visual.rows) {
        assert.equal(r.available, r.onHand !== null && r.reservedRemaining !== null ? r.onHand - r.reservedRemaining : null);
      }
    });
  }
  // every supported lens is exercised at a current finding frame somewhere
  const kinds = new Set();
  for (const c of data.cases) { const b = buildFrames(c); for (const i of [...b.findingFrames, ...b.groupFrames]) kinds.add(b.frames[i].visual.kind); }
  for (const k of ['capacity','stock','version','lifecycle','identity','diff']) assert.ok(kinds.has(k), k);
});

function fakeClock() {
  let pending = null, cancelled = 0;
  return { schedule: (cb) => { pending = cb; return 1; }, cancel: () => { cancelled += 1; },
    fire: () => { const cb = pending; pending = null; if (cb) cb(1); }, get pending() { return pending; }, get cancelled() { return cancelled; } };
}

test('playback controller (real clock abstraction): play, end, seek/switch/hidden/reduced while playing', () => {
  const clock = fakeClock(); const seen = []; let playingStates = [];
  const ctl = createPlaybackController({ schedule: clock.schedule, cancel: clock.cancel, onIndex: (i) => seen.push(i), onPlaying: (p) => playingStates.push(p) });
  ctl.switchTo(3, 0);
  assert.equal(ctl.play(), true); assert.equal(ctl.playing, true);
  clock.fire(); assert.equal(ctl.index, 1);
  const stale = clock.pending; ctl.seek(0); // seek while playing cancels the in-flight callback
  assert.equal(ctl.playing, false); assert.ok(clock.cancelled >= 1);
  stale(1); assert.equal(ctl.index, 0, 'stale callback must not advance');
  ctl.play(); clock.fire(); clock.fire(); // run to the end: stops, no loop
  assert.equal(ctl.index, 2); assert.equal(ctl.playing, false);
  ctl.play(); assert.equal(ctl.index, 0, 'play at end restarts'); // restart emits 0 then queues
  ctl.handleHidden(); assert.equal(ctl.playing, false);
  ctl.play(); ctl.handleReducedMotion(true); assert.equal(ctl.playing, false);
  ctl.play(); ctl.switchTo(5, 0); assert.equal(ctl.playing, false); assert.equal(ctl.length, 5); assert.equal(ctl.index, 0);
  ctl.switchTo(0, 0); assert.equal(ctl.enabled, false); assert.equal(ctl.play(), false);
  assert.ok(playingStates.includes(true) && playingStates.at(-1) === false);
});

test('failure -> empty -> clean sequence leaves no stale finding or enabled empty controls', () => {
  const clock = fakeClock();
  const ctl = createPlaybackController({ schedule: clock.schedule, cancel: clock.cancel });
  const failing = framesOf('trading-candidate-c');
  ctl.switchTo(failing.frames.length, 0); ctl.seek(jumpToFinding(failing.frames));
  assert.equal(failing.frames[ctl.index].isViolation, true);
  ctl.switchTo(framesOf('synthetic-empty').frames.length, 0); // empty case
  assert.equal(ctl.enabled, false); assert.equal(ctl.playing, false); assert.equal(ctl.play(), false);
  const clean = framesOf('trading-candidate-c-clean');
  ctl.switchTo(clean.frames.length, 0);
  assert.ok(clean.frames.every(f => !f.isViolation && !f.isGroupFinding));
  assert.deepEqual(clean.summary, { violationsRecorded: 0, uniqueMessages: 0 });
});

test('cleared visual state model and index helpers', () => {
  const c = clearedVisualState();
  assert.equal(c.nodesBad, false); assert.equal(c.packetVisible, false); assert.equal(c.playing, false); assert.equal(c.marker, null);
  assert.equal(clampIndex(-5, 4), 0); assert.equal(clampIndex(99, 4), 3); assert.equal(clampIndex(2, 0), 0);
  assert.equal(stepBy(0, -1, 4), 0); assert.equal(stepBy(3, 1, 4), 3);
  assert.equal(jumpToFinding(framesOf('trading-candidate-c').frames), 9);
  assert.equal(jumpToFinding(framesOf('trading-candidate-c-clean').frames), null);
});

test('fragment contract: redesign, lifecycle, widget state, no network, <1MB', () => {
  const html = readFileSync(join(here, 'replay-lab.html'), 'utf8');
  const ui = readFileSync(join(here, 'replay-ui.js'), 'utf8');
  assert.ok(!html.startsWith('<!doctype')); assert.ok(!/<html/i.test(html));
  assert.ok(html.includes('id="chaospilot-replay-lab"'));
  assert.ok(!/fetch\(|XMLHttpRequest|WebSocket/.test(html));
  assert.ok(Buffer.byteLength(html) < 1_000_000, String(Buffer.byteLength(html)));
  for (const id of ['cprl-case','cprl-play','cprl-prev','cprl-next','cprl-range','cprl-jump','cprl-raw','cprl-marker','cprl-summary']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes('prefers-reduced-motion')); assert.ok(html.includes('visibilitychange'));
  assert.ok(html.includes('cprl-limit'), 'fixed limit marker on the combined bar');
  assert.ok(!html.includes('cprl-node-bad'), 'nodes are never all painted as failed');
  assert.ok(html.includes('State not recorded')); assert.ok(html.includes('Group-level finding'));
  assert.ok(html.includes('openai:set_globals')); assert.ok(html.includes('modelContent'));
  // persistence only from interaction handlers: render/load never call persist()
  assert.ok(!/function render\(\)[^}]*persist\(\)/.test(ui), 'render must not persist');
  assert.ok(!/function loadCase[\s\S]*?render\(\);\s*persist/.test(ui), 'load must not persist');
  const coverage = JSON.parse(readFileSync(join(here, 'coverage.json'), 'utf8'));
  assert.equal(coverage.cases.length, 32);
  for (const cc of coverage.cases) {
    assert.ok(cc.executedChecks.every(x => x.status === 'passed'), cc.id);
    assert.ok(cc.claims.every(x => x.startsWith('descriptive') || x.startsWith('focused')), cc.id);
  }
});
