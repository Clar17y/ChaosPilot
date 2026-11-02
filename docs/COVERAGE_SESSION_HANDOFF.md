# Parallel coverage session handoff

Status: prepared task contract, not a started session. The main recovery session owns coordination and final integration. This is a documentation-only ownership refinement; existing source investigation is reused and no additional behavioural search is claimed.

## Objective and workspace

Implement the reviewed scenario plan, evidence-backed coverage model and workspace UI from the [implementation plan](RECOVERY_AND_COVERAGE_PLAN.md), while another session implements the recovery adapter and shared backend integration.

Read the full plan at `C:/dev/ChaosPilot-worktrees/recovery-coverage/docs/RECOVERY_AND_COVERAGE_PLAN.md` and this handoff by absolute path before setup. These files are uncommitted in that worktree and are not automatically available in a new checkout. Do not copy or modify the other session's work.

Keep the parent session anchored in the stable primary checkout. Follow `C:/dev/ChaosPilot/AGENTS.md` and `scripts/README.md`; inspect status, branch and `npm run worktree:list`. Create a distinct `coverage-ui` worktree from the agreed base `35b444aaa670a7d3bf46d314c5834f50a9794550` using the repository helper, or reuse this task's worktree if already created. Use explicit per-command working directories. Install dependencies through the helper/default setup when needed. Use a distinct `CHAOSPILOT_PORT` for a dev server.

You are not alone in the codebase. Preserve other work, do not reset/clean it, and do not edit paths assigned to the recovery session. Do not delegate again. Route bounded coding activities using the installed framework, with task-worktree Jev preparation and explicit owned paths. Mock/fake transport only; no runtime Meta spending is authorised.

## Exclusive file ownership

You own:

- `src/coverage/**` including the shared coverage types, versioned catalog and pure validation/projection helpers.
- `src/web/coverage.ts`.
- `src/web/app.ts`, `src/web/workspace.ts`, `src/web/snapshot.ts`, `src/web/replay-stage.ts`, `src/web/reproduction-view.ts` for bounded workspace wiring and recovery evidence presentation.
- `public/index.html` and `public/styles.css` for this feature's markup/styles only.
- New `tests/coverage*.test.ts` files, plus `tests/workspace.test.ts`, `tests/replay-stage.test.ts`, `tests/reproduction-view.test.ts`, `tests/reproduction-ui.test.ts` and `tests/reproduction-player.test.ts` for affected UI acceptance only. Coordinate any other existing test file ownership before editing it.
- A narrowly scoped coverage implementation note if useful; do not edit the master plan or this handoff while the primary owns them.

The recovery session owns `src/recovery/**` and all shared backend integration. **Do not edit** `src/domain.ts`, `src/adapters/index.ts`, `src/systems/**`, `src/server.ts`, `src/cli.ts`, `src/providers/**`, `src/investigation/**`, `src/storage.ts`, `src/evidence.ts` or `src/requirements/**`. If another existing UI module is genuinely needed, coordinate ownership before changing it. A separate worktree does not authorise overlapping file ownership.

## First checkpoint: share the interface

Before substantial implementation, agree and publish a small interface-only commit under `src/coverage/` that the recovery session can merge. Freeze:

1. `CoveragePlan`: version and evaluator/catalog identity, pinned system/brief/adapter/contract/source context, explicitly reviewed scenario intentions and unique requirement-text or contract-rule links.
2. `ScenarioCheckEvidence`: deterministic check identity and evaluator, experiment index, typed trigger/check outcome, relevant trace references and expected/observed facts. It must distinguish a reached/checked condition from a merely claimed goal or absent violation. Recovery facts include accepted report identity, reconnect/deadline/horizon and actual order/credit observations.
3. Pure function boundaries for building/validating a reviewed plan and projecting coverage from the pinned plan, recorded check results, experiment validity, confirmed findings and stop state. Keep Node-only operations out of browser-facing types and data. Use parameters for coverage fields if the baseline `InvestigationRecord` does not yet contain them; do not patch its backend definition yourself.
4. UI/backend request and response shapes. The recovery session owns server endpoints and launch validation; this session owns the UI caller. The plan is validated and attached to the saved run before the first model request. Reopening coverage is read-only and executes neither model nor target.

