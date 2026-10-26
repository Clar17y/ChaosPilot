import { expect, it } from 'vitest';
import { describeProposals } from '../src/web/proposals.ts';
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
