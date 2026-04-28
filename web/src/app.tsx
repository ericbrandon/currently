// Top-level app component.
//
// Lifecycle:
//   1. On mount: fetch manifest, then load the active volume.
//   2. Once loaded, mount the MapLibre map and station layer.
//   3. Subscribe to scrubberMs; on each change, push a station-layer
//      update through the rAF coalescer.

import { useEffect, useRef, useState } from "preact/hooks";
import { effect } from "@preact/signals";
import type { Map as MlMap } from "maplibre-gl";

import {
  manifest,
  activeVolume,
  loadedVolume,
  scrubberMs,
  scrubberRange,
  recenterAt,
} from "./state/store";
import { fetchManifest, loadVolume } from "./data/loader";
import { createMap, stationBounds } from "./map/map";
import { TideStationLayer } from "./map/stationLayer";
import { rafCoalesce } from "./util/rafCoalesce";
import { Scrubber } from "./ui/Scrubber";

export function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const layerRef = useRef<TideStationLayer | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Step 1 + 2: fetch manifest, load active volume.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const m = await fetchManifest();
        if (cancelled) return;
        manifest.value = m;
        const vol = await loadVolume(m, activeVolume.value);
        if (cancelled) return;
        loadedVolume.value = vol;

        // Reset the 15-h window so "now" sits at the default thumb position.
        recenterAt(Date.now());
      } catch (e) {
        console.error(e);
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Step 3: once volume loaded AND container ready, mount map.
  useEffect(() => {
    const vol = loadedVolume.value;
    if (!vol || !mapContainer.current || mapRef.current) return;

    const tideStations = [...vol.stationsById.values()].filter(s => s.kind === "tide-primary");
    const bbox = stationBounds(tideStations);
    const map = createMap(mapContainer.current, [[bbox[0], bbox[1]], [bbox[2], bbox[3]]]);
    mapRef.current = map;

    const layer = new TideStationLayer(map, vol);
    layerRef.current = layer;

    map.on("load", () => {
      layer.attach();
      layer.updateAt(scrubberMs.value);
    });
  }, [loadedVolume.value]);

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
      {!loadedVolume.value && !error && <div class="loading-overlay">Loading data…</div>}
      <Scrubber />
      {scrubberRange.value && (
        <div class="hint">
          range: {new Date(scrubberRange.value.min).toISOString().slice(0, 10)}
          {" → "}
          {new Date(scrubberRange.value.max).toISOString().slice(0, 10)}
        </div>
      )}
    </div>
  );
}
