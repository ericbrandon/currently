# Refining station coordinates after parsing

## What this document covers

The Canadian Tide & Current Tables PDFs publish each station's position only as **integer degrees + integer minutes** — no seconds, no fractional minutes. At BC latitudes (~48–55° N) one minute is roughly 1.85 km of latitude × 1.1–1.4 km of longitude, so any station's "true" position can sit anywhere inside a ~1 km box around what the PDF lists.

For a webapp that pins a marker on a map, this is enough error to put many coastal stations on land. (The original symptom: VICTORIA HARBOUR rendered ~800 m inland near Beacon Hill Park, OAK BAY rendered on the Oak Bay peninsula instead of in the bay.)

This document describes the build-time step that improves those positions. It runs *after* `read_tct.py` parses the PDFs and *before* `build_manifest.py` ships the JSONs into `web/public/data/`.

## Data sources

Three sources, in precedence order (highest first):

1. **`coord_overrides.json`** at the repo root — the persistent override file. Holds two kinds of entries:
   - **Manual** entries, hand-curated from `https://tides.gc.ca/en/stations/<id>` for stations that no automated source covers (e.g. VICTORIA HARBOUR is missing from the CSV) or where the automated source is wrong.
   - **IWLS-seeded** entries, produced in bulk by `seed_iwls_overrides.py` (see below) from the CHS IWLS API. These are not edited by hand; the seeder rewrites them on demand.

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

Typical output (2026 data, with the IWLS seeder run and the manual overrides committed):

```
Loaded 1750 CSV stations, 99 manual overrides
  tidal_primary     :   23 stations |  13 via overrides |  10 via CSV |   0 kept from PDF
  tidal_secondary   :  268 stations |  63 via overrides | 183 via CSV |  22 kept from PDF
  current_primary   :   22 stations |  21 via overrides |   0 via CSV |   1 kept from PDF
  current_secondary :   39 stations |   1 via overrides |   0 via CSV |  38 kept from PDF

Total: 352 stations | 98 overridden | 193 refined from CSV | 61 unchanged
```

The headline shifts: **all 23 primary tide stations and 21 of 22 primary current stations are now refined**, and the only stations left on raw PDF coords are the ~38 secondary current stations (which lack their own measurement programs and so don't appear in any CHS database).

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

The remaining ~88 entries in `coord_overrides.json` (under the `_block_iwls_seeded` comment) come from the IWLS seeder and are not hand-curated. They cover the bulk of primary tide and primary current stations.

## Resolving flagged stations (annual runbook)

When a fresh year's PDF is processed, `apply_coord_overrides.py` will print a list of stations it couldn't resolve confidently — CSV and PDF disagree but the script can't tell which side is right. This section is the runbook for closing them out.

The 2026 pass produced 9 flagged stations on the first run plus 1 more once the gross-disagreement threshold was added. Same loop should work for future-year flags.

### Step-by-step

0. **Refresh the upstream data sources for the new year.**

   a. **Re-download the inventory CSV** if it might have been updated since the last year was processed. Replace the file at the repo root (default name: `tide and water level station.csv`). Source:

      > **"Tides and Water Levels — Canadian Tide and Water Level Station Inventory"**
      > https://open.canada.ca/data/en/dataset/87b08750-4180-4d31-9414-a9470eba9b42/resource/f7f11a47-718c-4eff-a716-d68448914b40

      The CHS does refresh this dataset periodically (the `Modified` field on the dataset page tells you when). A stale CSV won't cause errors — it'll just miss any newly-added stations.

   b. **Re-run the IWLS seeder.** Run `read_tct.py` (or the full pipeline once with the new `--year`) so the parser-output JSONs exist for the seeder to scan, then:

      ```
      venv/bin/python seed_iwls_overrides.py --year YEAR
      ```

      This catches any new stations CHS has added to its catalog. Existing entries in `coord_overrides.json` are preserved; only genuinely new ones get appended. "Nothing to write" means no new entries — exits cleanly. To **force** the seeder to refresh an existing entry (e.g. CHS has corrected a station's coords), delete that entry from `coord_overrides.json` first, then re-run the seeder.

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

- **Some current stations remain unrefined.** The IWLS API covers all primary current stations and a handful of secondaries, but ~38 of the 39 secondary current stations in BC are *not* in any CHS database (they're prediction-only stations derived from a primary via Table 4 differences, with no measurement program of their own). These keep their integer-minute PDF coords. Add manual overrides from a marine chart for any visually-misplaced ones.
- **The CSV is occasionally wrong.** It's a separate dataset maintained on a different cadence than the printed tables. The 2 km offset ceiling catches gross disagreements; subtler errors can slip through. The script's flagged list at the end of each run is the right place to look first when investigating.
- **Some CSV rows have lower precision than ours.** Pacific stations span 0–6 decimal places. The 3-decimal floor stops us from regressing.
- **CSV file path is awkward.** As downloaded, the file is `tide and water level station.csv` (with spaces). The script defaults to that name; rename or pass `--csv` if you have your own copy elsewhere. Whether to commit the file to git is a separate call — it's small (~1.2 MB) and reproducibility argues for committing, but it's also redownloadable from the open-data URL above.
- **No automation around CSV freshness.** If CHS updates the inventory, you have to re-download manually. The script doesn't fetch.
