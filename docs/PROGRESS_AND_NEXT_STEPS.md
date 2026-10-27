# ChaosPilot: progress and next steps

Snapshot: 27 October 2026. This note assesses the merged product at `4844d48` against the original hackathon goal. A separate desktop UI/UX pass has finished locally in the shared checkout; its uncommitted changes and verification are not included in the merged-product claims below.

## Original goal

Build a credible end-to-end negative-testing investigator for automation engineers. Given a system's source, capabilities and business rules, it should form hypotheses, choose and execute experiments, check outcomes independently and produce reproducible evidence. The hackathon slice uses a synthetic event-driven trading system and Meta models. The proposed longer-term value is reducing the effort needed to design and prove useful negative scenarios; the longer-term vision includes other systems and transports.

The approved plan prioritised a working investigation and verified reproduction over presentation, with approximately 30 hours of the participant's time for implementation, evaluation and submission preparation. A model does not have to outperform a one-off AI code review for an automatically verified reproduction to be useful.

## What is achieved

| Goal | Current state |
| --- | --- |
| Representative target | A deterministic trading simulator covers market prices, credit, orders, cancellation and partial fills, including malformed messages and delivery delays, duplicates and reordering. Nine selectable fault variants have known offline reproductions, replay and clean controls. |
| Investigation loop | The investigator can choose structured experiments, observe deterministic checks and use observations in subsequent proposals. Each experiment starts with a fresh simulator; findings include evidence and replay. Known fault recipes are excluded from model context, while the chosen target's ordinary source is available to the investigator. |
| Model and offline operation | Live Meta Wonder and Spark providers and a labelled deterministic mock are available. There is a CLI, local application, proposal audit, saved investigations, replay and evaluation tooling. A mock run is not evidence of autonomous AI discovery. |
| Business context | The workspace supports saved system briefs, visible trading rules, investigation history and findings. New runs retain a snapshot of the saved requirements and revision they used. |
| Verification and documentation | The merged release candidate passed 401 tests, typecheck and build, with controlled browser checks. Setup, architecture, evaluation, demo and contribution records are documented. This is previous evidence for the merged candidate, not a new test of the in-progress styling edits. |

See the [README](../README.md), [architecture](ARCHITECTURE.md) and [known fault lab](FAULT_LAB.md).

## What the live evidence shows

In the initial comparison, Wonder and the conventional generator each found a defect in 4 of 6 trials. In a later controlled prompt 2.0 study, Wonder and Spark each found and reproduced one new synthetic fault in 2 of 2 trials; the existing conventional generator found it in 0 of 2 trials within the same three-experiment limit. Across that batch, 41 experiments replayed identically and reported estimated Meta API cost was about $0.95.

This is real model-generated, independently checked evidence of additional coverage against that particular baseline. It is a small synthetic study, with only two trials per model on the new fault and partial fixture-author blinding. The baseline was a fixed generator rather than a strong stateful fuzzer, and engineer time was not measured. Both models found that fault on their first experiment, so that result does not establish that feedback improved the discovery. The subsequent system-brief work changed the prompt to 3.0; no fresh live comparison of that version is recorded. The nine known fault recipes are development evidence, not a new held-out model study.

The full results, unsuccessful responses and limitations are in [controlled results](CONTROLLED_RESULTS.md) and the [evaluation record](EVALUATION.md).

## Gaps to keep visible

- Only the synthetic trading adapter can execute investigations. Other system profiles can be saved as drafts, but cannot run without an adapter.
- Additional business prose supplies model context; it does not automatically become an executable check. The existing trading adapter provides the deterministic rules.
- A replayable synthetic finding is not proof of production effectiveness or saved engineering time. The current source-aware approach is not a black-box or general transport-testing product.
- Delays and reordered messages are supported, but the current contract does not define recovery deadlines or latency service levels. A delay alone does not prove an outage, loss or latency defect.
- Feedback is available within an investigation; a persistent cross-session application knowledge base is outside the MVP.

## Build-first direction for the remaining hackathon

There is still room to extend the product. Keep developing useful capabilities while checking evidence throughout, and leave a sensible final buffer for stabilisation and the submission. These are planned outcomes, not claims about the product today.

1. **Make a second system executable.** The participant selected this as the next build. Use a small synthetic inventory-reservation system to exercise a genuinely different business contract, rather than creating another trading profile. The target should have a clean implementation, an independently checked fault, model-selected experiments, reproducible evidence and a clean comparison. Generalise only the execution seams necessary to run it; preserve trading and its saved evidence. The desktop work can continue in parallel, with the new path integrated into the interface when ownership permits.
2. **Make more business requirements checkable.** Explore a small, structured set of deterministic rules associated with a system and its supported observations. Validate and version those rules and pin them to each run. Distinguish executable checks from contextual prose; do not claim that arbitrary English can already be verified.
3. **Broaden the experiments.** Add message loss, outage recovery or latency scenarios only alongside explicit deadlines or recovery rules that let the verifier distinguish a genuine failure from a merely delayed event.
4. **Make findings useful after discovery.** Improve the path from a confirmed failure to a reusable regression: preserve the relevant system revision, experiment, model provenance and expected versus actual evidence, with a straightforward way to rerun or export it.
5. **Evaluate as the product evolves.** Exercise the current requirements-aware version with a bounded live model run after checking promotional credit and application limits. Strengthen the conventional baseline and compare against independently authored fresh faults under predeclared budgets. Preserve failed and inconclusive trials; measure engineer time only if a fair exercise is available.
6. **Keep the demo ready without stopping development early.** Integrate and verify the new system against Astra's completed desktop work. Use a genuine saved Meta finding as a dependable demonstration fallback, then update the story as new features are verified. Reserve the final period for stabilisation, evaluation and submission; see the [three-minute demo outline](DEMO.md).

The first delivery should demonstrate the full loop on a second system, not just add a selectable profile. General-purpose adapters, arbitrary natural-language verification and real transport integrations remain future work until their own end-to-end behaviour is implemented and verified.
