# GUI iteration log

This document tracks UI/UX changes to the *Currently* webapp as they're made. The detailed architecture lives in [`app_implementation.md`](app_implementation.md); this file is the running log of decisions on top of it.

When a decision here contradicts `app_implementation.md`, this file wins for the latest entry — `app_implementation.md` should be updated to match if the change is durable.

## 2026-04-28 — Track the arrowhead with the name pill when the arrow points down

When the marker box grew 25% (60→75 px), the name pill stayed anchored at `top: 100% + 2 px` — fine in CSS terms but 15 px farther from the marker centre in absolute terms. For arrows pointing south, that put the name pill noticeably below the visible arrowhead, especially at low speeds where the arrow scales down and its tip retreats from the box edge.

When the bearing is within ±60° of due south (`NAME_TRACK_THRESHOLD_DEG`), [`currentStationLayer.ts`](../web/src/map/currentStationLayer.ts) sets a `name-tracking` class and writes an inline `transform` on the name pill that places it directly below the visible arrowhead — `pill_cx = tip_x`, `pill_top = tip_y + NAME_TIP_GAP_PX`. The gap is a true vertical distance, not a distance along the bearing axis, so diagonal bearings (e.g., 220°, 240°) get the same 7 px breathing room as straight-down ones.

The first attempt (2026-04-28 morning) positioned the pill along the bearing axis at `D = scale × 32.5 + GAP + half_height`. That math treated the pill as a circle — fine at b=180° but wrong for diagonal bearings, where the pill's *vertical* edge (perpendicular to screen y) is what's closest to the tip, not its bearing-axis edge. At b=220° the actual gap was ~1 px instead of the designed 4. Fixed by repositioning relative to the tip's screen coords directly.

Threshold widened from 45° to 60° to catch arrows that "vaguely point down" — at 220–240° the tip reaches sideways far enough to land on top of a horizontally-centred default name pill, so they need tracking too.

A 120 ms `transition: transform` on the tracking-mode rule makes the pill smoothly follow the arrow as the user scrubs through speed changes.

The threshold-discontinuity worry (name jumps when the bearing crosses 120°/240°) is theoretical — flood/ebb directions are fixed station properties and don't change during scrubbing; only their magnitude (and thus scale) varies. A station with bearing 170° stays inside the tracking range forever; the user never sees a discontinuity.

## 2026-04-28 — Push current name pill below the speed pill when the arrow points up

Anticipated in the previous iteration: when a current arrow points within ~45° of due north, the speed pill at the tail lands on top of the station-name pill, which also lives below the marker.

Now: when the bearing is within ±45° of 0°, [`currentStationLayer.ts`](../web/src/map/currentStationLayer.ts) sets a `name-pushed` class on the marker and a CSS rule bumps the name pill's `margin-top` to 14 px so it sits below the speed pill. Outside that range the pill stays at its default 2 px spacing.

The visual reading order when an arrow points roughly north is now: icon → speed pill → name pill, stacked vertically. (Tried flipping the name above first; the user preferred keeping it below.)

`NAME_PUSH_THRESHOLD_DEG = 45` is tuned to the geometry: at ±45° the speed pill is 27 px below centre and the name pill normally starts at 32 px below centre, so they just begin to touch. Past 45°, the speed pill drifts off-axis fast enough that the two pills can coexist below the marker without colliding.

## 2026-04-28 — Tide icons 10% smaller (text unchanged)

Now that current arrows are 25% bigger, the tide markers were dominating the map relatively. Shrunk the icon 10% to rebalance — 25% felt too small in practice.

- SVG render size 48×66 → 43×59 in [`web/src/map/stationLayer.ts`](../web/src/map/stationLayer.ts) (`viewBox` unchanged at 40×55).
- Depth value text and station-name pill both stay at their original sizes (14px / 10px). The text now occupies a slightly larger fraction of the icon than before, which is fine — the depth readout is the load-bearing piece of info on a tide marker, and keeping it readable matters more than preserving the original text-to-icon ratio.

## 2026-04-28 — Drop hollow weak rendering on map markers

