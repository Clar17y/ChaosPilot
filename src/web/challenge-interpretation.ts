import type { ChallengeRecord } from '../challenges/types.ts';

export interface InterpretationSection {
  title: string;
  kind: 'summary' | 'observations' | 'replay' | 'clean' | 'limitations' | 'general';
  bullets: string[];
  paragraphs: string[];
}

export interface ParsedInterpretation {
  kind: 'structured' | 'legacy' | 'plain';
  summaryTakeaway?: string;
  previewExcerpt?: string;
  limitations?: string[];
  sections: InterpretationSection[];
}

const LEGACY_LABEL_REGEX =
  /(?:^|\s)(Observations:|Variant\s+\d+:?|Replay comparison:|Clean comparison:|Hypotheses vs established facts:|Limitations:)/g;

function classifySectionKind(title: string): InterpretationSection['kind'] {
  const lower = title.toLowerCase();
  if (lower.includes('summary')) return 'summary';
  if (lower.includes('observation')) return 'observations';
  if (lower.includes('replay')) return 'replay';
  if (lower.includes('clean')) return 'clean';
  if (lower.includes('limitation') || lower.includes('hypothes')) return 'limitations';
  return 'general';
}

function parseMarkdownStructured(rawText: string): ParsedInterpretation {
  const lines = rawText.split(/\r?\n/);
  const sections: InterpretationSection[] = [];
  let currentSec: InterpretationSection | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check for heading: e.g. ## Summary, ### Observations, or Summary:
    const headingMatch = trimmed.match(/^#{1,4}\s+(.+?)\s*#*$/) ||
      trimmed.match(/^(Summary|Observations|Replay comparison|Clean comparison|Limitations|Hypotheses vs established facts):?\s*$/i);

    if (headingMatch) {
      const title = headingMatch[1]!.replace(/:$/, '').trim();
      currentSec = {
        title,
        kind: classifySectionKind(title),
        bullets: [],
        paragraphs: [],
      };
      sections.push(currentSec);
      continue;
    }

    if (!currentSec) {
      currentSec = {
        title: 'Overview',
        kind: 'general',
        bullets: [],
        paragraphs: [],
      };
      sections.push(currentSec);
    }

    // Check for bullet: e.g. - item, * item, • item, 1. item
    const bulletMatch = trimmed.match(/^[-*•]\s+(.+)$/) || trimmed.match(/^\d+\.\s+(.+)$/);
    if (bulletMatch) {
      currentSec.bullets.push(bulletMatch[1]!.trim());
    } else {
      currentSec.paragraphs.push(trimmed);
    }
  }

  let summaryTakeaway: string | undefined;
  const summarySec = sections.find(s => s.kind === 'summary');
  if (summarySec) {
    const items = [...summarySec.paragraphs, ...summarySec.bullets];
    if (items.length > 0) {
      summaryTakeaway = items.join(' ');
    }
  }

  let limitations: string[] | undefined;
  const limSec = sections.find(s => s.kind === 'limitations');
  if (limSec) {
    const items = [...limSec.bullets, ...limSec.paragraphs];
    if (items.length > 0) {
      limitations = items;
    }
  }

  return {
    kind: 'structured',
    summaryTakeaway,
    limitations,
    sections,
  };
}

