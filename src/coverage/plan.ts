import { COVERAGE_CATALOG, COVERAGE_EVALUATOR } from './identity.ts';
import { allowedLinks, contextKeys, isRecord, linkKey, sameIdentity, scenarios, validContext, validPreparation } from './catalog.ts';
import type { BuildCoveragePlanInput, CoveragePlan, CoveragePlanIntention, CoveragePlanValidation, CoveragePreparationInput, CoverageScenarioId } from './types.ts';

export function validateCoveragePlan(plan: unknown, expected: CoveragePreparationInput): CoveragePlanValidation {
  const errors: string[] = [];
  if (!validPreparation(expected)) return { valid: false, errors: ['Expected preparation context or mappings are malformed'] };
  if (!isRecord(plan)) return { valid: false, errors: ['Coverage plan must be an object'] };
  if (plan.schemaVersion !== 1) errors.push('Unknown coverage plan schema');
  if (!sameIdentity(plan.catalog, COVERAGE_CATALOG)) errors.push('Unknown or mismatched coverage catalog identity');
  if (!sameIdentity(plan.evaluator, COVERAGE_EVALUATOR)) errors.push('Unknown or mismatched coverage evaluator identity');
  if (!validContext(plan.context)) errors.push('Malformed plan context');
  else for (const key of contextKeys) if (plan.context[key] !== expected.context[key]) errors.push(`Context ${key} mismatch`);
  const intentions: CoveragePlanIntention[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(plan.intentions)) errors.push('Plan intentions must be an array');
  else for (const value of plan.intentions) {
    if (!isRecord(value) || typeof value.scenarioId !== 'string' || !Object.hasOwn(scenarios, value.scenarioId)) { errors.push('Unknown or malformed scenario'); continue; }
    const id = value.scenarioId as CoverageScenarioId;
    if (seen.has(id)) errors.push(`Duplicate scenario ${id}`);
    seen.add(id);
    if (value.reviewed !== true) errors.push(`Scenario ${id} must be explicitly reviewed`);
    const allowed = allowedLinks(expected, id);
    if (!allowed.length) errors.push(`Unsupported scenario mapping ${id}`);
    const keys = new Set<string>();
    if (!Array.isArray(value.links) || !value.links.length) errors.push(`Scenario ${id} requires reviewed links`);
    else for (const link of value.links) {
      const key = linkKey(link);
      if (!key || !allowed.some(l => linkKey(l) === key)) errors.push(`Link does not match a reviewed credit rule or supported contract mapping for ${id}`);
      else if (keys.has(key)) errors.push(`Duplicate link for ${id}`);
      else keys.add(key);
    }
    intentions.push({ scenarioId: id, reviewed: true, links: allowed.filter(l => keys.has(linkKey(l)!)).map(l => ({ ...l })) });
  }
  if (errors.length) return { valid: false, errors };
  const canonical: CoveragePlan = { schemaVersion: 1, catalog: { ...COVERAGE_CATALOG }, evaluator: { ...COVERAGE_EVALUATOR }, context: { ...expected.context }, intentions };
  return { valid: true, errors: [], plan: canonical };
}
export function buildCoveragePlan(input: BuildCoveragePlanInput): CoveragePlanValidation {
  return validateCoveragePlan({ schemaVersion: 1, catalog: COVERAGE_CATALOG, evaluator: COVERAGE_EVALUATOR,
    context: input?.preparation?.context, intentions: input?.intentions }, input?.preparation);
}
