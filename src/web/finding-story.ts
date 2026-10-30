import { findingCategoryLabel } from './presentation.ts';

/** Short, evidence-backed comparisons shared by the workspace and HTML report. */
export interface RecordedDifference {
  label: string;
  expected: string;
  observed: string;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const fieldLabels: Record<string, string> = {
  remaining: 'remaining', onHand: 'on hand', received: 'received',
  reserved: 'reserved', shipped: 'shipped', cancelled: 'cancelled', quantity: 'quantity',
};

export function conciseFindingTitle(finding: { title?: unknown; category?: unknown; violation?: { category?: unknown } | null }): string {
  const category = typeof finding.category === 'string' && finding.category !== 'uncategorised (legacy or generic)'
    ? finding.category : finding.violation?.category;
  if (typeof category === 'string' && category.trim()) {
    const label = findingCategoryLabel({ category }).replace(/ \([a-z0-9_]+\)$/, '');
    return `Observed category: ${label}`;
  }
  return typeof finding.title === 'string' && finding.title ? finding.title : 'Untitled finding';
}

function labelFor(path: string[]): string {
  const [group, identity, ...rest] = path;
  if ((group === 'reservations' || group === 'stock') && identity && rest.length === 1) {
    const field = rest[0]!;
    return `${group === 'stock' ? 'Stock' : 'Reservation'} ${identity}: ${fieldLabels[field] ?? field}`;
  }
  return path.join(' / ') || 'Recorded value';
}

function display(value: unknown): string {
  if (value === undefined) return 'not present';
  if (value === null) return 'null';
  const text = String(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/**
 * Compare only values present in the oracle's recorded expected/actual evidence.
 * The full evidence stays available in the report; this is a bounded summary.
 */
export function recordedDifferences(violation: unknown): { rows: RecordedDifference[]; truncated: boolean } {
  if (!object(violation) || !object(violation.evidence)) return { rows: [], truncated: false };
  const evidence = violation.evidence;
  const rows: RecordedDifference[] = [];
  let visited = 0;
  let truncated = false;
  const add = (label: string, expected: unknown, observed: unknown) => {
    if (Object.is(expected, observed)) return;
    if (rows.length >= 12) { truncated = true; return; }
    if ((typeof expected === 'string' && expected.length > 160) || (typeof observed === 'string' && observed.length > 160)) truncated = true;
    rows.push({ label, expected: display(expected), observed: display(observed) });
  };
  if (typeof evidence.expectedOutcome === 'string' && typeof evidence.outcome === 'string') {
    add('Delivery outcome', evidence.expectedOutcome, evidence.outcome);
  }
  const walk = (expected: unknown, observed: unknown, path: string[], depth: number): void => {
    if (++visited > 500 || depth > 8) { truncated = true; return; }
    if (object(expected) && object(observed)) {
      for (const key of new Set([...Object.keys(expected), ...Object.keys(observed)])) {
        if (visited > 500) break;
        walk(expected[key], observed[key], [...path, key], depth + 1);
      }
    } else if (!object(expected) && !object(observed) && !Array.isArray(expected) && !Array.isArray(observed)) {
      add(labelFor(path), expected, observed);
    } else {
      // A structural difference is retained in the full recorded evidence.
      truncated = true;
    }
  };
  if (object(evidence.expected) && object(evidence.actual)) walk(evidence.expected, evidence.actual, [], 0);
  return { rows, truncated };
}
