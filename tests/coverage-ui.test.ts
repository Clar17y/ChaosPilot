import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  CoverageController, coverageStatusBadgeClass, coverageStatusLabel,
  renderCoveragePreparation, renderCoverageProjection, type CoverageViewContext,
} from '../src/web/coverage.ts';
import { loadOptionalFeature } from '../src/web/workspace.ts';
import { CREDIT_EVALUATOR } from '../src/coverage/catalog.ts';
import {
  COVERAGE_CATALOG, COVERAGE_EVALUATOR, RECOVERY_ADAPTER_ID, buildCoveragePlan, prepareCoverage,
  type CoverageContext, type CoveragePreparationInput, type ScenarioCheckEvidence,
} from '../src/coverage/index.ts';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}
const reqText = 'Orders must not exceed credit limit';
const ctxA: CoverageViewContext = {
  systemId: 'system-alpha', revision: 1, selectedAdapterId: 'synthetic-trading', selectedVariant: 'clean',
  isDraftMode: false, hasUnsavedSystemEdits: false, requirements: [reqText, 'Prose context'],
  requirementRules: [{ requirement: reqText, preset: 'accepted-order-credit-limit', reviewed: true }],
  contractRuleIds: ['credit_limit_respected'],
};
function serverContext(c: CoverageViewContext): CoverageContext {
  return { systemId: c.systemId!, revision: c.revision!, snapshotHash: `snap-${c.systemId}`, adapterId: c.selectedAdapterId!,
    variant: c.selectedVariant!, sourceHash: `src-${c.systemId}`, contractHash: `contract-${c.systemId}` };
}
function prepareResponse(c: CoverageViewContext) {
  const input: CoveragePreparationInput = { context: serverContext(c), requirements: c.requirements ?? [], requirementRules: c.requirementRules ?? [], contractRuleIds: c.contractRuleIds ?? [] };
  return { ok: true, status: 200, json: async () => prepareCoverage(input) };
}
const notFound = { ok: false, status: 404, json: async () => ({ error: 'Not Found' }) };

