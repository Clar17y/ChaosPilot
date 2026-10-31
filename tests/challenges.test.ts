import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHALLENGE_LIMITS, challengeFinding, classifyVariant, getChallengeView, parseChallengeProposals, prepareChallenge, truncateUtf8Preview } from '../src/challenges/index.ts';
import { readChallenges, readChallengeSource } from '../src/challenges/storage.ts';
import { deleteRun, getRunRevision, saveRun } from '../src/storage.ts';
import { resolveAdapter } from '../src/adapters/index.ts';
import type { ChallengeBinding, ChallengeProposal } from '../src/challenges/types.ts';
import type { ExperimentResult, Violation } from '../src/domain.ts';
import { challengeFixture, deferred, fakeTransport, originalExperiment, proposalFor, tempChallengeDir, usage } from './challenge-fixtures.ts';

const dirs: string[] = [];
async function setup(inventory = false) {
  const dir = await tempChallengeDir(); dirs.push(dir);
  const record = await challengeFixture(inventory); await saveRun(record, dir);
  return { dir, record, findingId: record.findings[0]!.id };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });

describe('authentic saved challenge evidence', () => {
  it.each([false, true])('executes fresh candidate, replay and clean for actual adapter inventory=%s; reload retains evidence', async inventory => {
    const { dir, record, findingId } = await setup(inventory);
    const fake = fakeTransport(record);
    const before = JSON.stringify(record);
    const result = await challengeFinding(record.id, findingId, { runsDir: dir, transport: fake.transport });
    expect(result.status).toBe('completed'); expect(fake.calls).toHaveLength(2);
    const variant = result.variants[0]!;
    expect(variant.reproduced).toBe(true); expect(variant.sameInvariant).toBe('observed');
    expect(variant.replayStatus).toBe('matched'); expect(variant.cleanStatus).toBe('passed');
    expect(variant.candidate!.trace.length).toBeGreaterThan(0); expect(variant.clean!.sourceHash).toBe(record.contextAudit.cleanSourceHash);
    expect(variant.candidate).not.toBe(variant.replay); expect(variant.changes.length).toBe(1);
    expect(result.interpretation.text).toContain('<script>'); expect(result.requests.every(r => r.usageKnown)).toBe(true);
    expect((await getChallengeView(record.id, findingId, dir)).current).toEqual(result);
    expect(JSON.stringify((await readChallengeSource(record.id, dir)).record)).toBe(before);
  });

  it('accepts legacy provenance only when recorded contract, source and clean source are still verifiable', async () => {
    const { dir, record, findingId } = await setup(); delete record.systemBrief;
    await saveRun(record, dir);
    expect((await getChallengeView(record.id, findingId, dir)).available).toBe(true);
    delete record.contextAudit.cleanSourceHash; await saveRun(record, dir);
    const view = await getChallengeView(record.id, findingId, dir);
    expect(view.available).toBe(false); expect(view.reason).toMatch(/clean-source/);
  });

  it.each(['running', 'ambiguous-finding', 'ambiguous-experiment', 'missing-experiment', 'source', 'clean-source', 'contract', 'unconfirmed', 'wrong-violation', 'adapter'] as const)('blocks %s before any model work', async kind => {
    const { dir, record, findingId } = await setup();
    if (kind === 'running') record.status = 'running';
    if (kind === 'ambiguous-finding') record.findings.push(structuredClone(record.findings[0]!));
    if (kind === 'ambiguous-experiment') record.experiments.push(structuredClone(record.experiments.find(e => e.index === record.findings[0]!.experimentIndex)!));
    if (kind === 'missing-experiment') record.findings[0]!.experimentIndex = 9999;
    if (kind === 'source') record.sourceHash = 'wrong';
    if (kind === 'clean-source') record.contextAudit.cleanSourceHash = 'wrong';
    if (kind === 'contract') record.contextAudit.contractHash = 'wrong';
    if (kind === 'unconfirmed') record.findings[0]!.reproduced = false;
    if (kind === 'wrong-violation') record.findings[0]!.violation.message += 'not the observed violation';
    if (kind === 'adapter') record.contextAudit.adapterId = 'inventory-reservation';
    await saveRun(record, dir);
    const fake = fakeTransport(record);
    await expect(challengeFinding(record.id, findingId, { runsDir: dir, transport: fake.transport })).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });

  it('preserves earlier completed evidence if a later proposal fails', async () => {
    const { dir, record, findingId } = await setup();
    const first = await challengeFinding(record.id, findingId, { runsDir: dir, transport: fakeTransport(record).transport });
    const second = await challengeFinding(record.id, findingId, { runsDir: dir, transport: { generate: async () => ({ content: '{"variants":[]}', usage }) } });
    expect(second.status).toBe('failed');
    const saved = await readChallenges(record.id, findingId, dir);
    expect(saved.current?.id).toBe(first.id); expect(saved.latestAttempt?.id).toBe(second.id);
  });

  it('retains partial evidence from cancelled attempt when there is no prior completed result and subsequent attempt fails', async () => {
    const { dir, record, findingId } = await setup(true);
    const adapter = resolveAdapter('inventory-reservation'); const execute = adapter.executeExperiment;
    const controller = new AbortController(); let executions = 0; const fake = fakeTransport(record);
    vi.spyOn(adapter, 'executeExperiment').mockImplementation((experiment, variant) => {
      const result = execute(experiment, variant);
      if (experiment.hypothesis.startsWith('challenge-variant') && ++executions === 1) controller.abort();
      return result;
    });
    const first = await challengeFinding(record.id, findingId, { runsDir: dir, transport: fake.transport, signal: controller.signal });
    expect(first.status).toBe('cancelled');
    expect(first.variants[0]!.candidate!.trace.length).toBeGreaterThan(0);

    const second = await challengeFinding(record.id, findingId, { runsDir: dir, transport: { generate: async () => ({ content: '{"variants":[]}', usage }) } });
    expect(second.status).toBe('failed');
    expect(second.variants).toHaveLength(0);

    const saved = await readChallenges(record.id, findingId, dir);
    expect(saved.current?.id).toBe(first.id);
    expect(saved.current?.variants[0]!.candidate!.trace.length).toBeGreaterThan(0);
    expect(saved.latestAttempt?.id).toBe(second.id);
  });

  it('preserves both completed and subsequent partial/cancelled evidence when a third attempt fails with no variants', async () => {
    const { dir, record, findingId } = await setup(true);
    // 1. Completed attempt
    const first = await challengeFinding(record.id, findingId, { runsDir: dir, transport: fakeTransport(record).transport });
    expect(first.status).toBe('completed');

    // 2. Cancelled attempt with traces
    const adapter = resolveAdapter('inventory-reservation'); const execute = adapter.executeExperiment;
    const controller = new AbortController(); let executions = 0;
    vi.spyOn(adapter, 'executeExperiment').mockImplementation((experiment, variant) => {
      const result = execute(experiment, variant);
      if (experiment.hypothesis.startsWith('challenge-variant') && ++executions === 1) controller.abort();
      return result;
    });
    const second = await challengeFinding(record.id, findingId, { runsDir: dir, transport: fakeTransport(record).transport, signal: controller.signal });
    expect(second.status).toBe('cancelled');
    expect(second.variants[0]!.candidate!.trace.length).toBeGreaterThan(0);

    // 3. Third attempt fails with no variants
    const third = await challengeFinding(record.id, findingId, { runsDir: dir, transport: { generate: async () => ({ content: '{"variants":[]}', usage }) } });
    expect(third.status).toBe('failed');
    expect(third.variants).toHaveLength(0);

    const saved = await readChallenges(record.id, findingId, dir);
    expect(saved.current?.id).toBe(first.id);
    expect(saved.latestPartial?.id).toBe(second.id);
    expect(saved.latestPartial?.variants[0]!.candidate!.trace.length).toBeGreaterThan(0);
    expect(saved.latestAttempt?.id).toBe(third.id);
  });

  it('does not serve older revision artifacts after run change, delete or recreate', async () => {
    const { dir, record, findingId } = await setup();
    const result = await challengeFinding(record.id, findingId, { runsDir: dir, transport: fakeTransport(record).transport });
    expect(result.status).toBe('completed');

    // Save run again -> changes revision
    await saveRun(record, dir);
    const view = await readChallenges(record.id, findingId, dir);
    expect(view.stale).toBe(true);
    expect(view.current).toBeNull();
    expect(view.latestPartial).toBeNull();
    expect(view.latestAttempt).toBeNull();
  });

  it('retains observed experiments when interpretation fails; no retries', async () => {
    const { dir, record, findingId } = await setup(); let calls = 0;
    const result = await challengeFinding(record.id, findingId, { runsDir: dir, transport: { generate: async () => {
      calls++; if (calls === 2) throw Object.assign(new Error('remote failed'), { requestSent: true });
      return { content: proposalFor(record, 3), usage };
    } } });
    expect(calls).toBe(2); expect(result.variants).toHaveLength(3); expect(result.interpretation.status).toBe('unavailable');
    expect(result.requests[1]!.usageKnown).toBe(false); expect(result.requests[1]!.usage).toBeNull();
    expect((await readChallenges(record.id, findingId, dir)).current).toEqual(result);
  });
});

