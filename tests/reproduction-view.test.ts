import { describe, expect, it } from 'vitest';
import type { TraceEntry, Violation } from '../src/domain.ts';
import { buildRerunTrace, buildTraceSteps, groupUnimportantSteps, PlaybackController } from '../src/web/reproduction-player.ts';
import { activeUnattributedViolations, detailVisibility, evidenceHeading, replayBehaviourStatus, stepsRevision, timelineRenderKey, unattributedText } from '../src/web/reproduction-view.ts';

const entry = (step: number, payload: unknown, state: Record<string, unknown> = {}): TraceEntry =>
  ({ step, time: step, action: 'deliver', payload, outcome: 'scheduled', state });
const ambiguous = (id: string): Violation => ({ id, invariant: 'inv', step: 2, message: `ambiguous ${id}`, evidence: {} });

describe('replay behaviour comparison', () => {
  it('distinguishes matching, differing and incomplete evidence', () => {
    const matched = { traceMatched: true, snapshotMatched: true, violationsMatched: true, rejectionsMatched: true, validityMatched: true };
    expect(replayBehaviourStatus(matched)).toBe('matched');
    expect(replayBehaviourStatus({ ...matched, snapshotMatched: false })).toBe('different');
    expect(replayBehaviourStatus({ ...matched, traceMatched: undefined })).toBe('unavailable');
    expect(replayBehaviourStatus(undefined)).toBe('unavailable');
  });
});

describe('fresh trace attribution is preserved from its own result', () => {
  it('original ambiguous -> fresh clean: no original warning on the fresh trace', () => {
    const original = [ambiguous('orig')];
    const fresh = buildRerunTrace({ sourceIdentical: false, reproduced: false, exactReproductionClaimed: false, outcomes: [{ replayedResult: { trace: [entry(0, { type: 'quote' })], violations: [] } }] });
    expect(fresh.unattributedViolations).toEqual([]);
    expect(activeUnattributedViolations(true, original, fresh.unattributedViolations)).toEqual([]);
    expect(unattributedText([], true)).toBe('');
    expect(activeUnattributedViolations(false, original, fresh.unattributedViolations).map(v => v.id)).toEqual(['orig']);
  });

  it('original clean -> fresh ambiguous: the fresh violation remains visible', () => {
    const trace = [entry(2, { type: 'quote' }), entry(2, { type: 'credit_limit' })];
    // Both entries share the violation action index; neither is a processed
    // transition, so the violation cannot be pinned to one entry.
    const fresh = buildRerunTrace({ sourceIdentical: true, reproduced: false, exactReproductionClaimed: false, outcomes: [{ replayedResult: { trace, violations: [ambiguous('fresh')] } }] });
    expect(fresh.steps.every(s => !s.isViolation)).toBe(true);
    expect(fresh.unattributedViolations.map(v => v.id)).toEqual(['fresh']);
    const shown = activeUnattributedViolations(true, [], fresh.unattributedViolations);
    expect(unattributedText(shown, true)).toContain('fresh rerun');
    expect(unattributedText(shown, true)).toContain('ambiguous fresh');
  });

  it('empty fresh trace keeps its own unattributed violations and no steps', () => {
    const fresh = buildRerunTrace({ sourceIdentical: true, reproduced: false, exactReproductionClaimed: false, outcomes: [{ replayedResult: { trace: [], violations: [ambiguous('empty-fresh')] } }] });
    expect(fresh.steps).toEqual([]);
    expect(activeUnattributedViolations(true, [ambiguous('orig')], fresh.unattributedViolations).map(v => v.id)).toEqual(['empty-fresh']);
    expect(buildRerunTrace({ sourceIdentical: true, reproduced: false, exactReproductionClaimed: false })).toEqual({ steps: [], unattributedViolations: [] });
  });

  it('labels the original summary historical, distinctly when fresh is selected', () => {
    expect(evidenceHeading(false)).toContain('historical');
    expect(evidenceHeading(true)).toContain('not the fresh rerun');
  });
});

describe('no-step detail visibility', () => {
  it('reset / no step / unrelated finding: facts and credit panels are hidden', () => {
    expect(detailVisibility(false, true)).toEqual({ factsVisible: false, creditVisible: false });
    expect(detailVisibility(false, false)).toEqual({ factsVisible: false, creditVisible: false });
    expect(detailVisibility(true, true)).toEqual({ factsVisible: true, creditVisible: true });
    expect(detailVisibility(true, false)).toEqual({ factsVisible: true, creditVisible: false });
  });
});

describe('timeline revision and cursor preservation', () => {
  it('3 grouped events -> 4 at the same visible count changes the render key', () => {
    const three = groupUnimportantSteps(buildTraceSteps([entry(0, { type: 'quote' }), entry(1, { type: 'quote' }), entry(2, { type: 'quote' })], []).steps)!;
    const four = groupUnimportantSteps(buildTraceSteps([entry(0, { type: 'quote' }), entry(1, { type: 'quote' }), entry(2, { type: 'quote' }), entry(3, { type: 'quote' })], []).steps)!;
    expect(three).toHaveLength(1);
    expect(four).toHaveLength(1);
    expect(stepsRevision(three)).not.toBe(stepsRevision(four));
    const base = { runId: 'r', experimentIndex: 0, findingId: '', sequence: 'grouped', showFull: false, useRerun: false, freshKind: 'idle' };
    expect(timelineRenderKey({ ...base, steps: three })).not.toBe(timelineRenderKey({ ...base, steps: four }));
    expect(timelineRenderKey({ ...base, steps: three })).toBe(timelineRenderKey({ ...base, steps: three }));
  });

  it('event text change without a count change changes the revision', () => {
    const a = buildTraceSteps([entry(0, { type: 'quote', price: 1 })], []).steps;
    const b = buildTraceSteps([{ ...entry(0, { type: 'quote', price: 1 }), outcome: 'duplicated from earlier' }], []).steps;
    expect(stepsRevision(a)).not.toBe(stepsRevision(b));
  });

  it('refreshCount preserves a valid cursor and clamps it when steps shrink', () => {
    const c = new PlaybackController(4);
    c.select(2);
    c.refreshCount(4);
    expect(c.position).toBe(2);
    c.refreshCount(2);
    expect(c.position).toBe(1);
    c.refreshCount(0);
    expect(c.position).toBe(-1);
    // setCount (selection change) still resets, by contrast.
    const d = new PlaybackController(4);
    d.select(2);
    d.setCount(4);
    expect(d.position).toBe(-1);
  });
});

describe('grouped step summary', () => {
  it('does not present the first member action, payload, credit or state as the group state', () => {
    const state = { credit: { version: 1, limit: 100 }, reservedCredit: 5, usedCredit: 7, orders: {} };
    const steps = buildTraceSteps([entry(0, { type: 'new_order', orderId: 'o1', quantity: 9 }, state), entry(1, { type: 'quote' }, state), entry(2, { type: 'quote' }, state)], []).steps;
    const grouped = groupUnimportantSteps(steps)!;
    const group = grouped[0]!;
    expect(group.isGroup).toBe(true);
    expect(group.action).not.toBe('deliver');
    expect(group.credit).toBeNull();
    expect(group.payloadText).toContain('Grouped summary');
    expect(group.stateText).toContain('not recorded for the group as a whole');
    expect(group.title).toContain('3 grouped recorded entries');
    expect(group.detail).toContain('complete original trace');
  });
});
