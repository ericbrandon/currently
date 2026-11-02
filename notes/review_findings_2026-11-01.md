# Review findings: 2026-11-01 changes

Audience: the agent working on the app. This is the result of a code review
of the six commits `758a711`..`f685ff2` on `main` (the scope in
`notes/review_brief_2026-11-01.md`). Nothing below re-opens the product
decisions in §2 of that brief. Only the implementation is in question.

State at review time: `npx tsc -b` is clean and `npx vitest run` passes
104 tests, with 2 skipped. No code was changed during the review.

Line numbers are as of `f685ff2`. Use the function names to find the code
if the lines have moved.

## Priority summary

| # | Severity | Where | One line |
|---|---|---|---|
| 1 | **Blocker** | `secondaryCurrents.ts` weak branches + synthesis | A weak reference max gives the full printed knots, so the secondary peaks when the reference is weakest |
| 2 | Fix | `scaledKnots` | A reference max of exactly 0 falls back to the full printed speed instead of 0 |
| 3 | Fix | `loader.ts` current-secondary `bound` | Scaled values above the printed speed are clipped by the chart's Y bound |
| 4 | Test gap | `secondaryCurrents*.test.ts` | No tests for Nitinat Bar or Haro Strait with the new scaling |
| 5 | Test gap | data invariants | Nothing asserts that the book maxima were carried over to the IWLS current primaries |
| 6 | Latent | `loader.ts:207` | An unresolved reference drops a port before its direct predictions are looked up |
| 7 | Latent | `build_manifest.py:237` | A missing source file skips the stale-sibling cleanup |
| 8 | Latent | `loader.ts` `dedupeEqualT` | Equal-time dedupe misses near-duplicates at a direct/derived year seam |
| 9 | Robustness | synthesis `nearestRefMax` | Can borrow the wrong hump in a double-humped flow |
| 10 | Robustness | synthesis tide branch | A tide row with a different turn reference would silently stay flat |
| 11–14 | Maintainability | see below | Orphaned JSDoc, duplicated flood/ebb branches, repeated filtering, stale comments |

Do 1–5 before promoting to `release`. 6–14 can follow.

---

## 1. Weak reference maxes invert the magnitude of knots rows (blocker)

**Where:** `web/src/interp/secondaryCurrents.ts`, function
`secondaryCurrentExtremes`:
- the `else if (ev.weak)` branches in the `max-flood` / `max-ebb` cases
  (around line 451);
- the synthesis path, where `scaledKnots` returns null for `r.weak` and the
  caller does `v ?? fMag`.

**What happens:** on an absolute-knots row, a weak reference max emits the
flat printed large-tide speed. Non-weak maxes are now scaled by
`|refV| / refMax`, which is usually well below 1. The secondary therefore
shows its largest value exactly when the reference is barely flowing.

**Evidence, from the 2027 published data:**
- Alert Bay (flood 4.0 kn, max diff given) references Johnstone Strait
  Central. The book's JSC large-tide flood is 1.5 kn.
- JSC has 585 weak maxes in 2027. Its 119 non-weak floods peak at 0.509 kn,
  with a median of 0.371 kn.
- Non-weak floods give Alert Bay 4.0 × 0.37 / 1.5 ≈ 1.0 kn, and at most
  about 1.36 kn.
- Weak floods give Alert Bay 4.0 kn, and these are most of the year.
- Pulteney Point (3.0 kn) behaves the same way.

**History:** before `e440197` every knots row was flat, so a weak reference
giving the printed value was consistent. The existing comment in that branch
explains this: "Johnstone Strait Central's 591 faded floods would otherwise
erase Alert Bay's 4-knot flood". The proportional rule removes that
justification. Under it, a weak reference implies a small secondary.

**Suggested fix:** under a `current` `RefScale`, treat a weak reference max
on a knots row the same way the percentage rule does. Emit `v: 0, weak: true`
for direct maxes, and in synthesis do not fall back to the flat value when
the matched reference max is weak. Keep the flat fallback only when there is
no `refScale` at all.

**Check against the data before choosing.** If IWLS has direct current
predictions for Alert Bay or Pulteney Point, compare them with both options
(weak → 0, or weak → secMax × some nominal small ratio). Use
`web/scripts/iwls-secondaries.test.ts` with `IWLS_COMPARE=1`. If no direct
series exists, go with weak → `v: 0, weak: true`, which matches the
percentage rows.

