# Finding-to-Regression Testing

Convert confirmed investigation findings into immutable, engineer-reviewed regression definitions and execute them against explicitly selected compatible targets in ChaosPilot.

## Overview

When an exploratory or scripted investigation uncovers a confirmed finding (reproduced by deterministic replay and passing against the clean control), engineers can convert that finding into a saved regression definition.

Like [functional baselines](FUNCTIONAL_TESTING.md), finding-to-regression capture and execution make **no AI model calls**, consume zero tokens or budget, and require no live provider credentials. Unlike static baseline catalogs, regression definitions are captured directly from confirmed findings, pin the exact sequence and original lineage, and require explicit engineer review of the reference expectations before publication.

## User Flow

1. **Select a Confirmed Finding**:
   - In `/workspace`, select a saved `synthetic-trading` system profile (e.g., `trading-gateway`).
   - Open a terminal saved investigation run in **Investigations** / **Findings & reproductions** and select a confirmed finding.
2. **Preview Proposed Expectations**:
   - In the **Capture as regression test** panel (shown alongside **Challenge with Muse**), click **Preview regression expectations**.
   - The server verifies the run's mutation lock, pinned system brief, contract, target source, clean-control source, deterministic replay (`replaySelectedExperiment`), and clean-control execution.
   - If any check fails (unconfirmed finding, legacy run without a pinned brief, unsupported adapter, or source/contract drift), the preview reports `available: false` with the specific reason.
3. **Review Reference Provenance & Confirm Consent**:
   - When available, the preview displays the proposed step-to-trace bindings, delivery-by-delivery expected decisions (`accepted` / `rejected` with exact rejection reason), expected credit/quote accounting, expected order book and `absentOrderIds`, `stateUnchangedFromPrevious` flags, final business state, and pinned requirement rule checks.
   - Expectations are explicitly labeled: *"Proposed reference behavior from clean control — requires engineer review"*.
   - Tick **I have reviewed the proposed clean-control expectations and confirm saving this immutable regression definition**, then click **Save reviewed regression**.
4. **Execute Against Any Compatible Target**:
   - Open **Functional tests** in the workspace navigation rail (or click **Open in Functional tests** after saving).
   - In the **Saved finding regressions** section, select a saved regression definition and an explicit compatible target variant (for example, `candidate-c` to verify the regression still fails on the faulty implementation, or `clean` to verify it passes on the fixed/clean implementation).
   - Click **Run selected regression**. Each execution is saved separately under `runs/regressions/runs/<runId>/record.json` and can be reopened across server restarts.

## Reference Provenance & Engineer Review

ChaosPilot does not silently promote clean-control output into an unreviewed oracle:

- `deriveRegressionExpectations` extracts positive milestone assertions from the verified clean-control execution of the finding's saved experiment (`resolveExperimentPositionForIndex(record.experiments, finding.experimentIndex)`).
- Every preview and saved definition carries `expected.referenceProvenance`:
  - `kind: 'clean-control-reference'`
  - `reviewLabel: 'Proposed reference behavior from clean control — requires engineer review'`
  - `cleanSourceHash`: SHA-256 hash of the clean reference implementation used to derive the expectations.
- `POST /api/regressions/definitions` rejects any request that omits `reviewed: true`, supplies an invalid `reviewToken` / `definitionId` / `contentHash`, or attempts to pass client-authored `expected` or `experiment` fields. The server recomputes the expectations and verifies that the canonical content hash matches the reviewed preview token.

## Positive Assertions & Classification

A regression pass is never inferred from "no violations" or missing evidence. `evaluateRegressionExecution` evaluates explicit positive assertions across every milestone:

- **`execution.identity`**, **`execution.complete`**, **`execution.valid`**, **`execution.evidence`**, **`execution.trace-length`**, and **`execution.delivery-count`**: Verify that the target executed the exact saved sequence to completion with valid harness steps and complete typed delivery observations matching the expected trace and delivery counts.
- **`sequence.trace-<traceIndex>`**: Verifies that every step-to-trace binding (`send`, `duplicate`, `advance`, `deliver`, `drain:deliver`, `drain`, `fill`, `confirm_cancel`) occurred at the expected trace index, step number, action, and message ID.
- **`delivery.<traceIndex>.<messageId>.binding`**, **`.decision`**, **`.credit-quote`**, **`.orders`**, and **`.state-unchanged`**:
  - Verify channel, message type, target order ID, and `payloadValid === true`.
  - Verify `status` (`accepted` or `rejected`) and exact rejection `reason`.
  - Verify `usedCredit`, `reservedCredit`, `creditLimit`, and `quote` after each delivery.
  - Verify the complete `orders` map (`status`, `price`, `initialQuantity`, `remainingQuantity`, `filledQuantity`, `cancelledQuantity`, `cancellationRequested`) and confirm every order ID in `absentOrderIds` is absent.
  - When a delivery is expected to be rejected without business mutation (`stateUnchangedFromPrevious: true`), verify that `quote`, `creditLimit`, `reservedCredit`, `usedCredit`, and `orders` are identical to the state before that delivery.
