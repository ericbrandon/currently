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
  showTides,
  showCurrents,
  useFeet,
  userLocation,
  userLocationActive,
  userLocationFollowing,
  tosAccepted,
} from "./state/store";
import { fetchManifest, loadAllYears } from "./data/loader";
import { createMap } from "./map/map";
import { TideStationLayer } from "./map/stationLayer";
import { CurrentStationLayer } from "./map/currentStationLayer";
import { UserLocationMarker } from "./map/userLocationMarker";
import { rafCoalesce } from "./util/rafCoalesce";
import { startGeolocation, stopGeolocation } from "./util/geolocation";
import { Scrubber } from "./ui/Scrubber";
import { TidePanel } from "./ui/TidePanel";
import { CurrentPanel } from "./ui/CurrentPanel";
import { Controls } from "./ui/Controls";
import { TosModal } from "./ui/TosModal";

export function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const layerRef = useRef<TideStationLayer | null>(null);
  const currentLayerRef = useRef<CurrentStationLayer | null>(null);
  const userLocMarkerRef = useRef<UserLocationMarker | null>(null);
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

    // Initial view: centered on Sidney, BC (Saanich Peninsula).
    const map = createMap(mapContainer.current, [-123.3989, 48.6512], 9);
    mapRef.current = map;

    const layer = new TideStationLayer(map, data);
    layerRef.current = layer;
    const currentLayer = new CurrentStationLayer(map, data);
    currentLayerRef.current = currentLayer;
    userLocMarkerRef.current = new UserLocationMarker(map);

    map.on("load", () => {
      layer.attach();
      layer.updateAt(scrubberMs.value);
      currentLayer.attach();
      currentLayer.updateAt(scrubberMs.value);
    });
    // Marker DOM clicks are handled by the marker's own listener (and call
    // stopPropagation), so this fires only for clicks that hit the map canvas.
    map.on("click", () => {
      selectedStationId.value = null;
    });

    // Pan-to-unlock for the user-location follow mode. Drag is always
    // user-initiated, so dragstart unconditionally clears `following`.
    // Wheel/touch zoom can come from either the user or our own flyTo
    // animation, so we gate zoomstart on `originalEvent` being present —
    // programmatic camera moves don't carry one.
    map.on("dragstart", () => {
      if (userLocationFollowing.value) userLocationFollowing.value = false;
    });
    map.on("zoomstart", (e) => {
      if (e.originalEvent && userLocationFollowing.value) {
        userLocationFollowing.value = false;
      }
    });
  }, [loadedData.value]);

  // Track the scrubber's height in a CSS variable so the TidePanel's
  // bottom can sit flush with the scrubber's top, regardless of whether
  // the chart is currently expanded. Runs once data is loaded — the
  // scrubber is mounted by then.
  useEffect(() => {
    if (!loadedData.value) return;
    const scrubberEl = document.querySelector(".scrubber") as HTMLElement | null;
    if (!scrubberEl) return;
    const update = () => {
      const h = scrubberEl.getBoundingClientRect().height;
      document.documentElement.style.setProperty("--scrubber-h", `${h}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(scrubberEl);
    return () => ro.disconnect();
  }, [loadedData.value]);

  // Step 4: scrubber → station-layer updates, rAF-coalesced.
  // Also re-runs when `useFeet` flips so markers re-render in the new
  // unit, and short-circuits when both layers' visibility is off.
  useEffect(() => {
    const coalesceTide = rafCoalesce<number>((t) => {
      layerRef.current?.updateAt(t);
    });
    const coalesceCurrent = rafCoalesce<number>((t) => {
      currentLayerRef.current?.updateAt(t);
    });
    const dispose = effect(() => {
      const t = scrubberMs.value;
      useFeet.value;
      const tides = showTides.value;
      const currents = showCurrents.value;
      const map = mapRef.current;
      if (!map || !map.loaded()) return;
      if (tides) coalesceTide.schedule(t);
      if (currents) coalesceCurrent.schedule(t);
    });
    return () => {
      dispose();
      coalesceTide.cancel();
      coalesceCurrent.cancel();
    };
  }, []);

  // User location: geolocation watcher lifecycle. start/stop the
  // navigator.geolocation.watchPosition in lockstep with the active
  // signal. Runs once — independent of map mount, since starting the
  // watcher early is harmless.
  useEffect(() => {
    const dispose = effect(() => {
      if (userLocationActive.value) startGeolocation();
      else {
        stopGeolocation();
        userLocation.value = null;
      }
    });
    return () => {
      dispose();
      stopGeolocation();
    };
  }, []);

  // User location: keep the dot marker's lng/lat in sync with the
  // latest fix, and show/hide the marker as `active` flips. Two signals
  // → one effect because the show/hide and reposition logic are coupled
  // (no point showing a marker before the first fix arrives).
  useEffect(() => {
    if (!loadedData.value) return;
    const dispose = effect(() => {
      const active = userLocationActive.value;
      const loc = userLocation.value;
      const m = userLocMarkerRef.current;
      if (!m) return;
      if (active && loc) {
        m.setPosition(loc.lon, loc.lat);
        m.show();
      } else {
        m.hide();
      }
    });
    return () => dispose();
  }, [loadedData.value]);

  // User location: when `following` is on, recenter the map on each new
  // fix. Reads `userLocation` so the effect re-runs on every position
  // update. On the first fix after activation, also bumps the zoom to
  // at least 13 so the dot is meaningfully framed.
  useEffect(() => {
    let firstFix = true;
    const dispose = effect(() => {
      const following = userLocationFollowing.value;
      const loc = userLocation.value;
      const map = mapRef.current;
      if (!following || !loc || !map) {
        if (!following) firstFix = true;
        return;
      }
      const targetZoom = firstFix ? Math.max(map.getZoom(), 13) : map.getZoom();
      firstFix = false;
      map.flyTo({
        center: [loc.lon, loc.lat],
        zoom: targetZoom,
        duration: 600,
      });
    });
    return () => dispose();
  }, [loadedData.value]);

  // Toggle the .hide-tides / .hide-currents classes whenever the
  // matching control flips. CSS hides the corresponding markers; the
  // per-frame effect above also short-circuits while hidden. Flipping
  // a layer off clears the station selection if the selected station
  // belonged to that layer, so the chart + panel disappear too rather
  // than dangling on an invisible marker.
  useEffect(() => {
    const dispose = effect(() => {
      const hideTides = !showTides.value;
      const hideCurrents = !showCurrents.value;
      const map = mapRef.current;
      if (!map) return;
      map.getContainer().classList.toggle("hide-tides", hideTides);
      map.getContainer().classList.toggle("hide-currents", hideCurrents);
      const sel = selectedStationId.value;
      if (sel !== null) {
        const meta = loadedData.value?.stationsById.get(sel);
        if (meta) {
          const isTide = meta.kind === "tide-primary" || meta.kind === "tide-secondary";
          const isCurrent = meta.kind === "current-primary" || meta.kind === "current-secondary";
          if ((isTide && hideTides) || (isCurrent && hideCurrents)) {
            selectedStationId.value = null;
          }
        }
      }
    });
    return () => dispose();
  }, [loadedData.value]);

  return (
    <div class="app">
      <div ref={mapContainer} class="map-container" />
      {error && <div class="error-banner">Error: {error}</div>}
      {!loadedData.value && !error && <div class="loading-overlay">Loading data…</div>}
      <TidePanel />
      <CurrentPanel />
      <Scrubber />
      <Controls />
      {!tosAccepted.value && <TosModal />}
    </div>
  );
}
