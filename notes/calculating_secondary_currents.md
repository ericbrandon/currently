# Calculating current speeds for secondary current stations

## What this document covers

This is the plan for the front-end module that, given a secondary current station and an instant in time, returns the **interpolated signed current speed (knots, + flood / − ebb)** at that instant. The output plugs into the existing `currentValueAt` (piecewise quarter-cycle) interpolator unchanged: we synthesise an `Extreme[]` for each secondary station at load time and store it in `currentExtremesById` alongside primary currents. Once stored, the chart, panel, and station-layer code paths light up for secondaries with zero changes.

Prerequisites:

- [calculating_primary_tides_and_currents.md](calculating_primary_tides_and_currents.md) — primary interpolators, `Extreme` shape, and the slack-vs-peak segment classification that `currentValueAt` depends on.
- [app_implementation.md](app_implementation.md) §7 — secondary tide construction (which we mirror).

The procedure is from `chs-shc-tct-tmc-vol5-2026-41311243.pdf` p. 91 ("Procedure for Calculation of Currents at Secondary Current Stations") and Table 4 on pp. 100–102.

## The contract with `currentValueAt` (load-bearing)

`currentValueAt` does **not** know whether an `Extreme` came from a primary's published JSON or was synthesised here from Table 4 differences. It branches purely on `v === 0`:

- `v === 0` → **zero-crossing endpoint** (slack, or weak/variable max).
- `v !== 0` → **peak endpoint** (signed flood/ebb max).

The secondary builder must preserve that classification through every shift and scale. Concretely:

| Source event (primary)                   | Stored as                | After Table 4 diffs                                         | What `v` must look like in the secondary |
|------------------------------------------|--------------------------|-------------------------------------------------------------|------------------------------------------|
| slack                                    | `v=0`                    | time shifted; value unchanged                               | **strict 0** (no float drift)            |
| max-flood / max-ebb                      | `v=±M`                   | time shifted; magnitude scaled (% rule) or replaced (knots rule) | non-zero, signed                    |
| weak/variable max (`*`)                  | `v=0, weak: true`        | time shifted; value untouched (already 0)                   | **strict 0** with `weak: true`           |

Two practical consequences:

1. **Don't multiply slacks.** `0 × factor` is 0 mathematically, but a future refactor that introduces an additive offset, or a degenerate magnitude column, could make a slack drift to e.g. `0.0001` and silently re-classify as a peak. Branch on the event role and assign `v: 0` literally for slacks. The same applies to weak maxes — preserve the flag and skip any magnitude transform on them.
2. **Synthesised midpoint maxes must always be non-zero.** §3 below synthesises a max event halfway between two slacks when Table 4 omits the max time diff. The magnitude comes from `max_flood_knots` / `max_ebb_knots` — emit the signed value directly so the surrounding slack→peak and peak→slack quarter-cycle segments fire correctly in the interpolator. If both flood and ebb absolute maxes happened to be 0 (not seen in vol 5, but theoretically), skip emitting the synthetic max altogether and let `currentValueAt`'s slack→slack fallback return 0 across the gap.

## The published procedure (paraphrased)

Per the PDF:

1. Each secondary current station names a **reference** — either a primary current station (e.g. RIVER JORDAN → JUAN DE FUCA-EAST) or, for the ones whose currents are driven by tide rather than current, a primary tide station (e.g. MALIBU RAPIDS → POINT ATKINSON).
2. **Times of turn-of-tide and max rate** are obtained by adding Table 4's per-event time differences to the corresponding events in the reference's daily predictions.
3. **Magnitude** is obtained one of two ways:
   - **Percentage**: multiply each ref-station max by Table 4's flood/ebb percentage. (E.g. RIVER JORDAN = 70 % of JUAN DE FUCA-EAST.)
   - **Absolute max at large tides**: if percentages are blank, Table 4 prints flood/ebb maximum knots directly. These are large-tide values; the PDF explicitly says "a consistent method of calculating speeds from the Reference Station has not been established" for non-large tides. We use the published number flat.

So at a high level, every secondary current decomposes into two independent choices:

- **Reference type**: current-primary (for slack and max events) or tide-primary (for HW/LW events that map to slacks).
- **Magnitude rule**: percentage of ref, or absolute large-tide max.

