import type { ChallengeRecord, ChallengeVariant, ChallengeView } from '../challenges/types.ts';
import type { SourceBundle, TraceEntry } from '../domain.ts';
import { renderChallengeInterpretation } from './challenge-interpretation.ts';

export interface VerificationViewState {
  selectedAttemptId?: string;
  selectedVariantIndex: number;
  selectedSourceTarget: 'candidate' | 'clean';
  selectedSourceFile?: string;
  selectedExecutionKind: 'candidate' | 'replay' | 'clean';
  playbackIndex: number;
  isPlaying: boolean;
  playbackTimer?: ReturnType<typeof setInterval>;
  lastTraceKey?: string;
  lastActiveAttemptId?: string;
}

// Global or per-host state tracker to preserve user selections across renders
const viewStates = new WeakMap<HTMLElement, VerificationViewState>();

export function getOrCreateViewState(host: HTMLElement): VerificationViewState {
  let state = viewStates.get(host);
  if (!state) {
    state = {
      selectedVariantIndex: 0,
      selectedSourceTarget: 'candidate',
      selectedExecutionKind: 'candidate',
      playbackIndex: 0,
      isPlaying: false,
    };
    viewStates.set(host, state);
  }
  return state;
}

export function cleanupVerificationView(host: HTMLElement): void {
  const state = viewStates.get(host);
  if (state) {
    stopPlayback(state);
    state.playbackIndex = 0;
  }
}

export function stopPlayback(state: VerificationViewState): void {
  if (state.playbackTimer) {
    clearInterval(state.playbackTimer);
    state.playbackTimer = undefined;
  }
  state.isPlaying = false;
}

const safeAddListener = (el: unknown, event: string, handler: (e: any) => void) => {
  if (el && typeof (el as any).addEventListener === 'function') {
    (el as any).addEventListener(event, handler);
  }
};

function appendJsonDetails(parent: HTMLElement, label: string, value: unknown, open = false): void {
  const details = document.createElement('details');
  if (open) details.open = true;
  const summary = document.createElement('summary');
  summary.textContent = label;
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(value, null, 2);
  details.append(summary, pre);
  parent.append(details);
}

function createTabButton(label: string, selected: boolean, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn btn-xs ${selected ? 'btn-primary' : 'btn-secondary'}`;
  button.setAttribute('role', 'tab');
  button.setAttribute('aria-selected', String(selected));
  button.textContent = label;
  safeAddListener(button, 'click', onClick);
  return button;
}

const addClass = (el: any, cls: string) => {
  if (!cls || !el) return;
  if (el.classList && typeof el.classList.add === 'function') {
    el.classList.add(cls);
  } else {
    const parts = (el.className ? el.className.split(/\s+/) : []).filter(Boolean);
    if (!parts.includes(cls)) {
      parts.push(cls);
      el.className = parts.join(' ');
    }
  }
};

const removeClass = (el: any, cls: string) => {
  if (!cls || !el) return;
  if (el.classList && typeof el.classList.remove === 'function') {
    el.classList.remove(cls);
  } else if (el.className) {
    el.className = el.className.split(/\s+/).filter((c: string) => c !== cls).join(' ');
  }
};

/** Tokenizes a line of JS/TS source code safely into syntax categories */
function tokenizeLine(line: string): Array<{ text: string; kind: 'plain' | 'kw' | 'str' | 'comm' | 'type' | 'num' }> {
  const tokens: Array<{ text: string; kind: 'plain' | 'kw' | 'str' | 'comm' | 'type' | 'num' }> = [];
  const regex = /(\/\/.*$)|('(?:\\.|[^'])*'|"(?:\\.|[^"])*"|`(?:\\.|[^`])*`)|(\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|import|export|from|as|class|interface|type|extends|implements|new|this|async|await|try|catch|finally|throw|typeof|instanceof|default)\b)|(\b(?:true|false|null|undefined|number|string|boolean|void|any|never|unknown|Promise|Record|Array|Set|Map)\b)|(\b\d+(?:\.\d+)?\b)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: line.substring(lastIndex, match.index), kind: 'plain' });
    }
    if (match[1] !== undefined) tokens.push({ text: match[1], kind: 'comm' });
    else if (match[2] !== undefined) tokens.push({ text: match[2], kind: 'str' });
    else if (match[3] !== undefined) tokens.push({ text: match[3], kind: 'kw' });
    else if (match[4] !== undefined) tokens.push({ text: match[4], kind: 'type' });
    else if (match[5] !== undefined) tokens.push({ text: match[5], kind: 'num' });

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < line.length) {
    tokens.push({ text: line.substring(lastIndex), kind: 'plain' });
  }

  return tokens;
}

