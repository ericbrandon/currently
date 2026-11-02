# IWLS API: the post-2027 Canadian data source

The 2027 Tide and Current Tables are CHS's final printed edition. From 2028
the Canadian data comes from the Integrated Water Level System (IWLS) API:

- Swagger: https://api-iwls.dfo-mpo.gc.ca/swagger-ui/index.html
- Spec: https://api-iwls.dfo-mpo.gc.ca/v3/api-docs
- Base: `https://api-iwls.dfo-mpo.gc.ca/api/v1`

This note records what the API offers, the tools that read it, how its
2027 predictions compare with the 2027 books (they match), and what it
makes possible beyond the books. Written 2026-11-01.

## 1. Endpoints that matter

| Endpoint | Use |
|---|---|
| `GET /stations?chs-region-code=PAC` | Catalog: 370 Pacific stations with `code` (the five-digit CHS index), `id` (Mongo-style id used by every other call), name, coords, `type` (PERMANENT = gauge, TEMPORARY = prediction-only) and the time-series codes each offers. |
| `GET /stations/{id}/data?time-series-code=…&from=…&to=…` | The data. `from`/`to` are UTC ISO 8601; `to` is inclusive. A whole year of `wlp-hilo` or `wcp1-events` comes back in one call. 1-minute series (`wlp`, `wcsp1`, `wcdp1`) are capped at 7 days per call, 31 days at `resolution=SIXTY_MINUTES`. |
| `GET /stations/{id}/metadata` | Tidal heights (HHWLT, MHHW, MLLW, LLWLT, MWL, HRWL, LRWL at 2 dp), datums (CGVD2013/CGVD28 offsets), `isTideTableReferencePort`, `tideTableId`, and for current stations `floodDirection` / `ebbDirection`. |
| `GET /stations/{id}/holdings` | Date range held per time series. Today: hi/lo predictions to **2029-11-30**, current events to **2028-01-01**, observations to now. |
| `GET /tide-tables` | The books' volume → area → sub-area hierarchy (vol 5/6/7 with their numbered areas), linked from station metadata by `tideTableId`. |
| `GET /time-series-definitions`, `/height-types`, `/phenomena` | Dictionaries. Units: water level m, current speed kn, direction degrees true. |

Time-series codes used:

| Code | Meaning | Record |
|---|---|---|
| `wlp-hilo` | High/low tide predictions | `eventDate` (UTC), `value` m (3 dp) |
| `wcp1-events` | Current prediction events | `qualifier` ∈ SLACK, EXTREMA_FLOOD, EXTREMA_EBB, WEAK_AND_VARIABLE; `value` kn (positive magnitude; ebb sign is implied by the qualifier) |
| `wlp` | Continuous water-level prediction | 1-minute |
| `wcsp1` / `wcdp1` | Continuous current speed / direction prediction | 1-minute |
| `wlo` | Observed water level (gauged stations) | 1-minute, live |

No authentication. Pacing of 4 requests per second drew no throttling; the
fetcher sleeps 250 ms between calls and retries 429/5xx.

## 2. Coverage versus the 2027 books

| Book class | In books | In IWLS with the needed series | Missing |
|---|---|---|---|
| Tide primaries (Tables 1/2) | 22 | 22 (`wlp-hilo`, metadata heights) | — |
| Current primaries (Table 4 reference rows) | 22 | 22 (`wcp1-events`, flood/ebb directions in metadata) | — |
| Table 3 secondary ports | 263 | **256 with their own `wlp-hilo`** | 7194 Yokeko Pt, 7196 Reservation Bay, 7240 Friday Harbor (US), 7771, 9090, 9470, 9960 |
| Table 4 secondary currents | 47 | **1** (08138 Dent Rapids) | the other 46 |

Beyond the books, IWLS has hi/lo predictions for 58 more Pacific tide
stations (Gorge waterway ×4, Steveston, New Westminster, Ambleside,
Roberts Bank, Bamberton, Esperanza, Port Alice, Sandspit…) and current
events for five stations the books do not print as primaries: Tillicum
Bridge (07129), Calamity Point (07724), Dent Rapids (08138), Porpoise
Channel East (09341), Fairview Terminal (09348).

What IWLS does **not** carry: Table 3 time/height differences, Table 4
offsets and percentages, the "maximum at large tides" knots, and the
Table 4 footnote semantics. For 2028 those stay frozen from the 2027 parse
(they are station characteristics, not annual predictions).

## 3. Tools

