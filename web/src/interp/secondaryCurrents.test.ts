// Unit tests for classifyCurrentEvents — in particular the weak/variable
// max direction resolution. A weak max (`*` in the CHS tables) is a faded
// peak sitting BETWEEN two opposite peaks, so it must classify by
// alternation parity, not by copying the nearest signed neighbour's sign
// (the pre-2026-07 bug that zeroed every flood at the Johnstone Strait
// Central secondaries). See notes/secondary_current_fix_plan.md.

import { describe, expect, it } from "vitest";
import type { CurrentPrimaryStation, CurrentSecondaryStation } from "../types";
import {
  classifyCurrentEvents,
  secondaryCurrentExtremes,
} from "./secondaryCurrents";

// Compact event spec: ["HH:MM", knots] is a signed max, ["HH:MM", "*"] a
// weak/variable max, ["HH:MM"] a slack (turn).
type Spec = [string, number] | [string, "*"] | [string];

function station(specs: Spec[]): CurrentPrimaryStation {
  return {
    name: "TEST",
    index_no: 0,
    year: 2026,
    utc_offset: -8,
    latitude: 0,
    longitude: 0,
    flood_direction_true: 0,
    ebb_direction_true: 180,
    max_flood_knots: 1,
    max_ebb_knots: 1,
    days: [
      {
        month: 1,
        day: 1,
        events: specs.map((s) =>
          s.length === 1
            ? { time: s[0], kind: "slack" as const, knots: 0 }
            : s[1] === "*"
            ? { time: s[0], kind: "max" as const, knots: 0, weak_variable: true }
            : { time: s[0], kind: "max" as const, knots: s[1] },
        ),
      },
    ],
  };
}

function kinds(specs: Spec[]): string[] {
  return classifyCurrentEvents(station(specs)).map((e) => e.kind);
}

describe("classifyCurrentEvents", () => {
  it("classifies signed maxes by sign and slacks by the next max", () => {
    expect(
      kinds([["00:10"], ["03:00", 1.2], ["06:10"], ["09:00", -1.4]]),
    ).toEqual(["slack-to-flood", "max-flood", "slack-to-ebb", "max-ebb"]);
  });

  it("resolves a weak max between two ebbs as a faded flood (JSC Jan 1 pattern)", () => {
    // Real Johnstone Strait Central Jan 1 2026: weak, ebb, weak, ebb, lone
    // slack — no turns bracket the weak maxes at all.
    expect(
      kinds([["00:05", "*"], ["05:45", -0.8], ["11:24", "*"], ["18:01", -1.3], ["22:39"]]),
    ).toEqual(["max-flood", "max-ebb", "max-flood", "max-ebb", "slack-to-flood"]);
  });

  it("handles the mixed real-flood day (JSC Jan 4 pattern)", () => {
    expect(
      kinds([
        ["00:10"],
        ["01:34", 0.3],
        ["03:05"],
        ["07:22", -1.0],
        ["13:35", "*"],
        ["19:52", -1.3],
      ]),
    ).toEqual([
      "slack-to-flood",
      "max-flood",
      "slack-to-ebb",
      "max-ebb",
      "max-flood",
      "max-ebb",
    ]);
  });

  it("resolves a weak max between two floods as a faded ebb (Scott Channel shape)", () => {
    expect(kinds([["02:00", 2.0], ["08:00", "*"], ["14:00", 2.2]])).toEqual([
      "max-flood",
      "max-ebb",
      "max-flood",
    ]);
  });

  it("classifies a slack before a weak flood as slack-to-flood", () => {
    // Regression: the old nearest-signed-value rule looked past the weak
    // max to the ebb and called this slack-to-ebb.
    expect(kinds([["00:10"], ["03:00", "*"], ["09:00", -1.4]])).toEqual([
      "slack-to-flood",
      "max-flood",
      "max-ebb",
    ]);
  });

  it("resolves an edge weak max from its single anchor", () => {
    expect(kinds([["00:30", "*"], ["06:00", -1.0], ["12:00", 1.0]])).toEqual([
      "max-flood",
      "max-ebb",
      "max-flood",
    ]);
    expect(kinds([["00:30", -1.0], ["06:00", 1.0], ["12:00", "*"]])).toEqual([
      "max-ebb",
      "max-flood",
      "max-ebb",
    ]);
  });

  it("keeps direct signs through alternation violations (double ebb)", () => {
    // Juan de Fuca East prints consecutive same-sign maxes when a flood
    // vanishes entirely — signed maxes must never be re-interpreted.
    expect(
      kinds([["01:00", 1.0], ["06:00", -0.5], ["11:00", -2.0], ["17:00", 1.1]]),
    ).toEqual(["max-flood", "max-ebb", "max-ebb", "max-flood"]);
  });

  it("lets the nearer anchor win when consecutive weaks force a parity conflict", () => {
    expect(
      kinds([["01:00", -1.0], ["05:00", "*"], ["09:00", "*"], ["13:00", -2.0]]),
    ).toEqual(["max-ebb", "max-flood", "max-flood", "max-ebb"]);
  });

  it("does not crash on an all-weak series (defaults flood)", () => {
    expect(kinds([["01:00", "*"], ["07:00", "*"]])).toEqual([
      "max-flood",
      "max-flood",
    ]);
  });

  it("keeps v strictly 0 on slacks and weak maxes", () => {
    const out = classifyCurrentEvents(
      station([["00:10"], ["03:00", "*"], ["06:10"], ["09:00", -1.4]]),
    );
    for (const e of out) {
      if (e.weak || e.kind.startsWith("slack")) expect(e.v).toBe(0);
    }
  });
});

