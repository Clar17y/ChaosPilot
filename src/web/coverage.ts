import type { InvestigationRecord, ExperimentResult } from '../domain.ts';
import type {
  CoverageContext, CoveragePlan, CoveragePlanIntention, CoveragePlanValidation, CoveragePreparation, CoveragePreparationInput,
  CoverageProjection, CoverageRecordFields, CoverageResultFields, CoverageScenarioId, CoverageStatus,
} from '../coverage/types.ts';
import { COVERAGE_CATALOG, COVERAGE_EVALUATOR, RECOVERY_ADAPTER_ID } from '../coverage/identity.ts';
import { isRecord, sameContext, sameIdentity, validContext } from '../coverage/catalog.ts';
import { prepareCoverage } from '../coverage/prepare.ts';
import { buildCoveragePlan, validateCoveragePlan } from '../coverage/plan.ts';
import { projectCoverage } from '../coverage/project.ts';

export interface CoverageViewContext {
  systemId: string | null;
  revision: number | null;
  selectedAdapterId: string | null;
  selectedVariant: string | null;
  snapshotHash?: string;
  sourceHash?: string;
  contractHash?: string;
  isDraftMode: boolean;
  hasUnsavedSystemEdits: boolean;
  isSystemSavePending?: boolean;
  isContextReady?: boolean;
  requirements?: readonly string[];
  requirementRules?: readonly { requirement: string; preset: string; reviewed: boolean }[];
  contractRuleIds?: readonly string[];
}
export interface CoverageViewState {
  context: CoverageViewContext | null;
  preparationPending: boolean;
  preparation: CoveragePreparation | null;
  preparationError: string | null;
  reviewedIntentions: Record<string, boolean>;
  plan: CoveragePlan | null;
  planValidation: CoveragePlanValidation | null;
  blockedReason: string | null;
  backendEndpointAvailable: boolean | null;
  selectedRunId: string | null;
  projectionPending: boolean;
  projection: CoverageProjection | null;
  projectionError: string | null;
}
type Fetch = (url: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;
export interface CoverageLaunchToken {
  generation: number;
  inspection: number;
  context: CoverageViewContext;
  preparation: CoveragePreparationInput | null;
  plan?: CoveragePlan;
}
class HttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
function eligible(c: CoverageViewContext | null): c is CoverageViewContext & { systemId: string; revision: number; selectedAdapterId: string; selectedVariant: string } {
  return Boolean(c?.systemId && c.revision && c.selectedAdapterId && c.selectedVariant && !c.isDraftMode && !c.hasUnsavedSystemEdits && !c.isSystemSavePending && c.isContextReady !== false);
}
function preparationInput(c: CoverageViewContext, context: CoverageContext): CoveragePreparationInput {
  return { context, requirements: c.requirements ?? [], requirementRules: c.requirementRules ?? [], contractRuleIds: c.contractRuleIds ?? [] };
}
/** Fetch-injected owner of preparation and coverage inspection. App-owned history
 * and record sequencers continue to own navigation; there is no second poller. */
export class CoverageController {
  readonly state: CoverageViewState = {
    context: null, preparationPending: false, preparation: null, preparationError: null, reviewedIntentions: {},
    plan: null, planValidation: null, blockedReason: 'SELECT A SAVED SYSTEM PROFILE', backendEndpointAvailable: null,
    selectedRunId: null, projectionPending: false, projection: null, projectionError: null,
  };
  private generation = 0;
  private inspection = 0;
  private prepareRequest = 0;
  constructor(private readonly fetchFn: Fetch, private readonly render: (state: CoverageViewState) => void) {}
  setContext(context: CoverageViewContext): Promise<void> | null {
    if (JSON.stringify(context) === JSON.stringify(this.state.context)) return null;
    this.generation++; this.inspection++; this.prepareRequest++;
    Object.assign(this.state, { context: structuredClone(context), preparationPending: false, preparation: null, preparationError: null,
      reviewedIntentions: {}, plan: null, planValidation: null, backendEndpointAvailable: null,
      selectedRunId: null, projectionPending: false, projection: null, projectionError: null });
    this.publish();
    return eligible(context) ? this.prepare() : null;
  }
  private publish(): void {
    const c = this.state.context;
    this.state.blockedReason = !eligible(c) ? 'SELECT A SAVED, UNCHANGED PROFILE AND CONFIRMED TARGET'
      : c.selectedAdapterId === RECOVERY_ADAPTER_ID && (!this.state.plan?.intentions.length || !this.state.planValidation?.valid || this.state.backendEndpointAvailable !== true)
        ? 'RECOVERY LAUNCH REQUIRES VALID PREPARATION AND A REVIEWED PLAN'
        : Object.values(this.state.reviewedIntentions).some(Boolean) && (!this.state.plan || !this.state.planValidation?.valid) ? 'REVIEWED COVERAGE PLAN IS NOT VALID' : null;
    this.render(this.state);
  }
  private async json(url: string, init?: RequestInit): Promise<unknown> {
    const res = await this.fetchFn(url, init);
    const data: unknown = await res.json();
    if (!res.ok) throw new HttpError(isRecord(data) && typeof data.error === 'string' ? data.error : `HTTP ${res.status}`, res.status);
    return data;
  }
  async prepare(): Promise<void> {
    const c = this.state.context;
    if (!eligible(c)) return;
    const generation = this.generation, request = ++this.prepareRequest;
    const current = () => generation === this.generation && request === this.prepareRequest;
    Object.assign(this.state, { preparationPending: true, preparation: null, plan: null, planValidation: null, reviewedIntentions: {}, preparationError: null });
    this.publish();
    try {
      const data = await this.json('/api/coverage/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemId: c.systemId, expectedRevision: c.revision, adapterId: c.selectedAdapterId, variant: c.selectedVariant }) });
      if (!current()) return;
      if (!isRecord(data) || !validContext(data.context) || !sameIdentity(data.catalog, COVERAGE_CATALOG) || !sameIdentity(data.evaluator, COVERAGE_EVALUATOR)
        || data.context.systemId !== c.systemId || data.context.revision !== c.revision || data.context.adapterId !== c.selectedAdapterId || data.context.variant !== c.selectedVariant
        )
        throw new Error('Coverage preparation does not match the selected saved context');
      const responseContext = data.context;
      if ((['snapshotHash', 'sourceHash', 'contractHash'] as const).some(k => c[k] !== undefined && c[k] !== responseContext[k]))
        throw new Error('Coverage preparation hash differs from the selected saved context');
      const canonical = prepareCoverage(preparationInput(c, data.context));
      if (JSON.stringify(data.suggestions) !== JSON.stringify(canonical.suggestions) || JSON.stringify(data.contextOnly) !== JSON.stringify(canonical.contextOnly))
        throw new Error('Coverage preparation has unsupported scenarios or requirement links');
      this.state.backendEndpointAvailable = true;
      this.state.preparation = canonical;
      this.state.reviewedIntentions = Object.fromEntries(canonical.suggestions.map(s => [s.scenarioId, false]));
    } catch (error) {
      if (!current()) return;
      if (error instanceof HttpError && error.status === 404) {
        this.state.backendEndpointAvailable = false;
        this.state.preparationError = 'Coverage preparation is unavailable. Supported investigations can still run without a coverage plan. Recovery requires preparation.';
      } else this.state.preparationError = String(error);
    } finally {
      if (current()) { this.state.preparationPending = false; this.recomputePlan(); this.publish(); }
    }
  }
  toggleIntention(scenarioId: CoverageScenarioId, reviewed: boolean): void {
    if (!this.state.preparation?.suggestions.some(s => s.scenarioId === scenarioId)) return;
    this.state.reviewedIntentions[scenarioId] = reviewed;
    this.recomputePlan(); this.publish();
  }
  private recomputePlan(): void {
    const prep = this.state.preparation, c = this.state.context;
    if (!prep || !eligible(c)) { this.state.plan = null; this.state.planValidation = null; return; }
    const intentions: CoveragePlanIntention[] = prep.suggestions.filter(s => this.state.reviewedIntentions[s.scenarioId] === true)
      .map(s => ({ scenarioId: s.scenarioId, reviewed: true, links: structuredClone(s.links) }));
    const validation = buildCoveragePlan({ preparation: preparationInput(c, prep.context), intentions });
    this.state.planValidation = validation;
    this.state.plan = validation.valid ? validation.plan! : null;
  }
  getLaunchPlan(): CoveragePlan | undefined {
    return eligible(this.state.context) && this.state.backendEndpointAvailable === true && this.state.planValidation?.valid && this.state.plan
      ? structuredClone(this.state.plan) : undefined;
  }
  captureLaunch(): CoverageLaunchToken {
    const c = this.state.context;
    if (!eligible(c) || this.state.blockedReason) throw new Error(this.state.blockedReason ?? 'Coverage context is unavailable');
    const plan = this.getLaunchPlan();
    if (Object.values(this.state.reviewedIntentions).some(Boolean) && !plan) throw new Error('Reviewed coverage plan cannot be discarded at launch');
    return { generation: this.generation, inspection: this.inspection, context: structuredClone(c),
      preparation: this.state.preparation ? preparationInput(c, this.state.preparation.context) : null, plan };
  }
  /** Successful HTTP start must settle global lifecycle even on identity error.
   * This boundary only authorizes inspection/coverage; it never patches a run. */
  validateLaunchResponse(value: unknown, token: CoverageLaunchToken): { current: boolean; error?: string } {
    const current = token.generation === this.generation && token.inspection === this.inspection;
    if (!isRecord(value) || typeof value.id !== 'string' || !value.id || value.variant !== token.context.selectedVariant
      || !['mock', 'meta'].includes(String(value.provider)) || !isRecord(value.systemBrief)
      || value.systemBrief.id !== token.context.systemId || value.systemBrief.revision !== token.context.revision)
      return { current, error: 'Investigation started, but its response identity could not be verified. Reload the saved investigation.' };
    if (token.plan) {
      const validation = validateCoveragePlan(value.coveragePlan, token.preparation!);
      if (!validation.valid || JSON.stringify(validation.plan) !== JSON.stringify(token.plan) || !sameContext(validation.plan?.context, token.plan.context)
        || value.systemBrief.hash !== token.plan.context.snapshotHash)
        return { current, error: 'Investigation started, but the reviewed coverage plan was not acknowledged. Reload the saved investigation to inspect its recorded evidence.' };
    } else if (value.coveragePlan !== undefined) return { current, error: 'Investigation started with an unexpected coverage plan. Reload its saved record.' };
    return { current };
  }
  inspectRun(value: unknown): void {
    this.inspection++;
    Object.assign(this.state, { projection: null, projectionError: null, projectionPending: false, selectedRunId: null });
    if (value === null) { this.publish(); return; }
    try {
      if (!isRecord(value) || typeof value.id !== 'string') throw new Error('Saved investigation identity is missing');
      const record = value as unknown as InvestigationRecord & CoverageRecordFields;
      this.state.selectedRunId = record.id;
      let preparation: CoveragePreparationInput | null = null;
      const snapshot = record.systemBrief, audit = record.contextAudit;
      if (snapshot?.brief && audit) {
        const context = { systemId: snapshot.brief.id, revision: snapshot.brief.revision, snapshotHash: snapshot.hash,
          adapterId: snapshot.brief.adapterId, variant: record.variant, sourceHash: record.sourceHash, contractHash: audit.contractHash };
        if (validContext(context) && snapshot.contract && Array.isArray(snapshot.contract.invariants)
          && (audit.adapterId === undefined || audit.adapterId === context.adapterId)
          && (audit.variant === undefined || audit.variant === context.variant)) {
          preparation = { context, requirements: snapshot.brief.requirements, requirementRules: snapshot.brief.requirementRules,
            contractRuleIds: snapshot.contract.invariants.map(i => i.id) };
        }
      }
      this.state.projection = projectCoverage({ runId: record.id, plan: record.coveragePlan, preparation,
        experiments: (record.experiments ?? []).map(e => {
          const result = e.result as ExperimentResult & CoverageResultFields;
          return { index: e.index, valid: result?.valid, executionComplete: result?.executionComplete, sourceHash: result?.sourceHash,
            trace: result?.trace, checks: result?.scenarioCheckEvidence ?? [] };
        }),
        findings: (record.findings ?? []).map(f => ({ id: f.id, experimentIndex: f.experimentIndex, sourceHash: f.sourceHash, violationId: f.violation?.id,
          invariant: f.violation?.invariant, reproduced: f.reproduced, cleanControlPassed: f.cleanControlPassed })),
        stop: { status: record.status, reason: record.stopReason } });
    } catch (error) { this.state.projectionError = String(error); }
    this.publish();
  }
  async open(id: string): Promise<void> {
    const generation = this.generation, inspection = ++this.inspection;
    const current = () => generation === this.generation && inspection === this.inspection;
    Object.assign(this.state, { selectedRunId: id, projectionPending: true, projection: null, projectionError: null }); this.publish();
    try {
      const record = await this.json(`/api/runs/${encodeURIComponent(id)}`);
      if (!current()) return;
      if (!isRecord(record) || record.id !== id) throw new Error('Historical run response identity mismatch');
      this.inspectRun(record);
    } catch (error) {
      if (current()) { this.state.projection = null; this.state.projectionError = String(error); this.state.projectionPending = false; this.publish(); }
    }
  }
}

export function coverageStatusBadgeClass(status: CoverageStatus): string {
  switch (status) {
    case 'confirmed': return 'badge-status-confirmed';
    case 'failed-unconfirmed': return 'badge-status-failed-unconfirmed';
    case 'exercised': return 'badge-status-exercised';
    case 'planned': return 'badge-status-planned';
    case 'suggested': return 'badge-status-suggested';
    case 'inconclusive': return 'badge-status-inconclusive';
    case 'invalid': return 'badge-status-invalid';
    case 'unsupported': return 'badge-status-unsupported';
    default: return 'badge-status-inconclusive';
  }
}

export function coverageStatusLabel(status: CoverageStatus): string {
  switch (status) {
    case 'suggested': return 'Suggested';
    case 'planned': return 'Planned / Unexercised';
    case 'exercised': return 'Exercised without violation';
    case 'failed-unconfirmed': return 'Failed (Unconfirmed)';
    case 'confirmed': return 'Confirmed finding';
    case 'inconclusive': return 'Inconclusive';
    case 'invalid': return 'Invalid check';
    case 'unsupported': return 'Unsupported';
    default: return String(status);
  }
}

export function renderCoveragePreparation(
  container: HTMLElement,
  state: CoverageViewState,
  onToggle: (scenarioId: CoverageScenarioId, reviewed: boolean) => void
): void {
  container.replaceChildren();

  if (state.preparationPending) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Loading coverage preparation and suggestions...';
    container.appendChild(p);
    return;
  }

  if (state.preparationError) {
    const note = document.createElement('div');
    note.className = 'note warn';
    const p = document.createElement('p');
    p.textContent = `Coverage preparation error: ${state.preparationError}`;
    note.appendChild(p);
    container.appendChild(note);
    return;
  }

  const c = state.context;
  const prep = state.preparation;
  if (!c || !prep) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No coverage configuration prepared. Select a saved system profile.';
    empty.appendChild(p);
    container.appendChild(empty);
    return;
  }

  const panel = document.createElement('div');
  panel.className = 'coverage-preparation-panel';

  const header = document.createElement('div');
  header.className = 'coverage-prep-header';
  const h3 = document.createElement('h3');
  h3.textContent = 'Reviewed coverage intentions';
  const desc = document.createElement('p');
  desc.className = 'muted';
  desc.textContent = 'Select and review scenarios to pin to the next investigation run. Check evidence is recorded during execution.';
  const pinned = document.createElement('p');
  pinned.className = 'muted coverage-pinned-context';
  const pinnedSmall = document.createElement('small');
  pinnedSmall.textContent = `Pinned context: ${prep.context.systemId} revision ${prep.context.revision} · ${prep.context.adapterId} · variant ${prep.context.variant} · catalog ${prep.catalog.id} v${prep.catalog.version} · evaluator ${prep.evaluator.id} v${prep.evaluator.version}`;
  pinned.appendChild(pinnedSmall);
  header.appendChild(pinned);
  header.append(h3, desc);
  panel.appendChild(header);

  if (state.backendEndpointAvailable === false) {
    const hint = document.createElement('p');
    hint.className = 'input-hint';
    hint.textContent = 'Coverage preparation is unavailable. No coverage plan will be attached to this launch.';
    panel.appendChild(hint);
  }

  const suggestionsList = document.createElement('div');
  suggestionsList.className = 'coverage-suggestions-list';

  if (!prep.suggestions || prep.suggestions.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No executable coverage scenarios available for this system adapter. Supplementary requirements remain context-only.';
    suggestionsList.appendChild(p);
  } else {
    for (const sug of prep.suggestions) {
      const card = document.createElement('article');
      card.className = 'card coverage-intention-card';

      const label = document.createElement('label');
      label.className = 'checkbox-label intention-review-label';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'coverage-intention-checkbox';
      cb.checked = state.reviewedIntentions[sug.scenarioId] === true;
      cb.addEventListener('change', () => onToggle(sug.scenarioId, cb.checked));

      const title = document.createElement('strong');
      title.textContent = sug.title;

      label.append(cb, title);

      const sDesc = document.createElement('p');
      sDesc.className = 'intention-desc';
      sDesc.textContent = sug.description;

      const linksP = document.createElement('p');
      linksP.className = 'muted intention-links';
      const small = document.createElement('small');
      small.textContent = sug.links.map(l => l.kind === 'requirement-text' ? `Requirement: "${l.text}"` : `Contract rule: ${l.ruleId}`).join('  ·  ');
      linksP.appendChild(small);

      card.append(label, sDesc, linksP);
      suggestionsList.appendChild(card);
    }
  }
  panel.appendChild(suggestionsList);

  const errors = state.planValidation?.errors ?? [];
  if (errors.length > 0) {
    const note = document.createElement('div');
    note.className = 'note warn';
    const p = document.createElement('p');
    p.textContent = 'Plan validation warnings:';
    const ul = document.createElement('ul');
    for (const err of errors) {
      const li = document.createElement('li');
      li.textContent = err;
      ul.appendChild(li);
    }
    note.append(p, ul);
    panel.appendChild(note);
  } else if (state.plan && state.planValidation?.valid) {
    const validP = document.createElement('p');
    validP.className = 'coverage-plan-valid text-success';
    const count = state.plan.intentions.length;
    validP.textContent = ` Reviewed coverage plan ready with ${count} intention${count === 1 ? '' : 's'}. Plan will be pinned to next run.`;
    panel.appendChild(validP);
  }

  const contextOnly = prep.contextOnly ?? [];
  if (contextOnly.length > 0) {
    const details = document.createElement('details');
    details.className = 'coverage-context-only-details';
    const summary = document.createElement('summary');
    summary.textContent = `Supplementary requirements (context only  ·  ${contextOnly.length} unmapped requirement${contextOnly.length === 1 ? '' : 's'})`;
    const notice = document.createElement('p');
    notice.className = 'muted';
    notice.textContent = 'Supplementary business requirements without reviewed executable rules remain unverified context and do not alter deterministic contract invariants.';
    const ul = document.createElement('ul');
    ul.className = 'coverage-context-list';
    for (const req of contextOnly) {
      const li = document.createElement('li');
      li.textContent = req;
      ul.appendChild(li);
    }
    details.append(summary, notice, ul);
    panel.appendChild(details);
  }

  container.appendChild(panel);
}

