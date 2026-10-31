import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InvestigationRecord } from '../src/domain.ts';
import { runInvestigation } from '../src/investigation/index.ts';
import { MockProvider } from '../src/providers/mock.ts';
import {
  captureRegressionFromFinding,
  getRegressionDefinitionDetail,
  listRegressionDefinitions,
  listRegressionRuns,
  previewRegressionFromFinding,
  runSavedRegression,
} from '../src/regressions/index.ts';
import { saveRun, saveSystemBrief } from '../src/storage.ts';
import { SEEDED_TRADING_BRIEF, createSystemSnapshot } from '../src/systems/index.ts';
import { ChallengeSession } from '../src/web/challenges.ts';
import { FunctionalController } from '../src/web/functional.ts';
import {
  RegressionController,
  initRegressionWorkspaceView,
  regressionDefinitionDetailHtml,
  regressionPreviewHtml,
  regressionRunResultHtml,
  setHtmlPreservingDisclosures,
  type RegressionWorkspaceContext,
} from '../src/web/regressions.ts';
import {
  regressionCaptureBlockedReason,
  regressionExecutionBlockedReason,
} from '../src/web/workspace.ts';

const readyContext: RegressionWorkspaceContext = {
  systemId: 'trading-gateway',
  revision: 1,
  hasSelectedSystem: true,
  selectedAdapterId: 'synthetic-trading',
  isDraftMode: false,
  hasUnsavedSystemEdits: false,
  isSystemSavePending: false,
  snapshotState: 'ready',
  targetState: 'ready',
  selectedVariant: 'candidate-c',
  allowedVariants: ['clean', 'candidate-a', 'candidate-b', 'candidate-c'],
};

const deferred = () => {
  let resolve!: (v: any) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<any>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};

const response = (value: any, ok = true) => ({
  ok,
  status: ok ? 200 : 409,
  json: async () => value,
});

const tempDirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function createRegressionFixture() {
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.tmp-regression-ui-'));
  tempDirs.push(dir);
  const runsDir = path.join(dir, 'runs');
  const systemsDir = path.join(dir, 'systems');
  await fs.mkdir(runsDir, { recursive: true });
  await fs.mkdir(systemsDir, { recursive: true });
  await saveSystemBrief(structuredClone(SEEDED_TRADING_BRIEF), systemsDir, { mode: 'create' });

  const brief = structuredClone(SEEDED_TRADING_BRIEF);
  brief.requirementRules = [
    {
      requirement:
        'Total commitments include both used and reserved credit. New order admission respects the current limit.',
      preset: 'accepted-order-credit-limit',
      reviewed: true,
    },
  ];
  const systemBrief = await createSystemSnapshot(brief);
  const record: InvestigationRecord = await runInvestigation({
    variant: 'candidate-c',
    systemBrief,
    provider: new MockProvider(),
  });
  await saveRun(record, runsDir);
  const finding = record.findings[0]!;
  const preview = await previewRegressionFromFinding(record.id, finding.id, { runsDir });
  if (!preview.available) throw new Error('Expected available preview');

  const definition = await captureRegressionFromFinding(
    {
      runId: record.id,
      findingId: finding.id,
      expectedRunRevision: preview.runRevision,
      expectedEvidenceHash: preview.evidenceHash,
      reviewToken: preview.reviewToken,
      definitionId: preview.definitionId,
      contentHash: preview.contentHash,
      reviewed: true,
    },
    { runsDir },
  );
  const runRecord = await runSavedRegression(
    { definitionId: definition.id, variant: 'candidate-c' },
    { runsDir },
  );
  const passRunRecord = await runSavedRegression(
    { definitionId: definition.id, variant: 'clean' },
    { runsDir },
  );
  const definitions = await listRegressionDefinitions(runsDir);
  const runs = await listRegressionRuns(runsDir);
  const detail = (await getRegressionDefinitionDetail(definition.id, runsDir))!;

  return {
    runsDir,
    record,
    finding,
    preview,
    definition,
    runRecord,
    passRunRecord,
    definitions,
    runs,
    detail,
  };
}

