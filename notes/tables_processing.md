# Refining station coordinates after parsing

## What this document covers

The Canadian Tide & Current Tables PDFs publish each station's position only as **integer degrees + integer minutes** — no seconds, no fractional minutes. At BC latitudes (~48–55° N) one minute is roughly 1.85 km of latitude × 1.1–1.4 km of longitude, so any station's "true" position can sit anywhere inside a ~1 km box around what the PDF lists.

For a webapp that pins a marker on a map, this is enough error to put many coastal stations on land. (The original symptom: VICTORIA HARBOUR rendered ~800 m inland near Beacon Hill Park, OAK BAY rendered on the Oak Bay peninsula instead of in the bay.)

This document describes the build-time step that improves those positions. It runs *after* `read_tct.py` parses the PDFs and *before* `build_manifest.py` ships the JSONs into `web/public/data/`.

## Data sources

Three sources, in precedence order (highest first):

1. **`coord_overrides.json`** at the repo root — the persistent override file. Holds three kinds of entries:
   - **Manual** entries, hand-curated from `https://tides.gc.ca/en/stations/<id>` for stations that no automated source covers (e.g. VICTORIA HARBOUR is missing from the CSV) or where the automated source is wrong.
   - **IWLS-seeded** entries, produced in bulk by `seed_iwls_overrides.py` (see below) from the CHS IWLS API. These are not edited by hand; the seeder rewrites them on demand.
   - **Geonames-seeded** entries, produced in bulk by `seed_geonames_overrides.py` (see below) from the Canadian Geographical Names Database. The backstop for stations missing from both CSV and IWLS — predominantly secondary current stations and a chunk of secondary tide stations whose names match named features (bays, channels, points) at sub-km precision.

2. **CHS station inventory CSV** at the repo root, default filename `tide and water level station.csv`. Downloaded from the Government of Canada open-data portal:

   > **"Tides and Water Levels — Canadian Tide and Water Level Station Inventory"**
   > https://open.canada.ca/data/en/dataset/87b08750-4180-4d31-9414-a9470eba9b42/resource/f7f11a47-718c-4eff-a716-d68448914b40

   The CSV lists ~1,750 stations across Canada, keyed by the same `STATION_NUMBER` that the PDF tables use as `index_no`. Roughly two-thirds of Pacific-region stations are published with **3 or more decimal places** (≤110 m horizontal precision); some are publised at 4–6 decimals (≤10 m). It is **not** a strict superset of the PDF: about a tenth of the stations we get from the PDF are absent from the CSV (notably VICTORIA HARBOUR, index 7120). The CSV also covers tide/water-level stations only — current stations are not in it.

   Now that IWLS-seeded overrides cover most of what the CSV covered (and at higher precision), the CSV is mostly a fallback for the handful of stations IWLS doesn't list.

3. **The PDF coord** itself — used as a fallback whenever the higher-precedence sources don't apply.

### One-shot IWLS seeder

