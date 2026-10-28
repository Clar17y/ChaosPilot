# Live market background — 28 October 2026

This is the latest homepage acceptance record. The requested change is a continuously updating order book with coherent charts, retaining the selected option 1 layout and chart footprint.

## Visual comparison

- Before: `docs/design/homepage/market-live-before.jpg` and `market-live-mobile-before.jpg`. Final: `market-live-desktop-final.jpg` and `market-live-mobile-final.jpg`, in that same directory. All four genuine browser captures were opened together for comparison.
- Desktop captures are both 1472 × 1047 pixels from a 1487 × 1058 CSS viewport; mobile captures are both 374 × 1604 from a 390 × 1058 CSS viewport. The browser capture provider introduces a small image scale and temporarily alters the scrollbar gutter during full-page capture; matching captures and pre-capture DOM geometry were used rather than inferring layout from those temporary metrics.
- The hero, copy, scene and event-strip rectangles match the original desktop geometry exactly after normalizing viewport Y by scroll position. Mobile pre-capture rectangles also match exactly. Typography, text, controls, gutters, page height and navigation are retained. Canvas regions use the original 1511 × 1041 market image coordinate frame, with the existing desktop/tablet/mobile background transforms.
- The original static values/charts were removed using built-in ImageGen to produce `public/assets/homepage/market-grid.png`, 1511 × 1041 opaque RGB. The original asset is preserved. Exact prompt and provenance: `docs/design/homepage/market-grid-asset.md`. Inspection found no ghost numbers or chart data.
- Initial visual pass: candles/depth/volume were too strong and rising candle histories could compete with the headline. The final pass uses thinner, quieter candles, low-opacity stepped depth and volume, and reserves the actual copy rectangle. The data occupies the same plot regions; no panels or new controls were added.

## Behavior, repairs and concrete coverage

The new `homepage-market.ts` owns one seeded random simulation. `homepage-market-renderer.ts` derives every displayed plot from its snapshot. The existing RAF advances both the market and message timeline; scenario selection never resets or advances the market. Updates arrive 350–1000ms apart, with small bounded price changes and frequent quantity-only updates. Candles hold four seconds of trades and history is capped at 48 candles. There is no live financial feed or backend activity.

The primary consolidated the source-review findings into one local integration repair after the worker finished: the first scene-bound market canvas clipped the mobile plots and cached incorrect scroll coordinates. A separate backdrop canvas now follows the background itself (fixed on desktop, document-anchored on mobile), with independent dimensions and no scroll-time layout reads. The same repair preserved resting book levels across price moves and made candle-only rollover invalidate the render immediately. A floating-point equality assertion was adjusted to a subpixel tolerance; it did not require a behavior change.

| Invariant / transition | Evidence and limits |
| --- | --- |
| Shared book, trade, candle, depth and volume data | 18 market tests cover deterministic seeds, distinct seeds, chunked elapsed time, zero/invalid delta, 2,500 update steps, ordered positive levels, narrow spread, tick-sized moves, resting-level continuity, trade prices inside the current spread, OHLC enclosure and close/open continuity, exact cumulative depth and trade-volume sums, rollover, finite values and bounded history. |
| Paused market survives scenario changes | Final paused book crops before/after 19 Next actions were pixel-identical. Earlier 15-action check also passed. The full paused page was byte-identical across separate captures. Evidence: `.llm-output/market-live-final-paused-a.jpg`, `market-live-final-paused-b.jpg` and earlier paused/running captures. |
| Resize preserves market history | Desktop → mobile → desktop retained every visible price/quantity and the same candle history. Corresponding book pixels differed by at most 2/255 from screenshot compression, not changed values. Capture: `.llm-output/market-live-final-paused-after-resize.jpg`. |
| Live updates and event switching | Separate playing captures show changed book values and charts; Play then Next remained in playback and injected event 21 into the running scene. Browser console warnings/errors were empty after the final integration. |
| Footprint and scrolling | Transform tests cover 320/390/768/1024/1487, fixed desktop/document mobile scroll coordinates and CSS breakpoints independent of scrollbar width. Actual 320/768/1024 browser checks found no overflow, tag/copy/control collisions or tag-pair overlaps; `.llm-output/market-live-responsive.json`. Desktop/mobile comparisons above verify the requested footprint. |
| Existing packet/scenario behavior | `homepage-events.ts`, `homepage-scene.ts` and `tests/homepage-scene.test.ts` were unchanged by this refinement. Reuse prior 210-case label-clearance checks and existing timeline tests. |
| Hidden/offscreen and reduced-motion lifecycle | Source integration uses the existing single-loop eligibility gate and capped active-time delta. Existing timeline tests cover reduced motion; no OS reduced-motion toggle or real hidden-tab emulation was added to browser verification. No claim of exhaustive browser lifecycle coverage. |

