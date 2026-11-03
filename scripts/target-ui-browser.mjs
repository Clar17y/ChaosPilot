#!/usr/bin/env node
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { runTargetUiBrowserJourney } from '../dist/target-ui/runner.js';

async function main() {
  const args = process.argv.slice(2);
  let variant = 'clean';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--variant' && args[i + 1]) {
      variant = args[i + 1];
      i++;
    }
  }

  console.log(`Starting Target UI Browser Journey against variant: ${variant}`);
  console.log('Prerequisite: an installed Chrome or Edge (or CHROME_BIN/EDGE_BIN). A missing browser is reported as inconclusive evidence, never a pass.');
  const outputDir = path.resolve(process.cwd(), process.env.TARGET_UI_OUTPUT_DIR ?? '.llm-output/issue13-repair');
  await fsp.mkdir(outputDir, { recursive: true });

  const outcome = await runTargetUiBrowserJourney({
    variant,
    screenshotsDir: path.join(outputDir, 'screenshots'),
  });

  const evidencePath = path.join(outputDir, 'target-ui-journey-evidence.json');
  await fsp.writeFile(evidencePath, JSON.stringify(outcome.evidence, null, 2));
  const outcomePath = path.join(outputDir, 'target-ui-journey-outcome.json');
  await fsp.writeFile(outcomePath, JSON.stringify({ evaluation: outcome.evaluation, screenshots: outcome.screenshots, evidencePath }, null, 2));

  console.log('\n--- TARGET UI BROWSER JOURNEY RESULTS ---');
  console.log(`Status:         ${outcome.evaluation.status.toUpperCase()}`);
  console.log(`Classification: ${outcome.evaluation.classification}`);
  console.log(`Instance ID:    ${outcome.evidence.instanceId}`);
  console.log(`Endpoint:       ${outcome.evidence.endpoint}`);
  console.log(`Exchanges:      ${outcome.evidence.exchanges.length}`);
  console.log(`Events:         ${outcome.evidence.events.length}`);
  console.log(`Observations:   ${outcome.evidence.uiObservations.length}`);
  console.log(`Screenshots:    ${outcome.screenshots.length} captured`);
  console.log('Reasons:');
  for (const r of outcome.evaluation.reasons) {
    console.log(`  - ${r}`);
  }
  console.log(`\nEvidence saved to: ${evidencePath}`);

  if (outcome.evaluation.status !== 'pass') {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nTarget UI Browser Journey failed with error:', err);
  process.exit(1);
});
