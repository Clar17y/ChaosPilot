# Coverage implementation (branch `codex/coverage-ui`)

Worktree: `C:/dev/ChaosPilot-worktrees/coverage-ui`, branch `codex/coverage-ui`,
based on shared interface commit `56f3729a3b472d3d95badc24e45138565d07673e`.
The implementation commit follows that published checkpoint. Frozen `src/coverage/types.ts` and
`src/coverage/identity.ts` are unmodified. No backend/domain/server files were
edited; backend integration below is the recovery owner's work.

## Pure coverage package (`src/coverage/`)

- `index.ts` exports all shared types/identities, the four `CoverageFunctions`
  (`prepareCoverage`, `buildCoveragePlan`, `validateCoveragePlan`,
  `projectCoverage`), a `coverageFunctions` object, and
  `adaptCreditEvidenceToScenarioCheck`.
- `catalog.ts` is the single explicit catalog: `accepted-order-credit-limit`
  only on `synthetic-trading` (unique normalized requirement text with a
  reviewed mapping; every mapped line is preserved as a link);
  `recovery-by-deadline` / `recovery-retry-idempotence` only on
  `synthetic-trading-recovery`, linking `recovery_deadline` (retry prefers an
  explicit `recovery_retry_idempotence` rule when present — no substring
  guessing). Everything else is context-only. It also holds the browser-safe
  original credit-evaluator identity, test-verified against
  `getRequirementEvaluatorIdentity()`.
- `plan.ts` validates unknown input safely: schema, catalog/evaluator
  identities, all seven pinned context fields, explicit `reviewed === true`
  (never overwritten), duplicate scenarios/links, unsupported mappings.
  Returns canonical cloned plans; empty intentions are valid.
- `project.ts` projects all eight statuses with no percentage. It binds every
  check to the validated plan context, experiment index/source, scenario/facts
  family, known evaluators, safe finite accounting (no invented zeros) and
  exact indexed step/tick/message trace refs. Unknown or contradictory
  evidence is `inconclusive`; invalid harness experiments are `invalid`;
  unselected suggestions are `suggested`; context-only prose is `unsupported`.
  Only an explicit fact-consistent failure with a unique saved finding
  (matching violation/experiment/source/compatible invariant, reproduced
  **and** clean-control passed) is `confirmed`. Lost backlog (reconnect,
  horizon ≥ reconnect+5, unreconciled accounting, no completion) fails;
  on-time completion before the horizon reaches the deadline passes;
  completion at `reconnect+5` is on time, later stays failed. Completed
  evidence survives cancellation (whole-run completion is not required).
  Recovery horizon and claimed completion ticks must each have a matching
  recorded trace reference; a claimed horizon alone cannot prove a deadline miss.
- `credit-adapter.ts` is an execution-time-only pure adapter from genuine
  saved `RequirementRuleResult` + `DeliveryObservation` + pinned snapshot. It
  verifies evaluator identity, source/snapshot hashes, experiment index, the
  reviewed unique mapping, an accepted valid client `new_order`, event-level
  evidence and exact trace refs; ids distinguish deliveries. It never infers
  checks on reopen and never promotes a rule failure to an oracle finding.
  The backend should record `ScenarioCheckEvidence` during execution (this
  adapter or equivalent genuine recording); legacy records stay `legacy`.

## UI (`src/web/coverage.ts`, wired in `src/web/app.ts`)

- `CoverageController` is fetch-injected with generation/inspection tokens.
  `POST /api/coverage/prepare` responses are runtime-validated against the
  selected saved context and re-canonicalized through `prepareCoverage`;
  intentions start unreviewed and are reviewed only by user action. A 404 (or
  any failure) means coverage unavailable: no fabricated hashes/rules/plan,
  existing trading/inventory launch proceeds without claiming a saved plan,
  recovery launch stays blocked. Dirty/draft/not-ready contexts yield no plan.
- Launch uses the existing `POST /api/investigation/start` with
  `coveragePlan`; `validateLaunchResponse` checks the echoed plan equals the
  submitted plan and the snapshot identity before navigation. A successful
  HTTP start still settles global start/stop bookkeeping even when the echo
  cannot be verified; stale responses cannot overwrite current inspection
  (including A-B-A). The launch token is captured after clearing the previous
  dashboard inspection so the launch does not invalidate its own response.
- Reopening is GET-only via existing `/api/runs` and `/api/runs/:id`.
  `inspectRun` builds the projection from the record's pinned snapshot and
  `contextAudit` contract hash (actual `snapshot.contract.invariants`),
  passing real `valid`/`executionComplete`/`sourceHash`; failed opens clear
  the old projection. Experiment links resolve saved experiment indices (not
  array positions) through `resolveExperimentPositionForIndex`.
- Rendering is one production DOM path using `textContent` only (hostile
  prose/IDs are inert text), with pinned context, stop status/reason and
  recorded recovery facts in simulated-tick units
  (`recordedRecoveryFacts` in `reproduction-view.ts`).
  `synthetic-trading-recovery` displays as trading state; functional
  baselines/regressions return explicit recovery-unsupported reasons.

### Browser static-module boundary (important)

