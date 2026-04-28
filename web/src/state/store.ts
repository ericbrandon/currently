// Global app state.
//
// The scrubber is a 15-hour *windowed* view, not a full-year slider:
//
//   - `windowStartMs` is the absolute UTC ms at the left edge of the visible
//     scrubber window. It changes when the labels pan (edge-pan, ±1h/±1d
//     buttons, "Now"). It is always snapped to the 15-min grid.
//   - `thumbFraction` is the thumb's position within the window, 0..1.
//     It changes when the user drags the thumb. Default 0.2 (3/15) places
//     "now" three hours from the left, leaving twelve hours of forecast
//     space to the right — useful for boaters planning a trip.
//   - `scrubberMs` is computed from those two and is what the rest of the
//     app reads. Snapped to STEP_MS so the map only re-renders on quarter-
//     hour transitions.

import { signal, computed } from "@preact/signals";
import type { LoadedVolume, Manifest } from "../types";

export const manifest = signal<Manifest | null>(null);
export const activeVolume = signal<string>("5");
export const loadedVolume = signal<LoadedVolume | null>(null);

// Scrubber constants.
export const STEP_MS = 15 * 60 * 1000;                 // visual tick spacing
export const WINDOW_MS = 15 * 60 * 60 * 1000;          // 15-hour visible window
export const DEFAULT_THUMB_FRACTION = 3 / 15;          // 3 h past, 12 h future

// Note: scrubberMs is *not* snapped to STEP_MS. STEP_MS is only the
// visual tick spacing on the timeline; the thumb may sit anywhere along
// it, and "Now" / initial load resolve to the exact current instant.

export const windowStartMs = signal<number>(
  Date.now() - DEFAULT_THUMB_FRACTION * WINDOW_MS,
);
export const thumbFraction = signal<number>(DEFAULT_THUMB_FRACTION);

/** Absolute UTC ms of the moment currently being displayed. */
export const scrubberMs = computed(
  () => windowStartMs.value + thumbFraction.value * WINDOW_MS,
);

/** Move the displayed instant to `t` while keeping the thumb fraction stable
 *  (the labels visually pan rather than the thumb jumping). */
export function setScrubberMs(t: number): void {
  windowStartMs.value = t - thumbFraction.value * WINDOW_MS;
}

/** Reset the thumb to its default position with `t` aligned to it exactly. */
export function recenterAt(t: number): void {
  thumbFraction.value = DEFAULT_THUMB_FRACTION;
  windowStartMs.value = t - DEFAULT_THUMB_FRACTION * WINDOW_MS;
}

export const selectedStationId = signal<number | null>(null);

/** Scrubber range derived from the loaded volume; null while loading. */
export const scrubberRange = computed(() => {
  const v = loadedVolume.value;
  return v ? v.scrubberRangeMs : null;
});
