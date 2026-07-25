// Data-invariant tests for the published marine_zones.geojson (produced
// by canada_data/extract_marine_zones.py). Mirrors the philosophy of
// interp/tideDataInvariants.test.ts: test the file the app actually
// ships. Geometry-heavy checks (pairwise overlap) already run in the
// extraction script with shapely; here we pin the structural contract
// the webapp relies on.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

type ZoneFeature = {
  type: string;
  id: string;
  properties: {
    clc: string;
    site_code: string;
    name_en: string;
    nom_fr: string;
    label_lon: number;
    label_lat: number;
    color: number;
  };
  geometry: { type: string; coordinates: number[][][] };
};

const fc = JSON.parse(
  readFileSync(
    new URL("../../public/data/marine_zones.geojson", import.meta.url),
    "utf-8",
  ),
) as { type: string; features: ZoneFeature[] };

// The zone set the feature was designed around (weather_plan.md §1.2).
const EXPECTED: Record<string, { site: string; name: string }> = {
  "001111": { site: "m0000009", name: "Juan de Fuca Strait - east entrance" },
  "001112": { site: "m0000009", name: "Juan de Fuca Strait - central strait" },
  "001113": { site: "m0000009", name: "Juan de Fuca Strait - west entrance" },
  "001120": { site: "m0000064", name: "Haro Strait" },
  "001131": { site: "m0000028", name: "Strait of Georgia - north of Nanaimo" },
  "001132": { site: "m0000028", name: "Strait of Georgia - south of Nanaimo" },
  "001140": { site: "m0000102", name: "Howe Sound" },
  "001150": { site: "m0000010", name: "Johnstone Strait" },
  "001180": { site: "m0000065", name: "West Coast Vancouver Island South" },
};

function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

describe("marine_zones.geojson", () => {
  it("contains exactly the expected zones with correct site codes and names", () => {
    const byClc = new Map(fc.features.map((f) => [f.properties.clc, f]));
    expect([...byClc.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [clc, exp] of Object.entries(EXPECTED)) {
      const f = byClc.get(clc)!;
      expect(f.properties.site_code).toBe(exp.site);
      expect(f.properties.name_en).toBe(exp.name);
      expect(f.properties.nom_fr.length).toBeGreaterThan(0);
      expect(f.id).toBe(clc);
    }
  });

  it("every geometry is a closed, plausibly-BC polygon", () => {
    for (const f of fc.features) {
      expect(f.geometry.type).toBe("Polygon");
      for (const ring of f.geometry.coordinates) {
        expect(ring.length).toBeGreaterThanOrEqual(4);
        expect(ring[0]).toEqual(ring[ring.length - 1]);
        for (const [lon, lat] of ring) {
          expect(lon).toBeGreaterThan(-129);
          expect(lon).toBeLessThan(-121);
          expect(lat).toBeGreaterThan(47);
          expect(lat).toBeLessThan(52);
        }
      }
    }
  });

  it("badge label points sit inside their own polygon", () => {
    for (const f of fc.features) {
      const { label_lon, label_lat } = f.properties;
      const [outer, ...holes] = f.geometry.coordinates;
      expect(pointInRing(label_lon, label_lat, outer)).toBe(true);
      for (const hole of holes) {
        expect(pointInRing(label_lon, label_lat, hole)).toBe(false);
      }
    }
  });

  it("touching zones never share a tint colour", () => {
    // Adjacent zones share exact boundary linework (verified at extraction
    // with shapely), so "≥2 common vertices" is a faithful adjacency test —
    // a single common vertex would be a corner touch, which may share a
    // colour.
    const vertexSets = fc.features.map(
      (f) =>
        new Set(
          f.geometry.coordinates.flat().map(([lon, lat]) => `${lon},${lat}`),
        ),
    );
    let adjacentPairs = 0;
    for (let i = 0; i < fc.features.length; i++) {
      for (let j = i + 1; j < fc.features.length; j++) {
        let common = 0;
        for (const v of vertexSets[i]) if (vertexSets[j].has(v)) common++;
        if (common >= 2) {
          adjacentPairs++;
          expect(
            fc.features[i].properties.color,
            `${fc.features[i].properties.name_en} and ` +
              `${fc.features[j].properties.name_en} touch but share colour`,
          ).not.toBe(fc.features[j].properties.color);
        }
      }
    }
    // The Salish Sea set has a known-connected core; if this drops to 0
    // the vertex heuristic broke, not the map.
    expect(adjacentPairs).toBeGreaterThanOrEqual(5);
    for (const f of fc.features) {
      expect([0, 1, 2]).toContain(f.properties.color);
    }
  });

  it("split-area sub-zone names match the API warning-name convention", () => {
    // Warnings join on name_en (weather_plan.md §1.1); the split areas use
    // the "Area - qualifier" pattern with a spaced hyphen.
    for (const f of fc.features) {
      const multi =
        fc.features.filter(
          (g) => g.properties.site_code === f.properties.site_code,
        ).length > 1;
      if (multi) expect(f.properties.name_en).toMatch(/ - /);
    }
  });
});
