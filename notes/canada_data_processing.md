# Canadian (CHS) data processing

Notes for everything in `canada_data/` and the `process_canadian.sh` pipeline. Covers the source PDFs, the parser, the helper data files, and the one-shot seeders that feed `coord_overrides.json` (which itself lives at the repo root and is applied by `process_combined.sh` — see [combined_data_processing.md](combined_data_processing.md)).

## What lives in `canada_data/`

- The four CHS source PDFs (TCT vol 5/6/7 for the year, plus the 2016 atlas vol3 reference). Gitignored by the repo-wide `*.pdf` rule.
- `tide and water level station.csv` — the CHS station inventory CSV.
- `read_tct.py` — the PDF parser invoked by `process_canadian.sh`.
- `seed_iwls_overrides.py` — one-shot seeder that syncs `_block_iwls_seeded` in `../coord_overrides.json` against the IWLS catalog.
- `diagnostics/spot_check.py` — diagnostic, run by hand; not part of the pipeline.
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

The fix is the build-time refinement step in `process_combined.sh`, fed by the `coord_overrides.json` at the repo root. That file is sourced from two Canadian-side providers:

- **Manual** entries hand-curated from `https://tides.gc.ca/en/stations/<id>` for stations that no automated source covers (e.g. VICTORIA HARBOUR is missing from the CSV) or where the automated source is wrong.
- **IWLS-seeded** entries, produced in bulk by `seed_iwls_overrides.py` (see below) from the CHS IWLS API. These are not edited by hand; the seeder rewrites them on demand.

Stations not covered by either source — almost entirely BC current secondaries (offset-based predictions with no physical gauge) — fall through to the PDF integer-arcminute coord at apply time. We previously had a third "geonames-seeded" provider that filled this gap with Canadian Geographical Names Database centroids, but it produced visibly wrong placements for long channels and concave water features (OKISOLLO CHANNEL was the worst case — its polygon centroid landed on land), so the system was removed.

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

The CHS IWLS REST API at `https://api-iwls.dfo-mpo.gc.ca/api/v1/stations` returns ~1,570 stations across Canada in a single JSON call, keyed by the same 5-digit station code. Coordinate precision is mostly 3 decimal places (~100 m), with some entries at 4–6 decimals (~10 m or better). Crucially, **it covers most BC tide stations** — primaries and secondaries — and all BC current *primaries*. Many tide secondaries are tagged `type: TEMPORARY` (prediction-only, no continuous gauge), but their coords are still authoritative. The CSV does not include current stations at all.

What's still missing from IWLS: BC current *secondaries* (~24 in our roster — offset-based predictions referenced from a primary, with no physical gauge of their own). For these we keep the PDF integer-arcminute coord (~1.1 km error at BC latitudes) as the rendered position. A handful have manual overrides where the PDF coord renders visibly off (SANSUM NARROWS, OKISOLLO CHANNEL, BELIZE INLET); add more from a marine chart if you spot a misplacement.

`canada_data/seed_iwls_overrides.py` (one-shot helper, *not* part of the `process_canadian.sh` / `process_combined.sh` pipeline) fetches the API once, walks the parser-output JSONs, and synchronises `_block_iwls_seeded` in `coord_overrides.json` so it exactly mirrors current IWLS data for every parser station IWLS covers. Per parser station the seeder does one of:

- **Add** — new station IWLS now covers, no existing override
- **Refresh** — existing IWLS-block entry whose IWLS coord has changed
- **Remove** — IWLS-block entry for a station no longer in IWLS, or no longer in the parser output (CHS dropped it from the PDF)

Manual / null / us-cross-border entries are never touched — human curation always wins. The IWLS block is rewritten in sorted-by-index order on each run. There is no "ignore changes < N metres" floor — IWLS is treated as authoritative when it has a station, so any difference between PDF and IWLS results in an IWLS-block entry.

When to run it:
- After a new PDF year is processed — picks up any new stations CHS has added to the catalog, refreshes any updated coords, and removes stragglers.
- Idempotent — re-running with no upstream changes prints "Nothing to write."

