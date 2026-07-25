#!/usr/bin/env python3
"""Extract ECCC marine forecast sub-zone polygons for the webapp.

Reads the `water_MarSubZone_hybrid_unproj` layer from the MSC Geography
Package (the official boundary geometry for marine forecast sub-locations),
filters it to the sub-zones covering the app's map area, and writes
web/public/data/marine_zones.geojson.

The polygons are static, versioned data (package v6.15.0 as of 2026-07);
re-run this script only when ECCC publishes a new geography package version.
The 40 MB source zip is cached in canada_data/marine_zones_raw/ (gitignored).

Each output feature carries:
  clc        zone code, joins to ECCC location metadata
  site_code  Datamart/GeoMet site id (m00000xx) of the PARENT forecast area —
             the id of the matching feature in the marineweather-realtime
             OGC API collection
  name_en    English sub-zone name; exactly matches the API's
             warnings.locations[].name.en
  nom_fr     French sub-zone name; matches the API's French-only
             regularForecast.locations[].name (see notes/weather_plan.md §1.1)
  label_lon / label_lat
             pole-of-inaccessibility point for the map warning badge
             (true centroids fall outside concave zones)
  color      0/1/2 — map tint index, greedy 3-colouring of the zone
             adjacency graph so no two touching zones share a colour

Validates before writing: geometry validity, zero pairwise overlap,
label points inside their polygon, expected zone set complete.
"""

from __future__ import annotations

import io
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

import shapefile  # pyshp
from shapely.geometry import Polygon, mapping, shape
from shapely.ops import polylabel, unary_union

PKG_VERSION = "6_15_0"
PKG_URL = (
    "https://dd.weather.gc.ca/today/meteocode/geodata/"
    f"version_{PKG_VERSION.replace('_', '.')}/"
    f"MSC_Geography_Pkg_V{PKG_VERSION}_Water_Unproj.zip"
)
LAYER = "water_MarSubZone_hybrid_unproj"
# Whole-area layer, used only for zones whose sub-zones don't tile (Queen
# Charlotte Sound's four "halves" pairwise overlap — north/south and
# east/west are alternative splits of the same water, not a partition).
STD_LAYER = "water_MarStdZone_hybrid_unproj"

ROOT = Path(__file__).resolve().parent
CACHE_DIR = ROOT / "marine_zones_raw"
CACHE_ZIP = CACHE_DIR / f"MSC_Geography_Pkg_V{PKG_VERSION}_Water_Unproj.zip"
OUT_PATH = ROOT.parent / "web" / "public" / "data" / "marine_zones.geojson"

# Sub-zones covering the app's map area, CLC -> parent forecast-area site
# code in the marineweather-realtime collection (verified live 2026-07-24).
# One bbox fetch of that collection returns exactly these six parent areas.
ZONES: dict[str, str] = {
    "001111": "m0000009",  # Juan de Fuca Strait - east entrance
    "001112": "m0000009",  # Juan de Fuca Strait - central strait
    "001113": "m0000009",  # Juan de Fuca Strait - west entrance
    "001120": "m0000064",  # Haro Strait
    "001131": "m0000028",  # Strait of Georgia - north of Nanaimo
    "001132": "m0000028",  # Strait of Georgia - south of Nanaimo
    "001140": "m0000102",  # Howe Sound
    "001150": "m0000010",  # Johnstone Strait
    "001160": "m0000112",  # Queen Charlotte Strait
    "001170": "m0000043",  # West Coast Vancouver Island North
    "001180": "m0000065",  # West Coast Vancouver Island South
    "001220": "m0000140",  # Central Coast from McInnes Island to Pine Island
}

# Zones taken from STD_LAYER as one whole polygon (see note there).
STD_ZONES: dict[str, str] = {
    "001210": "m0000063",  # Queen Charlotte Sound
}

COORD_DECIMALS = 5  # ~1 m — plenty for zone fills on a webmap


def fetch_package() -> Path:
    if CACHE_ZIP.exists():
        return CACHE_ZIP
    CACHE_DIR.mkdir(exist_ok=True)
    print(f"downloading {PKG_URL} ...")
    with urllib.request.urlopen(PKG_URL) as resp:
        CACHE_ZIP.write_bytes(resp.read())
    print(f"cached {CACHE_ZIP} ({CACHE_ZIP.stat().st_size / 1e6:.1f} MB)")
    return CACHE_ZIP


def read_layer(zip_path: Path, layer: str) -> shapefile.Reader:
    zf = zipfile.ZipFile(zip_path)
    return shapefile.Reader(
        shp=io.BytesIO(zf.read(f"{layer}.shp")),
        dbf=io.BytesIO(zf.read(f"{layer}.dbf")),
        shx=io.BytesIO(zf.read(f"{layer}.shx")),
    )


def round_ring(ring: list) -> list:
    return [[round(x, COORD_DECIMALS), round(y, COORD_DECIMALS)] for x, y in ring]