Additionally, the time-difference table is sometimes incomplete: many rows give only the two slack diffs and leave the two max diffs blank. In those cases we synthesise the max time at the midpoint between adjacent slacks.

## Data shape (already in JSON)

Each entry of `2026_tct_current_secondary_stations.json` has, beyond the usual metadata:

```ts
type SecondaryCurrentStation = {
  index_no: number;
  name: string;
  reference_primary: string;       // name of the reference (current OR tide primary)
  offsets_from_tides: boolean;     // true → reference_primary is a TIDE primary; HW/LW drive slacks
  // Time differences (all "+HH:MM" / "-HH:MM" or null):
  turn_to_flood_diff: string | null;   // applied to ref's slack-before-flood (or LW for tide-ref)
  flood_max_diff:      string | null;  // applied to ref's max-flood event; null → synthesise at midpoint
  turn_to_ebb_diff:    string | null;  // applied to ref's slack-before-ebb (or HW for tide-ref)
  ebb_max_diff:        string | null;  // applied to ref's max-ebb event; null → synthesise at midpoint
  // Magnitude (mutually exclusive in practice):
  pct_ref_flood: number | null;        // e.g. 70 → multiply ref's max-flood knots by 0.70
  pct_ref_ebb:   number | null;
  max_flood_knots: number | null;      // e.g. 9.0 → emit max-flood with v = +9.0
  max_ebb_knots:   number | null;      //                emit max-ebb  with v = -value
  has_footnote: boolean;
};
```

The 39 vol-5 rows partition empirically as:

| reference type | magnitude rule | count | example |
|---|---|---:|---|
| current primary | percentage | 14 | RIVER JORDAN (70 %, JUAN DE FUCA-EAST) |
| current primary | absolute knots | 14 | OKISOLLO CHANNEL (11 kn, SEYMOUR NARROWS) |
| tide primary | absolute knots | 9 | MALIBU RAPIDS (9 kn, POINT ATKINSON) |
| current primary | neither (insufficient data) | 1 | BARONET PASSAGE |
| tide primary | neither (insufficient data) | 1 | DRANEY NARROWS |

The two "neither" rows have time differences only and no magnitude info at all in Table 4. We render them as slack-time markers without a flow magnitude; the chart curve is omitted (or null) and the icon shows direction only when the user can reasonably infer it from neighbouring slacks. Practically: skip these from `currentExtremesById` and let the existing "no data" code path render the marker as a static dot.

## The algorithm

Build the secondary's `Extreme[]` once per secondary at load time, in `src/interp/secondaryCurrents.ts`. Steps:

### 1. Resolve and classify the reference's events

