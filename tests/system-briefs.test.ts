import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const lockFaults = vi.hoisted(() => ({
  failWrites: 0,
  partialWrite: false,
  failCloses: 0,
  failUnlinks: 0,
  failReads: 0,
  unlinkAttempts: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const isLockPath = (p: unknown): boolean =>
    typeof p === 'string' && p.includes('.locks') && p.endsWith('.lock');
  const injected = (msg: string, code: string) => Object.assign(new Error(msg), { code });
  return {
    ...actual,
    open: async (...args: unknown[]) => {
      const handle = await (actual.open as (...a: unknown[]) => Promise<unknown>)(...args);
      if (!isLockPath(args[0])) return handle;
      const real = handle as { writeFile: (d: unknown, e?: unknown) => Promise<void>; close: () => Promise<void> };
      return {
        writeFile: async (data: unknown, enc?: unknown) => {
          if (lockFaults.failWrites > 0) {
            lockFaults.failWrites--;
            if (lockFaults.partialWrite && typeof data === 'string') {
              await real.writeFile(data.slice(0, 4), enc);
            }
            throw injected('injected token write failure: no space left on device', 'ENOSPC');
          }
          return real.writeFile(data, enc);
        },
        close: async () => {
          if (lockFaults.failCloses > 0) {
            lockFaults.failCloses--;
            await real.close();
            throw injected('injected handle close failure', 'EIO');
          }
          return real.close();
        },
      };
    },
    unlink: async (...args: unknown[]) => {
      if (isLockPath(args[0])) {
        lockFaults.unlinkAttempts++;
        if (lockFaults.failUnlinks > 0) {
          lockFaults.failUnlinks--;
          throw injected('injected unlink failure: permission denied', 'EPERM');
        }
      }
      return (actual.unlink as (...a: unknown[]) => Promise<void>)(...args);
    },
    readFile: async (...args: unknown[]) => {
      if (isLockPath(args[0]) && lockFaults.failReads > 0) {
        lockFaults.failReads--;
        throw injected('injected lock read failure: permission denied', 'EPERM');
      }
      return (actual.readFile as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  };
});

function resetLockFaults(): void {
  lockFaults.failWrites = 0;
  lockFaults.partialWrite = false;
  lockFaults.failCloses = 0;
  lockFaults.failUnlinks = 0;
  lockFaults.failReads = 0;
  lockFaults.unlinkAttempts = 0;
}
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { ChaosPilotServer } from '../src/server.ts';
import { runInvestigation } from '../src/investigation/index.ts';
import {
  SEEDED_TRADING_BRIEF,
  validateSystemId,
  validateSystemBrief,
  computeSnapshotHash,
  resolveSystemPath,
  ensureSeededSystem,
  getSystemBrief,
  listSystemBriefs,
  saveSystemBrief,
  createSystemBrief,
  updateSystemBrief,
  createSystemSnapshot,
  withSystemLock,
  SystemIntegrityError,
  SystemConflictError,
  SystemNotFoundError,
  SystemRevisionConflictError,
  SystemLockTimeoutError,
  SystemLockReleaseError,
} from '../src/systems/index.ts';
import {
  saveRun,
  getRun,
  isValidInvestigationRecord,
} from '../src/storage.ts';
import { buildInvestigationPrompt, PROMPT_VERSION } from '../src/investigation/prompt.ts';
import { getContract } from '../src/simulator/contract.ts';
import type {
  SystemBrief,
  SystemBriefSnapshot,
  InvestigationRecord,
  ExperimentProvider,
  ProviderContext,
} from '../src/domain.ts';

describe('System Briefs & Requirements Specification', () => {
  let tmpDir: string;
  let tmpRunsDir: string;
  let tmpSystemsDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chaospilot-system-test-'));
    tmpRunsDir = path.join(tmpDir, 'runs');
    tmpSystemsDir = path.join(tmpRunsDir, 'systems');
    await fs.mkdir(tmpSystemsDir, { recursive: true });
  });

  afterEach(async () => {
    resetLockFaults();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('Invariant: Saved user context and executable checks are distinguishable and immutable per run', () => {
    it('case: seeded requirements visible', async () => {
      // 1. Seeded brief has valid structure
      const seeded = await ensureSeededSystem(tmpSystemsDir);
      expect(seeded.id).toBe('trading-gateway');
      expect(seeded.revision).toBe(1);
      expect(seeded.name).toBe('ChaosPilot Trading Gateway');
      expect(seeded.adapterId).toBe('synthetic-trading');
      expect(seeded.requirements.length).toBeGreaterThanOrEqual(5);

      // 2. Executable simulator contract invariants are distinct from supplementary business requirements
      const contract = getContract();
      expect(contract.invariants.length).toBe(10);
      const invariantIds = contract.invariants.map(inv => inv.id);
      expect(invariantIds).toContain('credit_non_negative');
      expect(invariantIds).toContain('credit_limit_respected');
      expect(invariantIds).toContain('order_quantity_conservation');
      expect(invariantIds).toContain('execution_idempotency');

      // 3. Brief requirements are supplementary business context, not invariant IDs
      for (const req of seeded.requirements) {
        expect(invariantIds).not.toContain(req);
      }

      // 4. Listing systems loads the seeded profile
      const list = await listSystemBriefs(tmpSystemsDir);
      expect(list.some(s => s.id === 'trading-gateway')).toBe(true);
    });

    it('case: edited extra prose not automatically checked', async () => {
      // Author custom supplementary requirement prose
      const customBrief: SystemBrief = {
        schemaVersion: 1,
        id: 'compliance-profile',
        revision: 1,
        name: 'Compliance Trading System',
        overview: 'Gateway with extra regulatory constraints',
        requirements: [
          'Orders above 50,000 quantity must send real-time alert to audit channel',
          'Trades occurring outside business hours must be escalated to risk officer',
        ],
        adapterId: 'synthetic-trading',
        updatedAt: new Date().toISOString(),
      };

      const snapshot = await createSystemSnapshot(customBrief);
      expect(snapshot.contract).toBeDefined();

      // Oracle invariants inside snapshot.contract remain the unchanged simulator invariants
      expect(snapshot.contract!.invariants.length).toBe(10);
      const invariantIds = snapshot.contract!.invariants.map(i => i.id);
      expect(invariantIds).not.toContain('Orders above 50,000 quantity must send real-time alert to audit channel');

      // Verify prompt construction: prompt explicitly notes supplementary requirements remain unverified context
      const mockContext: ProviderContext = {
        contract: snapshot.contract!,
        source: { hash: 'test-hash', files: [{ path: 'order-engine.ts', content: 'code' }] },
        history: [],
        experimentNumber: 1,
        maxExperiments: 5,
        systemBrief: snapshot,
      };

      const prompt = buildInvestigationPrompt(mockContext);
      expect(prompt.userMessage).toContain('USER SYSTEM BRIEF & REQUIREMENTS:');
      expect(prompt.userMessage).toContain('Compliance Trading System');
      expect(prompt.userMessage).toContain('Orders above 50,000 quantity must send real-time alert to audit channel');
      expect(prompt.userMessage).toContain(
        'Note: Supplementary business requirements without executable checks remain unverified context and do not alter the deterministic contract invariants.'
      );
      expect(PROMPT_VERSION).toBe('3.1');
    });

    it('case: running snapshot after concurrent edit', async () => {
      // Seed initial profile
      const initialBrief = await ensureSeededSystem(tmpSystemsDir);
      const snapshotRev1 = await createSystemSnapshot(initialBrief);
      const initialHash = snapshotRev1.hash;

      let providerCalled = false;
      let resumeProvider!: () => void;
      const providerPaused = new Promise<void>(resolve => {
        resumeProvider = resolve;
      });

      const slowProvider: ExperimentProvider = {
        kind: 'mock',
        model: 'slow-test',
        propose: async () => {
          providerCalled = true;
          // Wait for concurrent edit to happen on disk
          await providerPaused;
          return {
            experiment: null,
            usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.0001 },
            summary: 'Complete',
          };
        },
      };

      // Launch investigation with Rev 1 snapshot
      const investigationPromise = runInvestigation({
        id: 'inv-concurrent-test',
        variant: 'candidate-a',
        maxExperiments: 1,
        provider: slowProvider,
        systemBrief: structuredClone(snapshotRev1),
      });

      // Poll until provider has started
      while (!providerCalled) {
        await new Promise(r => setTimeout(r, 10));
      }

      // Concurrently edit the brief on disk to Revision 2 with completely different text
      const updatedBrief = await saveSystemBrief(
        {
          ...initialBrief,
          name: 'MUTATED ChaosPilot Trading Gateway Rev 2',
          overview: 'Overwritten concurrently during investigation',
          requirements: ['New requirement added mid-run'],
        },
        tmpSystemsDir
      );
      expect(updatedBrief.revision).toBe(2);

      // Verify on-disk file now has Revision 2
      const onDisk = await getSystemBrief(initialBrief.id, tmpSystemsDir);
      expect(onDisk?.revision).toBe(2);
      expect(onDisk?.name).toBe('MUTATED ChaosPilot Trading Gateway Rev 2');

      // Now resume provider to finish investigation
      resumeProvider();
      const completedRecord = await investigationPromise;

      // Assert: Completed record strictly retains Revision 1 snapshot and original hash
      expect(completedRecord.systemBrief).toBeDefined();
      expect(completedRecord.systemBrief!.brief.revision).toBe(1);
      expect(completedRecord.systemBrief!.brief.name).toBe('ChaosPilot Trading Gateway');
      expect(completedRecord.systemBrief!.hash).toBe(initialHash);
      expect(completedRecord.systemBrief!.brief.overview).toBe(initialBrief.overview);

      // Save the record and read it back from storage
      await saveRun(completedRecord, tmpRunsDir);
      const retrieved = await getRun(completedRecord.id, tmpRunsDir);
      expect(retrieved?.systemBrief).toBeDefined();
      expect(retrieved!.systemBrief!.brief.revision).toBe(1);
      expect(retrieved!.systemBrief!.brief.name).toBe('ChaosPilot Trading Gateway');
      expect(retrieved!.systemBrief!.hash).toBe(initialHash);
    });

    it('case: saved older revision', async () => {
      const briefRev1 = await ensureSeededSystem(tmpSystemsDir);
      const snapshotRev1 = await createSystemSnapshot(briefRev1);

      // Run 1 uses Rev 1
      const record1: InvestigationRecord = {
        schemaVersion: 1,
        id: 'run-revision-1',
        provider: 'mock',
        model: 'mock',
        mode: 'mock',
        variant: 'candidate-a',
        status: 'completed',
        startedAt: new Date(Date.now() - 10000).toISOString(),
        finishedAt: new Date().toISOString(),
        sourceHash: 'source-1',
        experiments: [],
        findings: [],
        usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        errors: [],
        contextAudit: { sourcePaths: [], contractHash: 'c1', promptVersion: '3.0' },
        systemBrief: structuredClone(snapshotRev1),
      };
      await saveRun(record1, tmpRunsDir);

      // Update system to Rev 2 and then Rev 3
      const briefRev2 = await saveSystemBrief(
        { ...briefRev1, name: 'Rev 2 Gateway' },
        tmpSystemsDir
      );
      const briefRev3 = await saveSystemBrief(
        { ...briefRev2, name: 'Rev 3 Gateway' },
        tmpSystemsDir
      );
      expect(briefRev3.revision).toBe(3);

      const snapshotRev3 = await createSystemSnapshot(briefRev3);

      // Run 2 uses Rev 3
      const record2: InvestigationRecord = {
        ...record1,
        id: 'run-revision-3',
        systemBrief: structuredClone(snapshotRev3),
      };
      await saveRun(record2, tmpRunsDir);

      // Both runs maintain their distinct, immutable revisions
      const fetched1 = await getRun('run-revision-1', tmpRunsDir);
      const fetched2 = await getRun('run-revision-3', tmpRunsDir);

      expect(fetched1?.systemBrief?.brief.revision).toBe(1);
      expect(fetched1?.systemBrief?.brief.name).toBe('ChaosPilot Trading Gateway');

      expect(fetched2?.systemBrief?.brief.revision).toBe(3);
      expect(fetched2?.systemBrief?.brief.name).toBe('Rev 3 Gateway');
      expect(fetched1?.systemBrief?.hash).not.toBe(fetched2?.systemBrief?.hash);
    });

    it('case: legacy missing snapshot', async () => {
      // Construct a legacy run without systemBrief
      const legacyRecord: InvestigationRecord = {
        schemaVersion: 1,
        id: 'run-legacy-without-snapshot',
        provider: 'mock',
        model: 'mock',
        mode: 'mock',
        variant: 'clean',
        status: 'completed',
        startedAt: new Date().toISOString(),
        sourceHash: 'legacy-source',
        experiments: [],
        findings: [],
        usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        errors: [],
        contextAudit: { sourcePaths: [], contractHash: 'hash', promptVersion: '2.0' },
      };

      expect(isValidInvestigationRecord(legacyRecord)).toBe(true);
      await saveRun(legacyRecord, tmpRunsDir);

      const fetched = await getRun('run-legacy-without-snapshot', tmpRunsDir);
      expect(fetched).not.toBeNull();
      expect(fetched?.systemBrief).toBeUndefined();

      // Direct runner call without systemBrief remains backward compatible
      const directRecord = await runInvestigation({
        id: 'direct-run',
        variant: 'clean',
        maxExperiments: 1,
        provider: {
          kind: 'mock',
          model: 'mock',
          propose: async () => ({
            experiment: null,
            usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
          }),
        },
      });
      expect(directRecord.systemBrief).toBeUndefined();
    });

    it('case: contract mismatch', async () => {
      const brief = await ensureSeededSystem(tmpSystemsDir);
      const snapshot = await createSystemSnapshot(brief);

      // Tamper with snapshot contract and compute its hash to isolate contract-correspondence check
      const tamperedContract = {
        ...snapshot.contract!,
        name: 'Tampered Contract With Altered Limits',
        limits: { maxExposure: 9999999 },
      };
      const tamperedSnapshot: SystemBriefSnapshot = {
        ...snapshot,
        contract: tamperedContract,
        hash: computeSnapshotHash(snapshot.brief, tamperedContract),
      };

      await expect(
        runInvestigation({
          id: 'test-mismatch',
          variant: 'candidate-a',
          maxExperiments: 1,
          provider: {
            kind: 'mock',
            model: 'mock',
            propose: async () => ({
              experiment: null,
              usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
            }),
          },
          systemBrief: tamperedSnapshot,
        })
      ).rejects.toThrow(/System brief contract does not match executing simulator contract/);
    });
  });

  describe('Invariant: Profile revision is a serialized compare-and-swap across all write transitions', () => {
    it('case: simultaneous updates', async () => {
      await ensureSeededSystem(tmpSystemsDir);

      const updateA = {
        ...SEEDED_TRADING_BRIEF,
        name: 'Update Branch Alpha',
        overview: 'Overview from worker Alpha',
      };
      const updateB = {
        ...SEEDED_TRADING_BRIEF,
        name: 'Update Branch Beta',
        overview: 'Overview from worker Beta',
      };

      // Both workers start at expectedRevision: 1
      const results = await Promise.allSettled([
        saveSystemBrief(updateA, tmpSystemsDir, { expectedRevision: 1 }),
        saveSystemBrief(updateB, tmpSystemsDir, { expectedRevision: 1 }),
      ]);

      const fulfilled = results.filter((r): r is PromiseFulfilledResult<SystemBrief> => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

      // Exactly ONE must succeed and ONE must reject with revision conflict
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      expect(fulfilled[0]!.value.revision).toBe(2);
      expect(rejected[0]!.reason.message).toMatch(/Revision conflict/i);

      // Disk state must be clean Revision 2
      const onDisk = await getSystemBrief('trading-gateway', tmpSystemsDir);
      expect(onDisk?.revision).toBe(2);
      expect(onDisk?.name).toBe(fulfilled[0]!.value.name);
    });

    it('case: simultaneous creates', async () => {
      const payloadA: SystemBrief = {
        schemaVersion: 1,
        id: 'pool-arbitrage',
        revision: 1,
        name: 'Pool Arbitrage Profile A',
        overview: 'First author attempt',
        requirements: ['Verify balance'],
        adapterId: 'synthetic-trading',
        updatedAt: new Date().toISOString(),
      };
      const payloadB: SystemBrief = {
        ...payloadA,
        name: 'Pool Arbitrage Profile B',
        overview: 'Second concurrent author attempt',
      };

      const results = await Promise.allSettled([
        createSystemBrief(payloadA, tmpSystemsDir),
        createSystemBrief(payloadB, tmpSystemsDir),
      ]);

      const fulfilled = results.filter((r): r is PromiseFulfilledResult<SystemBrief> => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

      // Exactly ONE creation succeeds and ONE is rejected with conflict
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      expect(fulfilled[0]!.value.id).toBe('pool-arbitrage');
      expect(fulfilled[0]!.value.revision).toBe(1);
      expect(rejected[0]!.reason).toBeInstanceOf(SystemConflictError);

      const onDisk = await getSystemBrief('pool-arbitrage', tmpSystemsDir);
      expect(onDisk?.name).toBe(fulfilled[0]!.value.name);
    });

    it('case: seed/update interleave', async () => {
      // 1. Seed gateway
      const initial = await ensureSeededSystem(tmpSystemsDir);
      expect(initial.revision).toBe(1);

      // 2. User updates gateway to revision 2
      const updated = await saveSystemBrief(
        { ...initial, name: 'User Customized Gateway Name' },
        tmpSystemsDir
      );
      expect(updated.revision).toBe(2);

      // 3. ensureSeededSystem called again must NOT overwrite or revert user update
      const reseeded = await ensureSeededSystem(tmpSystemsDir);
      expect(reseeded.revision).toBe(2);
      expect(reseeded.name).toBe('User Customized Gateway Name');

      // 4. Concurrently run ensureSeededSystem and an update to revision 3
      const [resSeed, resUpdate] = await Promise.all([
        ensureSeededSystem(tmpSystemsDir),
        saveSystemBrief(
          { ...reseeded, name: 'User Revision 3 Gateway' },
          tmpSystemsDir,
          { expectedRevision: 2 }
        ),
      ]);

      expect(resUpdate.revision).toBe(3);
      expect([2, 3]).toContain(resSeed.revision);

      const finalDisk = await getSystemBrief('trading-gateway', tmpSystemsDir);
      expect(finalDisk?.revision).toBe(3);
      expect(finalDisk?.name).toBe('User Revision 3 Gateway');
    });

    it('case: missing update', async () => {
      const ghostPayload: SystemBrief = {
        schemaVersion: 1,
        id: 'non-existent-system',
        revision: 1,
        name: 'Ghost System',
        overview: 'Does not exist on disk',
        requirements: ['None'],
        adapterId: 'synthetic-trading',
        updatedAt: new Date().toISOString(),
      };

      await expect(
        updateSystemBrief(ghostPayload, tmpSystemsDir)
      ).rejects.toThrow(SystemNotFoundError);

      // Verify no file was created
      const exists = await getSystemBrief('non-existent-system', tmpSystemsDir);
      expect(exists).toBeNull();
    });

    it('case: duplicate create', async () => {
      await ensureSeededSystem(tmpSystemsDir);

      const duplicatePayload = {
        ...SEEDED_TRADING_BRIEF,
        name: 'Duplicate Attempt',
      };

      await expect(
        createSystemBrief(duplicatePayload, tmpSystemsDir)
      ).rejects.toThrow(SystemConflictError);

      const onDisk = await getSystemBrief('trading-gateway', tmpSystemsDir);
      expect(onDisk?.name).toBe('ChaosPilot Trading Gateway');
    });

    it('case: lock contention', async () => {
      let lockAcquired!: () => void;
      const lockAcquiredPromise = new Promise<void>(resolve => {
        lockAcquired = resolve;
      });
      let releaseLock!: () => void;
      const lockHeldPromise = new Promise<void>(resolve => {
        releaseLock = resolve;
      });

      const lockHolder = withSystemLock(tmpSystemsDir, 'trading-gateway', async () => {
        lockAcquired();
        await lockHeldPromise;
      });

      try {
        await lockAcquiredPromise;

        // While lock is actively held, a second call with a short timeout must reject with SystemLockTimeoutError
        await expect(
          withSystemLock(
            tmpSystemsDir,
            'trading-gateway',
            async () => 'never executed',
            100 // 100ms timeout
          )
        ).rejects.toThrow(SystemLockTimeoutError);
      } finally {
        releaseLock();
        await lockHolder;
      }
    });

    it('case: subprocess cannot enter a lock held by another process', async () => {
      await ensureSeededSystem(tmpSystemsDir);
      const script = `
        import { withSystemLock, SystemLockTimeoutError } from './src/systems/index.ts';
        try {
          await withSystemLock(${JSON.stringify(tmpSystemsDir)}, 'trading-gateway', async () => {}, 100);
          process.stdout.write(JSON.stringify({ entered: true }));
        } catch (error) {
          if (!(error instanceof SystemLockTimeoutError)) throw error;
          process.stdout.write(JSON.stringify({ entered: false, timedOut: true }));
        }
      `;

      // Hold the lock for the child's entire lifetime: the processes must overlap.
      const result = await withSystemLock(tmpSystemsDir, 'trading-gateway', () =>
        new Promise<{ entered: boolean; timedOut?: boolean }>((resolve, reject) => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', chunk => { stdout += chunk.toString(); });
          child.stderr.on('data', chunk => { stderr += chunk.toString(); });
          child.on('error', reject);
          child.on('close', code => {
            if (code !== 0) {
              reject(new Error(`Lock contender exited ${code}: ${stderr}`));
              return;
            }
            try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
          });
        })
      );
      expect(result).toEqual({ entered: false, timedOut: true });
      // The contender did not steal or remove the parent's lock; normal writes resume after release.
      const saved = await saveSystemBrief({ ...SEEDED_TRADING_BRIEF, name: 'After contention' }, tmpSystemsDir);
      expect(saved.revision).toBe(2);
    });

    it('case: subprocess cross-process write race', async () => {
      await ensureSeededSystem(tmpSystemsDir);

      const script = `
        import { saveSystemBrief } from './src/systems/index.ts';
        try {
          const res = await saveSystemBrief(
            {
              schemaVersion: 1,
              id: 'trading-gateway',
              revision: 1,
              name: 'Subprocess Worker Update',
              overview: 'Written by child process',
              requirements: ['Child requirement'],
              adapterId: 'synthetic-trading',
              updatedAt: new Date().toISOString(),
            },
            ${JSON.stringify(tmpSystemsDir)},
            { expectedRevision: 1 }
          );
          process.stdout.write(JSON.stringify({ ok: true, revision: res.revision }));
        } catch (err) {
          process.stdout.write(JSON.stringify({ ok: false, error: err.message }));
        }
      `;

      // Spawn child process and concurrently run saveSystemBrief in parent process
      const childPromise = new Promise<{ ok: boolean; revision?: number; error?: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        let stdout = '';
        child.stdout.on('data', chunk => {
          stdout += chunk.toString();
        });
        child.on('close', code => {
          if (code !== 0 && !stdout) {
            reject(new Error(`Child exited with code ${code}`));
          } else {
            try {
              resolve(JSON.parse(stdout));
            } catch (e) {
              reject(new Error(`Failed to parse child output: ${stdout}`));
            }
          }
        });
      });

      const parentPromise = saveSystemBrief(
        {
          ...SEEDED_TRADING_BRIEF,
          name: 'Parent Worker Update',
          overview: 'Written by parent process',
        },
        tmpSystemsDir,
        { expectedRevision: 1 }
      ).then(
        res => ({ ok: true as const, revision: res.revision }),
        err => ({ ok: false as const, error: err.message })
      );

      const [childRes, parentRes] = await Promise.all([childPromise, parentPromise]);

      // Cross-process serialization invariant:
      // Exactly one succeeds with revision 2, and the other fails with Revision conflict
      const successes = [childRes, parentRes].filter(r => r.ok);
      const conflicts = [childRes, parentRes].filter(r => !r.ok);

      expect(successes).toHaveLength(1);
      expect(conflicts).toHaveLength(1);
      expect(successes[0]!.revision).toBe(2);
      expect(conflicts[0]!.error).toMatch(/Revision conflict/i);

      // Verify file on disk is valid Revision 2 and not corrupted
      const diskBrief = await getSystemBrief('trading-gateway', tmpSystemsDir);
      expect(diskBrief?.revision).toBe(2);
    });

    it('case: revision overflow', async () => {
      // Create a profile with revision = Number.MAX_SAFE_INTEGER
      const maxBrief: SystemBrief = {
        schemaVersion: 1,
        id: 'overflow-test',
        revision: Number.MAX_SAFE_INTEGER,
        name: 'Overflow Test Brief',
        overview: 'Brief at maximum integer revision',
        requirements: ['Overflow protection check'],
        adapterId: 'synthetic-trading',
        updatedAt: new Date().toISOString(),
      };

      const finalPath = resolveSystemPath(tmpSystemsDir, 'overflow-test');
      await fs.writeFile(finalPath, JSON.stringify(maxBrief, null, 2), 'utf8');

      // Attempting to update must throw overflow error without writing invalid revision
      await expect(
        saveSystemBrief(
          { ...maxBrief, name: 'Attempted Next Revision' },
          tmpSystemsDir,
          { expectedRevision: Number.MAX_SAFE_INTEGER }
        )
      ).rejects.toThrow(/Revision integer overflow/i);

      // File on disk must retain original content
      const onDisk = await getSystemBrief('overflow-test', tmpSystemsDir);
      expect(onDisk?.revision).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  describe('Invariant: Only an acquired lock is released, and every setup/operation transition attempts owned cleanup', () => {
    const lockPathFor = (id: string) => path.join(tmpSystemsDir, '.locks', `${id}.lock`);
    const lockExists = async (id: string): Promise<boolean> => {
      try { await fs.access(lockPathFor(id)); return true; } catch { return false; }
    };

    it('case: exclusive-open contention does not steal and reacquisition succeeds after release', async () => {
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      let acquired!: () => void;
      const acquiredP = new Promise<void>((r) => { acquired = r; });
      const holder = withSystemLock(tmpSystemsDir, 'lock-sys', async () => { acquired(); await held; return 'held-done'; });
      await acquiredP;
      await expect(withSystemLock(tmpSystemsDir, 'lock-sys', async () => 'never', 120)).rejects.toThrow(SystemLockTimeoutError);
      expect(await lockExists('lock-sys')).toBe(true);
      release();
      await expect(holder).resolves.toBe('held-done');
      expect(await lockExists('lock-sys')).toBe(false);
      await expect(withSystemLock(tmpSystemsDir, 'lock-sys', async () => 'again')).resolves.toBe('again');
    });

    it('case: partial token failure cleans up owned lock and reacquisition succeeds', async () => {
      lockFaults.failWrites = 1;
      lockFaults.partialWrite = true;
      await expect(withSystemLock(tmpSystemsDir, 'lock-sys', async () => 'never')).rejects.toThrow(/no space left on device/);
      resetLockFaults();
      expect(await lockExists('lock-sys')).toBe(false);
      await expect(withSystemLock(tmpSystemsDir, 'lock-sys', async () => 'recovered')).resolves.toBe('recovered');
      expect(await lockExists('lock-sys')).toBe(false);
    });

    it('case: token-write failure after file creation cleans up owned lock', async () => {
      lockFaults.failWrites = 1;
      await expect(withSystemLock(tmpSystemsDir, 'lock-sys', async () => 'never')).rejects.toThrow(/no space left on device/);
      resetLockFaults();
      expect(await lockExists('lock-sys')).toBe(false);
      await expect(withSystemLock(tmpSystemsDir, 'lock-sys', async () => 'recovered')).resolves.toBe('recovered');
    });

    it('case: handle-close failure cleans up owned lock and reacquisition succeeds', async () => {
      lockFaults.failCloses = 1;
      await expect(withSystemLock(tmpSystemsDir, 'lock-sys', async () => 'never')).rejects.toThrow(/close failure/);
      resetLockFaults();
      expect(await lockExists('lock-sys')).toBe(false);
      await expect(withSystemLock(tmpSystemsDir, 'lock-sys', async () => 'recovered')).resolves.toBe('recovered');
    });

    it('case: setup failure with cleanup failure surfaces explicit lock error and retains lock', async () => {
      lockFaults.failWrites = 1;
      lockFaults.failUnlinks = 999;
      const err = await withSystemLock(tmpSystemsDir, 'lock-sys', async () => 'never').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SystemLockReleaseError);
      expect((err as Error).message).toMatch(/Failed to set up lock/);
      expect((err as Error).message).toMatch(/no space left on device/);
      expect((err as Error).message).toMatch(/manually/);
      resetLockFaults();
      expect(await lockExists('lock-sys')).toBe(true);
      await fs.unlink(lockPathFor('lock-sys'));
    });

    it('case: successful operation + transient unlink retry succeeds and removes lock', async () => {
      lockFaults.failUnlinks = 2;
      await expect(withSystemLock(tmpSystemsDir, 'lock-sys', async () => 'ok')).resolves.toBe('ok');
      expect(lockFaults.unlinkAttempts).toBeGreaterThanOrEqual(3);
      resetLockFaults();
      expect(await lockExists('lock-sys')).toBe(false);
    });

    it('case: successful operation + permanent unlink failure is not reported as success', async () => {
      lockFaults.failUnlinks = 999;
      const err = await withSystemLock(tmpSystemsDir, 'lock-sys', async () => 'ok').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SystemLockReleaseError);
      expect((err as Error).message).toMatch(/Failed to release lock/);
      expect((err as Error).message).toMatch(/may have been saved/);
      expect((err as SystemLockReleaseError).lockPath).toBe(lockPathFor('lock-sys'));
      resetLockFaults();
      expect(await lockExists('lock-sys')).toBe(true);
      const retained = await fs.readFile(lockPathFor('lock-sys'), 'utf8');
      expect(retained.length).toBeGreaterThan(0);
      await fs.unlink(lockPathFor('lock-sys'));
    });

    it('case: successful operation + release read error is not reported as success', async () => {
      lockFaults.failReads = 10;
      const err = await withSystemLock(tmpSystemsDir, 'lock-sys', async () => 'ok').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SystemLockReleaseError);
      expect((err as Error).message).toMatch(/could not verify lock ownership/);
      resetLockFaults();
      expect(await lockExists('lock-sys')).toBe(true);
      await fs.unlink(lockPathFor('lock-sys'));
    });

    it('case: failed operation + successful release preserves operation failure and removes lock', async () => {
      await expect(withSystemLock(tmpSystemsDir, 'lock-sys', async () => { throw new Error('operation boom'); })).rejects.toThrow('operation boom');
      expect(await lockExists('lock-sys')).toBe(false);
    });

    it('case: failed operation + cleanup failure preserves both errors explicitly', async () => {
      lockFaults.failUnlinks = 999;
      const err = await withSystemLock(tmpSystemsDir, 'lock-sys', async () => { throw new Error('operation boom'); }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SystemLockReleaseError);
      expect((err as Error).message).toMatch(/operation boom/);
      expect((err as Error).message).toMatch(/lock release also failed/);
      expect((err as { cause?: Error }).cause?.message).toBe('operation boom');
      resetLockFaults();
      expect(await lockExists('lock-sys')).toBe(true);
      await fs.unlink(lockPathFor('lock-sys'));
    });

    it('case: ownership mismatch does not remove another writer lock and is surfaced', async () => {
      const err = await withSystemLock(tmpSystemsDir, 'lock-sys', async () => {
        await fs.writeFile(lockPathFor('lock-sys'), 'other-writer-token', 'utf8');
        return 'ok';
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SystemLockReleaseError);
      expect((err as Error).message).toMatch(/ownership mismatch/);
      expect(await fs.readFile(lockPathFor('lock-sys'), 'utf8')).toBe('other-writer-token');
      await fs.unlink(lockPathFor('lock-sys'));
    });

    it('case: permanent unlink failure on system API is mapped to 503, not success', async () => {
      const instance = new ChaosPilotServer({ runsDir: tmpRunsDir, systemsDir: tmpSystemsDir });
      const srv = instance.createHttpServer();
      try {
        lockFaults.failUnlinks = 999;
        const payload = JSON.stringify({
          schemaVersion: 1, id: 'api-lock-sys', revision: 1, name: 'API Lock System',
          overview: 'o', requirements: [], adapterId: 'synthetic-trading', updatedAt: new Date().toISOString(),
        });
        // Drive the real HTTP handler without a listening socket so the case
        // also runs where loopback listen is unavailable.
        const response = await new Promise<{ status: number; body: string }>((resolve) => {
          const req = new Readable({
            read() { this.push(payload); this.push(null); },
          }) as Readable & { method: string; url: string; headers: Record<string, string>; socket: { localPort: number } };
          req.method = 'POST';
          req.url = '/api/systems';
          req.headers = { host: '127.0.0.1', 'content-type': 'application/json' };
          req.socket = { localPort: 80 };
          let status = 0;
          const res = {
            writeHead: (s: number) => { status = s; },
            end: (b?: string) => resolve({ status, body: b || '' }),
          };
          srv.emit('request', req, res);
        });
        expect(response.status).toBe(503);
        const body = JSON.parse(response.body) as { error: string };
        expect(body.error).toMatch(/Failed to release lock/);
        resetLockFaults();
        // Uncertain-commit context: the guarded write may have completed despite the 503.
        expect(await getSystemBrief('api-lock-sys', tmpSystemsDir)).not.toBeNull();
        expect(await lockExists('api-lock-sys')).toBe(true);
        await fs.unlink(lockPathFor('api-lock-sys'));
      } finally {
        resetLockFaults();
        srv.close();
      }
    });
  });

  describe('Invariant: Unreadable or tampered data cannot be silently reset or relabelled', () => {
    it('case: corrupt seed/custom file', async () => {
      const seededPath = resolveSystemPath(tmpSystemsDir, 'trading-gateway');
      const corruptPayload = '{"broken-json-corrupt-data';

      // 1. Corrupt the seeded file on disk
      await fs.writeFile(seededPath, corruptPayload, 'utf8');

      // 2. ensureSeededSystem must FAIL visibly and must NOT overwrite the file
      await expect(ensureSeededSystem(tmpSystemsDir)).rejects.toThrow(SystemIntegrityError);

      // 3. Byte-preservation: file on disk must remain 100% byte-identical
      const diskContent = await fs.readFile(seededPath, 'utf8');
      expect(diskContent).toBe(corruptPayload);

      // 4. getSystemBrief must also fail visibly
      await expect(getSystemBrief('trading-gateway', tmpSystemsDir)).rejects.toThrow(SystemIntegrityError);

      // 5. Corrupt a custom system file
      const customPath = resolveSystemPath(tmpSystemsDir, 'custom-venue');
      const corruptCustom = '{ "id": "custom-venue", "revision": "not-a-number" }';
      await fs.writeFile(customPath, corruptCustom, 'utf8');

      await expect(getSystemBrief('custom-venue', tmpSystemsDir)).rejects.toThrow(SystemIntegrityError);
      const customDisk = await fs.readFile(customPath, 'utf8');
      expect(customDisk).toBe(corruptCustom);
    });

    it('case: mismatched fileID', async () => {
      // Write file named 'system-alpha.json' whose payload contains id 'system-beta'
      const alphaPath = resolveSystemPath(tmpSystemsDir, 'system-alpha');
      const mismatchedPayload: SystemBrief = {
        schemaVersion: 1,
        id: 'system-beta', // Mismatched!
        revision: 1,
        name: 'Mismatched ID System',
        overview: 'Payload ID does not match filename',
        requirements: [],
        adapterId: 'synthetic-trading',
        updatedAt: new Date().toISOString(),
      };

      await fs.writeFile(alphaPath, JSON.stringify(mismatchedPayload), 'utf8');

      // Attempting to read system-alpha must throw SystemIntegrityError
      await expect(
        getSystemBrief('system-alpha', tmpSystemsDir)
      ).rejects.toThrow(SystemIntegrityError);
    });

    it('case: canonical Windows ID aliases', async () => {
      // 1. Strict canonical lowercase check
      expect(validateSystemId('trading-gateway')).toBe(true);
      expect(validateSystemId('Trading-Gateway')).toBe(false);
      expect(validateSystemId('TRADING-GATEWAY')).toBe(false);
      expect(validateSystemId('Trading_Gateway')).toBe(false);

      // 2. Whitespace rejection (strict trimmed check)
      expect(validateSystemId(' trading-gateway ')).toBe(false);
      expect(validateSystemId('trading gateway')).toBe(false);
      expect(validateSystemId('\ttrading-gateway')).toBe(false);

      // 3. Windows reserved device basenames
      expect(validateSystemId('con')).toBe(false);
      expect(validateSystemId('CON')).toBe(false);
      expect(validateSystemId('prn')).toBe(false);
      expect(validateSystemId('aux')).toBe(false);
      expect(validateSystemId('nul')).toBe(false);
      expect(validateSystemId('com1')).toBe(false);
      expect(validateSystemId('com9')).toBe(false);
      expect(validateSystemId('lpt1')).toBe(false);

      // 4. Legitimate ledger IDs are ALLOWED (arbitrary ban removed)
      expect(validateSystemId('usage_ledger')).toBe(true);
      expect(validateSystemId('general_ledger')).toBe(true);
      expect(validateSystemId('audit_ledger_2026')).toBe(true);

      // 5. Length boundaries
      expect(validateSystemId('ab')).toBe(false); // too short (<3)
      expect(validateSystemId('a'.repeat(65))).toBe(false); // too long (>64)
      expect(validateSystemId('abc')).toBe(true);
      expect(validateSystemId('a'.repeat(64))).toBe(true);

      // 6. Directory containment
      expect(() => resolveSystemPath(tmpSystemsDir, '../../outside')).toThrow(/Invalid system ID/);
      expect(() => resolveSystemPath(tmpSystemsDir, '..\\..\\outside')).toThrow(/Invalid system ID/);
    });

    it('case: bad date', async () => {
      const basePayload = {
        schemaVersion: 1,
        id: 'date-check',
        revision: 1,
        name: 'Date Check System',
        overview: 'Overview',
        requirements: [],
        adapterId: 'synthetic-trading',
      };

      // Non-ISO date string
      const r1 = validateSystemBrief({ ...basePayload, updatedAt: 'not-a-date' });
      expect(r1.valid).toBe(false);
      expect(r1.error).toMatch(/updatedAt/i);

      // Invalid calendar date
      const r2 = validateSystemBrief({ ...basePayload, updatedAt: '2026-99-99T99:99:99.999Z' });
      expect(r2.valid).toBe(false);
      expect(r2.error).toMatch(/updatedAt/i);

      // Empty string
      const r3 = validateSystemBrief({ ...basePayload, updatedAt: '' });
      expect(r3.valid).toBe(false);

      // Valid ISO dates
      const r4 = validateSystemBrief({ ...basePayload, updatedAt: '2026-10-26T00:00:00.000Z' });
      expect(r4.valid).toBe(true);

      const r5 = validateSystemBrief({ ...basePayload, updatedAt: '2026-10-26T12:00:00Z' });
      expect(r5.valid).toBe(true);
    });

    it('case: tampered snapshot/hash', async () => {
      const brief = await ensureSeededSystem(tmpSystemsDir);
      const snapshot = await createSystemSnapshot(brief);

      // Tamper with the snapshot hash
      const tamperedHashSnapshot: SystemBriefSnapshot = {
        ...snapshot,
        hash: '0000000000000000000000000000000000000000000000000000000000000000',
      };

      let providerCalled = false;
      await expect(
        runInvestigation({
          id: 'test-tampered-hash',
          variant: 'candidate-a',
          maxExperiments: 1,
          provider: {
            kind: 'mock',
            model: 'mock',
            propose: async () => {
              providerCalled = true;
              return {
                experiment: null,
                usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
              };
            },
          },
          systemBrief: tamperedHashSnapshot,
        })
      ).rejects.toThrow(/System brief snapshot hash mismatch/);

      expect(providerCalled).toBe(false);
    });

    it('case: provider not called', async () => {
      const brief = await ensureSeededSystem(tmpSystemsDir);
      const snapshot = await createSystemSnapshot(brief);

      let providerCallCount = 0;
      const testProvider: ExperimentProvider = {
        kind: 'mock',
        model: 'mock',
        propose: async () => {
          providerCallCount++;
          return {
            experiment: null,
            usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
          };
        },
      };

      // 1. Invalid hash -> provider not called
      await expect(
        runInvestigation({
          id: 'inv-guard-1',
          variant: 'candidate-a',
          maxExperiments: 1,
          provider: testProvider,
          systemBrief: { ...snapshot, hash: 'bad-hash' },
        })
      ).rejects.toThrow();
      expect(providerCallCount).toBe(0);

      // 2. Unsupported adapter -> provider not called
      const unconfiguredBrief: SystemBrief = {
        ...brief,
        adapterId: 'unconfigured',
      };
      const unconfiguredSnap = await createSystemSnapshot(unconfiguredBrief);
      await expect(
        runInvestigation({
          id: 'inv-guard-2',
          variant: 'candidate-a',
          maxExperiments: 1,
          provider: testProvider,
          systemBrief: unconfiguredSnap,
        })
      ).rejects.toThrow(/unconfigured adapter/);
      expect(providerCallCount).toBe(0);

      // 3. Structural corruption in snapshot -> provider not called
      await expect(
        runInvestigation({
          id: 'inv-guard-3',
          variant: 'candidate-a',
          maxExperiments: 1,
          provider: testProvider,
          systemBrief: { brief: { ...brief, revision: -1 }, contract: null, hash: 'some-hash' } as any,
        })
      ).rejects.toThrow();
      expect(providerCallCount).toBe(0);
    });
  });

  describe('Invariant: Versioned state and start ownership survive invalid/concurrent input', () => {
    let server: http.Server;
    let baseUrl: string;
    let serverInstance: ChaosPilotServer;
    let providerFactoryCallCount = 0;

    beforeEach(async () => {
      providerFactoryCallCount = 0;
      serverInstance = new ChaosPilotServer({
        runsDir: tmpRunsDir,
        systemsDir: tmpSystemsDir,
        providerFactory: (kind) => {
          providerFactoryCallCount++;
          return {
            kind,
            model: 'test-model',
            propose: async () => ({
              experiment: null,
              usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
            }),
          };
        },
      });
      server = serverInstance.createHttpServer();
      await new Promise<void>(resolve => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as { port: number };
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
    });

    it('case: create/update/read', async () => {
      // 1. GET /api/systems returns seeded brief
      const listRes = await fetch(`${baseUrl}/api/systems`);
      expect(listRes.status).toBe(200);
      const systems: SystemBrief[] = await listRes.json();
      expect(systems.length).toBeGreaterThanOrEqual(1);
      expect(systems[0]!.id).toBe('trading-gateway');

      // 2. POST /api/systems creates a new brief
      const newBriefPayload = {
        schemaVersion: 1,
        id: 'credit-arb',
        revision: 1,
        name: 'Credit Arbitrage Venue',
        overview: 'Specialised event venue with custom risk limits',
        requirements: ['Check limit before fill', 'Reject stale quotes'],
        adapterId: 'synthetic-trading',
        updatedAt: new Date().toISOString(),
      };

      const createRes = await fetch(`${baseUrl}/api/systems`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newBriefPayload),
      });
      expect(createRes.status).toBe(201);
      const created: SystemBrief = await createRes.json();
      expect(created.id).toBe('credit-arb');
      expect(created.revision).toBe(1);

      // 3. GET /api/systems/:id reads it
      const getRes = await fetch(`${baseUrl}/api/systems/credit-arb`);
      expect(getRes.status).toBe(200);
      const fetched: SystemBrief = await getRes.json();
      expect(fetched.name).toBe('Credit Arbitrage Venue');

      // 4. GET /api/systems/:id/snapshot returns snapshot with canonical hash
      const snapRes = await fetch(`${baseUrl}/api/systems/credit-arb/snapshot`);
      expect(snapRes.status).toBe(200);
      const snapshot: SystemBriefSnapshot = await snapRes.json();
      expect(snapshot.brief.id).toBe('credit-arb');
      expect(snapshot.contract).toBeDefined();
      expect(snapshot.hash).toHaveLength(64);

      // 5. PUT /api/systems/:id updates to Rev 2
      const updateRes = await fetch(`${baseUrl}/api/systems/credit-arb`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...created,
          name: 'Credit Arbitrage Venue V2',
        }),
      });
      expect(updateRes.status).toBe(200);
      const updated: SystemBrief = await updateRes.json();
      expect(updated.revision).toBe(2);
      expect(updated.name).toBe('Credit Arbitrage Venue V2');
    });

    it('case: revision conflict', async () => {
      await ensureSeededSystem(tmpSystemsDir);

      // Save an update to advance to Rev 2
      await saveSystemBrief(
        { ...SEEDED_TRADING_BRIEF, name: 'Advanced Revision 2' },
        tmpSystemsDir
      );

      // Attempt to save an update with stale revision 1 via PUT
      const stalePutRes = await fetch(`${baseUrl}/api/systems/trading-gateway`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...SEEDED_TRADING_BRIEF,
          revision: 1, // Stale! Current is 2
          name: 'Stale Overwrite Attempt',
        }),
      });
      expect(stalePutRes.status).toBe(409);
      const err = await stalePutRes.json();
      expect(err.error).toMatch(/Revision conflict/i);

      // In start route: launching with a stale expectedRevision fails with 409
      const staleStartRes = await fetch(`${baseUrl}/api/investigation/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemId: 'trading-gateway',
          expectedRevision: 1, // Current is 2
          variant: 'candidate-a',
          provider: 'mock',
        }),
      });
      expect(staleStartRes.status).toBe(409);
      const startErr = await staleStartRes.json();
      expect(startErr.error).toMatch(/Revision conflict/i);
    });

    it('case: bad ID/body', async () => {
      // 1. Path traversal ID attempt
      const traversalRes = await fetch(`${baseUrl}/api/systems/..%2F..%2Fetc`);
      expect([400, 404]).toContain(traversalRes.status);

      // 2. Traversal attempt in storage directly throws
      expect(() => resolveSystemPath(tmpSystemsDir, '../../outside')).toThrow();

      // 3. Legitimate ledger IDs are valid
      expect(validateSystemId('usage_ledger')).toBe(true);

      // 4. Windows reserved device basenames return 400
      const conRes = await fetch(`${baseUrl}/api/systems/con`);
      expect(conRes.status).toBe(400);

      // 5. Uppercase / case aliases return 400
      const upperRes = await fetch(`${baseUrl}/api/systems/Trading-Gateway`);
      expect(upperRes.status).toBe(400);

      // 6. Bad payload validation
      const badBriefRes = await fetch(`${baseUrl}/api/systems`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, id: 'ok-id', name: '' }),
      });
      expect(badBriefRes.status).toBe(400);

      // 7. Oversized body (>64KB)
      const oversized = 'x'.repeat(70 * 1024);
      const oversizedRes = await fetch(`${baseUrl}/api/systems`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ huge: oversized }),
      });
      expect(oversizedRes.status).toBe(413);

      // 8. Malformed JSON
      const malformedRes = await fetch(`${baseUrl}/api/systems`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{broken-json',
      });
      expect(malformedRes.status).toBe(400);
    });

    it('case: API duplicate POST/missing PUT', async () => {
      await ensureSeededSystem(tmpSystemsDir);

      // Duplicate POST for trading-gateway must return 409
      const dupPost = await fetch(`${baseUrl}/api/systems`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...SEEDED_TRADING_BRIEF,
          name: 'Duplicate Attempt',
        }),
      });
      expect(dupPost.status).toBe(409);
      const dupJson = await dupPost.json();
      expect(dupJson.error).toMatch(/already exists/i);

      // PUT for missing system must return 404 without creating the file
      const missingPut = await fetch(`${baseUrl}/api/systems/missing-system`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          id: 'missing-system',
          revision: 1,
          name: 'Missing System',
          overview: 'Overview',
          requirements: [],
          adapterId: 'synthetic-trading',
          updatedAt: new Date().toISOString(),
        }),
      });
      expect(missingPut.status).toBe(404);
      const missingJson = await missingPut.json();
      expect(missingJson.error).toMatch(/not found/i);

      // Verify file was NOT created
      const fileCheck = await getSystemBrief('missing-system', tmpSystemsDir);
      expect(fileCheck).toBeNull();
    });

    it('case: corrupt file HTTP error surfacing', async () => {
      const corruptPath = resolveSystemPath(tmpSystemsDir, 'corrupt-sys');
      await fs.writeFile(corruptPath, '{corrupt-json-syntax', 'utf8');

      // GET /api/systems/corrupt-sys must return 500 integrity error, NOT 404
      const getRes = await fetch(`${baseUrl}/api/systems/corrupt-sys`);
      expect(getRes.status).toBe(500);
      const getJson = await getRes.json();
      expect(getJson.error).toMatch(/corrupt/i);

      // GET /api/systems/corrupt-sys/snapshot must also surface 500 integrity error
      const snapRes = await fetch(`${baseUrl}/api/systems/corrupt-sys/snapshot`);
      expect(snapRes.status).toBe(500);

      // GET /api/systems listing must surface 500 integrity error
      const listRes = await fetch(`${baseUrl}/api/systems`);
      expect(listRes.status).toBe(500);

      // Attempting to launch investigation against corrupt brief returns 500
      const launchRes = await fetch(`${baseUrl}/api/investigation/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemId: 'corrupt-sys',
          variant: 'candidate-a',
          provider: 'mock',
        }),
      });
      expect(launchRes.status).toBe(500);
    });

    it('case: unconfigured adapter', async () => {
      const draftBrief: SystemBrief = {
        schemaVersion: 1,
        id: 'draft-venue',
        revision: 1,
        name: 'Draft Fix Venue Specification',
        overview: 'FIX 4.4 specification without executable simulator implementation',
        requirements: ['Logon heartbeat 30s', 'Resend request sequence fill'],
        adapterId: 'unconfigured',
        updatedAt: new Date().toISOString(),
      };

      await createSystemBrief(draftBrief, tmpSystemsDir);

      // Inspecting snapshot produces contract: null
      const snapRes = await fetch(`${baseUrl}/api/systems/draft-venue/snapshot`);
      expect(snapRes.status).toBe(200);
      const snap: SystemBriefSnapshot = await snapRes.json();
      expect(snap.brief.adapterId).toBe('unconfigured');
      expect(snap.contract).toBeNull();
      expect(snap.hash).toHaveLength(64);

      // Attempting to launch investigation must reject with 400 BEFORE creating a provider
      const launchRes = await fetch(`${baseUrl}/api/investigation/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemId: 'draft-venue',
          variant: 'candidate-a',
          provider: 'mock',
        }),
      });

      expect(launchRes.status).toBe(400);
      const err = await launchRes.json();
      expect(err.error).toMatch(/unconfigured adapter/i);
      expect(providerFactoryCallCount).toBe(0);
    });

    it('case: stop during start', async () => {
      const entered = new Promise<void>(resolve => server.once('request', () => resolve()));
      const slowReq = http.request(`${baseUrl}/api/investigation/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const responsePromise = new Promise<number>((resolve, reject) => {
        slowReq.once('error', reject);
        slowReq.once('response', res => {
          res.resume();
          res.once('end', () => resolve(res.statusCode ?? 0));
        });
      });

      slowReq.write('{');
      await entered;

      const stopRes = await fetch(`${baseUrl}/api/investigation/stop`, { method: 'POST' });
      expect(stopRes.status).toBe(200);
      await stopRes.text();

      slowReq.end('}');
      const startStatus = await responsePromise;
      expect(startStatus).toBe(409);

      expect(serverInstance.getActiveInvestigation()).toBeNull();

      const nextStart = await fetch(`${baseUrl}/api/investigation/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant: 'candidate-a', provider: 'mock' }),
      });
      expect(nextStart.status).toBe(202);
      await nextStart.text();
    });

    it('case: no provider on invalid start', async () => {
      // 1. Invalid target variant
      const r1 = await fetch(`${baseUrl}/api/investigation/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant: 'non-existent-variant' }),
      });
      expect(r1.status).toBe(400);
      expect(providerFactoryCallCount).toBe(0);

      // 2. Non-existent system ID
      const r2 = await fetch(`${baseUrl}/api/investigation/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemId: 'missing-system-123' }),
      });
      expect(r2.status).toBe(404);
      expect(providerFactoryCallCount).toBe(0);

      // 3. Stale revision
      await ensureSeededSystem(tmpSystemsDir);
      const r3 = await fetch(`${baseUrl}/api/investigation/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemId: 'trading-gateway', expectedRevision: 999 }),
      });
      expect(r3.status).toBe(409);
      expect(providerFactoryCallCount).toBe(0);

      // 4. Malformed body
      const r4 = await fetch(`${baseUrl}/api/investigation/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json',
      });
      expect(r4.status).toBe(400);
      expect(providerFactoryCallCount).toBe(0);
    });
  });
});
