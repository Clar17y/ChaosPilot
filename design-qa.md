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
