// Data loader.
//
// Two responsibilities:
//   1. Fetch the manifest (no-cache) at app startup.
//   2. Fetch every year's tidal_primary JSON in parallel and merge them
//      into a single LoadedData:
//        - per-station extremes concatenated across years and sorted by t
//        - station metadata: latest year wins on conflict
//        - scrubber range = union of all loaded years
//
// v1 scope: primary tide stations only. Currents and secondary stations
// are stubbed in the manifest types but skipped here.

import type {
  Extreme,
  LoadedData,
  Manifest,
  StationMeta,
  TidePrimaryFile,
} from "../types";
import { tideExtremes } from "../interp/extremes";

const MANIFEST_URL = "data/manifest.json";

export async function fetchManifest(): Promise<Manifest> {
  const r = await fetch(MANIFEST_URL, { cache: "no-cache" });
  if (!r.ok) throw new Error(`manifest fetch failed: ${r.status}`);
  return (await r.json()) as Manifest;
}

/** Fetch and merge every year listed in the manifest. */
export async function loadAllYears(manifest: Manifest): Promise<LoadedData> {
  // Years sorted ascending so the "latest year wins" loop reads naturally.
  const yearEntries = [...manifest.years].sort((a, b) => a.year - b.year);
  if (yearEntries.length === 0) {
    throw new Error("manifest contains no years");
  }

  const tideFiles = await Promise.all(
    yearEntries.map(async (y) => {
      if (!y.tidal_primary) return null;
      const r = await fetch(`data/${y.tidal_primary}`);
      if (!r.ok) throw new Error(`tide fetch failed: ${y.tidal_primary} (${r.status})`);
      return (await r.json()) as TidePrimaryFile;
    }),
  );

  const stationsById = new Map<number, StationMeta>();
  const extremesByStation = new Map<number, Extreme[][]>();

  yearEntries.forEach((_y, i) => {
    const file = tideFiles[i];
    if (!file) return;
    for (const s of file.stations) {
      // Latest-year-wins for metadata. Iterating in ascending year order
      // means each assignment overwrites with a later year's data.
      stationsById.set(s.index_no, {
        station_id: s.index_no,
        name: s.name,
        kind: "tide-primary",
        latitude: s.latitude,
        longitude: s.longitude,
      });

      const list = extremesByStation.get(s.index_no) ?? [];
      list.push(tideExtremes(s));
      extremesByStation.set(s.index_no, list);
    }
  });

  const tideExtremesById = new Map<number, Extreme[]>();
  for (const [id, perYear] of extremesByStation) {
    const flat: Extreme[] = perYear.length === 1
      ? perYear[0]
      : perYear.flat().sort((a, b) => a.t - b.t);
    tideExtremesById.set(id, flat);
  }

  // Scrubber range = union of all years' extremes from the manifest
  // (build_manifest.py already computed first/last per year).
  let rangeMin = Number.POSITIVE_INFINITY;
  let rangeMax = Number.NEGATIVE_INFINITY;
  for (const y of yearEntries) {
    if (y.first_extreme_utc) {
      const ms = Date.parse(y.first_extreme_utc);
      if (Number.isFinite(ms) && ms < rangeMin) rangeMin = ms;
    }
    if (y.last_extreme_utc) {
      const ms = Date.parse(y.last_extreme_utc);
      if (Number.isFinite(ms) && ms > rangeMax) rangeMax = ms;
    }
  }
  if (!Number.isFinite(rangeMin) || !Number.isFinite(rangeMax)) {
    throw new Error("manifest has no extremes range");
  }

  return {
    years: yearEntries.map((y) => y.year),
    scrubberRangeMs: { min: rangeMin, max: rangeMax },
    stationsById,
    tideExtremesById,
  };
}
