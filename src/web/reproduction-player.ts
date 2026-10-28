/** Pure derivation and playback logic for the saved-trace reproduction player.
 * Playback reads recorded trace entries only. It never executes the target,
 * contacts a model, or invents state before/between recorded entries. */
import type { ExperimentRecord, Finding, InvestigationRecord, TraceEntry, Violation } from '../domain.ts';
import { resolveExperimentPositionForIndex } from '../experiment-identity.ts';
import { extractInventorySnapshotDisplay } from './snapshot.ts';
import { findingCategoryLabel } from './presentation.ts';

export type StepKind = 'scheduled' | 'processed' | 'rejected' | 'other';

export interface CreditView {
  limit: number | null;
  used: number | null;
  reserved: number | null;
  total: number | null;
  /** Arithmetic comparison only. Never, by itself, a compliance verdict. */
  totalExceedsLimit: boolean | null;
}

export interface PlaybackStep {
  /** Position within the visible playback sequence. */
  position: number;
  /** Position of the underlying entry in the saved trace. */
  tracePosition: number;
  /** Synthetic grouped step collapsing consecutive unimportant entries. */
  isGroup?: boolean;
  groupCount?: number;
  groupTracePositions?: number[];
  /** Recorded trading facts for this entry (payload/state), never inferred. */
  facts: string[];
  payloadType: string | null;
  /** Experiment action index recorded on the entry (`entry.step`). */
  actionIndex: number;
  time: number;
  action: string;
  kind: StepKind;
  kindLabel: string;
  outcome: string;
  payloadText: string;
  messageId: string | null;
  title: string;
  detail: string;
  credit: CreditView | null;
  stateText: string;
  /** Violations recorded at this entry's action (see violation attribution).
   * For whole-state checks this means detected at that action, not caused by it. */
  violations: Violation[];
  /** True when a violation is recorded at this processed entry. Drives red error styling only. */
  isViolation: boolean;
}

export interface EvidenceSummary {
  invariant: string | null;
  /** Observed oracle category for the selected finding/violation, as a readable label. */
  observedCategory: string;
  violationMessage: string | null;
  violations: Violation[];
  /** Rule text from the run's pinned contract only. */
  ruleText: string | null;
  ruleLabel: string;
  expectedInvariant: string | null;
  hypothesis: string;
  sourceHash: string | null;
  experimentPosition: number;
  experimentIndex: number | null;
  runId: string;
  /** Credit chart is relevant only when recorded credit evidence supports it. */
  creditRelevant: boolean;
}

