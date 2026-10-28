import { describe, expect, it } from 'vitest';
import {
  contractChecksVisible, defaultTargetVariant, executableCheckCount, isExecutableAdapter,
  launchBlockedReason, RequestSequencer, resolveSelectedTargetVariant, targetVariantsForAdapter, TargetSelectionSession, validateSystemSnapshot, validateTargetVariantsResponse,
} from '../src/web/workspace.ts';
import { fetchAdapterTargets, fetchSystemSnapshot, loadAdapterTargets, loadSystemContract } from '../src/web/request-boundaries.ts';
import type { SnapshotLoadState } from '../src/web/workspace.ts';
import {
  extractInventorySnapshotDisplay, extractSnapshotDisplay, inspectedRunAdapterId,
  stateKindForInspectedRun, stateKindForRecord, statePresentationFor,
} from '../src/web/snapshot.ts';
import { formatContractEntry } from '../src/web/presentation.ts';

const base = { isLaunchRequestPending: false, isInvestigationActive: false, isSystemSavePending: false, isDraftMode: false, hasUnsavedSystemEdits: false, hasSelectedSystem: true };
const snapshot = (id: string, adapterId: string, contract: unknown = { invariants: [{ id: 'INV-1', description: 'x' }], operations: [{ op: 'reserve' }], messages: [{ channel: 'stock', type: 'reserve' }] }) => ({ brief: { id, adapterId, revision: 1 }, contract, hash: 'abc123' });
function res(body: unknown, ok = true, status = 200) { return { ok, status, json: async () => body }; }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

describe('inventory adapter readiness', () => {
  it('treats inventory-reservation as executable alongside trading, not unconfigured', () => {
    expect(isExecutableAdapter('inventory-reservation')).toBe(true);
    expect(isExecutableAdapter('synthetic-trading')).toBe(true);
    expect(isExecutableAdapter('unconfigured')).toBe(false);
    expect(executableCheckCount('inventory-reservation', 3)).toBe(3);
    expect(executableCheckCount('unconfigured', 3)).toBe(0);
  });
  it('allows saved inventory/trading only with ready snapshot and scoped variant', () => {
    expect(launchBlockedReason({ ...base, selectedAdapterId: 'inventory-reservation', snapshotState: 'ready', selectedVariant: 'inventory-candidate-a', allowedVariants: ['clean', 'inventory-candidate-a'] })).toBeNull();
    expect(launchBlockedReason({ ...base, selectedAdapterId: 'synthetic-trading', snapshotState: 'ready', selectedVariant: 'candidate-a', allowedVariants: ['clean', 'candidate-a'] })).toBeNull();
    expect(launchBlockedReason({ ...base, selectedAdapterId: 'inventory-reservation', snapshotState: 'ready', selectedVariant: 'candidate-a', allowedVariants: ['clean', 'inventory-candidate-a'] })).toMatch(/TARGET NOT AVAILABLE/);
  });
  it('blocks unconfigured, dirty, draft, loading and failed contexts', () => {
    expect(launchBlockedReason({ ...base, selectedAdapterId: 'unconfigured' })).toMatch(/UNCONFIGURED/);
    expect(launchBlockedReason({ ...base, selectedAdapterId: 'inventory-reservation', hasUnsavedSystemEdits: true, snapshotState: 'ready' })).toMatch(/SAVE OR DISCARD/);
    expect(launchBlockedReason({ ...base, selectedAdapterId: 'inventory-reservation', isDraftMode: true, hasUnsavedSystemEdits: true })).toMatch(/SAVE THE NEW/);
    expect(launchBlockedReason({ ...base, selectedAdapterId: 'inventory-reservation', snapshotState: 'loading' })).toMatch(/LOADING/);
    expect(launchBlockedReason({ ...base, selectedAdapterId: 'inventory-reservation', snapshotState: 'error' })).toMatch(/UNAVAILABLE/);
    expect(launchBlockedReason({ ...base, selectedAdapterId: 'inventory-reservation', snapshotState: 'none' })).toMatch(/NOT CONFIRMED/);
    expect(launchBlockedReason({ ...base, selectedAdapterId: 'inventory-reservation', snapshotState: 'ready', isInvestigationActive: true })).toMatch(/IN PROGRESS/);
  });
});

