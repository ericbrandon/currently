# Canadian (CHS) data processing

Notes for everything in `canada_data/` and the `process_canadian.sh` pipeline. Covers the source PDFs, the parser, the helper data files, and the one-shot seeders that feed `coord_overrides.json` (which itself lives at the repo root and is applied by `process_combined.sh` — see [combined_data_processing.md](combined_data_processing.md)).

## What lives in `canada_data/`

- The four CHS source PDFs (TCT vol 5/6/7 for the year, plus the 2016 atlas vol3 reference). Gitignored by the repo-wide `*.pdf` rule.
- `tide and water level station.csv` — the CHS station inventory CSV.
- `read_tct.py` — the PDF parser invoked by `process_canadian.sh`.
- `seed_iwls_overrides.py`, `seed_geonames_overrides.py` — one-shot seeders that append to `../coord_overrides.json`.
- `audit_geonames_centroids.py`, `spot_check.py` — diagnostics, run by hand.
- `process_canadian.sh` — the wrapper script.

## The pipeline

```
./canada_data/process_canadian.sh --year YEAR
```

This runs `canada_data/read_tct.py` to parse the four `{year}_tct_*_stations.json` files and emit them at the repo root. Source-specific; produces nothing else.

The downstream cleanup-and-publish step (`process_combined.sh` at the repo root) is described in [combined_data_processing.md](combined_data_processing.md).

## Why coordinate refinement is needed

The Canadian Tide & Current Tables PDFs publish each station's position only as **integer degrees + integer minutes** — no seconds, no fractional minutes. At BC latitudes (~48–55° N) one minute is roughly 1.85 km of latitude × 1.1–1.4 km of longitude, so any station's "true" position can sit anywhere inside a ~1 km box around what the PDF lists.

For a webapp that pins a marker on a map, this is enough error to put many coastal stations on land. (The original symptom: VICTORIA HARBOUR rendered ~800 m inland near Beacon Hill Park, OAK BAY rendered on the Oak Bay peninsula instead of in the bay.)

The fix is the build-time refinement step in `process_combined.sh`, fed by the `coord_overrides.json` at the repo root. That file is sourced from three Canadian-side providers:

- **Manual** entries hand-curated from `https://tides.gc.ca/en/stations/<id>` for stations that no automated source covers (e.g. VICTORIA HARBOUR is missing from the CSV) or where the automated source is wrong.
- **IWLS-seeded** entries, produced in bulk by `seed_iwls_overrides.py` (see below) from the CHS IWLS API. These are not edited by hand; the seeder rewrites them on demand.
- **Geonames-seeded** entries, produced in bulk by `seed_geonames_overrides.py` (see below) from the Canadian Geographical Names Database. The backstop for stations missing from both CSV and IWLS — predominantly secondary current stations and a chunk of secondary tide stations whose names match named features (bays, channels, points) at sub-km precision.

The runtime apply logic (precedence, thresholds, flagging) lives in [combined_data_processing.md](combined_data_processing.md).

## Suppressing CHS stations covered by NOAA

The CHS chartbook bundles a small number of US tide stations (Neah Bay, Port Angeles, Crescent Bay, Bellingham, Blaine, Friday Harbor) as cross-border secondary computations off BC primaries. When `us_data/stations_tides.json` adds the NOAA harmonic-primary or NOAA-subordinate version of the same gauge, both versions render and the map gets duplicate pins on top of each other.

`coord_overrides.json` carries a `_suppress_index_nos` array of CHS `index_no`s that should be dropped from the parser output entirely. `apply_coord_overrides.py` runs a pre-pass that filters those stations out before the per-station coord-precedence walk runs — they never make it into the published JSON, never reach the loader, and never produce a marker.

