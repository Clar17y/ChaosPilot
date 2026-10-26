# Architecture

## Data flow

Browser or CLI → shared investigation runner → model provider → structured experiment → fresh simulator → deterministic verifier → observations for the next proposal.

A confirmed finding additionally carries a matching source identity, reproducible experiment and clean-control result. The application is one local Node.js process; the browser is a small TypeScript client. JSON artifacts provide persistence without a database.

## Boundaries

`src/domain.ts` defines integration records. `src/simulator/` owns business rules, logical venue, scheduler, input decoding, invariant checks and target source bundles. `src/investigation/` owns the bounded investigation lifecycle. `src/providers/` owns Meta transport, mock proposals, request validation and usage accounting. The server, CLI and evaluator consume the same core APIs.

The runtime model may see only the public contract, selected target source and experiment observations. It has no shell or general filesystem tool. Source paths are selected by the host; the model cannot choose arbitrary files. Environment configuration, tests, hidden selectors, answer keys, other implementations and verifier internals are not included.

Source awareness permits reading ordinary faulty code. It does not permit supplying a defect label, planted trigger or clean reference. The exact business code shown to the model must correspond to the executed candidate. Hashes bind observations and replay to that source.

## Simulation state

The target combines a latest quote, latest credit limit, used and reserved credit, and a collection of orders with immutable accepted terms. The logical venue maintains business occurrence independently from report delivery. The scheduler has explicit message identities, due times and deterministic tie ordering.

No simulator behaviour depends on wall time, model latency or unseeded randomness. Logical time and delivery controls form part of the experiment.

The normal message vocabulary covers quote, credit-limit, new-order, cancellation, execution and cancellation acknowledgement. Raw injection bypasses message-shape assumptions without bypassing experiment-envelope validation. Invalid target input and invalid test commands are different outcomes.

## Credit and cancellation

Acceptance must account for existing reservations and used credit. Fills consume the corresponding reservation once. Cancellation releases only the confirmed cancelled quantity; it cannot assume every unit not yet reported as filled was cancelled.

If an earlier fill report remains in transit when cancellation acknowledgement arrives, its outstanding reservation remains necessary. The later execution report is valid when it respects business chronology and the other contract rules.

A credit-limit reduction can legitimately leave existing commitments above the new limit. The admission rule is evaluated when a new commitment is made, rather than expressed as an unconditional assertion that current exposure is always below the latest limit.

## Independent verification

The oracle evaluates transitions and preserves transient violations even if subsequent messages conceal them. Expected behaviour comes from the contract, not from model commentary or fault switches. Tests include hand-checked valid and invalid cases to guard against a verifier that merely repeats target implementation mistakes.

Findings and rejected hypotheses remain separate. An inconclusive investigation is never labelled proof of correctness. A model's proposed explanation is supporting context; the invariant evidence and replay establish the reproduced failure.

## Runtime lifecycle

The server permits one active investigation. A stop request aborts pending inference and prevents later simulator dispatch, including a late response after cancellation. Partial evidence remains available. Model-request timeouts, provider failures and exhaustion must settle to explicit statuses.

The live provider bounds input, output, request duration, attempts and cost. Reservations cover uncertain in-flight usage and persist across restarts. Cancelling a local HTTP request is not a guarantee that remote inference stopped billing. Application allowances do not cap independent account usage.

The browser never receives provider credentials. Model text, injected messages and artifact data are rendered as text, rather than interpreted as HTML or executable code.

## Reproducibility

Keep the experiment, relevant contract/source identity, semantic trace, violations, provider provenance and usage. Replaying an artifact executes deterministic simulator actions without requesting a new model proposal. A source mismatch must be surfaced before claiming identical reproduction.

Live inference, scripted mocks, conventional generation and replay have distinct provenance. Model thoughts are not requested or displayed; the UI shows concise hypotheses, proposed actions and observable evidence.

## Proposal audit and controlled comparison

The specialised investigator prompt is versioned in `src/investigation/prompt.ts`. It asks for a causal, testable hypothesis and a small executable plan. The model chooses message contents, business times, delivery order and subsequent probes; the simulator and verifier decide what happened. Malformed model JSON is a rejected proposal, while malformed business data inside a valid experiment can be a legitimate probe.

Each provider invocation creates a pending proposal before inference. The Meta adapter records the actual prepared system/user text, prompt hash, request hash and whitelisted settings before attempting the network request. Headers and credentials are excluded. The final audit retains the visible response, finish reason, validation outcome, duration and reported usage when available. A missing audit or unknown request outcome remains unknown. The browser exposes these records in the Proposals tab.

`src/benchmark.ts` runs the existing conventional generator once per target and seed, alongside separately identified model arms. Rejected proposals consume the model call allowance. Initial prompt parity, selected source/contract identity, settings, arm order, raw violations, verified findings and incomplete trials are recorded. A freeze manifest binds the prompt and conventional implementation before a new fixture is authored. See `CONTROLLED_EVALUATION.md` for the predeclared batch and interpretation rules. Human timing is unmeasured.
