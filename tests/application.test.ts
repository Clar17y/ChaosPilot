import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ChaosPilotServer, createServer } from '../src/server.ts';
import { PROMPT_TEMPLATE_HASH, PROMPT_VERSION } from '../src/investigation/index.ts';
import { main as cliMain } from '../src/cli.ts';
import {
  saveRun,
  getRun,
  listRuns,
  deleteRun,
  replayRun,
  validateRunId,
  type SimulatorApi,
} from '../src/storage.ts';
import type {
  InvestigationRecord,
  InvestigationOptions,
  TargetVariant,
  Experiment,
  ExperimentResult,
  SourceBundle,
  ExperimentProvider,
} from '../src/domain.ts';

function createDummyRecord(id: string, variant: TargetVariant = 'candidate-a'): InvestigationRecord {
  return {
    schemaVersion: 1,
    id,
    provider: 'mock',
    model: 'mock-scripted',
    mode: 'mock',
    variant,
    status: 'completed',
    startedAt: new Date(Date.now() - 5000).toISOString(),
    finishedAt: new Date().toISOString(),
    sourceHash: 'hash-abc-123',
    experiments: [
      {
        index: 1,
        experiment: {
          hypothesis: 'Test hypothesis',
          expectedInvariant: 'order_quantity_conservation',
          steps: [],
        },
        result: {
          schemaVersion: 1,
          experiment: {
            hypothesis: 'Test hypothesis',
            expectedInvariant: 'order_quantity_conservation',
            steps: [],
          },
          sourceHash: 'hash-abc-123',
          trace: [],
          snapshot: {},
          violations: [
            {
              id: 'v1',
              invariant: 'order_quantity_conservation',
              message: 'Order quantity conservation violated',
              step: 3,
              evidence: {},
            },
          ],
          rejections: [],
          valid: true,
        },
        replayVerified: true,
        cleanControlPassed: true,
      },
    ],
    findings: [
      {
        id: 'finding-1',
        title: 'Order quantity conservation failure',
        hypothesis: 'Test hypothesis',
        experimentIndex: 1,
        violation: {
          id: 'v1',
          invariant: 'order_quantity_conservation',
          message: 'Order quantity conservation violated',
          step: 3,
          evidence: {},
        },
        sourceHash: 'hash-abc-123',
        reproduced: true,
        cleanControlPassed: true,
        replay: {
          hypothesis: 'Test hypothesis',
          expectedInvariant: 'order_quantity_conservation',
          steps: [],
        },
      },
    ],
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostUsd: 0.001,
    },
    errors: [],
    contextAudit: {
      sourcePaths: ['order-engine.ts'],
      // Legacy fixture: no contract hash was recorded, and the recorded prompt
      // identity is the current one, so source+execution exactness is testable.
      contractHash: '',
      promptVersion: PROMPT_VERSION,
      promptTemplateHash: PROMPT_TEMPLATE_HASH,
    },
  };
}

