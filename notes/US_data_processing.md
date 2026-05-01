# US (NOAA) tides & currents data processing

Working notes for ingesting and processing NOAA tides & currents data. Mirrors the Canadian (CHS) ingestion pipeline already in this repo, but kept as a separate program for now. Web app integration is **not** in scope yet.

## Goals

- Pull tide and current station data from NOAA for the regions we care about.
- Process it into the same shape our Canadian pipeline produces, so it can later drop into the same web app.

## Target regions / placenames

These are the plain-english placenames we want stations for. We'll resolve them to actual NOAA station IDs in a later step.

### Puget Sound — currents

1. Deception Pass
2. Swinomish Channel (incl. La Conner entrance)
3. Guemes Channel (Anacortes approaches; Rosario / Padilla)
4. Admiralty Inlet (incl. Point Wilson, Marrowstone Point, Bush Point)
5. Port Townsend Canal
6. Possession Sound / Saratoga Passage (around Possession Point)
7. Agate Passage
8. Rich Passage
9. Colvos Passage
10. Tacoma Narrows
11. Hale Passage (Fox Island)
12. Pitt Passage (incl. Wyckoff Shoal)
13. Balch Passage
14. Drayton Passage
15. Dana Passage
16. Pickering Passage
17. Peale Passage
18. Squaxin Passage
19. Hammersley Inlet (incl. Libby Point entrance)

### San Juan Islands — currents (honorable mentions)

20. Cattle Pass (south end of San Juan Channel)
21. Spieden Channel

### Tides

Central / North Sound:

1. Seattle / Elliott Bay
2. Shilshole Bay / Ballard
3. Ballard Locks / Lake Washington Ship Canal entrance
4. Edmonds
5. Everett / Port Gardner
6. Mukilteo / Possession Sound
7. Kingston / Apple Tree Cove
8. Port Madison
9. Eagle Harbor / Bainbridge Island
10. Poulsbo / Liberty Bay
11. Bremerton / Sinclair Inlet
12. Port Orchard / Sinclair Inlet
13. Blake Island

South Sound:

14. Gig Harbor
15. Tacoma / Commencement Bay
16. Tacoma Narrows / Narrows Marina area
17. Quartermaster Harbor / Vashon-Maury
18. Des Moines / Redondo area
19. Olympia / Budd Inlet
20. Shelton / Oakland Bay / Hammersley Inlet
21. Jarrell Cove
22. Penrose Point / Lakebay
23. McMicken Island / Harstine Island
24. Hope Island / Squaxin Island area

Hood Canal:

25. Hood Canal — Seabeck / Dabob entrance area
26. Hood Canal — Union / Great Bend

Port Townsend / Admiralty / Hood Canal entrance:

27. Port Townsend
28. Port Ludlow
29. Port Hadlock / Port Townsend Bay south end
30. Mystery Bay / Marrowstone Island
31. Fort Flagler / Kilisut Harbor area
32. Hadlock / Oak Bay / Mats Mats Bay cluster

North Sound / San Juans gateway:

33. Oak Harbor / Saratoga Passage
34. La Conner / Swinomish Channel
35. Anacortes / Cap Sante / Guemes Channel

## Primary vs. secondary stations (NOAA model)

NOAA has the same primary/secondary distinction the CHS PDFs use, just with different labels. Each metadata-API record has a `type` field:

| NOAA `type` | Class | Canadian equivalent | Prediction method |
|---|---|---|---|
| `R` (tides) / `H` (currents) | **Reference / Harmonic** — *primary* | Primary | Computed from harmonic constituents measured at that station. Fully self-contained predictions. |
| `S` | **Subordinate** — *secondary* | Secondary | Computed by applying time/height (or time/speed) offsets to a reference station. Has a `reference_id` field pointing at the primary. |
| `W` (currents only) | **Weak & Variable** | (no equivalent) | Predictions are narrative/descriptive only (e.g. "weak and variable"); no numeric harmonic or offset method. NOAA-specific class with no CHS analogue. |

(Why two letters for primaries: NOAA labels tides primaries `R` for *Reference* and currents primaries `H` for *Harmonic*. Same concept, different historical names.)

For tides, subordinate stations carry a `reference_id` (the 7-digit ID of their primary). For current subordinate stations, the offsets are exposed via a separate endpoint (`/stations/<id>/currentpredictionoffsets.json`) — not as a top-level field.

