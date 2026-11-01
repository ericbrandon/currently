# 2026 → 2027 data transition plan

Written 2026-11-01 after reviewing the 2027 CHS books (vol 5/6/7, downloaded to
`2027 books/`) against the 2026 pipeline and the runbooks in `deploy.md` §9,
`app_implementation.md` §12.7, `canada_data_processing.md` "Annual upstream-source
refresh", `combined_data_processing.md` "Resolving flagged stations", and
`US_data_processing.md` "The pipeline".

Goal: currentlybc.com serves **Nov 1 2026 – Dec 31 2027** instead of all of 2026.

## 1. What the 2027 books changed

Found by parsing all three 2027 volumes with a patched copy of `read_tct.py`
(see §3.1) and diffing against the 2026 parser output at the repo root.

| Item | 2026 | 2027 | Consequence |
|---|---|---|---|
| Time zone on every page | `PST-HNP (UTC-8)` | `PDT-HAP (UTC-7)` | Parser extracts −7 automatically for tides. Loader converts per station, so no app change. Creates a one-hour overlap at New Year (§1.2). |
| Current-table header text order | UTC line is line 3 of `extract_text()` | UTC line comes out as line 6, after the column headers | `_parse_current_header` raises on the first current station. **Parser fix required** (§3.1). Word positions are identical; only the PDF content-stream order changed. |
| Edition | — | "**Final edition**": 2027 is the last year CHS publishes the regional compendium | 2028 data will have to come from tides.gc.ca / the IWLS API. Plan a new Canadian source during 2027 (§6). |
| Primary tide stations | 22 unique (23 rows; Port Renfrew is printed in vol 5 and vol 6) | same | No station added or removed. |
| Secondary tide ports (Table 3) | 263 after suppression | 263 after suppression | Identical roster. The 5 US ports (7050, 7060, 7215, 7570, 8512) are still printed and still caught by `_suppress_index_nos`. Friday Harbor 7240 still present. |
| Current primaries | 22 | 22 | Identical. All 365 days, event counts within 5 % of 2026. |
| Secondary currents (Table 4) | 47 | 47 | Identical, including footnote markers (parser did not raise on any un-curated marker). |
| Station metadata | — | Only **Winter Harbour (8735)** changed: HHW large 4.3→4.4, HHW mean 3.5→3.6, LLW large −0.1→0.0, MWL 2.2→2.3 (a +0.1 m datum revision). | Latest-year-wins metadata picks up 2027 values. Expect a ~0.1 m step at midnight Jan 1 at Winter Harbour and its Table 3 dependents. Cosmetic. |
| Coordinates | integer arcminutes | integer arcminutes (720/720 raw coords exact) | Existing `coord_overrides.json` applies cleanly: **0 flagged stations**, 332 overridden, 2 via CSV, 21 kept from PDF. No new override work. |
| Record of changes page | empty | empty | Nothing to track yet; re-download before the final run if CHS posts corrections. |

Publish-time sizes for 2027 CHS (from a `build_manifest.py` dry run into scratch):
tidal_primary 158 KB gz, current_primary 280 KB gz, secondaries 11 KB gz.
2027 range: first extreme `2027-01-01T07:01Z`, last `2028-01-01T06:59Z`.

### 1.1 NOAA

The NOAA datagetter already returns 2027 predictions (checked Seattle 9447130
hilo tides and PUG1515 bin 1 currents through 2027-12-31). `process_us.sh --year
2027` can run now. Keep `time_zone=lst` (UTC-8): the "revisit when BC's 2027
chartbook ships at UTC-7" note in `US_data_processing.md` is resolved by the
fact that every station carries its own `utc_offset`. Mixing −7 CHS files with
−8 NOAA files is correct by construction.

### 1.2 The New Year overlap hour

The 2026 book (PST) ends at Dec 31 23:59 PST = `2027-01-01T07:59Z`. The 2027 book
(PDT) starts at Jan 1 00:00 PDT = `2027-01-01T07:00Z`. Any event between 07:00Z and
08:00Z is printed in **both** books. In the data that is 2 tide primaries (Sooke,
Owen Bay) and 13 current primaries, each with one event that is byte-identical in
time and value in both years.

After the loader's per-year concat-and-sort the merged `Extreme[]` for those
stations contains two entries with equal `t`. Effects:

- `valueAt` / `currentValueAt` already guard `e2.t === e1.t` — no NaN.
- `TidePanel` / `CurrentPanel` list the event twice.
- `TidePanel` runs `classifyHiLow` over the merged array; HW,HW breaks the
  alternation at that point and can mislabel the rows around New Year at Sooke
  and Owen Bay.