/** Renders syntax highlighted source code into a container with line numbers */
export function renderSourceViewer(container: HTMLElement, bundle?: SourceBundle, selectedFilePath?: string): void {
  container.replaceChildren();

  if (!bundle || !bundle.files.length) {
    const p = document.createElement('p');
    p.className = 'notice-muted';
    p.textContent = 'Source code snapshot not recorded for this challenge attempt.';
    container.append(p);
    return;
  }

  const file = bundle.files.find(f => f.path === selectedFilePath) ?? bundle.files[0]!;
  const viewer = document.createElement('div');
  viewer.className = 'source-code-viewer';
  viewer.setAttribute('tabindex', '0');
  viewer.setAttribute('role', 'region');
  viewer.setAttribute('aria-label', `Executed code: ${file.path}`);

  const lines = file.content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineEl = document.createElement('div');
    lineEl.className = 'code-line';

    const numSpan = document.createElement('span');
    numSpan.className = 'line-num';
    numSpan.setAttribute('aria-hidden', 'true');
    numSpan.textContent = String(i + 1);

    const contentSpan = document.createElement('span');
    contentSpan.className = 'line-content';

    const tokens = tokenizeLine(lines[i]!);
    for (const token of tokens) {
      if (token.kind === 'plain') {
        const textNode = document.createElement('span');
        textNode.textContent = token.text;
        contentSpan.append(textNode);
      } else {
        const span = document.createElement('span');
        span.className = `syn-${token.kind}`;
        span.textContent = token.text;
        contentSpan.append(span);
      }
    }

    lineEl.append(numSpan, contentSpan);
    viewer.append(lineEl);
  }

  container.append(viewer);
}

/** Renders the complete Watch Verification view into the results element */
export function renderWatchVerificationView(
  container: HTMLElement,
  view: ChallengeView,
  onStateChange: () => void,
): void {
  const state = getOrCreateViewState(container);

  // Determine active and historical attempts
  const current = view.current;
  const latestAttempt = view.latestAttempt;
  const latestPartial = view.latestPartial;

  // Track active generation. When a new generation starts, clear selectedAttemptId so active progress is prominent.
  const isGenerating = view.inFlight === true || latestAttempt?.status === 'running';
  if (isGenerating && latestAttempt) {
    if (state.lastActiveAttemptId !== latestAttempt.id) {
      state.selectedAttemptId = undefined;
      state.lastActiveAttemptId = latestAttempt.id;
    }
  } else if (!isGenerating) {
    state.lastActiveAttemptId = undefined;
  }

  const hasNewerAttempt = latestAttempt && latestAttempt.id !== current?.id;
  const primaryAttempt = state.selectedAttemptId
    ? ([latestAttempt, current, latestPartial].find(a => a?.id === state.selectedAttemptId) ?? latestAttempt ?? current)
    : (hasNewerAttempt || isGenerating ? latestAttempt : (current ?? latestAttempt ?? latestPartial));

  if (!primaryAttempt) {
    const p = document.createElement('p');
    p.textContent = 'No current challenge evidence saved for this finding.';
    container.append(p);
    return;
  }

  // inFlight applies specifically to the attempt currently running, never falsely to a historical selection
  const inFlightForAttempt = Boolean(
    (view.inFlight && primaryAttempt.id === latestAttempt?.id) ||
    primaryAttempt.status === 'running'
  );

  // Root verification view container
  const wrap = document.createElement('div');
  wrap.className = 'watch-verification-container';

  // Determine label prefix for primary attempt
  const isPartial = primaryAttempt.status !== 'completed' && primaryAttempt.variants.some(v => v.candidate !== undefined);
  const labelPrefix = primaryAttempt.status === 'completed'
    ? 'Saved challenge'
    : isPartial
      ? 'Partial attempt'
      : 'Latest attempt';

  // 1. Stage Progress Pipeline / Banner
  renderStagePipeline(wrap, primaryAttempt, inFlightForAttempt, labelPrefix);

  // 2. Multi-attempt selector banner if multiple attempts exist
  renderAttemptSelector(wrap, view, primaryAttempt, state, () => {
    stopPlayback(state);
    state.selectedVariantIndex = 0;
    state.playbackIndex = 0;
    onStateChange();
  });

  // Verify variant selection bounds
  const variants = primaryAttempt.variants;
  if (state.selectedVariantIndex >= variants.length) {
    state.selectedVariantIndex = Math.max(0, variants.length - 1);
  }
  const variant = variants[state.selectedVariantIndex];

  if (!variant) {
    const notice = document.createElement('p');
    notice.className = 'notice-muted';
    notice.textContent = inFlightForAttempt
      ? 'Awaiting proposed variations from Muse…'
      : (primaryAttempt.error ?? 'No variations proposed or recorded.');
    wrap.append(notice);
    // Render footer on the no-variants path to retain diagnostics, error details and usage
    renderVerificationFooter(wrap, primaryAttempt);
    renderPriorAttempts(wrap, view, primaryAttempt);
    container.append(wrap);
    return;
  }

  // Determine active trace and step
  const kind = state.selectedExecutionKind;
  const executionResult = variant[kind];
  const trace = executionResult?.trace ?? [];

  // Own playback by full evidence identity: stop and reset on trace or attempt change
  const currentTraceKey = `${view.evidenceHash ?? ''}:${primaryAttempt.id}:${state.selectedVariantIndex}:${state.selectedExecutionKind}:${trace.length}`;
  if (state.lastTraceKey !== undefined && state.lastTraceKey !== currentTraceKey) {
    stopPlayback(state);
    state.playbackIndex = 0;
  }
  state.lastTraceKey = currentTraceKey;

  if (state.playbackIndex >= trace.length) {
    state.playbackIndex = Math.max(0, trace.length - 1);
  }
  const activeEntry: TraceEntry | undefined = trace[state.playbackIndex];
  const activeActionStep = activeEntry !== undefined ? activeEntry.step : undefined;

  // 3. Full-width code with test steps and execution results beneath it.
  const grid = document.createElement('div');
  grid.className = 'verification-columns';

  // Exact test steps and differences
  const colSteps = document.createElement('div');
  colSteps.className = 'verification-col col-steps';
  renderStepsColumn(colSteps, primaryAttempt, variant, state, activeActionStep, onStateChange);

  // Code under test (provenance-matched source viewer)
  const colSource = document.createElement('div');
  colSource.className = 'verification-col col-source';
  renderSourceColumn(colSource, primaryAttempt, state, onStateChange);

  // Recorded execution results and interactive playback
  const colResults = document.createElement('div');
  colResults.className = 'verification-col col-results';
  renderResultsColumn(colResults, primaryAttempt, variant, executionResult, trace, state, colSteps, onStateChange);
  grid.append(colSource, colSteps, colResults);

  wrap.append(grid);

  // 4. Muse interpretation & accounting footer
  renderVerificationFooter(wrap, primaryAttempt);

  // 5. Retained earlier/other attempts display
  renderPriorAttempts(wrap, view, primaryAttempt);

  container.append(wrap);
}

