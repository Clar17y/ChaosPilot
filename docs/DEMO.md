# Three-minute demonstration

Use evidence from an actual live Meta investigation. If only offline scripted runs exist, describe the demonstration as offline validation and leave the autonomous-discovery claim unmade.

| Time | Screen and narration |
| --- | --- |
| 0:00–0:20 | Explain the automation engineer's problem: anticipating useful combinations of valid, malformed and reordered business messages. |
| 0:20–0:40 | Show the public behavioural contract and selected ordinary target source. Explain that hidden defect labels and known triggers are excluded. |
| 0:40–1:15 | Launch a bounded Meta investigation, or inspect a clearly labelled saved live run. Identify the actual model and provenance. |
| 1:15–1:50 | Show a generated hypothesis, concrete message plan and observed results. Explain any adaptation from an earlier experiment. Do not invent an adaptation if the first experiment found the bug. |
| 1:50–2:20 | Inspect the deterministic invariant violation and order/credit evidence. Distinguish business occurrence from report delivery. |
| 2:20–2:45 | Replay without another model call and inspect the clean-control result. The same experiment should reproduce the candidate failure without the same failure on clean. |
| Optional second system | Switch to the seeded **Inventory reservation service** profile (`inventory-reservation` adapter, target `inventory-candidate-a`) and run the labelled offline mock sequence. Open the finding in the reproduction timeline: stock receipts and competing reservations show recorded SKU stock/on-hand/reserved values, and rerunning the selected experiment replays exactly that experiment with no model or clean-comparison call. Describe this as offline validation of the second synthetic system, not a live discovery. |
| Optional requirement check | In the trading brief, review and attach the credit-limit check to the requirement about total commitments. Save, select **Candidate C** and **Mock**, then launch. The scripted credit-admission example shows a failed check under **Experiments**, with the observed credit values. For a passing comparison, launch a second mock run against **Clean control**. This is an offline demonstration, not a live AI discovery. |
| 2:45–3:00 | Give the actual evaluation outcome and limits: synthetic target, source-aware access, measured results and work remaining. |

Model inference may take longer than the recording. Cuts and recorded runs are acceptable when labelled. Replaying a genuine run does not become a fresh discovery. A scripted mock never becomes a live model demonstration.

Before recording, verify the run artifact, source identity, provenance, replay and conventional-baseline report. Quote actual completed trial counts and costs. Avoid a claim of engineer-time savings without a valid timed comparison.

The Proposals tab now separates model invocations from executed experiments. Show a rejected proposal if the selected run contains one, then its correction and resulting execution. Prepared request audits contain the actual prompt text and hashes; visible response audits contain no private reasoning. Initial prompt hashes should match between Wonder and Spark for the same target in a controlled batch. Report benchmark results from the corresponding version and freeze manifest, keeping calibration and held-out results separate.

The prompt 2.0 held-out run `run_bench_1793054619004_8e332a` is an authentic saved Spark finding. Import instructions are in `examples/controlled-v2/README.md`. It discovered the fault on the first experiment; do not narrate an adaptation that did not occur. `docs/heldout-finding-proof.png`, `docs/proposal-live-proof.png` and `docs/heldout-replay-proof.png` capture inspection and replay of this run. Its batch showed additional coverage over the fixed generator, with partial fixture-author blinding and unmeasured human timing.

For a live presentation, keep an authentic completed investigation available to inspect while a new one runs. Explain whether the screen shows a new investigation or saved evidence. A failed or inconclusive fresh run remains a legitimate outcome; do not replace it with an unlabelled scripted path.
