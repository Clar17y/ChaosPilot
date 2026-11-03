import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runApiJourneys, seal } from '../../src/target-api/runner.ts';
import { compareApiJourneys } from '../../src/target-api/compare.ts';
import { getApiJourneyRun, isValidApiJourneyRecord, saveApiJourneyRun } from '../../src/target-api/storage.ts';
import { createSystemSnapshot } from '../../src/storage.ts';
import { SEEDED_TRADING_BRIEF, computeSnapshotHash } from '../../src/systems/index.ts';
import { digest } from '../../src/target-api/identity.ts';
import type { ApiJourneyRecord } from '../../src/target-api/types.ts';

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));

let clean: ApiJourneyRecord;
const dirs: string[] = [];
beforeAll(async () => { clean = await runApiJourneys({ variant: 'clean', systemSnapshot: await createSystemSnapshot(SEEDED_TRADING_BRIEF) }); });
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function directory() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'target-api-integrity-')); dirs.push(dir); return dir; }
function mutate(change: (r: any) => void): ApiJourneyRecord { const record = JSON.parse(JSON.stringify(clean)); change(record); return seal(record); }
function walk(value: any, change: (v: any) => void): void {
  if (!value || typeof value !== 'object') return;
  change(value); for (const child of Object.values(value)) walk(child, change);
}

