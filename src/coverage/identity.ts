import type { CoverageIdentity } from './types.ts';

/** SHA-256 of these literal semantic descriptors, not disk/source hashes. Bump on semantic changes. */
export const COVERAGE_CATALOG_DESCRIPTOR = 'chaospilot-coverage-catalog:v2:accepted-order-credit-limit@synthetic-trading;recovery-by-deadline,recovery-retry-idempotence@synthetic-trading-recovery;reviewed-unique-requirement-or-contract-links;retry-prefers-execution-idempotency';
export const COVERAGE_EVALUATOR_DESCRIPTOR = 'chaospilot-coverage-evaluator:v3:pinned-context;typed-trigger-and-trace;credit-admission-recorded-rule;target-accepted-recovery;deadline-reconnect-plus-five-inclusive;actual-order-credit-accounting;retry-observed;matching-saved-confirmed-finding;partial-run-preserves-intentions;explicit-known-raw-recovery-producer;retry-before-after-per-delivery;connected-retry-independent-expected-accounting';

export const COVERAGE_CATALOG: Readonly<CoverageIdentity> = Object.freeze({
  id: 'chaospilot-coverage-catalog', version: 2,
  hash: '0fa637210195b5716e5bab37489227c3986e320813abf23e40e54c023a9409e7',
});
export const COVERAGE_EVALUATOR: Readonly<CoverageIdentity> = Object.freeze({
  id: 'chaospilot-coverage-evaluator', version: 3,
  hash: 'ad1a75cab3d6dd2e4e0a1516c9dc7bdbfec97c5e11755713a1783bc45f17ace1',
});

export const RECOVERY_ADAPTER_ID = 'synthetic-trading-recovery';
export const RECOVERY_PROFILE_ID = 'trading-recovery';
