import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as target from '../../src/target-api/target.ts';
import * as client from '../../src/target-api/client.ts';
import { runApiJourneys, seal } from '../../src/target-api/runner.ts';
import { isObservation } from '../../src/target-api/validation.ts';
import { compareApiJourneys } from '../../src/target-api/compare.ts';
import { getApiJourneyRun, isValidApiJourneyRecord, saveApiJourneyRun } from '../../src/target-api/storage.ts';
import { createSystemSnapshot } from '../../src/storage.ts';
import { SEEDED_TRADING_BRIEF } from '../../src/systems/index.ts';
import type { ApiJourneyRecord } from '../../src/target-api/types.ts';

vi.mock('../../src/target-api/target.ts', async original => ({ ...await original<typeof import('../../src/target-api/target.ts')>() }));
vi.mock('../../src/target-api/client.ts', async original => ({ ...await original<typeof import('../../src/target-api/client.ts')>() }));
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function reopen(record: ApiJourneyRecord) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'target-api-partial-')); dirs.push(dir);
  expect(isValidApiJourneyRecord(record)).toBe(true);
  await saveApiJourneyRun(record, dir);
  expect(await getApiJourneyRun(record.id, dir)).toEqual(JSON.parse(JSON.stringify(record)));
}

describe('catalog cancellation and raw incomplete evidence boundaries', () => {
  it.each([1, 2, 3])('preserves completion and represents remaining cancellation when abort arrives in close %i', async stop => {
    const controller = new AbortController(), start = target.startTarget;
    const handles: Awaited<ReturnType<typeof target.startTarget>>[] = [];
    const spy = vi.spyOn(target, 'startTarget').mockImplementation(async options => {
      const handle = await start(options); handles.push(handle); const nth = handles.length;
      return { ...handle, close: async () => { await handle.close(); if (nth === stop) controller.abort(new Error('Abort during close')); } };
    });
    const record = await runApiJourneys({ variant: 'clean', systemSnapshot: await createSystemSnapshot(SEEDED_TRADING_BRIEF), signal: controller.signal });
    expect(spy).toHaveBeenCalledTimes(stop);
    expect(record.journeys.map(j => j.status)).toEqual(Array.from({ length: 3 }, (_, i) => i < stop ? 'pass' : 'cancelled'));
    for (const j of record.journeys.slice(stop)) { expect(j.endpoint).toBe(''); expect(j.exchanges).toEqual([]); expect(j.observation).toBeNull(); }
    expect(record.status).toBe(stop === 3 ? 'pass' : 'cancelled');
    expect(handles.every(h => h.diagnostics().closed && !h.diagnostics().timer && !h.diagnostics().queued && !h.diagnostics().sockets)).toBe(true);
    await reopen(record);
    expect(compareApiJourneys(record, record).status).toBe(stop === 3 ? 'match' : 'blocked');
  });

  it.each(['pre-abort', 'in-flight'] as const)('persists complete cancelled catalog without later listeners on %s', async phase => {
    const controller = new AbortController(), start = target.startTarget, request = client.requestJson;
    const handles: Awaited<ReturnType<typeof target.startTarget>>[] = [];
    const startSpy = vi.spyOn(target, 'startTarget').mockImplementation(async options => {
      const handle = await start(options); handles.push(handle); return handle;
    });
    if (phase === 'pre-abort') controller.abort(new Error('Pre-aborted'));
    else vi.spyOn(client, 'requestJson').mockImplementation(async (...args) => {
      const exchange = await request(...args); controller.abort(new Error('Abort after actual first receipt')); return exchange;
    });
    const record = await runApiJourneys({ variant: 'clean', systemSnapshot: await createSystemSnapshot(SEEDED_TRADING_BRIEF), signal: controller.signal });
    expect(startSpy).toHaveBeenCalledTimes(phase === 'pre-abort' ? 0 : 1);
    expect(record.journeys.map(j => j.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect(record.status).toBe('cancelled');
    expect(handles.every(h => h.diagnostics().closed && !h.diagnostics().timer && !h.diagnostics().sockets)).toBe(true);
    await reopen(record); expect(compareApiJourneys(record, record).status).toBe('blocked');
  });

  it.each(['/setup', '/events', '/state'])('preserves malformed raw %s response on inconclusive save/reopen', async route => {
    const request = client.requestJson;
    const spy = vi.spyOn(client, 'requestJson').mockImplementation(async (...args) => {
      const wire = await request(...args);
      if (wire.path === route) wire.response = route === '/setup' ? { instanceId: (wire.response as any).instanceId } : { instanceId: (wire.response as any).instanceId, events: [null] };
      return wire;
    });
    const record = await runApiJourneys({ variant: 'clean', systemSnapshot: await createSystemSnapshot(SEEDED_TRADING_BRIEF) });
    expect(spy).toHaveBeenCalled(); expect(record.status).toBe('inconclusive');
    expect(record.journeys.every(j => j.status === 'inconclusive' && j.assertions.some(a => a.id === 'evidence-completeness'))).toBe(true);
    // Unknown wire JSON stays inspectable, while only structurally safe typed observations reach UI consumers.
    expect(record.journeys.every(j => route === '/setup' ? isObservation(j.observation) : j.observation === null)).toBe(true);
    expect(record.journeys.every(j => j.exchanges.some(e => e.path === route && !(e.response as any).state))).toBe(true);
    await reopen(record); expect(compareApiJourneys(record, record).status).toBe('blocked');
  });

  it.each(['inconclusive', 'cancelled'] as const)('accepts a sealed %s raw-response fixture but rejects unsafe typed observation and false pass', async status => {
    const record = await runApiJourneys({ variant: 'clean', systemSnapshot: await createSystemSnapshot(SEEDED_TRADING_BRIEF), signal: AbortSignal.abort() });
    record.status = status;
    for (const j of record.journeys) {
      j.status = status; j.error = 'Malformed target receipt'; j.observation = null;
      j.exchanges = [{ method: 'POST', path: '/setup', request: { kind: 'setup' }, status: 202, response: { missing: 'receipt fields' }, elapsedMs: 1 }];
    }
    seal(record); await reopen(record);
    expect(compareApiJourneys(record, record).status).toBe('blocked');
    const unsafe = structuredClone(record); unsafe.journeys[0]!.observation = { events: [] } as any; seal(unsafe);
    expect(isValidApiJourneyRecord(unsafe)).toBe(false);
    const falsePass = structuredClone(record); falsePass.status = 'pass';
    for (const j of falsePass.journeys) j.status = 'pass'; seal(falsePass);
    expect(isValidApiJourneyRecord(falsePass)).toBe(false);
  });
});
