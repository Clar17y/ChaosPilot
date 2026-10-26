import type {
  InvestigationRecord,
  ExperimentRecord,
  Finding,
  TargetVariant,
  ProviderKind,
} from '../domain.ts';
import type { RunSummary, ReplayReport } from '../storage.ts';
import { extractSnapshotDisplay } from './snapshot.ts';
import { describeProposals } from './proposals.ts';

interface ServerStatusResponse {
  active: boolean;
  status: 'idle' | 'starting' | 'running' | 'stopping';
  id?: string;
  startedAt?: string;
  currentRecord?: InvestigationRecord | null;
  metaKeyConfigured: boolean;
}

// State
let pollTimer: ReturnType<typeof setInterval> | null = null;
let currentInvestigationRecord: InvestigationRecord | null = null;
let selectedExperimentIndex = 0;
let consecutivePollErrors = 0;
const MAX_POLL_ERRORS = 5;
let isInspectingHistory = false;

// DOM Elements
const targetSelect = document.getElementById('target-select') as HTMLSelectElement;
const providerSelect = document.getElementById('provider-select') as HTMLSelectElement;
const maxExperimentsInput = document.getElementById('max-experiments-input') as HTMLInputElement;
const btnLaunch = document.getElementById('btn-launch') as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
const btnRefreshHistory = document.getElementById('btn-refresh-history') as HTMLButtonElement;
const provenanceBadge = document.getElementById('provenance-badge') as HTMLElement;
const provenanceLabel = document.getElementById('provenance-label') as HTMLElement;
const statusPill = document.getElementById('status-pill') as HTMLElement;
const statusText = document.getElementById('status-text') as HTMLElement;
const metaKeyHint = document.getElementById('meta-key-hint') as HTMLElement;
const alertBanner = document.getElementById('alert-banner') as HTMLElement;
const alertMessage = document.getElementById('alert-message') as HTMLElement;
const alertClose = document.getElementById('alert-close') as HTMLButtonElement;

// Metric Elements
const metricStatus = document.getElementById('metric-status') as HTMLElement;
const metricExperiments = document.getElementById('metric-experiments') as HTMLElement;
const metricFindings = document.getElementById('metric-findings') as HTMLElement;
const metricUsage = document.getElementById('metric-usage') as HTMLElement;
const dashRunId = document.getElementById('dash-run-id') as HTMLElement;
const dashTarget = document.getElementById('dash-target') as HTMLElement;
const dashTime = document.getElementById('dash-time') as HTMLElement;
const dashModel = document.getElementById('dash-model') as HTMLElement;

// Tab counts
const countFindings = document.getElementById('count-findings') as HTMLElement;
const countExperiments = document.getElementById('count-experiments') as HTMLElement;
const countProposals = document.getElementById('count-proposals') as HTMLElement;
const proposalsContainer = document.getElementById('proposals-container') as HTMLElement;
const proposalSummary = document.getElementById('proposal-summary') as HTMLElement;
const runNotes = document.getElementById('run-notes') as HTMLElement;

// Tab containers
const findingsContainer = document.getElementById('findings-container') as HTMLElement;
const experimentsContainer = document.getElementById('experiments-container') as HTMLElement;
const traceContainer = document.getElementById('trace-container') as HTMLElement;
const traceTitle = document.getElementById('trace-title') as HTMLElement;
const traceExpSelectorLabel = document.getElementById('trace-exp-selector-label') as HTMLElement;
const creditStateTable = document.getElementById('credit-state-table') as HTMLElement;
const ordersStateTable = document.getElementById('orders-state-table') as HTMLElement;
const historyTbody = document.getElementById('history-tbody') as HTMLElement;

// Replay Modal
const replayModal = document.getElementById('replay-modal') as HTMLElement;
const replayReportBody = document.getElementById('replay-report-body') as HTMLElement;
const btnCloseReplay = document.getElementById('btn-close-replay') as HTMLButtonElement;

function showAlert(message: string): void {
  alertMessage.textContent = message;
  alertBanner.classList.remove('hidden');
}

function hideAlert(): void {
  alertBanner.classList.add('hidden');
  alertMessage.textContent = '';
}

