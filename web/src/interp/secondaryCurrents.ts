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
  // Tide-referenced slack-to-flood only: true when the source LW is the
  // day's LOWER low water. Drives lower_lw_turn_to_flood_diff (NITINAT
  // BAR). Absent for current-referenced events.
  lowerLW?: boolean;
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

/** Per-extreme flag: is this LW the day's LOWER low water? Buckets LWs
 *  by station-local calendar day (matching the printed day tables the
 *  extremes came from) and marks the lowest LW of each day; a
 *  single-LW day's only LW counts as lower (it is the dominant low).
 *  HW slots are always false. Needed only by stations with a
 *  lower_lw_turn_to_flood_diff (NITINAT BAR). */
export function classifyLowerLows(
  refExtremes: Extreme[],
  refIsHi: boolean[],
  utcOffset: number,
): boolean[] {
  const n = refExtremes.length;
  const out = new Array<boolean>(n).fill(false);
  const dayOf = (t: number) => Math.floor((t + utcOffset * 3600_000) / 86_400_000);
  let i = 0;
  while (i < n) {
    if (refIsHi[i]) {
      i++;
      continue;
    }
    // Collect this local day's LWs and mark its minimum.
    const day = dayOf(refExtremes[i].t);
    let lowest = i;
    const dayLows: number[] = [];
    for (let j = i; j < n; j++) {
      if (dayOf(refExtremes[j].t) !== day) break;
      if (!refIsHi[j]) {
        dayLows.push(j);
        if (refExtremes[j].v < refExtremes[lowest].v) lowest = j;
      }
    }
    out[lowest] = true;
    i = dayLows[dayLows.length - 1] + 1;
  }
  return out;
}

/** Adapter for tide-referenced secondaries (offsets_from_tides=true).
 *  Each tide HW becomes a turn-to-ebb slack at the secondary; each LW
 *  becomes a turn-to-flood slack. v carries the original tide height
 *  but is ignored downstream — slacks always emit v === 0.
 *  `lowerLW` (from classifyLowerLows) tags each LW-derived slack so
 *  stations with an asymmetric per-LW offset can pick the right diff. */
export function classifyTideAsCurrent(
  refExtremes: Extreme[],
  refIsHi: boolean[],
  lowerLW?: boolean[],
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
      ...(lowerLW && !refIsHi[i] && lowerLW[i] ? { lowerLW: true } : {}),
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
  /** For slacks: the reference event's time and value (tide height for a
   *  tide reference, 0 for a current reference), so the synthesis step
   *  can find the half-cycle's reference max or its tidal range. */
  refT?: number;
  refV?: number;
};

function byT(a: { t: number }, b: { t: number }): number {
  return a.t - b.t;
}

// ============================================================
// Magnitude scaling for absolute-knots rows
// ============================================================

/** How an absolute-knots row's printed large-tide speed is scaled to the
 *  tide at hand. Table 4 prints such a row's speed at large tides only
 *  and says a method for other tides "has not been established";
 *  rendering that number on every tide overstates ordinary ones badly
 *  (Dent Rapids showed 11 kn where CHS's own prediction has 3–7 kn).
 *
 *  - `current`: the reference current primary's Table 4 maxima. The row
 *    scales by the reference's actual-over-large ratio, i.e. it behaves
 *    like a percentage row with pct = sec_max / ref_max. Reproduces the
 *    IWLS prediction for Dent Rapids to within a few tenths of a knot
 *    (notes/iwls_api.md §5). A direction whose reference maxes are mostly
 *    weak/variable (Johnstone Strait Central's floods: 585 weak, 119 real
 *    ones peaking at a third of the printed large-tide value) is NOT
 *    scaled — the reference carries no usable magnitude there and scaling
 *    would invert the row (small on real days, full on weak ones). Such a
 *    direction keeps the flat printed value, as before 2026-11.
 *  - `tide`: the reference port's large-tide range (HHWLT − LLWLT). The
 *    row scales by the square root of the half-cycle's range over that
 *    (notes/iwls_api.md §9). */