describe('strict model proposal boundary', () => {
  it.each([false, true])('bounds the whole plan while preserving untrusted malformed payloads inventory=%s', async inventory => {
    const record = await challengeFixture(inventory); const adapter = resolveAdapter(inventory ? 'inventory-reservation' : 'synthetic-trading');
    const original = originalExperiment(record); const invariant = record.findings[0]!.violation.invariant;
    const valid = JSON.parse(proposalFor(record));
    expect(parseChallengeProposals(proposalFor(record, 3), adapter, original, invariant)).toHaveLength(3);
    const invalid: unknown[] = [null, {}, { variants: [] }, { variants: Array(4).fill(valid.variants[0]) }, { variants: [valid.variants[0], valid.variants[0]] }];
    const change = (mutate: (v: any) => void) => { const clone = structuredClone(valid); mutate(clone.variants[0]); return clone; };
    invalid.push(
      change(v => { v.experiment.steps = original.steps; }),
      change(v => { v.experiment.steps = original.steps.map(s => s.op === 'send' || s.op === 'duplicate' || s.op === 'fill' || s.op === 'confirm_cancel' ? { ...s, delay: 0 } : s); }),
      change(v => { v.experiment.steps = [{ op: 'shell', command: 'echo bad' }]; }),
      change(v => { v.experiment.steps = Array(101).fill({ op: 'drain' }); }),
      change(v => { v.proposedChange = 'x'.repeat(2001); }),
      change(v => { v.experiment.steps = [{ op: 'send', id: 'x', to: inventory ? 'stock' : 'market', payload: 'x'.repeat(25000) }]; }),
      change(v => { v.experiment.steps[0].command = 'hidden action'; }),
      change(v => { v.experiment.expectedInvariant = 'invented oracle'; }),
      change(v => { v.experiment.steps = [{ op: 'send', id: 'x', to: inventory ? 'market' : 'stock', payload: {} }]; }),
    );
    for (const value of invalid) expect(() => parseChallengeProposals(JSON.stringify(value), adapter, original, invariant)).toThrow();
    expect(() => parseChallengeProposals('x'.repeat(100000), adapter, original, invariant)).toThrow(/maximum/);
    expect(() => parseChallengeProposals('{"variants":', adapter, original, invariant)).toThrow();
    const malicious = change(v => { v.experiment.steps = [{ op: 'send', id: 'attack', to: inventory ? 'stock' : 'market', payload: { type: '<script>attack()</script>', quantity: -2, __proto__: null } }, { op: 'drain' }]; });
    expect(parseChallengeProposals(JSON.stringify(malicious), adapter, original, invariant)[0]!.experiment.steps).toHaveLength(2);
  });
});

