import { describe, expect, it } from 'vitest';
import {
  classifyDeferredStop,
  classifyStartFailure,
  InvestigationLifecycle,
  RequestSequencer,
} from '../src/web/workspace.ts';
import { describeProposals } from '../src/web/proposals.ts';
import type { InvestigationRecord } from '../src/domain.ts';
import type { SimulatorApi } from '../src/storage.ts';

const live = (id: string, status: string, systemId: string | null = 'delivery-qa') => ({ id, status, systemId });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('investigation lifecycle (coupled state used by app.ts)', () => {
  it('open active before save uses the live record, not a saved-artifact fetch', () => {
    const lc = new InvestigationLifecycle();
    lc.noteStatus(live('run-live', 'running'));
    expect(lc.openActiveTarget()?.id).toBe('run-live');
    expect(lc.inspectedIsLive).toBe(true);
  });

  it('explicit active inspection follows running -> stopping -> terminal for the same ID', () => {
    const lc = new InvestigationLifecycle();
    lc.noteStatus(live('run-live', 'running'));
    lc.openActiveTarget();
    expect(lc.pollDecision('delivery-qa')).toBe('render-live');
    lc.noteStatus(live('run-live', 'stopping'));
    expect(lc.pollDecision('delivery-qa')).toBe('render-live');
    lc.noteStatus(live('run-live', 'cancelled'));
    expect(lc.pollDecision('delivery-qa')).toBe('render-live');
    expect(lc.latestLive?.status).toBe('cancelled');
  });

  it('does not overwrite unrelated historical inspection when live changes', () => {
    const lc = new InvestigationLifecycle();
    lc.openHistory('run-old');
    lc.noteStatus(live('run-live', 'running'));
    expect(lc.pollDecision('delivery-qa')).toBe('preserve-inspection');
    lc.noteStatus(live('run-live', 'completed'));
    expect(lc.pollDecision('delivery-qa')).toBe('preserve-inspection');
    expect(lc.inspectedId).toBe('run-old');
  });

  it('switch away then global Open re-opens the live run explicitly (even for another system)', () => {
    const lc = new InvestigationLifecycle();
    lc.noteStatus(live('run-live', 'running', 'delivery-qa'));
    lc.openHistory('run-other-history');
    // Banner/global Open targets live, switching inspection to it explicitly.
    expect(lc.openActiveTarget()?.id).toBe('run-live');
    expect(lc.pollDecision('payments-qa')).toBe('render-live');
  });

  it('auto-render is suppressed for other-system live runs until explicitly opened', () => {
    const lc = new InvestigationLifecycle();
    lc.noteStatus(live('run-live', 'running', 'delivery-qa'));
    expect(lc.pollDecision('payments-qa')).toBe('none');
    expect(lc.pollDecision('delivery-qa')).toBe('render-live');
  });

  it('late detail fetch after newer launch/selection is invalidated (sequencer + beginLaunch)', async () => {
    const seq = new RequestSequencer();
    const lc = new InvestigationLifecycle();
    const token = seq.next();
    const pending = deferred<string>();
    const applied: string[] = [];
    void pending.promise.then(v => { if (seq.isCurrent(token)) applied.push(v); });
    lc.beginLaunch();
    seq.invalidate(); // newer launch/selection, as app.ts does
    pending.resolve('stale-record');
    await pending.promise;
    await Promise.resolve();
    expect(applied).toEqual([]);
    expect(lc.inspectedId).toBeNull();
  });

  it('selection/dirty preservation is a caller decision: lifecycle does not mutate editor state', () => {
    const lc = new InvestigationLifecycle();
    lc.openHistory('run-a');
    // selectSystem only clears inspection; dirty draft fields live outside lifecycle.
    lc.clearInspection();
    expect(lc.inspectedId).toBeNull();
    expect(lc.pendingStopIntent).toBe(false);
  });
});

