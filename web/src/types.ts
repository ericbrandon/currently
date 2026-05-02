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
  // NOAA US stations (per us_data/convert_to_tct.py). NOAA combines what
  // CHS splits into primary/secondary, so we just have one tide file and
  // one current file; the US_secondary flag inside each station is a
  // zoom-visibility hint, not a different prediction model.
  noaa_tidal_primary?: string;
  noaa_current_primary?: string;
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
// Primary current stations (Table 4 of the CHS volume).
// Each event is either a slack (knots = 0) or a max (signed knots:
// positive = flood, negative = ebb). Weak/variable maxes are flagged
// with `weak_variable: true` and serialised as knots = 0; the
// interpolator preserves this so the curve actually crosses zero.
// ---------------------------------------------------------------

export type CurrentEvent = {
  time: string;
  kind: "slack" | "max";
  knots: number;
  // Omit-when-default: published JSON omits this field whenever it's
  // false (~99% of events). A missing field is equivalent to false.
  // See build_manifest.py:_strip_event_defaults.
  weak_variable?: boolean;
};

export type CurrentDay = {
  month: number;
  day: number;
  weekday?: string;
  events: CurrentEvent[];
};

export type CurrentPrimaryStation = {
  name: string;
  index_no: number;
  year: number;
  utc_offset: number;
  latitude: number;
  longitude: number;
  timezone?: string;
  flood_direction_true: number | null;
  ebb_direction_true: number | null;
  // Reference max magnitudes — used as the symmetric Y-axis bound on
  // the current chart so the curve doesn't rescale while the user pans.
  max_flood_knots: number;
  max_ebb_knots: number;
  days: CurrentDay[];
};

export type CurrentPrimaryFile = {
  year: number;
  stations: CurrentPrimaryStation[];
};

// ---------------------------------------------------------------
// Secondary current stations (Table 4 secondary rows).
// Each one references either a primary current station (whose slack/max
// events get time-shifted and rate-adjusted) or, when offsets_from_tides
// is true, a primary tide port (whose HW/LW times become turn-to-ebb /
// turn-to-flood slacks). Magnitude is given either as a percentage of
// the reference station's max (pct_ref_*) or as an absolute large-tide
// max in knots (max_*_knots); see calculating_secondary_currents.md.
// ---------------------------------------------------------------

export type CurrentSecondaryStation = {
  index_no: number;
  name: string;
  reference_primary: string;             // matches a CurrentPrimaryStation.name (with alias)
                                         // or a TidePrimaryStation.name when offsets_from_tides
  offsets_from_tides: boolean;
  flood_direction_true: number;          // always populated; ebb is flood + 180°
  latitude: number;
  longitude: number;
  // "+HH:MM" / "-HH:MM" — applied to the corresponding ref event time.
  // Slack diffs are always present; max diffs may be null (synthesise
  // the max at the midpoint between adjacent slacks instead).
  turn_to_flood_diff: string;
  turn_to_ebb_diff: string;
  flood_max_diff: string | null;
  ebb_max_diff: string | null;
  // Magnitude rule. Mutually exclusive in vol 5; both null is allowed
  // (BARONET PASSAGE, DRANEY NARROWS) and means "no magnitude data —
  // skip from the interpolator". The chart and panel render an empty
  // state for those.
  pct_ref_flood: number | null;
  pct_ref_ebb: number | null;
  max_flood_knots: number | null;
  max_ebb_knots: number | null;
  has_footnote: boolean;
  name_annotation?: string | null;
  geographic_zone?: string | null;
  format_note?: string | null;
};

export type CurrentSecondaryFile = {
  year: number;
  stations: CurrentSecondaryStation[];
};

// ---------------------------------------------------------------
// NOAA US station JSON shapes (from us_data/convert_to_tct.py).
//
// NOAA fans out one prediction file per station for the whole year, so
// every station is "primary-shaped" — no time/height-difference rows like
// CHS Table 3/4. The `US_secondary` boolean is a UI zoom hint only (NOAA
// labels these "Subordinate" stations), not a different prediction model.
// ---------------------------------------------------------------

export type NoaaTidePrimaryStation = {
  name: string;                  // short — used for the marker label pill
  NOAA_station_name: string;     // long — used for chart/table panel headers
  NOAA_short_name: string | null;
  timezone?: string;
  utc_offset: number;
  year: number;
  noaa_id: string;
  latitude: number | null;
  longitude: number | null;
  US_secondary: boolean;
  days: TideDay[];
};

export type NoaaTidePrimaryFile = {
  year: number;
  stations: NoaaTidePrimaryStation[];
};

export type NoaaCurrentPrimaryStation = {
  name: string;
  NOAA_station_name: string;
  NOAA_short_name: string | null;
  timezone?: string;
  utc_offset: number;
  year: number;
  flood_direction_true: number | null;
  ebb_direction_true: number | null;
  noaa_id: string;
  noaa_bin: number | null;
  latitude: number | null;
  longitude: number | null;
  // Either may be null for stations with no max events in the year.
  max_flood_knots: number | null;
  max_ebb_knots: number | null;
  US_secondary: boolean;
  days: CurrentDay[];
};

export type NoaaCurrentPrimaryFile = {
  year: number;
  stations: NoaaCurrentPrimaryStation[];
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

export type StationSource = "chs" | "noaa";

export type StationMeta = {
  // Namespaced canonical key — `chs:${index_no}` for CHS, `noaa:${noaa_id}`
  // for NOAA tide stations, `noaa:${noaa_id}:${noaa_bin}` for NOAA currents.
  // NOAA tide IDs are numeric strings ("9447130") and current IDs are
  // alphanumeric ("PUG1701"), so a flat numeric ID space wouldn't work.
  station_id: string;
  source: StationSource;
  // The short name used on the map marker pill. For NOAA, this is
  // `NOAA_short_name` (or the sanitized long name as a fallback).
  name: string;
  // The longer, more descriptive name used in chart and panel headers.
  // Undefined for CHS stations (which only publish one name); the panel
  // and chart fall back to `name` in that case.
  display_name?: string;
  kind: StationKind;
  latitude: number;
  longitude: number;
  // Tide stations only — Y-axis bounds for the tide chart so it doesn't
  // rescale while the user pans. For CHS primaries these are Table 2's
  // large-tide reference heights; for CHS secondaries they're derived by
  // applying the large-tide diffs. For NOAA stations the loader derives
  // them from the year's observed min/max with a small pad, since NOAA's
  // hilo predictions don't carry mean/large-tide reference heights.
  tide_lhhw?: number;
  tide_lllw?: number;
  // Current stations only — true bearings (degrees) for the rotated
  // arrow marker, and the symmetric Y-axis magnitude bound used by the
  // current chart (max of |max_flood_knots|, |max_ebb_knots|).
  flood_dir?: number | null;
  ebb_dir?: number | null;
  current_max_knots?: number;
  // NOAA-only metadata, surfaced for debugging and zoom-level visibility.
  noaa_id?: string;
  noaa_bin?: number | null;
  us_secondary?: boolean;
};

export type LoadedData = {
  years: number[];
  scrubberRangeMs: { min: number; max: number };
  stationsById: Map<string, StationMeta>;
  // Per-station merged Extreme[], sorted by t ascending.
  tideExtremesById: Map<string, Extreme[]>;
  currentExtremesById: Map<string, Extreme[]>;
};