export function renderCoverageProjection(
  container: HTMLElement,
  projection: CoverageProjection | null,
  callbacks?: {
    onOpenFinding?: (findingId: string) => void;
    onOpenExperiment?: (expIndex: number) => void;
  }
): void {
  container.replaceChildren();

  if (!projection) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Select an investigation run to view coverage evidence.';
    empty.appendChild(p);
    container.appendChild(empty);
    return;
  }

  if (projection.state === 'legacy') {
    const card = document.createElement('div');
    card.className = 'coverage-legacy-notice card';
    const h3 = document.createElement('h3');
    h3.textContent = 'Legacy investigation record';
    const p1 = document.createElement('p');
    p1.className = 'muted';
    p1.textContent = `Run ${projection.runId} was executed without a pinned coverage plan.`;
    const p2 = document.createElement('p');
    p2.textContent = 'No coverage assertions were recorded during execution. A passing run does not imply verified coverage.';
    card.append(h3, p1, p2);
    container.appendChild(card);
    return;
  }

  if (projection.state === 'incompatible') {
    const note = document.createElement('div');
    note.className = 'note warn';
    const h3 = document.createElement('h3');
    h3.textContent = 'Incompatible coverage plan';
    const p = document.createElement('p');
    p.textContent = `Run ${projection.runId} carries a coverage plan that is incompatible with the recorded context:`;
    const ul = document.createElement('ul');
    for (const w of projection.warnings) {
      const li = document.createElement('li');
      li.textContent = w;
      ul.appendChild(li);
    }
    note.append(h3, p, ul);
    container.appendChild(note);
    return;
  }

  const rows = projection.rows ?? [];
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No coverage scenarios recorded for this run.';
    empty.appendChild(p);
    container.appendChild(empty);
    return;
  }

  const panel = document.createElement('div');
  panel.className = 'coverage-projection-panel';

  const header = document.createElement('div');
  header.className = 'coverage-proj-header';
  const h3 = document.createElement('h3');
  h3.textContent = 'Investigation coverage results';
  const pDesc = document.createElement('p');
  pDesc.className = 'muted';
  pDesc.textContent = `Deterministic check evidence recorded for run ${projection.runId}. No percentage is claimed.`;
  if (projection.context) {
    const pCtx = document.createElement('p');
    pCtx.className = 'muted coverage-pinned-context';
    const ctxSmall = document.createElement('small');
    const ctx = projection.context;
    ctxSmall.textContent = `Pinned context: ${ctx.systemId} revision ${ctx.revision} · ${ctx.adapterId} · variant ${ctx.variant} · snapshot ${ctx.snapshotHash} · source ${ctx.sourceHash} · contract ${ctx.contractHash}`;
    pCtx.appendChild(ctxSmall);
    header.appendChild(pCtx);
  }
  header.append(h3, pDesc);
  const provenance = document.createElement('p');
  provenance.className = 'muted coverage-pinned-context';
  provenance.textContent = `Catalog: ${COVERAGE_CATALOG.id} v${COVERAGE_CATALOG.version} (${COVERAGE_CATALOG.hash}); evaluator: ${COVERAGE_EVALUATOR.id} v${COVERAGE_EVALUATOR.version} (${COVERAGE_EVALUATOR.hash}).`;
  header.appendChild(provenance);

  if (projection.stop) {
    const pStop = document.createElement('p');
    pStop.className = 'muted';
    const small = document.createElement('small');
    small.textContent = `Run status: ${projection.stop.status}${projection.stop.reason ? ` · Stop reason: ${projection.stop.reason}` : ''}`;
    pStop.appendChild(small);
    header.appendChild(pStop);
  }
  panel.appendChild(header);

  const tableResp = document.createElement('div');
  tableResp.className = 'table-responsive';
  tableResp.setAttribute('role', 'region');
  tableResp.setAttribute('aria-label', 'Investigation coverage results table');
  tableResp.tabIndex = 0;

  const table = document.createElement('table');
  table.className = 'data-table coverage-table';

  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  for (const colName of ['Scenario & Links', 'Status', 'Evidence & Reason', 'Confirmed Findings', 'Experiments']) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = colName;
    trHead.appendChild(th);
  }
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.className = 'coverage-table-row';

    const tdScenario = document.createElement('td');
    const strongTitle = document.createElement('strong');
    strongTitle.textContent = row.title;
    const br = document.createElement('br');
    const smallLinks = document.createElement('small');
    smallLinks.className = 'muted';
    smallLinks.textContent = row.links.map(l => l.kind === 'requirement-text' ? `Req: "${l.text}"` : `Rule: ${l.ruleId}`).join(', ');
    tdScenario.append(strongTitle, br, smallLinks);

    const tdStatus = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `status-badge ${coverageStatusBadgeClass(row.status)}`;
    badge.textContent = coverageStatusLabel(row.status);
    tdStatus.appendChild(badge);

    const tdEvidence = document.createElement('td');
    const reasonP = document.createElement('p');
    reasonP.className = 'coverage-row-reason';
    reasonP.textContent = row.reason;
    tdEvidence.appendChild(reasonP);

    if (row.evidence.length > 0) {
      const details = document.createElement('details');
      details.className = 'coverage-evidence-expander';
      const summary = document.createElement('summary');
      summary.textContent = `Recorded checks evidence (${row.evidence.length} check${row.evidence.length === 1 ? '' : 's'})`;
      const body = document.createElement('div');
      body.className = 'coverage-evidence-body';

      for (const ev of row.evidence) {
        const card = document.createElement('div');
        card.className = 'card check-evidence-card';

        const pHead = document.createElement('p');
        pHead.textContent = `Check ${ev.id}  ·  Trigger: ${ev.trigger}  ·  Outcome: ${ev.outcome}`;
        const pDetail = document.createElement('p');
        pDetail.className = 'muted';
        pDetail.textContent = ev.detail;

        const traceRefsText = ev.traceRefs.map(tr => `step ${tr.step} (${tr.tick} simulated ticks)`).join(', ');
        const pRefs = document.createElement('p');
        pRefs.textContent = `Trace references: ${traceRefsText || 'None'}`;

        const pre = document.createElement('pre');
        pre.className = 'code-block';
        pre.textContent = JSON.stringify(ev.facts, null, 2);

        card.append(pHead, pDetail, pRefs, pre);
        body.appendChild(card);
      }
      details.append(summary, body);
      tdEvidence.appendChild(details);
    }

    const tdFindings = document.createElement('td');
    if (row.findingIds.length === 0) {
      const muted = document.createElement('span');
      muted.className = 'muted';
      muted.textContent = 'None';
      tdFindings.appendChild(muted);
    } else {
      for (const fid of row.findingIds) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-secondary btn-xs btn-open-finding';
        btn.textContent = fid;
        btn.setAttribute('aria-label', `Open finding ${fid}`);
        btn.addEventListener('click', () => callbacks?.onOpenFinding?.(fid));
        tdFindings.appendChild(btn);
        tdFindings.appendChild(document.createTextNode(' '));
      }
    }

    const tdExperiments = document.createElement('td');
    if (row.experimentIndices.length === 0) {
      const muted = document.createElement('span');
      muted.className = 'muted';
      muted.textContent = 'None';
      tdExperiments.appendChild(muted);
    } else {
      for (const ei of row.experimentIndices) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-secondary btn-xs btn-open-experiment';
        btn.textContent = `Experiment ${ei}`;
        btn.setAttribute('aria-label', `Open experiment ${ei}`);
        btn.addEventListener('click', () => callbacks?.onOpenExperiment?.(ei));
        tdExperiments.appendChild(btn);
        tdExperiments.appendChild(document.createTextNode(' '));
      }
    }

    tr.append(tdScenario, tdStatus, tdEvidence, tdFindings, tdExperiments);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  tableResp.appendChild(table);
  panel.appendChild(tableResp);
  container.appendChild(panel);
}