## Candidate and checks

- Worktree/branch: `C:/dev/ChaosPilot-worktrees/homepage`, `codex/homepage`, base `e2fba1c0aca6b73c1cd6edbf2833f4f592324c0c`. Changes remain local and uncommitted; no push or PR for the homepage.
- Stable code/asset binding: `.llm-output/market-live-candidate.json`, integrated native Git diff SHA-256 `493a19ced2785663169e55ea4de3c6bf4f78799994918a7df3b68dda0f241881`.
- Host `npm test`: **514 passed in 29 files**, `.llm-output/market-live-full-tests.log`. This resolved the worker's restricted TEMP/child-process failures and missing-in-progress asset. Later changes only adjusted rendering opacity/line width, stepped depth drawing and the copy mask; unchanged full-suite evidence is reused.
- Focused homepage/scene/market suite: **74 passed in 3 files**, `.llm-output/market-live-focused-tests.log`. Final typecheck and build passed (`market-live-typecheck.log`, `market-live-build.log`). The final one-line mask origin correction is covered by the final browser resize/scroll comparisons and typecheck/build. `git diff --check` passed.
- Jev search completed. Integrated Jev review was saved against the candidate above, but remains **partial**, with unsupported/oversized/incomplete hunks and missing safe context. It provides no all-clear. Acceptance rests on inspected source, concrete tests and browser comparisons; no automatic extra reviewer was added for this illustrative frontend change.
- Remote PR #16 (recorded walkthrough) merged during this work. Its merge commit was fetched and verified; clean primary `C:/dev/ChaosPilot` was safely fast-forwarded to `05695ea` with ignored-file overwrite protection. Main is clean and matches `origin/main`; task worktrees were preserved. The homepage worktree retains its original base rather than merging unrelated changes into this visual refinement.

final result: passed


---

# Astra workspace integration — design QA

final result: passed

Passed for the bounded synthetic-adapter workspace integration. The initial findings and repairs remain below as an evidence trail. This is not a production-system, live-model-performance or comprehensive accessibility certification.

## Comparison target and evidence

- Source: `docs/design/astra/prototype.html`, freshly captured in `docs/design/integrated/reference-overview.png`.
- Implementation v1: real app with offline fixtures at `http://127.0.0.1:4312`, captured in `docs/design/integrated/implementation-overview-v1.png`.
- Both overview captures use an explicit 1280 × 900 desktop viewport. The new browser tab initially used 1280 × 720; that unmatched capture was replaced after aligning the viewport. The accepted source and implementation were reopened together in one comparison input. No screenshot was edited or substituted.
- Source is an illustrative trading overview; implementation uses actual saved QA profiles. Different system names, contextual requirement counts and saved-run counts are intentional. Removing the source's synthetic-prototype banner in the real app is intentional.
- The visual target contains text, native controls and layout surfaces, with no raster image assets to generate or approximate.

## Initial findings

1. **P1 — Stop is hidden after launch.** Launch navigates to Investigations, while the enabled Stop button remains inside the hidden Prepare panel. The browser confirmed `stopVisible: false` and `stopEnabled: true` during a running delayed mock. The user must navigate backwards to stop. Provide a visible control tied to the actual global investigation, including pending/stopping transitions and other workspace views.
2. **P2 — Evidence leaks between workspace views.** After opening delivery revision 1, switching to an unconfigured payments profile leaves delivery findings under “Findings in the currently opened run” without identifying the different system. History changes scope but the old detail remains. Reconcile selection, opened record, active polling and legacy inspection as one context-boundary repair.
3. **P2 — Unconfigured capabilities list trading operations as supported.** The payments profile correctly shows no executable checks, but still shows send/fill and the full trading message vocabulary under “Supported operations”. Gate those lists with the actual adapter, alongside the invariant/raw-contract display.
4. **P2 — Typography, spacing and lower overview hierarchy drift from the source.** The inherited runner CSS compresses buttons, leaves a smaller main gutter and oversized card headings. Two lower full-width cards replace the source's two-column grouping and touch vertically. Apply the source's owning layout/type rules and keep responsive stacking.
5. **P2 — Empty and product-copy states need correction.** With no opened run, Investigations leads with idle mock metrics and $0. Brief exposes implementation instructions about fields “not added” and the saved schema. Show a useful selection/loading state and remove development instructions from the product.

## Required fidelity surfaces

- **Fonts/typography:** source body 15px/1.55, h2 18px and larger native buttons; implementation inherits smaller button and larger h2 rules. Repair pending.
- **Spacing/layout:** rail and general grid proportions are present; main gutter, lower grid, card gaps and resulting density require correction.
- **Colors/tokens:** dark/cyan family and blue action emphasis are preserved. Ready/blocked states must retain text labels in addition to color.
- **Image quality/assets:** no photographic/illustration assets in the target. Both captures are genuine browser output; no fake visual assets were introduced.
- **Copy/content:** actual persisted values replace illustrative ones appropriately. Context-only requirements and availability-versus-coverage wording remain; the implementation-only copy noted above must be removed.

