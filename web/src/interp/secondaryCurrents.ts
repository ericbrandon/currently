// Secondary-station current extreme builder.
//
// Reference: chs-shc-tct-tmc-vol5-2026 §"Procedure for Calculation of
// Currents at Secondary Current Stations" (p. 91) and Table 4. The full
// algorithm — including the `v === 0` slack/peak contract that
// `currentValueAt` depends on — is documented in
// notes/calculating_secondary_currents.md.
//
// Each secondary references either a primary current station (whose
// slack/max events get time-shifted and rate-adjusted per Table 4) or,
// when offsets_from_tides is true, a primary tide port (whose LW/HW
// times become turn-to-flood / turn-to-ebb slacks). The output is a
// sorted Extreme[] that slots into currentExtremesById alongside
// primaries; downstream interpolation, chart, panel, and arrow rendering
// are unchanged.

import type {
  CurrentPrimaryStation,
  CurrentSecondaryStation,
  Extreme,
} from "../types";
import { stationTimeToUtcMs } from "./extremes";

export type CurrentEventKind =
  | "slack-to-flood"
  | "slack-to-ebb"
  | "max-flood"
  | "max-ebb";

/** A reference event tagged with its role in the current cycle. Built
 *  once per primary (current or tide) and shared by every secondary
 *  pointing at it. */
export type ClassifiedCurrentEvent = {
  t: number;                // absolute UTC ms
  v: number;                // signed knots (currents) or 0 (tide-ref)
  weak: boolean;            // weak/variable max — always v === 0
  kind: CurrentEventKind;
};

// ============================================================
// Classification
// ============================================================

/** Classify each event of a primary current station's flat extreme list
 *  into one of {slack-to-flood, slack-to-ebb, max-flood, max-ebb}.
 *
 *  Maxes classify by sign. Weak/variable maxes (v === 0, weak: true)
 *  classify by neighbouring peak direction. True slacks (v === 0,
 *  !weak) classify as the slack BEFORE the next peak; if at the end of
 *  the array, by inverting the previous peak's direction. */
export function classifyCurrentEvents(
  s: CurrentPrimaryStation,
): ClassifiedCurrentEvent[] {
  // Re-flatten the source events so we keep the per-event `kind`
  // ("slack" vs "max") that distinguishes a slack from a weak max —
  // both have v === 0 in the Extreme[] form.
  type Raw = { t: number; v: number; weak: boolean; isMax: boolean };
  const raw: Raw[] = [];
  for (const d of s.days) {
    for (const e of d.events) {
      const isMax = e.kind === "max";
      const isWeak = isMax && e.weak_variable === true;
      raw.push({
        t: stationTimeToUtcMs(s.year, d.month, d.day, e.time, s.utc_offset),
        v: isWeak ? 0 : e.kind === "slack" ? 0 : e.knots,
        weak: isWeak,
        isMax,
      });
    }
  }
  raw.sort((a, b) => a.t - b.t);

  const n = raw.length;
  const out = new Array<ClassifiedCurrentEvent>(n);

  // Per index, the direction (+1 / -1) of the nearest non-zero v after
  // and before that index. Pre-computing in two linear sweeps keeps the
  // classification one-pass and predictable for weak/edge cases.
  const nextDir = new Array<number>(n);
  const prevDir = new Array<number>(n);
  let last = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (raw[i].v > 0) last = 1;
    else if (raw[i].v < 0) last = -1;
    nextDir[i] = last;
  }
  last = 0;
  for (let i = 0; i < n; i++) {
    if (raw[i].v > 0) last = 1;
    else if (raw[i].v < 0) last = -1;
    prevDir[i] = last;
  }

  for (let i = 0; i < n; i++) {
    const e = raw[i];
    let kind: CurrentEventKind;

    if (e.v > 0) {
      kind = "max-flood";
    } else if (e.v < 0) {
      kind = "max-ebb";
    } else if (e.isMax) {
      // Weak max — sit between same-direction slacks (slack-to-flood …
      // weak … slack-to-ebb means a faded flood peak). Match the
      // nearest non-zero peak's sign.
      const dir = nextDir[i] || prevDir[i];
      kind = dir >= 0 ? "max-flood" : "max-ebb";
    } else {
      // Slack — turn-to-flood if the next peak is positive, turn-to-ebb
      // if negative. At end-of-array, infer from the previous peak.
      const dir = nextDir[i] !== 0 ? nextDir[i] : -prevDir[i];
      kind = dir >= 0 ? "slack-to-flood" : "slack-to-ebb";
    }

    out[i] = { t: e.t, v: e.v, weak: e.weak, kind };
  }
  return out;
}

/** Adapter for tide-referenced secondaries (offsets_from_tides=true).
 *  Each tide HW becomes a turn-to-ebb slack at the secondary; each LW
 *  becomes a turn-to-flood slack. v carries the original tide height
 *  but is ignored downstream — slacks always emit v === 0. */
export function classifyTideAsCurrent(
  refExtremes: Extreme[],
  refIsHi: boolean[],
): ClassifiedCurrentEvent[] {
  const n = refExtremes.length;
  const out = new Array<ClassifiedCurrentEvent>(n);
  for (let i = 0; i < n; i++) {
    const e = refExtremes[i];
    out[i] = {
      t: e.t,
      v: e.v,
      weak: false,
      kind: refIsHi[i] ? "slack-to-ebb" : "slack-to-flood",
    };
  }
  return out;
}