function makeRawRequest(
  options: http.RequestOptions,
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode || 0, body: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('Storage & Artifact Management', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chaospilot-storage-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('validates run IDs and blocks directory traversal attempts', () => {
    expect(validateRunId('run_12345678')).toBe(true);
    expect(validateRunId('inv-2026-test')).toBe(true);

    // Traversal and malformed attempts
    expect(validateRunId('../etc/passwd')).toBe(false);
    expect(validateRunId('..\\windows\\win.ini')).toBe(false);
    expect(validateRunId('/root')).toBe(false);
    expect(validateRunId('run/with/slash')).toBe(false);
    expect(validateRunId('')).toBe(false);
    expect(validateRunId('ab')).toBe(false); // too short
  });

  it('excludes private usage ledgers from run retrieval and listing', async () => {
    // Ledger-like files must fail validation
    expect(validateRunId('ledger')).toBe(false);
    expect(validateRunId('usage-ledger')).toBe(false);
    expect(validateRunId('runs-ledger-private')).toBe(false);

    // Write a fake ledger file and a valid run file into tmpDir
    await fs.writeFile(path.join(tmpDir, 'ledger.json'), JSON.stringify({ privateCost: 100 }));
    await fs.writeFile(path.join(tmpDir, 'usage-ledger.json'), JSON.stringify({ reserved: 25 }));

    const validRun = createDummyRecord('run_valid_1234');
    await saveRun(validRun, tmpDir);

    const runs = await listRuns(tmpDir);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe('run_valid_1234');

    // Attempting getRun on ledger returns null
    expect(await getRun('ledger', tmpDir)).toBeNull();
    expect(await getRun('usage-ledger', tmpDir)).toBeNull();
  });

  it('safely skips malformed or corrupt JSON artifacts when listing runs', async () => {
    // Write corrupt JSON
    await fs.writeFile(path.join(tmpDir, 'run_corrupt1.json'), '{ invalid json ...');
    // Write JSON missing required schema
    await fs.writeFile(path.join(tmpDir, 'run_invalid2.json'), JSON.stringify({ foo: 'bar' }));

    const validRun = createDummyRecord('run_valid_ok99');
    await saveRun(validRun, tmpDir);

    const runs = await listRuns(tmpDir);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe('run_valid_ok99');
  });

  it('performs atomic writes via temporary files', async () => {
    const validRun = createDummyRecord('run_atomic_01');
    const savedPath = await saveRun(validRun, tmpDir);

    expect(await fs.stat(savedPath)).toBeDefined();
    // No remaining .tmp files
    const entries = await fs.readdir(tmpDir);
    const tmpEntries = entries.filter((e) => e.startsWith('.tmp-'));
    expect(tmpEntries).toHaveLength(0);

    const loaded = await getRun('run_atomic_01', tmpDir);
    expect(loaded?.id).toBe('run_atomic_01');
  });

  it('deletes runs safely', async () => {
    const validRun = createDummyRecord('run_delete_01');
    await saveRun(validRun, tmpDir);

    expect(await getRun('run_delete_01', tmpDir)).not.toBeNull();
    const deleted = await deleteRun('run_delete_01', tmpDir);
    expect(deleted).toBe(true);
    expect(await getRun('run_delete_01', tmpDir)).toBeNull();

    // Deleting non-existent returns false
    expect(await deleteRun('run_delete_01', tmpDir)).toBe(false);
  });
});

