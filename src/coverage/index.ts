export * from './types.ts';
export * from './identity.ts';
export { prepareCoverage } from './prepare.ts';
export { buildCoveragePlan, validateCoveragePlan } from './plan.ts';
export { projectCoverage } from './project.ts';
export { adaptCreditEvidenceToScenarioCheck } from './credit-adapter.ts';

import { prepareCoverage } from './prepare.ts';
import { buildCoveragePlan, validateCoveragePlan } from './plan.ts';
import { projectCoverage } from './project.ts';
import type { CoverageFunctions } from './types.ts';
export const coverageFunctions: CoverageFunctions = { prepareCoverage, buildCoveragePlan, validateCoveragePlan, projectCoverage };
