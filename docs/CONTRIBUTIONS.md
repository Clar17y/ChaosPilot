# Hackathon contribution record

## Origin

ChaosPilot was created as a fresh repository for the Meta Global AI Developer Hackathon. Repository inspection on 26 October 2026 found no product files or commits. Product discovery and plan approval occurred during the event.

All project implementation is newly authored for this repository. No Forge or employer-owned code, credentials, market data, documents or assets are incorporated. The trading data and venue are synthetic.

## Contributions in this build

- Product discovery: narrowed the claim to source-aware negative investigation and verified reproductions, with a conventional baseline and explicit limitations.
- Architecture: separated target source, behavioural contract, experiment execution, independent verification, provider integration and presentation.
- Engineering: deterministic trading simulation, offline/live provider separation, replay artifacts, local investigation interface and automated checks.
- Documentation: setup, behavioural rules, evaluation methodology and accepted decisions.

AI coding tools assist implementation under the participant's direction. Their output is reviewed and tested; use of coding assistance does not itself establish runtime Meta integration or discovery performance. The installed development-routing framework is a development tool, not product code copied into the submission.

## Evidence status

Live Meta integration was exercised with Wonder and Spark on 26 October. Wonder generated and verified reproductions of both intended defects. A six-trial comparison and its failed requests are preserved in `examples/`; its combined discovery count equals the conventional baseline, so no overall efficiency advantage is claimed. The browser-launched live credit-release finding was replayed without another model call. Screenshots in `docs/` capture that application state and replay report.

Offline mock demonstrations remain labelled separately. The initial build passed 201 tests. A later explicitly low-effort live Wonder run executed two clean-target experiments with zero violations and retained its truncated-proposal errors; this is not a broader clean-correctness claim.

The next iteration added a specialised versioned investigation prompt, durable per-proposal audits and UI inspection, capped three-way benchmarking, source/runtime/function freezes and one new synthetic candidate. Its final complete suite passed 293 tests, typecheck and build. Actual Wonder and Spark calls each verified the new fault in 2/2 trials, using one experiment each; the unchanged conventional generator produced 0/2 findings within three experiments per trial. All 41 recorded experiments replayed identically. The estimated reported cost was $0.953607. Strict fixture-author blinding was not achieved because the author also read existing simulator tests and verifier code; the prompt, baseline and previous run artifacts were excluded. Independent review identified comparability failure paths, which were repaired and covered with regression cases. Fake-response tests were isolated from the live spending ledger, with all prior ledger entries preserved. See CONTROLLED_RESULTS.md for the evidence and limitations.

Measured engineer-time savings and production generalisation have not been established. This record must be updated only with actual results, not planned work.

## System briefs, known fault lab and Astra design

The next local iteration adds reusable business briefs, visible public trading rules, contextual requirements, saved revisions and immutable run snapshots. Browser/CLI launches pin their actual context. Concurrent writes use a bounded filesystem lock and revision check; corrupt files remain intact. Drafts without adapters cannot launch, and dirty forms cannot accidentally launch an older saved system. Prompt 3.0 includes the saved overview/requirements without granting new executable checks.

The synthetic library now has nine independently selectable deliberate faults, adding stale market/credit versions, split-fill accounting, mismatched execution prices, conflicting execution IDs and premature terminal status. All nine known recipes have valid reproductions, identical compiled replay and clean/normal controls. Recipes and labels remain in an isolated testing catalog. The original clean/A/B/C business identities and public verifier are unchanged. This is development evidence, not a new blind discovery comparison.

Astra produced a newly authored system-workspace design and standalone clickable prototype, grounded in the current screenshots and public contract. Selected prototype interactions were checked in a real browser; its investigation data remains illustrative. The working requirements editor was separately browser-checked through save, blocked drafts, a mock investigation and preservation of its older pinned context. The CLI replay reproduced both browser-run experiments exactly.

At the final acceptance checkpoint, `npm test` passed 356 tests in 19 files (including a production build), and the TypeScript check passed. The new checks include actual same-revision concurrent saves and an explicit subprocess attempt while another process holds the lock. One independent Sol review identified incomplete lock setup/release cleanup; the related failure paths were repaired with Muse development assistance and twelve filesystem-failure cases. Those cases and the real HTTP suite passed on the primary host after the worker environment denied loopback listening. Primary inspected the scoped repair against the review finding. No new runtime Meta API calls were made, and the private spending ledger remained byte-identical across the final offline checks. The branch is local and unpushed; the archived prompt 2.0 live study remains separate and unchanged.

## Working workspace integration and simplification

Astra's layout now surrounds the actual product APIs: Overview, Brief & requirements, Capabilities & checks, Prepare investigation, Investigations, and Findings & reproductions. Profiles are editable and saved; history is grouped by system and pinned revision, and legacy records remain unassigned. Production views use real artifacts rather than the prototype's illustrative investigation data. Muse assisted implementation under bounded file ownership.

One independent Sol simplify audit covered reuse, quality and efficiency after the Claude CLI failed authentication. It identified related live-inspection and pending-cancellation defects, which were repaired as one lifecycle batch. The behavior-preserving improvements type simulator contract access, reuse one proposal display calculation per refresh, and consolidate pending-stop intent. Standalone planted variants remain separate to preserve source identities.

The final host checks passed **387 tests in 23 files**, typecheck and production build. Browser acceptance uses separate offline stores and delayed mock requests; see `../design-qa.md` for actual observations and visual evidence. This integration adds no live discovery results and does not alter the archived controlled comparison. Human timing remains unmeasured.

## Meta review repairs and publication checkpoint

A participant-requested fresh Muse Wonder Full review found four frontend issues: a Stop lost between start acknowledgement and status settlement, old history shown under an unsaved draft, hidden profile integrity failures, and out-of-order status application. The primary corroborated all four in source and reproduced them in an isolated browser fixture using the saved pre-repair client. Muse implemented one consolidated request-boundary repair; primary acceptance additionally corrected terminal Stop controls while an invalidated status request was still pending. This was a same-provider second opinion, not a claim of provider-independent validation.

The stable release candidate passed **401 tests in 24 files**, typecheck and production build on the host. Controlled browser checks verified Stop transport, terminal controls, stale-response rejection, draft/discard identity and visible corrupt-profile errors with preserved file bytes. Original simulator identities and the archived live study remain unchanged. No runtime Meta model requests were used. The participant authorised committing, pushing and opening a PR for this batch.
