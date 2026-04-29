// Always-visible controls panel pinned to the top-right of the map.
//
// Boxes (top to bottom):
//   - Tides     on/off — show tide-station markers.
//   - Currents  on/off — show current-station markers.
//   - Panels    on/off — show TidePanel/CurrentPanel when a station is
//               selected. Default off; the panel covers a chunk of the
//               map on phones, so the user opts in.
//   - m / ft    binary — formatting unit for every tide height.
//               Rendered as a split-diagonal toggle: the selected unit's
//               half is blue. Clicking anywhere on the box flips it.
//               Hidden when tides are off (currents are in knots and
//               don't use this setting).
//   - location  three-state, sits below the others as a square icon-only
//               button:
//                 inactive  → black icon, geolocation off, no marker.
//                 active    → blue outline icon, dot on map, but the user
//                             has panned so the camera is no longer
//                             following.
//                 following → filled-blue icon, dot on map, camera
//                             recenters on every position update.
//               Tap cycles: off → following; following → off; active → following.

import {
  showTides,
  showCurrents,
  showPanels,
  useFeet,
  userLocationActive,
  userLocationFollowing,
} from "../state/store";

function onLocationClick() {
  if (!userLocationActive.value) {
    userLocationActive.value = true;
    userLocationFollowing.value = true;
  } else if (!userLocationFollowing.value) {
    userLocationFollowing.value = true;
  } else {
    userLocationActive.value = false;
    userLocationFollowing.value = false;
  }
}

export function Controls() {
  const locActive = userLocationActive.value;
  const locFollowing = userLocationFollowing.value;
  const locClass = locFollowing ? "following" : locActive ? "active" : "";
  const locLabel = locFollowing
    ? "Stop showing your location"
    : locActive
      ? "Recenter on your location"
      : "Show your location";

  return (
    <div class="controls">
      <button
        class={`control-box ${showTides.value ? "on" : "off"}`}
        onClick={() => { showTides.value = !showTides.value; }}
      >
        Tides
      </button>
      <button
        class={`control-box ${showCurrents.value ? "on" : "off"}`}
        onClick={() => { showCurrents.value = !showCurrents.value; }}
      >
        Currents
      </button>
      <button
        class={`control-box ${showPanels.value ? "on" : "off"}`}
        onClick={() => { showPanels.value = !showPanels.value; }}
      >
        Panels
      </button>
      {showTides.value && (
        <button
          class="control-box unit-toggle"
          onClick={() => { useFeet.value = !useFeet.value; }}
          aria-label={useFeet.value ? "Switch to meters" : "Switch to feet"}
        >
          <span class={`unit-half left ${useFeet.value ? "off" : "on"}`}>m</span>
          <span class={`unit-half right ${useFeet.value ? "on" : "off"}`}>ft</span>
        </button>
      )}
      <button
        class={`control-box location ${locClass}`}
        onClick={onLocationClick}
        aria-label={locLabel}
        title={locLabel}
      >
        <LocationIcon filled={locFollowing} />
      </button>
    </div>
  );
}

// "My location" crosshair glyph. Outline form when not following so the
// hollow centre reads as the dot waiting to lock; filled centre once
// following so it visually echoes the live dot on the map.
function LocationIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="7" />
      <line x1="12" y1="1" x2="12" y2="4" />
      <line x1="12" y1="20" x2="12" y2="23" />
      <line x1="1" y1="12" x2="4" y2="12" />
      <line x1="20" y1="12" x2="23" y2="12" />
      {filled
        ? <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
        : <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />}
    </svg>
  );
}
