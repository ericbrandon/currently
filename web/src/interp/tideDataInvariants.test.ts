// Data-invariant tests over the published tide files in public/data/.
// Tide-side counterpart of dataInvariants.test.ts (currents): globs every
// year directory so freshly added years (2027, …) are covered the day
// they land. Encodes the manual audit of 2026-07-05 (see "Postscript:
// tide-side audit" in notes/secondary_current_fix_plan.md): parser
// fidelity pins, reference resolution, alternation, and the known bounds
// of the CHS difference-method artifacts (neap inversions, sub-datum
// lows) so a parser or classifier regression can't hide inside them.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  Extreme,
  TidePrimaryFile,
  TidePrimaryStation,
  TideSecondaryFile,
  TideSecondaryStation,
} from "../types";
import { suffixAlias } from "../data/loader";
import { tideExtremes } from "./extremes";
import { classifyHiLow, secondaryTideExtremes } from "./secondaryTides";

const dataDir = fileURLToPath(new URL("../../public/data", import.meta.url));

type YearData = {
  year: string;
  primaries: TidePrimaryStation[];
  secondaries: TideSecondaryStation[];
};

function loadYears(): YearData[] {
  const out: YearData[] = [];
  for (const year of readdirSync(dataDir)) {
    if (!/^\d{4}$/.test(year)) continue;
    const yearDir = join(dataDir, year);
    const files = readdirSync(yearDir);
    const pf = files.find((f) => f.startsWith("tidal_primary."));
    const sf = files.find((f) => f.startsWith("tidal_secondary."));
    if (!pf || !sf) continue;
    out.push({
      year,
      primaries: (JSON.parse(readFileSync(join(yearDir, pf), "utf8")) as TidePrimaryFile).stations,
      secondaries: (JSON.parse(readFileSync(join(yearDir, sf), "utf8")) as TideSecondaryFile).stations,
    });
  }
  return out;
}

const years = loadYears();

function daysInYear(y: number): number {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
}

/** Reference lookup mirroring the loader: exact name, then suffix alias. */
function buildRefMap(primaries: TidePrimaryStation[]) {
  const m = new Map<string, { p: TidePrimaryStation; ext: Extreme[]; isHi: boolean[] }>();
  for (const p of primaries) {
    const ext = tideExtremes(p);
    const entry = { p, ext, isHi: classifyHiLow(ext) };
    m.set(p.name, entry);
    const a = suffixAlias(p.name);
    if (a && !m.has(a)) m.set(a, entry);
  }
  return m;
}

