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
from dataclasses import dataclass
from pathlib import Path

# File kinds we recognise. Each kind's `stem` is both the destination
# filename stem (e.g. "noaa_tidal_primary.{hash}.json") and the manifest
# key. Its `source_template` formats the parser's output filename at the
# repo root for that year.
@dataclass(frozen=True)
class Kind:
    stem: str
    source_template: str

KINDS: list[Kind] = [
    Kind("tidal_primary",        "{year}_tct_tidal_primary_stations.json"),
    Kind("tidal_secondary",      "{year}_tct_tidal_secondary_stations.json"),
    Kind("current_primary",      "{year}_tct_current_primary_stations.json"),
    Kind("current_secondary",    "{year}_tct_current_secondary_stations.json"),
    Kind("noaa_tidal_primary",   "{year}_noaa_tidal_primary_stations.json"),
    Kind("noaa_current_primary", "{year}_noaa_current_primary_stations.json"),
]
KIND_STEMS = {k.stem for k in KINDS}

HASHED_FILENAME_RE = re.compile(r"^(?P<stem>[a-z_]+)\.(?P<hash>[0-9a-f]{8})\.json$")


# Per-kind field allowlists for publish-time stripping. Anything outside
# these sets is dropped before the JSON is written to web/public/data/ —
# the webapp doesn't read them, and shipping them inflates the gzipped
# download. Parser outputs at the repo root remain untouched (they keep
# every field the source documents carry, which can be useful for ad-hoc
# scripts and human inspection).
#
# Audit done by grep against web/src/ — anything actually referenced by
# the loader, interpolator, or UI is in `station` or `day`. If a future
# UI feature needs a field that was being stripped, add it here.
_PUBLISH_KEEP: dict[str, dict[str, set[str]]] = {
    "tidal_primary": {
        "station": {
            "name", "index_no", "year", "utc_offset",
            "latitude", "longitude",
            "higher_high_water_mean_tide", "higher_high_water_large_tide",
            "lower_low_water_mean_tide", "lower_low_water_large_tide",
            "days",
        },
        "day": {"month", "day", "readings"},
    },
    "tidal_secondary": {
        "station": {
            "name", "index_no", "latitude", "longitude", "reference_port",
            "higher_high_water_time_diff",
            "higher_high_water_mean_tide_diff",
            "higher_high_water_large_tide_diff",
            "lower_low_water_time_diff",
            "lower_low_water_mean_tide_diff",
            "lower_low_water_large_tide_diff",
        },
    },
    "current_primary": {
        "station": {
            "name", "index_no", "year", "utc_offset",
            "latitude", "longitude",
            "flood_direction_true", "ebb_direction_true",
            "max_flood_knots", "max_ebb_knots",
            "days",
        },
        "day": {"month", "day", "events"},
    },
    "current_secondary": {
        "station": {
            "name", "index_no", "latitude", "longitude",
            "reference_primary", "offsets_from_tides",
            "flood_direction_true",
            "turn_to_flood_diff", "turn_to_ebb_diff",
            "flood_max_diff", "ebb_max_diff",
            "pct_ref_flood", "pct_ref_ebb",
            "max_flood_knots", "max_ebb_knots",
        },
    },
    "noaa_tidal_primary": {
        "station": {
            "name", "NOAA_station_name",
            "utc_offset", "year", "noaa_id",
            "latitude", "longitude", "US_secondary",
            "days",
        },
        "day": {"month", "day", "readings"},
    },
    "noaa_current_primary": {
        "station": {
            "name", "NOAA_station_name",
            "utc_offset", "year",
            "flood_direction_true", "ebb_direction_true",
            "noaa_id", "noaa_bin",
            "latitude", "longitude",
            "max_flood_knots", "max_ebb_knots", "US_secondary",
            "days",
        },
        "day": {"month", "day", "events"},
    },
}


def _strip_event_defaults(e: dict) -> dict:
    """Per-event omit-when-default. Today: drop `weak_variable` whenever
    it's False. ~99% of all current events have weak_variable=False (per
    analyze_field_frequency.py 2026), so this is the single biggest
    pre-gzip shrink available. The loader treats a missing field as
    False (CurrentEvent.weak_variable is now optional)."""
    if e.get("weak_variable") is False:
        return {k: v for k, v in e.items() if k != "weak_variable"}
    return e


def strip_for_publish(data: dict, stem: str) -> dict:
    """Return a copy of `data` retaining only fields the webapp reads,
    plus per-event omit-when-default for high-frequency values."""
    spec = _PUBLISH_KEEP.get(stem)
    if not spec:
        return data
    station_keep = spec["station"]
    day_keep = spec.get("day")
    out_stations: list[dict] = []
    for s in data.get("stations", []):
        new_s = {k: v for k, v in s.items() if k in station_keep}
        if day_keep and "days" in new_s:
            new_days: list[dict] = []
            for d in new_s["days"]:
                new_d = {k: v for k, v in d.items() if k in day_keep}
                if "events" in new_d:
                    new_d["events"] = [_strip_event_defaults(e) for e in new_d["events"]]
                new_days.append(new_d)
            new_s["days"] = new_days
        out_stations.append(new_s)
    return {"year": data.get("year"), "stations": out_stations}


@dataclass
class YearEntry:
    year: int
    files: dict[str, str]                # kind → relative path under data dir
    first_extreme_utc: str | None
    last_extreme_utc: str | None


def ingest(source: Path, data_dir: Path, year: int) -> None:
    """Strip parser outputs to publish-only fields and write into
    data_dir/{year}/ with content-hashed names. Idempotent: same source
    content → same stripped bytes → same hash → same filename → no-op.
    Stale siblings of the same kind are removed.

    Parser outputs at `source` are left untouched. The stripped, compact
    form is what the webapp downloads and parses; allowlists live in
    `_PUBLISH_KEEP` above."""
    dest_dir = data_dir / str(year)
    dest_dir.mkdir(parents=True, exist_ok=True)

    found_any = False
    for kind in KINDS:
        src = source / kind.source_template.format(year=year)
        if not src.exists():
            continue
        found_any = True
        data = json.loads(src.read_text())
        stripped = strip_for_publish(data, kind.stem)
        # Compact serialisation: no indents, no key spacing. The published
        # file isn't human-edited, and gzip on top of compact JSON beats
        # gzip on indented JSON by a meaningful margin.
        body = json.dumps(stripped, separators=(",", ":")).encode("utf-8")
        h = hashlib.sha256(body).hexdigest()[:8]
        target_name = f"{kind.stem}.{h}.json"
        target = dest_dir / target_name

        if not target.exists():
            target.write_bytes(body)
            print(f"  + {target.relative_to(data_dir)}  ({len(body):,} bytes)")

        for sibling in dest_dir.glob(f"{kind.stem}.*.json"):
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
            if stem not in KIND_STEMS:
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
