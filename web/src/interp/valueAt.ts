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

export type TideState = "flood" | "ebb" | "slack";

const SLACK_WINDOW_MS = 5 * 60 * 1000;

/** Returns both the interpolated tide value and the *phase* of the tide
 *  at time t: rising (flood), falling (ebb), or near a turnaround (slack).
 *  Slack is true within ±SLACK_WINDOW_MS of either surrounding extreme. */
export function tideStateAt(
  extremes: Extreme[],
  t: number,
): { state: TideState | null; value: number | null } {
  const n = extremes.length;
  if (n < 2 || t < extremes[0].t || t > extremes[n - 1].t) {
    return { state: null, value: null };
  }

  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (extremes[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const e1 = extremes[lo];
  const e2 = extremes[hi];
  if (e2.t === e1.t) return { state: "slack", value: e1.v };

  const tau = (t - e1.t) / (e2.t - e1.t);
  const value = (e1.v + e2.v) / 2 + ((e1.v - e2.v) / 2) * Math.cos(Math.PI * tau);

  if (t - e1.t < SLACK_WINDOW_MS || e2.t - t < SLACK_WINDOW_MS) {
    return { state: "slack", value };
  }
  return { state: e2.v > e1.v ? "flood" : "ebb", value };
}

export type CurrentState = "flood" | "ebb" | "slack";

/** Below this magnitude (knots) we render the current as a slack circle
 *  rather than a directional arrow. Picks up the genuine zero crossings as
 *  well as the weak/variable max events that we serialise as v=0. */
const SLACK_KNOTS = 0.1;

/** Piecewise sinusoidal interpolation between two consecutive published
 *  current events. Unlike tides — where every published event (HW or LW) is
 *  an extremum with zero slope — current events alternate between
 *  zero-crossings (slacks and weak/variable maxes, v=0) and true peaks
 *  (signed maxes). The shape of each segment depends on which kind of
 *  endpoint sits on each side:
 *
 *    slack → peak   → quarter-sine     v(τ) = v₂ · sin(πτ/2)
 *    peak  → slack  → quarter-cosine   v(τ) = v₁ · cos(πτ/2)
 *    peak  → peak   → half-cosine      (same as tides; both ends are extrema)
 *    slack → slack  → 0                (rare; conservative)
 *
 *  This matches the marine-navigation "50-90 rule" (50% / 87%-≈90% / 100%
 *  at thirds of the slack→max segment) and makes the chart curve C¹-
 *  continuous at every max while letting it cross zero with full slope at
 *  every slack — which is what a real tidal current does. */
function currentSegment(
  v1: number, v2: number, tau: number,
): number {
  const z1 = v1 === 0;
  const z2 = v2 === 0;
  if (z1 && z2) return 0;
  if (z1) return v2 * Math.sin(Math.PI * tau / 2);
  if (z2) return v1 * Math.cos(Math.PI * tau / 2);
  return (v1 + v2) / 2 + ((v1 - v2) / 2) * Math.cos(Math.PI * tau);
}

/** Interpolated signed knots at absolute UTC ms `t`, using the piecewise
 *  quarter-cycle shape described in `currentSegment`. Returns null outside
 *  the published range. */
export function currentValueAt(extremes: Extreme[], t: number): number | null {
  const n = extremes.length;
  if (n < 2) return null;
  if (t < extremes[0].t || t > extremes[n - 1].t) return null;

  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (extremes[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const e1 = extremes[lo];
  const e2 = extremes[hi];
  if (e2.t === e1.t) return e1.v;

  const tau = (t - e1.t) / (e2.t - e1.t);
  return currentSegment(e1.v, e2.v, tau);
}

/** Returns the interpolated signed knots at time `t` plus the phase
 *  (flood / ebb / slack) and a weak flag that tracks the surrounding
 *  weak/variable max events. */
export function currentStateAt(
  extremes: Extreme[],
  t: number,
): { state: CurrentState | null; value: number | null; weak: boolean } {
  const n = extremes.length;
  if (n < 2 || t < extremes[0].t || t > extremes[n - 1].t) {
    return { state: null, value: null, weak: false };
  }

  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (extremes[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const e1 = extremes[lo];
  const e2 = extremes[hi];
  if (e2.t === e1.t) {
    return { state: "slack", value: e1.v, weak: !!(e1.weak || e2.weak) };
  }

  const tau = (t - e1.t) / (e2.t - e1.t);
  const value = currentSegment(e1.v, e2.v, tau);
  const weak = !!((e1.weak && tau < 0.5) || (e2.weak && tau >= 0.5));

  if (Math.abs(value) < SLACK_KNOTS) {
    return { state: "slack", value, weak };
  }
  return { state: value > 0 ? "flood" : "ebb", value, weak };
}
