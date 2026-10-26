# Proposed overnight goal: test the advantage against a stronger baseline

Status: proposed; not activated. The first MVP and prompt 2.0 results are the checkpoint. Existing evidence must stay intact. Human timing remains unmeasured.

## Outcome

Produce a reproducible comparison that establishes whether the frozen ChaosPilot investigator adds verified failure coverage beyond a stronger stateful non-AI generator on three newly authored synthetic faults. A negative or inconclusive result is a valid completed outcome. Do not keep changing the benchmark until the AI wins.

This is a development-and-evaluation goal, not an instruction to run the known fault repeatedly throughout the night.

## Work and sequence

1. Extend the conventional baseline with bounded stateful generation: multiple orders, outstanding reservations, used credit, partial fills, cancellations, stale updates and independent delivery order. Generate valid venue operations from observed public state. Preserve seeds and every invalid plan; avoid adding a dedicated recipe for each known defect. Retain the original generator and its reports for comparison.
2. Test the stronger generator offline against clean and the now-known A/B/C cases. Freeze its source/runtime/function identities, the existing investigator prompt, contract, model settings, seeds and scoring rules before authoring new faults. Record the opportunity budget as well as model calls; count rejected proposals. No claim that a model call and a generator step have equal wall-time cost.
3. Author exactly three new, distinct single-mutation candidates, selected once from the clean implementation under the public contract. Separate fixture authoring from benchmark/prompt work. Supply a copied workspace containing only public contracts, required types and clean business files; validate that author-visible files contain no baseline, investigator prompt, prior reports, oracle or existing reproductions. Keep known reproductions and answer metadata outside investigator context. Use an independent integration step after each author has fixed the mutation choice. If the intended isolation cannot be demonstrated, label the batch partially blinded or incomplete instead of asserting strict blinding.
4. Validate each once-chosen fixture with the unchanged independent verifier, deterministic replay and a valid clean comparison. Do not substitute another fault because a model or baseline succeeds or fails. Record invalid fixtures as exclusions with their reason and keep their authoring evidence.
5. Run two trials per new target and per live model, with a maximum of three proposals/experiments per trial. Compare the stronger baseline once per target and seed with Wonder and Spark using the same verifier. This permits at most 36 live calls before early stopping. Preserve identical initial prompt information, counterbalanced model order and every error, timeout, truncation and incomplete trial.
6. Replay every recorded experiment, inspect per-invariant clean contrasts, check actual request identities and reconcile reported usage. Produce a morning report with raw trial results, unique defect classes, valid/no-violation clean cases, invalid proposals, confirmed/uncertain requests, wall-clock measurements for all approaches, API cost and limitations.

## Proposed limits

- Maximum additional Meta API allowance: **$5**, including conservative reservations for unknown usage. Enforce this as a cumulative batch allowance inside the existing shared production ledger and its remaining $25 application cap. Do not replace, reset or silently increase that ledger. Under the current low/4096-output/32768-byte settings and recorded pricing, 18 calls per model reserve at most $4.88448 in total; check actual configured bounds, prices and remaining allowance before launch. Never launch an unbudgeted full batch. This proposed allowance requires approval when activating the goal.
- Development uses the installed subscription routing framework and existing ownership/review rules. No switch to API billing or alternate credentials to bypass limits.
- Stop live evaluation when the approved allowance, fixed trial list or existing account/application limits are reached. Save partial results instead of replacing failed trials.
- No changes to the frozen investigator prompt after new fixtures are created. Keep mock development checks visibly separate from actual model evaluation.
- Preserve the current public contract and oracle. Add no transports, frontend redesign, database or deployment work to this goal. A fault requiring a new contract is a later study.
- Work on a `codex/` branch after the first-cut checkpoint. Local commits are allowed; leave overnight work unpushed for morning inspection unless publication is separately requested.
- Finish when the predeclared batch and report are complete or the approved evaluation allowance prevents more calls. If development or authoring isolation is blocked, record the concrete blocker and completed work. A connection outage or account limit must not trigger repeated uncontrolled retries.

## Morning deliverables

- A stronger seeded baseline with focused automated coverage.
- A frozen protocol and verifiable fixture-author input manifests.
- Three once-chosen fixture outcomes, including any documented invalid exclusions.
- Actual comparative artifacts and deterministic replays, or an explicit partial batch with its stopping reason.
- A concise answer: what additional coverage did ChaosPilot provide, how much runtime and API cost did it require, and what remains unproved?

The Codex goal is complete when these deliverables and their limits are recorded, irrespective of which approach performs better. The question of engineer-time savings remains outside this overnight batch.