The CHS IWLS REST API at `https://api-iwls.dfo-mpo.gc.ca/api/v1/stations` returns ~1,570 stations across Canada in a single JSON call, keyed by the same 5-digit station code, with 6-decimal-place coordinates. Crucially, **it includes current stations** (about 23 of the ~61 BC current stations — predominantly the primaries; secondaries that don't have their own measurement programs are not present). The CSV does not.

`seed_iwls_overrides.py` (one-shot helper, *not* part of `process_tct.sh`) fetches the API once, walks the parser-output JSONs, and appends entries to `coord_overrides.json` for every station whose IWLS coord differs from the PDF coord by more than 100 m. It never overwrites existing manual entries.

When to run it:
- **Now** (already done for 2026 — added 88 entries on first run).
- **After processing a future year's PDF** when there might be new stations CHS has added to the catalog. Re-running is safe — entries that already exist are left alone, only genuinely new ones get appended.

It is *not* run on every build. Coord_overrides.json is the persistent committed artifact; the IWLS API is just the upstream source for one of its blocks.

```
seed_iwls_overrides.py --year YEAR
    [--source DIR]            # parser-output JSONs (default: cwd)
    [--overrides PATH]        # default: ./coord_overrides.json
```

### One-shot geonames seeder

The Canadian Geographical Names Database (CGNDB), exposed as a public GeoJSON API at `https://geogratis.gc.ca/services/geoname/en/geonames.geojson?q=NAME&province=59`, is the **backstop for stations that aren't in CSV or IWLS** — predominantly the ~38 secondary current stations (which have no measurement program of their own and therefore no entry in any CHS station database) plus a long tail of secondary tide stations whose CSV row is at 0–2 decimal precision.

CGNDB returns named geographic features (bays, channels, points, populated places) with either a published representative point at ~6 decimals or an outline polygon. Station names like SANSUM NARROWS, OKISOLLO CHANNEL, MALIBU RAPIDS, OAK BAY almost all have a feature of the same name; the rep-point or polygon centroid is generally within 1–3 km of the actual gauge.

`seed_geonames_overrides.py` (one-shot helper, *not* part of `process_tct.sh`) walks the parser-output JSONs and queries the API once per unrefined station. For each station it picks the closest BC feature whose representative point is within an offset threshold of the PDF coord — 10 km for published rep-points (Point/MultiPoint), 5 km for polygon-derived centroids (long features like channels can have unhelpful centroids; the tighter bound rejects those rather than seeding a worse coord than the PDF). It never overwrites manual or IWLS-seeded entries.

When to run it: same cadence as the IWLS seeder. Once now, again after a new PDF year is processed.

```
seed_geonames_overrides.py --year YEAR
    [--source DIR]            # parser-output JSONs (default: cwd)
    [--overrides PATH]        # default: ./coord_overrides.json
    [--dry-run]               # print proposed entries without writing
    [--sleep SECONDS]         # API call spacing (default: 0.15)
```

The seeder prints proposed entries with the matched CGNDB feature name, concise code, geometry type, and offset, then a list of stations it couldn't resolve confidently. Stations rejected fall into three buckets:

- **Out-of-threshold**: the closest CGNDB feature is too far from the PDF — usually a name collision elsewhere in the province (CRESCENT BAY, BLAINE), or a feature whose polygon centroid happens to drift too far (TRINCOMALI CHANNEL, SUNDERLAND CHANNEL — both long passages where the centroid is mid-channel and the gauge is at one end).
- **Linear-only geometry**: the feature is a river or creek represented by a LineString. CHS gauges aren't usefully placed at a centroid of a coastline segment, so we skip and let manual review handle them.
- **No CGNDB hit at all**: typically US stations included for cross-border tidal context (BELLINGHAM, FRIDAY HARBOR, NEAH BAY), or compound names that don't appear verbatim in CGNDB. These need to be hand-curated from a different source.

Feature-type filter: the seeder hard-rejects any candidate whose `concise` code isn't a water feature (allows only `CHAN`, `BAY`, `RAP`, `SEAF`, `MAR`). Capes, islands, towns, settlements, parks, military ranges, and Indian-reserve polygons frequently share names with gauge stations, but their centroids put the marker on land — visibly wrong on a map. We'd rather keep the rounded PDF coord than seed an actively-wrong land coord.

This applies to both tide and current stations. For currents the rationale is obvious — the gauge is in the moving water. For tides, the gauge does sit at the shore, so a CAPE/TOWN/UNP match is *technically* close to the right spot, but the rendered marker still lands on the cape/island itself and looks wrong. Stations whose only CGNDB match is land-class (CLOVER POINT, SIDNEY, OAK BAY's neighbour CARDALE POINT, BONILLA ISLAND, etc.) keep their integer-arcminute PDF coord rather than getting an over-precise but wrong-place override.

## The script: `apply_coord_overrides.py`

CLI:

```
apply_coord_overrides.py --year YEAR
    [--source DIR]            # where to find the parser-output JSONs (default: cwd)
    [--csv PATH]              # CHS inventory CSV (default: ./tide and water level station.csv)
    [--overrides PATH]        # manual overrides (default: ./coord_overrides.json)
```

For each station in each of the four `{year}_tct_*_stations.json` files, the script picks new coordinates by walking the precedence list:

1. **Manual override present?** Use it (or, if the override value is `null`, keep the PDF coord and suppress any CSV-disagreement warning — see "Override file format" below).
2. **CSV has this station, with ≥ 3 decimal places on both lat and lon, and the CSV coord is within 2 km of the PDF coord?** Use it.
3. Otherwise, keep the PDF coord. Possibly flag for human review (see thresholds below).

### Trust thresholds

- **Precision floor: 3 decimal places (~110 m).** A CSV value with 0–2 decimals is too coarse to *replace* the PDF coord — at 2 decimals (~1 km) it's the same order of magnitude as the PDF's integer-minute precision, so swapping in a CSV value of unknown bias would be a wash at best.
- **CSV-trust offset ceiling: 2 km.** When CSV is precise enough to trust, but disagrees with PDF by more than 2 km, one source is clearly wrong. The script declines to pick a winner and instead flags the station for human review.

### Disagreement flagging

The script flags a station for human follow-up when *either*:

- CSV is precise (≥ 3 decimals) and disagrees with PDF by > 2 km, **or**
- CSV (at any precision) disagrees with PDF by > 5 km.

The second condition catches PDF typos that the first would miss. SHOAL BAY (index 8145) was the motivating case: the CSV had it at 50.46° N to 2 decimals (so the precision floor rejected it as an unreliable replacement), the PDF had it at 50.13° N — and the *real* gauge is at 50.46° N (per tides.gc.ca). The high-precision threshold alone never noticed; the gross-disagreement threshold does. BOAT HARBOUR (index 7480) is the same pattern.

The script writes each JSON back in place using the same `json.dumps(..., indent=2)` style as the parser, so a re-run with no input changes produces a no-op diff. It prints a per-file summary and a single sorted list of flagged stations.

Typical output (2026 data, with both seeders run and the manual overrides committed):

```
Loaded 1750 CSV stations, 153 manual overrides
  tidal_primary     :   23 stations |  17 via overrides |   6 via CSV |   0 kept from PDF
  tidal_secondary   :  268 stations | 192 via overrides |  62 via CSV |  14 kept from PDF
  current_primary   :   22 stations |  22 via overrides |   0 via CSV |   0 kept from PDF
  current_secondary :   39 stations |  28 via overrides |   0 via CSV |  11 kept from PDF

Total: 352 stations | 259 overridden | 68 refined from CSV | 25 unchanged
```

The headline shifts: **all 23 primary tide stations and all 22 primary current stations are refined**, and 25 of 352 stations are left on raw PDF coords. Most are US stations included for cross-border tidal context (BELLINGHAM, FRIDAY HARBOR, etc.) plus a handful of BC stations named after a cape, island, or settlement where no water-class CGNDB feature exists at the same name (BEAR POINT, CAMP POINT, PULTENEY POINT, MASTERMAN ISLANDS, BROWNING ISLANDS for currents; CARDALE POINT, GEORGINA POINT, JESSIE POINT, etc. for tides), and a few whose CGNDB feature is a river represented by a LineString.

Note that the override count is much lower than in earlier passes because the water-only filter now rejects land-class CGNDB matches universally. ~74 tide stations that were previously geonames-seeded to a CAPE / TOWN / UNP / ISL / BCH coord now either fall through to CSV refinement (≥3 decimal precision, ~63 of them) or to raw PDF coords if CSV is also missing or low-precision.

## The overrides file format

`coord_overrides.json` is a flat object keyed by stringified `index_no`. Each value is one of two things:

- **`[longitude, latitude]`** in WGS84 (GeoJSON-style, lon first) — replace the parsed coord with this.
- **`null`** — "I have verified the PDF coord is correct as-is; please stop flagging this station as a CSV/PDF disagreement on every run." Used when the CSV row is the wrong one (e.g. NAMU, where the CSV transcribed 51.53° N for what is actually a 51.86° N station).

Keys whose name starts with `_` are treated as comments and ignored, so the file can carry inline notes (per-block headers, source URLs, etc.).

When you find a station that's still rendering in the wrong place after this step, or one that the script flagged at the bottom of its run:

1. Look it up by `STATION_NUMBER` on https://tides.gc.ca/en/stations/&lt;5-digit zero-padded id&gt; (the official per-station detail page lists lat/lon to 3+ decimals for almost every station).
2. Add an entry keyed by its `index_no`. Use `[lon, lat]`, not `[lat, lon]`.
3. If you've verified the PDF was right and the CSV is the wrong one, use `null` instead of a coord — that suppresses the warning without changing the data.
4. Re-run `./process_tct.sh`. The build will pick up the new coord, write a fresh hashed JSON into `web/public/data/{year}/`, and the manifest will get a new ETag/content hash so the browser fetches the update on next page load.

### Manual overrides (2026)

Ten stations were curated by hand from `tides.gc.ca/en/stations/<id>` after the initial CSV refinement pass flagged them; they live in the top blocks of `coord_overrides.json` and are independent of the IWLS seeder:

| Index | Station | Reason |
|---|---|---|
| 7120 | VICTORIA HARBOUR | Missing from the CSV entirely. |
| 7480 | BOAT HARBOUR | PDF rounded coord was ~10 km north of the gauge. CSV correct (only 2 decimals, so the precision floor wouldn't auto-trust it). |
| 7579 | CRESCENT BEACH | PDF off by ~3.7 km. CSV correct. |
| 8025 | REDONDA BAY | PDF off; CSV also slightly off. Used CHS official. |
| 8069 | WADDINGTON HARBOUR | PDF off by ~2.9 km. CSV correct. |
| 8145 | SHOAL BAY | PDF off by ~36 km. CSV correct (only 2 decimals). |
| 8870 | NAMU | `null` — PDF correct, CSV row is wrong. |
| 9312 | LAWYER ISLANDS | PDF off by ~3.1 km. CSV correct. |
| 9512 | GORDON ISLANDS | PDF off; CSV also slightly off. Used CHS official. |
| 9570 | HUNGER HARBOUR | PDF off by ~2.0 km. CSV correct. |
| 9775 | PACOFI BAY | PDF off by ~2.0 km. CSV correct. |

The remaining entries in `coord_overrides.json` come from the two seeders and are not hand-curated:
- **`_block_iwls_seeded`** (~88 entries): primary tide and primary current stations, sourced from the IWLS API.
- **`_block_geonames_seeded`** (~140 entries): a mix of secondary tide and secondary current stations whose name matches a water-class CGNDB feature (BAY, CHAN, RAP, SEAF, MAR). Stations whose CGNDB match is land-class only (CAPE, ISL, TOWN, UNP, etc.) don't get seeded — they fall through to CSV refinement or PDF coord.

## Resolving flagged stations (annual runbook)

When a fresh year's PDF is processed, `apply_coord_overrides.py` will print a list of stations it couldn't resolve confidently — CSV and PDF disagree but the script can't tell which side is right. This section is the runbook for closing them out.

The 2026 pass produced 9 flagged stations on the first run plus 1 more once the gross-disagreement threshold was added. Same loop should work for future-year flags.

### Step-by-step

0. **Refresh the upstream data sources for the new year.**

   a. **Re-download the inventory CSV** if it might have been updated since the last year was processed. Replace the file at the repo root (default name: `tide and water level station.csv`). Source:

      > **"Tides and Water Levels — Canadian Tide and Water Level Station Inventory"**
      > https://open.canada.ca/data/en/dataset/87b08750-4180-4d31-9414-a9470eba9b42/resource/f7f11a47-718c-4eff-a716-d68448914b40

      The CHS does refresh this dataset periodically (the `Modified` field on the dataset page tells you when). A stale CSV won't cause errors — it'll just miss any newly-added stations.

   b. **Re-run both seeders.** Run `read_tct.py` (or the full pipeline once with the new `--year`) so the parser-output JSONs exist for the seeders to scan, then:

      ```
      venv/bin/python seed_iwls_overrides.py --year YEAR
      venv/bin/python seed_geonames_overrides.py --year YEAR
      ```

      Both catch any new stations that appeared in their upstream sources. Existing entries in `coord_overrides.json` are preserved; only genuinely new ones get appended. "Nothing to write" means no new entries — exits cleanly. To **force** a seeder to refresh an existing entry (e.g. CHS has corrected a station's coords), delete that entry from `coord_overrides.json` first, then re-run the seeder. To force a wholesale re-evaluation (e.g. you've changed the seeder's filter rules), delete the entire `_block_geonames_seeded` block and re-run.

      Run order doesn't matter (the IWLS seeder and the geonames seeder cover largely disjoint station sets — primaries vs. secondaries — and either way each respects pre-existing entries from the other). The geonames seeder is slower (~3 min for ~350 stations because every station needs an HTTPS round-trip to geogratis); the IWLS seeder is sub-second (one API call total).

      **Important — re-seed correctly.** Both seeders read each station's coord from the parser-output JSONs in the working directory. After `apply_coord_overrides.py` runs, those JSONs hold *post-override* coords, not the raw PDF integer-arcminute coords. If you want the seeder to evaluate a station against its PDF baseline, run `read_tct.py` (or the full `process_tct.sh` pipeline) to regenerate the parser JSONs from the PDF *before* re-running the seeder. Otherwise the seeder will see e.g. an IWLS-refined coord for a primary station and may classify a CGNDB feature as "close" (within 100m of the already-refined coord) and skip it. The cleanest pattern: `read_tct.py → seeders → apply_coord_overrides.py → build_manifest.py`, which is exactly what `process_tct.sh` does (minus the seeders, which sit between read_tct and apply when you choose to invoke them).

1. **Run the pipeline for the new year:**

   ```
   ./process_tct.sh --year YEAR
   ```

   Note the flagged list at the end. Each row has `index`, `name`, `Δ km`, and `csv-dec` (CSV's decimal-place count). Sample format:

   ```
   1 station(s) flagged for review — CSV and PDF disagree enough that one of them is likely wrong. ...
     kind               index  name                              Δ km  csv-dec
     tidal_secondary     7480  BOAT HARBOUR                      10.0        2
   ```

   Larger Δ usually means PDF-side typo; subtler ones (~2–3 km) can be either side, so always verify.

2. **Look up each flagged station in parallel** — fetch its detail page from CHS:

   ```
   https://tides.gc.ca/en/stations/<id>
   ```

   where `<id>` is the `index_no` zero-padded to 5 digits (e.g. `7480` → `07480`). The "Station Information" section on each page lists `Location: <lat>, <lon>` to 3+ decimals. Fan out all flagged stations in a single batch — these pages are independent and parallel WebFetches are an order of magnitude faster than serial.

   **404 fallback for secondary current stations.** Most secondary current stations (and a few secondary tide stations) are prediction-only — they don't have their own measurement program — and so don't have a tides.gc.ca detail page or an IWLS API entry. If you get a 404 for a flagged station, fall back to:

   - A marine chart of the area (CHS chart catalog, or just an OpenSeaMap / Navionics view).
   - BC Geographic Names if the station's `name` matches a named feature.
   - The reference primary's coords plus a manual eyeball — secondaries are usually ≤ 1 km from their reference station.

   In the worst case, if visual inspection in the app shows the marker landing in roughly the right water, leaving it on the PDF coord (or marking it `null`) is acceptable.

3. **Decide per station** by comparing PDF, CSV, and CHS-official:

   | Situation | What to add to `coord_overrides.json` |
   |---|---|
   | PDF matches CHS-official | `null` (confirms the PDF; the CSV row is the wrong one) |
   | CSV matches CHS-official | `[lon, lat]` using the CSV value (or CHS — they agree) |
   | Neither matches CHS-official | `[lon, lat]` using the CHS-official value |

   Coordinates go in **`[longitude, latitude]`** order (GeoJSON convention) — easy to flip and break. Longitudes in BC are negative.

   **Where to put the entry.** New manual entries belong in the top portion of `coord_overrides.json`, near the existing manual blocks (under `_block_pdf_wrong_replaced_with_chs_official` or `_block_pdf_correct_csv_wrong`, whichever fits). Don't interleave them with the IWLS-seeded block at the bottom — that block is regenerated by the seeder and human edits there are easy to lose track of. (Functionally, position doesn't matter; the script treats all entries equally.)

4. **Re-run** `apply_coord_overrides.py --year YEAR` (or the full pipeline). Verify the flagged-stations section is empty. If a new station appears that wasn't in the original list — almost certainly a low-precision-but-grossly-wrong case the gross threshold caught — repeat steps 2–3 for it.

5. **Spot-check the obvious ones in the running app.** Open the map, find each previously-misplaced station (use the station name pill or zoom to its area), and confirm the marker is now in the water where it should be. Victoria Harbour and Oak Bay are good canaries because the user originally surfaced them.

### Practical notes

- **Unflagged stations can still be wrong.** The script only flags stations the CSV row contradicts — a station the CSV is missing entirely (like Victoria Harbour) won't appear in the flagged list. Visual inspection of the map after the pipeline is the only way to catch those. Anything still landing on land, add an override.
- **Don't trust just the CSV.** Several CSV rows that look precise (3+ decimals) turn out to be wrong by 2–4 km — REDONDA BAY and GORDON ISLANDS in 2026 — even though they're close enough to the PDF that the script auto-trusted them. The flagged list catches outliers; small-but-real errors slip through. If a CSV-trusted station looks wrong in the app, look it up on tides.gc.ca and add an override.
- **The `null` semantics matter.** If you only correct PDF-wrong cases and leave PDF-correct-CSV-wrong cases unaddressed, the script will keep flagging the same handful of stations on every future run, drowning out genuinely new flags. Use `null` for confirmed-PDF cases so the noise floor stays at zero.
- **Override entries persist across years.** Stations don't move (the user's words), so once a 2026 override is correct, it stays correct for 2027, 2028, etc. The annual loop should be additive: investigate only the *new* flagged stations each year.
- **Sanity-check the parser before chasing flags.** A surge of newly-flagged stations in a future year is more likely to indicate a parser-side regex regression than a sudden onslaught of CHS typos. Before opening 20 WebFetches, eyeball a few raw `latitude`/`longitude` values in the new JSONs and confirm the integer-minute structure looks the same as last year (e.g. all values are exact `n + m/60` for integer n, m).

## Pipeline integration

The script sits between PDF parsing and manifest generation in `process_tct.sh`:

```
1. read_tct.py              → emits {year}_tct_*_stations.json at repo root
2. apply_coord_overrides.py → rewrites the same files in place with refined coords
3. build_manifest.py        → copies the files into web/public/data/{year}/ with
                              content-hashed filenames; rebuilds manifest.json
```

This placement is deliberate:

- The refinement is a *correction* to parser output, not a separate data product. Putting it inline keeps every downstream consumer (the webapp loader, future scripts, ad-hoc analyses) on the same corrected data.
- `build_manifest.py` already content-hashes the JSONs, so a coord change automatically produces a new filename and the existing cache-invalidation story (long-lived immutable cache on hashed files, no-cache on `manifest.json`) keeps working unchanged.
- The webapp loader (`web/src/data/loader.ts`) and the MapLibre layer (`web/src/map/stationLayer.ts`) need no changes.

## Limitations and known gotchas

- **A handful of stations remain unrefined.** As of 2026, 25 of 352 stations fall through every source. Most are US stations included for cross-border context (BELLINGHAM, FRIDAY HARBOR, NEAH BAY, etc.) which BC-only sources don't cover. The rest are BC stations whose name doesn't match a usable water-class CGNDB feature — compound names like SAMUEL I. NORTH SHORE, river-based names whose CGNDB entry is a LineString (DAVIS RIVER, KWINITSA RIVER), BOUNDARY PASSAGE which straddles the international boundary, current stations named after a cape/island (BEAR POINT, CAMP POINT, PULTENEY POINT, MASTERMAN ISLANDS, BROWNING ISLANDS), or tide stations named after a CAPE / TOWN / ISL whose only CGNDB match is land-class. Add manual overrides from a marine chart or the relevant national hydrographic service (NOAA for US stations) for any visually-misplaced ones.
- **CGNDB centroids drift on long features.** The geonames seeder takes the polygon centroid for features without a published rep-point, but for long channels (TRINCOMALI, SUNDERLAND) the centroid is mid-channel while the gauge sits at one end — a worse coord than the rounded PDF. The seeder's 5 km polygon-offset threshold rejects these so they stay on PDF coords; if the PDF coord then renders visibly wrong on the map, add a manual override from a marine chart.
- **The CSV is occasionally wrong.** It's a separate dataset maintained on a different cadence than the printed tables. The 2 km offset ceiling catches gross disagreements; subtler errors can slip through. The script's flagged list at the end of each run is the right place to look first when investigating.
- **Some CSV rows have lower precision than ours.** Pacific stations span 0–6 decimal places. The 3-decimal floor stops us from regressing.
- **CSV file path is awkward.** As downloaded, the file is `tide and water level station.csv` (with spaces). The script defaults to that name; rename or pass `--csv` if you have your own copy elsewhere. Whether to commit the file to git is a separate call — it's small (~1.2 MB) and reproducibility argues for committing, but it's also redownloadable from the open-data URL above.
- **No automation around CSV freshness.** If CHS updates the inventory, you have to re-download manually. The script doesn't fetch.