CHS flags some current maxima as "weak and variable" (`*` in the PDF). The map marker previously rendered those segments as a hollow arrow (white fill, coloured stroke) so they were visually distinct from a small but normal flood/ebb. With the speed readout now living outside the arrow, the hollow look read more like a desaturated arrow than a meaningful state — the user found it strange to see what looked like a "white-inside red arrow" for any ebb under ~2 kt.

Now: weak segments render as ordinary filled flood/ebb arrows on the map. The small interpolated magnitude already telegraphs uncertainty.

The `weak` distinction is still preserved in [`CurrentChart`](../web/src/ui/CurrentChart.tsx) (label says "weak" rather than "slack"/magnitude) and [`CurrentPanel`](../web/src/ui/CurrentPanel.tsx) ("WEAK" badge), where context makes the distinction useful and unambiguous. Only the marker treatment was dropped.

Removed: `.current-marker.weak` CSS rules, the `weak` class on marker DOM, and the now-unused `weak` param on `updateMarkerEl` in [`currentStationLayer.ts`](../web/src/map/currentStationLayer.ts).

## 2026-04-28 — Bigger current arrows, speed at the tail

Two changes to current-station markers:

1. **Marker box 60×60 → 75×75 px (25% bigger).** Same SVG viewBox; the polygon naturally renders 25% larger at the new size.
2. **Speed readout moved off the arrow body to a small white pill at the arrow's tail.** The pill is positioned along the bearing vector via an inline transform set each scrub frame in [`web/src/map/currentStationLayer.ts`](../web/src/map/currentStationLayer.ts) (`TAIL_OFFSET_PX = 38`, just past the un-scaled arrow tail). It never rotates — text stays upright. For slack and no-data states, the pill stays centred on the circle, since there's no direction.

Why: the centred white-on-arrow readout broke the arrow silhouette and was about to fight harder with the bigger arrow. Moving it to the tail leaves the arrow shape clean, and reads naturally as "speed of where this water is coming from." Pill background mirrors the station-name pill's visual language.

Open thing to watch: at bearing ≈ 0° the speed pill sits below the marker, where the station-name pill also lives. Both render with `pointer-events: none` so they don't intercept clicks, but they may overlap visually. Will revisit if it bothers in practice.

## 2026-04-28 — Hide m/ft toggle when tides are off

The unit toggle only governs tide-height formatting; current speeds are always knots. When `showTides` is `false`, the unit toggle is now hidden entirely (rather than greyed out). Implemented in [`web/src/ui/Controls.tsx`](../web/src/ui/Controls.tsx) by gating the JSX on `showTides.value`.

## 2026-04-28 — Split-diagonal m/ft toggle

The unit toggle in `Controls` now reads as a single button split diagonally: `m` on the left, `ft` on the right, separated by a line tilted ~30° from vertical. The selected unit's half is blue, the other is white. Tapping the button anywhere flips the selection.

Implemented in [`web/src/ui/Controls.tsx`](../web/src/ui/Controls.tsx) (markup) and [`web/src/index.css`](../web/src/index.css) (`.unit-toggle` / `.unit-half`). The diagonal is two `clip-path` polygons that share an edge; the on/off colour contrast draws the line — no separate divider element.

Why: the previous "Feet/Meters" word toggle was visually indistinguishable from the on/off boxes above it (Tides, Currents, Panels), even though it's a binary unit choice rather than an enable/disable. Splitting the button shows both states at once and makes the choice unambiguous.

## 2026-04-28 — Default toggles at launch

**Tides off, currents on by default.**

Implemented in [`web/src/state/store.ts`](../web/src/state/store.ts): `showTides` defaults to `false`, `showCurrents` stays `true`.

Why: currents are the primary use case for the BC boating audience this app targets. Tides are useful but secondary, and showing every tide marker by default crowds the map. Users who want tides can flip the toggle.

Side effect: `app_implementation.md` §8 still lists `showTides: true` as the default and §10.5 still describes `showCurrents` as "intentionally unwired in v1". Both are out of date relative to the code; should be reconciled the next time that doc is touched.