- `canada_data/fetch_iwls.py --year Y [--secondaries] [--add-currents 08138] [--roster-year 2027] [--utc-offset -7]`
  Fetches the roster (by default the stations in `{Y}_tct_*` at the repo
  root) and writes `{Y}_iwls_tidal_primary_stations.json`,
  `{Y}_iwls_current_primary_stations.json` and, with `--secondaries`,
  `{Y}_iwls_tidal_secondary_predictions.json`, all in `read_tct.py`'s shape
  (local days at the chosen offset, `readings[]` / `events[]`). Raw
  responses cache under `canada_data/iwls_raw/<year>/` (gitignored). Values
  keep IWLS precision (3 dp); `max_flood_knots` / `max_ebb_knots` are the
  year's largest event, as in the NOAA path. `--metadata-from roster`
  (default) then carries the book's Table 4 large-tide maxima and Table 2
  heights onto the records, keeping IWLS's own values as `iwls_*` fields;
  `--metadata-from iwls` uses the API throughout. The raw cache key
  includes the local offset.
- `apply_coord_overrides.py`, `build_manifest.py` and `process_combined.sh`
  take `--primaries iwls|tct` (default `iwls`): which pipeline supplies the
  two CHS primary files. Secondaries always come from the `*_tct_*` files.
- `canada_data/compare_iwls_tct.py --year Y`
  Pairs every book event with the IWLS event at the same UTC minute and
  reports count, same-minute matches, |dt| histogram, value mismatches
  after rounding IWLS to the book's 0.1, kind mismatches, unpaired events,
  and metadata deltas (coords, heights, directions).
- `web/scripts/iwls-secondaries.test.ts` (run with `IWLS_COMPARE=1 IWLS_YEAR=Y npx vitest run scripts/iwls-secondaries`)
  Compares the webapp's *derived* Table 3 tides and Table 4 currents
  against IWLS's direct predictions for the same stations. Writes
  `canada_data/iwls_raw/<year>/secondary_comparison.tsv`.

## 4. Results: 2027 book versus IWLS

Run 2026-11-01 (`compare_iwls_tct.py --year 2027`).

**Tide primaries (22 stations, ~30,000 events).** Every book event has an
IWLS event at the same UTC minute with the same height after rounding.
Differences, all explained:

- IWLS prints a few extra micro high/low pairs the book suppresses: Sooke
  4 (e.g. 2.341 m then 2.331 m an hour apart), Campbell River 12.
- **Campbell River 2027-03-14: the book's 10:16 PDT low is one hour late.**
  IWLS's hi/lo says 09:16Z and its 1-minute `wlp` curve bottoms at
  09:15Z. The 2026 book has the same defect on 2026-03-08 at Vancouver,
  Point Atkinson and Port Alberni (events in the 02:xx local hour on the
  DST-change date). The printed tables are generated through a civil-time
  step that still applies the spring-forward rule; IWLS is UTC-native.
  One event per affected station per year; the app currently carries the
  book's value.
- Metadata heights: the book rounds to 0.1 m; a handful differ by more
  (Bella Coola HHWLT 5.6 vs 5.83, Hunger Harbour LLWLT 0.0 vs 0.28).
  IWLS's look like a newer epoch. Chart bounds only.

**Current primaries (22 stations, ~59,000 events).** Every event pairs at
the same minute with the same kind, including every weak-and-variable
max. Value differences are only x.x5 rounding ties (the book rounds
2.850 down to 2.8, 1 to 9 per station per year).

**Verdict:** the 2027 parse is correct, and `fetch_iwls.py` reproduces it.
For 2028 the fetcher can replace the parser for primaries without any
change to the published JSON shape or the app.

### 2026 cross-check

`compare_iwls_tct.py --year 2026` (book printed in PST, fetched with
`--utc-offset -8`): same agreement, plus two cases where IWLS has moved on
since the book was printed:

- Winter Harbour: IWLS 2026 predictions are 0.12 m higher and shifted 1–3
  min all year. The 2027 book carries the same revision (its datum heights
  moved +0.1 m), so the book-sourced Nov–Dec 2026 tail is ~0.1 m low there.
- Fulford Harbour: IWLS is +0.06 m from 2026-09-14 to year end (84 readings
  round differently). 2027 matches exactly.
- Blackney Passage: four weak ebb maxes on 2026-03-11..13 and 09-20 sit at
  different local extrema in the two sources (weak, double-humped flow).

IWLS is the living record; printed books freeze at press time.

### Coordinates

IWLS's `/stations` positions differ from our manual overrides for five
current primaries: Beazley 0.10 km, Gillard 0.13 km, Seymour Narrows
0.32 km, Quatsino Narrows 0.32 km, **Blackney Passage 1.31 km**
(override 50.566631, −126.687238; IWLS 50.555000, −126.684200). Worth a
look on a chart before deciding which to keep.

## 5. Results: derived secondaries versus IWLS direct predictions

