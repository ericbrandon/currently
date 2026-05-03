# GUI iteration log

This document tracks UI/UX changes to the *Currently* webapp as they're made. The detailed architecture lives in [`app_implementation.md`](app_implementation.md); this file is the running log of decisions on top of it.

When a decision here contradicts `app_implementation.md`, this file wins for the latest entry — `app_implementation.md` should be updated to match if the change is durable.

## 2026-05-03 — Two-step chart dismiss; left-swipe on table dismisses table only

Two related changes that align dismissal gestures with their natural granularity.

**Chevron two-step.** Tapping the downward chevron at the top of the chart panel previously closed the chart in one tap, even when the table was open underneath. Users expected the more recently-opened thing (the table) to be what closed first. Now in [`Scrubber.tsx`](../web/src/ui/Scrubber.tsx): if `tableOpen.value` is true, the first tap of the chevron sets `tableOpen.value = false`; only when the table is already closed does the next tap clear `selectedStationId`. The button's `aria-label` flips between "Close table" and "Close chart" so screen readers track the same two-step. Map-tap and the chart-area swipe-down gesture (both already in place) are unchanged — they still clear the station in one step.

**Left-swipe on table.** Previously the panel-gesture handler in [`panelGestures.ts`](../web/src/ui/panelGestures.ts) cleared `selectedStationId` on a left flick, which closed the chart along with the table. Now it sets `tableOpen.value = false` only — the chart stays open. Other dismissal paths (chevron two-step, map tap, chart-area swipe-down) are untouched.

Together the rule is: tapping or swiping *the table* dismisses the table; tapping the map / chart-area swipe-down / multi-tap-the-chevron dismisses the station entirely.

**iOS hover stickiness fix.** Hover styles on `.chart-close` and `.table-open` were rgba-with-low-alpha — fine on desktop, but iOS Safari sticks `:hover` after a tap, leaving the chevron looking translucent for a beat after the first dismiss tap of the new two-step. Wrapped both `:hover` rules in `@media (hover: hover)` in [`index.css`](../web/src/index.css) so they only activate on devices that actually hover.

## 2026-05-03 — Always-visible date/time pill above the thumb; removed from title; mobile-responsive layout

Old: the scrubber's title row showed a `formatScrubber(ms)` text label ("Sat, May 2 at 13:25") next to the station-name pill. Tide and current charts each rendered a separate "13:25  2.9 kt" pill above the thumb when a station was selected. Two readouts of "now under the thumb", redundant content (both showed time), and inconsistent format (only one had a date).

New: title shows the station-name pill alone. The date/time pill lives directly above the blue thumb at all times, and the thumb-vline always drops from pill to dot — same metaphor whether or not a chart is open:

- **No chart**: a small `.scrubber-thumb-pill-area` slot in [`Scrubber.tsx`](../web/src/ui/Scrubber.tsx) (above the timeline track inside `scrubber-main`) hosts a blue pill with `formatThumb(ms)` ("Sat, May 2 13:25").
- **Tide / current chart**: the existing chart-thumb pill at top of the chart now reads `formatThumb(ms)` followed by the value ("Sat, May 2 13:25  2.9 kt") — same vline, deeper content.

A new compact `formatThumb` in [`util/time.ts`](../web/src/util/time.ts) joins date and time with a single space; en-CA's default joiner inserts "at" between the two formatted parts, which felt too chatty for a pill. Pill font bumped 13 → 14 px after side-by-side.

**Narrow-viewport adjustments** (decided once at module load — phones don't change width, and an iPad at zoom-induced 595 px doesn't cross either threshold):

1. **Below 600 px**: the chart-mode pill stacks into two rows — date/time on top, value below — via `display: flex; flex-direction: column` in the existing `@media (max-width: 600px)` block in [`index.css`](../web/src/index.css). The `{" "}` text node between time and value spans was removed from JSX so flex column doesn't generate an empty middle row from the whitespace. Value row is also bumped to `font-weight: 700` and `opacity: 1` to match the time row, since the inline form's typographic hierarchy (bold time + lighter value) doesn't read as well stacked.

