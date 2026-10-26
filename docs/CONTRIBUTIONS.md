# Hackathon contribution record

## Origin

ChaosPilot was created as a fresh repository for the Meta Global AI Developer Hackathon. Repository inspection on 26 October 2026 found no product files or commits. Product discovery and plan approval occurred during the event.

All project implementation is newly authored for this repository. No Forge or employer-owned code, credentials, market data, documents or assets are incorporated. The trading data and venue are synthetic.

## Contributions in this build

- Product discovery: narrowed the claim to source-aware negative investigation and verified reproductions, with a conventional baseline and explicit limitations.
- Architecture: separated target source, behavioural contract, experiment execution, independent verification, provider integration and presentation.
- Engineering: deterministic trading simulation, offline/live provider separation, replay artifacts, local investigation interface and automated checks.
- Documentation: setup, behavioural rules, evaluation methodology and accepted decisions.

AI coding tools assist implementation under the participant's direction. Their output is reviewed and tested; use of coding assistance does not itself establish runtime Meta integration or discovery performance. The installed development-routing framework is a development tool, not product code copied into the submission.

## Evidence status

Live Meta integration was exercised with Wonder and Spark on 26 October. Wonder generated and verified reproductions of both intended defects. A six-trial comparison and its failed requests are preserved in `examples/`; its combined discovery count equals the conventional baseline, so no overall efficiency advantage is claimed. The browser-launched live credit-release finding was replayed without another model call. Screenshots in `docs/` capture that application state and replay report.

Offline mock demonstrations remain labelled separately. The initial build passed 201 tests. A later explicitly low-effort live Wonder run executed two clean-target experiments with zero violations and retained its truncated-proposal errors; this is not a broader clean-correctness claim.

The next iteration added a specialised versioned investigation prompt, durable per-proposal audits and UI inspection, capped three-way benchmarking, source/runtime/function freezes and one new synthetic candidate. Its final complete suite passed 293 tests, typecheck and build. Actual Wonder and Spark calls each verified the new fault in 2/2 trials, using one experiment each; the unchanged conventional generator produced 0/2 findings within three experiments per trial. All 41 recorded experiments replayed identically. The estimated reported cost was $0.953607. Strict fixture-author blinding was not achieved because the author also read existing simulator tests and verifier code; the prompt, baseline and previous run artifacts were excluded. Independent review identified comparability failure paths, which were repaired and covered with regression cases. Fake-response tests were isolated from the live spending ledger, with all prior ledger entries preserved. See CONTROLLED_RESULTS.md for the evidence and limitations.

Measured engineer-time savings and production generalisation have not been established. This record must be updated only with actual results, not planned work.