// ------------------------------------------------------------------
// secondaryCurrentExtremes — weak reference-max propagation (Phase 2)
// ------------------------------------------------------------------

function secondary(over: Partial<CurrentSecondaryStation>): CurrentSecondaryStation {
  return {
    index_no: 9999,
    name: "TEST SECONDARY",
    reference_primary: "TEST",
    offsets_from_tides: false,
    flood_direction_true: 100,
    latitude: 0,
    longitude: 0,
    turn_to_flood_diff: "+00:00",
    turn_to_ebb_diff: "+00:00",
    flood_max_diff: "+00:00",
    ebb_max_diff: "+00:00",
    pct_ref_flood: null,
    pct_ref_ebb: null,
    max_flood_knots: null,
    max_ebb_knots: null,
    has_footnote: false,
    ...over,
  };
}

describe("secondaryCurrentExtremes weak-ref handling", () => {
  // JSC-like reference day: weak (faded flood), ebb, weak, ebb.
  const ref = classifyCurrentEvents(
    station([["00:05", "*"], ["05:45", -0.8], ["11:24", "*"], ["18:01", -1.3]]),
  );

  it("emits the published magnitude for weak ref maxes at knots-rule secondaries", () => {
    // Per the book, the knots column IS the secondary's rate ("given
    // directly"); the reference contributes timing only, so its `*`
    // must not zero the secondary (the Alert Bay bug).
    const ext = secondaryCurrentExtremes(
      secondary({ max_flood_knots: 4.0, max_ebb_knots: 4.0 }),
      ref,
    );
    expect(ext.map((e) => e.v)).toEqual([4.0, -4.0, 4.0, -4.0]);
    expect(ext.every((e) => !e.weak)).toBe(true);
  });

  it("keeps weak ref maxes at 0 with weak flag for percentage-rule secondaries", () => {
    // Percentage rule multiplies the ref's rate — unusable when the ref
    // prints `*`, so 0 + weak is the only defensible value.
    const ext = secondaryCurrentExtremes(
      secondary({ pct_ref_flood: 50, pct_ref_ebb: 50 }),
      ref,
    );
    expect(ext.map((e) => e.v)).toEqual([0, -0.4, 0, -0.65]);
    expect(ext.map((e) => !!e.weak)).toEqual([true, false, true, false]);
  });

  it("takes slacks from the turn reference and maxes from the rate reference", () => {
    // ALERT BAY / PULTENEY POINT (vol 6 footnote (a)): turn diffs apply
    // to Seymour Narrows' turns, max diffs and rates to Johnstone
    // Strait-Central's maxes.
    const turnRef = classifyCurrentEvents(
      station([["01:00"], ["04:00", 5.0], ["07:00"], ["10:00", -5.0]]),
    );
    const rateRef = classifyCurrentEvents(
      station([["03:30", "*"], ["09:30", -1.0]]),
    );
    const ext = secondaryCurrentExtremes(
      secondary({
        max_flood_knots: 4.0,
        max_ebb_knots: 4.0,
        turn_to_flood_diff: "-01:00",
        turn_to_ebb_diff: "-01:00",
        flood_max_diff: "+00:00",
        ebb_max_diff: "+00:00",
        turn_reference_primary: "TURN REF",
      }),
      rateRef,
      turnRef,
    );
    const hhmm = (t: number) => {
      const d = new Date(t);
      return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    };
    // Slacks: turnRef's 01:00 / 07:00 local (09:00 / 15:00 UTC at -8)
    // shifted -1:00; maxes: rateRef's 03:30 / 09:30 local (11:30 / 17:30
    // UTC) unshifted, at ±4.0 (weak flood → published magnitude).
    expect(ext.map((e) => [hhmm(e.t), e.v])).toEqual([
      ["08:00", 0],
      ["11:30", 4.0],
      ["14:00", 0],
      ["17:30", -4.0],
    ]);
    // The turn ref's own maxes (±5.0) must NOT leak into the output.
    expect(ext.some((e) => Math.abs(e.v) === 5.0)).toBe(false);
  });

  it("emits weak zero when the matching magnitude column is null", () => {
    // hasMagnitudeData passes on the ebb column alone; the flood side
    // has no published rate, so a weak ref flood stays 0 + weak.
    const ext = secondaryCurrentExtremes(
      secondary({ max_ebb_knots: 2.0 }),
      ref,
    );
    expect(ext.map((e) => e.v)).toEqual([0, -2.0, 0, -2.0]);
    expect(ext.map((e) => !!e.weak)).toEqual([true, false, true, false]);
  });
});
