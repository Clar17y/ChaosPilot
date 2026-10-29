/** Typed visual-stage projection for recorded replay.
 * Dispatch is by supported adapter identity plus recorded evidence semantics,
 * never by case, variant or finding identifiers. Unknown adapters keep the
 * generic before/after view even when field names look familiar. */
import type { TraceEntry, Violation } from '../domain.ts';
import { extractInventorySnapshotDisplay, type StateAdapterKind } from './snapshot.ts';
import { attributeViolations, creditFromState, isProcessedTransition, violationMatchesEntry, type CreditView } from './reproduction-player.ts';

export type StageLensKind = 'capacity' | 'stock' | 'version' | 'lifecycle' | 'identity' | 'diff' | 'not-recorded' | 'grouped';

export interface StateDiff { path: string; before: unknown; after: unknown; kind: 'first-recorded' | 'added' | 'removed' | 'changed' }
export interface ComparisonRow { label: string; before: unknown; after: unknown; regressed?: boolean | null }
export interface StockRow { sku: string; received: number | null; onHand: number | null; reservedRemaining: number | null; available: number | null; overReserved: boolean | null }
export interface IdentityConflict { field: string; eventValue: unknown; recordedLabel: string; recordedValue: unknown }

export interface CreditBarSegment { label: 'used' | 'reserved' | 'total'; value: number; left: number; width: number; negative: boolean }
export interface CreditBarGeometry { mode: 'stacked' | 'signed'; zeroPct: number; segments: CreditBarSegment[]; limitPct: number | null; scaleMax: number }
/** Signed geometry with a zero origin. Negative components are never drawn
 * as positive stacked areas; null components produce no segment (unknown). */
export function creditBarGeometry(used: number | null, reserved: number | null, total: number | null, limit: number | null, scaleMax: number | null): CreditBarGeometry | null {
  if (scaleMax === null || !(scaleMax > 0)) return null;
  const entries = ([['used', used], ['reserved', reserved], ['total', total]] as const).filter(([, v]) => v !== null) as [CreditBarSegment['label'], number][];
  if (!entries.length) return null;
  const hasNegative = entries.some(([, v]) => v < 0);
  if (!hasNegative) {
    let left = 0; const segments: CreditBarSegment[] = [];
    for (const [label, value] of entries.filter(([l]) => l !== 'total')) { const width = (value / scaleMax) * 100; segments.push({ label, value, left, width, negative: false }); left += width; }
    return { mode: 'stacked', zeroPct: 0, segments, limitPct: limit === null ? null : (limit / scaleMax) * 100, scaleMax };
  }
  const segments = entries.map(([label, value]) => ({ label, value, left: value < 0 ? 50 + (value / scaleMax) * 50 : 50, width: (Math.abs(value) / scaleMax) * 50, negative: value < 0 }));
  return { mode: 'signed', zeroPct: 50, segments, limitPct: limit === null ? null : 50 + (limit / scaleMax) * 50, scaleMax };
}

export interface StageVisual {
  kind: StageLensKind;
  diffs: StateDiff[];
  comparison: ComparisonRow[];
  credit: (CreditView & { scaleMax: number | null; usedPct: number | null; reservedPct: number | null; totalPct: number | null; limitPct: number | null; negative: string[]; bar: CreditBarGeometry | null }) | null;
  stockRows: StockRow[];
  versionChanges: ComparisonRow[];
  statusChanges: StateDiff[];
  quantities: StateDiff[];
  eventIdentity: string | null;
  occurrences: number | null;
  priorOccurrences: number | null;
  conflicts: IdentityConflict[];
  stateChanged: boolean | null;
  changeCount: number;
  negativeChanges: StateDiff[];
}

export interface StageFrame {
  tracePosition: number;
  eventName: string;
  stateKnown: boolean;
  stateStatus: 'not-recorded' | 'first-recorded' | 'recorded';
  diffs: StateDiff[];
  visual: StageVisual;
  violationsHere: Violation[];
  groupViolations: Violation[];
  isViolation: boolean;
  isGroupFinding: boolean;
}

export interface StageProjection {
  frames: StageFrame[];
  scaleMax: number | null;
  findingTracePosition: number | null;
  groupFindingTracePosition: number | null;
  unattributed: Violation[];
}

function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function num(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

export function formatRecordedValue(v: unknown): string {
  if (v === undefined) return 'not recorded';
  if (v === null) return 'null';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return 'not recorded (unserialisable)'; } }
  return String(v);
}

