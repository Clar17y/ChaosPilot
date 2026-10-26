import type { InvestigationRecord } from '../domain.ts';

export function describeProposals(record: InvestigationRecord): { count: number | null; summary: string; unknownCost: boolean } {
  const attempts = record.proposalAttempts;
  if (!attempts) {
    return { count: null, summary: 'Proposal history was not recorded for this older investigation.', unknownCost: false };
  }
  const rejected = attempts.filter(a => a.status === 'invalid_response' || a.status === 'invalid_plan').length;
  const failed = attempts.filter(a => a.status === 'failed' || a.status === 'cancelled').length;
  const pending = attempts.filter(a => a.status === 'pending').length;
  const unknownCost = record.provider === 'meta' && attempts.some(a =>
    a.status !== 'pending' && !a.usageKnown && a.requestSent !== false
  );
  return {
    count: attempts.length,
    summary: `${attempts.length} proposals recorded; ${record.experiments.length} experiments executed; ${rejected} proposals rejected; ${failed} failed or cancelled; ${pending} pending.`,
    unknownCost
  };
}
