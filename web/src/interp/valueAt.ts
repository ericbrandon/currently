// Sinusoidal interpolation between consecutive published extremes.
//
// Reference: notes/calculating_primary_tides_and_currents.md §"The
// algorithm". Each segment between two consecutive extremes is fitted to
// half a cosine cycle (π radians), so the curve has zero slope at every
// extreme and works for arbitrary asymmetric durations and magnitudes.

import type { Extreme } from "../types";

/** Returns the interpolated value at absolute UTC ms `t`, or null if `t`
 *  falls outside [first, last] extreme of the array. We never extrapolate. */
export function valueAt(extremes: Extreme[], t: number): number | null {
  const n = extremes.length;
  if (n < 2) return null;
  if (t < extremes[0].t || t > extremes[n - 1].t) return null;

  // Binary search: find the largest i such that extremes[i].t <= t.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (extremes[mid].t <= t) lo = mid;
    else hi = mid;
  }

  const e1 = extremes[lo];
  const e2 = extremes[hi];
  if (e2.t === e1.t) return e1.v;     // defensive: zero-duration segment

  const tau = (t - e1.t) / (e2.t - e1.t);
  return (e1.v + e2.v) / 2 + ((e1.v - e2.v) / 2) * Math.cos(Math.PI * tau);
}