function renderPriorAttempts(wrap: HTMLElement, view: ChallengeView, primaryAttempt: ChallengeRecord): void {
  if (view.current && view.current.id !== primaryAttempt.id) {
    const priorSec = document.createElement('section');
    priorSec.className = 'prior-evidence-section';
    const priorHead = document.createElement('h5');
    priorHead.textContent = `Saved challenge ${view.current.id} · ${view.current.status} · ${view.current.startedAt}`;
    const priorNote = document.createElement('p');
    priorNote.textContent = 'Earlier valid completed evidence is retained. Select above to inspect.';
    priorSec.append(priorHead, priorNote);
    wrap.append(priorSec);
  }
  if (view.latestPartial && view.latestPartial.id !== primaryAttempt.id && view.latestPartial.id !== view.current?.id) {
    const partSec = document.createElement('section');
    partSec.className = 'prior-evidence-section';
    const partHead = document.createElement('h5');
    partHead.textContent = `Partial attempt ${view.latestPartial.id} · ${view.latestPartial.status} · ${view.latestPartial.startedAt}`;
    partSec.append(partHead);
    wrap.append(partSec);
  }
}

export interface DerivedStage {
  name: string;
  label: string;
  status: 'completed' | 'active' | 'failed' | 'cancelled' | 'skipped' | 'pending';
  display: string;
}

