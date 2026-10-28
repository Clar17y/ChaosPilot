import * as crypto from 'node:crypto';
import type { ExperimentResult, SystemContract } from './domain.ts';

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

/** Canonical (key-order independent) SHA-256 hash of a system contract. */
export function computeContractHash(contract: SystemContract | null | undefined): string {
  return crypto.createHash('sha256').update(canonicalJson(contract ?? null), 'utf8').digest('hex');
}

/** Legacy raw-order SHA-256 hash, retained only to verify historical records. */
export function computeLegacyRawContractHash(contract: SystemContract | null | undefined): string {
  return crypto.createHash('sha256').update(JSON.stringify(contract ?? null), 'utf8').digest('hex');
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

  // Legacy records may lack the oracle category added later; ignore that
  // field only for genuine legacy evidence: no category on any violation
  // AND no categoryAware marker. A category-aware result whose categories
  // were removed or changed is not legacy and must not replay as exact.
  const categoryAwareMismatch = original.categoryAware === true && replayed.categoryAware !== true;
  if (categoryAwareMismatch) {
    mismatches.push('Category-aware evidence mismatch: original result records violation categories but replayed result does not');
  }
  const legacyWithoutCategory = original.categoryAware !== true
    && (original.violations || []).length > 0
    && (original.violations || []).every(v => !('category' in v));
  const normalizeViolations = (vs: typeof original.violations) => legacyWithoutCategory
    ? (vs || []).map(v => { const { category: _category, ...rest } = v as typeof v & { category?: string }; return rest; })
    : (vs || []);
  const violationsMatched = !categoryAwareMismatch
    && canonicalJson(normalizeViolations(original.violations)) === canonicalJson(normalizeViolations(replayed.violations));
  if (!violationsMatched) {
    const stripIds = (vs: typeof original.violations) =>
      (vs || []).map((v) => { const { id: _id, ...rest } = v; return rest; });
    if (canonicalJson(stripIds(original.violations)) === canonicalJson(stripIds(replayed.violations))) {
      mismatches.push('Violations mismatch between original and replayed execution: violation IDs differ while semantic violation content otherwise matches (possible legacy duplicate-ID format)');
    } else {
      mismatches.push('Violations mismatch between original and replayed execution');
    }
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
