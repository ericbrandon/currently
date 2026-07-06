// Data-invariant tests over the published year files in public/data/.
// These glob every year directory, so freshly added years (2027, …) are
// covered automatically — the point is to catch data-shape surprises in
// a new CHS volume before they silently break classification again.
// See notes/secondary_current_fix_plan.md.

import { readFileSync, readdirSync } from "node:fs";
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
  classifyCurrentEvents,
  hasMagnitudeData,
  secondaryCurrentExtremes,
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
        "SCHOONER", "SLINGSBY", "HAYDEN",
      ]) {
        expect(byName(frag), `${year}: continuation-page station ${frag} missing`).toBeDefined();
      }
      for (const frag of ["ALERT BAY", "PULTENEY"]) {
        expect(
          byName(frag)?.turn_reference_primary,
          `${year}: ${frag} should turn-reference Seymour Narrows`,
        ).toBe("SEYMOUR NARROWS");
      }
    }
  });
});
