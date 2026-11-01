#!/usr/bin/env python3
"""Compare a year's printed-table parse (read_tct.py) against the IWLS API
fetch (fetch_iwls.py), station by station and event by event.

    venv/bin/python canada_data/compare_iwls_tct.py --year 2027

For every tide and current primary present in both files it reports:
  - event counts on each side
  - how many events pair up at the same UTC minute, and the |dt| histogram
    for the ones that do not
  - how many paired events agree in value after rounding the IWLS value to
    the book's precision (0.1 m / 0.1 kn, sign included) and, for currents,
    in kind (slack / max / weak-variable)
  - metadata differences: coordinates (km), tidal heights, flood/ebb dirs
and exits non-zero if any station has unpaired events or value mismatches
beyond --tolerance (default 0, i.e. identical).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import sys
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def utc(year: int, month: int, day: int, hhmm: str, offset: int) -> dt.datetime:
    hh, mm = map(int, hhmm.split(":"))
    return dt.datetime(year, month, day, tzinfo=dt.timezone.utc) + dt.timedelta(hours=hh - offset, minutes=mm)


def tide_events(s: dict) -> list[tuple[dt.datetime, float, str]]:
    out = []
    for d in s["days"]:
        for r in d["readings"]:
            out.append((utc(s["year"], d["month"], d["day"], r["time"], s["utc_offset"]), r["metres"], "hl"))
    return sorted(out)


def current_events(s: dict) -> list[tuple[dt.datetime, float, str]]:
    out = []
    for d in s["days"]:
        for e in d["events"]:
            kind = "weak" if e.get("weak_variable") else e["kind"]
            out.append((utc(s["year"], d["month"], d["day"], e["time"], s["utc_offset"]), e.get("knots", 0.0), kind))
    return sorted(out)


def round_half_up(x: float, nd: int = 1) -> float:
    """CHS tables round half away from zero; Python's round() is banker's."""
    q = 10 ** nd
    return math.copysign(math.floor(abs(x) * q + 0.5) / q, x) + 0.0


def pair(a: list, b: list, max_dt_min: int = 30):
    """Greedy nearest-time pairing within max_dt_min. Returns pairs and leftovers."""
    used_b: set[int] = set()
    pairs = []
    j = 0
    for i, ea in enumerate(a):
        best = None
        best_d = None
        k = j
        while k < len(b):
            d = (b[k][0] - ea[0]).total_seconds() / 60
            if d > max_dt_min:
                break
            if k not in used_b and abs(d) <= max_dt_min and (best_d is None or abs(d) < best_d):
                best, best_d = k, abs(d)
            k += 1
        if best is not None:
            used_b.add(best)
            pairs.append((i, best))
            while j < len(b) and (j in used_b or (b[j][0] - ea[0]).total_seconds() / 60 < -max_dt_min):
                j += 1
    left_a = [i for i in range(len(a)) if i not in {p[0] for p in pairs}]
    left_b = [k for k in range(len(b)) if k not in used_b]
    return pairs, left_a, left_b


def km(lat1, lon1, lat2, lon2) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


HEIGHT_FIELDS = ["higher_high_water_large_tide", "higher_high_water_mean_tide",
                 "lower_low_water_mean_tide", "lower_low_water_large_tide", "mean_water_level",
                 "highest_recorded_high_water", "lowest_recorded_low_water"]


def compare_kind(kind: str, tct: dict, iwls: dict, extractor, tolerance: float,
                 show: int) -> tuple[int, list[str]]:
    """Returns (number of stations with problems, report lines)."""
    lines = [f"\n==== {kind}: book {len(tct)} stations, IWLS {len(iwls)} stations"]
    problems = 0
    only_book = sorted(set(tct) - set(iwls))
    only_iwls = sorted(set(iwls) - set(tct))
    if only_book:
        lines.append(f"  only in book: {only_book}")
    if only_iwls:
        lines.append(f"  only in IWLS: {only_iwls}")
    hdr = f"  {'idx':>5} {'name':<24} {'book':>5} {'iwls':>5} {'same-min':>8} {'|dt|>0':>6} {'val≠':>5} {'kind≠':>5} {'unpaired':>8}  notes"
    lines.append(hdr)
    for code in sorted(set(tct) & set(iwls)):
        a, b = tct[code], iwls[code]
        ea, eb = extractor(a), extractor(b)
        pairs, la, lb = pair(ea, eb)
        same_min = sum(1 for i, k in pairs if ea[i][0] == eb[k][0])
        dts = Counter()
        val_bad = []
        kind_bad = []
        for i, k in pairs:
            d = int(abs((eb[k][0] - ea[i][0]).total_seconds()) // 60)
            if d:
                dts[d] += 1
            va, vb = ea[i][1], round_half_up(eb[k][1], 1)
            if abs(va - vb) > tolerance + 1e-9:
                val_bad.append((ea[i][0], va, eb[k][1], ea[i][2], eb[k][2]))
            if ea[i][2] != eb[k][2]:
                kind_bad.append((ea[i][0], ea[i][2], eb[k][2], ea[i][1], eb[k][1]))
        notes = []
        # metadata
        dk = km(a["latitude"], a["longitude"], b["latitude"], b["longitude"])
        if dk > 0.05:
            notes.append(f"coords Δ{dk:.2f}km")
        for f in HEIGHT_FIELDS:
            if f in a and f in b and abs(a[f] - round_half_up(b[f], 1)) > 1e-9:
                notes.append(f"{f.replace('_', ' ')}: book {a[f]} iwls {b[f]}")
        for f in ("flood_direction_true", "ebb_direction_true"):
            if f in a and f in b and a[f] != b[f]:
                notes.append(f"{f}: book {a[f]} iwls {b[f]}")
        bad = bool(la or lb or val_bad or kind_bad or dts)
        if bad:
            problems += 1
        lines.append(f"  {code:>5} {a['name'][:24]:<24} {len(ea):>5} {len(eb):>5} {same_min:>8} {sum(dts.values()):>6} "
                     f"{len(val_bad):>5} {len(kind_bad):>5} {len(la) + len(lb):>8}  {'; '.join(notes)}")
        if dts:
            lines.append(f"        |dt| minutes histogram: {dict(sorted(dts.items()))}")
        for t, va, vb, ka, kb in val_bad[:show]:
            lines.append(f"        value  {t:%m-%d %H:%M}Z book {va:+.1f} ({ka})  iwls {vb:+.3f} ({kb})")
        for t, ka, kb, va, vb in kind_bad[:show]:
            lines.append(f"        kind   {t:%m-%d %H:%M}Z book {ka} {va:+.1f}  iwls {kb} {vb:+.3f}")
        for i in la[:show]:
            lines.append(f"        book-only {ea[i][0]:%m-%d %H:%M}Z {ea[i][1]:+.1f} ({ea[i][2]})")
        for k in lb[:show]:
            lines.append(f"        iwls-only {eb[k][0]:%m-%d %H:%M}Z {eb[k][1]:+.3f} ({eb[k][2]})")
    return problems, lines


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--year", type=int, required=True)
    ap.add_argument("--source", type=Path, default=REPO_ROOT)
    ap.add_argument("--tolerance", type=float, default=0.0, help="Allowed |book - round(iwls)| (default 0)")
    ap.add_argument("--show", type=int, default=5, help="Mismatch examples per station")
    args = ap.parse_args()

    def load(name: str) -> dict[int, dict]:
        p = args.source / name
        if not p.exists():
            raise SystemExit(f"missing {p}")
        out: dict[int, dict] = {}
        for s in json.loads(p.read_text())["stations"]:
            out.setdefault(s["index_no"], s)
        return out

    y = args.year
    total = 0
    report: list[str] = [f"compare_iwls_tct: year {y}"]
    p, l = compare_kind("tide primaries", load(f"{y}_tct_tidal_primary_stations.json"),
                        load(f"{y}_iwls_tidal_primary_stations.json"), tide_events, args.tolerance, args.show)
    total += p
    report += l
    p, l = compare_kind("current primaries", load(f"{y}_tct_current_primary_stations.json"),
                        load(f"{y}_iwls_current_primary_stations.json"), current_events, args.tolerance, args.show)
    total += p
    report += l
    report.append(f"\n{total} station(s) with differences")
    print("\n".join(report))
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main())