### What we captured for our picks

In our population (WA-region):

| Source | Total | Primary | Subordinate | Weak/var |
|---|---|---|---|---|
| All WA tide stations | 162 | 56 (R) | 106 (S) | — |
| All PNW current stations | 461 rows / 212 unique IDs | 379 (H) | 61 (S) | 21 (W) |
| Our tide picks (36 entries) | — | 7 (R) | 29 (S) | — |
| Our current picks (26 entries, 25 stations) | — | 25 (H) | 0 (S) | 0 (W) |

Our 7 primary tide stations: Seattle, Everett, Bremerton, Tacoma Commencement Bay, Hood Canal–Union, Port Townsend, Foulweather Bluff. All other tide picks are subordinates referencing one of these (Seattle is the dominant reference for everything in Puget Sound proper, ~26 of our subordinate picks).

All of our current picks are primary (H) stations — the big Puget Sound chokepoints are all well-instrumented with harmonic constituents. Subordinate (S) and Weak/Variable (W) current stations exist in the dataset but cluster around the Columbia River, outer coast, and Strait of Juan de Fuca rather than the spots on our list.

The `type` field is now stored on each entry in [`us_data/stations_currents.json`](../us_data/stations_currents.json) and [`us_data/stations_tides.json`](../us_data/stations_tides.json); subordinate tide picks also carry their `reference_id`.

## NOAA station IDs

Resolved against the NOAA CO-OPS metadata API on 2026-05-01:

- All WA tide prediction stations: [`us_data/2026_noaa_tidepredictions_wa.json`](../us_data/2026_noaa_tidepredictions_wa.json) (162 stations)
- WA-region current prediction stations: [`us_data/2026_noaa_currentpredictions_wa.json`](../us_data/2026_noaa_currentpredictions_wa.json) (212 unique IDs, multiple bins each)

Final picks (keep canonical here; full structured form including bin/depth/extras in the JSON files):

- Currents: [`us_data/stations_currents.json`](../us_data/stations_currents.json)
- Tides: [`us_data/stations_tides.json`](../us_data/stations_tides.json)

Match scripts (re-runnable): [`us_data/match_currents.py`](../us_data/match_currents.py), [`us_data/match_tides.py`](../us_data/match_tides.py)

### Currents — primary station per placename

| Placename | Station | NOAA name | Bin (depth ft) |
|---|---|---|---|
| Deception Pass | `PUG1701` | Deception Pass (Narrows) | 18 (18 ft) |
| Swinomish Channel / La Conner | — | (no current prediction; use tide station) | — |
| Guemes Channel — W entrance | `PUG1734` | Guemes Channel, West Entrance | 1 (11 ft) |
| Guemes Channel — E entrance | `PUG1735` | Guemes Channel, East Entrance | 1 (9 ft) |
| Rosario Strait (Anacortes-SJI) | `PUG1702` | Rosario Strait | 9 (47 ft) |
| Admiralty Inlet — Bush Point | `PUG1616` | Admiralty Inlet (off Bush Point) | 6 (29 ft) |
| Admiralty Inlet — Point Wilson | `PUG1623` | Point Wilson, 0.6 mi. NE of | 14 (17 ft) |
| Admiralty Inlet — Marrowstone Pt | `PUG1619` | Marrowstone Point, 0.8 mi. NE of | 9 (29 ft) |
| Port Townsend Canal | `PUG1614` | Port Townsend Canal | 1 (5 ft) |
| Possession Sound / Saratoga | `PUG1605` | Possession Sound Entrance | 20 (59 ft) |
| Agate Passage (S end) | `PUG1501` | Agate Passage, south end | 1 (9 ft) |
| Rich Passage — E end | `PUG1513` | Rich Passage, East end | 1 (11 ft) |
| Rich Passage — W end | `PUG1514` | Rich Passage, West end | 1 (12 ft) |
| Colvos Passage | `PUG1518` | Anderson Point, East of, Colvos Passage | 10 (35 ft) |
| Tacoma Narrows | `PUG1527` | The Narrows, 0.3 mi N of Bridge | 1 (23 ft) |
| Hale Passage (E end, Fox I.) | `PUG1529` | Hale Passage, East end | 1 (11 ft) |
| Pitt Passage | `PUG1536` | Pitt Passage, NE of Pitt Island | 1 (7 ft) |
| Balch Passage | `PUG1535` | Balch Passage, NE of Eagle Island | 1 (11 ft) |
| Drayton Passage | `PUG1537` | Drayton Passage | 5 (19 ft) |
| Dana Passage | `PUG1539` | Dana Passage | 1 (16 ft) |
| Pickering Passage | `PUG1547` | Pickering Passage, off Graham Point | 1 (10 ft) |
| Peale Passage | `PUG1541` | Peale Passage, South end | 1 (9 ft) |
| Squaxin Passage | `PUG1543` | Squaxin Passage, N of Hunter Point | 1 (5 ft) |
| Hammersley Inlet (Libby Pt) | `PUG1545` | Libby Point, Hammersley Inlet | 1 (5 ft) |
| Cattle Pass / SJ Channel S | `PUG1703` | San Juan Channel, south entrance | 13 (75 ft) |
| Spieden Channel | `PUG1719` | Spieden Channel, N of Limestone Pt | 7 (47 ft) |

