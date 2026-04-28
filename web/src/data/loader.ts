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
  CurrentPrimaryFile,
  CurrentPrimaryStation,
  CurrentSecondaryFile,
  Extreme,
  LoadedData,
  Manifest,
  StationMeta,
  TidePrimaryFile,
  TidePrimaryStation,
  TideSecondaryFile,
} from "../types";
import { currentExtremes, tideExtremes } from "../interp/extremes";
import {
  classifyHiLow,
  secondaryTideExtremes,
} from "../interp/secondaryTides";
import {
  type ClassifiedCurrentEvent,
  classifyCurrentEvents,
  classifyTideAsCurrent,
  hasMagnitudeData,
  secondaryCurrentExtremes,
} from "../interp/secondaryCurrents";

/** Alias map for current-station references that don't match exactly
 *  between Table 4's reference column and the primary current header.
 *  Vol 5: secondary "JOHNSTONE STRAIT-CENTRAL" ↔ primary "JOHNSTONE STR. CEN.". */
const CURRENT_REF_ALIASES: Record<string, string> = {
  "JOHNSTONE STRAIT-CENTRAL": "JOHNSTONE STR. CEN.",
};

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

  const [
    tidePrimaryFiles,
    tideSecondaryFiles,
    currentPrimaryFiles,
    currentSecondaryFiles,
  ] = await Promise.all([
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
    Promise.all(
      yearEntries.map(async (y) => {
        if (!y.current_primary) return null;
        const r = await fetch(`data/${y.current_primary}`);
        if (!r.ok) {
          throw new Error(`current primary fetch failed: ${y.current_primary} (${r.status})`);
        }
        return (await r.json()) as CurrentPrimaryFile;
      }),
    ),
    Promise.all(
      yearEntries.map(async (y) => {
        if (!y.current_secondary) return null;
        const r = await fetch(`data/${y.current_secondary}`);
        if (!r.ok) {
          throw new Error(`current secondary fetch failed: ${y.current_secondary} (${r.status})`);
        }
        return (await r.json()) as CurrentSecondaryFile;
      }),
    ),
  ]);

  const stationsById = new Map<number, StationMeta>();
  const tideExtremesByStation = new Map<number, Extreme[][]>();
  const currentExtremesByStation = new Map<number, Extreme[][]>();

  const pushTo = (
    bucket: Map<number, Extreme[][]>,
    id: number,
    ext: Extreme[],
  ) => {
    const list = bucket.get(id);
    if (list) list.push(ext);
    else bucket.set(id, [ext]);
  };
  const pushExtremes = (id: number, ext: Extreme[]) => pushTo(tideExtremesByStation, id, ext);

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
    if (secFile) {
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
    }

    // Per-year primary current lookup, classified once per primary and
    // shared across every secondary that references it. Tide-referenced
    // secondaries (offsets_from_tides=true) reuse the tide refByName
    // built above, adapted via classifyTideAsCurrent.
    type CurRefEntry = {
      station: CurrentPrimaryStation;
      classified: ClassifiedCurrentEvent[];
    };
    const curRefByName = new Map<string, CurRefEntry>();

    const curFile = currentPrimaryFiles[i];
    if (curFile) {
      for (const c of curFile.stations) {
        const ext = currentExtremes(c);
        // Symmetric Y-axis bound for the current chart: the larger of
        // the station's two reference max magnitudes. max_ebb_knots is
        // signed negative in the JSON, so take its absolute value.
        const maxMag = Math.max(
          Math.abs(c.max_flood_knots),
          Math.abs(c.max_ebb_knots),
        );
        stationsById.set(c.index_no, {
          station_id: c.index_no,
          name: c.name,
          kind: "current-primary",
          latitude: c.latitude,
          longitude: c.longitude,
          flood_dir: c.flood_direction_true,
          ebb_dir: c.ebb_direction_true,
          current_max_knots: maxMag,
        });
        pushTo(currentExtremesByStation, c.index_no, ext);
        curRefByName.set(c.name, { station: c, classified: classifyCurrentEvents(c) });
      }
    }

    const curSecFile = currentSecondaryFiles[i];
    if (curSecFile) {
      for (const sec of curSecFile.stations) {
        // Resolve the reference. Either a current primary (with optional
        // alias) or — for offsets_from_tides — a tide primary, adapted.
        let refClassified: ClassifiedCurrentEvent[] | null = null;
        if (sec.offsets_from_tides) {
          const tideRef = refByName.get(sec.reference_primary);
          if (tideRef) {
            refClassified = classifyTideAsCurrent(tideRef.extremes, tideRef.classified);
          }
        } else {
          const aliased = CURRENT_REF_ALIASES[sec.reference_primary] ?? sec.reference_primary;
          const curRef = curRefByName.get(aliased);
          if (curRef) refClassified = curRef.classified;
        }
        if (!refClassified) {
          console.warn(
            `secondary current ${sec.index_no} ${sec.name} references unknown ${sec.offsets_from_tides ? "tide" : "current"} primary "${sec.reference_primary}"`,
          );
          continue;
        }

        // Skip stations with no magnitude data entirely (BARONET PASSAGE,
        // DRANEY NARROWS). CHS publishes time differences for them but no
        // percentage or absolute knots, so we can't calculate a flow value
        // — better to omit them from the map than render a markerless dot.
        if (!hasMagnitudeData(sec)) continue;

        // Y-axis bound from whichever magnitude rule the station uses; for
        // percentage rows we approximate with the ref's own bound (best
        // signal of the station's full-scale range).
        const ebbDir = (sec.flood_direction_true + 180) % 360;
        let bound: number | undefined;
        if (sec.max_flood_knots !== null || sec.max_ebb_knots !== null) {
          bound = Math.max(
            Math.abs(sec.max_flood_knots ?? 0),
            Math.abs(sec.max_ebb_knots ?? 0),
          );
        } else if (
          (sec.pct_ref_flood !== null || sec.pct_ref_ebb !== null) &&
          !sec.offsets_from_tides
        ) {
          const aliased = CURRENT_REF_ALIASES[sec.reference_primary] ?? sec.reference_primary;
          const curRef = curRefByName.get(aliased);
          if (curRef) {
            const pf = sec.pct_ref_flood ?? 0;
            const pe = sec.pct_ref_ebb ?? 0;
            bound = Math.max(
              (pf / 100) * Math.abs(curRef.station.max_flood_knots),
              (pe / 100) * Math.abs(curRef.station.max_ebb_knots),
            );
          }
        }

        stationsById.set(sec.index_no, {
          station_id: sec.index_no,
          name: sec.name,
          kind: "current-secondary",
          latitude: sec.latitude,
          longitude: sec.longitude,
          flood_dir: sec.flood_direction_true,
          ebb_dir: ebbDir,
          current_max_knots: bound,
        });

        const ext = secondaryCurrentExtremes(sec, refClassified);
        if (ext.length > 0) pushTo(currentExtremesByStation, sec.index_no, ext);
      }
    }
  });

  const flattenPerYear = (
    bucket: Map<number, Extreme[][]>,
  ): Map<number, Extreme[]> => {
    const out = new Map<number, Extreme[]>();
    for (const [id, perYear] of bucket) {
      out.set(
        id,
        perYear.length === 1
          ? perYear[0]
          : perYear.flat().sort((a: Extreme, b: Extreme) => a.t - b.t),
      );
    }
    return out;
  };
  const tideExtremesById = flattenPerYear(tideExtremesByStation);
  const currentExtremesById = flattenPerYear(currentExtremesByStation);

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
    currentExtremesById,
  };
}
