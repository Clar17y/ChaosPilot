/** Pure presentation helpers for run-detail tabs and experiment selection. */

/** Distinguish matching experiments from a fully verified replay context. */
export function replayOutcome(report: {
  experimentsTotal: number;
  experimentsReproduced: number;
  exactReproductionClaimed: boolean;
}): 'reproduced' | 'unconfirmed' | 'mismatch' | 'empty' {
  if (report.experimentsTotal === 0) return 'empty';
  if (report.experimentsReproduced !== report.experimentsTotal) return 'mismatch';
  return report.exactReproductionClaimed ? 'reproduced' : 'unconfirmed';
}

/** Index to activate for a tablist key, or null when the key is not a tab-navigation key. Wraps at both ends. */
export function tabIndexForKey(currentIndex: number, key: string, tabCount: number): number | null {
  if (tabCount <= 0) return null;
  const current = Math.min(Math.max(currentIndex, 0), tabCount - 1);
  switch (key) {
    case 'ArrowRight': return (current + 1) % tabCount;
    case 'ArrowLeft': return (current - 1 + tabCount) % tabCount;
    case 'Home': return 0;
    case 'End': return tabCount - 1;
    default: return null;
  }
}

const CATEGORY_LABELS: Record<string, string> = {
  cancellation_release: 'Cancellation release',
  duplicate_shipment: 'Duplicate shipment',
  duplicate_event: 'Duplicate event',
  shipment_quantity: 'Shipment quantity',
  reservation_availability: 'Reservation availability',
  stock_receipt: 'Stock receipt',
  inventory_transition: 'Inventory transition',
};

/**
 * Human-readable label for the observed oracle category on a finding.
 * Known categories get a readable name plus the raw value; unknown values are
 * returned verbatim (callers render as text, never HTML). Legacy findings
 * without category metadata get an explicit fallback.
 */
export function findingCategoryLabel(finding: { category?: unknown; violation?: { category?: unknown } | null }): string {
  const raw = typeof finding.category === 'string' && finding.category.trim() ? finding.category
    : typeof finding.violation?.category === 'string' && finding.violation.category.trim() ? finding.violation.category
    : null;
  if (!raw) return 'Not recorded (legacy finding without category metadata)';
  const known = CATEGORY_LABELS[raw];
  return known ? `${known} (${raw})` : raw;
}

/** Persisted continuation setting for saved run details. Absent means off (legacy default). */
export function continuationSettingLabel(continueAfterFindings: unknown): string {
  return continueAfterFindings === true
    ? 'Continue after findings: on (bounded continuation after verified findings)'
    : 'Continue after findings: off (stop after the first verified finding)';
}

/** Readable label for a target variant choice. Unknown values are returned verbatim as text. */
export function targetVariantLabel(variant: string): string {
  if (variant === 'clean') return 'Clean control';
  const inventory = /^inventory-candidate-([a-z])$/.exec(variant);
  if (inventory) return `Inventory Candidate ${inventory[1]!.toUpperCase()}`;
  const candidate = /^candidate-([a-z])$/.exec(variant);
  if (candidate) return `Candidate ${candidate[1]!.toUpperCase()}`;
  return variant;
}

/** Keeps a selection valid after a record refresh adds/removes experiments. */
export function clampSelectedIndex(selected: number, count: number): number {
  if (count <= 0) return 0;
  if (!Number.isFinite(selected) || selected < 0) return 0;
  return Math.min(Math.floor(selected), count - 1);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** Renders a supplied fields/parameters value (string or name→description map) as plain text. */
function describeFields(value: unknown): string | null {
  const asString = nonEmptyString(value);
  if (asString) return asString;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const parts: string[] = [];
    for (const [name, description] of Object.entries(value as Record<string, unknown>)) {
      const text = nonEmptyString(description);
      parts.push(text ? `${name}: ${text}` : name);
    }
    return parts.length > 0 ? parts.join('; ') : null;
  }
  return null;
}

/**
 * One readable line for a contract operation/message entry, using only the
 * information that entry supplies. A description is preferred (the existing
 * trading display); entries that supply `fields` instead of a description
 * show those fields, and a semantics-only entry is labelled Semantics.
 * Never emits a blank trailing colon or a meaningless '/:' row. Callers must
 * render the returned string as text, not HTML.
 */
export function formatContractEntry(item: Record<string, unknown>): string {
  if (!item || typeof item !== 'object') return '';
  const op = nonEmptyString(item.op);
  const channel = nonEmptyString(item.channel);
  const type = nonEmptyString(item.type);
  const semantics = nonEmptyString(item.semantics);
  let head: string;
  if (op) {
    head = op;
  } else if (channel || type) {
    // Identical channel/type (e.g. stock/stock) is shown once.
    head = channel && type && channel !== type ? `${channel}/${type}` : (channel ?? type ?? '');
  } else if (semantics) {
    head = 'Semantics';
  } else {
    head = 'Contract entry';
  }
  const description = nonEmptyString(item.description);
  if (description) return `${head}: ${description}`;
  const fields = describeFields(item.fields);
  if (fields) return `${head}: Fields: ${fields}`;
  if (semantics && head !== 'Semantics') return `${head}: ${semantics}`;
  if (semantics) return `${head}: ${semantics}`;
  const parameters = describeFields(item.parameters);
  if (parameters) return `${head}: Parameters: ${parameters}`;
  const identity = nonEmptyString(item.identity);
  if (identity) return `${head}: ${identity}`;
  return head;
}
