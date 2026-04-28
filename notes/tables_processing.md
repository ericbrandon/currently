# Refining station coordinates after parsing

## What this document covers

The Canadian Tide & Current Tables PDFs publish each station's position only as **integer degrees + integer minutes** — no seconds, no fractional minutes. At BC latitudes (~48–55° N) one minute is roughly 1.85 km of latitude × 1.1–1.4 km of longitude, so any station's "true" position can sit anywhere inside a ~1 km box around what the PDF lists.

For a webapp that pins a marker on a map, this is enough error to put many coastal stations on land. (The original symptom: VICTORIA HARBOUR rendered ~800 m inland near Beacon Hill Park, OAK BAY rendered on the Oak Bay peninsula instead of in the bay.)

This document describes the build-time step that improves those positions. It runs *after* `read_tct.py` parses the PDFs and *before* `build_manifest.py` ships the JSONs into `web/public/data/`.

## Data sources

Three sources, in precedence order (highest first):

1. **`coord_overrides.json`** at the repo root — a small hand-curated map of `index_no → [longitude, latitude]`. Used when the inventory CSV is missing a station, or when both the CSV and the PDF clearly disagree with reality.

2. **CHS station inventory CSV** at the repo root, default filename `tide and water level station.csv`. Downloaded from the Government of Canada open-data portal:

   > **"Tides and Water Levels — Canadian Tide and Water Level Station Inventory"**
   > https://open.canada.ca/data/en/dataset/87b08750-4180-4d31-9414-a9470eba9b42/resource/f7f11a47-718c-4eff-a716-d68448914b40

   The CSV lists ~1,750 stations across Canada, keyed by the same `STATION_NUMBER` that the PDF tables use as `index_no`. Roughly two-thirds of Pacific-region stations are published with **3 or more decimal places** (≤110 m horizontal precision); some are publised at 4–6 decimals (≤10 m). It is **not** a strict superset of the PDF: about a tenth of the stations we get from the PDF are absent from the CSV (notably VICTORIA HARBOUR, index 7120). The CSV also covers tide/water-level stations only — current stations are not in it.

3. **The PDF coord** itself — used as a fallback whenever the higher-precedence sources don't apply.

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

Typical output (2026 data, with the curated overrides committed):

```
Loaded 1750 CSV stations, 11 manual overrides
  tidal_primary     :   23 stations |   2 via overrides |  11 via CSV |  10 kept from PDF
  tidal_secondary   :  268 stations |   8 via overrides | 185 via CSV |  75 kept from PDF
  current_primary   :   22 stations |   0 via overrides |   0 via CSV |  22 kept from PDF
  current_secondary :   39 stations |   0 via overrides |   0 via CSV |  39 kept from PDF

Total: 352 stations | 10 overridden | 196 refined from CSV | 146 unchanged
```

`196 refined from CSV` is the headline — about two-thirds of tide stations got better coordinates. The 10 overrides cover the cases where the CSV was missing or wrong (see the next section). Current stations all came through unchanged because the CSV doesn't cover them; if/when CHS publishes a current-station inventory in similar form, this same script can be pointed at it.

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

### Current overrides (2026)

Ten stations needed manual intervention after the initial CSV refinement pass; all looked up against tides.gc.ca:

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

## Resolving flagged stations (annual runbook)

When a fresh year's PDF is processed, `apply_coord_overrides.py` will print a list of stations it couldn't resolve confidently — CSV and PDF disagree but the script can't tell which side is right. This section is the runbook for closing them out.

The 2026 pass produced 9 flagged stations on the first run plus 1 more once the gross-disagreement threshold was added. Same loop should work for future-year flags.

### Step-by-step

1. **Run the pipeline** (`./process_tct.sh`) and note the flagged list. Each row has `index`, `name`, `Δ km`, and `csv-dec` (CSV's decimal-place count). Larger Δ usually means PDF-side typo; subtler ones (~2–3 km) can be either side, so always verify.

2. **Look up each flagged station in parallel** — fetch its detail page from CHS:

   ```
   https://tides.gc.ca/en/stations/<id>
   ```

   where `<id>` is the `index_no` zero-padded to 5 digits (e.g. `7480` → `07480`). The "Station Information" section on each page lists `Location: <lat>, <lon>` to 3+ decimals. Fan out all flagged stations in a single batch — these pages are independent and parallel WebFetches are an order of magnitude faster than serial.

3. **Decide per station** by comparing PDF, CSV, and CHS-official:

   | Situation | What to add to `coord_overrides.json` |
   |---|---|
   | PDF matches CHS-official | `null` (confirms the PDF; the CSV row is the wrong one) |
   | CSV matches CHS-official | `[lon, lat]` using the CSV value (or CHS — they agree) |
   | Neither matches CHS-official | `[lon, lat]` using the CHS-official value |

   Coordinates go in **`[longitude, latitude]`** order (GeoJSON convention) — easy to flip and break. Longitudes in BC are negative.

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

- **Current stations are not refined.** The CSV doesn't list them, so they retain their integer-minute PDF coords. Until CHS publishes a current-station inventory, current markers can land up to ~1 km from their true position. Add manual overrides for any noticeably misplaced ones.
- **The CSV is occasionally wrong.** It's a separate dataset maintained on a different cadence than the printed tables. The 2 km offset ceiling catches gross disagreements; subtler errors can slip through. The script's flagged list at the end of each run is the right place to look first when investigating.
- **Some CSV rows have lower precision than ours.** Pacific stations span 0–6 decimal places. The 3-decimal floor stops us from regressing.
- **CSV file path is awkward.** As downloaded, the file is `tide and water level station.csv` (with spaces). The script defaults to that name; rename or pass `--csv` if you have your own copy elsewhere. Whether to commit the file to git is a separate call — it's small (~1.2 MB) and reproducibility argues for committing, but it's also redownloadable from the open-data URL above.
- **No automation around CSV freshness.** If CHS updates the inventory, you have to re-download manually. The script doesn't fetch.