2. **Below 500 px**: `THUMB_FRACTION` becomes `4/15` instead of `3/15`, shifting the thumb from 20% to ~26.7% of the track. Decided in [`store.ts`](../web/src/state/store.ts) at module load via `window.innerWidth < 500 ? 4/15 : 3/15`. Without this, the centred pill would clip off the left edge on phones (an iPhone 12 Pro at 390 px gives only ~78 px of left-side budget at 20%, less than half the stacked pill's width). Cost: 4 h of past + 11 h of future instead of 3 h + 12 h. Not reactive to resize — keeping it static avoids `windowStartMs` recalibration on every viewport change.

One iPad surprise worth noting: the test iPad Mini 7 reported `window.innerWidth: 595` despite a 744 px native CSS viewport. Cause: Settings → Safari → Page Zoom at 125% (744 / 1.25 ≈ 595). The 600 px breakpoint was firing legitimately at that zoom — left intact, since users at zoomed iPad still benefit from the stacked pill.

## 2026-05-03 — Now-lock: cadence reduced to wall-clock minute; current-marker transitions suppressed; smaller red dot

Refinements on top of the initial now-lock implementation (entry below). Three issues with the 1 Hz tick:

1. **Visible per-second pulse on every current marker.** Current-marker SVG transforms have `transition: transform 120ms ease-out` so they glide smoothly while the user scrubs. Each lock-tick changed the transform → fired a fresh 120 ms transition → 880 ms of nothing → repeat. Read as a "breathing" pulse on every current arrow once a second.

2. **Wasted idle CPU.** A locked tab ran the full chain (`setInterval` → `windowStartMs` mutate → `scrubberMs` recompute → effect → rAF → `updateAt(t)` for both layers → DOM transforms on every in-view marker) once per second, for current values that change minute-to-minute.

3. **Red lock-dot was 1 px too big.** Cosmetic.

Three fixes:

- **Lock cadence reduced to 1/min, aligned to wall-clock minute boundary.** Replaced `setInterval(1000)` with a self-rescheduling `setTimeout` in [`store.ts`](../web/src/state/store.ts) that fires at the next minute boundary (`60_000 - (Date.now() % 60_000)` ms from now). Result: idle work drops ~60×, and the visible `HH:MM` pill flips in lockstep with the wall clock instead of lagging by up to a minute (which a plain `setInterval(60_000)` would do, since the first tick would land 60 s after the lock engagement, not at the next minute boundary).

- **Current-marker transitions suppressed while locked.** A `.now-locked` class is toggled on the map container by an effect in [`app.tsx`](../web/src/app.tsx) reading `nowLocked.value`. CSS in [`index.css`](../web/src/index.css) overrides `transition: none` on `.current-arrow`, `.current-value`, and `.current-marker.name-tracking .current-name` only when that class is present. Pan/zoom uses MapLibre's own marker positioning (not the SVG transforms we suppress), so disabling them mid-lock has no effect on map gestures. Per-tick changes are now small instant snaps once a minute — preferred over a 120 ms "jerk" through ~60 s of marker change. (Alternative considered: rAF-pace `windowStartMs` so the existing 120 ms transition smooths sub-pixel steps. Rejected because it's the opposite direction from the per-minute idle-work goal.)

- **Lock-dot 8 → 7 px** in `.scrubber-thumb.is-locked::after`.

## 2026-05-03 — Now-lock: blue thumb pins to "now"; timeline slides under it

Old "Now" behaviour: tap snapped `windowStartMs` so real-world now sat under the thumb, but the red now-dot then drifted right while the blue thumb stayed put — within a minute or two the user was looking at past time and didn't realise it.

New: tap "Now" sets a `nowLocked` signal. While locked, a 1-second `setInterval` in [`store.ts`](../web/src/state/store.ts) shifts `windowStartMs` so `Date.now() - THUMB_FRACTION * WINDOW_MS` stays the left edge — the blue thumb is fixed at THUMB_FRACTION on the track, so as wall time advances the timeline slides leftward under it. The red now-dot is hidden while locked (it'd be obscured by the thumb anyway, and the 1-min vs 1-s update cadence mismatch would otherwise let it creep visibly out from behind the thumb between minute ticks).

Lock indicator: `.scrubber-thumb.is-locked::after` paints an 8 px red dot in the centre of the blue thumb. The metaphor is literal — the red now-dot is captured inside the thumb. Earlier iteration used a red border + soft red glow, but the fading-edge red ring read as a warning/error state; a centred red dot has none of that and reuses the same visual vocabulary the unlocked now-dot already established.

Lock release: `panWindowTo` now sets `nowLocked = false` as a side-effect, so any user-initiated pan — scrubber drag, scrubber wheel, panel drag, panel wheel — clears the lock automatically. The lock-effect's own writes call a private `setWindowStartClamped` instead, so they don't release themselves. The 1-second cadence is fine cost-wise (mid-pixel sub-frame movement; markers re-update via the existing rAF coalescer).

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