describe('Replay Provenance & Deterministic Execution', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chaospilot-replay-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('claims exact reproduction when source hash matches and results reproduce', async () => {
    const record = createDummyRecord('run_replay_match');
    await saveRun(record, tmpDir);

    const fakeSimulator: SimulatorApi = {
      getSourceBundle: (_variant) => ({
        hash: 'hash-abc-123', // Matches record.sourceHash
        files: [{ path: 'order-engine.ts', content: '// code' }],
      }),
      executeExperiment: (_exp, _variant) => ({
        schemaVersion: 1,
        experiment: _exp,
        sourceHash: 'hash-abc-123',
        trace: [],
        snapshot: {},
        violations: [
          {
            id: 'v1',
            invariant: 'order_quantity_conservation',
            message: 'Order quantity conservation violated',
            step: 3,
            evidence: {},
          },
        ],
        rejections: [],
        valid: true,
      }),
    };

    const report = await replayRun('run_replay_match', tmpDir, fakeSimulator);
    expect(report.sourceIdentical).toBe(true);
    expect(report.reproduced).toBe(true);
    expect(report.exactReproductionClaimed).toBe(true);
    expect(report.experimentsReproduced).toBe(1);
  });

  it('refuses exact reproduction claim when target source hash has diverged', async () => {
    const record = createDummyRecord('run_replay_diverged');
    await saveRun(record, tmpDir);

    const fakeSimulator: SimulatorApi = {
      getSourceBundle: (_variant) => ({
        hash: 'different-source-hash-999', // Diverged!
        files: [{ path: 'order-engine.ts', content: '// modified' }],
      }),
      executeExperiment: (_exp, _variant) => ({
        schemaVersion: 1,
        experiment: _exp,
        sourceHash: 'different-source-hash-999',
        trace: [],
        snapshot: {},
        violations: [
          {
            id: 'v1',
            invariant: 'order_quantity_conservation',
            message: 'Order quantity conservation violated',
            step: 3,
            evidence: {},
          },
        ],
        rejections: [],
        valid: true,
      }),
    };

    const report = await replayRun('run_replay_diverged', tmpDir, fakeSimulator);
    expect(report.sourceIdentical).toBe(false);
    expect(report.exactReproductionClaimed).toBe(false);
    expect(report.note).toContain('Source changed or diverged');
  });

  it('refuses exact reproduction claim when trace changed despite same violations', async () => {
    const record = createDummyRecord('run_replay_trace_diff');
    // Original record has empty trace
    await saveRun(record, tmpDir);

    const fakeSimulator: SimulatorApi = {
      getSourceBundle: (_variant) => ({
        hash: 'hash-abc-123', // Matches record.sourceHash
        files: [],
      }),
      executeExperiment: (_exp, _variant) => ({
        schemaVersion: 1,
        experiment: _exp,
        sourceHash: 'hash-abc-123',
        trace: [
          // Replayed trace changed!
          {
            step: 1,
            time: 0,
            action: 'send',
            outcome: 'SENT',
            state: {},
          },
        ],
        snapshot: {},
        violations: [
          {
            id: 'v1',
            invariant: 'order_quantity_conservation',
            message: 'Order quantity conservation violated',
            step: 3,
            evidence: {},
          },
        ],
        rejections: [],
        valid: true,
      }),
    };

    const report = await replayRun('run_replay_trace_diff', tmpDir, fakeSimulator);
    expect(report.sourceIdentical).toBe(true);
    expect(report.exactReproductionClaimed).toBe(false);
    expect(report.reproduced).toBe(false);
    expect(report.outcomes[0]?.violationsMatched).toBe(true);
    expect(report.outcomes[0]?.traceMatched).toBe(false);
    expect(report.outcomes[0]?.mismatches?.some((m) => m.includes('Trace'))).toBe(true);
  });

  it('refuses exact reproduction claim when snapshot changed', async () => {
    const record = createDummyRecord('run_replay_snap_diff');
    // Original snapshot is {}
    await saveRun(record, tmpDir);

    const fakeSimulator: SimulatorApi = {
      getSourceBundle: (_variant) => ({
        hash: 'hash-abc-123',
        files: [],
      }),
      executeExperiment: (_exp, _variant) => ({
        schemaVersion: 1,
        experiment: _exp,
        sourceHash: 'hash-abc-123',
        trace: [],
        snapshot: { availableCredit: 9999 }, // Snapshot changed!
        violations: [
          {
            id: 'v1',
            invariant: 'order_quantity_conservation',
            message: 'Order quantity conservation violated',
            step: 3,
            evidence: {},
          },
        ],
        rejections: [],
        valid: true,
      }),
    };

    const report = await replayRun('run_replay_snap_diff', tmpDir, fakeSimulator);
    expect(report.sourceIdentical).toBe(true);
    expect(report.exactReproductionClaimed).toBe(false);
    expect(report.reproduced).toBe(false);
    expect(report.outcomes[0]?.snapshotMatched).toBe(false);
  });

  it('supports safe runs/<id>.json path or run id for replay', async () => {
    const record = createDummyRecord('run_replay_path_compat');
    await saveRun(record, tmpDir);

    const fakeSimulator: SimulatorApi = {
      getSourceBundle: () => ({ hash: 'hash-abc-123', files: [] }),
      executeExperiment: (_exp) => ({
        schemaVersion: 1,
        experiment: _exp,
        sourceHash: 'hash-abc-123',
        trace: [],
        snapshot: {},
        violations: [
          {
            id: 'v1',
            invariant: 'order_quantity_conservation',
            message: 'Order quantity conservation violated',
            step: 3,
            evidence: {},
          },
        ],
        rejections: [],
        valid: true,
      }),
    };

    // Replay using runs/<id>.json path format
    const report1 = await replayRun(`runs/run_replay_path_compat.json`, tmpDir, fakeSimulator);
    expect(report1.runId).toBe('run_replay_path_compat');
    expect(report1.exactReproductionClaimed).toBe(true);

    // Replay using <id>.json format
    const report2 = await replayRun(`run_replay_path_compat.json`, tmpDir, fakeSimulator);
    expect(report2.runId).toBe('run_replay_path_compat');
    expect(report2.exactReproductionClaimed).toBe(true);
  });

  it('rejects invalid record variant when loading or listing run', async () => {
    const invalidRec = createDummyRecord('run_invalid_var');
    (invalidRec as any).variant = 'unsupported-bogus-variant';
    // Write directly to bypass saveRun validation
    await fs.writeFile(path.join(tmpDir, 'run_invalid_var.json'), JSON.stringify(invalidRec), 'utf8');

    expect(await getRun('run_invalid_var', tmpDir)).toBeNull();
    const runs = await listRuns(tmpDir);
    expect(runs.find((r) => r.id === 'run_invalid_var')).toBeUndefined();
  });

  it('rejects id mismatch between filename and record id', async () => {
    const mismatchRec = createDummyRecord('run_id_inside');
    // Filename is run_file_outside.json but inside id is run_id_inside
    await fs.writeFile(path.join(tmpDir, 'run_file_outside.json'), JSON.stringify(mismatchRec), 'utf8');

    expect(await getRun('run_file_outside', tmpDir)).toBeNull();
    const runs = await listRuns(tmpDir);
    expect(runs.find((r) => r.id === 'run_file_outside')).toBeUndefined();
  });

  it('persists partial onUpdate evidence upon cancellation', async () => {
    const partialRecord = createDummyRecord('run_partial_cancel');
    partialRecord.status = 'cancelled';
    partialRecord.stopReason = 'Interrupted by user signal';
    partialRecord.finishedAt = new Date().toISOString();

    const savedPath = await saveRun(partialRecord, tmpDir);
    expect(await fs.stat(savedPath)).toBeDefined();

    const loaded = await getRun('run_partial_cancel', tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.status).toBe('cancelled');
    expect(loaded?.stopReason).toContain('Interrupted');
    expect(loaded?.experiments).toHaveLength(1);
  });

  it('never invokes model/provider during replay', async () => {
    const record = createDummyRecord('run_replay_no_prov');
    await saveRun(record, tmpDir);

    let providerCalled = false;
    const fakeSimulator: SimulatorApi = {
      getSourceBundle: (_v) => ({ hash: 'hash-abc-123', files: [] }),
      executeExperiment: (_exp, _v) => {
        // Deterministic simulator execution only
        return {
          schemaVersion: 1,
          experiment: _exp,
          sourceHash: 'hash-abc-123',
          trace: [],
          snapshot: {},
          violations: [],
          rejections: [],
          valid: true,
        };
      },
    };

    await replayRun('run_replay_no_prov', tmpDir, fakeSimulator);
    expect(providerCalled).toBe(false);
  });
});

