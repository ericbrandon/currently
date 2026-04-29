// Single maplibregl.Marker that renders the live user position as a
// Google-Maps-style blue dot with a pulsing concentric ring.
//
// Lifecycle is owned by app.tsx: it constructs the marker once, then
// calls show() / hide() / setPosition() in response to signal changes.

import maplibregl, { type Map as MlMap } from "maplibre-gl";

export class UserLocationMarker {
  private map: MlMap;
  private marker: maplibregl.Marker;
  private attached = false;

  constructor(map: MlMap) {
    this.map = map;
    const el = document.createElement("div");
    el.className = "user-location";
    el.innerHTML = `
      <div class="pulse-ring"></div>
      <div class="dot"></div>
    `;
    this.marker = new maplibregl.Marker({ element: el, anchor: "center" });
  }

  setPosition(lon: number, lat: number): void {
    this.marker.setLngLat([lon, lat]);
  }

  show(): void {
    if (this.attached) return;
    this.marker.addTo(this.map);
    this.attached = true;
  }

  hide(): void {
    if (!this.attached) return;
    this.marker.remove();
    this.attached = false;
  }
}
