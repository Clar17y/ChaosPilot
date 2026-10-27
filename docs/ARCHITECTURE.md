# Architecture

## Data flow

Browser or CLI → shared investigation runner → model provider → structured experiment → fresh simulator → deterministic verifier → observations for the next proposal.

A confirmed finding additionally carries a matching source identity, reproducible experiment and clean-control result. The application is one local Node.js process; the browser is a small TypeScript client. JSON artifacts provide persistence without a database.

## Boundaries

`src/domain.ts` defines integration records. `src/simulator/` owns business rules, logical venue, scheduler, input decoding, invariant checks and target source bundles. `src/investigation/` owns the bounded investigation lifecycle. `src/providers/` owns Meta transport, mock proposals, request validation and usage accounting. The server, CLI and evaluator consume the same core APIs.

The runtime model may see the selected system's business overview and contextual requirements, public contract, selected target source and experiment observations. It has no shell or general filesystem tool. Source paths are selected by the host; the model cannot choose arbitrary files. Environment configuration, tests, hidden selectors, answer keys, other implementations and verifier internals are not included.

Source awareness permits reading ordinary faulty code. It does not permit supplying a defect label, planted trigger or clean reference. The exact business code shown to the model must correspond to the executed candidate. Hashes bind observations and replay to that source.

## System briefs and executable contracts

`src/systems/` stores versioned system briefs as JSON under the configured run directory. A brief has a stable ID, name, overview, contextual requirement list and adapter selection. The browser supports create, edit, save and selection; the CLI accepts a saved system ID. Dirty forms cannot launch, and an expected revision guards against launching a profile that another client has changed.

Only `synthetic-trading` is executable. An `unconfigured` profile can preserve a future system definition but cannot start a provider. A trading profile uses the same public trading contract and simulator; editing prose does not change their behavior or turn a new domain into an adapter. The UI therefore distinguishes the ten existing deterministic checks from supplementary requirements that are context only.

New runs pin a full brief/contract snapshot with a revision and canonical content hash. The engine validates it against the execution contract and copies it into the provider context and run record. A later profile edit cannot rewrite old evidence. Legacy records without a snapshot remain readable and explicitly lack that provenance. Prompt 3.0 includes this business context; the archived prompt 2.0 comparison remains an earlier, separate evaluation.

Creation, update and seeding share a per-system filesystem lock and compare-and-swap revision check. Lock acquisition is bounded and never steals an apparently old lock. Only an absent seed file is created automatically; invalid existing files fail visibly and remain intact. A process crash can leave a lock requiring operator inspection after confirming that no writer remains. There is no automatic crash-recovery or lock-stealing claim. Writes use a temporary file followed by rename; this provides atomic replacement under the supported local filesystem, not a power-loss durability guarantee.

The known development fault catalog lives in `src/testing/fault-catalog.ts`. It contains human/test descriptions and reproductions for candidates A–I, and is excluded from provider context and target source bundles. Each new candidate changes one business behavior under the unchanged public verifier. This library proves catchability of known scenarios; it is not a held-out discovery benchmark.

## Browser workspace

The plain TypeScript client separates Overview, Brief & requirements, Capabilities & checks, Prepare investigation, Investigations and Findings & reproductions. These views use the same profile, launch, status, artifact and replay APIs. The illustrative Astra prototype is a design reference; its sample records and proposed fields are not runtime data.

The selected system, editable draft, inspected run and globally active investigation have distinct identities. Navigation retains an unsaved draft, while profile switching and launch require save or discard. An inspected run shows its own pinned system/revision; findings from another system are not attributed to the selected workspace. A global run bar preserves cancellation access across views. Unconfigured profiles expose no executable trading operations.

`src/web/workspace.ts` holds client state predicates and history grouping. Run summaries include optional system ID, name, revision and snapshot hash, derived while storage already reads the record. This avoids fetching every full run again merely to group history. Records without that metadata remain explicitly unassigned legacy records. The run detail fetch still provides the full immutable snapshot and evidence.

`src/web/request-boundaries.ts` supplies the async operations used by the actual handlers. Stop follows the lifecycle's deferred/immediate decision, independently of a launch handler still awaiting status. Stop controls use the unsettled-start phase; the broader launch-handler guard prevents a second overlapping launch. Status responses apply in request order only when no newer response has already applied, with explicit-action generations invalidating older work. This allows slow requests to make progress while preventing stale responses or errors from restoring older state. Drafts have no saved workspace ID, and profile-loading errors are shown without replacing existing loaded context or dirty edits.

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
