// Data-invariant tests over the published year files in public/data/.
// These glob every year directory, so freshly added years (2027, …) are
// covered automatically — the point is to catch data-shape surprises in
// a new CHS volume before they silently break classification again.
// See notes/secondary_current_fix_plan.md.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  CurrentPrimaryFile,
  CurrentPrimaryStation,
  CurrentSecondaryFile,
} from "../types";
import { CURRENT_REF_ALIASES } from "../data/loader";
import {
  WEAK_DOMINATED_SHARE,
  classifyCurrentEvents,
  hasMagnitudeData,
  secondaryCurrentExtremes,
  weakShares,
} from "./secondaryCurrents";

const dataDir = fileURLToPath(new URL("../../public/data", import.meta.url));

/** Every CHS current-primary station across all published years. */
function chsCurrentPrimaries(): { year: string; station: CurrentPrimaryStation }[] {
  const out: { year: string; station: CurrentPrimaryStation }[] = [];
  for (const year of readdirSync(dataDir)) {
    if (!/^\d{4}$/.test(year)) continue;
    const yearDir = join(dataDir, year);
    for (const f of readdirSync(yearDir)) {
      if (!f.startsWith("current_primary.")) continue;
      const file = JSON.parse(
        readFileSync(join(yearDir, f), "utf8"),
      ) as CurrentPrimaryFile;
      for (const station of file.stations) out.push({ year, station });
    }
  }
  return out;
}

const primaries = chsCurrentPrimaries();

