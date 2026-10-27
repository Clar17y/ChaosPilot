# ChaosPilot desktop UI / UX review

Follow-up: the requested Muse review and behavior-preserving simplify pass are complete. See [Review and simplification results](REVIEW_AND_SIMPLIFY.md) for the latest candidate and checks, including 425 passing tests on the pull request branch. The screenshots below remain applicable; the follow-up only consolidated duplicate experiment-selection validation.

27 October 2026. Baseline: `4844d48`. Scope: all six workspace views, saved investigation details, experiments, proposals, trace, accounting and replay. Desktop is the intended platform, as clarified during this review.

The interface's main problem was an inconsistent presentation layer. Two rendered components had no matching style rules, the investigation header packed every field into one flex row, and trace payloads could widen the whole page. Dense prose, tiny supporting text and repeated colored boxes amplified those defects.

## Priority findings

| Priority | Finding | Evidence | Required outcome |
| --- | --- | --- | --- |
| High | Finding and experiment styles do not match their rendered class names | Steps 6–7 | Shared component styles apply to actual markup; consistent spacing and alignment |
| High | Trace JSON causes document-wide horizontal scrolling | Step 8 | Long payloads stay within their evidence area |
| High | Experiment selection is a clickable div; tabs lack their full semantic and keyboard behavior | Step 7 and source inspection | Keyboard-operable experiment selection and associated tab/panel states |
| Medium | Run metadata collides with the heading and wraps into fragments | Steps 6–10 | Separate title/status and metadata rows with safe wrapping |
| Medium | Prose editors are tiny monospace with little vertical separation | Step 2 | Readable prose typography, comfortable editor heights and consistent form spacing |
| Medium | Heavy nesting and repeated warning accents flatten the visual hierarchy | Steps 1–4 | Restrained surface, typography and action hierarchy |
| Medium | History squeezes identifiers and actions; findings prioritize raw IDs | Steps 5 and 11 | Readable rows, useful target/outcome hierarchy, exact identifiers retained |
| Medium | Secondary guidance is too faint or too small | Steps 3, 5 and 9 | Readable supporting text and clear keyboard focus |

## Captured walkthrough

Every image below was captured from the running application during this review, saved, reopened and inspected. Baseline captures use the initial desktop viewport (approximately 1280 × 720). After captures use the user's desktop window or a controlled 1280 × 900 preview; an additional 1024px trace capture checks a narrower desktop window. Content and scroll positions vary, so these are experience checks rather than pixel comparisons.

### 1. Overview — needs hierarchy

Actual readiness counts and the synthetic-adapter scope are useful. Equally weighted boxed sections and repeated primary actions compete with the current system context. The long system name is clipped in the selector.

![Overview before](images/01-overview-before.png)

**After:** Improved: quieter surfaces, stronger headings and consistent shared edges. The long native system-selector label still truncates; the full system name is visible in the workspace.

![Overview after](images/01-overview-after.png)

### 2. Brief and requirements — needs repair

Labels and revision context are present, but ordinary prose appears as small monospace. The overview editor nearly touches the next field label. Informational hints use warning colors and the context-only explanation repeats.

![Brief before](images/02-brief-before.png)

**After:** Improved and verified: normal prose typography, clearer label/editor gaps and consistent controls. Unsaved edits survive navigation, block launch and can be discarded. A new isolated draft saved successfully.

![Brief after](images/02-brief-after.png)

### 3. Capabilities and checks — dense

The distinction between available checks and exercised coverage is truthful. Nested cards, long machine identifiers and small descriptions make the checks harder to scan.

![Capabilities before](images/03-capabilities-before.png)

**After:** Improved: descriptions and check labels are more readable. The detailed contract remains dense by nature; availability is still clearly distinguished from exercised coverage.

![Capabilities after](images/03-capabilities-after.png)

### 4. Prepare investigation — unbalanced

Mock/live modes and pinned context are explicit. A short context panel stretches to the entire height of the form, while warning text and the inactive Stop action compete with Launch.

![Prepare before](images/04-prepare-before.png)

**After:** Improved and verified: the context panel keeps its natural height, form spacing is consistent, and the final disabled-launch reason is visible beside the action. The draft example is included below.

![Prepare after](images/04-prepare-after.png)

### 5. History and empty dashboard — needs repair

Selected-system and legacy histories are separated correctly. Empty-state guidance has weak contrast. Table cells squeeze identifiers and controls into awkward fragments.

![History before](images/05-history-before.png)

**After:** Improved: clearer empty guidance, wrapped identifiers and bounded table scrolling. Wide history tables still scroll within their own region at narrower desktop sizes.

![History after](images/05-history-after.png)

### 6. Saved investigation and finding — broken alignment

The heading touches the metadata, model/target values wrap into fragments and provenance becomes a tall pill. The finding's intended structure is lost because emitted `.finding-card` / `.finding-header` classes do not match the stylesheet's `.finding-item` / `.finding-title-row`.

![Investigation before](images/06-investigation-before.png)

**After:** Repaired: title/status and metadata occupy separate rows, findings have matching styles, and long content wraps. Empty findings now use neutral guidance that also makes sense for completed and stopped runs.

![Investigation after](images/06-investigation-after.png)

### 7. Experiment selection — broken styling and keyboard access

