# ChaosPilot Fault Lab: Synthetic Trading Fault Library

## Overview

The ChaosPilot Fault Lab is an offline development and demonstration library containing 9 independently selectable realistic defect variants, designed to validate verification plumbing, invariant coverage, and catchability mechanics within the synthetic trading gateway simulator.

> [!IMPORTANT]
> The Fault Lab is an intentionally configured development and demonstration library, **not** a blind evaluation set or proof of autonomous discovery. Scripted reproductions in this library verify deterministic catchability under unchanged public invariants. Unbiased evaluation of autonomous agents requires a separate, held-out evaluation set not disclosed or present in training or demonstration fixtures.

---

## The 9 Known Fault Variants

The gateway architecture comprises three core business modules:
- `credit-manager.ts`: Manages credit limits, active exposure, reservations, and used credit balances.
- `decoder.ts`: Validates and decodes wire envelopes across channels (`market`, `credit`, `client`, `reports`).
- `order-engine.ts`: Manages active quotes, order lifecycles, execution matching, and cancellation reconciliation.

Each candidate variant incorporates exactly one isolated, credible mutation relative to the `clean` baseline:

| Variant | Affected Component | Mutation Summary | Public Invariant Caught |
| :--- | :--- | :--- | :--- |
| `candidate-a` | `OrderEngine` | Missing execution report deduplication on redelivery | `execution_idempotency` |
| `candidate-b` | `OrderEngine` | Cancellation acknowledgement over-releases remaining instead of cancelled quantity | `credit_non_negative` |
| `candidate-c` | `CreditManager` | Credit headroom check checks `reserved + notional` omitting `used` credit | `credit_limit_respected` |
| `candidate-d` | `OrderEngine` | Stale or repeated market quote versions overwrite active price | `version_monotonicity` |
| `candidate-e` | `CreditManager` | Stale or repeated credit-limit versions overwrite active credit limit | `version_monotonicity` |
| `candidate-f` | `CreditManager` | Cumulative used credit overwrites (`used = notional`) instead of accumulating on partial fills | `credit_exposure_consistency` |
| `candidate-g` | `OrderEngine` | Execution report with mismatched price accepted instead of rejected | `input_integrity_no_mutation` |
| `candidate-h` | `OrderEngine` | Conflicting content for an existing execution business ID acknowledged rather than rejected | `execution_idempotency` |
| `candidate-i` | `OrderEngine` | Partial fill prematurely transitions order status to `FILLED` | `lifecycle_consistency` |

### Detailed Variant Breakdown

#### 1. `candidate-a`: Redelivery Deduplication Failure
- **Root Cause**: Omits idempotency tracking for processed execution IDs.
- **Behavior**: Duplicate delivery of an identical execution report mutates state, deducting reservation and adding used credit a second time.
- **Public Invariant**: `execution_idempotency`.

#### 2. `candidate-b`: Out-of-Order Cancellation Over-Release
- **Root Cause**: Cancellation handler calculates released reservation as `order.remainingQuantity * order.price` rather than `cancelledQuantity * order.price`.
- **Behavior**: If an execution fill is in transit (delayed) when cancellation is acknowledged, reservation is prematurely drained to 0. When the fill arrives and converts reservation to used credit, `reservedCredit` becomes negative.
- **Public Invariant**: `credit_non_negative`.

#### 3. `candidate-c`: Credit Headroom Used-Credit Blindness
- **Root Cause**: `canReserve(notional)` checks `this.reserved + notional <= this.limit` instead of `this.reserved + this.used + notional <= this.limit`.
- **Behavior**: An order is accepted even when cumulative exposure (`reserved + used + notional`) exceeds the active credit limit.
- **Public Invariant**: `credit_limit_respected`.

#### 4. `candidate-d`: Market Quote Version Monotonicity Regression
- **Root Cause**: Quote handler in `order-engine.ts` omits version check `payload.version <= this.activeQuote.version`.
- **Behavior**: Market quotes with equal or regressing versions overwrite the active quote price.
- **Public Invariant**: `version_monotonicity`.

