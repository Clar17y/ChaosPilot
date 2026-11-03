# Recovery backend interface

Session A owns the backend only. Session B owns coverage projection and UI.
The authoritative browser-safe raw observation schema is `src/recovery/types.ts`.
`ExperimentResult.recovery` is optional for legacy adapters and mandatory for
`synthetic-trading-recovery` results. It is `RecoveryEvidence` schema 1: evaluator
identity, horizonTick, executionComplete, aggregate status, idempotenceStatus,
ingress, obligations, retries. Statuses are passed, failed, not-exercised,
inconclusive and invalid. Ticks are simulated units.

Ingress records target acceptance (not scheduling), immutable report content,
transport messageId, disconnected/duplicate flags, tick, step and traceIndex.
Each obligation has key `[orderId, executionId]`, report, acceptedTick,
acceptanceTraceIndex, optional reconnectTick/deadlineTick/completionTick,
sticky deadlineMissed, checkedTick/checkTraceIndex, expected/observed order and
aggregate credit/application facts. Retry checks contain before/after facts.
The target application journal alone cannot establish success: the oracle also
checks actual order quantities and credit across all orders.

Adapter: `synthetic-trading-recovery`; saved seed: `trading-recovery`; targets:
`clean`, `recovery-candidate-a`. Existing endpoints publish these through
`GET /api/targets?adapterId=synthetic-trading-recovery` and system listing.
Launch with the saved systemId and matching revision through the existing
`POST /api/investigation/start` API. Run details contain raw `result.recovery`.
Selected and whole-run replay compare this evidence and evaluator identity.

Supported actions: send (market/credit/client/reports), duplicate, deliver,
advance (including zero), drain, fill, disconnect, reconnect. Deliver requires
an already due envelope. Drain moves to scheduled envelope times and also runs
internal work due along the way; an empty drain does not advance time. Advance
runs all internal work and deadlines crossed, in order. Send/fill/duplicate and
connection operations do not move time. Cancellations are unsupported in v1.
Repeated current connection state is a no-op; a second outage is invalid.
Deadline is reconnect + 5 inclusive, with due target work processed first.
Reconnect whose deadline exceeds maxTicks is invalid. Early stop/no reconnect
cannot prove a miss. Identical retry never resets a deadline.

Coverage plan persistence, launch intentions, public goal injection and projection
are integrated using `src/coverage` and `src/investigation/coverage-evidence.ts`.
The optional saved fields are `InvestigationRecord.coveragePlan` and
`ExperimentResult.scenarioCheckEvidence`; replay rebuilds checks from the pinned
plan. Coverage evaluator version 2 adds typed per-delivery retry before/after
facts and requires an explicitly valid raw recovery evaluator before deriving
coverage. Clock jumps preserve actual intermediate `recovery:deadline` trace
entries, including their tick and snapshot, after due target work. Baselines and
regression capture remain trading-only. Offline mock proposals are labelled
scripted and do not constitute AI discovery evidence.