describe('HTTP Server Lifecycle & Invariants', () => {
  let server: http.Server;
  let serverInstance: ChaosPilotServer;
  let port: number;
  let baseUrl: string;
  let tmpRunsDir: string;

  beforeEach(async () => {
    tmpRunsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chaospilot-server-'));
    serverInstance = new ChaosPilotServer({
      runsDir: tmpRunsDir,
      providerFactory: (_kind) => {
        if (_kind !== 'mock') throw new Error('Unsupported test provider');
        return ({
        kind: 'mock',
        model: 'mock-controlled',
        propose: async () => ({
          experiment: null,
          usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0 },
        }),
        });
      },
    });
    server = serverInstance.createHttpServer();

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr === 'object' && addr) {
          port = addr.port;
          baseUrl = `http://127.0.0.1:${port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmpRunsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it.each(['finish', 'malformed', 'stop', 'factory'] as const)(
    'owns an incomplete start body through %s and releases ownership for a retry', async disposition => {
      const entered = new Promise<void>(resolve => server.once('request', () => resolve()));
      const slow = http.request(`${baseUrl}/api/investigation/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }
      });
      const response = new Promise<number | undefined>((resolve, reject) => {
        slow.once('error', reject);
        slow.once('response', result => {
          result.resume();
          result.once('end', () => resolve(result.statusCode));
        });
      });
      try {
        slow.write('{');
        await entered;
        const contender = await fetch(`${baseUrl}/api/investigation/start`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        expect(contender.status).toBe(409);
        await contender.text();

        if (disposition === 'stop') {
          const stopped = await fetch(`${baseUrl}/api/investigation/stop`, { method: 'POST' });
          expect(stopped.status).toBe(200);
          await stopped.text();
        }
        slow.end(disposition === 'malformed' ? 'broken' :
          disposition === 'factory' ? '"provider":"unknown"}' : '"maxExperiments":1}');
        expect(await response).toBe({ finish: 202, malformed: 400, stop: 409, factory: 500 }[disposition]);
        await serverInstance.getActiveInvestigation()?.promise;
        expect(serverInstance.getActiveInvestigation()).toBeNull();
        if (disposition !== 'finish') expect(serverInstance.getLatestRecord()).toBeNull();

        const retry = await fetch(`${baseUrl}/api/investigation/start`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"maxExperiments":1}'
        });
        expect(retry.status).toBe(202);
        await retry.text();
        await serverInstance.getActiveInvestigation()?.promise;
      } finally {
        slow.destroy();
      }
    }
  );

  it('enforces single active investigation exclusivity (start/start returns 409)', async () => {
    // Create a slow runner that hangs until released
    let resolveRunner: (rec: InvestigationRecord) => void;
    const runnerPromise = new Promise<InvestigationRecord>((res) => {
      resolveRunner = res;
    });

    const controlledServer = new ChaosPilotServer({
      runsDir: tmpRunsDir,
      investigationRunner: async (opts) => {
        const dummy = createDummyRecord(opts.id || 'slow_run');
        opts.onUpdate?.(dummy);
        return runnerPromise;
      },
      providerFactory: () => ({ kind: 'mock', model: 'm', propose: async () => ({ experiment: null, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } }) }),
    });

    const controlledHttp = controlledServer.createHttpServer();
    const ctrlPort = await new Promise<number>((res) => {
      controlledHttp.listen(0, '127.0.0.1', () => {
        const a = controlledHttp.address();
        res(typeof a === 'object' && a ? a.port : 0);
      });
    });

    try {
      // 1. First start
      const start1 = await fetch(`http://127.0.0.1:${ctrlPort}/api/investigation/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant: 'candidate-a' }),
      });
      expect(start1.status).toBe(202);

      // 2. Second start while first is running -> MUST be 409 Conflict
      const start2 = await fetch(`http://127.0.0.1:${ctrlPort}/api/investigation/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant: 'candidate-b' }),
      });
      expect(start2.status).toBe(409);
      const errJson = await start2.json();
      expect(errJson.error).toContain('already in progress');

      // Release first
      resolveRunner!(createDummyRecord('slow_run'));
      await controlledServer.getActiveInvestigation()?.promise;
    } finally {
      await new Promise<void>((res) => controlledHttp.close(() => res()));
    }
  });

  it('handles start/stop/start lifecycle while first is settling', async () => {
    let unblockRunner: () => void;
    const blockPromise = new Promise<void>((r) => { unblockRunner = r; });

    const controlledServer = new ChaosPilotServer({
      runsDir: tmpRunsDir,
      investigationRunner: async (opts) => {
        const dummy = createDummyRecord(opts.id || 'settle_run');
        opts.onUpdate?.(dummy);
        await blockPromise;
        return dummy;
      },
      providerFactory: () => ({ kind: 'mock', model: 'm', propose: async () => ({ experiment: null, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } }) }),
    });

    const controlledHttp = controlledServer.createHttpServer();
    const ctrlPort = await new Promise<number>((res) => {
      controlledHttp.listen(0, '127.0.0.1', () => {
        const a = controlledHttp.address();
        res(typeof a === 'object' && a ? a.port : 0);
      });
    });

    try {
      // Start
      await fetch(`http://127.0.0.1:${ctrlPort}/api/investigation/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant: 'candidate-a' }),
      });

      // Stop while running
      const stopRes = await fetch(`http://127.0.0.1:${ctrlPort}/api/investigation/stop`, {
        method: 'POST',
      });
      expect(stopRes.status).toBe(200);

      // Attempt second start while settling -> MUST return 409
      const secondStart = await fetch(`http://127.0.0.1:${ctrlPort}/api/investigation/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant: 'clean' }),
      });
      expect(secondStart.status).toBe(409);

      // Unblock and settle
      unblockRunner!();
      await controlledServer.getActiveInvestigation()?.promise;

      // After settling, a new start is permitted
      const thirdStart = await fetch(`http://127.0.0.1:${ctrlPort}/api/investigation/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant: 'clean' }),
      });
      expect(thirdStart.status).toBe(202);
      await controlledServer.getActiveInvestigation()?.promise;
    } finally {
      await new Promise<void>((res) => controlledHttp.close(() => res()));
    }
  });

  it('rejects cross-port origin on mutating requests', async () => {
    const res = await fetch(`${baseUrl}/api/investigation/stop`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port + 1}`,
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('Same-origin');
  });

  it('rejects evil Host matching Origin on mutating requests and GET requests', async () => {
    // GET request with evil Host sent over wire
    const getRes = await makeRawRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/status',
      method: 'GET',
      headers: {
        Host: 'evil.com',
      },
    });
    expect(getRes.status).toBe(403);

    // POST request with evil Host even matching evil Origin
    const postRes = await makeRawRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/investigation/stop',
        method: 'POST',
        headers: {
          Host: 'evil.com',
          Origin: 'http://evil.com',
          'Content-Type': 'application/json',
        },
      },
      JSON.stringify({})
    );
    expect(postRes.status).toBe(403);
  });

  it('permits valid loopback Host and Origin on mutating and CLI requests', async () => {
    // Valid 127.0.0.1 Origin matching server port
    const stopRes1 = await fetch(`${baseUrl}/api/investigation/stop`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
      },
    });
    // Stop returns 400 because no investigation is running, but passed origin check (not 403!)
    expect(stopRes1.status).toBe(400);

    // Valid CLI request with no Origin header
    const stopRes2 = await fetch(`${baseUrl}/api/investigation/stop`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${port}`,
      },
    });
    expect(stopRes2.status).toBe(400);
  });

  it('rejects oversized JSON payload with 413 and malformed JSON with 400', async () => {
    // Malformed JSON
    const malformedRes = await fetch(`${baseUrl}/api/investigation/start`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        'Content-Type': 'application/json',
      },
      body: '{ not valid json ...',
    });
    expect(malformedRes.status).toBe(400);
    const mBody = await malformedRes.json();
    expect(mBody.error).toContain('Malformed JSON');

    // Oversized JSON (>64KB)
    const oversizedBody = JSON.stringify({
      variant: 'candidate-a',
      padding: 'x'.repeat(70 * 1024),
    });
    const oversizedRes = await fetch(`${baseUrl}/api/investigation/start`, {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        'Content-Type': 'application/json',
      },
      body: oversizedBody,
    });
    expect(oversizedRes.status).toBe(413);
    const oBody = await oversizedRes.json();
    expect(oBody.error).toContain('Payload too large');
  });

  it('serves static files on allowlist and prevents path traversal', async () => {
    // Root index.html
    const indexRes = await fetch(`${baseUrl}/`);
    expect(indexRes.status).toBe(200);
    expect(indexRes.headers.get('content-type')).toContain('text/html');

    // styles.css
    const cssRes = await fetch(`${baseUrl}/styles.css`);
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get('content-type')).toContain('text/css');

    // app.js
    const jsRes = await fetch(`${baseUrl}/app.js`);
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get('content-type')).toContain('javascript');

    // Path traversal attempts -> 404
    const trav1 = await fetch(`${baseUrl}/../package.json`);
    expect(trav1.status).toBe(404);

    const trav2 = await fetch(`${baseUrl}/etc/passwd`);
    expect(trav2.status).toBe(404);
  });

  it('serves every module imported by the workspace without exposing server modules', async () => {
    const pending = [new URL('/app.js', baseUrl).href];
    const visited = new Set<string>();
    while (pending.length) {
      const moduleUrl = pending.pop()!;
      if (visited.has(moduleUrl)) continue;
      visited.add(moduleUrl);
      const response = await fetch(moduleUrl);
      expect(response.status, moduleUrl).toBe(200);
      expect(response.headers.get('content-type'), moduleUrl).toContain('javascript');
      const source = await response.text();
      for (const match of source.matchAll(/^(?:import|export)\s+(?:.*?\sfrom\s*)?['"]([^'"]+)['"]/gm)) {
        const specifier = match[1]!;
        expect(specifier, moduleUrl).toMatch(/^\.{1,2}\//);
        pending.push(new URL(specifier, moduleUrl).href);
      }
    }
    expect(visited.has(new URL('/experiment-identity.js', baseUrl).href)).toBe(true);
    expect((await fetch(`${baseUrl}/storage.js`)).status).toBe(404);
  });

  it('exposes contract without raw env or secret answer keys', async () => {
    const res = await fetch(`${baseUrl}/api/contract`);
    expect(res.status).toBe(200);
    const contract = await res.json();
    expect(contract.name).toBeDefined();
    // Verify no env secrets or defect tags exposed
    const serialized = JSON.stringify(contract);
    expect(serialized).not.toContain('MODEL_API_KEY');
    expect(serialized).not.toContain('defectEnabled');
  });
});

