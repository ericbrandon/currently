// Current-station overlay: one maplibregl.Marker per current station,
// rendered as an arrow that rotates to the live flow direction and
// scales with the absolute current strength.
//
//   flood (v > 0): rotated to flood_direction_true, navy fill.
//   ebb   (v < 0): rotated to ebb_direction_true,  red  fill.
//   slack (|v| < 0.1 kt): non-rotated purple circle.
//
// Weak/variable max events (CHS-flagged uncertain peaks) render as
// ordinary flood/ebb arrows here — the small interpolated magnitude
// already conveys uncertainty. Chart and side panel still distinguish
// them.
//
// Two non-rotated pills sit beside the arrow, positioned via inline
// transforms set every scrub frame:
//
//   - speed pill: at the arrow's tail (opposite the arrowhead).
//     Centred on the slack/no-data circle when there's no direction.
//   - name pill: below the marker by default. Two overrides:
//     `.name-pushed`  (arrow ≈ N): pushed further down so the south-side
//     speed pill fits between icon and name.
//     `.name-tracking` (arrow ≈ S): repositioned to follow the visible
//     arrowhead with a constant vertical gap below it.
//
// Mirrors TideStationLayer in structure: per-frame scrub updates mutate
// marker DOM in place; nothing is re-created.

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

/** Distance in CSS px from the marker centre at which the speed pill
 *  sits, along the arrow's tail direction. Independent of per-frame
 *  scale so the pill doesn't pop around as speed ramps. Sized to land
 *  just past the un-scaled arrow tail (~30 px from centre at the 75 px
 *  marker box). */
const TAIL_OFFSET_PX = 38;

/** Arrow-tip distance from the marker centre at scale = 1, in CSS px.
 *  Polygon tip is 26 viewBox units from centre; SVG viewBox 60 renders
 *  to 75 px box → 1.25 px/unit → 26 × 1.25 = 32.5. */
const ARROW_TIP_PX = 32.5;

/** When the bearing is within ±this of due north, the speed pill (which
 *  sits south of the marker at that bearing) lands on top of the name
 *  pill. The name pill gets pushed further south to clear it. */
const NAME_PUSH_THRESHOLD_DEG = 45;

/** When the bearing is within ±this of due south, the arrowhead reaches
 *  toward the name pill's default location. The name pill is repositioned
 *  to track the arrowhead. Wider than NAME_PUSH so that bearings like
 *  220–240° (which point "vaguely down" but reach far sideways) and
 *  105°/255° (almost horizontal but still meaningfully below centre)
 *  also get tracking. Capped below 90° from due south so that
 *  near-horizontal arrows (e.g. 95°, where the tip dips only ~3 px
 *  below centre) don't snap into a big lateral track for what's
 *  visually still a horizontal arrow. */
const NAME_TRACK_THRESHOLD_DEG = 75;

/** When tracking, vertical gap between the arrow tip and the name pill's
 *  top edge. The pill sits directly below the tip (pill_cx = tip_x), so
 *  this is a true vertical distance — diagonal bearings get the same
 *  breathing room as straight-down ones. */
const NAME_TIP_GAP_PX = 13;

/** Half the height of the name pill in CSS px — converts the desired
 *  tip-to-pill-top gap into a tip-to-pill-centre offset for the
 *  inline transform. */
const NAME_HALF_HEIGHT_PX = 9;

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
    `<div class="current-name-row"><div class="current-name">${escapeHtml(name)}</div></div>`;
  return el;
}

/** Below this zoom level, secondary-current markers are hidden. Mirrors
 *  the same threshold used for secondary-tide markers in stationLayer.ts. */
const SECONDARY_MIN_ZOOM = 8;

/** `translate(...)` string that centres an absolutely-positioned element
 *  on its anchor point and then nudges it by (dx, dy) CSS px. */
function offsetTransform(dx: number, dy: number): string {
  return `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
}

/** True iff `bearing` is within `radius` degrees of `centre`, treating
 *  bearings as cyclic in [0, 360). Lets a single call cover both the
 *  ±N-of-0° and ±N-of-180° windows without juggling 360→0 wrap-around. */
function isWithinDeg(bearing: number, centre: number, radius: number): boolean {
  return Math.abs(((bearing - centre + 540) % 360) - 180) <= radius;
}

const CENTRED = "translate(-50%, -50%)";

function updateMarkerEl(
  el: HTMLElement,
  meta: StationMeta,
  state: CurrentState | null,
  value: number | null,
): void {
  const valueEl = el.querySelector(".current-value") as HTMLElement;
  const nameEl = el.querySelector(".current-name") as HTMLElement;
  const svg = el.querySelector("svg.current-arrow") as SVGSVGElement;

  // Reset every per-frame piece of state up-front; each branch below
  // adds back exactly what applies.
  el.classList.remove("flood", "ebb", "slack", "no-data", "name-pushed", "name-tracking");
  nameEl.style.transform = "";

  // No-data and slack share a layout: centred speed pill, un-rotated
  // arrow at min scale (slack/no-data circle is the visible piece).
  if (state === null || value === null) {
    el.classList.add("no-data");
    valueEl.textContent = "—";
    valueEl.style.transform = CENTRED;
    svg.style.transform = `rotate(0deg) scale(${MIN_SCALE})`;
    return;
  }
  el.classList.add(state);
  valueEl.textContent = formatCurrentValue(value);
  if (state === "slack") {
    valueEl.style.transform = CENTRED;
    svg.style.transform = `rotate(0deg) scale(${MIN_SCALE})`;
    return;
  }

  // Flood / ebb: the rest of the function is the directional path.
  const bearing = (state === "flood" ? meta.flood_dir : meta.ebb_dir) ?? 0;
  const scale = arrowScale(Math.abs(value));
  const rad = (bearing * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);

  svg.style.transform = `rotate(${bearing}deg) scale(${scale})`;

  // Speed pill at the arrow's tail — opposite the arrowhead, so offset
  // in (-sin b, +cos b) from the marker centre.
  valueEl.style.transform = offsetTransform(-sin * TAIL_OFFSET_PX, cos * TAIL_OFFSET_PX);

  // Name pill: pushed if the arrow points roughly N (so the south-side
  // speed pill needs room), tracked if it points roughly S (so the name
  // hugs the arrowhead at any scale), default otherwise.
  if (isWithinDeg(bearing, 0, NAME_PUSH_THRESHOLD_DEG)) {
    el.classList.add("name-pushed");
  } else if (isWithinDeg(bearing, 180, NAME_TRACK_THRESHOLD_DEG)) {
    el.classList.add("name-tracking");
    const tipDx = sin * ARROW_TIP_PX * scale;
    const tipDy = -cos * ARROW_TIP_PX * scale;
    nameEl.style.transform = offsetTransform(
      tipDx,
      tipDy + NAME_TIP_GAP_PX + NAME_HALF_HEIGHT_PX,
    );
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
