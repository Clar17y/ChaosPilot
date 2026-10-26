# Evaluation and claims

## Question

Can a Meta-powered investigator construct and reproduce meaningful negative scenarios from source, a behavioural contract and observations, reducing scenario-design work or improving useful discovery compared with a conventional generator?

This is a small synthetic pilot. It cannot establish production effectiveness or general time savings for engineering teams.

## Required separation

1. Offline mock-provider tests validate plumbing and known reproductions. They are scripted.
2. Deterministic simulator tests establish replay and specified invariant behaviour.
3. Live Meta evaluation measures actual model-generated investigation.
4. Saved-run replay confirms an earlier sequence, not a fresh AI discovery.

Keep those labels in artifacts and presentations. A mock finding must never appear as live-model performance.

## Freeze before evaluation

Record the target source, contract and investigator prompt/configuration identities. Keep hidden defect descriptions and known triggers out of model context. Use fresh model sessions; retain both successful and unsuccessful trials. If a prompt or candidate changes, label the new batch separately rather than silently combining results.

The model receives source-aware clues as ordinary implementation code. Do not claim it independently inferred something that was explicitly supplied as a failure scenario.

## Conventional baseline

Use a seeded, structure-aware generator with the same operations, verifier, public message examples and experiment limits. Include useful valid workflows, mutations, duplicate business identities, delivery perturbations and cancellation/fill ordering. Mostly invalid random bytes would be a weak comparator.

Shared harness and happy-path seed setup is shared preparation. Count additional scenario-specific baseline code if introduced. Do not add secret defect-specific templates merely to make either side win.

## Metrics

- Verified distinct findings, not repeated instances of one violation.
- Trials with a replay-confirmed finding and clean-control result.
- Experiment count to first verified reproduction.
- Invalid or rejected experiment plans.
- Model requests, token use, estimated API cost and elapsed time.
- Human interventions and scenario-authoring/review effort where actually measured.
- Complete artifacts and source identity for reproduction.

Execution count alone is not a measurement of engineer effort. A small timed manual exercise can provide preliminary evidence if the engineer has not already seen the hidden defect or known reproduction. Otherwise report the comparison as contaminated, or omit the human-time claim.

A single-pass model comparison is optional and isolates the value of feedback; outperforming ordinary AI code review is not a mandatory product criterion.

## Decision rule

If a generic conventional generator needs no more custom setup and achieves comparable verified results, ChaosPilot's proposed advantage has not been demonstrated. Report that result and reassess instead of presenting synthetic bug discovery alone as superiority.

Credit, model availability and time can limit a batch. Record planned and completed trial counts; interrupted or failed trials must remain visible. A small sample cannot support broad statistical or commercial claims.

## Three-minute presentation

Show the actual Meta model, target contract/source, a generated hypothesis and experiment, the observed invariant violation, deterministic replay and clean comparison. Distinguish business occurrence from delivery order. Any cuts for model latency and any use of a recorded run should be disclosed plainly.

## Development pilots — 26 October 2026

Two initial live calls used `muse-wonder-1.0` against development versions of the target. Each constructed its own hypothesis and complete experiment; neither used the scripted mock.

| Saved run | Observation | Estimated API cost |
| --- | --- | ---: |
| `run_1793044507359_7a68rr` | Duplicate partial execution exposed the intended idempotency defect; deterministic replay matched and the corresponding clean checks passed. Two violated invariants describe one underlying defect. | $0.074216 |
| `run_1793044783458_q3kbqv` | An oversized fabricated execution exposed an unintended missing guard in Candidate B. It was reproduced and absent on clean, then corrected before the final batch. | $0.079412 |

These are development pilots, not a frozen comparison batch. Their original source hashes and source snapshots were preserved with local run artifacts. They must not be combined with later results after the target changed or presented as evidence that the intended cancellation defect was discovered. Subsequent replay against changed source must report a source mismatch.

The completed batch and its limitations are recorded below when available. Estimated application costs are not an account billing statement.

## First comparative batch

