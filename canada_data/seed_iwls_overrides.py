#!/usr/bin/env python3
"""seed_iwls_overrides.py — synchronise the `_block_iwls_seeded` portion
of coord_overrides.json with the current CHS IWLS station catalog
(api-iwls.dfo-mpo.gc.ca).

NOT part of the per-build pipeline — `apply_coord_overrides.py` just
reads the persistent coord_overrides.json. Run this seeder by hand once
per year, after the new PDF set has been parsed (so the parser-output
JSONs hold raw integer-arcminute coords for the seeder to compare
against).

After running, the IWLS block exactly mirrors current IWLS data for
every parser station IWLS covers. Per parser station the seeder does
one of:

  - **Add**     — new station IWLS now covers, no existing override
  - **Refresh** — existing IWLS-block entry whose IWLS coord has changed
  - **Remove**  — IWLS-block entry for a station no longer in IWLS, or
                  no longer in the parser output (CHS dropped it)

Manual / null / us-cross-border entries are never touched — human
curation always wins. Stations IWLS doesn't cover (mostly current
secondaries) fall through to PDF integer-arcminute coords at apply time.

The IWLS block is rewritten in sorted-by-index order on each run.

See notes/canada_data_processing.md for context.
"""

from __future__ import annotations

import argparse
import json
import math
import urllib.request
from pathlib import Path

# coord_overrides.json lives at the repo root (one level up from canada_data/).
REPO_ROOT = Path(__file__).resolve().parent.parent
KINDS = ["tidal_primary", "tidal_secondary", "current_primary", "current_secondary"]
IWLS_URL = "https://api-iwls.dfo-mpo.gc.ca/api/v1/stations"


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def insert_into_block(
    raw: dict, marker_key: str, marker_desc: str, new_entries: dict
) -> dict:
    """Return a new dict with new_entries placed inside the block whose
    header is marker_key — i.e. immediately before the next `_block_*`
    marker, or at end-of-dict if marker_key is in the last block.

    Plain `raw[idx] = value` always appends at end-of-dict, which lands
    new entries in whichever block happens to be last in the file. Once a
    second seeder block is added below this one, that's the wrong block.
    """
    if marker_key not in raw:
        out = dict(raw)
        out[marker_key] = marker_desc
        out.update(new_entries)
        return out
    out: dict = {}
    in_block = False
    inserted = False
    for k, v in raw.items():
        if k == marker_key:
            in_block = True
            out[k] = marker_desc  # refresh description on each run
            continue
        if in_block and k.startswith("_block_"):
            out.update(new_entries)
            inserted = True
            in_block = False
        out[k] = v
    if in_block and not inserted:
        out.update(new_entries)
    return out


def identify_blocks(overrides_path: Path) -> dict[str, str]:
    """Walk the source file textually to determine which `_block_*`
    region each non-comment key lives in. JSON dicts don't preserve
    section structure, so we have to read the file as text.

    Returns {idx_str: 'manual' | 'csv_wrong' | 'us' | 'iwls'}.
    """
    block = "manual"  # entries before any _block_* marker count as top-level manual
    out: dict[str, str] = {}
    for line in overrides_path.read_text().splitlines():
        if "_block_pdf_wrong_replaced_with_chs_official" in line:
            block = "manual"; continue
        if "_block_pdf_correct_csv_wrong" in line:
            block = "csv_wrong"; continue
        if "_block_us_cross_border" in line:
            block = "us"; continue
        if "_block_iwls_seeded" in line:
            block = "iwls"; continue
        if ('"_format' in line or '"_source_url' in line
                or '"_block_suppressed' in line or '"_suppress_index_nos' in line):
            continue
        s = line.strip()
        if s.startswith('"') and ":" in s:
            k = s.split('"')[1]
            if not k.startswith("_") and k.isdigit():
                out[k] = block
    return out


