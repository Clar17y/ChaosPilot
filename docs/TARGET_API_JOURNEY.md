# Scripted Target HTTP API Journey

## Overview

ChaosPilot includes an isolated, real loopback HTTP target API test mode for synthetic trading. It exercises genuine HTTP networking on ephemeral `127.0.0.1` ports with asynchronous order and execution queueing, independent business accounting assertions, sealed evidence storage, and semantic rerun comparison.

The feature makes **zero AI model calls** and does not alter the existing synchronous deterministic simulator or adapter interfaces (`AdapterRegistration.executeExperiment` and `SimulatorApi`).

## Architecture and Design

```
+-------------------------------------------------------------------------------+
| ChaosPilot Client / Workspace UI / CLI Driver                                |
+-------------------------------------------------------------------------------+
       |
       | HTTP (ephemeral 127.0.0.1 port, agent: false, Connection: close)
       v
+-------------------------------------------------------------------------------+
| Isolated Target API HTTP Listener (src/target-api/target.ts)                  |
| - Authority: 127.0.0.1:<ephemeral-port> (strict Host, Origin, Sec-Fetch-Site) |
| - Endpoints: POST /setup, POST /orders, POST /executions                      |
|              GET /state, GET /events, GET /orders/:id                         |
+-------------------------------------------------------------------------------+
       |
       | 202 Accepted + Transport Receipt { instanceId, receiptId, sequence }
       | (Transport acknowledgement ALWAYS precedes asynchronous processing)
       v
+-------------------------------------------------------------------------------+
| Asynchronous Bounded Ordered Queue                                            |
| - Configurable processing delay seam (processingDelayMs)                      |
| - Bounded history folding preserves legacy simulator/adapter identities       |
+-------------------------------------------------------------------------------+
       |
       v
+-------------------------------------------------------------------------------+
| Target Engine & Public Trading Oracle (src/simulator/oracle.ts)               |
| - Independent business status: OPEN, PARTIALLY_FILLED, FILLED, CANCELLED      |
| - Credit manager accounting: reservedCredit, usedCredit                       |
| - Venue execution integrity & duplicate execution idempotence                 |
+-------------------------------------------------------------------------------+
```

### Truthful Transport Acknowledgement

HTTP receipts are explicitly distinct from eventual business acceptance:
1. When a client POSTs `/setup`, `/orders`, or `/executions`, the target validates the HTTP request bounds (body <= 4096 bytes, valid JSON, known fields, safe integer limits, command count <= 32).
2. It returns `HTTP 202 Accepted` with a correlated `Receipt` `{ instanceId, receiptId, requestId, sequence, status: 'queued' }`.
3. The command is enqueued for asynchronous worker processing.
4. Business acceptance or rejection occurs subsequently during scheduled processing and is observed via `/events`, `/state`, and `/orders/:id`.
5. **HTTP acknowledgements alone never pass a business check.** If wire observations are missing or incomplete, the journey is classified as `inconclusive`, never `pass`.

### Bounded Scenario Catalog

Three reviewed journeys cover core business milestones:
1. `order-lifecycle`: Accepted valid order through partial fill and complete fill. Verifies order quantities, credit reservation transition to used credit, and final `FILLED` status.
2. `credit-rejection`: Used-credit rejection without business state mutation. Setup limit 50, order 2 (20 reserved), fill 2 (20 used), then order 4 (40 notional) rejected for insufficient credit limit. Verifies that rejected commands leave business state strictly unchanged.
3. `execution-retry`: Identical execution retries before and after reconciliation, followed by conflicting execution report. Verifies exactly-once execution application without double-counting filled quantity or used credit, and rejects conflicting report.

### Fault Variant Verification

The journey evaluator validates clean reference behavior while detecting flaws in candidate variants:
- **`clean`**: Passes all 3 catalog journeys and all assertions.
- **`candidate-a` (duplicate execution defect)**: Fails journey 3 (`execution-retry`) because duplicate execution reports trigger state mutations, caught by the independent oracle invariants `venue_execution_integrity` and `execution_idempotency`.
- **`candidate-c` (used credit admission defect)**: Fails journey 2 (`credit-rejection`) because used credit is erroneously ignored, admitting an order that exceeds the credit limit and triggering `credit_limit_respected`.
- **Honest no-failure results**: Unexercised journeys on faulty variants pass honestly without false positives.

