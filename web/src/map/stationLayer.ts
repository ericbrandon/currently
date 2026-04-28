// Tide-station overlay: one maplibregl.Marker per station, each rendered
// as an SVG icon whose shape and colour reflect the tide state at the
// current scrubber time.
//
//   - flood (rising):  pentagon, square on top, triangle hanging below
//                      with apex pointing down. Navy fill.
//   - ebb (falling):   pentagon, triangle on top with apex pointing up,
//                      square below. Red fill.
//   - slack (±5 min):  plain square, purple fill.
//
// Each marker also displays the interpolated value (m) inside the square,
// large and bold. A small station-name label sits below the icon.
//
// Per-frame scrub updates mutate marker DOM in place: each marker has all
// three shapes pre-rendered in the SVG, hidden via CSS, and we just swap
// the state class + update the text content / y attribute.

import maplibregl, { type Map as MlMap } from "maplibre-gl";
import type { Extreme, LoadedData } from "../types";
import { tideStateAt, type TideState } from "../interp/valueAt";

// SVG viewBox is 40 wide × 55 tall. The 40×40 square sits centred
// vertically; the triangle occupies the remaining 15 units (above for
// flood, below for ebb). For slack the square is centred (y=7.5..47.5).
const SVG_TEMPLATE = `
<svg viewBox="0 0 40 55" width="48" height="66" preserveAspectRatio="xMidYMid meet">
  <polygon class="shape shape-flood" points="20,0 40,15 40,55 0,55 0,15" />
  <polygon class="shape shape-ebb" points="0,0 40,0 40,40 20,55 0,40" />
  <rect class="shape shape-slack" x="0" y="7.5" width="40" height="40" />
  <text class="value" x="20" y="29" text-anchor="middle" dominant-baseline="middle">—</text>
</svg>`;

/** y-coordinate of the value text for each state (centre of the square). */
const VALUE_Y: Record<TideState, number> = {
  flood: 37,   // square spans 15..55 → centre ~35
  ebb: 22,     // square spans 0..40 → centre ~20
  slack: 29,   // square spans 7.5..47.5 → centre ~27.5
};

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

function createMarkerEl(name: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "tide-marker no-data";
  el.innerHTML = `${SVG_TEMPLATE}<div class="tide-name">${escapeHtml(name)}</div>`;
  return el;
}

function updateMarkerEl(
  el: HTMLElement,
  state: TideState | null,
  value: number | null,
): void {
  el.classList.remove("flood", "ebb", "slack", "no-data");
  const text = el.querySelector("text.value") as SVGTextElement;

  if (state === null) {
    el.classList.add("no-data");
    text.textContent = "—";
    text.setAttribute("y", "29");
    return;
  }

  el.classList.add(state);
  text.textContent = value === null ? "—" : value.toFixed(1);
  text.setAttribute("y", String(VALUE_Y[state]));
}

export class TideStationLayer {
  private map: MlMap;
  private markers: Map<number, maplibregl.Marker> = new Map();
  private elements: Map<number, HTMLElement> = new Map();
  private extremesById: Map<number, Extreme[]>;

  constructor(map: MlMap, data: LoadedData) {
    this.map = map;
    this.extremesById = data.tideExtremesById;

    for (const meta of data.stationsById.values()) {
      if (meta.kind !== "tide-primary" && meta.kind !== "tide-secondary") continue;
      const el = createMarkerEl(meta.name);
      const marker = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat([meta.longitude, meta.latitude]);
      this.markers.set(meta.station_id, marker);
      this.elements.set(meta.station_id, el);
    }
  }

  attach(): void {
    for (const marker of this.markers.values()) marker.addTo(this.map);
  }

  updateAt(t: number): void {
    for (const [id, el] of this.elements) {
      const ext = this.extremesById.get(id);
      if (!ext) continue;
      const { state, value } = tideStateAt(ext, t);
      updateMarkerEl(el, state, value);
    }
  }
}
