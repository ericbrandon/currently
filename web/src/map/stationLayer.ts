// Tide-station overlay layer.
//
// Single GeoJSON source + a circle layer. The FeatureCollection object is
// allocated once and reused; per-frame scrub updates mutate
// `feature.properties.value` in place and call `source.setData(fc)`. This
// avoids GC pressure in the hot path. (See app_implementation.md §11.)

import type { Map as MlMap, GeoJSONSource } from "maplibre-gl";
import type { Extreme, LoadedVolume } from "../types";
import { valueAt } from "../interp/valueAt";

const SOURCE_ID = "tide-stations";
const LAYER_ID = "tide-primary-layer";
const LABEL_LAYER_ID = "tide-primary-labels";

type TideFeature = GeoJSON.Feature<GeoJSON.Point, {
  station_id: number;
  name: string;
  value: number | null;
}>;

export class TideStationLayer {
  private map: MlMap;
  private fc: GeoJSON.FeatureCollection<GeoJSON.Point>;
  private features: TideFeature[];
  private extremesById: Map<number, Extreme[]>;

  constructor(map: MlMap, vol: LoadedVolume) {
    this.map = map;
    this.extremesById = vol.tideExtremesById;

    this.features = [];
    for (const meta of vol.stationsById.values()) {
      if (meta.kind !== "tide-primary") continue;
      this.features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [meta.longitude, meta.latitude] },
        properties: {
          station_id: meta.station_id,
          name: meta.name,
          value: null,
        },
      });
    }
    this.fc = { type: "FeatureCollection", features: this.features };
  }

  /** Add the source and layer to the map. Call after `map.on('load')`. */
  attach(): void {
    this.map.addSource(SOURCE_ID, {
      type: "geojson",
      data: this.fc,
    });

    this.map.addLayer({
      id: LAYER_ID,
      source: SOURCE_ID,
      type: "circle",
      paint: {
        // Radius pulses with tide height. null/no-data → small grey dot.
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["coalesce", ["get", "value"], 0],
          0, 6,
          5, 22,
        ],
        "circle-color": [
          "case",
          ["==", ["get", "value"], null], "#9ca3af",
          [
            "interpolate", ["linear"],
            ["get", "value"],
            0, "#bae6fd",
            5, "#1d4ed8",
          ],
        ],
        "circle-stroke-color": "#0c4a6e",
        "circle-stroke-width": 1.2,
        "circle-opacity": 0.9,
      },
    });

    this.map.addLayer({
      id: LABEL_LAYER_ID,
      source: SOURCE_ID,
      type: "symbol",
      layout: {
        "text-field": [
          "case",
          ["==", ["get", "value"], null], ["get", "name"],
          ["concat", ["get", "name"], "  ",
            ["number-format", ["get", "value"], { "min-fraction-digits": 2, "max-fraction-digits": 2 }],
            " m"],
        ],
        "text-font": ["Noto Sans Regular"],
        "text-size": 12,
        "text-offset": [0, 1.6],
        "text-anchor": "top",
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": "#0f172a",
        "text-halo-color": "#ffffff",
        "text-halo-width": 1.4,
      },
    });
  }

  /** Recompute every visible station's value at `t` and push to the GPU.
   *  O(n log m) where n = stations and m = extremes per station. */
  updateAt(t: number): void {
    for (const f of this.features) {
      const ext = this.extremesById.get(f.properties.station_id);
      f.properties.value = ext ? valueAt(ext, t) : null;
    }
    const src = this.map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    src?.setData(this.fc);
  }
}
