# Business context, richer fault lab and Astra design

The participant redirected the next iteration from comparative benchmarking toward a richer synthetic target and a usable system-definition workflow. The functional changes and Astra design are implemented and locally verified on `codex/system-brief-fault-lab`. No persistent Codex Goal or new live Meta evaluation batch has been activated.

## Outcome

Give an automation engineer somewhere to describe the system and read its business rules before launching an investigation. Expand the known synthetic fault library and provide a concrete Astra UX/UI proposal that can guide subsequent implementation.

## Current work

1. **System briefs and requirements.** Add reusable system selection and editable business overview/additional requirements. Show the existing executable trading contract in readable form. Clearly separate rules with deterministic checks from contextual prose. Save a brief/check-contract snapshot and revision/hash with new user-facing launches, preserving historical evidence when the brief changes. New domains without adapters are saved drafts and cannot run.
2. **Known fault lab.** Add six independently selectable realistic variants to the existing three: stale/repeated quote version, stale/repeated credit version, used-credit accumulator reset, mismatched execution price acceptance, conflicting execution-ID acceptance and premature FILLED lifecycle. Every variant needs a valid deterministic reproduction, an appropriate clean comparison and normal/boundary cases under the unchanged public verifier. Keep recipes and labels out of investigator context.
3. **Astra design.** Give the explicitly requested Astra agent the product vision, settled trading rules, honest capability limits, current screenshots and functional boundaries. Deliver a system-workspace information architecture, engineer journeys, fields/readiness/evidence states, implementation priorities and a self-contained clickable proposal. Astra owns design artifacts only; production workers own their separate implementation scopes.

## Boundaries

- Preserve the first-cut commit and archived prompt2.0 live reports. New context support moves the prompt to3.0; it does not retroactively alter the old study.
- Known faults are development/demo data, not held-out evidence. Future unbiased evaluation needs a separately authored set with stronger isolation.
- This round uses offline tests and deterministic replay. The previously proposed $5 live comparison has not started; revisit the evaluation budget and protocol after the product changes are accepted.
- Use the installed development-provider framework and explicit non-overlapping ownership. The primary model stays unchanged; Astra is an explicitly requested design subtask.
- Keep Node/TypeScript/Vitest, plain frontend and JSON persistence. No database, auth, Docker, deployment or real transport integration in this slice.
- The current simulator has no contractual liveness deadline. Dropped reports, outage recovery and latency SLA checks require explicit future capabilities; a delay alone is not evidence of a fault.
- Keep new work on the local branch for review. Do not automatically push it or publish the design prototype.

## Completion evidence

- The running app visibly exposes business requirements and a working brief authoring/save/select flow.
- New launches pin context; edits and stale revisions have meaningful, tested behaviour; unsupported adapters cannot start providers.
- The nine known variants have a reproducible offline catchability/control matrix, with old target identities preserved.
- Astra's design is inspectable and labels unsupported execution and synthetic prototype activity honestly.
- Appropriate tests, typecheck/build and integrated review pass, with remaining limitations recorded.

A stronger stateful baseline and fresh comparison remain the next research step. Finding more planted defects in this development library does not establish superiority or engineer-time savings.

## Acceptance coverage

| Invariant | Relevant cases | Evidence status |
| --- | --- | --- |
| A saved revision cannot silently overwrite another writer | Concurrent update/create, seed versus update, stale API revisions, separate processes | Regression tests passed, including forced cross-process lock contention and the setup/release IO-error repair |
| Existing requirements cannot be silently reset | Corrupt seed/custom files, file/ID mismatch, invalid dates/IDs, revision overflow | Byte-preservation and schema tests passed |
| Every new run uses the validated saved context | Snapshot/hash tampering, adapter/contract mismatch, unconfigured profile, stale launch | Engine/API tests passed; actual browser and CLI launches pinned snapshots |
| The form cannot launch a different context from the one shown | Dirty saved form, new draft changed to trading, pending save/start, selection while dirty, discard/save | Browser verified dirty/draft blocking, save/discard and revision isolation; client pending-network timings were inspected but not exhaustively browser-injected |
| Known faults remain catchable under the public verifier | Nine recipes, exact replay, clean/normal controls, malformed input and boundary cases | Nine compiled reproductions/replays/clean/normal controls and root fault/boundary tests passed |
| Design claims match the prototype | Brief editing, saved revision separation, unconfigured system blocked, synthetic provenance | Selected browser checks passed; see `design/astra/BROWSER_CHECK.md` |

At the stable pre-review checkpoint, 344 root tests, typecheck and build passed. The independent review supported the context/revision boundaries and identified one owning-component cleanup issue: an IO failure during lock setup or release can leave a profile blocked without clear failure reporting. This led to a consolidated repair of the related setup/operation/release transitions, including partial writes, close failure, transient/permanent release failure and preserved operation errors. This exact-location repair followed the review's source evidence and required no additional broad behavior search. Earlier partial Jev search evidence remains context, not proof of complete search coverage.