function parseLegacyDense(rawText: string): ParsedInterpretation {
  const matches: { label: string; offset: number }[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(LEGACY_LABEL_REGEX);

  while ((m = re.exec(rawText)) !== null) {
    const label = m[1]!;
    const offset = m.index + (m[0].length - label.length);
    matches.push({ label, offset });
  }

  const sections: InterpretationSection[] = [];
  let observationsIntro = '';
  const variantBullets: string[] = [];
  let replayBullet = '';
  let cleanBullet = '';
  let limitationsText = '';

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i]!;
    const next = matches[i + 1];
    const slice = rawText.slice(current.offset + current.label.length, next ? next.offset : undefined).trim();

    if (current.label.startsWith('Observations')) {
      observationsIntro = slice;
    } else if (current.label.startsWith('Variant')) {
      const normalizedLabel = current.label.replace(/:$/, '').trim();
      const variantText = slice ? `${normalizedLabel}: ${slice}` : normalizedLabel;
      variantBullets.push(variantText);
    } else if (current.label.startsWith('Replay comparison')) {
      replayBullet = slice;
    } else if (current.label.startsWith('Clean comparison')) {
      cleanBullet = slice;
    } else if (current.label.startsWith('Hypotheses') || current.label.startsWith('Limitations')) {
      limitationsText = slice;
    }
  }

  // 1. Observations section
  const obsSec: InterpretationSection = {
    title: 'Observations',
    kind: 'observations',
    paragraphs: observationsIntro ? [observationsIntro] : [],
    bullets: variantBullets,
  };
  sections.push(obsSec);

  // 2. Replay comparison section
  if (replayBullet) {
    sections.push({
      title: 'Replay comparison',
      kind: 'replay',
      paragraphs: [],
      bullets: [replayBullet],
    });
  }

  // 3. Clean comparison section
  if (cleanBullet) {
    sections.push({
      title: 'Clean comparison',
      kind: 'clean',
      paragraphs: [],
      bullets: [cleanBullet],
    });
  }

  // 4. Limitations section
  if (limitationsText) {
    sections.push({
      title: 'Hypotheses vs established facts',
      kind: 'limitations',
      paragraphs: [limitationsText],
      bullets: [],
    });
  }

  const previewExcerpt =
    rawText.length > 200 ? `${rawText.slice(0, 200).trim()}…` : rawText.trim();

  return {
    kind: 'legacy',
    previewExcerpt,
    limitations: limitationsText ? limitationsText.split(/(?<=[.!?])\s+(?=[A-Z])/) : undefined,
    sections,
  };
}

export function parseInterpretationText(rawText: string): ParsedInterpretation {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return {
      kind: 'plain',
      sections: [],
    };
  }

  const hasMarkdownHeaders = /(?:^|\n)\s*#{1,4}\s+[A-Za-z]/.test(trimmed);
  if (hasMarkdownHeaders) {
    return parseMarkdownStructured(trimmed);
  }

  const hasObservations = /(?:^|\s)Observations:/.test(trimmed);
  const hasOtherLegacyLabels =
    /(?:^|\s)(?:Variant\s+\d+|Replay comparison:|Clean comparison:|Hypotheses vs established facts:)/.test(
      trimmed,
    );
  if (hasObservations && hasOtherLegacyLabels) {
    return parseLegacyDense(trimmed);
  }

  // Plain text fallback
  const paragraphs = trimmed
    .split(/\r?\n\s*\r?\n/)
    .map(p => p.trim())
    .filter(Boolean);

  const previewExcerpt =
    trimmed.length > 200 ? `${trimmed.slice(0, 200).trim()}…` : undefined;

  return {
    kind: 'plain',
    previewExcerpt,
    sections: [
      {
        title: 'Interpretation',
        kind: 'general',
        paragraphs: paragraphs.length > 0 ? paragraphs : [trimmed],
        bullets: [],
      },
    ],
  };
}

