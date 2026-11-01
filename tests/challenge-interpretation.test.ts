import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChallengeRecord } from '../src/challenges/types.ts';
import {
  parseInterpretationText,
  renderChallengeInterpretation,
} from '../src/web/challenge-interpretation.ts';

class MockElement {
  children: MockElement[] = [];
  textContent = '';
  disabled = false;
  open = false;
  attrs: Record<string, string> = {};
  className = '';

  constructor(readonly tag: string) {}

  set innerHTML(_v: string) {
    throw new Error('Unsafe HTML rendering forbidden: innerHTML must not be used');
  }

  append(...children: (MockElement | string)[]) {
    for (const c of children) {
      if (typeof c === 'string') {
        const textEl = new MockElement('span');
        textEl.textContent = c;
        this.children.push(textEl);
      } else if (c instanceof MockElement) {
        this.children.push(c);
      }
    }
  }

  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  querySelector(selector: string): MockElement | null {
    if (selector.startsWith('.')) {
      const classes = selector.split('.').filter(Boolean);
      const hasAll = classes.every(cls => this.className.split(/\s+/).includes(cls));
      if (hasAll) return this;
    } else if (this.tag === selector) {
      return this;
    }
    for (const c of this.children) {
      const found = c.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      if (this.className.split(/\s+/).includes(cls)) results.push(this);
    } else if (this.tag === selector) {
      results.push(this);
    }
    for (const c of this.children) {
      results.push(...c.querySelectorAll(selector));
    }
    return results;
  }

  allTags(): string[] {
    const tags = [this.tag];
    for (const c of this.children) tags.push(...c.allTags());
    return tags;
  }

  allText(): string {
    return [this.textContent, ...this.children.map(c => c.allText())].join('\n');
  }
}

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: (tag: string) => new MockElement(tag),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('parseInterpretationText', () => {
  it('parses structured markdown format into summary takeaway, sections, bullets and limitations', () => {
    const structured = `## Summary
The candidate accepted mismatched execution prices while clean rejected them. The variations support the observed failure.

## Observations
- Small upward and downward mismatches were accepted.
- Full and partial fills changed candidate state without venue executions.
- A quote update did not protect the locked order price.

## Replay comparison
- All three candidate replays matched.

## Clean comparison
- All three clean runs rejected the execution and preserved the order and credit.

## Limitations
- The post-update test cannot distinguish absent validation from comparison against the current quote.
- This interpretation is limited to the supplied deterministic evidence.`;

    const parsed = parseInterpretationText(structured);
    expect(parsed.kind).toBe('structured');
    expect(parsed.summaryTakeaway).toContain('The candidate accepted mismatched execution prices');
    expect(parsed.summaryTakeaway).toContain('The variations support the observed failure');
    expect(parsed.limitations).toHaveLength(2);
    expect(parsed.limitations![0]).toContain('distinguish absent validation');

    const obs = parsed.sections.find(s => s.kind === 'observations');
    expect(obs?.bullets).toHaveLength(3);
    expect(obs?.bullets[0]).toContain('Small upward and downward mismatches');

    const replay = parsed.sections.find(s => s.kind === 'replay');
    expect(replay?.bullets).toHaveLength(1);
    expect(replay?.bullets[0]).toContain('All three candidate replays matched');

    const clean = parsed.sections.find(s => s.kind === 'clean');
    expect(clean?.bullets).toHaveLength(1);
    expect(clean?.bullets[0]).toContain('All three clean runs rejected');
  });

  it('parses legacy dense one-line interpretations with explicit labels without another model call and without fabricating a summary', () => {
    const legacyDense =
      'Observations: The bound finding (candidate-g, venue_execution_integrity) originally reported order o1 locked at price 100, then an execution produced targetFilled=5. Three completed variants tested related price mismatches. Variant 1 used price 101, quantity 10: at step 7 the candidate accepted it. Variant 2 used price 99, quantity 4: the candidate accepted it. Variant 3 updated the active quote to q2 price 200: candidate accepted it. Replay comparison: for each variant, replayStatus=matched and replayMismatches=[]. Clean comparison: for each variant, cleanStatus=passed and clean run rejected the mismatched execution. Hypotheses vs established facts: the variant hypotheses proposed absent rather than threshold-based validation, but this does not by itself prove internal root cause. A single-model interpretation does not establish finding truth beyond the supplied deterministic evidence.';

    const parsed = parseInterpretationText(legacyDense);
    expect(parsed.kind).toBe('legacy');
    expect(parsed.summaryTakeaway).toBeUndefined(); // Acceptance criterion: Do not infer or fabricate a summary!
    expect(parsed.previewExcerpt).toBeDefined();
    expect(parsed.previewExcerpt).toContain('Observations: The bound finding');
    expect(parsed.previewExcerpt?.endsWith('…')).toBe(true);

    const obs = parsed.sections.find(s => s.kind === 'observations');
    expect(obs).toBeDefined();
    expect(obs?.paragraphs[0]).toContain('The bound finding (candidate-g');
    expect(obs?.bullets).toHaveLength(3);
    expect(obs?.bullets[0]).toContain('Variant 1: used price 101');
    expect(obs?.bullets[1]).toContain('Variant 2: used price 99');
    expect(obs?.bullets[2]).toContain('Variant 3: updated the active quote');

    const replay = parsed.sections.find(s => s.kind === 'replay');
    expect(replay?.bullets[0]).toContain('replayStatus=matched');

    const clean = parsed.sections.find(s => s.kind === 'clean');
    expect(clean?.bullets[0]).toContain('cleanStatus=passed');

    expect(parsed.limitations).toBeDefined();
    expect(parsed.limitations![0]).toContain('the variant hypotheses proposed absent');
  });

  it('handles plain text fallback preserving paragraphs without fabricating summary or sections', () => {
    const plain = 'First paragraph of plain text observation.\n\nSecond paragraph notes limitations without headings.';
    const parsed = parseInterpretationText(plain);
    expect(parsed.kind).toBe('plain');
    expect(parsed.summaryTakeaway).toBeUndefined();
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]!.paragraphs).toEqual([
      'First paragraph of plain text observation.',
      'Second paragraph notes limitations without headings.',
    ]);
  });

  it('handles empty or whitespace-only text gracefully', () => {
    const parsed = parseInterpretationText('   \n  \t  ');
    expect(parsed.kind).toBe('plain');
    expect(parsed.sections).toHaveLength(0);
    expect(parsed.summaryTakeaway).toBeUndefined();
  });
});

