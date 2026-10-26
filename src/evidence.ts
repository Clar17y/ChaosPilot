import type { ExperimentResult } from './domain.ts';

/**
 * Pure canonical JSON serializer that normalizes object property key order
 * while strictly preserving array order and primitive values.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined) {
      entries.push(JSON.stringify(k) + ':' + canonicalJson(v));
    }
  }
  return '{' + entries.join(',') + '}';
}

export interface SemanticReplayComparison {
  matched: boolean;
  sourceMatched: boolean;
  validityMatched: boolean;
  snapshotMatched: boolean;
  traceMatched: boolean;
  violationsMatched: boolean;
  rejectionsMatched: boolean;
  details?: string;
  mismatches: string[];
}

/**
 * Compares an original ExperimentResult and a replayed ExperimentResult for exact semantic equality.
 * Covers source hash, snapshot, trace, violations, rejections, and validity.
 *
 * Source fingerprint mismatch is NEVER considered an exact reproduction.
 */
export function compareSemanticReplay(
  original: ExperimentResult,
  replayed: ExperimentResult
): SemanticReplayComparison {
  const mismatches: string[] = [];

  // Source fingerprint mismatch never exact reproduction
  const sourceMatched = Boolean(
    original.sourceHash &&
    replayed.sourceHash &&
    original.sourceHash === replayed.sourceHash
  );
  if (!sourceMatched) {
    mismatches.push(
      `Source hash mismatch: original "${original.sourceHash}", replayed "${replayed.sourceHash}"`
    );
  }

  const validityMatched = original.valid === replayed.valid;
  if (!validityMatched) {
    mismatches.push(
      `Validity mismatch: original valid=${original.valid}, replayed valid=${replayed.valid}`
    );
  }

  const violationsMatched =
    canonicalJson(original.violations || []) === canonicalJson(replayed.violations || []);
  if (!violationsMatched) {
    mismatches.push('Violations mismatch between original and replayed execution');
  }

  const rejectionsMatched =
    canonicalJson(original.rejections || []) === canonicalJson(replayed.rejections || []);
  if (!rejectionsMatched) {
    mismatches.push('Rejections mismatch between original and replayed execution');
  }

  const snapshotMatched =
    canonicalJson(original.snapshot || {}) === canonicalJson(replayed.snapshot || {});
  if (!snapshotMatched) {
    mismatches.push('Snapshot state mismatch between original and replayed execution');
  }

  const traceMatched =
    canonicalJson(original.trace || []) === canonicalJson(replayed.trace || []);
  if (!traceMatched) {
    mismatches.push('Trace mismatch between original and replayed execution');
  }

  const matched =
    sourceMatched &&
    validityMatched &&
    violationsMatched &&
    rejectionsMatched &&
    snapshotMatched &&
    traceMatched;

  return {
    matched,
    sourceMatched,
    validityMatched,
    snapshotMatched,
    traceMatched,
    violationsMatched,
    rejectionsMatched,
    details: mismatches.length > 0 ? mismatches.join('; ') : undefined,
    mismatches,
  };
}
