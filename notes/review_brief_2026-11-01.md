# Review brief: 2026-11-01 changes (2027 data, IWLS switch, secondary rules)

Audience: a reviewer who has not seen the working session. Everything
below is on `main` (commits `758a711` through `f685ff2`, six commits on top
of `47d5226`). Nothing has been promoted to `release` yet. The repo owner
made the product decisions listed in §2; please review the implementation
of those decisions rather than re-opening them, and flag anything that
looks wrong, fragile, or under-tested.

The longer narrative is in `2027_transition_plan.md` (run log in §7–§9)
and `iwls_api.md` (API survey, comparison results, research). This brief
is the map.

## 1. What the app does and what changed today

CurrentlyBC (`web/`, Preact + MapLibre, static on Cloudflare Pages) shows
BC and Puget Sound tide heights and current speeds along a scrubbable
timeline. Data is published as content-hashed JSON per year under
`web/public/data/{year}/`, listed in `manifest.json`. The loader
(`web/src/data/loader.ts`) fetches every year in the manifest, builds a
sorted `Extreme[]` per station (absolute UTC ms, value), merges years, and
the interpolators in `web/src/interp/` turn those into values at any
instant. Secondary stations have no published predictions of their own in
the printed tables: tide "secondary ports" are derived from a reference
port with Table 3 time/height differences (`secondaryTides.ts`), and
secondary current stations from a reference current or tide primary with
Table 4 offsets and either a percentage or an absolute large-tide speed
(`secondaryCurrents.ts`).

Until today the Canadian data came from CHS's printed Tide and Current
Tables (PDF, parsed by `canada_data/read_tct.py`) and the app published
all of 2026. Today:

| Commit | Change |
|---|---|
| `758a711` | Info legend wording; the transition plan document. |
| `4a15b5f` | 2027 books parsed and published; 2026 republished as an Oct 31 → tail; parser fix for the 2027 PDF layout; seeder fix; loader dedupe of equal timestamps; `--from-date` on the manifest builder; NOAA 2027 fetched. |
| `cdcc0b9` | IWLS API fetcher and two comparison tools; the 2027 parse verified against the API event for event. |
| `7898316` | Published CHS primaries switched from the book parse to the IWLS fetch (`--primaries iwls`), with book metadata carried over. |
| `e440197` | Table 3 ports published with their own IWLS predictions (`tidal_secondary_direct`); proportional magnitude rule for current-referenced absolute-knots rows; published window shortened to Oct 31 2026 – Oct 31 2027 (`--to-date`). |
| `f685ff2` | Square-root range scaling for tide-referenced absolute-knots rows. |

## 2. Decisions already made (context, not up for review)

- 2027 is the last printed edition of the CHS tables. The IWLS API is the
  Canadian source from here on; the book parse remains a cross-check and
  the only source of Table 3 / Table 4 offsets, which are frozen from 2027.
- Published window is a rolling twelve months, Oct 31 2026 – Oct 31 2027
  today, to hold the download down after adding port predictions.
- Direct IWLS predictions are used for every Table 3 port that has them
  (256 of 263), not just the badly derived ones.
- Absolute-knots Table 4 rows scale with the tide instead of rendering the
  printed large-tide speed flat: by the reference current's actual-over-
  large ratio (14 rows), or by the square root of the tidal half-cycle
  range over the reference port's large-tide range (13 rows). Evidence is
  in `iwls_api.md` §5 and §9. No UI caveat was added; the owner declined.
- The info legend states that times are BC time and that in winter they
  read one hour later than Washington clocks.

## 3. Where to look, in priority order

### 3.1 `web/src/interp/secondaryCurrents.ts` (new logic, highest risk)

`secondaryCurrentExtremes(sec, refClassified, turnRefClassified, refScale)`
gained the fourth parameter, a discriminated union `RefScale`
(`{kind:"current", maxFlood, maxEbb}` or `{kind:"tide", largeRange}`).

- `scaledKnots` (current reference): `secMax × |refV| / refMax`. Applied on
  direct max events when Table 4 gives a max time diff, and in the
  midpoint-synthesis path otherwise. Falls back to the flat printed value
  when the reference max is weak, zero, or no scale is supplied.
- In the synthesis path the matching reference max is found by binary
  search (`nearestRefMax`) at the midpoint shifted back by the mean turn
  offset, within a 4 h window (`SYNTH_MATCH_WINDOW_MS`). Check: is the
  shift direction right (`t − turnShift`), and can a half-cycle ever borrow
  the wrong reference max in a double-humped flow? Blackney / Johnstone
  Strait Central have many weak maxes; weak falls back to flat by design.