It is *not* run on every build. `coord_overrides.json` is the persistent committed artifact; the IWLS API is just the upstream source for one of its blocks.

```
seed_iwls_overrides.py --year YEAR
    [--source DIR]            # parser-output JSONs (default: cwd)
    [--overrides PATH]        # default: ./coord_overrides.json
```

## Why we don't have a geonames-centroid fallback any more

For stations IWLS doesn't cover, the obvious fallback is the Canadian Geographical Names Database (CGNDB) — query it for a feature with the same name as the station, take the representative point or polygon centroid. We had this implemented for ~140 stations and it caused more problems than it solved:

- **Long channels** (HARO STRAIT, TRINCOMALI CHANNEL, SUNDERLAND CHANNEL, SIDNEY CHANNEL, SWANSON CHANNEL): the polygon centroid lands mid-channel while the gauge sits at one end — moves of 2–8 km from the PDF coord were typical, with the marker often ending up in the wrong basin.
- **Concave / U-shaped water features** (OKISOLLO CHANNEL, the canonical bad case): the vertex-average centroid lands *outside* the polygon, on land.
- **Long tide-feature names** (KYUQUOT, SMITH INLET, GOOSE ISLAND, ZEBALLOS): seeded coords drifted 6–8 km from the actual gauge.

For any case where a manual override was worth doing, the override was already in place; the geonames layer only ever supplied actively-wrong centroids that the manual-override curator would then have to undo. Removing the layer was a strict improvement — stations IWLS doesn't cover now fall through to the PDF integer-arcminute coord (~1.1 km error at BC latitudes, but at least it's *in* the right body of water) until a manual override goes in.

If a future build needs better positioning for these stations, a per-station chart lookup is the right path, not centroid-of-feature.

### Re-seed correctly

The IWLS seeder reads each station's coord from the parser-output JSONs in the working directory. After `apply_coord_overrides.py` runs, those JSONs hold *post-override* coords, not the raw PDF integer-arcminute coords — running the seeder against post-override coords would skew its offset calculations.

The wrapper script [`canada_data/refresh_seeded_overrides.sh`](../canada_data/refresh_seeded_overrides.sh) does this in the right order: re-parses the PDFs first, then runs the seeder. Use it instead of running the seeder by hand.

## Annual upstream-source refresh

When a new year's PDF set arrives, refresh the upstream sources before running the combined pipeline. (The combined-side runbook for handling stations that the apply step then flags is in [combined_data_processing.md](combined_data_processing.md#resolving-flagged-stations-annual-runbook).)

a. **Re-download the inventory CSV** if it might have been updated since the last year was processed. Replace the file in `canada_data/` (default name: `tide and water level station.csv`). Source:

   > **"Tides and Water Levels — Canadian Tide and Water Level Station Inventory"**
   > https://open.canada.ca/data/en/dataset/87b08750-4180-4d31-9414-a9470eba9b42/resource/f7f11a47-718c-4eff-a716-d68448914b40

   The CHS does refresh this dataset periodically (the `Modified` field on the dataset page tells you when). A stale CSV won't cause errors — it'll just miss any newly-added stations.

b. **Refresh the IWLS-seeded block of `coord_overrides.json`:**

   ```
   ./canada_data/refresh_seeded_overrides.sh --year YEAR
   ```

   This wrapper re-parses the PDFs, then runs the IWLS seeder against the raw PDF coords (in the right order — see "Re-seed correctly" above). Manual / null / us-cross-border entries are untouched; the IWLS block updates against the current upstream catalog (add, refresh, remove).

   Inspect the seeders' output for surprises (large refreshes, removals) before publishing. Either seeder printing "Nothing to write" means no upstream changes for its source.

c. **Apply and publish:**

   ```
   ./process_combined.sh --year YEAR
   ```

   Re-applies the override file to the parser JSONs and republishes into `web/public/data/`.

### Routine edits (not annual)

For everyday changes to `coord_overrides.json` — adding a manual override, suppressing a duplicate station, fixing a typo — the PDFs haven't changed and the seeders don't need to run. Just edit the file and run `./process_combined.sh --year YEAR`.
