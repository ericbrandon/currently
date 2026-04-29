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

import {
  showTides,
  showCurrents,
  showPanels,
  useFeet,
} from "../state/store";

export function Controls() {
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
    </div>
  );
}