- `rangeScaledKnots` (tide reference): `secMax × sqrt(range / largeRange)`,
  where range is `|refV_b − refV_a|` of the two slacks bracketing the
  synthesised peak. `EmittedEvent.refV` was added to carry the tide height
  through; for current-referenced slacks it is 0 and unused. Check: the
  bracketing slacks come from `turnRefClassified`, which for the two
  footnote (a) stations (Alert Bay, Pulteney Point) is a different primary
  from the rate reference. Those two are current-referenced, so the tide
  branch never sees them, but confirm nothing else mixes the two arrays.
- Ratios above 1 are allowed in both rules (a reference exceeding its own
  large-tide value scales the secondary above its printed value). That is
  consistent with the percentage rule; say if you think it should cap.
- No tests cover `turn_to_ebb_conditional` (Haro Strait) or
  `lower_lw_turn_to_flood_diff` (Nitinat Bar) in combination with the new
  scaling. Nitinat is tide-referenced and absolute-knots, so it now goes
  through `rangeScaledKnots` with the per-LW slack offsets. Worth a
  targeted test.

Tests: `secondaryCurrentsScale.test.ts` (five cases, pinned to Dent
Rapids / Gillard numbers and a Point Atkinson-style tide), plus the
existing `secondaryCurrents.test.ts` (19) which still passes with the
default `refScale = null`.

### 3.2 `web/src/data/loader.ts`

- `dedupeEqualT`: after the multi-year concat-and-sort, drops entries
  whose `t` equals the previous one, keeping the later (stable sort, later
  year appended second). Needed for the PST/PDT New Year overlap of the
  book era and for Port Renfrew, which CHS prints in two volumes and the
  loader therefore pushes twice per year. With both years now fetched at
  UTC−7 the overlap is gone, but the dedupe stays as a guard. Test in
  `loader.test.ts`.
- Direct secondaries: per year, `tidal_secondary_direct` stations are
  indexed by `index_no`; in the Table 3 loop a port with a direct record
  uses `tideExtremes(direct)` instead of `secondaryTideExtremes(...)`.
  Metadata (coords, kind, `tide_lhhw`/`tide_lllw` bounds) still comes from
  the Table 3 record and its reference, so the reference lookup is still
  required. Check the fallback path still runs for the seven ports IWLS
  lacks (7194, 7196, 7240, 7771, 9090, 9470, 9960) and that a port present
  in the direct file for one year but not the other would merge sensibly.
- `refScale` construction for current secondaries: tide branch uses
  `higher_high_water_large_tide − lower_low_water_large_tide` of the tide
  reference; current branch uses `|max_flood_knots|`, `|max_ebb_knots|` of
  the current reference. Those fields now come from the book via the
  fetcher's carry-over (§3.4); if that carry-over were ever skipped the
  current-branch denominators would silently become the year's largest
  event instead of the Table 4 large-tide value.

### 3.3 `build_manifest.py`, `apply_coord_overrides.py`, `process_combined.sh`

- `KINDS` gained `tidal_secondary_direct` (source
  `{year}_iwls_tidal_secondary_predictions.json`) and the two primary
  kinds take their source from `--primaries iwls|tct` (default `iwls`).
  Secondaries (`*_tct_*`) are always the book files.
- `trim_days(from_md, to_md)` drops days outside a station-local
  `(month, day)` window before hashing; `--from-date` / `--to-date` must
  be in `--year`. Files without `days[]` pass through. Check the inclusive
  semantics (`--to-date 2027-10-31` keeps Oct 31) and that
  `extreme_iso_range` then yields the right `first/last_extreme_utc`
  (today: 2026 starts `2026-10-31T07:00Z`, 2027 ends `2027-11-01T07:59Z`;
  the NOAA files are UTC−8 so the window edges differ by an hour between
  CHS and NOAA stations, and the date picker's noon rule hides the stub
  days).
- `apply_coord_overrides.py` now processes IWLS primary files whose
  coordinates are already precise; its flagging heuristics were written
  for integer-arcminute PDF coordinates. All 44 primaries have overrides
  so the heuristics never fire for them, but the code path is no longer
  what the comments describe.
- Publish-time allowlist for `tidal_secondary_direct` keeps only `name`,
  `index_no`, `year`, `utc_offset`, `days`.

### 3.4 `canada_data/fetch_iwls.py` (new, 400 lines)

- Roster from `{roster-year}_tct_*` files; `--add-tides/--add-currents`
  for extra five-digit codes; `--secondaries` for the Table 3 ports.
