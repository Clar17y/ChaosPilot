import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { main } from '../../src/cli.ts';
import { listApiJourneyRuns, getApiJourneyRun } from '../../src/target-api/storage.ts';

describe('CLI exit status and execution outcomes', () => {
  let tmp: string;
  let runsDir: string;
  let logs: string[];
  let errors: string[];

  async function cli(...argv: string[]): Promise<void> {
    process.exitCode = undefined;
    await main(argv);
  }

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'chaospilot-cli-target-api-'));
    runsDir = path.join(tmp, 'runs');
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(' '));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    if (tmp) {
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    }
  });

  it('exits with code 0 for a clean passing journey', async () => {
    await cli('api-journey', '--target', 'clean', '--runs-dir', runsDir);
    expect(process.exitCode).toBeUndefined();

    const runs = await listApiJourneyRuns(runsDir);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('pass');
  });

  it('exits with code 1 for a faulty journey (candidate-a)', async () => {
    await cli('api-journey', '--target', 'candidate-a', '--runs-dir', runsDir);
    expect(process.exitCode).toBe(1);

    const runs = await listApiJourneyRuns(runsDir);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('fail');
  });

  it('exits with code 0 when comparing matching clean runs', async () => {
    // 1. Run clean first
    await cli('api-journey', '--target', 'clean', '--runs-dir', runsDir);
    expect(process.exitCode).toBeUndefined();

    const runs = await listApiJourneyRuns(runsDir);
    expect(runs).toHaveLength(1);
    const origId = runs[0]!.id;

    // 2. Rerun clean and compare against origId
    await cli('api-journey', '--target', 'clean', '--compare', origId, '--runs-dir', runsDir);
    expect(process.exitCode).toBeUndefined();
    expect(logs.some((l) => l.includes('Comparison outcome: MATCH'))).toBe(true);
  });

  it('exits with code 1 when requested comparison produces different', async () => {
    // 1. Run clean first
    await cli('api-journey', '--target', 'clean', '--runs-dir', runsDir);
    expect(process.exitCode).toBeUndefined();

    const runs = await listApiJourneyRuns(runsDir);
    const origId = runs[0]!.id;

    // 2. Reseal the saved run with a modified sourceHash so variant matches but provenance differs
    const run = await getApiJourneyRun(origId, runsDir);
    expect(run).not.toBeNull();
    const modified = JSON.parse(JSON.stringify(run).replaceAll(run!.sourceHash, '0'.repeat(64)));
    const { seal } = await import('../../src/target-api/runner.ts');
    seal(modified);

    const recordPath = path.join(runsDir, 'api-journeys', origId, 'record.json');
    await fs.writeFile(recordPath, JSON.stringify(modified, null, 2), 'utf8');

    // 3. Rerun clean and compare against modified -> comparison is DIFFERENT -> exitCode 1
    await cli('api-journey', '--target', 'clean', '--compare', origId, '--runs-dir', runsDir);
    expect(process.exitCode).toBe(1);
    expect(logs.some((l) => l.includes('Comparison outcome: DIFFERENT'))).toBe(true);
  });

  it('exits with code 1 when requested comparison produces blocked', async () => {
    // 1. Run clean first
    await cli('api-journey', '--target', 'clean', '--runs-dir', runsDir);
    expect(process.exitCode).toBeUndefined();

    const runs = await listApiJourneyRuns(runsDir);
    const origId = runs[0]!.id;

    // 2. Historical evaluator identities remain readable but cannot be re-verified
    // but compareApiJourneys blocks it
    const run = await getApiJourneyRun(origId, runsDir);
    expect(run).not.toBeNull();
    const modified = structuredClone(run!);
    modified.evaluator.hash = '0'.repeat(64);
    const { seal } = await import('../../src/target-api/runner.ts');
    seal(modified);

    const recordPath = path.join(runsDir, 'api-journeys', origId, 'record.json');
    await fs.writeFile(recordPath, JSON.stringify(modified, null, 2), 'utf8');

    // 3. Rerun clean and compare against modified -> BLOCKED -> exitCode 1
    await cli('api-journey', '--target', 'clean', '--compare', origId, '--runs-dir', runsDir);
    expect(process.exitCode).toBe(1);
    expect(logs.some((l) => l.includes('Comparison outcome: BLOCKED'))).toBe(true);
  });
});
