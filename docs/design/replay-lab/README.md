# Replay lab (design prototype)

Self-contained interactive prototype testing one shared replay design against
different recorded finding shapes. This is a design test, not production
integration, and makes no AI-discovery claim.

## Deliverables

- [replay-lab.html](replay-lab.html) — literal HTML fragment (unique root
  `chaospilot-replay-lab`, all CSS/JS/data embedded, no network calls, <1 MB).
- [replay-core.mjs](replay-core.mjs) — reusable generic projection: state
  field diff, credit/stock views, unique-attribution, lens dispatch, playback
  index helpers. No case/variant-ID branching.
- [generate.mjs](generate.mjs) — regenerates data and the fragment from real
  offline simulator executions.
- [cases.json](cases.json) — generated recorded cases (raw traces, snapshots,
  violations as executed).
- [coverage.json](coverage.json) — machine-readable per-case coverage linking
  recorded violations to attributed/action-level frames and lenses used.
- [candidate-identity.json](candidate-identity.json) — base HEAD and SHA-256
  hashes of scoped source and generated artifacts.
- [replay-lab.test.mjs](replay-lab.test.mjs) — focused Node tests.

## Generation

```sh
npm run build
node docs/design/replay-lab/generate.mjs
node --test docs/design/replay-lab/replay-lab.test.mjs
```

Regeneration is deterministic (verified by identical fragment SHA-256 across
runs). Trading cases execute the nine `FAULT_CATALOG` known experiments
(candidate-a…i) on their fault variant plus the same recipe on `clean`;
inventory cases execute the known proposals for reservation availability,
cancellation release and duplicate shipment, a combined candidate-d recipe,
plus clean controls. All are labelled Known-recipe demo / recorded playback.
Six separately labelled synthetic fixtures cover unknown nested fields,
known→missing→known state, shared-action ambiguous attribution, empty trace,
neutral duplicate outcome, and two entities with a negative balance.

## Design contract

- One generic, unframed dark stage for every case: Recorded event → System
  under test (schematic, no invented topology) → Observed state, with the
  animated packet travelling on the line between the labelled node dots.
  Captions use human-readable event names; raw strings stay in the evidence
  disclosure.
- Every displayed value comes from the active case's recorded payload/state
  or clearly labelled arithmetic (e.g. used + reserved, whole-case scale).
  Missing state renders as "State not recorded", never as invented removals
  or zero; a first snapshot (including the first after a gap) is labelled as
  such; recorded `null`, `false` and `0` stay distinct from unavailable.
- A violation marks a single entry only when exactly one processed entry
  matches it. The coral check marker sits at that entry's observed-state
  node — never on all three nodes. Shared-action violations appear only at
  frames of their recorded action, labelled group-level, with duplicate
  messages deduplicated in the banner; a separate case summary reports the
  recorded count without implying detection at the current entry. All
  original violation records remain in the evidence disclosure.
- Only recorded violations get failure styling. Accepted/rejected/duplicate
  outcomes are neutral. No violations means "No violation recorded", not
  proof the system is correct.
- Credit case (candidate-c): one combined used+reserved bar on a stable
  whole-case scale with a fixed limit marker — 100 used + 100 reserved
  reaches 200 against the 100 limit at the scale midpoint. Negative
  quantities get a signed, proportional display, never a full positive bar.
- Switching to an empty, clean or missing-state case resets every visual
  state and disables empty-case controls.

## Lens dispatch

Dispatched by evidence semantics, never by case/variant ID. The recorded
violation family (invariant/category) wins first — version, lifecycle,
stock/reservation balance, identity/input-integrity (repeated or conflicting
event identity and outcome), credit capacity — then per-path field changes
(each path tested separately, never a concatenated string): a changed
version or status field, a duplicate outcome, or credit/stock fields changed
at this frame. A credit or stock snapshot that this frame neither violates
nor changes never hijacks the lens. Each frame carries a structured
`visual` model (combined used/reserved/total/limit with scale percentages;
stock rows with over-reservation; version/status before→after with the
relevant quantities; identity occurrences and price conflicts; or the first
changed values for an unfamiliar finding). The generic before/after diff is
the mandatory fallback, including string, boolean, nested and missing
values. Raw evidence stays available in the disclosure per step.

## Playback

Case selector, Play/Pause (one owned playback controller in
[replay-core.mjs](replay-core.mjs), driven by `requestAnimationFrame`; the
packet interpolates between the node dots while recorded values stay
discrete), Previous/Next, range scrubber, Jump to finding (falls back to
the shared action frame for group-level findings), evidence disclosure.
No autoplay and no endless loop: a generation token invalidates in-flight
frame callbacks on pause, case switch, seek, end of trace, document hidden,
and reduced motion. The same controller is exercised with a fake clock in
the focused tests. Saved state is read from the widgetState
`modelContent`/`privateContent` structure, applied on `openai:set_globals`,
and clamped; it is persisted only from user interaction handlers — never
during load, render or restore — and rendering never rebuilds the focused
controls.

## Limitations

- Inventory deliveries made by one `drain` action share an action index, so
  their violations honestly remain action-level rather than pinned to one
  entry; Jump to finding goes to the final frame of the first affected action,
  so its completed state can be inspected without claiming entry-level blame.
- Trading state snapshots include venue/target internals; the generic diff
  may list many fields (first 24 shown, remainder in raw evidence).
- Rendering success is not semantic completeness: coverage.json records
  lenses and attribution per case, and synthetic fixtures are not simulator
  evidence.
- Specialised views currently recognise the two bundled simulator schemas.
  Production integration should use explicit adapter metadata for entity,
  quantity, version and lifecycle roles. Unknown schemas keep the generic
  before/after view; no promise is made to infer every future finding's meaning.
- Identity comparisons count delivered messages, not scheduling entries, and
  scope comparisons to the same event type and business entity. Locked-price
  comparisons use the explicitly referenced order. Inventory expected/observed
  comparisons require a recorded check whose actual snapshot matches the
  displayed state.

## Checks run

- `node docs/design/replay-lab/generate.mjs` — 32 cases generated.
  [coverage.json](coverage.json) separates checks executed during
  generation (with real pass/fail per case, plus each lens's finding-frame
  visual values) from descriptive claims.
- `node --test docs/design/replay-lab/replay-lab.test.mjs` — 20 focused tests pass, including
  known→missing→known state, null/false/0, attribution before/at/after a
  shared action, visual-model values against raw state for every case, and
  playback transitions on the real controller with a fake clock.
- `npm run typecheck` passes on unchanged production sources; broad
  `npm test` is run by the primary in the unrestricted host (see handoff).
- Determinism: fragment SHA-256 identical across regeneration; fragment JS
  parsed with `new Function` syntax check; size < 1 MB; no fetch/XHR.
