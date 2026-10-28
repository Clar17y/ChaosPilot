# Adding an execution adapter

ChaosPilot runs synthetic systems through registered adapters. Two are
registered today: `synthetic-trading` and `inventory-reservation` (see
[SECOND_SYSTEM.md](SECOND_SYSTEM.md)). This guide is the minimum integration
contract for a future adapter. An unknown or unconfigured adapter is never
executable: registration and server support are explicit, and arbitrary
external systems are not supported automatically.

## Server registration

Register the adapter in `src/adapters/index.ts` by supplying the full
`AdapterRegistration` interface:

- `id` — stable adapter id string.
- `variants` — the closed list of target variants this adapter may execute,
  including its clean control (`clean`). Variants are never shared across
  adapters; launches with a cross-adapter variant fail before any provider
  call (`assertAdapterVariant`).
- `getContract()` — the pinned public `SystemContract` (operations, messages,
  invariants, limits). It is snapshotted into every run and hashed with
  canonical JSON.
- `getSourceBundle(variant)` — model-visible source files plus a stable
  content hash per variant, including `clean`. Source identity gates exact
  replay claims, so hashes must change whenever executing behaviour changes
  and must not depend on timestamps or machine state.
- `parseExperiment(input)` — strict validation of untrusted experiment JSON
  into bounded actions for this adapter only.
- `executeExperiment(experiment, variant)` — deterministic execution from a
  fresh state. It must produce the shared evidence shape: ordered `trace`
  entries (action index, outcome, payload, state after the entry),
  final `snapshot`, `violations` from an independent oracle (not the target's
  own transition code), `rejections`, `valid`, and the executing
  `sourceHash`. Execution must be bounded (actions, messages, logical time)
  and must not use wall clocks, randomness, network or persistence.

## Saved-system and investigation support

Registration alone does not make an adapter launchable. A complete
integration also needs:

- The adapter id accepted by system-brief validation
  (`src/systems/index.ts`, `src/domain.ts`) so a profile can be saved and its
  brief plus contract pinned by snapshot hash.
- A seeded or creatable saved profile whose snapshot the server can return
  (`GET /api/systems/:id/snapshot`), plus per-adapter targets via
  `GET /api/targets?adapterId=<id>` (served from the registry).
- Prompt identity for the adapter in `src/investigation/prompt.ts`
  (`getPromptIdentity`): version, template hash and system message. The mock
  and Meta providers record this identity in every request audit; replay
  compares it against saved evidence.
- Provider context: the mock provider needs a labelled scripted sequence for
  offline work (never presented as AI discovery); the Meta provider path
  reuses the same prompt identity and parser. No live calls are required to
  develop or test an adapter.
- Clean-control semantics: findings require the same plan to pass on the
  adapter's `clean` variant. The clean source hash is recorded in the run
  audit and checked on replay.

## Replay and evidence

Full-run replay (`POST /api/runs/:id/replay`) and selected-experiment replay
(`POST /api/runs/:id/experiments/:position/replay`, zero-based saved array
position) share the same gates in `src/storage.ts`: adapter/variant
resolution from saved evidence, snapshot and plan integrity, and prompt,
contract, clean-source and target-source context checks. Selected replay
executes exactly one experiment, invokes no model and does not rerun the
clean comparison. Result-level match counts and behaviour-match status are
reported separately from source/context-gated exact reproduction; drifted or
unverified context produces a report, never a verified exact claim. A new
adapter gets this behaviour by producing the evidence shape above — do not
add adapter-specific replay paths.

## Browser playback

The reproduction player is evidence-driven, not adapter-driven. Trading
credit views and inventory stock/reservation facts appear only when recorded
trace state or violation evidence actually contains those shapes. Unfamiliar
payloads, outcomes and state shapes fall back to a neutral timeline: recorded
action and outcome text, primitive payload fields, and the raw recorded
state. Delivery outcomes such as accepted, duplicate or rejected are shown
as recorded neutrally; none is a pass or fail by itself. To make the adapter
selectable in the UI, list it as executable in `src/web/workspace.ts` and in
the adapter select in `public/index.html` — only after the server support
above exists. Optionally add a state presentation in `src/web/snapshot.ts`
keyed by the run's pinned adapter; unknown adapters must keep the neutral
`unknown` presentation rather than borrowing another system's labels.

## Limitations

- Adapters are local deterministic synthetic systems. Registering one does
  not connect a real application, message bus or database.
- Benchmark and evaluation harnesses may remain scoped to specific adapters;
  say so explicitly rather than implying coverage.
- Replay can only claim exact reproduction when source and recorded context
  still match current code. Changing an adapter's contract, prompt or source
  legitimately turns older runs into drift reports.
