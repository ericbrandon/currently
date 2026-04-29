#!/usr/bin/env python3
"""seed_geonames_overrides.py — one-shot helper that queries the Canadian
Geographical Names Database (CGNDB) via the geogratis GeoJSON API and
appends overrides into coord_overrides.json for stations that are not yet
covered by a manual override or the IWLS seeder.

Backstop source for the secondary current stations (and a chunk of
secondary tide stations) that don't appear in the CHS station inventory
CSV at usable precision or in the IWLS catalog. Their names — SANSUM
NARROWS, OKISOLLO CHANNEL, MALIBU RAPIDS, etc. — match named features in
CGNDB, which publishes representative points and feature outlines.

Like seed_iwls_overrides.py, this is NOT part of the per-build pipeline.
Run by hand once now, and again after a new PDF year is processed.
Existing entries (manual or previously-seeded) are never overwritten.

Algorithm per station:
  1. Skip if already in coord_overrides.json (manual or any seeder).
  2. Query the API for the station name, filtered to BC (province=59).
     Strip parenthetical fragments and trailing punctuation first.
     If no hits, try simple abbreviation expansions (I.→ISLAND,
     PT.→POINT) and a last-two-words fallback for compound names like
     'PRINCESS LOUISA INLET MALIBU RAPIDS'.
  3. From candidate features, take a representative point — the
     published rep-point for Point/MultiPoint geometries, or a
     vertex-average centroid for Polygon/MultiPolygon. Skip linear-only
     geometry; CHS gauges aren't usefully placed at a centroid of a
     linestring.
  4. Hard-reject any candidate whose `concise` code isn't a water
     feature (CHAN, BAY, RAP, SEAF, MAR). Capes, islands, towns,
     settlements, parks, military ranges, Indian reserves all share
     names with gauge stations but their centroids put the marker on
     land; we'd rather keep the rounded PDF coord than seed an
     actively-wrong land coord. Pick the surviving candidate closest
     to the PDF.
  5. Accept if the chosen point is within the per-geometry threshold
     (10 km for points, 5 km for polygon centroids); reject anything
     farther (almost always a same-name collision elsewhere).
  6. Skip if the chosen point is within MIN_OFFSET_M of the PDF (the
     override would be a no-op move).

See notes/tables_processing.md for context.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

KINDS = ["tidal_primary", "tidal_secondary", "current_primary", "current_secondary"]
API_URL = "https://geogratis.gc.ca/services/geoname/en/geonames.geojson"
BC_PROVINCE_CODE = "59"

MIN_OFFSET_M = 100

# Tight bound on accepted offset between CGNDB position and PDF coord —
# large offsets almost always mean a same-name collision elsewhere in
# the province. Two thresholds because polygon centroids drift further
# from the gauge than published rep-points: a 30 km channel's centroid
# can be ~15 km from any plausible gauge location, and seeding that
# would actually be worse than keeping the rounded PDF coord.
MAX_OFFSET_KM_POINT = 10.0
MAX_OFFSET_KM_POLYGON = 5.0

# Tide and current gauges both sit in (or right at the edge of) water,
# so we restrict to water-class features. A land-feature centroid puts
# the marker on the cape/island/town itself even when the station's
# name matches that feature — visibly wrong on a map even for tide
# stations. Capes named after the adjacent passage are the worst trap
# for currents (BEAR POINT, CAMP POINT, PULTENEY POINT — gauge is in
# the water beside the cape, not on it); the same is true at smaller
# scale for tide stations matched to a CAPE / TOWN / ISL / UNP, where
# the actual gauge is just offshore in a bay or harbour. We'd rather
# keep the rounded PDF coord than seed an actively-wrong land coord.
WATER_CONCISE = {"CHAN", "BAY", "RAP", "SEAF", "MAR"}


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def representative_point(geom: dict) -> tuple[tuple[float, float], str] | None:
    """Return ((lon, lat), source_label) for a feature, or None if the
    geometry can't be reduced to a single useful point.

    Point/MultiPoint → CGNDB-published representative point (best).
    Polygon/MultiPolygon → outer-ring vertex average (acceptable for
      small features; offset threshold filters out long-channel cases
      where the centroid drifts far from any plausible gauge spot).
    LineString/MultiLineString → skipped; a centroid of a coastline
      segment doesn't correspond to anything we can pin a gauge to."""
    t = geom.get("type")
    c = geom.get("coordinates")
    if t == "Point":
        return ((c[0], c[1]), "Point")
    if t == "MultiPoint" and c:
        lon = sum(p[0] for p in c) / len(c)
        lat = sum(p[1] for p in c) / len(c)
        return ((lon, lat), "MultiPoint")
    if t == "Polygon" and c:
        ring = c[0]
        lon = sum(p[0] for p in ring) / len(ring)
        lat = sum(p[1] for p in ring) / len(ring)
        return ((lon, lat), "Polygon")
    if t == "MultiPolygon" and c:
        pts = [p for poly in c for p in poly[0]]
        lon = sum(p[0] for p in pts) / len(pts)
        lat = sum(p[1] for p in pts) / len(pts)
        return ((lon, lat), "MultiPolygon")
    return None


