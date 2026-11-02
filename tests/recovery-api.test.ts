import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type * as http from 'node:http';
import { ChaosPilotServer } from '../src/server.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { getContract } from '../src/recovery/contract.ts';
import { RECOVERY_EVALUATOR_IDENTITY } from '../src/recovery/index.ts';
import { computeSnapshotHash } from '../src/systems/index.ts';
import { canonicalJson } from '../src/evidence.ts';
import { listRuns } from '../src/storage.ts';

// Real HTTP handlers exercised directly (no socket listener), matching
// tests/inventory-api.test.ts so this runs where binding ports is denied.
let runsDir: string;
let instance: ChaosPilotServer;
let listener: (...args: unknown[]) => void;
let providerFactoryCalls = 0;

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chaospilot-recovery-api-'));
  providerFactoryCalls = 0;
  instance = new ChaosPilotServer({
    runsDir,
    providerFactory: (kind) => {
      providerFactoryCalls++;
      if (kind !== 'mock') throw new Error('Unsupported test provider');
      return new MockProvider();
    },
  });
  const server = instance.createHttpServer();
  listener = server.listeners('request')[0] as typeof listener;
});

afterEach(async () => {
  if (runsDir) await fs.rm(runsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload)] : []) as any;
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1', 'content-type': 'application/json' };
  req.socket = { localPort: 80 };
  let status = 0;
  let text = '';
  const done = new Promise<void>((resolve) => {
    const res: Partial<http.ServerResponse> & { end: (chunk?: unknown) => void } = {
      writeHead(code: number) { status = code; return res as http.ServerResponse; },
      end(chunk?: unknown) { if (chunk) text += String(chunk); resolve(); return res as http.ServerResponse; },
    };
    listener(req, res);
  });
  await done;
  return { status, json: text ? JSON.parse(text) : null };
}

async function runToCompletion(runId: string) {
  await vi.waitFor(async () => {
    expect(instance.getActiveInvestigation()).toBeNull();
    expect((await listRuns(runsDir)).map((r) => r.id)).toContain(runId);
  }, { timeout: 15000 });
  return call('GET', `/api/runs/${runId}`);
}