**Tests to add** in `secondaryCurrentsScale.test.ts`:
- On a current-referenced knots row with a weak reference max:
  - when the row has a max diff, assert the output is not the printed speed;
  - when the row is synthesised, assert the same.
- Assert that the year-long maximum of a JSC-style series with mostly weak
  maxes does not exceed `secMax × max(|refV|)/refMax`.

## 2. A reference max of exactly 0 gives the full printed speed

**Where:** `scaledKnots`, around line 327:
`if (refWeak || !refMax || refMax <= 0 || refV === 0) return null;`

**Problem:** `refV === 0` means the reference ran at 0 kn. The correct
secondary value is `secMax × 0 = 0`. Instead the function returns null, and
the caller substitutes the printed maximum, for example 11 kn at Dent Rapids.
This can happen with an IWLS `EXTREMA_FLOOD`/`EXTREMA_EBB` value of 0, or one
that rounds to 0.000.

**Fix:** drop `refV === 0` from the null conditions so the function returns
0. Note that a max event must be non-zero, because `currentValueAt` branches
on `v === 0` for slacks. So either:
- emit it as `weak: true` with v 0, which is consistent with fix 1; or
- clamp to a tiny signed epsilon.

Check how `currentValueAt` treats a weak max with v 0 before choosing.

## 3. The chart clips scaled peaks above the printed speed

**Where:** `web/src/data/loader.ts`, around line 385. This is the `bound`
computation for current secondaries, which uses
`max(|max_flood_knots|, |max_ebb_knots|)` for knots rows. `CurrentChart`
clamps to `hi = bound`.

**Problem:** both new rules deliberately allow ratios above 1 (owner
decision, do not cap). Dent Rapids prints 11 kn, and a 13 kn Gillard flood
against its 12.5 kn large-tide value gives 11.44 kn, a value pinned in the
existing tests. The curve flat-tops at 11 while the label reads 11.4. The
same thing happens on tide-referenced rows whenever the half-cycle range
exceeds HHWLT − LLWLT.

**Fix:** size the bound from the station's computed extremes, taking the
larger of the printed speed and the observed max |v| for the station.
Alternatively, pad it by a headroom factor. Computing from the extremes is
more honest and cheap, because `ext` is already in hand at that point.
Add a test that no emitted |v| exceeds `current_max_knots` for any station.

## 4. Test gap: Nitinat Bar and Haro Strait with scaling

Neither footnote path is tested together with the new `refScale`:
- **Nitinat Bar** is tide-referenced and absolute-knots, so it now goes
  through `rangeScaledKnots`. Its slacks use `lower_lw_turn_to_flood_diff`
  for lower lows. Add a case with a mixed tide (alternating higher and lower
  lows). Assert that:
  - the per-LW slack offsets are applied;
  - each synthesised peak scales by `sqrt(range / largeRange)` of its own
    bracketing pair.
- **Haro Strait** (`turn_to_ebb_conditional`) takes a percentage or
  current-referenced path. Add a case that combines the conditional ebb
  delay with a `current` `refScale`. Assert that the delayed slack does not
  break the midpoint matching (the `nearestRefMax` 4 h window).

## 5. Test gap: maxima carried over to the IWLS current primaries

The current-branch `refScale` denominators come from
`max_flood_knots`/`max_ebb_knots` on the current primaries. Under IWLS these
values exist only because `fetch_iwls.py --metadata-from roster` copies the
book's Table 4 values. If that step were skipped, the denominators would
silently become something else, and every proportional row would scale
wrong.

I verified that all 22 CHS current primaries carry both maxima in the 2026
and 2027 published files today. Add an invariant to `dataInvariants.test.ts`:
every CHS current primary has non-zero `max_flood_knots` and `max_ebb_knots`.
If the `*_tct_*` book file is available in the test environment, also
compare them against it.

## 6. Latent: an unresolved reference drops a port that has direct predictions

**Where:** `loader.ts`, around line 207, in the Table 3 loop. The
`if (!ref) { console.warn(...); continue; }` runs before
`directById.get(sec.index_no)`.

