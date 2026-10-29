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

export interface RunOutcome {
  heading: string;
  reason: string;
  metrics: string;
  notice: string;
}

function readableReason(reason: string): string {
  const size = /Prompt size \((\d+) bytes\) exceeds maximum allowed size \((\d+) bytes\)/i.exec(reason);
  if (size) {
    return `The next experiment could not start: its request was ${Number(size[1]).toLocaleString('en-US')} bytes, above the ${Number(size[2]).toLocaleString('en-US')}-byte limit.`;
  }
  if (/truncat|cut off/i.test(reason)) {
    return 'The model response was cut off by the output limit, so the next experiment could not be prepared.';
  }
  const cleaned = reason.replace(/^(?:Provider proposal failure|Provider failed to propose):\s*/i, '').trim();
  return cleaned.length > 500 ? `${cleaned.slice(0, 500)}… See Proposals for details.` : cleaned;
}

/** Plain text only. Includes legacy records whose old retry loop falsely completed. */
export function describeRunOutcome(record: InvestigationRecord): RunOutcome | null {
  if (record.status === 'running') return null;
  const attempts = record.proposalAttempts;
  const last = attempts?.at(-1);
  const lastUnfinished = last?.status === 'pending' || last?.status === 'invalid_response' || last?.status === 'invalid_plan' || last?.status === 'failed' || last?.status === 'cancelled';
  const incomplete = record.status !== 'completed' || (record.errors?.length ?? 0) > 0
    || lastUnfinished;
  if (!incomplete) return null;
  const confirmed = record.findings.filter(f => f.reproduced && f.cleanControlPassed).length;
  const completedWithFinding = record.status === 'completed' && confirmed > 0 && !lastUnfinished;
  const heading = record.status === 'cancelled' ? 'Investigation stopped'
    : completedWithFinding ? 'Investigation completed with warnings' : 'Investigation incomplete';
  const reason = completedWithFinding
    ? 'One or more earlier proposals were rejected; the investigation later confirmed a finding.'
    : readableReason(record.errors?.at(-1) || last?.error || record.stopReason || 'No specific reason was recorded for this run.');
  const unknown = describeProposals(record).unknownCost || (record.provider === 'meta' && !attempts);
  const cost = record.usage?.estimatedCostUsd;
  const costText = typeof cost === 'number' && Number.isFinite(cost)
    ? `Estimated cost: $${cost.toFixed(4)}${unknown ? ' reported; some usage is unknown' : ''}`
    : 'Cost and usage unknown';
  return {
    heading,
    reason,
    metrics: `${record.experiments.length} experiment${record.experiments.length === 1 ? '' : 's'} completed · ${confirmed} confirmed finding${confirmed === 1 ? '' : 's'} · ${costText}`,
    notice: `${confirmed === 0 ? 'No findings were confirmed; this is not a clean pass. ' : ''}${completedWithFinding ? 'See Proposals for earlier errors and Findings for confirmed evidence.' : 'Earlier evidence is available below.'}${record.mode === 'mock' ? ' Scripted mock results are not live AI discovery.' : ''}`
  };
}