describe("published current-primary data", () => {
  it("has at least one year of stations", () => {
    expect(primaries.length).toBeGreaterThan(0);
  });

  it("keeps every reference's weak share well clear of the proportional rule's threshold, in every year and pooled", () => {
    // The weak-dominated exemption (WEAK_DOMINATED_SHARE) must not hinge
    // on a re-fetch moving a share by a fraction, nor differ between a
    // two-month tail and the full year beside it. Today only Johnstone
    // Strait Central's floods are above the line (~83 %); the next highest
    // is Juan de Fuca-East's floods (~20 %).
    const MARGIN = 0.15;
    const byIndex = new Map<number, { years: string[]; lists: ReturnType<typeof classifyCurrentEvents>[] }>();
    for (const { year, station } of primaries) {
      const e = byIndex.get(station.index_no) ?? { years: [], lists: [] };
      e.years.push(year);
      e.lists.push(classifyCurrentEvents(station));
      byIndex.set(station.index_no, e);
    }
    for (const [idx, { years: ys, lists }] of byIndex) {
      const pooled = weakShares(lists);
      for (const dir of ["flood", "ebb"] as const) {
        expect(
          Math.abs(pooled[dir] - WEAK_DOMINATED_SHARE),
          `${idx} ${dir}: pooled weak share ${pooled[dir].toFixed(3)} too close to the threshold`,
        ).toBeGreaterThan(MARGIN);
        for (let k = 0; k < lists.length; k++) {
          const yearly = weakShares([lists[k]]);
          expect(
            yearly[dir] <= WEAK_DOMINATED_SHARE,
            `${idx} ${dir} ${ys[k]}: per-year decision differs from the pooled one`,
          ).toBe(pooled[dir] <= WEAK_DOMINATED_SHARE);
        }
      }
    }
    const dominated = [...byIndex].filter(([, { lists }]) => weakShares(lists).flood > WEAK_DOMINATED_SHARE || weakShares(lists).ebb > WEAK_DOMINATED_SHARE).map(([idx]) => idx);
    expect(dominated, "weak-dominated directions should be Johnstone Strait Central's floods only").toEqual([8246]);
  });

  it("carries the book's Table 4 large-tide maxima on every CHS current primary", () => {
    // The proportional rule divides by these. Under the IWLS source they
    // exist only because fetch_iwls.py --metadata-from roster copies the
    // book's values; a fetch without the carry-over would silently turn
    // them into the year's largest event. Compare against the book parse
    // at the repo root when it is available.
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    for (const { year, station } of primaries) {
      // The book prints both as magnitudes; the loader takes Math.abs, so
      // only non-zero matters here.
      expect(Math.abs(station.max_flood_knots), `${year} ${station.name}: max_flood_knots`).toBeGreaterThan(0);
      expect(Math.abs(station.max_ebb_knots), `${year} ${station.name}: max_ebb_knots`).toBeGreaterThan(0);
      const bookPath = join(repoRoot, `${year}_tct_current_primary_stations.json`);
      if (existsSync(bookPath)) {
        const book = (JSON.parse(readFileSync(bookPath, "utf8")) as CurrentPrimaryFile).stations
          .find((b) => b.index_no === station.index_no);
        if (book) {
          expect(station.max_flood_knots, `${year} ${station.name}: flood max vs book`).toBe(book.max_flood_knots);
          expect(station.max_ebb_knots, `${year} ${station.name}: ebb max vs book`).toBe(book.max_ebb_knots);
        }
      }
    }
  });

  it("classifies a balanced flood/ebb split at every station", () => {
    // A station's classified maxes must not collapse toward one
    // direction. The 2026 bug classified all 591 of Johnstone Strait
    // Central's weak (faded-flood) maxes as ebbs, leaving 110 floods vs
    // 1301 ebbs (8%). Physically, floods and ebbs come in near-equal
    // numbers, weak or not — 25% is a loose floor (the most lopsided
    // real station, Juan de Fuca East, sits at ~44%).
    for (const { year, station } of primaries) {
      const classified = classifyCurrentEvents(station);
      let flood = 0;
      let ebb = 0;
      for (const e of classified) {
        if (e.kind === "max-flood") flood++;
        else if (e.kind === "max-ebb") ebb++;
      }
      const total = flood + ebb;
      expect(total, `${year} ${station.name}: no max events`).toBeGreaterThan(0);
      const floor = total * 0.25;
      expect(
        flood,
        `${year} ${station.name}: only ${flood}/${total} maxes classified flood`,
      ).toBeGreaterThanOrEqual(floor);
      expect(
        ebb,
        `${year} ${station.name}: only ${ebb}/${total} maxes classified ebb`,
      ).toBeGreaterThanOrEqual(floor);
    }
  });

  it("classifies every Johnstone Strait Central weak max as a faded flood", () => {
    // Pins the original bug precisely: JSC's `*` entries are floods that
    // faded below the printable threshold (the ebb-dominant outflow
    // regime); every one sits between two ebbs.
    const jscs = primaries.filter(({ station }) =>
      station.name.toUpperCase().includes("JOHNSTONE"),
    );
    expect(jscs.length).toBeGreaterThan(0);
    for (const { year, station } of jscs) {
      const weak = classifyCurrentEvents(station).filter((e) => e.weak);
      expect(weak.length, `${year} ${station.name}`).toBeGreaterThan(0);
      for (const e of weak) {
        expect(e.kind, `${year} ${station.name} @ ${new Date(e.t).toISOString()}`).toBe(
          "max-flood",
        );
      }
    }
  });

  it("keeps v strictly 0 on every classified slack and weak max", () => {
    // Contract from notes/calculating_secondary_currents.md —
    // currentValueAt branches on v === 0 to tell slack endpoints from
    // peaks; any float drift here corrupts the curve shape.
    for (const { year, station } of primaries) {
      for (const e of classifyCurrentEvents(station)) {
        if (e.weak || e.kind.startsWith("slack")) {
          expect(e.v, `${year} ${station.name}`).toBe(0);
        }
      }
    }
  });

  it("gives every magnitude-bearing secondary peaks in both directions", () => {
    // The user-visible symptom of the 2026-07 bug: six Johnstone Strait
    // Central secondaries (Alert Bay, Pulteney Point, Camp Point,
    // Current Passage, Masterman/Browning Islands) never floods — the
    // reference's weak maxes zeroed their published magnitudes, so the
    // map arrows pointed one way all year. Tide-referenced secondaries
    // (offsets_from_tides) are exercised elsewhere; they synthesise
    // midpoint peaks from HW/LW and were never at risk.
    for (const year of readdirSync(dataDir)) {
      if (!/^\d{4}$/.test(year)) continue;
      const yearDir = join(dataDir, year);
      const files = readdirSync(yearDir);
      const secFile = files.find((f) => f.startsWith("current_secondary."));
      if (!secFile) continue;
      const secs = (
        JSON.parse(readFileSync(join(yearDir, secFile), "utf8")) as CurrentSecondaryFile
      ).stations;

      const classifiedByName = new Map<
        string,
        ReturnType<typeof classifyCurrentEvents>
      >();
      for (const { station } of primaries.filter((p) => p.year === year)) {
        classifiedByName.set(station.name, classifyCurrentEvents(station));
      }

      for (const sec of secs) {
        if (sec.offsets_from_tides || !hasMagnitudeData(sec)) continue;
        const refName = CURRENT_REF_ALIASES[sec.reference_primary] ?? sec.reference_primary;
        const ref = classifiedByName.get(refName);
        expect(ref, `${year} ${sec.name}: unresolved reference "${sec.reference_primary}"`).toBeDefined();
        let turnRef = ref!;
        if (sec.turn_reference_primary) {
          const turnName =
            CURRENT_REF_ALIASES[sec.turn_reference_primary] ?? sec.turn_reference_primary;
          const resolved = classifiedByName.get(turnName);
          expect(
            resolved,
            `${year} ${sec.name}: unresolved turn reference "${sec.turn_reference_primary}"`,
          ).toBeDefined();
          turnRef = resolved!;
        }
        const ext = secondaryCurrentExtremes(sec, ref!, turnRef);
        const expectsFlood = sec.pct_ref_flood !== null || (sec.max_flood_knots ?? 0) > 0;
        const expectsEbb = sec.pct_ref_ebb !== null || (sec.max_ebb_knots ?? 0) > 0;
        if (expectsFlood) {
          expect(
            ext.some((e) => e.v > 0),
            `${year} ${sec.name}: no flood peaks all year`,
          ).toBe(true);
        }
        if (expectsEbb) {
          expect(
            ext.some((e) => e.v < 0),
            `${year} ${sec.name}: no ebb peaks all year`,
          ).toBe(true);
        }
      }
    }
  });

  it("publishes the Table 4 footnote and continuation-page stations", () => {
    // Guards two parser regressions fixed 2026-07:
    // 1. Table 4 spans multiple pages in vol 6 — 8 stations on the
    //    continuation page were silently dropped for years.
    // 2. Footnote (a) split references: ALERT BAY / PULTENEY POINT turn
    //    diffs key off SEYMOUR NARROWS, not their rate reference.
    for (const year of readdirSync(dataDir)) {
      if (!/^\d{4}$/.test(year)) continue;
      const yearDir = join(dataDir, year);
      const secFile = readdirSync(yearDir).find((f) => f.startsWith("current_secondary."));
      if (!secFile) continue;
      const secs = (
        JSON.parse(readFileSync(join(yearDir, secFile), "utf8")) as CurrentSecondaryFile
      ).stations;
      const byName = (frag: string) =>
        secs.find((s) => s.name.toUpperCase().includes(frag));

      for (const frag of [
        "NAHWITTI", "STUART NARROWS", "NENAHLMAI", "ECLIPSE",
        "SCHOONER", "SLINGSBY", "HAYDEN", "NITINAT",
      ]) {
        expect(byName(frag), `${year}: continuation-page station ${frag} missing`).toBeDefined();
      }
      for (const frag of ["ALERT BAY", "PULTENEY"]) {
        expect(
          byName(frag)?.turn_reference_primary,
          `${year}: ${frag} should turn-reference Seymour Narrows`,
        ).toBe("SEYMOUR NARROWS");
      }
      // HARO STRAIT footnote (a): conditional +1:10 turn-to-ebb.
      expect(
        byName("HARO")?.turn_to_ebb_conditional,
        `${year}: HARO STRAIT conditional missing`,
      ).toEqual({ below_knots: 2.0, add: "+01:10" });
      // NITINAT BAR footnote (b): asymmetric per-LW turn-to-flood.
      const nitinat = byName("NITINAT");
      expect(nitinat?.turn_to_flood_diff, `${year}: NITINAT higher-LW diff`).toBe("+02:00");
      expect(
        nitinat?.lower_lw_turn_to_flood_diff,
        `${year}: NITINAT lower-LW diff`,
      ).toBe("+04:17");
    }
  });
});
