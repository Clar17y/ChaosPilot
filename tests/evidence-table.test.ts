import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  outcomeBadgeClass,
  renderAssertionTable,
  renderEvidenceValue,
  type AssertionRow,
} from '../src/web/evidence-table.ts';

describe('evidence-table presentation helper', () => {
  it('escapes HTML and hostile characters in values and summaries', () => {
    const hostile = '<script>alert("xss")</script> & "quotes" \'apostrophe\'';
    const escaped = escapeHtml(hostile);
    expect(escaped).not.toContain('<script>');
    expect(escaped).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(escaped).toContain('&amp;');
    expect(escaped).toContain('&#039;apostrophe&#039;');
  });

  it('renders short values inline within <code> tags', () => {
    const rendered = renderEvidenceValue('short string');
    expect(rendered).toBe('<code>short string</code>');
  });

  it('preserves null, false, zero, and structured evidence without treating them as empty', () => {
    expect(renderEvidenceValue(null)).toBe('<code>null</code>');
    expect(renderEvidenceValue(false)).toBe('<code>false</code>');
    expect(renderEvidenceValue(0)).toBe('<code>0</code>');
    expect(renderEvidenceValue(undefined)).toBe('<code></code>');
    const value = { message: '<script>unsafe</script>', total: 0, missing: null };
    const rendered = renderEvidenceValue(value);
    expect(rendered).toContain(`<pre class="evidence-raw-pre">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`);
    expect(rendered).not.toContain('<script>');
  });

  it('renders unusually long values or multiline text as compact disclosures preserving full raw content', () => {
    const longValue = 'A'.repeat(150);
    const rendered = renderEvidenceValue(longValue);
    expect(rendered).toContain('<details class="evidence-disclosure">');
    expect(rendered).toContain('<summary');
    expect(rendered).toContain('(150 chars)');
    expect(rendered).toContain(`<pre class="evidence-raw-pre">${longValue}</pre>`);

    const multiline = 'line1\nline2\nline3';
    const multilineRendered = renderEvidenceValue(multiline);
    expect(multilineRendered).toContain('<details class="evidence-disclosure">');
    expect(multilineRendered).toContain('line1\nline2\nline3');
  });

  it('correctly maps outcome badge classes for various assertion statuses', () => {
    expect(outcomeBadgeClass('pass')).toBe('badge-pass');
    expect(outcomeBadgeClass('PASS')).toBe('badge-pass');
    expect(outcomeBadgeClass('match')).toBe('badge-pass');
    expect(outcomeBadgeClass('fail')).toBe('badge-fail');
    expect(outcomeBadgeClass('different')).toBe('badge-fail');
    expect(outcomeBadgeClass('blocked')).toBe('badge-blocked');
    expect(outcomeBadgeClass('cancelled')).toBe('badge-blocked');
    expect(outcomeBadgeClass('inconclusive')).toBe('badge-inconclusive');
    expect(outcomeBadgeClass('unknown')).toBe('badge-inconclusive');
  });

  it('renders accessible assertion tables with keyboard-scrollable region and sticky headers', () => {
    const assertions: AssertionRow[] = [
      {
        status: 'pass',
        name: 'order-quote-valid',
        expected: 'quote > 0',
        actual: '12.50',
        detail: 'order accepted within limits',
      },
      {
        status: 'fail',
        name: 'balance-invariant',
        expected: '{"total": 100}',
        actual: '{"total": 85}',
        detail: 'missing 15 credit',
      },
    ];

    const html = renderAssertionTable(assertions, {
      label: 'Trading scenario assertion results',
      observedColumnName: 'Actual',
      includeDetail: true,
    });

    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Trading scenario assertion results"');
    expect(html).toContain('class="data-table assertion-table"');
    expect(html).toContain('<th>Expected</th>');
    expect(html).toContain('<th>Actual</th>');
    expect(html).toContain('<th>Detail</th>');
    expect(html).toContain('badge-pass');
    expect(html).toContain('badge-fail');
    expect(html).toContain('order-quote-valid');
    expect(html).toContain('balance-invariant');
  });

  it('supports custom observed column name and omitting detail column', () => {
    const assertions: AssertionRow[] = [
      {
        status: 'pass',
        name: 'step-1',
        expected: '200',
        observed: '200',
      },
    ];

    const html = renderAssertionTable(assertions, {
      observedColumnName: 'Observed',
      includeDetail: false,
    });

    expect(html).toContain('<th>Observed</th>');
    expect(html).not.toContain('<th>Detail</th>');
  });
});