export function deriveStageStates(record: ChallengeRecord, inFlight: boolean): DerivedStage[] {
  const currentStageName = record.stage?.stage;
  const isTerminal = record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled';

  // 1. Proposal
  let proposalStatus: DerivedStage['status'] = 'pending';
  let proposalDisplay = '1. Muse proposing';
  if (inFlight && currentStageName === 'proposal') {
    proposalStatus = 'active';
    proposalDisplay = '▶ 1. Muse proposing';
  } else if (record.proposalResponse !== undefined || record.variants.length > 0) {
    proposalStatus = 'completed';
    proposalDisplay = '✓ 1. Muse proposed';
  } else if (record.status === 'cancelled') {
    proposalStatus = 'cancelled';
    proposalDisplay = '⊘ 1. Proposal cancelled';
  } else if (record.status === 'failed') {
    proposalStatus = 'failed';
    proposalDisplay = '✗ 1. Proposal failed';
  }

  const hasVariants = record.variants.length > 0;
  const plannedVariants = record.stage?.totalVariants ?? record.variants.length;

  const isCandidateExecuted = (v: ChallengeVariant) => (v.candidate !== undefined || v.candidateStatus === 'completed') && v.candidateStatus !== 'unavailable' && v.candidateStatus !== 'error';
  const isCandidateFailed = (v: ChallengeVariant) => v.candidateStatus === 'error' || v.candidateStatus === 'invalid-or-incomplete' || v.candidateStatus === 'source-mismatch';

  const isReplayExecuted = (v: ChallengeVariant) => (v.replay !== undefined || v.replayStatus === 'matched' || v.replayStatus === 'mismatch') && v.replayStatus !== 'unavailable' && v.replayStatus !== 'error';
  const isReplayFailed = (v: ChallengeVariant) => v.replayStatus === 'error' || v.replayStatus === 'mismatch' || (v.replay !== undefined && v.replayStatus === 'unavailable');

  const isCleanExecuted = (v: ChallengeVariant) => (v.clean !== undefined || v.cleanStatus === 'passed' || v.cleanStatus === 'failed') && v.cleanStatus !== 'unavailable' && v.cleanStatus !== 'error';
  const isCleanFailed = (v: ChallengeVariant) => v.cleanStatus === 'error' || v.cleanStatus === 'failed' || v.cleanStatus === 'invalid-or-incomplete' || v.cleanStatus === 'source-mismatch';

  const checkExecutionStage = (
    kind: 'candidate' | 'replay' | 'clean',
    stepNum: number,
    title: string,
    isExecuted: (v: ChallengeVariant) => boolean,
    isFailed: (v: ChallengeVariant) => boolean,
  ): DerivedStage => {
    if (inFlight && currentStageName === kind) {
      return { name: kind, label: `${stepNum}. ${title}`, status: 'active', display: `▶ ${stepNum}. ${title}` };
    }

    if (hasVariants) {
      const allExecuted = record.variants.length >= plannedVariants && record.variants.every(isExecuted);
      const anyFailed = record.variants.some(isFailed);
      const anyExecuted = record.variants.some(isExecuted);

      if (anyFailed) {
        return { name: kind, label: `${stepNum}. ${title}`, status: 'failed', display: `✗ ${stepNum}. ${title} failed` };
      }
      if (allExecuted) {
        return { name: kind, label: `${stepNum}. ${title}`, status: 'completed', display: `✓ ${stepNum}. ${title}` };
      }
      if (record.status === 'cancelled') {
        if (currentStageName === kind || (anyExecuted && !allExecuted)) {
          return { name: kind, label: `${stepNum}. ${title}`, status: 'cancelled', display: `⊘ ${stepNum}. ${title} cancelled` };
        }
        return { name: kind, label: `${stepNum}. ${title}`, status: 'skipped', display: `- ${stepNum}. ${title} skipped` };
      }
      if (record.status === 'failed') {
        if (currentStageName === kind) {
          return { name: kind, label: `${stepNum}. ${title}`, status: 'failed', display: `✗ ${stepNum}. ${title} failed` };
        }
        return { name: kind, label: `${stepNum}. ${title}`, status: 'skipped', display: `- ${stepNum}. ${title} skipped` };
      }
      if (inFlight) {
        return { name: kind, label: `${stepNum}. ${title}`, status: 'pending', display: `${stepNum}. ${title}` };
      }
    }

    if (isTerminal) {
      return { name: kind, label: `${stepNum}. ${title}`, status: 'skipped', display: `- ${stepNum}. ${title} skipped` };
    }
    return { name: kind, label: `${stepNum}. ${title}`, status: 'pending', display: `${stepNum}. ${title}` };
  };

  const candidateStage = checkExecutionStage('candidate', 2, 'Candidate execution', isCandidateExecuted, isCandidateFailed);
  const replayStage = checkExecutionStage('replay', 3, 'Replay verification', isReplayExecuted, isReplayFailed);
  const cleanStage = checkExecutionStage('clean', 4, 'Clean control', isCleanExecuted, isCleanFailed);
  const cleanDone = cleanStage.status === 'completed';

  // 5. Interpretation
  let interpStatus: DerivedStage['status'] = 'pending';
  let interpDisplay = '5. Muse interpreting';
  if (inFlight && currentStageName === 'interpretation') {
    interpStatus = 'active';
    interpDisplay = '▶ 5. Muse interpreting';
  } else if (!cleanDone && isTerminal && record.interpretation.status !== 'available') {
    interpStatus = 'skipped';
    interpDisplay = '- 5. Interpretation skipped';
  } else {
    switch (record.interpretation.status) {
      case 'available':
        interpStatus = 'completed';
        interpDisplay = '✓ 5. Muse interpreted';
        break;
      case 'not-requested':
        interpStatus = 'skipped';
        interpDisplay = '- 5. Interpretation skipped';
        break;
      case 'unavailable':
        interpStatus = 'failed';
        interpDisplay = '✗ 5. Interpretation unavailable';
        break;
      case 'cancelled':
        interpStatus = 'cancelled';
        interpDisplay = '⊘ 5. Interpretation cancelled';
        break;
      case 'pending':
      default:
        if (isTerminal) {
          interpStatus = 'skipped';
          interpDisplay = '- 5. Interpretation skipped';
        } else {
          interpStatus = 'pending';
          interpDisplay = '5. Muse interpreting';
        }
        break;
    }
  }

  // 6. Terminal
  let terminalStatus: DerivedStage['status'] = 'pending';
  let terminalDisplay = '6. Terminal';
  if (record.status === 'completed') {
    terminalStatus = 'completed';
    terminalDisplay = '✓ 6. Completed';
  } else if (record.status === 'cancelled') {
    terminalStatus = 'cancelled';
    terminalDisplay = '⊘ 6. Cancelled';
  } else if (record.status === 'failed') {
    terminalStatus = 'failed';
    terminalDisplay = '✗ 6. Failed';
  }

  return [
    { name: 'proposal', label: '1. Muse proposing', status: proposalStatus, display: proposalDisplay },
    candidateStage,
    replayStage,
    cleanStage,
    { name: 'interpretation', label: '5. Muse interpreting', status: interpStatus, display: interpDisplay },
    { name: 'terminal', label: record.status === 'completed' ? '6. Completed' : `6. ${record.status}`, status: terminalStatus, display: terminalDisplay },
  ];
}

/** Renders the 6-stage verification progress timeline */
function renderStagePipeline(parent: HTMLElement, record: ChallengeRecord, inFlight: boolean, labelPrefix = 'Saved challenge'): void {
  const section = document.createElement('section');
  section.className = 'stage-pipeline-section';
  section.setAttribute('aria-label', 'Verification stage progression');

  const header = document.createElement('div');
  header.className = 'stage-pipeline-header';

  const title = document.createElement('strong');
  title.textContent = inFlight
    ? `Active challenge in progress · ${record.stage?.detail ?? 'Running…'}`
    : `${labelPrefix} ${record.id} · ${record.status} · ${record.startedAt}`;
  header.append(title);

  if (record.error) {
    const err = document.createElement('span');
    err.className = 'stage-error-text';
    err.textContent = ` — ${record.error}`;
    header.append(err);
  }
  section.append(header);

  const pipeline = document.createElement('div');
  pipeline.className = 'stage-pipeline';
  pipeline.setAttribute('role', 'list');

  const stages = deriveStageStates(record, inFlight);
  stages.forEach(st => {
    const item = document.createElement('div');
    item.className = 'stage-step';
    item.setAttribute('role', 'listitem');

    if (st.status === 'completed') {
      addClass(item, 'stage-done');
    } else if (st.status === 'active') {
      addClass(item, 'stage-active');
    } else if (st.status === 'failed') {
      addClass(item, 'stage-failed');
    } else if (st.status === 'cancelled') {
      addClass(item, 'stage-cancelled');
    } else if (st.status === 'skipped') {
      addClass(item, 'stage-skipped');
    }

    item.textContent = st.display;
    pipeline.append(item);
  });

  section.append(pipeline);
  parent.append(section);
}

