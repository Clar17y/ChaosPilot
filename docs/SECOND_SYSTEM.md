# Second system: inventory reservation service

ChaosPilot has a second executable target alongside the synthetic trading
gateway: a deterministic inventory-reservation service. It exists so the
investigation engine, evidence and replay machinery can be exercised against a
different domain without changing trading behavior, identities or archived
evaluations.

- Adapter id: `inventory-reservation`
- Seeded saved system id: `inventory-reservation` (revision 1, seeded like the
  trading system on first read/listing in a systems store)
- Variants: `clean` (correct control) and `inventory-candidate-a` (selectable
  faulty implementation that can over-reserve stock)
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
  "inventory-candidate-a"]`; `GET /api/contract?adapterId=inventory-reservation`
  returns the inventory contract. Without `adapterId`, both keep returning the
  trading defaults. Unknown adapters are rejected. The desktop obtains its
  choices from this endpoint for the selected adapter. `GET /api/status` keeps
  its original trading `targetVariants` field and also reports
  `targetVariantsByAdapter` for adapter-aware clients.
- `POST /api/investigation/start` with
  `{"systemId":"inventory-reservation","variant":"inventory-candidate-a","provider":"mock"}`
  starts an offline run; poll `GET /api/status`, then read
  `GET /api/runs/<id>` and verify with `POST /api/runs/<id>/replay`.

## Verification behavior

- Launch binds the saved system snapshot: snapshot hash, adapter, contract,
  source identity (target and clean control) and variant are recorded in the
  run audit. Unknown or unconfigured adapters and cross-adapter variants fail
  before a provider is constructed. Replay rejects internally inconsistent
  saved evidence, including a mismatched snapshot hash or contradictory audit.
- Findings require deterministic replay of the same plan on the same source
  plus a passing clean control (no violation on `clean`).
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

## Limitations

- `evaluate` and `benchmark` remain trading-only and say so; `--targets`
  accepts trading variants only.
- The mock inventory sequence is a fixed scripted fixture (baseline plus a
  competing-reservations probe). The Meta provider path uses an
  inventory-specific prompt, but no live evaluation results are claimed here.
- One faulty variant exists (`inventory-candidate-a`); there is no held-out
  set, freeze manifest or benchmark comparability story for inventory yet.
- The browser UI exposes the seeded inventory profile, its checks and
  inventory-specific state. It still runs only the local synthetic target;
  selecting this adapter does not connect an arbitrary application.
