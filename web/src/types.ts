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

export type Manifest = {
  generated_at: string;
  years: ManifestYearEntry[];
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
  // Table 2 reference heights — required for secondary-station calculation
  // (Step 6a: interpolate the height diff between mean-tide and large-tide).
  higher_high_water_mean_tide: number;
  higher_high_water_large_tide: number;
  lower_low_water_mean_tide: number;
  lower_low_water_large_tide: number;
  days: TideDay[];
};

export type TidePrimaryFile = {
  year: number;
  stations: TidePrimaryStation[];
};

// ---------------------------------------------------------------
// Secondary tide stations (Table 3 of the CHS volume).
// They are derived from a reference primary station by applying
// per-station time and height differences.
// ---------------------------------------------------------------

export type TideSecondaryStation = {
  index_no: number;
  name: string;
  utc_offset: number;
  latitude: number;
  longitude: number;
  area_number?: number;
  area_name?: string;
  geographic_zone?: string;
  reference_port: string;            // matches a TidePrimaryStation.name
  // "+HH:MM" / "-HH:MM" — the shift applied to each high or low water.
  higher_high_water_time_diff: string;
  higher_high_water_mean_tide_diff: number;
  higher_high_water_large_tide_diff: number;
  lower_low_water_time_diff: string;
  lower_low_water_mean_tide_diff: number;
  lower_low_water_large_tide_diff: number;
  mean_tide_range?: number;
  large_tide_range?: number;
  mean_water_level?: number;
  has_footnote?: boolean;
};

export type TideSecondaryFile = {
  year: number;
  stations: TideSecondaryStation[];
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
  // Tide stations only — large-tide reference heights in metres, used as
  // fixed Y-axis bounds for the tide chart so it doesn't rescale while the
  // user pans the timeline. For primaries these come straight from Table 2;
  // for secondaries they're derived by applying the large-tide diffs to the
  // reference primary's values.
  tide_lhhw?: number;
  tide_lllw?: number;
  // For currents (unused in v1):
  flood_dir?: number | null;
  ebb_dir?: number | null;
};

export type LoadedData = {
  years: number[];
  scrubberRangeMs: { min: number; max: number };
  stationsById: Map<number, StationMeta>;
  // Per-station merged Extreme[], sorted by t ascending.
  // Tides only for v1; currents will live alongside in a parallel map.
  tideExtremesById: Map<number, Extreme[]>;
};