- **`final.state`**: Verifies the terminal `quote`, `creditLimit`, `reservedCredit`, `usedCredit`, `orders`, and `absentOrderIds`.
- **`requirements.<preset>`**: Re-evaluates any requirement rules pinned in `definition.origin.systemBrief` against the target execution using `evaluateRequirementRules`. If the requirement evaluator throws or is unavailable, `requirements.available` is recorded as `inconclusive` (never silently skipped or treated as a pass).
- **`oracle.violations`**: Verifies zero invariant violations and specifically distinguishes whether the original finding's invariant (`definition.origin.finding.violation.invariant`) recurred or whether a different invariant was violated.

Outcomes are classified as:
- **`pass`**: Every positive assertion, pinned requirement rule, and oracle check passed.
- **`fail`**: Target behavior contradicted an expected delivery decision, business state, pinned requirement rule, or invariant check.
- **`inconclusive`**: Execution was incomplete, delivery observations or trace bindings were missing, target source identity mismatched the expected executing target source, or the requirement rule evaluator was unavailable.
- **`invalid`**: A sequence step was rejected by the simulation harness (`result.valid === false` or `result.rejections.length > 0`).

## Intentional Target Execution vs. Historical Replay

ChaosPilot keeps historical investigation replay and regression execution strictly distinct:

- **Historical Replay** (`src/storage.ts` / `replaySelectedExperiment`): Re-runs a saved investigation experiment against its original target variant and checks whether the current source matches the recorded `sourceHash`. Source changes are flagged as drift against the historical record.
- **Regression Execution** (`POST /api/regressions/run` / `runSavedRegression`): Intentionally executes an immutable regression definition against a newly selected compatible target variant (or updated target source) to test whether the defect is present or fixed.
  - At the start of execution, `runSavedRegression` resolves the selected target's current `expectedSourceHash` and checks adapter contract compatibility (`canonicalJson(adapter.getContract()) === canonicalJson(definition.origin.contract)`).
  - `evaluateRegressionExecution` verifies `execution.identity` against that run's `expectedSourceHash`, while preserving the original finding's target variant and `sourceHash` in `record.origin`.
  - When a saved `RegressionRunRecord` is reopened from disk, `isValidRegressionRunRecord` validates the run against its own recorded `expectedSourceHash`, never requiring equality with the current live target source or the original finding's source hash.

## Storage Layout, Immutability & Lineage

Regression artifacts live in their own namespace under the configured `runsDir`:

- **Definitions**: `runs/regressions/definitions/<definitionId>/record.json` (where `definitionId` is `reg-<first 24 hex chars of contentHash>`).
- **Executions**: `runs/regressions/runs/<runId>/record.json`.

Key storage guarantees:
- **Atomic Non-Overwriting Publication**: Both `saveRegressionDefinition` and `saveRegressionRun` write `record.json` with `flag: 'wx'` inside a unique temporary directory (`.tmp-<id>-<random>`) and publish via `fs.rename(tempDir, finalDir)`. Existing records are never overwritten; collisions fail cleanly and clean up only their own scratch directory.
- **Self-Contained Lineage**: Every `RegressionDefinitionRecord` embeds an `origin` snapshot with the original run revision and evidence hash, finding and experiment identities, target and clean-control source hashes, pinned brief/contract, finding, and full `originalResult` including its trace. Reviewed clean-control reference facts are saved separately in `expected`.
- **Definition-Bound Run History**: Loaded executions must agree with their saved definition's full content hash, origin, experiment, and expectations. Inconsistent records are excluded from history. The saved definition must remain present; deleting the original investigation does not remove it.
- **Resilience to Origin Deletion or Modification**: If the original investigation run (`runs/<runId>.json`) is later modified or deleted, `checkOriginStatus` reports `originStatus.status` as `'modified'` or `'deleted'` with an explicit explanation, while the saved regression definition remains valid, inspectable, and executable from its pinned `origin` snapshot.
- **Zero Side Effects on Existing Stores**: Capturing or running a regression never mutates `runs/<runId>.json`, `runs/challenges/`, `runs/reports/`, or `runs/functional/`. Moreover, `getRegressionEvaluatorIdentity()` hashes `src/regressions/evaluator.ts`, `src/functional/evaluator.ts`, and `src/requirements/evaluator.ts` without altering `getFunctionalEvaluatorIdentity()`, preserving 100% compatibility with saved functional baseline records.

## Workspace Guardrails & Limitations

- **Supported Scope**: Currently supports the registered `synthetic-trading` adapter and bounded deterministic sequences (`send`, `duplicate`, `advance`, `deliver`, `drain`, `fill`, `confirm_cancel`) whose steps carry valid message payloads (`payloadValid === true`) on the clean control. Sequences that rely on intentionally malformed raw payloads (`inject_raw`) are rejected for regression capture with a clear reason.
- **Workspace State Ownership**: Unsaved system requirement edits, draft profiles, pending profile saves, unconfirmed contracts/targets, or runs still saving (`waitsForSave`) block capture and execution. Switching system profile, revision, adapter, target, or selected finding invalidates stale in-flight preview/save/run/detail responses.
- **Pinned Brief Revision Notice**: If the current workspace profile has been saved at a newer revision than the revision pinned in a regression definition's `origin.systemBrief`, the UI displays an explicit notice showing both revisions and stating that regression execution evaluates against the pinned original brief/rules, never unpinned prose edits.
