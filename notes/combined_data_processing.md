# Combined data processing — apply overrides + publish manifest

Notes for `process_combined.sh` and the at-root scripts it runs (`apply_coord_overrides.py`, `build_manifest.py`). This is the cleanup-and-publish step that consumes the per-feed JSON outputs and produces the artifacts the web app loads.

For the Canadian source data (PDFs, CSV, seeders, parser), see [canada_data_processing.md](canada_data_processing.md).
For the NOAA source data (mdapi catalog, predictions), see [US_data_processing.md](US_data_processing.md).

## What this step does

The Canadian Tide & Current Tables PDFs publish each station's position only as **integer degrees + integer minutes** — no seconds, no fractional minutes. At BC latitudes (~48–55° N) one minute is roughly 1.85 km of latitude × 1.1–1.4 km of longitude, so any station's "true" position can sit anywhere inside a ~1 km box around what the PDF lists.

For a webapp that pins a marker on a map, this is enough error to put many coastal stations on land. (The original symptom: VICTORIA HARBOUR rendered ~800 m inland near Beacon Hill Park, OAK BAY rendered on the Oak Bay peninsula instead of in the bay.)

`process_combined.sh` is the build-time step that improves those positions. It runs *after* `read_tct.py` (in `process_canadian.sh`) parses the PDFs and *before* `build_manifest.py` ships the JSONs into `web/public/data/`.

## Pipeline integration

The pipeline is split across two shell scripts at the repo root:

- **`canada_data/process_canadian.sh --year YEAR`** — runs `canada_data/read_tct.py` to parse the PDFs (sourced from `canada_data/`) into `{year}_tct_*_stations.json` at the repo root. Source-specific; produces nothing else. (Details in [canada_data_processing.md](canada_data_processing.md).)
- **`process_combined.sh --year YEAR`** (at the repo root) — runs `apply_coord_overrides.py` then `build_manifest.py`. Consumes both the Canadian outputs (above) and the NOAA outputs (`{year}_noaa_*_stations.json` from `us_data/process_us.sh`) and publishes the year's data into `web/public/data/`. `apply_coord_overrides.py` is Canadian-only (NOAA's mdapi already returns precise coords); `build_manifest.py` ingests both feeds — `noaa_tidal_primary` and `noaa_current_primary` are registered kinds with their own `_PUBLISH_KEEP` allowlists and get the same publish-time stripping as the CHS kinds.

End-to-end ordering for a fresh year:

```
1. canada_data/process_canadian.sh
                            → canada_data/read_tct.py emits
                              {year}_tct_*_stations.json at the repo root
2. (optional) IWLS seeder   → canada_data/seed_iwls_overrides.py
                              (one-shot; against the parser-output JSONs)
3. us_data/process_us.sh    → emits {year}_noaa_*_stations.json at the repo root
4. process_combined.sh      → apply_coord_overrides.py rewrites the CHS
                              files in place with refined coords (sourcing
                              from canada_data/'s CSV + ./coord_overrides.json),
                              then build_manifest.py strips each parser
                              output to publish-only fields, serialises it
                              compactly, content-hashes the bytes, writes
                              into web/public/data/{year}/, and rebuilds
                              manifest.json
```

This placement is deliberate:

- The refinement is a *correction* to parser output, not a separate data product. Putting it inline keeps every downstream consumer (the webapp loader, future scripts, ad-hoc analyses) on the same corrected data.
- `build_manifest.py` already content-hashes the JSONs, so a coord change automatically produces a new filename and the existing cache-invalidation story (long-lived immutable cache on hashed files, no-cache on `manifest.json`) keeps working unchanged.
- The webapp loader (`web/src/data/loader.ts`) and the MapLibre layer (`web/src/map/stationLayer.ts`) need no changes.

## The script: `apply_coord_overrides.py`

CLI:

```
apply_coord_overrides.py --year YEAR
    [--source DIR]            # where to find the parser-output JSONs (default: cwd)
    [--csv PATH]              # CHS inventory CSV (default: canada_data/tide and water level station.csv)
    [--overrides PATH]        # manual overrides (default: ./coord_overrides.json — at repo root)
```