**Table 3 tides (256 ports).** Our Table 3 derivation versus IWLS's own
harmonic prediction for the same port, per-station p90 of |Δt| and |Δh|:

| | ports |
|---|---|
| within 15 min and 0.10 m | 24 |
| within 30 min and 0.20 m | 141 |
| worse than that | 115 |

Median port: 6 min / 0.07 m. Worst: Aero Trading (p90 1.12 m, high waters
0.8 m too high), Khyex Point, Kwinitsa River, Sand Heads (0.55 m), Deep
Cove, the Prince Rupert river stations. These are limits of the Table 3
method (linear interpolation of a height difference between mean and large
tide, extrapolated to small tides), not implementation bugs: Aero Trading's
HW difference runs from +0.5 m at mean tide to −0.2 m at large tide and our
formula reproduces exactly what the printed instructions give.

**Table 4 currents (Dent Rapids, the one station IWLS has).** Dent Rapids
is an "absolute knots" row (11 kn flood / 9.5 kn ebb at large tides, no
percentage), so the app emits 11 kn on every flood. IWLS says 3–7 kn on
most floods, 9.9 kn peak. Scaling the printed large-tide value by the
reference's actual-over-large-tide ratio, `11 × (Gillard actual ÷ 12.5)`,
reproduces IWLS to within a few tenths of a knot (median flood ratio
IWLS/Gillard 0.88 = 11/12.5; ebb 1.04 ≈ 9.5/9.5). Slack timing: IWLS runs
about 20 min later than Table 4's −00:15 / −00:25 offsets imply.

27 of the 47 Table 4 secondaries use the absolute-knots rule (14 referenced
to current primaries, 13 to tide primaries), so the flat-magnitude
rendering overstates speeds at Sansum Narrows, Okisollo, Yuculta, Dent,
Greene Point, Whirlpool Rapids, Nakwakto's neighbours and the rest on
every tide smaller than a large one.

One exception, found in review: six of the 14 current-referenced rows
(Alert Bay, Pulteney Point, Camp Point, Current Passage, Masterman
Islands, Browning Islands) reference Johnstone Strait Central, whose
flood is structurally suppressed: 585 of its 704 floods are weak and the
119 real ones peak at 0.51 kn against a printed large-tide 1.5. Scaling
Alert Bay's real 4 kn flood by that ratio would understate it on real
days and, with a flat fallback on weak days, invert the row. So the
proportional rule is switched off for any reference *direction* whose
maxes are more than 20 % weak (`WEAK_DOMINATED_SHARE`); those six rows'
floods stay flat as before, their ebbs scale (JSC's ebb is healthy). On a
scaled direction a weak reference max now yields a weak (0) secondary
max, as the percentage rule does.

## 6. Opportunities, in rough order of value

1. **Switch Canadian primaries to IWLS now.** Same shape, same values,
   plus 3 dp heights, the DST-day fix, and freedom from the PDF parser.
   Keep the book parse as the 2027 cross-check only.
2. **Serve Table 3 ports from IWLS's direct predictions** (256 of 263).
   Removes the derivation error entirely; the seven ports IWLS lacks keep
   the Table 3 method. Changes the loader (secondary tides become
   primaries with their own `days[]`) and raises the payload (~3.5 MB raw
   per year before stripping; hi/lo for 256 ports ≈ 1,400 events each).
3. **Proportional magnitude for absolute-knots secondaries.** Validated on
   Dent Rapids; apply `sec_max × (ref actual ÷ ref large-tide max)` for
   current-referenced rows. For tide-referenced rows the analogous scale
   is the reference's range over its large-tide range; unverified (no
   IWLS station to check against), so flag it in the UI or keep flat.
4. **Add the five IWLS-only current stations** (Dent Rapids direct,
   Tillicum Bridge, Calamity Point, Porpoise Channel East, Fairview
   Terminal) and whichever of the 58 extra tide stations matter to users
   (Gorge, Steveston, New Westminster, Ambleside, Bamberton, Esperanza,
   Sandspit).
5. **Live observed water level** (`wlo`): 14 of the 22 primaries and 18
   Table 3 ports are gauged. Observed minus predicted is the storm-surge
   residual; a "now" marker on the tide chart or a residual badge is
   cheap to build (one call per visible gauged station, 20-minute latest
   endpoint also exists).
6. **Two years ahead.** Hi/lo predictions are held to 2029-11-30, so 2028
   and 2029 tides can be published any time; current events currently end
   2028-01-01 and will need to extend before the 2028 drop.
7. **1-minute speed and direction** (`wcsp1`/`wcdp1`) could validate or
   replace the cosine/quarter-sine interpolation shape at primaries, and
   give true direction at every instant instead of the fixed flood/ebb
   bearings. Too large to ship (525k points per station-year) but ideal
   for offline validation of `valueAt`.