export interface ReproductionModel {
  runId: string;
  evidence: EvidenceSummary;
  /** Complete original trace steps, always accessible. */
  allSteps: PlaybackStep[];
  traceCount: number;
  modelLabel: string;
  targetLabel: string;
  systemLabel: string;
  briefLabel: string;
  experimentLabel: string;
  hypothesis: string;
  valid: boolean;
  invalidLabel: string | null;
  replayLabel: string;
  cleanLabel: string;
  findingTitle: string | null;
  steps: PlaybackStep[];
  /** Violations that share an action index but cannot be pinned to one processed entry. */
  unattributedViolations: Violation[];
  /** A compact, evidence-backed credit-admission story, grouped concise view, or the complete trace. */
  sequence: 'key-events' | 'grouped' | 'trace';
  hasTrace: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Credit figures from a recorded trace-entry state or final snapshot. Nulls mean not recorded. */
export function creditFromState(state: unknown): CreditView | null {
  if (!isRecord(state)) return null;
  const target = isRecord(state.target) ? state.target : state;
  const limit = isRecord(target.credit) ? num(target.credit.limit) : num(target.creditLimit);
  const reserved = num(target.reservedCredit);
  const used = num(target.usedCredit);
  if (limit === null && reserved === null && used === null) return null;
  const total = reserved !== null && used !== null ? reserved + used : null;
  return {
    limit, used, reserved, total,
    totalExceedsLimit: total !== null && limit !== null ? total > limit : null,
  };
}

export function fmtCredit(v: number | null): string {
  return v === null ? 'not recorded' : String(v);
}

/** Scale the composition to include the limit, so spare capacity stays visible. */
export function creditBarLayout(credit: CreditView | null): { used: number; reserved: number; limit: number | null } | null {
  if (!credit || credit.total === null || credit.total <= 0 || credit.used === null || credit.used < 0 || credit.reserved === null || credit.reserved < 0) return null;
  const limit = credit.limit !== null && credit.limit >= 0 ? credit.limit : null;
  const scale = Math.max(credit.total, limit ?? 0);
  return {
    used: (credit.used / scale) * 100,
    reserved: (credit.reserved / scale) * 100,
    limit: limit === null ? null : (limit / scale) * 100,
  };
}

/** Delivery outcomes recorded by adapters whose executor reports the raw
 * target outcome (accepted/duplicate/rejected) on a 'deliver' entry. The
 * oracle checks state after every such delivery, so all three are processed
 * transitions for attribution; accepted/duplicate are never a pass by
 * themselves and rejected is never a defect by itself. */
const DELIVERY_OUTCOMES = new Set(['accepted', 'duplicate', 'rejected']);

export function isProcessedTransition(entry: TraceEntry): boolean {
  const outcome = entry.outcome ?? '';
  if (entry.action === 'deliver' && DELIVERY_OUTCOMES.has(outcome)) return true;
  return outcome.startsWith('delivered:') || outcome === 'drained:empty' || outcome.startsWith('advanced by');
}

export function classifyStep(entry: TraceEntry): StepKind {
  const outcome = entry.outcome ?? '';
  if (outcome === 'rejected' || outcome.startsWith('rejected:') || outcome.startsWith('delivered:rejected')) return 'rejected';
  if (outcome === 'accepted' || outcome === 'duplicate') return 'processed';
  if (outcome === 'executed' && (entry.action === 'send' || entry.action === 'duplicate')) return 'scheduled';
  if (outcome === 'scheduled' || outcome.endsWith('_scheduled') || outcome.startsWith('duplicated from')) return 'scheduled';
  if (outcome.startsWith('delivered:') || outcome === 'drained:empty' || outcome.startsWith('advanced by')) return 'processed';
  return 'other';
}

const KIND_LABEL: Record<StepKind, string> = {
  scheduled: 'Scheduled: not yet processed (recorded state is unchanged by this event)',
  processed: 'Processed: recorded state after this transition',
  rejected: 'Recorded rejection: not by itself a target defect or a recorded pass',
  other: 'Recorded entry',
};

function payloadRecord(entry: TraceEntry): Record<string, unknown> | null {
  return isRecord(entry.payload) ? entry.payload : null;
}

export function stepTitle(entry: TraceEntry, credit: CreditView | null): string {
  const p = payloadRecord(entry);
  const type = typeof p?.type === 'string' ? p.type : null;
  const kind = classifyStep(entry);
  if (type === 'credit_limit' && num(p?.limit) !== null) {
    const status = kind === 'processed' ? 'processed' : kind === 'rejected' ? 'rejected' : 'scheduled';
    return `Credit limit update ${status}: ${num(p?.limit)}`;
  }
  if (type === 'quote' && num(p?.price) !== null) {
    const status = kind === 'processed' ? 'processed' : kind === 'rejected' ? 'rejected' : 'scheduled';
    return `Quote update ${status}: ${num(p?.price)}`;
  }
  if (type === 'new_order') {
    const oid = typeof p?.orderId === 'string' ? p.orderId : 'order';
    const qty = num(p?.quantity);
    if (kind === 'processed') return qty !== null ? `Order ${oid} admitted: quantity ${qty}` : `Order ${oid} admitted`;
    if (kind === 'rejected') return `Order ${oid} not admitted (recorded rejection)`;
    return qty !== null ? `Order ${oid} scheduled: quantity ${qty}` : `Order ${oid} scheduled`;
  }
  if (type === 'execution') {
    const oid = typeof p?.orderId === 'string' ? p.orderId : 'order';
    const qty = num(p?.quantity);
    if (kind === 'processed') return qty !== null ? `Order ${oid} fill processed: quantity ${qty}` : `Order ${oid} fill processed`;
    if (kind === 'rejected') return `Fill for order ${oid} rejected`;
    return qty !== null ? `Fill for order ${oid} scheduled: quantity ${qty}` : `Fill for order ${oid} scheduled`;
  }
  if (type === 'cancel_ack') return kind === 'processed' ? 'Cancel acknowledgement processed' : kind === 'rejected' ? 'Cancel acknowledgement rejected' : 'Cancel acknowledgement scheduled';
  const inventoryTitle = inventoryStepTitle(entry, p, kind);
  if (inventoryTitle) return inventoryTitle;
  if (credit && kind === 'processed' && credit.total !== null) return `${entry.action}: total exposure ${credit.total}`;
  return `${entry.action}: ${entry.outcome || 'recorded'}`;
}

/**
 * Titles for inventory delivery payloads, from recorded payload fields and
 * the recorded delivery outcome only. The outcome word is the target's own
 * recorded outcome; it is labelled recorded, never a pass/fail judgement.
 */
function inventoryStepTitle(entry: TraceEntry, p: Record<string, unknown> | null, kind: StepKind): string | null {
  const type = typeof p?.type === 'string' ? p.type : null;
  if (!p || (type !== 'stock' && type !== 'reserve' && type !== 'cancel' && type !== 'ship')) return null;
  const sku = typeof p.sku === 'string' ? p.sku : null;
  const reservationId = typeof p.reservationId === 'string' ? p.reservationId : null;
  const qty = num(p.quantity);
  const outcome = entry.outcome ?? '';
  const suffix = DELIVERY_OUTCOMES.has(outcome) ? `: ${outcome} (recorded)` : kind === 'scheduled' ? ' scheduled' : '';
  if (type === 'stock') return `Stock receipt${sku ? ` for SKU ${sku}` : ''}${qty !== null ? `: quantity ${qty}` : ''}${suffix}`;
  if (type === 'reserve') return `Reservation${reservationId ? ` ${reservationId}` : ''}${sku ? ` for SKU ${sku}` : ''}${qty !== null ? `: quantity ${qty}` : ''}${suffix}`;
  if (type === 'cancel') return `Cancel reservation${reservationId ? ` ${reservationId}` : ''}${suffix}`;
  return `Ship reservation${reservationId ? ` ${reservationId}` : ''}${qty !== null ? `: quantity ${qty}` : ''}${suffix}`;
}

function stepDetail(kind: StepKind): string {
  if (kind === 'scheduled') return 'This event was scheduled. Delivery and any state change are recorded in a later entry, if at all.';
  if (kind === 'rejected') return 'This action was rejected as recorded. A rejected or invalid action is not, by itself, evidence of a target defect.';
  if (kind === 'processed') return 'The recorded state shown is the state after this entry was processed.';
  return 'Recorded entry from the trace.';
}

/**
 * Associate a violation with a specific entry only when the evidence supports
 * it: the entry must be a processed transition at the violation's action index,
 * and when the violation names an order, the entry payload must name that order.
 * The caller must additionally establish that this is the only matching entry:
 * several deliveries can share an action index, even for the same order.
 * Association means "recorded/detected at this action". Whole-state oracle
 * checks (credit consistency, quantity conservation, overfill, lifecycle,
 * venue integrity, non-negative credit) re-fire on later transitions, so an
 * associated state violation must never be described as caused by that entry.
 */
export function violationMatchesEntry(violation: Violation, entry: TraceEntry): boolean {
  if (violation.step !== entry.step) return false;
  if (!isProcessedTransition(entry)) return false;
  if (violation.orderId) {
    const p = payloadRecord(entry);
    return p !== null && p.orderId === violation.orderId;
  }
  // A violation whose recorded evidence names a SKU cannot be pinned to a
  // delivery whose payload names a different SKU. Payloads without a SKU
  // (ship/cancel) are not excluded by this evidence alone.
  const evidenceSku = typeof violation.evidence?.sku === 'string' ? violation.evidence.sku : null;
  if (evidenceSku) {
    const p = payloadRecord(entry);
    if (p && typeof p.sku === 'string' && p.sku !== evidenceSku) return false;
  }
  return true;
}

/** True only for the oracle's credit-admission evidence, not for arithmetic alone. */
export function isCreditAdmissionViolation(v: Violation | null | undefined): boolean {
  if (!v || v.invariant !== 'credit_limit_respected') return false;
  const e = v.evidence ?? {};
  return num(e.limit) !== null && num(e.totalRequired) !== null;
}

export interface StepExplanation {
  /** Hypothetical rule expectation. Never a recorded pass. */
  expected: string | null;
  expectedLabel: string | null;
  /** Recorded observation. Non-null violation text is an explicit error. */
  observed: string;
  observedIsViolation: boolean;
}

/**
 * Expected/observed for inventory oracle violations, using only numbers and
 * outcomes actually recorded in violation evidence. Returns null when the
 * recorded evidence does not support an expected statement.
 */
function explainInventoryViolations(violationsHere: Violation[]): StepExplanation | null {
  const stockViolation = violationsHere.find(v => v.invariant === 'stock_conservation'
    && typeof v.evidence?.sku === 'string'
    && num(v.evidence?.received) !== null && num(v.evidence?.onHand) !== null
    && num(v.evidence?.reserved) !== null && num(v.evidence?.shipped) !== null);
  if (stockViolation) {
    const e = stockViolation.evidence;
    return {
      // Expected side: the rule/reference constraint only. Actual recorded
      // figures belong on the observed side.
      expected: `For SKU ${String(e.sku)}, reserved remaining must not exceed on-hand stock, and received must equal on-hand plus shipped.`,
      expectedLabel: 'Expected (hypothetical, based on the rule): would satisfy the rule',
      observed: `Error: rule violation recorded at this action: ${violationsHere.map(v => v.message).join('; ')} Recorded evidence: received ${num(e.received)}, on hand ${num(e.onHand)}, reserved (remaining) ${num(e.reserved)}, shipped ${num(e.shipped)}.`,
      observedIsViolation: true,
    };
  }
  const transitionViolation = violationsHere.find(v => v.invariant === 'inventory_transition_consistency'
    && typeof v.evidence?.expectedOutcome === 'string' && typeof v.evidence?.outcome === 'string');
  if (transitionViolation) {
    const e = transitionViolation.evidence;
    // Expected side: the reference expectation only. The target's recorded
    // outcome belongs on the observed side, whether it differs or matches.
    const expected = e.expectedOutcome === e.outcome
      ? `The independent reference recorded in the violation evidence expected delivery outcome ${String(e.expectedOutcome)} with its own resulting inventory state; the reference and actual states are recorded in the violation evidence.`
      : `The independent reference recorded in the violation evidence expected delivery outcome ${String(e.expectedOutcome)}.`;
    return {
      expected,
      expectedLabel: 'Expected (from the independent reference recorded in the violation evidence)',
      observed: `Error: rule violation recorded at this action: ${violationsHere.map(v => v.message).join('; ')} Recorded target delivery outcome: ${String(e.outcome)}.`,
      observedIsViolation: true,
    };
  }
  return null;
}

export function explainStep(step: PlaybackStep, violationsHere: Violation[]): StepExplanation {
  if (step.isGroup) return { expected: null, expectedLabel: null, observed: `Observed (recorded): ${step.groupCount ?? 0} grouped entries (trace entries ${(step.groupTracePositions ?? []).map(p => p + 1).join(', ')}). No violation is attributed to these entries. Show the complete original trace to inspect each one.`, observedIsViolation: false };
  const creditViolation = violationsHere.find(isCreditAdmissionViolation);
  if (creditViolation) {
    const e = creditViolation.evidence;
    const limit = num(e.limit); const total = num(e.totalRequired);
    return {
      expected: `Rejecting this order would satisfy the rule: recorded limit ${fmtCredit(limit)}, required total exposure ${fmtCredit(total)}.`,
      expectedLabel: 'Expected (hypothetical, based on the rule): would satisfy the rule',
      observed: `Error: rule violation recorded at this action: ${creditViolation.message}`,
      observedIsViolation: true,
    };
  }
  const inventoryExplanation = explainInventoryViolations(violationsHere);
  if (inventoryExplanation) return inventoryExplanation;
  if (violationsHere.length > 0) {
    return {
      expected: null, expectedLabel: null,
      observed: `Error: rule violation recorded at this action: ${violationsHere.map(v => v.message).join('; ')}`,
      observedIsViolation: true,
    };
  }
  if (step.kind === 'rejected') {
    return {
      expected: null, expectedLabel: null,
      observed: `Observed (recorded): ${step.outcome}. No violation is attributed to this entry; a rejection alone is not a recorded pass and not a target defect.`,
      observedIsViolation: false,
    };
  }
  return {
    expected: null, expectedLabel: null,
    observed: `Observed (recorded): ${step.outcome}. No violation is attributed to this entry.`,
    observedIsViolation: false,
  };
}

/** Resolve a finding to its experiment array position, matching the recorded experiment index first.
 * Shared with the server replay gates (see src/experiment-identity.ts): an
 * exact unique explicit match, or the guarded one-based legacy position only
 * when every experiment index is absent. Anything else is -1. */
export function resolveExperimentPosition(record: InvestigationRecord, finding: Finding): number {
  return resolveExperimentPositionForIndex(record?.experiments, finding?.experimentIndex);
}

/**
 * Condense only an unambiguous quote/credit -> order -> fill -> over-admission
 * sequence. If anything else was processed, retain the complete recorded trace.
 */
function creditAdmissionStory(trace: TraceEntry[], steps: PlaybackStep[], valid: boolean, finding: Finding | null): PlaybackStep[] | null {
  if (!valid || (finding && !isCreditAdmissionViolation(finding.violation))) return null;
  const processed = steps.filter(step => step.kind === 'processed' || step.kind === 'rejected');
  if (processed.length !== 5 || processed.some(step => step.kind !== 'processed') || processed.slice(0, 4).some(step => step.isViolation)) return null;
  const entries = processed.map(step => trace[step.tracePosition]!);
  const payloads = entries.map(payloadRecord);
  const types = payloads.map(p => p?.type);
  if (!types.slice(0, 2).includes('quote') || !types.slice(0, 2).includes('credit_limit') ||
      types[2] !== 'new_order' || types[3] !== 'execution' || types[4] !== 'new_order') return null;
  const firstOrder = payloads[2]?.orderId;
  const secondOrder = payloads[4]?.orderId;
  if (typeof firstOrder !== 'string' || typeof secondOrder !== 'string' || firstOrder === secondOrder || payloads[3]?.orderId !== firstOrder) return null;
  const failure = processed[4]!;
  const creditViolation = failure.violations.find(isCreditAdmissionViolation);
  if (!creditViolation || creditViolation.orderId !== secondOrder || (finding && creditViolation.id !== finding.violation.id)) return null;
  // Quote and credit may arrive in either order: the credit-limit event is
  // the entry whose payload is credit_limit, never merely processed[1].
  const creditPosition = types.slice(0, 2).indexOf('credit_limit');
  const setup = processed[creditPosition]!;
  const admitted = processed[2]!;
  const filled = processed[3]!;
  const limit = num(creditViolation.evidence?.limit);
  if (limit === null || setup.credit?.limit !== limit || admitted.credit?.reserved === null || admitted.credit?.reserved === undefined ||
      filled.credit?.used === null || filled.credit?.used === undefined || failure.credit?.total === null || failure.credit?.total === undefined) return null;
  const titles = [
    `Credit limit set: ${fmtCredit(limit)}`,
    `Order ${firstOrder} accepted: reserved ${fmtCredit(admitted.credit.reserved)}`,
    `Fill processed for ${firstOrder}: used ${fmtCredit(filled.credit.used)}`,
    `Order ${secondOrder} accepted: total exposure ${fmtCredit(failure.credit.total)}`,
  ];
  return [setup, admitted, filled, failure].map((step, position) => ({ ...step, position, title: titles[position]! }));
}

const KNOWN_FACT_FIELDS = new Set(['type', 'orderId', 'quantity', 'price', 'executionId', 'limit', 'quoteId', 'sku', 'reservationId', 'id']);

export function stepFacts(entry: TraceEntry): string[] {
  const facts: string[] = [];
  const p = payloadRecord(entry);
  if (p) {
    if (typeof p.type === 'string') facts.push(`Type: ${p.type}`);
    if (typeof p.orderId === 'string') facts.push(`Order: ${p.orderId}`);
    if (typeof p.sku === 'string') facts.push(`SKU: ${p.sku}`);
    if (typeof p.reservationId === 'string') facts.push(`Reservation: ${p.reservationId}`);
    if (typeof p.id === 'string') facts.push(`Event: ${p.id}`);
    if (num(p.quantity) !== null) facts.push(`Quantity: ${num(p.quantity)}`);
    if (num(p.price) !== null) facts.push(`Price: ${num(p.price)}`);
    if (typeof p.executionId === 'string') facts.push(`Execution: ${p.executionId}`);
    if (num(p.limit) !== null) facts.push(`Credit limit (payload): ${num(p.limit)}`);
    if (typeof p.quoteId === 'string') facts.push(`Quote: ${p.quoteId}`);
    // Neutral fallback for unfamiliar payload shapes: list recorded
    // primitive fields the known adapters do not name. Never invent values.
    const extra = Object.entries(p)
      .filter(([k, v]) => !KNOWN_FACT_FIELDS.has(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'));
    for (const [k, v] of extra.slice(0, 8)) facts.push(`${k}: ${String(v)}`);
    if (extra.length > 8) facts.push(`…and ${extra.length - 8} more recorded payload fields (see Payload)`);
  }
  if (entry.messageId) facts.push(`Message: ${entry.messageId}`);
  const credit = creditFromState(entry.state);
  if (credit && (credit.limit !== null || credit.used !== null || credit.reserved !== null)) {
    facts.push(`Recorded credit: limit ${fmtCredit(credit.limit)}, used ${fmtCredit(credit.used)}, reserved ${fmtCredit(credit.reserved)}, total ${fmtCredit(credit.total)}`);
  }
  const inventory = extractInventorySnapshotDisplay(entry.state);
  for (const stock of inventory.stock) {
    facts.push(`Recorded stock for SKU ${stock.sku}: received ${stock.received}, on hand ${stock.onHand}, reserved (remaining) ${stock.reservedRemaining}, available ${stock.available}${stock.overReserved ? ' (over-reserved)' : ''}`);
  }
  for (const reservation of inventory.reservations) {
    facts.push(`Recorded reservation ${reservation.reservationId}: SKU ${reservation.sku}, quantity ${reservation.quantity}, remaining ${reservation.remaining}, shipped ${reservation.shipped}, cancelled ${reservation.cancelled}`);
  }
  if (isRecord(entry.state) && isRecord(entry.state.target) && isRecord(entry.state.target.orders)) {
    facts.push(`Orders in recorded state: ${Object.keys(entry.state.target.orders).length}`);
  } else if (isRecord(entry.state) && isRecord((entry.state as Record<string, unknown>).orders)) {
    facts.push(`Orders in recorded state: ${Object.keys((entry.state as Record<string, unknown>).orders as Record<string, unknown>).length}`);
  }
  return facts;
}

/** Build steps for any trace/violation set; used for original and fresh rerun traces. */
export function buildTraceSteps(trace: TraceEntry[], violations: Violation[]): { steps: PlaybackStep[]; unattributedViolations: Violation[] } {
  const attributed = new Set<Violation>();
  const byPos = new Map<number, Violation[]>();
  for (const violation of violations ?? []) {
    const matches: number[] = [];
    trace.forEach((entry, position) => { if (violationMatchesEntry(violation, entry)) matches.push(position); });
    if (matches.length !== 1) continue;
    const position = matches[0]!;
    byPos.set(position, [...(byPos.get(position) ?? []), violation]);
    attributed.add(violation);
  }
  const steps: PlaybackStep[] = trace.map((entry, position) => {
    const kind = classifyStep(entry);
    const credit = creditFromState(entry.state);
    const here = byPos.get(position) ?? [];
    const p = payloadRecord(entry);
    return {
      position, tracePosition: position, actionIndex: entry.step, time: entry.time, action: entry.action,
      kind, kindLabel: KIND_LABEL[kind], outcome: entry.outcome ?? '',
      payloadText: entry.payload !== undefined ? safeText(entry.payload) : (entry.messageId ?? 'not recorded'),
      messageId: entry.messageId ?? null, title: stepTitle(entry, credit), detail: stepDetail(kind), credit,
      stateText: entry.state !== undefined && entry.state !== null ? safeText(entry.state) : 'not recorded',
      violations: here, isViolation: here.length > 0, facts: stepFacts(entry),
      payloadType: typeof p?.type === 'string' ? p.type : null,
    };
  });
  return { steps, unattributedViolations: (violations ?? []).filter(v => !attributed.has(v)) };
}

/** Group only consecutive scheduled/other entries with no violation; processed/rejected/violation entries stay individual. */
export function groupUnimportantSteps(steps: PlaybackStep[]): PlaybackStep[] | null {
  const out: PlaybackStep[] = [];
  let i = 0; let grouped = false;
  while (i < steps.length) {
    const s = steps[i]!;
    const unimportant = (s.kind === 'scheduled' || s.kind === 'other') && !s.isViolation;
    if (!unimportant) { out.push(s); i++; continue; }
    let j = i;
    while (j < steps.length && (steps[j]!.kind === 'scheduled' || steps[j]!.kind === 'other') && !steps[j]!.isViolation) j++;
    const run = steps.slice(i, j);
    if (run.length >= 3) {
      grouped = true;
      const first = run[0]!; const last = run[run.length - 1]!;
      // A group is a summary only: never present the first member's action,
      // payload, credit or state as a recorded state for the whole group.
      out.push({ ...first, isGroup: true, groupCount: run.length, groupTracePositions: run.map(r => r.tracePosition),
        action: 'grouped entries', outcome: `${run.length} grouped recorded entries`, messageId: null,
        payloadType: null, payloadText: 'Grouped summary: no single payload is recorded for the group as a whole. Show the complete original trace to inspect each entry.',
        stateText: 'not recorded for the group as a whole; show the complete original trace to inspect each entry',
        credit: null, violations: [], isViolation: false,
        kindLabel: 'Grouped summary: not a single recorded entry',
        title: `${run.length} grouped recorded entries (trace entries ${first.tracePosition + 1}–${last.tracePosition + 1})`,
        detail: 'Consecutive scheduled or other recorded entries with no attributed violation are grouped here. This row summarises them; it is not a recorded state for the group. Show the complete original trace to inspect each entry.',
        facts: [`Grouped entries: ${run.length}`, `Trace entries ${first.tracePosition + 1}–${last.tracePosition + 1}`, 'No violation attributed to these entries'] });
    } else out.push(...run);
    i = j;
  }
  if (!grouped) return null;
  return out.map((s, position) => ({ ...s, position }));
}

export function pinnedRuleText(record: InvestigationRecord, invariant: string | null): { ruleText: string | null; ruleLabel: string } {
  if (!invariant) return { ruleText: null, ruleLabel: 'Pinned rule: unavailable. No invariant was recorded for this selection.' };
  const contract = record.systemBrief?.contract;
  if (!contract) return { ruleText: null, ruleLabel: 'Pinned rule: unavailable. No pinned contract was recorded for this run (legacy/missing data).' };
  const inv = contract.invariants?.find(x => x.id === invariant);
  if (!inv) return { ruleText: null, ruleLabel: `Pinned rule: unavailable. Invariant "${invariant}" is not in the pinned contract for this run.` };
  return { ruleText: inv.description, ruleLabel: `Pinned rule (${invariant}) from the run's saved contract` };
}

export interface ExperimentReplayLike {
  sourceIdentical: boolean; reproduced: boolean; exactReproductionClaimed: boolean;
  scope?: string; experimentPosition?: number; experimentsTotal?: number;
  contextStatus?: 'verified' | 'drifted' | 'unknown' | 'legacy-unknown';
  outcomes?: {
    behaviorMatched?: boolean;
    traceMatched?: boolean; snapshotMatched?: boolean; violationsMatched?: boolean;
    rejectionsMatched?: boolean; validityMatched?: boolean;
    replayedResult: { trace?: TraceEntry[]; violations?: Violation[] };
  }[];
}

export type FreshKind = 'idle' | 'pending' | 'success' | 'mismatch' | 'source-changed' | 'source-changed-mismatch' | 'context-unverified' | 'error';

export type FreshClassification = 'success' | 'mismatch' | 'source-changed' | 'source-changed-mismatch' | 'context-unverified';

/** Recorded behaviour comparison for the scoped outcome, regardless of
 * source or context gates. 'unknown' when the report carries no usable
 * comparison evidence at all. */
export function scopedBehaviourStatus(report: ExperimentReplayLike): 'matched' | 'mismatched' | 'unknown' {
  const o = report.outcomes?.[0];
  if (!o) return 'unknown';
  if (typeof o.behaviorMatched === 'boolean') return o.behaviorMatched ? 'matched' : 'mismatched';
  const checks = [o.traceMatched, o.snapshotMatched, o.violationsMatched, o.rejectionsMatched, o.validityMatched];
  if (checks.some(v => v === false)) return 'mismatched';
  return checks.every(v => v === true) ? 'matched' : 'unknown';
}

export function classifyFreshReplay(report: ExperimentReplayLike): FreshClassification {
  const behaviour = scopedBehaviourStatus(report);
  const contextBlocksExact = report.contextStatus === 'drifted' || report.contextStatus === 'unknown';
  // An exact claim needs identical source and no known behaviour mismatch or
  // drifted/unknown context gate. Older reports may carry the aggregate exact
  // claim without individual comparison flags. ('legacy-unknown' keeps the
  // historical source+execution exactness definition for snapshotless records.)
  if (report.sourceIdentical && report.reproduced && report.exactReproductionClaimed && behaviour !== 'mismatched' && !contextBlocksExact) return 'success';
  if (!report.sourceIdentical) {
    // Source drift never hides a recorded behaviour mismatch.
    return behaviour === 'mismatched' ? 'source-changed-mismatch' : 'source-changed';
  }
  // Same source and same behaviour, but saved context could not be proved:
  // distinguishable from a semantic mismatch and from verified success.
  if (behaviour === 'matched') return 'context-unverified';
  return 'mismatch';
}
export interface RerunTrace { steps: PlaybackStep[]; unattributedViolations: Violation[] }

/** Build playback steps + attribution for the single rerun outcome, from its own trace/violations. */
export function buildRerunTrace(report: ExperimentReplayLike): RerunTrace {
  const result = report.outcomes?.[0]?.replayedResult;
  if (!result) return { steps: [], unattributedViolations: [] };
  return buildTraceSteps(result.trace ?? [], result.violations ?? []);
}

/** Build playback steps for the single rerun outcome, labelled as rerun by the caller. */
export function buildRerunSteps(report: ExperimentReplayLike): PlaybackStep[] {
  return buildRerunTrace(report).steps;
}

export function buildReproductionModel(
  record: InvestigationRecord,
  experimentPosition: number,
  finding: Finding | null,
): ReproductionModel | null {
  const expRec: ExperimentRecord | undefined = record.experiments[experimentPosition];
  if (!expRec) return null;
  const result = expRec.result;
  const violations = result.violations ?? [];
  const trace = result.trace ?? [];
  const attributed = new Set<Violation>();
  const violationsByPosition = new Map<number, Violation[]>();
  for (const violation of violations) {
    const matches: number[] = [];
    trace.forEach((entry, position) => {
      if (violationMatchesEntry(violation, entry)) matches.push(position);
    });
    if (matches.length !== 1) continue;
    const position = matches[0]!;
    violationsByPosition.set(position, [...(violationsByPosition.get(position) ?? []), violation]);
    attributed.add(violation);
  }
  const steps: PlaybackStep[] = trace.map((entry, position) => {
    const kind = classifyStep(entry);
    const credit = creditFromState(entry.state);
    const here = violationsByPosition.get(position) ?? [];
    return {
      position,
      tracePosition: position,
      actionIndex: entry.step,
      time: entry.time,
      action: entry.action,
      kind,
      kindLabel: KIND_LABEL[kind],
      outcome: entry.outcome ?? '',
      payloadText: entry.payload !== undefined ? safeText(entry.payload) : (entry.messageId ?? 'not recorded'),
      messageId: entry.messageId ?? null,
      title: stepTitle(entry, credit),
      detail: stepDetail(kind),
      credit,
      stateText: entry.state !== undefined && entry.state !== null ? safeText(entry.state) : 'not recorded',
      violations: here,
      isViolation: here.length > 0,
      facts: stepFacts(entry),
      payloadType: typeof payloadRecord(entry)?.type === 'string' ? (payloadRecord(entry)!.type as string) : null,
    };
  });
  const unattributedViolations = violations.filter(v => !attributed.has(v));
  const story = unattributedViolations.length ? null : creditAdmissionStory(trace, steps, result.valid, finding);
  const grouped = story ? null : groupUnimportantSteps(steps);
  const playbackSteps = story ?? grouped ?? steps;
  const reproduced = finding ? finding.reproduced : expRec.replayVerified;
  const cleanPassed = finding ? finding.cleanControlPassed : expRec.cleanControlPassed;
  const primaryViolation = finding?.violation ?? violations[0] ?? null;
  const invariant = primaryViolation?.invariant ?? expRec.experiment.expectedInvariant ?? null;
  const rule = pinnedRuleText(record, invariant);
  const creditRelevant = violations.some(isCreditAdmissionViolation)
    || (invariant !== null && invariant.includes('credit') && steps.some(s => s.credit !== null))
    || steps.some(s => s.payloadType === 'credit_limit' && violations.some(v => v.invariant.includes('credit')));
  const evidence: EvidenceSummary = {
    invariant, observedCategory: findingCategoryLabel(finding ?? (primaryViolation ? { violation: primaryViolation } : {})),
    violationMessage: primaryViolation?.message ?? null,
    violations, ruleText: rule.ruleText, ruleLabel: rule.ruleLabel,
    expectedInvariant: expRec.experiment.expectedInvariant ?? null,
    hypothesis: expRec.experiment.hypothesis || 'not recorded',
    sourceHash: finding?.sourceHash ?? result.sourceHash ?? record.sourceHash ?? null,
    experimentPosition, experimentIndex: (expRec as { index?: number }).index ?? null,
    runId: record.id, creditRelevant,
  };
  return {
    runId: record.id,
    evidence, allSteps: steps, traceCount: trace.length,
    modelLabel: record.model ? `Model: ${record.model}` : 'Model: not recorded',
    targetLabel: `Synthetic target: ${record.variant} (synthetic simulator, not an arbitrary application)`,
    systemLabel: record.systemBrief ? `System: ${record.systemBrief.brief.name}` : 'System: legacy / unavailable',
    briefLabel: record.systemBrief
      ? `Saved brief: revision ${record.systemBrief.brief.revision}`
      : 'Legacy brief unavailable: no system brief snapshot was recorded for this run',
    experimentLabel: (expRec as { index?: number }).index === undefined
      ? `Experiment (recorded index not recorded; position ${experimentPosition + 1} of ${record.experiments.length})`
      : `Experiment #${expRec.index} (position ${experimentPosition + 1} of ${record.experiments.length})`,
    hypothesis: expRec.experiment.hypothesis || 'not recorded',
    valid: result.valid,
    invalidLabel: result.valid ? null : 'Invalid or rejected experiment plan: this is not, by itself, a target defect.',
    replayLabel: reproduced
      ? 'Original replay: verified during the investigation'
      : 'Original replay: not verified during the investigation',
    cleanLabel: cleanPassed
      ? finding
        ? 'Clean comparison: passed for the recorded finding/check, not a claim of complete correctness'
        : 'Clean comparison: passed for at least one recorded violation, not a claim of complete correctness'
      : 'Clean comparison: not confirmed for this selection',
    findingTitle: finding ? finding.title : null,
    steps: playbackSteps,
    unattributedViolations,
    sequence: story ? 'key-events' : grouped ? 'grouped' : 'trace',
    hasTrace: trace.length > 0,
  };
}

/** Text form of recorded evidence. Callers must insert it with textContent, never HTML. */
export function safeText(value: unknown): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text ?? 'not recorded';
  } catch {
    return 'not recorded (unserialisable evidence)';
  }
}

export type FreshReplayState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'success' }
  | { kind: 'mismatch' }
  | { kind: 'source-changed' }
  | { kind: 'source-changed-mismatch' }
  | { kind: 'context-unverified' }
  | { kind: 'error'; message: string };

