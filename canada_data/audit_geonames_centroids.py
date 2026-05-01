#!/usr/bin/env python3
"""Diagnostic: find geonames-seeded stations whose vertex-average
centroid falls *outside* its CGNDB polygon. That's the OKISOLLO
horseshoe signature — concave/U-shaped water features whose centroid
lands on land while staying within the seeder's offset threshold.

Not part of the build. Run by hand to surface candidates for manual
override.
"""

from __future__ import annotations

import json
import math
import time
import urllib.parse
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent

KINDS = ["tidal_primary", "tidal_secondary", "current_primary", "current_secondary"]
API = "https://geogratis.gc.ca/services/geoname/en/geonames.geojson"
WATER = {"CHAN", "BAY", "RAP", "SEAF", "MAR"}


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def point_in_ring(lon, lat, ring):
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > lat) != (yj > lat)) and (lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def point_in_geom(lon, lat, geom):
    t = geom["type"]
    c = geom["coordinates"]
    if t == "Polygon":
        return point_in_ring(lon, lat, c[0])
    if t == "MultiPolygon":
        return any(point_in_ring(lon, lat, poly[0]) for poly in c)
    return None


def fetch(name):
    url = f"{API}?q={urllib.parse.quote_plus(name)}&province=59"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read()).get("features", [])


def best_water_polygon(features, lat, lon):
    best = None
    best_d = None
    for f in features:
        g = f.get("geometry", {})
        t = g.get("type")
        if t not in ("Polygon", "MultiPolygon"):
            continue
        p = f.get("properties", {})
        if p.get("concise") not in WATER:
            continue
        c = g["coordinates"]
        if t == "Polygon":
            ring = c[0]
        else:
            ring = [pt for poly in c for pt in poly[0]]
        clon = sum(pt[0] for pt in ring) / len(ring)
        clat = sum(pt[1] for pt in ring) / len(ring)
        d = haversine_km(lat, lon, clat, clon)
        if best is None or d < best_d:
            best = (g, p, clon, clat, d)
            best_d = d
    return best


def main():
    overrides_path = REPO_ROOT / "coord_overrides.json"
    overrides = json.loads(overrides_path.read_text())
    # geonames-seeded keys come after the _block_geonames_seeded marker
    raw = overrides_path.read_text().splitlines()
    in_block = False
    seeded_keys = set()
    for line in raw:
        if "_block_geonames_seeded" in line:
            in_block = True
            continue
        if in_block and '"_block' in line:
            in_block = False
            continue
        if in_block:
            stripped = line.strip()
            if stripped.startswith('"') and ":" in stripped:
                k = stripped.split('"')[1]
                if not k.startswith("_"):
                    seeded_keys.add(k)

    # Build idx -> (kind, name) map from parser JSONs
    idx_meta = {}
    for kind in KINDS:
        path = REPO_ROOT / f"2026_tct_{kind}_stations.json"
        if not path.exists():
            continue
        for s in json.loads(path.read_text())["stations"]:
            idx_meta[str(s["index_no"])] = (kind, s["name"])

    print(f"Auditing {len(seeded_keys)} geonames-seeded stations for outside-polygon centroids...")
    print()
    suspect = []
    skipped_pointlike = 0
    for k in sorted(seeded_keys, key=int):
        if k not in idx_meta:
            continue
        kind, name = idx_meta[k]
        seeded = overrides[k]
        seed_lon, seed_lat = seeded[0], seeded[1]
        try:
            feats = fetch(name.split("(")[0].strip())
        except Exception as e:
            print(f"  ! {k} {name}: API error {e}")
            continue
        time.sleep(0.15)
        if not feats:
            continue
        best = best_water_polygon(feats, seed_lat, seed_lon)
        if best is None:
            skipped_pointlike += 1
            continue
        geom, props, clon, clat, d_to_seed = best
        # Sanity: the polygon we just found should match the seeded coord
        # (within a few meters) — if not, the seeder picked a different
        # candidate or used a Point geom and we can't audit.
        if d_to_seed > 0.2:
            skipped_pointlike += 1
            continue
        inside = point_in_geom(clon, clat, geom)
        if inside is False:
            suspect.append((k, kind, name, props.get("name"), props.get("concise"),
                            geom["type"], clon, clat))

    print(f"\nPolygon-derived seeds where centroid is OUTSIDE the polygon ({len(suspect)} suspect):")
    print(f"  {'idx':>5s}  {'kind':18s}  {'name':32s}  {'cgndb':28s} {'concise':<7s} {'geom':<13s}  {'centroid':>22s}")
    for k, kind, name, cname, cc, gt, clon, clat in suspect:
        print(f"  {k:>5s}  {kind:18s}  {name[:32]:32s}  {cname[:28]:28s} {cc:<7s} {gt:<13s}  {clat:8.4f},{clon:9.4f}")
    print(f"\nSkipped (Point/MultiPoint seeds, or polygon-mismatch): {skipped_pointlike}")


if __name__ == "__main__":
    main()
