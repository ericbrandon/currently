// Marine forecast zone overlay: pale sub-zone polygons + warning badges.
//
// Unlike the station layers (DOM markers), the polygons are real MapLibre
// GL layers — a geojson source with a fill and a line layer, so they pan
// and zoom natively with the basemap. The warning/watch badges reuse the
// DOM-marker idiom: one maplibregl.Marker per flagged zone, positioned at
// the zone's pre-computed pole-of-inaccessibility point.
//
// Behaviour (notes/weather_plan.md §2):
//   - Zones render only while showWeather is on AND forecast data is held
//     (never-stale rule: no data → nothing to tap → no layer).
//   - Polygons are a uniform pale tint; they never change colour with
//     conditions. Red "!" badge = active warning, yellow = watch only.
//   - Tapping a zone (or badge) selects it → WeatherPanel opens (modal).
//   - While the panel is open, only the selected zone keeps its tint;
//     the rest drop to outline-only.

import maplibregl, { type Map as MlMap } from "maplibre-gl";
import { effect } from "@preact/signals";
import {
  marineZones,
  selectedZoneId,
  showWeather,
  usWeatherData,
  weatherData,
} from "../state/store";
import { zoneWarnings } from "../data/marineForecast";
import type { MarineWarningEvent, MarineZoneInfo } from "../types";

const SOURCE_ID = "marine-zones";
const FILL_LAYER_ID = "marine-zones-fill";
const LINE_LAYER_ID = "marine-zones-line";

// Per-zone tint keyed on the `color` property (0/1/2) baked into the
// geojson by extract_marine_zones.py — a 3-colouring of the adjacency
// graph, so touching zones never share a tint. Yellow/orange family:
// distinct from the blue basemap water and from station markers.
const FILL_COLORS: [string, string, string] = [
  // Light amber rather than lemon yellow: the blue water underneath pulls
  // pure yellow toward olive-green at 45% opacity; a touch of red
  // compensates without darkening the tint (full gold went muddy).
  "#fcd34d", // light amber
  "#fdba74", // peach
  "#ea580c", // strong orange
];
const FILL_COLOR_EXPR = [
  "match",
  ["get", "color"],
  0, FILL_COLORS[0],
  1, FILL_COLORS[1],
  2, FILL_COLORS[2],
  FILL_COLORS[0],
] as unknown as string;
const FILL_OPACITY_DEFAULT = 0.45;
// Yellow needs more opacity than the others: below ~0.5 the blue water
// underneath drags it to olive-green. The warmer hues survive blending.
const FILL_OPACITY_YELLOW = 0.6;
const FILL_OPACITY_SELECTED = 0.65;
const FILL_OPACITY_UNSELECTED = 0.0; // others vanish while panel is open
const OPACITY_BASE_EXPR = [
  "match",
  ["get", "color"],
  0, FILL_OPACITY_YELLOW,
  FILL_OPACITY_DEFAULT,
] as unknown as number;
const LINE_COLOR = "#9a3412"; // dark burnt orange outline
const LINE_OPACITY = 0.4;

export class MarineZoneLayer {
  private map: MlMap;
  private badges: Map<string, maplibregl.Marker> = new Map(); // clc → marker
  private zones: MarineZoneInfo[] = [];
  private attached = false;

  constructor(map: MlMap) {
    this.map = map;
  }