### Tides — primary station per placename

| Placename | Station | NOAA name | Type |
|---|---|---|---|
| Seattle / Elliott Bay | `9447130` | Seattle (Madison St.), Elliott Bay | R |
| Shilshole Bay / Ballard | `9447265` | Meadow Point, Shilshole Bay | S |
| Ballard Locks / Ship Canal | `9447265` | Meadow Point, Shilshole Bay (no station at locks) | S |
| Edmonds | `9447427` | Edmonds | S |
| Everett / Port Gardner | `9447659` | Everett | R |
| Mukilteo / Possession Sound | `9447814` | Glendale, Whidbey Island (no Mukilteo station) | S |
| Kingston / Apple Tree Cove | `9445639` | Kingston, Appletree Cove | S |
| Port Madison | `9445753` | Port Madison | S |
| Eagle Harbor / Bainbridge | `9445882` | Eagle Harbor, Bainbridge Island | S |
| Poulsbo / Liberty Bay | `9445719` | Poulsbo, Liberty Bay | S |
| Bremerton / Sinclair Inlet | `9445958` | Bremerton, Sinclair Inlet, Port Orchard | R |
| Port Orchard | `9445832` | Brownsville, Port Orchard | S |
| Blake Island | `9445993` | Harper, Yukon Harbor (no Blake Island station) | S |
| Gig Harbor | `9446369` | Gig Harbor | S |
| Tacoma / Commencement Bay | `9446484` | Tacoma, Commencement Bay, Sitcum Waterway | R |
| Tacoma Narrows | `9446486` | Tacoma Narrows Bridge | S |
| Quartermaster Hbr / Vashon-Maury | `9446254` | Burton, Quartermaster Hbr (inside) | S |
| Des Moines / Redondo | `9446248` | Des Moines, East Passage | S |
| Olympia / Budd Inlet | `9446969` | Olympia, Budd Inlet | S |
| Shelton / Oakland Bay / Hammersley | `9446628` | Shelton, Oakland Bay | S |
| Jarrell Cove | `9446489` | Walkers Landing, Pickering Passage (no Jarrell Cove station) | S |
| Penrose Point / Lakebay | `9446500` | Home, Von Geldern Cove (no Penrose station) | S |
| McMicken Island / Harstine | `9446583` | McMicken Island, Case Inlet | S |
| Hope Island / Squaxin Island | `9446666` | Arcadia, Totten Inlet (no Hope/Squaxin station) | S |
| Hood Canal — Seabeck / Dabob | `9445303` | Seabeck, Seabeck Bay | S |
| Hood Canal — Union / Great Bend | `9445478` | Union | R |
| Port Townsend | `9444900` | Port Townsend | R |
| Port Ludlow | `9445017` | Port Ludlow | S |
| Port Hadlock / PT Bay south | `9444971` | Mystery Bay, Marrowstone Island (no Hadlock station) | S |
| Mystery Bay / Marrowstone | `9444971` | Mystery Bay, Marrowstone Island | S |
| Fort Flagler / Kilisut Harbor | `9444971` | Mystery Bay (no Flagler station; Mystery Bay is at S end of Kilisut) | S |
| Hadlock / Oak Bay / Mats Mats | `9445016` | Foulweather Bluff (no station in cluster) | R |
| Oak Harbor | `9447952` | Crescent Harbor, N. Whidbey Island (no Oak Harbor station) | S |
| Saratoga Passage | `9447929` | Coupeville, Penn Cove, Whidbey Island | S |
| La Conner / Swinomish | `9448558` | La Conner, Swinomish Channel | S |
| Anacortes / Cap Sante / Guemes | `9448794` | Anacortes, Guemes Channel | S |

