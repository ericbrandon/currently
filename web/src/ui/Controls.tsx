// Always-visible controls panel pinned to the top-right of the map.
//
// Boxes (top to bottom):
//   - Tides     on/off — show tide-station markers.
//   - Currents  on/off — show current-station markers.
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

import { useState } from "preact/hooks";
import {
  showTides,
  showCurrents,
  useFeet,
  userLocationActive,
  userLocationFollowing,
  infoModalOpen,
  showWeather,
  usWeatherData,
  weatherData,
  weatherEverEnabled,
  weatherHasActiveAlert,
  weatherOnline,
} from "../state/store";
import { refreshMarineForecast } from "../data/marineForecast";

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

// Weather button. Three visual states on top of the shared on/off pair:
//   - offline (grey): the last forecast refresh failed. Still tappable —
//     as an iPhone home-screen app there is no reload button, so the grey
//     button doubles as the manual "retry now" affordance. A failed retry
//     shakes the button briefly as feedback.
//   - alert dot: layer off but an active warning/watch exists in the data
//     (only possible when polling, i.e. the user has used weather before).
function WeatherButton() {
  const [shaking, setShaking] = useState(false);

  const offline = weatherEverEnabled.value && !weatherOnline.value;
  const on =
    showWeather.value &&
    (weatherData.value !== null || usWeatherData.value !== null);
  const showAlertDot = !showWeather.value && weatherHasActiveAlert.value;

  const onClick = () => {
    if (offline) {
      // Manual retry. Success un-greys via the signals; keep the user's
      // intent to see the layer so it appears as soon as data lands.
      showWeather.value = true;
      void refreshMarineForecast().then((ok) => {
        if (!ok) {
          setShaking(true);
          setTimeout(() => setShaking(false), 500);
        }
      });
      return;
    }
    const next = !showWeather.value;
    showWeather.value = next;
    // First-ever enable (or enable with a source missing): fetch right
    // away. initMarineWeather's poll covers the rest.
    if (next && (weatherData.value === null || usWeatherData.value === null)) {
      void refreshMarineForecast();
    }
  };

  return (
    <button
      class={
        `control-box weather ${on ? "on" : "off"}` +
        (offline ? " offline" : "") +
        (showAlertDot ? " has-alert" : "") +
        (shaking ? " shake" : "")
      }
      onClick={onClick}
      aria-label={
        offline
          ? "Weather unavailable — tap to retry"
          : on
            ? "Hide marine weather"
            : "Show marine weather"
      }
    >
      Weather
    </button>
  );
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
      <WeatherButton />
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
      <button
        class="control-box info"
        onClick={() => { infoModalOpen.value = true; }}
        aria-label="About this site"
        title="About this site"
      >
        <InfoIcon />
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

function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <circle cx="12" cy="7.5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