function encodePathSegment(key: string): string {
  if (key === '') return '\\_';
  return key.replace(/\\/g, '\\\\').replace(/\./g, '\\.');
}

function flatten(value: unknown, prefix: string | null = null, out = new Map<string, unknown>()): Map<string, unknown> {
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) {
      // An empty object is a meaningful recorded value, not an absence.
      if (prefix !== null) out.set(prefix, value);
      return out;
    }
    for (const k of keys) flatten(value[k], prefix === null ? encodePathSegment(k) : `${prefix}.${encodePathSegment(k)}`, out);
    return out;
  }
  if (prefix !== null) out.set(prefix, value);
  return out;
}

function stateKnown(state: unknown): boolean { return state !== undefined && state !== null; }

/** IDs may change on rerun; the selected failure must still be recorded there. */
function sameRecordedViolation(a: Violation, b: Violation): boolean {
  const evidenceKey = (value: Record<string, unknown>) => JSON.stringify(value, (_key, item: unknown) =>
    isRecord(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  return a.invariant === b.invariant && a.step === b.step && a.orderId === b.orderId &&
    a.category === b.category && a.message === b.message && evidenceKey(a.evidence) === evidenceKey(b.evidence);
}

export function diffRecordedStates(prev: unknown, curr: unknown): StateDiff[] {
  if (!stateKnown(curr)) return [];
  const b = flatten(curr);
  if (!stateKnown(prev)) return [...b.entries()].map(([path, after]) => ({ path, before: undefined, after, kind: 'first-recorded' as const }));
  const a = flatten(prev);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  const diffs: StateDiff[] = [];
  for (const p of paths) {
    const before = a.has(p) ? a.get(p) : undefined;
    const after = b.has(p) ? b.get(p) : undefined;
    if (JSON.stringify(before) !== JSON.stringify(after)) diffs.push({ path: p, before, after, kind: !a.has(p) ? 'added' : !b.has(p) ? 'removed' : 'changed' });
  }
  return diffs;
}

function stockRows(state: unknown): StockRow[] | null {
  // Share the detailed evidence view's missing-data and safe-arithmetic rules.
  const rows = extractInventorySnapshotDisplay(state).stock.map(row => ({
    sku: row.sku,
    received: num(row.received),
    onHand: num(row.onHand),
    reservedRemaining: num(row.reservedRemaining),
    available: num(row.available),
    overReserved: row.available === '-' ? null : row.overReserved,
  }));
  return rows.length ? rows : null;
}

export function humanEventName(entry: TraceEntry): string {
  const p = isRecord(entry.payload) ? entry.payload : null;
  const raw = typeof p?.type === 'string' && p.type ? p.type : (entry.action ?? 'recorded event');
  const words = String(raw).replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Recorded event';
}

function identityKey(p: Record<string, unknown> | null): string | null {
  if (!p) return null;
  const v = p.executionId ?? p.id ?? null;
  return v === null || v === undefined ? null : String(v);
}
function isDelivered(entry: TraceEntry): boolean {
  return isProcessedTransition(entry) && (entry.action === 'deliver' || entry.action.includes('deliver'));
}

function selectLens(args: { entry: TraceEntry; diffs: StateDiff[]; relevant: Violation[]; credit: CreditView | null; stock: StockRow[] | null; adapterKind: StateAdapterKind }): StageLensKind {
  // Unknown/generic adapters always keep the general before/after view, even
  // when field or invariant names look like a supported domain.
  if (args.adapterKind !== 'trading' && args.adapterKind !== 'inventory') return 'diff';
  const fam = args.relevant.map(v => `${v.invariant ?? ''} ${v.category ?? ''}`).join(' ');
  const outcome = args.entry.outcome ?? '';
  const changedVersion = args.diffs.some(d => /(^|\.)version(\.|$)/.test(d.path) && d.kind === 'changed');
  const changedStatus = args.diffs.some(d => /(^|\.)status$/.test(d.path) && d.kind === 'changed');
  const creditChanged = args.diffs.some(d => /(^|\.)(usedCredit|reservedCredit|credit)(\.|$)/.test(d.path));
  const stockChanged = args.diffs.some(d => /(^|\.)(stock|reservations)(\.|$)/.test(d.path));
  if (/version/.test(fam) || changedVersion) return 'version';
  if (/lifecycle/.test(fam)) return 'lifecycle';
  if (args.adapterKind === 'inventory' && args.stock && /stock|inventory|reservation|shipment|cancellation/.test(fam)) return 'stock';
  if (/idempoten|input_integrity|execution_integrity|duplicate/.test(fam)) return 'identity';
  if (args.adapterKind === 'trading' && /credit|capacity|limit/.test(fam) && args.credit) return 'capacity';
  if (/balance|non_negative|negative/.test(fam)) return 'diff';
  if (changedStatus) return 'lifecycle';
  if (outcome === 'duplicate') return 'identity';
  if (args.adapterKind === 'trading' && args.credit && creditChanged) return 'capacity';
  if (args.adapterKind === 'inventory' && args.stock && stockChanged) return 'stock';
  if ((outcome === 'accepted' || outcome === 'duplicate' || outcome === 'rejected') && args.relevant.length) return 'identity';
  return 'diff';
}

export function buildStageProjection(trace: TraceEntry[], violations: Violation[], adapterKind: StateAdapterKind, selected?: Violation | { violation: Violation } | null): StageProjection {
  const selectedViolation: Violation | null = selected
    ? ((selected as { violation?: Violation }).violation ?? (selected as Violation))
    : null;
  const { byPosition: perIndex, unattributed } = attributeViolations(trace ?? [], violations ?? []);
  const groupByIndex = new Map<number, Violation[]>();
  for (const v of unattributed) (trace ?? []).forEach((e, i) => { if (e.step === v.step) groupByIndex.set(i, [...(groupByIndex.get(i) ?? []), v]); });

  const rawFrames = (trace ?? []).map((entry, i) => {
    const known = stateKnown(entry.state);
    const prevKnown = i > 0 ? stateKnown(trace[i - 1]!.state) : false;
    const diffs = known ? diffRecordedStates(i > 0 && prevKnown ? trace[i - 1]!.state : undefined, entry.state) : [];
    // Specialised domain views require explicit supported adapter identity.
    const credit = known && adapterKind === 'trading' ? creditFromState(entry.state) : null;
    const stock = known && adapterKind === 'inventory' ? stockRows(entry.state) : null;
    const violationsHere = perIndex.get(i) ?? [];
    const groupViolations = groupByIndex.get(i) ?? [];
    const lens = selectLens({ entry, diffs, relevant: [...violationsHere, ...groupViolations], credit, stock, adapterKind });
    return { entry, i, known, prevKnown, diffs, credit, stock, violationsHere, groupViolations, lens };
  });

  let scale = 0;
  for (const f of rawFrames) {
    if (f.credit) scale = Math.max(scale, Math.abs(f.credit.total ?? 0), Math.abs(f.credit.limit ?? 0), Math.abs(f.credit.used ?? 0), Math.abs(f.credit.reserved ?? 0));
    if (f.stock) for (const s of f.stock) scale = Math.max(scale, Math.abs(s.received ?? 0), Math.abs(s.onHand ?? 0), Math.abs(s.reservedRemaining ?? 0));
  }
  const scaleMax = scale > 0 ? scale : null;

  // Running prior-delivery lookup: only count and last payload per exact
  // identity/type/order/reservation match. Strict === keeps missing vs null,
  // numeric vs string and object identity distinct (never a JSON key).
  interface PriorDelivery { type: unknown; orderId: unknown; reservationId: unknown; count: number; lastPayload: Record<string, unknown> }
  const priorByKey = new Map<string, PriorDelivery[]>();
  const findPrior = (key: string, type: unknown, orderId: unknown, reservationId: unknown): PriorDelivery | undefined =>
    priorByKey.get(key)?.find(b => b.type === type && b.orderId === orderId && b.reservationId === reservationId);
  const recordDelivery = (entry: TraceEntry): void => {
    if (!isDelivered(entry)) return;
    const xp = isRecord(entry.payload) ? entry.payload : null;
    const key = identityKey(xp);
    if (key === null || !xp) return;
    // A NaN field can never strictly match a later frame, so it has no predecessor effect.
    if (xp.type !== xp.type || xp.orderId !== xp.orderId || xp.reservationId !== xp.reservationId) return;
    const existing = findPrior(key, xp.type, xp.orderId, xp.reservationId);
    if (existing) { existing.count++; existing.lastPayload = xp; }
    else {
      const list = priorByKey.get(key) ?? [];
      list.push({ type: xp.type, orderId: xp.orderId, reservationId: xp.reservationId, count: 1, lastPayload: xp });
      priorByKey.set(key, list);
    }
  };

  const frames: StageFrame[] = rawFrames.map((f) => {
    const base: StageVisual = { kind: 'diff', diffs: f.diffs, comparison: [], credit: null, stockRows: [], versionChanges: [], statusChanges: [], quantities: [], eventIdentity: null, occurrences: null, priorOccurrences: null, conflicts: [], stateChanged: null, changeCount: f.diffs.length, negativeChanges: f.diffs.filter(d => typeof d.after === 'number' && d.after < 0) };
    let visual: StageVisual;
    if (!f.known) visual = { ...base, kind: 'not-recorded' };
    else if (f.lens === 'capacity' && f.credit) {
      const c = f.credit; const s = scaleMax ?? Math.max(Math.abs(c.total ?? 0), Math.abs(c.limit ?? 0), 1);
      const pct = (v: number | null) => v === null ? null : (v / s) * 100;
      const comparison: ComparisonRow[] = [];
      for (const v of f.violationsHere) {
        const e = v.evidence ?? {};
        if (num(e.expectedUsedCredit) !== null && num(e.targetUsedCredit) !== null) comparison.push({ label: 'Used credit', before: e.expectedUsedCredit, after: e.targetUsedCredit });
        if (num(e.expectedReservation) !== null && num(e.targetReservedCredit) !== null) comparison.push({ label: 'Reserved credit', before: e.expectedReservation, after: e.targetReservedCredit });
        // A recorded limit is a ceiling, not an expected value: no
        // expected/observed row is synthesised from limit/totalRequired.
      }
      visual = { ...base, kind: 'capacity', comparison, credit: { ...c, scaleMax: s, usedPct: pct(c.used), reservedPct: pct(c.reserved), totalPct: pct(c.total), limitPct: pct(c.limit), negative: ['used', 'reserved', 'total'].filter(k => typeof c[k as 'used' | 'reserved' | 'total'] === 'number' && (c[k as 'used' | 'reserved' | 'total'] as number) < 0), bar: creditBarGeometry(c.used, c.reserved, c.total, c.limit, s) }, quantities: f.diffs.filter(d => /filledQuantity|remainingQuantity|quantity/.test(d.path)) };
    } else if (f.lens === 'stock' && f.stock) {
      const target = isRecord(f.entry.state) && isRecord((f.entry.state as Record<string, unknown>).target) ? (f.entry.state as Record<string, unknown>).target : f.entry.state;
      const recorded = [...f.violationsHere, ...f.groupViolations].find(v => isRecord(v.evidence?.expected) && isRecord(v.evidence?.actual) && JSON.stringify(v.evidence.actual) === JSON.stringify(target));
      const comparison = recorded ? diffRecordedStates(recorded.evidence.expected, recorded.evidence.actual).filter(d => /^(stock|reservations)\./.test(d.path)).map(d => ({ label: d.path, before: d.before, after: d.after })) : [];
      visual = { ...base, kind: 'stock', comparison, stockRows: f.stock };
    } else if (f.lens === 'version') {
      visual = { ...base, kind: 'version', versionChanges: f.diffs.filter(d => /(^|\.)version(\.|$)/.test(d.path) && d.kind === 'changed').map(d => ({ label: d.path, before: d.before, after: d.after, regressed: typeof d.before === 'number' && typeof d.after === 'number' ? d.after < d.before : null })) };
    } else if (f.lens === 'lifecycle') {
      visual = { ...base, kind: 'lifecycle', statusChanges: f.diffs.filter(d => /(^|\.)status$/.test(d.path)), quantities: f.diffs.filter(d => /remaining|filled|shipped|cancelled|quantity/i.test(d.path)) };
    } else if (f.lens === 'identity') {
      const p = isRecord(f.entry.payload) ? f.entry.payload : {};
      const key = identityKey(p);
      const prior = key === null ? undefined : findPrior(key, p.type, p.orderId, p.reservationId);
      const priorCount = prior?.count ?? 0;
      const conflicts: IdentityConflict[] = [];
      const prevPayload = prior?.lastPayload ?? null;
      if (prevPayload) for (const [field, value] of Object.entries(p)) {
        if (['id', 'type', 'executionId', 'orderId', 'reservationId'].includes(field)) continue;
        if (Object.prototype.hasOwnProperty.call(prevPayload, field) && JSON.stringify(prevPayload[field]) !== JSON.stringify(value)) conflicts.push({ field, eventValue: value, recordedLabel: 'Previous delivery', recordedValue: prevPayload[field] });
      }
      const targetState = isRecord(f.entry.state) && isRecord((f.entry.state as Record<string, unknown>).target) ? (f.entry.state as Record<string, unknown>).target as Record<string, unknown> : (isRecord(f.entry.state) ? f.entry.state as Record<string, unknown> : null);
      const order = targetState && isRecord(targetState.orders) && typeof p.orderId === 'string' ? (targetState.orders as Record<string, unknown>)[p.orderId] : null;
      if (p.type === 'execution' && num(p.price) !== null && isRecord(order) && num(order.price) !== null && p.price !== order.price) conflicts.push({ field: 'price', eventValue: p.price, recordedLabel: `Order ${String(p.orderId)} locked price`, recordedValue: order.price });
      visual = { ...base, kind: 'identity', eventIdentity: key, priorOccurrences: priorCount, occurrences: key === null ? null : priorCount + 1, conflicts: conflicts.slice(0, 4), stateChanged: f.prevKnown ? f.diffs.length > 0 : null, quantities: f.diffs.filter(d => /filledQuantity|remainingQuantity|quantity/.test(d.path)) };
    } else {
      visual = { ...base, kind: 'diff', comparison: f.diffs.slice(0, 3).map(d => ({ label: d.path, before: d.before, after: d.after })) };
    }
    // Current frame contributes only to later frames, whatever its lens or recorded state.
    recordDelivery(f.entry);
    return { tracePosition: f.i, eventName: humanEventName(f.entry), stateKnown: f.known, stateStatus: !f.known ? 'not-recorded' : (!f.prevKnown && f.i > 0 ? 'first-recorded' : f.i === 0 ? 'first-recorded' : 'recorded'), diffs: f.diffs, visual, violationsHere: f.violationsHere, groupViolations: f.groupViolations, isViolation: f.violationsHere.length > 0, isGroupFinding: f.groupViolations.length > 0 };
  });

  if (selectedViolation) {
    // A familiar action/entity alone is not evidence that the selected failure
    // occurred in this recording. First resolve it among this source's checks.
    const recordedViolation = violations.find(v => sameRecordedViolation(v, selectedViolation));
    if (!recordedViolation) return { frames, scaleMax, findingTracePosition: null, groupFindingTracePosition: null, unattributed };
    // Then resolve its position in this source, including a shared action.
    const matches: number[] = [];
    (trace ?? []).forEach((e, i) => { if (violationMatchesEntry(recordedViolation, e)) matches.push(i); });
    if (matches.length === 1) return { frames, scaleMax, findingTracePosition: matches[0]!, groupFindingTracePosition: null, unattributed };
    const sameStep: number[] = [];
    (trace ?? []).forEach((e, i) => { if (e.step === recordedViolation.step) sameStep.push(i); });
    return { frames, scaleMax, findingTracePosition: null, groupFindingTracePosition: sameStep.length ? sameStep[sameStep.length - 1]! : null, unattributed };
  }
  const finding = frames.find(f => f.isViolation);
  const groupFrames = frames.filter(f => f.isGroupFinding);
  let groupFindingTracePosition: number | null = null;
  if (groupFrames.length) {
    const firstStep = groupFrames[0]!.tracePosition; const stepVal = trace[firstStep]!.step;
    const same = groupFrames.filter(fr => trace[fr.tracePosition]!.step === stepVal);
    groupFindingTracePosition = same[same.length - 1]!.tracePosition;
  }
  return { frames, scaleMax, findingTracePosition: finding ? finding.tracePosition : null, groupFindingTracePosition, unattributed };
}

/** Step (visible-sequence position) whose underlying trace entry is the recorded finding, or null. */
export function visiblePositionForTracePosition(steps: { tracePosition: number; isGroup?: boolean; groupTracePositions?: number[] }[], tracePosition: number | null): number | null {
  if (tracePosition === null) return null;
  const direct = steps.findIndex(s => !s.isGroup && s.tracePosition === tracePosition);
  if (direct >= 0) return direct;
  const grouped = steps.findIndex(s => s.isGroup && (s.groupTracePositions ?? []).includes(tracePosition));
  return grouped >= 0 ? grouped : null;
}
