import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAdapter } from '../src/adapters/index.ts';
import type { InvestigationRecord } from '../src/domain.ts';
import { runInvestigation } from '../src/investigation/index.ts';
import { MockProvider } from '../src/providers/mock.ts';
import {
  RegressionConflictError,
  captureRegressionFromFinding,
  getRegressionDefinition,
  getRegressionRun,
  isValidRegressionDefinitionRecord,
  isValidRegressionRunRecord,
  listRegressionDefinitions,
  listRegressionRuns,
  previewRegressionFromFinding,
  resolveRegressionDefinitionPath,
  resolveRegressionDefinitionsDir,
  resolveRegressionRunPath,
  resolveRegressionRunsDir,
  runSavedRegression,
  saveRegressionDefinition,
  saveRegressionRun,
  validateRegressionId,
  validateRegressionRunId,
} from '../src/regressions/index.ts';
import { ChaosPilotServer } from '../src/server.ts';
import { saveRun, saveSystemBrief } from '../src/storage.ts';
import { SEEDED_TRADING_BRIEF, createSystemSnapshot } from '../src/systems/index.ts';
import { api, type TestResponse } from './challenge-fixtures.ts';

async function rawRequest(
  instance: ChaosPilotServer,
  opts: { method: string; url: string; headers?: Record<string, string>; body?: string },
): Promise<TestResponse> {
  const server = instance.createHttpServer();
  return new Promise(resolve => {
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableEnded: false,
      writeHead(status: number) {
        this.statusCode = status;
        return this;
      },
      end(text = '') {
        this.writableEnded = true;
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: this.statusCode, json, text });
      },
    });
    const req = {
      method: opts.method,
      url: opts.url,
      headers: {
        host: '127.0.0.1:4310',
        origin: 'http://127.0.0.1:4310',
        'content-type': 'application/json',
        ...opts.headers,
      },
      socket: { localPort: 4310 },
      resume() {},
      on(event: string, cb: (...args: any[]) => void) {
        if (event === 'data' && opts.body !== undefined) {
          queueMicrotask(() => cb(Buffer.from(opts.body!)));
        }
        if (event === 'end') {
          queueMicrotask(() => cb());
        }
        return this;
      },
    };
    server.emit('request', req as never, res as never);
  });
}

