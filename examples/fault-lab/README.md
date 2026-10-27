# Known fault catchability record

[`catchability.json`](catchability.json) is an offline record generated from the deliberately authored recipes in `src/testing/fault-catalog.ts`.

- Nine candidate variants have valid known reproductions and matching invariant violations.
- Each reproduction replays exactly against the same source identity.
- The identical experiment against `clean` has no invariant violations.
- Each candidate also has a normal control without violations.
- The original clean/A/B/C business source hashes remain unchanged from the published first cut.

No model calls were made. `aiDiscoveryEvidence` is explicitly `false`. This record tests the simulator/verifier and reproducibility plumbing; it is not autonomous discovery or a fresh comparison with a conventional baseline.

Run the executable catchability and boundary checks with:

```sh
npm run build
npx vitest run --dir tests tests/fault-lab.test.ts
```

See [the fault lab documentation](../../docs/FAULT_LAB.md) for the intended behaviors and known limitations. A future fair discovery comparison needs a separate held-out set.
