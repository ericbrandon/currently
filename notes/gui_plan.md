# GUI iteration log

This document tracks UI/UX changes to the *Currently* webapp as they're made. The detailed architecture lives in [`app_implementation.md`](app_implementation.md); this file is the running log of decisions on top of it.

When a decision here contradicts `app_implementation.md`, this file wins for the latest entry — `app_implementation.md` should be updated to match if the change is durable.

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