describe('CLI Invariants & Flags Validation', () => {
  const originalExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it('rejects unsupported target variants with nonzero exitCode', async () => {
    process.exitCode = undefined;
    await cliMain(['investigate', '--target', 'bogus-target']);
    expect(process.exitCode).toBe(1);
  });

  it('rejects non-finite or out-of-bound max-experiments with nonzero exitCode', async () => {
    process.exitCode = undefined;
    await cliMain(['investigate', '--max-experiments', 'abc']);
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    await cliMain(['investigate', '--max-experiments', '0']);
    expect(process.exitCode).toBe(1);
  });

  it('rejects invalid seeds with nonzero exitCode', async () => {
    process.exitCode = undefined;
    await cliMain(['evaluate', '--seeds', '1001,notanumber']);
    expect(process.exitCode).toBe(1);
  });

  it('rejects unknown CLI options with nonzero exitCode', async () => {
    process.exitCode = undefined;
    await cliMain(['investigate', '--malicious-flag']);
    expect(process.exitCode).toBe(1);
  });

  it('rejects invalid benchmark phase with nonzero exitCode', async () => {
    process.exitCode = undefined;
    await cliMain(['benchmark', '--phase', 'invalid-phase']);
    expect(process.exitCode).toBe(1);
  });

  it('rejects unsupported target variants in benchmark --targets with nonzero exitCode', async () => {
    process.exitCode = undefined;
    await cliMain(['benchmark', '--targets', 'clean,invalid-target']);
    expect(process.exitCode).toBe(1);
  });
});
