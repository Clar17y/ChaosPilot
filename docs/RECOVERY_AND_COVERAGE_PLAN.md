# Recovery and requirement coverage: implementation plan

Status: implementation started, 2 November 2026. Session A's recovery/backend package is running under an exclusive bounded contract; coverage/UI remains separately owned.

The participant chose to retain two build days and shorten the polish window. Build on 2–3 November; freeze features at the end of 3 November; use 4 November for stabilisation, authentic current-version evidence, recording and submission. The published submission deadline is 4 November at 9pm ET, which is 5 November at 2am in London ([official event page](https://dev.meta.ai/events/global-hackathon)). Target submission during 4 November, ahead of that final deadline.

Task branch: `codex/recovery-coverage`, worktree `C:/dev/ChaosPilot-worktrees/recovery-coverage`, starting at `35b444aaa670a7d3bf46d314c5834f50a9794550`. The parent chat stays in `C:/dev/ChaosPilot`. `npm ci --no-audit --no-fund` completed successfully in the task worktree. This document is local and uncommitted.

## Product outcome

An engineer reviews a small scenario plan against a saved business brief, launches a bounded investigation, and sees which requirements have actual evidence and which remain untested. One new scenario demonstrates a recovery obligation that the existing simulator cannot currently check.

The demonstration should show:

1. A saved trading recovery profile and its precise recovery rule.
2. Two reviewed scenario intentions: recover an accepted execution after reconnect, and avoid double accounting when that execution is retried.
3. A Muse-generated experiment, or an honestly labelled saved live experiment, exposing a missed recovery deadline.
4. Accepted execution, disconnect/reconnect, deadline and observed order/credit state in the recorded timeline.
5. Deterministic replay and clean comparison for the confirmed finding.
6. A coverage view showing the finding and any planned scenario whose conditions were not reached.

Offline mock development proves the workflow only. Genuine AI discovery requires a recorded Meta run. The demonstration must retain that distinction.

Deliver the bounded recovery scenario in [issue #11](https://github.com/Clar17y/ChaosPilot/issues/11) and a first slice of [issue #7](https://github.com/Clar17y/ChaosPilot/issues/7). Do not close all of #7 on the strength of this slice: broader assumption authoring, suggested-link review, overlap comparison and cross-run coverage remain separate work.

## Scope decisions

### An opt-in trading recovery adapter

Add a separately registered `synthetic-trading-recovery` adapter and a seeded `trading-recovery` profile. Give it `clean` and one neutrally named faulty target, such as `recovery-candidate-a`. It is a simulated trading integration, not another application domain or a production connector.

The existing adapter supplies one contract for all its variants (`src/adapters/index.ts`). Changing that contract would cause older trading snapshots and regression definitions to report incompatibility. A separate adapter makes the recovery obligation explicit while keeping the existing trading and inventory contracts, target source bundles and prompt identities intact.

Reuse the existing clean trading business implementation and suitable scheduler/venue APIs. Put target-owned recovery code, its independent checks, execution driver and source bundling under `src/recovery/`. Avoid a general adapter framework rewrite. Any extraction from existing code needs a demonstrated benefit and checks that existing behaviour and source identities remain honest.

All executing candidate business dependencies, including its recovery component, must appear in its model-visible source bundle with neutral paths. Exclude the other implementation, independent verifier, known reproductions, variant selectors and defect explanations. The faulty and clean sources must have distinct identities. Follow the existing loaded-source/restart checks rather than hashing changed disk files as though they were executing.

### Coverage for one pinned investigation

The first coverage view answers questions about an explicitly selected saved investigation. Its identity includes the run, adapter, brief snapshot/hash, target/source hash, contract and coverage evaluator version.

Start with a small versioned scenario catalog: recovery-by-deadline and recovery retry/idempotence for the new adapter, plus the existing reviewed credit-admission rule where it is supported on synthetic trading. Additional prose is displayed as context without an executable check. Inventory may show that explicit unsupported state; adding inventory check mappings is outside this build.

Users review the proposed scenario intentions and requirement links during preparation. Save the selected plan with the run before requesting the first experiment. For the new recovery adapter, pass the explicit goals to Muse through its normal bounded proposal request; this does not need a separate planning model call. The model continues to construct the actual action sequence. Existing trading coverage initially records the selected credit-rule intention and projects its existing check evidence without changing that adapter's model inputs or prompt identity; extending goal-directed generation there is deferred.

Send only public scenario goals and reviewed requirement/contract links to the model. The saved plan's full context includes runtime target selectors and evidence bookkeeping for the application; those fields must not be copied into model inputs.

Scenario links are evidence-backed only when deterministic observations establish the relevant trigger and an applicable check executes. A model-supplied goal ID, hypothesis, `expectedInvariant`, or lack of oracle violations is insufficient. Use the existing typed credit observations for the existing preset and typed recovery observations for the new checks.

Keep plan state and evidence state separate:

| Plan/evidence | Display meaning |
| --- | --- |
| Suggested | An explicit catalog proposal awaiting review; no execution claim |
| Planned, not exercised | Reviewed intention, but its necessary conditions were not reached |
| Exercised, no violation observed | Applicable observations and checks exist for this experiment; no claim about the whole requirement |
| Check failed, confirmation incomplete | A deterministic failure was observed, but replay/clean confirmation is absent or unsuccessful |
| Confirmed finding | The existing finding gates succeeded; link to the finding and its experiment |
| Inconclusive | Evidence, identity, completion or the required observation horizon is insufficient |
| Invalid | A harness command or experiment was invalid; no product failure claim |
| Unsupported/context only | There is no executable check for this statement |

Retain unexercised intentions when execution stops after a finding, exhausts its budget, is cancelled or fails. Show the recorded stop reason. Partial execution may contain a confirmed finding alongside inconclusive and unexercised rows.

Do not roll up unrelated revisions or sources, count a baseline/regression from a different context as current evidence, calculate an overall coverage percentage, infer hidden model reasoning, or automatically discard apparently overlapping scenarios. Existing baseline and regression evidence can remain accessible through their current views. Aggregating them into this coverage view is deferred.

## Recovery contract to implement

The proposed demonstrator rule is:

> A valid execution report explicitly accepted by the target-owned recovery component during disconnection must be applied exactly once, with the correct order quantities and credit accounting, no later than five logical ticks after reconnection.

Freeze these semantics before implementation:

- **Owner and acceptance:** the target includes a recoverable report component. Its explicit accepted report identity and immutable report contents establish the obligation. Generating or scheduling an envelope in the harness is not acceptance. Invalid or rejected reports create no obligation.
- **Business occurrence and report delivery:** venue execution, transport acceptance and application to the order engine are separate recorded events with correlation identities. Acknowledgement alone does not establish business reconciliation.
- **Recovery policy:** clean retains the accepted backlog and attempts reconciliation on the next logical tick after reconnect. The faulty component loses that backlog during reconnection. Both implement the same public contract; the runtime model receives only the selected ordinary implementation. This is a known development fixture, not an independently blinded held-out evaluation.
- **Clock ownership:** advancing logical time runs due target-owned recovery work automatically. The model does not need to deliver a retained internal retry manually. Any operation that moves time, including a drain or delivery that jumps the clock if supported, uses the same ordered clock driver.
- **Deadline:** for reconnection at tick `r`, the deadline is `r + 5`. Run all target-owned work due at a tick before checking that tick's deadline. Completion at `r + 5` is on time. An unresolved accepted obligation after processing that tick is a failure. A later completion does not erase the recorded miss.
- **Large jumps:** a jump across retry and deadline times must process them in chronological order and retain the actual due/observed times. It cannot skip the check or turn a late result into an on-time result.
- **Duplicates:** identical report retries or repeated reconnect requests do not create another obligation, apply another fill, release more credit, or reset the original deadline. Conflicting execution identity/content is rejected without state mutation.
- **Bounded outage scope:** version 1 supports one outage/reconnect cycle per experiment. Repeated disconnect while already disconnected and repeated reconnect while already connected are idempotent. A second outage after reconnect is an explicitly unsupported harness command, yielding an invalid experiment rather than a target finding. Broader recurring-outage semantics are deferred.
- **Observation horizon:** no accepted trigger means not exercised. Accepted work still unresolved when the experiment ends before the deadline is pending/inconclusive. Actual evidenced completion before the deadline can establish that check's on-time outcome without waiting for tick 5; an untested duplicate/retry intention still remains unexercised. Disconnection without reconnection does not prove a missed post-reconnect deadline. Missing observations or target exceptions cannot produce a passing check.
- **Independent truth:** the oracle tracks obligations from accepted ingress evidence and checks actual order/credit changes and application identities. It must not trust the target's pending queue, claimed success flag or disappearance of a report as proof of completion.
- **Bounds:** retain bounded action/message counts and monotonic logical time. Reject out-of-range ticks, unsupported operations and an unobservable deadline beyond the experiment's logical-time bound. Label all times as simulated ticks.

One adapter-specific `recovery_deadline` invariant and an explicit retry/idempotence check are enough. Requirement-rule results currently remain separate from findings (`src/investigation/index.ts`); recovery must report a genuine independent oracle violation through the existing finding/replay/clean-comparison path. Do not promote a model explanation or coverage status into a finding.

For a recovery deadline finding, the clean comparison must exercise the corresponding accepted obligation and show positive on-time reconciliation. A valid clean experiment with no violation, but no matching obligation or an incomplete horizon, is not sufficient confirmation. Keep this check specific to recovery so that legacy finding semantics and identities remain intact.

## Evidence and compatibility design

Use additive, optional versioned fields for the coverage plan and coverage/check evidence. Keep them in the existing investigation artifact rather than adding a second mutable coverage store. Reuse existing run publication, mutation locks and snapshot validation.

Pin the catalog/evaluator descriptor and exact reviewed requirement text or contract rule ID. Duplicate or edited requirement text requires explicit remapping. Do not change the semantics or identity of the existing credit-rule evaluator merely to add recovery coverage.

Recovery evidence should identify the execution/report/order, acceptance tick, reconnect tick, deadline tick, observed completion tick or absence at the checked horizon, expected/observed order and credit facts, and relevant trace references. Evaluate and record results during execution; reopening coverage makes no model call and does not execute the target.

Replay must compare recovery/check evidence and its evaluator identity as well as existing trace, state, validity, violations and source context. New fields cannot be silently ignored on new records; genuinely older records remain labelled as not having recorded coverage. A changed or unavailable evaluator yields explicit drift/unknown status. Do not backfill plans into old evidence or rewrite historical briefs.

Compatibility acceptance:

- Browser and CLI can launch the new saved profile with its confirmed adapter/target and pinned brief.
- Meta and labelled mock paths use an explicit adapter prompt identity and strict parser; adapter/target mismatches fail before any model call.
- Selected and whole-run replay use the existing adapter registry and provenance gates.
- Findings and the reproduction timeline show meaningful recovery facts and simulation units. Neutral fallback remains available for unfamiliar state.
- Existing challenge/report consumers are checked against the new evidence shape. Their limits remain visible; a consumer that cannot preserve the adapter's required semantics is disabled with an explicit reason for that adapter rather than showing a false result. Existing supported behaviour remains intact.
- Functional baselines and saved regression capture remain synthetic-trading-only in this delivery. The new adapter must show an explicit unsupported reason. Adding recovery regression capture is a separate feature, not an implied consequence of registration.
- Existing trading and inventory contracts, source identities, archived replay and saved regression behaviour remain unchanged unless a genuine, disclosed change requires drift. In particular, do not globally replace existing prompt identities to add the new adapter's instructions.

## Work packages and ownership

The primary owns scope decisions, contracts, integration acceptance and evidence assessment. Dispatch bounded implementation outcomes through the installed routing framework. Workers own local investigation, implementation, focused validation, routine repairs and self-review; no recursive delegation. Use mock development only.

### Parallel execution arrangement

The calendar packages below describe delivery checkpoints, not a requirement to run all implementation sequentially. A second session can start coverage implementation during recovery development after a short shared-interface checkpoint. Use a separate task-owned worktree, based on the same starting commit, and the bounded contract in [COVERAGE_SESSION_HANDOFF.md](COVERAGE_SESSION_HANDOFF.md).

Ownership is divided by layer: session A owns recovery and existing shared backend files; session B owns the new coverage modules and specified workspace UI files. Session A does not edit B's UI files, including the new adapter selector/navigation integration. Session B does not edit the domain record, server, investigation runner or replay implementation. A integrates B's pure coverage functions and agreed optional record fields into those backend files. These ownership rules replace the earlier proposed sequential transfer of shared paths.

Freeze the versioned plan/check input types, evidence references and public function signatures first. Session B should publish a small interface-only commit that A can merge before wiring against it. Both sessions use the same type definitions; neither keeps a competing temporary schema. Any later interface change must be coordinated before dependent edits.

Session B can immediately implement coverage projection using existing credit-rule evidence, explicit recovery fixtures, legacy/unsupported cases and a fetch-injected UI controller. Those fixtures are development inputs, not discovery evidence. Recovery-specific integration waits only for the agreed typed observations. Real run persistence, cancellation/early-stop semantics, replay and the complete browser journey are verified after the two branches are integrated.

The short interface checkpoint, backend wiring and final integrated checks remain sequential. Do not claim that independently passing branches prove the complete flow. Commit availability matters: the planning documents are currently uncommitted and must be read by their absolute filesystem paths; they will not appear automatically in a new worktree.

### A. Recovery engine and runnable investigation — build day 1

One worker owns `src/recovery/**`, recovery tests, and the necessary shared backend integration: domain types, adapter registry, system validation/seeding, adapter-specific prompt and mock selection, investigation allowlists, server/CLI launch defaults and replay/evidence integration. Allocate explicit individual paths in its task contract; this paragraph does not authorise a whole-repository claim.

The worker first fixes the public contract and typed observations, then implements clean/faulty recovery and the independent oracle, then completes the runnable CLI/API path. A owns shared backend wiring for coverage as well: validated launch intentions, plan publication before inference, observations/check recording, goal context and replay comparison. A imports B's agreed types/functions after their commits are available. Browser selection and a basic recorded timeline are supplied by B under its exclusive UI ownership; they must work in the integrated checkpoint.

Acceptance: an offline mock investigation creates a confirmed recovery finding on the faulty implementation; the same sequence meets the recovery rule on clean; selected replay matches; an early-ended experiment remains inconclusive; legacy trading and inventory focused checks pass.

### B. Reviewed plan, coverage and recovery evidence UI — start in parallel; deliver by build day 2

The other session owns `src/coverage/**`, `src/web/coverage.ts`, coverage tests, preparation/coverage UI and the recovery timeline presentation. Its exact existing UI paths and forbidden backend paths are listed in the handoff. It provides pure plan validation/projection helpers and their tests for A to wire into the backend. No shared-file transfer or concurrent backend writer is required.

Keep the UI within the existing workspace: review intentions in Prepare investigation, then open coverage for the selected investigation with links to exact experiments/findings. Reuse the existing view/controller selection-generation pattern so a delayed response cannot replace a newer system, target, revision or historical selection.

Acceptance: the agreed statuses are supported by recorded facts; cancellation/early stop retains unexercised goals; reload preserves the plan; a changed brief/source does not relabel historical evidence as current; legacy records are honest; desktop and narrow layouts and keyboard operation are usable.

### C. Integrated acceptance and release preparation — end of build day 2

On one stable candidate, run focused checks, `npm run typecheck`, `npm test` (including its build), and the applicable browser journey. Save candidate identity and results. Run Jev review on the integrated code diff, then one independent review focused on deadline ordering, target/harness ownership, coverage truth and historical identity. These are the concrete reasons an independent perspective is useful here; no automatic extra review round or correctness gate is added.

Adjudicate findings against source and evidence, group related repairs under their current owner, and rerun affected checks. Reuse matching evidence for unchanged inputs. Do not request automated PR review or first push until coupled transitions have been tested. Commit/push/PR actions and final publication remain distinct from this planning change.

## Planned acceptance coverage

Every row below is **planned and unproved**. Planning source inspection and a completed provider response are not test results. Workers must update their existing contract/run record with concrete candidate-specific evidence and disclose missing cases.

| Invariant | Discriminating cases | Planned evidence |
| --- | --- | --- |
| Only target-accepted work creates recovery obligations | Never delivered; rejected/invalid report; accepted while disconnected; acceptance distinct from venue occurrence | Recovery parser/ingress tests with typed acceptance and independent oracle assertions |
| Due recovery work runs before deadline checks | Before, exactly at and after tick 5; zero/single/repeated advances; jump across retry and deadline; every supported clock-moving operation | Clock-driver boundary tests, including on-time and late completion seams |
| Recovery and retries apply each execution once | Duplicate acceptance/retry; identical/conflicting business ID; multiple accepted reports; repeated reconnect; next outage rejected | Full order/credit and obligation assertions, not just violation counts |
| Incomplete observation cannot pass or prove failure | No trigger; no reconnect; early end; missing evidence; target exception; invalid command; out-of-range horizon | Outcome-classification tests covering combinations of connection and obligation states |
| A true failure is confirmed by the existing gates | Faulty versus clean, semantic replay, source/contract/evaluator drift, a clean control that also fails or never exercises the corresponding obligation | Investigation and selected/full replay tests and offline CLI/API artifacts |
| Coverage follows actual exercised checks | Model claims a goal without reaching it; mismatched trigger; failed check without confirmation; confirmed finding; context-only prose | Coverage projector tests bound to typed observations and saved finding references |
| Early stop preserves the plan honestly | First finding stops before second intention; experiment/call budget exhausted; cancel/failure before and after a completed finding | Investigation lifecycle and saved-artifact reopening checks |
| History and selection cannot cross contexts | Edit/duplicate requirement; change revision/source/adapter; delayed response; reload; legacy/no plan; unknown evaluator | API/controller tests plus delayed-response browser checks |
| Existing supported journeys remain intact | Trading/inventory execution, source hashes/contracts, legacy replay, baselines, regression preview/run, challenge and report handling | Existing focused checks and required full repository suite on the stable candidate |

Proposed focused command after the new test files exist: `npx vitest run tests/recovery.test.ts tests/recovery-investigation.test.ts tests/recovery-replay.test.ts tests/coverage.test.ts tests/coverage-ui.test.ts`. Names may follow repository conventions chosen by the owner. This command has not been run and does not replace the required repository checks.

## Timeboxes and cut points

| Window | Required checkpoint |
| --- | --- |
| 2 November, first half | Recovery contract/observations frozen; clean and faulty target execution and boundary tests working |
| 2 November, second half | Saved offline investigation, clean comparison and replay work end to end; basic workspace selection works |
| 3 November, first half | Reviewed plan persisted before inference; coverage states and evidence links work on the new scenario |
| 3 November, second half | Browser acceptance, required repository checks, integrated Jev/independent review and grouped repairs; feature freeze |
| 4 November | Stabilisation, authorised bounded live evidence, demo assets, documentation and submission |

At the day-1 checkpoint, the accepted report must become a genuine independently checked recovery finding and replay. If that is not achieved, consolidate the cause and narrow the recovery scenario; defer wider coverage mappings and presentation embellishments. Never replace missing recovery behaviour with a scripted success. Keep the acceptance and deadline semantics intact when reducing scope.

At the day-2 checkpoint, prioritise the complete single-run coverage/recovery journey. Defer cross-run aggregation, AI-generated plans/assumptions, extra adapters, general requirement editors, scenario overlap automation and regression support for recovery. Preserve honest unsupported states and recorded gaps.

No target-facing HTTP/browser/load-testing integration, real broker/outage support, general natural-language verifier, autonomous code repair or expanded conventional benchmark is part of these two days. A current-version live demonstration is separate from completing the comparative evaluation in issue #15.

## Evidence, authorisation and current limits

- Main was safely fast-forwarded from `398ce82` to the verified merge `35b444a` after fetch, clean-status and untracked/ignored-collision checks. The planning worktree was fast-forwarded to the same commit. No other task worktree was modified.
- Jev recovery search was attempted and saved at `C:/dev/ChaosPilot/.llm-output/jev-search-recovery-plan.json`; coverage was partial because the candidate cap was reached. Earlier requirement/regression evidence is at `.llm-output/jev-search-two-day-scope.json` in the primary checkout. These are investigation context, not proof of completeness.
- Routed exploration produced an incomplete source investigation after a reader limitation. The primary inspected the scheduler, executor, target/venue interfaces, adapter registry, source bundling, requirement evaluator identity, run records and integration allowlists directly. The plan relies on those original sources; unsupported worker claims are not accepted evidence.
- Implementation needs task-worktree Jev accounting prepared or reused validly under that workspace's contract. Do not treat the primary checkout's saved path as automatically satisfying a different workspace's adapter gate.
- At dispatch, dependency installation and task-worktree Jev preparation were complete. Application acceptance, browser checks and review remain unproved until the implementation handoff supplies concrete candidate-specific results. No runtime Meta calls or comparative evaluation are authorised by the implementation task.
- Runtime Meta execution and its spending cap are not yet authorised for this work. Develop and verify with mock/fake transport first. Agree a bounded application allowance and coordinate it with other worktrees before any live evidence run; never switch billing or providers on failure.
- The remaining feasibility risk is the amount of adapter-specific UI/legacy handling exposed during integration. Report that risk at the day-1 checkpoint rather than silently expanding the build or cutting the final verification.

## Integrated implementation checkpoint (2 November)

Coverage session commits `56f3729` and `f5a2730` were fast-forwarded into `codex/recovery-coverage` after the backend writers stopped and incoming paths were checked for collisions. The primary owns the combined integration. No other worktree was edited.

The backend now resolves coverage preparation from the saved system, validates the submitted plan before constructing a provider, publishes it before inference, and echoes it in the start response. Fresh execution records contextual checks from genuine credit observations or independent recovery obligations. Same-variant confirmation and saved whole/selected replay rebuild those checks from the pinned plan before comparing evidence. Only public goals and reviewed links reach the provider; the private plan context is removed from history.

The browser receives the five explicitly allowlisted pure coverage modules; server-only modules remain unavailable. Real loopback HTTP acceptance exercised the faulty and clean targets, saved records, coverage projection and exact whole/selected replay, with no model calls. The faulty deadline row is confirmed and its untried retry stays planned; the clean run exercises both rows with a recorded completion at tick 1 against deadline tick 5. All 26 modules in the actual workspace/coverage import graph were served successfully.

Browser automation is disabled in Work settings. Visual desktop/narrow/keyboard acceptance is therefore unproved; production-renderer fake-DOM tests and HTTP module checks do not substitute for it. Live-model behavior remains unproved and spending remains unauthorised. Full-suite results and independent review are recorded in the final acceptance handoff when complete.

The single integrated independent review identified three evidence gaps, all repaired together: intermediate deadline visits now record a `recovery:deadline` trace after due work; retry checks retain per-delivery before/after accounting and match the real `execution_idempotency` violation; derived coverage requires an explicitly valid, available raw recovery producer identity. Coverage evaluator version 2 records the stronger retry semantics; version 1 plans remain inspectable as incompatible rather than being silently reinterpreted. The catalog and data schema remain version 1 with additive retry-check facts.

Focused acceptance now includes confirmed deadline coverage and exact replay after both a large `advance` and delayed `drain`, actual malicious retry mutations while still offline and before/after reconciliation, missing/unknown producer controls with a genuine passing positive control, missing/contradictory retry observations, and a retry mutation surviving later matching accounting. These checks exercise the actual raw oracle and mapper, not only hand-written projection fixtures. No additional independent review round is required for the adjudicated localized repairs; the primary inspects the delta, reruns affected and required checks, and refreshes the Jev binding.
