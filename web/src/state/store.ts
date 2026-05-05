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
//   - `THUMB_FRACTION` is a constant decided at module load: 3/15
//     (3 h past, 12 h future) on standard viewports, 4/15 (4 h past,
//     11 h future) on narrow viewports (< 500 px) so the date/time
//     pill centred above the thumb has room on the left edge instead
//     of clipping. Not reactive to resize — phones don't usually
//     change width, and the iPad's 595 px doesn't cross the threshold.
//   - `scrubberMs` is computed from those and is what the rest of the
//     app reads.

import { signal, computed, effect } from "@preact/signals";
import type { LoadedData, Manifest } from "../types";

export const manifest = signal<Manifest | null>(null);
export const loadedData = signal<LoadedData | null>(null);

// Scrubber constants.
export const STEP_MS = 15 * 60 * 1000;                 // visual tick spacing
export const WINDOW_MS = 15 * 60 * 60 * 1000;          // 15-hour visible window
export const THUMB_FRACTION =
  typeof window !== "undefined" && window.innerWidth < 500 ? 4 / 15 : 3 / 15;

export const windowStartMs = signal<number>(
  Date.now() - THUMB_FRACTION * WINDOW_MS,
);

/** Absolute UTC ms of the moment currently being displayed (under the thumb). */
export const scrubberMs = computed(
  () => windowStartMs.value + THUMB_FRACTION * WINDOW_MS,
);

export const selectedStationId = signal<string | null>(null);

/** Scrubber range derived from the loaded data; null while loading. */
export const scrubberRange = computed(() => {
  const v = loadedData.value;
  return v ? v.scrubberRangeMs : null;
});

function setWindowStartClamped(t: number): void {
  const r = scrubberRange.value;
  if (r) {
    const min = r.min - THUMB_FRACTION * WINDOW_MS;
    const max = r.max - THUMB_FRACTION * WINDOW_MS;
    if (t < min) t = min;
    else if (t > max) t = max;
  }
  windowStartMs.value = t;
}

/** Set windowStartMs, clamping so the thumb's instant stays inside the
 *  loaded data range, and clear the now-lock — any user-initiated pan
 *  ends the lock. Range may be null while loading; in that case the
 *  caller's value passes through unclamped. */
export function panWindowTo(t: number): void {
  setWindowStartClamped(t);
  nowLocked.value = false;
}

/** Place the instant `t` exactly under the thumb. */
export function recenterAt(t: number): void {
  panWindowTo(t - THUMB_FRACTION * WINDOW_MS);
}

// "Now" lock: while true, the timeline advances once per wall-clock
// minute so real-world "now" stays under the thumb (the red now-dot is
// then visually obscured by the blue thumb). Engaged by the Now button;
// cleared by any call to panWindowTo (i.e. any user pan on the scrubber
// or panel).
//
// Ticking is aligned to the next minute boundary (rather than 60 s after
// engagement) so the displayed HH:MM in the scrubber updates in sync
// with the wall clock instead of lagging by up to a minute.
export const nowLocked = signal<boolean>(false);

let nowLockTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleNextNowLockTick(): void {
  const msUntilNextMinute = 60_000 - (Date.now() % 60_000);
  nowLockTimer = setTimeout(() => {
    setWindowStartClamped(Date.now() - THUMB_FRACTION * WINDOW_MS);
    if (nowLocked.value) scheduleNextNowLockTick();
  }, msUntilNextMinute);
}
effect(() => {
  if (nowLocked.value) {
    setWindowStartClamped(Date.now() - THUMB_FRACTION * WINDOW_MS);
    if (nowLockTimer === null) scheduleNextNowLockTick();
  } else if (nowLockTimer !== null) {
    clearTimeout(nowLockTimer);
    nowLockTimer = null;
  }
});

// User-facing toggles surfaced via the Controls panel in the top-right.
// Persisted across sessions in localStorage so the user's last choice
// sticks on reload.
//   - showTides: render and update tide-station markers (off → markers
//     hidden via a class on the map container; per-frame interpolation
//     is also skipped to save CPU).
//   - showCurrents: same, for current-station markers.
//   - useFeet: format every tide height in feet instead of metres.
function persistedBoolean(key: string, defaultValue: boolean) {
  let initial = defaultValue;
  try {
    const v = localStorage.getItem(key);
    if (v === "0" || v === "1") initial = v === "1";
  } catch {
    // Private mode / storage disabled — fall through with the default.
  }
  const s = signal<boolean>(initial);
  effect(() => {
    try {
      localStorage.setItem(key, s.value ? "1" : "0");
    } catch {
      // Same — we silently drop the write.
    }
  });
  return s;
}

export const showTides = persistedBoolean("pref-show-tides", false);
export const showCurrents = persistedBoolean("pref-show-currents", true);
export const useFeet = persistedBoolean("pref-use-feet", true);

// Per-selection table visibility. The table (TidePanel / CurrentPanel)
// only opens when the user explicitly taps the "Table" handle on the
// chart. Resets to false whenever the selected station changes — opening
// a new station starts with the chart only, never with the table.
export const tableOpen = signal<boolean>(false);
effect(() => {
  // Subscribe to selectedStationId; the body resets tableOpen but doesn't
  // read it, so there's no feedback loop.
  selectedStationId.value;
  tableOpen.value = false;
});

// Terms-of-Use gate. Acceptance is recorded in localStorage under a
// versioned key — bump TOS_VERSION any time the terms change materially
// so existing users are re-prompted (see notes/TOS.md §6).
export const TOS_VERSION = "v1.1";
const TOS_STORAGE_KEY = `tos-accepted-${TOS_VERSION}`;

function readTosAccepted(): boolean {
  try {
    return localStorage.getItem(TOS_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export const tosAccepted = signal<boolean>(readTosAccepted());

export function acceptTos(): void {
  try {
    localStorage.setItem(
      TOS_STORAGE_KEY,
      JSON.stringify({
        version: TOS_VERSION,
        acceptedAt: new Date().toISOString(),
      }),
    );
  } catch {
    // Private-mode / storage-disabled: the click still counts for this
    // session, but the user will be re-prompted next visit.
  }
  tosAccepted.value = true;
}

// Live user-location overlay (Google-Maps-style blue dot).
//   - userLocationActive: a watchPosition is running and the marker is shown.
//   - userLocationFollowing: the map recenters on each position update.
//     Decoupled from `active` so the user can pan away (which clears
//     `following` but leaves the dot rendered) and re-engage following by
//     tapping the icon again.
//   - userLocation: latest fix from the Geolocation API; null until the
//     first reading or after the watcher stops.
export const userLocationActive = signal<boolean>(false);
export const userLocationFollowing = signal<boolean>(false);
export const userLocation = signal<{ lat: number; lon: number } | null>(null);

// Info modal: copyright/contact + basemap and data attributions. Opened
// from the "i" button in the Controls panel; dismissed by tapping the
// backdrop, the close button, or pressing Escape.
export const infoModalOpen = signal<boolean>(false);