function updateProvenanceBadge(mode: 'mock' | 'live' | 'replay'): void {
  provenanceBadge.className = 'provenance-badge';
  if (mode === 'live') {
    provenanceBadge.classList.add('badge-live');
    provenanceLabel.textContent = 'PROVENANCE: LIVE (Meta API)';
  } else if (mode === 'replay') {
    provenanceBadge.classList.add('badge-replay');
    provenanceLabel.textContent = 'PROVENANCE: REPLAY (Deterministic)';
  } else {
    provenanceBadge.classList.add('badge-mock');
    provenanceLabel.textContent = 'PROVENANCE: MOCK (Scripted)';
  }
}

function updateStatusPill(status: string): void {
  statusPill.className = 'status-pill';
  const norm = status.toLowerCase();
  statusText.textContent = norm.toUpperCase();

  if (norm === 'running') {
    statusPill.classList.add('status-running');
  } else if (norm === 'stopping') {
    statusPill.classList.add('status-stopping');
  } else if (norm === 'completed') {
    statusPill.classList.add('status-completed');
  } else if (norm === 'failed' || norm === 'cancelled') {
    statusPill.classList.add('status-failed');
  } else {
    statusPill.classList.add('status-idle');
  }
}

async function fetchStatus(): Promise<void> {
  try {
    const res = await fetch('/api/status', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: ServerStatusResponse = await res.json();
    consecutivePollErrors = 0;

    // Update UI controls based on active state
    if (data.active) {
      btnLaunch.disabled = true;
      btnStop.disabled = data.status === 'stopping';
      if (!isInspectingHistory) {
        updateStatusPill(data.status);
        metricStatus.textContent = data.status.toUpperCase();
      }
    } else {
      btnLaunch.disabled = false;
      btnStop.disabled = true;
      if (!isInspectingHistory) {
        const status = data.currentRecord?.status ?? 'idle';
        updateStatusPill(status);
        metricStatus.textContent = status.toUpperCase();
      }
    }

    // Toggle hint for meta key
    if (providerSelect.value === 'meta' && !data.metaKeyConfigured) {
      metaKeyHint.classList.remove('hidden');
    } else {
      metaKeyHint.classList.add('hidden');
    }

    if (!isInspectingHistory && data.currentRecord) {
      currentInvestigationRecord = data.currentRecord;
      renderActiveRecord(data.currentRecord);
    }

    // Bounded polling control: if not active, slow down polling
    if (!data.active && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      loadHistory();
    }
  } catch (err) {
    consecutivePollErrors++;
    if (consecutivePollErrors > MAX_POLL_ERRORS && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      showAlert('Polling suspended due to network or server errors.');
    }
  }
}

function startPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  consecutivePollErrors = 0;
  pollTimer = setInterval(fetchStatus, 800);
}

function renderActiveRecord(rec: InvestigationRecord): void {
  dashRunId.textContent = `Run ID: ${rec.id}`;
  dashTarget.textContent = `Variant: ${rec.variant}`;
  dashTime.textContent = `Started: ${new Date(rec.startedAt).toLocaleTimeString()}`;
  dashModel.textContent = `Model: ${rec.model}`;

  updateProvenanceBadge(rec.mode);
  updateStatusPill(rec.status);
  metricStatus.textContent = rec.status.toUpperCase();
  metricExperiments.textContent = `${rec.experiments.length} executed`;
  metricFindings.textContent = `${rec.findings.length}`;

  countFindings.textContent = `${rec.findings.length}`;
  countExperiments.textContent = `${rec.experiments.length}`;

  if (rec.usage) {
    const cost = (rec.usage.estimatedCostUsd || 0).toFixed(4);
    metricUsage.textContent = `${rec.usage.inputTokens} in / ${rec.usage.outputTokens} out ($${cost})`;
  }

  if (selectedExperimentIndex >= rec.experiments.length) {
    selectedExperimentIndex = 0;
  }

  renderFindings(rec.findings);
  renderExperiments(rec.experiments);
  renderProposals(rec);
  renderSelectedExperimentTrace();
}

