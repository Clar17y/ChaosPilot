import type { RequirementRule } from '../domain.ts';

export const CREDIT_RULE_PRESET = 'accepted-order-credit-limit' as const;

export function normalizeRequirement(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** Only this preset is executable. Extra keys cannot smuggle in code or operations. */
export function validateRequirementRules(input: unknown, requirements: string[], adapterId: string): string | null {
  if (!Array.isArray(input) || input.length > 50) return 'requirementRules must be an array of at most 50 reviewed rules';
  if (input.length && adapterId !== 'synthetic-trading') return 'Requirement rules support synthetic-trading only; explicitly remove the rules before switching adapter';
  const linked = new Set<string>();
  for (const value of input) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Each requirement rule must be an object';
    const r = value as Record<string, unknown>;
    if (Object.keys(r).some(k => !['requirement', 'preset', 'reviewed'].includes(k))) return 'Unsupported requirement rule field; only requirement, preset and reviewed are allowed';
    if (r.preset !== CREDIT_RULE_PRESET) return 'Unsupported requirement rule preset or operation';
    if (r.reviewed !== true) return 'A requirement rule must be explicitly reviewed before saving';
    if (typeof r.requirement !== 'string' || !r.requirement || r.requirement !== normalizeRequirement(r.requirement)) return 'Rule requirement must be non-empty normalized text';
    if (requirements.filter(t => normalizeRequirement(t) === r.requirement).length !== 1) return 'Linked requirement text is missing or ambiguous; explicitly remap or remove the rule';
    if (linked.has(r.requirement)) return 'Only one rule per requirement is supported';
    linked.add(r.requirement);
  }
  return null;
}

export function reviewedCreditRule(requirement: string): RequirementRule {
  return { requirement: normalizeRequirement(requirement), preset: CREDIT_RULE_PRESET, reviewed: true };
}

/** Deep-copies already-validated rules into their canonical stored shape. */
export function cloneRequirementRules(input: readonly RequirementRule[]): RequirementRule[] {
  return input.map(r => ({ requirement: r.requirement, preset: r.preset, reviewed: true as const }));
}
