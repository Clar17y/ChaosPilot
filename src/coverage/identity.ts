import type { CoverageIdentity } from './types.ts';

/** SHA-256 of these literal semantic descriptors, not disk/source hashes. Bump on semantic changes. */
export const COVERAGE_CATALOG_DESCRIPTOR = 'chaospilot-coverage-catalog:v1:accepted-order-credit-limit@synthetic-trading;recovery-by-deadline,recovery-retry-idempotence@synthetic-trading-recovery;reviewed-unique-requirement-or-contract-links';
export const COVERAGE_EVALUATOR_DESCRIPTOR = 'chaospilot-coverage-evaluator:v1:pinned-context;typed-trigger-and-trace;credit-admission-recorded-rule;target-accepted-recovery;deadline-reconnect-plus-five-inclusive;actual-order-credit-accounting;retry-observed;matching-saved-confirmed-finding;partial-run-preserves-intentions';

export const COVERAGE_CATALOG: Readonly<CoverageIdentity> = Object.freeze({
  id: 'chaospilot-coverage-catalog', version: 1,
  hash: '9e446f3c4331a23e79c0b4ca44fffca772125936e23714bd30ecd4ae9f01e936',
});
export const COVERAGE_EVALUATOR: Readonly<CoverageIdentity> = Object.freeze({
  id: 'chaospilot-coverage-evaluator', version: 1,
  hash: '16379172f25e7b112e2c5d4892a71b4a588362ceeea0200a8b9f7c2ff2f49d6a',
});

export const RECOVERY_ADAPTER_ID = 'synthetic-trading-recovery';
export const RECOVERY_PROFILE_ID = 'trading-recovery';