### Resource Lifecycle and Cancellation

Every target listener, socket, queued task, and timer settles deterministically:
- Ephemeral ports on `127.0.0.1` are bound per run and destroyed upon completion or failure.
- Optional `AbortSignal` at the runner boundary supports pre-aborted cancellation and in-flight abort.
- `targetHandle.close()` settles all sockets, clears active timers, empties queues, and marks diagnostics `closed: true`.
- Concurrent journey runs execute on isolated instances with separate UUID instance IDs and ports, preventing state leakage.

### Evidence Provenance and Rerun Comparison

Every execution saves an immutable versioned record under `runs/api-journeys/<id>/record.json`:
- Schema version 1, type `'scripted-target-api'`, sealed with a SHA-256 integrity digest.
- Pinned system brief snapshot, revision, target variant, and source bundle hash.
- Pinned transport and evaluator hashes (`transportIdentity`, `evaluatorIdentity`).
- Full correlated exchanges (request, response, elapsed time) and wire observations.
- Reopen is strictly read-only and requires zero model or code execution.
- **Semantic Rerun Comparison**: Compares business state, assertion outcomes, and protocol invariants across separate executions. Ephemeral ports, network timing, and UUIDs vary per run and are explicitly disclosed rather than claiming byte-for-byte network replay. Tampered integrity or mismatched profiles/variants produce a `BLOCKED` status.

## Usage

### CLI

Execute journeys against clean or faulty variants:

```sh
# Clean variant (passes all journeys)
npm run api-journey -- --target clean

# Candidate variant (catches duplicate execution flaw)
npm run api-journey -- --target candidate-a

# Candidate variant (catches over-credit flaw)
npm run api-journey -- --target candidate-c

# Rerun and compare against a previously saved run
npm run api-journey -- --target clean --compare apij_e7249f66-df3d-4614-b9dc-1b3e3bdbfa15
```

### UI Workspace

1. Open ChaosPilot at `http://127.0.0.1:4310/workspace`.
2. Select a saved `synthetic-trading` system profile (e.g. `trading-gateway`).
3. Click **Functional tests** in the navigation rail.
4. Scroll to the **Target API journeys** panel.
5. Select a target variant and click **Run API journeys**.
6. View real-time results, assertion breakdown, and correlated HTTP traffic.
7. Click **Rerun & Compare** to re-execute against the opened run and inspect semantic differences.
8. Reopen prior runs from the scoped history list.

### Evidence validation and publication

Storage validates terminal timestamps, the complete nested wire-evidence shape, unique catalog journeys,
pinned brief/contract/evaluator structure, recomputed snapshot and contract digests, and aggregate status.
Current compatible completed records are independently re-evaluated from their actual HTTP evidence;
stored assertions must agree exactly. Cancelled and incomplete terminal evidence remains reopenable,
but cannot produce a semantic match. Historical evaluator or transport identities remain unchanged and
read-only loadable; comparison blocks when that implementation is unavailable.

Comparison validates every poll, receipt/event binding, command sequence, checkpoint and logical
execution horizon before projecting the full nonpoll protocol and business results. It normalizes only
loopback ports, generated instance/receipt/event bindings, request elapsed time and valid poll cadence.
Request, message, order and execution identities remain significant. Equal failed runs can reproduce a
failure; only equal complete passing runs claim verified invariants.

Saving captures serialized bytes before asynchronous work, writes a private same-directory temporary
file, closes it, and publishes its completed inode with an exclusive hard link. Readers see absence or
a complete record. An existing record always wins, and an unsupported filesystem fails safely without
copy/rename fallback. Temporary cleanup never removes the published record. The SHA-256 seal detects
accidental changes; it is not a signature against someone who can modify and reseal local evidence.

Cancellation preserves completed journey evidence and explicitly marks every remaining catalog entry
cancelled without opening another listener. Cancellation during final cleanup after all catalog work
completed preserves the completed outcome. Incomplete/cancelled records retain malformed raw wire
responses for inspection; unsafe responses are never promoted to typed business observations.
