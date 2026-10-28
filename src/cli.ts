import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { assertAdapterVariant } from './adapters/index.ts';
import { SEEDED_INVENTORY_BRIEF } from './systems/index.ts';
import { replayOutcome } from './web/presentation.ts';
import {
  TARGET_VARIANTS,
  ALL_TARGET_VARIANTS,
  type TargetVariant,
  type ProviderKind,
  type InvestigationOptions,
  type InvestigationRecord,
} from './domain.ts';
import {
  saveRun,
  listRuns,
  replayRun,
  validateRunId,
  normalizeRunInput,
  saveBenchmarkReport,
  getSystemBrief,
  createSystemSnapshot,
} from './storage.ts';
import { runEvaluation } from './evaluation.ts';
import {
  runBenchmark,
  captureBenchmarkFreeze,
  type BenchmarkReport,
} from './benchmark.ts';

const SUPPORTED_PROVIDERS: ProviderKind[] = ['mock', 'meta'];

interface ParsedArgs {
  command?: string;
  provider: ProviderKind;
  target?: TargetVariant;
  targets?: TargetVariant[];
  models?: string[];
  phase?: 'calibration' | 'heldout';
  freeze?: string;
  maxExperiments?: number;
  trials?: number;
  seeds?: number[];
  id?: string;
  continueAfterFindings?: boolean;
  systemId?: string;
  runsDir?: string;
  systemsDir?: string;
  help?: boolean;
}

function parseBoundedInt(val: string, name: string, min: number, max: number): number {
  const trimmed = val.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${name}: "${val}" is not a valid integer.`);
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}: ${n} is outside allowed range [${min}, ${max}].`);
  }
  return n;
}

function parseSeeds(val: string): number[] {
  const parts = val.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new Error(`Invalid --seeds: must specify at least one integer.`);
  }
  const seeds: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) {
      throw new Error(`Invalid seed value "${p}": must be a non-negative integer.`);
    }
    const n = Number(p);
    if (!Number.isSafeInteger(n) || n < 0 || n > 2147483647) {
      throw new Error(`Invalid seed value "${p}": outside allowed range [0, 2147483647].`);
    }
    seeds.push(n);
  }
  return seeds;
}

function parseTargetsList(val: string): TargetVariant[] {
  const parts = val.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new Error(`Invalid --targets: must specify at least one variant.`);
  }
  const targets: TargetVariant[] = [];
  for (const p of parts) {
    if (!(TARGET_VARIANTS as readonly string[]).includes(p)) {
      throw new Error(`Invalid target variant "${p}". Supported variants: ${TARGET_VARIANTS.join(', ')}.`);
    }
    targets.push(p as TargetVariant);
  }
  return targets;
}

function parseModelsList(val: string): string[] {
  const parts = val.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new Error(`Invalid --models: must specify at least one model name.`);
  }
  return parts;
}

function parseCliArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: undefined,
    provider: 'mock',
    // No target default here: the default depends on the resolved system adapter (see handleInvestigate).
  };

  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--provider' || arg.startsWith('--provider=')) {
      const val = arg.startsWith('--provider=') ? arg.slice('--provider='.length) : args[++i];
      if (!val || !SUPPORTED_PROVIDERS.includes(val as ProviderKind)) {
        throw new Error(`Invalid provider: "${val}". Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}.`);
      }
      result.provider = val as ProviderKind;
    } else if (arg === '--target' || arg.startsWith('--target=') || arg === '--variant' || arg.startsWith('--variant=')) {
      const prefix = arg.startsWith('--target=') ? '--target=' : (arg.startsWith('--variant=') ? '--variant=' : null);
      const val = prefix ? arg.slice(prefix.length) : args[++i];
      if (!val || !(ALL_TARGET_VARIANTS as readonly string[]).includes(val)) {
        throw new Error(`Invalid target variant: "${val}". Supported variants: ${ALL_TARGET_VARIANTS.join(', ')}.`);
      }
      result.target = val as TargetVariant;
    } else if (arg === '--targets' || arg.startsWith('--targets=')) {
      const val = arg.startsWith('--targets=') ? arg.slice('--targets='.length) : args[++i];
      if (!val) throw new Error(`Missing value for --targets.`);
      result.targets = parseTargetsList(val);
    } else if (arg === '--models' || arg.startsWith('--models=')) {
      const val = arg.startsWith('--models=') ? arg.slice('--models='.length) : args[++i];
      if (!val) throw new Error(`Missing value for --models.`);
      result.models = parseModelsList(val);
    } else if (arg === '--phase' || arg.startsWith('--phase=')) {
      const val = arg.startsWith('--phase=') ? arg.slice('--phase='.length) : args[++i];
      if (val !== 'calibration' && val !== 'heldout') {
        throw new Error(`Invalid --phase: "${val}". Supported phases: calibration, heldout.`);
      }
      result.phase = val;
    } else if (arg === '--freeze' || arg.startsWith('--freeze=')) {
      const val = arg.startsWith('--freeze=') ? arg.slice('--freeze='.length) : args[++i];
      if (!val) throw new Error(`Missing value for --freeze.`);
      result.freeze = val;
    } else if (arg === '--continue-after-findings') {
      result.continueAfterFindings = true;
    } else if (arg === '--max-experiments' || arg.startsWith('--max-experiments=')) {
      const val = arg.startsWith('--max-experiments=') ? arg.slice('--max-experiments='.length) : args[++i];
      if (!val) throw new Error(`Missing value for --max-experiments.`);
      result.maxExperiments = parseBoundedInt(val, '--max-experiments', 1, 20);
    } else if (arg === '--trials' || arg.startsWith('--trials=')) {
      const val = arg.startsWith('--trials=') ? arg.slice('--trials='.length) : args[++i];
      if (!val) throw new Error(`Missing value for --trials.`);
      result.trials = parseBoundedInt(val, '--trials', 1, 10);
    } else if (arg === '--seeds' || arg.startsWith('--seeds=')) {
      const val = arg.startsWith('--seeds=') ? arg.slice('--seeds='.length) : args[++i];
      if (!val) throw new Error(`Missing value for --seeds.`);
      result.seeds = parseSeeds(val);
    } else if (arg === '--id' || arg.startsWith('--id=')) {
      const val = arg.startsWith('--id=') ? arg.slice('--id='.length) : args[++i];
      if (!val) throw new Error(`Missing value for --id.`);
      result.id = val;
    } else if (arg === '--system-id' || arg.startsWith('--system-id=') || arg === '--system' || arg.startsWith('--system=')) {
      const prefix = arg.startsWith('--system-id=') ? '--system-id=' : (arg.startsWith('--system=') ? '--system=' : null);
      const val = prefix ? arg.slice(prefix.length) : args[++i];
      if (!val) throw new Error(`Missing value for --system-id.`);
      result.systemId = val;
    } else if (arg === '--runs-dir' || arg.startsWith('--runs-dir=') || arg === '--systems-dir' || arg.startsWith('--systems-dir=')) {
      const isRuns = arg.startsWith('--runs-dir');
      const val = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
      if (!val || val.startsWith('--')) throw new Error(`Missing directory for ${arg}`);
      if (isRuns) result.runsDir = val; else result.systemsDir = val;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: "${arg}". Use --help to view supported options.`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 0) {
    result.command = positional[0];
    if (positional.length > 1 && !result.id) {
      result.id = positional[1];
    }
  }

  return result;
}

function printUsage(): void {
  console.log(`
ChaosPilot - Source-Aware Negative Scenario Investigation CLI

Usage:
  node src/cli.ts <command> [options]

Commands:
  inventory-init    Save the default inventory profile (create only)
  investigate       Launch an investigation against a target variant
  evaluate          Compare baseline conventional generator vs provider
  benchmark         Run controlled 3-way benchmarking (Baseline vs Wonder vs Spark)
  benchmark-freeze  Capture baseline and prompt freeze manifest
  replay            Deterministically replay an investigation artifact
  demo              Run mock investigation against candidate-a

Options:
  --provider        Provider kind: 'mock' | 'meta' (default: mock)
  --target          Target variant: ${ALL_TARGET_VARIANTS.join(' | ')} (investigate default: candidate-a for trading, inventory-candidate-a for inventory; evaluate/benchmark default: candidate-a)
  --targets         Comma-separated targets for benchmark (e.g. clean,candidate-a,candidate-b)
  --models          Comma-separated models for benchmark (e.g. muse-wonder-1.0,muse-spark-1.3)
  --phase           Benchmark phase: 'calibration' | 'heldout' (default: calibration)
  --freeze          Path to freeze manifest for benchmark or benchmark-freeze
  --max-experiments Maximum experiments to execute (default: 5 for evaluate, 6 for benchmark)
  --continue-after-findings  Continue after verified findings until bounds/provider stop (default: stop at first finding; extra live proposals may cost more)
  --trials          Number of trials (default: 3 for evaluate, 2 for benchmark)
  --seeds           Comma-separated seeds (e.g. 1001,1002,1003)
  --id              Run artifact ID for replay command or benchmark ID
  --system-id       System brief ID to investigate (default: trading-gateway)
  --runs-dir        Isolated run store (default: runs)
  --systems-dir     System store (default: <runs-dir>/systems)
  Inventory target: clean | inventory-candidate-a | inventory-candidate-b | inventory-candidate-c | inventory-candidate-d; evaluate/benchmark remain trading-only
  --help, -h        Show this help message
`);
}

function defaultTargetForAdapter(adapterId: string): TargetVariant { return adapterId === 'inventory-reservation' ? 'inventory-candidate-a' : 'candidate-a'; }

async function handleInvestigate(args: ParsedArgs): Promise<void> {
  const providerKind = args.provider;
  const maxExperiments = args.maxExperiments ?? 5;

  const systemId = args.systemId || 'trading-gateway';
  const runsDir = args.runsDir ?? 'runs';
  const systemsDir = args.systemsDir ?? path.join(runsDir, 'systems');
  const brief = await getSystemBrief(systemId, systemsDir);
  if (!brief) {
    console.error(`\n[Error] System brief "${systemId}" not found in ${systemsDir}.\n`);
    process.exit(1);
  }
  if (brief.adapterId === 'unconfigured') {
    console.error(`\n[Error] Cannot launch investigation: System brief "${brief.name}" has unconfigured adapter.\n`);
    process.exit(1);
  }
  const target: TargetVariant = args.target ?? defaultTargetForAdapter(brief.adapterId);
  try {
    assertAdapterVariant(brief.adapterId, target);
  } catch (err) {
    console.error(`\n[Error] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }
  const snapshot = await createSystemSnapshot(brief);

  // Clear missing-key error requirement
  if (providerKind === 'meta') {
    const apiKey = process.env.MODEL_API_KEY?.trim();
    if (!apiKey) {
      console.error('\n[Error] Missing required environment variable MODEL_API_KEY for provider "meta".');
      console.error('To run live Meta investigations, set MODEL_API_KEY in your .env file.');
      console.error('To run offline verification without an API key, use: --provider mock\n');
      process.exit(1);
    }
  }

  console.log(`\n============================================================`);
  console.log(` ChaosPilot Investigation`);
  console.log(` System Brief:    ${snapshot.brief.name} (Rev ${snapshot.brief.revision})`);
  console.log(` Brief Hash:      ${snapshot.hash.slice(0, 16)}...`);
  console.log(` Target Variant:  ${target}`);
  console.log(` Provider:        ${providerKind.toUpperCase()}`);
  console.log(` Max Experiments: ${maxExperiments}`);
  console.log(` Continue After Findings: ${args.continueAfterFindings ? 'YES (additional proposals may incur additional live cost)' : 'NO (stop at first verified finding)'}`);
  console.log(` Provenance:      ${providerKind === 'mock' ? 'MOCK (Scripted offline mock; no live model calls)' : 'LIVE (Official Meta API)'}`);
  console.log(`============================================================\n`);

  let runInvestigation: (options: InvestigationOptions) => Promise<InvestigationRecord>;
  let createProvider: (kind: ProviderKind) => any;

  try {
    const invModule = await import('./investigation/index.ts');
    runInvestigation = invModule.runInvestigation;
    const provModule = await import('./providers/index.ts');
    createProvider = provModule.createProvider;
  } catch (err) {
    console.error('[Error] Investigation engine dependencies not yet available:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const provider = createProvider(providerKind);
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const abortController = new AbortController();
  let latestRecord: InvestigationRecord | null = null;

  const sigintHandler = async () => {
    console.log('\n\n[Ctrl+C] Investigation interrupted. Preserving prior evidence...');
    abortController.abort();
    if (latestRecord) {
      latestRecord.status = 'cancelled';
      latestRecord.stopReason = 'Interrupted by SIGINT';
      latestRecord.finishedAt = new Date().toISOString();
      try {
        await saveRun(latestRecord, runsDir);
        console.log(`Saved partial investigation artifact to runs/${latestRecord.id}.json`);
      } catch (err) {
        console.error('Failed to save partial run on SIGINT:', err);
      }
    }
    process.exit(130);
  };
  process.on('SIGINT', sigintHandler);

  console.log(`[1/3] Initializing investigation run ${runId}...`);
  let record: InvestigationRecord;

  try {
    record = await runInvestigation({
      id: runId,
      variant: target,
      maxExperiments,
      continueAfterFindings: args.continueAfterFindings === true,
      provider,
      systemBrief: structuredClone(snapshot),
      signal: abortController.signal,
      onUpdate: async (rec) => {
        latestRecord = rec;
        try {
          await saveRun(rec, runsDir);
        } catch {
          // Ignore transient save errors during active streaming
        }
        const expCount = rec.experiments.length;
        const findingsCount = rec.findings.length;
        process.stdout.write(`\r[2/3] Executing experiments... Progress: ${expCount}/${maxExperiments} experiments | ${findingsCount} findings confirmed`);
      },
    });
  } finally {
    process.removeListener('SIGINT', sigintHandler);
  }

  console.log(`\n[3/3] Saving final investigation artifact...`);
  const savedPath = await saveRun(record, runsDir);

  console.log(`\n============================================================`);
  console.log(` Investigation Summary`);
  console.log(`============================================================`);
  console.log(` Run ID:         ${record.id}`);
  console.log(` Status:         ${record.status.toUpperCase()}`);
  console.log(` Target:         ${record.variant}`);
  if (record.systemBrief) {
    console.log(` System Brief:   ${record.systemBrief.brief.name} (Rev ${record.systemBrief.brief.revision})`);
    console.log(` Brief Hash:     ${record.systemBrief.hash}`);
  } else {
    console.log(` System Brief:   None (legacy / direct run)`);
  }
  console.log(` Provider:       ${record.provider} (${record.model})`);
  console.log(` Mode:           ${record.mode.toUpperCase()}`);
  console.log(` Source Hash:    ${record.sourceHash}`);
  console.log(` Experiments:    ${record.experiments.length}`);
  console.log(` Findings Found: ${record.findings.length}`);
  console.log(` Artifact Path:  ${savedPath}`);

  if (record.usage) {
    console.log(` Token Usage:    In: ${record.usage.inputTokens} | Out: ${record.usage.outputTokens} | Cost: $${(record.usage.estimatedCostUsd || 0).toFixed(4)}`);
  }

  if (record.findings.length > 0) {
    console.log(`\n--- Confirmed Findings ---`);
    for (let i = 0; i < record.findings.length; i++) {
      const f = record.findings[i]!;
      console.log(`[Finding ${i + 1}] ${f.title}`);
      console.log(`  Invariant: ${f.violation.invariant}`);
      if (f.category ?? f.violation.category) console.log(`  Category:  ${f.category ?? f.violation.category}`);
      console.log(`  Message:   ${f.violation.message}`);
      console.log(`  Clean Control Passed: ${f.cleanControlPassed ? 'YES (Defect absent on clean)' : 'NO'}`);
      console.log(`  Replay Verified:      ${f.reproduced ? 'YES (Deterministic match)' : 'NO'}`);
    }
  } else {
    console.log(`\nNo reproducible invariant violations found under current bounds.`);
    console.log(`Note: Non-finding on exhaustion does NOT prove code correctness.`);
  }

  if (record.status === 'failed') {
    process.exitCode = 1;
  }

  console.log(`============================================================\n`);
}

async function handleEvaluate(args: ParsedArgs): Promise<void> {
  if (args.systemId && args.systemId !== 'trading-gateway') throw new Error('Comparative evaluation is trading-only');
  const providerKind = args.provider;
  const target: TargetVariant = args.target ?? 'candidate-a';
  assertAdapterVariant('synthetic-trading', target);
  const maxExperiments = args.maxExperiments ?? 5;
  const trials = args.trials ?? 3;

  if (providerKind === 'meta' && !process.env.MODEL_API_KEY?.trim()) {
    console.error('\n[Error] Missing required environment variable MODEL_API_KEY for provider "meta".');
    console.error('Use --provider mock for offline comparative evaluation.\n');
    process.exit(1);
  }

  console.log(`\n============================================================`);
  console.log(` ChaosPilot Comparative Evaluation`);
  console.log(` Comparing Conventional Baseline vs ${providerKind.toUpperCase()} Provider`);
  console.log(` Target: ${target} | Equal Limits: ${maxExperiments} experiments/trial | Trials: ${trials}`);
  console.log(` Provenance: ${providerKind === 'mock' ? 'MOCK (Scripted; does not imply autonomous discovery)' : 'LIVE Meta'}`);
  console.log(`============================================================\n`);

  const report = await runEvaluation({
    variant: target,
    provider: providerKind,
    maxExperiments,
    trials,
    seeds: args.seeds,
  });

  // Save evaluation report
  const evalDir = 'runs';
  await fs.mkdir(evalDir, { recursive: true });
  const evalPath = path.join(evalDir, `${report.id}.json`);
  await fs.writeFile(evalPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(`Evaluation Results Summary:`);
  console.log(`------------------------------------------------------------`);
  console.log(`  Baseline Total Experiments: ${report.baseline.totalExperiments}`);
  console.log(`  Baseline Valid Plans:       ${report.baseline.validPlans}`);
  console.log(`  Baseline Invalid Plans:     ${report.baseline.invalidPlans}`);
  console.log(`  Baseline Discovery Rate:    ${(report.comparison.baselineDiscoveryRate * 100).toFixed(1)}%`);
  console.log(`  Baseline Invariants Found:  ${report.baseline.uniqueInvariantsFound.join(', ') || 'None'}`);
  console.log(`------------------------------------------------------------`);
  console.log(`  Provider Total Experiments: ${report.provider.totalExperiments}`);
  console.log(`  Provider Valid Plans:       ${report.provider.validPlans}`);
  console.log(`  Provider Invalid Plans:     ${report.provider.invalidPlans}`);
  console.log(`  Provider Discovery Rate:    ${(report.comparison.providerDiscoveryRate * 100).toFixed(1)}%`);
  console.log(`  Provider Invariants Found:  ${report.provider.uniqueInvariantsFound.join(', ') || 'None'}`);
  console.log(`------------------------------------------------------------`);
  console.log(`  Report Saved To:            ${evalPath}`);
  console.log(`  Provenance Note:            ${report.comparison.efficiencyNotes}`);
  console.log(`============================================================\n`);
}

async function handleReplay(args: ParsedArgs): Promise<void> {
  const runsDir = args.runsDir ?? 'runs';
  let rawTarget = args.id;
  if (!rawTarget) {
    const runs = await listRuns(runsDir);
    if (runs.length === 0) {
      console.log('No saved runs found in runs/ directory to replay.');
      return;
    }
    rawTarget = runs[0]!.id;
    console.log(`No run ID specified; defaulting to latest run: ${rawTarget}`);
  }

  const runId = normalizeRunInput(rawTarget, runsDir);
  if (!runId || !validateRunId(runId)) {
    console.error(`[Error] Invalid run ID or path: "${rawTarget}"`);
    process.exit(1);
  }

  console.log(`\n============================================================`);
  console.log(` ChaosPilot Deterministic Replay`);
  console.log(` Replaying Run: ${runId}`);
  console.log(` Replay Mechanism: Deterministic simulator only (NO model calls)`);
  console.log(`============================================================\n`);

  try {
    const report = await replayRun(runId, runsDir);
    console.log(`Replay Report:`);
    console.log(`  Variant:                    ${report.variant}`);
    console.log(`  Original Source Hash:       ${report.originalSourceHash}`);
    console.log(`  Current Source Hash:        ${report.currentSourceHash}`);
    console.log(`  Source Identical:           ${report.sourceIdentical ? 'YES' : 'NO (Source diverged!)'}`);
    console.log(`  Exact Reproduction Claimed: ${report.exactReproductionClaimed ? 'YES' : 'NO'}`);
    console.log(`  Experiments Reproduced:     ${report.experimentsReproduced}/${report.experimentsTotal}`);
    const outcome = replayOutcome(report);
    const status = outcome === 'reproduced' ? 'REPRODUCED'
      : outcome === 'unconfirmed' ? 'EXPERIMENTS MATCHED; EXACT REPLAY UNCONFIRMED'
      : outcome === 'empty' ? 'NO EXPERIMENTS REPLAYED' : 'MISMATCH';
    console.log(`  Replay Status:              ${status}`);
    console.log(`  Note:                       ${report.note}`);
    console.log(`============================================================\n`);

    if (!report.reproduced || !report.exactReproductionClaimed) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`[Error] Replay failed:`, err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

async function handleBenchmark(args: ParsedArgs): Promise<void> {
  if (args.systemId && args.systemId !== 'trading-gateway') throw new Error('Benchmark is trading-only');
  if (args.target !== undefined) assertAdapterVariant('synthetic-trading', args.target);
  if (args.targets !== undefined) for (const t of args.targets) assertAdapterVariant('synthetic-trading', t);
  const providerKind = args.provider;
  const phase = args.phase || 'calibration';

  if (providerKind === 'meta' && !process.env.MODEL_API_KEY?.trim()) {
    console.error('\n[Error] Missing required environment variable MODEL_API_KEY for provider "meta".');
    console.error('Use --provider mock for offline controlled benchmarking.\n');
    process.exit(1);
  }

  const trials = args.trials ?? 2;
  const maxExperiments = args.maxExperiments ?? 6;

  console.log(`\n============================================================`);
  console.log(` ChaosPilot Controlled Three-Way Benchmark`);
  console.log(` Phase:          ${phase.toUpperCase()}`);
  console.log(` Provider:       ${providerKind.toUpperCase()}`);
  console.log(` Models:         ${args.models?.join(', ') || (providerKind === 'meta' ? 'muse-wonder-1.0, muse-spark-1.3' : 'scripted-offline')}`);
  console.log(` Targets:        ${args.targets?.join(', ') || (phase === 'calibration' ? 'clean, candidate-a, candidate-b' : 'unspecified')}`);
  console.log(` Trials:         ${trials} | Max Experiments: ${maxExperiments}`);
  console.log(` Freeze Path:    ${args.freeze || 'none'}`);
  console.log(` Provenance:     ${providerKind === 'mock' ? 'MOCK (Scripted offline arm; does NOT imply autonomous discovery)' : 'LIVE Meta (Official API)'}`);
  console.log(`============================================================\n`);

  const abortController = new AbortController();
  let latestReport: BenchmarkReport | null = null;

  const sigintHandler = async () => {
    console.log('\n\n[Ctrl+C] Benchmark interrupted. Preserving prior evidence...');
    abortController.abort();
    if (latestReport) {
      latestReport.status = 'cancelled';
      latestReport.stopReason = 'Interrupted by SIGINT';
      try {
        await saveBenchmarkReport(latestReport);
        console.log(`Saved partial benchmark artifact to runs/benchmarks/${latestReport.id}.json`);
      } catch (err) {
        console.error('Failed to save partial benchmark on SIGINT:', err);
      }
    }
    process.exit(130);
  };
  process.on('SIGINT', sigintHandler);

  let report: BenchmarkReport;
  try {
    report = await runBenchmark({
      id: args.id,
      phase,
      targets: args.targets,
      models: args.models,
      provider: providerKind,
      trials,
      maxExperiments,
      seeds: args.seeds,
      freezePath: args.freeze,
      signal: abortController.signal,
      onUpdate: (r) => {
        latestReport = r;
      },
    });
  } catch (err) {
    console.error(`\n[Benchmark Error] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  } finally {
    process.removeListener('SIGINT', sigintHandler);
  }

  console.log(`\n============================================================`);
  console.log(` Benchmark Execution Completed`);
  console.log(` Benchmark ID:   ${report.id}`);
  console.log(` Status:         ${report.status.toUpperCase()}`);
  console.log(` Baseline Trials: ${report.baseline.totalTrials} (Discoveries: ${report.baseline.trialsWithDiscoveries})`);

  for (const [m, arm] of Object.entries(report.arms)) {
    console.log(` Arm [${m}]:`);
    console.log(`   Trials: ${arm.summary.totalTrials} (Completed: ${arm.summary.completedTrials}, Findings: ${arm.summary.trialsWithFindings})`);
    console.log(`   Verified Invariants: ${arm.summary.uniqueVerifiedInvariants.join(', ') || 'None'}`);
    console.log(`   Raw Invariants:      ${arm.summary.uniqueRawInvariantsViolated.join(', ') || 'None'}`);
    console.log(`   Total Calls:         ${arm.summary.totalProviderCalls} (Confirmed net: ${arm.summary.totalConfirmedNetworkRequests})`);
    console.log(`   Tokens:              In: ${arm.summary.totalUsage.inputTokens} | Out: ${arm.summary.totalUsage.outputTokens} | Cost: $${arm.summary.totalUsage.estimatedCostUsd.toFixed(4)}`);
  }

  console.log(` Comparability:  ${report.comparability.status.toUpperCase()}`);
  if (report.comparability.notes.length > 0) {
    for (const note of report.comparability.notes) {
      console.log(`   * ${note}`);
    }
  }
  console.log(` Artifact Path:  runs/benchmarks/${report.id}.json`);
  console.log(`============================================================\n`);

  if (report.status === 'failed') {
    process.exitCode = 1;
  }
}

async function handleBenchmarkFreeze(args: ParsedArgs): Promise<void> {
  const freezePath = args.freeze || 'runs/freeze-manifest.json';
  console.log(`\n============================================================`);
  console.log(` Capturing Benchmark Freeze Manifest`);
  console.log(` Destination: ${freezePath}`);
  console.log(`============================================================\n`);

  try {
    const manifest = await captureBenchmarkFreeze(freezePath);
    console.log(`Freeze manifest captured:`);
    console.log(`  Baseline file:           ${manifest.baseline.file}`);
    console.log(`  Baseline SHA-256:        ${manifest.baseline.sha256}`);
    console.log(`  Prompt Version:          ${manifest.prompt.version}`);
    console.log(`  Prompt Template SHA-256: ${manifest.prompt.templateHash}`);
    console.log(`\nSuccessfully written to: ${freezePath}\n`);
  } catch (err) {
    console.error(`\n[Error] Failed to capture benchmark freeze: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    console.error(`\n[CLI Error] ${err instanceof Error ? err.message : String(err)}\n`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (args.help || !args.command) {
    printUsage();
    return;
  }

  try {
  switch (args.command.toLowerCase()) {
    case 'inventory-init': {
      const systemsDir = args.systemsDir ?? path.join(args.runsDir ?? 'runs', 'systems');
      const saved = await getSystemBrief(SEEDED_INVENTORY_BRIEF.id, systemsDir);
      if (!saved) throw new Error('Failed to seed inventory system');
      console.log(`Saved inventory system ${saved.id} in ${systemsDir}`);
      break;
    }
    case 'investigate':
    case 'demo':
      await handleInvestigate(args);
      break;
    case 'evaluate':
      await handleEvaluate(args);
      break;
    case 'replay':
      await handleReplay(args);
      break;
    case 'benchmark':
      await handleBenchmark(args);
      break;
    case 'benchmark-freeze':
      await handleBenchmarkFreeze(args);
      break;
    default:
      console.error(`Unknown command: ${args.command}`);
      printUsage();
      process.exitCode = 1;
  }
  } catch (err) {
    console.error(`\n[CLI Error] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

// Execute main if invoked directly
if (process.argv[1] && (process.argv[1].endsWith('cli.ts') || process.argv[1].endsWith('cli.js'))) {
  main().catch((err) => {
    console.error('Fatal CLI Error:', err);
    process.exit(1);
  });
}
