/** Pure derivation and playback logic for the saved-trace reproduction player.
 * Playback reads recorded trace entries only. It never executes the target,
 * contacts a model, or invents state before/between recorded entries. */
import type { ExperimentRecord, Finding, InvestigationRecord, TraceEntry, Violation } from '../domain.ts';

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

export interface ReproductionModel {
  runId: string;
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
  /** A compact, evidence-backed credit-admission story, or the complete trace. */
  sequence: 'key-events' | 'trace';
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

export function isProcessedTransition(entry: TraceEntry): boolean {
  const outcome = entry.outcome ?? '';
  return outcome.startsWith('delivered:') || outcome === 'drained:empty' || outcome.startsWith('advanced by');
}

export function classifyStep(entry: TraceEntry): StepKind {
  const outcome = entry.outcome ?? '';
  if (outcome.startsWith('rejected:') || outcome.startsWith('delivered:rejected')) return 'rejected';
  if (outcome === 'scheduled' || outcome.endsWith('_scheduled') || outcome.startsWith('duplicated from')) return 'scheduled';
  if (outcome.startsWith('delivered:') || outcome === 'drained:empty' || outcome.startsWith('advanced by')) return 'processed';
  return 'other';
}

const KIND_LABEL: Record<StepKind, string> = {
  scheduled: 'Scheduled — not yet processed (recorded state is unchanged by this event)',
  processed: 'Processed — recorded state after this transition',
  rejected: 'Recorded rejection — not by itself a target defect or a recorded pass',
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
  if (credit && kind === 'processed' && credit.total !== null) return `${entry.action}: total exposure ${credit.total}`;
  return `${entry.action}: ${entry.outcome || 'recorded'}`;
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

export function explainStep(step: PlaybackStep, violationsHere: Violation[]): StepExplanation {
  const creditViolation = violationsHere.find(isCreditAdmissionViolation);
  if (creditViolation) {
    const e = creditViolation.evidence;
    const limit = num(e.limit); const total = num(e.totalRequired);
    return {
      expected: `Rejecting this order would satisfy the rule: recorded limit ${fmtCredit(limit)}, required total exposure ${fmtCredit(total)}.`,
      expectedLabel: 'Expected (hypothetical, based on the rule) — would satisfy the rule',
      observed: `Error: rule violation recorded at this action — ${creditViolation.message}`,
      observedIsViolation: true,
    };
  }
  if (violationsHere.length > 0) {
    return {
      expected: null, expectedLabel: null,
      observed: `Error: rule violation recorded at this action — ${violationsHere.map(v => v.message).join('; ')}`,
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

/** Resolve a finding to its experiment array position, matching the recorded experiment index first. */
export function resolveExperimentPosition(record: InvestigationRecord, finding: Finding): number {
  const byIndex = record.experiments.findIndex(e => e.index === finding.experimentIndex);
  if (byIndex >= 0) return byIndex;
  // Legacy records may lack experiment indices. Findings use one-based indices;
  // never guess when the record has explicit indices that do not match.
  const legacyPosition = finding.experimentIndex - 1;
  if (record.experiments.every(e => e.index === undefined) && legacyPosition >= 0 && legacyPosition < record.experiments.length) return legacyPosition;
  return -1;
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
    };
  });
  const unattributedViolations = violations.filter(v => !attributed.has(v));
  const story = unattributedViolations.length ? null : creditAdmissionStory(trace, steps, result.valid, finding);
  const playbackSteps = story ?? steps;
  const reproduced = finding ? finding.reproduced : expRec.replayVerified;
  const cleanPassed = finding ? finding.cleanControlPassed : expRec.cleanControlPassed;
  return {
    runId: record.id,
    modelLabel: record.model ? `Model: ${record.model}` : 'Model: not recorded',
    targetLabel: `Synthetic target: ${record.variant} (synthetic simulator — not an arbitrary application)`,
    systemLabel: record.systemBrief ? `System: ${record.systemBrief.brief.name}` : 'System: legacy / unavailable',
    briefLabel: record.systemBrief
      ? `Saved brief: revision ${record.systemBrief.brief.revision}`
      : 'Legacy brief unavailable — no system brief snapshot was recorded for this run',
    experimentLabel: (expRec as { index?: number }).index === undefined
      ? `Experiment (recorded index not recorded; position ${experimentPosition + 1} of ${record.experiments.length})`
      : `Experiment #${expRec.index} (position ${experimentPosition + 1} of ${record.experiments.length})`,
    hypothesis: expRec.experiment.hypothesis || 'not recorded',
    valid: result.valid,
    invalidLabel: result.valid ? null : 'Invalid or rejected experiment plan — this is not, by itself, a target defect.',
    replayLabel: reproduced
      ? 'Original replay: verified during the investigation'
      : 'Original replay: not verified during the investigation',
    cleanLabel: cleanPassed
      ? finding
        ? 'Clean comparison: passed for the recorded finding/check — not a claim of complete correctness'
        : 'Clean comparison: passed for at least one recorded violation — not a claim of complete correctness'
      : 'Clean comparison: not confirmed for this selection',
    findingTitle: finding ? finding.title : null,
    steps: playbackSteps,
    unattributedViolations,
    sequence: story ? 'key-events' : 'trace',
    hasTrace: playbackSteps.length > 0,
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
  | { kind: 'error'; message: string };

export function describeFreshReplay(state: FreshReplayState): string {
  switch (state.kind) {
    case 'idle': return 'No rerun has been started from this player. The historical result above is not a new replay.';
    case 'pending': return 'Rerunning the saved investigation through the deterministic replay path… This does not contact the model and does not rerun the clean comparison.';
    case 'success': return 'Fresh replay finished: the saved experiments reproduced exactly. Historical results have not been overwritten.';
    case 'mismatch': return 'Fresh replay finished with a mismatch: the saved experiments did not reproduce exactly. Historical results have not been overwritten.';
    case 'error': return `Fresh replay failed: ${state.message} Historical results have not been overwritten.`;
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