**Today:** every reference resolves. Seven ports (7080, 7082, 7109, 7110,
7115, 7125, 7130) name `"VICTORIA"`, which `suffixAlias` maps to VICTORIA
HARBOUR. However, `fetch_iwls.py` skips a primary that IWLS lacks. If that
ever happens, every port referencing that primary vanishes, even though its
own predictions are published.

**Fix:** look up `direct` first. If it exists, publish the port even without
`ref`, and leave `tide_lhhw`/`tide_lllw` undefined. Alternatively, derive
them from the port's own extremes, as the NOAA branch does with its pad.
Warn only when there is neither a reference nor direct data.

## 7. Latent: a missing source file skips the stale-sibling cleanup

**Where:** `build_manifest.py`, around line 237, in `ingest`. When a kind's
source file is missing, the loop does `continue` before removing stale
siblings of that kind.

**Failure:** republishing with `--primaries tct`, or after
`{year}_iwls_tidal_secondary_predictions.json` is deleted or fails to
regenerate, leaves the old `tidal_secondary_direct.<hash>.json` in the year
directory. `scan_data_dir` then lists it in `manifest.json`, and the loader
overrides the Table 3 derivations with stale, possibly untrimmed data.

**Fix:** when a kind is legitimately absent, remove its existing published
files, or fail loudly. Which one depends on whether absence is ever
intended. For `tidal_secondary_direct` under `--primaries tct` it is
intended, so remove the files.

## 8. Latent: dedupe misses near-duplicates at a year seam

**Where:** `dedupeEqualT` in `loader.ts`, used by `flattenPerYear`, around
line 482.

**Today:** no port is direct in one year and derived in the other (I checked:
the 2026 and 2027 direct index sets are identical). If that changes, the
derived and direct events near Jan 1 can differ by a few minutes. Both
survive the dedupe, giving HW/HW at the seam and a near-zero-length segment.

**Fix options:**
- dedupe within a small tolerance (say 30 min) and also require the same
  hi/lo kind;
- or, simpler, make the per-year arrays non-overlapping before merging:
  trim year N+1's events that fall before year N's last event.

Add a test with a 5-minute offset at the seam.

## 9. Robustness: synthesis can borrow the wrong reference max

**Where:** the midpoint synthesis in `secondaryCurrentExtremes`, which calls
`nearestRefMax(refFloods, t - turnShift)` within `SYNTH_MATCH_WINDOW_MS`.

**Brief question:** is `t − turnShift` the right direction? **Yes.** A
secondary slack is the reference slack plus its offset, so subtracting the
mean offset maps the secondary midpoint back to reference time. The 4 h
window is well under the ~12 h spacing of same-kind maxes, so it will not
jump a full cycle.

**Remaining risk:** a reference flood with two maxes (double hump), or a
short mixed-tide half-cycle (Seymour Narrows, Active Pass). The midpoint can
sit nearer the smaller hump, which then scales the synthesised Okisollo or
Sansum peak too low.

**More robust:** choose the largest-magnitude reference max of the right kind
between the two reference slacks that produced `a` and `b`. Carry the source
reference index or time on `EmittedEvent` for this, much as `refV` was
added. This bracketing also removes the need for the 4 h window constant.

## 10. Robustness: tide row with a different turn reference

The brief asked to confirm that nothing mixes `turnRefClassified` and
`refClassified` on the tide branch. **Confirmed for today's data.** Only
Alert Bay and Pulteney Point have `turn_reference_primary`, and both are
current-referenced.

**Unguarded case:** if a tide-referenced row ever had a
`turn_reference_primary`, its slacks would come from a current primary with
`refV = 0`. `halfCycleRange` would then return 0, and `rangeScaledKnots`
would return null, so the row would silently stay flat. Add a `console.warn`
in the loader when `offsets_from_tides && turn_reference_primary`, or ignore
the turn reference for tide rows.

## 11–14. Maintainability

11. **Orphaned JSDoc.** The `RefScale` type, `scaledKnots`,
    `rangeScaledKnots`, `nearestRefMax` and `SYNTH_MATCH_WINDOW_MS` were
    inserted between `secondaryCurrentExtremes`'s doc comment (footnote (a),
    `turnRefClassified` semantics) and the function. Move that comment back
    onto the function and document the new `refScale` parameter.
12. **Duplicated synthesis branches.** The flood and ebb branches are copy-
    pastes that differ only in magnitude, max array, scale field and sign.
    Fixes 1 and 9 must touch both. Fold them into one helper, e.g.
    `synthPeak(mag, refMaxes, scaleMax, sign)`, as part of fix 1.
