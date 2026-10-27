# ChaosPilot: a system workspace before a run

Design proposal · 26 October 2026 · Synthetic examples throughout the prototype

## Recommendation

Make the reusable business system the primary object. A user opens **Trading gateway**, understands its rules and available checks, then prepares an investigation. A run is an immutable record under that system, not the context for the whole app. Keep the existing dark surfaces, cyan emphasis, restrained borders, provenance labels, trace and deterministic replay strengths. Spend the hackathon effort on information hierarchy and truthful states rather than branding.

`prototype.html` is a self-contained, clickable proposal. Open it directly in a browser. It has no external assets, dependencies, requests, model calls or engine execution. Edits and new systems exist only in the open page; reload resets the examples. Every run, finding, replay and hash shown there is explicitly illustrative. This is interaction design, not new experimental evidence.

## Grounding and limits

Inspected the exact saved images `../current/01-investigation-runner.png` and `../current/02-proposal-inspection.png`, `public/index.html`, `public/styles.css`, and the public `src/simulator/contract.ts`. The screenshots are the starting-state audit; concurrent production edits are not silently treated as reviewed.

1. **Runner: useful evidence, ambiguous context.** In screen 01, the launch controls say Candidate A / mock while the saved record says Candidate C / live. Each is legitimate, but their shared global provenance treatment makes scope easy to misread. Move future configuration to its own screen; put target, mode and brief revision inside each saved record.
2. **Proposal inspection: inspectable but cognitively expensive.** Screen 02 exposes response and preparation diagnostics, but encoded JSON carries the business explanation. Lead with hypothesis → sequence → observation → next action; retain raw payloads under disclosure.
3. **System knowledge is missing from the visible navigation.** Neither image exposes purpose, editable context or a requirement/check mapping. Add those before asking users to launch. This claim concerns the captured views, not hidden or subsequently implemented functionality.
4. **Accessibility is unproved in the existing app.** Screenshots establish desktop hierarchy only. Keyboard access, focus handling, zoom, reflow, contrast and screen-reader behavior require testing; do not infer compliance from the images.

This bounded design package uses exact source lookups and a documentation-only prototype, rather than a substantial runtime investigation. No hidden defect recipes, private run logs, model credentials or whole historical conversations were read. No production implementation or transport research is included.

## Navigation and object model

Persistent left rail: system selector, **Overview**, **Brief & requirements**, **Capabilities & checks**, **Investigations**, **Findings & regressions**. A distinct **Prepare investigation** action always operates on the selected system's latest saved brief. **New system** creates an unconfigured draft. On narrow screens the rail becomes a normal stacked navigation region, not an icon-only menu.

Objects and relationships:

- System: stable identity and human name, independent of synthetic candidate selection.
- Brief revision: immutable saved purpose, components, vocabulary, rules, concerns and permitted source context. A new save creates a revision; run history never reads the mutable editor as its evidence.
- Requirement: stable ID, statement, verification classification, originating revision and mapping to versioned executable check(s) where available. Editable prose alone never receives a mapping automatically.
- Adapter configuration: concrete execution boundary, supported operations and check versions. Only the synthetic trading adapter is available today.
- Investigation: pinned brief snapshot/hash, adapter/check version, source-access manifest, target, provider/model, bounds, lifecycle and usage provenance.
- Finding: requirement/check, expected vs actual, event sequence, candidate replay, clean comparison, evidence status and limits. A saved reproduction may become a regression only when it has a reusable executable artifact and an explicit expected outcome.

No global “live” badge. Provenance belongs to the run or operation it describes. Navigation retains system identity; inspecting a historical revision does not replace the current editable brief.

## Core journeys

### 1. Seeded first use

Open Trading gateway Overview. Read the purpose, **10 executable checks**, contextual requirements and unsupported capabilities. “10 checks available” describes configuration, not coverage or passing tests. Open Brief & requirements to inspect real business rules; then Prepare investigation. The bounded first use avoids forcing scenario authoring.

### 2. Describe a new system

Create a draft with a name and business purpose. Add actors/components, message vocabulary, business requirements, failure concerns and source scope. Saving incomplete work is allowed. Readiness says **Draft — adapter unconfigured** and explains that no execution or deterministic verification is available. The prototype can save additional requirements as Context only, Needs clarification or Unsupported capability; it cannot turn them into executable checks. Adapter choice must be compatible with the system, not a generic “ready” switch. A payments draft cannot become runnable by relabelling the trading adapter.