The renderer emits `.experiment-item`; the stylesheet expects `.exp-item`. The resulting row has weak selection feedback and misaligned outcome text. Source inspection and the accessibility tree confirm the row is a clickable div rather than a keyboard control. The run's tablist also exposes ordinary buttons without the complete tab/panel state model.

![Experiments before](images/07-experiments-before.png)

**After:** Repaired and keyboard checked: native buttons provide selection feedback. Enter opens the chosen experiment trace and focuses its tab. Tab navigation supports arrows, Home and End.

![Experiments after](images/07-experiments-after.png)

### 8. Action trace — document overflow

The trace preserves useful step, time, action, payload and outcome data, but long payloads make the whole desktop page scroll sideways. The bottom scrollbar in this capture is page-level.

![Trace before](images/08-trace-before.png)

**After:** Repaired: the five columns fit within the evidence region, with useful space reserved for payloads. Long JSON wraps without widening the document; 1024px and normal desktop captures were checked.

![Trace after](images/08-trace-after.png)

### 9. Credit and order state — dense

Credit and orders can be compared for the selected experiment. Tiny type and compressed multi-value order summaries make scanning difficult; label/value gaps and wrapping need consistent rules.

![State before](images/09-state-before.png)

**After:** Improved: label/value gaps and readable values make credit and order state easier to compare. Technical field names and exact figures remain available.

![State after](images/09-state-after.png)

### 10. Proposal audit — usable but compressed

The request and response disclosures are useful progressive detail. Summary, completion reason and proposal metadata need clearer spacing and hierarchy.

![Proposals before](images/10-proposals-before.png)

**After:** Improved and checked: request/response details remain collapsible, supporting text is larger, and opened request content stays within the page.

![Proposals after](images/10-proposals-after.png)

### 11. Findings index — hard to scan

Long raw IDs dominate repeated rows. Target, outcome and finding count should be easier to compare while preserving the full run identity and legacy attribution.

![Findings before](images/11-findings-before.png)

**After:** Improved: target, outcome and finding count lead each row; exact run IDs and legacy attribution remain underneath.

![Findings after](images/11-findings-after.png)

### 12. Replay report — functional, needs polish

The real saved candidate-C record reproduced 1/1 experiments. Escape closed the report and restored focus to Replay. Long hashes, dense monospace and a small-looking close control make the result harder to read than necessary.

![Replay before](images/13-replay-before.png)

**After:** Improved and verified: the saved candidate-C run reproduced 1/1 experiments without a model call. Escape closed the report and restored focus to Replay. Export JSON downloaded the matching run with its experiment.

![Replay after](images/13-replay-after.png)

## Evidence limits

These observations cover desktop layout and specific interactions. Screenshots alone do not establish accessibility compliance. Screen-reader testing, other browser engines, live model calls, billing behavior and production systems are outside this review. Offline mock tests use an isolated store. Mobile is excluded from acceptance at the user's request.

## Repair and final checks

The repair is implemented locally. It covers shared typography, spacing, control sizes and contrast; finding/experiment styles; run metadata; trace widths; form guidance; tab and experiment keyboard interaction; and clearer empty-state copy.

Additional draft readiness and narrow desktop evidence:

![Visible draft launch explanation](images/14-draft-readiness-after.png)

![Trace at 1024px desktop width](images/15-trace-1024-after.png)

| Check | Result |
| --- | --- |
| Six main views at 1024, 1280 and 1440px | All 18 combinations fit without document horizontal overflow. Local table/tab scrolling remains available. |
| Browser interactions | 20 recorded checks passed, including dirty/discard behavior, draft saving/readiness, active-run Stop from another view, honest cancellation, tab keyboard navigation, experiment activation, replay and export. |
| Full automated suite | 408 tests across 25 files passed; its production build passed. |
| Type checking | Passed on the integrated candidate. Final source changes also passed TypeScript compilation. |
| Final focused checks | 17 tests across 3 files passed after the readiness/empty-copy changes. The last change only adjusts trace column proportions and was verified in the browser. |
| Whitespace validation | `git diff --check` passed. |
| Browser console | No captured error messages in the inspected app and isolated preview. |
| Independent review | No actionable introduced defects in the five scoped code files. Final small readiness/copy/CSS deltas were self-reviewed and checked directly. |
| Jev advisory review | Attempted again on the final diff; coverage is partial because of the operation budget and an oversized hunk. This is not an all-clear or test evidence. |

Base: `4844d48`. Final scoped code diff SHA-256: `7895d0ffbfd61690d08e584c4c225f0b39fcb1a7e299359cbb1b4d8a03eea151`.

Local verification records are in `.llm-output/ui-ux-audit/`, including `browser-checks.json`, `host-tests.log`, `candidate.diff` (independently reviewed), `final-candidate.diff` and `jev-review-final.json`. Independent review output is in `.llm-output/agent-framework/266468ad-b6bf-4325-86bc-20e6b4a31692/stdout.log`.

Remaining limits: the selector still shortens long system names; dense history and tab rows use local scrolling in narrow desktop windows. Focus restoration across a newly arriving experiment was inspected in source and a terminal focus state was observed, but arrival timing was not independently captured in the browser. Full screen-reader coverage, other browser engines, mobile, live provider failure/billing paths and exhaustive lifecycle fault injection were not tested. Test mutations used an isolated offline store; the user's saved systems and runs were not edited. No commit or deployment was made.