describe('CoverageController async ownership', () => {
  it('discards a late preparation response after an A-B-A context change', async () => {
    const d1 = deferred<unknown>(), d2 = deferred<unknown>(), d3 = deferred<unknown>();
    const queue = [d1, d2, d3];
    const fetchMock = vi.fn(() => queue.shift()!.promise);
    const controller = new CoverageController(fetchMock as never, () => {});
    const ctxB: CoverageViewContext = { ...ctxA, systemId: 'system-beta', revision: 2, selectedVariant: 'candidate-a' };
    const p1 = controller.setContext(ctxA);
    const p2 = controller.setContext(ctxB);
    const p3 = controller.setContext(ctxA); // back to A: earlier A response is still stale
    d3.resolve(prepareResponse(ctxA)); await p3;
    expect(controller.state.preparation?.context.systemId).toBe('system-alpha');
    controller.toggleIntention('accepted-order-credit-limit', true);
    expect(controller.state.plan?.intentions).toHaveLength(1);
    d1.resolve(prepareResponse(ctxA)); d2.resolve(prepareResponse(ctxB));
    await p1; await p2;
    expect(controller.state.context?.systemId).toBe('system-alpha');
    expect(controller.state.reviewedIntentions['accepted-order-credit-limit']).toBe(true); // not reset by late responses
  });

  it('404 means coverage unavailable: no fabricated preparation or plan; trading unblocked, recovery blocked', async () => {
    const controller = new CoverageController(vi.fn(async () => notFound) as never, () => {});
    await controller.setContext(ctxA);
    expect(controller.state.backendEndpointAvailable).toBe(false);
    expect(controller.state.preparation).toBeNull();
    expect(controller.state.plan).toBeNull();
    expect(controller.getLaunchPlan()).toBeUndefined();
    expect(controller.state.preparationError).toContain('unavailable');
    expect(controller.state.blockedReason).toBeNull(); // existing trading launch still works, no saved-plan claim
    expect(controller.captureLaunch().plan).toBeUndefined();

    const recovery = new CoverageController(vi.fn(async () => notFound) as never, () => {});
    await recovery.setContext({ ...ctxA, selectedAdapterId: RECOVERY_ADAPTER_ID, contractRuleIds: ['recovery_deadline'] });
    expect(recovery.state.blockedReason).toContain('RECOVERY LAUNCH REQUIRES');
    expect(() => recovery.captureLaunch()).toThrow();
  });

  it('valid preparation starts unreviewed; explicit review builds the plan; launch echo is validated', async () => {
    const controller = new CoverageController(vi.fn(async () => prepareResponse(ctxA)) as never, () => {});
    await controller.setContext(ctxA);
    expect(controller.state.reviewedIntentions).toEqual({ 'accepted-order-credit-limit': false });
    expect(controller.state.plan?.intentions).toEqual([]);
    controller.toggleIntention('accepted-order-credit-limit', true);
    const token = controller.captureLaunch();
    expect(token.plan?.intentions).toHaveLength(1);
    const echo = { id: 'run-9', variant: 'clean', provider: 'mock', systemBrief: { id: 'system-alpha', name: 'A', revision: 1, hash: 'snap-system-alpha' }, coveragePlan: token.plan };
    expect(controller.validateLaunchResponse(echo, token)).toEqual({ current: true });
    expect(controller.validateLaunchResponse({ ...echo, coveragePlan: undefined }, token).error).toContain('not acknowledged');
    expect(controller.validateLaunchResponse({ ...echo, systemBrief: { ...echo.systemBrief, hash: 'other' } }, token).error).toContain('not acknowledged');
    expect(controller.validateLaunchResponse({ ...echo, variant: 'candidate-b' }, token).error).toContain('could not be verified');
  });

  it('rejects a preparation whose suggestions do not match the canonical catalog', async () => {
    const tampered = { ok: true, status: 200, json: async () => ({ ...prepareCoverage({ context: serverContext(ctxA), requirements: ctxA.requirements!, requirementRules: ctxA.requirementRules, contractRuleIds: ctxA.contractRuleIds! }),
      suggestions: [{ scenarioId: 'accepted-order-credit-limit', title: 'Fake', description: 'x', links: [{ kind: 'requirement-text', text: 'invented' }] }] }) };
    const controller = new CoverageController(vi.fn(async () => tampered) as never, () => {});
    await controller.setContext(ctxA);
    expect(controller.state.preparation).toBeNull();
    expect(controller.state.preparationError).toContain('unsupported');
  });
  it('captures launch after its dashboard reset, then rejects a later historical selection or context change', async () => {
    const controller = new CoverageController(vi.fn(async () => prepareResponse(ctxA)) as never, () => {});
    await controller.setContext(ctxA);
    controller.toggleIntention('accepted-order-credit-limit', true);
    controller.inspectRun({ id: 'previous', status: 'completed', experiments: [], findings: [] });
    controller.inspectRun(null); // app clears its dashboard before capturing the new launch
    const token = controller.captureLaunch();
    const echo = { id: 'new-run', variant: 'clean', provider: 'mock',
      systemBrief: { id: 'system-alpha', revision: 1, hash: 'snap-system-alpha' }, coveragePlan: token.plan };
    expect(controller.validateLaunchResponse(echo, token)).toEqual({ current: true });
    controller.inspectRun({ id: 'selected-history', status: 'completed', experiments: [], findings: [] });
    expect(controller.validateLaunchResponse(echo, token).current).toBe(false);
    await controller.setContext({ ...ctxA, selectedVariant: 'candidate-a' });
    await controller.setContext(ctxA);
    expect(controller.validateLaunchResponse(echo, token).current).toBe(false);
  });

  it('discards a late historical detail response; failed open clears the old projection', async () => {
    const d1 = deferred<unknown>(), d2 = deferred<unknown>();
    const fetchMock = vi.fn((url: string) => url.includes('run-1') ? d1.promise : d2.promise);
    const controller = new CoverageController(fetchMock as never, () => {});
    const o1 = controller.open('run-1'); const o2 = controller.open('run-2');
    d2.resolve({ ok: true, status: 200, json: async () => ({ id: 'run-2', status: 'completed', experiments: [], findings: [] }) });
    await o2;
    expect(controller.state.selectedRunId).toBe('run-2');
    expect(controller.state.projection?.state).toBe('legacy');
    d1.resolve({ ok: true, status: 200, json: async () => ({ id: 'run-1', status: 'completed', experiments: [], findings: [] }) });
    await o1;
    expect(controller.state.selectedRunId).toBe('run-2');

    const failing = new CoverageController(vi.fn(async () => { throw new Error('offline'); }) as never, () => {});
    failing.inspectRun({ id: 'old', status: 'completed', experiments: [], findings: [] });
    expect(failing.state.projection).not.toBeNull();
    await failing.open('gone');
    expect(failing.state.projection).toBeNull();
    expect(failing.state.projectionError).toContain('offline');
  });

  it('inspectRun uses the pinned snapshot, not the current profile, for a full saved record', async () => {
    const pinned = serverContext(ctxA);
    const preparation: CoveragePreparationInput = { context: pinned, requirements: ctxA.requirements!, requirementRules: ctxA.requirementRules, contractRuleIds: ctxA.contractRuleIds! };
    const savedPlan = buildCoveragePlan({ preparation, intentions: [{ scenarioId: 'accepted-order-credit-limit', reviewed: true, links: [{ kind: 'requirement-text', text: reqText }] }] }).plan;
    const check: ScenarioCheckEvidence = {
      schemaVersion: 1, id: 'c1', scenarioId: 'accepted-order-credit-limit', evaluator: COVERAGE_EVALUATOR, context: pinned,
      experimentIndex: 3, trigger: 'reached', outcome: 'passed', traceRefs: [{ traceIndex: 0, step: 1, tick: 10, messageId: 'm1' }],
      facts: { kind: 'credit-admission', requirement: reqText, requirementEvaluator: CREDIT_EVALUATOR, messageId: 'm1', payloadValid: true, deliveryStatus: 'accepted', usedCredit: 1, reservedCredit: 1, creditLimit: 500 },
      detail: 'ok',
    };
    const record = {
      id: 'saved-1', status: 'completed', variant: 'clean', sourceHash: pinned.sourceHash, coveragePlan: savedPlan,
      systemBrief: { hash: pinned.snapshotHash, brief: { id: pinned.systemId, revision: 1, adapterId: 'synthetic-trading', requirements: ctxA.requirements, requirementRules: ctxA.requirementRules },
        contract: { invariants: [{ id: 'credit_limit_respected' }] } },
      contextAudit: { contractHash: pinned.contractHash, adapterId: 'synthetic-trading', variant: 'clean' },
      experiments: [{ index: 3, result: { valid: true, executionComplete: true, sourceHash: pinned.sourceHash, trace: [{ step: 1, time: 10, messageId: 'm1' }], scenarioCheckEvidence: [check] } }],
      findings: [],
    };
    const controller = new CoverageController(vi.fn(async () => notFound) as never, () => {});
    await controller.setContext({ ...ctxA, systemId: 'changed-profile', revision: 99 }); // current profile moved on
    controller.inspectRun(record);
    expect(controller.state.projection?.state).toBe('ready');
    expect(controller.state.projection?.rows.find(r => r.scenarioId === 'accepted-order-credit-limit')?.status).toBe('exercised');
    expect(controller.state.projection?.rows.find(r => r.scenarioId === 'accepted-order-credit-limit')?.experimentIndices).toEqual([3]);
  });
});

