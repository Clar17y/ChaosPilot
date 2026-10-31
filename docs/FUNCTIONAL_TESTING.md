# Functional Baseline Testing

Saved deterministic functional baselines for synthetic trading in ChaosPilot.

## Overview

Functional baseline testing provides an allowlisted, deterministic testing workflow with explicit milestone assertions, backed by the deterministic simulation adapter, saved system brief and contract context, and inspectable evidence.

Unlike exploratory AI investigations, functional baselines make **no AI model calls**, consume no tokens, incur no billing, and require no live provider keys. They evaluate the target against precise business expectations and accounting invariants.

## User Flow

1. **Select a Profile**: In the system workspace (`/workspace`), select a saved trading profile (e.g. `trading-gateway`).
2. **Navigate to Functional Tests**: Click **Functional tests** in the sidebar navigation rail.
3. **Select Target Variant**: Choose an explicit supported variant (e.g., `clean` for the baseline pass, or `candidate-c` to demonstrate defect detection).
4. **Run Baselines**: Click **Run baselines**. The backend executes the allowlisted scenario catalog against the target engine in-process without model calls.
5. **Inspect Drill-Down**:
   - **Scenario Overview**: High-level pass/fail summary and scenario status.
   - **Milestone Assertions**: Expected vs. actual state, quantities, and credit accounting at every lifecycle milestone.
   - **Reproducible Sequence**: Exact sequence of scheduled operations.
   - **Trace & Observations**: Full execution trace and typed target delivery observations.
   - **Provenance**: Pinned brief revision, brief hash, contract hash, source hash, and evaluator identity.
6. **Reopen Saved Runs**: Historical baseline runs are saved under `runs/functional/` and listed in the history table. Click **Open** on any past run to reload and inspect historical evidence across server restarts.

## Scenario Catalog Scope

The catalog covers allowlisted deterministic synthetic trading scenarios:

1. **`trading-lifecycle-partial-fill-cancel`**:
   - Four units at price 10 reserve 40 credit.
   - Partial fill of 2 units consumes 20 credit and leaves 20 reserved.
   - Client cancellation request retains the 20 reservation (request alone does not release funds).
   - Venue cancellation confirmation releases the remaining 20 reservation and retains 20 used credit.
   - Explicit assertions evaluate order status (`OPEN`, `CANCELLED`), `remainingQuantity`, `filledQuantity`, `cancelledQuantity`, `cancellationRequested`, and credit allocations (`reservedCredit`, `usedCredit`) at each milestone.

2. **`trading-used-credit-admission-rejection`**:
   - Establishes 20 used credit against a 50 limit via a completed 2-unit fill.
   - A subsequent order for 4 units at price 10 (notional 40) requires total commitments of 60 (20 used + 40 requested), exceeding the 50 limit.
   - The order must be rejected with `Insufficient credit limit` without mutating credit balances or creating any order, including terminal orders, or changing the existing order book.
   - **Faulty Target Coverage**: Candidate `candidate-c` ignores used credit in its admission check (`reserved + notional <= limit`); this baseline catches that bug and reports a functional failure.

3. **`trading-initial-insufficient-credit`**:
   - An order for 40 notional against an initial credit limit of 30 is rejected at admission without mutating state.

## Result Meaning & Classification

Results are classified distinctly per assertion and scenario:

- **`pass`**: Every intended valid business event and explicit expected state was observed and matched. A pass is never inferred from missing data, absence of oracle violations, zero checks, or target rejection of a required action.
- **`fail`**: Observed target behavior contradicted expected baseline facts (e.g., target accepted an order that exceeded credit, or returned incorrect quantity/credit balances). Any oracle violations or failing requirement rules also mark the scenario as `fail`.
- **`inconclusive`**: Execution was incomplete, required milestone evidence was unreached or missing, or the target decoder threw an unhandled exception.
- **`invalid`**: The test harness command itself was rejected by the simulation harness (e.g., envelope not found in scheduler, clock advance error). An invalid harness command is never treated as an expected target business rejection.

## Evidence Storage & Provenance

- **Isolated Storage**: Functional records are persisted under `runs/functional/<id>/record.json` inside the configured `runsDir`. They never overwrite or mix with exploratory investigation runs (`runs/<id>.json`) or finding reports (`runs/reports/`).
- **Immutable Publication**: Runs are saved with unique IDs (`fnrun_<timestamp>_<random>`) using atomic publication of a completed nonempty run directory (temporary directory + rename; an existing completed directory cannot be replaced). Overwriting an existing run is prohibited.
- **Historical Integrity**: Historical records pin the brief snapshot, brief revision, content hash, source hash, and evaluator identity at time of execution. Subsequent edits to system briefs or target code leave historical records intact.

## Limitations

- **Synthetic-Trading Only**: Functional baselines currently support the `synthetic-trading` adapter. Profiles configured with `inventory-reservation` or `unconfigured` adapters are rejected with clear error messages.
- **No Arbitrary Scripts**: Baselines execute the allowlisted deterministic catalog; arbitrary client-supplied code or unvalidated experiment payloads are rejected by the server.
- **Prose Requirements**: Additional free-form English requirements in system briefs remain unverified context and are never claimed as verified by baselines.

## Selection and evidence integrity

The Functional tests view uses the same confirmed target selection as investigation preparation. Its choices come from the selected adapter's target response. Draft profiles, unsaved changes, a pending save, or unconfirmed contract/targets block execution. Launch uses the revision already held by the app; a concurrent saved edit produces a revision conflict instead of silently adopting the new brief. Changing profile, revision, adapter, or target invalidates pending view updates. Historical inspections show their own saved revision and target, independently of the current selection.

Every scenario pins its expected experiment, complete milestone expectations, executed source hash and target variant. The classifier checks every action and typed delivery against the sequence, message and trace index. Rejections must be valid client `new_order` deliveries and preserve the full order book and credit configuration. Missing or misbound evidence cannot pass. Evaluator identity hashes the evaluator implementation, catalog and configured-rule evaluator source. An unavailable configured-rule evaluator is visible as inconclusive; `not-exercised` rules remain explicitly unverified. A rule failure or oracle violation prevents a pass.

Open the provenance and complete scenario evidence sections for the pinned brief/contract, evaluator, source, timestamps, expected/actual assertion references, rejection evidence, oracle violations and configured-rule outcomes. Brief prose is context only.

Record loading verifies shape, snapshot/context consistency, summaries and classification against recorded evidence. These are consistency checks, not cryptographic tamper protection. Unsupported legacy evaluator records and malformed records are left untouched and excluded rather than reopened as passes. Records do not depend on the current saved brief or current target source when reopened. Directory publication provides atomic visibility and collision protection; it does not promise survival of a power loss. No browser journey is implied by unit or HTTP-handler validation.
