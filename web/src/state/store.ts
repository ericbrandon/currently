// Global app state.
//
// The scrubber is a 15-hour *windowed* view, not a full-year slider.
// The thumb sits at a fixed visual position — `THUMB_FRACTION` of the
// way across the track — and the user pans the timeline content
// underneath it via drag, wheel, or touch. So:
//
//   - `windowStartMs` is the absolute UTC ms at the left edge of the
//     visible scrubber window. The Scrubber mutates it (via panWindowTo)
//     in response to user input.
//   - `THUMB_FRACTION` is a constant: 0.2, placing the thumb three hours
//     from the left edge with twelve hours of forecast space to the right
//     — useful for boaters planning a trip.
//   - `scrubberMs` is computed from those and is what the rest of the
//     app reads.

import { signal, computed } from "@preact/signals";
import type { LoadedData, Manifest } from "../types";

export const manifest = signal<Manifest | null>(null);
export const loadedData = signal<LoadedData | null>(null);

// Scrubber constants.
export const STEP_MS = 15 * 60 * 1000;                 // visual tick spacing
export const WINDOW_MS = 15 * 60 * 60 * 1000;          // 15-hour visible window
export const THUMB_FRACTION = 3 / 15;                  // 3 h past, 12 h future

export const windowStartMs = signal<number>(
  Date.now() - THUMB_FRACTION * WINDOW_MS,
);

/** Absolute UTC ms of the moment currently being displayed (under the thumb). */
export const scrubberMs = computed(
  () => windowStartMs.value + THUMB_FRACTION * WINDOW_MS,
);

export const selectedStationId = signal<number | null>(null);

/** Scrubber range derived from the loaded data; null while loading. */
export const scrubberRange = computed(() => {
  const v = loadedData.value;
  return v ? v.scrubberRangeMs : null;
});

/** Set windowStartMs, clamping so the thumb's instant stays inside the
 *  loaded data range. Range may be null while loading; in that case the
 *  caller's value passes through unclamped. */
export function panWindowTo(t: number): void {
  const r = scrubberRange.value;
  if (r) {
    const min = r.min - THUMB_FRACTION * WINDOW_MS;
    const max = r.max - THUMB_FRACTION * WINDOW_MS;
    if (t < min) t = min;
    else if (t > max) t = max;
  }
  windowStartMs.value = t;
}

/** Place the instant `t` exactly under the thumb. */
export function recenterAt(t: number): void {
  panWindowTo(t - THUMB_FRACTION * WINDOW_MS);
}

// User-facing toggles surfaced via the Controls panel in the top-right.
//   - showTides: render and update tide-station markers (off → markers
//     hidden via a class on the map container; per-frame interpolation
//     is also skipped to save CPU).
//   - showCurrents: same, for current-station markers.
//   - showPanels: render the 5-day TidePanel when a tide station is
//     selected. Off → station selection still works (the chart still
//     appears in the scrubber) but the side panel stays hidden.
//   - useFeet: format every tide height in feet instead of metres.
export const showTides = signal<boolean>(false);
export const showCurrents = signal<boolean>(true);
export const showPanels = signal<boolean>(false);
export const useFeet = signal<boolean>(true);
