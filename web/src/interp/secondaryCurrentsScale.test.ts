// The proportional rule for absolute-knots Table 4 rows referenced to a
// current primary: the printed large-tide speed scales by the reference's
// actual-over-large-tide ratio, on direct max events and on synthesised
// midpoint maxes alike. Pinned to the Dent Rapids / Gillard Passage
// numbers that IWLS confirmed (notes/iwls_api.md §5): Gillard large-tide
// maxima 12.5 / 9.5 kn, Dent printed 11 / 9.5 kn, so a 4.7 kn Gillard flood
// gives 4.14 kn at Dent (IWLS: 4.15) and a 5.9 kn ebb gives 5.90 (IWLS 6.06).

import { describe, expect, it } from "vitest";
import type { CurrentPrimaryStation, CurrentSecondaryStation } from "../types";
import { classifyCurrentEvents, secondaryCurrentExtremes } from "./secondaryCurrents";

function gillard(events: { time: string; kind: "slack" | "max"; knots: number; weak?: boolean }[]): CurrentPrimaryStation {
  return {
    name: "GILLARD PASSAGE", index_no: 8059, year: 2027, utc_offset: -7, latitude: 0, longitude: 0,
    flood_direction_true: 0, ebb_direction_true: 180, max_flood_knots: 12.5, max_ebb_knots: -9.5,
    days: [{ month: 1, day: 1, events: events.map((e) => ({ time: e.time, kind: e.kind, knots: e.knots, weak_variable: !!e.weak })) }],
  };
}

const dent = (overrides: Partial<CurrentSecondaryStation> = {}): CurrentSecondaryStation => ({
  index_no: 8138, name: "DENT RAPIDS", reference_primary: "GILLARD PASSAGE", offsets_from_tides: false,
  flood_direction_true: 140, latitude: 0, longitude: 0,
  turn_to_flood_diff: "-00:15", turn_to_ebb_diff: "-00:25", flood_max_diff: null, ebb_max_diff: null,
  pct_ref_flood: null, pct_ref_ebb: null, max_flood_knots: 11, max_ebb_knots: 9.5,
  ...overrides,
});

// One flood half-cycle and one ebb half-cycle at Gillard.
const ref = classifyCurrentEvents(gillard([
  { time: "01:00", kind: "slack", knots: 0 },
  { time: "04:00", kind: "max", knots: 4.7 },
  { time: "07:00", kind: "slack", knots: 0 },
  { time: "10:00", kind: "max", knots: -5.9 },
  { time: "13:00", kind: "slack", knots: 0 },
]));
const maxes = (xs: { v: number }[]) => xs.filter((e) => e.v !== 0).map((e) => +e.v.toFixed(2));

describe("proportional rule for absolute-knots rows", () => {
  it("scales synthesised midpoint maxes by the reference's actual/large ratio", () => {
    const out = secondaryCurrentExtremes(dent(), ref, ref, { maxFlood: 12.5, maxEbb: 9.5 });
    expect(maxes(out)).toEqual([+(11 * 4.7 / 12.5).toFixed(2), -(9.5 * 5.9 / 9.5)]);
  });

  it("scales direct max events when Table 4 gives max time diffs", () => {
    const out = secondaryCurrentExtremes(
      dent({ flood_max_diff: "+00:10", ebb_max_diff: "+00:10" }), ref, ref, { maxFlood: 12.5, maxEbb: 9.5 },
    );
    expect(maxes(out)).toEqual([4.14, -5.9]);
    // and the timing is the reference max plus the diff
    const flood = out.find((e) => e.v > 0)!;
    expect(flood.t).toBe(Date.UTC(2027, 0, 1, 4 + 7, 10));
  });

  it("falls back to the flat printed value without a scale (tide-referenced rows) and on weak reference maxes", () => {
    expect(maxes(secondaryCurrentExtremes(dent(), ref, ref, null))).toEqual([11, -9.5]);
    const weakRef = classifyCurrentEvents(gillard([
      { time: "01:00", kind: "slack", knots: 0 },
      { time: "04:00", kind: "max", knots: 0, weak: true },
      { time: "07:00", kind: "slack", knots: 0 },
      { time: "10:00", kind: "max", knots: -5.9 },
      { time: "13:00", kind: "slack", knots: 0 },
    ]));
    expect(maxes(secondaryCurrentExtremes(dent(), weakRef, weakRef, { maxFlood: 12.5, maxEbb: 9.5 }))).toEqual([11, -5.9]);
  });

  it("lets the secondary exceed its printed value when the reference exceeds its large-tide max", () => {
    const big = classifyCurrentEvents(gillard([
      { time: "01:00", kind: "slack", knots: 0 },
      { time: "04:00", kind: "max", knots: 13.0 },
      { time: "07:00", kind: "slack", knots: 0 },
      { time: "10:00", kind: "max", knots: -10.0 },
      { time: "13:00", kind: "slack", knots: 0 },
    ]));
    const out = secondaryCurrentExtremes(dent(), big, big, { maxFlood: 12.5, maxEbb: 9.5 });
    expect(maxes(out)).toEqual([+(11 * 13 / 12.5).toFixed(2), -10]);
  });
});
