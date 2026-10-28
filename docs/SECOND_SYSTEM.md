# Second system: inventory reservation service

ChaosPilot has a second executable target alongside the synthetic trading
gateway: a deterministic inventory-reservation service. It exists so the
investigation engine, evidence and replay machinery can be exercised against a
different domain without changing trading behavior, identities or archived
evaluations.

- Adapter id: `inventory-reservation`
- Seeded saved system id: `inventory-reservation` (revision 1, seeded like the
  trading system on first read/listing in a systems store)
- Variants: `clean` (correct control), `inventory-candidate-a` (selectable
  faulty implementation that can over-reserve stock), `inventory-candidate-b`
  and `inventory-candidate-c` (single-fault variants for cancellation-release
  and duplicate-shipment behaviour respectively) and `inventory-candidate-d`
  (both of those faults). Variant identities are execution configuration only;
  they never appear in the model-visible source or prompt.
- Trading variants (`candidate-a` … `candidate-i`) and inventory variants are
  not interchangeable; cross-adapter launches fail before any provider call.

## Supported operations

Each experiment starts from a fresh, empty inventory. Bounded deterministic
actions: `send`, `deliver`, `duplicate`, `advance`, `drain` (at most 100
actions/messages, 1000 logical ticks). `send` channels are `stock`,
`reservations` and `shipments`. Actions or channels outside the selected
adapter (for example trading `fill`/`confirm_cancel`, or `market` channel)
make the plan invalid; a well-formed plan whose payload the target rejects is
still an executed, valid experiment with a recorded target rejection.

Messages (only listed fields; identifiers are trimmed strings of 1–64 chars;
quantities are positive safe integers up to 1,000,000):

| Channel | Type | Fields | Semantics |
|---|---|---|---|
| `stock` | `stock` | `id`, `sku`, `quantity` | Additive receipt; per-SKU received total ≤ 1,000,000 |
| `reservations` | `reserve` | `id`, `reservationId`, `sku`, `quantity` | New reservation; quantity ≤ on-hand minus remaining reservations for the SKU |
| `reservations` | `cancel` | `id`, `reservationId` | Releases all remaining quantity; requires remaining > 0 |
| `shipments` | `ship` | `id`, `reservationId`, `quantity` | Partial shipments allowed; consumes remaining reservation and on-hand stock |

Accepted event ids are global and idempotent: identical redelivery is a
no-op (`duplicate`), conflicting reuse is rejected. Rejected events do not
consume ids and never mutate business state, so a corrected or later-ordered
retry can succeed. Reservation ids cannot be reused, including after
completion or cancellation. Unknown, completed and cancelled references are
rejected. There is no wall clock, persistence, message loss or latency model;
delivery order is business order.

Findings are grouped by a deterministic category assigned by the independent
oracle from the observed event (for example `cancellation_release` or
`duplicate_shipment`), not by target labels or model text. Repeats of the same
category are grouped; different categories may share one broad invariant. A
continuing discrepancy keeps the category of the fault that introduced it:
each event is re-checked locally by replaying just that transition with the
reference reducer seeded from the target's own prior state, and only a
transition that is incorrect even from that state earns the current event's
category. The seeded reducer takes the target's actual `received`/`onHand`
and per-reservation `remaining`/`shipped`/`cancelled` verbatim — it never
re-derives on-hand from a conservation identity the corrupted state may
violate — so reservation admission and shipment are judged against the
balances the target actually had (including missing stock). A correct
follow-on that merely transforms already-corrupted state
(for example shipping an incorrectly admitted reservation, a correct
insufficient-on-hand shipment rejection after an over-reservation, or
cancelling after a duplicate shipment) is propagation, not a new finding; the full
global expected/actual divergence is still recorded as raw evidence. A
category is a finding attribution, not a root-cause claim. Confirmation is conservative per invariant:
if the valid, source-matching clean control violates the same invariant (in
any category), the candidate violation of that invariant is not confirmed.
Investigations stop at the first verified finding by default. The explicit
opt-in `--continue-after-findings` (CLI), `continueAfterFindings: true`
(API/UI checkbox) continues within the existing experiment/proposal bounds,
records `continueAfterFindings: true` on the run, and reports the actual stop
reason. Additional live proposals under this opt-in may cost more.

Checked invariants (independent oracle, separate from target code):

- `stock_conservation` — per SKU, `received = onHand + shipped` and
  `0 ≤ sum(remaining reservations) ≤ onHand`.
- `inventory_transition_consistency` — every target transition, outcome and
  accepted event identity matches an independent reference reducer, and per
  reservation `quantity = remaining + shipped + cancelled`.

## Offline walkthrough (CLI)

No live model calls are needed; the mock provider is a labelled scripted
offline sequence, not an AI discovery.

```powershell
npm run build
node dist/cli.js inventory-init --runs-dir <store>
node dist/cli.js investigate --provider mock --target inventory-candidate-a `
  --system-id inventory-reservation --runs-dir <store>