Jev review of the integrated code candidate was attempted and bound to its saved diff. Coverage was partial because of the operation budget and oversized hunks; it was not an approval or all-clear. The one native Sol review followed confirmed CLI authentication/transport failures in the same session. There is no automatic extra reviewer for the scoped cleanup repair; primary acceptance must inspect the repair and matching failure-injection results.

## Foundation checkpoint, before workspace integration

The cleanup repair is complete. Exclusive creation now establishes ownership before token setup; setup failure attempts owned cleanup. Release verifies ownership and retries removal within a bound. Permanent failures return an explicit error retaining the original operation failure and warning of an uncertain commit; API create/update/list map lock availability failures to 503. The implementation does not steal locks or promise recovery while the filesystem itself denies cleanup.

Twelve injected failure cases cover partial/full token-write errors, close failure, active contention/reacquisition, transient/permanent unlink errors, release-read failure, operation errors, combined errors, ownership mismatch and HTTP error reporting. The worker's environment denied listening sockets; the primary reran the final candidate on the host and observed **356 tests passing in 19 files**, plus typecheck and build. The scoped delta was inspected against the original review and related transitions. Earlier unchanged simulator, browser and replay evidence was reused, rather than adding another review round.

Final candidate: first-cut HEAD `7561729eb2648eac9176f30f6fca646d1fff1236` plus code diff SHA256 `15c4026a180aa734bee01a31790a4f80ceed0bf3faee7769ae12ec77734301fb`. Jev was rebound to this candidate, retaining the partial-coverage limitation. Logs and saved diff bindings are in ignored `.llm-output/`. Static documentation/screenshots and the offline recipe report are excluded from that code hash. No new runtime Meta calls were made; actual credential scanning found no configured key in public files. Work remains local and unpushed.

The approved workspace integration around this core is recorded below. Outage, loss and latency experiments need a subsequent explicit recovery/deadline contract. A fresh comparison with the stronger non-AI baseline follows those product choices; this known fault library cannot substitute for that study.

## Approved follow-on: real workspace integration and simplify

The participant approved integration of Astra's workspace into the working application, followed by the simplify skill. Starting HEAD remains `7561729eb2648eac9176f30f6fca646d1fff1236`; the existing uncommitted code diff is `15c4026a180aa734bee01a31790a4f80ceed0bf3faee7769ae12ec77734301fb`. Existing edits/staging, isolated candidates and archived live artifacts are preserved; no commit or push is part of this request.

The bounded UI outcome is a system workspace with Overview, Brief & requirements, Capabilities & checks, Investigations, Findings & reproductions and a separate Prepare investigation flow. It uses actual persisted profiles, records and replay APIs. The current brief schema and synthetic adapter remain the execution boundary; illustrative prototype data and unpersisted fields will not be presented as working product features. History uses optional brief metadata extracted while records are already read, with an explicit legacy view for records lacking a snapshot.

Planned acceptance covers dirty-form navigation and selection, save/start/status transitions, stale asynchronous selections, historical/current revision separation, unconfigured launch blocking, legacy history, actual mock run/stop/replay/export, unknown usage and text-safe evidence. Desktop and narrow layouts will be compared against Astra's source at matching viewport sizes. Offline browser fixtures use a separate ignored store and a delayed mock provider; they do not alter user evidence or the spending ledger.

After integration, one bounded simplify audit will cover reuse, quality and efficiency in the combined recent diff. Proven improvements will be grouped under one repair owner; intentional business-source isolation and existing failure handling must remain. Additional reviewers or broad refactors are not automatic. Final verification and applied/deferred simplifications will be recorded when proved.

## Integration and simplify acceptance

The six working views now use actual profiles, scoped revision history, immutable context and existing execution/replay/export APIs. Unconfigured profiles expose no trading execution contract. Empty detail is distinct from a run result. Global controls remain available while navigating or editing another system.

The one integrated simplify audit identified live inspection being mistaken for historical inspection, a resulting unsaved-artifact fetch, and misleading pending-start cancellation errors. The related selection/open/poll/start/stop/terminal paths were consolidated in one repair. The primary inspected that delta and removed redundant pending-stop state and a no-op branch. Optional typed simulator contract access and one shared proposal display calculation address the accepted reuse/quality/efficiency recommendations. No speculative caching or variant deduplication was added.

Final host evidence: **387 tests in 23 files**, typecheck and build passed. The new lifecycle cases exercise the state code used by the UI, with delayed-request browser acceptance recorded in `../design-qa.md`. These are offline workflow checks; no new runtime Meta evaluation or human-time comparison is claimed. Jev was rebound to the final saved diff, with partial coverage retained explicitly. Logs, diff identities and the primary repair assessment remain in ignored `.llm-output/`; no commit or push is included.

## Approved review repairs and release

After that checkpoint, the participant requested a Meta review and then authorised fixing its findings, pushing the branch and raising a PR. One consolidated frontend repair covers Stop through acknowledgement/status settlement, monotonic response application without slow-request starvation, unsaved-draft identity, and visible profile-loading failures. Primary acceptance added the coupled cancelled-controls/old-status case. Final host evidence is **401 tests in 24 files**, typecheck and build, with controlled before/after browser observations in `../design-qa.md`. The release retains the existing synthetic-adapter and evaluation limitations; a new live performance study remains separate work.
