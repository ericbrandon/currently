// Current-station overlay: one maplibregl.Marker per primary current
// station, rendered as an arrow that rotates to the live flow direction
// and scales with the absolute current strength.
//
//   - flood (v > 0):  arrow rotated to flood_direction_true, navy fill.
//   - ebb   (v < 0):  arrow rotated to ebb_direction_true,  red  fill.
//   - slack (|v| < 0.1 kt): non-rotated circle, purple fill.
//
// Weak/variable max events (where CHS has flagged the peak as too
// variable to publish a magnitude) are rendered as ordinary flood/ebb
// arrows on the map — the small interpolated magnitude already conveys
// uncertainty, and a separate visual treatment was confusing here. The
// distinction is preserved in the chart and side panel.
//
// The numeric speed (kt, absolute) sits in a non-rotated pill positioned
// just beyond the arrow's tail (i.e., on the opposite side of the
// station from where the flow is heading). The pill itself never
// rotates so the digits stay upright; we just translate it along the
// bearing vector from the marker centre. For slack / no-data, the pill
// sits centred on the marker since there's no direction. Mirrors
// TideStationLayer in structure: per-frame scrub updates mutate marker
// DOM in place.

import maplibregl, { type Map as MlMap } from "maplibre-gl";
import { effect } from "@preact/signals";
import type { Extreme, LoadedData, StationMeta } from "../types";
import { currentStateAt, type CurrentState } from "../interp/valueAt";
import { selectedStationId } from "../state/store";
import { formatCurrentValue } from "../util/units";

// SVG layout: 60×60 viewBox. The arrow points "up" (toward 0° = north)
// in its un-rotated form, so a CSS `rotate(deg)` lands the head at the
// true bearing. The slack circle sits centred and is shown when |v|<0.1.
const ARROW_POINTS = "30,4 50,26 38,26 38,54 22,54 22,26 10,26";
const SVG_TEMPLATE = `
<svg class="current-arrow" viewBox="0 0 60 60" width="60" height="60" preserveAspectRatio="xMidYMid meet">
  <polygon class="shape shape-arrow" points="${ARROW_POINTS}" />
  <circle  class="shape shape-slack" cx="30" cy="30" r="16" />
</svg>`;

/** Reference magnitude used to scale the arrow size. At |v| ≥ this, the
 *  arrow renders at full size; below it scales linearly down to MIN_SCALE.
 *  8 kt is a comfortable mid-range that keeps Sechelt's 16 kt visually
 *  distinct from Juan-de-Fuca's ~3 kt without losing weak-flow stations. */
const REF_KNOTS = 8;
const MIN_SCALE = 0.45;

/** Distance in CSS px from the marker centre at which the speed pill is
 *  placed when the arrow has a direction (flood/ebb). Sized to sit
 *  just past the un-scaled arrow tail (which is at 30 px from centre at
 *  the marker's 75 px box) — independent of the arrow's per-frame scale,
 *  so the pill doesn't pop around as the speed ramps. */
const TAIL_OFFSET_PX = 38;

