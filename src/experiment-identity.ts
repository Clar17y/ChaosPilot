/**
 * Shared, safe resolution of a finding's recorded experiment index to an
 * experiment array position. Used by both the browser reproduction player
 * and the server-side replay integrity gates so the two can never disagree
 * about which saved experiment a finding belongs to.
 *
 * Rules:
 * - The finding index must be a nonnegative safe integer. Explicit indices
 *   may start at zero; the one-based legacy fallback requires a positive index.
 * - When any experiment carries an explicit index, only an exact, unique
 *   explicit match resolves. Unmatched, mixed missing/present and
 *   duplicate (ambiguous) indices return -1 and never fall back to position.
 * - Only when ALL experiment indices are absent may the historic one-based
 *   finding position be used: index N means array position N - 1, valid
 *   only for 1 <= N <= experiments.length.
 */

export interface ExperimentIndexLike {
  index?: unknown;
}

export function resolveExperimentPositionForIndex(
  experiments: readonly ExperimentIndexLike[] | null | undefined,
  experimentIndex: unknown,
): number {
  if (!Array.isArray(experiments) || experiments.length === 0) return -1;
  if (typeof experimentIndex !== 'number' || !Number.isSafeInteger(experimentIndex) || experimentIndex < 0) return -1;

  const hasExplicitIndex = experiments.some(e => e !== null && typeof e === 'object' && e.index !== undefined);
  if (hasExplicitIndex) {
    let match = -1;
    for (let position = 0; position < experiments.length; position++) {
      if (experiments[position]?.index === experimentIndex) {
        if (match !== -1) return -1; // duplicate explicit index: ambiguous
        match = position;
      }
    }
    return match;
  }

  // Legacy records with no recorded experiment indices: findings used a
  // one-based position. Zero is not a valid one-based position.
  const legacyPosition = experimentIndex - 1;
  return legacyPosition >= 0 && legacyPosition < experiments.length ? legacyPosition : -1;
}

export interface FindingExperimentLike<F> {
  experiments: readonly ExperimentIndexLike[];
  findings: readonly F[];
}

/**
 * The first finding (in recorded order) whose experiment can be resolved,
 * with its experiment array position. Null when no finding resolves, so
 * callers keep a safe no-finding fallback.
 */
export function firstResolvableFindingPosition<F extends { experimentIndex?: unknown }>(
  record: FindingExperimentLike<F> | null | undefined,
): { finding: F; position: number } | null {
  if (!record || !Array.isArray(record.experiments) || !Array.isArray(record.findings)) return null;
  for (const finding of record.findings) {
    if (!finding || typeof finding !== 'object') continue;
    const position = resolveExperimentPositionForIndex(record.experiments, finding.experimentIndex);
    if (position >= 0) return { finding, position };
  }
  return null;
}