describe('untrusted record and semantic boundary', () => {
  const malformed: [string, (r: any) => void][] = [
    ['stale brief hash', r => { r.systemSnapshot.brief.overview += ' changed'; }],
    ['contract digest', r => { r.contractHash = '0'.repeat(64); }],
    ['adapter', r => { r.adapterId = 'inventory-reservation'; }],
    ['variant', r => { r.variant = 'inventory-candidate-a'; }],
    ['type', r => { r.type = 'other'; }],
    ['schema', r => { r.schemaVersion = 2; }],
    ['identity version', r => { r.evaluator.version = 2; }],
    ['terminal date', r => { r.finishedAt = 'NaN'; }],
    ['nested identity', r => { r.transport = []; }],
    ['nested journey', r => { r.journeys = [{}]; }],
    ['nested observation', r => { r.journeys[0].observation.events = [{}]; }],
    ['nested trace', r => { r.journeys[0].observation.events[0].result.trace = [null]; }],
    ['nested snapshot', r => { r.journeys[0].observation.state.orders = []; }],
    ['nested contract', r => { r.systemSnapshot.contract.operations = [null]; }],
    ['requirement evaluator', r => { r.systemSnapshot.requirementEvaluator = []; }],
    ['duplicate catalog', r => { r.journeys.push(r.journeys[0]); }],
    ['missing catalog', r => { r.journeys.pop(); }],
    ['sparse passing catalog', r => { r.journeys = []; }],
    ['aggregate status', r => { r.status = 'fail'; }],
    ['duplicate assertions', r => { r.journeys[0].assertions.push(r.journeys[0].assertions[0]); }],
    ['missing assertions', r => { r.journeys[0].assertions = []; }],
  ];
  it.each(malformed)('rejects sealed %s on storage and symmetric comparison without throwing', async (_, change) => {
    const record = mutate(change);
    expect(isValidApiJourneyRecord(record)).toBe(false);
    for (const [a, b] of [[record, clean], [clean, record], [record, record]]) {
      expect(() => compareApiJourneys(a!, b!)).not.toThrow();
      expect(compareApiJourneys(a!, b!).status).not.toBe('match');
    }
    const dir = await directory();
    await expect(saveApiJourneyRun(record, dir)).rejects.toThrow(/invalid API journey record/);
    const file = path.join(dir, 'api-journeys', record.id, 'record.json');
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(record));
    expect(await getApiJourneyRun(record.id, dir)).toBeNull();
  });
  const semantic: [string, (r: any) => void][] = [
    ['POST receipt binding', r => { r.journeys[0].exchanges.find((e: any) => e.method === 'POST').response.receiptId = 'wrong'; }],
    ['event identity', r => walk(r.journeys[0], v => { if ('eventId' in v) v.eventId = 'wrong'; })],
    ['execution identity', r => walk(r.journeys[0], v => { if ('executionId' in v) v.executionId = 'wrong'; })],
    ['order identity', r => walk(r.journeys[0], v => { if ('orderId' in v) v.orderId = 'wrong'; })],
    ['command', r => { r.journeys[0].exchanges.find((e: any) => e.method === 'POST').request.limit = 99; }],
    ['business status', r => walk(r.journeys[0], v => { if (v.status === 'accepted') v.status = 'rejected'; })],
    ['state', r => walk(r.journeys[0], v => { if ('reservedCredit' in v) v.reservedCredit = 555; })],
    ['logical horizon', r => walk(r.journeys[0], v => { if (Array.isArray(v.trace)) v.trace.pop(); })],
    ['missing observation', r => { r.journeys[0].observation = null; }],
    ['poll binding', r => { r.journeys[0].exchanges.find((e: any) => e.path === '/events').response.instanceId = 'wrong'; }],
    ['poll state', r => { r.journeys[0].exchanges.find((e: any) => e.path === '/events').response.state.usedCredit = 999; }],
    ['poll method', r => { r.journeys[0].exchanges.find((e: any) => e.path === '/events').method = 'POST'; }],
    ['duplicate delivery facts', r => walk(r.journeys[0], v => { if (Array.isArray(v.deliveryObservations)) v.deliveryObservations.push(structuredClone(v.deliveryObservations[0])); })],
    ['extra exchange', r => { r.journeys[0].exchanges.push(r.journeys[0].exchanges.at(-1)); }],
    ['request ordering', r => { r.journeys[0].exchanges.reverse(); }],
    ['expected assertion', r => { r.journeys[0].assertions[0].expected = 'changed'; }],
    ['observed assertion', r => { r.journeys[0].assertions[0].observed = 'changed'; }],
    ['extra assertion', r => { r.journeys[0].assertions.push({ id: 'extra', expected: true, observed: true, status: 'pass' }); }],
    ['removed assertion', r => { r.journeys[0].assertions.pop(); }],
  ];
  it.each(semantic)('does not trust equal summaries or equal corrupt evidence: %s', async (_, change) => {
    const record = mutate(change);
    for (const [a, b] of [[record, clean], [clean, record], [record, record]]) expect(compareApiJourneys(a!, b!).status).not.toBe('match');
    expect(isValidApiJourneyRecord(record)).toBe(false);
    await expect(saveApiJourneyRun(record, await directory())).rejects.toThrow(/invalid API journey record/);
  });
  it('compares meaningful valid result payloads when all assertions still agree', () => {
    const record = mutate(r => walk(r, v => { if (v.experiment) v.experiment.hypothesis = 'Different recorded execution intent'; }));
    expect(isValidApiJourneyRecord(record)).toBe(true);
    expect(record.journeys.map(j => j.assertions)).toEqual(clean.journeys.map(j => j.assertions));
    expect(compareApiJourneys(clean, record).status).toBe('different');
    expect(compareApiJourneys(record, clean).status).toBe('different');
  });
  it('normalizes only validated UUID bindings, elapsed time, ports and repeated valid polls', () => {
    const record = mutate(r => {
      for (const j of r.journeys) {
        const previous = j.instanceId; const next = `new-${previous}`;
        walk(j, v => {
          if (v.instanceId === previous) v.instanceId = next;
          if (typeof v.eventId === 'string') v.eventId = v.eventId.replace(previous, next);
          if (typeof v.receiptId === 'string') v.receiptId = `new-${v.receiptId}`;
          if ('elapsedMs' in v) v.elapsedMs += 200;
        });
        j.endpoint = 'http://127.0.0.1:12345';
        const i = j.exchanges.findIndex((e: any) => e.path === '/events');
        j.exchanges.splice(i, 0, structuredClone(j.exchanges[i]));
      }
    });
    expect(isValidApiJourneyRecord(record)).toBe(true);
    expect(compareApiJourneys(clean, record).status).toBe('match');
  });
  it('loads historical identities unchanged, but blocks re-verification', async () => {
    for (const kind of ['evaluator', 'transport'] as const) {
      const old = mutate(r => { r[kind].hash = '0'.repeat(64); });
      const dir = await directory(); await saveApiJourneyRun(old, dir);
      expect(await getApiJourneyRun(old.id, dir)).toEqual(old);
      expect(compareApiJourneys(old, old).status).toBe('blocked');
    }
    const oldRule = mutate(r => { r.systemSnapshot.requirementEvaluator = { id: 'historical', version: 1, hash: '0'.repeat(64) };
      r.systemSnapshot.hash = computeSnapshotHash(r.systemSnapshot.brief, r.systemSnapshot.contract, r.systemSnapshot.requirementEvaluator); });
    expect(isValidApiJourneyRecord(oldRule)).toBe(true);
    expect(compareApiJourneys(oldRule, oldRule).status).toBe('blocked');
  });
  it('reopens honest incomplete and cancelled terminal evidence without claiming match', async () => {
    for (const record of [await runApiJourneys({ variant: 'clean', systemSnapshot: clean.systemSnapshot, signal: AbortSignal.abort() }),
      await runApiJourneys({ variant: 'clean', systemSnapshot: clean.systemSnapshot, timeoutMs: 10, targetOptions: { processingDelayMs: 100 } })]) {
      expect(['cancelled', 'inconclusive']).toContain(record.status);
      const dir = await directory(); await saveApiJourneyRun(record, dir);
      expect(await getApiJourneyRun(record.id, dir)).toEqual(record);
      const c = compareApiJourneys(record, record); expect(c.status).toBe('blocked'); expect(c.note).not.toContain('verified all');
    }
  });
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
describe('completed inode exclusive publication', () => {
  it('exposes no final record during a paused partial temp write and captures caller bytes before awaits', async () => {
    const dir = await directory(), entered = deferred(), resume = deferred();
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      return { writeFile: async (bytes: string) => {
        await handle.write(bytes.slice(0, 60), 0, 'utf8'); entered.resolve(); await resume.promise;
        await handle.write(bytes, 0, 'utf8');
      }, close: () => handle.close() } as Awaited<ReturnType<typeof fs.open>>;
    });
    const record = structuredClone(clean), expected = structuredClone(record);
    const pending = saveApiJourneyRun(record, dir); await entered.promise;
    record.journeys = []; record.integrity = 'mutated-after-call';
    expect(await getApiJourneyRun(expected.id, dir)).toBeNull();
    const runDir = path.join(dir, 'api-journeys', expected.id);
    expect(await fs.readdir(runDir)).toHaveLength(1);
    resume.resolve(); await pending;
    expect(await getApiJourneyRun(expected.id, dir)).toEqual(expected);
    expect(await fs.readdir(runDir)).toEqual(['record.json']);
  });
  it('publishes through a completed temp hard link, with no copy or rename fallback', async () => {
    const dir = await directory(), entered = deferred(), resume = deferred(); const link = fs.link;
    const copy = vi.spyOn(fs, 'copyFile'), rename = vi.spyOn(fs, 'rename');
    vi.spyOn(fs, 'link').mockImplementation(async (temp, final) => {
      expect(JSON.parse(await fs.readFile(temp, 'utf8'))).toEqual(clean);
      expect(path.dirname(String(temp))).toBe(path.dirname(String(final)));
      entered.resolve(); await resume.promise; await link(temp, final);
    });
    const pending = saveApiJourneyRun(clean, dir); await entered.promise;
    expect(await getApiJourneyRun(clean.id, dir)).toBeNull(); resume.resolve(); await pending;
    expect(await getApiJourneyRun(clean.id, dir)).toEqual(clean);
    expect(copy).not.toHaveBeenCalled(); expect(rename).not.toHaveBeenCalled();
  });
  it.each(['write', 'publish'])('cleans only its owned temp on %s failure and preserves prior evidence', async stage => {
    const dir = await directory(); await saveApiJourneyRun(clean, dir);
    const next = mutate(r => { r.id += '_next'; });
    if (stage === 'publish') vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }));
    else {
      const open = fs.open;
      vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        return { writeFile: async () => { await handle.write('partial'); throw new Error('disk full'); }, close: () => handle.close() } as Awaited<ReturnType<typeof fs.open>>;
      });
    }
    await expect(saveApiJourneyRun(next, dir)).rejects.toThrow(stage === 'publish' ? /Atomic exclusive.*hard links/ : /disk full/);
    expect(await getApiJourneyRun(next.id, dir)).toBeNull();
    expect(await fs.readdir(path.join(dir, 'api-journeys', next.id))).toEqual([]);
    expect(await getApiJourneyRun(clean.id, dir)).toEqual(clean);
  });
});