export type CurrentRefScale = {
  kind: "current";
  maxFlood: number;
  maxEbb: number;
  /** All max-flood / max-ebb events of the reference, sorted by t, weak
   *  ones included; shared by every secondary on this reference. */
  floods: ClassifiedCurrentEvent[];
  ebbs: ClassifiedCurrentEvent[];
  /** False when that direction is weak-dominated (see WEAK_DOMINATED_SHARE). */
  scaleFlood: boolean;
  scaleEbb: boolean;
};
export type TideRefScale = { kind: "tide"; largeRange: number };
export type RefScale = CurrentRefScale | TideRefScale;

/** Share of a reference direction's maxes that may be weak before the
 *  proportional rule is switched off for that direction. Real references
 *  sit at 0–1 weak per year; Johnstone Strait Central's floods sit at
 *  83 %. */
export const WEAK_DOMINATED_SHARE = 0.2;

/** Build the scale for a current primary once; the loader shares it
 *  across every secondary referenced to that primary. */
export function buildCurrentRefScale(
  station: { max_flood_knots: number; max_ebb_knots: number },
  classified: ClassifiedCurrentEvent[],
): CurrentRefScale {
  const floods = classified.filter((e) => e.kind === "max-flood");
  const ebbs = classified.filter((e) => e.kind === "max-ebb");
  const weakShare = (xs: ClassifiedCurrentEvent[]) =>
    xs.length === 0 ? 1 : xs.filter((e) => e.weak).length / xs.length;
  return {
    kind: "current",
    maxFlood: Math.abs(station.max_flood_knots),
    maxEbb: Math.abs(station.max_ebb_knots),
    floods,
    ebbs,
    scaleFlood: weakShare(floods) <= WEAK_DOMINATED_SHARE,
    scaleEbb: weakShare(ebbs) <= WEAK_DOMINATED_SHARE,
  };
}

type Dir = "flood" | "ebb";

/** Unsigned magnitude (and weak flag) for a knots-rule max in direction
 *  `dir`, given the reference max `ev` it keys off (null when none could
 *  be matched). Flat printed value whenever the proportional rule does
 *  not apply; otherwise a weak reference max gives a weak (0) secondary
 *  max, exactly as the percentage rule does, and a reference max of 0 kn
 *  likewise. */
function knotsRuleMagnitude(
  mag: number,
  ev: { v: number; weak: boolean } | null,
  scale: CurrentRefScale | null,
  dir: Dir,
): { v: number; weak: boolean } {
  const enabled = scale !== null && (dir === "flood" ? scale.scaleFlood : scale.scaleEbb);
  if (!enabled || ev === null) return { v: mag, weak: false };
  if (ev.weak) return { v: 0, weak: true };
  const refMax = dir === "flood" ? scale!.maxFlood : scale!.maxEbb;
  if (!(refMax > 0)) return { v: mag, weak: false };
  const v = mag * (Math.abs(ev.v) / refMax);
  return v === 0 ? { v: 0, weak: true } : { v, weak: false };
}

/** Square-root rule for tide-referenced rows: `mag · √(range / largeRange)`.
 *  Null when it cannot apply (degenerate range) so the caller keeps the
 *  flat value. */
function rangeScaledKnots(mag: number, range: number, largeRange: number): number | null {
  if (!(largeRange > 0) || !(range > 0)) return null;
  return mag * Math.sqrt(range / largeRange);
}

