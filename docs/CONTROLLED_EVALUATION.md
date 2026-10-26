# Controlled evaluation protocol

This protocol is specified before the new held-out fixture is created. Earlier pilot results remain separate in EVALUATION.md and examples/. Human timing is explicitly unmeasured for this batch at the participant's request.

## Question and limits

Can the specialised investigator produce useful, verified negative scenarios beyond the unchanged conventional generator, and what runtime and API resources do Wonder and Spark need?

This synthetic pilot can measure reproduced failures, invalid proposals, elapsed runtime and reported API usage. It cannot measure engineer-time savings, production effectiveness or statistical superiority. A held-out mutation is a fresh synthetic case, not a production bug or a representative population of systems.

## Freeze and separation

The conventional generator in `src/evaluation.ts` is unchanged from the previous MVP. Its identity is recorded before fixture creation. The specialised prompt, prompt-template hash and compatible request settings are frozen before the held-out fixture is authored.

The fixture author receives the public trading contract and clean implementation, uses fresh development context, and is instructed to avoid the prompt, baseline generator and prior result artifacts. The author introduces one different defect and keeps its answer key and known reproduction outside model context. The runtime investigators receive only the selected ordinary business source, public contract and their own observations. Selected files keep neutral names.

The frozen prompt/baseline identities are checked by the evaluator. Target source and contract identities are recorded for every case. New fixtures and findings must not be used to retune the frozen prompt or conventional generator and then counted in the same held-out batch.

## Planned first batch

| Property | Setting |
| --- | --- |
| Calibration targets | Clean, Candidate A, Candidate B |
| Held-out targets | One newly authored candidate, created after freeze |
| Live models | `muse-wonder-1.0`, `muse-spark-1.3` |
| Trials | 2 per target and live model |
| Experiment limit | 3 per trial for every approach |
| Provider-call limit | 3 per model trial, including rejected proposals |
| Reasoning effort | Explicit `low` for both models |
| Temperature | 0.2 |
| Output allowance | 4096 tokens, including private reasoning |
| Request allowance | 32768 bytes |
| Per-request deadline | 90000 ms |
| Baseline seeds | 1001, 1002 |
| Stopping | First verified finding, explicit model stop, cancellation or budget exhaustion |
| Model order | Counterbalanced across trials and recorded |
| Human effort | Unmeasured |

The maximum is 48 model calls across calibration and held-out phases, before early stops or the existing application allowance intervene. There is one shared durable spending ledger; no new ledger or account allowance is created for this study. No automatic billing/provider fallback is permitted. A bounded partial batch is a valid outcome and must remain visible.

The two models receive identical initial prompt text for a given target. Exact prompt hashes establish this; request hashes also include the chosen model/settings and therefore may differ. Later messages legitimately differ because the models choose different experiments and receive different observations. The conventional generator uses the same executable operations and verifier; it is a fixed non-AI algorithm, with no natural-language prompt.

## Records and scoring

Every provider call gets a pending record before invocation and a final outcome when known. Save prepared request text and hashes without headers or credentials, visible response and finish reason, rejection reason, reported usage, unknown-usage status and elapsed time. Private reasoning is not requested or logged. An interrupted pending call stays pending or explicitly cancelled; it is never reconstructed as a successful response.

Keep separate counts for provider invocations, known attempted network requests, uncertain request states, rejected responses, rejected plans, executed experiments, harness-invalid experiments and verified findings. Rejected proposals consume the call allowance. A zero reported cost with unknown usage does not mean zero spend; the durable ledger retains a conservative allowance.

A finding requires a valid executed plan, deterministic semantic replay and successful clean execution without the corresponding invariant violation. Count a trial with a finding once even if one defect violates multiple invariants. Preserve full traces and inconclusive cases.

Clean-target findings are constrained by the clean-comparison rule, so also report raw invariant violations, valid executed cases without violations and trials with no executed experiment. A timeout or empty investigation is not a clean pass.

## Interpretation

Calibration selects whether the setup is usable; it is not held-out evidence. The new fixture tests the frozen setup once. Do not replace failed trials or combine earlier prompt/configuration versions to improve a headline rate. If the model and baseline achieve comparable coverage, report that. If the model finds a case the generator misses, report the additional verified coverage and measured runtime/cost, while keeping engineer-effort savings unclaimed.

An optional same-model comparison with and without execution feedback can isolate the value of iteration later. It is not a mandatory hurdle for this batch and does not replace the comparison with the conventional generator.