describe('renderChallengeInterpretation', () => {
  it('shows short plain interpretations directly and preserves their lines', () => {
    const parent = new MockElement('div');
    const text = 'First observation.\nSecond observation.';
    const container = renderChallengeInterpretation(parent as unknown as HTMLElement, {
      status: 'available', text,
    }) as unknown as MockElement;
    expect(container.querySelector('.interp-plain-content')?.allText()).toContain(text);
    expect(container.querySelector('.interp-supporting-disclosure')).toBeNull();
    expect(container.querySelector('.interp-raw-text')?.textContent).toBe(text);
  });

  it('renders structured interpretation with takeaway, visible limitations, disclosure for details, and raw text', () => {
    const parent = new MockElement('div');
    const interpretation: ChallengeRecord['interpretation'] = {
      status: 'available',
      text: `## Summary\nCritical finding confirmed.\n\n## Observations\n- Observed violation at step 4.\n\n## Replay comparison\n- Replay matched candidate.\n\n## Clean comparison\n- Clean passed.\n\n## Limitations\n- Uncertainty remains about root cause.`,
    };

    const container = renderChallengeInterpretation(parent as unknown as HTMLElement, interpretation) as unknown as MockElement;

    // Status badge and caveat
    expect(container.querySelector('.interp-status-badge')?.textContent).toBe('available');
    expect(container.querySelector('.interp-caveat')?.textContent).toContain('not deterministic evidence');

    // Key Takeaway
    const takeaway = container.querySelector('.interp-takeaway-card');
    expect(takeaway).not.toBeNull();
    expect(takeaway?.allText()).toContain('Critical finding confirmed');

    // Visible Limitations
    const limCard = container.querySelector('.interp-limitations-card');
    expect(limCard).not.toBeNull();
    expect(limCard?.allText()).toContain('Uncertainty remains about root cause');

    // Keyboard-accessible details for supporting sections
    const supportingDetails = container.querySelector('.interp-supporting-disclosure');
    expect(supportingDetails).not.toBeNull();
    expect(supportingDetails?.attrs['data-disclosure-key']).toBe('interp-supporting-details');
    expect(supportingDetails?.open).toBe(false);
    expect(supportingDetails?.allText()).toContain('Observed violation at step 4');
    expect(supportingDetails?.allText()).toContain('Replay matched candidate');
    expect(supportingDetails?.allText()).toContain('Clean passed');

    // Full raw text disclosure
    const rawDetails = container.querySelector('.interp-raw-disclosure');
    expect(rawDetails).not.toBeNull();
    expect(rawDetails?.attrs['data-disclosure-key']).toBe('interp-raw-text');
    expect(container.querySelector('.interp-raw-text')?.textContent).toBe(interpretation.text);
  });

  it('renders legacy dense interpretation with honest legacy preview excerpt, structured bullets, visible limitations, and full raw text', () => {
    const parent = new MockElement('div');
    const legacyText =
      'Observations: Invariant violation observed. Variant 1 used price 101: candidate accepted it. Variant 2 used price 99: candidate accepted it. Replay comparison: matched. Clean comparison: clean passed. Hypotheses vs established facts: root cause unproven.';
    const interpretation: ChallengeRecord['interpretation'] = {
      status: 'available',
      text: legacyText,
    };

    const container = renderChallengeInterpretation(parent as unknown as HTMLElement, interpretation) as unknown as MockElement;

    // Honest legacy preview label (no fabricated summary!)
    const legacyPreview = container.querySelector('.legacy-preview-card');
    expect(legacyPreview).not.toBeNull();
    expect(legacyPreview?.allText()).toContain('Interpretation preview');
    expect(container.querySelector('.takeaway-label')?.textContent).toBe('Interpretation preview');

    // Limitations visible
    expect(container.querySelector('.interp-limitations-card')?.allText()).toContain('root cause unproven');

    // Bullets inside supporting disclosure
    const supporting = container.querySelector('.interp-supporting-disclosure');
    expect(supporting?.allText()).toContain('Variant 1: used price 101');
    expect(supporting?.allText()).toContain('Variant 2: used price 99');
    expect(supporting?.allText()).toContain('matched');
    expect(supporting?.allText()).toContain('clean passed');

    // Full raw text intact
    expect(container.querySelector('.interp-raw-text')?.textContent).toBe(legacyText);
  });

  it('safely handles hostile HTML, script, img, and link strings without executing or creating DOM elements', () => {
    const parent = new MockElement('div');
    const hostile = '<script>alert("xss")</script><img src=x onerror=alert(1)><a href="javascript:void(0)">evil</a>';
    const interpretation: ChallengeRecord['interpretation'] = {
      status: 'available',
      text: hostile,
    };

    const container = renderChallengeInterpretation(parent as unknown as HTMLElement, interpretation) as unknown as MockElement;
    const allTags = container.allTags();
    expect(allTags).not.toContain('script');
    expect(allTags).not.toContain('img');
    expect(allTags).not.toContain('a');

    // Safe text is preserved
    expect(container.allText()).toContain(hostile);
  });

  it.each([
    ['pending', 'Muse model interpretation is currently running…'],
    ['not-requested', 'Model interpretation was not requested for this challenge.'],
    ['cancelled', 'Interpretation cancelled by user.'],
    ['unavailable', 'Model quota exceeded.'],
  ] as const)('renders status and message correctly for %s status', (status, errorMsg) => {
    const parent = new MockElement('div');
    const interpretation: ChallengeRecord['interpretation'] = {
      status,
      error: status === 'cancelled' || status === 'unavailable' ? errorMsg : undefined,
    };

    const container = renderChallengeInterpretation(parent as unknown as HTMLElement, interpretation) as unknown as MockElement;
    expect(container.querySelector(`.interp-status-badge.status-${status}`)?.textContent).toBe(status);
    expect(container.querySelector(`.interp-notice-${status}`)?.textContent).toContain(
      status === 'not-requested'
        ? 'not requested'
        : status === 'pending'
          ? 'currently running'
          : errorMsg,
    );
  });

  it('renders a notice when interpretation text is empty string', () => {
    const parent = new MockElement('div');
    const container = renderChallengeInterpretation(parent as unknown as HTMLElement, {
      status: 'available',
      text: '   ',
    }) as unknown as MockElement;

    expect(container.querySelector('.interp-empty')?.textContent).toContain('No interpretation text provided');
  });
});
