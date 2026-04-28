// Tide-height formatting helpers. Internal storage is always metres
// (the CHS data shape); these helpers consult the `useFeet` signal
// from the global store so each call site renders in the user's
// chosen unit.

import { useFeet } from "../state/store";

const M_TO_FT = 3.28084;

/** Format a metres value with its unit suffix, e.g. "1.4 m" / "4.6 ft". */
export function formatTideHeight(metres: number): string {
  return useFeet.value
    ? `${(metres * M_TO_FT).toFixed(1)} ft`
    : `${metres.toFixed(1)} m`;
}

/** Format a metres value as a bare number, no unit suffix — used in the
 *  station markers where space is tight and the colour/shape already
 *  carry the meaning. */
export function formatTideValue(metres: number): string {
  return useFeet.value
    ? (metres * M_TO_FT).toFixed(1)
    : metres.toFixed(1);
}

/** Format a current speed in knots with a unit suffix, e.g. "2.6 kt".
 *  The sign carries through; callers can show absolute value if they're
 *  also showing a flood/ebb badge. */
export function formatCurrentSpeed(knots: number): string {
  return `${knots.toFixed(1)} kt`;
}

/** Format a current speed as a bare absolute number — used in the
 *  station markers where space is tight and the arrow direction already
 *  conveys flood vs ebb. */
export function formatCurrentValue(knots: number): string {
  return Math.abs(knots).toFixed(1);
}
