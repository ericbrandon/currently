#!/usr/bin/env python3
"""Walk every parser-output JSON for a year and report value-frequency per
field. The point is to surface fields whose value is the same most of the
time — those are candidates for omit-if-default at publish time, with the
loader filling in the default when the field is absent.

Run: python3 analyze_field_frequency.py --year 2026
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

# (publish-stem, source-filename-template). Same shape as KINDS in
# build_manifest.py — kept here standalone so the script is independent.
SOURCES = [
    ("tidal_primary",        "{year}_tct_tidal_primary_stations.json"),
    ("tidal_secondary",      "{year}_tct_tidal_secondary_stations.json"),
    ("current_primary",      "{year}_tct_current_primary_stations.json"),
    ("current_secondary",    "{year}_tct_current_secondary_stations.json"),
    ("noaa_tidal_primary",   "{year}_noaa_tidal_primary_stations.json"),
    ("noaa_current_primary", "{year}_noaa_current_primary_stations.json"),
]


def hashable(v):
    """Make any JSON value hashable for Counter keys."""
    if isinstance(v, (dict, list)):
        return json.dumps(v, sort_keys=True)
    return v


def report(label: str, counters: dict[str, Counter], n_total: int) -> None:
    if not counters:
        return
    print(f"\n=== {label}  (n={n_total:,}) ===")
    # Field order: most-skewed first (highest top-value share).
    rows = []
    for field, c in counters.items():
        if not c:
            continue
        top_val, top_cnt = c.most_common(1)[0]
        share = top_cnt / n_total
        rows.append((share, field, top_val, top_cnt, c))
    rows.sort(key=lambda r: -r[0])
    for share, field, top_val, top_cnt, c in rows:
        n_values = len(c)
        if share >= 0.95:
            tag = "★"   # strong default candidate
        elif share >= 0.80:
            tag = "○"
        else:
            tag = " "
        # Show the top three values for context.
        top3 = ", ".join(f"{v!r}={n}" for v, n in c.most_common(3))
        print(f"  {tag} {field:35s}  top={share*100:5.1f}%  values={n_values:4d}  [{top3}]")


def analyze_station_level(stations: list[dict]) -> tuple[dict[str, Counter], int]:
    """Counter per station-level field (everything except `days` since
    those are arrays we walk separately)."""
    fields: dict[str, Counter] = {}
    for s in stations:
        for k, v in s.items():
            if k == "days":
                continue
            fields.setdefault(k, Counter())[hashable(v)] += 1
    return fields, len(stations)


def analyze_day_level(stations: list[dict]) -> tuple[dict[str, Counter], int]:
    fields: dict[str, Counter] = {}
    n = 0
    for s in stations:
        for d in s.get("days", []):
            n += 1
            for k, v in d.items():
                if k in ("readings", "events"):
                    continue
                fields.setdefault(k, Counter())[hashable(v)] += 1
    return fields, n


def analyze_event_level(stations: list[dict], event_key: str) -> tuple[dict[str, Counter], int]:
    fields: dict[str, Counter] = {}
    n = 0
    for s in stations:
        for d in s.get("days", []):
            for e in d.get(event_key, []):
                n += 1
                for k, v in e.items():
                    fields.setdefault(k, Counter())[hashable(v)] += 1
    return fields, n


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--year", type=int, required=True)
    ap.add_argument("--dir", type=Path, default=Path("."))
    args = ap.parse_args()

    for stem, tmpl in SOURCES:
        path = args.dir / tmpl.format(year=args.year)
        if not path.exists():
            print(f"\n##### {stem}: file not found ({path.name})")
            continue
        data = json.loads(path.read_text())
        stations = data.get("stations", [])
        print(f"\n\n##### {stem}  ({path.name})")
        print(f"##### {len(stations)} stations")

        sf, sn = analyze_station_level(stations)
        report("station fields", sf, sn)

        df, dn = analyze_day_level(stations)
        report("day fields", df, dn)

        # Tide files have readings, current files have events.
        if any("readings" in d for s in stations for d in s.get("days", [])):
            ef, en = analyze_event_level(stations, "readings")
            report("reading fields", ef, en)
        if any("events" in d for s in stations for d in s.get("days", [])):
            ef, en = analyze_event_level(stations, "events")
            report("event fields", ef, en)


if __name__ == "__main__":
    main()
