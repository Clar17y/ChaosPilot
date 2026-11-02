# Muse review of recovery and coverage

The user-requested ask-muse review examined `6b133ce` against `35b444a` on
2 November 2026 using `muse-wonder-full-1.0` at medium effort. It was read-only;
the reviewer ran no tests and changed no source. Matching Jev preparation was
reused, with its existing partial-coverage limits preserved.

Four findings were substantiated against the owning code and assigned as one
repair batch:

| Finding | Required correction |
| --- | --- |
| Oracle trusts target duplicate/report metadata | Bind accepted reports to delivered business content and independent history; a target cannot erase or rewrite an obligation through its return values. |
| Connected retries receive no coverage | Record genuine connected retry checks and independent accounting without inventing a recovery obligation or reconnect deadline. |
| Source identity omits engine-selection shim | Include or validate the executing binding under neutral public source paths; reject an unsupported redirection rather than claim identical source. |
| Later exception relabels completed recovery | Preserve warranted per-obligation completion while reporting the overall run failed/incomplete and retaining pending, missed or mutated failures. |

The repair scope includes adjacent acceptance-control metadata and normal,
conflicting, offline, pending, completed and terminal retry combinations. Legacy
trading/inventory engines, cancellation support and general requirement
verification remain outside this change. New evaluator/catalog semantics must
carry updated identities so old evidence is not silently reinterpreted.

The review also offered three suggestions. The partial `/api/status` adapter
summary is not used by the scoped workspace target selector; the permissive raw
evaluator helper is guarded by explicit identity checks at current call sites;
and row-priority aggregation retains its per-check evidence. These were not
substantiated defects and are not expanded into unrelated changes.

All four findings are repaired. Accepted ingress now uses the delivered payload,
the oracle's own identity history and the executor's link state. Target-returned
metadata cannot erase an obligation or change its quantities/business identity.
A rejected conflicting delivery may echo its existing report as diagnostic data;
the primary added a regression that failed before limiting the consistency
guard to accepted deliveries.

Connected retries now carry independent expected accounting and real before/after
facts, without a fabricated outage or deadline. Reviewed links prefer the actual
`execution_idempotency` rule. The business shim is included under neutral source
paths after exact supported-binding validation; unsupported redirects are
rejected on hot access and fresh import. Completed obligations survive unrelated
later exceptions while aggregate failure and genuine pending/mutated failures
remain visible. Raw recovery evaluator v2, coverage evaluator v3 and catalog v2
identify the new semantics; earlier incompatible evidence is not reinterpreted.

Host validation for checkpoint `f15f862` on 2 November 2026:

- `npm run typecheck`: both configurations passed.
- `npm test -- --maxWorkers=4`: build and **73 files / 1,294 tests passed**, with
  no failures or skips.
- Actual compiled HTTP: faulty deadline finding confirmed, clean recovery/retry
  exercised, saved plan/checks echoed and persisted, and whole/selected exact
  replay passed. All 26 workspace/coverage modules served; server-only modules
  stayed unavailable.
- Connected-retry HTTP flow: no recovery obligation or invented reconnect /
  deadline, retry exercised, deadline intention planned, and whole/selected exact
  replay passed.
- Compiled mock CLI: faulty target produced a reproduced clean-confirmed finding;
  clean completed with no findings. No runtime model requests or token cost.

The executed regression cases cover first-delivery duplicate lies (including
suppressed work), quantity/execution-identity substitutions, omitted optional
metadata, distinct transport ids, rejected diagnostic echoes, forged target
connection state, connected pass/mutation with finding gates, pending offline
retries, fresh/hot compiled source-binding redirects, and completed/pending /
subsequently mutated obligations around a later exception. Returned price/time
substitution guards and the sticky-miss priority over a later exception were
also inspected directly; those exact additional combinations were not separate
test cases. Existing exact-deadline and late-completion regression checks passed.

Muse's implementation patch and completed check results were preserved when its
reporting stalled. Primary confirmed the writer stopped, inspected the complete
repair delta, added the diagnostic-echo regression/guard, checked fixture cleanup
paths, and ran the final host checks. The child test attempt had environment
failures (including loopback hook timeouts); the passing host results supersede
them. No second independent review was added after the adjudicated repairs.

The bound Jev preparation is retained with its actual coverage limits. Browser
visual acceptance remains unproved because automation is disabled; live-model
execution remains unauthorised. Raw review output, cessation records, before-fix
regression failure, test JSON/log and HTTP/CLI evidence remain locally under
`.llm-output/`; review claims themselves are not test evidence. These results
describe `f15f862` before its later integration and publication. The PR
description records the current integration and simplification validation.
