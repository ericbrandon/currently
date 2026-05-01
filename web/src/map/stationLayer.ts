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
import { effect } from "@preact/signals";
import type { Extreme, LoadedData } from "../types";
import { tideStateAt, type SegmentCache, type TideState } from "../interp/valueAt";
import { selectedStationId } from "../state/store";
import { formatTideValue } from "../util/units";

// SVG viewBox is 40 wide × 55 tall. The 40×40 square sits centred
// vertically; the triangle occupies the remaining 15 units (above for
// flood, below for ebb). For slack the square is centred (y=7.5..47.5).
// Rendered size 43×59 px (10% smaller than the original 48×66).
const SVG_TEMPLATE = `
<svg viewBox="0 0 40 55" width="43" height="59" preserveAspectRatio="xMidYMid meet">
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

function createMarkerEl(name: string, kindClass: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `tide-marker no-data ${kindClass}`;
  el.innerHTML = `${SVG_TEMPLATE}<div class="tide-name-row"><div class="tide-name">${escapeHtml(name)}</div></div>`;
  return el;
}

/** Below this zoom level, secondary-tide markers are hidden so the map
 *  stays readable when zoomed out. Raise to keep them hidden longer. */
const SECONDARY_MIN_ZOOM = 9;

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
  text.textContent = value === null ? "—" : formatTideValue(value);
  text.setAttribute("y", String(VALUE_Y[state]));
}

export class TideStationLayer {
  private map: MlMap;
  private markers: Map<string, maplibregl.Marker> = new Map();
  private elements: Map<string, HTMLElement> = new Map();
  private extremesById: Map<string, Extreme[]>;
  // Cached [lng, lat] per id, used for the per-frame off-screen cull in
  // updateAt(). Cheaper than re-reading lat/lon from a maplibregl.Marker
  // (which goes through the marker's LngLat object) on every frame.
  private coordsById: Map<string, [number, number]> = new Map();
  // Per-station last-segment cache for tideStateAt's segment search.
  // See SegmentCache in interp/valueAt.ts — between consecutive scrub
  // frames `t` rarely crosses an extreme, so the cache turns the lookup
  // into amortised O(1).
  private segmentCache: Map<string, SegmentCache> = new Map();

  constructor(map: MlMap, data: LoadedData) {
    this.map = map;
    this.extremesById = data.tideExtremesById;

    for (const meta of data.stationsById.values()) {
      if (meta.kind !== "tide-primary" && meta.kind !== "tide-secondary") continue;
      // Visual secondaries (hidden at low zoom): CHS tide-secondary, plus
      // NOAA tide stations flagged US_secondary (NOAA "Subordinate"). NOAA
      // doesn't split primary/secondary structurally — every NOAA station
      // lands as kind="tide-primary" — so the source-of-truth for visual
      // de-emphasis is `us_secondary`.
      const isVisualSecondary =
        meta.kind === "tide-secondary" || meta.us_secondary === true;
      const kindClass = isVisualSecondary ? "secondary" : "primary";
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
      this.coordsById.set(id, [meta.longitude, meta.latitude]);
      this.segmentCache.set(id, { i: 0 });
    }
  }

  attach(): void {
    for (const marker of this.markers.values()) marker.addTo(this.map);
    this.applyZoomVisibility();
    this.map.on("zoom", this.applyZoomVisibility);
    // When a station is selected, hide every other marker (CSS rule keyed
    // off `.has-selection` on the map container + `.selected` on the active
    // marker). Hidden markers use display:none so clicks pass through to
    // the map canvas, where the existing map-click handler deselects.
    effect(() => {
      const sel = selectedStationId.value;
      for (const [id, el] of this.elements) {
        el.classList.toggle("selected", id === sel);
      }
      this.map.getContainer().classList.toggle("has-selection", sel !== null);
    });
  }

  /** Toggle a body-level class so a single CSS rule can hide every secondary
   *  marker at low zooms. Cheaper than touching each marker on every event. */
  private applyZoomVisibility = (): void => {
    const hide = this.map.getZoom() < SECONDARY_MIN_ZOOM;
    this.map.getContainer().classList.toggle("hide-secondary-tides", hide);
  };

  /** Recompute and apply each marker's state at time `t`.
   *  When `full` is false (the per-frame scrub path), markers outside the
   *  current viewport are skipped to halve the per-frame cost. When `full`
   *  is true (movestart in app.tsx, pre-pan), the cull is bypassed so
   *  off-screen markers that are about to slide into view already hold
   *  current values when they appear. */
  updateAt(t: number, full = false): void {
    const bounds = full ? null : this.map.getBounds();
    for (const [id, el] of this.elements) {
      if (bounds) {
        const c = this.coordsById.get(id);
        if (c && !bounds.contains(c)) continue;
      }
      const ext = this.extremesById.get(id);
      if (!ext) continue;
      const { state, value } = tideStateAt(ext, t, this.segmentCache.get(id));
      updateMarkerEl(el, state, value);
    }
  }
}