export function describeFreshReplay(state: FreshReplayState): string {
  switch (state.kind) {
    case 'idle': return 'No rerun has been started from this player. The historical result above is not a new replay.';
    case 'pending': return 'Rerunning this experiment through the deterministic replay path… This does not contact the model and does not rerun the clean comparison.';
    case 'success': return 'Fresh rerun finished: matched. This selected experiment reproduced exactly. Historical results have not been overwritten.';
    case 'mismatch': return 'Fresh rerun finished with a mismatch: this selected experiment did not reproduce exactly. Historical results have not been overwritten.';
    case 'source-changed': return 'Fresh rerun finished: source changed. The current source differs from the saved source, so exact reproduction cannot be claimed for this selected experiment. Historical results have not been overwritten.';
    case 'source-changed-mismatch': return 'Fresh rerun finished with a mismatch and source changed: this selected experiment did not reproduce exactly, and the current source differs from the saved source, so exact reproduction cannot be claimed for this selected experiment. Historical results have not been overwritten.';
    case 'context-unverified': return 'Fresh rerun finished: behaviour matched, but replay context is unverified. Saved prompt, contract or clean-control context differs from or cannot be proved against the current context, so exact reproduction cannot be claimed for this selected experiment. Historical results have not been overwritten.';
    case 'error': return `Fresh rerun failed: ${state.message} Historical results have not been overwritten.`;
  }
}