node dist/cli.js replay --runs-dir <store>
```

`inventory-init` is idempotent (the profile is also auto-seeded on first
read). The target defaults to `inventory-candidate-a` when an inventory
profile is selected; use `--target clean` for the control run, which yields no
findings. Trading investigations retain their `candidate-a` default.
`replay` defaults to the latest run in the store; pass `--id <runId>` to pick
one. `--systems-dir` overrides the default `<runs-dir>/systems` store.

## Offline walkthrough (HTTP API)

Start the server (`npm start`) and then, from the same machine:

- `GET /api/systems/inventory-reservation/snapshot` — saved system snapshot:
  brief (id, revision, adapter id), executable inventory contract and their
  combined hash. The UI validates all three against this response.
- `GET /api/targets?adapterId=inventory-reservation` → `["clean",
  "inventory-candidate-a", "inventory-candidate-b", "inventory-candidate-c",
  "inventory-candidate-d"]`; `GET /api/contract?adapterId=inventory-reservation`
  returns the inventory contract. Without `adapterId`, both keep returning the
  trading defaults. Unknown adapters are rejected. The desktop obtains its
  choices from this endpoint for the selected adapter. `GET /api/status` keeps
  its original trading `targetVariants` field and also reports
  `targetVariantsByAdapter` for adapter-aware clients.
- `POST /api/investigation/start` with
  `{"systemId":"inventory-reservation","variant":"inventory-candidate-a","provider":"mock"}`
  starts an offline run; poll `GET /api/status`, then read
  `GET /api/runs/<id>` and verify with `POST /api/runs/<id>/replay`.
- `POST /api/runs/<id>/experiments/<position>/replay` replays exactly one
  saved experiment (zero-based array position) through the same integrity
  and context gates, with no model or clean-comparison call. The
  reproduction player uses it for its per-experiment rerun and shows
  inventory findings with their recorded SKU/reservation evidence.

## Verification behavior

- Launch binds the saved system snapshot: snapshot hash, adapter, contract,
  source identity (target and clean control) and variant are recorded in the
  run audit. Unknown or unconfigured adapters and cross-adapter variants fail
  before a provider is constructed. Replay rejects internally inconsistent
  saved evidence, including a mismatched snapshot hash or contradictory audit.
- Findings require deterministic replay of the same plan on the same source
  plus a valid clean control with neither the same invariant nor the same
  observed category violated.
- Inventory runs record the inventory prompt identity
  (`inventory-1.0`), not the trading template. Trading prompt bytes, variant
  identities and archived evaluations are unchanged.
- Replay resolves the adapter from the saved system brief: inventory records
  replay through inventory; legacy records without a brief replay through
  trading. Replay never invokes a provider. It reports per-experiment results
  and context checks when the saved prompt, contract, or clean-control source
  differs from current code. For snapshot-backed records, drift or unverified
  context prevents an exact-reproduction claim. For legacy runs without a
  pinned brief, experiment results remain available and any recorded prompt
  and contract identities are checked where possible. The report identifies
  missing historical context, even when the experiments match.
- New contract hashes use canonical JSON, so property order does not affect
  their identity. Older raw-order hashes are accepted when verifiable; an
  irrecoverable historical ordering is marked unverified and cannot support an
  exact claim. Older inventory records with duplicate violation IDs can replay,
  but an ID mismatch is reported instead of being treated as exact.
- New inventory results carry a `categoryAware` marker. Category-insensitive
  replay comparison applies only to genuine legacy results (no marker and no
  recorded categories); on a category-aware result, removing or changing a
  violation category — or a saved finding whose category no longer matches its
  saved result violation — blocks an exact-reproduction claim. This is a
  consistency check, not cryptographic tamper resistance: evidence with the
  marker, categories and findings all removed is indistinguishable from legacy.

## Limitations

- `evaluate` and `benchmark` remain trading-only and say so; `--targets`
  accepts trading variants only.
- The mock inventory sequence is a fixed scripted fixture (partial
  shipment/cancellation, competing-reservations and duplicate-shipment probes,
  in that order). With `--continue-after-findings` and the normal budget, the
  combined candidate yields separately replay-verified `cancellation_release`
  and `duplicate_shipment` findings, each absent on clean. This is scripted
  offline provenance, not live discovery. The Meta provider path uses an
  inventory-specific prompt, but no live evaluation results are claimed here.
- Attribution is deliberately conservative within one experiment: when a
  second independent fault's local effect exactly coincides with the
  per-path discrepancy already carried from an earlier fault, it is grouped
  under the earlier category rather than split into a new finding. Distinct
  faults are separated when their locally incorrect transitions are
  observable (including both faults of the combined candidate in one
  experiment, and across continued experiments).
- There is no held-out set, freeze manifest or benchmark comparability story
  for inventory yet.
- The browser UI exposes the seeded inventory profile, its checks and
  inventory-specific state. It still runs only the local synthetic target;
  selecting this adapter does not connect an arbitrary application.