13. **Repeated filtering.** `refFloods`/`refEbbs` are re-filtered from
    `refClassified` on every call, about 2.8k events, twice per synthesised
    secondary that shares a reference. This is cheap but pointless. Build
    them once per `CurRefEntry` in the loader and pass them in.
14. **Stale comments in `apply_coord_overrides.py`.** Its comments and its
    "flagged for review" heuristics describe integer-arcminute PDF
    coordinates. The script now processes IWLS primaries with precise
    coordinates. This is already listed in the brief's §5. Update the
    comments, or skip the heuristics for IWLS-sourced files.

## Verified, no action needed

- **Fallback ports:** the seven ports IWLS lacks (7194, 7196, 7240, 7771,
  9090, 9470, 9960) all resolve their reference in both years and go through
  the derivation.
- **Direct port sets:** the 2026 and 2027 direct files hold the same 256
  index numbers.
- **Inclusive trim:** `trim_days` is inclusive on both ends. The 2026 port
  days run Oct 31 → Dec 31, and the 2027 days run Jan 1 → Oct 31.
- **Book maxima on IWLS primaries:** all 22 CHS current primaries carry
  non-zero `max_flood_knots`/`max_ebb_knots` in both years.
- **Build and tests:** `tsc -b` is clean, and vitest shows 104 passed and 2
  skipped.


---

## Resolution (2026-11-01, same day)

All fourteen findings were acted on; the code changes are in the commit that
follows `7c357b0`. Tests went from 104 to 114.

| # | Outcome |
|---|---|
| 1 | Fixed, but not with the suggested remedy. The six affected rows all reference Johnstone Strait Central, whose flood is structurally suppressed (585 of 704 weak, real ones ≤ 0.51 kn against a printed 1.5). Zeroing on weak would erase Alert Bay's real 4 kn flood most of the year, which the pre-existing comment already warned about. Instead the proportional rule is disabled per reference *direction* when more than 20 % of that direction's maxes are weak (`WEAK_DOMINATED_SHARE`, decided once per primary in `buildCurrentRefScale`). Those rows' floods are flat for weak and real maxes alike, so there is no inversion; their ebbs scale. On a direction that is scaled, a weak reference max now yields a weak (0) secondary max, as the percentage rule does. No IWLS series exists for Alert Bay or Pulteney Point to check against. Tests: weak on a scaled direction, weak-dominated direction, year-max bound. |
| 2 | Fixed. A reference max of 0 kn yields a weak (0) secondary max. Test added. IWLS emitted no such event in 2027. |
| 3 | Fixed. `currentChartBound` raises the bound to the largest emitted magnitude; the extremes are computed before the station metadata now. Test added. |
| 4 | Tests added: Nitinat Bar (per-LW offsets plus per-pair square-root scaling on a mixed tide) and a Haro-style conditional ebb delay with a current scale. |
| 5 | Invariant added to `dataInvariants.test.ts`: every CHS current primary carries non-zero maxima equal to the book's. |
| 6 | Fixed. Direct data is looked up before the reference; a port with direct data and no reference is published with bounds from its own extremes. |
| 7 | Fixed. An absent kind now removes its stale published files (verified on a scratch copy with `--primaries tct`). |
| 8 | Fixed. `trimOverlaps` drops later-year events at or before the previous year's last event before the merge. Test with a 5-minute seam offset. |
| 9 | Adopted. The synthesised peak takes the largest same-kind reference max between the two reference slacks that produced its pair (`pickRefMax`); the nearest-within-4-h search remains only for footnote (a) rows whose turns come from a different primary. Dent Rapids against IWLS is unchanged: median 0.15 kn. Test for the double hump. |
| 10 | Guarded. A tide-referenced row with a turn reference logs a warning and keeps its own reference for turns. |
| 11 | Done: the function's doc comment is back on the function and documents `refScale`. |
| 12 | Done: one `synthPeak` helper. |
| 13 | Done: `buildCurrentRefScale` runs once per primary in the loader and carries the sorted flood/ebb arrays. |
| 14 | Done: comments updated to describe IWLS-sourced primaries. The heuristics were left in place since they only fire on PDF-sourced rows. |

---

