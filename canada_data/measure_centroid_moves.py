#!/usr/bin/env python3
"""measure_centroid_moves.py — quantify how far each geonames-seeded coord
override has moved a station's marker from its raw PDF book position.

Re-runs read_tct.py against the year's CHS PDFs (in a tempdir, doesn't touch
the committed parser-output JSONs at the repo root) to recover the integer-
arcminute PDF coords, then walks the `_block_geonames_seeded` block of
coord_overrides.json and computes the haversine distance from each PDF coord
to its override coord. Prints two tables — tides and currents — sorted by
distance moved.

Diagnostic. Not part of the build pipeline. Run by hand whenever you want
to surface candidates for manual override review (large moves are a smell
that the seeder picked an inappropriate CGNDB feature centroid).

Usage:
    venv/bin/python3 canada_data/measure_centroid_moves.py --year 2026
"""
from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
KINDS = ["tidal_primary", "tidal_secondary", "current_primary", "current_secondary"]


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def load_geonames_block(overrides_path: Path) -> dict[str, tuple[float, float]]:
    """Return {index_no: (lat, lon)} for entries inside the
    `_block_geonames_seeded` block. The block is identified textually
    because JSON dicts don't preserve section structure."""
    in_block = False
    keys: list[str] = []
    for line in overrides_path.read_text().splitlines():
        if "_block_geonames_seeded" in line:
            in_block = True
            continue
        if in_block and re.search(r'"_block', line):
            in_block = False
            continue
        if in_block:
            stripped = line.strip()
            if stripped.startswith('"') and ":" in stripped:
                k = stripped.split('"')[1]
                if not k.startswith("_"):
                    keys.append(k)

    full = json.loads(overrides_path.read_text())
    out: dict[str, tuple[float, float]] = {}
    for k in keys:
        v = full.get(k)
        if isinstance(v, list) and len(v) == 2:
            lon, lat = float(v[0]), float(v[1])
            out[k] = (lat, lon)
    return out


def run_parser(year: int, pdf_dir: Path, out_dir: Path) -> None:
    """Re-run read_tct.py to a tempdir, capturing its output so we don't
    drown the table in parser logging."""
    cmd = [
        sys.executable,
        str(SCRIPT_DIR / "read_tct.py"),
        "--year", str(year),
        "--directory", str(pdf_dir),
        "--out-dir", str(out_dir),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        sys.stderr.write(res.stdout)
        sys.stderr.write(res.stderr)
        raise SystemExit(f"read_tct.py exited with {res.returncode}")


def load_raw_pdf_coords(year: int, parser_out_dir: Path) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for kind in KINDS:
        path = parser_out_dir / f"{year}_tct_{kind}_stations.json"
        if not path.exists():
            continue
        for s in json.loads(path.read_text())["stations"]:
            idx = str(s.get("index_no"))
            if idx == "None" or idx in out:
                continue
            out[idx] = {
                "kind": kind,
                "name": s.get("name", "?"),
                "lat": s.get("latitude"),
                "lon": s.get("longitude"),
            }
    return out


def render(title: str, rows: list[tuple]) -> None:
    print()
    print(f"=== {title} ({len(rows)} stations) — sorted by distance moved ===")
    if not rows:
        print("  (none)")
        return
    print(f"  {'idx':>5s}  {'kind':<10s}  {'name':<32s}  "
          f"{'PDF lat':>9s}, {'PDF lon':>11s}  →  "
          f"{'over lat':>9s}, {'over lon':>11s}  {'moved m':>8s}")
    for idx, kind, name, pl, plo, ol, olo, d in rows:
        short = (
            kind.replace("tidal_primary", "tide pri")
                .replace("tidal_secondary", "tide sec")
                .replace("current_primary", "curr pri")
                .replace("current_secondary", "curr sec")
        )
        print(f"  {idx:>5s}  {short:<10s}  {name[:32]:<32s}  "
              f"{pl:9.4f}, {plo:11.4f}  →  "
              f"{ol:9.4f}, {olo:11.4f}  {d:8.0f}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--year", type=int, required=True,
                    help="Year whose CHS PDFs to re-parse for raw book coords.")
    ap.add_argument("--pdf-dir", type=Path, default=SCRIPT_DIR,
                    help="Directory holding the year's CHS PDFs (default: canada_data/).")
    ap.add_argument("--overrides", type=Path,
                    default=REPO_ROOT / "coord_overrides.json",
                    help="coord_overrides.json (default: ./coord_overrides.json).")
    args = ap.parse_args()

    geonames = load_geonames_block(args.overrides)
    print(f"Geonames-seeded entries in {args.overrides.name}: {len(geonames)}")

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        print(f"Re-parsing CHS PDFs from {args.pdf_dir} → tempdir ...", flush=True)
        run_parser(args.year, args.pdf_dir, td_path)
        raw = load_raw_pdf_coords(args.year, td_path)
    print(f"Recovered raw PDF coords for {len(raw)} stations.")

    tide_rows: list[tuple] = []
    current_rows: list[tuple] = []
    missing: list[tuple[str, str]] = []  # (idx, reason)

    for idx, (over_lat, over_lon) in geonames.items():
        meta = raw.get(idx)
        if meta is None:
            missing.append((idx, "not in parsed PDF"))
            continue
        if meta["lat"] is None or meta["lon"] is None:
            missing.append((idx, f"{meta['name']}: parser produced no coord"))
            continue
        pdf_lat, pdf_lon = meta["lat"], meta["lon"]
        d = haversine_m(pdf_lat, pdf_lon, over_lat, over_lon)
        row = (idx, meta["kind"], meta["name"], pdf_lat, pdf_lon, over_lat, over_lon, d)
        if meta["kind"].startswith("tidal"):
            tide_rows.append(row)
        else:
            current_rows.append(row)

    tide_rows.sort(key=lambda r: -r[7])
    current_rows.sort(key=lambda r: -r[7])

    render("TIDE STATIONS moved by geonames centroid seeder", tide_rows)
    render("CURRENT STATIONS moved by geonames centroid seeder", current_rows)

    print()
    print(f"Summary: {len(tide_rows)} tide stations, {len(current_rows)} current stations moved.")
    if missing:
        print(f"WARN: {len(missing)} geonames-seeded indices had no usable PDF coord:")
        for idx, reason in missing:
            print(f"  {idx}: {reason}")


if __name__ == "__main__":
    main()