// ============================================================
// Build the secondary's Extreme[]
// ============================================================

/** Parse "+HH:MM" / "-HH:MM" / "HH:MM" to milliseconds. */
function parseSignedHHMM(s: string): number {
  const sign = s.charCodeAt(0) === 0x2d /* - */ ? -1 : 1;
  const body =
    s.charCodeAt(0) === 0x2b || s.charCodeAt(0) === 0x2d ? s.slice(1) : s;
  const colon = body.indexOf(":");
  const hh = +body.slice(0, colon);
  const mm = +body.slice(colon + 1);
  return sign * (hh * 3600_000 + mm * 60_000);
}

export function hasMagnitudeData(sec: CurrentSecondaryStation): boolean {
  return (
    sec.pct_ref_flood !== null ||
    sec.pct_ref_ebb !== null ||
    sec.max_flood_knots !== null ||
    sec.max_ebb_knots !== null
  );
}

/** Internal: emit-stage event with its role tag, used to drive midpoint
 *  synthesis before the kind tag is dropped. */
type EmittedEvent = {
  t: number;
  v: number;
  weak: boolean;
  kind: CurrentEventKind;
};

function byT(a: { t: number }, b: { t: number }): number {
  return a.t - b.t;
}

/** Build the Extreme[] for a secondary current station from a
 *  pre-classified reference (current primary or tide primary). */
export function secondaryCurrentExtremes(
  sec: CurrentSecondaryStation,
  refClassified: ClassifiedCurrentEvent[],
): Extreme[] {
  if (!hasMagnitudeData(sec)) return [];

  const ttf = parseSignedHHMM(sec.turn_to_flood_diff);
  const tte = parseSignedHHMM(sec.turn_to_ebb_diff);
  const fmd = sec.flood_max_diff !== null ? parseSignedHHMM(sec.flood_max_diff) : null;
  const emd = sec.ebb_max_diff !== null ? parseSignedHHMM(sec.ebb_max_diff) : null;
  const pctF = sec.pct_ref_flood;
  const pctE = sec.pct_ref_ebb;
  const fMag = sec.max_flood_knots;
  const eMag = sec.max_ebb_knots;

  const events: EmittedEvent[] = [];

  for (const ev of refClassified) {
    switch (ev.kind) {
      case "slack-to-flood":
        // Slacks must be strictly v === 0 (currentValueAt branches on it).
        events.push({ t: ev.t + ttf, v: 0, weak: false, kind: "slack-to-flood" });
        break;
      case "slack-to-ebb":
        events.push({ t: ev.t + tte, v: 0, weak: false, kind: "slack-to-ebb" });
        break;
      case "max-flood": {
        if (fmd === null) break;            // synthesise at midpoint below
        if (ev.weak) {
          events.push({ t: ev.t + fmd, v: 0, weak: true, kind: "max-flood" });
        } else {
          const v =
            pctF !== null
              ? (pctF / 100) * ev.v          // ev.v > 0 → result > 0
              : fMag !== null
              ? fMag
              : 0;
          events.push({ t: ev.t + fmd, v, weak: false, kind: "max-flood" });
        }
        break;
      }
      case "max-ebb": {
        if (emd === null) break;
        if (ev.weak) {
          events.push({ t: ev.t + emd, v: 0, weak: true, kind: "max-ebb" });
        } else {
          const v =
            pctE !== null
              ? (pctE / 100) * ev.v          // ev.v < 0 → result < 0
              : eMag !== null
              ? -eMag                        // emit signed
              : 0;
          events.push({ t: ev.t + emd, v, weak: false, kind: "max-ebb" });
        }
        break;
      }
    }
  }

  events.sort(byT);

  // Midpoint synthesis. Needed when (a) the secondary references a tide
  // primary (no max events emitted at all) or (b) Table 4 omits the max
  // time diffs for a current-referenced row (e.g. SEYMOUR NARROWS,
  // GILLARD PASSAGE, ACTIVE PASS secondaries). Walk consecutive
  // opposite-kind slack pairs and insert a peak at the midpoint with
  // the published large-tide magnitude.
  if (fmd === null || emd === null) {
    const synth: EmittedEvent[] = [];
    for (let i = 0; i < events.length - 1; i++) {
      const a = events[i];
      const b = events[i + 1];
      if (a.kind !== "slack-to-flood" && a.kind !== "slack-to-ebb") continue;
      if (b.kind !== "slack-to-flood" && b.kind !== "slack-to-ebb") continue;
      if (a.kind === b.kind) continue;       // same-direction slacks → no half-cycle to peak
      const t = (a.t + b.t) / 2;
      if (a.kind === "slack-to-flood" && fMag !== null && fMag !== 0) {
        synth.push({ t, v: fMag, weak: false, kind: "max-flood" });
      } else if (a.kind === "slack-to-ebb" && eMag !== null && eMag !== 0) {
        synth.push({ t, v: -eMag, weak: false, kind: "max-ebb" });
      }
    }
    if (synth.length > 0) {
      events.push(...synth);
      events.sort(byT);
    }
  }

  // Strip the kind tag for the Extreme[] result.
  const out = new Array<Extreme>(events.length);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    out[i] = e.weak ? { t: e.t, v: e.v, weak: true } : { t: e.t, v: e.v };
  }
  return out;
}
