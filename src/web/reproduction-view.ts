/** Pure view decisions for the reproduction player: which trace's evidence is
 * shown, when the timeline must be rebuilt, and what a no-step detail shows.
 * Kept DOM-free so app.ts wiring is covered by production-logic tests. */
import type { Violation } from '../domain.ts';
import type { PlaybackStep } from './reproduction-player.ts';

/** Compare recorded behaviour independently of the source fingerprint. */
export function replayBehaviourStatus(outcome: {
  traceMatched?: boolean;
  snapshotMatched?: boolean;
  violationsMatched?: boolean;
  rejectionsMatched?: boolean;
  validityMatched?: boolean;
} | undefined): 'matched' | 'different' | 'unavailable' {
  if (!outcome) return 'unavailable';
  const checks = [outcome.traceMatched, outcome.snapshotMatched, outcome.violationsMatched, outcome.rejectionsMatched, outcome.validityMatched];
  if (checks.every(check => check === true)) return 'matched';
  return checks.some(check => check === false) ? 'different' : 'unavailable';
}

/** Content revision of the visible steps. Changes when any button text or
 * accessible label would change, even if the visible count is unchanged
 * (e.g. a group growing from 3 to 4 members at the same step count). */
export function stepsRevision(steps: PlaybackStep[]): string {
  return steps.map(s => [
    s.position, s.tracePosition, s.title, s.kind, s.outcome, s.action,
    s.isViolation ? 'violation' : '',
    s.isGroup ? `group:${s.groupCount ?? 0}:${(s.groupTracePositions ?? []).join(',')}` : '',
    s.violations.map(v => v.id).join(','),
  ].join(':')).join('|');
}

export interface TimelineKeyParts {
  runId: string;
  experimentIndex: number;
  findingId: string;
  sequence: string;
  showFull: boolean;
  useRerun: boolean;
  freshKind: string;
  steps: PlaybackStep[];
}

export function timelineRenderKey(parts: TimelineKeyParts): string {
  return [
    parts.runId, parts.experimentIndex, parts.findingId, parts.sequence,
    parts.steps.length, parts.showFull ? 'full' : 'concise',
    parts.useRerun ? 'rerun' : 'original', parts.freshKind,
    stepsRevision(parts.steps),
  ].join('|');
}

/** The unattributed violations of the trace actually on screen. A fresh rerun
 * shows its own; the original warning never appears as if from a fresh trace. */
export function activeUnattributedViolations(
  useRerun: boolean,
  original: Violation[],
  fresh: Violation[],
): Violation[] {
  return useRerun ? fresh : original;
}

export function unattributedText(violations: Violation[], useRerun: boolean): string {
  if (!violations.length) return '';
  const scope = useRerun ? 'fresh rerun' : 'original recording';
  return `Some recorded violations in the ${scope} could not be pinned to one processed trace entry. ${violations.map(v => `Action #${v.step} (${v.invariant}): ${v.message}`).join(' · ')}`;
}

/** Original finding/evidence summary is historical whenever the fresh trace is on screen. */
export function evidenceHeading(useRerun: boolean): string {
  return useRerun
    ? 'Original finding summary (historical — from the original recording, not the fresh rerun)'
    : 'Original finding summary (historical)';
}

export interface DetailVisibility { factsVisible: boolean; creditVisible: boolean }

/** No selected step (before playback, after Reset, empty trace): no facts or
 * credit figures from a previous entry may remain visible. */
export function detailVisibility(hasStep: boolean, creditRelevant: boolean): DetailVisibility {
  return { factsVisible: hasStep, creditVisible: hasStep && creditRelevant };
}

export const NO_STEP_CREDIT_TEXT = 'not recorded — no step selected';