- Window `[Jan 1 00:00, Jan 1 00:00 next year)` at `--utc-offset`
  (default −7); IWLS `to` is inclusive, so the fetcher filters `< end`.
  Cache key includes the offset.
- Event mapping: SLACK → slack 0; EXTREMA_FLOOD → +v; EXTREMA_EBB → −|v|;
  WEAK_AND_VARIABLE → max 0 with `weak_variable: true`; anything else is
  skipped with a warning (none seen).
- `--metadata-from roster` (default) copies the book's Table 2 heights and
  Table 4 maxima/directions onto the records, keeping IWLS values as
  `iwls_*` fields (stripped at publish). This is what keeps published
  metadata byte-identical to the book era and feeds the scales in §3.2.
- Days are emitted for the whole local year including empty ones, like
  the parser. Values keep IWLS precision (3 dp); the UI rounds to 1 dp.
- The Table 3 port file is written compactly (~15 MB per year, tracked in
  git); the primaries indented (~14 MB per year, tracked).

### 3.5 `canada_data/read_tct.py` and `seed_iwls_overrides.py` (book era, still used for Table 3/4)

- `_parse_current_header` now orders `extract_text_lines()` by `top` and
  searches lines 2–7 for `(UTC±Nh)` with an optional `PST|PDT|HNP|HAP`
  token (French right-hand pages have no space before the parenthesis).
  Verified: the 2026 books re-parse byte-identically under old and new
  code; 2027 parses fully. An earlier version of this fix required the
  space and silently halved every current station to 182 days, which is
  why the regression check exists.
- `identify_blocks` treats any `_block_*` marker it does not know as a
  hand-curated block. The first 2027 run deleted eight hand-placed Table 4
  entries because `_block_table4_continuation_restored` was unknown; the
  file was restored from git before anything was published.

### 3.6 Tests and the test data

- `tideDataInvariants.test.ts`: the full-year assertion became "consecutive
  dates, ≥ 60 days" to allow windows; a new case checks the direct port
  files (count ≥ 200, all in Table 3, contiguous, alternating, in range).
- `dataInvariants.test.ts` (currents) unchanged and passing on the
  trimmed 2026 tail and the 304-day 2027.
- `web/scripts/iwls-secondaries.test.ts` is a report, skipped unless
  `IWLS_COMPARE=1`; it compares derived Table 3/4 predictions against IWLS
  direct ones. `IWLS_ROOT` can point it at a scratch directory.
- 104 tests pass (`cd web && npx vitest run`); `npx tsc -b` is clean.

## 4. How to verify locally

```bash
cd web && npx tsc -b && npx vitest run                 # 104 tests
cat web/public/data/manifest.json                      # two years, seven CHS/NOAA kinds each
venv/bin/python canada_data/compare_iwls_tct.py --year 2027   # book vs API, same-minute everywhere
cd web && IWLS_COMPARE=1 IWLS_YEAR=2027 npx vitest run scripts/iwls-secondaries
cd web && npm run dev                                   # date picker: Oct 31 2026 → Oct 31 2027
```

Re-fetching from IWLS (`canada_data/fetch_iwls.py --year 2027
--secondaries`) takes about three minutes and is cached under
`canada_data/iwls_raw/`; a re-fetch may legitimately differ from the
committed files if CHS re-issues predictions (it did so for Winter Harbour
and Fulford inside 2026).

## 5. Known caveats and open items

- Payload is 3.86 MB gz for the window (was 1.88 MB for Nov 2026 – Dec
  2027 without port predictions); 2.16 MB of it is the port file. Heap is
  unchanged because derived secondaries already occupied it. Per-region
  lazy loading is the next lever if cold start matters.
- Five current primaries' manual coordinate overrides differ from IWLS's
  positions by 0.1–1.3 km (Blackney Passage the largest). Not resolved.
- Campbell River / Vancouver / Point Atkinson / Port Alberni DST-day
  events are an hour late in the printed books (verified against the API's
  continuous curve); published data now comes from the API so the app is
  right, but the `*_tct_*` primary files still carry the book values.
- The report script's Table 3 comparison shows the derivation is poor at
  ~68 ports; that is moot for the 256 ports now served directly but still
  applies to the seven fallbacks.
- `apply_coord_overrides.py` comments and the "flagged for review"
  heuristics describe PDF-era inputs (§3.3).
- Current events in IWLS are held only to 2028-01-01 today; the 2028 drop
  waits on that (tides are held to late 2029).
- Not promoted to `release`; the owner wants a phone check first.