describe('deterministic outcome classification', () => {
  it.each([
    ['same', 'completed', 'observed', 'matched', 'passed', true],
    ['absent', 'completed', 'absent', 'matched', 'passed', false],
    ['other', 'completed', 'absent', 'matched', 'passed', false],
    ['invalid', 'invalid-or-incomplete', 'observed', 'matched', 'passed', false],
    ['incomplete', 'invalid-or-incomplete', 'observed', 'matched', 'passed', false],
    ['replay-mismatch', 'completed', 'observed', 'mismatch', 'passed', false],
    ['wrong-source', 'source-mismatch', 'observed', 'mismatch', 'passed', false],
    ['clean-wrong-source', 'completed', 'observed', 'matched', 'source-mismatch', false],
    ['clean-invalid', 'completed', 'observed', 'matched', 'invalid-or-incomplete', false],
    ['clean-incomplete', 'completed', 'observed', 'matched', 'invalid-or-incomplete', false],
    ['clean-failed', 'completed', 'observed', 'matched', 'failed', false],
    ['clean-unrelated', 'completed', 'observed', 'matched', 'passed', true],
    ['clean-same-category', 'completed', 'observed', 'matched', 'failed', false],
    ['clean-diff-category', 'completed', 'observed', 'matched', 'passed', true],
    ['clean-missing-category', 'completed', 'observed', 'matched', 'passed', true],
    ['clean-unavailable', 'completed', 'observed', 'matched', 'unavailable', false],
    ['execution-error', 'error', 'unavailable', 'unavailable', 'passed', false],
    ['replay-error', 'completed', 'observed', 'error', 'passed', false],
    ['clean-error', 'completed', 'observed', 'matched', 'error', false],
  ])('%s distinguishes all proof boundaries', (kind, candidateStatus, sameInvariant, replayStatus, cleanStatus, reproduced) => {
    const experiment = { hypothesis: 'h', expectedInvariant: 'same', steps: [{ op: 'drain' as const }] };
    const proposal: ChallengeProposal = { proposedChange: 'c', experiment, changes: [] };
    const binding = { invariant: 'same', category: kind === 'clean-missing-category' ? undefined : 'cat-A', sourceHash: 'expected', cleanSourceHash: 'clean' } as ChallengeBinding;
    const candidate: ExperimentResult = { schemaVersion: 1, experiment, sourceHash: 'expected', trace: [], snapshot: {}, violations: [{ id: 'v', invariant: 'same', category: 'cat-A', message: 'observed', step: 1, evidence: {} }], rejections: [], valid: true };
    if (kind === 'absent') candidate.violations = [];
    if (kind === 'other') candidate.violations[0]!.invariant = 'other';
    if (kind === 'invalid') candidate.valid = false;
    if (kind === 'incomplete') candidate.executionComplete = false;
    if (kind === 'wrong-source') candidate.sourceHash = 'wrong';
    const replay = structuredClone(candidate);
    if (kind === 'replay-mismatch') replay.snapshot = { changed: true };
    let cleanViolations: Violation[] = [];
    if (kind === 'clean-failed') cleanViolations = candidate.violations;
    else if (kind === 'clean-unrelated') cleanViolations = [{ id: 'cv', invariant: 'unrelated', category: 'cat-B', message: 'unrelated', step: 1, evidence: {} }];
    else if (kind === 'clean-same-category') cleanViolations = [{ id: 'cv', invariant: 'diff-inv', category: 'cat-A', message: 'same cat', step: 1, evidence: {} }];
    else if (kind === 'clean-diff-category') cleanViolations = [{ id: 'cv', invariant: 'diff-inv', category: 'cat-B', message: 'diff cat', step: 1, evidence: {} }];
    else if (kind === 'clean-missing-category') cleanViolations = [{ id: 'cv', invariant: 'diff-inv', category: 'cat-A', message: 'missing cat binding', step: 1, evidence: {} }];
    const clean = { ...structuredClone(candidate), valid: true, executionComplete: true, sourceHash: kind === 'clean-wrong-source' ? 'wrong' : 'clean', violations: cleanViolations };
    if (kind === 'clean-invalid') clean.valid = false;
    if (kind === 'clean-incomplete') clean.executionComplete = false;
    const evidence = { candidate: kind === 'execution-error' ? undefined : candidate, replay: kind === 'execution-error' || kind === 'replay-error' ? undefined : replay, clean: kind === 'clean-unavailable' || kind === 'clean-error' ? undefined : clean,
      candidateError: kind === 'execution-error' ? 'throw' : undefined, replayError: kind === 'replay-error' ? 'throw' : undefined, cleanError: kind === 'clean-error' ? 'throw' : undefined };
    const result = classifyVariant(proposal, binding, evidence);
    expect(result).toMatchObject({ candidateStatus, sameInvariant, replayStatus, cleanStatus, reproduced });
    if (kind === 'other') expect(result.otherInvariants).toEqual(['other']);
  });
});

