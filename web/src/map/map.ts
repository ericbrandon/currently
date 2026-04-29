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
  });
  map.touchZoomRotate.disableRotation();
  return map;
}