Use one authoritative schema rather than separate definitions in each branch. A model-supplied scenario identifier is never evidence. Fixed recovery adapter/profile IDs are `synthetic-trading-recovery` and `trading-recovery`; checks cover recovery by deadline and duplicate/retry accounting. The actual recovery contract and observations are owned by the recovery session and must match the master plan.

Recovery implementation is now assigned in `C:/dev/ChaosPilot-worktrees/recovery-coverage`. Its producer-owned raw observations will be defined in `src/recovery/types.ts` and documented in `docs/RECOVERY_BACKEND_HANDOFF.md` there. Read the actual producer contract when available; do not invent another recovery state schema in the coverage branch. Your adapter-neutral coverage types and credit-rule projection can proceed independently. The recovery session will integrate the bridge from those raw facts to the agreed coverage helper inputs.

Packaging checkpoint: the original `.gitignore` pattern `coverage/` also ignores new files under `src/coverage/`. The recovery branch has corrected it to `/coverage/` so only root generated output is ignored. Before publishing your implementation commit, ensure every new source module under `src/coverage/` is actually tracked; if your branch still has the original ignore rule, explicitly stage the owned source files with `git add -f` or integrate the agreed ignore correction. A passing local build that reads ignored source files is not a reproducible checkout.

## Work that can proceed immediately

- Implement catalog and plan validation, coverage projection and matching-context checks using the existing reviewed credit-rule evidence plus explicit recovery fixtures.
- Implement all documented states: suggested, planned/unexercised, exercised without violation, failed/unconfirmed, confirmed finding, inconclusive, invalid and unsupported/context-only.
- Build a fetch-injected controller following the existing `FunctionalController` generation/inspection pattern. Handle system/revision/adapter/target changes, historical selection, late responses, reload and fetch failures.
- Add preparation review and selected-investigation coverage within the workspace. Wire the new adapter selector and recovery timeline presentation under your exclusive UI ownership. Show simulation units and recorded facts.
- Add meaningful tests for false coverage claims, wrong context, missing observations, cancelled/early-ended runs, legacy records, unsafe text, stale responses and navigation.

Fixtures are development inputs. Do not present their output as genuine recovery execution or AI discovery. Backend wiring and the real combined journey require integration with the recovery branch.

## Invariants and acceptance

All coverage is planned/unproved until backed by candidate-specific checks:

| Invariant | Required cases/evidence |
| --- | --- |
| A scenario counts only when its condition was reached and checked | Claimed ID without trigger; zero checks; missing observation; actual credit trigger; recovery trigger; passing/failing/inconclusive check |
| Confirmed means a saved, matching confirmed finding | Raw failure without confirmation; wrong experiment/source; matching replay/clean-confirmed finding |
| Early stop preserves intentions | First finding stops before a second scenario; budget exhaustion; cancellation before trigger, during pending recovery, and after a completed finding |
| Coverage never crosses contexts silently | Different brief hash/revision, contract/source, adapter, unknown evaluator, edited/duplicate requirement text; legacy record without a plan |
| UI selection has one current owner | Delayed history/detail/launch response, system/target change, reopened saved run, failed request and reload |
| The UI preserves evidence and scope | Context-only prose, unsupported inventory mapping, logical ticks, escaped external text, explicit unsupported recovery baselines/regressions |

Focused acceptance uses the existing credit-rule evidence and explicit recovery fixtures first. Run appropriate new tests, `npm run typecheck`, `npm test`, and relevant browser checks against your candidate. Record commands, conditions, candidate and results; distinguish fixture acceptance from the integrated recovery run, which the primary accepts after merging.

Before handoff, self-review for reuse, clarity and unnecessary work; apply justified fixes and rerun affected checks. Return completion status, exact changed paths, interface/implementation commit IDs, exports and backend wiring needed, commands/results, remaining unproved integration cases and useful log locations. Do not hold completed results for optional audits.

## Final integration owner

The primary recovery session merges committed work, wires the shared record/server/investigation/replay boundaries and verifies the real mock/API/browser flow. It owns the integrated Jev diff review, one independent review and required final repository checks. Branch-level checks are reusable when inputs match, but do not establish end-to-end acceptance independently.

The short interface checkpoint and final integration remain sequential. Coverage implementation and recovery implementation can otherwise overlap. The feature freeze remains the end of 3 November; 4 November is for stabilisation, authorised live evidence, recording and submission.