- Secondaries are derived per year and concatenated, so they duplicate too.

Fix in `loader.ts` `flattenPerYear`: after sorting, drop an entry whose `t` equals
the previous entry's `t` (keep the later year's). NOAA has no overlap (LST both
years).

## 2. Review of the existing runbooks

What still holds:
- The architecture is multi-year by design: `manifest.years[]`, per-station merge by
  `index_no`, `/data/2*` immutable headers, SW `warmDataCache` backfills new year
  files on activation. No app, headers, or SW change is needed to add 2027.
- Tests glob every year directory, so 2027 is covered the day its files land.
- `coord_overrides.json` persists across years as promised: zero new flags.
- `dataInvariants` / `TABLE4_FOOTNOTES` 2027-proofing worked (loud failure, not
  silent corruption).

What is stale or missing:
- `deploy.md` §9 and `app_implementation.md` §12.7 say "place PDFs in repo root
  and run `./process_tct.sh`". That script no longer exists and the parser reads
  from `canada_data/`. The real sequence is `canada_data/process_canadian.sh`,
  `us_data/process_us.sh`, `process_combined.sh` (plus the seeder step).
- `process_canadian.sh` has no `--directory` passthrough, so the 2027 PDFs must be
  moved into `canada_data/` (they are gitignored by `*.pdf`).
- Nothing in the plan covered the UTC-8 → UTC-7 overlap hour (§1.2).
- Nothing covered trimming the old year; `tideDataInvariants.test.ts:79` asserts
  every primary has `daysInYear` days, which a Nov–Dec 2026 file will fail.
- `parse_current_station` hardcodes `timezone="PST-HNP"` on current stations.
  Harmless (the field is stripped at publish) but now wrong; take the token from
  the header while fixing §3.1.
- `US_data_processing.md` "Cross that bridge when the 2027 CHS data arrives" —
  resolved, no change needed (§1.1).

## 3. Plan

### 3.1 Code changes (before running the pipeline)

1. **`canada_data/read_tct.py` `_parse_current_header`** — stop relying on
   `extract_text()` line order. Use `page.extract_text_lines()` sorted by `top`,
   take year from line 0 and name from line 1, and search lines 2–7 for
   `\(UTC([+-]\d+)h?\)`. Also capture the `PDT`/`PST` token for `timezone`.
   A working patch is in
   `/private/tmp/claude-501/-Users-ericbrandon-Development-Currently/ee5d826a-ab2d-4be4-8791-be2e7fc619c9/scratchpad/parser_patched/read_tct.py`
   (diff it against `canada_data/read_tct.py`). It parsed all three 2027
   volumes end to end. Re-run on 2026 afterwards and confirm the 2026 JSONs are
   byte-identical (the tide path is untouched; the current path only changes how
   the header is located).

2. **`build_manifest.py` — add `--from-date YYYY-MM-DD`** to ingest mode. Keep
   only days whose station-local `(month, day)` ≥ the cutoff's `(month, day)`
   for files that have `days[]` (tidal_primary, current_primary, noaa_*).
   Secondary files carry no days and pass through; the loader derives their
   extremes from the trimmed primaries, so they trim for free. Content hashes
   change, stale siblings are removed, and `first_extreme_utc` is recomputed from
   the trimmed file, so the manifest range moves on its own.

   Recommended cutoff: **`--from-date 2026-10-31`**, one day of runway so Nov 1
   is interpolable from local midnight (the interpolator needs the extreme before
   the first displayed instant). Measured effect on 2026: 303,738 → ~52,000
   events; published 2026 gz drops from ~1.5 MB to ~0.26 MB. Combined
   Nov 2026 – Dec 2027 payload ≈ 1.8 MB gz versus ≈ 3 MB for two full years;
   runtime heap stays near today's ~40 MB instead of the ~80 MB
   `runtime_heap.md` projects for two full years.

3. **`web/src/data/loader.ts` `flattenPerYear`** — dedupe equal `t` after the
   multi-year sort (§1.2).

4. **`web/src/interp/tideDataInvariants.test.ts:79`** — replace "exactly
   `daysInYear`" with "days are consecutive calendar dates, end on Dec 31, and
   there are at least 60 of them (full year, or a trimmed tail)". Keep the
   alternation and range checks as they are. Check `dataInvariants.test.ts`
   still passes on the trimmed 2026 slice: Johnstone Strait Central keeps 102
   weak maxes from Oct 31, and its classified flood/ebb split stays above the
   25 % floor only because weak maxes are classified as floods — run it rather
   than assume.