function arrowScale(absKnots: number): number {
  const r = Math.min(absKnots / REF_KNOTS, 1);
  return MIN_SCALE + (1 - MIN_SCALE) * r;
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

function createMarkerEl(name: string, kindClass: "primary" | "secondary"): HTMLElement {
  const el = document.createElement("div");
  el.className = `current-marker ${kindClass} no-data`;
  el.innerHTML =
    `${SVG_TEMPLATE}` +
    `<div class="current-value">—</div>` +
    `<div class="current-name">${escapeHtml(name)}</div>`;
  return el;
}

/** Below this zoom level, secondary-current markers are hidden. Mirrors
 *  the same threshold used for secondary-tide markers in stationLayer.ts. */
const SECONDARY_MIN_ZOOM = 8;

function updateMarkerEl(
  el: HTMLElement,
  meta: StationMeta,
  state: CurrentState | null,
  value: number | null,
): void {
  el.classList.remove("flood", "ebb", "slack", "no-data");
  const valueEl = el.querySelector(".current-value") as HTMLElement;
  const svg = el.querySelector("svg.current-arrow") as SVGSVGElement;

  if (state === null || value === null) {
    el.classList.add("no-data");
    valueEl.textContent = "—";
    valueEl.style.transform = "translate(-50%, -50%)";
    svg.style.transform = `rotate(0deg) scale(${MIN_SCALE})`;
    return;
  }

  el.classList.add(state);
  valueEl.textContent = formatCurrentValue(value);

  // Direction: flood bearing for flood, ebb bearing for ebb. Slack has no
  // direction — leave the rotation at 0 since the slack circle is shown
  // in place of the arrow anyway.
  let bearing = 0;
  if (state === "flood" && meta.flood_dir != null) bearing = meta.flood_dir;
  else if (state === "ebb" && meta.ebb_dir != null) bearing = meta.ebb_dir;

  const scale = state === "slack" ? MIN_SCALE : arrowScale(Math.abs(value));
  svg.style.transform = `rotate(${bearing}deg) scale(${scale})`;

  // Speed pill placement: slack is centred on the slack circle; flood
  // and ebb sit at the arrow's tail. The tail is opposite the arrowhead,
  // so it's offset along (-sin b, +cos b) in screen coords where b is
  // the bearing measured clockwise from north.
  if (state === "slack") {
    valueEl.style.transform = "translate(-50%, -50%)";
  } else {
    const rad = (bearing * Math.PI) / 180;
    const dx = -Math.sin(rad) * TAIL_OFFSET_PX;
    const dy = Math.cos(rad) * TAIL_OFFSET_PX;
    valueEl.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }
}

export class CurrentStationLayer {
  private map: MlMap;
  private markers: Map<number, maplibregl.Marker> = new Map();
  private elements: Map<number, HTMLElement> = new Map();
  private metaById: Map<number, StationMeta>;
  private extremesById: Map<number, Extreme[]>;

  constructor(map: MlMap, data: LoadedData) {
    this.map = map;
    this.metaById = data.stationsById;
    this.extremesById = data.currentExtremesById;

    for (const meta of data.stationsById.values()) {
      if (meta.kind !== "current-primary" && meta.kind !== "current-secondary") continue;
      const kindClass = meta.kind === "current-secondary" ? "secondary" : "primary";
      const el = createMarkerEl(meta.name, kindClass);
      const id = meta.station_id;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        selectedStationId.value =
          selectedStationId.value === id ? null : id;
      });
      const marker = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat([meta.longitude, meta.latitude]);
      this.markers.set(id, marker);
      this.elements.set(id, el);
    }
  }

  attach(): void {
    for (const marker of this.markers.values()) marker.addTo(this.map);
    this.applyZoomVisibility();
    this.map.on("zoom", this.applyZoomVisibility);
    // Selection state — mirrors TideStationLayer.attach. The same
    // `.has-selection` class on the map container drives both layers'
    // hide-others CSS rules, so selecting any station hides every other
    // marker (current or tide), regardless of type.
    effect(() => {
      const sel = selectedStationId.value;
      for (const [id, el] of this.elements) {
        el.classList.toggle("selected", id === sel);
      }
    });
  }

  /** Toggle a body-level class so a single CSS rule can hide every
   *  secondary-current marker at low zooms. */
  private applyZoomVisibility = (): void => {
    const hide = this.map.getZoom() < SECONDARY_MIN_ZOOM;
    this.map.getContainer().classList.toggle("hide-secondary-currents", hide);
  };

  updateAt(t: number): void {
    for (const [id, el] of this.elements) {
      const ext = this.extremesById.get(id);
      const meta = this.metaById.get(id);
      if (!ext || !meta) continue;
      const { state, value } = currentStateAt(ext, t);
      updateMarkerEl(el, meta, state, value);
    }
  }
}
