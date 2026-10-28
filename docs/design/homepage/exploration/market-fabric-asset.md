# Market fabric background asset

- Asset: `public/assets/homepage/market-fabric.png`
- Built-in provenance: generated with the built-in `image_gen.imagegen` tool; no API or CLI fallback.
- Reference: `docs/design/homepage/exploration/option-1-exchange-fabric.png` (1487 × 1058), supplied through `referenced_image_paths`.
- Generated source: `C:/Users/sdyer/.codex/generated_images/01a17fab-603f-7cf3-bf2d-b1d21021cac9/exec-fca6470d-80ea-49b0-a24b-7a485df8e9ab.png`
- Actual dimensions: **1511 × 1041 pixels**, 24-bit RGB PNG, opaque.
- Requested dimensions: 1487 × 1058; the built-in generator returned 1511 × 1041. The copied asset preserves that output without resampling.
- Inspection: clean financial-market plate with dark upper-left space, candlesticks, order book and depth chart at the right, lower-right volume bars, quiet lower band and footer. Foreground webpage UI and luminous event-network graphics are absent.
- The generated source was copied without overwriting an existing asset.

## Exact prompt

```text
Use case: precise-object-edit
Asset type: full-bleed raster background plate for a homepage, desired output 1487 × 1058 pixels, same proportions and framing as the supplied reference, opaque with no transparency.
Input image 1 is the exact chosen composition reference. Reconstruct only its quiet financial-market background, completely removing all foreground webpage UI and all luminous event-network graphics.
Primary request: preserve the reference's near-black navy palette, faint cyan/teal and muted red chart marks, subtle grid, restrained contrast, exact chart placement and generous dark negative space. Make this a faithful clean background plate, not a new design.
Composition: upper-left x0–47%, y0–48% must be almost empty near-black navy, with only extremely faint grid texture, ready for readable hero typography. In the upper/middle x50–64% region, retain a subtle fictional financial candlestick chart and tiny low-contrast numerical ticks. At x64–82% upper right, retain the fictional order-book BID/ASK columns, tiny dim teal and muted red numbers on navy. At x83–98% upper right, retain the faint stepped market-depth chart. Preserve subtle lower-right volume bars. Sprinkle very sparse tiny ticker fragments and a faint precise orthogonal market grid, integrated unobtrusively into the background. The band x0–100%, y48–74% must be primarily dark and quiet, ready for separately animated paths; do not include paths. Footer y74–100% is dark with restrained fine navy texture and very faint grid detail.
Remove every foreground element: brand logo, navigation, header, headline, subtitle, body copy, buttons, floating labels, event details, controls, horizontal UI separators, numbered steps, footer copy, any interface cards, and all network lines, cyan/amber/red flowing light paths, glowing packet squares and particle bursts.
Constraints: financial numbers/chart text may remain fictional and faint because it is background texture. Maintain the financial chart composition and palette of the reference; do not invent a central object. Full bleed with no borders, no padding, no watermark, no transparency.
Avoid: UI, branding, header, headline, buttons, floating labels, crystal, central object, network lines, glowing packet squares, smoke, fog, dramatic atmosphere, bright gradients, excessive glow, large foreground typography.
```