describe('Recovery HTTP API (synthetic-trading-recovery / trading-recovery)', () => {
  it('serves the seeded trading-recovery snapshot with matching adapter, contract and hash', async () => {
    const { status, json } = await call('GET', '/api/systems/trading-recovery/snapshot');
    expect(status).toBe(200);
    expect(json.brief.id).toBe('trading-recovery');
    expect(json.brief.adapterId).toBe('synthetic-trading-recovery');
    expect(json.brief.revision).toBe(1);
    expect(canonicalJson(json.contract)).toBe(canonicalJson(getContract()));
    expect(json.hash).toBe(computeSnapshotHash(json.brief, json.contract, json.requirementEvaluator));
  });

  it('lists the seeded recovery system and exposes adapter targets/contract', async () => {
    const list = await call('GET', '/api/systems');
    expect(list.status).toBe(200);
    expect(list.json.map((s: any) => s.id)).toEqual(
      expect.arrayContaining(['trading-gateway', 'inventory-reservation', 'trading-recovery']),
    );
    expect((await call('GET', '/api/targets?adapterId=synthetic-trading-recovery')).json).toEqual([
      'clean', 'recovery-candidate-a',
    ]);
    expect((await call('GET', '/api/targets?adapterId=nope')).status).toBe(400);
    const contract = await call('GET', '/api/contract?adapterId=synthetic-trading-recovery');
    expect(contract.status).toBe(200);
    expect(contract.json.name).toBe('Trading recovery gateway');
    expect(contract.json.invariants.map((i: any) => i.id)).toContain('recovery_deadline');
    expect(contract.json.limits.recoveryDeadlineTicks).toBe(5);
  });

  it('rejects cross-adapter variants before constructing a provider (no model usage)', async () => {
    for (const variant of ['candidate-a', 'inventory-candidate-a']) {
      const { status, json } = await call('POST', '/api/investigation/start', {
        systemId: 'trading-recovery', variant, provider: 'mock', expectedRevision: 1,
      });
      expect(status).toBe(400);
      expect(json.error).toMatch(/Unsupported variant/);
    }
    expect(providerFactoryCalls).toBe(0);
    expect(await listRuns(runsDir)).toEqual([]);
  });

  it('runs faulty target offline to a confirmed recovery_deadline finding, persists raw evidence, and replays whole/selected', async () => {
    const started = await call('POST', '/api/investigation/start', {
      systemId: 'trading-recovery', variant: 'recovery-candidate-a', provider: 'mock', expectedRevision: 1,
    });
    expect(started.status).toBe(202);
    const runId = started.json.id as string;
    const record = await runToCompletion(runId);
    expect(record.status).toBe(200);
    expect(record.json.variant).toBe('recovery-candidate-a');
    expect(record.json.status).toBe('completed');
    expect(record.json.contextAudit.adapterId).toBe('synthetic-trading-recovery');
    expect(record.json.mode).toBe('mock');
    expect(record.json.usage).toEqual({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
    expect(record.json.proposalAttempts.every((a: any) => a.requestSent === false)).toBe(true);

    expect(record.json.findings).toHaveLength(1);
    expect(record.json.findings[0].category).toBe('recovery_deadline');
    expect(record.json.findings[0].reproduced).toBe(true);
    expect(record.json.findings[0].cleanControlPassed).toBe(true);

    const recovery = record.json.experiments[0].result.recovery;
    expect(recovery.schemaVersion).toBe(1);
    expect(recovery.evaluator).toEqual(RECOVERY_EVALUATOR_IDENTITY);
    expect(recovery.status).toBe('failed');
    expect(recovery.obligations[0].deadlineMissed).toBe(true);
    expect(recovery.obligations[0].deadlineTick).toBe(recovery.obligations[0].reconnectTick + 5);
    expect(recovery.ingress.some((i: any) => i.status === 'accepted' && i.disconnected)).toBe(true);

    const replay = await call('POST', `/api/runs/${runId}/replay`);
    expect(replay.status).toBe(200);
    expect(replay.json.exactReproductionClaimed).toBe(true);
    expect(replay.json.outcomes.every((o: any) => o.recoveryMatched)).toBe(true);
    expect(replay.json.contextChecks.find((c: any) => c.kind === 'recovery-evaluator')?.status).toBe('identical');

    const selected = await call('POST', `/api/runs/${runId}/experiments/0/replay`);
    expect(selected.status).toBe(200);
    expect(selected.json.scope).toBe('experiment');
    expect(selected.json.experimentPosition).toBe(0);
    expect(selected.json.exactReproductionClaimed).toBe(true);
    expect(selected.json.outcomes[0].recoveryMatched).toBe(true);
  });

  it('runs clean target with no finding and positive passed recovery evidence', async () => {
    const started = await call('POST', '/api/investigation/start', {
      systemId: 'trading-recovery', variant: 'clean', provider: 'mock', expectedRevision: 1,
    });
    expect(started.status).toBe(202);
    const record = await runToCompletion(started.json.id as string);
    expect(record.json.findings).toEqual([]);
    expect(record.json.experiments.length).toBeGreaterThanOrEqual(1);
    for (const exp of record.json.experiments) {
      expect(exp.result.valid).toBe(true);
      expect(exp.result.violations).toEqual([]);
      expect(exp.result.recovery.status).toBe('passed');
      expect(exp.result.recovery.obligations.length).toBeGreaterThan(0);
      expect(exp.result.recovery.obligations[0].completionTick).toBeLessThanOrEqual(
        exp.result.recovery.obligations[0].deadlineTick,
      );
      expect(exp.result.recovery.obligations[0].observed).toEqual(exp.result.recovery.obligations[0].expected);
    }
  });

  it('uses recovery-candidate-a as the default variant for the seeded profile', async () => {
    const started = await call('POST', '/api/investigation/start', {
      systemId: 'trading-recovery', provider: 'mock', expectedRevision: 1,
    });
    expect(started.status).toBe(202);
    const record = await runToCompletion(started.json.id as string);
    expect(record.json.variant).toBe('recovery-candidate-a');
    expect(record.json.findings).toHaveLength(1);
  });

  it('blocks trading-only functional baselines for the recovery adapter with an explicit reason', async () => {
    const res = await call('POST', '/api/functional/run', {
      systemId: 'trading-recovery', variant: 'clean', expectedRevision: 1,
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/only supported for the "synthetic-trading" adapter/);
  });
});
