#!/usr/bin/env python3
"""seed_iwls_overrides.py — one-shot helper that fetches the CHS IWLS
station catalog (api-iwls.dfo-mpo.gc.ca) and appends bulk overrides into
coord_overrides.json for every station whose IWLS coord meaningfully
differs from the parsed PDF coord.

This is NOT part of the per-build pipeline — `apply_coord_overrides.py`
just reads the persistent coord_overrides.json. Run this seeder by hand:

  - Once now, to populate overrides for ~half the current stations and
    most tide stations from a single authoritative source.
  - Again after a new PDF year is processed, in case CHS has added new
    stations to the catalog that didn't exist before.

Existing entries in coord_overrides.json (manual or previously-seeded)
are never overwritten — manual curation always wins.

See notes/tables_processing.md for context.
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

# Don't bother adding an override that would shift the position by less
# than this — within this radius, the PDF coord is "good enough" and
# adding a no-op override just bloats the file.
MIN_OFFSET_M = 100


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


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
                    help="Override file to append to (default: ./coord_overrides.json)")
    args = ap.parse_args()

    iwls = fetch_iwls()
    overrides_raw = json.loads(args.overrides.read_text()) if args.overrides.exists() else {}
    existing_keys = {k for k in overrides_raw if not k.startswith("_")}
    print(f"Existing entries in {args.overrides.name}: {len(existing_keys)} (preserved as-is)\n")

    added: list[tuple[str, int, str, float, float, float]] = []  # (kind, idx, name, lat, lon, offset_m)
    counts = {kind: {"add": 0, "exists": 0, "no_iwls": 0, "close": 0} for kind in KINDS}

    for kind in KINDS:
        path = args.source / f"{args.year}_tct_{kind}_stations.json"
        if not path.exists():
            print(f"  {kind}: (no input file at {path})")
            continue
        for s in json.loads(path.read_text())["stations"]:
            idx = s.get("index_no")
            lat, lon = s.get("latitude"), s.get("longitude")
            if idx is None or lat is None or lon is None:
                continue
            if str(idx) in existing_keys:
                counts[kind]["exists"] += 1
                continue
            iwls_pos = iwls.get(idx)
            if iwls_pos is None:
                counts[kind]["no_iwls"] += 1
                continue
            ilat, ilon = iwls_pos
            d = haversine_m(lat, lon, ilat, ilon)
            if d < MIN_OFFSET_M:
                counts[kind]["close"] += 1
                continue
            added.append((kind, idx, s.get("name", "?"), ilat, ilon, d))
            counts[kind]["add"] += 1

    print(f"  {'kind':18s} {'add':>5s} {'existing':>9s} {'no-iwls':>8s} {'close':>6s}")
    for kind in KINDS:
        c = counts[kind]
        print(f"  {kind:18s} {c['add']:5d} {c['exists']:9d} {c['no_iwls']:8d} {c['close']:6d}")
    print(f"\nWill add {len(added)} new IWLS-seeded overrides.")

    if not added:
        print("Nothing to write.")
        return

    overrides_raw["_block_iwls_seeded"] = (
        f"Bulk-seeded from {IWLS_URL} by seed_iwls_overrides.py — "
        f"do not edit by hand. Re-run that script after a new PDF year is processed "
        f"to catch any newly-added stations. See notes/tables_processing.md."
    )
    # JSON preserves insertion order from Python 3.7+, so appended entries
    # show up at the end of the file. Sort by index for deterministic output.
    for kind, idx, name, ilat, ilon, d in sorted(added, key=lambda r: r[1]):
        overrides_raw[str(idx)] = [ilon, ilat]

    args.overrides.write_text(json.dumps(overrides_raw, indent=2, ensure_ascii=False) + "\n")
    print(f"\nWrote {args.overrides} (+{len(added)} entries).")

    # A few sanity peek-ins, sorted by largest offset — these are the ones
    # most likely to be code mismatches if anything is off.
    print("\nLargest IWLS-vs-PDF offsets (sanity check):")
    print(f"  {'kind':18s} {'idx':>5s}  {'name':<30s}  {'Δ km':>6s}")
    for kind, idx, name, ilat, ilon, d in sorted(added, key=lambda r: -r[5])[:10]:
        print(f"  {kind:18s} {idx:5d}  {name[:30]:<30s}  {d/1000:6.2f}")


if __name__ == "__main__":
    main()
