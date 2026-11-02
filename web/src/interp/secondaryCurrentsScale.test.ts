// Magnitude scaling for absolute-knots Table 4 rows (see RefScale in
// secondaryCurrents.ts). Current-referenced rows scale by the reference's
// actual-over-large ratio, pinned to the Dent Rapids / Gillard Passage
// numbers IWLS confirmed (notes/iwls_api.md §5): Gillard large-tide maxima
// 12.5 / 9.5 kn, Dent printed 11 / 9.5 kn, so a 4.7 kn Gillard flood gives
// 4.14 kn at Dent (IWLS 4.15) and a 5.9 kn ebb gives 5.90 (IWLS 6.06).
// Tide-referenced rows scale by the square root of the half-cycle range
// over the port's large-tide range (§9).

import { describe, expect, it } from "vitest";
import type { CurrentPrimaryStation, CurrentSecondaryStation, Extreme } from "../types";
import {
  buildCurrentRefScale,
  classifyCurrentEvents,
  classifyLowerLows,
  classifyTideAsCurrent,
  secondaryCurrentExtremes,
} from "./secondaryCurrents";
import { classifyHiLow } from "./secondaryTides";

type Ev = { time: string; kind: "slack" | "max"; knots: number; weak?: boolean };
const h = (hr: number, min = 0) => Date.UTC(2027, 0, 1, hr + 7, min);
const hhmm = (hr: number) => `${String(Math.floor(hr / 24) === 0 ? hr : hr % 24).padStart(2, "0")}:00`;

function primary(events: Ev[], maxFlood = 12.5, maxEbb = -9.5, day = 1): CurrentPrimaryStation {
  return {
    name: "GILLARD PASSAGE", index_no: 8059, year: 2027, utc_offset: -7, latitude: 0, longitude: 0,
    flood_direction_true: 0, ebb_direction_true: 180, max_flood_knots: maxFlood, max_ebb_knots: maxEbb,
    days: [{ month: 1, day, events: events.map((e) => ({ time: e.time, kind: e.kind, knots: e.knots, weak_variable: !!e.weak })) }],
  };
}
/** Six 12-hour cycles across three days: slack, flood max, slack, ebb max. */
function multiDay(flood: (i: number) => Ev, ebbKnots = -5.0, maxFlood = 12.5, maxEbb = -9.5): CurrentPrimaryStation {
  const days: CurrentPrimaryStation["days"] = [];
  for (let d = 0; d < 3; d++) {
    const events: Ev[] = [];
    for (const base of [0, 12]) {
      const i = d * 2 + (base === 12 ? 1 : 0);
      events.push({ time: hhmm(base), kind: "slack", knots: 0 });
      events.push({ ...flood(i), time: hhmm(base + 3) });
      events.push({ time: hhmm(base + 6), kind: "slack", knots: 0 });
      events.push({ time: hhmm(base + 9), kind: "max", knots: ebbKnots });
    }
    days.push({ month: 1, day: d + 1, events: events.map((e) => ({ time: e.time, kind: e.kind, knots: e.knots, weak_variable: !!e.weak })) });
  }
  return { ...primary([], maxFlood, maxEbb), days };
}
function scaledOf(p: CurrentPrimaryStation) {
  const classified = classifyCurrentEvents(p);
  return { classified, scale: buildCurrentRefScale(p, classified) };
}
const dent = (overrides: Partial<CurrentSecondaryStation> = {}): CurrentSecondaryStation => ({
  index_no: 8138, name: "DENT RAPIDS", reference_primary: "GILLARD PASSAGE", offsets_from_tides: false,
  flood_direction_true: 140, latitude: 0, longitude: 0,
  turn_to_flood_diff: "-00:15", turn_to_ebb_diff: "-00:25", flood_max_diff: null, ebb_max_diff: null,
  pct_ref_flood: null, pct_ref_ebb: null, max_flood_knots: 11, max_ebb_knots: 9.5,
  ...overrides,
});
const maxes = (xs: Extreme[]) => xs.filter((e) => e.v !== 0 || e.weak).map((e) => (e.weak ? "weak" : +e.v.toFixed(2)));

const normal: Ev[] = [
  { time: "01:00", kind: "slack", knots: 0 },
  { time: "04:00", kind: "max", knots: 4.7 },
  { time: "07:00", kind: "slack", knots: 0 },
  { time: "10:00", kind: "max", knots: -5.9 },
  { time: "13:00", kind: "slack", knots: 0 },
];