8. **Refresh instead of freeze.** Re-run the fetch quarterly and diff; the
   Winter Harbour and Fulford cases show CHS re-issues predictions inside
   a year.

## 7. Switch made 2026-11-01

Opportunity 1 was taken: the published Oct 31 2026 – Dec 31 2027 CHS
primaries now come from `fetch_iwls.py` (both years fetched at UTC−7, so
they meet at local midnight with no overlap), with the book's large-tide
maxima and Table 2 heights carried over. Table 3/4 secondaries still come
from the 2027 book parse. The book parse remains the cross-check
(`compare_iwls_tct.py`). Consequences: the Campbell River DST-day event is
now correct, the Winter Harbour and Fulford revisions are in the 2026 tail,
and the Jan 1 step at Winter Harbour is gone.

### Second step, later on 2026-11-01

Opportunities 2 and 3 were taken as well, and the published window was
shortened to **Oct 31 2026 – Oct 31 2027** to hold the download down:

- `tidal_secondary_direct`: `fetch_iwls.py --secondaries` output is
  published as a sixth CHS file per year. The loader uses a port's direct
  IWLS prediction wherever one exists (256 of 263) and falls back to the
  Table 3 derivation for the rest; metadata still comes from the Table 3
  record. Both years were fetched at UTC−7.
- Proportional rule (`secondaryCurrents.ts`): the 14 absolute-knots rows
  referenced to a current primary now scale the printed large-tide speed
  by the reference's actual-over-large-tide ratio, on direct and
  synthesised maxes alike; weak reference maxes keep the flat value. The
  reference maxima come from the Table 4 rows carried onto the IWLS
  primaries. The 13 tide-referenced rows use square-root range scaling
  (§9).
- `build_manifest.py --to-date` trims the far end the way `--from-date`
  trims the near end; `process_combined.sh` passes both through.

## 9. Research: scaling for the 13 tide-referenced rows

Question: for a Table 4 row like Malibu Rapids (9 kn at large tides,
referenced to Point Atkinson's HW/LW), is it reasonable to scale the
printed speed by the reference tide's range? There is no IWLS current
station to check such a row against directly, but we have fifteen current
*primaries* that sit next to a tide primary and are the same kind of
feature as the tide-referenced rows: sill rapids filling an inlet
(Sechelt Rapids / Point Atkinson, the Owen Bay rapids), inlet entrances
(First and Second Narrows / Vancouver, Quatsino / Winter Harbour, Masset),
strait passes (Dodd, Active, Porlier / Fulford), channels (Hiekish /
Prince Rupert). For each 2027 max at the current station, take the range
of the reference's tide cycle around it and compare the actual speed with
three predictors built only from the printed large-tide speed `S` and the
reference's large-tide range `R_large`:

| predictor | median error, as a fraction of `S` (30 station-directions) |
|---|---|
| flat `S` (what the app did) | 0.39 |
| linear `S · R/R_large` | 0.11 |
| square root `S · √(R/R_large)` | 0.11 |

Either scaling removes about three quarters of the error. The fitted
exponent of speed against range runs from ~0.3 (strait passes, Seymour)
through ~0.5 (the Owen Bay sill rapids, Sechelt ebb) to ~1.0 (First
Narrows, Quatsino, Hiekish). Linear under-predicts at the sill rapids by
1–2 kn; square root over-predicts there by about 1 kn and is high at 29 of
the 30 cases, which is the safe direction for a passage planner. Per-pair
numbers are in the scratch run of 2026-11-01 (reproduce with the script
in §3 of the plan note's run log).

Implemented 2026-11-01 (same evening): `secondaryCurrentExtremes` takes a
`RefScale` of kind `tide` (`largeRange = HHWLT − LLWLT` of the reference
port) and scales each synthesised max by the square root of its
half-cycle's range over that. The half-cycle range comes from the two
tide extremes that produced the bracketing slacks. The flat value remains
the fallback when no scale is supplied.

## 10. 2028 plan

1. `fetch_iwls.py --year 2028 --roster-year 2027 --secondaries` once
   current events for 2028 appear in holdings (check `/holdings` for a
   current primary; tides are already held to 2029).
2. Copy the 2027 Table 3 / Table 4 secondary files to the 2028 names;
   they hold offsets, not predictions, and the fetcher keeps the book's
   station names so every reference still resolves.
3. `process_us.sh --year 2028`, `process_combined.sh --year 2028
   --to-date 2028-10-31`, then `build_manifest.py --year 2027 --from-date
   2027-10-31` (the window is rolling; move both ends when you refresh).
   Full sequence in deploy.md §9.
4. Nothing else pending on the data side; opportunities 4–8 in §6 remain.
