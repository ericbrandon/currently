// MapLibre instance lifecycle.
//
// v1 uses OpenFreeMap's Liberty vector style as a placeholder basemap
// (free, no API key, hosted on a CDN). When we ship offline support, we
// swap this URL for a self-hosted PMTiles file. The rest of the app
// doesn't care.

import maplibregl, { Map as MlMap } from "maplibre-gl";
import type { LngLatLike } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

export function createMap(
  container: HTMLElement,
  center: LngLatLike,
  zoom: number,
): MlMap {
  const map = new maplibregl.Map({
    container,
    style: BASEMAP_STYLE,
    center,
    zoom,
    attributionControl: { compact: true },
    pitchWithRotate: false,
    dragRotate: false,
    touchPitch: false,
  });
  map.touchZoomRotate.disableRotation();
  return map;
}

// Camera-view persistence. Reading is synchronous so the caller can use
// the saved view as initial state for createMap; persistence is hooked
// up afterwards via a moveend listener that captures every pan and zoom
// (including programmatic flyTo from station selection / location follow).
const MAP_VIEW_KEY = "pref-map-view";

export type SavedMapView = { center: [number, number]; zoom: number };

export function getSavedMapView(): SavedMapView | null {
  try {
    const raw = localStorage.getItem(MAP_VIEW_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (
      typeof v?.lng === "number" &&
      typeof v?.lat === "number" &&
      typeof v?.zoom === "number"
    ) {
      return { center: [v.lng, v.lat], zoom: v.zoom };
    }
  } catch {
    // Malformed JSON or storage disabled — fall back to the default view.
  }
  return null;
}

export function attachMapViewPersistence(map: MlMap): void {
  map.on("moveend", () => {
    try {
      const c = map.getCenter();
      localStorage.setItem(
        MAP_VIEW_KEY,
        JSON.stringify({ lng: c.lng, lat: c.lat, zoom: map.getZoom() }),
      );
    } catch {
      // Storage disabled — drop the write.
    }
  });
}