## The pipeline

Annual driver: [`us_data/process_us.sh --year YEAR`](../us_data/process_us.sh). Designed to be run around November each year for the upcoming calendar year.

Four stages:

1. **`refresh_station_metadata.py --year YEAR`** — refetches the NOAA mdapi catalogs and writes year-prefixed snapshots: `us_data/<YEAR>_noaa_tidepredictions_wa.json` (state=WA filter) and `us_data/<YEAR>_noaa_currentpredictions_wa.json` (PNW lat/lng box). The year prefix preserves history across annual runs so we can diff NOAA's catalog year-over-year.
2. **`check_stations.py`** — cross-references our committed picks ([`stations_tides.json`](../us_data/stations_tides.json), [`stations_currents.json`](../us_data/stations_currents.json)) against the fresh catalog. Flags name changes (case-insensitive), reference_id changes, type changes (R↔S, H↔S), missing stations, and current-bin disappearance. Logs each station to the terminal with ✓ / ⚠ / ✗ markers, writes a timestamped Markdown report (`anomalies_<UTC>.md`, gitignored), and **exits non-zero on any anomaly**. The driver halts unless `--force` is given.
3. **`fetch_predictions.py --year YEAR`** — calls NOAA datagetter once per station:
    - Tides: `product=predictions, interval=hilo, units=metric, datum=MLLW, time_zone=lst`
    - Currents: `product=currents_predictions, interval=MAX_SLACK, units=english, time_zone=lst, bin=<shallowest>`

   **Times are fetched in Local Standard Time** (no DST). For all our WA stations this is UTC-8 year-round. Output JSONs carry `utc_offset: -8` and `timezone: "PST"`, which matches the 2026 CHS chartbook's offset. The web app converts to user-local at display time the same way it does for CHS data, so a BC user (UTC-7 since 2026-03-08) sees the prediction shifted by 1 hour automatically.

   We chose LST over GMT to align the data window to Jan 1 – Dec 31 in PST. With GMT, the window cuts off mid-afternoon Dec 31 in any North American Pacific local time, dropping the evening's events. LST gives us complete coverage of the local-time year.

   Caches the raw response under `us_data/raw/<year>/tide_<id>.json` or `current_<id>_bin<N>.json`. Skips already-cached files unless `--refresh`. Retries 429/5xx with exponential backoff.