## Follow-up review of `dd276d7` (2026-11-01)

The fixes in `dd276d7` were re-reviewed. `npx tsc -b` is clean, and
`npx vitest run` shows 114 passed and 2 skipped. The rewritten
`secondaryCurrentExtremes`, the loader changes and the `build_manifest.py`
change were all read, not just this resolution table.

### Finding 1: the alternative fix is accepted

The disagreement is correct, and the remedy originally suggested in §1 was
wrong. Johnstone Strait Central's floods carry no usable magnitude signal:
83 % are weak, and the real ones peak at 0.49 kn against a printed 1.5. So
zeroing on weak would erase a real flood, and scaling would understate it.
Switching the rule off per weak-dominated reference direction
(`WEAK_DOMINATED_SHARE`) removes the inversion, which was the actual bug.

**Known trade-off, not a blocker.** On the six JSC rows (Camp Point, Current
Passage, Alert Bay, Pulteney Point, Masterman Islands, Browning Islands),
floods are now always the full printed value while ebbs scale. JSC's ebbs
are well behaved: median 1.00 kn against the printed 1.5, maximum 1.52.
So Alert Bay typically shows an ebb of about 2.7 kn and a flood that is
always 4.0, which makes the flood look systematically stronger.

**Possible later improvement:** scale a weak-dominated direction by the ratio
of the adjacent opposite-direction max in the same tidal cycle, since tidal
strength applies to the whole cycle. That would restore flood/ebb symmetry
without using the unusable flood magnitudes. Validate it against IWLS before
adopting it, if any IWLS current series sits on a JSC-referenced row.
Otherwise leave it for the owner to decide.

### New issues in the fixes

| # | Severity | Where | Issue |
|---|---|---|---|
| F1 | **Fix before deploy** | `build_manifest.py` `ingest`, absent-source branch | The stale-file cleanup deletes the published files of *any* missing optional kind |
| F2 | Fix (cheap) | `buildCurrentRefScale` / loader per-year loop | The weak-dominated decision is made per year, and one reference sits on the threshold |
| F3 | Fix (cheap) | loader, `currentChartBound` call | The chart bound only considers the last loaded year's extremes |
| F4 | Minor | `pickRefMax` → `knotsRuleMagnitude` | No matched reference max still falls back to the flat printed value |

#### F1. The stale-file cleanup is broader than intended

The fix for finding 7 removes `{kind.stem}.*.json` whenever a kind's source
is absent, for every kind except the two primaries. That was meant for
`tidal_secondary_direct` under `--primaries tct`. It also applies to:
- `tidal_secondary` and `current_secondary`, the book Table 3/4 files;
- `noaa_tidal_primary` and `noaa_current_primary`.

**Failure:** run `--source` against a directory without the NOAA outputs, or
without one of the `*_tct_*` secondary files. The build then quietly
unpublishes every NOAA station or every secondary for that year. It prints
only a `- removed` line, and the manifest is rebuilt without them. Before
`dd276d7` the old files would have survived.

**Fix:** only remove stale files for kinds that are legitimately optional,
which today means just `tidal_secondary_direct`. For every other kind,
missing input should be an error, as it already is for the primaries. One way
is an `optional: bool` on `Kind`. Add a test, or at least a scratch-copy
check, that a run missing a NOAA source fails and leaves `data/{year}/`
untouched.

#### F2. The weak-dominated decision can flip between years

`buildCurrentRefScale` runs once per primary *per year*, on that year's
events only. The 2026 file is now a two-month tail (Oct 31 – Dec 31), so its
share is computed from about 110 maxes per direction.

An approximate count shows how close one reference is. It assigns each weak
max to the opposite direction of the previous max, so it is close to the
classifier but not identical. Recompute with `classifyCurrentEvents` to
confirm.

| Reference, flood direction | 2026 tail | 2027 |
|---|---|---|
| Juan de Fuca-East | ~26 % weak → flat | ~19.9 % weak → scaled |
| Johnstone Strait Central | ~86 % | ~83 % |
| Race Passage | ~8 % | ~7 % |
| Blackney Passage | ~3 % | ~7 % |

Every ebb direction is at or near 0 %.

No absolute-knots row references Juan de Fuca-East today (the knots rows'
references are Active Pass, Seymour Narrows, Gillard Passage and JSC), so
nothing renders differently yet. The design is still fragile:
- a row that later referenced it would change rule at midnight on Jan 1;
- a re-fetch that moves its share by a fraction of a percent would flip it.