Mechanism details (where `_suppress_index_nos` is read, ordering vs. coord overrides, summary output) live in [combined_data_processing.md](combined_data_processing.md#suppressing-stations).

Constraint: only suppress stations that aren't used as a `reference_primary` (currents) or `reference_name` (tides) by another station in the four parser-output JSONs. Suppressing a referenced primary leaves any secondary pointing at it without a reference; the loader logs a console warning and the secondary degrades to "no value" rendering. Grep the parser-output JSONs before adding an entry to confirm nothing depends on the station you're dropping.

Current 2026 entries (all secondary tide stations whose CHS computation is offset off a BC primary, now replaced 1:1 by a NOAA pick in `us_data/stations_tides.json`):

| CHS index | CHS name | NOAA replacement |
|---|---|---|
| 7050 | CRESCENT BAY | 9443826 (subordinate, ref Port Townsend) |
| 7060 | PORT ANGELES | 9444090 (harmonic primary) |
| 7215 | BELLINGHAM | 9449211 (subordinate, ref Port Townsend) |
| 7570 | BLAINE | 9449679 (harmonic primary) |
| 8512 | NEAH BAY | 9443090 (harmonic primary) |

Friday Harbor (CHS index 7240) is **not** suppressed — there's no equivalent NOAA pick yet and removing it would leave the San Juan Channel without a tide marker.

Adding more suppressions later: append the `index_no` to `_suppress_index_nos`, add the corresponding NOAA station to `us_data/stations_tides.json`, then run `./us_data/process_us.sh` and `./process_combined.sh`. The CHS coord override (if any) for the suppressed index can stay or go — the suppression pre-pass runs first, so any leftover override entry is simply unused.

## The PDF parser: `read_tct.py`

`read_tct.py` is what `process_canadian.sh` runs. It scans `canada_data/` for the year's TCT PDFs (filtered by filename containing "tct" and the year, with a `vol(\d)` suffix), parses each volume's table of contents, then extracts:

- Primary tide stations (per-station hi/lo predictions)
- Table 3 secondary tide ports
- Primary current stations (slack/max events per station)
- Table 4 secondary currents

Output: four JSON files at the repo root, one per kind:
- `{year}_tct_tidal_primary_stations.json`
- `{year}_tct_tidal_secondary_stations.json`
- `{year}_tct_current_primary_stations.json`
- `{year}_tct_current_secondary_stations.json`

These have raw integer-arcminute coords. The downstream `apply_coord_overrides.py` step (in `process_combined.sh`) rewrites them in place with refined coords.

CLI:

```
read_tct.py --year YEAR
    [--directory DIR]         # PDF location (default: canada_data/)
    [--out-dir DIR]           # where to write {year}_tct_*_stations.json (default: cwd)
    [-v|--verbose]            # pretty-print all primary tide stations to stdout
```

## CHS source data in `canada_data/`

### CHS station inventory CSV

`canada_data/tide and water level station.csv` — downloaded from the Government of Canada open-data portal:

> **"Tides and Water Levels — Canadian Tide and Water Level Station Inventory"**
> https://open.canada.ca/data/en/dataset/87b08750-4180-4d31-9414-a9470eba9b42/resource/f7f11a47-718c-4eff-a716-d68448914b40

The CSV lists ~1,750 stations across Canada, keyed by the same `STATION_NUMBER` that the PDF tables use as `index_no`. Roughly two-thirds of Pacific-region stations are published with **3 or more decimal places** (≤110 m horizontal precision); some are publised at 4–6 decimals (≤10 m). It is **not** a strict superset of the PDF: about a tenth of the stations we get from the PDF are absent from the CSV (notably VICTORIA HARBOUR, index 7120). The CSV also covers tide/water-level stations only — current stations are not in it.

Now that IWLS-seeded overrides cover most of what the CSV covered (and at higher precision), the CSV is mostly a fallback for the handful of stations IWLS doesn't list.

**File path notes.** As downloaded, the file is `tide and water level station.csv` (with spaces). The override script defaults to `canada_data/tide and water level station.csv`; rename or pass `--csv` if you have your own copy elsewhere. Whether to commit the file to git is a separate call — it's small (~1.2 MB) and reproducibility argues for committing, but it's also redownloadable from the open-data URL above.

**No automation around CSV freshness.** If CHS updates the inventory, you have to re-download manually. The script doesn't fetch.

### Source PDFs

The TCT volumes (`chs-shc-tct-tmc-vol5-2026-...pdf`, `vol6`, `vol7`) plus the 2016 atlas (`chs-shc-atlas-vol3-2016-...pdf`) live in `canada_data/`. They're gitignored by the repo-wide `*.pdf` rule. `read_tct.py` discovers them via filename pattern matching (filename must contain "tct", the year, and `vol(\d)`).

## One-shot IWLS seeder

The CHS IWLS REST API at `https://api-iwls.dfo-mpo.gc.ca/api/v1/stations` returns ~1,570 stations across Canada in a single JSON call, keyed by the same 5-digit station code, with 6-decimal-place coordinates. Crucially, **it includes current stations** (about 23 of the ~61 BC current stations — predominantly the primaries; secondaries that don't have their own measurement programs are not present). The CSV does not.

`canada_data/seed_iwls_overrides.py` (one-shot helper, *not* part of the `process_canadian.sh` / `process_combined.sh` pipeline) fetches the API once, walks the parser-output JSONs, and appends entries to `coord_overrides.json` (at the repo root) for every station whose IWLS coord differs from the PDF coord by more than 100 m. It never overwrites existing manual entries.

When to run it:
- **Now** (already done for 2026 — added 88 entries on first run).
- **After processing a future year's PDF** when there might be new stations CHS has added to the catalog. Re-running is safe — entries that already exist are left alone, only genuinely new ones get appended.

It is *not* run on every build. `coord_overrides.json` is the persistent committed artifact; the IWLS API is just the upstream source for one of its blocks.

```
seed_iwls_overrides.py --year YEAR
    [--source DIR]            # parser-output JSONs (default: cwd)
    [--overrides PATH]        # default: ./coord_overrides.json
```

## One-shot geonames seeder

The Canadian Geographical Names Database (CGNDB), exposed as a public GeoJSON API at `https://geogratis.gc.ca/services/geoname/en/geonames.geojson?q=NAME&province=59`, is the **backstop for stations that aren't in CSV or IWLS** — predominantly the ~38 secondary current stations (which have no measurement program of their own and therefore no entry in any CHS station database) plus a long tail of secondary tide stations whose CSV row is at 0–2 decimal precision.

CGNDB returns named geographic features (bays, channels, points, populated places) with either a published representative point at ~6 decimals or an outline polygon. Station names like SANSUM NARROWS, OKISOLLO CHANNEL, MALIBU RAPIDS, OAK BAY almost all have a feature of the same name; the rep-point or polygon centroid is generally within 1–3 km of the actual gauge.

`canada_data/seed_geonames_overrides.py` (one-shot helper, *not* part of the `process_canadian.sh` / `process_combined.sh` pipeline) walks the parser-output JSONs and queries the API once per unrefined station. For each station it picks the closest BC feature whose representative point is within an offset threshold of the PDF coord — 10 km for published rep-points (Point/MultiPoint), 5 km for polygon-derived centroids (long features like channels can have unhelpful centroids; the tighter bound rejects those rather than seeding a worse coord than the PDF). It never overwrites manual or IWLS-seeded entries.

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

### Re-seed correctly

**Important — re-seed correctly.** Both seeders read each station's coord from the parser-output JSONs in the working directory. After `apply_coord_overrides.py` runs, those JSONs hold *post-override* coords, not the raw PDF integer-arcminute coords. If you want the seeder to evaluate a station against its PDF baseline, run `read_tct.py` (or `./canada_data/process_canadian.sh`) to regenerate the parser JSONs from the PDF *before* re-running the seeder. Otherwise the seeder will see e.g. an IWLS-refined coord for a primary station and may classify a CGNDB feature as "close" (within 100m of the already-refined coord) and skip it. The cleanest pattern: `process_canadian.sh → seeders → process_combined.sh`, with the seeders inserted between the two scripts when you choose to invoke them.

## Annual upstream-source refresh

When a new year's PDF set arrives, refresh the upstream sources before running the combined pipeline. (The combined-side runbook for handling stations that the apply step then flags is in [combined_data_processing.md](combined_data_processing.md#resolving-flagged-stations-annual-runbook).)

a. **Re-download the inventory CSV** if it might have been updated since the last year was processed. Replace the file in `canada_data/` (default name: `tide and water level station.csv`). Source:

   > **"Tides and Water Levels — Canadian Tide and Water Level Station Inventory"**
   > https://open.canada.ca/data/en/dataset/87b08750-4180-4d31-9414-a9470eba9b42/resource/f7f11a47-718c-4eff-a716-d68448914b40

   The CHS does refresh this dataset periodically (the `Modified` field on the dataset page tells you when). A stale CSV won't cause errors — it'll just miss any newly-added stations.

b. **Re-run both seeders.** Run `read_tct.py` (or the full pipeline once with the new `--year`) so the parser-output JSONs exist for the seeders to scan, then:

   ```
   venv/bin/python canada_data/seed_iwls_overrides.py --year YEAR
   venv/bin/python canada_data/seed_geonames_overrides.py --year YEAR
   ```

   Both catch any new stations that appeared in their upstream sources. Existing entries in `coord_overrides.json` are preserved; only genuinely new ones get appended. "Nothing to write" means no new entries — exits cleanly. To **force** a seeder to refresh an existing entry (e.g. CHS has corrected a station's coords), delete that entry from `coord_overrides.json` first, then re-run the seeder. To force a wholesale re-evaluation (e.g. you've changed the seeder's filter rules), delete the entire `_block_geonames_seeded` block and re-run.

   Run order doesn't matter (the IWLS seeder and the geonames seeder cover largely disjoint station sets — primaries vs. secondaries — and either way each respects pre-existing entries from the other). The geonames seeder is slower (~3 min for ~350 stations because every station needs an HTTPS round-trip to geogratis); the IWLS seeder is sub-second (one API call total).

After the seeders, run the full pipeline:

```
./canada_data/process_canadian.sh --year YEAR
./process_combined.sh --year YEAR
```
