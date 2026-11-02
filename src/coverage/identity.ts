import type { CoverageIdentity } from './types.ts';

/** SHA-256 of these literal semantic descriptors, not disk/source hashes. Bump on semantic changes. */
export const COVERAGE_CATALOG_DESCRIPTOR = 'chaospilot-coverage-catalog:v1:accepted-order-credit-limit@synthetic-trading;recovery-by-deadline,recovery-retry-idempotence@synthetic-trading-recovery;reviewed-unique-requirement-or-contract-links';
export const COVERAGE_EVALUATOR_DESCRIPTOR = 'chaospilot-coverage-evaluator:v2:pinned-context;typed-trigger-and-trace;credit-admission-recorded-rule;target-accepted-recovery;deadline-reconnect-plus-five-inclusive;actual-order-credit-accounting;retry-observed;matching-saved-confirmed-finding;partial-run-preserves-intentions;explicit-known-raw-recovery-producer;retry-before-after-per-delivery';

export const COVERAGE_CATALOG: Readonly<CoverageIdentity> = Object.freeze({
  id: 'chaospilot-coverage-catalog', version: 1,
  hash: '9e446f3c4331a23e79c0b4ca44fffca772125936e23714bd30ecd4ae9f01e936',
});
export const COVERAGE_EVALUATOR: Readonly<CoverageIdentity> = Object.freeze({
  id: 'chaospilot-coverage-evaluator', version: 2,
  hash: 'b131832deb18eda7bb6c3e72316e38300bd0d1121952a7eca69a7b4fad0d5982',
});

export const RECOVERY_ADAPTER_ID = 'synthetic-trading-recovery';
export const RECOVERY_PROFILE_ID = 'trading-recovery';