**Fix:** decide `scaleFlood`/`scaleEbb` once per primary across all loaded
years, by pooling the counts. Alternatively, pin the decision per primary
(only JSC floods are weak-dominated) and have a data invariant test fail if
the computed share for any primary moves across the threshold. Either way,
add a test that the decision is the same in every loaded year.

#### F3. The chart bound only considers the last year

`current_max_knots: currentChartBound(bound, ext)` is computed inside the
per-year loop, and `stationsById.set` is "latest year wins". The bound
therefore reflects only the last year's emitted extremes (2027). A larger
scaled peak in the 2026 tail would still flat-top on the chart, which is the
problem finding 3 was meant to fix.

**Fix:** keep a running maximum per station id across years, for example
`max(existing?.current_max_knots ?? 0, currentChartBound(bound, ext))`. Or
compute the bound once after `flattenPerYear` from the merged extremes. Apply
the same reasoning to the observed-bounds branch for direct ports without a
reference (finding 6), which has the same per-year shape.

#### F4. An unmatched reference max still falls back to flat

When `pickRefMax` returns null (no same-kind reference max between the two
reference slacks, or none within 4 h on the footnote (a) path),
`knotsRuleMagnitude` returns the full printed value. This is the same
over-statement pattern as finding 1. It should be rare: at the edges of the
data window, or after a classifier anomaly.

**Fix:** decide the intended behaviour explicitly. Weak/0 is more consistent
with the scaled rule, and flat is the historical default. Then add a
one-line test for it. Low priority.

### Verified in `dd276d7`, no action needed

- **Finding 2:** a 0 kn reference max gives a weak 0 secondary max.
- **Findings 6, 8, 10:** direct-before-reference lookup, `trimOverlaps`, and
  the tide-row turn-reference guard all behave as described.
  - `trimOverlaps` keeps the earlier year's event at a seam tie, where
    `dedupeEqualT` alone kept the later one. This is harmless.
  - The within-year duplicate (Port Renfrew) is still handled by
    `dedupeEqualT`.
- **Findings 9, 12, 13:** `pickRefMax` bracketing, the single `synthPeak`
  helper, and the shared per-primary flood/ebb arrays are correct.
- **Findings 4, 5, 11:** the requested tests and doc comment are present and
  meaningful.
- **Order before deploy:** F1, then F2 and F3, which are cheap and can go in
  the same commit. F4 and the symmetry improvement can wait.


---

## Resolution of the follow-up (2026-11-01)

| # | Outcome |
|---|---|
| F1 | Fixed. `Kind` gained `optional`; only `tidal_secondary_direct` is optional and has its stale files removed. Every other missing source now stops the run with a hint naming the pipeline to run. Scratch check: a 2027 run without the NOAA current source exits 1 and leaves `data/2027/` byte-for-byte unchanged. |
| F2 | Fixed two ways. The decision is now pooled across all loaded years per primary (`decideScaling` in the loader's pre-pass, handed to `buildCurrentRefScale`), and the threshold moved from 20 % to a majority (`WEAK_DOMINATED_SHARE = 0.5`): "dominated" should mean the direction carries no usable magnitude, which is JSC's floods at 83 % and nothing else; Juan de Fuca-East at ~20 % has real floods with a few genuinely faded ones. `dataInvariants.test.ts` now asserts every reference's pooled share is at least 15 points from the threshold, that each year's decision matches the pooled one, and that the weak-dominated set is exactly JSC. A unit test shows a 4-of-6-weak tail pooled with a clean year scaling consistently. |
| F3 | Fixed. The current-secondary bound carries the running maximum across years; the observed-bounds branch for direct ports without a reference widens by any earlier year's bound. |
| F4 | Decided: on a scaled direction, a half-cycle with no matching reference max yields a weak (0) secondary max, consistent with weak and zero reference maxes; flat only when the direction is not scaled. Test added with explicitly built classified events. |

Flood/ebb symmetry on the JSC rows (scaling a weak-dominated direction by the
cycle's opposite-direction max) is left for the owner; there is no IWLS
current series on a JSC-referenced row to validate it against.

Tests: 117 passed, 2 skipped (119 total). `tsc -b` clean.