/** Renders attempt selector when multiple attempts exist */
function renderAttemptSelector(
  parent: HTMLElement,
  view: ChallengeView,
  selected: ChallengeRecord,
  state: VerificationViewState,
  onSelect: () => void,
): void {
  const attempts: { id: string; label: string; record: ChallengeRecord }[] = [];

  if (view.latestAttempt) {
    const isRunning = view.inFlight || view.latestAttempt.status === 'running';
    attempts.push({
      id: view.latestAttempt.id,
      label: `${isRunning ? 'Active attempt' : 'Latest attempt'} (${view.latestAttempt.status})`,
      record: view.latestAttempt,
    });
  }

  if (view.current && view.current.id !== view.latestAttempt?.id) {
    attempts.push({
      id: view.current.id,
      label: `Prior completed challenge (${view.current.status})`,
      record: view.current,
    });
  }

  if (view.latestPartial && view.latestPartial.id !== view.latestAttempt?.id && view.latestPartial.id !== view.current?.id) {
    attempts.push({
      id: view.latestPartial.id,
      label: `Partial attempt (${view.latestPartial.status})`,
      record: view.latestPartial,
    });
  }

  if (attempts.length <= 1) return;

  const bar = document.createElement('div');
  bar.className = 'attempt-selector-bar';
  bar.setAttribute('role', 'tablist');
  bar.setAttribute('aria-label', 'Challenge attempt history');

  const note = document.createElement('span');
  note.className = 'attempt-selector-note';
  note.textContent = 'Challenge attempts: ';
  bar.append(note);

  attempts.forEach(att => {
    const btn = createTabButton(att.label, att.id === selected.id, () => {
      state.selectedAttemptId = att.id;
      onSelect();
    });
    bar.append(btn);
  });

  parent.append(bar);
}

/** Column 1: Test Steps, Differences, and Step Highlighting */
function renderStepsColumn(
  parent: HTMLElement,
  record: ChallengeRecord,
  variant: ChallengeVariant,
  state: VerificationViewState,
  activeActionStep: number | undefined,
  onChange: () => void,
): void {
  const heading = document.createElement('h4');
  heading.textContent = 'Exact test steps & differences';
  parent.append(heading);

  // Variation selector tabs
  if (record.variants.length > 1) {
    const tabList = document.createElement('div');
    tabList.className = 'variation-tabs';
    tabList.setAttribute('role', 'tablist');
    tabList.setAttribute('aria-label', 'Challenge variations');

    record.variants.forEach((_, i) => {
      const btn = createTabButton(`Variation ${i + 1}`, i === state.selectedVariantIndex, () => {
        stopPlayback(state);
        state.selectedVariantIndex = i;
        state.playbackIndex = 0;
        onChange();
      });
      tabList.append(btn);
    });
    parent.append(tabList);
  } else {
    const sub = document.createElement('h5');
    sub.textContent = 'Variation 1';
    parent.append(sub);
  }

  // Muse proposed change & hypothesis
  const pProp = document.createElement('p');
  pProp.textContent = `Muse proposed change: ${variant.proposedChange}`;
  parent.append(pProp);

  const pHyp = document.createElement('p');
  pHyp.textContent = `Hypothesis: ${variant.experiment.hypothesis}`;
  parent.append(pHyp);

  // Actual step differences
  const diffDetails = document.createElement('details');
  diffDetails.open = true;
  const diffSummary = document.createElement('summary');
  diffSummary.textContent = `Actual step differences from original experiment (${variant.changes.length})`;
  diffDetails.append(diffSummary);

  if (variant.changes.length === 0) {
    const pNoDiff = document.createElement('p');
    pNoDiff.className = 'notice-muted';
    pNoDiff.textContent = 'No step differences detected.';
    diffDetails.append(pNoDiff);
  } else {
    const table = document.createElement('div');
    table.className = 'diff-list';
    variant.changes.forEach(c => {
      const row = document.createElement('div');
      row.className = 'diff-row';
      const label = document.createElement('strong');
      label.textContent = `Step ${c.step}: `;
      const desc = document.createElement('span');
      if (c.before && c.after) {
        desc.className = 'diff-modified';
        desc.textContent = 'modified: ';
        const beforeCode = document.createElement('code');
        beforeCode.className = 'diff-before';
        beforeCode.textContent = JSON.stringify(c.before);
        const arrow = document.createElement('span');
        arrow.textContent = ' -> ';
        const afterCode = document.createElement('code');
        afterCode.className = 'diff-after';
        afterCode.textContent = JSON.stringify(c.after);
        desc.append(beforeCode, arrow, afterCode);
      } else if (c.after) {
        desc.className = 'diff-added';
        desc.textContent = 'added: ';
        const afterCode = document.createElement('code');
        afterCode.className = 'diff-after';
        afterCode.textContent = JSON.stringify(c.after);
        desc.append(afterCode);
      } else if (c.before) {
        desc.className = 'diff-removed';
        desc.textContent = 'removed: ';
        const beforeCode = document.createElement('code');
        beforeCode.className = 'diff-before';
        beforeCode.textContent = JSON.stringify(c.before);
        desc.append(beforeCode);
      }
      row.append(label, desc);
      diffDetails.append(row);
    });
  }
  parent.append(diffDetails);

  // Exact Experiment Steps List
  const stepsHeading = document.createElement('h5');
  stepsHeading.textContent = `Experiment steps (${variant.experiment.steps.length})`;
  parent.append(stepsHeading);

  const stepsList = document.createElement('div');
  stepsList.className = 'experiment-steps-list';
  stepsList.setAttribute('role', 'list');
  stepsList.setAttribute('aria-label', 'Experiment step sequence');

  variant.experiment.steps.forEach((step, idx) => {
    const stepNum = idx + 1;
    // Highlight step only if active playback entry corresponds to this step (exact zero-based matching)
    const isStepActive = activeActionStep !== undefined && activeActionStep === idx;

    const stepItem = document.createElement('div');
    stepItem.className = `step-item ${isStepActive ? 'step-item-active' : ''}`;
    stepItem.setAttribute('role', 'listitem');
    if (isStepActive) {
      stepItem.setAttribute('aria-current', 'step');
    }

    const numSpan = document.createElement('span');
    numSpan.className = 'step-badge';
    numSpan.textContent = `#${stepNum}`;

    const { op, ...detailsObj } = step;
    const opSpan = document.createElement('strong');
    opSpan.textContent = ` ${op} `;

    const detailSpan = document.createElement('span');
    detailSpan.textContent = JSON.stringify(detailsObj);

    stepItem.append(numSpan, opSpan, detailSpan);
    stepsList.append(stepItem);
  });

  parent.append(stepsList);
}

