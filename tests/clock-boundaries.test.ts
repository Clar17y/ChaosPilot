import { expect, it } from 'vitest';
import { executeExperiment, getContract, parseExperiment } from '../src/simulator/index.ts';
import { Scheduler } from '../src/simulator/scheduler.ts';

const limit = getContract().limits.maxTicks!;
const envelope = { hypothesis: 'Clock bounds', expectedInvariant: 'input_integrity_no_mutation' };

it.each([
  { op: 'advance', ticks: limit + 1 },
  { op: 'send', id: 'm', to: 'market', payload: null, delay: limit + 1 },
  { op: 'advance', ticks: Number.MAX_SAFE_INTEGER }
])('rejects a plan exceeding the advertised clock bound: $op', step => {
  expect(() => parseExperiment({ ...envelope, steps: [step] })).toThrow(/ticks|delay/i);
});

it('accepts the exact cumulative clock limit and marks overflow as an invalid experiment', () => {
  const valid = executeExperiment({ ...envelope, steps: [{ op: 'advance', ticks: limit - 1 }, { op: 'advance', ticks: 1 }] }, 'clean');
  expect(valid.valid).toBe(true);
  expect(valid.snapshot.logicalTime).toBe(limit);
  const invalid = executeExperiment({ ...envelope, steps: [{ op: 'advance', ticks: limit }, { op: 'advance', ticks: 1 }] }, 'clean');
  expect(invalid.valid).toBe(false);
  expect(invalid.rejections[0]?.reason).toMatch(/time|tick|clock/i);
  expect(invalid.snapshot.logicalTime).toBe(limit);
});

it('refuses overflowing schedules and duplicates without creating envelopes', () => {
  const scheduler = new Scheduler();
  expect(scheduler.schedule('original', 'market', null).success).toBe(true);
  scheduler.advance(limit);
  expect(scheduler.schedule('too-late', 'market', null, 1).success).toBe(false);
  expect(scheduler.duplicate('original', 'duplicate-too-late', 1).success).toBe(false);
  expect(scheduler.getEnvelope('too-late')).toBeUndefined();
  expect(scheduler.getEnvelope('duplicate-too-late')).toBeUndefined();
  expect(scheduler.getTime()).toBe(limit);
});

it('keeps the scheduler clock valid after direct invalid inputs', () => {
  const scheduler = new Scheduler();
  scheduler.advance(limit);
  expect(() => scheduler.advance(1)).toThrow();
  expect(() => scheduler.setTime(limit + 1)).toThrow();
  expect(scheduler.getTime()).toBe(limit);
});