function renderProposals(rec: InvestigationRecord): void {
  const display = describeProposals(rec);
  countProposals.textContent = display.count === null ? '—' : String(display.count);
  proposalSummary.textContent = display.summary + (display.unknownCost
    ? ' Some request usage is unknown. Reported token costs exclude it; the application retains a conservative allowance.' : '');
  runNotes.textContent = [rec.stopReason, ...rec.errors].filter(Boolean).join('\n');

  const openKeys = new Set(Array.from(proposalsContainer.querySelectorAll<HTMLDetailsElement>('details[open]'))
    .map(el => el.dataset.proposalKey));
  proposalsContainer.textContent = '';
  for (const attempt of rec.proposalAttempts ?? []) {
    const key = `attempt-${attempt.index}`;
    const card = document.createElement('details');
    card.className = 'proposal-card';
    card.dataset.proposalKey = key;
    card.open = openKeys.has(key);
    const heading = document.createElement('summary');
    const elapsed = typeof attempt.durationMs === 'number' ? ` · ${(attempt.durationMs / 1000).toFixed(2)}s` : '';
    heading.textContent = `Proposal #${attempt.index} · ${attempt.status.replaceAll('_', ' ')}${elapsed}`;
    card.appendChild(heading);

    const facts = document.createElement('p');
    const sent = attempt.requestSent === true ? 'attempted' : attempt.requestSent === false ? 'not sent' : 'not recorded';
    facts.textContent = `Experiment slot ${attempt.experimentNumber}, correction ${attempt.correctionNumber}. Network request: ${sent}. Usage: ${attempt.usageKnown ? 'reported' : 'unknown'}.`;
    card.appendChild(facts);
    if (attempt.error) {
      const error = document.createElement('p');
      error.textContent = attempt.error;
      card.appendChild(error);
    }
    for (const [label, data, suffix] of [
      ['Prepared request audit', attempt.request, 'request'],
      ['Visible model response', attempt.response, 'response']
    ] as const) {
      if (!data) continue;
      const section = document.createElement('details');
      const sectionKey = `${key}-${suffix}`;
      section.dataset.proposalKey = sectionKey;
      section.open = openKeys.has(sectionKey);
      const title = document.createElement('summary');
      title.textContent = label;
      const content = document.createElement('pre');
      content.textContent = JSON.stringify(data, null, 2);
      section.append(title, content);
      card.appendChild(section);
    }
    proposalsContainer.appendChild(card);
  }
}

function renderFindings(findings: Finding[]): void {
  findingsContainer.textContent = '';
  if (!findings || findings.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No invariant violations or findings confirmed.';
    findingsContainer.appendChild(empty);
    return;
  }

  for (let i = 0; i < findings.length; i++) {
    const f = findings[i]!;
    const item = document.createElement('div');
    item.className = 'finding-item';

    const titleRow = document.createElement('div');
    titleRow.className = 'finding-title-row';

    const titleEl = document.createElement('div');
    titleEl.className = 'finding-title';
    titleEl.textContent = `[Finding #${i + 1}] ${f.title}`;

    const badges = document.createElement('div');
    badges.className = 'finding-badges';

    const invPill = document.createElement('span');
    invPill.className = 'pill-badge pill-invariant';
    invPill.textContent = f.violation.invariant;
    badges.appendChild(invPill);

    const replayPill = document.createElement('span');
    replayPill.className = f.reproduced
      ? 'pill-badge pill-pass'
      : 'pill-badge pill-fail';
    replayPill.textContent = f.reproduced ? 'REPLAY VERIFIED' : 'REPLAY FAILED';
    badges.appendChild(replayPill);

    const cleanPill = document.createElement('span');
    cleanPill.className = f.cleanControlPassed
      ? 'pill-badge pill-pass'
      : 'pill-badge pill-fail';
    cleanPill.textContent = f.cleanControlPassed
      ? 'CLEAN CONTROL: PASSED'
      : 'CLEAN CONTROL: FALSE POSITIVE';
    badges.appendChild(cleanPill);

    titleRow.appendChild(titleEl);
    titleRow.appendChild(badges);

    const descEl = document.createElement('div');
    descEl.className = 'finding-desc';
    descEl.textContent = f.violation.message;

    const metaEl = document.createElement('div');
    metaEl.className = 'finding-meta';
    metaEl.textContent = `Hypothesis: "${f.hypothesis}" | Step: ${f.violation.step}${f.violation.orderId ? ` | Order: ${f.violation.orderId}` : ''}`;

    item.appendChild(titleRow);
    item.appendChild(descEl);
    item.appendChild(metaEl);

    findingsContainer.appendChild(item);
  }
}

