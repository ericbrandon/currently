#!/usr/bin/env python3
"""apply_coord_overrides.py — replace integer-minute station coords with
finer-grained values from the CHS open-data inventory CSV plus a
hand-curated overrides file.

Why this exists: the Tide & Current Tables PDFs only publish station
positions to the nearest whole minute (~1 km error budget at BC
latitudes), which is enough to put coastal stations on land in the
webapp. The "Canadian Tide and Water Level Station Inventory" CSV from
open.canada.ca lists most BC stations with 3+ decimal places (~110 m or
better). For stations the CSV is missing or gets wrong, a small
`coord_overrides.json` keyed by index_no provides a manual escape hatch.

Runs after read_tct.py and before build_manifest.py — see
notes/tables_processing.md for full rationale.

Idempotent: re-running with the same inputs yields no diff.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path

# Repo root — this script lives here; coord_overrides.json sits beside it.
# The CHS station inventory CSV stays in canada_data/ (Canadian source).
REPO_ROOT = Path(__file__).resolve().parent

# Match build_manifest.py's KINDS list — the four parser output JSONs.
KINDS = ["tidal_primary", "tidal_secondary", "current_primary", "current_secondary"]

# CSV is trusted only when its coords are at least this precise AND not
# wildly disagreeing with the PDF coord. Tuned from the spot-check across
# 260 matched Pacific tide stations — see notes/tables_processing.md.
MIN_DECIMAL_PLACES = 3          # ~110 m horizontal precision at 48°N
MAX_OFFSET_PRECISE_M = 2000     # CSV ≥ MIN_DECIMAL_PLACES disagreeing by > this → flag
MAX_OFFSET_GROSS_M = 5000       # CSV at any precision disagreeing by > this → flag
                                # (catches PDF typos even when the CSV is too coarse to use)


def parser_filename(year: int, kind: str) -> str:
    return f"{year}_tct_{kind}_stations.json"


def decimal_places(s: str) -> int:
    s = s.strip()
    return len(s.split(".", 1)[1]) if "." in s else 0


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in meters. Plenty accurate at our scale."""
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def load_csv(path: Path) -> dict[int, tuple[float, float, int]]:
    """Read the CHS station inventory CSV. Returns {index_no: (lat, lon, min_decimals)}.
    Skips rows whose lat/lon don't parse as floats."""
    out: dict[int, tuple[float, float, int]] = {}
    with path.open(newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            try:
                idx = int(row["STATION_NUMBER"])
                lat_s, lon_s = row["LATITUDE"].strip(), row["LONGITUDE"].strip()
                lat, lon = float(lat_s), float(lon_s)
            except (ValueError, KeyError):
                continue
            out[idx] = (lat, lon, min(decimal_places(lat_s), decimal_places(lon_s)))
    return out


def load_overrides(path: Path) -> dict[int, tuple[float, float] | None]:
    """Read coord_overrides.json. Format: {"index_no": [lon, lat], ...}.
    A null value means "I've verified the PDF coord; stop flagging this
    station as a CSV/PDF disagreement." Keys starting with `_` are treated
    as comments and skipped, so the file can carry inline notes."""
    if not path.exists():
        return {}
    raw = json.loads(path.read_text())
    out: dict[int, tuple[float, float] | None] = {}
    for k, v in raw.items():
        if k.startswith("_"):
            continue
        try:
            idx = int(k)
        except ValueError:
            print(f"  WARN: ignoring overrides entry with non-int key {k!r}")
            continue
        if v is None:
            out[idx] = None
            continue
        try:
            lon, lat = float(v[0]), float(v[1])
        except (ValueError, TypeError, IndexError):
            print(f"  WARN: ignoring malformed overrides entry {k!r}: {v!r}")
            continue
        out[idx] = (lat, lon)
    return out


def load_suppressed(path: Path) -> set[int]:
    """Read the optional `_suppress_index_nos` list from the overrides file.
    Stations with these index_nos are dropped from the parser output entirely
    — used when a CHS station is now covered by another data source (e.g. a
    NOAA US station) and would otherwise duplicate a marker on the map."""
    if not path.exists():
        return set()
    raw = json.loads(path.read_text())
    items = raw.get("_suppress_index_nos") or []
    out: set[int] = set()
    for v in items:
        try:
            out.add(int(v))
        except (TypeError, ValueError):
            print(f"  WARN: ignoring malformed _suppress_index_nos entry {v!r}")
    return out


def process_file(
    path: Path,
    csv_data: dict[int, tuple[float, float, int]],
    overrides: dict[int, tuple[float, float] | None],
    suppressed: set[int],
) -> tuple[int, int, int, int, int, list[tuple[int, str, float, int]]]:
    """Returns (n_stations, n_suppressed, n_override, n_csv, n_kept, big_diffs).
    big_diffs: (idx, name, offset_m, csv_decimals) for stations where CSV
    and PDF disagree enough to be suspicious. Two thresholds — see the
    module-level constants."""
    doc = json.loads(path.read_text())

    # Pre-pass: drop stations whose index_no is in the suppression list.
    before = doc.get("stations", [])
    doc["stations"] = [s for s in before if s.get("index_no") not in suppressed]
    n_suppressed = len(before) - len(doc["stations"])

    n_override = n_csv = n_kept = 0
    big_diffs: list[tuple[int, str, float, int]] = []

    for s in doc.get("stations", []):
        idx = s.get("index_no")
        if idx is None or s.get("latitude") is None or s.get("longitude") is None:
            n_kept += 1
            continue

        # Branch 1: explicit override. A non-null value replaces; null
        # means "I've verified PDF is right — keep, and don't flag."
        if idx in overrides:
            value = overrides[idx]
            if value is not None:
                s["latitude"], s["longitude"] = value
                n_override += 1
            else:
                n_kept += 1
            continue

        cr = csv_data.get(idx)
        if cr is None:
            n_kept += 1
            continue
        clat, clon, min_dec = cr
        offset = haversine_m(s["latitude"], s["longitude"], clat, clon)

        # Branch 2: CSV is precise enough and agrees closely → trust it.
        if min_dec >= MIN_DECIMAL_PLACES and offset <= MAX_OFFSET_PRECISE_M:
            s["latitude"], s["longitude"] = clat, clon
            n_csv += 1
            continue

        # Branch 3: keep PDF. Flag if either:
        #   - CSV is precise enough to trust but disagrees > 2 km
        #     (one source is wrong; needs human verdict), or
        #   - any-precision CSV disagrees > 5 km (likely a PDF typo —
        #     covers the SHOAL-BAY-style case where CSV had only 2
        #     decimals so it didn't trip the precise threshold).
        n_kept += 1
        flag = (min_dec >= MIN_DECIMAL_PLACES and offset > MAX_OFFSET_PRECISE_M) \
            or offset > MAX_OFFSET_GROSS_M
        if flag:
            big_diffs.append((idx, s.get("name", "?"), offset, min_dec))

    # Stable, indented re-serialisation matching read_tct.py's style.
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    return len(doc.get("stations", [])), n_suppressed, n_override, n_csv, n_kept, big_diffs


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--year", type=int, required=True, help="Year being processed")
    ap.add_argument("--source", type=Path, default=Path("."),
                    help="Directory holding the parser output JSONs (default: cwd)")
    ap.add_argument("--csv", type=Path,
                    default=REPO_ROOT / "canada_data" / "tide and water level station.csv",
                    help="CHS station inventory CSV (default: canada_data/tide and water level station.csv)")
    ap.add_argument("--overrides", type=Path,
                    default=REPO_ROOT / "coord_overrides.json",
                    help="Manual override file (default: ./coord_overrides.json)")
    args = ap.parse_args()

    if not args.csv.exists():
        print(f"  WARN: CSV not found at {args.csv} — skipping coord overrides "
              f"(see notes/tables_processing.md for download URL)")
        return

    csv_data = load_csv(args.csv)
    overrides = load_overrides(args.overrides)
    suppressed = load_suppressed(args.overrides)
    print(f"Loaded {len(csv_data)} CSV stations, {len(overrides)} manual overrides, "
          f"{len(suppressed)} suppressed index_no(s)")

    totals = {"stations": 0, "suppressed": 0, "override": 0, "csv": 0, "kept": 0}
    all_big_diffs: list[tuple[str, int, str, float, int]] = []

    for kind in KINDS:
        path = args.source / parser_filename(args.year, kind)
        if not path.exists():
            print(f"  {kind}: (no input file at {path})")
            continue
        n, ns, no, nc, nk, big = process_file(path, csv_data, overrides, suppressed)
        print(f"  {kind:18s}: {n:4d} stations | "
              f"{ns:3d} suppressed | {no:3d} via overrides | "
              f"{nc:3d} via CSV | {nk:3d} kept from PDF")
        totals["stations"] += n
        totals["suppressed"] += ns
        totals["override"] += no
        totals["csv"] += nc
        totals["kept"] += nk
        for idx, name, off, dec in big:
            all_big_diffs.append((kind, idx, name, off, dec))

    print(f"\nTotal: {totals['stations']} stations | "
          f"{totals['suppressed']} suppressed | "
          f"{totals['override']} overridden | {totals['csv']} refined from CSV | "
          f"{totals['kept']} unchanged")

    if all_big_diffs:
        print(f"\n{len(all_big_diffs)} station(s) flagged for review — "
              f"CSV and PDF disagree enough that one of them is likely wrong. "
              f"Look up the station at https://tides.gc.ca/en/stations/<5-digit id> "
              f"and add the right answer to coord_overrides.json (or null if PDF "
              f"turns out to be correct):")
        print(f"  {'kind':18s} {'index':>5s}  {'name':<30s}  {'Δ km':>6s}  {'csv-dec':>7s}")
        for kind, idx, name, off, dec in sorted(all_big_diffs, key=lambda x: -x[3]):
            print(f"  {kind:18s} {idx:5d}  {name[:30]:<30s}  {off/1000:6.1f}  {dec:7d}")


if __name__ == "__main__":
    main()