#### 5. `candidate-e`: Credit Limit Version Monotonicity Regression
- **Root Cause**: `updateLimit` in `credit-manager.ts` omits version check `newVersion <= this.version`.
- **Behavior**: Credit updates with equal or regressing versions overwrite the active credit limit.
- **Public Invariant**: `version_monotonicity`.

#### 6. `candidate-f`: Used Credit Overwrite on Split Fills
- **Root Cause**: `convertReserveToUsed(notional)` assigns `this.used = notional` instead of accumulating `this.used += notional`.
- **Behavior**: The first partial fill appears correct; a subsequent partial fill resets `usedCredit` to only the second fill's notional, creating a discrepancy with order-level filled valuations.
- **Public Invariant**: `credit_exposure_consistency`.

#### 7. `candidate-g`: Mismatched Execution Price Acceptance
- **Root Cause**: Omits price check `payload.price !== order.price` in execution processing.
- **Behavior**: Gateway accepts an execution report with a price conflicting with the locked order price.
- **Public Invariant**: `input_integrity_no_mutation`.

#### 8. `candidate-h`: Conflicting Execution Business ID Acknowledged
- **Root Cause**: Execution deduplication acknowledges existing execution IDs unconditionally (`return { accepted: true }`) without validating that quantity, price, and timestamp match the original record.
- **Behavior**: Conflicting duplicate reports are silently acknowledged instead of rejected.
- **Public Invariant**: `execution_idempotency`.

#### 9. `candidate-i`: Premature Order Terminal State on Partial Fill
- **Root Cause**: Order status unconditionally set to `'FILLED'` upon any execution fill.
- **Behavior**: A partial fill marks the order as `FILLED` while `remainingQuantity > 0`, violating order lifecycle consistency.
- **Public Invariant**: `lifecycle_consistency`.

---

## Offline Selection and Reproduction

### Selecting Variants

Variants are registered in `TARGET_VARIANTS` in `src/domain.ts` and can be selected:

1. **Programmatically**:
   ```ts
   import { executeExperiment } from './src/simulator/index.ts';
   import { getFaultCatalogEntry } from './src/testing/fault-catalog.ts';

   const entry = getFaultCatalogEntry('candidate-d')!;
   const result = executeExperiment(entry.knownExperiment, 'candidate-d');
   console.log('Violations:', result.violations);
   ```

2. **Via Test Suite**:
   ```bash
   npx vitest run --dir tests tests/fault-lab.test.ts
   ```

3. **Select a target for a scripted investigation**:
   ```bash
   npm run investigate -- --provider mock --target candidate-d
   ```

   This selects D for the normal investigation loop. The mock's fixed proposals do not promise to expose D. Use the known-recipe test above to reproduce every catalogued fault; use a live provider for a separate model-led investigation.

The saved [offline catchability matrix](../examples/fault-lab/README.md) records all nine known recipes, their exact replays and identical clean executions. It contains no model proposals or new discovery claims.

---

## Importance of Clean Contrast

Every reproduced defect in the Fault Lab is validated against an identical `clean` control execution:

1. **Semantic Equivalence**: The exact same sequence of experiment steps must execute against `clean`.
2. **Clean Controls**: The `clean` run must produce `valid: true`, 0 harness rejections, and 0 invariant violations. Business-message rejection can be the correct outcome for malformed or conflicting input.
3. **Causal Attribution**: Demonstrates that the violation observed in the candidate variant is strictly due to the planted mutation and not a flaw in test construction, message framing, or simulator scheduler mechanics.

---

## Boundaries and Limitations

1. **No Autonomous Discovery Claim**: All recipes and reproductions in this module are predetermined verification benchmarks designed to test catchability plumbing and invariant monitors.
2. **Liveness and Latency SLAs**: Real component outages, swallowed reports, and latency SLAs require dedicated protocol adapters and timeout contracts. Simulated tick delays alone do not emulate network partitioning or protocol heartbeat failures.
3. **Separate Held-Out Evaluation**: Models and automated discovery agents must be benchmarked on independent held-out variants that are not part of this library to prevent overfitting and data leakage.