describe("proportional rule, current reference", () => {
  it("scales synthesised midpoint maxes by the reference's actual/large ratio", () => {
    const { classified, scale } = scaledOf(primary(normal));
    expect(maxes(secondaryCurrentExtremes(dent(), classified, classified, scale))).toEqual([+(11 * 4.7 / 12.5).toFixed(2), -(9.5 * 5.9 / 9.5)]);
  });

  it("scales direct max events when Table 4 gives max time diffs, keeping their timing", () => {
    const { classified, scale } = scaledOf(primary(normal));
    const out = secondaryCurrentExtremes(dent({ flood_max_diff: "+00:10", ebb_max_diff: "+00:10" }), classified, classified, scale);
    expect(maxes(out)).toEqual([4.14, -5.9]);
    expect(out.find((e) => e.v > 0)!.t).toBe(h(4, 10));
  });

  it("lets the secondary exceed its printed value when the reference exceeds its large-tide max", () => {
    const { classified, scale } = scaledOf(primary([
      { time: "01:00", kind: "slack", knots: 0 }, { time: "04:00", kind: "max", knots: 13.0 },
      { time: "07:00", kind: "slack", knots: 0 }, { time: "10:00", kind: "max", knots: -10.0 }, { time: "13:00", kind: "slack", knots: 0 },
    ]));
    expect(maxes(secondaryCurrentExtremes(dent(), classified, classified, scale))).toEqual([+(11 * 13 / 12.5).toFixed(2), -10]);
  });

  it("takes the largest same-kind reference max between the bracketing reference slacks (double hump)", () => {
    const { classified, scale } = scaledOf(primary([
      { time: "01:00", kind: "slack", knots: 0 }, { time: "03:30", kind: "max", knots: 2.0 }, { time: "05:30", kind: "max", knots: 6.0 },
      { time: "07:00", kind: "slack", knots: 0 }, { time: "10:00", kind: "max", knots: -5.9 }, { time: "13:00", kind: "slack", knots: 0 },
    ]));
    const out = secondaryCurrentExtremes(dent(), classified, classified, scale);
    expect(out.find((e) => e.v > 0)!.v).toBeCloseTo(11 * 6.0 / 12.5, 5);
  });

  it("falls back to the flat printed value without a scale", () => {
    const { classified } = scaledOf(primary(normal));
    expect(maxes(secondaryCurrentExtremes(dent(), classified, classified, null))).toEqual([11, -9.5]);
  });

  it("a weak reference max on a scaled direction gives a weak secondary max, never the printed speed", () => {
    const p = multiDay((i) => (i === 2 ? { time: "", kind: "max", knots: 0, weak: true } : { time: "", kind: "max", knots: 4.0 }));
    const { classified, scale } = scaledOf(p);
    expect(scale.scaleFlood).toBe(true);   // 1 of 6 weak
    for (const row of [dent(), dent({ flood_max_diff: "+00:00", ebb_max_diff: "+00:00" })]) {
      const out = secondaryCurrentExtremes(row, classified, classified, scale);
      expect(out.filter((e) => e.weak).length).toBe(1);
      expect(out.filter((e) => e.v > 0).every((e) => Math.abs(e.v - 11 * 4.0 / 12.5) < 1e-9)).toBe(true);
      expect(out.some((e) => e.v === 11)).toBe(false);
      // year maximum never exceeds secMax × max ref ratio
      expect(Math.max(...out.map((e) => e.v))).toBeLessThanOrEqual(11 * 4.0 / 12.5 + 1e-9);
    }
  });

  it("a weak-dominated reference direction stays flat (Johnstone Strait Central's floods) while the other direction scales", () => {
    const p = multiDay((i) => (i === 0 ? { time: "", kind: "max", knots: 0.4 } : { time: "", kind: "max", knots: 0, weak: true }), -1.2, 1.5, -1.5);
    const { classified, scale } = scaledOf(p);
    expect(scale.scaleFlood).toBe(false);  // 5 of 6 weak
    expect(scale.scaleEbb).toBe(true);
    const alertBay = dent({ name: "ALERT BAY", flood_max_diff: "+00:00", ebb_max_diff: "+00:00", max_flood_knots: 4.0, max_ebb_knots: 4.0 });
    const out = secondaryCurrentExtremes(alertBay, classified, classified, scale);
    const floods = out.filter((e) => e.v > 0); const ebbs = out.filter((e) => e.v < 0);
    expect(floods.length).toBe(6);
    expect(floods.every((e) => e.v === 4.0)).toBe(true);              // flat for weak and real alike: no inversion
    expect(ebbs.every((e) => Math.abs(e.v + 4.0 * 1.2 / 1.5) < 1e-9)).toBe(true);
    expect(out.filter((e) => e.weak).length).toBe(0);
  });

  it("a reference max of exactly 0 kn gives a weak secondary max, not the printed speed", () => {
    const p = multiDay((i) => ({ time: "", kind: "max", knots: i === 1 ? 0 : 4.0 }));
    const { classified, scale } = scaledOf(p);
    const out = secondaryCurrentExtremes(dent({ flood_max_diff: "+00:00", ebb_max_diff: "+00:00" }), classified, classified, scale);
    expect(out.some((e) => e.v === 11)).toBe(false);
    expect(out.filter((e) => e.weak).length).toBe(1);
  });

  it("Haro Strait style: conditional ebb delay together with a current scale", () => {
    const { classified, scale } = scaledOf(primary([
      { time: "01:00", kind: "slack", knots: 0 }, { time: "04:00", kind: "max", knots: 1.0 },
      { time: "07:00", kind: "slack", knots: 0 }, { time: "10:00", kind: "max", knots: -5.9 }, { time: "13:00", kind: "slack", knots: 0 },
    ]));
    const out = secondaryCurrentExtremes(dent({ turn_to_ebb_conditional: { below_knots: 2.0, add: "+01:10" } }), classified, classified, scale);
    const slacks = out.filter((e) => e.v === 0 && !e.weak).map((e) => e.t);
    // 01:00 slack-to-flood → −00:15; 07:00 slack-to-ebb → −00:25 + 1:10 (preceding flood 1.0 < 2.0);
    // 13:00 slack-to-flood → −00:15.
    expect(slacks).toEqual([h(0, 45), h(6, 35) + 70 * 60_000, h(12, 45)]);
    expect(out.find((e) => e.v > 0)!.v).toBeCloseTo(11 * 1.0 / 12.5, 5);
    expect(out.find((e) => e.v < 0)!.v).toBeCloseTo(-(9.5 * 5.9 / 9.5), 5);
  });
});