Before the per-station precedence walk runs, a **suppression pre-pass** drops any station whose `index_no` appears in `_suppress_index_nos` at the top of `coord_overrides.json` — see "Suppressing stations" below.

For each station in each of the four `{year}_tct_*_stations.json` files that survives the pre-pass, the script picks new coordinates by walking the precedence list:

1. **Manual override present?** Use it (or, if the override value is `null`, keep the PDF coord and suppress any CSV-disagreement warning — see "Override file format" below).
2. **CSV has this station, with ≥ 3 decimal places on both lat and lon, and the CSV coord is within 2 km of the PDF coord?** Use it.
3. Otherwise, keep the PDF coord. Possibly flag for human review (see thresholds below).

### Data sources, in precedence order

1. **`coord_overrides.json`** at the repo root — the persistent override file. Lives at root rather than inside `canada_data/` so the same file can grow to hold US-side overrides too if/when NOAA stations need them. Holds two kinds of entries:
   - **Manual** entries, hand-curated from `https://tides.gc.ca/en/stations/<id>` for stations that no automated source covers (e.g. VICTORIA HARBOUR is missing from the CSV) or where the automated source is wrong.
   - **IWLS-seeded** entries, produced in bulk by `canada_data/seed_iwls_overrides.py` from the CHS IWLS API. These are not edited by hand; the seeder rewrites them on demand.

   (Seeder mechanics in [canada_data_processing.md](canada_data_processing.md). A previous geonames-centroid layer was removed — see "Why we don't have a geonames-centroid fallback any more" in the same file.)

2. **CHS station inventory CSV** in `canada_data/`, default filename `tide and water level station.csv`. (See [canada_data_processing.md](canada_data_processing.md) for the open-data download URL and refresh cadence.) The CSV lists ~1,750 stations across Canada, keyed by the same `STATION_NUMBER` that the PDF tables use as `index_no`. Roughly two-thirds of Pacific-region stations are published with **3 or more decimal places** (≤110 m horizontal precision); some are publised at 4–6 decimals (≤10 m). It is **not** a strict superset of the PDF: about a tenth of the stations we get from the PDF are absent from the CSV (notably VICTORIA HARBOUR, index 7120). The CSV also covers tide/water-level stations only — current stations are not in it.

3. **The PDF coord** itself — used as a fallback whenever the higher-precedence sources don't apply.

### Trust thresholds

- **Precision floor: 3 decimal places (~110 m).** A CSV value with 0–2 decimals is too coarse to *replace* the PDF coord — at 2 decimals (~1 km) it's the same order of magnitude as the PDF's integer-minute precision, so swapping in a CSV value of unknown bias would be a wash at best.
- **CSV-trust offset ceiling: 2 km.** When CSV is precise enough to trust, but disagrees with PDF by more than 2 km, one source is clearly wrong. The script declines to pick a winner and instead flags the station for human review.

### Disagreement flagging

The script flags a station for human follow-up when *either*:

- CSV is precise (≥ 3 decimals) and disagrees with PDF by > 2 km, **or**
- CSV (at any precision) disagrees with PDF by > 5 km.

The second condition catches PDF typos that the first would miss. SHOAL BAY (index 8145) was the motivating case: the CSV had it at 50.46° N to 2 decimals (so the precision floor rejected it as an unreliable replacement), the PDF had it at 50.13° N — and the *real* gauge is at 50.46° N (per tides.gc.ca). The high-precision threshold alone never noticed; the gross-disagreement threshold does. BOAT HARBOUR (index 7480) is the same pattern.

The script writes each JSON back in place using the same `json.dumps(..., indent=2)` style as the parser, so a re-run with no input changes produces a no-op diff. It prints a per-file summary and a single sorted list of flagged stations.

Typical output (2026 data, with the IWLS seeder run, manual overrides committed, and 5 stations suppressed):

