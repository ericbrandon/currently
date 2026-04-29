# GUI iteration log

This document tracks UI/UX changes to the *Currently* webapp as they're made. The detailed architecture lives in [`app_implementation.md`](app_implementation.md); this file is the running log of decisions on top of it.

When a decision here contradicts `app_implementation.md`, this file wins for the latest entry — `app_implementation.md` should be updated to match if the change is durable.

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