function renderExperiments(experiments: ExperimentRecord[]): void {
  experimentsContainer.textContent = '';
  if (!experiments || experiments.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No experiments executed yet.';
    experimentsContainer.appendChild(empty);
    return;
  }

  for (let i = 0; i < experiments.length; i++) {
    const expRec = experiments[i]!;
    const item = document.createElement('div');
    item.className = 'exp-item';
    if (i === selectedExperimentIndex) {
      item.classList.add('selected');
    }

    const left = document.createElement('div');
    left.className = 'exp-item-left';

    const indexEl = document.createElement('span');
    indexEl.className = 'exp-index';
    indexEl.textContent = `#${i + 1}`;

    const hypEl = document.createElement('span');
    hypEl.className = 'exp-hypothesis';
    hypEl.textContent = expRec.experiment.hypothesis;

    left.appendChild(indexEl);
    left.appendChild(hypEl);

    const right = document.createElement('div');
    right.className = 'finding-badges';

    const statusPill = document.createElement('span');
    const hasViolations = expRec.result.violations && expRec.result.violations.length > 0;
    if (hasViolations) {
      statusPill.className = 'pill-badge pill-fail';
      statusPill.textContent = `${expRec.result.violations.length} VIOLATION(S)`;
    } else if (expRec.result.valid) {
      statusPill.className = 'pill-badge pill-pass';
      statusPill.textContent = 'VALID (0 VIOLATIONS)';
    } else {
      statusPill.className = 'pill-badge pill-fail';
      statusPill.textContent = 'INVALID PLAN';
    }
    right.appendChild(statusPill);

    item.appendChild(left);
    item.appendChild(right);

    item.addEventListener('click', () => {
      selectedExperimentIndex = i;
      renderExperiments(experiments);
      renderSelectedExperimentTrace();
    });

    experimentsContainer.appendChild(item);
  }
}

function renderSelectedExperimentTrace(): void {
  traceContainer.textContent = '';
  creditStateTable.textContent = '';
  ordersStateTable.textContent = '';

  if (!currentInvestigationRecord || !currentInvestigationRecord.experiments[selectedExperimentIndex]) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No experiment selected.';
    traceContainer.appendChild(empty);
    return;
  }

  const expRec = currentInvestigationRecord.experiments[selectedExperimentIndex]!;
  traceTitle.textContent = `Experiment #${selectedExperimentIndex + 1} Action Trace`;
  traceExpSelectorLabel.textContent = `Hypothesis: ${expRec.experiment.hypothesis}`;

  const trace = expRec.result.trace || [];
  if (trace.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No trace entries recorded for this experiment.';
    traceContainer.appendChild(empty);
  } else {
    for (const entry of trace) {
      const stepEl = document.createElement('div');
      stepEl.className = 'trace-step';
      if (entry.outcome && entry.outcome.includes('VIOLATION')) {
        stepEl.classList.add('violation');
      }

      const sStep = document.createElement('span');
      sStep.textContent = `Step ${entry.step}`;

      const sTime = document.createElement('span');
      sTime.textContent = entry.businessTime !== undefined
        ? `t_del=${entry.time} | t_bus=${entry.businessTime}`
        : `t=${entry.time}`;

      const sAction = document.createElement('span');
      sAction.textContent = entry.action;

      const sPayload = document.createElement('span');
      sPayload.textContent = entry.payload ? JSON.stringify(entry.payload) : (entry.messageId || '-');

      const sOutcome = document.createElement('span');
      sOutcome.textContent = entry.outcome;

      stepEl.appendChild(sStep);
      stepEl.appendChild(sTime);
      stepEl.appendChild(sAction);
      stepEl.appendChild(sPayload);
      stepEl.appendChild(sOutcome);

      traceContainer.appendChild(stepEl);
    }
  }

  // Render snapshot state using pure display model
  const displayModel = extractSnapshotDisplay(expRec.result.snapshot);

  const creditEntries: [string, string][] = [
    ['quotePrice', displayModel.credit.quotePrice],
    ['creditLimit', displayModel.credit.creditLimit],
    ['reservedCredit', displayModel.credit.reservedCredit],
    ['usedCredit', displayModel.credit.usedCredit],
    ['availableCredit', displayModel.credit.availableCredit],
  ];

  for (const [k, val] of creditEntries) {
    const row = document.createElement('div');
    row.className = 'kv-row';
    const keySpan = document.createElement('span');
    keySpan.textContent = k;
    const valSpan = document.createElement('span');
    valSpan.textContent = val;
    row.appendChild(keySpan);
    row.appendChild(valSpan);
    creditStateTable.appendChild(row);
  }

  // Orders
  if (!displayModel.hasOrders) {
    const emptyOrders = document.createElement('div');
    emptyOrders.className = 'empty-state';
    emptyOrders.textContent = 'No orders active in snapshot.';
    ordersStateTable.appendChild(emptyOrders);
  } else {
    for (const ord of displayModel.orders) {
      const row = document.createElement('div');
      row.className = 'kv-row';
      const keySpan = document.createElement('span');
      keySpan.textContent = ord.orderId;
      const valSpan = document.createElement('span');
      valSpan.textContent = ord.displayText;
      row.appendChild(keySpan);
      row.appendChild(valSpan);
      ordersStateTable.appendChild(row);
    }
  }
}