describe("square-root rule, tide reference", () => {
  const tideRef = (heights: [number, number][]) => {
    const tide = heights.map(([hr, v]) => ({ t: h(hr), v }));
    const isHi = classifyHiLow(tide);
    return { tide, isHi, classified: classifyTideAsCurrent(tide, isHi) };
  };

  it("scales each synthesised peak by sqrt(half-cycle range / large-tide range)", () => {
    const { classified } = tideRef([[0, 1.0], [6, 4.0], [12, 0.5]]);
    const malibu = dent({
      index_no: 7863, name: "MALIBU RAPIDS", reference_primary: "POINT ATKINSON", offsets_from_tides: true,
      turn_to_flood_diff: "+00:35", turn_to_ebb_diff: "+00:25", max_flood_knots: 9, max_ebb_knots: 9,
    });
    const out = secondaryCurrentExtremes(malibu, classified, classified, { kind: "tide", largeRange: 4.9 });
    expect(maxes(out)).toEqual([+(9 * Math.sqrt(3.0 / 4.9)).toFixed(2), -+(9 * Math.sqrt(3.5 / 4.9)).toFixed(2)]);
    expect(maxes(secondaryCurrentExtremes(malibu, classified, classified, null))).toEqual([9, -9]);
  });

  it("Nitinat Bar: per-LW turn offsets and per-pair ranges on a mixed tide", () => {
    const { tide, isHi } = tideRef([[0, 1.5], [6, 3.5], [12, 0.2], [18, 3.0], [24, 1.5]]);
    const lowerLW = classifyLowerLows(tide, isHi, -7);
    const classified = classifyTideAsCurrent(tide, isHi, lowerLW);
    const nitinat = dent({
      index_no: 8533, name: "NITINAT BAR", reference_primary: "TOFINO", offsets_from_tides: true,
      turn_to_flood_diff: "+02:00", turn_to_ebb_diff: "+02:15", lower_lw_turn_to_flood_diff: "+03:00",
      max_flood_knots: 8, max_ebb_knots: 8,
    });
    const out = secondaryCurrentExtremes(nitinat, classified, classified, { kind: "tide", largeRange: 4.1 });
    const slacks = out.filter((e) => e.v === 0 && !e.weak).map((e) => e.t);
    expect(lowerLW.some(Boolean)).toBe(true);
    for (let i = 0; i < tide.length; i++) {
      const expected = isHi[i] ? tide[i].t + 135 * 60_000 : tide[i].t + (lowerLW[i] ? 180 : 120) * 60_000;
      expect(slacks).toContain(expected);
    }
    const peaks = out.filter((e) => e.v !== 0);
    const ranges = [2.0, 3.3, 2.8, 1.5];  // 1.5→3.5, 3.5→0.2, 0.2→3.0, 3.0→1.5
    expect(peaks.map((e) => +Math.abs(e.v).toFixed(3))).toEqual(ranges.map((r) => +(8 * Math.sqrt(r / 4.1)).toFixed(3)));
  });
});
