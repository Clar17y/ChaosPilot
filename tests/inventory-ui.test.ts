import { describe, expect, it } from 'vitest';
import {
  contractChecksVisible, defaultTargetVariant, executableCheckCount, isExecutableAdapter,
  launchBlockedReason, RequestSequencer, targetVariantsForAdapter, validateSystemSnapshot,
} from '../src/web/workspace.ts';
import { fetchSystemSnapshot, loadSystemContract } from '../src/web/request-boundaries.ts';
import type { SnapshotLoadState } from '../src/web/workspace.ts';

const base = { isLaunchRequestPending: false, isInvestigationActive: false, isSystemSavePending: false, isDraftMode: false, hasUnsavedSystemEdits: false, hasSelectedSystem: true };
const snapshot = (id: string, adapterId: string, contract: unknown = { invariants: [{ id: 'INV-1', description: 'x' }], operations: [{ op: 'reserve' }], messages: [{ channel: 'stock', type: 'reserve' }] }) => ({ brief: { id, adapterId, revision: 1 }, contract, hash: 'abc123' });
function res(body: unknown, ok = true, status = 200) { return { ok, status, json: async () => body }; }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

describe('inventory adapter readiness (unsupported on this branch)', () => {
  it('treats only synthetic-trading as executable; inventory is not executable', () => {
    expect(isExecutableAdapter('inventory-reservation')).toBe(false);
    expect(isExecutableAdapter('synthetic-trading')).toBe(true);
    expect(isExecutableAdapter('unconfigured')).toBe(false);
    expect(executableCheckCount('inventory-reservation', 3)).toBe(0);
    expect(executableCheckCount('synthetic-trading', 3)).toBe(3);
    expect(executableCheckCount('unconfigured', 3)).toBe(0);
  });
  it('allows saved trading only with ready snapshot and scoped variant', () => {
    expect(launchBlockedReason({ ...base, selectedAdapterId: 'synthetic-trading', snapshotState: 'ready', selectedVariant: 'candidate-a', allowedVariants: ['clean', 'candidate-a'] })).toBeNull();
    expect(launchBlockedReason({ ...base, selectedAdapterId: 'synthetic-trading', snapshotState: 'ready', selectedVariant: 'inventory-candidate-a', allowedVariants: ['clean', 'candidate-a'] })).toMatch(/TARGET NOT AVAILABLE/);
  });
  it('blocks inventory launch even with a ready snapshot and an inventory variant', () => {
    // Fabricated inventory fixtures must not prove backend capability.
    expect(launchBlockedReason({ ...base, selectedAdapterId: 'inventory-reservation', snapshotState: 'ready', selectedVariant: 'inventory-candidate-a', allowedVariants: ['clean', 'inventory-candidate-a'] })).toMatch(/NOT AVAILABLE ON THIS SERVER/);
    expect(launchBlockedReason({ ...base, selectedAdapterId: 'inventory-reservation', snapshotState: 'ready', selectedVariant: 'clean', allowedVariants: ['clean'] })).toMatch(/NOT AVAILABLE/);
  });
  it('blocks unconfigured, dirty, draft, loading and failed contexts', () => {
    expect(launchBlockedReason({ ...base, selectedAdapterId: 'unconfigured' })).toMatch(/UNCONFIGURED/);
    expect(launchBlockedReason({ ...base, selectedAdapterId: 'synthetic-trading', hasUnsavedSystemEdits: true, snapshotState: 'ready' })).toMatch(/SAVE OR DISCARD/);
    expect(launchBlockedReason({ ...base, selectedAdapterId: 'synthetic-trading', isDraftMode: true, hasUnsavedSystemEdits: true })).toMatch(/SAVE THE NEW/);
    expect(launchBlockedReason({ ...base, selectedAdapterId: 'synthetic-trading', snapshotState: 'loading' })).toMatch(/LOADING/);
    expect(launchBlockedReason({ ...base, selectedAdapterId: 'synthetic-trading', snapshotState: 'error' })).toMatch(/UNAVAILABLE/);
    expect(launchBlockedReason({ ...base, selectedAdapterId: 'synthetic-trading', snapshotState: 'none' })).toMatch(/NOT CONFIRMED/);
    expect(launchBlockedReason({ ...base, selectedAdapterId: 'synthetic-trading', snapshotState: 'ready', isInvestigationActive: true })).toMatch(/IN PROGRESS/);
  });
});