```
Loaded 1750 CSV stations, 305 manual overrides, 5 suppressed index_no(s)
  tidal_primary     :   23 stations |   0 suppressed |  23 via overrides |   0 via CSV |   0 kept from PDF
  tidal_secondary   :  263 stations |   5 suppressed | 257 via overrides |   2 via CSV |   4 kept from PDF
  current_primary   :   22 stations |   0 suppressed |  22 via overrides |   0 via CSV |   0 kept from PDF
  current_secondary :   39 stations |   0 suppressed |   3 via overrides |   0 via CSV |  36 kept from PDF

Total: 347 stations | 5 suppressed | 305 overridden | 2 refined from CSV | 40 unchanged
```

**All primaries are refined**, and **40 of 347 stations are left on raw PDF coords**. The 4 tide-secondary fall-throughs are stations IWLS doesn't have and the CSV is too low-precision (or wildly disagrees) for. The 36 current-secondary fall-throughs are the offset-based prediction stations IWLS doesn't cover at all — most of these will render at the PDF integer-arcminute coord (~1.1 km error). A few have manual overrides where the PDF coord renders visibly off (SANSUM NARROWS, OKISOLLO CHANNEL, BELIZE INLET).

## The overrides file format

`coord_overrides.json` (at the repo root) is a flat object keyed by stringified `index_no`. Each value is one of two things:

- **`[longitude, latitude]`** in WGS84 (GeoJSON-style, lon first) — replace the parsed coord with this.
- **`null`** — "I have verified the PDF coord is correct as-is; please stop flagging this station as a CSV/PDF disagreement on every run." Used when the CSV row is the wrong one (e.g. NAMU, where the CSV transcribed 51.53° N for what is actually a 51.86° N station).

Keys whose name starts with `_` are treated as comments and ignored, so the file can carry inline notes (per-block headers, source URLs, etc.).

When you find a station that's still rendering in the wrong place after this step, or one that the script flagged at the bottom of its run:

