import { describe, expect, it } from 'vitest';
import type { ExperimentResult, Violation } from '../src/domain.ts';
import { isRecoveryDeadlineCleanControlConfirmed, runInvestigation } from '../src/investigation/index.ts';
import { buildInvestigationPrompt, getPromptIdentity } from '../src/investigation/prompt.ts';
import {
  RECOVERY_PROMPT_TEMPLATE_HASH,
  RECOVERY_PROMPT_VERSION,
  RECOVERY_SYSTEM_PROMPT,
} from '../src/investigation/recovery-prompt.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { recoveryProposal } from '../src/providers/recovery-mock.ts';
import * as recovery from '../src/recovery/index.ts';
import { SEEDED_RECOVERY_BRIEF, createSystemSnapshot } from '../src/systems/index.ts';
import type { SimulatorApi } from '../src/storage.ts';

describe('Recovery investigation and clean-control confirmation', () => {
  it('exposes deterministic recovery prompt identity', () => {
    const identity = getPromptIdentity('synthetic-trading-recovery');
    expect(identity.promptVersion).toBe(RECOVERY_PROMPT_VERSION);
    expect(identity.systemMessage).toBe(RECOVERY_SYSTEM_PROMPT);
    expect(identity.promptTemplateHash).toBe(RECOVERY_PROMPT_TEMPLATE_HASH);
    expect(RECOVERY_PROMPT_TEMPLATE_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it('builds a neutral recovery investigation prompt with contract and source bundle', async () => {
    const snapshot = await createSystemSnapshot(structuredClone(SEEDED_RECOVERY_BRIEF));
    const bundle = recovery.getSourceBundle('recovery-candidate-a');
    const built = buildInvestigationPrompt({
      contract: recovery.getContract(),
      source: bundle,
      history: [],
      experimentNumber: 1,
      maxExperiments: 2,
      systemBrief: snapshot,
    });

    expect(getPromptIdentity('synthetic-trading-recovery').promptVersion).toBe(RECOVERY_PROMPT_VERSION);
    expect(built.systemMessage).toBe(RECOVERY_SYSTEM_PROMPT);
    // Contract name/adapter context and neutral bundle paths are model-visible.
    expect(built.userMessage).toContain('recovery-component.ts');
    expect(built.userMessage).toContain('recovery_deadline');
    expect(built.userMessage).not.toContain('recovery-candidate-a');
    expect(built.userMessage).not.toContain('BUG');
    expect(built.systemMessage).not.toContain('recovery-candidate-a');
  });

  it('provides scripted offline recovery mock proposals for zero-based rounds 0 and 1 and returns null after', () => {
    const r0 = recoveryProposal(0);
    expect(r0).not.toBeNull();
    expect(r0!.steps.some((s) => s.op === 'disconnect')).toBe(true);
    expect(r0!.steps.some((s) => s.op === 'reconnect')).toBe(true);
    expect(r0!.hypothesis).toContain('[Scripted Offline Recovery]');
    const r1 = recoveryProposal(1);
    expect(r1).not.toBeNull();
    expect(r1!.steps.some((s) => s.op === 'duplicate')).toBe(true);
    expect(recoveryProposal(2)).toBeNull();
  });

  it('confirms a recovery_deadline finding on recovery-candidate-a with positive clean control', async () => {
    const systemBrief = await createSystemSnapshot(structuredClone(SEEDED_RECOVERY_BRIEF));
    const record = await runInvestigation({
      variant: 'recovery-candidate-a',
      systemBrief,
      provider: new MockProvider(),
    });

    expect(record.status).toBe('completed');
    expect(record.variant).toBe('recovery-candidate-a');
    expect(record.contextAudit.adapterId).toBe('synthetic-trading-recovery');
    expect(record.contextAudit.promptVersion).toBe(RECOVERY_PROMPT_VERSION);
    expect(record.contextAudit.promptTemplateHash).toBe(RECOVERY_PROMPT_TEMPLATE_HASH);
    expect(record.proposalAttempts?.every((a) => a.requestSent === false)).toBe(true);

    expect(record.findings).toHaveLength(1);
    const finding = record.findings[0]!;
    expect(finding.category).toBe('recovery_deadline');
    expect(finding.violation.invariant).toBe('recovery_deadline');
    expect(finding.reproduced).toBe(true);
    expect(finding.cleanControlPassed).toBe(true);
    // Finding.replay is the saved reproduction plan (the confirmed experiment).
    expect(finding.replay.steps.length).toBeGreaterThan(0);
    expect(finding.replay).toEqual(record.experiments[finding.experimentIndex - 1]?.experiment ?? record.experiments[0]?.experiment);
    const expRecord = record.experiments[0]!;
    expect(expRecord.replayVerified).toBe(true);
    expect(expRecord.cleanControlPassed).toBe(true);

    const primaryResult = record.experiments[0]?.result;
    expect(primaryResult?.recovery?.status).toBe('failed');
    expect(primaryResult?.recovery?.obligations[0]?.deadlineMissed).toBe(true);
  });

  it('completes a clean recovery investigation with zero findings and passed recovery evidence', async () => {
    const systemBrief = await createSystemSnapshot(structuredClone(SEEDED_RECOVERY_BRIEF));
    const record = await runInvestigation({
      variant: 'clean',
      systemBrief,
      provider: new MockProvider(),
    });

    expect(record.status).toBe('completed');
    expect(record.findings).toEqual([]);
    expect(record.experiments.length).toBeGreaterThanOrEqual(1);
    for (const exp of record.experiments) {
      expect(exp.result.valid).toBe(true);
      expect(exp.result.violations).toEqual([]);
      expect(exp.result.recovery?.status).toBe('passed');
    }
  });

  it('requires positive on-time reconciliation on clean control before confirming recovery_deadline', async () => {
    const proposal = recoveryProposal(0);
    expect(proposal).not.toBeNull();
    const plan = recovery.parseExperiment(proposal!);
    const faultyResult = recovery.executeExperiment(plan, 'recovery-candidate-a');
    const cleanResult = recovery.executeExperiment(plan, 'clean');
    const deadlineViolation = faultyResult.violations.find(
      (v) => v.invariant === 'recovery_deadline',
    ) as Violation;
    expect(deadlineViolation).toBeDefined();
    // Sanity: clean actually exercised and passed the obligation.
    expect(cleanResult.recovery?.status).toBe('passed');
    expect(cleanResult.recovery?.obligations[0]?.completionTick).toBeDefined();
    expect(cleanResult.recovery?.obligations[0]?.observed).toEqual(
      cleanResult.recovery?.obligations[0]?.expected,
    );

    // Positive clean control passes: (violation, targetResult, cleanResult).
    expect(isRecoveryDeadlineCleanControlConfirmed(deadlineViolation, faultyResult, cleanResult)).toBe(true);

    // Missing clean result / missing recovery evidence fails.
    expect(isRecoveryDeadlineCleanControlConfirmed(deadlineViolation, faultyResult, undefined)).toBe(false);
    const withoutRecovery: ExperimentResult = { ...structuredClone(cleanResult), recovery: undefined };
    expect(isRecoveryDeadlineCleanControlConfirmed(deadlineViolation, faultyResult, withoutRecovery)).toBe(false);

    // Valid clean result that never exercised the matching obligation fails.
    const notExercised = structuredClone(cleanResult);
    notExercised.recovery!.status = 'not-exercised';
    notExercised.recovery!.obligations = [];
    expect(isRecoveryDeadlineCleanControlConfirmed(deadlineViolation, faultyResult, notExercised)).toBe(false);
    // Even with status forged to passed, absence of the matching key fails.
    const passedButNoObligation = structuredClone(cleanResult);
    passedButNoObligation.recovery!.obligations = [];
    expect(isRecoveryDeadlineCleanControlConfirmed(deadlineViolation, faultyResult, passedButNoObligation)).toBe(false);

    // Inconclusive clean control fails.
    const inconclusive = structuredClone(cleanResult);
    inconclusive.recovery!.status = 'inconclusive';
    expect(isRecoveryDeadlineCleanControlConfirmed(deadlineViolation, faultyResult, inconclusive)).toBe(false);

    // Clean control completed after the inclusive deadline fails.
    const lateReconcile = structuredClone(cleanResult);
    lateReconcile.recovery!.obligations[0]!.completionTick =
      lateReconcile.recovery!.obligations[0]!.deadlineTick! + 1;
    expect(isRecoveryDeadlineCleanControlConfirmed(deadlineViolation, faultyResult, lateReconcile)).toBe(false);

    // Clean control whose observed credit facts disagree with expected fails.
    const mismatchedFacts = structuredClone(cleanResult);
    mismatchedFacts.recovery!.obligations[0]!.observed!.reservedCredit = 999_999;
    expect(isRecoveryDeadlineCleanControlConfirmed(deadlineViolation, faultyResult, mismatchedFacts)).toBe(false);

    // Clean control whose obligation identity/report does not match fails.
    const wrongOrder = structuredClone(cleanResult);
    wrongOrder.recovery!.obligations[0]!.report.orderId = 'OTHER';
    expect(isRecoveryDeadlineCleanControlConfirmed(deadlineViolation, faultyResult, wrongOrder)).toBe(false);
    const wrongKey = structuredClone(cleanResult);
    wrongKey.recovery!.obligations[0]!.key = '["OTHER","exec-x"]';
    expect(isRecoveryDeadlineCleanControlConfirmed(deadlineViolation, faultyResult, wrongKey)).toBe(false);

    // Clean that also missed the deadline fails.
    expect(isRecoveryDeadlineCleanControlConfirmed(deadlineViolation, faultyResult, faultyResult)).toBe(false);
  });

  const inconsistentControls: Array<[string, (target: ExperimentResult, clean: ExperimentResult) => void]> = [
    ['missing producer identity', (_target, clean) => { Reflect.deleteProperty(clean.recovery!, 'evaluator'); }],
    ['unknown producer identity', (_target, clean) => { clean.recovery!.evaluator.version++; }],
    ['unknown evidence schema', (_target, clean) => { Reflect.set(clean.recovery!, 'schemaVersion', 2); }],
    ['incomplete control result', (_target, clean) => { clean.executionComplete = false; }],
    ['unobserved completion', (_target, clean) => { clean.recovery!.horizonTick = 0; }],
    ['different acceptance tick', (_target, clean) => { clean.recovery!.obligations[0]!.acceptedTick++; }],
    ['different reconnect tick', (_target, clean) => { clean.recovery!.obligations[0]!.reconnectTick!++; }],
    ['different deadline tick', (_target, clean) => { clean.recovery!.obligations[0]!.deadlineTick!++; }],
    ['contradictory target verdict', (target) => { target.recovery!.obligations[0]!.deadlineMissed = false; }],
  ];
  it.each(inconsistentControls)('rejects inconsistent recovery confirmation: %s', (_name, mutate) => {
    const plan = recovery.parseExperiment(recoveryProposal(0)!);
    const target = recovery.executeExperiment(plan, 'recovery-candidate-a');
    const clean = recovery.executeExperiment(plan, 'clean');
    const violation = target.violations.find(v => v.invariant === 'recovery_deadline')!;
    expect(isRecoveryDeadlineCleanControlConfirmed(violation, target, clean)).toBe(true);
    mutate(target, clean);
    expect(isRecoveryDeadlineCleanControlConfirmed(violation, target, clean)).toBe(false);
  });

  it('refuses to confirm a finding in runInvestigation when clean control does not exercise recovery', async () => {
    const systemBrief = await createSystemSnapshot(structuredClone(SEEDED_RECOVERY_BRIEF));
    const simulator: SimulatorApi & { parseExperiment: typeof recovery.parseExperiment } = {
      getContract: () => recovery.getContract(),
      getSourceBundle: (v) => recovery.getSourceBundle(v),
      parseExperiment: recovery.parseExperiment,
      executeExperiment: (experiment, variant) => {
        const res = recovery.executeExperiment(experiment, variant);
        if (variant === 'clean' && res.recovery) {
          return {
            ...res,
            recovery: {
              ...res.recovery,
              status: 'not-exercised',
              obligations: [],
            },
          };
        }
        return res;
      },
    };

    const record = await runInvestigation({
      variant: 'recovery-candidate-a',
      systemBrief,
      provider: new MockProvider(),
      maxExperiments: 1,
      simulator,
    });

    expect(record.findings).toEqual([]);
  });

  it('rejects cross-adapter variants for trading-recovery', async () => {
    const systemBrief = await createSystemSnapshot(structuredClone(SEEDED_RECOVERY_BRIEF));
    await expect(
      runInvestigation({
        variant: 'candidate-a',
        systemBrief,
        provider: new MockProvider(),
      }),
    ).rejects.toThrow(/Unsupported variant "candidate-a" for adapter "synthetic-trading-recovery"/);
  });
});