/** Column 2: Actual Executed Code under Test */
function renderSourceColumn(
  parent: HTMLElement,
  record: ChallengeRecord,
  state: VerificationViewState,
  onChange: () => void,
): void {
  const heading = document.createElement('h4');
  heading.textContent = 'Actual code under test';
  parent.append(heading);

  // Target toggle: Candidate vs Clean
  const targetBar = document.createElement('div');
  targetBar.className = 'source-target-bar';
  targetBar.setAttribute('role', 'tablist');
  targetBar.setAttribute('aria-label', 'Source variant target');

  const btnCandidate = createTabButton(`Candidate (${record.binding.target})`, state.selectedSourceTarget === 'candidate', () => {
    state.selectedSourceTarget = 'candidate';
    state.selectedSourceFile = undefined;
    onChange();
  });

  const btnClean = createTabButton('Clean control (clean)', state.selectedSourceTarget === 'clean', () => {
    state.selectedSourceTarget = 'clean';
    state.selectedSourceFile = undefined;
    onChange();
  });

  targetBar.append(btnCandidate, btnClean);
  parent.append(targetBar);

  const bundle = state.selectedSourceTarget === 'candidate'
    ? record.sources?.candidate
    : record.sources?.clean;

  // File selector if multiple files exist
  if (bundle && bundle.files.length > 1) {
    const fileSelector = document.createElement('div');
    fileSelector.className = 'source-file-selector';

    const label = document.createElement('label');
    label.textContent = 'File: ';

    const select = document.createElement('select');
    select.className = 'form-input form-input-xs';
    bundle.files.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.path;
      opt.textContent = f.path;
      if (f.path === (state.selectedSourceFile ?? bundle.files[0]?.path)) {
        opt.selected = true;
      }
      select.append(opt);
    });
    safeAddListener(select, 'change', (e: any) => {
      state.selectedSourceFile = e.target.value;
      onChange();
    });
    label.append(select);
    fileSelector.append(label);
    parent.append(fileSelector);
  }

  // Provenance metadata line
  const meta = document.createElement('div');
  meta.className = 'source-provenance-line';
  const expectedHash = state.selectedSourceTarget === 'candidate' ? record.binding.sourceHash : record.binding.cleanSourceHash;
  const currentHash = bundle?.hash ?? expectedHash;
  meta.textContent = `Verified hash: ${currentHash.slice(0, 16)}… · ${state.selectedSourceTarget === 'candidate' ? record.binding.target : 'clean'}`;
  parent.append(meta);

  // Honest context notice
  const notice = document.createElement('p');
  notice.className = 'source-context-notice';
  notice.textContent = 'Source file is context only; no per-line execution instrumentation.';
  parent.append(notice);

  // Code viewer container
  const codeWrap = document.createElement('div');
  codeWrap.className = 'source-viewer-wrap';
  renderSourceViewer(codeWrap, bundle, state.selectedSourceFile);
  parent.append(codeWrap);
}

