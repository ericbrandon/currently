// Data loader.
//
// Two responsibilities:
//   1. Fetch the manifest (no-cache) at app startup.
//   2. For a given (volume, year-set), fetch the per-year tide JSONs in
//      parallel and merge them into a single LoadedVolume:
//        - per-station extremes concatenated across years and sorted by t
//        - station metadata: latest year wins on conflict
//        - scrubber range = union of all loaded years
//
// v1 scope: primary tide stations only. Currents and secondary stations
// are stubbed in the manifest types but skipped here.

import type {
  Extreme,
  LoadedVolume,
  Manifest,
  StationMeta,
  TidePrimaryFile,
  TidePrimaryStation,
} from "../types";
import { tideExtremes } from "../interp/extremes";

const MANIFEST_URL = "data/manifest.json";

export async function fetchManifest(): Promise<Manifest> {
  const r = await fetch(MANIFEST_URL, { cache: "no-cache" });
  if (!r.ok) throw new Error(`manifest fetch failed: ${r.status}`);
  return (await r.json()) as Manifest;
}

/** Fetch and merge all years of the given volume in the manifest.
 *  Years are loaded in parallel. */
export async function loadVolume(
  manifest: Manifest,
  volume: string,
): Promise<LoadedVolume> {
  const v = manifest.volumes[volume];
  if (!v) throw new Error(`volume ${volume} not in manifest`);

  // Years sorted ascending so the "latest year wins" loop reads naturally.
  const yearEntries = [...v.years].sort((a, b) => a.year - b.year);

  // Fetch each year's tidal_primary JSON in parallel.
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
      // Latest-year-wins for metadata. Because we iterate in ascending year
      // order, every assignment overwrites with a later year's data.
      stationsById.set(s.index_no, {
        station_id: s.index_no,
        name: s.name,
        kind: "tide-primary",
        latitude: s.latitude,
        longitude: s.longitude,
      });

      // Accumulate this year's extremes for this station.
      const list = extremesByStation.get(s.index_no) ?? [];
      list.push(tideExtremes(s));
      extremesByStation.set(s.index_no, list);
    }
  });

  // Concatenate + sort each station's per-year arrays into one sorted Extreme[].
  const tideExtremesById = new Map<number, Extreme[]>();
  for (const [id, perYear] of extremesByStation) {
    const flat: Extreme[] = perYear.length === 1
      ? perYear[0]
      : perYear.flat().sort((a, b) => a.t - b.t);
    tideExtremesById.set(id, flat);
  }

  // Scrubber range = union of all years' extremes (parsed from the manifest
  // strings, which build_manifest.py already computed).
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
    throw new Error(`volume ${volume} has no extremes in manifest`);
  }

  return {
    volume,
    name: v.name,
    years: yearEntries.map((y) => y.year),
    scrubberRangeMs: { min: rangeMin, max: rangeMax },
    stationsById,
    tideExtremesById,
  };
}

// Helper: re-export for callers that want to recompute a single station's
// extremes (e.g. test harness).
export type { TidePrimaryStation };
