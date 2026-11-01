// Report-style comparison of the webapp's derived secondary predictions
// against IWLS's own predictions for the same stations. Not a regression
// test: it is skipped unless IWLS_COMPARE=1, and it asserts only that
// there was something to compare. Run it after
//   venv/bin/python canada_data/fetch_iwls.py --year 2027 --secondaries
//   venv/bin/python canada_data/fetch_iwls.py --year 2027 --add-currents 08138
// with
//   cd web && IWLS_COMPARE=1 IWLS_YEAR=2027 npx vitest run scripts/iwls-secondaries
//
// Two questions it answers:
//   1. Table 3 tide secondaries: how far are our offset-derived HW/LW
//      (secondaryTides.ts) from IWLS's direct wlp-hilo predictions? IWLS has
//      256 of the 263 ports, so this is also the 2028 upgrade path.
//   2. Table 4 current secondaries: IWLS only has Dent Rapids (08138) with
//      events, so that one station checks secondaryCurrents.ts end to end.
// Per-station rows go to the console and to
// canada_data/iwls_raw/<year>/secondary_comparison.tsv (gitignored).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  CurrentPrimaryFile,
  CurrentSecondaryFile,
  Extreme,
  TidePrimaryFile,
  TidePrimaryStation,
  TideSecondaryFile,
} from "../src/types";
import { CURRENT_REF_ALIASES, suffixAlias } from "../src/data/loader";
import { currentExtremes, tideExtremes } from "../src/interp/extremes";
import { classifyHiLow, secondaryTideExtremes } from "../src/interp/secondaryTides";
import {
  classifyCurrentEvents,
  classifyTideAsCurrent,
  hasMagnitudeData,
  secondaryCurrentExtremes,
} from "../src/interp/secondaryCurrents";

const enabled = process.env.IWLS_COMPARE === "1";
const year = Number(process.env.IWLS_YEAR ?? "2027");
// IWLS_ROOT points the report at another directory of {year}_* files, e.g.
// a scratch fetch that includes --add-currents stations not published.
const root = process.env.IWLS_ROOT ?? fileURLToPath(new URL("../../", import.meta.url));
const rawDir = join(root, "canada_data", "iwls_raw", String(year));

function loadJson<T>(name: string): T | null {
  const p = join(root, name);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
}

type Pair = { dtMin: number; dv: number };

/** Greedy nearest-time pairing within `maxMin` minutes. */
function pairUp(a: Extreme[], b: Extreme[], maxMin: number): { pairs: Pair[]; unpairedA: number; unpairedB: number } {
  const used = new Set<number>();
  const pairs: Pair[] = [];
  let j = 0;
  for (const ea of a) {
    let best = -1;
    let bestD = Infinity;
    for (let k = j; k < b.length; k++) {
      const d = (b[k].t - ea.t) / 60_000;
      if (d > maxMin) break;
      if (!used.has(k) && Math.abs(d) <= maxMin && Math.abs(d) < bestD) {
        best = k;
        bestD = Math.abs(d);
      }
    }
    if (best >= 0) {
      used.add(best);
      pairs.push({ dtMin: (b[best].t - ea.t) / 60_000, dv: b[best].v - ea.v });
      while (j < b.length && (used.has(j) || (b[j].t - ea.t) / 60_000 < -maxMin)) j++;
    }
  }
  return { pairs, unpairedA: a.length - pairs.length, unpairedB: b.length - pairs.length };
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
}

const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");