describe('scoped target choices (per-adapter endpoint is source of truth)', () => {
  it('offers exactly the selected adapter response, never an invented inventory fallback', () => {
    // Each list below is the already-scoped /api/targets?adapterId=... response.
    expect(targetVariantsForAdapter('inventory-reservation', ['clean', 'inventory-candidate-a'])).toEqual(['clean', 'inventory-candidate-a']);
    // If the backend stops reporting inventory-candidate-a, the UI must not invent it.
    expect(targetVariantsForAdapter('inventory-reservation', ['clean', 'candidate-a'])).toEqual(['clean', 'candidate-a']);
    expect(targetVariantsForAdapter('inventory-reservation', [])).toEqual([]);
    expect(targetVariantsForAdapter('synthetic-trading', ['clean', 'candidate-a', 'candidate-b'])).toEqual(['clean', 'candidate-a', 'candidate-b']);
    expect(targetVariantsForAdapter('synthetic-trading', ['clean', 'inventory-candidate-a'])).toEqual(['clean', 'inventory-candidate-a']);
    expect(targetVariantsForAdapter('unconfigured', ['clean', 'candidate-a'])).toEqual([]);
    expect(targetVariantsForAdapter(null, ['clean'])).toEqual([]);
    expect(defaultTargetVariant(['clean', 'inventory-candidate-a'])).toBe('inventory-candidate-a');
    expect(defaultTargetVariant(['clean', 'custom-x'])).toBe('custom-x');
    expect(defaultTargetVariant(['clean'])).toBe('clean');
    expect(defaultTargetVariant([])).toBeNull();
  });
  it('validates responses and preserves only a still-supported selection', () => {
    expect(validateTargetVariantsResponse(['clean', 'candidate-a'])).toEqual({ ok: true, variants: ['clean', 'candidate-a'] });
    expect(validateTargetVariantsResponse([])).toEqual({ ok: true, variants: [] });
    for (const bad of [null, {}, 'clean', ['clean', 42], [''], [' clean'], ['clean', 'clean']]) {
      expect(validateTargetVariantsResponse(bad).ok).toBe(false);
    }
    expect(resolveSelectedTargetVariant('candidate-b', ['clean', 'candidate-a', 'candidate-b'])).toBe('candidate-b');
    expect(resolveSelectedTargetVariant('candidate-b', ['clean', 'candidate-a'])).toBe('candidate-a'); // removed -> supported default
    expect(resolveSelectedTargetVariant('inventory-candidate-a', ['clean'])).toBe('clean');
    expect(resolveSelectedTargetVariant(null, [])).toBeNull();
  });
  it('blocks launch for loading, failed, unloaded and empty target lists with accurate reasons', () => {
    const readySnap = { ...base, selectedAdapterId: 'inventory-reservation', snapshotState: 'ready' as const, allowedVariants: ['clean', 'inventory-candidate-a'], selectedVariant: 'inventory-candidate-a' };
    expect(launchBlockedReason({ ...readySnap, targetState: 'loading', allowedVariants: [] })).toMatch(/LOADING TARGETS/);
    expect(launchBlockedReason({ ...readySnap, targetState: 'error', allowedVariants: [] })).toMatch(/TARGET LIST UNAVAILABLE/);
    expect(launchBlockedReason({ ...readySnap, targetState: 'idle', allowedVariants: [] })).toMatch(/TARGET LIST NOT LOADED/);
    expect(launchBlockedReason({ ...readySnap, targetState: 'ready', allowedVariants: [], selectedVariant: null })).toMatch(/NO TARGET AVAILABLE/);
    expect(launchBlockedReason({ ...readySnap, targetState: 'ready' })).toBeNull();
  });
});

describe('production target load path (loadAdapterTargets used by app.ts)', () => {
  function harness(selected: { id: string; revision: number; adapterId: string }) {
    const seq = new RequestSequencer();
    let current = { ...selected };
    let dirty = false;
    const events: string[] = [];
    let variants: string[] = [];
    let state: string = 'idle';
    const readiness = () => launchBlockedReason({ ...base, selectedAdapterId: current.adapterId, snapshotState: 'ready', targetState: state as never, allowedVariants: variants, selectedVariant: resolveSelectedTargetVariant(null, variants) });
    const load = (fetchFn: (u: string) => Promise<unknown>, expected = { ...current }) => loadAdapterTargets({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchFn as any, adapterId: expected.adapterId, sequencer: seq,
      isCurrentSelection: () => !dirty && current.id === expected.id && current.revision === expected.revision && current.adapterId === expected.adapterId,
      onLoading: () => { state = 'loading'; variants = []; events.push(`loading:${readiness()}`); },
      onReady: (v) => { state = 'ready'; variants = [...v]; events.push(`ready:${readiness()}:${v.join(',')}`); },
      onEmpty: () => { state = 'ready'; variants = []; events.push(`empty:${readiness()}`); },
      onError: (e) => { state = 'error'; variants = []; events.push(`error:${e instanceof Error ? e.message : e}:${readiness()}`); },
    });
    return { seq, load, events, readiness, get variants() { return variants; }, setDirty: (v: boolean) => { dirty = v; }, switchTo: (s: typeof selected) => { current = { ...s }; } };
  }
  const inv = { id: 'inv-1', revision: 1, adapterId: 'inventory-reservation' };

  it('fetches the per-adapter URL and enables only reported variants', async () => {
    const urls: string[] = [];
    await expect(fetchAdapterTargets(async (u) => { urls.push(u); return res(['clean', 'inventory-candidate-a']); }, 'inventory-reservation')).resolves.toEqual(['clean', 'inventory-candidate-a']);
    expect(urls).toEqual(['/api/targets?adapterId=inventory-reservation']);
    const h = harness(inv);
    await expect(h.load(async () => res(['clean', 'inventory-candidate-a']))).resolves.toBe('ready');
    expect(h.readiness()).toBeNull();
  });
  it('empty, malformed and HTTP-error responses block launch without fallback', async () => {
    const h = harness(inv);
    await expect(h.load(async () => res([]))).resolves.toBe('empty');
    expect(h.readiness()).toMatch(/NO TARGET AVAILABLE/);
    const h2 = harness(inv);
    await expect(h2.load(async () => res({ variants: ['clean'] }))).resolves.toBe('error');
    expect(h2.readiness()).toMatch(/TARGET LIST UNAVAILABLE/);
    const h3 = harness(inv);
    await expect(h3.load(async () => res({ error: 'boom' }, false, 400))).resolves.toBe('error');
    expect(h3.events.at(-1)).toContain('boom');
    await expect(fetchAdapterTargets(async () => res(['clean', 'clean']), 'inventory-reservation')).rejects.toThrow(/duplicate/);
  });
  it('rapid A-to-B: late success and late error for A are stale with no side effects', async () => {
    const h = harness(inv);
    const slow = deferred<unknown>();
    const p1 = h.load(() => slow.promise);
    h.switchTo({ id: 'trade-1', revision: 1, adapterId: 'synthetic-trading' });
    await expect(h.load(async () => res(['clean', 'candidate-a']))).resolves.toBe('ready');
    const after = [...h.events];
    slow.resolve(res(['clean', 'inventory-candidate-a']));
    await expect(p1).resolves.toBe('stale');
    expect(h.events).toEqual(after);
    expect(h.variants).toEqual(['clean', 'candidate-a']);

    const h2 = harness(inv);
    const slowErr = deferred<unknown>();
    const q1 = h2.load(() => slowErr.promise).catch(e => e);
    // Start B via a fresh load, then reject A late by resolving its fetch with an error response.
    h2.switchTo({ id: 'trade-1', revision: 1, adapterId: 'synthetic-trading' });
    await expect(h2.load(async () => res(['clean', 'candidate-a']))).resolves.toBe('ready');
    const after2 = [...h2.events];
    slowErr.resolve(res({ error: 'late boom' }, false, 500));
    await expect(q1).resolves.toBe('stale');
    expect(h2.events).toEqual(after2);
  });
  it('same-id revision change and dirty drop responses; discard reselection recovers', async () => {
    const h = harness(inv);
    const d = deferred<unknown>();
    const p = h.load(() => d.promise);
    h.switchTo({ id: 'inv-1', revision: 2, adapterId: 'inventory-reservation' });
    d.resolve(res(['clean', 'inventory-candidate-a']));
    await expect(p).resolves.toBe('stale');
    expect(h.events.some(e => e.startsWith('ready'))).toBe(false);

    const h2 = harness(inv);
    const d2 = deferred<unknown>();
    const p2 = h2.load(() => d2.promise);
    h2.setDirty(true); h2.seq.invalidate();
    d2.resolve(res(['clean', 'inventory-candidate-a']));
    await expect(p2).resolves.toBe('stale');
    h2.setDirty(false);
    await expect(h2.load(async () => res(['clean', 'inventory-candidate-a']))).resolves.toBe('ready');
    expect(h2.readiness()).toBeNull();
  });
});