describe('scoped target choices', () => {
  it('offers no inventory options and only trading options for trading', () => {
    const global = ['clean', 'candidate-a', 'candidate-b', 'inventory-candidate-a'];
    expect(targetVariantsForAdapter('inventory-reservation', global)).toEqual([]);
    expect(targetVariantsForAdapter('inventory-reservation', ['clean', 'candidate-a'])).toEqual([]);
    expect(targetVariantsForAdapter('synthetic-trading', global)).toEqual(['clean', 'candidate-a', 'candidate-b']);
    expect(targetVariantsForAdapter('unconfigured', global)).toEqual([]);
    expect(defaultTargetVariant(['clean', 'candidate-a'])).toBe('candidate-a');
  });
});

describe('snapshot validation and fetching', () => {
  it('accepts own trading contract and rejects mismatch, missing contract and bad shapes', () => {
    expect(validateSystemSnapshot(snapshot('inv-1', 'synthetic-trading'), 'inv-1').ok).toBe(true);
    expect(validateSystemSnapshot(snapshot('other', 'synthetic-trading'), 'inv-1').ok).toBe(false);
    expect(validateSystemSnapshot(snapshot('inv-1', 'synthetic-trading', null), 'inv-1').ok).toBe(false);
    expect(validateSystemSnapshot({ brief: { id: 'inv-1', adapterId: 'synthetic-trading' }, contract: { invariants: [] }, hash: 'x' }, 'inv-1').ok).toBe(false);
    expect(validateSystemSnapshot({ brief: { id: 'u1', adapterId: 'unconfigured' }, contract: null, hash: 'x' }, 'u1').ok).toBe(true);
    // An inventory snapshot carrying a contract is not executable evidence on this branch.
    expect(validateSystemSnapshot(snapshot('inv-1', 'inventory-reservation'), 'inv-1').ok).toBe(false);
    expect(contractChecksVisible({ effectiveAdapterId: 'synthetic-trading', snapshotState: 'ready', isDraftMode: false, hasUnsavedSystemEdits: false })).toBe(true);
    expect(contractChecksVisible({ effectiveAdapterId: 'inventory-reservation', snapshotState: 'ready', isDraftMode: false, hasUnsavedSystemEdits: false })).toBe(false);
    expect(contractChecksVisible({ effectiveAdapterId: 'synthetic-trading', snapshotState: 'ready', isDraftMode: false, hasUnsavedSystemEdits: true })).toBe(false);
    expect(contractChecksVisible({ effectiveAdapterId: 'synthetic-trading', snapshotState: 'error', isDraftMode: false, hasUnsavedSystemEdits: false })).toBe(false);
  });
  it('fetches per-system snapshot URL and rejects failures', async () => {
    const urls: string[] = [];
    const ok = await fetchSystemSnapshot(async (u) => { urls.push(u); return res(snapshot('inv-1', 'synthetic-trading')); }, 'inv-1');
    expect(urls).toEqual(['/api/systems/inv-1/snapshot']);
    expect(ok.brief.id).toBe('inv-1');
    await expect(fetchSystemSnapshot(async () => res({ error: 'boom' }, false, 503), 'inv-1')).rejects.toThrow(/boom/);
    await expect(fetchSystemSnapshot(async () => res(snapshot('other', 'synthetic-trading')), 'inv-1')).rejects.toThrow(/mismatch/);
  });
  it('requires exact selected id, revision and adapter identity', () => {
    const expected = { id: 'inv-1', revision: 1, adapterId: 'synthetic-trading' };
    expect(validateSystemSnapshot(snapshot('inv-1', 'synthetic-trading'), expected).ok).toBe(true);
    // Same id, newer revision (profile changed concurrently on the server).
    const newer = { brief: { id: 'inv-1', adapterId: 'synthetic-trading', revision: 2 }, contract: snapshot('x', 'synthetic-trading').contract, hash: 'h' };
    expect(validateSystemSnapshot(newer, expected)).toEqual({ ok: false, reason: 'snapshot revision mismatch' });
    // Same id and revision, changed adapter.
    const changedAdapter = { brief: { id: 'inv-1', adapterId: 'unconfigured', revision: 1 }, contract: snapshot('x', 'synthetic-trading').contract, hash: 'h' };
    expect(validateSystemSnapshot(changedAdapter, expected)).toEqual({ ok: false, reason: 'snapshot adapter mismatch' });
    expect(validateSystemSnapshot(snapshot('other', 'synthetic-trading'), expected).ok).toBe(false);
    // Legacy string form and variadic form keep working.
    expect(validateSystemSnapshot(snapshot('inv-1', 'synthetic-trading'), 'inv-1').ok).toBe(true);
    expect(validateSystemSnapshot(newer, 'inv-1', 1, 'synthetic-trading').ok).toBe(false);
    expect(validateSystemSnapshot(snapshot('inv-1', 'synthetic-trading'), 'inv-1', 1, 'synthetic-trading').ok).toBe(true);
  });
  it('fetchSystemSnapshot rejects same-id newer revision / changed adapter and accepts exact match', async () => {
    const expected = { id: 'inv-1', revision: 1, adapterId: 'synthetic-trading' };
    await expect(fetchSystemSnapshot(async () => res(snapshot('inv-1', 'synthetic-trading')), expected)).resolves.toMatchObject({ brief: { revision: 1 } });
    const newer = { brief: { id: 'inv-1', adapterId: 'synthetic-trading', revision: 2 }, contract: snapshot('x', 'synthetic-trading').contract, hash: 'h' };
    await expect(fetchSystemSnapshot(async () => res(newer), expected)).rejects.toThrow(/revision mismatch/);
    const changed = { brief: { id: 'inv-1', adapterId: 'unconfigured', revision: 1 }, contract: snapshot('x', 'synthetic-trading').contract, hash: 'h' };
    await expect(fetchSystemSnapshot(async () => res(changed), expected)).rejects.toThrow(/adapter mismatch/);
  });
  it('delayed out-of-order responses are dropped by the sequencer used in app.ts', async () => {
    const seq = new RequestSequencer();
    const first = seq.next(); const second = seq.next();
    const d = deferred<unknown>(); const applied: string[] = [];
    void d.promise.then(v => { if (seq.isCurrent(first)) applied.push(String(v)); });
    d.resolve(snapshot('inv-1', 'synthetic-trading'));
    await d.promise; await Promise.resolve();
    expect(seq.isCurrent(second)).toBe(true);
    expect(applied).toEqual([]);
  });
});