describe.skipIf(!enabled)(`IWLS vs derived secondaries (${year})`, () => {
  it("Table 3 tide secondaries: derived HW/LW vs IWLS wlp-hilo", () => {
    const prim = loadJson<TidePrimaryFile>(`${year}_tct_tidal_primary_stations.json`);
    const sec = loadJson<TideSecondaryFile>(`${year}_tct_tidal_secondary_stations.json`);
    const iwls = loadJson<TidePrimaryFile>(`${year}_iwls_tidal_secondary_predictions.json`);
    expect(prim && sec && iwls, "input files present").toBeTruthy();
    if (!prim || !sec || !iwls) return;

    const refByName = new Map<string, { station: TidePrimaryStation; extremes: Extreme[]; classified: boolean[] }>();
    for (const s of prim.stations) {
      const ext = tideExtremes(s);
      const entry = { station: s, extremes: ext, classified: classifyHiLow(ext) };
      refByName.set(s.name, entry);
      const alias = suffixAlias(s.name);
      if (alias && !refByName.has(alias)) refByName.set(alias, entry);
    }
    const iwlsById = new Map(iwls.stations.map((s) => [s.index_no, s]));

    type Row = {
      idx: number; name: string; ref: string; n: number; unpaired: number;
      dtMed: number; dtP90: number; dtMax: number; dtBias: number;
      dhMed: number; dhP90: number; dhMax: number; dhBias: number;
    };
    const rows: Row[] = [];
    let compared = 0;
    for (const s of sec.stations) {
      const target = iwlsById.get(s.index_no);
      const ref = refByName.get(s.reference_port);
      if (!target || !ref) continue;
      const derived = secondaryTideExtremes(s, ref.extremes, ref.station, ref.classified);
      const direct = tideExtremes(target);
      if (derived.length === 0 || direct.length === 0) continue;
      const { pairs, unpairedA, unpairedB } = pairUp(derived, direct, 90);
      compared++;
      if (process.env.IWLS_DEBUG_TIDE === String(s.index_no)) {
        const isHi = classifyHiLow(derived);
        const hw: number[] = [];
        const lw: number[] = [];
        // re-pair with indices to split by HW/LW
        const used = new Set<number>();
        derived.forEach((e, i) => {
          let best = -1; let bd = Infinity;
          direct.forEach((f, k) => { const d = Math.abs(f.t - e.t) / 60_000; if (!used.has(k) && d <= 90 && d < bd) { best = k; bd = d; } });
          if (best >= 0) { used.add(best); (isHi[i] ? hw : lw).push(direct[best].v - e.v); }
        });
        const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
        console.log(`DEBUG ${s.name}: ref ${s.reference_port}; diffs HW t ${s.higher_high_water_time_diff} mean ${s.higher_high_water_mean_tide_diff} large ${s.higher_high_water_large_tide_diff}; LW t ${s.lower_low_water_time_diff} mean ${s.lower_low_water_mean_tide_diff} large ${s.lower_low_water_large_tide_diff}`);
        console.log(`  HW: n ${hw.length} bias ${f2(mean(hw))} m  |  LW: n ${lw.length} bias ${f2(mean(lw))} m`);
        for (let i = 0; i < 10; i++) {
          const e = derived[i]; const f = direct.reduce((b, x) => Math.abs(x.t - e.t) < Math.abs(b.t - e.t) ? x : b);
          console.log(`  ${new Date(e.t).toISOString().slice(5, 16)} derived ${e.v.toFixed(2)} (${isHi[i] ? "HW" : "LW"})  iwls ${new Date(f.t).toISOString().slice(5, 16)} ${f.v.toFixed(2)}`);
        }
      }
      const adt = pairs.map((p) => Math.abs(p.dtMin));
      const adh = pairs.map((p) => Math.abs(p.dv));
      rows.push({
        idx: s.index_no, name: s.name, ref: s.reference_port, n: pairs.length, unpaired: unpairedA + unpairedB,
        dtMed: quantile(adt, 0.5), dtP90: quantile(adt, 0.9), dtMax: Math.max(...adt),
        dtBias: pairs.reduce((a, p) => a + p.dtMin, 0) / pairs.length,
        dhMed: quantile(adh, 0.5), dhP90: quantile(adh, 0.9), dhMax: Math.max(...adh),
        dhBias: pairs.reduce((a, p) => a + p.dv, 0) / pairs.length,
      });
    }
    rows.sort((a, b) => b.dhP90 - a.dhP90);

    const header = ["idx", "name", "ref", "pairs", "unpaired", "dt_med_min", "dt_p90_min", "dt_max_min", "dt_bias_min",
      "dh_med_m", "dh_p90_m", "dh_max_m", "dh_bias_m"];
    const tsv = [header.join("\t"), ...rows.map((r) => [r.idx, r.name, r.ref, r.n, r.unpaired, f1(r.dtMed), f1(r.dtP90),
      f1(r.dtMax), f1(r.dtBias), f2(r.dhMed), f2(r.dhP90), f2(r.dhMax), f2(r.dhBias)].join("\t"))].join("\n");
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(rawDir, "secondary_comparison.tsv"), tsv + "\n");

    const all = rows.flatMap((r) => [r]);
    const med = (k: keyof Row) => quantile(all.map((r) => r[k] as number), 0.5);
    const lines = [
      `Table 3 secondaries compared: ${compared} (IWLS has ${iwls.stations.length}; book ${sec.stations.length})`,
      `across stations: median of per-station median |dt| ${f1(med("dtMed"))} min, p90 |dt| ${f1(med("dtP90"))} min; ` +
        `median |dh| ${f2(med("dhMed"))} m, p90 |dh| ${f2(med("dhP90"))} m`,
      `stations with p90 |dh| > 0.30 m: ${rows.filter((r) => r.dhP90 > 0.3).length}; with p90 |dt| > 30 min: ${rows.filter((r) => r.dtP90 > 30).length}; ` +
        `with any unpaired events: ${rows.filter((r) => r.unpaired > 0).length}`,
      `worst 15 by p90 |dh|:`,
      ...rows.slice(0, 15).map((r) =>
        `  ${String(r.idx).padStart(5)} ${r.name.padEnd(26)} ref ${r.ref.padEnd(16)} pairs ${String(r.n).padStart(4)} unpaired ${String(r.unpaired).padStart(3)} ` +
        `|dt| med/p90/max ${f1(r.dtMed)}/${f1(r.dtP90)}/${f1(r.dtMax)} min (bias ${f1(r.dtBias)})  ` +
        `|dh| med/p90/max ${f2(r.dhMed)}/${f2(r.dhP90)}/${f2(r.dhMax)} m (bias ${f2(r.dhBias)})`),
      `full table: ${join(rawDir, "secondary_comparison.tsv")}`,
    ];
    console.log(lines.join("\n"));
    expect(compared).toBeGreaterThan(0);
  });

  it("Table 4 current secondaries: derived events vs IWLS wcp1-events (Dent Rapids)", () => {
    const prim = loadJson<CurrentPrimaryFile>(`${year}_tct_current_primary_stations.json`);
    const sec = loadJson<CurrentSecondaryFile>(`${year}_tct_current_secondary_stations.json`);
    const tidePrim = loadJson<TidePrimaryFile>(`${year}_tct_tidal_primary_stations.json`);
    const iwls = loadJson<CurrentPrimaryFile>(`${year}_iwls_current_primary_stations.json`);
    expect(prim && sec && tidePrim && iwls, "input files present").toBeTruthy();
    if (!prim || !sec || !tidePrim || !iwls) return;

    const curRefByName = new Map(prim.stations.map((c) => [c.name, classifyCurrentEvents(c)]));
    const curScaleByName = new Map(prim.stations.map((c) => [c.name, {
      maxFlood: Math.abs(c.max_flood_knots), maxEbb: Math.abs(c.max_ebb_knots),
    }]));
    const tideRefByName = new Map<string, { extremes: Extreme[]; classified: boolean[] }>();
    for (const s of tidePrim.stations) {
      const ext = tideExtremes(s);
      const e = { extremes: ext, classified: classifyHiLow(ext) };
      tideRefByName.set(s.name, e);
      const a = suffixAlias(s.name);
      if (a && !tideRefByName.has(a)) tideRefByName.set(a, e);
    }
    const bookIdx = new Set(prim.stations.map((c) => c.index_no));
    const targets = iwls.stations.filter((c) => !bookIdx.has(c.index_no));
    let compared = 0;
    for (const target of targets) {
      const s = sec.stations.find((x) => x.index_no === target.index_no);
      if (!s || !hasMagnitudeData(s)) {
        console.log(`IWLS current station ${target.index_no} ${target.name}: not a Table 4 secondary with magnitude data; skipped`);
        continue;
      }
      let refClassified = null;
      if (s.offsets_from_tides) {
        const r = tideRefByName.get(s.reference_primary);
        if (r) refClassified = classifyTideAsCurrent(r.extremes, r.classified);
      } else {
        refClassified = curRefByName.get(CURRENT_REF_ALIASES[s.reference_primary] ?? s.reference_primary) ?? null;
      }
      if (!refClassified) {
        console.log(`${s.name}: reference ${s.reference_primary} not found; skipped`);
        continue;
      }
      let turnRef = refClassified;
      if (s.turn_reference_primary) {
        turnRef = curRefByName.get(CURRENT_REF_ALIASES[s.turn_reference_primary] ?? s.turn_reference_primary) ?? refClassified;
      }
      const refScale = s.offsets_from_tides
        ? null
        : curScaleByName.get(CURRENT_REF_ALIASES[s.reference_primary] ?? s.reference_primary) ?? null;
      const derived = secondaryCurrentExtremes(s, refClassified, turnRef, refScale);
      const direct = currentExtremes(target);
      if (process.env.IWLS_DEBUG_CURRENT === String(s.index_no)) {
        console.log("DEBUG Table 4 record:", JSON.stringify({ ...s, days: undefined }));
        console.log("DEBUG IWLS station:", JSON.stringify({ ...target, days: undefined }));
        for (let i = 0; i < 16; i++) {
          const e = derived[i]; const f = direct.reduce((b, x) => Math.abs(x.t - e.t) < Math.abs(b.t - e.t) ? x : b);
          console.log(`  ${new Date(e.t).toISOString().slice(5, 16)} derived ${e.v.toFixed(2)}${e.weak ? "w" : ""}  nearest iwls ${new Date(f.t).toISOString().slice(5, 16)} ${f.v.toFixed(2)}${f.weak ? "w" : ""}`);
        }
      }
      const split = (xs: Extreme[]) => ({ slack: xs.filter((e) => e.v === 0), max: xs.filter((e) => e.v !== 0) });
      const d = split(derived);
      const i = split(direct);
      const ps = pairUp(d.slack, i.slack, 90);
      const pm = pairUp(d.max, i.max, 90);
      const adt = (p: Pair[]) => p.map((x) => Math.abs(x.dtMin));
      const adv = pm.pairs.map((x) => Math.abs(x.dv));
      compared++;
      console.log([
        `${s.name} (${s.index_no}) ref ${s.reference_primary}${s.turn_reference_primary ? ` / turns ${s.turn_reference_primary}` : ""}:`,
        `  derived ${derived.length} events (${d.slack.length} slack, ${d.max.length} max); IWLS ${direct.length} (${i.slack.length} slack, ${i.max.length} max)`,
        `  slacks: ${ps.pairs.length} paired, ${ps.unpairedA}/${ps.unpairedB} unpaired; |dt| med/p90/max ${f1(quantile(adt(ps.pairs), 0.5))}/${f1(quantile(adt(ps.pairs), 0.9))}/${f1(Math.max(...adt(ps.pairs)))} min, bias ${f1(ps.pairs.reduce((a, x) => a + x.dtMin, 0) / ps.pairs.length)}`,
        `  maxes:  ${pm.pairs.length} paired, ${pm.unpairedA}/${pm.unpairedB} unpaired; |dt| med/p90/max ${f1(quantile(adt(pm.pairs), 0.5))}/${f1(quantile(adt(pm.pairs), 0.9))}/${f1(Math.max(...adt(pm.pairs)))} min, bias ${f1(pm.pairs.reduce((a, x) => a + x.dtMin, 0) / pm.pairs.length)}`,
        `          |dv| med/p90/max ${f2(quantile(adv, 0.5))}/${f2(quantile(adv, 0.9))}/${f2(Math.max(...adv))} kn, bias ${f2(pm.pairs.reduce((a, x) => a + x.dv, 0) / pm.pairs.length)} kn; ` +
        `book max flood/ebb ${s.max_flood_knots}/${s.max_ebb_knots}, IWLS year max ${target.max_flood_knots}/${target.max_ebb_knots}`,
      ].join("\n"));
    }
    if (targets.length === 0) console.log("no IWLS current stations beyond the book primaries in the fetch (pass --add-currents 08138)");
    expect(compared >= 0).toBe(true);
  });
});