export interface PlaybackTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const defaultTimers: PlaybackTimers = {
  set: (fn, ms) => setInterval(fn, ms),
  clear: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/** Recorded-trace cursor. Position -1 means before the first recorded entry: no state is shown. */
export class PlaybackController {
  position = -1;
  playing = false;
  private timer: unknown = null;
  constructor(
    private count: number,
    private onChange: () => void = () => {},
    private timers: PlaybackTimers = defaultTimers,
    private intervalMs = 1400,
  ) {}
  get stepCount(): number { return this.count; }
  get atEnd(): boolean { return this.count === 0 || this.position >= this.count - 1; }
  setCount(count: number): void {
    this.pause();
    this.count = Math.max(0, count);
    this.position = -1;
    this.onChange();
  }
  /** Refresh the step list (e.g. labels changed on polling) without losing a still-valid cursor. */
  refreshCount(count: number): void {
    this.pause();
    this.count = Math.max(0, count);
    this.position = this.count === 0 ? -1 : Math.min(Math.max(this.position, -1), this.count - 1);
    this.onChange();
  }
  select(position: number): void {
    this.pause();
    this.position = this.count === 0 ? -1 : Math.min(Math.max(position, -1), this.count - 1);
    this.onChange();
  }
  next(): void {
    if (this.count === 0) return;
    this.position = Math.min(this.position + 1, this.count - 1);
    if (this.atEnd) this.pause();
    this.onChange();
  }
  previous(): void {
    this.pause();
    if (this.count === 0) return;
    this.position = Math.max(this.position - 1, -1);
    this.onChange();
  }
  reset(): void {
    this.pause();
    this.position = -1;
    this.onChange();
  }
  play(): void {
    if (this.count === 0 || this.playing) return;
    if (this.atEnd) this.position = -1;
    this.playing = true;
    this.timer = this.timers.set(() => {
      this.next();
      if (this.atEnd) this.pause();
    }, this.intervalMs);
    this.onChange();
  }
  pause(): void {
    this.playing = false;
    if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; }
  }
  /** Pause without notifying; used when the owning selection/view goes away. */
  stop(): void { this.pause(); }
  dispose(): void { this.pause(); }
}