The unchanged server only serves root `/basename.js` files, so the coverage
UI must not be in the app's static graph. `app.ts` therefore loads it behind
`loadOptionalFeature(() => import('./coverage.ts'))` (helper in
`workspace.ts`, injected-importer tests cover success/failure). On failure the
baseline workspace starts normally, coverage panes show "unavailable", and
recovery launch is blocked. To enable the feature, the backend owner must
serve these exact built assets (in addition to the existing root
`/coverage.js`):

- `/coverage/identity.js`
- `/coverage/catalog.js`
- `/coverage/prepare.js`
- `/coverage/plan.js`
- `/coverage/project.js`

(`types.js` is type-only; `index.js`/`credit-adapter.js` are backend-use
entry points and are not needed by the browser graph.)

## Backend wiring still required (recovery owner)

1. `POST /api/coverage/prepare` per `src/coverage/INTERFACE.md`.
2. Accept/validate/persist `coveragePlan` on investigation start **before**
   the first provider request; echo it in the launch response.
3. Serve the five `/coverage/*.js` assets above (allowlisted, pure modules).
4. Record `ExperimentResult.scenarioCheckEvidence` during execution; compare
   it in replay. Recovery adapter/profile registration
   (`synthetic-trading-recovery` / `trading-recovery`) and widened
   `SystemBrief.adapterId` are backend changes.

## Final host validation (`.llm-output/host-validation/`)

- `npm run typecheck` — passed both TypeScript configurations (exit 0).
- `npm test` — build passed; **66 test files / 1,214 tests passed**, exit 0.
  Final code run started at 10:38:44 UTC on 2 November 2026; see `npm-test.log`.
- Focused coverage and affected UI checks — **8 files / 142 tests passed**,
  exit 0; `focused.log`. These also run in the full suite. They include the
  launch reset/selection sequence, missing horizon/completion references,
  cancellation before a trigger, during pending recovery and after confirmation.
- `node .llm-output/host-validation/assets.mjs` — main compiled workspace
  graph: **20 modules served, zero failures**. Five shared coverage assets
  and coverage preparation return 404 on this deliberately unchanged backend.
  This confirms the documented integration gap; the caught optional loader
  preserves baseline startup. This is an HTTP/import check, not visual browser QA.
- `git diff --check` — passed. Source inputs and Git candidate identity are
  recorded in `.llm-output/host-validation/candidate.json`.

### Invariant coverage

| Invariant | Concrete branch evidence | Remaining limit |
| --- | --- | --- |
| Count only reached, checked conditions | `coverage.test.ts`: credit observation, trigger/outcome, exact trace, missing/negative facts and duplicate-ID controls; `coverage-recovery.test.ts`: horizon/completion, pending and exactly-once cases | Recovery inputs are explicit fixtures; genuine recovery execution belongs to integration |
| Confirm only a matching saved finding | Credit/recovery tests distinguish raw failures, wrong experiment/invariant, replay/clean gates and confirmed findings | Backend must record actual independent violation IDs and replay evidence |
| Preserve early-stop intentions | Recovery tests cover cancellation before trigger, during pending recovery and after a completed confirmed finding; retry remains unexercised | Real runner publication/cancellation ordering requires combined acceptance |
| Keep pinned contexts separate | Plan validation, source/evaluator mismatch, unique normalized mapping, legacy/unsupported cases; saved-record reload uses its own snapshot | Server resolves and validates the actual source/contract/snapshot |
| One current UI owner | Deferred preparation/detail responses, A-B-A, launch-reset/history-selection sequence, failed request and full saved-record inspection tests | Real browser navigation remains unproved |
| Preserve evidence/scope safely | Production DOM renderer tests for hostile text and navigation; recorded recovery presentation; explicit unsupported baseline/regression guards; optional module-loader tests | Desktop/narrow/keyboard visual acceptance is unproved; provenance text wraps long hashes |

All final application checks used mock/fake inputs. No runtime Meta spending
or genuine AI-discovery claim is part of this package.

### Earlier child validation (`.llm-output/coverage-implementation/repair/`)

- `focused-tests.log` — 8 owned/affected files, 139 tests passed, exit 0.
- `typecheck.log` — `npm run typecheck` exit 0.
- `diff-check.log` — `git diff --check` exit 0.
- `npm-test.log` — one full-suite attempt in the child sandbox: 18 non-owned
  files failed on sandbox `mkdtemp EPERM` / loopback restrictions (336 tests,
  all in non-owned files; e.g. worktrees/application/prompt temp setup). No
  owned test file failed. The primary runs the final full suite on the host.

Those child environment limitations are superseded by the passing host suite
above; their logs remain available for diagnosis.

## Changed implementation paths

`src/coverage/{catalog,credit-adapter,index,plan,prepare,project}.ts`;
`src/web/{app,coverage,reproduction-view,snapshot,workspace}.ts`;
`public/index.html`, `public/styles.css`;
`tests/{coverage,coverage-recovery,coverage-ui,reproduction-view,workspace}.test.ts`;
this note. The frozen shared-interface files and all recovery/backend-owned
paths remain unchanged by the implementation commit.

Unproved: combined backend+recovery execution, real browser rendering
(automation disabled; verified via fake-DOM production-renderer tests and
build output inspection), and live-model behavior (mock/fake transport only).
