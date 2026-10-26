import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  runBenchmark,
  captureBenchmarkFreeze,
  verifyBenchmarkFreeze,
  ALLOWED_META_MODELS,
  DEFAULT_META_CONFIG,
  type BenchmarkOptions,
  type BenchmarkReport,
  type BenchmarkFreezeManifest,
} from '../src/benchmark.ts';
import {
  saveBenchmarkReport,
  getBenchmarkReport,
  listBenchmarkReports,
  validateBenchmarkId,
  normalizeBenchmarkInput,
  isValidBenchmarkReport,
} from '../src/storage.ts';
import { main as cliMain } from '../src/cli.ts';
import { BudgetLedger, calculateCost, calculateWorstCaseCost } from '../src/providers/budget.ts';
import { PROMPT_VERSION, PROMPT_TEMPLATE_HASH } from '../src/investigation/prompt.ts';
import type {
  TargetVariant,
  InvestigationRecord,
  ExperimentProvider,
  ProviderReply,
  ProviderContext,
  ProposalAttempt,
} from '../src/domain.ts';

// Test directory setup
let testRunsDir: string;
let testBenchmarksDir: string;

beforeEach(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'chaospilot-bench-test-'));
  testRunsDir = path.join(tmp, 'runs');
  testBenchmarksDir = path.join(testRunsDir, 'benchmarks');
  await fs.mkdir(testBenchmarksDir, { recursive: true });
});

afterEach(async () => {
  try {
    const tmp = path.dirname(testRunsDir);
    await fs.rm(tmp, { recursive: true, force: true });
  } catch {}
});

function createFakeSimulator() {
  return {
    getContract: () => ({
      name: 'TestSystem',
      description: 'Test contract',
      operations: [],
      messages: [],
      invariants: [
        { id: 'credit_limit_respected', description: 'Credit limit invariant' },
        { id: 'order_quantity_conservation', description: 'Order quantity invariant' },
      ],
      limits: { maxTicks: 100 },
    }),
    getSourceBundle: (variant: TargetVariant) => ({
      hash: `source-hash-${variant}`,
      files: [{ path: 'order-engine.ts', content: `// variant: ${variant}` }],
    }),
    parseExperiment: (input: any) => input,
    executeExperiment: (exp: any, variant: TargetVariant) => {
      const isCandidateA = variant === 'candidate-a';
      return {
        schemaVersion: 1,
        experiment: exp,
        sourceHash: `source-hash-${variant}`,
        trace: [],
        snapshot: {},
        violations: isCandidateA
          ? [
              {
                id: 'v1',
                invariant: 'order_quantity_conservation',
                message: 'Quantity mismatch',
                step: 1,
                evidence: {},
              },
            ]
          : [],
        rejections: [],
        valid: true,
      };
    },
  };
}

