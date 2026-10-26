# Controlled evaluation, prompt 2.0

On 26 October 2026, both live Meta models produced verified reproductions of a new synthetic defect that the frozen conventional generator missed within the same three-experiment limit. This is additional coverage against this particular baseline on one case. Engineer time was explicitly unmeasured.

## Results

Every faulty-target cell below represents two trials per target. A trial counts once even when one defect violates multiple invariants.

| Phase | Conventional generator | Muse Wonder 1.0 | Muse Spark 1.3 |
| --- | --- | --- | --- |
| Calibration: A and B | Findings in 3/4 trials | Findings in 4/4 trials | Findings in 4/4 trials |
| New target: C | Findings in 0/2 trials; 6 experiments | Findings in 2/2 trials; 2 experiments | Findings in 2/2 trials; 2 experiments |
| Clean calibration | 2 trials, 6 valid experiments, 0 raw violations | 2 trials, 4 valid experiments, 0 raw violations | 2 trials, 4 valid experiments, 0 raw violations |

Each model found C on its first proposal in each trial. Mean total trial time was 3.86 seconds for Wonder and 3.93 seconds for Spark. Reported estimated API cost for the two held-out trials was $0.067836 for Wonder and $0.022930 for Spark. The baseline's elapsed time was not recorded; these numbers do not establish a wall-time advantage over conventional execution.

Across both phases there were 24 actual Meta requests, 20 model-executed experiments and 21 conventional experiments. Four truncated responses, two from each model during clean calibration, remained in the records and consumed the call allowance. There were no harness-invalid executed plans, failed trials or unknown-usage requests in this batch. The total reported estimated API cost was $0.953607. The durable application allowance is separate from account-wide promotional credit and usage.

Acceptance checking found that two offline test files had used the default local spending ledger while settling fake responses. These were simulated settlements with no real model requests. Both files now use temporary ledgers; the full suite leaves the live ledger byte-identical. Earlier local entries were preserved conservatively. Live batch costs above come from the actual request records, not a subtraction of mixed historical ledger totals.

## What C demonstrated

The new credit-admission calculation omitted already used credit. After a fill converted reserved credit into used credit, another order could be admitted even though total commitments exceeded the limit. Both models constructed a fill-then-new-order sequence from the selected ordinary source. The existing `credit_limit_respected` invariant detected the improper admission, exact replay reproduced it, and clean rejected the extra order without the corresponding violation. The known fixture reproduction was never included in runtime model context.

This demonstrates source-aware experiment construction and deterministic verification. The held-out findings occurred on the first experiment, so they do not demonstrate that feedback was necessary for those discoveries. Clean-target trials exercised subsequent proposals with observations; an ablation would be needed to measure the value of feedback itself.

## Freeze and blinding

The pre-authoring freeze was recorded at **22:26:41.988 UTC**, before the fixture author started at 22:26:52 UTC. It binds prompt source/runtime bytes, baseline source/runtime bytes, loaded function identities and the predeclared protocol. The conventional source remained `d92d70216d50d859e3be9efae039451a99c238e3ba7a6447616371191811323a` throughout.

The fixture's private answer record was created at 22:33:28 UTC, before held-out inference at approximately 22:43:30 UTC. A standard execution freeze manifest was captured at 22:35 after harness repairs. Its prompt and baseline were checked against the earlier pre-authoring freeze; every frozen input was unchanged. Existing clean/A/B executing source identities were also unchanged. Both phases used the same specialised prompt and settings, with matching initial prompt hashes across models and trials for each target.

**Blinding was partial.** The visible authoring log showed no content reads of the investigator prompt, conventional generator, prior run artifacts or credentials. However, the author read existing simulator tests, including previous reproductions, and verifier code while integrating C. That exceeded the intended authoring boundary. We preserve the result and disclose the deviation; this is not a strictly blind independent mutation study. The runtime models still received only the selected ordinary business files, public contract and their own observations. No prompt or baseline was retuned after fixture creation, and no alternative fixture was substituted.

## Verification and limits

All **41 recorded experiments** were replayed against the final compiled sources with identical source identities, validity, snapshots, traces, violations and rejections. All **16 invariant finding records** passed the corresponding valid clean comparison; these represent three deliberate defect classes, not 16 independent bugs. All 24 request audits were checked against actual prompt/body hashes, selected source and controlled settings. Exact credential scanning found no configured key in candidate public files or published reports.

The final integrated automated suite passed **293 tests in 17 files**, plus TypeScript checking and the production build. Offline CLI defaults, legacy saved-run inspection and browser replay of the new live finding were exercised. The external review routes encountered connection failures and revoked sign-in respectively; a fresh native reviewer provided independent context using the same provider as the primary integration work. Review found related freeze/source failure paths that could retain a misleading comparability label. These were fixed together, with regression checks for initial and between-trial freeze failures, identity changes during awaited inference, and unchanged identities after normal network failures. Mock benchmarking also rejects live model labels. These reporting repairs do not change the frozen prompt, baseline, simulator or successful recorded measurements; authentic reports were retained without rerunning the models. Review is separate from replay/test evidence, and the auxiliary Jev scan had partial coverage.

The fixture and conventional generator are small and synthetic. Two trials are not statistical evidence, and the existing generator is a fixed six-family algorithm rather than a strong stateful coverage-guided fuzzer. The models had ordinary target source access. Additional coverage here does not prove production effectiveness, superiority to stronger baselines or measured engineer-time savings.

The next useful experiment is a larger, predeclared set of independently authored faults with stricter authoring isolation and a stronger stateful non-AI baseline. Preserve this batch rather than retuning against C and counting another run as held-out evidence.

See the [predeclared protocol](CONTROLLED_EVALUATION.md) and [authentic artifacts and replay commands](../examples/controlled-v2/README.md).