describe('production target selection state transitions (TargetSelectionSession used by app.ts)', () => {
  const trading = { id: 'trade-1', revision: 1, adapterId: 'synthetic-trading' };
  const tradingList = ['clean', 'candidate-a', 'candidate-b'];
  const readinessFor = (s: TargetSelectionSession, selected = trading, clean = true) => launchBlockedReason({
    ...base, hasUnsavedSystemEdits: !clean, selectedAdapterId: selected.adapterId, snapshotState: 'ready',
    targetState: s.effectiveStateFor(selected, clean), allowedVariants: s.scopedVariantsFor(selected, clean), selectedVariant: s.selection,
  });
  // Mirrors app.ts: selectSystem/reset empties the select, then a fresh load begins.
  function reload(s: TargetSelectionSession, identity = trading, displayed: string | null = null) {
    s.reset('loading', displayed); // capture before clear; empty display afterwards
    s.beginLoad(identity, '');
  }

  it('keeps a non-default choice across same-profile refresh (loading empties the select first)', () => {
    const s = new TargetSelectionSession();
    s.beginLoad(trading); expect(s.applyReady(trading, tradingList)).toBe('candidate-a');
    s.select('candidate-b');
    reload(s, trading, 'candidate-b');
    expect(s.state).toBe('loading'); expect(s.selection).toBeNull(); expect(s.scopedVariantsFor(trading, true)).toEqual([]);
    expect(readinessFor(s)).toMatch(/LOADING TARGETS/);
    expect(s.applyReady(trading, tradingList)).toBe('candidate-b');
    expect(readinessFor(s)).toBeNull();
  });

  it('keeps the choice across dirty edits and discard back to the saved profile', () => {
    const inv = { id: 'inv-1', revision: 1, adapterId: 'inventory-reservation' };
    const s = new TargetSelectionSession();
    s.beginLoad(inv); s.applyReady(inv, ['clean', 'inventory-candidate-a']);
    s.select('clean'); // non-default explicit choice
    s.reset('idle', 'clean'); // markUnsavedEdits clears the select
    expect(s.effectiveStateFor(inv, false)).toBe('idle');
    expect(readinessFor(s, inv, false)).toMatch(/SAVE OR DISCARD/);
    reload(s, inv, ''); // discard -> selectSystem(saved) -> fresh load, display already empty
    expect(s.applyReady(inv, ['clean', 'inventory-candidate-a'])).toBe('clean');
  });

  it('keeps the choice across a save / revision change for the same adapter', () => {
    const s = new TargetSelectionSession();
    s.beginLoad(trading); s.applyReady(trading, tradingList); s.select('candidate-b');
    const saved = { ...trading, revision: 2 };
    reload(s, saved, 'candidate-b');
    expect(s.applyReady(saved, tradingList)).toBe('candidate-b');
    expect(s.matchesSelected(saved, true)).toBe(true);
    expect(s.matchesSelected(trading, true)).toBe(false);
  });

  it('falls back to a supported default when the choice is removed or the adapter differs', () => {
    const s = new TargetSelectionSession();
    s.beginLoad(trading); s.applyReady(trading, tradingList); s.select('candidate-b');
    reload(s, trading, 'candidate-b');
    expect(s.applyReady(trading, ['clean', 'candidate-a'])).toBe('candidate-a'); // removed

    const s2 = new TargetSelectionSession();
    s2.beginLoad(trading); s2.applyReady(trading, tradingList); s2.select('candidate-a');
    const inv = { id: 'inv-1', revision: 1, adapterId: 'inventory-reservation' };
    reload(s2, inv, 'candidate-a'); // captured under trading, not inventory
    // candidate-a exists in this list, but the adapter differs so the supported default wins.
    expect(s2.applyReady(inv, ['clean', 'candidate-a', 'inventory-candidate-a'])).toBe('inventory-candidate-a');
  });

  it('empty and error keep the choice unconfirmed, and retry restores it if still supported', () => {
    const s = new TargetSelectionSession();
    s.beginLoad(trading); s.applyReady(trading, tradingList); s.select('candidate-b');
    reload(s, trading, 'candidate-b'); s.applyError(trading);
    expect(s.selection).toBeNull(); expect(readinessFor(s)).toMatch(/TARGET LIST UNAVAILABLE/);
    reload(s, trading, ''); expect(s.applyReady(trading, tradingList)).toBe('candidate-b');

    reload(s, trading, 'candidate-b'); s.applyEmpty(trading);
    expect(s.selection).toBeNull(); expect(s.scopedVariantsFor(trading, true)).toEqual([]);
    expect(readinessFor(s)).toMatch(/NO TARGET AVAILABLE/);
    reload(s, trading, ''); expect(s.applyReady(trading, tradingList)).toBe('candidate-b');
  });

  it('an explicit change before refresh wins, and unsupported explicit values are never stored', () => {
    const s = new TargetSelectionSession();
    s.beginLoad(trading); s.applyReady(trading, tradingList);
    s.select('candidate-b'); s.select('invented'); expect(s.selection).toBe('candidate-b');
    s.select('candidate-a'); // user changes target before the refresh
    reload(s, trading, 'candidate-a');
    expect(s.applyReady(trading, tradingList)).toBe('candidate-a');
  });

  it('stale delayed responses through loadAdapterTargets cannot replace a newer system selection', async () => {
    const seq = new RequestSequencer();
    const s = new TargetSelectionSession();
    let current = { ...trading };
    const load = (fetchFn: (u: string) => Promise<unknown>, expected = { ...current }) => loadAdapterTargets({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchFn as any, adapterId: expected.adapterId, sequencer: seq,
      isCurrentSelection: () => current.id === expected.id && current.revision === expected.revision && current.adapterId === expected.adapterId,
      onLoading: () => s.beginLoad(expected, ''),
      onReady: (v) => s.applyReady(expected, v),
      onEmpty: () => s.applyEmpty(expected),
      onError: () => s.applyError(expected),
    });
    const slow = deferred<unknown>();
    const p1 = load(() => slow.promise);
    const inv = { id: 'inv-1', revision: 1, adapterId: 'inventory-reservation' };
    current = { ...inv };
    await expect(load(async () => res(['clean', 'inventory-candidate-a']))).resolves.toBe('ready');
    expect(s.selection).toBe('inventory-candidate-a');
    slow.resolve(res(tradingList)); // late success for the old system
    await expect(p1).resolves.toBe('stale');
    expect(s.identity).toEqual(inv); expect(s.selection).toBe('inventory-candidate-a');
    expect(s.scopedVariantsFor(inv, true)).toEqual(['clean', 'inventory-candidate-a']);

    const slowErr = deferred<unknown>();
    current = { ...trading };
    const p2 = load(() => slowErr.promise, { ...trading });
    current = { ...inv };
    await expect(load(async () => res(['clean', 'inventory-candidate-a']))).resolves.toBe('ready');
    slowErr.resolve(res({ error: 'late boom' }, false, 500)); // late error for the old system
    await expect(p2).resolves.toBe('stale');
    expect(s.state).toBe('ready'); expect(s.selection).toBe('inventory-candidate-a');
  });
});