describe('cancellation and coupled publication transitions', () => {
  it('aborted before start sends nothing; during inference records unknown usage and does no variants', async () => {
    const { dir, record, findingId } = await setup(); const controller = new AbortController(); controller.abort(); const fake = fakeTransport(record);
    await expect(challengeFinding(record.id, findingId, { runsDir: dir, transport: fake.transport, signal: controller.signal })).rejects.toThrow(); expect(fake.calls).toHaveLength(0);
    const later = new AbortController(); const entered = deferred(); const release = deferred();
    const pending = challengeFinding(record.id, findingId, { runsDir: dir, signal: later.signal, transport: { generate: async () => { entered.resolve(); await release.promise; throw Object.assign(new Error('abort after send'), { requestSent: true }); } } });
    await entered.promise; later.abort(); release.resolve(); const result = await pending;
    expect(result.status).toBe('cancelled'); expect(result.variants).toHaveLength(0); expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({ usageKnown: false, usage: null, requestSent: true });
  });

  it('a late successful transport after abort retains known usage but executes nothing', async () => {
    const { dir, record, findingId } = await setup(); const controller = new AbortController();
    const result = await challengeFinding(record.id, findingId, { runsDir: dir, signal: controller.signal, transport: { generate: async () => { controller.abort(); return { content: proposalFor(record), usage }; } } });
    expect(result.variants).toHaveLength(0); expect(result.requests[0]).toMatchObject({ usageKnown: true, usage });
  });

  it.each([1, 3])('cancelling after execution %s retains traces, stops later executions/interpretation and preserves previous evidence', async stopAfter => {
    const { dir, record, findingId } = await setup(true);
    const first = await challengeFinding(record.id, findingId, { runsDir: dir, transport: fakeTransport(record).transport });
    const adapter = resolveAdapter('inventory-reservation'); const execute = adapter.executeExperiment;
    const controller = new AbortController(); let executions = 0; const fake = fakeTransport(record, 3);
    vi.spyOn(adapter, 'executeExperiment').mockImplementation((experiment, variant) => {
      const result = execute(experiment, variant);
      if (experiment.hypothesis.startsWith('challenge-variant') && ++executions === stopAfter) controller.abort();
      return result;
    });
    const result = await challengeFinding(record.id, findingId, { runsDir: dir, transport: fake.transport, signal: controller.signal });
    expect(executions).toBe(stopAfter); expect(fake.calls).toHaveLength(1); expect(result.status).toBe('cancelled');
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]!.candidate!.trace.length).toBeGreaterThan(0);
    expect((await readChallenges(record.id, findingId, dir)).current!.id).toBe(first.id);
    expect((await readChallenges(record.id, findingId, dir)).latestAttempt!.id).toBe(result.id);
  });

  it('cancelling interpretation retains all prior deterministic evidence and no later request', async () => {
    const { dir, record, findingId } = await setup(); const controller = new AbortController(); let calls = 0;
    const result = await challengeFinding(record.id, findingId, { runsDir: dir, signal: controller.signal, transport: { generate: async () => {
      calls++; if (calls === 2) { controller.abort(); throw Object.assign(new Error('cancel interpretation'), { requestSent: true }); }
      return { content: proposalFor(record), usage };
    } } });
    expect(calls).toBe(2); expect(result.status).toBe('cancelled'); expect(result.interpretation.status).toBe('cancelled');
    expect((await readChallenges(record.id, findingId, dir)).current!.variants[0]!.reproduced).toBe(true);
  });

  it.each(['rewrite', 'delete', 'delete-recreate'] as const)('%s while inference is pending prevents later work and resurrection', async mutation => {
    const { dir, record, findingId } = await setup(); const entered = deferred(); const release = deferred(); let calls = 0;
    const pending = challengeFinding(record.id, findingId, { runsDir: dir, transport: { generate: async () => { calls++; entered.resolve(); await release.promise; return { content: proposalFor(record), usage }; } } });
    await entered.promise;
    if (mutation !== 'rewrite') await deleteRun(record.id, dir);
    if (mutation !== 'delete') await saveRun(record, dir); // identical JSON must still invalidate the lease's source version
    release.resolve(); await expect(pending).rejects.toThrow(/deleted|changed/); expect(calls).toBe(1);
    if (mutation !== 'delete') { const view = await readChallenges(record.id, findingId, dir); expect(view.stale).toBe(true); expect(view.current).toBeNull(); expect(view.latestAttempt).toBeNull(); }
    else await expect(readChallenges(record.id, findingId, dir)).rejects.toThrow(/deleted|missing/);
  });

  it('requires expected selection identity before proposal, even if same finding ID remains', async () => {
    const { dir, record, findingId } = await setup(); const view = await getChallengeView(record.id, findingId, dir);
    await saveRun(record, dir); const fake = fakeTransport(record);
    await expect(challengeFinding(record.id, findingId, { runsDir: dir, transport: fake.transport, expectedRunRevision: view.runRevision, expectedEvidenceHash: view.evidenceHash })).rejects.toThrow(/changed/);
    expect(fake.calls).toHaveLength(0);
  });

  it('an actual adapter execution throw is saved with other evidence and never becomes reproduced', async () => {
    const { dir, record, findingId } = await setup(true); const adapter = resolveAdapter('inventory-reservation'); const execute = adapter.executeExperiment;
    vi.spyOn(adapter, 'executeExperiment').mockImplementation((experiment, variant) => {
      if (experiment.hypothesis.startsWith('challenge-variant') && variant !== 'clean') throw new Error('execution failed');
      return execute(experiment, variant);
    });
    const result = await challengeFinding(record.id, findingId, { runsDir: dir, transport: fakeTransport(record).transport });
    expect(result.variants[0]).toMatchObject({ candidateStatus: 'error', replayStatus: 'error', cleanStatus: 'passed', reproduced: false });
    expect(result.variants[0]!.errors).toHaveLength(2);
  });
});