def fetch_iwls() -> dict[int, tuple[float, float]]:
    print(f"Fetching {IWLS_URL} ...", end=" ", flush=True)
    req = urllib.request.Request(IWLS_URL, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read())
    out: dict[int, tuple[float, float]] = {}
    for s in data:
        code = s.get("code")
        if not code or not str(code).isdigit():
            continue
        lat, lon = s.get("latitude"), s.get("longitude")
        if lat is None or lon is None:
            continue
        out[int(code)] = (float(lat), float(lon))
    print(f"got {len(out)} stations with parseable coords.")
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--year", type=int, required=True,
                    help="Year whose parsed JSONs to use as the station roster")
    ap.add_argument("--source", type=Path, default=Path("."),
                    help="Directory holding the parser output JSONs (default: cwd)")
    ap.add_argument("--overrides", type=Path, default=REPO_ROOT / "coord_overrides.json",
                    help="Override file to update (default: ./coord_overrides.json)")
    args = ap.parse_args()

    iwls = fetch_iwls()
    overrides_raw = json.loads(args.overrides.read_text()) if args.overrides.exists() else {}
    block_of = identify_blocks(args.overrides) if args.overrides.exists() else {}

    manual_keys   = {k for k, b in block_of.items() if b in ("manual", "csv_wrong", "us")}
    iwls_keys     = {k for k, b in block_of.items() if b == "iwls"}
    print(f"Current state: manual={len(manual_keys)}  iwls={len(iwls_keys)}\n")

    added: list[tuple[str, str, str, list[float], float]] = []
    refreshed: list[tuple[str, str, str, list[float], list[float], float]] = []
    removed_no_iwls: list[tuple[str, str, str]] = []
    skipped_manual = 0
    no_iwls_no_action = 0
    no_change = 0
    seen_in_parser: set[str] = set()

    for kind in KINDS:
        path = args.source / f"{args.year}_tct_{kind}_stations.json"
        if not path.exists():
            print(f"  ({kind}: no input file at {path})")
            continue
        for s in json.loads(path.read_text())["stations"]:
            idx_int = s.get("index_no")
            lat, lon = s.get("latitude"), s.get("longitude")
            if idx_int is None or lat is None or lon is None:
                continue
            idx = str(idx_int)
            seen_in_parser.add(idx)
            name = s.get("name", "?")

            if idx in manual_keys:
                skipped_manual += 1
                continue

            iwls_pos = iwls.get(idx_int)
            if iwls_pos is None:
                if idx in iwls_keys:
                    del overrides_raw[idx]
                    removed_no_iwls.append((kind, idx, name))
                else:
                    no_iwls_no_action += 1
                continue

            ilat, ilon = iwls_pos
            new_value = [round(ilon, 6), round(ilat, 6)]
            d = haversine_m(lat, lon, ilat, ilon)

            if idx in iwls_keys:
                existing = overrides_raw.get(idx)
                if existing == new_value:
                    no_change += 1
                else:
                    refreshed.append((kind, idx, name, existing, new_value, d))
            else:
                added.append((kind, idx, name, new_value, d))

    # Orphans: IWLS-block entries for stations no longer in the parser output.
    removed_no_station: list[tuple[str]] = []
    for idx in list(iwls_keys):
        if idx not in seen_in_parser and idx in overrides_raw:
            del overrides_raw[idx]
            removed_no_station.append((idx,))

    # Rebuild the IWLS block from scratch, sorted by index. We pull every
    # surviving IWLS-block entry out of overrides_raw, merge with new
    # additions, sort, and re-insert via insert_into_block.
    final_iwls: dict[str, list[float]] = {}
    for idx in iwls_keys:
        if idx in overrides_raw:  # not removed above
            final_iwls[idx] = overrides_raw[idx]
            del overrides_raw[idx]
    # Apply refreshed values now (they were tracked but not yet written).
    for kind, idx, name, old, new, d in refreshed:
        final_iwls[idx] = new
    for kind, idx, name, val, _ in added:
        final_iwls[idx] = val

    sorted_iwls = dict(sorted(final_iwls.items(), key=lambda x: int(x[0])))

    block_desc = (
        f"Bulk-seeded from {IWLS_URL} by seed_iwls_overrides.py — "
        f"do not edit by hand. Re-run that script after a new PDF year is processed "
        f"to add/refresh/migrate/remove entries against the current IWLS catalog. "
        f"See notes/canada_data_processing.md."
    )
    overrides_raw = insert_into_block(
        overrides_raw, "_block_iwls_seeded", block_desc, sorted_iwls
    )

    # Summary
    print(f"  added                : {len(added):>4d}")
    print(f"  refreshed            : {len(refreshed):>4d}")
    print(f"  removed (no IWLS)    : {len(removed_no_iwls):>4d}")
    print(f"  removed (no station) : {len(removed_no_station):>4d}")
    print(f"  unchanged in IWLS    : {no_change:>4d}")
    print(f"  skipped (manual)     : {skipped_manual:>4d}")
    print(f"  not in IWLS, no-op   : {no_iwls_no_action:>4d}")

    any_change = bool(
        added or refreshed or removed_no_iwls or removed_no_station
    )
    if not any_change:
        print("\nNothing to write.")
        return

    args.overrides.write_text(
        json.dumps(overrides_raw, indent=2, ensure_ascii=False) + "\n"
    )
    print(f"\nWrote {args.overrides}.")

    def show(title, rows, fmt):
        if not rows:
            return
        print(f"\n{title}:")
        for r in rows:
            print(fmt(r))

    show("Added", sorted(added, key=lambda r: int(r[1])),
         lambda r: f"  {r[0]:18s} {r[1]:>5s}  {r[2][:30]:<30s}  Δ from PDF: {r[4]:6.0f} m")
    show("Refreshed (IWLS coord changed)", sorted(refreshed, key=lambda r: int(r[1])),
         lambda r: f"  {r[0]:18s} {r[1]:>5s}  {r[2][:30]:<30s}  was {r[3]} → {r[4]}")
    show("Removed (no longer in IWLS catalog)", sorted(removed_no_iwls, key=lambda r: int(r[1])),
         lambda r: f"  {r[0]:18s} {r[1]:>5s}  {r[2][:30]:<30s}")
    show("Removed (no longer in parser output)", sorted(removed_no_station, key=lambda r: int(r[0])),
         lambda r: f"  {r[0]:>5s}")


if __name__ == "__main__":
    main()
