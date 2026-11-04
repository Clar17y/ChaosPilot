/**
 * Shared accessible presentation for functional baseline, regression, and API journey assertion tables.
 * Preserves complete raw evidence, top-aligned cells, keyboard-accessible scroll regions,
 * and compact disclosures for unusually long values.
 */

export function escapeHtml(value: unknown): string {
  const str = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function outcomeBadgeClass(status: string): string {
  switch (status.toLowerCase()) {
    case 'pass':
    case 'match':
      return 'badge-pass';
    case 'fail':
    case 'different':
      return 'badge-fail';
    case 'blocked':
    case 'cancelled':
      return 'badge-blocked';
    default:
      return 'badge-inconclusive';
  }
}

export function renderEvidenceValue(value: unknown, maxLength = 80): string {
  const rawStr = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2);
  const isLong = rawStr.length > maxLength || rawStr.includes('\n');
  const escaped = escapeHtml(rawStr);

  if (!isLong) {
    return `<code>${escaped}</code>`;
  }

  // Compact disclosure preserves full raw value without clipping or blowing up row height
  const preview = escapeHtml(rawStr.slice(0, 50).replace(/\s+/g, ' '));
  return `<details class="evidence-disclosure">
    <summary title="Click to expand/collapse full evidence">
      <span class="evidence-preview">${preview}…</span>
      <span class="evidence-len">(${rawStr.length} chars)</span>
    </summary>
    <pre class="evidence-raw-pre">${escaped}</pre>
  </details>`;
}

export interface AssertionRow {
  status: string;
  name: string;
  expected: unknown;
  actual?: unknown;
  observed?: unknown;
  detail?: unknown;
}

export interface AssertionTableOptions {
  label?: string;
  observedColumnName?: 'Actual' | 'Observed';
  includeDetail?: boolean;
}

export function renderAssertionTable(
  assertions: AssertionRow[],
  options: AssertionTableOptions = {},
): string {
  const label = options.label ?? 'Assertion evidence results';
  const observedCol = options.observedColumnName ?? 'Actual';
  const includeDetail = options.includeDetail ?? true;

  const rows = assertions.map(a => {
    const statusClass = outcomeBadgeClass(a.status);
    const badge = `<span class="system-badge ${statusClass}">${escapeHtml(a.status.toUpperCase())}</span>`;
    const name = `<code>${escapeHtml(a.name)}</code>`;
    const expected = renderEvidenceValue(a.expected);
    const observedValue = a.observed !== undefined ? a.observed : a.actual;
    const observed = renderEvidenceValue(observedValue);
    const detailCell = includeDetail ? `<td>${renderEvidenceValue(a.detail ?? '')}</td>` : '';

    return `<tr>
      <td>${badge}</td>
      <td>${name}</td>
      <td>${expected}</td>
      <td>${observed}</td>
      ${detailCell}
    </tr>`;
  }).join('');

  return `<div class="table-scroll-region" tabindex="0" role="region" aria-label="${escapeHtml(label)}">
    <table class="data-table assertion-table">
      <thead>
        <tr>
          <th style="width:76px;">Status</th>
          <th style="width:150px;">Assertion</th>
          <th>Expected</th>
          <th>${observedCol}</th>
          ${includeDetail ? '<th>Detail</th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>`;
}
