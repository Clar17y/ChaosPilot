import { COVERAGE_CATALOG, COVERAGE_EVALUATOR } from './identity.ts';
import { allowedLinks, normalize, scenarios, validPreparation } from './catalog.ts';
import type { CoveragePreparation, CoveragePreparationInput, CoverageScenarioId } from './types.ts';

export function prepareCoverage(input: CoveragePreparationInput): CoveragePreparation {
  if (!validPreparation(input)) throw new TypeError('Coverage preparation requires a complete pinned context and valid requirement/contract lists');
  const suggestions = (Object.keys(scenarios) as CoverageScenarioId[]).flatMap(scenarioId => {
    const links = allowedLinks(input, scenarioId);
    return links.length ? [{ scenarioId, title: scenarios[scenarioId].title, description: scenarios[scenarioId].description, links }] : [];
  });
  const linked = new Set(suggestions.flatMap(s => s.links.flatMap(l => l.kind === 'requirement-text' ? [l.text] : [])));
  return { context: { ...input.context }, catalog: { ...COVERAGE_CATALOG }, evaluator: { ...COVERAGE_EVALUATOR }, suggestions,
    contextOnly: input.requirements.filter(r => !linked.has(normalize(r))) };
}