1. Look it up by `STATION_NUMBER` on https://tides.gc.ca/en/stations/&lt;5-digit zero-padded id&gt; (the official per-station detail page lists lat/lon to 3+ decimals for almost every station).
2. Add an entry keyed by its `index_no`. Use `[lon, lat]`, not `[lat, lon]`. See [Where to add or edit entries](#where-to-add-or-edit-entries) below for which block to put it in.
3. If you've verified the PDF was right and the CSV is the wrong one, use `null` instead of a coord — that suppresses the warning without changing the data.
4. Re-run `./process_combined.sh`. The build will pick up the new coord, write a fresh hashed JSON into `web/public/data/{year}/`, and the manifest will get a new ETag/content hash so the browser fetches the update on next page load. (No need to re-run `./canada_data/process_canadian.sh` — the parser output hasn't changed.)

### Where to add or edit entries

The `_block_*` keys are JSON comments, not a permission system — `apply_coord_overrides.py` treats every entry equivalently regardless of which block it's in. But the seeders DO care which block an entry sits in, so two rules apply:

1. **Add manual edits to the top three blocks** (`_block_pdf_wrong_replaced_with_chs_official`, `_block_pdf_correct_csv_wrong`, or `_block_us_cross_border`). Never directly into `_block_iwls_seeded` — the next IWLS seeder run will refresh entries it owns against the upstream API and silently overwrite your edit.
2. **To override a seeded entry, move it — don't duplicate it.** If a station is currently in `_block_iwls_seeded` and you want a different coord, delete its entry from there and add a new one in a manual block at the top. The seeders skip entries in the manual blocks (treating them as "already curated"), so once moved, your value sticks across reruns.

A station's `index_no` should appear in exactly one block. If the same key appears more than once in the file, JSON parsing keeps only the last occurrence — easy footgun if you copy-paste rather than move.

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

The remaining entries in `coord_overrides.json` come from the IWLS seeder and are not hand-curated:
- **`_block_iwls_seeded`** (~290 entries): every BC parser station that IWLS covers — primaries, secondaries, both tide and current. Sourced from the IWLS API; the seeder rewrites the block end-to-end on each run.

## Suppressing stations

Some CHS stations are now better-served by a NOAA station on the US side (the chartbook publishes Neah Bay, Port Angeles, Crescent Bay, Bellingham, Blaine, Friday Harbor as cross-border secondary computations off BC primaries; NOAA publishes harmonic-primary or NOAA-subordinate versions of the same gauges). When both render, the map gets stacked duplicate pins. To pick one and drop the other, `coord_overrides.json` carries an array key:

```json
"_suppress_index_nos": [7050, 7060, 7215, 7570, 8512]
```

`apply_coord_overrides.py`'s `load_suppressed()` parses this list at startup and `process_file()` runs a one-line filter before the per-station coord walk:

```python
doc["stations"] = [s for s in before if s.get("index_no") not in suppressed]
```

Suppressed stations never reach `build_manifest.py`, never appear in the published JSON, and never produce a marker. The pre-run summary line counts them on a per-kind basis:

```
tidal_secondary :  263 stations |   5 suppressed | 194 via overrides | ...
```

The parser-output JSONs at the repo root (`{year}_tct_*_stations.json`) are *also* rewritten in place with the suppressed stations removed — `apply_coord_overrides.py` always writes its filtered result back over the input. So after a run, the suppressed stations are gone from both the published artifact and the parser output. To bring them back, either remove the `index_no` from `_suppress_index_nos` *and* re-run `read_tct.py` (which regenerates the parser JSONs from the PDF), or use `git restore` on the parser output files.

**Constraint — don't suppress a referenced primary.** Secondary stations name a primary in `reference_primary` (currents) or `reference_name` (tides). Suppressing the referenced primary leaves any dependent secondary without a reference; the loader logs a console warning and the secondary degrades to "no value" rendering. Before adding an `index_no` to `_suppress_index_nos`, grep the four parser-output JSONs to confirm no `reference_primary` / `reference_name` field names the station you're dropping.

**Operational note — `_suppress_index_nos` is read, but coord-override entries for suppressed indices are not.** The suppression pre-pass runs first; the coord-precedence walk only sees the surviving stations. If you later want a suppressed station re-included, the leftover coord-override entry (if any) keeps working — you just need to remove the index from `_suppress_index_nos` and regenerate the parser output.

The Canadian-side rationale and current 2026 entries are catalogued in [canada_data_processing.md — Suppressing CHS stations covered by NOAA](canada_data_processing.md#suppressing-chs-stations-covered-by-noaa).

## Resolving flagged stations (annual runbook)

When a fresh year's PDF is processed, `apply_coord_overrides.py` will print a list of stations it couldn't resolve confidently — CSV and PDF disagree but the script can't tell which side is right. This section is the runbook for closing them out.

The 2026 pass produced 9 flagged stations on the first run plus 1 more once the gross-disagreement threshold was added. Same loop should work for future-year flags.

### Step-by-step

0. **Refresh the upstream data sources for the new year.** Re-download the CHS inventory CSV and re-run both seeders against the year's parser-output JSONs. The mechanics, URLs, and rationale live in [canada_data_processing.md — Annual upstream-source refresh](canada_data_processing.md#annual-upstream-source-refresh).

1. **Run the pipeline for the new year:**

   ```
   ./canada_data/process_canadian.sh --year YEAR
   ./process_combined.sh --year YEAR
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

   **Where to put the entry.** Add it to one of the manual blocks at the top — see [Where to add or edit entries](#where-to-add-or-edit-entries) for the rules and rationale.

4. **Re-run** `apply_coord_overrides.py --year YEAR` (or the full pipeline). Verify the flagged-stations section is empty. If a new station appears that wasn't in the original list — almost certainly a low-precision-but-grossly-wrong case the gross threshold caught — repeat steps 2–3 for it.

5. **Spot-check the obvious ones in the running app.** Open the map, find each previously-misplaced station (use the station name pill or zoom to its area), and confirm the marker is now in the water where it should be. Victoria Harbour and Oak Bay are good canaries because the user originally surfaced them.

### Practical notes

- **Unflagged stations can still be wrong.** The script only flags stations the CSV row contradicts — a station the CSV is missing entirely (like Victoria Harbour) won't appear in the flagged list. Visual inspection of the map after the pipeline is the only way to catch those. Anything still landing on land, add an override.
- **Don't trust just the CSV.** Several CSV rows that look precise (3+ decimals) turn out to be wrong by 2–4 km — REDONDA BAY and GORDON ISLANDS in 2026 — even though they're close enough to the PDF that the script auto-trusted them. The flagged list catches outliers; small-but-real errors slip through. If a CSV-trusted station looks wrong in the app, look it up on tides.gc.ca and add an override.
- **The `null` semantics matter.** If you only correct PDF-wrong cases and leave PDF-correct-CSV-wrong cases unaddressed, the script will keep flagging the same handful of stations on every future run, drowning out genuinely new flags. Use `null` for confirmed-PDF cases so the noise floor stays at zero.
- **Override entries persist across years.** Stations don't move (the user's words), so once a 2026 override is correct, it stays correct for 2027, 2028, etc. The annual loop should be additive: investigate only the *new* flagged stations each year.
- **Sanity-check the parser before chasing flags.** A surge of newly-flagged stations in a future year is more likely to indicate a parser-side regex regression than a sudden onslaught of CHS typos. Before opening 20 WebFetches, eyeball a few raw `latitude`/`longitude` values in the new JSONs and confirm the integer-minute structure looks the same as last year (e.g. all values are exact `n + m/60` for integer n, m).

## `build_manifest.py`

After `apply_coord_overrides.py` finishes, `build_manifest.py` is the second step in `process_combined.sh`. Two modes:

1. **Ingest mode** (when `--year` is given): reads each parser-output JSON from `--source`, strips it to the fields the webapp actually reads, serialises the result compactly, content-hashes the published bytes, writes the hashed file into `web/public/data/{year}/`, and removes any stale hashed siblings of the same kind. Then rebuilds the manifest.
2. **Rescan mode** (when `--year` is omitted): only rebuilds the manifest by scanning the existing data tree. Useful after manual file moves.

Both modes are idempotent: re-running with the same inputs yields no diff (the strip is deterministic, so identical source content produces identical published bytes and therefore an identical hash). `process_combined.sh` invokes ingest mode for the year being processed.

The manifest at `web/public/data/manifest.json` lists each year's content-hashed file paths plus the first/last UTC extreme times. Together with the content-hashed filenames, this gives the cache-invalidation story noted in "Pipeline integration" above: long-lived immutable cache on hashed files, no-cache on `manifest.json`.

### Publish-time stripping

The parser outputs at the repo root preserve every field the source documents (CHS PDFs, NOAA mdapi catalog) carry — useful for ad-hoc analyses, the seeders, and human inspection. But the published artifact in `web/public/data/{year}/` is what every browser downloads, parses, and holds in memory. Trimming it to only fields the webapp actually reads is a clean, conservative win on download size, parse time, and runtime heap.

Three reductions stack:

1. **Field allowlists per kind.** The `_PUBLISH_KEEP` table at the top of `build_manifest.py` maps each kind (`tidal_primary`, `tidal_secondary`, `current_primary`, `current_secondary`, `noaa_tidal_primary`, `noaa_current_primary`) to two sets of field names: one for the station object, one for each per-day object. Anything outside the sets is dropped. The allowlists were established by `grep`ing every JSON field name across `web/src/` and keeping only what the loader, interpolator, or UI references. Examples of fields that get dropped: `timezone`, `tide_type`, `reference_name`, `mean_tide_range`, `large_tide_range`, `mean_water_level`, `lowest_recorded_low_water`, `highest_recorded_high_water`, `area_number`, `area_name`, `geographic_zone`, `format_note`, `name_annotation`, `has_footnote`, `NOAA_short_name`, and per-day `weekday`. If a future UI feature needs one of these, add the field name to the appropriate allowlist and re-run the pipeline; the loader's TypeScript types will still need to expose it.

2. **Compact JSON serialisation.** Parser-output JSONs at the repo root are written with `indent=2` for human readability; the published files use `json.dumps(..., separators=(",", ":"))` — no indent, no key spacing. The published files are never human-edited, and gzip on top of compact JSON beats gzip on indented JSON by a meaningful margin (parse time also drops because the byte stream is shorter).

3. **Omit-when-default for high-frequency values.** A separate per-event pass drops fields whose value matches an overwhelming default. Today the only rule is on currents:

   - `weak_variable: false` is omitted from every event where it's `false` (~99% of all current events across CHS and NOAA combined).

   The webapp's `CurrentEvent` type marks `weak_variable` as optional, and the interpolator (`interp/extremes.ts`, `interp/secondaryCurrents.ts`) treats a missing field as `false`. So a published event for a normal max reads `{"time":"04:21","kind":"max","knots":-3.4}` instead of `{"time":"04:21","kind":"max","knots":-3.4,"weak_variable":false}`. Truly weak/variable events still serialise the field as `true`.

   Other candidates for this kind of defaulting were measured (see `analyze_field_frequency.py` at the repo root) and found small enough not to bother with — most fields with skewed distributions live in `current_secondary`, which is only ~24 KB total. The entire moderate-defaults pass would have saved ~3 KB. Adding more defaulting rules later is straightforward: extend `_strip_event_defaults` (or add a `_strip_station_defaults` peer) and update the loader's TypeScript type to mark the field optional.

### Loader-side contract

Any field that the publish step omits (or omits-when-default) must be recoverable by the loader. Today that means:

- Optional fields in `web/src/types.ts` for anything that's been allow-listed out of every published kind (e.g. dropping `timezone` made nothing optional because the field was already not in any `*Station` interface in use).
- Optional fields in `web/src/types.ts` for anything in the omit-when-default set, with a comment pointing at `_strip_event_defaults` so the contract is documented in both directions.

If you add a field to `_PUBLISH_KEEP`, no loader change is needed — the loader was already reading something compatible. If you add a field to `_strip_event_defaults`, the loader must also start treating that field as optional.

### Audit script: `analyze_field_frequency.py`

`analyze_field_frequency.py` (at the repo root) scans every parser-output JSON for a year and reports the value-frequency distribution per field, at three nesting levels (station, day, reading/event). Run it before adding new omit-when-default rules:

```
$ venv/bin/python analyze_field_frequency.py --year 2026
```

Fields whose top value's share is ≥95% are flagged with `★`, ≥80% with `○`. Use the report to confirm a candidate default is actually as skewed as you think before encoding it into `_strip_event_defaults`.

### Byte savings (2026)

For reference, the combined effect of the three reductions on the 2026 data:

| Kind | Pre-strip raw | Post-strip raw | Savings |
|---|---|---|---|
| `tidal_primary` | 3.9 MB | 1.2 MB | 70% |
| `tidal_secondary` | 191 KB | 93 KB | 60% |
| `current_primary` | 10.3 MB | 2.9 MB | 80% |
| `current_secondary` | 24 KB | 14 KB | 50% |
| `noaa_tidal_primary` | 5.7 MB | 1.9 MB | 70% |
| `noaa_current_primary` | 11.8 MB | 3.3 MB | 80% |
| **Total** | **32.0 MB** | **9.4 MB** | **70%** |

After gzip the win is smaller in percentage terms (gzip already compressed away most of the repeated key names) but still meaningful: the bundle the browser actually downloads is now ~1.1 MB total, vs. ~3 MB before.

For runtime memory savings beyond what the publish step achieves — the loader's in-memory `Extreme[]` objects, which dwarf the parsed JSON — see [runtime_heap.md](runtime_heap.md).

## Limitations and known gotchas

- **40 stations remain on raw PDF coords (~1.1 km error at BC latitudes).** Most are BC current secondaries, since IWLS doesn't cover them — they're offset-based predictions with no physical gauge for IWLS to publish a position for. A few tide-secondary stragglers IWLS doesn't have either. For these the ~1.1 km integer-arcminute error is acceptable for the marker landing inside the right body of water; if a specific station renders visibly off (e.g. on land), add a manual override from a marine chart.
- **The CSV is occasionally wrong.** It's a separate dataset maintained on a different cadence than the printed tables. The 2 km offset ceiling catches gross disagreements; subtler errors can slip through. The script's flagged list at the end of each run is the right place to look first when investigating.
- **Some CSV rows have lower precision than ours.** Pacific stations span 0–6 decimal places. The 3-decimal floor stops us from regressing.
- **CSV file path / freshness.** The CSV is in `canada_data/`; refresh and naming conventions are described in [canada_data_processing.md](canada_data_processing.md).