describe('clean control preflight and category equivalence', () => {
  it.each([false, true])('preflight accepts unrelated clean violations and blocks same invariant inventory=%s', async inventory => {
    const { dir, record, findingId } = await setup(inventory);
    const adapterId = inventory ? 'inventory-reservation' : 'synthetic-trading';
    const adapter = resolveAdapter(adapterId);
    const execute = adapter.executeExperiment;

    // 1. Unrelated violation on clean: preflight succeeds
    vi.spyOn(adapter, 'executeExperiment').mockImplementation((exp, variant) => {
      const res = execute(exp, variant);
      if (variant === 'clean') {
        res.violations = [{ id: 'v-unrelated', invariant: 'unrelated-inv', category: 'unrelated-cat', message: 'clean unrelated', step: 1, evidence: {} }];
      }
      return res;
    });
    const rev = await getRunRevision(record.id, dir);
    const prepared = await prepareChallenge(record, findingId, rev);
    expect(prepared.binding.invariant).toBe(record.findings[0]!.violation.invariant);

    // 2. Same invariant on clean: preflight throws
    vi.spyOn(adapter, 'executeExperiment').mockImplementation((exp, variant) => {
      const res = execute(exp, variant);
      if (variant === 'clean') {
        res.violations = [{ id: 'v-same', invariant: record.findings[0]!.violation.invariant, message: 'clean same', step: 1, evidence: {} }];
      }
      return res;
    });
    await expect(prepareChallenge(record, findingId, rev)).rejects.toThrow(/clean control/);

    // 3. Clean invalid: preflight throws
    vi.spyOn(adapter, 'executeExperiment').mockImplementation((exp, variant) => {
      const res = execute(exp, variant);
      if (variant === 'clean') res.valid = false;
      return res;
    });
    await expect(prepareChallenge(record, findingId, rev)).rejects.toThrow(/clean control/);

    // 4. Clean incomplete: preflight throws
    vi.spyOn(adapter, 'executeExperiment').mockImplementation((exp, variant) => {
      const res = execute(exp, variant);
      if (variant === 'clean') res.executionComplete = false;
      return res;
    });
    await expect(prepareChallenge(record, findingId, rev)).rejects.toThrow(/clean control/);

    // 5. Clean wrong source: preflight throws
    vi.spyOn(adapter, 'executeExperiment').mockImplementation((exp, variant) => {
      const res = execute(exp, variant);
      if (variant === 'clean') res.sourceHash = 'wrong-source';
      return res;
    });
    await expect(prepareChallenge(record, findingId, rev)).rejects.toThrow(/clean control/);
  });

  it('preflight blocks clean violation matching recorded category with different invariant (inventory)', async () => {
    const { dir, record, findingId } = await setup(true);
    const adapter = resolveAdapter('inventory-reservation');
    const execute = adapter.executeExperiment;
    const category = record.findings[0]!.category ?? record.findings[0]!.violation.category;
    expect(category).toBeDefined();

    vi.spyOn(adapter, 'executeExperiment').mockImplementation((exp, variant) => {
      const res = execute(exp, variant);
      if (variant === 'clean') {
        res.violations = [{ id: 'v-diff-same-cat', invariant: 'different-invariant', category: category!, message: 'diff invariant same category', step: 1, evidence: {} }];
      }
      return res;
    });
    const rev = await getRunRevision(record.id, dir);
    await expect(prepareChallenge(record, findingId, rev)).rejects.toThrow(/clean control/);
  });

  it('preflight accepts clean violation with different invariant when category is missing (trading)', async () => {
    const { dir, record, findingId } = await setup(false);
    const adapter = resolveAdapter('synthetic-trading');
    const execute = adapter.executeExperiment;
    expect(record.findings[0]!.category).toBeUndefined();

    vi.spyOn(adapter, 'executeExperiment').mockImplementation((exp, variant) => {
      const res = execute(exp, variant);
      if (variant === 'clean') {
        res.violations = [{ id: 'v-diff', invariant: 'different-invariant', category: 'some-cat', message: 'diff invariant', step: 1, evidence: {} }];
      }
      return res;
    });
    const rev = await getRunRevision(record.id, dir);
    const prepared = await prepareChallenge(record, findingId, rev);
    expect(prepared.binding.category).toBeUndefined();
    expect(prepared.binding.invariant).toBe(record.findings[0]!.violation.invariant);
  });
});

