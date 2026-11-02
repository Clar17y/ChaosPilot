import type { CoverageContext, CoverageIdentity, CoveragePreparationInput, CoverageRequirementLink, CoverageScenarioId } from './types.ts';

export const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
export const amount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export const normalize = (v: string): string => v.trim().replace(/\s+/g, ' ');
export const contextKeys = ['systemId', 'revision', 'snapshotHash', 'adapterId', 'variant', 'sourceHash', 'contractHash'] as const;
export function validContext(v: unknown): v is CoverageContext {
  return isRecord(v) && contextKeys.every(k => k === 'revision' ? amount(v[k]) && v[k] > 0 : text(v[k]));
}
export function sameContext(a: unknown, b: CoverageContext): boolean {
  return validContext(a) && contextKeys.every(k => a[k] === b[k]);
}
export function sameIdentity(a: unknown, b: CoverageIdentity): boolean {
  return isRecord(a) && a.id === b.id && a.version === b.version && a.hash === b.hash;
}
// Existing requirement evaluator semantic identity, browser-safe. Tested against
// getRequirementEvaluatorIdentity(); never replace it with the coverage identity.
export const CREDIT_EVALUATOR: Readonly<CoverageIdentity> = Object.freeze({
  id: 'trading-credit-admission', version: 1,
  hash: '2278d341caf1951837c79c27b18edf582e4cb3b1fc62c8e2d49473992fb47a0a',
});
export const scenarios = {
  'accepted-order-credit-limit': { adapter: 'synthetic-trading', title: 'Credit limit on accepted orders', description: 'Check recorded credit after each accepted valid client new_order delivery.' },
  'recovery-by-deadline': { adapter: 'synthetic-trading-recovery', title: 'Recovery by deadline', description: 'Check target-accepted recovery accounting by reconnect + 5 simulated ticks, inclusive.' },
  'recovery-retry-idempotence': { adapter: 'synthetic-trading-recovery', title: 'Recovery retry idempotence', description: 'Check exactly-once order and credit accounting after an observed retry.' },
} satisfies Record<CoverageScenarioId, { adapter: string; title: string; description: string }>;
export function validPreparation(v: unknown): v is CoveragePreparationInput {
  return isRecord(v) && validContext(v.context) && Array.isArray(v.requirements) && v.requirements.every(text)
    && Array.isArray(v.contractRuleIds) && v.contractRuleIds.every(text)
    && new Set(v.contractRuleIds).size === v.contractRuleIds.length
    && (v.requirementRules === undefined || Array.isArray(v.requirementRules) && v.requirementRules.every(r => isRecord(r) && text(r.requirement) && text(r.preset) && typeof r.reviewed === 'boolean'));
}
export function allowedLinks(input: CoveragePreparationInput, id: CoverageScenarioId): CoverageRequirementLink[] {
  if (input.context.adapterId !== scenarios[id].adapter) return [];
  if (id === 'accepted-order-credit-limit') {
    const rules = input.requirementRules ?? [];
    return input.requirements.filter(req => {
      const key = normalize(req);
      const matches = rules.filter(r => normalize(r.requirement) === key);
      return input.requirements.filter(r => normalize(r) === key).length === 1 && matches.length === 1
        && matches[0]?.reviewed === true && matches[0]?.preset === id;
    }).map(req => ({ kind: 'requirement-text', text: normalize(req) }));
  }
  const ruleId = id === 'recovery-retry-idempotence' && input.contractRuleIds.includes('recovery_retry_idempotence')
    ? 'recovery_retry_idempotence' : 'recovery_deadline';
  return input.contractRuleIds.includes(ruleId) ? [{ kind: 'contract-rule', ruleId }] : [];
}
export function linkKey(v: unknown): string | null {
  if (!isRecord(v)) return null;
  if (v.kind === 'requirement-text' && text(v.text)) return `requirement:${normalize(v.text)}`;
  if (v.kind === 'contract-rule' && text(v.ruleId)) return `contract:${v.ruleId}`;
  return null;
}
