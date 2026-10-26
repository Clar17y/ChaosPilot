# Authentic live comparison: prompt 2.0

These are unchanged reports from actual Meta Model API requests on 26 October 2026. They are separate from the earlier pilot in the parent directory. No mock result is included in this comparison.

- `bench_calibration_v2_20261026.json`: clean, A and B, with separate conventional/Wonder/Spark results and complete nested investigation records.
- `bench_heldout_v2_20261026.json`: new target C, two trials per approach. Both models found the defect in 2/2 trials, one experiment each; the frozen conventional generator found it in 0/2 within three experiments each.
- `preauthor-freeze.json`: frozen inputs and protocol before C was authored.
- `freeze-v2.json`: execution manifest, with matching prompt/baseline identities after harness integration.
- `fixture-provenance.json`: timing, source identity and the partial-blinding limitation.

Read [results and limitations](../../docs/CONTROLLED_RESULTS.md) before interpreting the comparison. Human timing was unmeasured. The fixture author avoided prompt/baseline/results but did read existing simulator tests and verifier code, so strict author blinding was not achieved. This is one synthetic case against one fixed generator.

## Inspect and replay without model calls

After `npm install` and `npm run build`, import the authentic held-out records into local history:

```sh
node --input-type=module -e "import fs from 'node:fs/promises'; import { saveRun } from './dist/storage.js'; const report=JSON.parse(await fs.readFile('examples/controlled-v2/bench_heldout_v2_20261026.json','utf8')); for(const arm of Object.values(report.arms)) for(const trial of arm.trials) if(trial.record) await saveRun(trial.record);"
npm run replay -- run_bench_1793054610732_75d00f
npm start
```

Open the local application, refresh history and view the imported run. The Proposals tab shows the actual prompt, request hashes, visible response and reported usage. Replay executes saved events against a fresh simulator and does not contact Meta. The reports also contain every conventional sequence under `baseline.trials[].experiments`.

The live commands used were:

```sh
node --env-file-if-exists=.env dist/cli.js benchmark --provider meta --models muse-wonder-1.0,muse-spark-1.3 --targets clean,candidate-a,candidate-b --trials 2 --seeds 1001,1002 --max-experiments 3 --freeze runs/benchmarks/freeze-v2.json --id bench_calibration_v2_20261026
node --env-file-if-exists=.env dist/cli.js benchmark --provider meta --models muse-wonder-1.0,muse-spark-1.3 --targets candidate-c --phase heldout --trials 2 --seeds 1001,1002 --max-experiments 3 --freeze runs/benchmarks/freeze-v2.json --id bench_heldout_v2_20261026
```

The original pre-authoring freeze preceded creation of C. Repeating these commands now is a replication on a known fixture, not a new blind discovery study. A new build or changed prompt/baseline requires its own manifest and clearly identified batch. Replaying the saved events requires no API key.
