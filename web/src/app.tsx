// Top-level app component.
//
// Lifecycle:
//   1. On mount: fetch manifest, then load all years' data.
//   2. Once loaded, mount the MapLibre map and station layer.
//   3. Subscribe to scrubberMs; on each change, push a station-layer
//      update through the rAF coalescer.

import { useEffect, useRef, useState } from "preact/hooks";
import { effect } from "@preact/signals";
import type { Map as MlMap } from "maplibre-gl";

import {
  manifest,
  loadedData,
  scrubberMs,
  recenterAt,
  selectedStationId,
} from "./state/store";
import { fetchManifest, loadAllYears } from "./data/loader";
import { createMap, stationBounds } from "./map/map";
import { TideStationLayer } from "./map/stationLayer";
import { rafCoalesce } from "./util/rafCoalesce";
import { Scrubber } from "./ui/Scrubber";

export function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const layerRef = useRef<TideStationLayer | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Step 1 + 2: fetch manifest, load all years.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const m = await fetchManifest();
        if (cancelled) return;
        manifest.value = m;
        const data = await loadAllYears(m);
        if (cancelled) return;
        loadedData.value = data;

        // Reset the 15-h window so "now" sits at the default thumb position.
        recenterAt(Date.now());
      } catch (e) {
        console.error(e);
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Step 3: once data loaded AND container ready, mount map.
  useEffect(() => {
    const data = loadedData.value;
    if (!data || !mapContainer.current || mapRef.current) return;

    const tideStations = [...data.stationsById.values()].filter(
      (s) => s.kind === "tide-primary" || s.kind === "tide-secondary",
    );
    const bbox = stationBounds(tideStations);
    const map = createMap(mapContainer.current, [[bbox[0], bbox[1]], [bbox[2], bbox[3]]]);
    mapRef.current = map;

    const layer = new TideStationLayer(map, data);
    layerRef.current = layer;

    map.on("load", () => {
      layer.attach();
      layer.updateAt(scrubberMs.value);
    });
    // Marker DOM clicks are handled by the marker's own listener (and call
    // stopPropagation), so this fires only for clicks that hit the map canvas.
    map.on("click", () => {
      selectedStationId.value = null;
    });
  }, [loadedData.value]);

  // Step 4: scrubber → station-layer updates, rAF-coalesced.
  useEffect(() => {
    const coalesce = rafCoalesce<number>((t) => {
      layerRef.current?.updateAt(t);
    });
    const dispose = effect(() => {
      const t = scrubberMs.value;
      if (mapRef.current && mapRef.current.loaded()) {
        coalesce.schedule(t);
      }
    });
    return () => { dispose(); coalesce.cancel(); };
  }, []);

  return (
    <div class="app">
      <div ref={mapContainer} class="map-container" />
      {error && <div class="error-banner">Error: {error}</div>}
      {!loadedData.value && !error && <div class="loading-overlay">Loading data…</div>}
      <Scrubber />
    </div>
  );
}