## Interaction checks already observed

System/revision history grouping, separate legacy history, pinned revision 1 after current profile 2, dirty-form retention through navigation, dirty launch blocking, protected profile switching, unconfigured launch blocking and a genuinely cancelled mock run all worked in the first browser pass. API spending was not used. These are observations from the specific offline fixture; no AI discovery or comprehensive accessibility claim follows.

## Acceptance repair and next comparison

The related context/control/capability paths and visual findings were consolidated into one owned repair batch. The repaired desktop overview and focused navigation/control captures were reopened alongside the source in the same comparison input. `implementation-overview-v2.png` and `implementation-controls-v2.png` show the corrected type scale, readable controls, main/card gutters and two-column lower overview. The extra prototype banner is absent intentionally. Counts describe actual check availability, contextual requirements and saved runs rather than the prototype's proposed per-requirement classification, which the saved schema does not implement.

The browser verified an empty dashboard before selection, grouped system/revision history, no other-system findings attributed to a selected workspace, explicit identity for an intentionally inspected different run, and no trading operations for an unconfigured profile. A delayed history response after immediate selection change retained only an explicit cross-system notice. A running investigation remained stoppable while editing a different system; opening and stopping it retained that system's unsaved text. Saving that draft produced revision 2. A separately created unconfigured profile saved its authored requirements and could not launch.

The real replay API reproduced both saved mock experiments exactly. Escape closed the report and restored focus to the Replay button. JSON export downloaded the actual saved record. Expanding historical requirements showed revision 1 and its hash while the current profile remained revision 2. Browser console inspection after these flows returned no warnings or errors.

`implementation-narrow-v2.png` and `implementation-narrow-history-v2.png` show the actual app at 390 × 844. Document widths were 375px at a 390px viewport and 305px at a 320px viewport, with no document horizontal overflow; the 916px history table scrolls inside its panel. The narrow reference tab did not accept the same override, so no matching narrow-reference fidelity comparison is claimed. Desktop comparisons are matched at 1280 × 900. Full keyboard/screen-reader compliance is not inferred from these selected checks.

An additional timing case was found: with POST/start deliberately delayed by two seconds, Stop pending start issued a premature stop request and reported “No active investigation to stop”. The subsequent start handler honoured cancellation and the actual run ended CANCELLED with zero experiments, but the persistent failure message was misleading. It was included in the consolidated control-lifecycle repair, separately from behavior-preserving simplification.

The integrated static audit also traced live inspection being marked as historical, preventing later status/terminal updates. A further browser probe confirmed the related missing-cache path: launch an offline run, switch to payments, allow a poll, then choose global Open. It requested the unsaved artifact and displayed HTTP 404. Evidence: `implementation-live-open-before-repair.png`. These related active/inspection/stop transitions share the same repair owner; earlier statements about Stop visibility and draft retention do not establish live inspection refresh correctness.

## Final acceptance

The consolidated lifecycle repair retains the latest live record separately from inspected history, follows an explicitly opened live ID to terminal state, and checks deferred cancellation outcomes. New selection, launch and global Open invalidate older detail requests. A small primary simplification removed the duplicate pending-stop flag and a no-op branch; cancellation intent now has one owner. The original standalone simulator sources and archived live study remain unchanged.

| Case | Actual evidence |
| --- | --- |
| Stop before the delayed start is acknowledged | Visible pending Stop, no false alert, actual CANCELLED record with zero experiments; `implementation-pending-stop-final.png` |
| Open live from another system before persistence | No 404; actual live record opened with its own system identity while the payments draft stayed unsaved and intact |
| Follow explicit inspection through completion and findings | Two real mock experiments completed; Findings view updated without reopening, with replay/clean-control results and the run's own system/revision; `implementation-live-findings-final.png` |
| Preserve unrelated saved inspection | Legacy record remained COMPLETED and selected while the global live run reached CANCELLED; stopped history remained distinct from a clean pass; `implementation-history-isolation-final.png` |
| Drop late saved-detail responses | A 1.5-second historical fetch could not replace a newer launch or global Open; the live record retained revision 2 rather than the delayed revision-1 record |
| Tests and static checks | Final host `npm test`: 387 passed in 23 files; typecheck and production build passed. Worker sandbox socket/TEMP failures were resolved by the host rerun |
| Real product presentation | `application-requirements.png` captures the actual saved profile at port 4310, separate from the offline QA store |

