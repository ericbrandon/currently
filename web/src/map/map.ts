// MapLibre instance lifecycle.
//
// v1 uses OpenFreeMap's Liberty vector style as a placeholder basemap
// (free, no API key, hosted on a CDN). When we ship offline support, we
// swap this URL for a self-hosted PMTiles file. The rest of the app
// doesn't care.

import maplibregl, { Map as MlMap } from "maplibre-gl";
import type { LngLatBoundsLike } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

export function createMap(container: HTMLElement, fitBounds: LngLatBoundsLike): MlMap {
  const map = new maplibregl.Map({
    container,
    style: BASEMAP_STYLE,
    bounds: fitBounds,
    fitBoundsOptions: { padding: 40 },
    attributionControl: { compact: true },
    pitchWithRotate: false,
    dragRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  return map;
}

/** Compute a bounding box [west, south, east, north] from a list of
 *  station coordinates, padded by a degree-fraction so points aren't
 *  flush against the viewport edge. */
export function stationBounds(
  stations: Iterable<{ longitude: number; latitude: number }>,
  pad = 0.15,
): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const st of stations) {
    if (st.longitude < w) w = st.longitude;
    if (st.longitude > e) e = st.longitude;
    if (st.latitude < s) s = st.latitude;
    if (st.latitude > n) n = st.latitude;
  }
  if (!Number.isFinite(w)) {
    // No stations — fall back to a sensible BC view.
    return [-125, 48, -123, 50];
  }
  const dx = (e - w) * pad || 0.5;
  const dy = (n - s) * pad || 0.5;
  return [w - dx, s - dy, e + dx, n + dy];
}