def clean_query(name: str) -> str:
    q = name.split("(")[0]
    q = re.sub(r"[\.,;:]+$", "", q.strip()).strip()
    return q


def fallback_queries(name: str) -> list[str]:
    """Generate alternative queries to try if the first cleaned name
    returns nothing. Order: most-specific first."""
    out: list[str] = []
    base = clean_query(name)

    # Abbreviation expansions seen in the parser output.
    expanded = re.sub(r"\bI\.", "ISLAND", base)
    expanded = re.sub(r"\bIS\.", "ISLAND", expanded)
    expanded = re.sub(r"\bPT\.?\b", "POINT", expanded)
    expanded = re.sub(r"\s+", " ", expanded).strip()
    if expanded != base:
        out.append(expanded)

    # Compound names like 'PRINCESS LOUISA INLET MALIBU RAPIDS' — the
    # specific feature is the last 2 words; the rest is qualifier.
    words = base.split()
    if len(words) >= 4:
        out.append(" ".join(words[-2:]))

    return out


def fetch_features(query: str) -> list[dict]:
    url = f"{API_URL}?q={urllib.parse.quote_plus(query)}&province={BC_PROVINCE_CODE}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read())
    return data.get("features", [])


def best_candidate(
    features: list[dict], pdf_lat: float, pdf_lon: float
) -> tuple[tuple[float, float], dict, float, str] | None:
    """Among features, pick the closest water-class candidate to the
    PDF coord. Hard-rejects features whose `concise` code isn't in
    WATER_CONCISE (capes, islands, towns, settlements — see comment on
    that constant). Returns ((lon, lat), props, km, geom_label) or
    None."""
    candidates: list[tuple[float, tuple[float, float], dict, str]] = []
    for f in features:
        rp = representative_point(f.get("geometry", {}))
        if rp is None:
            continue
        props = f.get("properties", {})
        if props.get("concise") not in WATER_CONCISE:
            continue
        (lon, lat), label = rp
        d = haversine_km(pdf_lat, pdf_lon, lat, lon)
        candidates.append((d, (lon, lat), props, label))
    if not candidates:
        return None
    candidates.sort(key=lambda r: r[0])
    d, pt, props, label = candidates[0]
    return (pt, props, d, label)


