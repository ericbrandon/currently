// Per-station extreme array builders. Convert station-local clock times
// (as printed in the CHS PDF, parsed by read_tct.py) to absolute UTC ms.
//
// Reference: notes/calculating_primary_tides_and_currents.md §"TypeScript
// implementation" and §"Time zone & DST handling".

import type { CurrentDay, Extreme, TideDay } from "../types";

// Structural minimum for the extreme builders below. CHS primaries and
// NOAA stations both satisfy these — the builders touch only year,
// utc_offset, and the days array, so we don't constrain to one source.
type TideSeries = { year: number; utc_offset: number; days: TideDay[] };
type CurrentSeries = { year: number; utc_offset: number; days: CurrentDay[] };

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
export function tideExtremes(s: TideSeries): Extreme[] {
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

/** Flatten a primary current station's per-day events into one sorted Extreme[].
 *  Slack → v=0. Max → v=signed knots. Weak/variable max (`*` in the PDF) →
 *  v=0 with weak=true, so the cosine interpolator passes through zero at
 *  the published instant rather than drawing a straight line between the
 *  surrounding flood/ebb maxes. */
export function currentExtremes(s: CurrentSeries): Extreme[] {
  const out: Extreme[] = [];
  for (const d of s.days) {
    for (const e of d.events) {
      const t = stationTimeToUtcMs(s.year, d.month, d.day, e.time, s.utc_offset);
      const isWeak = e.kind === "max" && e.weak_variable;
      out.push({
        t,
        v: e.kind === "slack" ? 0 : isWeak ? 0 : e.knots,
        ...(isWeak ? { weak: true } : {}),
      });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