### 3. Prepare an investigation

Review the latest saved brief revision and the exact source scope before choosing a synthetic target, provider and bounds. Preview the model-visible brief in readable sections. Distinguish read-only contract/check rules from editable context. Show unsaved edits and require saving or discarding before launch. Freeze the snapshot atomically with submission; server-side validation must reject a stale revision/configuration rather than quietly launching against a different brief.

The prototype exposes an offline walkthrough only. A production live provider requires truthful credential/model readiness from the backend, never from a populated browser selector. Fault labels and recipes remain in a separate developer demo lab and must not enter the system brief or investigator input.

### 4. Follow an investigation

Present status plus the most recent meaningful transition: hypothesis formed, proposal rejected, experiment executed, observation recorded, replay pending, comparison completed. Show experiments executed separately from proposals attempted/rejected/truncated. Running → Stop requested → Stopped is distinct from Completed; retain partial artifacts. Failed, rejected and truncated states explain what did not run. Never reinterpret a model failure as “no defects”. Usage supports reported, partially reported, unknown and not applicable; unknown never becomes zero dollars.

The prototype uses explicit “Advance walkthrough” controls instead of timers. Its rejected-proposal example consumes no executed-experiment count. Stop preserves the illustrated progress and ends the walkthrough. The UI must not imply that this scripted example represents autonomous discovery.

### 5. Understand a finding

Start with the business failure: a new order was admitted despite total commitments exceeding the current credit limit. Link directly to `credit_limit_respected`. Show expected rejection vs observed acceptance, used/reserved/new commitments, ordered events, replay status and clean comparison separately. A candidate observation alone is unconfirmed. Repeatable candidate failure plus a valid clean comparison can support a confirmed finding for that sequence and versions; it does not establish general system failure frequency or comprehensive coverage.

Provide “Inspect replay” and “View diagnostics” as progressive detail. A production replay launches against the pinned artifacts and appends a new report rather than modifying prior evidence. Regression status distinguishes reproduction saved, regression configured, last check passed/failed, and never run. The prototype only demonstrates a saved reproduction; exporting/running a regression is not claimed.

### 6. Resume later

History stays scoped to the system and groups by brief revision. A saved run header says **Saved run · revision 2**, while a comparison note says **Current brief · revision 3**. Both snapshots are inspectable. Editing the current purpose creates revision 4 without changing run 2. Filters for mode/status/revision can follow once the fundamental navigation works. Live model, scripted offline and deterministic replay remain distinct in history, exports and sharing.

## Fields and states

| Area | Fields / states | Behavior |
| --- | --- | --- |
| Brief | Name, purpose, actors/components, messages, business rules, failure concerns, permitted source context | Name and purpose required for a new saved revision; additional context can remain incomplete. Explain inline errors; retain typed values. |
| Requirement | Stable ID, statement, classification, check mapping, last saved revision | Existing public-contract checks read-only initially. Additional prose editable; no inferred oracle. Deleting context changes future revisions only. |
| Requirement classification | Executable check / Context only / Needs clarification / Unsupported capability | These are readiness classes, not test outcomes. Counts stay separate. |
| Check result | Not exercised / Observed no violation / Violation observed / Error or inconclusive | Always attached to a run, sequence, check version and evaluated state range. “No violation observed” is not a universal pass. |
| Readiness | Draft / Ready for supported scope / Blocked | List exact reasons: no adapter, no checks, unsupported requested operation, invalid bounds, provider unavailable, unsaved/stale brief. Context-only requirements do not block otherwise supported checks, but remain visibly unverified. |
| Capability | Available / Unsupported / Not configured | Logical delays are not network-latency measurements; no component outage injection or liveness deadline oracle exists today. FIX, RV, Solace, Kafka and HTTP are future adapters. |
| Launch | Pinned revision/hash, adapter/check version, target, provider/model, experiment bound, source scope | Preflight uses backend authority. Show payload limits where supported; never imply an unenforced spend/time cap. |
| Run | Queued, running, stop requested, stopped, completed, failed | Preserve results and timestamps, identify failure stage and retryability. Retry creates a new run with explicit reused or updated configuration. |
| Finding | Observed, replay pending/failed/verified, clean comparison pending/invalid/passed, confirmed | Do not collapse independent evidence dimensions into one green badge. |
| Usage | Reported, partial, unknown, not applicable | Estimated cost includes calculation basis when present. No fabricated precision or default zero for missing usage. |

