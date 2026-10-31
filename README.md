# ChaosPilot

An investigation workbench for negative scenarios in event-driven software. ChaosPilot reads a target's source and behavioural contract, proposes experiments, executes them against fresh deterministic instances, and verifies reproducible failures.

Built from scratch for the Meta Global AI Developer Hackathon, 26 October–4 November 2026. The executable synthetic targets are a trading system covering prices, credit reservations, orders, partial fills and cancellation, and an inventory-reservation system covering stock, reservations, shipments and cancellation.

**A scripted mock is included for offline development. Its results are not evidence of autonomous AI defect discovery.** Live investigations require a separately configured Meta Model API key. A Muse Code subscription does not provide application API credentials.

## Quick start

Requires Node.js 24 or later and npm.

```sh
npm ci
npm run dev
```

Open [http://127.0.0.1:4310](http://127.0.0.1:4310). The **How it works** link in the landing-page header opens `/how-it-works`, a dedicated page explaining the brief-to-replay flow and its limits. The root page is an animated landing page with an illustrative, browser-local simulation (no runs are started and no simulated data enters run history); use **Unleash Chaos**, or go to `/workspace`, to enter the system workspace. Click the ChaosPilot wordmark in the workspace to return home. On the landing page, the examples start at a random event, Pause/Play and Next event step through them, and reduced-motion preferences show a static outcome instead. Start with the explicitly labelled mock provider to inspect the workflow without making any model requests.

The landing page's order book, candles, depth and volume charts share one simulated market. Quotes and quantities change at uneven intervals, trades update the charts, and switching chaos examples preserves the ongoing market. Pause/Play controls both the market and the message stream. These prices are generated locally for the demonstration, not taken from a live feed.

The application runs locally. No database, containers, authentication service or external messaging installation is needed.

## Define a system before investigating

The application opens as a system workspace. Select or create a profile, then use **Brief & requirements** to save its business overview and additional requirements. **Capabilities & checks** shows the selected adapter's public contract and deterministic checks. Save or discard edits before launching so the run uses the requirements shown on screen.

Additional prose gives the investigator context. By itself it does **not** create an executable check and stays explicitly unverified. One narrow exception exists for `synthetic-trading`: in **Brief & requirements** an engineer can review and attach the allowlisted preset `accepted-order-credit-limit` to one uniquely worded requirement line. The preset checks, at every accepted valid `new_order` delivery (including `drain`), that `usedCredit + reservedCredit <= current credit limit`, using typed delivery observations. It is a deterministic demonstrator that can overlap the existing oracle; it does not verify general English requirements, and a single passing experiment does not verify the whole requirement. The rule binds to the exact unique requirement text, so renaming, deleting or duplicating that line requires an explicit remap or removal, and switching adapters requires removing it first. Rule configuration saves atomically with the brief revision; new runs pin the rule and evaluator identity, per-experiment outcomes (`passed` / `failed` / `not-exercised` / `inconclusive`) are stored separately from confirmed findings, and replay re-executes the pinned rule with its recorded evaluator rather than the current brief. Two synthetic adapters run experiments: `synthetic-trading` and the deterministic [inventory reservation service](docs/SECOND_SYSTEM.md) (`inventory-reservation`, variants `clean` and `inventory-candidate-a`). Profiles for other systems can be saved with an unconfigured adapter and remain drafts. Selecting an adapter for a profile still executes that synthetic system, not an arbitrary external application. See the [adapter guide](docs/ADAPTER_GUIDE.md) for the minimum integration contract for a future adapter.

New browser and CLI investigations save an immutable brief, revision, contract and content hash. Editing a profile later leaves earlier run evidence intact. Older artifacts explicitly show that no system brief was recorded. CLI selection uses `--system-id <saved-profile-id>`; the default is `trading-gateway`.

**Overview** summarises the selected system. **Prepare investigation** reviews the saved context and bounded run configuration. **Investigations** groups actual history by system and pinned brief revision, with older unassigned records shown separately. **Findings & reproductions** links findings to their saved run; inspect the exact sequence, source, pinned requirements, replay and clean comparison there. A global control keeps an active investigation visible and stoppable while navigating between views or systems.

The [Astra workspace design](docs/design/astra/UX_DESIGN.md) and its [clickable prototype](docs/design/astra/prototype.html) guided this integration. The prototype's sample investigation data is illustrative; the application uses persisted records and real execution/replay APIs. Fields outside the saved brief schema remain design proposals.

## Functional baseline tests

In addition to autonomous defect discovery, engineers can run deterministic functional baselines with explicit milestone assertions. Select a saved synthetic trading profile, open **Functional tests** in the workspace navigation rail, choose a target variant, and click **Run baselines**.

Baselines make **no AI model calls** and consume zero tokens or budget. They execute an allowlisted scenario catalog covering:
1. Normal order acceptance and a complete partial-fill and cancellation lifecycle (4 units at price 10 reserve 40, partial fill of 2 units consumes 20 and leaves 20 reserved, cancel request alone retains reservation, and cancellation confirmation releases only the remainder).
2. Used-credit admission accounting and rejection without state mutation (catching real flaws such as in `candidate-c`, where used credit is erroneously ignored during new order admission).
3. Initial credit rejection without state mutation.

Assertions explicitly classify outcomes as `pass`, `fail` (contradictory observed state, oracle violations, or failing requirement rules), `inconclusive` (missing observations, incomplete runs, or decoder exceptions), or `invalid` (simulator harness command rejected). Results pin the brief revision, target source, complete expected checks and evaluator identity under `runs/functional/<id>/record.json`, and can be reopened across server restarts. Drafts, unsaved edits, pending saves and unconfirmed targets block launch; old responses cannot replace a newer selection. Open the provenance and complete evidence drilldowns to inspect rejections, oracle violations and configured-rule outcomes. Context-only prose remains unverified. Detailed documentation is in [docs/FUNCTIONAL_TESTING.md](docs/FUNCTIONAL_TESTING.md).

## Finding-to-regression tests

Confirmed `synthetic-trading` findings can also be converted into immutable, engineer-reviewed regression definitions and executed against any explicitly selected compatible target variant with **no AI model calls** and zero token usage.

1. In **Findings & reproductions**, select a confirmed finding from a saved terminal run and click **Preview regression expectations**. The server verifies the run's mutation lock, pinned system brief, contract, target source, clean-control source, deterministic replay and clean-control execution.
2. Proposed delivery-by-delivery and final business-state expectations derived from the verified clean control are shown with the provenance label *"Proposed reference behavior from clean control — requires engineer review"*. Tick the explicit review confirmation checkbox and click **Save reviewed regression** to publish an immutable definition under `runs/regressions/definitions/<definitionId>/record.json` (client-supplied expectations or unreviewed saves are rejected).
3. In **Functional tests**, select a saved regression definition and any compatible target variant (e.g. `candidate-c` to reproduce the failure or `clean` to verify the fix) and click **Run selected regression**. Each execution is saved separately under `runs/regressions/runs/<runId>/record.json`, evaluating positive delivery decisions, credit/quote accounting, full order book and `absentOrderIds`, `stateUnchangedFromPrevious` rejection invariants, pinned requirement rules and oracle violations against the selected target's current executing source while preserving original finding lineage (`record.origin`). If the original investigation run is later modified or deleted, saved definitions remain valid and executable from their pinned origin snapshot and surface the updated `originStatus`. Detailed documentation is in [docs/REGRESSION_TESTING.md](docs/REGRESSION_TESTING.md).

At commit `5e4270e`, the integrated application and development tooling passed 754 tests in 43 files, the TypeScript checks and production build. See the [initial browser workflow check](docs/design/implemented/BROWSER_CHECK.md) and [workspace integration checks](design-qa.md) for browser evidence and limitations. The current prompt and larger request limits have not been evaluated in a new live comparison.

## Findings reports (saved HTML)

In **Findings & reproductions**, the opened run's findings are shown first; prior runs and verbose provenance are collapsed below. For a saved terminal run with findings, **Create report with Muse** calls Muse through the existing Meta API (shared key, model, limits and budget ledger; it incurs usage), while **Create offline scripted report** makes no model call, incurs no usage and is explicitly labelled not Muse. Either action saves a self-contained, printable HTML report under `runs/reports/` covering every recorded finding — hypothesis/why tested, recorded action/trace sequence, expected vs observed, and the recorded replay/clean-control status — with missing, legacy, ambiguous or truncated evidence stated rather than invented. View/download later makes no model call; stale reports (evidence changed) and reports for deleted runs are never served as current. Model narration is labelled interpretation and is rendered escaped in a static template; expected/observed/replay facts come only from the record.

Report generation makes one request, with no automatic retry. Evidence must fit the configured serialized request limit; it is never silently shortened. Reports bind to the complete saved record. Atomic publication shares a run mutation lock with saving/deletion, and a generation lease prevents duplicate requests across server instances. If a process crashes, inspect the corresponding `.mutation.lock` or `.html.generation.lock` under the run/report directory and confirm the owner has stopped before removing that lock and retrying. An existing lock is never broken automatically. Offline mock reports demonstrate recorded scripted behavior, not autonomous model discovery.

## Live Meta configuration

Copy `.env.example` to `.env` and set `MODEL_API_KEY` locally. Do not put credentials in browser fields, exported experiments, Git or chat. The server reads configuration; the browser does not receive the key.

`META_MODEL` selects `muse-wonder-1.0` or `muse-spark-1.3`. The mock is deterministic; live model proposals need not be deterministic. Simulator replay is deterministic in both modes.

The default request deadline is 90 seconds, configurable with `CHAOSPILOT_REQUEST_TIMEOUT_MS` up to 120 seconds. Input, output and spending allowances are configured in `.env.example`. A timeout can still incur remote usage; a zero reported token count is not evidence of a free request. The ledger keeps a conservative charge when actual usage is unknown.

New live runs default to a **131,072-byte serialized request limit** and **32,768 output tokens**. Set `CHAOSPILOT_MAX_PROMPT_BYTES` or `CHAOSPILOT_MAX_OUTPUT_TOKENS` to override either limit. The prepare screen checks the actual initial request size without a model call or budget reservation, warns when little space remains, and prevents a request already over the limit from starting. Later observations can make requests larger; when necessary the provider sends a disclosed, compact history while retaining the full saved evidence. If essential context still does not fit, the investigation stops with a reason. A failed preflight is shown as unknown, not as a guarantee that the request will fit.

`META_REASONING_EFFORT` defaults to `low`. Meta includes private reasoning in the output-token allowance, so even a valid request can finish before producing complete experiment JSON. Truncation triggers bounded correction attempts and can exhaust an investigation's proposal budget. Configuration is recorded in new live artifacts. [Meta reasoning documentation](https://dev.meta.ai/docs/reasoning)

Truncated responses are retried with a request for a shorter complete experiment. If retries or the proposal allowance are exhausted, the run is marked incomplete and keeps any earlier experiments and findings. The ledger reserves a conservative worst case using the configured bounds before each live request; larger bounds can require more available budget even when the eventual charge is lower. New benchmark defaults use the larger bounds too; explicitly frozen historical configurations and results are unchanged. A benchmark trial that uses its entire call allowance before completing the requested experiments is reported as failed/incomplete; setup comparability describes the input identities and settings, not whether that trial succeeded.

The prompt version changes with this behavior. Previously saved runs remain inspectable and their experiments can still be replayed, but whole-run exact reproduction is not claimed when the recorded prompt version differs from the current one, even if the individual experiment traces match.

Meta's account spending alert is **not a hard billing cap**. Check your remaining promotional credit before live batches. ChaosPilot's conservative application allowance is separate from account-wide usage, and cannot control requests from other tools or keys. Missing credentials or an exhausted application allowance must stop requests rather than switch billing or providers.

Official references: [Meta models](https://dev.meta.ai/docs/models), [structured output](https://dev.meta.ai/docs/cookbook/structured-output), [spending alerts](https://dev.meta.ai/help/billing/spend-limit-alert).

## Parallel worktrees

For parallel local checkouts, use the Git worktree helpers (see [scripts/README.md](scripts/README.md)):

```sh
npm run worktree:setup -- <name> [--base <local-ref>] [--no-install]
npm run worktree:list
npm run worktree:teardown -- <name>
```

```powershell
.\scripts\setup-worktree.ps1 <name> [-Base <local-ref>] [-NoInstall]
.\scripts\teardown-worktree.ps1 <name>
```

Managed worktrees live in the sibling `<repo>-worktrees/` directory on a `codex/<name>` branch (a leading `codex/` on the name is accepted), with separate dependencies and `runs/`. Setup copies the primary checkout's `.env` byte-for-byte when present (never printed or overwritten at the destination); otherwise it continues with a message. Use a distinct `CHAOSPILOT_PORT` per dev server, and the mock provider unless live credentials and total budget are explicitly coordinated — live-budget ledgers remain separate per checkout by default. Clean teardown first backs up ignored local data to a unique retained directory under `<repo>-worktree-backups/` and reports it; it still refuses dirty, locked, detached, external or unsafe targets, and always retains the branch.

[AGENTS.md](AGENTS.md) makes this the default implementation workflow for coding agents. Keep the parent chat/session anchored in the main checkout (or its existing higher-level workspace), and create temporary worktrees with these scripts. Run task edits and commands in the worktree using explicit paths and per-command working directories; do not move the parent chat into it unless the user explicitly requests that. Run teardown from the main checkout after task processes stop.

`CLAUDE.md` and `GEMINI.md` import the same instructions; delegated provider tasks also receive the shared policy through the installed dispatcher. Start future sessions in the main checkout with these files available. Existing app-managed worktrees still use the app's handoff/archive lifecycle; see [scripts/README.md](scripts/README.md).

## Commands

```sh
npm run demo
npm run investigate -- --provider mock --target candidate-a
npm run investigate -- --provider mock --system-id inventory-reservation --target inventory-candidate-a
npm run investigate -- --provider mock --system-id inventory-reservation --target clean
npm run investigate -- --provider mock --system-id inventory-reservation --target inventory-candidate-d --continue-after-findings
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

The subsequent frozen prompt 2.0 batch gave both models findings in **2/2 trials on a new synthetic target**, using one experiment each, while the unchanged conventional generator found it in **0/2 trials** within three experiments each. All 41 recorded experiments replayed identically. Total reported estimated API cost was **$0.953607**. Human timing was unmeasured, and fixture-author blinding was partial. See [controlled results and limitations](docs/CONTROLLED_RESULTS.md) and [the complete authentic reports](examples/controlled-v2/README.md). That archived revision passed 293 tests, the TypeScript check and production build. The current requirements-aware prompt and limits have not had a new live comparison.

Trading targets are `clean` and nine independently selectable candidates, A through I. Candidate identities are execution configuration, not model instructions. The investigator receives the selected implementation as ordinary source, without another variant, the answer key or known reproductions. Default benchmark calibration remains A/B; select other targets explicitly.

The [known fault lab](docs/FAULT_LAB.md) adds stale market and credit updates, split-fill accounting, mismatched execution prices, conflicting execution IDs and premature terminal order status to the original three faults. Its [offline catchability record](examples/fault-lab/README.md) contains nine known reproductions, exact replays and clean controls. These are deliberately authored recipes, **not new AI discovery results**. No live model calls were used for this expansion.

## What an experiment can do

### Challenge a saved finding with Muse

Open a terminal saved run, select a confirmed finding in Findings or its reproduction,
then use **Challenge with Muse · paid Meta API**. This is an explicit paid action even
when the original run used the offline mock. It uses the existing `MODEL_API_KEY`,
`META_MODEL`, prompt/output limits, request deadline and shared budget ledger. There
are no automatic retries: one proposal request produces 1–3 distinct variations;
one optional interpretation request follows execution. The HTTP API can omit the
interpretation with `interpret: false`.

Only the registered trading and inventory adapters are supported. The saved finding,
experiment, target, contract, original replay and clean source must be verifiable;
legacy records without adequate provenance show an availability reason. Variations
are limited to 100 actions and 24 KiB per experiment. All proposals are parsed before
any variation executes. Payloads may intentionally be malformed; arbitrary tools,
shell commands and external targets are unsupported.

Each variation starts fresh on candidate, candidate replay and clean control. The
panel shows actual step differences, hypotheses, same-invariant observations, other
violations, replay/clean statuses and full evidence/traces. “Absent” requires a valid
completed candidate; errors and incomplete runs do not establish absence. Muse's
post-execution text is labelled interpretation and does not establish root cause.

Challenge artifacts are saved separately under `runs/challenges/`, bound to the exact
run version and finding. Reloading or revisiting retrieves saved evidence. Failed
attempts retain previous completed evidence; cancellation or interpretation failure
retains completed traces. Cancellation may leave remote usage unknown, with the
shared ledger retaining a conservative charge allowance. Rewriting/deleting a run
or source/context drift prevents artifacts being presented as current. A generation
lock excludes duplicate challenges across server instances; interrupted locks require
inspection rather than automatic removal. Original run/model histories stay intact.

Offline validation (fake model responses only):

```sh
npx vitest run tests/challenges.test.ts tests/challenge-api.test.ts tests/challenge-ui.test.ts
npm run typecheck
npm test
```

These checks exercise actual adapter evidence and HTTP handlers; the loopback test
reports a skip when the execution environment denies local network connections.
They are plumbing/correctness checks, not AI discovery evidence.

The model constructs structured action sequences. For trading it can publish market and credit messages, submit and cancel orders, cause simulated venue fills or cancellation confirmations, inject raw JSON, duplicate messages, choose delivery order and advance logical time. For inventory it can send stock receipts, reservations, cancellations and shipments, duplicate messages, choose delivery order and advance logical time. See the [inventory contract and walkthrough](docs/SECOND_SYSTEM.md) for its bounds and checks.

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
