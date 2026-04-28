// Data loader.
//
// Two responsibilities:
//   1. Fetch the manifest (no-cache) at app startup.
//   2. Fetch every year's tide JSONs (primary + secondary) in parallel,
//      build per-station merged Extreme[] across years, and produce the
//      authoritative station metadata map.
//
// Secondary stations are derived per-year by applying Table 3 differences
// to that year's reference primary station's extremes. See
// notes/calculating_primary_tides_and_currents.md and the secondary-tide
// derivation reference in chs-shc-tct-tmc-vol5-2026 §"Prediction of Tides
// at Secondary Ports". Once built, secondary extremes are stored alongside
// primaries in `tideExtremesById` keyed by index_no, so the rest of the
// app treats them identically.

import type {
  Extreme,
  LoadedData,
  Manifest,
  StationMeta,
  TidePrimaryFile,
  TidePrimaryStation,
  TideSecondaryFile,
} from "../types";
import { tideExtremes } from "../interp/extremes";
import {
  classifyHiLow,
  secondaryTideExtremes,
} from "../interp/secondaryTides";

const MANIFEST_URL = "data/manifest.json";

export async function fetchManifest(): Promise<Manifest> {
  const r = await fetch(MANIFEST_URL, { cache: "no-cache" });
  if (!r.ok) throw new Error(`manifest fetch failed: ${r.status}`);
  return (await r.json()) as Manifest;
}

/** CHS sometimes uses the short name in Table 3 references (e.g. "VICTORIA")
 *  while Table 1/2 use a longer form for the same station ("VICTORIA HARBOUR").
 *  Strip a small set of known suffixes to expose an alias. */
function suffixAlias(name: string): string | null {
  const m = name.match(/^(.+?)\s+(HARBOUR|HARBOR|INLET|BAY)$/i);
  return m ? m[1] : null;
}

/** Fetch and merge every year listed in the manifest. */
export async function loadAllYears(manifest: Manifest): Promise<LoadedData> {
  // Years sorted ascending so the "latest year wins" loop reads naturally.
  const yearEntries = [...manifest.years].sort((a, b) => a.year - b.year);
  if (yearEntries.length === 0) {
    throw new Error("manifest contains no years");
  }

  const [tidePrimaryFiles, tideSecondaryFiles] = await Promise.all([
    Promise.all(
      yearEntries.map(async (y) => {
        if (!y.tidal_primary) return null;
        const r = await fetch(`data/${y.tidal_primary}`);
        if (!r.ok) {
          throw new Error(`tide primary fetch failed: ${y.tidal_primary} (${r.status})`);
        }
        return (await r.json()) as TidePrimaryFile;
      }),
    ),
    Promise.all(
      yearEntries.map(async (y) => {
        if (!y.tidal_secondary) return null;
        const r = await fetch(`data/${y.tidal_secondary}`);
        if (!r.ok) {
          throw new Error(`tide secondary fetch failed: ${y.tidal_secondary} (${r.status})`);
        }
        return (await r.json()) as TideSecondaryFile;
      }),
    ),
  ]);

  const stationsById = new Map<number, StationMeta>();
  const extremesByStation = new Map<number, Extreme[][]>();

  const pushExtremes = (id: number, ext: Extreme[]) => {
    const list = extremesByStation.get(id);
    if (list) list.push(ext);
    else extremesByStation.set(id, [ext]);
  };

  yearEntries.forEach((_y, i) => {
    const tideFile = tidePrimaryFiles[i];
    if (!tideFile) return;

    // Per-year primary lookup: by index_no for sanity, by name (and a
    // suffix-stripped alias) for matching secondary references.
    type RefEntry = {
      station: TidePrimaryStation;
      extremes: Extreme[];
      classified: boolean[];
    };
    const refByName = new Map<string, RefEntry>();

    for (const s of tideFile.stations) {
      const ext = tideExtremes(s);
      const entry: RefEntry = { station: s, extremes: ext, classified: classifyHiLow(ext) };
      refByName.set(s.name, entry);
      const alias = suffixAlias(s.name);
      if (alias && !refByName.has(alias)) refByName.set(alias, entry);

      // Latest-year-wins for metadata. Iterating in ascending year order
      // means each assignment overwrites with a later year's data.
      stationsById.set(s.index_no, {
        station_id: s.index_no,
        name: s.name,
        kind: "tide-primary",
        latitude: s.latitude,
        longitude: s.longitude,
        tide_lhhw: s.higher_high_water_large_tide,
        tide_lllw: s.lower_low_water_large_tide,
      });
      pushExtremes(s.index_no, ext);
    }

    const secFile = tideSecondaryFiles[i];
    if (!secFile) return;

    for (const sec of secFile.stations) {
      const ref = refByName.get(sec.reference_port);
      if (!ref) {
        console.warn(
          `secondary station ${sec.index_no} ${sec.name} references unknown primary "${sec.reference_port}"`,
        );
        continue;
      }
      const ext = secondaryTideExtremes(sec, ref.extremes, ref.station, ref.classified);

      // At large tide, secondaryTideExtremes degenerates to ref.X_large + sec.X_large_diff:
      // dh = dhMean + (hLarge - hMean) * slope = dhMean + (dhLarge - dhMean) = dhLarge.
      stationsById.set(sec.index_no, {
        station_id: sec.index_no,
        name: sec.name,
        kind: "tide-secondary",
        latitude: sec.latitude,
        longitude: sec.longitude,
        tide_lhhw: ref.station.higher_high_water_large_tide + sec.higher_high_water_large_tide_diff,
        tide_lllw: ref.station.lower_low_water_large_tide + sec.lower_low_water_large_tide_diff,
      });
      pushExtremes(sec.index_no, ext);
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
