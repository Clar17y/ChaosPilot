# ChaosPilot Overview Video (Motion Graphics)

A self-contained Remotion project that renders a polished, deterministic, 180-second (3-minute) motion graphics overview of **ChaosPilot**, an investigation workbench for negative scenarios in event-driven software.

## Technical Specifications

- **Duration:** Exactly 180 seconds (3 minutes) / 5400 frames
- **Resolution:** 1920 × 1080 (1080p Full HD, Landscape 16:9)
- **Frame Rate:** 30 fps
- **Format:** H.264 / MP4 (`yuv420p` pixel format)
- **Audio:** Silent (focused motion graphics with high-readability on-screen text)
- **Framework:** Remotion `4.0.541` (React 19, headless Chrome renderer)

---

## Storyboard & Scene Breakdown

| # | Time | Frames | Scene Name | Core Content & Narrative |
|---|------|--------|------------|--------------------------|
| 01 | 00:00–00:10 | 0–299 (300f) | ChaosPilot Title | "Find the failure. Keep the evidence." Event stream packets converge into the glowing brand core. |
| 02 | 00:10–00:24 | 300–719 (420f) | Order of Events | "The order of events changes everything." Animated packet sequence: new order, fill, duplicate report, reconnect. |
| 03 | 00:24–00:36 | 720–1079 (360f) | Six-Stage Flow | "From a question to a reproduction." 6-stage lifecycle: Brief → Plan → Propose → Execute → Verify → Replay. |
| 04 | 00:36–00:50 | 1080–1499 (420f) | Brief & Requirements | "Start with the system." System overview, behavioral contract, and executable checks locked to pinned revision. |
| 05 | 00:50–01:04 | 1500–1919 (420f) | Prepare Investigation | "Prepare a bounded investigation." Pinned source, brief, contract, and evaluator. Planned vs. exercised states. |
| 06 | 01:04–01:18 | 1920–2339 (420f) | Propose Sequence | "Propose the sequence that tests the assumption." Source-aware negative hypothesis & action steps. |
| 07 | 01:18–01:34 | 2340–2819 (480f) | Execute Fresh State | "Execute from a fresh state." Independent target state, action delivery, and invariant evaluation. |
| 08 | 01:34–01:48 | 2820–3239 (420f) | Invariant Failure | "A duplicate should not count twice." Illustrative trading example: duplicate execution changes used credit again. |
| 09 | 01:48–02:02 | 3240–3659 (420f) | Replay & Compare | "Replay it. Compare it." Side-by-side: candidate fails invariant, clean control reference target passes. |
| 10 | 02:02–02:14 | 3660–4019 (360f) | Chain of Evidence | "Keep the chain of evidence." Saved trace, snapshots, failed check, source identity, replay, and clean comparison. |
| 11 | 02:14–02:26 | 4020–4379 (360f) | Baselines vs Explore | "Known checks. New questions." Deterministic functional baselines (zero AI calls) converge with exploratory runs. |
| 12 | 02:26–02:38 | 4380–4739 (360f) | Synthetic Adapters | "More than one kind of system." Adapters for Trading, Inventory Reservations, and Report Recovery. |
| 13 | 02:38–02:50 | 4740–5099 (360f) | Evidence Boundaries | "Be precise about the evidence." Scripted mocks, unverified prose boundaries, and honest scenario limits. |
| 14 | 02:50–03:00 | 5100–5399 (300f) | Outro & CTA | "Ask what can fail. Leave with a reproduction." Local setup commands and workbench URL. |

---

## Design System

Matched to `public/styles.css`:
- **Background Ground:** `#060a10`
- **Surfaces & Raised:** `#0c131d`, `#162233`
- **Telemetry Accents:** Cyan (`#69c7db`, `#8ad9ea`), Green (`#4fd19b`), Amber (`#d9a84e`), Coral (`#e07a6a`), Violet (`#a996f7`)
- **Typography:**
  - Sans: `Inter`, `Segoe UI`, system sans-serif
  - Monospace: `Cascadia Mono`, `Consolas`, system monospace
  - Headlines: 68–96px, Body: 28–36px, Telemetry: 16–22px

---

## Scripts & Reproducibility

Within this `video/` directory:

Requires Node.js 24+ and npm. Install dependencies first. Remotion downloads its managed browser on the first render if needed. This project was validated on Windows.

```bash
# Install the locked dependencies
npm ci

# Typecheck
npm run typecheck

# Launch Interactive Remotion Studio
npm run studio

# Render Full 1080p MP4 and QA frames
npm run render

# Validate Output Metadata and Frame Decode
npm run validate
```

All generated binaries (`out/chaospilot-overview.mp4`, `out/poster.png`, `out/qa-frames/*.png`) are written to `out/` and ignored by `.gitignore`.

The content follows the [project overview](../README.md) and the product workflow. The diagrams are labelled illustrations. Producing this video makes no live application model calls.

The final export was checked for 180 seconds, 5,400 frames, 1920×1080, 30 fps, H.264, and error-free full decoding. A readable ending and a continuous global timer were verified from rendered frames. `out/validation-report.json` records the output checks.
