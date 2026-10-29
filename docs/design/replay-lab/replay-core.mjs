// Generic replay projection. No case/variant ID branching: lens dispatch uses
// recorded evidence semantics (invariant/category names, per-path field
// changes, outcomes), never a scenario identifier.
export function isRecord(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }
export function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
export function formatValue(v) {
  // undefined = unavailable/not recorded. null, false and 0 are recorded values.
  if (v === undefined) return 'not recorded';
  if (v === null) return 'null';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
export function flatten(value, prefix = '', out = new Map()) {
  if (isRecord(value)) {
    // An empty record contributes no leaves: no synthetic "(root) {}" entry.
    for (const k of Object.keys(value).sort()) flatten(value[k], prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  if (prefix) out.set(prefix, value);
  return out;
}
export function stateKnown(state) { return state !== undefined && state !== null; }
export function diffStates(prev, curr) {
  if (!stateKnown(curr)) return []; // missing current state invents no removals
  const b = flatten(curr);
  if (!stateKnown(prev)) {
    // First recorded snapshot (start of trace, or first after a gap): its
    // leaves are recorded values, not changes against an invented baseline.
    return [...b.entries()].map(([path, after]) => ({ path, before: undefined, after, kind: 'first-recorded' }));
  }
  const a = flatten(prev);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  const diffs = [];
  for (const p of paths) {
    const before = a.has(p) ? a.get(p) : undefined;
    const after = b.has(p) ? b.get(p) : undefined;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      diffs.push({ path: p, before, after, kind: !a.has(p) ? 'added' : !b.has(p) ? 'removed' : 'changed' });
    }
  }
  return diffs;
}
export function creditView(state) {
  if (!isRecord(state)) return null;
  const t = isRecord(state.target) ? state.target : state;
  const limit = isRecord(t.credit) ? num(t.credit.limit) : num(t.creditLimit);
  const used = num(t.usedCredit), reserved = num(t.reservedCredit);
  if (limit === null && used === null && reserved === null) return null;
  const total = used !== null && reserved !== null ? used + reserved : null;
  return { limit, used, reserved, total, exceeds: total !== null && limit !== null ? total > limit : null };
}
export function stockView(state) {
  if (!isRecord(state)) return null;
  const t = isRecord(state.target) ? state.target : state;
  if (!isRecord(t.stock)) return null;
  const rows = [];
  // An explicitly present (even empty) reservations object in a state that
  // also carries stock establishes zero reserved; an absent one stays unknown.
  const hasReservations = Object.prototype.hasOwnProperty.call(t, 'reservations') && isRecord(t.reservations);
  const reservations = hasReservations ? t.reservations : {};
  for (const [sku, raw] of Object.entries(t.stock)) {
    if (!isRecord(raw)) continue;
    let reservedRemaining = hasReservations ? 0 : null;
    for (const r of Object.values(reservations)) {
      if (isRecord(r) && r.sku === sku && num(r.remaining) !== null) reservedRemaining += r.remaining;
    }
    rows.push({ sku, received: num(raw.received), onHand: num(raw.onHand), reservedRemaining,
      available: num(raw.onHand) !== null && reservedRemaining !== null ? raw.onHand - reservedRemaining : null });
  }
  return rows.length ? rows : null;
}
const DELIVERY = new Set(['accepted', 'duplicate', 'rejected']);
export function isProcessed(entry) {
  const o = entry?.outcome ?? '';
  if (entry?.action === 'deliver' && DELIVERY.has(o)) return true;
  return o.startsWith('delivered:') || o === 'drained:empty' || o.startsWith('advanced by');
}
export function classify(entry) {
  const o = entry?.outcome ?? '';
  if (o === 'rejected' || o.startsWith('rejected:') || o.startsWith('delivered:rejected')) return 'rejected';
  if (o === 'accepted' || o === 'duplicate') return 'processed';
  if (o.startsWith('delivered:') || o === 'drained:empty' || o.startsWith('advanced by')) return 'processed';
  if (o === 'executed' || o === 'scheduled' || o.endsWith('_scheduled') || o.startsWith('duplicated from')) return 'scheduled';
  return 'other';
}
export function humanEventName(entry) {
  const p = isRecord(entry?.payload) ? entry.payload : null;
  const raw = typeof p?.type === 'string' && p.type ? p.type : (entry?.action ?? 'recorded event');
  const words = String(raw).replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Recorded event';
}
export function violationMatches(violation, entry) {
  if (!violation || !entry || violation.step !== entry.step) return false;
  if (!isProcessed(entry)) return false;
  const p = isRecord(entry.payload) ? entry.payload : null;
  if (violation.orderId) return p !== null && p.orderId === violation.orderId;
  const sku = typeof violation.evidence?.sku === 'string' ? violation.evidence.sku : null;
  if (sku && p && typeof p.sku === 'string' && p.sku !== sku) return false;
  return true;
}
export function attributeViolations(trace, violations) {
  const perIndex = new Map(); const attributed = new Set();
  for (const v of violations ?? []) {
    const matches = [];
    (trace ?? []).forEach((e, i) => { if (violationMatches(v, e)) matches.push(i); });
    if (matches.length !== 1) continue;
    const i = matches[0];
    perIndex.set(i, [...(perIndex.get(i) ?? []), v]); attributed.add(v);
  }
  const unattributed = (violations ?? []).filter(v => !attributed.has(v));
  // Group-level findings belong to frames at their recorded step/action only.
  const groupByIndex = new Map();
  for (const v of unattributed) {
    (trace ?? []).forEach((e, i) => {
      if (e.step === v.step) groupByIndex.set(i, [...(groupByIndex.get(i) ?? []), v]);
    });
  }
  return { perIndex, unattributed, groupByIndex };
}
export function dedupeViolations(violations) {
  const seen = new Set(); const out = [];
  for (const v of violations ?? []) {
    const key = `${v.invariant ?? ''}|${v.category ?? ''}|${v.message ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push(v);
  }
  return out;
}
const pathHas = (diffs, re) => (diffs ?? []).some(d => re.test(d.path)); // per path, never a joined string
export function selectLens({ entry, diffs, violationsHere, groupViolations, credit, stock }) {
  const relevant = [...(violationsHere ?? []), ...(groupViolations ?? [])];
  const fam = relevant.map(v => `${v.invariant ?? ''} ${v.category ?? ''}`).join(' ');
  const outcome = entry?.outcome ?? '';
  const changedVersion = (diffs ?? []).some(d => /(^|\.)version(\.|$)/.test(d.path) && d.kind === 'changed');
  const changedStatus = (diffs ?? []).some(d => /(^|\.)status$/.test(d.path) && d.kind === 'changed');
  const creditChanged = pathHas(diffs, /(^|\.)(usedCredit|reservedCredit|credit)(\.|$)/);
  const stockChanged = pathHas(diffs, /(^|\.)(stock|reservations)(\.|$)/);
  if (/version/.test(fam) || changedVersion) return 'version';
  if (/lifecycle/.test(fam)) return 'lifecycle';
  // Stock/reservation findings are explained by the balance, not by identity.
  if (stock && /stock|inventory|reservation|shipment|cancellation/.test(fam)) return 'stock';
  if (/idempoten|input_integrity|execution_integrity|duplicate/.test(fam)) return 'identity';
  if (/credit|capacity|limit/.test(fam) && credit) return 'capacity';
  if (/balance|non_negative|negative/.test(fam)) return 'diff';
  if (changedStatus) return 'lifecycle';
  if (outcome === 'duplicate') return 'identity';
  // A specialised chart only when this frame's evidence touches it: an
  // incidental credit/stock snapshot elsewhere never hijacks the lens.
  if (credit && creditChanged) return 'capacity';
  if (stock && stockChanged) return 'stock';
  if (DELIVERY.has(outcome) && relevant.length) return 'identity';
  return 'diff';
}
export function caseScale(frames) {
  let scale = 0;
  for (const f of frames) {
    if (f.credit) scale = Math.max(scale, Math.abs(f.credit.total ?? 0), Math.abs(f.credit.limit ?? 0), Math.abs(f.credit.used ?? 0), Math.abs(f.credit.reserved ?? 0));
    if (f.stock) for (const s of f.stock) scale = Math.max(scale, Math.abs(s.received ?? 0), Math.abs(s.onHand ?? 0), Math.abs(s.reservedRemaining ?? 0));
  }
  return scale > 0 ? scale : null;
}
function identityKey(p) {
  if (!isRecord(p)) return null;
  const v = p.executionId ?? p.id ?? null;
  return v === null || v === undefined ? null : String(v);
}
function buildVisual(f, priorFrames) {
  const base = { lens: f.lens, stateStatus: f.stateStatus, diffs: f.diffs };
  if (!f.stateKnown) return { ...base, kind: 'not-recorded' };
  if (f.lens === 'capacity' && f.credit) {
    const c = f.credit, scale = c.scaleMax || Math.max(Math.abs(c.total ?? 0), Math.abs(c.limit ?? 0), 1);
    const pct = (v) => v === null ? null : (v / scale) * 100;
    const comparison = f.violationsHere.flatMap(v => {
      const e = v.evidence ?? {}, rows = [];
      if (num(e.expectedUsedCredit) !== null && num(e.targetUsedCredit) !== null)
        rows.push({path:'Used credit', before:e.expectedUsedCredit, after:e.targetUsedCredit});
      if (num(e.expectedReservation) !== null && num(e.targetReservedCredit) !== null)
        rows.push({path:'Reserved credit', before:e.expectedReservation, after:e.targetReservedCredit});
      return rows;
    });
    return { ...base, kind: 'capacity', comparison, used: c.used, reserved: c.reserved, total: c.total, limit: c.limit,
      exceeds: c.exceeds, scaleMax: scale, usedPct: pct(c.used), reservedPct: pct(c.reserved),
      totalPct: pct(c.total), limitPct: pct(c.limit),
      negative: ['used', 'reserved', 'total'].filter(k => typeof c[k] === 'number' && c[k] < 0),
      quantities: f.diffs.filter(d => /filledQuantity|remainingQuantity|quantity/.test(d.path)) };
  }
  if (f.lens === 'stock' && f.stock) {
    const target = isRecord(f.state.target) ? f.state.target : f.state;
    const recordedComparison = [...f.violationsHere, ...f.groupViolations].find(v =>
      isRecord(v.evidence?.expected) && isRecord(v.evidence?.actual) &&
      JSON.stringify(v.evidence.actual) === JSON.stringify(target));
    const comparison = recordedComparison ? diffStates(recordedComparison.evidence.expected, recordedComparison.evidence.actual)
      .filter(d => /^(stock|reservations)\./.test(d.path)) : [];
    return { ...base, kind: 'stock', comparison, rows: f.stock.map(s => ({ ...s,
      overReserved: s.reservedRemaining !== null && s.onHand !== null ? s.reservedRemaining > s.onHand : null })) };
  }
  if (f.lens === 'version') {
    const changes = f.diffs.filter(d => /(^|\.)version(\.|$)/.test(d.path) && d.kind === 'changed')
      .map(d => ({ path: d.path, field: d.path.split('.').pop(), before: d.before, after: d.after,
        regressed: typeof d.before === 'number' && typeof d.after === 'number' ? d.after < d.before : null }));
    return { ...base, kind: 'version', changes };
  }
  if (f.lens === 'lifecycle') {
    return { ...base, kind: 'lifecycle',
      statusChanges: f.diffs.filter(d => /(^|\.)status$/.test(d.path)),
      quantities: f.diffs.filter(d => /remaining|filled|shipped|cancelled|quantity/i.test(d.path)) };
  }
  if (f.lens === 'identity') {
    const p = isRecord(f.payload) ? f.payload : {};
    const key = identityKey(p);
    // Scheduling and delivery are separate trace entries for the same message.
    // Compare only delivered events with the same business identity and entity.
    const deliveries = key === null ? [] : priorFrames.filter(x => x.action === 'deliver' && isProcessed(x) &&
      identityKey(x.payload) === key && x.payload?.type === p.type && x.payload?.orderId === p.orderId &&
      x.payload?.reservationId === p.reservationId);
    const repeats = deliveries.length;
    const previousPayload = deliveries.at(-1)?.payload;
    const conflicts = [];
    if (previousPayload) {
      for (const [field, value] of Object.entries(p)) {
        if (['id', 'type', 'executionId', 'orderId', 'reservationId'].includes(field)) continue;
        if (Object.hasOwn(previousPayload, field) && JSON.stringify(previousPayload[field]) !== JSON.stringify(value)) {
          conflicts.push({ field, eventValue: value, recordedPath: 'Previous delivery', recordedValue: previousPayload[field] });
        }
      }
    }
    // A locked price is comparable only on the explicitly referenced order.
    const target = isRecord(f.state.target) ? f.state.target : f.state;
    const order = isRecord(target.orders) && typeof p.orderId === 'string' ? target.orders[p.orderId] : null;
    if (p.type === 'execution' && num(p.price) !== null && num(order?.price) !== null && p.price !== order.price) {
      conflicts.push({ field: 'price', eventValue: p.price, recordedPath: `Order ${p.orderId} locked price`, recordedValue: order.price });
    }
    return { ...base, kind: 'identity', eventIdentity: key, messageId: f.messageId,
      orderId: p.orderId ?? null, outcome: f.outcome, priorOccurrences: repeats, occurrences: repeats + (key === null ? 0 : 1),
      stateChanged: f.diffs.length > 0, quantities: f.diffs.filter(d => /filledQuantity|remainingQuantity|quantity/.test(d.path)),
      conflicts: conflicts.slice(0, 4) };
  }
  return { ...base, kind: 'diff', changes: f.diffs.slice(0, 3), changeCount: f.diffs.length,
    negativeChanges: f.diffs.filter(d => typeof d.after === 'number' && d.after < 0) };
}
export function buildFrames(caseData) {
  const trace = caseData?.trace ?? [];
  const { perIndex, unattributed, groupByIndex } = attributeViolations(trace, caseData?.violations ?? []);
  const frames = trace.map((entry, i) => {
    const known = stateKnown(entry.state);
    const prevKnown = i > 0 ? stateKnown(trace[i - 1].state) : false;
    const diffs = known ? diffStates(prevKnown || i === 0 ? (i > 0 ? trace[i - 1].state : undefined) : undefined, entry.state) : [];
    const credit = known ? creditView(entry.state) : null;
    const stock = known ? stockView(entry.state) : null;
    const violationsHere = perIndex.get(i) ?? [];
    const groupViolations = groupByIndex.get(i) ?? [];
    const p = isRecord(entry.payload) ? entry.payload : null;
    const type = typeof p?.type === 'string' ? p.type : null;
    const lens = selectLens({ entry, diffs, violationsHere, groupViolations, credit, stock });
    const stateStatus = !known ? 'not-recorded' : (!prevKnown ? 'first-recorded' : 'recorded');
    return { index: i, step: entry.step, time: entry.time ?? null, action: entry.action ?? 'recorded',
      outcome: entry.outcome ?? '', messageId: entry.messageId ?? null, payload: entry.payload ?? null,
      payloadType: type, kind: classify(entry), diffs, credit, stock, lens,
      violationsHere, groupViolations, isViolation: violationsHere.length > 0,
      isGroupFinding: groupViolations.length > 0,
      state: entry.state ?? null, stateKnown: known, prevStateKnown: prevKnown, stateStatus,
      eventName: humanEventName(entry),
      title: `${humanEventName(entry)}: ${entry.outcome ?? 'recorded'}` };
  });
  const scale = caseScale(frames);
  for (const f of frames) if (f.credit && scale) f.credit.scaleMax = scale;
  for (let i = 0; i < frames.length; i++) frames[i].visual = buildVisual(frames[i], frames.slice(0, i));
  const groupFrames = frames.filter(f => f.isGroupFinding).map(f => f.index);
  const firstGroupStep = groupFrames.length ? frames[groupFrames[0]].step : null;
  const actionFindingFrame = groupFrames.length ? groupFrames.filter(i => frames[i].step === firstGroupStep).at(-1) : null;
  return { frames, unattributed, findingFrames: frames.filter(f => f.isViolation).map(f => f.index),
    groupFrames, actionFindingFrame, scale,
    summary: { violationsRecorded: (caseData?.violations ?? []).length,
      uniqueMessages: dedupeViolations(caseData?.violations ?? []).length } };
}
export function clampIndex(i, len) {
  if (!len || len <= 0) return 0;
  const n = Number.isFinite(i) ? Math.trunc(i) : 0;
  return Math.min(Math.max(n, 0), len - 1);
}
export function stepBy(current, delta, len) { return clampIndex(current + delta, len); }
export function jumpToFinding(frames) {
  const f = (frames ?? []).find(x => x.isViolation);
  return f ? f.index : null;
}
export function clearedVisualState() {
  // Model of the fully reset stage used for empty/missing/clean transitions.
  return { caption: '', event: '', change: '', flowState: '', marker: null, bannerKind: 'neutral',
    banner: '', lensKind: null, nodesBad: false, packetVisible: false, playing: false };
}
// One owned playback clock. The scheduler is injected so the UI can drive it
// with requestAnimationFrame and tests can drive the very same controller
// with a fake clock. A generation token invalidates in-flight callbacks on
// every pause/seek/switch/hide/reduced-motion transition.
export function createPlaybackController({ onIndex, onPlaying, schedule, cancel, stepDuration = 900 } = {}) {
  let index = 0, length = 0, playing = false, generation = 0, handle = null;
  const sched = schedule ?? ((cb) => setTimeout(() => cb(1), stepDuration));
  const canc = cancel ?? ((h) => clearTimeout(h));
  function invalidate() { generation += 1; if (handle !== null) { try { canc(handle); } catch {} handle = null; } }
  function setPlaying(v) { if (playing !== v) { playing = v; onPlaying?.(v); } }
  function emit() { onIndex?.(index); }
  function tick(gen) {
    if (!playing || gen !== generation) return;
    handle = null;
    if (length <= 0) { setPlaying(false); return; }
    if (index >= length - 1) { setPlaying(false); emit(); return; }
    index += 1; emit();
    if (index >= length - 1) { setPlaying(false); return; }
    queue();
  }
  function queue() {
    const gen = generation;
    handle = sched((progress) => { if (gen === generation && playing) tick(gen); });
  }
  return {
    get index() { return index; }, get length() { return length; }, get playing() { return playing; },
    get enabled() { return length > 0; },
    setLength(n) { length = Math.max(0, Math.trunc(n) || 0); index = clampIndex(index, length); },
    play() {
      if (length <= 0 || playing) return false;
      if (index >= length - 1) index = 0;
      invalidate(); setPlaying(true); emit(); queue(); return true;
    },
    pause() { invalidate(); setPlaying(false); },
    stop() { invalidate(); setPlaying(false); },
    toggle() { if (playing) { this.pause(); return false; } return this.play(); },
    seek(i) { invalidate(); setPlaying(false); index = clampIndex(i, length); emit(); },
    step(delta) { invalidate(); setPlaying(false); index = stepBy(index, delta, length); emit(); },
    switchTo(n, start = 0) { invalidate(); setPlaying(false); length = Math.max(0, Math.trunc(n) || 0); index = clampIndex(start, length); emit(); },
    handleHidden() { if (playing) this.pause(); },
    handleReducedMotion(matches) { if (matches) this.pause(); },
    dispose() { invalidate(); setPlaying(false); },
  };
}