export function renderChallengeInterpretation(
  parent: HTMLElement,
  interpretation: ChallengeRecord['interpretation'],
): HTMLElement {
  const container = document.createElement('div');
  container.className = 'challenge-interpretation';

  // 1. Heading & status banner
  const headRow = document.createElement('div');
  headRow.className = 'interp-head-row';

  const title = document.createElement('h4');
  title.className = 'interp-title';
  title.textContent = 'Muse interpretation';
  headRow.append(title);

  const statusBadge = document.createElement('span');
  statusBadge.className = `interp-status-badge status-${interpretation.status}`;
  statusBadge.textContent = interpretation.status;
  headRow.append(statusBadge);

  container.append(headRow);

  // Interpretation / deterministic evidence caveat (always visible)
  const caveat = document.createElement('p');
  caveat.className = 'interp-caveat';
  caveat.textContent =
    'Model interpretation, not deterministic evidence. It does not establish the finding or its root cause.';
  container.append(caveat);

  // Status check for non-available states
  if (interpretation.status !== 'available') {
    const notice = document.createElement('p');
    notice.className = `interp-notice interp-notice-${interpretation.status}`;
    if (interpretation.status === 'pending') {
      notice.textContent = 'Muse model interpretation is currently running…';
    } else if (interpretation.status === 'not-requested') {
      notice.textContent = 'Model interpretation was not requested for this challenge.';
    } else if (interpretation.status === 'cancelled') {
      notice.textContent =
        interpretation.error ?? 'Interpretation was cancelled before completion.';
    } else {
      notice.textContent = interpretation.error ?? 'No interpretation available.';
    }
    container.append(notice);
    parent.append(container);
    return container;
  }

  const rawText = interpretation.text ?? '';
  if (!rawText.trim()) {
    const emptyNotice = document.createElement('p');
    emptyNotice.className = 'interp-notice interp-empty';
    emptyNotice.textContent = 'No interpretation text provided.';
    container.append(emptyNotice);
    parent.append(container);
    return container;
  }

  const parsed = parseInterpretationText(rawText);

  // 2. Compact takeaway (Summary) or honest legacy preview
  if (parsed.summaryTakeaway) {
    const takeawayCard = document.createElement('div');
    takeawayCard.className = 'interp-takeaway-card';

    const label = document.createElement('div');
    label.className = 'takeaway-label';
    label.textContent = 'Summary';
    takeawayCard.append(label);

    const body = document.createElement('p');
    body.className = 'takeaway-text';
    body.textContent = parsed.summaryTakeaway;
    takeawayCard.append(body);

    container.append(takeawayCard);
  } else if (parsed.previewExcerpt) {
    const previewCard = document.createElement('div');
    previewCard.className = 'interp-takeaway-card legacy-preview-card';

    const label = document.createElement('div');
    label.className = 'takeaway-label';
    label.textContent = 'Interpretation preview';
    previewCard.append(label);

    const body = document.createElement('p');
    body.className = 'takeaway-text';
    body.textContent = parsed.previewExcerpt;
    previewCard.append(body);

    container.append(previewCard);
  }

  // 3. Limitations (visible always!)
  if (parsed.limitations && parsed.limitations.length > 0) {
    const limCard = document.createElement('div');
    limCard.className = 'interp-limitations-card';

    const limTitle = document.createElement('h5');
    limTitle.className = 'limitations-heading';
    limTitle.textContent = 'Limitations';
    limCard.append(limTitle);

    const limList = document.createElement('ul');
    limList.className = 'limitations-list';
    for (const item of parsed.limitations) {
      const li = document.createElement('li');
      li.textContent = item;
      limList.append(li);
    }
    limCard.append(limList);
    container.append(limCard);
  }

  // 4. Supporting Detail behind a native keyboard-accessible disclosure
  const supportingSections = parsed.sections.filter(
    s => s.kind !== 'summary' && s.kind !== 'limitations',
  );

  if (supportingSections.length > 0 && (parsed.kind !== 'plain' || parsed.previewExcerpt)) {
    const details = document.createElement('details');
    details.className = 'interp-supporting-disclosure';
    details.setAttribute('data-disclosure-key', 'interp-supporting-details');

    const summary = document.createElement('summary');
    summary.className = 'interp-supporting-summary';
    summary.textContent = 'Observations and comparisons';
    details.append(summary);

    const body = document.createElement('div');
    body.className = 'interp-supporting-body';

    for (const sec of supportingSections) {
      const secDiv = document.createElement('div');
      secDiv.className = `interp-section interp-section-${sec.kind}`;

      const h = document.createElement('h5');
      h.className = 'interp-section-heading';
      h.textContent = sec.title;
      secDiv.append(h);

      for (const p of sec.paragraphs) {
        const pEl = document.createElement('p');
        pEl.className = 'interp-section-paragraph';
        pEl.textContent = p;
        secDiv.append(pEl);
      }

      if (sec.bullets.length > 0) {
        const ul = document.createElement('ul');
        ul.className = 'interp-section-bullets';
        for (const b of sec.bullets) {
          const li = document.createElement('li');
          li.textContent = b;
          ul.append(li);
        }
        secDiv.append(ul);
      }

      body.append(secDiv);
    }

    details.append(body);
    container.append(details);
  } else if (parsed.kind === 'plain') {
    // Short plain text needs no preview or supporting disclosure.
    const plainBox = document.createElement('div');
    plainBox.className = 'interp-plain-content';
    for (const sec of parsed.sections) {
      for (const p of sec.paragraphs) {
        const pEl = document.createElement('p');
        pEl.className = 'interp-paragraph';
        pEl.textContent = p;
        plainBox.append(pEl);
      }
    }
    container.append(plainBox);
  }

  // 5. Full Raw text disclosure (always available)
  const rawDetails = document.createElement('details');
  rawDetails.className = 'interp-raw-disclosure';
  rawDetails.setAttribute('data-disclosure-key', 'interp-raw-text');

  const rawSummary = document.createElement('summary');
  rawSummary.textContent = 'Full interpretation text';
  rawDetails.append(rawSummary);

  const pre = document.createElement('pre');
  pre.className = 'interp-raw-text';
  pre.textContent = rawText;
  rawDetails.append(pre);

  container.append(rawDetails);

  parent.append(container);
  return container;
}
