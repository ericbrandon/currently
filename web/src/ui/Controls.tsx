// Always-visible controls panel pinned to the top-right of the map.
//
// Four equally-sized boxes:
//   - Tides           on/off — show tide-station markers.
//   - Currents        on/off — show current-station markers.
//   - 5 Day Panels    on/off — show TidePanel when a tide station is selected.
//   - m / ft          binary — formatting unit for every tide height.
//                     Rendered as a split-diagonal toggle: the selected unit's
//                     half is blue. Clicking anywhere on the box flips it.
//                     Hidden when tides are off (currents are in knots and
//                     don't use this setting).

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
        5 Day Panels
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
