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
 *  Signed maxes classify by sign. Weak/variable maxes (v === 0,
 *  weak: true) are faded peaks sitting BETWEEN two opposite peaks, so
 *  they classify by alternation parity from the nearest signed max on
 *  each side (an odd number of steps flips direction). The two sides
 *  agree for 874 of the 876 weak maxes in the 2026 data; on the rare
 *  disagreement (a genuinely vanished peak nearby — consecutive
 *  same-sign maxes do occur, e.g. Juan de Fuca East double ebbs) the
 *  nearer anchor wins. Matching the nearest signed value directly is
 *  wrong by construction: that neighbour is almost always the opposite
 *  direction (it zeroed out Johnstone Strait Central's 591 faded
 *  floods as ebbs).
 *
 *  True slacks (v === 0, !weak) classify as the slack BEFORE the next
 *  max, using that max's RESOLVED direction (so a slack ahead of a
 *  weak flood is slack-to-flood); at the end of the array, by
 *  inverting the previous max's resolved direction. */
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

  // Pass 1 — resolve a direction (+1 / -1) for every max event, walking
  // the max-only subsequence. Signed maxes resolve by sign; weak maxes
  // by alternation parity from the nearest signed max on each side.
  const maxPos: number[] = [];
  for (let i = 0; i < n; i++) if (raw[i].isMax) maxPos.push(i);
  const m = maxPos.length;
  const maxDir = new Array<number>(m).fill(0);

  // Nearest signed max at-or-before / at-or-after each max index, as
  // (dir, distance-in-maxes) pairs from two linear sweeps.
  const beforeDir = new Array<number>(m).fill(0);
  const beforeDist = new Array<number>(m).fill(0);
  const afterDir = new Array<number>(m).fill(0);
  const afterDist = new Array<number>(m).fill(0);
  let dir = 0;
  let dist = 0;
  for (let k = 0; k < m; k++) {
    const v = raw[maxPos[k]].v;
    if (v !== 0) {
      dir = v > 0 ? 1 : -1;
      dist = 0;
    } else if (dir !== 0) {
      dist++;
    }
    beforeDir[k] = dir;
    beforeDist[k] = dist;
  }
  dir = 0;
  dist = 0;
  for (let k = m - 1; k >= 0; k--) {
    const v = raw[maxPos[k]].v;
    if (v !== 0) {
      dir = v > 0 ? 1 : -1;
      dist = 0;
    } else if (dir !== 0) {
      dist++;
    }
    afterDir[k] = dir;
    afterDist[k] = dist;
  }

  for (let k = 0; k < m; k++) {
    const v = raw[maxPos[k]].v;
    if (v !== 0) {
      maxDir[k] = v > 0 ? 1 : -1;
      continue;
    }
    // Alternation parity: an odd number of steps from a signed anchor
    // flips its direction.
    const cb = beforeDir[k] === 0 ? 0 : beforeDist[k] % 2 === 1 ? -beforeDir[k] : beforeDir[k];
    const ca = afterDir[k] === 0 ? 0 : afterDist[k] % 2 === 1 ? -afterDir[k] : afterDir[k];
    if (cb !== 0 && ca !== 0) {
      // Disagreement means a peak genuinely vanished somewhere between
      // the anchors; trust the nearer one (tie → before).
      maxDir[k] = cb === ca ? cb : beforeDist[k] <= afterDist[k] ? cb : ca;
    } else {
      // At most one anchor (array edge). Default flood when neither
      // side has any signed max at all (no real station is all-weak).
      maxDir[k] = cb !== 0 ? cb : ca !== 0 ? ca : 1;
    }
  }

  // Pass 2 — per raw index, the resolved direction of the next / previous
  // max event, for slack classification.
  const nextMaxDir = new Array<number>(n).fill(0);
  const prevMaxDir = new Array<number>(n).fill(0);
  for (let k = m - 1, i = n - 1; i >= 0; i--) {
    while (k >= 0 && maxPos[k] > i) k--;
    prevMaxDir[i] = k >= 0 ? maxDir[k] : 0;
  }
  for (let k = 0, i = 0; i < n; i++) {
    while (k < m && maxPos[k] < i) k++;
    nextMaxDir[i] = k < m ? maxDir[k] : 0;
  }

  let mi = 0;
  for (let i = 0; i < n; i++) {
    const e = raw[i];
    let kind: CurrentEventKind;

    if (e.isMax) {
      kind = maxDir[mi++] >= 0 ? "max-flood" : "max-ebb";
    } else {
      // Slack — turn toward the next max's resolved direction. At
      // end-of-array, infer by inverting the previous max's direction.
      const d = nextMaxDir[i] !== 0 ? nextMaxDir[i] : -prevMaxDir[i];
      kind = d >= 0 ? "slack-to-flood" : "slack-to-ebb";
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
 *  pre-classified reference (current primary or tide primary).
 *
 *  `turnRefClassified` supplies the slack (turn) events when the
 *  station's turn diffs key off a DIFFERENT primary than its max diffs
 *  (Table 4 vol 6 footnote (a): ALERT BAY / PULTENEY POINT turns come
 *  from SEYMOUR NARROWS while maxes stay on Johnstone Strait-Central).
 *  Defaults to refClassified — one reference for both, the normal case. */
export function secondaryCurrentExtremes(
  sec: CurrentSecondaryStation,
  refClassified: ClassifiedCurrentEvent[],
  turnRefClassified: ClassifiedCurrentEvent[] = refClassified,
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

  // Slacks from the turn reference (usually the same array as
  // refClassified — see the doc comment).
  for (const ev of turnRefClassified) {
    switch (ev.kind) {
      case "slack-to-flood":
        // Slacks must be strictly v === 0 (currentValueAt branches on it).
        events.push({ t: ev.t + ttf, v: 0, weak: false, kind: "slack-to-flood" });
        break;
      case "slack-to-ebb":
        events.push({ t: ev.t + tte, v: 0, weak: false, kind: "slack-to-ebb" });
        break;
    }
  }

  // Maxes from the (rate) reference.
  for (const ev of refClassified) {
    switch (ev.kind) {
      case "max-flood": {
        if (fmd === null) break;            // synthesise at midpoint below
        // Weak/variable is a property of the REFERENCE, not the
        // secondary. Percentage rule: the secondary's rate is a multiple
        // of the ref rate, and a `*` ref rate is unusable → 0 with
        // weak: true. Knots rule: the book gives the secondary's
        // large-tide rate directly and the ref contributes timing only
        // ("a consistent method of calculating speeds from the Reference
        // Station has not been established"), so the ref's `*` must not
        // zero it — Johnstone Strait Central's 591 faded floods would
        // otherwise erase Alert Bay's 4-knot flood for most of the year.
        if (ev.weak && pctF !== null) {
          events.push({ t: ev.t + fmd, v: 0, weak: true, kind: "max-flood" });
        } else if (ev.weak) {
          events.push({ t: ev.t + fmd, v: fMag ?? 0, weak: fMag === null, kind: "max-flood" });
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
        if (ev.weak && pctE !== null) {
          events.push({ t: ev.t + emd, v: 0, weak: true, kind: "max-ebb" });
        } else if (ev.weak) {
          events.push({ t: ev.t + emd, v: eMag !== null ? -eMag : 0, weak: eMag === null, kind: "max-ebb" });
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