describe('pending stop / start settlement', () => {
  it('stop before start receipt defers intent instead of posting prematurely', () => {
    const lc = new InvestigationLifecycle();
    lc.beginLaunch();
    expect(lc.requestStop()).toBe('defer-until-start-settles');
    expect(lc.pendingStopIntent).toBe(true);
    expect(lc.settleStart()).toEqual({ deferredStop: true });
    expect(lc.settleStart()).toEqual({ deferredStop: false });
  });

  it('stop during init: only coded START_CANCELLED with intent is an intentional stop', () => {
    expect(classifyStartFailure({ status: 409, code: 'START_CANCELLED', stopRequested: true })).toBe('intentional-stop');
    expect(classifyStartFailure({ status: 409, code: 'START_CANCELLED', stopRequested: false })).toBe('conflict');
    expect(classifyStartFailure({ status: 409, code: null, stopRequested: true })).toBe('conflict');
    expect(classifyStartFailure({ status: 409, code: 'OTHER', stopRequested: true })).toBe('conflict');
    expect(classifyStartFailure({ status: 500, code: null, stopRequested: true })).toBe('failure');
    expect(classifyStartFailure({ status: 400, code: null, stopRequested: false })).toBe('failure');
  });

  it('retains stop intent when status arrives before the start response', () => {
    const lc = new InvestigationLifecycle();
    lc.beginLaunch();
    lc.noteStatus(live('run-early-status', 'running'));
    expect(lc.requestStop()).toBe('defer-until-start-settles');
    expect(lc.settleStart()).toEqual({ deferredStop: true });
    expect(lc.requestStop()).toBe('stop-now');
  });

  it('deferred stop: success stops, 400 is rapid settlement (not cancellation), other errors fail', () => {
    expect(classifyDeferredStop({ ok: true, status: 200 })).toBe('stopping');
    expect(classifyDeferredStop({ ok: false, status: 400 })).toBe('already-settled');
    expect(classifyDeferredStop({ ok: false, status: 500 })).toBe('failed');
    expect(classifyDeferredStop({ ok: false, status: 409 })).toBe('failed');
  });

  it('stop after acceptance goes now; repeated terminal state is not pending', () => {
    const lc = new InvestigationLifecycle();
    lc.beginLaunch();
    lc.noteStatus(live('run-1', 'running'));
    lc.settleStart();
    expect(lc.requestStop()).toBe('stop-now');
  });
});

describe('SIM-01 optional typed getContract', () => {
  it('injected fixtures may omit getContract; present method is invoked optionally', () => {
    const absent: SimulatorApi = {
      getSourceBundle: () => ({ hash: 'h', files: [] }),
      executeExperiment: () => { throw new Error('not used'); },
    };
    expect(absent.getContract ? absent.getContract() : null).toBeNull();
    const contract = { name: 'C', description: '', operations: [], messages: [], invariants: [], limits: {} };
    const present: SimulatorApi = { ...absent, getContract: () => contract };
    expect(present.getContract ? present.getContract() : null).toBe(contract);
  });
});

describe('SIM-02 proposal display model (computed once, passed through)', () => {
  it('preserves count/summary/unknown-usage semantics for the shared display model', () => {
    const rec = {
      provider: 'meta',
      experiments: [{}, {}],
      proposalAttempts: [
        { status: 'pending', usageKnown: false },
        { status: 'invalid_plan', usageKnown: false, requestSent: true },
        { status: 'failed', usageKnown: true, requestSent: true },
      ],
    } as unknown as InvestigationRecord;
    const display = describeProposals(rec);
    expect(display.count).toBe(3);
    expect(display.summary).toContain('3 proposals recorded; 2 experiments executed; 1 proposals rejected; 1 failed or cancelled; 1 pending.');
    expect(display.unknownCost).toBe(true);
    // Same object is what renderActiveRecord passes to renderProposals.
    expect(describeProposals(rec)).toEqual(display);
  });

  it('older records without proposal history keep the null-count display', () => {
    const rec = { provider: 'mock', experiments: [] } as unknown as InvestigationRecord;
    expect(describeProposals(rec).count).toBeNull();
    expect(describeProposals(rec).summary).toContain('not recorded');
  });
});
