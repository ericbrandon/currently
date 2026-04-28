// Shared TypeScript types.
//
// The "JSON" types mirror the shape produced by read_tct.py exactly. The
// "loaded" / "merged" types are the in-memory representations the rest of
// the app works with after the loader has fetched and processed them.

// ---------------------------------------------------------------
// Manifest (web/public/data/manifest.json)
// ---------------------------------------------------------------

export type ManifestYearEntry = {
  year: number;
  tidal_primary?: string;
  tidal_secondary?: string;
  current_primary?: string;
  current_secondary?: string;
  first_extreme_utc: string | null;
  last_extreme_utc: string | null;
};

export type ManifestVolume = {
  name: string;
  years: ManifestYearEntry[];
};

export type Manifest = {
  generated_at: string;
  volumes: Record<string, ManifestVolume>;
};

// ---------------------------------------------------------------
// Per-station JSON shapes (from read_tct.py)
// ---------------------------------------------------------------

export type TideReading = { time: string; metres: number };
export type TideDay = { month: number; day: number; readings: TideReading[] };

export type TidePrimaryStation = {
  name: string;
  index_no: number;
  year: number;
  utc_offset: number;
  latitude: number;
  longitude: number;
  timezone?: string;
  tide_type?: string;
  reference_name?: string | null;
  mean_tide_range?: number | null;
  large_tide_range?: number | null;
  days: TideDay[];
};

export type TidePrimaryFile = {
  year: number;
  stations: TidePrimaryStation[];
};

// ---------------------------------------------------------------
// Internal flat representation used by the interpolator
// ---------------------------------------------------------------

/** A single published extreme in absolute UTC ms.
 *  For tides, v is height in metres.
 *  For currents (later), v is signed knots.
 *  `weak` is set on weak/variable current maxes (`*` in the PDF). */
export type Extreme = { t: number; v: number; weak?: boolean };

// ---------------------------------------------------------------
// Per-station merged metadata + extremes (the loader's output)
// ---------------------------------------------------------------

export type StationKind =
  | "tide-primary"
  | "tide-secondary"
  | "current-primary"
  | "current-secondary";

export type StationMeta = {
  station_id: number;          // CHS index_no, stable across years
  name: string;
  kind: StationKind;
  latitude: number;
  longitude: number;
  // For currents (unused in v1):
  flood_dir?: number | null;
  ebb_dir?: number | null;
};

export type LoadedVolume = {
  volume: string;
  name: string;
  years: number[];
  scrubberRangeMs: { min: number; max: number };
  stationsById: Map<number, StationMeta>;
  // Per-station merged Extreme[], sorted by t ascending.
  // Tides only for v1; currents will live alongside in a parallel map.
  tideExtremesById: Map<number, Extreme[]>;
};
