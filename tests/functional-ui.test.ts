import { describe, expect, it, vi } from 'vitest';
import { FunctionalController, functionalResultHtml, type FunctionalContext } from '../src/web/functional.ts';
import { functionalExecutionBlockedReason } from '../src/web/workspace.ts';
import { createSystemSnapshot, SEEDED_TRADING_BRIEF } from '../src/systems/index.ts';
import { runFunctionalBaselines } from '../src/functional/runner.ts';

const ready: FunctionalContext = {
  systemId: 'trading-gateway', revision: 1, hasSelectedSystem: true, selectedAdapterId: 'synthetic-trading',
  isDraftMode: false, hasUnsavedSystemEdits: false, isSystemSavePending: false,
  snapshotState: 'ready', targetState: 'ready', selectedVariant: 'clean', allowedVariants: ['clean', 'candidate-c'],
};
const deferred = () => { let resolve!: (v: any) => void; let reject!: (e: Error) => void;
  const promise = new Promise<any>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const response = (value: any, ok = true) => ({ ok, status: ok ? 200 : 409, json: async () => value });
async function record() { return runFunctionalBaselines({ variant: 'clean', systemSnapshot: await createSystemSnapshot(SEEDED_TRADING_BRIEF) }); }
function setup() {
  const requests: { url: string; init?: RequestInit; deferred: ReturnType<typeof deferred> }[] = [];
  const render = vi.fn();
  const controller = new FunctionalController((url, init) => { const d = deferred(); requests.push({ url, init, deferred: d }); return d.promise; }, render);
  controller.setContext(ready);
  return { controller, requests, render };
}

describe('production functional controller with app context transitions', () => {
  it('ignores unchanged app context without rerendering or disturbing a pending launch', async () => {
    const { controller, requests, render } = setup();
    const initialRenders = render.mock.calls.length;
    controller.setContext(structuredClone(ready));
    expect(render).toHaveBeenCalledTimes(initialRenders);
    expect(requests).toHaveLength(1);

    const run = controller.run(), request = requests.at(-1)!;
    const pendingRenders = render.mock.calls.length;
    controller.setContext(structuredClone(ready));
    expect(render).toHaveBeenCalledTimes(pendingRenders);
    expect(controller.state.pending).toBe(true);
    expect(requests.filter(r => r.url === '/api/functional/run')).toHaveLength(1);
    request.deferred.resolve(response(await record())); await run;
    expect(controller.state.pending).toBe(false);
    expect(controller.state.record?.status).toBe('pass');

    const settledRenders = render.mock.calls.length;
    controller.setContext({ ...ready, revision: 2 });
    expect(render).toHaveBeenCalledTimes(settledRenders + 1);
    expect(controller.state.record).toBeNull();
  });

  it.each([
    { hasUnsavedSystemEdits: true }, { isDraftMode: true }, { isSystemSavePending: true },
    { targetState: 'loading' as const }, { snapshotState: 'error' as const },
    { selectedAdapterId: 'inventory-reservation' }, { systemId: null, hasSelectedSystem: false },
    { selectedVariant: 'unsupported' },
  ])('blocks render and execution for %j', async patch => {
    const { controller, requests } = setup(); controller.setContext({ ...ready, ...patch });
    const count = requests.length; await controller.run();
    expect(requests.length).toBe(count); expect(controller.state.blockedReason).not.toBeNull();
  });
  it('saved -> dirty -> discard/save and saved -> draft never launch the old saved context', async () => {
    const { controller, requests } = setup();
    controller.setContext({ ...ready, hasUnsavedSystemEdits: true }); await controller.run();
    controller.setContext({ ...ready, isDraftMode: true }); await controller.run();
    expect(requests.every(r => r.url !== '/api/functional/run')).toBe(true);
    controller.setContext({ ...ready, revision: 2 }); const run = controller.run();
    const request = requests.at(-1)!;
    expect(JSON.parse(request.init!.body as string)).toEqual({ systemId: ready.systemId, expectedRevision: 2, variant: 'clean' });
    request.deferred.resolve(response({ error: 'Revision conflict' }, false)); await run;
    expect(controller.state.error).toContain('Revision conflict');
    expect(controller.state.context?.revision).toBe(2); // No fetch silently adopts another revision.
  });
  it('establishes pending before await and prevents double launch', async () => {
    const { controller, requests } = setup(); const first = controller.run(); await controller.run();
    expect(requests.filter(r => r.url === '/api/functional/run')).toHaveLength(1);
    expect(controller.state.pending).toBe(true);
    requests.at(-1)!.deferred.resolve(response(await record())); await first;
    expect(controller.state.record?.status).toBe('pass'); expect(controller.state.pending).toBe(false);
  });
  it.each([
    { systemId: 'other' }, { revision: 2 }, { selectedAdapterId: 'inventory-reservation' },
    { selectedVariant: 'candidate-c' }, { hasUnsavedSystemEdits: true }, { isDraftMode: true },
    { isSystemSavePending: true }, { targetState: 'loading' as const },
  ])('drops old run success/error/finally after context transition %j', async patch => {
    for (const fails of [false, true]) {
      const { controller, requests } = setup(); const old = controller.run(); const oldRequest = requests.at(-1)!;
      controller.setContext({ ...ready, ...patch });
      if (fails) oldRequest.deferred.reject(new Error('late error')); else oldRequest.deferred.resolve(response(await record()));
      await old;
      expect(controller.state.record).toBeNull(); expect(controller.state.error).toBeNull();
      expect(controller.state.blockedReason).toBe(functionalExecutionBlockedReason({ ...ready, ...patch, isFunctionalRunPending: false }));
    }
  });
  it('old finally cannot clear newer run pending state', async () => {
    const { controller, requests } = setup(); const old = controller.run(); const a = requests.at(-1)!;
    controller.setContext({ ...ready, revision: 2 }); const newer = controller.run(); const b = requests.at(-1)!;
    a.deferred.reject(new Error('stale')); await old;
    expect(controller.state.pending).toBe(true); expect(controller.state.error).toBeNull();
    b.deferred.resolve(response({ ...await record(), systemBrief: { ...(await record()).systemBrief, revision: 2 } })); await newer;
    expect(controller.state.pending).toBe(false);
  });
  it('newer history wins; stale history and its errors cannot replace another profile', async () => {
    const { controller, requests } = setup(); const initial = requests[0]!;
    const loading = controller.loadHistory(); const newer = requests.at(-1)!;
    const r = await record(); newer.deferred.resolve(response([r])); await loading;
    initial.deferred.resolve(response([])); await Promise.resolve(); await Promise.resolve();
    expect(controller.state.history.map(h => h.id)).toEqual([r.id]);
    const old = controller.loadHistory(); const prior = requests.at(-1)!;
    controller.setContext({ ...ready, systemId: 'other' }); prior.deferred.reject(new Error('late history error')); await old;
    expect(controller.state.history).toEqual([]); expect(controller.state.historyError).toBeNull();
  });
  it('new inspection wins over older detail and late run results, and historical identity stays pinned', async () => {
    const { controller, requests } = setup(); const r = await record(), second = { ...r, id: 'second', variant: 'candidate-c' as const, systemBrief: { ...r.systemBrief, revision: 9 } };
    requests[0]!.deferred.resolve(response([r, second])); await new Promise(resolve => setTimeout(resolve, 0));
    const run = controller.run(), runRequest = requests.at(-1)!;
    const old = controller.open(r.id), oldRequest = requests.at(-1)!;
    const newer = controller.open(second.id), newerRequest = requests.at(-1)!;
    newerRequest.deferred.resolve(response(second)); await newer;
    oldRequest.deferred.reject(new Error('late detail')); await old;
    runRequest.deferred.resolve(response(r)); await run;
    expect(controller.state.record?.id).toBe('second'); expect(controller.state.record?.systemBrief.revision).toBe(9);
    expect(controller.state.context?.revision).toBe(1); expect(controller.state.error).toBeNull();
    const html = functionalResultHtml(second);
    expect(html).toContain('revision 9'); expect(html).toContain('candidate-c');
    for (const label of ['systemSnapshot', 'contract', 'evaluator', 'sourceHash', 'expectedMilestones', 'rejections', 'violations', 'requirementRuleResults']) {
      if (label !== 'requirementRuleResults') expect(html).toContain(label);
    }
  });
  it('context changes discard late detail, including A -> B -> A', async () => {
    const { controller, requests } = setup(); const r = await record();
    requests[0]!.deferred.resolve(response([r])); await new Promise(resolve => setTimeout(resolve, 0));
    const open = controller.open(r.id), request = requests.at(-1)!;
    controller.setContext({ ...ready, systemId: 'other' }); controller.setContext(ready);
    request.deferred.resolve(response(r)); await open;
    expect(controller.state.record).toBeNull();
  });
  it('rejects wrong run response identity and escapes saved evidence', async () => {
    const { controller, requests } = setup(); const run = controller.run(), r = await record();
    r.systemBrief.id = '<other>'; requests.at(-1)!.deferred.resolve(response(r)); await run;
    expect(controller.state.record).toBeNull(); expect(controller.state.error).toContain('identity');
    expect(functionalResultHtml(r)).toContain('&lt;other&gt;'); expect(functionalResultHtml(r)).not.toContain('<other>');
  });
  it('displays configured rule, oracle, rejection and unavailable-evaluator evidence', async () => {
    const snapshot = await createSystemSnapshot({ ...SEEDED_TRADING_BRIEF, requirementRules: [{
      requirement: 'Total commitments include both used and reserved credit. New order admission respects the current limit.',
      preset: 'accepted-order-credit-limit', reviewed: true,
    }] });
    const r = await runFunctionalBaselines({ variant: 'candidate-c', systemSnapshot: snapshot });
    const html = functionalResultHtml(r);
    expect(html).toContain('requirementRuleResults'); expect(html).toContain('accepted-order-credit-limit');
    expect(html).toContain('failed'); expect(html).toContain('violations'); expect(html).toContain('rejections');
    delete snapshot.requirementEvaluator;
    const unavailable = await runFunctionalBaselines({ variant: 'clean', systemSnapshot: snapshot });
    expect(functionalResultHtml(unavailable)).toContain('requirementEvaluationError');
    expect(functionalResultHtml(unavailable)).toContain('Requirement evaluator identity is missing');
  });

});
