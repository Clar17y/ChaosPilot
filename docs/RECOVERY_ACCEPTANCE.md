# Recovery and reviewed coverage acceptance

Implemented on `codex/recovery-coverage` in
`C:/dev/ChaosPilot-worktrees/recovery-coverage`, based on `35b444a`, with the
parallel coverage commits `56f3729` and `f5a2730` integrated. Main was preserved.

The opt-in `trading-recovery` profile executes `synthetic-trading-recovery`.
Only target-accepted disconnected reports create independent obligations. Clean
reconciles next tick; the candidate loses its backlog. The deadline is reconnect
+ 5 inclusive, with due target work first and a sticky miss. Tests check actual
order quantities, application counts and aggregate account credit across orders.

Reviewed coverage plans are validated against saved revision/source/contract
before provider construction and published before the first proposal. Fresh
execution records checks; reopening is read-only. Whole/selected replay rebuilds
checks from the pinned plan. The model receives public goals and links, with
private plan context removed from history. Coverage evaluator v2 retains actual
retry before/after facts and requires explicit raw evaluator provenance.

Validation on 2 November 2026:

- `npm run typecheck`: both configurations passed.
- `npm test -- --maxWorkers=4`: build and **72 files / 1,281 tests passed**.
- Focused kernel/coverage/integration repair checks: **38 passed**.
- Real loopback HTTP: preparation, launch echo, persisted plan/checks, confirmed
  faulty deadline, planned untried retry, exercised clean deadline/retry, and
  exact whole/selected replay passed. All 26 workspace/coverage modules served;
  server-only module requests returned 404.
- Compiled mock CLI: faulty target yielded one replay-verified, clean-confirmed
  finding; clean target completed two experiments with no findings. Zero tokens
  and model cost.
- Deterministic challenge preflight/classification: real candidate/replay/clean
  accepted; missing clean obligation and pre-aborted signal rejected. No model
  transport was invoked.
- `git diff --cached --check`: passed before commit.

One independent Sol-medium review used the same provider as the integration
author after the preferred route failed. Its three findings were repaired as one
batch: actual intermediate deadline traces, failed retry mapping and invariant
matching, and explicit raw producer identity. Primary inspected the repair delta
and exercised large advance/drain, offline and pre/post reconciliation mutations,
missing/contradictory facts, and unknown producer controls. Jev preparation was
refreshed for the repaired diff; its coverage remains partial due to hunk,
operation and context limits. Review output is not test evidence.

An initial unrestricted parallel suite run passed 1,272 tests and failed the
existing child-process budget-ledger contention test. That exact test passed in
isolation; subsequent full runs with four workers passed. Budget code was not
changed.

Remaining limits: local browser automation is disabled in Work settings, so
desktop/narrow/keyboard visual acceptance is unproved. Production fake-DOM and
HTTP checks passed. Runtime Meta execution/spending remains unauthorised;
scripted mock results are not AI discovery evidence. Recovery supports one
outage and excludes cancellation, external brokers, general English verification,
cross-run aggregation, and recovery functional-baseline/regression execution.

Detailed host evidence is retained in the worktree's ignored `.llm-output/`,
including `recovery-implementation-record.json`, the full test JSON/log, HTTP and
challenge smoke evidence, and the bound Jev/independent review artifacts. These
local logs are not published with the branch.
