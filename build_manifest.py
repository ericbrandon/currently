#!/usr/bin/env python3
"""Build (or rebuild) web/public/data/manifest.json.

Two modes:

1. Ingest mode: when --year is given, copy the parser's output JSONs from
   --source into web/public/data/{year}/, renaming them with a content
   hash, and remove any stale hashed siblings of the same kind. Then
   rebuild the manifest.

2. Rescan mode: when --year is omitted, only rebuild the manifest by
   scanning the existing data tree. Useful after manual file moves.

Both modes are idempotent: re-running with the same inputs yields no diff.
"""

from __future__ import annotations

import argparse
import calendar
import hashlib
import json
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

# The four file kinds we recognise. The first element is the parser's
# filename stem (e.g. "tidal_primary" → "{year}_tct_tidal_primary_stations.json")
# and also the destination stem and the manifest key.
KINDS = ["tidal_primary", "tidal_secondary", "current_primary", "current_secondary"]

HASHED_FILENAME_RE = re.compile(r"^(?P<stem>[a-z_]+)\.(?P<hash>[0-9a-f]{8})\.json$")


@dataclass
class YearEntry:
    year: int
    files: dict[str, str]                # kind → relative path under data dir
    first_extreme_utc: str | None
    last_extreme_utc: str | None


def content_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()[:8]


def ingest(source: Path, data_dir: Path, year: int) -> None:
    """Copy parser outputs into data_dir/{year}/ with content-hashed names.
    Idempotent: same content → same filename → no-op. Stale siblings of
    the same kind are removed."""
    dest_dir = data_dir / str(year)
    dest_dir.mkdir(parents=True, exist_ok=True)

    found_any = False
    for kind in KINDS:
        src = source / f"{year}_tct_{kind}_stations.json"
        if not src.exists():
            continue
        found_any = True
        h = content_hash(src)
        target_name = f"{kind}.{h}.json"
        target = dest_dir / target_name

        if not target.exists():
            shutil.copyfile(src, target)
            print(f"  + {target.relative_to(data_dir)}")

        for sibling in dest_dir.glob(f"{kind}.*.json"):
            if sibling.name != target_name:
                sibling.unlink()
                print(f"  - {sibling.relative_to(data_dir)}")

    if not found_any:
        raise SystemExit(
            f"No parser output JSONs found in {source} for year {year}. "
            f"Expected files like {year}_tct_tidal_primary_stations.json"
        )


def station_time_to_utc_iso(year: int, month: int, day: int,
                            hhmm: str, utc_offset: int) -> str:
    """Convert a station-local clock time printed in the PDF to a UTC ISO 8601
    string. Mirrors stationTimeToUtcMs in the TS interpolator."""
    hh, mm = map(int, hhmm.split(":"))
    total_minutes = (hh - utc_offset) * 60 + mm
    days_added, remainder = divmod(total_minutes, 24 * 60)
    new_hh, new_mm = divmod(remainder, 60)

    abs_day = day + days_added
    while True:
        days_in_month = calendar.monthrange(year, month)[1]
        if 1 <= abs_day <= days_in_month:
            break
        if abs_day < 1:
            month -= 1
            if month < 1:
                month = 12
                year -= 1
            abs_day += calendar.monthrange(year, month)[1]
        else:
            abs_day -= days_in_month
            month += 1
            if month > 12:
                month = 1
                year += 1
    return f"{year:04d}-{month:02d}-{abs_day:02d}T{new_hh:02d}:{new_mm:02d}:00Z"


def extreme_iso_range(json_path: Path) -> tuple[str | None, str | None]:
    """(first_extreme_utc, last_extreme_utc) ISO strings for a JSON file
    emitted by read_tct.py. (None, None) if no extremes."""
    data = json.loads(json_path.read_text())
    first: str | None = None
    last: str | None = None
    for s in data.get("stations", []):
        year = s.get("year")
        utc_offset = s.get("utc_offset")
        if year is None or utc_offset is None:
            # Secondary stations carry differences, not extremes — skip.
            continue
        for d in s.get("days", []):
            month = d["month"]
            day = d["day"]
            entries = d.get("readings") or d.get("events") or []
            for e in entries:
                iso = station_time_to_utc_iso(year, month, day,
                                              e["time"], utc_offset)
                if first is None or iso < first:
                    first = iso
                if last is None or iso > last:
                    last = iso
    return first, last


def scan_data_dir(data_dir: Path) -> list[YearEntry]:
    """Walk data_dir/{year}/ subdirs and produce YearEntry list."""
    out: list[YearEntry] = []
    for year_dir in sorted(p for p in data_dir.iterdir()
                           if p.is_dir() and p.name.isdigit()):
        year = int(year_dir.name)
        files: dict[str, str] = {}
        first: str | None = None
        last: str | None = None
        for entry in sorted(year_dir.iterdir()):
            if not entry.is_file():
                continue
            m = HASHED_FILENAME_RE.match(entry.name)
            if not m:
                continue
            stem = m.group("stem")
            if stem not in KINDS:
                continue
            files[stem] = str(entry.relative_to(data_dir)).replace("\\", "/")
            ef, el = extreme_iso_range(entry)
            if ef and (first is None or ef < first):
                first = ef
            if el and (last is None or el > last):
                last = el
        if files:
            out.append(YearEntry(year=year, files=files,
                                 first_extreme_utc=first,
                                 last_extreme_utc=last))
    return out


def build_manifest(data_dir: Path) -> dict:
    from datetime import datetime, timezone

    years = []
    for entry in scan_data_dir(data_dir):
        years.append({
            "year": entry.year,
            **entry.files,
            "first_extreme_utc": entry.first_extreme_utc,
            "last_extreme_utc": entry.last_extreme_utc,
        })
    years.sort(key=lambda y: y["year"])

    return {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "years": years,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", type=Path, default=Path("."),
                    help="Where to find parser output JSONs (only used with --year)")
    ap.add_argument("--data-dir", type=Path, default=Path("web/public/data"),
                    help="Destination data dir (default: web/public/data)")
    ap.add_argument("--year", type=int, help="Year being ingested")
    args = ap.parse_args()

    args.data_dir.mkdir(parents=True, exist_ok=True)

    if args.year is not None:
        print(f"Ingesting year={args.year} from {args.source}/")
        ingest(args.source, args.data_dir, args.year)

    print(f"Rebuilding manifest in {args.data_dir}/manifest.json")
    manifest = build_manifest(args.data_dir)
    manifest_path = args.data_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

    n_years = len(manifest["years"])
    print(f"  {n_years} year entry/entries")


if __name__ == "__main__":
    main()