If `offsets_from_tides`:
- Look up the reference **tide** primary's `Extreme[]` from `tideExtremesById`.
- Run `classifyHiLow()` (already in `src/interp/secondaryTides.ts`) to label each as `HW` or `LW`.
- HW = the slack-before-ebb (i.e. turn-to-ebb); LW = the slack-before-flood. (At max-tide, the current is slack and reverses direction; this is the convention CHS uses for the LW/HW columns in MALIBU RAPIDS' row.)

Else (current ref):
- Look up the reference **current** primary from `currentExtremesById`.
- Classify each event into one of `{slack-to-flood, slack-to-ebb, max-flood, max-ebb}`. The original `CurrentEvent.kind` and `knots` sign almost get us there, but we lose `kind` when we collapse to `Extreme`. So either:
  - **Preferred**: keep a parallel classified array per primary (cached, like `classifyHiLow` for tides), built at load from the original `CurrentStation` JSON. Each entry: `{ t, v, weak, kind }` where kind is one of the four labels.
  - For `kind === "slack"` events: look at the **next non-slack event** to decide turn-to-flood (next is max-flood, v > 0) vs turn-to-ebb (next is max-ebb, v < 0). Falls back to the previous event if at end-of-array.
  - For `kind === "max"`: positive knots → `max-flood`, negative → `max-ebb`. Weak/variable maxes (`v === 0, weak: true`) get classified by neighbouring slacks' implied direction (or by the surrounding max events).

Cache classified arrays per **primary** so multiple secondaries pointing at the same reference share the work — same pattern as `classifyHiLow`.

### 2. Walk classified events; emit shifted+scaled extremes

For each classified ref event, look up the matching secondary diff and magnitude rule:

| ref event kind            | time-diff to apply        | secondary kind        | secondary value (pct rule)      | secondary value (knots rule) |
|---------------------------|---------------------------|-----------------------|---------------------------------|------------------------------|
| `slack-to-flood` / `LW`   | `turn_to_flood_diff`      | `slack-to-flood`      | 0                               | 0                            |
| `max-flood`               | `flood_max_diff` (or skip) | `max-flood`           | `pct_ref_flood / 100 · ref.v`   | `+max_flood_knots`           |
| `slack-to-ebb` / `HW`     | `turn_to_ebb_diff`        | `slack-to-ebb`        | 0                               | 0                            |
| `max-ebb`                 | `ebb_max_diff` (or skip)   | `max-ebb`             | `pct_ref_ebb / 100 · ref.v`     | `−max_ebb_knots`             |
| weak max (`weak: true`)   | by inferred direction     | weak max              | 0 (with `weak: true`)           | 0 (with `weak: true`)        |

If the time-diff for a max event is null AND the magnitude rule is "knots" (which is the only case it happens — see Table above), we **defer** the max emission and synthesise it after step 2 (next).

Emit each event as `{ t: ref.t + diff_ms, v: <per table>, weak?: ... }`.

### 3. Synthesise missing maxes at midpoints

After step 2, walk the secondary's slack list pairwise. For each pair `(slack_to_flood_t, slack_to_ebb_t)` that does **not** already have a max event between them, emit a max-flood at `(t1 + t2)/2` with the magnitude rule's flood value. Likewise for `(slack_to_ebb_t, slack_to_flood_t)` → max-ebb at midpoint.

This matters in practice for:
- Tide-referenced stations (no max diffs at all — only slack diffs exist).
- ACTIVE PASS / SEYMOUR NARROWS / GILLARD PASSAGE secondaries (CHS publishes only slack diffs even though the ref is a current station).

For the `pct` rule, max diffs are always present in the source data, so this synthesis step is a no-op for those.

### 4. Sort defensively and store

Sort the resulting `Extreme[]` by `t` (time-shifts of independent magnitudes can rarely flip the order of consecutive events). Insert into `currentExtremesById` keyed by the secondary's `index_no`. The chart (`CurrentChart`), panel (`CurrentPanel`), station layer (`CurrentStationLayer`), and `currentValueAt` itself are unchanged — they already query `currentExtremesById.get(id)` and the new array slots in identically to a primary's.

## Pseudocode

```ts
// src/interp/secondaryCurrents.ts

type CurrentEventKind =
  | "slack-to-flood" | "max-flood"
  | "slack-to-ebb"   | "max-ebb"
  | "max-weak-flood" | "max-weak-ebb";

export type ClassifiedCurrent = { t: number; v: number; weak: boolean; kind: CurrentEventKind };

/** Cached per primary current station. */
export function classifyCurrentEvents(s: CurrentStation): ClassifiedCurrent[] {
  const flat = currentExtremes(s).map((e, i, all) => /* re-attach kind from s.days[].events[].kind */);
  // Two-pass: first label maxes by sign, then label slacks by next/prev max direction.
  // Weaks get inferred direction from the same neighbour-walk.
  return /* ... */;
}

/** Cached per tide reference port — reuse `classifyHiLow` from secondaryTides.ts. */

export function secondaryCurrentExtremes(
  sec: SecondaryCurrentStation,
  refClassified: ClassifiedCurrent[] | TideHiLow[],   // discriminated by sec.offsets_from_tides
): Extreme[] {
  if (!hasMagnitudeData(sec)) return [];               // BARONET, DRANEY → skip

  const out: Extreme[] = [];
  const pendingMaxFromMidpoint = !sec.flood_max_diff || !sec.ebb_max_diff;

  for (const ref of refClassified) {
    const { kind, diff } = matchRefToSecondary(sec, ref);   // returns null kind if event has no role
    if (!kind) continue;
    if (kind.endsWith("max") && !diff) continue;            // synthesise later

    const t = ref.t + parseDiffMs(diff!);

    // CONTRACT: slacks and weak maxes must remain strictly v === 0
    // so currentValueAt classifies them as zero-crossings, not peaks.
    let v: number;
    if (kind.startsWith("slack-") || ref.weak) {
      v = 0;                                                // never multiply a 0
    } else {
      v = magnitudeFor(sec, kind, ref.v);                   // pct · ref.v  OR  ±maxKnots
    }
    out.push({ t, v, weak: ref.weak || undefined });
  }

  if (pendingMaxFromMidpoint) synthesiseMidpointMaxes(out, sec);

  out.sort((a, b) => a.t - b.t);
  return out;
}
```

Helpers (`parseDiffMs`, `matchRefToSecondary`, `magnitudeFor`, `synthesiseMidpointMaxes`) are small and pure.

## Edge cases & known issues

### Reference-name aliasing

The primary current JSON uses `"JOHNSTONE STR. CEN."` while the secondary `reference_primary` field is `"JOHNSTONE STRAIT-CENTRAL"`. Other references match exactly. Build a small alias map at load time, mirroring the `VICTORIA HARBOUR ↔ VICTORIA` alias in `secondaryTides.ts`. Keep it data-driven (a const `CURRENT_REF_ALIASES`) rather than hardcoded in lookup logic.

### Tide-referenced stations (`offsets_from_tides: true`)

- Reference must resolve against `tideExtremesById`, not `currentExtremesById`.
- `classifyHiLow` already exists; we just need to map HW → turn-to-ebb and LW → turn-to-flood.
- Max time diffs are always null for these — every max comes from §3 synthesis.
- The PDF doesn't provide a magnitude scaling formula for tide-referenced stations, only the absolute large-tide knots. This is the documented limitation.

### Stations with no magnitude data

`BARONET PASSAGE` (current ref) and `DRANEY NARROWS` (tide ref) have time differences but no percentage and no max. Skip them from `currentExtremesById`. The map marker still appears (it's in `stationsById` from the JSON), but rendering will fall through to "no value at this t" — same code path as scrubbing past end of year for any station. Possibly add a `magnitude_known: false` flag to the station meta so the UI can render the dot in a muted style and suppress the arrow direction; defer this until UI work is needed.

### Footnote (a) on HARO STRAIT

PDF: `"(a) If the preceding flood current at Race Passage was less than 2.0 knots, add 1 hour 10 minutes."` This is a state-dependent time correction — different from the static diffs we apply. The current parser drops the `(a)` marker silently (HARO STRAIT's `turn_to_ebb_diff` parses to `+02:30`, ignoring the conditional adjustment).

For v1 we apply the static diff only. To do this correctly we would: (i) extend the parser to capture footnote markers per cell, (ii) for each ref max-flood event, evaluate "preceding flood at ref < 2 kn" and conditionally extend the relevant diff. Defer until the parser is extended.

### `has_footnote: true` rows

3 BC stations (HARO STRAIT, ALERT BAY, PULTENEY POINT) carry station-level footnotes in the JSON. The footnote text is not preserved (same situation as Table 3). The standard formula is applied to all of them. Per the PDF's own caveat that secondary predictions are inherently approximate, this is acceptable for visualisation. Worth surfacing visually (e.g. a "*" annotation on the marker tooltip) so users know the prediction is rougher.

### Weak/variable ref maxes

If a ref event has `weak: true` (a `*` in the source PDF), the secondary's matching event inherits the flag and a value of 0. The classification still places it in flood-half or ebb-half based on the ref's neighbour analysis, so downstream rendering can still distinguish a weak flood from a weak ebb if it cares.

### Out-of-window time shifts

A negative slack diff at the start of the year (or positive at the end) can shift an event before the secondary's first ref event or after the last. We let those through; `currentValueAt` already returns null outside the secondary's own `[first, last]` range. No extrapolation.

### Defensive sort

In rare cases, e.g. SWANSON CHANNEL with `ebb_max_diff = +01:35` and `turn_to_ebb_diff = +01:25`, the time shifts can push events past their neighbours when the underlying ref segment is short. Final sort handles this.

## Caching & performance

- Classified ref events: one array per primary (current + tide), built once at load. Tide HiLow already cached for secondary tides — reuse.
- Per-secondary `Extreme[]`: built once at load, after the ref it depends on. Stored in `currentExtremesById`. Identical lifecycle to secondary tides.
- Multi-year handling: per-year resolution (a 2027 secondary uses 2027's primary slice), then concatenate per-secondary extreme arrays across years and sort. Identical to secondary tides §7.1.

Cost: ~39 secondaries × ~1500 events/year per ref = ~60 k operations at load. Single-digit ms.

## Sanity checks for testing

When implementing, verify against the published values rather than trusting the formula:

1. **Time-shift exact-match.** Pick a day at JUAN DE FUCA-EAST with a slack at, say, 07:00. RIVER JORDAN's `turn_to_flood_diff` is −00:50, so RIVER JORDAN's slack-to-flood that day should land at 06:10.
2. **Percentage scaling.** At the same JUAN DE FUCA-EAST flood-max of 3.5 kn, RIVER JORDAN should peak at 3.5 × 0.70 = 2.45 kn at the shifted time.
3. **Absolute knots flat-rate.** Pick a low-tide and a large-tide day at SEYMOUR NARROWS. OKISOLLO CHANNEL should peak at +11.0 kn on both days (the doc's deliberate limitation; this is correct behaviour, not a bug).
4. **Tide reference.** MALIBU RAPIDS' slack-before-flood times should equal POINT ATKINSON's LW times + 00:35. Slack-before-ebb = HW times + 00:25. Maxes synthesised at midpoint, magnitude ±9.0 kn.
5. **Midpoint synthesis.** SANSUM NARROWS uses ACTIVE PASS as ref with no max time diffs. The flood-max should fall exactly halfway (in time) between consecutive slacks of opposite type.
6. **Alias resolution.** `JOHNSTONE STRAIT-CENTRAL` references must resolve to the primary `"JOHNSTONE STR. CEN."`.
7. **No-magnitude graceful handling.** `BARONET PASSAGE` and `DRANEY NARROWS` must not throw, must not appear in `currentExtremesById`, and must still appear in `stationsById` so the marker is plotted.
8. **Endpoint exactness.** `currentValueAt(secondaryExtremes, e.t)` must return `e.v` (within float epsilon) for every emitted extreme `e`. The quarter-sine and quarter-cosine segments both reduce to the endpoint value at τ=0 and τ=1, same as the half-cosine for tides.
9. **Slack identity.** Every emitted slack and every emitted weak/variable max must have `v === 0` strictly (no float drift from `0 * pct`). Otherwise `currentValueAt` will misclassify the segment endpoint and draw a peak→peak half-cosine instead of the correct slack→peak quarter-sine. A simple unit-test guard: `out.filter(e => e.v === 0 || e.weak).every(e => e.v === 0)`.
10. **50-90 rule check on a secondary.** Pick a slack→max segment in a built secondary array (e.g. RIVER JORDAN). At τ=1/3 of the segment, `currentValueAt` should return ~50% of the peak magnitude; at τ=2/3, ~87%. Same property as primaries — confirms the secondary's `Extreme[]` is being interpreted by `currentValueAt` correctly, not falling back to half-cosine.

## Implementation order

1. **Extend `classifyHiLow` reuse + add `classifyCurrentEvents`** in a new file `src/interp/secondaryCurrents.ts`. Unit-test classification on 2026 primaries.
2. **Implement `secondaryCurrentExtremes`** with the 4-route table + midpoint synthesis. Unit-test against the sanity checks above.
3. **Wire into `loader.ts`**: after primary currents are built, build secondaries; merge across years; insert into `currentExtremesById`; populate `stationsById` for the marker layer.
4. **Add the alias map** for `JOHNSTONE STR. CEN. ↔ JOHNSTONE STRAIT-CENTRAL`. Surface a console warning if a secondary's reference doesn't resolve in either current or tide primaries (data drift detection for future years).
5. **Skip the no-magnitude pair** with explicit `magnitude_known: false` on the station meta. Render the marker without a value/arrow until UI work catches up.
6. **Document the footnote (a) deferral** in code comments at the HARO STRAIT special case.

Each step is independently testable. The map's existing current-marker code path picks up secondaries automatically once they're keyed in `currentExtremesById`.

## Deliberately deferred

- **Footnote (a) state-dependent time correction** (HARO STRAIT). Requires parser changes.
- **Magnitude annotations on the marker** (a "*" or styling for `has_footnote` / weak / no-magnitude). UI polish, not algorithm.
- **Non-large-tide scaling for absolute-knots stations**. The PDF explicitly disclaims this; revisit only if we ever ship navigation-grade output.