describe('optional coverage module boundary', () => {
  it('loadOptionalFeature reports failure without throwing and returns the module on success', async () => {
    await expect(loadOptionalFeature(async () => { throw new Error('404 /coverage/identity.js'); }))
      .resolves.toEqual({ available: false, error: '404 /coverage/identity.js' });
    await expect(loadOptionalFeature(async () => ({ ok: 1 }))).resolves.toEqual({ available: true, module: { ok: 1 } });
  });
  it('app loads coverage only behind the dynamic boundary (no static coverage-core imports)', async () => {
    const app = await readFile(new URL('../src/web/app.ts', import.meta.url), 'utf8');
    expect(app).toContain("loadOptionalFeature(() => import('./coverage.ts'))");
    expect(app).not.toMatch(/^\s*import\s+(?!type\b)[^;]*from\s+'\.\.\/coverage\//m);
    expect(app).not.toMatch(/^\s*import\s+(?!type\b)[^;]*from\s+'\.\/coverage\.ts'/m);
    for (const file of ['workspace.ts', 'snapshot.ts', 'reproduction-view.ts']) {
      const src = await readFile(new URL(`../src/web/${file}`, import.meta.url), 'utf8');
      expect(src, file).not.toMatch(/^\s*import\s+(?!type\b)[^;]*coverage/m);
    }
  });
});

// Minimal DOM surface used by the production renderers (repository UI-test pattern).
class El {
  className = ''; type = ''; checked = false; tabIndex = -1; scope = '';
  attrs = new Map<string, string>(); children: unknown[] = [];
  listeners = new Map<string, (() => void)[]>();
  private text = '';
  get textContent(): string { return this.text + this.children.map(c => (c as { textContent?: string }).textContent ?? '').join(''); }
  set textContent(v: string) { this.text = v; this.children = []; }
  append(...nodes: unknown[]) { this.children.push(...nodes); }
  appendChild(n: unknown) { this.children.push(n); return n; }
  replaceChildren(...nodes: unknown[]) { this.children = nodes; this.text = ''; }
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  addEventListener(name: string, fn: () => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], fn]); }
  dispatch(name: string) { this.listeners.get(name)?.forEach(fn => fn()); }
  findAll(pred: (e: El) => boolean): El[] {
    return [this, ...this.children.flatMap(c => c instanceof El ? c.findAll(pred) : [])].filter(pred);
  }
}
afterEach(() => vi.unstubAllGlobals());
function stubDom() {
  vi.stubGlobal('document', {
    createElement: () => new El(),
    createTextNode: (t: string) => ({ textContent: t }),
  });
}

