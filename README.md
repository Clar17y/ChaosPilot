# ChaosPilot

An investigation workbench for negative scenarios in event-driven software. ChaosPilot reads a target's source and behavioural contract, proposes experiments, executes them against fresh deterministic instances, and verifies reproducible failures.

Built from scratch for the Meta Global AI Developer Hackathon, 26 October–4 November 2026. The current target is a synthetic trading system covering prices, credit reservations, orders, partial fills and cancellation.

**A scripted mock is included for offline development. Its results are not evidence of autonomous AI defect discovery.** Live investigations require a separately configured Meta Model API key. A Muse Code subscription does not provide application API credentials.

## Quick start

Requires Node.js 24 or later and npm.

```sh
npm ci
npm run dev
```

Open [http://127.0.0.1:4310](http://127.0.0.1:4310). Start with the explicitly labelled mock provider to inspect the workflow without making any model requests.

The application runs locally. No database, containers, authentication service or external messaging installation is needed.

## Live Meta configuration

Copy `.env.example` to `.env` and set `MODEL_API_KEY` locally. Do not put credentials in browser fields, exported experiments, Git or chat. The server reads configuration; the browser does not receive the key.

`META_MODEL` selects `muse-wonder-1.0` or `muse-spark-1.3`. The mock is deterministic; live model proposals need not be deterministic. Simulator replay is deterministic in both modes.

The default request deadline is 90 seconds, configurable with `CHAOSPILOT_REQUEST_TIMEOUT_MS` up to 120 seconds. Input, output and spending allowances are configured in `.env.example`. A timeout can still incur remote usage; a zero reported token count is not evidence of a free request. The ledger keeps a conservative charge when actual usage is unknown.

`META_REASONING_EFFORT` defaults to `low`. Meta includes private reasoning in the output-token allowance, so even a valid request can finish before producing complete experiment JSON. Truncation triggers bounded correction attempts and can exhaust an investigation's proposal budget. Configuration is recorded in new live artifacts. [Meta reasoning documentation](https://dev.meta.ai/docs/reasoning)

Meta's account spending alert is **not a hard billing cap**. Check your remaining promotional credit before live batches. ChaosPilot's conservative application allowance is separate from account-wide usage, and cannot control requests from other tools or keys. Missing credentials or an exhausted application allowance must stop requests rather than switch billing or providers.

Official references: [Meta models](https://dev.meta.ai/docs/models), [structured output](https://dev.meta.ai/docs/cookbook/structured-output), [spending alerts](https://dev.meta.ai/help/billing/spend-limit-alert).

## Commands

```sh
npm run demo
npm run investigate -- --provider mock --target candidate-a
npm run investigate -- --provider meta --target candidate-a --max-experiments 6
npm run evaluate -- --provider mock --trials 3 --seeds 1001,1002,1003 --max-experiments 6
npm run benchmark -- --provider mock --targets clean,candidate-a,candidate-b --trials 2 --max-experiments 3
npm run freeze-benchmark -- --freeze runs/benchmarks/freeze.json
npm run benchmark -- --provider meta --models muse-wonder-1.0,muse-spark-1.3 --targets clean,candidate-a,candidate-b --trials 2 --seeds 1001,1002 --max-experiments 3 --freeze runs/benchmarks/freeze.json
npm run replay -- <run-id>
npm run typecheck
npm test
npm run build
```

`demo` uses the scripted mock and is an offline plumbing demonstration. Evaluation with `--provider mock` is also offline validation. Use `--provider meta` for live evaluation after checking credentials and credit. Saved investigations and evaluation artifacts live under the ignored `runs/` directory.

The investigation, evaluation and replay commands build first and use the same compiled target as the browser application. Replay identifies a saved run by the ID printed at the end of investigation.

`benchmark` records the conventional generator and each model arm separately under `runs/benchmarks/`. Both live models receive the same specialised initial investigation prompt; exact hashes check parity. Rejected proposals consume the call allowance and remain inspectable. The [controlled evaluation protocol](docs/CONTROLLED_EVALUATION.md) freezes the prompt and baseline before authoring a held-out target. Human timing is unmeasured for this batch. In the application, the Proposals tab exposes prepared requests, visible responses, errors and reported usage; older runs with no proposal audit are labelled explicitly.

## Recorded live evidence

Wonder generated reproducible experiments exposing both deliberate defects. The initial six-trial comparison found a defect in **4/6 model trials and 4/6 conventional-generator trials**. Both failed Meta trials remain in the report. Fewer executed model experiments in this small sample do **not** establish engineer-time savings or general superiority.

See [authentic artifacts and reproduction instructions](examples/README.md) and the [evaluation record](docs/EVALUATION.md). The initial comparison used a 30-second request deadline; the current configurable default was increased after observing timeouts. Saved-run replay remains independent of model latency.

The completed clean-target follow-up executed two model-generated experiments with no invariant violations; repeated truncation consumed another proposal slot. This is limited evidence, not proof of correctness.

The subsequent frozen prompt 2.0 batch gave both models findings in **2/2 trials on a new synthetic target**, using one experiment each, while the unchanged conventional generator found it in **0/2 trials** within three experiments each. All 41 recorded experiments replayed identically. Total reported estimated API cost was **$0.953607**. Human timing was unmeasured, and fixture-author blinding was partial. See [controlled results and limitations](docs/CONTROLLED_RESULTS.md) and [the complete authentic reports](examples/controlled-v2/README.md). Automated validation currently passes **293 tests**, the TypeScript check and production build.

Targets are `clean`, `candidate-a`, `candidate-b` and `candidate-c`. Candidate identities are evaluation configuration, not model instructions. The investigator receives the selected implementation as ordinary source, without another variant, the answer key or known reproductions. Default calibration excludes C; select it explicitly for replication.

## What an experiment can do

The model constructs structured action sequences. It can publish market and credit messages, submit and cancel orders, cause simulated venue fills or cancellation confirmations, inject raw JSON, duplicate messages, choose delivery order and advance logical time.

The experiment envelope is validated independently of its message payloads. Intentionally malformed payloads must reach the target decoder. An invalid experiment action is recorded as a rejected experiment; it is not automatically a target defect.

Every experiment starts fresh. Results contain a message trace, business state, rejected actions and deterministic invariant violations. Findings are confirmed by replay and checked against a clean control. Exhausting the experiment budget does not prove the target correct.

## Trading contract

- One client account and one instrument, with bounded integer quantities and prices.
- Orders lock their accepted quote. Later quotes affect future admissions.
- Acceptance reserves quote notional. A fill converts reservation to used credit.
- Cancellation releases only the explicitly confirmed cancelled quantity.
- A venue fill occurring before cancellation remains valid when its report is delivered later.
- Credit reductions govern new admissions, without invalidating earlier commitments.
- Newer business versions supersede older price and credit updates.
- Malformed or prohibited messages follow explicit rejection rules without unintended business mutation.

Fabricated messages are assessed against observable consistency rules. The target cannot identify an otherwise indistinguishable lie merely because the test harness invented it.

## Scope and limitations

This is a source-aware synthetic research prototype. It does not establish effectiveness on production trading systems, provide real FIX/Solace/RV/Kafka adapters, or test network outages, latency limits, settlement or eventual completion.

The intended benefit is reduced scenario-authoring effort. That remains an evaluation question: a conventional generator may find some or all faults just as effectively. Reports must preserve unsuccessful runs and distinguish verified findings from hypotheses. A saved live investigation can be inspected and replayed without another model call; replay is not a new live discovery.

See [architecture](docs/ARCHITECTURE.md), [evaluation methodology](docs/EVALUATION.md), [decisions](docs/DECISIONS.md) and [hackathon contributions](docs/CONTRIBUTIONS.md).