/** Column 3: Recorded Execution Results & Interactive Trace Playback */
function renderResultsColumn(
  parent: HTMLElement,
  record: ChallengeRecord,
  variant: ChallengeVariant,
  executionResult: import('../domain.ts').ExperimentResult | undefined,
  trace: TraceEntry[],
  state: VerificationViewState,
  colSteps?: HTMLElement,
  onChange?: () => void,
): void {
  const heading = document.createElement('h4');
  heading.textContent = 'Recorded execution results';
  parent.append(heading);

  // Execution kind tabs: Candidate | Replay | Clean
  const kindBar = document.createElement('div');
  kindBar.className = 'execution-kind-bar';
  kindBar.setAttribute('role', 'tablist');
  kindBar.setAttribute('aria-label', 'Execution simulator output');

  const kinds: Array<'candidate' | 'replay' | 'clean'> = ['candidate', 'replay', 'clean'];
  kinds.forEach(k => {
    const label = k === 'candidate' ? 'Candidate' : k === 'replay' ? 'Replay' : 'Clean control';
    const btn = createTabButton(label, state.selectedExecutionKind === k, () => {
      stopPlayback(state);
      state.selectedExecutionKind = k;
      state.playbackIndex = 0;
      onChange?.();
    });
    kindBar.append(btn);
  });
  parent.append(kindBar);

  // Classification summary card
  const summaryCard = document.createElement('div');
  summaryCard.className = 'verdict-summary-card';

  const pStatus = document.createElement('p');
  pStatus.textContent = `Candidate: ${variant.candidateStatus} · Same invariant (${record.binding.invariant}): ${variant.sameInvariant} · Replay: ${variant.replayStatus} · Clean control: ${variant.cleanStatus}`;
  summaryCard.append(pStatus);

  const pRepro = document.createElement('p');
  pRepro.className = variant.reproduced ? 'verdict-success' : 'verdict-neutral';
  pRepro.textContent = variant.reproduced
    ? 'Same invariant reproduced with matching replay and a verified clean comparison. This observation does not prove root cause.'
    : 'Same invariant reproduction with a verified clean comparison has not been established.';
  summaryCard.append(pRepro);

  if (variant.otherInvariants.length > 0) {
    const pOther = document.createElement('p');
    pOther.textContent = `Other observed invariants: ${variant.otherInvariants.join(', ')}`;
    summaryCard.append(pOther);
  }

  if (variant.clean && variant.clean.violations.length > 0) {
    const pCleanViol = document.createElement('p');
    pCleanViol.className = 'error-text';
    pCleanViol.textContent = `Clean control violations: ${variant.clean.violations.map(v => v.invariant).join(', ')}`;
    summaryCard.append(pCleanViol);
  }

  for (const err of [...variant.errors, ...variant.replayMismatches]) {
    const pErr = document.createElement('p');
    pErr.className = 'error-text';
    pErr.textContent = err;
    summaryCard.append(pErr);
  }

  parent.append(summaryCard);

  // Playback section
  const playbackSection = document.createElement('section');
  playbackSection.className = 'trace-playback-section';
  playbackSection.setAttribute('aria-label', 'Saved trace playback');

  const playTitle = document.createElement('h5');
  playTitle.textContent = 'Saved trace playback';
  playbackSection.append(playTitle);

  const playNotice = document.createElement('p');
  playNotice.className = 'playback-notice';
  playNotice.textContent = 'Plays recorded trace entries only; never contacts Muse or executes code.';
  playbackSection.append(playNotice);

  if (!trace.length) {
    const pEmpty = document.createElement('p');
    pEmpty.className = 'notice-muted';
    pEmpty.textContent = 'Recorded trace is empty or unavailable for this execution.';
    playbackSection.append(pEmpty);
  } else {
    // Controls toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'playback-controls-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Trace playback controls');

    const btnReset = document.createElement('button');
    btnReset.type = 'button';
    btnReset.className = 'btn btn-secondary btn-xs';
    btnReset.setAttribute('aria-label', 'Reset playback to start');
    btnReset.textContent = '<< Reset';

    const btnPrev = document.createElement('button');
    btnPrev.type = 'button';
    btnPrev.className = 'btn btn-secondary btn-xs';
    btnPrev.setAttribute('aria-label', 'Previous trace entry');
    btnPrev.textContent = '< Prev';
    btnPrev.disabled = state.playbackIndex <= 0;

    const btnPlay = document.createElement('button');
    btnPlay.type = 'button';
    btnPlay.className = `btn ${state.isPlaying ? 'btn-danger' : 'btn-primary'} btn-xs`;
    btnPlay.setAttribute('aria-label', state.isPlaying ? 'Pause trace playback' : 'Play trace playback');
    btnPlay.textContent = state.isPlaying ? 'Pause' : 'Play';

    const btnNext = document.createElement('button');
    btnNext.type = 'button';
    btnNext.className = 'btn btn-secondary btn-xs';
    btnNext.setAttribute('aria-label', 'Next trace entry');
    btnNext.textContent = 'Next >';
    btnNext.disabled = state.playbackIndex >= trace.length - 1;

    const counter = document.createElement('span');
    counter.className = 'playback-counter';
    counter.textContent = `Entry ${state.playbackIndex + 1} of ${trace.length}`;

    toolbar.append(btnReset, btnPrev, btnPlay, btnNext, counter);
    playbackSection.append(toolbar);

    // Active entry inspector
    const inspector = document.createElement('div');
    inspector.className = 'trace-entry-inspector';
    renderInspectorContent(inspector, trace[state.playbackIndex], state.playbackIndex, executionResult);
    playbackSection.append(inspector);

    // In-place UI update for stepping and playback: preserves focus and prevents recreating DOM
    const updatePlaybackUI = () => {
      btnPlay.className = `btn ${state.isPlaying ? 'btn-danger' : 'btn-primary'} btn-xs`;
      btnPlay.setAttribute('aria-label', state.isPlaying ? 'Pause trace playback' : 'Play trace playback');
      btnPlay.textContent = state.isPlaying ? 'Pause' : 'Play';
      btnPrev.disabled = state.playbackIndex <= 0;
      btnNext.disabled = state.playbackIndex >= trace.length - 1;
      counter.textContent = `Entry ${state.playbackIndex + 1} of ${trace.length}`;
      renderInspectorContent(inspector, trace[state.playbackIndex], state.playbackIndex, executionResult);

      if (colSteps) {
        const activeEntry = trace[state.playbackIndex];
        const activeStep = activeEntry !== undefined ? activeEntry.step : undefined;
        const stepItems = colSteps.querySelectorAll('.step-item');
        stepItems.forEach((item, idx) => {
          const isStepActive = activeStep !== undefined && activeStep === idx;
          if (isStepActive) {
            addClass(item, 'step-item-active');
            item.setAttribute('aria-current', 'step');
          } else {
            removeClass(item, 'step-item-active');
            item.removeAttribute('aria-current');
          }
        });
      }
    };

    safeAddListener(btnReset, 'click', () => {
      stopPlayback(state);
      state.playbackIndex = 0;
      updatePlaybackUI();
    });

    safeAddListener(btnPrev, 'click', () => {
      stopPlayback(state);
      state.playbackIndex = Math.max(0, state.playbackIndex - 1);
      updatePlaybackUI();
    });

    safeAddListener(btnPlay, 'click', () => {
      if (state.isPlaying) {
        stopPlayback(state);
        updatePlaybackUI();
      } else {
        if (state.playbackIndex >= trace.length - 1) {
          state.playbackIndex = 0;
        }
        state.isPlaying = true;
        state.playbackTimer = setInterval(() => {
          if (!state.isPlaying) {
            stopPlayback(state);
            return;
          }
          if (state.playbackIndex < trace.length - 1) {
            state.playbackIndex++;
            updatePlaybackUI();
          } else {
            stopPlayback(state);
            updatePlaybackUI();
          }
        }, 600);
        updatePlaybackUI();
      }
    });

    safeAddListener(btnNext, 'click', () => {
      stopPlayback(state);
      state.playbackIndex = Math.min(trace.length - 1, state.playbackIndex + 1);
      updatePlaybackUI();
    });

    // Full trace details expandable
    appendJsonDetails(playbackSection, `${state.selectedExecutionKind}: full trace, snapshot, violations and rejections`, executionResult);
  }

  parent.append(playbackSection);
}