describe('UTF-8 proposal response preview bounds', () => {
  it('truncates by UTF-8 bytes, not JS character count, and avoids broken UTF-8 characters', () => {
    // 50,000 Chinese characters: each is 3 bytes in UTF-8 (150,000 bytes > 98,304 byte cap)
    // but JS character length is 50,000 (<= 98,304).
    const char = '中';
    const content = char.repeat(50000);
    expect(content.length).toBe(50000);
    expect(Buffer.byteLength(content, 'utf8')).toBe(150000);

    const result = truncateUtf8Preview(content, CHALLENGE_LIMITS.responseBytes);
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(150000);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(CHALLENGE_LIMITS.responseBytes);
    // 98304 / 3 = 32768 complete characters exactly
    expect(result.text).toBe(char.repeat(32768));
    expect(result.text.includes('\uFFFD')).toBe(false);

    // Emoji: 4 UTF-8 bytes
    const emoji = '😀'; // F0 9F 98 80
    const str = 'abc' + emoji + 'def';
    // 'abc' is 3 bytes, emoji is 4 bytes. If cap is 5 bytes, 'abc' fits (3 bytes), emoji (4 bytes) would need 7 bytes.
    const truncatedEmoji = truncateUtf8Preview(str, 5);
    expect(truncatedEmoji.truncated).toBe(true);
    expect(truncatedEmoji.text).toBe('abc');
    expect(Buffer.byteLength(truncatedEmoji.text, 'utf8')).toBe(3);
    expect(truncatedEmoji.text.includes('\uFFFD')).toBe(false);

    // If cap is 7 bytes, 'abc' + emoji fits exactly 7 bytes
    const fitsEmoji = truncateUtf8Preview(str, 7);
    expect(fitsEmoji.truncated).toBe(true);
    expect(fitsEmoji.text).toBe('abc' + emoji);
    expect(Buffer.byteLength(fitsEmoji.text, 'utf8')).toBe(7);

    // Non-truncated
    const small = '{"variants":[]}';
    const exact = truncateUtf8Preview(small, CHALLENGE_LIMITS.responseBytes);
    expect(exact.truncated).toBe(false);
    expect(exact.bytes).toBe(Buffer.byteLength(small, 'utf8'));
    expect(exact.text).toBe(small);
  });
});

describe('run deletion and revision persistence', () => {
  it('deleteRun on nonexistent run returns false and creates no revision tombstone', async () => {
    const dir = await tempChallengeDir();
    dirs.push(dir);
    const absentId = 'nonexistent-run-0000';
    const deleted = await deleteRun(absentId, dir);
    expect(deleted).toBe(false);
    const revisionPath = path.join(dir, `.${absentId}.revision`);
    await expect(fs.access(revisionPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('deleteRun on existing run advances revision before unlinking; recreate has distinct revision', async () => {
    const dir = await tempChallengeDir();
    dirs.push(dir);
    const record = await challengeFixture();
    await saveRun(record, dir);
    const rev1 = await getRunRevision(record.id, dir);

    const deleted = await deleteRun(record.id, dir);
    expect(deleted).toBe(true);

    // Recreate run with identical JSON
    await saveRun(record, dir);
    const rev2 = await getRunRevision(record.id, dir);
    expect(rev2).not.toBe(rev1);

    // Second delete on already deleted/nonexistent run returns false without creating new revision
    const otherAbsent = 'absent-never-saved';
    expect(await deleteRun(otherAbsent, dir)).toBe(false);
    await expect(fs.access(path.join(dir, `.${otherAbsent}.revision`))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
