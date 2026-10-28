# ChaosPilot: system workspace and investigation UX brief

This is the original design brief. The application has since added an inventory-reservation adapter; see [SECOND_SYSTEM.md](../SECOND_SYSTEM.md) for its current scope.

## Requested outcome

Design a credible product workflow for an automation engineer to describe a system, inspect its business requirements, launch bounded negative investigations and understand reproducible findings. The current runner proves plumbing but does not expose the knowledge being investigated. The participant specifically requested Astra for this design work.

Own a bounded design outcome: information architecture, core journeys, fields and states, implementation priorities, and one self-contained clickable HTML design prototype. The prototype is a proposal, with clearly labelled synthetic content, not the running investigation engine. Do not replace production frontend code during this task.

## Product and users

ChaosPilot is an autonomous negative-testing investigator for distributed event-driven software. It reads public capabilities and contracts, forms a testable failure hypothesis, constructs an executable event sequence, executes against a fresh target, checks deterministic invariants and uses observations for subsequent experiments. A finding requires repeatable failure and a valid clean comparison.

The primary user is an automation or QA engineer who understands business behaviour but cannot anticipate every combination of malformed data, duplicate/reordered messages, stale state, component outages, swallowed messages and latency spikes. The intended benefit is less scenario-authoring effort. That benefit is an evaluation question; human time has not been measured.

Long-term targets include FIX, TIBCO RV, Solace, Kafka and HTTP systems. The current executable adapter is a synthetic trading system only. It supports logical message delays, duplication/reordering and raw structured messages. Real transport connectors, component failures and contractual liveness deadlines are not implemented. General system descriptions can be authored as drafts, but a system without an adapter/checks must not appear executable.

## Business behaviour already established

- Quotes and credit-limit updates are versioned; older or repeated versions must not change state.
- Accepted orders lock their quote price, reserve credit and follow an explicit lifecycle.
- Total commitments include both used and reserved credit. New order admission respects the current limit.
- A limit reduction constrains future commitments. Fills already reported to a client are honoured; do not retroactively invalidate them.
- Unique fills convert reservation into used credit once. Duplicate and conflicting reports have different rejection/idempotency requirements.
- Cancellation releases only confirmed cancelled quantity. A fill that occurred before cancellation can legitimately arrive after the cancellation acknowledgement.
- Malformed/rejected payloads must not mutate business state or poison future identifiers.
- Quantities, exposure and lifecycle must remain consistent through every transition, including transient failures.

The exact public contract and ten executable checks are in `src/simulator/contract.ts`. Source-visible files use neutral business filenames. Source-aware investigation is allowed, but defect labels, answer keys, fixture recipes, other implementations and verifier internals are excluded from model context.

## Current audit evidence

Screenshots captured in this audit run:

1. `current/01-investigation-runner.png`: usable launch controls, saved-run provenance, finding evidence and replay history. No visible system-definition or requirements-authoring entry point. Future launch controls show A/mock while the saved view shows C/live, so these contexts need clearer separation.
2. `current/02-proposal-inspection.png`: raw response, hashes and preparation details are inspectable. Engineers must traverse proposal diagnostics to understand model inputs; encoded JSON dominates the inspection view. There is no first-class requirement or coverage view.

Keep findings/provenance/replay strengths. Treat the runner as one view inside a system workspace. Current screenshots show desktop layout only; keyboard navigation, zoom/reflow and screen-reader completeness have not been established.

## Proposed information model

Design around **System → Brief and requirements → Capabilities and checks → Investigations → Findings and regressions**. Distinguish the human business system from the selected synthetic candidate used for development.

A reusable system brief should expose name, business purpose, actors/components, message vocabulary, rules/invariants, failure concerns, source context/access, executable adapter and verification readiness. An investigation pins an immutable brief revision and hash. Editing a brief affects future investigations and never rewrites historical evidence.

Requirements need visible verification states: executable check, contextual requirement without a check, ambiguous/draft requirement, and unsupported capability. Saving arbitrary prose does not create a deterministic oracle. Do not display untested prose as passed or invent a coverage percentage. The initial implementation can expose existing executable trading requirements read-only, with editable business overview and additional contextual requirements. Other system types remain saved drafts until an adapter/check mapping exists.

## Journeys to design

1. First use: open a seeded trading workspace, understand its purpose and explicit rules, see what can be tested, then launch a bounded investigation.
2. New system: enter a brief and requirements, choose an available adapter or retain an unconfigured draft, discover missing verification capability and save progress without a false readiness claim.
3. Prepare investigation: review exact brief revision, source access and executable checks; choose target, model and limits. Clearly identify the next launch configuration separately from any saved run being inspected.
4. Follow progress: see hypothesis, experiment, observation and next action; expose rejected proposals, truncations, stopped/failed work and known/unknown usage without a fabricated success story. Technical JSON stays available as progressive detail.
5. Inspect a finding: link violated business requirement to actual vs expected behaviour, event ordering and state, deterministic replay and clean comparison. Explain what the evidence establishes and what remains unproved.
6. Resume later: history grouped by system and brief revision, saved findings/reproductions, clear provenance for live Meta, scripted offline mock and deterministic replay.

## Work in parallel

Another implementation worker may add a small functional system-brief editor and revision snapshots in the existing UI. Treat that as a foundation and an implementation constraint, not a selected polished layout. A separate worker will expand independently selectable known synthetic faults from three to nine. Fault labels/recipes belong to an explicitly developer-facing demo lab and must never become investigator instructions by accident. These are development fixtures, not new held-out evidence.

## Constraints and deliverables

- Own only `docs/design/astra/**`. Other agents own production source, frontend, tests and simulator. You are not alone; preserve their work and do not edit their files.
- Do not read `.env`, private ledgers, provider logs, hidden fixture answers or whole prior conversations. No live Meta requests, external communications, deployments, paid API calls or nested delegation.
- Existing app: local Node/TypeScript, plain browser client, JSON persistence, no production dependencies. Keep proposals achievable inside a hackathon. No databases, auth, Docker, framework migration or enterprise feature sprawl.
- Read relevant current screenshot files with the image tool and inspect the existing HTML/CSS design tokens. Use actual business content and functional controls in the prototype, without fake image placeholders or illustrative assets. No new image generation is needed for an information-workflow proposal.
- Deliver `UX_DESIGN.md` with recommended navigation, journeys, field/state specification, vocabulary, confidence/coverage presentation, accessibility considerations and a small ordered implementation backlog. Separate current capability from proposed behaviour.
- Deliver self-contained `prototype.html`: working system navigation, brief/requirements editing, readiness states, a labelled synthetic investigation/finding and diagnostic disclosure. No network calls or claims that prototype buttons run Meta. Include a saved-run example with a pinned older brief revision so context changes are understandable.
- Return promptly with changed paths, what was designed/verified, limitations and preview instructions. Do not spend time on unrelated branding or speculative integrations. This task is complete when the design package is concrete enough for the participant to review and an implementer to build.