function setupController() {
  const requests: { url: string; init?: RequestInit; deferred: ReturnType<typeof deferred> }[] = [];
  const render = vi.fn();
  const controller = new RegressionController((url, init) => {
    const d = deferred();
    requests.push({ url, init, deferred: d });
    return d.promise;
  }, render);
  controller.setContext(readyContext);
  return { controller, requests, render };
}

describe('RegressionController: context/finding transitions, pending guards, and inspection ordering', () => {
  it('ignores unchanged workspace context and unchanged finding selection without rerendering or clearing preview/consent', async () => {
    const { record, finding, preview, definitions, runs } = await createRegressionFixture();
    const { controller, requests, render } = setupController();

    // Resolve initial list load (GET /api/regressions/definitions and GET /api/regressions/runs)
    expect(requests).toHaveLength(2);
    requests[0]!.deferred.resolve(response(definitions));
    requests[1]!.deferred.resolve(response(runs));
    await Promise.resolve();
    await Promise.resolve();

    controller.selectFinding(record, finding.id, false);
    const previewPromise = controller.preview();
    expect(controller.state.previewPending).toBe(true);

    // Unchanged polling during previewPending must not rerender or abort
    const rendersDuringPreview = render.mock.calls.length;
    controller.setContext(structuredClone(readyContext));
    controller.selectFinding(structuredClone(record), finding.id, false);
    expect(render).toHaveBeenCalledTimes(rendersDuringPreview);
    expect(controller.state.previewPending).toBe(true);

    await vi.waitFor(() =>
      expect(requests.some(r => r.url === '/api/regressions/preview')).toBe(true),
    );
    const previewReq = requests.find(r => r.url === '/api/regressions/preview')!;
    previewReq.deferred.resolve(response(preview));
    await previewPromise;

    expect(controller.state.previewPending).toBe(false);
    expect(controller.state.preview).toEqual(preview);
    controller.setReviewedConsent(true);
    expect(controller.state.canSaveCapture).toBe(true);

    // Unchanged polling after preview/consent must preserve preview and reviewedConsent
    const rendersAfterConsent = render.mock.calls.length;
    controller.setContext(structuredClone(readyContext));
    controller.selectFinding(structuredClone(record), finding.id, false);
    expect(render).toHaveBeenCalledTimes(rendersAfterConsent);
    expect(controller.state.reviewedConsent).toBe(true);
    expect(controller.state.canSaveCapture).toBe(true);
  });

  it('establishes pending before first await on preview(), save(), and run(), preventing double-click duplicate requests', async () => {
    const { record, finding, preview, definition, definitions, runs, runRecord } =
      await createRegressionFixture();
    const { controller, requests } = setupController();
    requests[0]!.deferred.resolve(response(definitions));
    requests[1]!.deferred.resolve(response(runs));
    await new Promise(r => setTimeout(r, 0));

    controller.selectFinding(record, finding.id, false);

    // 1. Double-click preview() before first await resolves
    const p1 = controller.preview();
    expect(controller.state.previewPending).toBe(true);
    const p2 = controller.preview();
    await p2;
    await vi.waitFor(() =>
      expect(requests.filter(r => r.url === '/api/regressions/preview')).toHaveLength(1),
    );
    const previewReqs = requests.filter(r => r.url === '/api/regressions/preview');
    expect(previewReqs).toHaveLength(1);
    previewReqs[0]!.deferred.resolve(response(preview));
    await p1;
    expect(controller.state.previewPending).toBe(false);

    // 2. Double-click save() before first await resolves
    controller.setReviewedConsent(true);
    const s1 = controller.save();
    expect(controller.state.savePending).toBe(true);
    const s2 = controller.save();
    await s2;
    const saveReqs = requests.filter(
      r => r.url === '/api/regressions/definitions' && r.init?.method === 'POST',
    );
    expect(saveReqs).toHaveLength(1);
    saveReqs[0]!.deferred.resolve(response(definition));
    await s1;
    expect(controller.state.savePending).toBe(false);
    expect(controller.state.savedDefinition?.id).toBe(definition.id);

    // Resolve the background loadList triggered by save()
    for (const req of requests) {
      if (req.url === '/api/regressions/definitions' && !req.init?.method) {
        req.deferred.resolve(response(definitions));
      }
      if (req.url === '/api/regressions/runs') {
        req.deferred.resolve(response(runs));
      }
    }
    await new Promise(r => setTimeout(r, 0));

    // 3. Double-click run() before first await resolves
    const r1 = controller.run();
    expect(controller.state.runPending).toBe(true);
    const r2 = controller.run();
    await r2;
    const runReqs = requests.filter(r => r.url === '/api/regressions/run');
    expect(runReqs).toHaveLength(1);
    runReqs[0]!.deferred.resolve(response(runRecord));
    await r1;
    expect(controller.state.runPending).toBe(false);
    expect(controller.state.runRecord?.id).toBe(runRecord.id);
  });

  it.each([
    { hasUnsavedSystemEdits: true },
    { isDraftMode: true },
    { isSystemSavePending: true },
    { snapshotState: 'error' as const },
    { selectedAdapterId: 'inventory-reservation' },
    { systemId: null, hasSelectedSystem: false },
  ])('blocks capture and execution for workspace state %j (saved -> dirty -> draft -> save/discard)', async patch => {
    const { record, finding, definitions, runs } = await createRegressionFixture();
    const { controller, requests } = setupController();
    requests[0]!.deferred.resolve(response(definitions));
    requests[1]!.deferred.resolve(response(runs));
    await new Promise(r => setTimeout(r, 0));

    controller.selectFinding(record, finding.id, false);
    controller.setContext({ ...readyContext, ...patch });

    const beforeCount = requests.length;
    await controller.preview();
    await controller.save();
    await controller.run();
    expect(requests.filter(r => r.init?.method === 'POST')).toHaveLength(0);
    expect(controller.state.captureBlockedReason).not.toBeNull();
    expect(controller.state.executionBlockedReason).not.toBeNull();
    expect(requests.length).toBeGreaterThanOrEqual(beforeCount);
  });

  it.each([
    { label: 'profile change', contextPatch: { systemId: 'other-system' } },
    { label: 'revision change', contextPatch: { revision: 2 } },
    { label: 'adapter change', contextPatch: { selectedAdapterId: 'inventory-reservation' } },
    { label: 'dirty edits', contextPatch: { hasUnsavedSystemEdits: true } },
    { label: 'draft mode', contextPatch: { isDraftMode: true } },
    { label: 'finding change', findingPatch: 'other-finding' },
    { label: 'waitsForSave', waitsForSave: true },
  ])('drops stale preview and save success/error/finally after $label and never clears newer pending state', async scenario => {
    const { record, finding, preview, definition } = await createRegressionFixture();

    for (const fails of [false, true]) {
      const { controller, requests } = setupController();
      controller.selectFinding(record, finding.id, false);

      // Start preview, then transition before it settles
      const oldPreview = controller.preview();
      await vi.waitFor(() =>
        expect(requests.some(r => r.url === '/api/regressions/preview')).toBe(true),
      );
      const oldPreviewReq = requests.find(r => r.url === '/api/regressions/preview')!;

      if (scenario.contextPatch) {
        controller.setContext({ ...readyContext, ...scenario.contextPatch });
      } else if (scenario.findingPatch) {
        const clone = structuredClone(record);
        clone.findings.push({ ...structuredClone(finding), id: scenario.findingPatch });
        controller.selectFinding(clone, scenario.findingPatch, false);
      } else if (scenario.waitsForSave) {
        controller.selectFinding(record, finding.id, true);
      }

      if (fails) {
        oldPreviewReq.deferred.reject(new Error('stale preview error'));
      } else {
        oldPreviewReq.deferred.resolve(response(preview));
      }
      await oldPreview;

      expect(controller.state.preview).toBeNull();
      expect(controller.state.captureError).toBeNull();
      expect(controller.state.previewPending).toBe(false);
    }

    // Also verify old preview finally cannot clear a newer previewPending
    const { controller, requests } = setupController();
    controller.selectFinding(record, finding.id, false);
    const firstPreview = controller.preview();
    await vi.waitFor(() =>
      expect(requests.filter(r => r.url === '/api/regressions/preview')).toHaveLength(1),
    );
    const firstReq = requests.find(r => r.url === '/api/regressions/preview')!;

    controller.setContext({ ...readyContext, revision: 2 });
    const secondPreview = controller.preview();
    await vi.waitFor(() =>
      expect(requests.filter(r => r.url === '/api/regressions/preview')).toHaveLength(2),
    );
    const previewReqs = requests.filter(r => r.url === '/api/regressions/preview');
    expect(previewReqs).toHaveLength(2);

    firstReq.deferred.reject(new Error('stale preview failure'));
    await firstPreview;
    expect(controller.state.previewPending).toBe(true);
    expect(controller.state.captureError).toBeNull();

    previewReqs[1]!.deferred.resolve(response(preview));
    await secondPreview;
    expect(controller.state.previewPending).toBe(false);
    expect(controller.state.preview?.available).toBe(true);

    // Same for save(): old save finally cannot clear a newer previewPending/savePending
    controller.setReviewedConsent(true);
    const firstSave = controller.save();
    const saveReq = requests.find(
      r => r.url === '/api/regressions/definitions' && r.init?.method === 'POST',
    )!;
    controller.setContext({ ...readyContext, revision: 3 });
    saveReq.deferred.resolve(response(definition));
    await firstSave;
    expect(controller.state.savedDefinition).toBeNull();
  });

  it('drops stale run() and inspection results across target/context transitions and ensures newer inspection wins', async () => {
    const { definitions, runs, detail, runRecord, passRunRecord } = await createRegressionFixture();
    const { controller, requests } = setupController();
    requests[0]!.deferred.resolve(response(definitions));
    requests[1]!.deferred.resolve(response(runs));
    await new Promise(r => setTimeout(r, 0));

    // 1. Start run(), then openRun(passRunRecord.id) while run() is still in flight
    const inflightRun = controller.run();
    const inflightRunReq = requests.find(r => r.url === '/api/regressions/run')!;

    const inspectPass = controller.openRun(passRunRecord.id);
    const inspectPassReq = requests.find(
      r => r.url === `/api/regressions/runs/${encodeURIComponent(passRunRecord.id)}`,
    )!;
    inspectPassReq.deferred.resolve(response(passRunRecord));
    await inspectPass;

    // Late completion of inflightRun must be ignored because inspectionSeq advanced
    inflightRunReq.deferred.resolve(response(runRecord));
    await inflightRun;
    expect(controller.state.runRecord?.id).toBe(passRunRecord.id);
    expect(controller.state.runRecord?.status).toBe('pass');

    // 2. Context transition A -> B -> A discards in-flight openDefinition
    const openDef = controller.openDefinition(detail.definition.id);
    const openDefReq = requests.find(
      r => r.url === `/api/regressions/definitions/${encodeURIComponent(detail.definition.id)}`,
    )!;
    controller.setContext({ ...readyContext, systemId: 'other-system' });
    controller.setContext(readyContext);
    openDefReq.deferred.resolve(response(detail));
    await openDef;
    expect(controller.state.definitionDetail).toBeNull();
  });

  it('coexists cleanly with FunctionalController and ChallengeSession and surfaces workspace revision differences accurately', async () => {
    const { record, finding, preview, detail, runRecord } = await createRegressionFixture();

    // Render HTML with workspace at revision 2 while definition is pinned to original revision 1
    const previewHtml = regressionPreviewHtml(preview, 2);
    expect(previewHtml).toContain('Current workspace profile is revision 2');
    expect(previewHtml).toContain('pins original brief revision 1');
    expect(previewHtml).toContain('Proposed reference behavior from clean control');

    const detailHtml = regressionDefinitionDetailHtml(detail, 2);
    expect(detailHtml).toContain('Workspace profile is currently at revision 2');
    expect(detailHtml).toContain('verified on disk');

    const runHtml = regressionRunResultHtml(runRecord, 2);
    expect(runHtml).toContain('Current workspace profile is revision 2');
    expect(runHtml).toContain('delivery.9.m-order-2.decision');
    expect(runHtml).toContain('accepted-order-credit-limit');

    // Verify HTML escaping against XSS in rendered payloads
    const xssRun = structuredClone(runRecord);
    xssRun.origin.systemBrief.id = '<script>alert("xss")</script>';
    const escapedHtml = regressionRunResultHtml(xssRun, 1);
    expect(escapedHtml).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(escapedHtml).not.toContain('<script>alert("xss")</script>');

    // Verify setHtmlPreservingDisclosures preserves open <details data-disclosure-key> across key changes
    // and skips DOM replacement entirely when key is unchanged
    const openKeys = new Set<string>(['run-assertions-' + runRecord.id]);
    let innerHtmlWrites = 0;
    const fakeHost = {
      querySelectorAll() {
        return [
          {
            open: openKeys.has('run-assertions-' + runRecord.id),
            dataset: { disclosureKey: 'run-assertions-' + runRecord.id },
          },
          {
            open: openKeys.has('run-lineage-' + runRecord.id),
            dataset: { disclosureKey: 'run-lineage-' + runRecord.id },
          },
        ];
      },
      set innerHTML(_v: string) {
        innerHtmlWrites++;
        // Simulate DOM replacement resetting open states before setHtmlPreservingDisclosures restores them
        openKeys.clear();
      },
    } as unknown as HTMLElement;

    // Also allow restoring open=true on the fake details elements
    const detailsElements = [
      {
        _open: true,
        get open() {
          return this._open;
        },
        set open(v: boolean) {
          this._open = v;
        },
        dataset: { disclosureKey: 'run-assertions-' + runRecord.id },
      },
      {
        _open: false,
        get open() {
          return this._open;
        },
        set open(v: boolean) {
          this._open = v;
        },
        dataset: { disclosureKey: 'run-lineage-' + runRecord.id },
      },
    ];
    const statefulHost = {
      querySelectorAll() {
        return detailsElements;
      },
      set innerHTML(_v: string) {
        innerHtmlWrites++;
        for (const d of detailsElements) d._open = false;
      },
    } as unknown as HTMLElement;

    const cache = new WeakMap<HTMLElement, string>();
    setHtmlPreservingDisclosures(statefulHost, cache, 'key-1', runHtml);
    expect(innerHtmlWrites).toBe(1);
    expect(detailsElements[0]!.open).toBe(true);
    expect(detailsElements[1]!.open).toBe(false);

    // Unchanged key does not rewrite innerHTML
    detailsElements[1]!.open = true;
    setHtmlPreservingDisclosures(statefulHost, cache, 'key-1', runHtml);
    expect(innerHtmlWrites).toBe(1);
    expect(detailsElements[1]!.open).toBe(true);

    // Changed key rewrites innerHTML and preserves both open disclosures
    setHtmlPreservingDisclosures(statefulHost, cache, 'key-2', runHtml);
    expect(innerHtmlWrites).toBe(2);
    expect(detailsElements[0]!.open).toBe(true);
    expect(detailsElements[1]!.open).toBe(true);
    void fakeHost;

    // Coexistence with FunctionalController and ChallengeSession
    const funcController = new FunctionalController(
      () => new Promise(() => {}),
      () => {},
    );
    const challengeSession = new ChallengeSession(
      () => {},
      () => new Promise(() => {}),
    );
    const { controller: regController } = setupController();

    funcController.setContext(readyContext);
    regController.setContext(readyContext);
    challengeSession.select(record, finding.id, false);
    regController.selectFinding(record, finding.id, false);

    expect(funcController.state.blockedReason).toBeNull();
    expect(regController.state.captureBlockedReason).toBeNull();
    expect(
      regressionCaptureBlockedReason({
        ...readyContext,
        selectedSystemId: readyContext.systemId,
        isCapturePending: false,
        hasInspectedRun: true,
        inspectedRunTerminal: true,
        inspectedRunSystemId: readyContext.systemId,
        hasSelectedFinding: true,
        findingConfirmed: true,
      }),
    ).toBeNull();
    expect(
      regressionExecutionBlockedReason({
        ...readyContext,
        isRegressionRunPending: false,
        hasSelectedDefinition: true,
      }),
    ).toBeNull();
    expect(typeof initRegressionWorkspaceView).toBe('function');
  });

  it('wires real DOM controls through initRegressionWorkspaceView and preserves open disclosures across unchanged polling', async () => {
    const { record, finding, preview, definition, definitions, runs, detail, runRecord } =
      await createRegressionFixture();

    class FakeDomElement {
      id: string;
      tagName: string;
      textContent = '';
      disabled = false;
      checked = false;
      value = '';
      title = '';
      open = false;
      dataset: Record<string, string> = {};
      attrs: Record<string, string> = {};
      children: FakeDomElement[] = [];
      listeners: Record<string, ((e: any) => void)[]> = {};
      private _innerHTML = '';
      private detailsChildren: FakeDomElement[] = [];
      classList = {
        classes: new Set<string>(['hidden']),
        toggle(cls: string, force?: boolean) {
          if (force === undefined) {
            if (this.classes.has(cls)) this.classes.delete(cls);
            else this.classes.add(cls);
          } else if (force) {
            this.classes.add(cls);
          } else {
            this.classes.delete(cls);
          }
        },
        contains(cls: string) {
          return this.classes.has(cls);
        },
      };

      constructor(tag: string, id = '') {
        this.tagName = tag.toUpperCase();
        this.id = id;
      }

      setAttribute(k: string, v: string) {
        this.attrs[k] = v;
      }
      append(...nodes: FakeDomElement[]) {
        this.children.push(...nodes);
      }
      replaceChildren(...nodes: FakeDomElement[]) {
        this.children = [...nodes];
      }
      addEventListener(type: string, cb: (e: any) => void) {
        (this.listeners[type] ??= []).push(cb);
      }
      dispatch(type: string, event: any = { target: this }) {
        for (const cb of this.listeners[type] ?? []) cb(event);
      }
      get innerHTML() {
        return this._innerHTML;
      }
      set innerHTML(val: string) {
        this._innerHTML = val;
        // Parse data-disclosure-key occurrences into fake details elements
        const matches = [...val.matchAll(/<details\s+data-disclosure-key="([^"]+)"(\s+open)?>/g)];
        this.detailsChildren = matches.map(m => {
          const d = new FakeDomElement('details');
          d.dataset.disclosureKey = m[1]!;
          d.open = Boolean(m[2]);
          return d;
        });
      }
      querySelectorAll(selector: string): FakeDomElement[] {
        if (selector === 'details[data-disclosure-key]') {
          return this.detailsChildren;
        }
        return [];
      }
    }

    const elementsById = new Map<string, FakeDomElement>();
    for (const [id, tag] of [
      ['regression-capture-panel', 'section'],
      ['btn-regression-preview', 'button'],
      ['regression-review-checkbox', 'input'],
      ['btn-regression-save', 'button'],
      ['btn-regression-open-saved', 'button'],
      ['regression-capture-status', 'p'],
      ['regression-preview-container', 'div'],
      ['regression-definition-select', 'select'],
      ['regression-target-select', 'select'],
      ['btn-run-regression', 'button'],
      ['btn-inspect-regression-definition', 'button'],
      ['regression-run-status', 'p'],
      ['regression-definitions-list', 'div'],
      ['regression-definition-detail-container', 'div'],
      ['regression-results-card', 'article'],
      ['regression-run-results-container', 'div'],
      ['regression-run-badge', 'span'],
      ['regression-run-meta', 'p'],
      ['regression-history-list', 'div'],
    ] as const) {
      elementsById.set(id, new FakeDomElement(tag, id));
    }

    vi.stubGlobal('document', {
      getElementById: (id: string) => elementsById.get(id) ?? null,
      createElement: (tag: string) => new FakeDomElement(tag),
    });

    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === '/api/regressions/preview' && init?.method === 'POST') {
        return response(preview);
      }
      if (url === '/api/regressions/definitions' && init?.method === 'POST') {
        return response(definition);
      }
      if (url === '/api/regressions/definitions') {
        return response(definitions);
      }
      if (url === '/api/regressions/runs') {
        return response(runs);
      }
      if (url.startsWith('/api/regressions/definitions/')) {
        return response(detail);
      }
      if (url === '/api/regressions/run' && init?.method === 'POST') {
        return response(runRecord);
      }
      if (url.startsWith('/api/regressions/runs/')) {
        return response(runRecord);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const targetChanges: string[] = [];
    let openedFunctionalView = 0;
    const controller = initRegressionWorkspaceView({
      onTargetChange: v => targetChanges.push(v),
      onOpenFunctionalView: () => {
        openedFunctionalView++;
      },
    });

    controller.setContext(readyContext);
    await vi.waitFor(() => expect(controller.state.definitions).toHaveLength(1));
    controller.selectFinding(record, finding.id, false);

    const btnPreview = elementsById.get('btn-regression-preview')!;
    const checkbox = elementsById.get('regression-review-checkbox')!;
    const btnSave = elementsById.get('btn-regression-save')!;
    const btnOpenSaved = elementsById.get('btn-regression-open-saved')!;
    const previewContainer = elementsById.get('regression-preview-container')!;

    expect(btnPreview.disabled).toBe(false);
    expect(btnSave.disabled).toBe(true);

    // Click preview button
    btnPreview.dispatch('click');
    await vi.waitFor(() => expect(controller.state.preview?.available).toBe(true));
    expect(previewContainer.innerHTML).toContain(preview.definitionId);

    // Open the second disclosure in previewContainer, then run unchanged polling
    const previewDisclosures = previewContainer.querySelectorAll('details[data-disclosure-key]');
    expect(previewDisclosures.length).toBeGreaterThanOrEqual(2);
    previewDisclosures[1]!.open = true;

    controller.setContext(structuredClone(readyContext));
    controller.selectFinding(structuredClone(record), finding.id, false);
    expect(
      previewContainer.querySelectorAll('details[data-disclosure-key]')[1]!.open,
    ).toBe(true);

    // Tick consent checkbox and click Save
    checkbox.checked = true;
    checkbox.dispatch('change', { target: checkbox });
    expect(btnSave.disabled).toBe(false);

    btnSave.dispatch('click');
    await vi.waitFor(() => expect(controller.state.savedDefinition?.id).toBe(definition.id));
    expect(btnOpenSaved.classList.contains('hidden')).toBe(false);

    // Click Open in Functional tests
    btnOpenSaved.dispatch('click');
    expect(openedFunctionalView).toBe(1);
    await vi.waitFor(() =>
      expect(controller.state.definitionDetail?.definition.id).toBe(definition.id),
    );

    // Change target select and click Run selected regression
    const targetSelect = elementsById.get('regression-target-select')!;
    targetSelect.value = 'clean';
    targetSelect.dispatch('change', { target: targetSelect });
    expect(targetChanges).toEqual(['clean']);

    const btnRun = elementsById.get('btn-run-regression')!;
    btnRun.dispatch('click');
    await vi.waitFor(() => expect(controller.state.runRecord?.id).toBe(runRecord.id));
    expect(elementsById.get('regression-results-card')!.classList.contains('hidden')).toBe(false);
    expect(elementsById.get('regression-run-badge')!.textContent).toBe('Failed');
  });
});