describe("published tide data", () => {
  it("has at least one year of stations", () => {
    expect(years.length).toBeGreaterThan(0);
  });

  it("primaries have a full year of clean, alternating readings", () => {
    for (const { year, primaries } of years) {
      expect(primaries.length, `${year}: primary count`).toBeGreaterThanOrEqual(20);
      for (const p of primaries) {
        expect(p.days.length, `${year} ${p.name}: day count`).toBe(daysInYear(p.year));
        const ext = tideExtremes(p);
        const isHi = classifyHiLow(ext);
        // Printed readings alternate HW/LW; allow a small tie budget from
        // 0.1 m rounding on vanishing neap tides.
        let same = 0;
        for (let i = 1; i < isHi.length; i++) if (isHi[i] === isHi[i - 1]) same++;
        expect(same, `${year} ${p.name}: non-alternating readings`).toBeLessThanOrEqual(20);
        for (const e of ext) {
          expect(e.v, `${year} ${p.name}: height out of range`).toBeGreaterThan(-1);
          expect(e.v, `${year} ${p.name}: height out of range`).toBeLessThan(16);
        }
      }
    }
  });

  it("every secondary resolves its reference port", () => {
    for (const { year, primaries, secondaries } of years) {
      expect(secondaries.length, `${year}: secondary count`).toBeGreaterThanOrEqual(250);
      const refs = buildRefMap(primaries);
      for (const s of secondaries) {
        expect(
          refs.get(s.reference_port),
          `${year} ${s.index_no} ${s.name}: unresolved reference "${s.reference_port}"`,
        ).toBeDefined();
      }
    }
  });

  it("keeps the deliberate US-border suppressions suppressed", () => {
    // coord_overrides.json `_suppress_index_nos`: these CHS rows duplicate
    // NOAA harmonic stations and must not re-appear after a regeneration.
    const suppressed = [7050, 7060, 7215, 7570, 8512];
    for (const { year, secondaries } of years) {
      const present = new Set(secondaries.map((s) => s.index_no));
      for (const idx of suppressed) {
        expect(present.has(idx), `${year}: suppressed station ${idx} re-appeared`).toBe(false);
      }
    }
  });

  it("pins the parser output for hand-verified Table 3 rows", () => {
    // These rows were checked character-by-character against the 2026
    // PDFs (audit 2026-07-05). If a parser change shifts a column or a
    // sign anywhere, these are the canaries. Year-scoped: applies to
    // every published year on the assumption CHS rows change rarely; if
    // a future book legitimately revises one, update the pin.
    const pins: Record<number, Partial<TideSecondaryStation>> = {
      7194: {
        // YOKEKO POINT — mixed signs across columns
        higher_high_water_time_diff: "-00:19",
        higher_high_water_mean_tide_diff: 0.1,
        higher_high_water_large_tide_diff: 0.1,
        lower_low_water_time_diff: "+00:25",
        lower_low_water_mean_tide_diff: -0.9,
        lower_low_water_large_tide_diff: -1.0,
      },
      9470: {
        // DAVIS RIVER — largest height diffs in the dataset
        higher_high_water_mean_tide_diff: -1.1,
        higher_high_water_large_tide_diff: -1.3,
        lower_low_water_mean_tide_diff: -1.3,
        lower_low_water_large_tide_diff: -1.2,
      },
      7240: {
        // FRIDAY HARBOR — zero time diff edge case
        higher_high_water_time_diff: "+00:00",
        lower_low_water_time_diff: "+00:03",
      },
    };
    for (const { year, secondaries } of years) {
      for (const [idxStr, want] of Object.entries(pins)) {
        const s = secondaries.find((x) => x.index_no === Number(idxStr));
        expect(s, `${year}: pinned station ${idxStr} missing`).toBeDefined();
        for (const [field, value] of Object.entries(want)) {
          expect(
            (s as unknown as Record<string, unknown>)[field],
            `${year} ${s!.name}.${field}`,
          ).toBe(value);
        }
      }
    }
  });

  it("keeps secondary outputs within the known artifact envelope", () => {
    // The CHS difference method legitimately produces neap inversions
    // (computed HW below adjacent LW on vanishing tides) and sub-datum
    // extreme lows. 2026 baselines: 54/263 stations invert, worst
    // magnitude 0.63 m (DEEP COVE); deepest low -1.32 m (YOKEKO POINT).
    // Bound both loosely — a sign flip or column shift in the parser
    // would blow far past these, while ordinary year-to-year variation
    // stays inside.
    for (const { year, primaries, secondaries } of years) {
      const refs = buildRefMap(primaries);
      let stationsWithInversions = 0;
      for (const sec of secondaries) {
        const r = refs.get(sec.reference_port)!;
        const out = secondaryTideExtremes(sec, r.ext, r.p, r.isHi);
        expect(out.length, `${year} ${sec.name}: event count`).toBe(r.ext.length);
        for (let i = 1; i < out.length; i++) {
          expect(out[i].t, `${year} ${sec.name}: unsorted output`).toBeGreaterThanOrEqual(out[i - 1].t);
        }
        let min = Infinity;
        let max = -Infinity;
        for (const e of out) {
          if (e.v < min) min = e.v;
          if (e.v > max) max = e.v;
        }
        // Inversion depth needs HW/LW identity, which the sorted combined
        // output loses. A same-type subset keeps its order through the
        // builder (one uniform time shift), so shift HWs and LWs
        // separately, tag, merge, and walk.
        const hwExt = r.ext.filter((_, i) => r.isHi[i]);
        const lwExt = r.ext.filter((_, i) => !r.isHi[i]);
        const hwOut = secondaryTideExtremes(sec, hwExt, r.p, hwExt.map(() => true));
        const lwOut = secondaryTideExtremes(sec, lwExt, r.p, lwExt.map(() => false));
        const tagged = [
          ...hwOut.map((o) => ({ hi: true, o })),
          ...lwOut.map((o) => ({ hi: false, o })),
        ].sort((a, b) => a.o.t - b.o.t);
        let worstInv = 0;
        for (let i = 1; i < tagged.length; i++) {
          const a = tagged[i - 1];
          const b = tagged[i];
          if (a.hi === b.hi) continue;
          const depth = b.hi ? a.o.v - b.o.v : b.o.v - a.o.v;
          if (depth > worstInv) worstInv = depth;
        }
        if (worstInv > 0) stationsWithInversions++;
        expect(min, `${year} ${sec.name}: implausibly deep low (${min.toFixed(2)} m)`).toBeGreaterThan(-2.0);
        expect(max, `${year} ${sec.name}: implausibly high high (${max.toFixed(2)} m)`).toBeLessThan(16);
        expect(
          worstInv,
          `${year} ${sec.name}: inversion depth ${worstInv.toFixed(2)} m — parser sign/column regression?`,
        ).toBeLessThan(1.0);
      }
      expect(
        stationsWithInversions,
        `${year}: inversion-station count far above 2026 baseline of 54`,
      ).toBeLessThan(100);
    }
  });
});
