import { createHash } from 'node:crypto';
import type { RequirementEvaluatorIdentity } from '../domain.ts';

/**
 * Semantic identity of the requirement-rule evaluator.
 *
 * The hash is computed from a stable descriptor of the evaluation semantics,
 * NOT from source file bytes. TypeScript sources (tests run via vitest/ts)
 * and compiled JavaScript (dist runtime) therefore produce the same identity
 * for the same semantics. Bump `version` and update the descriptor whenever
 * trigger, observation or comparison semantics change.
 */
export const REQUIREMENT_EVALUATOR_DESCRIPTOR = Object.freeze({
  id: 'trading-credit-admission',
  version: 1,
  preset: 'accepted-order-credit-limit',
  adapter: 'synthetic-trading',
  trigger: 'valid new_order message on client channel accepted via deliver or drain:deliver',
  observations: ['usedCredit', 'reservedCredit', 'creditLimit'],
  comparison: 'usedCredit + reservedCredit <= current credit limit',
  evaluatedAt: 'every matching delivery event, immediately after delivery',
  statuses: ['passed', 'failed', 'not-exercised', 'inconclusive'],
  provenance: 'typed delivery observations recorded by the trading executor; payload validity decoded independently with the clean decoder',
});

const EVALUATOR_HASH = createHash('sha256')
  .update(JSON.stringify(REQUIREMENT_EVALUATOR_DESCRIPTOR), 'utf8')
  .digest('hex');

export function getRequirementEvaluatorIdentity(): RequirementEvaluatorIdentity {
  return {
    id: REQUIREMENT_EVALUATOR_DESCRIPTOR.id,
    version: REQUIREMENT_EVALUATOR_DESCRIPTOR.version,
    hash: EVALUATOR_HASH,
  };
}

export function isRequirementEvaluatorIdentity(value: unknown): value is RequirementEvaluatorIdentity {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && v.id.length > 0
    && typeof v.version === 'number' && Number.isSafeInteger(v.version) && v.version >= 1
    && typeof v.hash === 'string' && /^[0-9a-f]{64}$/.test(v.hash);
}

export function requirementEvaluatorAvailable(saved: RequirementEvaluatorIdentity | undefined): boolean {
  if (!saved || !isRequirementEvaluatorIdentity(saved)) return false;
  const current = getRequirementEvaluatorIdentity();
  return saved.id === current.id && saved.version === current.version && saved.hash === current.hash;
}