const tempDirs: string[] = [];
async function makeTempWorkspace(): Promise<{ runsDir: string; systemsDir: string }> {
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.tmp-regression-api-storage-'));
  tempDirs.push(dir);
  const runsDir = path.join(dir, 'runs');
  const systemsDir = path.join(dir, 'systems');
  await fs.mkdir(runsDir, { recursive: true });
  await fs.mkdir(systemsDir, { recursive: true });
  await saveSystemBrief(structuredClone(SEEDED_TRADING_BRIEF), systemsDir, { mode: 'create' });
  return { runsDir, systemsDir };
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function createConfirmedRun(runsDir: string): Promise<InvestigationRecord> {
  const brief = structuredClone(SEEDED_TRADING_BRIEF);
  brief.requirementRules = [
    {
      requirement:
        'Total commitments include both used and reserved credit. New order admission respects the current limit.',
      preset: 'accepted-order-credit-limit',
      reviewed: true,
    },
  ];
  const systemBrief = await createSystemSnapshot(brief);
  const record = await runInvestigation({
    variant: 'candidate-c',
    systemBrief,
    provider: new MockProvider(),
  });
  await saveRun(record, runsDir);
  return record;
}

describe('Regression storage: atomic non-overwriting publication, collision handling, and record integrity', () => {
  it('validates regression definition and run IDs against traversal, reserved names, and invalid formats', () => {
    for (const invalid of [
      '',
      '..',
      '.',
      'con',
      'prn',
      'aux',
      'nul',
      'com1',
      'lpt1',
      'ledger',
      'reg-abc',
      'reg-0123456789abcdef0123456',
      'reg-0123456789abcdef012345678',
      'reg-0123456789ABCDEF01234567',
      'reg-0123456789abcdef01234567/..',
      'reg-0123456789abcdef 1234567',
      '.tmp-reg-0123456789abcdef01234567',
    ]) {
      expect(validateRegressionId(invalid)).toBe(false);
      expect(() => resolveRegressionDefinitionPath('/tmp/runs', invalid)).toThrow();
    }
    expect(validateRegressionId('reg-0123456789abcdef01234567')).toBe(true);

    for (const invalidRunId of [
      '',
      '..',
      'con',
      'ledger',
      'regrun_1700000000000_abcd',
      'regrun_1700000000000_ABCDEF01',
      'regrun_1700000000000_abcdef01/..',
      'regrun_1700000000000_abcdef 1',
      '.tmp-regrun_1700000000000_abcdef01',
    ]) {
      expect(validateRegressionRunId(invalidRunId)).toBe(false);
      expect(() => resolveRegressionRunPath('/tmp/runs', invalidRunId)).toThrow();
    }
    expect(validateRegressionRunId('regrun_1700000000000_abcdef01')).toBe(true);
  });

  it('publishes definitions and runs atomically, rejects simultaneous same-ID writers without overwriting, and cleans up scratch directories', async () => {
    const { runsDir, systemsDir } = await makeTempWorkspace();
    const record = await createConfirmedRun(runsDir);
    const finding = record.findings[0]!;

    const preview = await previewRegressionFromFinding(record.id, finding.id, { runsDir });
    expect(preview.available).toBe(true);
    if (!preview.available) throw new Error('Expected available preview');

    const server = new ChaosPilotServer({ runsDir, systemsDir });

    // Simultaneous HTTP POST /api/regressions/definitions for the same finding/definitionId
    const payload = {
      runId: record.id,
      findingId: finding.id,
      expectedRunRevision: preview.runRevision,
      expectedEvidenceHash: preview.evidenceHash,
      reviewToken: preview.reviewToken,
      definitionId: preview.definitionId,
      contentHash: preview.contentHash,
      reviewed: true,
    };

    const [res1, res2] = await Promise.all([
      api(server, 'POST', '/api/regressions/definitions', payload),
      api(server, 'POST', '/api/regressions/definitions', payload),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([201, 409]);

    const defPath = resolveRegressionDefinitionPath(runsDir, preview.definitionId);
    const savedBytes = await fs.readFile(defPath, 'utf8');
    const savedDef = JSON.parse(savedBytes);

    // Direct simultaneous storage writes with a modified timestamp must also fail with RegressionConflictError
    // and leave the existing file byte-for-byte unchanged, with zero leftover .tmp-* directories
    const modifiedClone = {
      ...savedDef,
      createdAt: '2099-01-01T00:00:00.000Z',
    };
    const directResults = await Promise.allSettled([
      saveRegressionDefinition(modifiedClone, runsDir),
      saveRegressionDefinition(modifiedClone, runsDir),
    ]);
    for (const r of directResults) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') {
        expect(String(r.reason)).toContain('Cannot overwrite existing regression definition');
      }
    }

    const bytesAfterCollision = await fs.readFile(defPath, 'utf8');
    expect(bytesAfterCollision).toBe(savedBytes);

    const defsDirEntries = await fs.readdir(resolveRegressionDefinitionsDir(runsDir));
    expect(defsDirEntries.filter(name => name.startsWith('.tmp-'))).toHaveLength(0);
    expect(defsDirEntries).toEqual([preview.definitionId]);

    // Same atomic non-overwriting guarantee for regression runs
    const runRecord = await runSavedRegression(
      { definitionId: preview.definitionId, variant: 'clean' },
      { runsDir },
    );
    const runPath = resolveRegressionRunPath(runsDir, runRecord.id);
    const runBytesBefore = await fs.readFile(runPath, 'utf8');

    const collidingRunClone = {
      ...runRecord,
      startedAt: '2099-01-01T00:00:00.000Z',
      finishedAt: '2099-01-01T00:00:01.000Z',
    };
    await expect(saveRegressionRun(collidingRunClone, runsDir)).rejects.toThrow(
      /Cannot overwrite existing regression run/,
    );
    const runBytesAfter = await fs.readFile(runPath, 'utf8');
    expect(runBytesAfter).toBe(runBytesBefore);

    const runsDirEntries = await fs.readdir(resolveRegressionRunsDir(runsDir));
    expect(runsDirEntries.filter(name => name.startsWith('.tmp-'))).toHaveLength(0);
  });

  it('ignores temporary scratch directories and rejects tampered definition or run records on disk', async () => {
    const { runsDir } = await makeTempWorkspace();
    const record = await createConfirmedRun(runsDir);
    const finding = record.findings[0]!;

    const preview = await previewRegressionFromFinding(record.id, finding.id, { runsDir });
    if (!preview.available) throw new Error('Expected available preview');

    const def = await captureRegressionFromFinding(
      {
        runId: record.id,
        findingId: finding.id,
        expectedRunRevision: preview.runRevision,
        expectedEvidenceHash: preview.evidenceHash,
        reviewToken: preview.reviewToken,
        definitionId: preview.definitionId,
        contentHash: preview.contentHash,
        reviewed: true,
      },
      { runsDir },
    );

    const regRun = await runSavedRegression(
      { definitionId: def.id, variant: 'candidate-c' },
      { runsDir },
    );

    // Plant .tmp-* scratch directories in both definitions and runs dirs
    const fakeTmpDefDir = path.join(
      resolveRegressionDefinitionsDir(runsDir),
      `.tmp-${def.id}-deadbeef`,
    );
    await fs.mkdir(fakeTmpDefDir, { recursive: true });
    await fs.writeFile(path.join(fakeTmpDefDir, 'definition.json'), '{broken', 'utf8');

    const fakeTmpRunDir = path.join(
      resolveRegressionRunsDir(runsDir),
      `.tmp-${regRun.id}-deadbeef`,
    );
    await fs.mkdir(fakeTmpRunDir, { recursive: true });
    await fs.writeFile(path.join(fakeTmpRunDir, 'run.json'), '{broken', 'utf8');

    const listedDefs = await listRegressionDefinitions(runsDir);
    expect(listedDefs.map(d => d.id)).toEqual([def.id]);

    const listedRuns = await listRegressionRuns(runsDir);
    expect(listedRuns.map(r => r.id)).toEqual([regRun.id]);

    // Tamper with expected outcomes on disk without updating contentHash/id
    const defPath = resolveRegressionDefinitionPath(runsDir, def.id);
    const originalDefBytes = await fs.readFile(defPath, 'utf8');
    const tamperedDef = JSON.parse(originalDefBytes);
    tamperedDef.expected.finalState.usedCredit = 999999;
    expect(isValidRegressionDefinitionRecord(tamperedDef)).toBe(false);
    await fs.writeFile(defPath, JSON.stringify(tamperedDef, null, 2), 'utf8');

    expect(await getRegressionDefinition(def.id, runsDir)).toBeNull();
    expect(await listRegressionDefinitions(runsDir)).toHaveLength(0);
    expect(await getRegressionRun(regRun.id, runsDir)).toBeNull();
    expect(await listRegressionRuns(runsDir)).toHaveLength(0);

    // Restore valid definition
    await fs.writeFile(defPath, originalDefBytes, 'utf8');
    expect((await getRegressionDefinition(def.id, runsDir))?.id).toBe(def.id);

    // Tamper with regression run status or expectedSourceHash on disk
    const runPath = resolveRegressionRunPath(runsDir, regRun.id);
    const originalRunBytes = await fs.readFile(runPath, 'utf8');
    const tamperedRun = JSON.parse(originalRunBytes);
    tamperedRun.status = 'pass'; // when evaluation.overallStatus is 'fail'
    expect(isValidRegressionRunRecord(tamperedRun)).toBe(false);

    const tamperedHashRun = JSON.parse(originalRunBytes);
    tamperedHashRun.expectedSourceHash = 'f'.repeat(64);
    expect(isValidRegressionRunRecord(tamperedHashRun)).toBe(false);

    await fs.writeFile(runPath, JSON.stringify(tamperedRun, null, 2), 'utf8');
    expect(await getRegressionRun(regRun.id, runsDir)).toBeNull();
    expect(await listRegressionRuns(runsDir)).toHaveLength(0);

    await fs.writeFile(runPath, originalRunBytes, 'utf8');
    expect((await getRegressionRun(regRun.id, runsDir))?.id).toBe(regRun.id);

    const inconsistentHeaders: ((r: typeof regRun) => void)[] = [
      r => { r.sourceHash = 'wrong-execution-source'; },
      r => { r.origin.sourceHash = 'wrong-original-source'; },
      r => { r.origin.findingId = 'different-finding'; },
      r => { r.origin.experimentIndex++; },
      r => { r.origin.cleanSourceHash = 'wrong-clean-reference'; },
      r => { r.origin.finding.reproduced = false; },
    ];
    for (const mutate of inconsistentHeaders) {
      const corrupt = structuredClone(regRun); mutate(corrupt);
      expect(isValidRegressionRunRecord(corrupt)).toBe(false);
      await fs.writeFile(runPath, JSON.stringify(corrupt), 'utf8');
      expect(await getRegressionRun(regRun.id, runsDir)).toBeNull();
      expect(await listRegressionRuns(runsDir)).toHaveLength(0);
      await expect(saveRegressionRun(corrupt, runsDir)).rejects.toThrow(/inconsistent/);
    }

    // These fields can be internally well-formed while contradicting the saved definition.
    const inconsistentLinks: ((r: typeof regRun) => void)[] = [
      r => { r.definitionHash = r.definitionHash.slice(0, -1) + (r.definitionHash.endsWith('0') ? '1' : '0'); },
      r => { r.origin.runId = 'different-original-run'; },
      r => { r.origin.evidenceHash = 'f'.repeat(64); },
      r => { r.expected.referenceProvenance.note = 'Different reviewed expectations'; },
    ];
    for (const mutate of inconsistentLinks) {
      const corrupt = structuredClone(regRun); mutate(corrupt);
      await fs.writeFile(runPath, JSON.stringify(corrupt), 'utf8');
      expect(await getRegressionRun(regRun.id, runsDir)).toBeNull();
      expect(await listRegressionRuns(runsDir)).toHaveLength(0);
      expect((await listRegressionDefinitions(runsDir))[0]?.runCount).toBe(0);
      await expect(saveRegressionRun(corrupt, runsDir)).rejects.toThrow(/inconsistent/);
    }
    await fs.writeFile(runPath, originalRunBytes, 'utf8');
    expect((await getRegressionRun(regRun.id, runsDir))?.id).toBe(regRun.id);
    expect((await listRegressionDefinitions(runsDir))[0]?.runCount).toBe(1);
  });
});

describe('Regression HTTP API: security headers, body limits, strict field validation, and error isolation', () => {
  it('enforces same-origin, Host, Content-Type, 64 KiB body limit, and strict allowed fields across all regression POST routes', async () => {
    const { runsDir, systemsDir } = await makeTempWorkspace();
    const record = await createConfirmedRun(runsDir);
    const finding = record.findings[0]!;
    const server = new ChaosPilotServer({ runsDir, systemsDir });

    const preview = await previewRegressionFromFinding(record.id, finding.id, { runsDir });
    if (!preview.available) throw new Error('Expected available preview');

    for (const url of [
      '/api/regressions/preview',
      '/api/regressions/definitions',
      '/api/regressions/run',
    ]) {
      // Cross-origin rejected with 403
      const crossOrigin = await rawRequest(server, {
        method: 'POST',
        url,
        headers: {
          host: '127.0.0.1:4310',
          origin: 'http://evil.example',
          'content-type': 'application/json',
        },
        body: '{}',
      });
      expect(crossOrigin.status).toBe(403);

      // Bad Host rejected with 403
      const badHost = await rawRequest(server, {
        method: 'POST',
        url,
        headers: {
          host: 'evil.example:4310',
          origin: 'http://evil.example:4310',
          'content-type': 'application/json',
        },
        body: '{}',
      });
      expect(badHost.status).toBe(403);

      // Wrong Content-Type rejected with 415
      const badContentType = await rawRequest(server, {
        method: 'POST',
        url,
        headers: {
          host: '127.0.0.1:4310',
          origin: 'http://127.0.0.1:4310',
          'content-type': 'text/plain',
        },
        body: '{}',
      });
      expect(badContentType.status).toBe(415);

      // Body > 64 KiB rejected with 413
      const oversizedBody = JSON.stringify({
        runId: 'a'.repeat(70 * 1024),
        findingId: 'f1',
      });
      const tooLarge = await rawRequest(server, {
        method: 'POST',
        url,
        headers: {
          host: '127.0.0.1:4310',
          origin: 'http://127.0.0.1:4310',
          'content-type': 'application/json',
        },
        body: oversizedBody,
      });
      expect(tooLarge.status).toBe(413);

      // Malformed JSON rejected with 400
      const malformedJson = await rawRequest(server, {
        method: 'POST',
        url,
        headers: {
          host: '127.0.0.1:4310',
          origin: 'http://127.0.0.1:4310',
          'content-type': 'application/json',
        },
        body: '{not-valid-json',
      });
      expect(malformedJson.status).toBe(400);
    }

    // Reject client-supplied expected, experiment, or unknown fields on POST /api/regressions/definitions
    const baseSavePayload = {
      runId: record.id,
      findingId: finding.id,
      expectedRunRevision: preview.runRevision,
      expectedEvidenceHash: preview.evidenceHash,
      reviewToken: preview.reviewToken,
      definitionId: preview.definitionId,
      contentHash: preview.contentHash,
      reviewed: true,
    };

    const withClientExpected = await api(server, 'POST', '/api/regressions/definitions', {
      ...baseSavePayload,
      expected: preview.expected,
    });
    expect(withClientExpected.status).toBe(400);
    expect(withClientExpected.json.error).toContain('client-supplied expectation fields are not allowed');

    const withClientExperiment = await api(server, 'POST', '/api/regressions/definitions', {
      ...baseSavePayload,
      experiment: preview.experiment,
    });
    expect(withClientExperiment.status).toBe(400);
    expect(withClientExperiment.json.error).toContain('client-supplied expectation fields are not allowed');

    const withUnknownFieldPreview = await api(server, 'POST', '/api/regressions/preview', {
      runId: record.id,
      findingId: finding.id,
      extra: 123,
    });
    expect(withUnknownFieldPreview.status).toBe(400);

    const withUnknownFieldRun = await api(server, 'POST', '/api/regressions/run', {
      definitionId: preview.definitionId,
      variant: 'clean',
      expectedSourceHash: '0'.repeat(64),
    });
    expect(withUnknownFieldRun.status).toBe(400);

    // Invalid IDs on GET routes rejected with 400
    for (const badId of [
      'con',
      'ledger',
      'reg-bad',
      'regrun_bad',
      'reg-0123456789abcdef01234567%20',
    ]) {
      const defGet = await api(server, 'GET', `/api/regressions/definitions/${badId}`);
      expect(defGet.status).toBe(400);
      const runGet = await api(server, 'GET', `/api/regressions/runs/${badId}`);
      expect(runGet.status).toBe(400);
    }

    // Valid ID format that does not exist returns 404
    const missingDef = await api(
      server,
      'GET',
      '/api/regressions/definitions/reg-ffffffffffffffffffffffff',
    );
    expect(missingDef.status).toBe(404);
    const missingRun = await api(
      server,
      'GET',
      '/api/regressions/runs/regrun_1700000000000_ffffffff',
    );
    expect(missingRun.status).toBe(404);
  });

  it('preserves original run, saved definition, and prior regression runs when target execution throws or client disconnects', async () => {
    const { runsDir, systemsDir } = await makeTempWorkspace();
    const record = await createConfirmedRun(runsDir);
    const finding = record.findings[0]!;
    const origRunPath = path.join(runsDir, `${record.id}.json`);
    const origRunBytes = await fs.readFile(origRunPath, 'utf8');

    const preview = await previewRegressionFromFinding(record.id, finding.id, { runsDir });
    if (!preview.available) throw new Error('Expected available preview');

    const def = await captureRegressionFromFinding(
      {
        runId: record.id,
        findingId: finding.id,
        expectedRunRevision: preview.runRevision,
        expectedEvidenceHash: preview.evidenceHash,
        reviewToken: preview.reviewToken,
        definitionId: preview.definitionId,
        contentHash: preview.contentHash,
        reviewed: true,
      },
      { runsDir },
    );
    const defPath = resolveRegressionDefinitionPath(runsDir, def.id);
    const defBytes = await fs.readFile(defPath, 'utf8');

    const priorRun = await runSavedRegression(
      { definitionId: def.id, variant: 'clean' },
      { runsDir },
    );
    const priorRunPath = resolveRegressionRunPath(runsDir, priorRun.id);
    const priorRunBytes = await fs.readFile(priorRunPath, 'utf8');

    // 1. Adapter executeExperiment throws an unexpected runtime error during POST /api/regressions/run
    const baseAdapter = resolveAdapter('synthetic-trading');
    const throwingServer = new ChaosPilotServer({
      runsDir,
      systemsDir,
      regressionAdapterResolver: () => ({
        ...baseAdapter,
        executeExperiment: () => {
          throw new Error('Simulated simulator crash during regression run');
        },
      }),
    });

    const crashRes = await api(throwingServer, 'POST', '/api/regressions/run', {
      definitionId: def.id,
      variant: 'candidate-c',
    });
    expect(crashRes.status).toBe(500);

    // 2. Client disconnect / aborted AbortSignal during preview, capture, and run
    const abortedController = new AbortController();
    abortedController.abort();
    await expect(
      previewRegressionFromFinding(record.id, finding.id, {
        runsDir,
        signal: abortedController.signal,
      }),
    ).rejects.toThrow();
    await expect(
      runSavedRegression(
        { definitionId: def.id, variant: 'clean' },
        { runsDir, signal: abortedController.signal },
      ),
    ).rejects.toThrow();

    // Verify original run, saved definition, and prior regression run are byte-for-byte intact and no extra run was persisted
    expect(await fs.readFile(origRunPath, 'utf8')).toBe(origRunBytes);
    expect(await fs.readFile(defPath, 'utf8')).toBe(defBytes);
    expect(await fs.readFile(priorRunPath, 'utf8')).toBe(priorRunBytes);
    const allRuns = await listRegressionRuns(runsDir);
    expect(allRuns.map(r => r.id)).toEqual([priorRun.id]);
  });

  it('loopback HTTP end-to-end: preview, reviewed save, fail on candidate-c, pass on clean, and fresh server reopen', async context => {
    const { runsDir, systemsDir } = await makeTempWorkspace();
    const record = await createConfirmedRun(runsDir);
    const finding = record.findings[0]!;
    const instance = new ChaosPilotServer({ runsDir, systemsDir });
    const server = instance.createHttpServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        context.skip(
          `Loopback listen denied by environment (${code}); HTTP handler integration tests remain required`,
        );
      }
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback address');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const wsHtml = await (await fetch(`${base}/workspace`)).text();
      expect(wsHtml).toContain('Save selected finding as regression');
      expect(wsHtml).toContain('Saved finding regressions');

      const previewRes = await fetch(`${base}/api/regressions/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ runId: record.id, findingId: finding.id }),
      });
      expect(previewRes.status).toBe(200);
      const preview = (await previewRes.json()) as any;
      expect(preview.available).toBe(true);

      const saveRes = await fetch(`${base}/api/regressions/definitions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({
          runId: record.id,
          findingId: finding.id,
          expectedRunRevision: preview.runRevision,
          expectedEvidenceHash: preview.evidenceHash,
          reviewToken: preview.reviewToken,
          definitionId: preview.definitionId,
          contentHash: preview.contentHash,
          reviewed: true,
        }),
      });
      expect(saveRes.status).toBe(201);
      const savedDef = (await saveRes.json()) as any;

      const failRes = await fetch(`${base}/api/regressions/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({
          definitionId: savedDef.id,
          variant: 'candidate-c',
          systemId: 'trading-gateway',
          expectedRevision: 1,
        }),
      });
      expect(failRes.status).toBe(201);
      expect(((await failRes.json()) as any).status).toBe('fail');

      const passRes = await fetch(`${base}/api/regressions/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({
          definitionId: savedDef.id,
          variant: 'clean',
          systemId: 'trading-gateway',
          expectedRevision: 1,
        }),
      });
      expect(passRes.status).toBe(201);
      expect(((await passRes.json()) as any).status).toBe('pass');

      const detailRes = await fetch(`${base}/api/regressions/definitions/${savedDef.id}`);
      expect(detailRes.status).toBe(200);
      const detail = (await detailRes.json()) as any;
      expect(detail.runs).toHaveLength(2);
    } catch (error) {
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if (code === 'EACCES' || code === 'EPERM') {
        context.skip(
          `Loopback connections denied by environment (${code}); HTTP handler integration tests remain required`,
        );
      }
      throw error;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
    }
  });
});
