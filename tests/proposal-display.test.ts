import { expect, it } from 'vitest';
import { describeProposals, describeRunOutcome } from '../src/web/proposals.ts';
import type { InvestigationRecord, ProposalAttempt } from '../src/domain.ts';

function record(attempts?: ProposalAttempt[]): InvestigationRecord {
  return {
    schemaVersion: 1, id: 'view', provider: 'meta', model: 'muse-wonder-1.0', mode: 'live', variant: 'clean',
    status: 'completed', startedAt: '', sourceHash: 'source', experiments: [], findings: [],
    usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, errors: [],
    contextAudit: { sourcePaths: [], contractHash: 'contract', promptVersion: '2.0' }, proposalAttempts: attempts
  };
}

function attempt(status: ProposalAttempt['status'], requestSent?: boolean): ProposalAttempt {
  return { index: 1, experimentNumber: 1, correctionNumber: 0, startedAt: '', status, usageKnown: false, requestSent };
}

it('distinguishes unrecorded legacy proposal history from a known empty history', () => {
  expect(describeProposals(record()).count).toBeNull();
  expect(describeProposals(record([])).count).toBe(0);
});

it('counts rejected, failed and pending proposals separately from executed experiments', () => {
  const display = describeProposals(record([
    attempt('invalid_response'), attempt('invalid_plan'), attempt('failed'), attempt('pending')
  ]));
  expect(display.summary).toContain('4 proposals recorded; 0 experiments executed; 2 proposals rejected; 1 failed or cancelled; 1 pending');
  expect(display.unknownCost).toBe(true);
});

it('does not imply unknown network cost for a confirmed unsent or pending request', () => {
  expect(describeProposals(record([attempt('failed', false), attempt('pending')])).unknownCost).toBe(false);
  const known = attempt('executed', true);
  known.usageKnown = true;
  expect(describeProposals(record([known])).unknownCost).toBe(false);
});

it('summarizes the actual size failure and partial results without repeating technical errors', () => {
  const rec = record([attempt('failed', false)]);
  rec.status = 'failed';
  rec.stopReason = 'Provider failed to propose';
  rec.errors = ['Provider proposal failure: Prompt size (33923 bytes) exceeds maximum allowed size (32768 bytes)'];
  rec.usage.estimatedCostUsd = 0.378492;
  rec.experiments = [{}, {}] as InvestigationRecord['experiments'];
  const summary = describeRunOutcome(rec)!;
  expect(summary.heading).toBe('Investigation incomplete');
  expect(summary.reason).toContain('33,923 bytes');
  expect(summary.reason).toContain('32,768-byte limit');
  expect(summary.metrics).toContain('2 experiments completed · 0 confirmed findings');
  expect(summary.metrics).toContain('$0.3785');
  expect(summary.notice).toContain('not a clean pass');
});

it('distinguishes cancellation and unknown usage, supports legacy records, and hides successful summaries', () => {
  const rec = record();
  rec.status = 'cancelled';
  rec.stopReason = 'Investigation cancelled by user';
  expect(describeRunOutcome(rec)).toMatchObject({ heading: 'Investigation stopped', reason: rec.stopReason });
  expect(describeRunOutcome(rec)?.metrics).toContain('some usage is unknown');
  rec.status = 'completed';
  expect(describeRunOutcome(rec)).toBeNull();
  rec.errors = ['Model response was truncated due to max_tokens limit'];
  expect(describeRunOutcome(rec)?.reason).toContain('cut off');
});

it('does not call a legacy completed finding incomplete just because an earlier proposal was rejected', () => {
  const rec = record([attempt('invalid_response'), attempt('executed', true)]);
  rec.status = 'completed';
  rec.stopReason = 'Verified finding confirmed';
  rec.errors = ['Proposal rejected after three corrections: truncated'];
  rec.findings = [{ reproduced: true, cleanControlPassed: true }] as InvestigationRecord['findings'];
  const summary = describeRunOutcome(rec)!;
  expect(summary.heading).toBe('Investigation completed with warnings');
  expect(summary.reason).toContain('later confirmed a finding');
  expect(summary.metrics).toContain('1 confirmed finding ·');
  rec.proposalAttempts!.push(attempt('pending'));
  expect(describeRunOutcome(rec)?.heading).toBe('Investigation incomplete');
});