On 26 October, three trials per defect variant used Wonder, temperature 0.2, a 4,096-token output allowance, a 32,768-byte request allowance and a 30-second request deadline. Both approaches had a six-experiment limit, stopped at the first verified finding, and used the same executor, verifier, replay and clean-control criterion. Baseline seeds were 1001, 1002 and 1003; these control the conventional generator, not model randomness.

| Target | Wonder trials with a finding | Baseline trials with a finding | Model experiments executed | Baseline experiments executed |
| --- | ---: | ---: | ---: | ---: |
| Candidate A | 2/3 | 1/3 | 2 | 14 |
| Candidate B | 2/3 | 3/3 | 2 | 5 |
| Total | 4/6 | 4/6 | 4 | 19 |

Every successful model trial found the defect in its first executable experiment. One request per variant timed out before a proposal was executed. These count as unsuccessful trials, not clean outcomes. Two violated invariants can describe one underlying defect; this table counts trials rather than pretending each invariant is a distinct bug.

The reported token-based cost estimate is $0.320872. The application additionally retained $0.425984 conservatively for the two requests with unknown usage. This is an application accounting record, not an invoice. Error reporting initially masked native timeout messages; that client-side error handling was repaired after the batch. Failures were retained and were not replaced by new successful trials.

The baseline found both defect classes. Overall discovery counts were equal, and fewer executed experiments do not measure human scenario-authoring effort or include model latency. **The proposed efficiency advantage has not been established.** The next useful evaluation is a held-out target/defect exercise with measured scenario-authoring and review time, rather than a stronger claim from these same two fixtures.

The batch files, a successful A trial and a separately browser-launched B finding are in [examples](../examples/README.md). The latter was replayed through the browser with identical source, trace, state, violations, rejections and validity. A subsequent Wonder clean-target attempt timed out; a Spark clean-target attempt exhausted its first output allowance then timed out. Both are retained as failed investigations with zero executed experiments, not evidence that clean was tested successfully. Clean-control executions of the discovered sequences and deterministic clean tests are separate successful checks.

After the initial batch, the request deadline became configurable with a 90-second default. This changes the runtime configuration and does not retrospectively improve the recorded trial results. Additional experiments must be labelled separately. Invalid-plan rates in the current report count executed harness plans; proposal correction attempts are not separately counted, which limits interpretation of that metric.

## Clean-target follow-up and request tuning

The comparative batch omitted `reasoning_effort`, leaving it to Meta's model default. An additional Wonder probe with a 90-second deadline and 8,192 output tokens produced three truncated replies and no executable plan. It was cancelled rather than continuing to spend its remaining proposal allowance. Its reported cost was $0.552020, with uncertain in-flight usage retained conservatively. The cancelled artifact is preserved.

Meta documents that private reasoning and visible output share the output-token allowance. The live client now explicitly defaults to `reasoning_effort: "low"` and records nonsecret request settings in `contextAudit.providerConfiguration`. This is a changed configuration, not a retroactive improvement to the original comparison.

The separate low-effort Wonder run `run_1793049060762_nocmcm` completed with **two valid executed experiments and zero invariant violations**. It used observations from an earlier experiment for later proposals. Repeated truncation consumed another proposal slot; the artifact retains that error. Reported usage: 38,403 input tokens, 27,873 output tokens and $0.711072 estimated cost. The bound was three proposal slots, not three successfully executed experiments. No new comparative discovery rate or general clean-correctness claim follows from this run.

The current full test suite has 201 passing tests. The independent review identified overlapping startup requests, unsaved allowance reductions and unbounded logical-clock accumulation; concrete regressions and repairs cover those cases. Review and test success do not establish exhaustive schedule coverage.

Final browser acceptance separately launched a low-effort A investigation, verified its first generated finding by replay, and cancelled an in-flight clean investigation through the Stop button. Those acceptance checks are retained and are not replacement trials in the comparison. All 23 executed comparison experiments replayed exactly on the final simulator; the saved A, B and clean investigations also reproduced their semantic results. Screenshots capture the final workbench, replay report and cancellation state.
