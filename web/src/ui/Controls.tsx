// Always-visible controls panel pinned to the top-right of the map.
//
// Four equally-sized boxes:
//   - Tides           on/off — show tide-station markers.
//   - Currents        on/off — reserved for current overlay (no-op v1).
//   - 5 Day Panels    on/off — show TidePanel when a tide station is selected.
//   - Feet / Meters   binary — formatting unit for every tide height.
//
// Each box reflects its signal state via `.on` / `.off` classes — the
// unit toggle reuses the same styling, with Feet rendered as "on".

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
      <button
        class={`control-box ${useFeet.value ? "on" : "off"}`}
        onClick={() => { useFeet.value = !useFeet.value; }}
      >
        {useFeet.value ? "Feet" : "Meters"}
      </button>
    </div>
  );
}