describe('production coverage renderers (safe DOM binding)', () => {
  it('preparation renderer binds hostile text as text, checkbox changes call back, pinned context shown', () => {
    stubDom();
    const hostile = '<img src=x onerror=alert(1)>';
    const input: CoveragePreparationInput = { context: serverContext(ctxA), requirements: [reqText, hostile], requirementRules: ctxA.requirementRules, contractRuleIds: ctxA.contractRuleIds! };
    const prep = prepareCoverage(input);
    const onToggle = vi.fn();
    const container = new El();
    renderCoveragePreparation(container as never, {
      context: ctxA, preparationPending: false, preparation: prep, preparationError: null,
      reviewedIntentions: { 'accepted-order-credit-limit': false }, plan: null, planValidation: null,
      blockedReason: null, backendEndpointAvailable: true, selectedRunId: null, projectionPending: false, projection: null, projectionError: null,
    }, onToggle);
    const allText = container.textContent;
    expect(allText).toContain(hostile); // present as inert text content, never parsed markup
    expect(allText).toContain('Pinned context: system-alpha revision 1');
    const checkbox = container.findAll(e => e.type === 'checkbox')[0];
    expect(checkbox).toBeDefined();
    expect(checkbox.checked).toBe(false);
    checkbox.checked = true; checkbox.dispatch('change');
    expect(onToggle).toHaveBeenCalledWith('accepted-order-credit-limit', true);
    const labels = container.findAll(e => e.className.includes('intention-review-label'));
    expect(labels).toHaveLength(1);
  });

  it('projection renderer shows all statuses safely, finding/experiment buttons navigate, no percentage', () => {
    stubDom();
    const onOpenFinding = vi.fn(), onOpenExperiment = vi.fn();
    const container = new El();
    renderCoverageProjection(container as never, {
      runId: 'run-<b>1</b>', state: 'ready', context: serverContext(ctxA), stop: { status: 'cancelled', reason: 'budget <stop>' },
      rows: [{
        scenarioId: 'accepted-order-credit-limit', title: 'Credit <script>x</script>', status: 'confirmed',
        reason: 'matched', links: [{ kind: 'requirement-text', text: reqText }], evidence: [], experimentIndices: [3], findingIds: ['f-1'],
      }], warnings: [],
    }, { onOpenFinding, onOpenExperiment });
    const text = container.textContent;
    expect(text).toContain('Confirmed finding');
    expect(text).toContain('Credit <script>x</script>');
    expect(text).toContain('Run status: cancelled');
    expect(text).toContain(`evaluator: ${COVERAGE_EVALUATOR.id} v${COVERAGE_EVALUATOR.version} (${COVERAGE_EVALUATOR.hash})`);
    expect(text).toContain(`Catalog: ${COVERAGE_CATALOG.id} v${COVERAGE_CATALOG.version}`);
    expect(text).not.toContain('%');
    container.findAll(e => e.className.includes('btn-open-finding'))[0].dispatch('click');
    expect(onOpenFinding).toHaveBeenCalledWith('f-1');
    container.findAll(e => e.className.includes('btn-open-experiment'))[0].dispatch('click');
    expect(onOpenExperiment).toHaveBeenCalledWith(3);
    const region = container.findAll(e => e.attrs.get('role') === 'region')[0];
    expect(region.tabIndex).toBe(0); // keyboard-focusable scroll region
  });

  it('status helpers cover all eight statuses', () => {
    for (const s of ['suggested', 'planned', 'exercised', 'failed-unconfirmed', 'confirmed', 'inconclusive', 'invalid', 'unsupported'] as const) {
      expect(coverageStatusBadgeClass(s)).toBe(`badge-status-${s}`);
      expect(coverageStatusLabel(s).length).toBeGreaterThan(0);
    }
  });
});