The final browser console check returned no warnings or errors. Runtime Meta API calls were not used, and the private spending ledger was unchanged. Coded initialization cancellation, true conflicts, deferred-stop failures and rapid settlement have automated classifier/state coverage; their full browser fault-injection combinations were not all exercised. The selected keyboard, desktop and narrow checks above remain the extent of the accessibility/responsive evidence. Jev review was bound to the final diff but had partial coverage, not an all-clear.

## Meta review repair and release acceptance

The requested Meta review produced four further frontend findings, accepted by primary source inspection. Before/after checks used an isolated real product server, a scripted mock investigator, and a loopback transport proxy. The pre-repair client was reconstructed from its saved diff and compiled separately; cached asset hashes distinguish it from the final client. Only QA responses are delayed. Headers are flushed and responses marked uncacheable so browser cache serialization does not conceal overlapping body responses. These helpers and traces stay in ignored `.llm-output/`; user runs/profiles are separate.

| Finding | Before | Final result |
| --- | --- | --- |
| Stop after acknowledgement, before first status resolves | Start accepted, Stop acknowledged in UI, zero Stop requests sent; run continued | One Stop request sent, actual CANCELLED result, all Stop controls hidden even while the old status body remained delayed; `meta-repair-cancelled.png` |
| Unsaved draft identity | New System Profile showed three runs from the previous saved system | Overview count zero/latest empty; Findings/history explicitly unscoped; discard restored Review QA trading and its three runs |
| Corrupt profile error | Actual API integrity failure, empty selector, no alert | Visible error naming corrupt-qa and inability to load profiles; file bytes unchanged; `meta-repair-profile-error.png` |
| Out-of-order status response | Terminal result followed by delayed running body restored RUNNING and Stop, while backend was completed | Same delivery order retained COMPLETED with Stop hidden; `meta-repair-status-order.png` |

The new request-boundary tests exercise code actually delegated to by the handlers, including immediate/deferred Stop, failure/retry, rapid settlement, terminal-before-running response order, slow-request progress, generation invalidation/stale errors, and failed profile loads without replacing context. Primary added the coupled terminal-controls case after browser acceptance exposed it. The stable final host run passed **401 tests in 24 files**, typecheck and production build. Earlier unchanged simulator, profile-store, snapshot and replay checks remain applicable. Full browser injection of every transport/init error combination is not claimed; the tests and specific observations above define the evidence.

# Reproduction player - design verification

This section was originally written in a different, combined checkout. Its
screenshots were local-only files in that checkout's ignored output directory;
they are not included in this repository and are not available to readers of
this pull request, so no screenshot comparison can be checked from here. They
are described, not linked, for that reason: a desktop source capture, a desktop
implementation capture, a full-view comparison, a focused comparison, and a
390 x 844 mobile capture, all of a saved candidate-C finding at the fourth key
event with credit limit 100 and recorded exposure 200.

Findings and repairs recorded at that time:
- [P2] The initial player showed ten low-level rows and pushed controls beyond the demo frame. The final player derives four key events only for a validated, unambiguous credit-admission sequence, preserves source trace positions, and falls back to the complete trace otherwise.
- [P2] Initial credit figures were visually subordinate. The final view emphasises the limit and total exposure, and the composition bar includes a limit marker.
- [P1] Non-credit failures could be incorrectly labelled as credit-limit failures, and multiple entries sharing an action index could be assigned a violation ambiguously. Fixed by using the recorded invariant and only associating a violation when exactly one entry matches. A separate saved non-credit example and focused tests were checked at that time.
- [P1] Recorded playback and real replay are distinct controls. The real replay reproduced the saved experiment with matching source and no model invocation at that time.

Required visual surfaces:
- Typography: existing product font and hierarchy retained; player title and failure figures enlarged.
- Layout: aligned desktop two-column evidence and action areas; 390px view stacks content with no document horizontal overflow.
- Colors: green represents a hypothetical rule-satisfying outcome, red a recorded violation; labels carry the same meaning in text.
- Assets: source uses product UI rather than photography or illustrations; existing product identity retained.
- Copy: the expected outcome is explicitly hypothetical, legacy brief absence is visible, and the synthetic target and historical status are identified.

Intentional differences: the player lives within the existing investigation workspace instead of a separate page; key events are explicitly labelled as a selection from the full trace; additional provenance and replay distinctions prevent claims not supported by the saved record. A full accessibility audit and every provider failure timing were not tested.

Historical checks: the combined checkout this section came from recorded 489
passing tests plus typecheck/build and browser checks, and marked itself
passed. That result belongs to that other combined checkout, not to this
candidate, and cannot be verified from this pull request. It is retained only
as historical context and is not a result for this branch.

Current verification for this candidate is reported separately in the pull
request / task handoff (focused test and typecheck commands actually run on
this checkout), not asserted in this note.

final result: not claimed for this candidate - see the separately reported current verification