function renderInspectorContent(
  inspector: HTMLElement,
  entry: TraceEntry | undefined,
  playbackIndex: number,
  executionResult?: import('../domain.ts').ExperimentResult,
): void {
  inspector.replaceChildren();
  if (!entry) return;

  const entryHead = document.createElement('div');
  entryHead.className = 'entry-inspector-head';
  const displayStep = entry.step !== undefined ? entry.step + 1 : '—';
  entryHead.textContent = `Entry #${playbackIndex + 1} · Action Step ${displayStep} · Time: ${entry.time} · Outcome: ${entry.outcome}`;
  inspector.append(entryHead);

  const entryAction = document.createElement('div');
  entryAction.textContent = `Action: ${entry.action}${entry.messageId ? ` · msgId: ${entry.messageId}` : ''}`;
  inspector.append(entryAction);

  if (entry.payload !== undefined) {
    appendJsonDetails(inspector, 'Payload facts', entry.payload);
  }

  if (entry.state) {
    appendJsonDetails(inspector, 'Recorded state', entry.state, true);
  }

  // Violations at this step or in this execution
  if (executionResult?.violations && executionResult.violations.length > 0) {
    const violWrap = document.createElement('div');
    violWrap.className = 'step-violations-wrap';

    const violHead = document.createElement('strong');
    violHead.textContent = 'Observed violations: ';
    violWrap.append(violHead);

    executionResult.violations.forEach(v => {
      const vTag = document.createElement('span');
      vTag.className = `violation-badge ${v.step === entry.step ? 'violation-badge-current' : ''}`;
      vTag.textContent = `${v.invariant}${v.step !== undefined ? ` (step ${v.step + 1})` : ''}: ${v.message}`;
      violWrap.append(vTag);
    });
    inspector.append(violWrap);
  }
}

/** Footer: Muse interpretation & token accounting */
function renderVerificationFooter(parent: HTMLElement, record: ChallengeRecord): void {
  const footer = document.createElement('footer');
  footer.className = 'verification-footer';

  renderChallengeInterpretation(footer, record.interpretation);

  appendJsonDetails(footer, 'Challenge model requests and reported usage (null means unknown)', record.requests);

  if (record.proposalResponse) {
    appendJsonDetails(footer, 'Model proposal response (untrusted text)', record.proposalResponse);
  }

  // Exact identities
  appendJsonDetails(footer, 'Exact run, finding, experiment and source identities', record.binding);

  parent.append(footer);
}