describe('snapshot validation and fetching', () => {
  it('accepts own contract and rejects mismatch, missing contract and bad shapes', () => {
    expect(validateSystemSnapshot(snapshot('inv-1', 'inventory-reservation'), 'inv-1').ok).toBe(true);
    expect(validateSystemSnapshot(snapshot('other', 'inventory-reservation'), 'inv-1').ok).toBe(false);
    expect(validateSystemSnapshot(snapshot('inv-1', 'inventory-reservation', null), 'inv-1').ok).toBe(false);
    expect(validateSystemSnapshot({ brief: { id: 'inv-1', adapterId: 'inventory-reservation' }, contract: { invariants: [] }, hash: 'x' }, 'inv-1').ok).toBe(false);
    expect(validateSystemSnapshot({ brief: { id: 'u1', adapterId: 'unconfigured' }, contract: null, hash: 'x' }, 'u1').ok).toBe(true);
    expect(contractChecksVisible({ effectiveAdapterId: 'inventory-reservation', snapshotState: 'ready', isDraftMode: false, hasUnsavedSystemEdits: false })).toBe(true);
    expect(contractChecksVisible({ effectiveAdapterId: 'inventory-reservation', snapshotState: 'ready', isDraftMode: false, hasUnsavedSystemEdits: true })).toBe(false);
    expect(contractChecksVisible({ effectiveAdapterId: 'inventory-reservation', snapshotState: 'error', isDraftMode: false, hasUnsavedSystemEdits: false })).toBe(false);
  });
  it('fetches per-system snapshot URL and rejects failures', async () => {
    const urls: string[] = [];
    const ok = await fetchSystemSnapshot(async (u) => { urls.push(u); return res(snapshot('inv-1', 'inventory-reservation')); }, 'inv-1');
    expect(urls).toEqual(['/api/systems/inv-1/snapshot']);
    expect(ok.brief.id).toBe('inv-1');
    await expect(fetchSystemSnapshot(async () => res({ error: 'boom' }, false, 503), 'inv-1')).rejects.toThrow(/boom/);
    await expect(fetchSystemSnapshot(async () => res(snapshot('other', 'inventory-reservation')), 'inv-1')).rejects.toThrow(/mismatch/);
  });
  it('requires exact selected id, revision and adapter identity', () => {
    const expected = { id: 'inv-1', revision: 1, adapterId: 'inventory-reservation' };
    expect(validateSystemSnapshot(snapshot('inv-1', 'inventory-reservation'), expected).ok).toBe(true);
    // Same id, newer revision (profile changed concurrently on the server).
    const newer = { brief: { id: 'inv-1', adapterId: 'inventory-reservation', revision: 2 }, contract: snapshot('x', 'inventory-reservation').contract, hash: 'h' };
    expect(validateSystemSnapshot(newer, expected)).toEqual({ ok: false, reason: 'snapshot revision mismatch' });
    // Same id and revision, changed adapter.
    const changedAdapter = { brief: { id: 'inv-1', adapterId: 'synthetic-trading', revision: 1 }, contract: snapshot('x', 'synthetic-trading').contract, hash: 'h' };
    expect(validateSystemSnapshot(changedAdapter, expected)).toEqual({ ok: false, reason: 'snapshot adapter mismatch' });
    expect(validateSystemSnapshot(snapshot('other', 'inventory-reservation'), expected).ok).toBe(false);
    // Legacy string form and variadic form keep working.
    expect(validateSystemSnapshot(snapshot('inv-1', 'inventory-reservation'), 'inv-1').ok).toBe(true);
    expect(validateSystemSnapshot(newer, 'inv-1', 1, 'inventory-reservation').ok).toBe(false);
    expect(validateSystemSnapshot(snapshot('inv-1', 'inventory-reservation'), 'inv-1', 1, 'inventory-reservation').ok).toBe(true);
  });
  it('fetchSystemSnapshot rejects same-id newer revision / changed adapter and accepts exact match', async () => {
    const expected = { id: 'inv-1', revision: 1, adapterId: 'inventory-reservation' };
    await expect(fetchSystemSnapshot(async () => res(snapshot('inv-1', 'inventory-reservation')), expected)).resolves.toMatchObject({ brief: { revision: 1 } });
    const newer = { brief: { id: 'inv-1', adapterId: 'inventory-reservation', revision: 2 }, contract: snapshot('x', 'inventory-reservation').contract, hash: 'h' };
    await expect(fetchSystemSnapshot(async () => res(newer), expected)).rejects.toThrow(/revision mismatch/);
    const changed = { brief: { id: 'inv-1', adapterId: 'synthetic-trading', revision: 1 }, contract: snapshot('x', 'synthetic-trading').contract, hash: 'h' };
    await expect(fetchSystemSnapshot(async () => res(changed), expected)).rejects.toThrow(/adapter mismatch/);
  });
  it('delayed out-of-order responses are dropped by the sequencer used in app.ts', async () => {
    const seq = new RequestSequencer();
    const first = seq.next(); const second = seq.next();
    const d = deferred<unknown>(); const applied: string[] = [];
    void d.promise.then(v => { if (seq.isCurrent(first)) applied.push(String(v)); });
    d.resolve(snapshot('inv-1', 'inventory-reservation'));
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
    const readiness = () => launchBlockedReason({ ...base, selectedAdapterId: current.adapterId, snapshotState: state, selectedVariant: 'inventory-candidate-a', allowedVariants: ['clean', 'inventory-candidate-a'] });
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
  const inv = { id: 'inv-1', revision: 1, adapterId: 'inventory-reservation' };

  it('loading-to-ready enables launch immediately without a later status poll', async () => {
    const h = harness(inv);
    const d = deferred<unknown>();
    const p = h.load(() => d.promise);
    expect(h.state).toBe('loading');
    expect(h.readiness()).toMatch(/LOADING/);
    d.resolve(res(snapshot('inv-1', 'inventory-reservation')));
    await expect(p).resolves.toBe('ready');
    expect(h.state).toBe('ready');
    expect(h.readiness()).toBeNull(); // enabled by the success callback alone
    expect(h.events).toEqual(['loading:LOADING SYSTEM CONTRACT', 'ready:null']);
  });

  it('identity mismatch fails visibly as error, never ready, and reselection recovers', async () => {
    const h = harness(inv);
    const newer = { brief: { id: 'inv-1', adapterId: 'inventory-reservation', revision: 2 }, contract: snapshot('x', 'inventory-reservation').contract, hash: 'h' };
    await expect(h.load(async () => res(newer))).resolves.toBe('error');
    expect(h.state).toBe('error');
    expect(h.readiness()).toMatch(/UNAVAILABLE/);
    expect(h.events.some(e => e.startsWith('ready'))).toBe(false);
    // Intentional refresh/reselection to the newer saved profile recovers.
    h.switchTo({ id: 'inv-1', revision: 2, adapterId: 'inventory-reservation' });
    await expect(h.load(async () => res(newer))).resolves.toBe('ready');
    expect(h.readiness()).toBeNull();
  });

  it('rapid switches: delayed response for the old system is stale with no side effects', async () => {
    const h = harness(inv);
    const slow = deferred<unknown>();
    const p1 = h.load(() => slow.promise);
    h.switchTo({ id: 'inv-2', revision: 1, adapterId: 'inventory-reservation' });
    const snap2 = { brief: { id: 'inv-2', adapterId: 'inventory-reservation', revision: 1 }, contract: snapshot('x', 'inventory-reservation').contract, hash: 'h' };
    await expect(h.load(async () => res(snap2))).resolves.toBe('ready');
    const eventsAfterSwitch = [...h.events];
    slow.resolve(res(snapshot('inv-1', 'inventory-reservation')));
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
    d.resolve(res(snapshot('inv-1', 'inventory-reservation')));
    await expect(p).resolves.toBe('stale');
    expect(h.events.some(e => e.startsWith('ready'))).toBe(false);
    h.setDirty(false); // discard -> selectSystem -> fresh load
    await expect(h.load(async () => res(snapshot('inv-1', 'inventory-reservation')))).resolves.toBe('ready');
    expect(h.readiness()).toBeNull();
  });

  it('selection changed while loading (same id, newer revision) drops the old response', async () => {
    const h = harness(inv);
    const d = deferred<unknown>();
    const p = h.load(() => d.promise);
    h.switchTo({ id: 'inv-1', revision: 2, adapterId: 'inventory-reservation' });
    d.resolve(res(snapshot('inv-1', 'inventory-reservation')));
    await expect(p).resolves.toBe('stale');
    expect(h.events.some(e => e.startsWith('ready'))).toBe(false);
  });
});

describe('inspected-run state presentation (pinned adapter, not selected profile)', () => {
  const record = (adapterId?: string) => adapterId === undefined
    ? {} // legacy no-brief record
    : { systemBrief: { brief: { adapterId }, contract: null, hash: 'h' } };

  it('inventory run inspected while trading is selected still presents inventory', () => {
    // The helper receives only the inspected record; the selected profile is not an input.
    const selectedProfileAdapter = 'synthetic-trading';
    expect(selectedProfileAdapter).toBe('synthetic-trading');
    expect(stateKindForRecord(record('inventory-reservation'))).toBe('inventory');
    const presentation = statePresentationFor(stateKindForRecord(record('inventory-reservation')));
    expect(presentation.tabTitle).toBe('Inventory & reservations');
    expect(presentation.primaryTitle).toBe('Stock by SKU');
    expect(presentation.secondaryTitle).toBe('Reservations');
    expect(presentation.tabTitle).not.toMatch(/credit|order/i);
  });

  it('trading run inspected while inventory is selected still presents trading', () => {
    expect(stateKindForRecord(record('synthetic-trading'))).toBe('trading');
    const presentation = statePresentationFor(stateKindForRecord(record('synthetic-trading')));
    expect(presentation.tabTitle).toBe('Order & credit exposure');
    expect(presentation.primaryTitle).toMatch(/Credit/);
    expect(presentation.secondaryTitle).toMatch(/Orders/);
  });

  it('legacy no-brief trading records remain usable as trading', () => {
    expect(stateKindForRecord(record())).toBe('trading');
    expect(stateKindForRecord(null)).toBe('trading');
    expect(stateKindForInspectedRun(null, false)).toBe('trading');
    expect(inspectedRunAdapterId(record())).toBeNull();
  });

  it('snapshotless records use their saved audit identity', () => {
    const auditRecord = (adapterId: unknown) => ({ contextAudit: { adapterId } });
    expect(stateKindForRecord(auditRecord('inventory-reservation'))).toBe('inventory');
    expect(statePresentationFor(stateKindForRecord(auditRecord('inventory-reservation'))).tabTitle).toBe('Inventory & reservations');
    expect(stateKindForRecord(auditRecord('synthetic-trading'))).toBe('trading');
    expect(inspectedRunAdapterId(auditRecord('inventory-reservation'))).toBe('inventory-reservation');
    // Present but unknown/malformed/unconfigured audit identity is honest unknown.
    expect(stateKindForRecord(auditRecord('some-future-adapter'))).toBe('unknown');
    expect(stateKindForRecord(auditRecord('unconfigured'))).toBe('unknown');
    expect(stateKindForRecord(auditRecord(42))).toBe('unknown');
    expect(stateKindForRecord(auditRecord(''))).toBe('unknown');
    expect(stateKindForRecord(auditRecord(null))).toBe('unknown');
    // Truly identity-free remains the historical trading fallback.
    expect(stateKindForRecord({ contextAudit: {} })).toBe('trading');
    expect(stateKindForRecord({ contextAudit: { adapterId: undefined } })).toBe('trading');
    expect(stateKindForRecord({})).toBe('trading');
  });

  it('a pinned snapshot stays authoritative over a conflicting or usable audit identity', () => {
    const pinned = (adapterId: unknown, auditId: string) => ({
      systemBrief: { brief: { adapterId }, contract: null, hash: 'h' },
      contextAudit: { adapterId: auditId },
    });
    expect(stateKindForRecord(pinned('inventory-reservation', 'synthetic-trading'))).toBe('inventory');
    expect(stateKindForRecord(pinned('synthetic-trading', 'inventory-reservation'))).toBe('trading');
    // Missing/malformed pinned identity is unknown, never repaired from the audit.
    expect(stateKindForRecord(pinned(undefined, 'inventory-reservation'))).toBe('unknown');
    expect(stateKindForRecord(pinned(42, 'inventory-reservation'))).toBe('unknown');
    expect(stateKindForRecord({ systemBrief: { brief: null, contract: null, hash: 'h' }, contextAudit: { adapterId: 'inventory-reservation' } })).toBe('unknown');
    expect(inspectedRunAdapterId(pinned(undefined, 'inventory-reservation'))).toBeNull();
  });

  it('unknown or malformed pinned adapters are never mislabeled as trading', () => {
    expect(stateKindForRecord(record('some-future-adapter'))).toBe('unknown');
    expect(stateKindForRecord({ systemBrief: { brief: {}, contract: null, hash: 'h' } })).toBe('unknown');
    expect(stateKindForRecord({ systemBrief: { brief: { adapterId: 42 }, contract: null, hash: 'h' } })).toBe('unknown');
    expect(stateKindForRecord({ systemBrief: { brief: { adapterId: 'unconfigured' }, contract: null, hash: 'h' } })).toBe('unknown');
    expect(statePresentationFor('unknown').primaryEmpty).toMatch(/unknown system adapter/i);
  });
});

describe('inventory snapshot display model', () => {
  const inventorySnapshot = {
    target: {
      stock: { 'SKU-1': { received: 100, onHand: 80 }, 'SKU-2': { received: 10, onHand: 10 } },
      reservations: {
        'res-1': { sku: 'SKU-1', quantity: 30, remaining: 20, shipped: 5, cancelled: 5 },
        'res-2': { sku: 'SKU-1', quantity: 10, remaining: 10, shipped: 0, cancelled: 0 },
      },
      accepted: {},
    },
    logicalTime: 3,
    messages: [],
  };

  it('shows actual received/on-hand and reservation quantities from the selected experiment snapshot', () => {
    const model = extractInventorySnapshotDisplay(inventorySnapshot);
    expect(model.hasStock).toBe(true);
    expect(model.hasReservations).toBe(true);
    const sku1 = model.stock.find(s => s.sku === 'SKU-1')!;
    expect(sku1.received).toBe(100);
    expect(sku1.onHand).toBe(80);
    expect(sku1.reservedRemaining).toBe(30); // 20 + 10 remaining
    expect(sku1.available).toBe(50);
    expect(sku1.overReserved).toBe(false);
    expect(sku1.displayText).toContain('Received: 100');
    expect(sku1.displayText).toContain('On hand: 80');
    const sku2 = model.stock.find(s => s.sku === 'SKU-2')!;
    expect(sku2.reservedRemaining).toBe(0);
    expect(sku2.available).toBe(10);
    const res1 = model.reservations.find(r => r.reservationId === 'res-1')!;
    expect(res1).toMatchObject({ sku: 'SKU-1', quantity: 30, remaining: 20, shipped: 5, cancelled: 5 });
    expect(res1.displayText).toContain('Shipped: 5');
    expect(res1.displayText).toContain('Cancelled: 5');
  });

  it('reports over-reservation as-is without clamping availability to zero', () => {
    const model = extractInventorySnapshotDisplay({
      target: {
        stock: { 'SKU-9': { received: 10, onHand: 10 } },
        reservations: { 'res-x': { sku: 'SKU-9', quantity: 25, remaining: 25, shipped: 0, cancelled: 0 } },
      },
    });
    const sku = model.stock[0]!;
    expect(sku.reservedRemaining).toBe(25);
    expect(sku.available).toBe(-15);
    expect(sku.overReserved).toBe(true);
    expect(sku.displayText).toContain('Available: -15');
    expect(sku.displayText).toContain('Over-reserved');
  });

  it('represents missing or malformed values honestly without inventing zeros', () => {
    for (const raw of [null, undefined, 'malformed', {}, { target: 'corrupt' }]) {
      const model = extractInventorySnapshotDisplay(raw);
      expect(model.stock).toEqual([]);
      expect(model.reservations).toEqual([]);
      expect(model.hasStock).toBe(false);
    }
    const partial = extractInventorySnapshotDisplay({
      target: {
        stock: { 'SKU-1': { received: 'lots', onHand: 5 }, 'SKU-2': 'broken' },
        reservations: { 'res-1': { sku: 'SKU-1', quantity: 4 }, 'res-2': 7 },
      },
    });
    const sku1 = partial.stock.find(s => s.sku === 'SKU-1')!;
    expect(sku1.received).toBe('-');
    expect(sku1.onHand).toBe(5);
    // res-1 remaining is missing, so the reserved total cannot be derived honestly.
    expect(sku1.reservedRemaining).toBe('-');
    expect(sku1.available).toBe('-');
    expect(sku1.overReserved).toBe(false);
    const sku2 = partial.stock.find(s => s.sku === 'SKU-2')!;
    expect(sku2.received).toBe('-');
    expect(sku2.onHand).toBe('-');
    const res1 = partial.reservations.find(r => r.reservationId === 'res-1')!;
    expect(res1.quantity).toBe(4);
    expect(res1.remaining).toBe('-');
    expect(res1.shipped).toBe('-');
    const res2 = partial.reservations.find(r => r.reservationId === 'res-2')!;
    expect(res2.sku).toBe('-');
    expect(res2.remaining).toBe('-');
    // Trading extractor is untouched by inventory-shaped input handling.
    expect(extractSnapshotDisplay(null).credit.availableCredit).toBe('-');
  });

  it('does not infer availability when a reservation cannot be assigned to a SKU', () => {
    for (const reservation of [{ remaining: 7 }, { sku: ' ', remaining: 7 }, null]) {
      const model = extractInventorySnapshotDisplay({
        target: { stock: { A: { received: 10, onHand: 10 }, B: { received: 5, onHand: 5 } }, reservations: { r1: reservation } },
      });
      for (const stock of model.stock) {
        expect(stock.reservedRemaining).toBe('-');
        expect(stock.available).toBe('-');
      }
    }
    const validDashSku = extractInventorySnapshotDisplay({
      target: { stock: { '-': { received: 10, onHand: 10 } }, reservations: { r1: { sku: '-', remaining: 3 } } },
    });
    expect(validDashSku.stock[0]).toMatchObject({ reservedRemaining: 3, available: 7 });
  });

  it('distinguishes missing state from an observed empty state and avoids unsafe derived totals', () => {
    const missing = extractInventorySnapshotDisplay({ target: {} });
    expect(missing).toMatchObject({ stockAvailable: false, reservationsAvailable: false });
    const empty = extractInventorySnapshotDisplay({ target: { stock: {}, reservations: {} } });
    expect(empty).toMatchObject({ stockAvailable: true, reservationsAvailable: true, hasStock: false, hasReservations: false });
    const unsafe = extractInventorySnapshotDisplay({
      target: {
        stock: { A: { received: 10, onHand: 10 } },
        reservations: { r1: { sku: 'A', remaining: Number.MAX_SAFE_INTEGER }, r2: { sku: 'A', remaining: 2 } },
      },
    });
    expect(unsafe.stock[0]).toMatchObject({ reservedRemaining: '-', available: '-', overReserved: false });
  });

  it('keeps target-derived identifiers verbatim as plain text values', () => {
    const model = extractInventorySnapshotDisplay({
      target: {
        stock: { '<img src=x onerror=alert(1)>': { received: 1, onHand: 1 } },
        reservations: { '<b>res</b>': { sku: '<img src=x onerror=alert(1)>', quantity: 1, remaining: 1, shipped: 0, cancelled: 0 } },
      },
    });
    expect(model.stock[0]!.sku).toBe('<img src=x onerror=alert(1)>');
    expect(model.reservations[0]!.reservationId).toBe('<b>res</b>');
    expect(model.stock[0]!.displayText).not.toContain('Received: 0');
  });
});

describe('contract entry formatting (readable vocabulary, model contract unchanged)', () => {
  it('inventory fields-only operation shows its fields instead of a bare colon', () => {
    const text = formatContractEntry({ op: 'send', fields: 'id, to (stock|reservations|shipments), payload, optional delay (0..1000)' });
    expect(text).toBe('send: Fields: id, to (stock|reservations|shipments), payload, optional delay (0..1000)');
    expect(text).not.toMatch(/:\s*$/);
  });

  it('inventory fields-only message shows channel and fields without stock/stock duplication', () => {
    const text = formatContractEntry({ channel: 'stock', type: 'stock', fields: 'id, sku, quantity (positive safe integer <= 1000000); additive receipt' });
    expect(text).toContain('stock: Fields: id, sku, quantity');
    expect(text).not.toContain('stock/stock');
    expect(text).not.toMatch(/:\s*$/);
    const reserve = formatContractEntry({ channel: 'reservations', type: 'reserve', fields: 'id, reservationId, sku, quantity' });
    expect(reserve).toBe('reservations/reserve: Fields: id, reservationId, sku, quantity');
  });

  it('semantics-only entry is labelled Semantics with no meaningless slash-colon row', () => {
    const text = formatContractEntry({ semantics: 'Only listed payload fields are supported. Reservation ids cannot be reused.' });
    expect(text).toBe('Semantics: Only listed payload fields are supported. Reservation ids cannot be reused.');
    expect(text).not.toContain('/:');
    expect(text).not.toMatch(/^\//);
  });

  it('preserves the existing trading description display', () => {
    expect(formatContractEntry({ op: 'send', description: 'Schedules a message to a channel for future delivery.', parameters: { id: 'Unique envelope identifier string' } }))
      .toBe('send: Schedules a message to a channel for future delivery.');
    expect(formatContractEntry({ channel: 'market', type: 'quote', description: 'Market quote update broadcasting instrument price.', fields: { id: 'Quote identifier string', price: 'Positive safe integer price' } }))
      .toBe('market/quote: Market quote update broadcasting instrument price.');
  });

  it('renders fields maps and untrusted text verbatim as plain text, with no blank rows', () => {
    expect(formatContractEntry({ op: 'fill', fields: { orderId: 'Venue order identifier', quantity: 'Positive integer' } }))
      .toBe('fill: Fields: orderId: Venue order identifier; quantity: Positive integer');
    const hostile = formatContractEntry({ op: '<script>alert(1)</script>', fields: '<img src=x onerror=alert(1)>' });
    expect(hostile).toContain('<script>alert(1)</script>');
    expect(hostile).toContain('<img src=x onerror=alert(1)>');
    expect(formatContractEntry({ op: 'drain' })).toBe('drain');
    expect(formatContractEntry({})).toBe('Contract entry');
    for (const entry of [{ op: 'send', fields: 'x' }, { channel: 'stock', type: 'stock', fields: 'y' }, { semantics: 'z' }, { op: 'drain' }]) {
      expect(formatContractEntry(entry)).not.toMatch(/:\s*$/);
      expect(formatContractEntry(entry)).not.toContain('/:');
    }
  });
});
