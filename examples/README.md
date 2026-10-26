# Authentic live evidence

These files are actual Meta API records from 26 October 2026, not scripted mock outputs. All data is synthetic. They contain no API credentials.

| File | Provenance and interpretation |
| --- | --- |
| [Candidate A comparison](eval_1793047946203_58ud3o.json) | Wonder 2/3 successful trials; baseline 1/3. Includes the unsuccessful request. |
| [Candidate B comparison](eval_1793048143474_xytdkq.json) | Wonder 2/3 successful trials; baseline 3/3. Includes the unsuccessful request. |
| [Successful A investigation](inv-1793047894609-b1b3e9ba.json) | One model-generated duplicate-execution experiment, deterministic replay, corresponding clean checks passed. |
| [Browser-launched B investigation](run_1793047957260_gwcd0j.json) | One model-generated partial cancellation experiment exposed incorrect credit release. Exact replay was also verified through the app. |
| [Failed Wonder clean investigation](run_1793048243960_7lhgpg.json) | Timed out before executing an experiment; not a clean pass. |
| [Failed Spark clean investigation](run_1793048381260_8kz6ne.json) | Output truncation followed by timeout; no executed experiment and no clean-pass claim. |
| [Cancelled larger-output probe](run_1793048740132_0sgs2p.json) | Three truncated Wonder proposals, zero executed experiments; manually stopped with local process cessation verified and unknown usage retained. |
| [Completed low-effort clean investigation](run_1793049060762_nocmcm.json) | Two valid executed experiments, zero violations; another proposal slot exhausted through truncation. Configuration and error are recorded. |
| [Final browser A smoke check](run_1793049596825_q99sgy.json) | Current low-effort configuration found the duplicate-execution defect in one experiment; exact browser replay and clean checks passed. Separate from the comparative batch. |
| [Final browser stop check](run_1793049626529_pg0xsv.json) | In-flight clean investigation cancelled through the Stop button; zero experiments dispatched and unknown usage retained conservatively. |

The comparative batch used `muse-wonder-1.0`, temperature 0.2, max output 4096, max request bytes 32768, deadline 30000 ms, three trials per variant and at most six experiments per trial. Baseline seeds were 1001/1002/1003. The current deadline default was increased afterward; failed trials have not been replaced. See [methodology and limitations](../docs/EVALUATION.md).

To replay a bundled investigation, copy its JSON into `runs/` keeping its filename, then run:

```sh
npm run replay -- run_1793047957260_gwcd0j
```

No API key or model invocation is needed for replay. Run `npm ci` first on a fresh checkout. The command builds the pinned sources; a changed business-source hash or a changed semantic result prevents an exact-reproduction claim.

Business-source hashes used by these records:

- A: `cc692a33733ab368dcf75c374495405ce52cb99ff5d7fb4c9ffbd646a03dafb0`
- B: `d68dd726a8eba0ccbb7ff8795f95bda003ca93e1d29e6079d8418c7ecdae5b35`
- Clean: `7080524ace4dd8cfaa6bb7bebd2aec4afe195e9c54790b51416070692b7013d0`

These identify the selected ordinary business modules, not an answer key or a guarantee of whole-system correctness. The full trace remains evidence; a model hypothesis alone is not a finding.