def main() -> int:
    zip_path = fetch_package()

    seen: dict[str, Polygon] = {}
    meta: dict[str, tuple[str, str, str]] = {}  # clc -> (site, name, nom)
    for layer, wanted in ((LAYER, ZONES), (STD_LAYER, STD_ZONES)):
        sf = read_layer(zip_path, layer)
        for i, rec in enumerate(sf.records()):
            d = rec.as_dict()
            clc = d.get("CLC")
            if clc not in wanted or clc in seen:
                continue
            poly = shape(sf.shape(i).__geo_interface__)
            if poly.geom_type == "MultiPolygon":
                # Some zones carry degenerate zero-area sliver parts
                # (e.g. Central Coast). Keep the real polygon; refuse to
                # silently drop anything with actual area.
                parts = sorted(poly.geoms, key=lambda g: g.area, reverse=True)
                # Sliver threshold ~1 km² in degrees at this latitude.
                if any(g.area > 1e-4 for g in parts[1:]):
                    print(f"ERROR: {clc} {d['NAME']} has multiple real parts")
                    return 1
                poly = parts[0]
            if not poly.is_valid or poly.geom_type != "Polygon":
                print(f"ERROR: bad geometry for {clc} {d['NAME']}")
                return 1
            seen[clc] = poly
            meta[clc] = (wanted[clc], d["NAME"].strip(), d["NOM"].strip())

    missing = (set(ZONES) | set(STD_ZONES)) - set(seen)
    if missing:
        print(f"ERROR: zones not found in layer: {sorted(missing)}")
        return 1

    # The std layer's coastline generalisation differs slightly from the
    # sub-zone layer's, so whole-area zones can overlap their sub-zone
    # neighbours by hairline slivers. Clip them against the sub-zone union
    # so the mosaic tiles by construction.
    sub_union = unary_union([seen[c] for c in ZONES])
    for clc in STD_ZONES:
        clipped = seen[clc].difference(sub_union)
        if clipped.geom_type == "MultiPolygon":
            clipped = max(clipped.geoms, key=lambda g: g.area)
        if clipped.geom_type != "Polygon" or not clipped.is_valid:
            print(f"ERROR: clipping {clc} produced {clipped.geom_type}")
            return 1
        seen[clc] = clipped

    features = []
    for clc, poly in seen.items():
        label = polylabel(poly, tolerance=0.005)
        if not poly.contains(label):
            print(f"ERROR: label point outside polygon for {clc}")
            return 1
        site, name, nom = meta[clc]
        geo = mapping(poly)
        features.append(
            {
                "type": "Feature",
                "id": clc,
                "properties": {
                    "clc": clc,
                    "site_code": site,
                    "name_en": name,
                    "nom_fr": nom,
                    "label_lon": round(label.x, COORD_DECIMALS),
                    "label_lat": round(label.y, COORD_DECIMALS),
                },
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [round_ring(r) for r in geo["coordinates"]],
                },
            }
        )

    clcs = sorted(seen)
    adjacent: dict[str, set[str]] = {c: set() for c in clcs}
    for a_i, a in enumerate(clcs):
        for b in clcs[a_i + 1 :]:
            inter = seen[a].intersection(seen[b])
            if inter.area > 1e-9:
                print(f"ERROR: zones {a} and {b} overlap (area {inter.area})")
                return 1
            # Shared linework = neighbours (point-touches don't count —
            # corner contact doesn't need distinct colours).
            if inter.length > 1e-6:
                adjacent[a].add(b)
                adjacent[b].add(a)

    # Greedy 3-colouring, highest-degree first, preferring the least-used
    # free colour so all three tints appear even where 2 would suffice.
    # The zone graph is planar and sparse, so 3 colours suffice; fail
    # loudly if a future zone set ever breaks that assumption.
    colors: dict[str, int] = {}
    for clc in sorted(clcs, key=lambda c: -len(adjacent[c])):
        used = {colors[n] for n in adjacent[clc] if n in colors}
        free = [c for c in range(3) if c not in used]
        if not free:
            print(f"ERROR: zone {clc} needs a 4th colour; adjacency: "
                  f"{sorted(adjacent[clc])}")
            return 1
        counts = {c: sum(1 for v in colors.values() if v == c) for c in free}
        colors[clc] = min(free, key=lambda c: (counts[c], c))
    for f in features:
        f["properties"]["color"] = colors[f["id"]]

    features.sort(key=lambda f: f["id"])
    fc = {
        "type": "FeatureCollection",
        "package_version": PKG_VERSION.replace("_", "."),
        "features": features,
    }
    OUT_PATH.write_text(json.dumps(fc, separators=(",", ":")) + "\n")
    size_kb = OUT_PATH.stat().st_size / 1024
    print(f"wrote {OUT_PATH} — {len(features)} zones, {size_kb:.0f} KB")
    for f in features:
        p = f["properties"]
        npts = len(f["geometry"]["coordinates"][0])
        print(f"  {p['clc']}  {p['site_code']}  colour {p['color']}  "
              f"{p['name_en']}  ({npts} pts)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