def resolve_one(name: str, pdf_lat: float, pdf_lon: float, sleep: float
                ) -> tuple[str, list[dict], tuple[tuple[float, float], dict, float, str] | None]:
    """Try the cleaned name first, then fallback queries until one
    returns a feature. Returns (query_used, features, best_or_none)."""
    queries = [clean_query(name), *fallback_queries(name)]
    seen: set[str] = set()
    for q in queries:
        if not q or q in seen:
            continue
        seen.add(q)
        feats = fetch_features(q)
        time.sleep(sleep)
        if feats:
            return (q, feats, best_candidate(feats, pdf_lat, pdf_lon))
    return (queries[0] if queries else name, [], None)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--year", type=int, required=True,
                    help="Year whose parsed JSONs to use as the station roster")
    ap.add_argument("--source", type=Path, default=Path("."),
                    help="Directory holding the parser output JSONs (default: cwd)")
    ap.add_argument("--overrides", type=Path, default=Path("coord_overrides.json"),
                    help="Override file to append to (default: ./coord_overrides.json)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print proposed overrides; do not write the file.")
    ap.add_argument("--sleep", type=float, default=0.15,
                    help="Seconds to sleep between API calls (default: 0.15)")
    args = ap.parse_args()

    overrides_raw = json.loads(args.overrides.read_text()) if args.overrides.exists() else {}
    existing_keys = {k for k in overrides_raw if not k.startswith("_")}
    print(f"Existing entries in {args.overrides.name}: {len(existing_keys)} (preserved as-is)")

    # idx → (kind, name, query, lon, lat, km, cgndb_name, concise, geom_label)
    added: dict[int, tuple[str, str, str, float, float, float, str, str, str]] = {}
    rejected_far: list[tuple[str, int, str, str, float, str, str, str, float]] = []
    rejected_no_geom: list[tuple[str, int, str, int]] = []
    no_results: list[tuple[str, int, str, str]] = []
    rejected_close: list[tuple[str, int, str, float]] = []
    counts = {kind: {"add": 0, "exists": 0, "dupe": 0, "no_results": 0,
                     "no_geom": 0, "too_far": 0, "close": 0} for kind in KINDS}

    for kind in KINDS:
        path = args.source / f"{args.year}_tct_{kind}_stations.json"
        if not path.exists():
            print(f"  {kind}: (no input file at {path})")
            continue
        for s in json.loads(path.read_text())["stations"]:
            idx = s.get("index_no")
            lat, lon = s.get("latitude"), s.get("longitude")
            name = s.get("name", "?")
            if idx is None or lat is None or lon is None:
                continue
            if str(idx) in existing_keys:
                counts[kind]["exists"] += 1
                continue
            if idx in added:
                counts[kind]["dupe"] += 1
                continue

            try:
                query, feats, best = resolve_one(name, lat, lon, args.sleep)
            except Exception as e:
                print(f"  ! {kind} {idx} {name!r}: API error {e}")
                continue

            if not feats:
                counts[kind]["no_results"] += 1
                no_results.append((kind, idx, name, query))
                continue

            if best is None:
                counts[kind]["no_geom"] += 1
                rejected_no_geom.append((kind, idx, name, len(feats)))
                continue

            (clon, clat), props, dkm, geom_label = best
            limit = MAX_OFFSET_KM_POLYGON if geom_label.endswith("Polygon") else MAX_OFFSET_KM_POINT
            if dkm > limit:
                counts[kind]["too_far"] += 1
                rejected_far.append((kind, idx, name, query, dkm,
                                     props.get("name", "?"), props.get("concise", "?"),
                                     geom_label, limit))
                continue
            if dkm * 1000 < MIN_OFFSET_M:
                counts[kind]["close"] += 1
                rejected_close.append((kind, idx, name, dkm))
                continue

            counts[kind]["add"] += 1
            added[idx] = (kind, name, query, clon, clat, dkm,
                          props.get("name", "?"), props.get("concise", "?"), geom_label)

    print()
    print(f"  {'kind':18s} {'add':>4s} {'existing':>9s} {'dupe':>5s} {'no-results':>11s} "
          f"{'no-geom':>8s} {'too-far':>8s} {'close':>6s}")
    for kind in KINDS:
        c = counts[kind]
        print(f"  {kind:18s} {c['add']:4d} {c['exists']:9d} {c['dupe']:5d} {c['no_results']:11d} "
              f"{c['no_geom']:8d} {c['too_far']:8d} {c['close']:6d}")
    print(f"\nProposed: {len(added)} new geonames-seeded overrides.")

    if added:
        print(f"\n{'kind':18s} {'idx':>5s}  {'station':<32s}  {'cgndb':<28s} {'concise':<7s} "
              f"{'geom':<13s} {'Δ km':>6s}")
        for idx in sorted(added):
            kind, name, q, clon, clat, dkm, cname, cc, gl = added[idx]
            print(f"{kind:18s} {idx:5d}  {name[:32]:<32s}  {cname[:28]:<28s} "
                  f"{cc:<7s} {gl:<13s} {dkm:6.2f}")

    if rejected_far:
        print(f"\nRejected — closest CGNDB hit beyond per-geometry threshold "
              f"(point: {MAX_OFFSET_KM_POINT:.0f} km, polygon: {MAX_OFFSET_KM_POLYGON:.0f} km — "
              f"polygon centroids of long features drift far from any plausible gauge spot):")
        for kind, idx, name, q, dkm, cname, cc, gl, lim in sorted(rejected_far, key=lambda r: r[1]):
            print(f"  {kind:18s} {idx:5d}  {name[:30]:<30s}  best={cname[:25]:<25s} "
                  f"[{cc}] {gl:<13s} Δ={dkm:6.2f} km (limit {lim:.0f})")

    if rejected_no_geom:
        print("\nRejected — feature(s) found but no usable point candidate "
              "(linear-only geometry, or — for current stations — only land features "
              "like CAPE/ISL/UNP that fail the water-class filter); needs manual:")
        for kind, idx, name, n in sorted(rejected_no_geom, key=lambda r: r[1]):
            print(f"  {kind:18s} {idx:5d}  {name[:30]:<30s}  ({n} feature(s))")

    if no_results:
        print("\nRejected — no CGNDB hit at all (likely outside BC, or the name doesn't match a CGNDB feature):")
        for kind, idx, name, q in sorted(no_results, key=lambda r: r[1]):
            print(f"  {kind:18s} {idx:5d}  {name[:30]:<30s}  query={q!r}")

    if not added:
        print("\nNothing to write.")
        return

    if args.dry_run:
        print("\n--dry-run: not modifying coord_overrides.json")
        return

    if "_block_geonames_seeded" not in overrides_raw:
        overrides_raw["_block_geonames_seeded"] = (
            f"Bulk-seeded from {API_URL} (Canadian Geographical Names Database, "
            f"province={BC_PROVINCE_CODE}=BC) by seed_geonames_overrides.py — do not edit by hand. "
            f"Backstop for stations not in the CHS station inventory CSV at usable precision or in "
            f"the IWLS catalog. Re-run after a new PDF year is processed. "
            f"See notes/tables_processing.md."
        )
    for idx in sorted(added):
        kind, name, q, clon, clat, dkm, cname, cc, gl = added[idx]
        overrides_raw[str(idx)] = [round(clon, 6), round(clat, 6)]

    args.overrides.write_text(json.dumps(overrides_raw, indent=2, ensure_ascii=False) + "\n")
    print(f"\nWrote {args.overrides} (+{len(added)} entries).")


if __name__ == "__main__":
    main()