4. **`convert_to_tct.py --year YEAR`** — reads the cached raw NOAA JSONs and emits at the repo root:
    - `<year>_noaa_tidal_primary_stations.json`
    - `<year>_noaa_current_primary_stations.json`

   Same shape as `read_tct.py`'s output (`name`, `timezone`, `utc_offset`, `year`, `days[]` with `readings[]`/`events[]`). Adds two NOAA-specific fields:
    - `noaa_id` (string) — replaces `index_no` (which is int-typed in CHS data; we don't shoehorn).
    - `noaa_bin` (currents only) — the bin used for predictions.
    - `US_secondary` (bool) — **UI hint only; not used in prediction computation.** True for NOAA `S` (subordinate) stations, false for `R`/`H` (reference/harmonic). The web app uses this to hide secondaries when zoomed out.

There is **no** `*_secondary_stations.json` for NOAA. NOAA's API computes full predictions for every station regardless of type, so all NOAA stations live in the `*_primary_stations.json` file with their own `days` array. The CHS primary/secondary file split is a CHS-PDF artifact we don't reproduce; the only equivalent we carry is the `US_secondary` flag for UI zoom filtering.

### Run pattern

```
./us_data/process_us.sh --year 2027            # standard run
./us_data/process_us.sh --year 2027 --force    # proceed past anomalies
./us_data/process_us.sh --year 2027 --refresh  # re-download even if cached
```

A clean 2026 run downloads ~58 calls (33 tide stations + 25 currents), takes ~60 s of API time, and writes ~17 MB of converted output.

### When the anomaly checker fires

Possible outcomes and how to handle:
- **Name change**: NOAA renamed a station. Update `name` (tides) or `primary_name` (currents) in the relevant `stations_*.json` file.
- **Reference change** (tides only): the station's primary reference moved. Update `reference_id` in `stations_tides.json`.
- **Type change**: a station was upgraded (S→R) or downgraded. Update `type`. If it became R, our `US_secondary` flag will flip to false on next run.
- **Missing**: the station is gone. Either pick a substitute and update `id`/`primary` + relevant fields, or drop the entry entirely.
- **Bin missing** (currents only): the bin we recorded is no longer offered. Inspect the raw catalog to find the new shallowest bin and update `shallowest_bin`.

Then re-run; the report should be empty.

## Decisions

- **Data sources**: NOAA CO-OPS metadata API (`mdapi/prod/webapi/stations.json`) for station discovery; CO-OPS datagetter (`api/prod/datagetter`) for predictions.
  - Tides: `product=predictions&datum=MLLW`.
  - Currents: `product=currents_predictions&bin=<n>` — bin chosen per station to be the shallowest available (surface-most relevant for boating).
- **NOAA times stored in PST (UTC-8) — matches 2026 CHS chartbook.** We fetch with `time_zone=lst` (Local Standard Time, no DST observance — for WA this is always UTC-8) and store `utc_offset: -8`. This matches the 2026 CHS chartbook's offset, so both datasets feed the same app the same way. The window also aligns naturally with Jan 1 – Dec 31 in local time, with no GMT-window-cutoff dropping Dec 31 evening events. **When BC's 2027 chartbook ships at UTC-7** (BC went permanent UTC-7 on 2026-03-08), we will need to revisit this: NOAA's API doesn't accept arbitrary offsets, so going to UTC-7 means pulling `gmt` with an extended window and shifting timestamps locally. Cross that bridge when the 2027 CHS data arrives.
- **Geographic scope**: WA state for tide stations (NOAA exposes a `state` field). For currents (no state field), filter to a PNW lat/lng box (45.5–49.0°N, −125.0–−121.5°W) and match by name.
- **Station selection**: One canonical "primary" station per placename, with `additional` IDs in the JSON for places where multiple nearby stations are useful (e.g. Admiralty Inlet has Bush Pt + Pt Wilson + Marrowstone; Rich Passage has both ends).
- **Where no NOAA station exists**: pick the geographically nearest reasonable substitute and tag with a `note` field explaining the substitution. Affects Mukilteo, Blake Island, Jarrell Cove, Penrose Point, Hope Island, Port Hadlock, Fort Flagler, Mats Mats / Oak Bay, Oak Harbor.
- **Swinomish Channel currents**: NOAA has no current prediction station here despite our placename being on the list — kept on the tide list only.

## Semantic differences from CHS data

Field names match the CHS schema but a couple of fields mean subtly different things in the NOAA-derived output:

- **`max_flood_knots` / `max_ebb_knots`** — in CHS data these come from the printed Tidal Current Tables and represent *peak velocities at large tides* (a reference number tied to a specific tidal-range condition, often higher than what shows up on any given day). In our NOAA output they are computed from the year's actual predictions: `max_flood_knots = max(positive Velocity_Major over the year)`, `max_ebb_knots = abs(min(negative Velocity_Major over the year))`. Same units (knots), similar magnitude, **different definition** — the NOAA value is "highest predicted event in this calendar year", not "peak at large tides." Acceptable for the app's display purposes, but worth knowing if a future cross-Canada/US comparison ever depends on this field.
- **`weak_variable`** — set to `false` for every NOAA event. The CHS field is true for events the PDF marked with `*` (weak/variable max). NOAA's `H`/`S` stations don't expose this at the event level; only the `W` station class is "weak and variable" by design, and we have none of those in our picks.
- **`utc_offset` / `timezone`** — `0` / `"UTC"` for NOAA (see decisions above); CHS data uses the published chartbook offset.

## Open questions

- Continuous time-series predictions, or just slack/max events like the Canadian secondary-currents pipeline?
- Same output JSON schema as the CHS pipeline (so the web app can consume both with one renderer), or NOAA-shaped and merged later? If we mirror the CHS shape, NOAA `R`/`H` map to "primary" and `S` to "secondary"; we'd need to decide whether to drop `W` stations or carry them as a third class.
- Should we also pull observed-water-level (`product=water_level`) for tide stations that have it, in addition to predictions?
- Bin selection: shallowest is what we picked, but several stations only have bins at 30+ ft depth. Acceptable for surface relative timing, but worth confirming the assumption holds for surface flows.