function createFakeRecord(
  variant: TargetVariant,
  model: string,
  options: {
    status?: 'completed' | 'failed' | 'cancelled';
    finding?: boolean;
    hasViolations?: boolean;
    initialPromptHash?: string;
    attempts?: ProposalAttempt[];
    stopReason?: string;
    contractHash?: string;
    sourceHash?: string;
  } = {}
): InvestigationRecord {
  const status = options.status || 'completed';
  const hasFinding = options.finding ?? (variant === 'candidate-a');
  const hasViolations = options.hasViolations ?? hasFinding;
  const contractHash =
    options.contractHash ||
    crypto
      .createHash('sha256')
      .update(JSON.stringify(createFakeSimulator().getContract()), 'utf8')
      .digest('hex');
  const sourceHash = options.sourceHash || `source-hash-${variant}`;

  const defaultAttempts: ProposalAttempt[] = [
    {
      index: 1,
      experimentNumber: 1,
      correctionNumber: 0,
      startedAt: new Date(Date.now() - 100).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 95,
      status: 'executed',
      requestSent: true,
      usageKnown: true,
      request: {
        promptVersion: '2.0',
        promptTemplateHash: PROMPT_TEMPLATE_HASH,
        promptHash: options.initialPromptHash || 'shared-prompt-hash-123',
        requestHash: `req-hash-${model}-1`,
        systemMessage: 'system',
        userMessage: 'user',
        configuration: { model, reasoningEffort: 'low', temperature: 0.2, maxOutputTokens: 4096, maxPromptBytes: 32768, requestTimeoutMs: 90000 },
      },
      response: {
        finishReason: 'stop',
      },
      usage: {
        inputTokens: 200,
        outputTokens: 80,
        estimatedCostUsd: 0.002,
      },
    },
  ];

  return {
    schemaVersion: 1,
    id: `inv-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    provider: 'meta',
    model,
    mode: 'live',
    variant,
    status,
    stopReason: options.stopReason,
    startedAt: new Date(Date.now() - 500).toISOString(),
    finishedAt: new Date().toISOString(),
    sourceHash,
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
          sourceHash,
          trace: [],
          snapshot: {},
          violations: hasViolations
            ? [
                {
                  id: 'v1',
                  invariant: 'order_quantity_conservation',
                  message: 'Quantity violated',
                  step: 1,
                  evidence: {},
                },
              ]
            : [],
          rejections: [],
          valid: true,
        },
        replayVerified: hasFinding,
        cleanControlPassed: hasFinding,
      },
    ],
    findings: hasFinding
      ? [
          {
            id: 'finding-1',
            title: 'Order quantity conservation violated',
            hypothesis: 'Test hypothesis',
            experimentIndex: 1,
            violation: {
              id: 'v1',
              invariant: 'order_quantity_conservation',
              message: 'Quantity violated',
              step: 1,
              evidence: {},
            },
            sourceHash,
            reproduced: true,
            cleanControlPassed: true,
            replay: {
              hypothesis: 'Test hypothesis',
              expectedInvariant: 'order_quantity_conservation',
              steps: [],
            },
          },
        ]
      : [],
    usage: {
      inputTokens: 200,
      outputTokens: 80,
      estimatedCostUsd: 0.002,
    },
    errors: [],
    contextAudit: {
      sourcePaths: ['order-engine.ts'],
      contractHash,
      promptVersion: '2.0',
      promptTemplateHash: PROMPT_TEMPLATE_HASH,
      providerConfiguration: { reasoning: 'low', reasoningEffort: 'low' },
      maxProposalAttempts: 6,
    },
    proposalAttempts: options.attempts ?? defaultAttempts,
  };
}

describe('Controlled Benchmark Engine & Reports', () => {
  it('runs mock benchmark with one offline arm and correct provenance', async () => {
    const fakeSim = createFakeSimulator();
    const report = await runBenchmark({
      provider: 'mock',
      trials: 2,
      maxExperiments: 4,
      targets: ['clean', 'candidate-a'],
      benchmarksDir: testBenchmarksDir,
      simulator: fakeSim,
      runner: async (opts) => {
        return createFakeRecord(opts.variant, 'scripted-offline', {
          attempts: [], // Mock may omit attempts
        });
      },
    });

    expect(report.schemaVersion).toBe(1);
    expect(report.kind).toBe('benchmark');
    expect(report.phase).toBe('calibration');
    expect(report.provenance.providerMode).toBe('mock');
    expect(report.provenance.mockResultsNeverImplyLivePerformance).toBe(true);
    expect(report.provenance.humanEffort).toBe('unmeasured');
    expect(report.baseline.totalTrials).toBe(4); // 2 targets * 2 trials
    expect(report.arms['scripted-offline']).toBeDefined();
    expect(report.arms['scripted-offline']!.trials).toHaveLength(4);
    expect(report.comparability.status).toBe('mock-offline');

    // Report was saved to disk
    const saved = await getBenchmarkReport(report.id, testBenchmarksDir);
    expect(saved).not.toBeNull();
    expect(saved.id).toBe(report.id);
  });

  it('counterbalances model arm order across trials (Wonder first then Spark first)', async () => {
    const fakeSim = createFakeSimulator();
    const executionOrder: { trial: number; model: string; target: string }[] = [];

    const report = await runBenchmark({
      provider: 'meta',
      models: ['muse-wonder-1.0', 'muse-spark-1.3'],
      targets: ['candidate-a'],
      trials: 2,
      maxExperiments: 6,
      benchmarksDir: testBenchmarksDir,
      simulator: fakeSim,
      budgetLedger: new BudgetLedger(path.join(testRunsDir, 'test-ledger.json'), 500),
      runner: async (opts) => {
        executionOrder.push({
          trial: opts.maxProposalAttempts || 0,
          model: (opts.provider as any).model,
          target: opts.variant,
        });
        return createFakeRecord(opts.variant, (opts.provider as any).model);
      },
      providerFactory: (_kind, model, config) => ({
        kind: 'meta',
        model,
        configuration: config,
        propose: async () => ({
          experiment: null,
          usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        }),
      }),
    });

    // Trial 1: Wonder armIndex 0, Spark armIndex 1
    const wonderTrial1 = report.arms['muse-wonder-1.0']!.trials.find((t) => t.trial === 1)!;
    const sparkTrial1 = report.arms['muse-spark-1.3']!.trials.find((t) => t.trial === 1)!;
    expect(wonderTrial1.armIndex).toBe(0);
    expect(sparkTrial1.armIndex).toBe(1);
    expect(wonderTrial1.armOrder).toEqual(['muse-wonder-1.0', 'muse-spark-1.3']);

    // Trial 2: Spark armIndex 0, Wonder armIndex 1 (counterbalanced!)
    const wonderTrial2 = report.arms['muse-wonder-1.0']!.trials.find((t) => t.trial === 2)!;
    const sparkTrial2 = report.arms['muse-spark-1.3']!.trials.find((t) => t.trial === 2)!;
    expect(sparkTrial2.armIndex).toBe(0);
    expect(wonderTrial2.armIndex).toBe(1);
    expect(sparkTrial2.armOrder).toEqual(['muse-spark-1.3', 'muse-wonder-1.0']);
  });

  it('validates initial promptHash parity across models and flags deliberate divergence', async () => {
    const fakeSim = createFakeSimulator();

    // 1. Matching hashes -> comparable
    const report1 = await runBenchmark({
      provider: 'meta',
      models: ['muse-wonder-1.0', 'muse-spark-1.3'],
      targets: ['candidate-a'],
      trials: 1,
      benchmarksDir: testBenchmarksDir,
      simulator: fakeSim,
      budgetLedger: new BudgetLedger(path.join(testRunsDir, 'test-ledger.json'), 500),
      runner: async (opts) => {
        return createFakeRecord(opts.variant, (opts.provider as any).model, {
          initialPromptHash: 'shared-identical-initial-prompt-hash',
        });
      },
      providerFactory: (_kind, model) => ({
        kind: 'meta',
        model,
        propose: async () => ({
          experiment: null,
          usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        }),
      }),
    });

    expect(report1.comparability.status).toBe('comparable');

    // 2. Mismatched prompt hashes -> comparability violated!
    const report2 = await runBenchmark({
      provider: 'meta',
      models: ['muse-wonder-1.0', 'muse-spark-1.3'],
      targets: ['candidate-a'],
      trials: 1,
      benchmarksDir: testBenchmarksDir,
      simulator: fakeSim,
      budgetLedger: new BudgetLedger(path.join(testRunsDir, 'test-ledger.json'), 500),
      runner: async (opts) => {
        const m = (opts.provider as any).model;
        // Inject mismatched hash between Wonder and Spark
        const initialPromptHash = m === 'muse-wonder-1.0' ? 'hash-wonder' : 'hash-spark';
        return createFakeRecord(opts.variant, m, { initialPromptHash });
      },
      providerFactory: (_kind, model) => ({
        kind: 'meta',
        model,
        propose: async () => ({
          experiment: null,
          usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        }),
      }),
    });

    expect(report2.comparability.status).toBe('violated');
    expect(report2.comparability.notes.some((n) => n.includes('diverged') || n.includes('mismatch'))).toBe(true);
  });

  it('captures and verifies benchmark freeze manifest, rejecting drifted baseline', async () => {
    const freezeFile = path.join(testRunsDir, 'freeze.json');
    const manifest = await captureBenchmarkFreeze(freezeFile);

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.baseline.file).toBe('src/evaluation.ts');
    expect(manifest.baseline.sha256).toHaveLength(64);
    expect(manifest.prompt.version).toBe(PROMPT_VERSION);
    expect(manifest.prompt.templateHash).toBe(PROMPT_TEMPLATE_HASH);

    // Verify succeeds on clean freeze
    const verified = await verifyBenchmarkFreeze(freezeFile);
    expect(verified.baseline.sha256).toBe(manifest.baseline.sha256);

    // Tamper with freeze file sha256 to simulate drift
    const tampered = { ...manifest, baseline: { ...manifest.baseline, sha256: 'deadbeef'.repeat(8) } };
    const tamperedPath = path.join(testRunsDir, 'tampered-freeze.json');
    await fs.writeFile(tamperedPath, JSON.stringify(tampered, null, 2), 'utf8');

    await expect(verifyBenchmarkFreeze(tamperedPath)).rejects.toThrow(/drift detected/i);

    // runBenchmark with drifted freeze rejects BEFORE running any trials
    let runnerCalled = false;
    await expect(
      runBenchmark({
        provider: 'mock',
        freezePath: tamperedPath,
        benchmarksDir: testBenchmarksDir,
        runner: async () => {
          runnerCalled = true;
          throw new Error('Should not be reached');
        },
      })
    ).rejects.toThrow(/drift detected/i);

    expect(runnerCalled).toBe(false);
  });

  it('enforces heldout phase requirements: requires freeze path and explicit targets', async () => {
    // 1. Heldout phase without freeze path throws
    await expect(
      runBenchmark({
        phase: 'heldout',
        targets: ['candidate-b'],
        benchmarksDir: testBenchmarksDir,
      })
    ).rejects.toThrow(/requires an existing matching freeze/i);

    // 2. Heldout phase without explicit targets throws
    const freezeFile = path.join(testRunsDir, 'freeze-valid.json');
    await captureBenchmarkFreeze(freezeFile);

    await expect(
      runBenchmark({
        phase: 'heldout',
        freezePath: freezeFile,
        targets: [], // missing explicit target
        benchmarksDir: testBenchmarksDir,
      })
    ).rejects.toThrow(/requires explicit selected target/i);
  });

  it('enforces maxProposalAttempts equal to maxExperiments and retains invalid/truncated attempts', async () => {
    const fakeSim = createFakeSimulator();
    let capturedOptions: any = null;

    const invalidAttempts: ProposalAttempt[] = [
      {
        index: 1,
        experimentNumber: 1,
        correctionNumber: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'invalid_response',
        requestSent: true,
        usageKnown: true,
        response: { finishReason: 'length', validationError: 'Truncated JSON' },
        usage: { inputTokens: 50, outputTokens: 20, estimatedCostUsd: 0.0001 },
      },
      {
        index: 2,
        experimentNumber: 1,
        correctionNumber: 1,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'invalid_plan',
        requestSent: true,
        usageKnown: true,
        response: { validationError: 'Unknown operation' },
        usage: { inputTokens: 50, outputTokens: 20, estimatedCostUsd: 0.0001 },
      },
      {
        index: 3,
        experimentNumber: 2,
        correctionNumber: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'executed',
        requestSent: true,
        usageKnown: false, // unknown usage
      },
    ];

    const report = await runBenchmark({
      provider: 'meta',
      models: ['muse-wonder-1.0'],
      targets: ['candidate-a'],
      trials: 1,
      maxExperiments: 6,
      benchmarksDir: testBenchmarksDir,
      simulator: fakeSim,
      budgetLedger: new BudgetLedger(path.join(testRunsDir, 'test-ledger.json'), 500),
      runner: async (opts) => {
        capturedOptions = opts;
        return createFakeRecord(opts.variant, 'muse-wonder-1.0', {
          attempts: invalidAttempts,
        });
      },
      providerFactory: (_kind, model) => ({
        kind: 'meta',
        model,
        propose: async () => ({
          experiment: null,
          usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        }),
      }),
    });

    // maxProposalAttempts passed to runner equals maxExperiments
    expect(capturedOptions.maxProposalAttempts).toBe(6);
    expect(capturedOptions.maxExperiments).toBe(6);

    const trial = report.arms['muse-wonder-1.0']!.trials[0]!;
    expect(trial.providerCallCount).toBe(3);
    expect(trial.invalidResponseCount).toBe(1);
    expect(trial.invalidPlanCount).toBe(1);
    expect(trial.truncationCount).toBe(1);
    expect(trial.unknownUsageCount).toBe(1);
    expect(trial.executedExperimentCount).toBe(1);
  });

  it('preserves failed and cancelled trials and saves partial report on abort', async () => {
    const fakeSim = createFakeSimulator();
    const abortController = new AbortController();

    let callCount = 0;
    const report = await runBenchmark({
      provider: 'mock',
      targets: ['candidate-a', 'candidate-b'],
      trials: 2,
      benchmarksDir: testBenchmarksDir,
      simulator: fakeSim,
      signal: abortController.signal,
      runner: async (opts) => {
        callCount++;
        if (callCount === 1) {
          // First trial throws before creating a record
          throw new Error('Network timeout before record creation');
        }
        if (callCount === 2) {
          // Second trial triggers abort
          abortController.abort();
          return createFakeRecord(opts.variant, 'scripted-offline', {
            status: 'cancelled',
            stopReason: 'Aborted during test',
          });
        }
        return createFakeRecord(opts.variant, 'scripted-offline');
      },
    });

    expect(report.status).toBe('cancelled');
    const trials = report.arms['scripted-offline']!.trials;
    expect(trials.length).toBeGreaterThanOrEqual(2);

    // Trial 1: preserved as failed trial, no fabricated metrics for pre-construction failure
    expect(trials[0]!.status).toBe('failed');
    expect(trials[0]!.errorReason).toContain('Network timeout');
    expect(trials[0]!.unknownUsageCount).toBe(0);
    expect(trials[0]!.providerCallCount).toBeNull();
    expect(trials[0]!.metricsComplete).toBe(false);

    // Trial 2: preserved as cancelled trial
    expect(trials[1]!.status).toBe('cancelled');

    // Partial report survived and was persisted to disk
    const onDisk = await getBenchmarkReport(report.id, testBenchmarksDir);
    expect(onDisk).not.toBeNull();
    expect(onDisk.status).toBe('cancelled');
  });

  it('distinguishes clean target raw violations from true discoveries (zero findings on clean)', async () => {
    const fakeSim = createFakeSimulator();

    const report = await runBenchmark({
      provider: 'meta',
      models: ['muse-wonder-1.0'],
      targets: ['clean'],
      trials: 1,
      benchmarksDir: testBenchmarksDir,
      simulator: fakeSim,
      budgetLedger: new BudgetLedger(path.join(testRunsDir, 'test-ledger.json'), 500),
      runner: async (opts) => {
        // Clean target returns raw violation in experiment, but cleanControlPassed is false -> findings: []
        return {
          ...createFakeRecord('clean', 'muse-wonder-1.0', { finding: false, hasViolations: true }),
          findings: [],
        };
      },
      providerFactory: (_kind, model) => ({
        kind: 'meta',
        model,
        propose: async () => ({
          experiment: null,
          usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        }),
      }),
    });

    const cleanSummary = report.arms['muse-wonder-1.0']!.summary.targetSummaries.find(
      (ts) => ts.target === 'clean'
    )!;

    // Clean findings count is strictly 0
    expect(cleanSummary.findingsCount).toBe(0);
    // Raw violation trials tracked separately without becoming false positive wins
    expect(cleanSummary.rawViolationTrialCount).toBe(1);
    expect(report.arms['muse-wonder-1.0']!.trials[0]!.timeToFirstVerifiedFindingMs).toBeNull();
  });

  it('enforces BudgetLedger aggregate cap and rejects launch if budget insufficient', async () => {
    const fakeSim = createFakeSimulator();
    const ledgerPath = path.join(testRunsDir, 'low-budget-ledger.json');
    // Create ledger with tiny $0.001 budget
    const lowLedger = new BudgetLedger(ledgerPath, 0.001);

    let runnerCalled = false;
    await expect(
      runBenchmark({
        provider: 'meta',
        models: ['muse-wonder-1.0', 'muse-spark-1.3'],
        targets: ['clean', 'candidate-a', 'candidate-b'],
        trials: 2,
        maxExperiments: 6,
        benchmarksDir: testBenchmarksDir,
        simulator: fakeSim,
        budgetLedger: lowLedger,
        runner: async () => {
          runnerCalled = true;
          throw new Error('Should not be called');
        },
      })
    ).rejects.toThrow(/Insufficient budget/i);

    expect(runnerCalled).toBe(false);
  });

  it('validates model whitelist and rejects unapproved models before network', async () => {
    const fakeSim = createFakeSimulator();
    const ledger = new BudgetLedger(path.join(testRunsDir, 'test-ledger.json'), 500);

    await expect(
      runBenchmark({
        provider: 'meta',
        models: ['unapproved-gpt-5' as any],
        benchmarksDir: testBenchmarksDir,
        simulator: fakeSim,
        budgetLedger: ledger,
      })
    ).rejects.toThrow(/Unsupported model for provider meta/i);
  });
});

describe('Invariant Coverage 1: Declared controls match actual network provider and frozen executed code', () => {
  it('conflicting env: provider uses declared controls and ignores conflicting environment variables', async () => {
    const origReasoning = process.env['META_REASONING_EFFORT'];
    const origTimeout = process.env['CHAOSPILOT_REQUEST_TIMEOUT_MS'];
    const origKey = process.env['MODEL_API_KEY'];

    process.env['META_REASONING_EFFORT'] = 'high';
    process.env['CHAOSPILOT_REQUEST_TIMEOUT_MS'] = '10000';
    process.env['MODEL_API_KEY'] = 'test-mock-key';

    const fakeSim = createFakeSimulator();
    let capturedProviderConfig: Record<string, string | number> | undefined;

    try {
      await runBenchmark({
        provider: 'meta',
        models: ['muse-wonder-1.0'],
        targets: ['candidate-a'],
        trials: 1,
        configuration: {
          reasoningEffort: 'low',
          requestTimeoutMs: 75000,
        },
        benchmarksDir: testBenchmarksDir,
        simulator: fakeSim,
        budgetLedger: new BudgetLedger(path.join(testRunsDir, 'test-ledger.json'), 500),
        runner: async (opts) => {
          capturedProviderConfig = opts.provider.configuration;
          return createFakeRecord(opts.variant, opts.provider.model);
        },
      });

      expect(capturedProviderConfig).toBeDefined();
      expect(capturedProviderConfig!['reasoningEffort']).toBe('low');
      expect(capturedProviderConfig!['requestTimeoutMs']).toBe(75000);
      expect(capturedProviderConfig!['reasoningEffort']).not.toBe('high');
      expect(capturedProviderConfig!['requestTimeoutMs']).not.toBe(10000);
    } finally {
      if (origReasoning !== undefined) process.env['META_REASONING_EFFORT'] = origReasoning;
      else delete process.env['META_REASONING_EFFORT'];

      if (origTimeout !== undefined) process.env['CHAOSPILOT_REQUEST_TIMEOUT_MS'] = origTimeout;
      else delete process.env['CHAOSPILOT_REQUEST_TIMEOUT_MS'];

      if (origKey !== undefined) process.env['MODEL_API_KEY'] = origKey;
      else delete process.env['MODEL_API_KEY'];
    }
  });

  it('same ledger: aggregate preflight ledger is injected into MetaProvider', async () => {
    const origKey = process.env['MODEL_API_KEY'];
    process.env['MODEL_API_KEY'] = 'test-mock-key';

    const fakeSim = createFakeSimulator();
    const myLedger = new BudgetLedger(path.join(testRunsDir, 'custom-preflight-ledger.json'), 250);
    let capturedLedger: any;

    try {
      await runBenchmark({
        provider: 'meta',
        models: ['muse-wonder-1.0'],
        targets: ['candidate-a'],
        trials: 1,
        benchmarksDir: testBenchmarksDir,
        simulator: fakeSim,
        budgetLedger: myLedger,
        runner: async (opts) => {
          capturedLedger = (opts.provider as any).getLedger?.();
          return createFakeRecord(opts.variant, opts.provider.model);
        },
      });

      expect(capturedLedger).toBe(myLedger);
    } finally {
      if (origKey !== undefined) process.env['MODEL_API_KEY'] = origKey;
      else delete process.env['MODEL_API_KEY'];
    }
  });

  it('source/runtime/function drift: rejects modified runtime bytes and function identities', async () => {
    const freezeFile = path.join(testRunsDir, 'freeze-funcs.json');
    const manifest = await captureBenchmarkFreeze(freezeFile);

    // 1. Runtime bytes drift
    const tamperedRuntime = {
      ...manifest,
      baseline: { ...manifest.baseline, runtimeSha256: 'deadbeef'.repeat(8) },
    };
    const runtimePath = path.join(testRunsDir, 'tampered-runtime.json');
    await fs.writeFile(runtimePath, JSON.stringify(tamperedRuntime, null, 2), 'utf8');
    await expect(verifyBenchmarkFreeze(runtimePath)).rejects.toThrow(/baseline generator runtime drift detected/i);

    // 2. Function identity drift: runBaselineTrial
    const tamperedFn = {
      ...manifest,
      baseline: {
        ...manifest.baseline,
        functions: {
          ...manifest.baseline.functions!,
          runBaselineTrial: 'f00d'.repeat(16),
        },
      },
    };
    const fnPath = path.join(testRunsDir, 'tampered-fn.json');
    await fs.writeFile(fnPath, JSON.stringify(tamperedFn, null, 2), 'utf8');
    await expect(verifyBenchmarkFreeze(fnPath)).rejects.toThrow(/function identity drift detected for runBaselineTrial/i);

    // 3. Function identity drift: createPrng
    const tamperedPrng = {
      ...manifest,
      baseline: {
        ...manifest.baseline,
        functions: {
          ...manifest.baseline.functions!,
          createPrng: 'f00d'.repeat(16),
        },
      },
    };
    const prngPath = path.join(testRunsDir, 'tampered-prng.json');
    await fs.writeFile(prngPath, JSON.stringify(tamperedPrng, null, 2), 'utf8');
    await expect(verifyBenchmarkFreeze(prngPath)).rejects.toThrow(/function identity drift detected for createPrng/i);
  });

  it('dynamic prompt drift: detects prompt module bytes and buildInvestigationPrompt drift', async () => {
    const freezeFile = path.join(testRunsDir, 'freeze-prompt.json');
    const manifest = await captureBenchmarkFreeze(freezeFile);

    // 1. Prompt module bytes drift
    const tamperedModule = {
      ...manifest,
      prompt: {
        ...manifest.prompt,
        moduleSha256: 'cafe'.repeat(16),
      },
    };
    const modPath = path.join(testRunsDir, 'tampered-prompt-mod.json');
    await fs.writeFile(modPath, JSON.stringify(tamperedModule, null, 2), 'utf8');
    await expect(verifyBenchmarkFreeze(modPath)).rejects.toThrow(/prompt module bytes drift detected/i);

    // 2. Dynamic prompt function identity drift
    const tamperedDynamic = {
      ...manifest,
      prompt: {
        ...manifest.prompt,
        dynamicPromptHash: 'cafe'.repeat(16),
      },
    };
    const dynPath = path.join(testRunsDir, 'tampered-prompt-dyn.json');
    await fs.writeFile(dynPath, JSON.stringify(tamperedDynamic, null, 2), 'utf8');
    await expect(verifyBenchmarkFreeze(dynPath)).rejects.toThrow(/dynamic prompt function identity drift detected/i);
  });

  it('invalid and duplicate settings: rejects NaN, Infinity, zero, duplicate models/targets/seeds rather than silently replacing with defaults', async () => {
    const fakeSim = createFakeSimulator();

    // 1. NaN and Infinity in trials
    await expect(runBenchmark({ trials: NaN, simulator: fakeSim, benchmarksDir: testBenchmarksDir })).rejects.toThrow(/Invalid trials/i);
    await expect(runBenchmark({ trials: Infinity, simulator: fakeSim, benchmarksDir: testBenchmarksDir })).rejects.toThrow(/Invalid trials/i);
    await expect(runBenchmark({ trials: 0, simulator: fakeSim, benchmarksDir: testBenchmarksDir })).rejects.toThrow(/Invalid trials/i);
    await expect(runBenchmark({ trials: 15, simulator: fakeSim, benchmarksDir: testBenchmarksDir })).rejects.toThrow(/Invalid trials/i);

    // 2. NaN and 0 in maxExperiments
    await expect(runBenchmark({ maxExperiments: NaN, simulator: fakeSim, benchmarksDir: testBenchmarksDir })).rejects.toThrow(/Invalid maxExperiments/i);
    await expect(runBenchmark({ maxExperiments: 0, simulator: fakeSim, benchmarksDir: testBenchmarksDir })).rejects.toThrow(/Invalid maxExperiments/i);
    await expect(runBenchmark({ maxExperiments: 25, simulator: fakeSim, benchmarksDir: testBenchmarksDir })).rejects.toThrow(/Invalid maxExperiments/i);

    // 3. Duplicate and empty models
    await expect(runBenchmark({ models: [], simulator: fakeSim, benchmarksDir: testBenchmarksDir })).rejects.toThrow(/models must be a nonempty array/i);
    await expect(runBenchmark({ models: ['muse-wonder-1.0', 'muse-wonder-1.0'], provider: 'meta', simulator: fakeSim, benchmarksDir: testBenchmarksDir })).rejects.toThrow(/Duplicate models are not permitted/i);

    // 4. Duplicate and empty targets
    await expect(runBenchmark({ targets: [], simulator: fakeSim, benchmarksDir: testBenchmarksDir })).rejects.toThrow(/targets must be a nonempty array/i);
    await expect(runBenchmark({ targets: ['clean', 'clean'], simulator: fakeSim, benchmarksDir: testBenchmarksDir })).rejects.toThrow(/Duplicate targets are not permitted/i);

    // 5. Duplicate and invalid seeds
    await expect(runBenchmark({ trials: 2, seeds: [1001, 1001], simulator: fakeSim, benchmarksDir: testBenchmarksDir })).rejects.toThrow(/Duplicate seeds are not permitted/i);
    await expect(runBenchmark({ trials: 2, seeds: [1001, NaN], simulator: fakeSim, benchmarksDir: testBenchmarksDir })).rejects.toThrow(/Invalid seed/i);

    // 6. Timeout bounds against provider max120000
    await expect(runBenchmark({ provider: 'meta', configuration: { timeoutMs: 130000 }, simulator: fakeSim, benchmarksDir: testBenchmarksDir })).rejects.toThrow(/Range: \[1000, 120000\]/i);
    await expect(runBenchmark({ provider: 'meta', configuration: { timeoutMs: 500 }, simulator: fakeSim, benchmarksDir: testBenchmarksDir })).rejects.toThrow(/Range: \[1000, 120000\]/i);

    // 7. Reasoning setting validation
    await expect(runBenchmark({ provider: 'meta', configuration: { reasoning: 'high' }, simulator: fakeSim, benchmarksDir: testBenchmarksDir })).rejects.toThrow(/Must be explicit "low"/i);

    // 8. No-argument defaults preserved
    const defaultRep = await runBenchmark({
      provider: 'mock',
      targets: ['candidate-a'],
      trials: 1,
      benchmarksDir: testBenchmarksDir,
      simulator: fakeSim,
      runner: async (opts) => createFakeRecord(opts.variant, 'scripted-offline'),
    });
    expect(defaultRep.config.trials).toBe(1);
    expect(defaultRep.config.maxExperiments).toBe(6);
  });

  it('freeze saved before fixture creation remains valid when only candidate registry changes', async () => {
    const freezeFile = path.join(testRunsDir, 'freeze-pre-fixture.json');
    await captureBenchmarkFreeze(freezeFile);

    // Simulate candidate registry extension in simulator
    const extendedSimulator = {
      ...createFakeSimulator(),
      getCandidateRegistry: () => ['candidate-a', 'candidate-b', 'candidate-c'],
    };

    // Verification succeeds without failure
    const verified = await verifyBenchmarkFreeze(freezeFile);
    expect(verified.schemaVersion).toBe(1);
  });
});

describe('Invariant Coverage 2: No attempt or uncertainty disappears or becomes fabricated measurement', () => {
  it('pending disk save: active trial and record are saved to disk during pending attempt', async () => {
    const fakeSim = createFakeSimulator();
    let savedReportDuringPending: BenchmarkReport | null = null;
    let benchReportId: string | undefined;

    await runBenchmark({
      id: 'bench-pending-save-test',
      provider: 'meta',
      models: ['muse-wonder-1.0'],
      targets: ['candidate-a'],
      trials: 1,
      benchmarksDir: testBenchmarksDir,
      simulator: fakeSim,
      budgetLedger: new BudgetLedger(path.join(testRunsDir, 'test-ledger.json'), 500),
      runner: async (opts) => {
        benchReportId = opts.id;
        const rec = createFakeRecord(opts.variant, 'muse-wonder-1.0');
        rec.proposalAttempts = [
          {
            index: 1,
            experimentNumber: 1,
            correctionNumber: 0,
            startedAt: new Date().toISOString(),
            status: 'pending',
            usageKnown: false,
          },
        ];
        // Trigger runner onUpdate with pending attempt
        await opts.onUpdate?.(rec);

        // Read saved report directly from disk while attempt is pending
        savedReportDuringPending = await getBenchmarkReport('bench-pending-save-test', testBenchmarksDir);

        return rec;
      },
      providerFactory: (_kind, model) => ({
        kind: 'meta',
        model,
        propose: async () => ({
          experiment: null,
          usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        }),
      }),
    });

    expect(savedReportDuringPending).not.toBeNull();
    const trialOnDisk = savedReportDuringPending!.arms['muse-wonder-1.0']!.trials[0]!;
    expect(trialOnDisk.status).toBe('running');
    expect(trialOnDisk.record).toBeDefined();
    expect(trialOnDisk.record!.proposalAttempts![0]!.status).toBe('pending');
  });

  it('runner throw after progress: retains last record and updates trial to failed', async () => {
    const fakeSim = createFakeSimulator();

    const report = await runBenchmark({
      provider: 'mock',
      targets: ['candidate-a'],
      trials: 1,
      benchmarksDir: testBenchmarksDir,
      simulator: fakeSim,
      runner: async (opts) => {
        const partialRecord = createFakeRecord(opts.variant, 'scripted-offline');
        // Progress update
        await opts.onUpdate?.(partialRecord);
        // Abrupt failure
        throw new Error('Simulated runner unhandled exception after progress');
      },
    });

    const trial = report.arms['scripted-offline']!.trials[0]!;
    expect(trial.status).toBe('failed');
    expect(trial.errorReason).toContain('Simulated runner unhandled exception after progress');
    expect(trial.record).toBeDefined();
    expect(trial.executedExperimentCount).toBe(1);

    // Verified on disk as well
    const onDisk = await getBenchmarkReport(report.id, testBenchmarksDir);
    expect(onDisk.arms['scripted-offline']!.trials[0]!.status).toBe('failed');
  });

  it('pre-construction failure: failure before provider/runner produces record leaves no fabricated call/network counts', async () => {
    const fakeSim = createFakeSimulator();

    const report = await runBenchmark({
      provider: 'mock',
      targets: ['candidate-a'],
      trials: 1,
      benchmarksDir: testBenchmarksDir,
      simulator: fakeSim,
      runner: async () => {
        throw new Error('Pre-construction harness initialization failure');
      },
    });

    const trial = report.arms['scripted-offline']!.trials[0]!;
    expect(trial.status).toBe('failed');
    expect(trial.errorReason).toContain('Pre-construction harness initialization failure');
    // NO fabricated counts
    expect(trial.providerCallCount).toBeNull();
    expect(trial.confirmedNetworkRequests).toBeNull();
    expect(trial.uncertainNetworkRequests).toBeNull();
    expect(trial.unknownUsageCount).toBe(0);
    expect(trial.metricsComplete).toBe(false);
  });

  it('legacy missing audit: marks aggregate comparability incomplete rather than fabricating counts', async () => {
    const fakeSim = createFakeSimulator();

    const report = await runBenchmark({
      provider: 'meta',
      models: ['muse-wonder-1.0'],
      targets: ['candidate-a'],
      trials: 1,
      benchmarksDir: testBenchmarksDir,
      simulator: fakeSim,
      budgetLedger: new BudgetLedger(path.join(testRunsDir, 'test-ledger.json'), 500),
      runner: async (opts) => {
        return createFakeRecord(opts.variant, 'muse-wonder-1.0', {
          attempts: [], // Missing attempt audit on live provider
        });
      },
      providerFactory: (_kind, model) => ({
        kind: 'meta',
        model,
        propose: async () => ({
          experiment: null,
          usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        }),
      }),
    });

    const trial = report.arms['muse-wonder-1.0']!.trials[0]!;
    expect(trial.providerCallCount).toBeNull();
    expect(trial.metricsComplete).toBe(false);
    expect(trial.comparabilityStatus).toBe('incomplete');
    expect(report.comparability.status).toBe('incomplete');
  });

  it('missing peer: incomplete trials/arms mark aggregate comparability incomplete', async () => {
    const fakeSim = createFakeSimulator();
    const abortController = new AbortController();

    const report = await runBenchmark({
      provider: 'meta',
      models: ['muse-wonder-1.0', 'muse-spark-1.3'],
      targets: ['candidate-a'],
      trials: 1,
      benchmarksDir: testBenchmarksDir,
      simulator: fakeSim,
      signal: abortController.signal,
      budgetLedger: new BudgetLedger(path.join(testRunsDir, 'test-ledger.json'), 500),
      runner: async (opts) => {
        abortController.abort(); // Cancel before peer arm executes
        return createFakeRecord(opts.variant, (opts.provider as any).model);
      },
      providerFactory: (_kind, model) => ({
        kind: 'meta',
        model,
        propose: async () => ({
          experiment: null,
          usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        }),
      }),
    });

    expect(report.comparability.status).toBe('incomplete');
    expect(report.comparability.notes.some((n) => n.includes('incomplete') || n.includes('cancelled'))).toBe(true);
  });

  it('source/config mismatch: contractHash or sourceHash divergence marks trial and report violated', async () => {
    const fakeSim = createFakeSimulator();

    const report = await runBenchmark({
      provider: 'meta',
      models: ['muse-wonder-1.0'],
      targets: ['candidate-a'],
      trials: 1,
      benchmarksDir: testBenchmarksDir,
      simulator: fakeSim,
      budgetLedger: new BudgetLedger(path.join(testRunsDir, 'test-ledger.json'), 500),
      runner: async (opts) => {
        return createFakeRecord(opts.variant, 'muse-wonder-1.0', {
          sourceHash: 'tampered-source-hash-mismatch',
        });
      },
      providerFactory: (_kind, model) => ({
        kind: 'meta',
        model,
        propose: async () => ({
          experiment: null,
          usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        }),
      }),
    });

    const trial = report.arms['muse-wonder-1.0']!.trials[0]!;
    expect(trial.comparabilityStatus).toBe('violated');
    expect(report.comparability.status).toBe('violated');
    expect(report.comparability.notes.some((n) => n.includes('sourceHash drifted'))).toBe(true);
  });

  it('multiple attempt timing: time-to-first verified finding includes earlier rejected attempts naturally via monotonic now()', async () => {
    const fakeSim = createFakeSimulator();

    let currentTime = 1000;
    const injectedNow = () => currentTime;

    const report = await runBenchmark({
      provider: 'meta',
      models: ['muse-wonder-1.0'],
      targets: ['candidate-a'],
      trials: 1,
      benchmarksDir: testBenchmarksDir,
      simulator: fakeSim,
      now: injectedNow,
      budgetLedger: new BudgetLedger(path.join(testRunsDir, 'test-ledger.json'), 500),
      runner: async (opts) => {
        // Start of trial is at t = 1000
        const rec = createFakeRecord(opts.variant, 'muse-wonder-1.0', { finding: false });

        // Attempt 1: Failed/rejected attempt takes 150ms
        currentTime = 1150;
        rec.proposalAttempts = [
          {
            index: 1,
            experimentNumber: 1,
            correctionNumber: 0,
            startedAt: new Date(1000).toISOString(),
            finishedAt: new Date(1150).toISOString(),
            durationMs: 150,
            status: 'invalid_response',
            usageKnown: true,
          },
        ];
        await opts.onUpdate?.(rec);

        // Attempt 2: Proposes experiment, takes 200ms
        currentTime = 1350;
        rec.proposalAttempts.push({
          index: 2,
          experimentNumber: 2,
          correctionNumber: 0,
          startedAt: new Date(1150).toISOString(),
          finishedAt: new Date(1350).toISOString(),
          durationMs: 200,
          status: 'executed',
          usageKnown: true,
        });

        // Verification replay finishes at t = 1450 (finding appears)
        currentTime = 1450;
        rec.findings = [
          {
            id: 'finding-1',
            title: 'Order quantity conservation violated',
            hypothesis: 'Test hypothesis',
            experimentIndex: 2,
            violation: {
              id: 'v1',
              invariant: 'order_quantity_conservation',
              message: 'Quantity violated',
              step: 1,
              evidence: {},
            },
            sourceHash: `source-hash-${opts.variant}`,
            reproduced: true,
            cleanControlPassed: true,
            replay: {
              hypothesis: 'Test hypothesis',
              expectedInvariant: 'order_quantity_conservation',
              steps: [],
            },
          },
        ];
        await opts.onUpdate?.(rec);

        // Final total elapsed reaches t = 1500
        currentTime = 1500;
        return rec;
      },
      providerFactory: (_kind, model) => ({
        kind: 'meta',
        model,
        propose: async () => ({
          experiment: null,
          usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        }),
      }),
    });

    const trial = report.arms['muse-wonder-1.0']!.trials[0]!;
    // Time to first verified finding is 1450 - 1000 = 450ms (includes attempt 1, attempt 2, and verification!)
    // NOT attempt 2 duration (200ms) and NOT an approximation!
    expect(trial.timeToFirstVerifiedFindingMs).toBe(450);
    expect(trial.elapsedMs).toBe(500);
  });
});

describe('Storage & Safe Persistence for Benchmarks', () => {
  it('validates benchmark ID format and prevents path traversal', () => {
    expect(validateBenchmarkId('bench_123456_abcd')).toBe(true);
    expect(validateBenchmarkId('bench-12345')).toBe(true);
    expect(validateBenchmarkId('../etc/passwd')).toBe(false);
    expect(validateBenchmarkId('runs/bench_123')).toBe(false);
    expect(validateBenchmarkId('bench_ledger_secret')).toBe(false);
    expect(validateBenchmarkId('')).toBe(false);
    expect(validateBenchmarkId('a'.repeat(100))).toBe(false);
  });

  it('normalizes benchmark file path inputs safely', () => {
    expect(normalizeBenchmarkInput('bench_123', testBenchmarksDir)).toBe('bench_123');
    expect(normalizeBenchmarkInput('bench_123.json', testBenchmarksDir)).toBe('bench_123');
    expect(normalizeBenchmarkInput(path.join(testBenchmarksDir, 'bench_123.json'), testBenchmarksDir)).toBe(
      'bench_123'
    );
    expect(normalizeBenchmarkInput('../../etc/passwd', testBenchmarksDir)).toBeNull();
  });

  it('atomically saves, retrieves, and lists benchmark reports', async () => {
    const fakeSim = createFakeSimulator();
    const report = await runBenchmark({
      id: 'bench_test_save_123',
      provider: 'mock',
      targets: ['candidate-a'],
      trials: 1,
      benchmarksDir: testBenchmarksDir,
      simulator: fakeSim,
      runner: async (opts) => createFakeRecord(opts.variant, 'scripted-offline'),
    });

    const retrieved = await getBenchmarkReport('bench_test_save_123', testBenchmarksDir);
    expect(retrieved).not.toBeNull();
    expect(retrieved.id).toBe('bench_test_save_123');
    expect(retrieved.kind).toBe('benchmark');

    const list = await listBenchmarkReports(testBenchmarksDir);
    expect(list.some((b) => b.id === 'bench_test_save_123')).toBe(true);
  });
});

describe('CLI Integration for benchmark and benchmark-freeze', () => {
  it('captures freeze manifest via CLI benchmark-freeze', async () => {
    const freezePath = path.join(testRunsDir, 'cli-freeze.json');
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      await cliMain(['benchmark-freeze', `--freeze=${freezePath}`]);
    } finally {
      console.log = origLog;
    }

    const content = await fs.readFile(freezePath, 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.baseline.file).toBe('src/evaluation.ts');
    expect(logs.some((l) => l.includes('Successfully written'))).toBe(true);
  });

  it('runs offline benchmark via CLI benchmark command with mock provider', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      await cliMain([
        'benchmark',
        '--provider=mock',
        '--targets=candidate-a',
        '--trials=1',
        '--max-experiments=2',
      ]);
    } finally {
      console.log = origLog;
    }

    expect(logs.some((l) => l.includes('Benchmark Execution Completed'))).toBe(true);
    expect(logs.some((l) => l.includes('Arm [scripted-offline]'))).toBe(true);
  });

  it('rejects live meta benchmark when MODEL_API_KEY is missing', async () => {
    const origKey = process.env.MODEL_API_KEY;
    delete process.env.MODEL_API_KEY;

    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...args) => errors.push(args.join(' '));

    const origExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as any;

    try {
      await expect(
        cliMain(['benchmark', '--provider=meta'])
      ).rejects.toThrow(/process\.exit/);
      expect(exitCode).toBe(1);
      expect(errors.some((e) => e.includes('Missing required environment variable MODEL_API_KEY'))).toBe(true);
    } finally {
      console.error = origErr;
      process.exit = origExit;
      if (origKey !== undefined) process.env.MODEL_API_KEY = origKey;
    }
  });
});

describe('Complete freeze and observed request identity', () => {
  it('persists initial freeze failure as a comparability violation', async () => {
    const file = path.join(testRunsDir, 'drifted-freeze.json');
    const manifest = await captureBenchmarkFreeze();
    manifest.baseline.sha256 = '0'.repeat(64);
    await fs.writeFile(file, JSON.stringify(manifest));
    await expect(runBenchmark({ id: 'bench-freeze-failure', provider: 'meta', targets: ['candidate-a'], trials: 1,
      freezePath: file, simulator: createFakeSimulator(), benchmarksDir: testBenchmarksDir,
      budgetLedger: new BudgetLedger(path.join(testRunsDir, 'ledger.json'), 50),
    })).rejects.toThrow(/source drift/);
    const saved = await getBenchmarkReport<BenchmarkReport>('bench-freeze-failure', testBenchmarksDir);
    expect(saved).toMatchObject({ status: 'failed', comparability: { status: 'violated' } });
    expect(saved!.comparability.notes.join(' ')).toContain('Freeze verification failed');
  });

  it('retains a completed trial and marks drifted freeze verification between trials violated', async () => {
    const file = path.join(testRunsDir, 'between-trials.json');
    const manifest = await captureBenchmarkFreeze(file);
    await expect(runBenchmark({ id: 'bench-between-trials', provider: 'meta', models: ['muse-wonder-1.0'],
      targets: ['candidate-a'], trials: 2, freezePath: file, simulator: createFakeSimulator(), benchmarksDir: testBenchmarksDir,
      budgetLedger: new BudgetLedger(path.join(testRunsDir, 'ledger.json'), 50),
      providerFactory: (_kind, model) => ({ kind: 'meta', model, propose: async () => ({ experiment: null }) }),
      runner: async opts => {
        manifest.baseline.runtimeSha256 = '0'.repeat(64);
        await fs.writeFile(file, JSON.stringify(manifest));
        return createFakeRecord(opts.variant, opts.provider.model);
      },
    })).rejects.toThrow(/runtime drift/);
    const saved = await getBenchmarkReport<BenchmarkReport>('bench-between-trials', testBenchmarksDir);
    expect(saved!.arms['muse-wonder-1.0']!.trials).toHaveLength(1);
    expect(saved).toMatchObject({ status: 'failed', comparability: { status: 'violated' } });
  });

  it('cannot claim comparable when source becomes unavailable during an awaited proposal', async () => {
    const sim = createFakeSimulator();
    const originalSource = sim.getSourceBundle;
    const originalExecute = sim.executeExperiment;
    let changed = false;
    sim.getSourceBundle = variant => {
      if (changed) throw new Error('Runtime source changed on disk; restart required before continuing.');
      return originalSource(variant);
    };
    sim.executeExperiment = (experiment, variant) => { sim.getSourceBundle(variant); return originalExecute(experiment, variant); };
    const report = await runBenchmark({
      provider: 'meta', models: ['muse-wonder-1.0'], targets: ['candidate-a'], trials: 1,
      simulator: sim, benchmarksDir: testBenchmarksDir,
      budgetLedger: new BudgetLedger(path.join(testRunsDir, 'ledger.json'), 50),
      providerFactory: (_kind, model) => ({ kind: 'meta', model,
        propose: async (_ctx, _signal, onAudit) => {
          const audit = createFakeRecord('candidate-a', model).proposalAttempts![0]!.request!;
          await onAudit?.(audit);
          await Promise.resolve();
          changed = true;
          return { experiment: { hypothesis: 'Probe', expectedInvariant: 'credit_limit_respected', steps: [] },
            requestAudit: audit, requestSent: true, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } };
        },
      }),
    });
    const trial = report.arms['muse-wonder-1.0']!.trials[0]!;
    expect(trial.record!.sourceHash).toBe('source-hash-candidate-a');
    expect(trial.record!.status).toBe('failed');
    expect(trial.comparabilityStatus).toBe('incomplete');
    expect(report.comparability.status).toBe('incomplete');
    expect(report.comparability.notes.join(' ')).toContain('Current target source identity is unavailable');
  });

  it.each(['source', 'contract'])('detects actual %s identity drift despite unchanged saved context', async identity => {
    const sim = createFakeSimulator();
    const report = await runBenchmark({ provider: 'meta', models: ['muse-wonder-1.0'], targets: ['candidate-a'], trials: 1,
      simulator: sim, benchmarksDir: testBenchmarksDir, budgetLedger: new BudgetLedger(path.join(testRunsDir, 'ledger.json'), 50),
      providerFactory: (_kind, model) => ({ kind: 'meta', model, propose: async () => ({ experiment: null }) }),
      runner: async opts => {
        const rec = createFakeRecord(opts.variant, opts.provider.model);
        if (identity === 'source') sim.getSourceBundle = () => ({ hash: 'changed', files: [] });
        else { const contract = sim.getContract(); sim.getContract = () => ({ ...contract, description: 'changed' }); }
        return rec;
      },
    });
    expect(report.comparability.status).toBe('violated');
    expect(report.comparability.notes.join(' ')).toContain('changed during the trial');
  });

  it('preserves comparability of unchanged input identity after an ordinary provider failure', async () => {
    const report = await runBenchmark({ provider: 'meta', models: ['muse-wonder-1.0'], targets: ['candidate-a'], trials: 1,
      simulator: createFakeSimulator(), benchmarksDir: testBenchmarksDir,
      budgetLedger: new BudgetLedger(path.join(testRunsDir, 'ledger.json'), 50),
      providerFactory: (_kind, model) => ({ kind: 'meta', model, propose: async () => ({ experiment: null }) }),
      runner: async opts => createFakeRecord(opts.variant, opts.provider.model, { status: 'failed', stopReason: 'Network timeout' }),
    });
    expect(report.arms['muse-wonder-1.0']!.trials[0]!.status).toBe('failed');
    expect(report.comparability.status).toBe('comparable');
  });

  it('rejects live model labels on offline scripted arms', async () => {
    await expect(runBenchmark({ provider: 'mock', models: ['muse-wonder-1.0', 'muse-spark-1.3'],
      benchmarksDir: testBenchmarksDir, simulator: createFakeSimulator(),
    })).rejects.toThrow(/single scripted-offline arm/);
  });

  it.each(['runtimeSha256', 'functions', 'promptModule'])('rejects a manifest with missing %s before constructing a provider', async field => {
    const file = path.join(testRunsDir, `missing-${field}.json`);
    const manifest: any = await captureBenchmarkFreeze();
    if (field === 'promptModule') delete manifest.prompt.moduleSha256;
    else delete manifest.baseline[field];
    await fs.writeFile(file, JSON.stringify(manifest));
    const factory = vi.fn();
    await expect(runBenchmark({ provider: 'meta', targets: ['candidate-a'], trials: 1, freezePath: file,
      simulator: createFakeSimulator(), budgetLedger: new BudgetLedger(path.join(testRunsDir, 'ledger.json'), 50),
      benchmarksDir: testBenchmarksDir, providerFactory: factory,
    })).rejects.toThrow(/complete source, runtime, function and prompt identities/);
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([
    ['matching', 'comparable'], ['wrong settings', 'violated'], ['wrong request model', 'violated'],
    ['missing settings', 'incomplete'], ['missing contract', 'incomplete'], ['missing source', 'incomplete'],
  ])('marks %s using observed metadata', async (scenario, expected) => {
    const report = await runBenchmark({
      provider: 'meta', models: ['muse-wonder-1.0'], targets: ['candidate-a'], trials: 1,
      simulator: createFakeSimulator(), benchmarksDir: testBenchmarksDir,
      budgetLedger: new BudgetLedger(path.join(testRunsDir, 'ledger.json'), 50),
      providerFactory: (_kind, model) => ({ kind: 'meta', model, propose: async () => ({ experiment: null }) }),
      runner: async opts => {
        const rec = createFakeRecord(opts.variant, opts.provider.model);
        const config = rec.proposalAttempts![0]!.request!.configuration;
        if (scenario === 'wrong settings') config.reasoningEffort = 'high';
        if (scenario === 'wrong request model') config.model = 'muse-spark-1.3';
        if (scenario === 'missing settings') delete config.requestTimeoutMs;
        if (scenario === 'missing contract') delete rec.contextAudit;
        if (scenario === 'missing source') rec.sourceHash = '';
        return rec;
      },
    });
    expect(report.comparability.status).toBe(expected);
    expect(report.arms['muse-wonder-1.0']!.trials[0]!.comparabilityStatus).toBe(expected);
  });
});