  /** Fetch the pre-baked zone polygons and mount source/layers/effects.
   *  Call from map "load". Safe to call once; failures leave the feature
   *  dormant (weather button still works — the panel just can't open
   *  without zones, and refreshMarineForecast is unaffected). */
  async attach(): Promise<void> {
    if (this.attached) return;
    let geojson: GeoJSON.FeatureCollection;
    try {
      const resp = await fetch("data/marine_zones.geojson");
      if (!resp.ok) throw new Error(`marine_zones HTTP ${resp.status}`);
      geojson = await resp.json();
    } catch (e) {
      console.error("marine zones failed to load:", e);
      return;
    }
    this.attached = true;

    this.zones = geojson.features.map((f) => {
      const info = { ...(f.properties as MarineZoneInfo) };
      const outer = (f.geometry as GeoJSON.Polygon).coordinates[0] as [
        number,
        number,
      ][];
      let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
      for (const [lon, lat] of outer) {
        if (lon < w) w = lon;
        if (lon > e) e = lon;
        if (lat < s) s = lat;
        if (lat > n) n = lat;
      }
      info.bbox = [w, s, e, n];
      info.ring = outer;
      return info;
    });
    marineZones.value = this.zones;

    this.map.addSource(SOURCE_ID, { type: "geojson", data: geojson });
    // Insert below the basemap's first symbol layer so place names and
    // water labels render crisply on top of the tint.
    const firstSymbol = this.map
      .getStyle()
      .layers.find((l) => l.type === "symbol")?.id;
    this.map.addLayer(
      {
        id: FILL_LAYER_ID,
        type: "fill",
        source: SOURCE_ID,
        layout: { visibility: "none" },
        paint: {
          "fill-color": FILL_COLOR_EXPR,
          "fill-opacity": OPACITY_BASE_EXPR,
        },
      },
      firstSymbol,
    );
    this.map.addLayer(
      {
        id: LINE_LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        layout: { visibility: "none" },
        paint: {
          "line-color": LINE_COLOR,
          "line-opacity": LINE_OPACITY,
          "line-width": 1,
        },
      },
      firstSymbol,
    );

    // Visibility: on iff the toggle is on AND at least one country's data
    // is held. Zones of a country whose source is down are filtered out
    // entirely (never-stale: nothing tappable without data) — a NWS
    // outage must not hide Canadian zones. Also rebuilds badges whenever
    // forecast data changes (hourly refresh may add or clear warnings).
    effect(() => {
      const caOk = weatherData.value !== null;
      const usOk = usWeatherData.value !== null;
      const visible = showWeather.value && (caOk || usOk);
      const vis = visible ? "visible" : "none";
      const filter =
        caOk && usOk
          ? null
          : (["==", ["get", "country"], caOk ? "CA" : "US"] as any);
      this.map.setFilter(FILL_LAYER_ID, filter);
      this.map.setFilter(LINE_LAYER_ID, filter);
      this.map.setLayoutProperty(FILL_LAYER_ID, "visibility", vis);
      this.map.setLayoutProperty(LINE_LAYER_ID, "visibility", vis);
      this.rebuildBadges(visible);
      if (!visible && selectedZoneId.value !== null) {
        selectedZoneId.value = null;
      }
    });

    // Selection tint: while a zone is selected (panel open), it keeps a
    // stronger tint and every other zone drops to outline only.
    effect(() => {
      const sel = selectedZoneId.value;
      this.map.setPaintProperty(
        FILL_LAYER_ID,
        "fill-opacity",
        sel === null
          ? OPACITY_BASE_EXPR
          : [
              "case",
              ["==", ["get", "clc"], sel],
              FILL_OPACITY_SELECTED,
              FILL_OPACITY_UNSELECTED,
            ],
      );
    });
  }

  /** CLC of the top-most zone under a screen point, or null. Used by the
   *  map click handler; returns null while the layer is hidden. */
  zoneAt(point: { x: number; y: number }): string | null {
    if (!this.attached) return null;
    if (
      this.map.getLayoutProperty(FILL_LAYER_ID, "visibility") !== "visible"
    ) {
      return null;
    }
    const hits = this.map.queryRenderedFeatures(
      [point.x, point.y] as [number, number],
      { layers: [FILL_LAYER_ID] },
    );
    return hits.length > 0 ? (hits[0].properties as MarineZoneInfo).clc : null;
  }

  private rebuildBadges(visible: boolean): void {
    for (const m of this.badges.values()) m.remove();
    this.badges.clear();
    const data = weatherData.value;
    const usData = usWeatherData.value;
    if (!visible || (!data && !usData)) return;

    for (const z of this.zones) {
      let events: MarineWarningEvent[];
      if (z.country === "US") {
        events = usData?.warningsByZone.get(z.site_code) ?? [];
      } else {
        events = data ? zoneWarnings(data, z.site_code, z.name_en) : [];
      }
      if (events.length === 0) continue;
      // Red beats yellow when a zone somehow has both.
      const isWarning = events.some((e) => e.type === "warning");
      const el = document.createElement("div");
      el.className = `weather-badge ${isWarning ? "warning" : "watch"}`;
      el.textContent = "!";
      const clc = z.clc;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        selectedZoneId.value = clc;
      });
      const marker = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat([z.label_lon, z.label_lat])
        .addTo(this.map);
      this.badges.set(clc, marker);
    }
  }
}