/** First index in `sorted` with t >= x (binary search). */
function lowerBound(sorted: { t: number }[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].t < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The reference max a synthesised peak keys off. When the slacks and
 *  the maxes come from the same reference, take the largest-magnitude
 *  max of the right kind between the two reference slacks that produced
 *  the pair — immune to double-humped half-cycles and to the spacing of
 *  mixed tides. When the turns come from a different primary (Table 4
 *  footnote (a): Alert Bay / Pulteney Point turn on Seymour Narrows but
 *  rate on Johnstone Strait Central), the reference slacks are in another
 *  station's time frame, so fall back to the max nearest the midpoint
 *  mapped back to reference time, within a few hours. */
const SYNTH_MATCH_WINDOW_MS = 4 * 3600_000;

function pickRefMax(
  maxes: ClassifiedCurrentEvent[],
  a: EmittedEvent,
  b: EmittedEvent,
  midpointRefTime: number,
  sameReference: boolean,
): ClassifiedCurrentEvent | null {
  if (maxes.length === 0) return null;
  if (sameReference && a.refT !== undefined && b.refT !== undefined) {
    let best: ClassifiedCurrentEvent | null = null;
    for (let i = lowerBound(maxes, a.refT); i < maxes.length && maxes[i].t <= b.refT; i++) {
      if (best === null || Math.abs(maxes[i].v) > Math.abs(best.v)) best = maxes[i];
    }
    return best;
  }
  const i = lowerBound(maxes, midpointRefTime);
  const cands = [maxes[i - 1], maxes[i]].filter((e): e is ClassifiedCurrentEvent => e !== undefined);
  let best: ClassifiedCurrentEvent | null = null;
  for (const e of cands) {
    if (best === null || Math.abs(e.t - midpointRefTime) < Math.abs(best.t - midpointRefTime)) best = e;
  }
  return best !== null && Math.abs(best.t - midpointRefTime) <= SYNTH_MATCH_WINDOW_MS ? best : null;
}

// ============================================================
// Build the secondary's Extreme[]
// ============================================================

/** Build the Extreme[] for a secondary current station from a
 *  pre-classified reference (current primary or tide primary).
 *
 *  `turnRefClassified` supplies the slack (turn) events when the
 *  station's turn diffs key off a DIFFERENT primary than its max diffs
 *  (Table 4 vol 6 footnote (a): ALERT BAY / PULTENEY POINT turns come
 *  from SEYMOUR NARROWS while maxes stay on Johnstone Strait-Central).
 *  Defaults to refClassified — one reference for both, the normal case.
 *
 *  `refScale` drives the magnitude of absolute-knots rows (see RefScale).
 *  Null keeps the printed large-tide value flat, the pre-2026-11
 *  behaviour. Percentage rows ignore it. */
export function secondaryCurrentExtremes(
  sec: CurrentSecondaryStation,
  refClassified: ClassifiedCurrentEvent[],
  turnRefClassified: ClassifiedCurrentEvent[] = refClassified,
  refScale: RefScale | null = null,
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
  const curScale = refScale?.kind === "current" ? refScale : null;
  const tideScale = refScale?.kind === "tide" ? refScale : null;
  // Footnote extras (see CurrentSecondaryStation for provenance).
  const ttfLower =
    sec.lower_lw_turn_to_flood_diff != null
      ? parseSignedHHMM(sec.lower_lw_turn_to_flood_diff)
      : null;
  const cond = sec.turn_to_ebb_conditional ?? null;
  const condAdd = cond ? parseSignedHHMM(cond.add) : 0;

  const events: EmittedEvent[] = [];

  // Slacks from the turn reference (usually the same array as
  // refClassified — see the doc comment). Each carries the reference
  // event's time and value so the synthesis step can find the half-cycle.
  for (let i = 0; i < turnRefClassified.length; i++) {
    const ev = turnRefClassified[i];
    switch (ev.kind) {
      case "slack-to-flood": {
        // Slacks must be strictly v === 0 (currentValueAt branches on it).
        const diff = ttfLower !== null && ev.lowerLW ? ttfLower : ttf;
        events.push({ t: ev.t + diff, v: 0, weak: false, kind: "slack-to-flood", refT: ev.t, refV: ev.v });
        break;
      }
      case "slack-to-ebb": {
        // HARO STRAIT footnote (a): when the reference's preceding flood
        // ran below the threshold (weak counts as 0), the ebb turns
        // later — add the conditional correction.
        let diff = tte;
        if (cond) {
          let precedingFlood: ClassifiedCurrentEvent | null = null;
          for (let j = i - 1; j >= 0; j--) {
            if (turnRefClassified[j].kind === "max-flood") {
              precedingFlood = turnRefClassified[j];
              break;
            }
          }
          if (precedingFlood !== null && precedingFlood.v < cond.below_knots) {
            diff += condAdd;
          }
        }
        events.push({ t: ev.t + diff, v: 0, weak: false, kind: "slack-to-ebb", refT: ev.t, refV: ev.v });
        break;
      }
    }
  }

  // Maxes from the (rate) reference, when Table 4 gives a max time diff.
  // Percentage rule: multiple of the reference rate; a weak reference
  // rate is unusable → 0 with weak: true. Knots rule: knotsRuleMagnitude
  // (proportional where the reference direction is usable, flat
  // otherwise).
  for (const ev of refClassified) {
    switch (ev.kind) {
      case "max-flood": {
        if (fmd === null) break;            // synthesise at midpoint below
        if (pctF !== null) {
          events.push(ev.weak
            ? { t: ev.t + fmd, v: 0, weak: true, kind: "max-flood" }
            : { t: ev.t + fmd, v: (pctF / 100) * ev.v, weak: false, kind: "max-flood" });
        } else if (fMag !== null) {
          const m = knotsRuleMagnitude(fMag, ev, curScale, "flood");
          events.push({ t: ev.t + fmd, v: m.v, weak: m.weak, kind: "max-flood" });
        } else {
          events.push({ t: ev.t + fmd, v: 0, weak: true, kind: "max-flood" });
        }
        break;
      }
      case "max-ebb": {
        if (emd === null) break;
        if (pctE !== null) {
          events.push(ev.weak
            ? { t: ev.t + emd, v: 0, weak: true, kind: "max-ebb" }
            : { t: ev.t + emd, v: (pctE / 100) * ev.v, weak: false, kind: "max-ebb" });
        } else if (eMag !== null) {
          const m = knotsRuleMagnitude(eMag, ev, curScale, "ebb");
          events.push({ t: ev.t + emd, v: -m.v, weak: m.weak, kind: "max-ebb" });
        } else {
          events.push({ t: ev.t + emd, v: 0, weak: true, kind: "max-ebb" });
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
  // opposite-kind slack pairs and insert a peak at the midpoint. Its
  // magnitude: knots rule via the matched reference max (current
  // reference), √(range) rule via the two tide heights (tide reference),
  // else the flat printed value.
  if (fmd === null || emd === null) {
    const sameReference = turnRefClassified === refClassified;
    const turnShift = (ttf + tte) / 2;
    const synthPeak = (a: EmittedEvent, b: EmittedEvent, dir: Dir): EmittedEvent | null => {
      const mag = dir === "flood" ? fMag : eMag;
      if (mag === null || mag === 0) return null;
      const t = (a.t + b.t) / 2;
      let m: { v: number; weak: boolean } = { v: mag, weak: false };
      if (curScale) {
        const ref = pickRefMax(dir === "flood" ? curScale.floods : curScale.ebbs, a, b, t - turnShift, sameReference);
        m = knotsRuleMagnitude(mag, ref, curScale, dir);
      } else if (tideScale && a.refV !== undefined && b.refV !== undefined) {
        // The half-cycle between two tide-derived slacks is the rise
        // (LW→HW, flood) or fall (HW→LW, ebb) between the two tide
        // extremes that produced them.
        const v = rangeScaledKnots(mag, Math.abs(b.refV - a.refV), tideScale.largeRange);
        if (v !== null) m = { v, weak: false };
      }
      return { t, v: dir === "flood" ? m.v : -m.v, weak: m.weak, kind: dir === "flood" ? "max-flood" : "max-ebb" };
    };
    const synth: EmittedEvent[] = [];
    for (let i = 0; i < events.length - 1; i++) {
      const a = events[i];
      const b = events[i + 1];
      if (a.kind !== "slack-to-flood" && a.kind !== "slack-to-ebb") continue;
      if (b.kind !== "slack-to-flood" && b.kind !== "slack-to-ebb") continue;
      if (a.kind === b.kind) continue;       // same-direction slacks → no half-cycle to peak
      const peak = synthPeak(a, b, a.kind === "slack-to-flood" ? "flood" : "ebb");
      if (peak) synth.push(peak);
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