5. Docs: rewrite `deploy.md` §9 and `app_implementation.md` §12.7 to the real
   command sequence below; add the `--from-date` convention; note the overlap
   hour and the final-edition notice. Update `US_data_processing.md`'s open
   note. Optional: `InfoModal` "© 2026" → "© 2026–2027".

### 3.2 Pipeline run (order matters)

```bash
# 0. Source files
mv "2027 books"/*.pdf canada_data/            # parser discovers by filename (tct, 2027, volN)
# optional: re-download the CHS inventory CSV (canada_data_processing.md step a)

# 1. Canada: refresh IWLS-seeded overrides, then parse
./canada_data/refresh_seeded_overrides.sh --year 2027   # re-parses, then seeds; expect "Nothing to write" or a handful of refreshes
./canada_data/process_canadian.sh --year 2027           # → 2027_tct_*_stations.json at repo root

# 2. US
./us_data/process_us.sh --year 2027                     # halts on catalog anomalies; resolve per US_data_processing.md, re-run
                                                        # → 2027_noaa_*_stations.json at repo root

# 3. Publish 2027, then re-publish a trimmed 2026
./process_combined.sh --year 2027                       # apply overrides (expect 0 flagged) + ingest + manifest
venv/bin/python build_manifest.py --year 2026 --from-date 2026-10-31   # re-ingest 2026 tail; manifest rebuilt

# 4. Verify
cat web/public/data/manifest.json     # 2026 first_extreme ≈ 2026-10-31T08:xxZ, 2027 last ≈ 2028-01-01T06:59Z
cd web && npm test                    # invariants over both year dirs
npm run dev                           # scrub Oct 31 → Nov 1 2026, Dec 31 2026 → Jan 1 2027 (Sooke, Owen Bay, Race Passage), Dec 31 2027
```

Expected `apply_coord_overrides` summary for 2027 (already observed on the
scratch run): 355 stations, 5 suppressed, 332 overridden, 2 CSV, 21 PDF, 0 flagged.

### 3.3 Deploy

```bash
git add canada_data/read_tct.py build_manifest.py web/src web/public/data notes
git commit -m "Add 2027 CHS and NOAA tables; trim 2026 to Oct 31 onward"
git push origin main                  # preview: https://main.currently.pages.dev
# verify on a real phone (BC is on permanent UTC-7 as of today; old zone tables show 1 h off)
git push origin main:release          # production; manifest is no-cache, year files immutable
```

Service worker: nothing to change. `warmDataCache` fetches the new hashed files
on the next activation; `DATA_CACHE_MAX` 60 absorbs the stale 2026 files.

### 3.4 Order of checks on the live build

- Scrubber range starts Oct 31/Nov 1 2026 and ends Dec 31 2027; the date picker
  offers Nov 2026 through Dec 2027 and nothing outside.
- Now-lock lands on today with values at every station (no "no data" warning).
- New Year at Sooke / Owen Bay: one HW row, not two; HW/LW labels alternate.
- Winter Harbour chart bounds use the 2027 datum numbers.
- NOAA stations still render correct wall-clock times in winter (they stay at
  UTC-8 in the data; BC display zone is UTC-7, so a WA user's phone clock will
  now read one hour earlier than the app's labels — see §5).

## 4. Risks

- **Overlap duplicates** (§1.2) — ship the loader dedupe in the same release as
  the 2027 data.
- **Trimmed-year test** — the full-year assertion fails on the 2026 tail until
  §3.1 step 4 lands.
- **NOAA catalog anomalies** — `check_stations.py` may flag renames or bin changes
  for 2027. Handle per the runbook; do not `--force` through a missing bin.
- **Zone tables** — devices without the BC permanent-UTC-7 rule display BC times
  one hour early from today onward. Not fixable in the app; worth knowing when a
  bug report arrives.

## 5. Open question: display zone for US stations

`util/time.ts` formats everything in `America/Vancouver`. Until today BC and WA
shared an offset year-round; from Nov 1 2026 WA is UTC-8 in winter while BC stays
UTC-7. A user on the US side now sees labels one hour ahead of their wall clock
for five months a year. Options: keep BC time everywhere (document it in the
info modal), or format NOAA stations in `America/Los_Angeles`. Decide separately
from the data drop.

## 6. 2028 and the final edition

CHS says 2027 is the last regional compendium. The replacement source is the
Canadian Tide and Current Tables website / IWLS API (`api-iwls.dfo-mpo.gc.ca`),
which the seeder already uses for station metadata. During 2027: confirm IWLS
serves high/low and slack/max predictions for the 22 + 22 primaries and the
Table 3 / Table 4 offsets (or an equivalent), then write a `read_iwls.py` that
emits the same four JSON shapes so `process_combined.sh` and the app stay as
they are. Budget this for spring 2027, not autumn.