The ten existing check IDs remain canonical: `credit_non_negative`, `credit_limit_respected`, `credit_exposure_consistency`, `order_quantity_conservation`, `lifecycle_consistency`, `no_overfill`, `venue_execution_integrity`, `execution_idempotency`, `version_monotonicity`, `input_integrity_no_mutation`.

## Confidence and wording

Use **verification readiness** for configured checks and **evidence** for outcomes. Do not use a coverage percentage without a justified denominator. Show counts such as “10 executable checks, 1 contextual requirement, 1 unsupported capability”; the presence of a check does not prove all transitions were explored. Confidence is expressed through concrete provenance, replay, comparison and known limitations, not a model-generated score.

Preserve these business distinctions in readable copy: commitment means used + reserved; a lower credit limit constrains new admission without undoing fills; a delayed earlier fill can remain valid after cancel acknowledgement; identical execution IDs differ from conflicting duplicates; remaining quantity can represent unreconciled reports in transit. Avoid simplifying these into incorrect promises such as “cancelled means no credit reserved”.

## Accessibility and responsive behavior

Use native buttons, labels, fieldsets, headings, tables and details. Navigation uses `aria-current`; screen changes move focus to the view heading. Persistent skip link and visible focus rings support keyboard use. Status messages use a polite live region; avoid announcing whole streaming traces. State has text, not only color. Diagnostic text wraps. Trace tables retain headers and get a labelled horizontal scroll region when necessary. At 320 CSS pixels main content reflows to one column. Respect reduced motion; no essential animation. Validate 200%/400% zoom, keyboard-only paths, accessible names, focus return after dialog close, contrast and a screen-reader path before production acceptance. The prototype avoids modal dialogs entirely.

## Small ordered implementation backlog

1. **System and revision foundation.** Integrate the parallel brief editor into the system workspace. Persist stable system IDs and immutable run snapshots. Test edit/save/launch concurrency and that old run evidence remains unchanged. Migrate historical runs to “brief snapshot unavailable” rather than inventing revisions.
2. **Truthful readiness.** Expose all ten checks with read-only contract text; classify added prose separately. Gate launch on actual adapter/provider readiness. Test unconfigured systems, unsupported capabilities, missing snapshots and invalid bounds.
3. **Separate preparation from saved inspection.** Move controls into Prepare investigation; scope provenance to each record. Show source access and pinned revision before submission. Keep existing run/trace/replay UI reusable.
4. **Business-first evidence.** Add requirement links, expected/actual summary and structured proposal lifecycle. Keep raw request/response under disclosure. Exercise rejected/truncated/stopped/failed, unknown usage and invalid clean-comparison states.
5. **Usable history and regression follow-through.** Group by system/revision, retain evidence lineage and export existing reproduction artifacts. Add saved regressions only when execution/storage behavior is implemented. Perform keyboard, contrast and responsive checks across these journeys.

Defer real transports, collaboration/auth, databases, automatic check generation, coverage scoring and enterprise dashboards. The existing plain browser client and JSON storage are sufficient for this scope.

## Prototype verification and acceptance

The prototype's concrete review paths are: inspect seeded brief/check mapping; edit and save a revision; add a contextual requirement; create and save an unconfigured system; observe launch blocked there; return to trading and prepare an offline walkthrough; advance through rejection/execution or stop; inspect the older saved run, finding, trace and replay disclosure. Saved-run text must remain revision 2 after current-brief edits. Browser verification results and any limits are recorded in the handoff; no runtime-engine checks are claimed by this design artifact.


Verification performed on this proposal: JavaScript parsed successfully; a local Node VM with a minimal DOM stub exercised nine view renderers, brief revision isolation, unsaved-brief launch guard, contextual requirement saving, walkthrough rejection/execution/stop transitions, unconfigured-system launch blocking and replay disclosure. A source scan found no external asset links or network request APIs; the page also declares `connect-src 'none'`. These are state/source checks, not browser verification. In-app browser opening of the local `file:` URL was blocked by its URL policy; no bypass was attempted. Visual layout, real DOM interaction, keyboard and screen-reader checks remain unverified. The inspected starting-state screenshots remain the visual grounding.

Subsequent primary verification used a restricted, permitted loopback HTTP preview. Selected real-browser interactions and screenshots are recorded in [BROWSER_CHECK.md](BROWSER_CHECK.md); full keyboard, responsive and assistive-technology validation remains outstanding.
