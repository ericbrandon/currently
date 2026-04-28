// Secondary-station tide extreme builder.
//
// Reference: chs-shc-tct-tmc-vol5-2026 §"Prediction of Tides at Secondary
// Ports" (p. 85) and §"Calculation of Intermediate Times or Heights"
// (p. 87, Step 6a — the more-precise interpolated height-diff method).
//
// Each reading in the reference port's published HW/LW list becomes one
// secondary-station extreme: time is shifted by the published per-event
// time difference, height is shifted by a height difference linearly
// interpolated between the mean-tide and large-tide diffs based on where
// the reference reading sits between the reference port's mean-tide and
// large-tide HHW (for high waters) or LLW (for low waters) heights.
// Extrapolation outside [mean, large] is permitted (per Step 6a).
//
// The resulting Extreme[] feeds into the same sinusoidal `valueAt` used
// for primary stations — secondary stations behave identically downstream.

import type {
  Extreme,
  TidePrimaryStation,
  TideSecondaryStation,
} from "../types";

/** Classify each entry in a sorted reference-port Extreme[] as a high
 *  water (true) or low water (false) by comparing to its neighbours.
 *  Computed once per primary station and reused across every secondary
 *  station that points at that primary. */
export function classifyHiLow(refExtremes: Extreme[]): boolean[] {
  const n = refExtremes.length;
  const isHi = new Array<boolean>(n);
  for (let i = 0; i < n; i++) {
    const v = refExtremes[i].v;
    const prev = i > 0 ? refExtremes[i - 1].v : Number.NEGATIVE_INFINITY;
    const next = i < n - 1 ? refExtremes[i + 1].v : Number.NEGATIVE_INFINITY;
    // ">=" so a degenerate equal-neighbour case still classifies (rare;
    // typically only at array boundaries with the -Infinity sentinel).
    isHi[i] = v >= prev && v >= next;
  }
  return isHi;
}

/** Parse "+HH:MM" / "-HH:MM" (or "HH:MM") to milliseconds. */
function parseSignedHHMM(s: string): number {
  const sign = s.charCodeAt(0) === 0x2d /* - */ ? -1 : 1;
  const body = s.charCodeAt(0) === 0x2b || s.charCodeAt(0) === 0x2d ? s.slice(1) : s;
  const colon = body.indexOf(":");
  const hh = +body.slice(0, colon);
  const mm = +body.slice(colon + 1);
  return sign * (hh * 3600_000 + mm * 60_000);
}

/** Build the full Extreme[] for a secondary tide station from its
 *  reference port's already-built (sorted, absolute-UTC-ms) extremes. */
export function secondaryTideExtremes(
  sec: TideSecondaryStation,
  refExtremes: Extreme[],
  ref: TidePrimaryStation,
  refIsHi: boolean[],
): Extreme[] {
  const dtHwMs = parseSignedHHMM(sec.higher_high_water_time_diff);
  const dtLwMs = parseSignedHHMM(sec.lower_low_water_time_diff);

  const dhHwMean = sec.higher_high_water_mean_tide_diff;
  const dhHwLarge = sec.higher_high_water_large_tide_diff;
  const dhLwMean = sec.lower_low_water_mean_tide_diff;
  const dhLwLarge = sec.lower_low_water_large_tide_diff;

  // Reference port's Table 2 heights.
  const hwMean = ref.higher_high_water_mean_tide;
  const hwLarge = ref.higher_high_water_large_tide;
  const lwMean = ref.lower_low_water_mean_tide;
  const lwLarge = ref.lower_low_water_large_tide;

  // Pre-compute the linear-interpolation slopes to avoid a divide per row.
  // dh = dhMean + ratio * (dhLarge - dhMean), ratio = (v - hMean) / (hLarge - hMean).
  // → dh = dhMean + (v - hMean) * slope, slope = (dhLarge - dhMean) / (hLarge - hMean).
  // If hLarge == hMean (degenerate), fall back to the mean diff alone.
  const hwDenom = hwLarge - hwMean;
  const lwDenom = lwLarge - lwMean;
  const hwSlope = hwDenom !== 0 ? (dhHwLarge - dhHwMean) / hwDenom : 0;
  const lwSlope = lwDenom !== 0 ? (dhLwLarge - dhLwMean) / lwDenom : 0;

  const n = refExtremes.length;
  const out = new Array<Extreme>(n);
  for (let i = 0; i < n; i++) {
    const e = refExtremes[i];
    if (refIsHi[i]) {
      const dh = dhHwMean + (e.v - hwMean) * hwSlope;
      out[i] = { t: e.t + dtHwMs, v: e.v + dh };
    } else {
      const dh = dhLwMean + (e.v - lwMean) * lwSlope;
      out[i] = { t: e.t + dtLwMs, v: e.v + dh };
    }
  }

  // Time shifts can in principle reorder consecutive extremes when the HW
  // and LW shifts differ by more than the gap between them. Sort defensively
  // — for the vast majority of stations the array is already sorted and
  // Array.prototype.sort on a near-sorted array is fast.
  out.sort(byT);
  return out;
}

function byT(a: Extreme, b: Extreme): number {
  return a.t - b.t;
}
