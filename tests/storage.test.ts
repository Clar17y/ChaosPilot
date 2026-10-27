import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listRuns, saveRun } from '../src/storage.ts';
import type { InvestigationRecord } from '../src/domain.ts';

const dirs: string[] = [];
async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.tmp-chaospilot-runs-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
});

function record(id: string, withBrief: boolean): InvestigationRecord {
  return {
    schemaVersion: 1, id, provider: 'mock', model: 'mock-runner', mode: 'mock',
    variant: 'candidate-a', status: 'completed', startedAt: '2026-10-26T00:00:00.000Z',
    sourceHash: 'source-1', experiments: [], findings: [],
    usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, errors: [],
    contextAudit: { sourcePaths: [], contractHash: 'c', promptVersion: '1' },
    ...(withBrief ? {
      systemBrief: {
        brief: {
          schemaVersion: 1 as const, id: 'trading-gateway', revision: 1, name: 'Trading Gateway',
          overview: 'o', requirements: [], adapterId: 'synthetic-trading' as const,
          updatedAt: '2026-10-26T00:00:00.000Z',
        },
        contract: null, hash: 'hash-abc',
      },
    } : {}),
  };
}

describe('listRuns brief metadata', () => {
  it('exposes minimal pinned brief metadata without fetching full records', async () => {
    const dir = await tmpDir();
    await saveRun(record('run-with-brief', true), dir);
    await saveRun(record('run-legacy-01', false), dir);
    const summaries = await listRuns(dir);
    const withBrief = summaries.find(s => s.id === 'run-with-brief')!;
    expect(withBrief.systemBrief).toEqual({
      id: 'trading-gateway', name: 'Trading Gateway', revision: 1,
      adapterId: 'synthetic-trading', hash: 'hash-abc',
    });
    const legacy = summaries.find(s => s.id === 'run-legacy-01')!;
    // Legacy summary shape is preserved: no brief metadata is invented.
    expect(legacy.systemBrief).toBeUndefined();
    expect(legacy).toMatchObject({ id: 'run-legacy-01', status: 'completed', findingsCount: 0 });
  });

  it('keeps the pinned revision in the summary even though it is just metadata', async () => {
    const dir = await tmpDir();
    const rec = record('run-rev-pinned', true);
    rec.systemBrief!.brief.revision = 1;
    await saveRun(rec, dir);
    const [summary] = await listRuns(dir);
    expect(summary!.systemBrief?.revision).toBe(1);
  });
});