describe('production contract load path (loadSystemContract used by app.ts)', () => {
  // Mirrors app.ts fetchSystemContract callbacks: state + readiness recomputed
  // from the production launchBlockedReason on every side-effect callback,
  // with no status polling involved.
  function harness(selected: { id: string; revision: number; adapterId: string }) {
    const seq = new RequestSequencer();
    let state: SnapshotLoadState = 'none';
    let dirty = false;
    let current = { ...selected };
    const events: string[] = [];
    const readiness = () => launchBlockedReason({ ...base, selectedAdapterId: current.adapterId, snapshotState: state, selectedVariant: 'candidate-a', allowedVariants: ['clean', 'candidate-a'] });
    const load = (fetchFn: (u: string) => Promise<unknown>, expected = { ...current }) => loadSystemContract({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchFn as any, expected, sequencer: seq,
      isCurrentSelection: () => !dirty && current.id === expected.id && current.revision === expected.revision && current.adapterId === expected.adapterId,
      onLoading: () => { state = 'loading'; events.push(`loading:${readiness()}`); },
      onReady: () => { state = 'ready'; events.push(`ready:${readiness()}`); },
      onIncompatible: () => { state = 'incompatible'; events.push(`incompatible:${readiness()}`); },
      onError: (e) => { state = 'error'; events.push(`error:${e instanceof Error ? e.message : e}:${readiness()}`); },
    });
    return { seq, load, events, get state() { return state; }, readiness, setDirty: (v: boolean) => { dirty = v; }, switchTo: (s: { id: string; revision: number; adapterId: string }) => { current = { ...s }; } };
  }
  const inv = { id: 'inv-1', revision: 1, adapterId: 'synthetic-trading' };

  it('loading-to-ready enables launch immediately without a later status poll', async () => {
    const h = harness(inv);
    const d = deferred<unknown>();
    const p = h.load(() => d.promise);
    expect(h.state).toBe('loading');
    expect(h.readiness()).toMatch(/LOADING/);
    d.resolve(res(snapshot('inv-1', 'synthetic-trading')));
    await expect(p).resolves.toBe('ready');
    expect(h.state).toBe('ready');
    expect(h.readiness()).toBeNull(); // enabled by the success callback alone
    expect(h.events).toEqual(['loading:LOADING SYSTEM CONTRACT', 'ready:null']);
  });

  it('identity mismatch fails visibly as error, never ready, and reselection recovers', async () => {
    const h = harness(inv);
    const newer = { brief: { id: 'inv-1', adapterId: 'synthetic-trading', revision: 2 }, contract: snapshot('x', 'synthetic-trading').contract, hash: 'h' };
    await expect(h.load(async () => res(newer))).resolves.toBe('error');
    expect(h.state).toBe('error');
    expect(h.readiness()).toMatch(/UNAVAILABLE/);
    expect(h.events.some(e => e.startsWith('ready'))).toBe(false);
    // Intentional refresh/reselection to the newer saved profile recovers.
    h.switchTo({ id: 'inv-1', revision: 2, adapterId: 'synthetic-trading' });
    await expect(h.load(async () => res(newer))).resolves.toBe('ready');
    expect(h.readiness()).toBeNull();
  });

  it('rapid switches: delayed response for the old system is stale with no side effects', async () => {
    const h = harness(inv);
    const slow = deferred<unknown>();
    const p1 = h.load(() => slow.promise);
    h.switchTo({ id: 'inv-2', revision: 1, adapterId: 'synthetic-trading' });
    const snap2 = { brief: { id: 'inv-2', adapterId: 'synthetic-trading', revision: 1 }, contract: snapshot('x', 'synthetic-trading').contract, hash: 'h' };
    await expect(h.load(async () => res(snap2))).resolves.toBe('ready');
    const eventsAfterSwitch = [...h.events];
    slow.resolve(res(snapshot('inv-1', 'synthetic-trading')));
    await expect(p1).resolves.toBe('stale');
    expect(h.events).toEqual(eventsAfterSwitch);
    expect(h.state).toBe('ready');
  });

  it('loading then HTTP error blocks launch; incompatible (null contract) blocks as not confirmed', async () => {
    const h = harness(inv);
    await expect(h.load(async () => res({ error: 'boom' }, false, 503))).resolves.toBe('error');
    expect(h.state).toBe('error');
    expect(h.readiness()).toMatch(/UNAVAILABLE/);
    const h2 = harness({ id: 'u1', revision: 1, adapterId: 'unconfigured' });
    const unconfiguredSnap = { brief: { id: 'u1', adapterId: 'unconfigured', revision: 1 }, contract: null, hash: 'x' };
    await expect(h2.load(async () => res(unconfiguredSnap))).resolves.toBe('incompatible');
    expect(h2.state).toBe('incompatible');
  });

  it('dirty during loading drops the response; discard (clean reselection) recovers to ready', async () => {
    const h = harness(inv);
    const d = deferred<unknown>();
    const p = h.load(() => d.promise);
    h.setDirty(true); // markUnsavedEdits in app.ts also invalidates the sequencer
    h.seq.invalidate();
    d.resolve(res(snapshot('inv-1', 'synthetic-trading')));
    await expect(p).resolves.toBe('stale');
    expect(h.events.some(e => e.startsWith('ready'))).toBe(false);
    h.setDirty(false); // discard -> selectSystem -> fresh load
    await expect(h.load(async () => res(snapshot('inv-1', 'synthetic-trading')))).resolves.toBe('ready');
    expect(h.readiness()).toBeNull();
  });

  it('selection changed while loading (same id, newer revision) drops the old response', async () => {
    const h = harness(inv);
    const d = deferred<unknown>();
    const p = h.load(() => d.promise);
    h.switchTo({ id: 'inv-1', revision: 2, adapterId: 'synthetic-trading' });
    d.resolve(res(snapshot('inv-1', 'synthetic-trading')));
    await expect(p).resolves.toBe('stale');
    expect(h.events.some(e => e.startsWith('ready'))).toBe(false);
  });
});
