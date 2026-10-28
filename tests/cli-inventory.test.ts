import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { main } from '../src/cli.ts';
import type { InvestigationRecord } from '../src/domain.ts';
import { saveRun } from '../src/storage.ts';

let tmp: string;
let runsDir: string;
let logs: string[];
let errors: string[];

async function cli(...argv: string[]): Promise<void> {
  process.exitCode = undefined;
  await main(argv);
}

async function savedRecords(): Promise<InvestigationRecord[]> {
  let entries: string[];
  try { entries = await fs.readdir(runsDir); } catch { return []; }
  const records: InvestigationRecord[] = [];
  for (const entry of entries.filter(e => e.endsWith('.json'))) {
    records.push(JSON.parse(await fs.readFile(path.join(runsDir, entry), 'utf8')) as InvestigationRecord);
  }
  return records;
}

beforeEach(async () => {
  try { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'chaospilot-cli-')); } catch { tmp = await fs.mkdtemp(path.join(process.cwd(), '.tmp-cli-')); }
  runsDir = path.join(tmp, 'runs');
  logs = []; errors = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
  await cli('inventory-init', '--runs-dir', runsDir);
  expect(process.exitCode).toBeUndefined();
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('CLI target defaults resolved from the saved system adapter', () => {
  it('defaults an inventory investigation to inventory-candidate-a', async () => {
    await cli('investigate', '--system-id', 'inventory-reservation', '--provider', 'mock', '--runs-dir', runsDir);
    expect(process.exitCode).toBeUndefined();
    const records = await savedRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.variant).toBe('inventory-candidate-a');
    expect(records[0]!.findings.length).toBeGreaterThan(0);
  });

  it('defaults a trading investigation to candidate-a', async () => {
    await cli('investigate', '--provider', 'mock', '--runs-dir', runsDir);
    expect(process.exitCode).toBeUndefined();
    const records = await savedRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.variant).toBe('candidate-a');
  });

  it('accepts explicit clean and inventory targets via --target and --variant aliases', async () => {
    await cli('investigate', '--system-id', 'inventory-reservation', '--target', 'clean', '--provider', 'mock', '--runs-dir', runsDir);
    expect(process.exitCode).toBeUndefined();
    await cli('investigate', '--system-id', 'inventory-reservation', '--variant=inventory-candidate-a', '--provider', 'mock', '--runs-dir', runsDir);
    expect(process.exitCode).toBeUndefined();
    const variants = (await savedRecords()).map(r => r.variant).sort();
    expect(variants).toEqual(['clean', 'inventory-candidate-a']);
  });

  it('rejects cross-adapter targets before creating any run or provider request', async () => {
    await cli('investigate', '--system-id', 'inventory-reservation', '--target', 'candidate-a', '--provider', 'meta', '--runs-dir', runsDir);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/Unsupported variant "candidate-a" for adapter "inventory-reservation"/);
    await cli('investigate', '--target', 'inventory-candidate-a', '--provider', 'meta', '--runs-dir', runsDir);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/Unsupported variant "inventory-candidate-a" for adapter "synthetic-trading"/);
    expect(await savedRecords()).toEqual([]);
  });

  it('rejects unsupported target values at parse time', async () => {
    await cli('investigate', '--system-id', 'inventory-reservation', '--target', 'candidate-z', '--runs-dir', runsDir);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/Invalid target variant/);
    expect(await savedRecords()).toEqual([]);
  });

  it('reports matching experiments with unverified context without calling them a mismatch', async () => {
    await cli('investigate', '--system-id', 'inventory-reservation', '--provider', 'mock', '--runs-dir', runsDir);
    const record = (await savedRecords())[0]!;
    delete record.contextAudit.cleanSourceHash;
    await saveRun(record, runsDir);
    logs = [];

    await cli('replay', '--id', record.id, '--runs-dir', runsDir);
    expect(process.exitCode).toBe(1);
    expect(logs.join('\n')).toContain('EXPERIMENTS MATCHED; EXACT REPLAY UNCONFIRMED');
    expect(logs.join('\n')).toContain('Experiments Reproduced:     2/2');
    expect(logs.join('\n')).not.toContain('Replay Status:              MISMATCH');
  });

  it('keeps evaluate and benchmark trading-only', async () => {
    await cli('evaluate', '--target', 'inventory-candidate-a', '--provider', 'mock', '--runs-dir', runsDir);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/Unsupported variant "inventory-candidate-a" for adapter "synthetic-trading"/);
    errors = [];
    await cli('evaluate', '--system-id', 'inventory-reservation', '--provider', 'mock', '--runs-dir', runsDir);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/trading-only/);
    errors = [];
    await cli('benchmark', '--target', 'inventory-candidate-a', '--provider', 'mock', '--runs-dir', runsDir);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/Unsupported variant "inventory-candidate-a" for adapter "synthetic-trading"/);
    expect(await savedRecords()).toEqual([]);
  });
});
