// Per-station extreme array builders. Convert station-local clock times
// (as printed in the CHS PDF, parsed by read_tct.py) to absolute UTC ms.
//
// Reference: notes/calculating_primary_tides_and_currents.md §"TypeScript
// implementation" and §"Time zone & DST handling".

import type { Extreme, TidePrimaryStation } from "../types";

/** Convert a station-local clock time (from the PDF) to absolute UTC ms.
 *  utc_offset is whatever the PDF's page header declared (e.g. -8 for PST).
 *  We never apply manual DST shifts here — that's the display layer's job. */
export function stationTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hhmm: string,
  utcOffset: number,
): number {
  const [hh, mm] = hhmm.split(":").map(Number);
  return Date.UTC(year, month - 1, day, hh - utcOffset, mm);
}

/** Flatten a primary tide station's per-day readings into one sorted Extreme[]. */
export function tideExtremes(s: TidePrimaryStation): Extreme[] {
  const out: Extreme[] = [];
  for (const d of s.days) {
    for (const r of d.readings) {
      out.push({
        t: stationTimeToUtcMs(s.year, d.month, d.day, r.time, s.utc_offset),
        v: r.metres,
      });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