async function loadHistory(): Promise<void> {
  try {
    const res = await fetch('/api/runs');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const runs: RunSummary[] = await res.json();

    historyTbody.textContent = '';
    if (runs.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 8;
      td.className = 'text-center';
      td.textContent = 'No persisted run artifacts found.';
      tr.appendChild(td);
      historyTbody.appendChild(tr);
      return;
    }

    for (const r of runs) {
      const tr = document.createElement('tr');

      const tdId = document.createElement('td');
      tdId.textContent = r.id;

      const tdTarget = document.createElement('td');
      tdTarget.textContent = r.variant;

      const tdProv = document.createElement('td');
      tdProv.textContent = `${r.provider} (${r.mode})`;

      const tdStatus = document.createElement('td');
      tdStatus.textContent = r.status.toUpperCase();

      const tdExps = document.createElement('td');
      tdExps.textContent = `${r.experimentsCount}`;

      const tdFindings = document.createElement('td');
      tdFindings.textContent = `${r.findingsCount}`;

      const tdTime = document.createElement('td');
      tdTime.textContent = new Date(r.startedAt).toLocaleString();

      const tdActions = document.createElement('td');
      const actionGroup = document.createElement('div');
      actionGroup.className = 'action-btns';

      const btnView = document.createElement('button');
      btnView.className = 'btn btn-secondary btn-xs';
      btnView.textContent = 'View';
      btnView.addEventListener('click', async () => {
        const runRes = await fetch(`/api/runs/${r.id}`);
        if (runRes.ok) {
          const rec: InvestigationRecord = await runRes.json();
          isInspectingHistory = true;
          selectedExperimentIndex = 0;
          currentInvestigationRecord = rec;
          renderActiveRecord(rec);
          window.scrollTo({ top: 200, behavior: 'smooth' });
        }
      });

      const btnReplay = document.createElement('button');
      btnReplay.className = 'btn btn-primary btn-xs';
      btnReplay.textContent = 'Replay';
      btnReplay.addEventListener('click', async () => {
        btnReplay.disabled = true;
        try {
          const replayRes = await fetch(`/api/runs/${r.id}/replay`, { method: 'POST' });
          if (!replayRes.ok) {
            const err = await replayRes.json();
            throw new Error(err.error || 'Replay failed');
          }
          const repReport: ReplayReport = await replayRes.json();
          showReplayReport(repReport);
        } catch (e) {
          showAlert(`Replay failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          btnReplay.disabled = false;
        }
      });

      const btnExport = document.createElement('button');
      btnExport.className = 'btn btn-secondary btn-xs';
      btnExport.textContent = 'Export JSON';
      btnExport.addEventListener('click', async () => {
        const runRes = await fetch(`/api/runs/${r.id}`);
        if (runRes.ok) {
          const jsonText = await runRes.text();
          const blob = new Blob([jsonText], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${r.id}.json`;
          a.click();
          URL.revokeObjectURL(url);
        }
      });

      actionGroup.appendChild(btnView);
      actionGroup.appendChild(btnReplay);
      actionGroup.appendChild(btnExport);
      tdActions.appendChild(actionGroup);

      tr.appendChild(tdId);
      tr.appendChild(tdTarget);
      tr.appendChild(tdProv);
      tr.appendChild(tdStatus);
      tr.appendChild(tdExps);
      tr.appendChild(tdFindings);
      tr.appendChild(tdTime);
      tr.appendChild(tdActions);

      historyTbody.appendChild(tr);
    }
  } catch (err) {
    showAlert(`Failed to load history: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function showReplayReport(report: ReplayReport): void {
  replayReportBody.textContent = '';

  const addLine = (label: string, value: string, highlight?: boolean) => {
    const row = document.createElement('div');
    row.className = 'kv-row';
    const lSpan = document.createElement('span');
    lSpan.textContent = label;
    const vSpan = document.createElement('span');
    vSpan.textContent = value;
    if (highlight) vSpan.className = 'highlight';
    row.appendChild(lSpan);
    row.appendChild(vSpan);
    replayReportBody.appendChild(row);
  };

  addLine('Replayed Run ID:', report.runId);
  addLine('Target Variant:', report.variant);
  addLine('Original Source Hash:', report.originalSourceHash);
  addLine('Current Source Hash:', report.currentSourceHash);
  addLine('Source Identical Match:', report.sourceIdentical ? 'YES' : 'NO (Source changed)');
  addLine('Exact Reproduction Claimed:', report.exactReproductionClaimed ? 'CONFIRMED' : 'CANNOT BE CLAIMED', !report.exactReproductionClaimed);
  addLine('Experiments Matched:', `${report.experimentsReproduced} / ${report.experimentsTotal}`);
  addLine('Deterministic Replay Result:', report.reproduced ? 'ALL EXPERIMENTS REPRODUCED' : 'MISMATCH DETECTED');
  addLine('Replay Engine:', 'Local Deterministic Simulator (No model invocation)');

  const noteEl = document.createElement('div');
  noteEl.className = 'provenance-notice';
  noteEl.textContent = report.note || '';
  replayReportBody.appendChild(noteEl);

  replayModal.classList.remove('hidden');
}

// Event Listeners
btnLaunch.addEventListener('click', async () => {
  hideAlert();
  isInspectingHistory = false;
  selectedExperimentIndex = 0;
  const variant = targetSelect.value as TargetVariant;
  const provider = providerSelect.value as ProviderKind;
  const maxExperiments = parseInt(maxExperimentsInput.value, 10) || 5;

  btnLaunch.disabled = true;

  try {
    const res = await fetch('/api/investigation/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ variant, provider, maxExperiments }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    startPolling();
  } catch (err) {
    btnLaunch.disabled = false;
    showAlert(`Failed to start investigation: ${err instanceof Error ? err.message : String(err)}`);
  }
});

btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  try {
    const res = await fetch('/api/investigation/stop', { method: 'POST' });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to stop');
    }
  } catch (err) {
    showAlert(`Failed to stop investigation: ${err instanceof Error ? err.message : String(err)}`);
  }
});

btnRefreshHistory.addEventListener('click', () => {
  loadHistory();
});

alertClose.addEventListener('click', () => {
  hideAlert();
});

btnCloseReplay.addEventListener('click', () => {
  replayModal.classList.add('hidden');
});

providerSelect.addEventListener('change', () => {
  fetchStatus();
});

// Tab switching
const tabButtons = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabButtons.forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));

    btn.classList.add('active');
    const targetId = btn.getAttribute('data-tab');
    if (targetId) {
      const pane = document.getElementById(targetId);
      if (pane) pane.classList.add('active');
    }
  });
});

// Initialization
fetchStatus();
loadHistory();
startPolling();
