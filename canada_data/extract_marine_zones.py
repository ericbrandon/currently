#!/usr/bin/env python3
"""Extract marine forecast zone polygons (Canada + US) for the webapp.

Canada: reads the `water_MarSubZone_hybrid_unproj` layer from the MSC
Geography Package (official boundary geometry for forecast sub-locations),
filtered to the zones covering the app's map area.
US: fetches the NWS marine zone GeoJSON (island-holed polygons) from
api.weather.gov for the six Puget Sound / US Juan de Fuca zones, prunes
sub-km² island holes, and clips against the Canadian zones at the border
midline (the two datasets approximate the boundary differently).

Writes web/public/data/marine_zones.geojson. Polygons are static,
versioned data; re-run only when ECCC ships a new geography package or
NWS redraws zones. Sources are cached in canada_data/marine_zones_raw/
(gitignored).

Each output feature carries:
  clc        zone code: ECCC CLC ("001131") or NWS zone id ("PZZ133")
  site_code  forecast join key — ECCC marineweather-realtime feature id
             (m00000xx) for CA, the NWS zone id itself for US
  country    "CA" | "US" — routes fetching/rendering in the app
  name_en    English zone name; matches ECCC warnings.locations[].name.en
             (CA) / the NWS zone name (US)
  nom_fr     French name (CA; see weather_plan.md §1.1) — mirrors name_en
             for US zones
  label_lon / label_lat
             pole-of-inaccessibility point for the map warning badge
             (true centroids fall outside concave zones)
  color      0/1/2 — map tint index, greedy 3-colouring of the zone
             adjacency graph (cross-border pairs included) so no two
             touching zones share a colour

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
    "001230": "m0000152",  # Douglas Channel
    "001241": "m0000106",  # Hecate Strait - northern half
    "001242": "m0000106",  # Hecate Strait - southern half
    "001250": "m0000124",  # Dixon Entrance East
    "001261": "m0000098",  # Dixon Entrance West - east of Langara
    "001262": "m0000098",  # Dixon Entrance West - west of Langara
    "001271": "m0000079",  # West Coast Haida Gwaii - northern half
    "001272": "m0000079",  # West Coast Haida Gwaii - southern half
}

# Zones taken from STD_LAYER as one whole polygon (see note there).
STD_ZONES: dict[str, str] = {
    "001210": "m0000063",  # Queen Charlotte Sound
}

# NWS marine zones (Seattle forecast office), fetched from api.weather.gov.
# The zone id is both the display id and the forecast/alert join key.
US_ZONES: list[str] = [
    "PZZ130",  # West Entrance U.S. Waters Strait Of Juan De Fuca
    "PZZ131",  # Central U.S. Waters Strait Of Juan De Fuca
    "PZZ132",  # East Entrance U.S. Waters Strait Of Juan De Fuca
    "PZZ133",  # Northern Inland Waters Including The San Juan Islands
    "PZZ134",  # Admiralty Inlet
    "PZZ135",  # Puget Sound and Hood Canal
]
NWS_ZONE_URL = "https://api.weather.gov/zones/marine/{}"
NWS_UA = "currentlybc.com zone extraction (admin.currentlybc@gmail.com)"

COORD_DECIMALS = 5  # ~1 m — plenty for zone fills on a webmap
# Island holes smaller than this (~1 km²) are pruned from US zones —
# PZZ133 alone ships 210 holes down to bare rocks.
MIN_HOLE_AREA = 1e-4
# US zones ship at full NOAA coastline resolution (PZZ135 alone: ~8k
# points, 10× the entire Canadian set). Simplified to ~80 m, then clipped
# sequentially so simplification can't reintroduce overlaps — worst case
# is a hairline (<~160 m) gap along a shared boundary, invisible on a
# translucent fill.
US_SIMPLIFY_TOLERANCE = 0.001


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


def fetch_nws_zone(zone_id: str) -> dict:
    CACHE_DIR.mkdir(exist_ok=True)
    cache = CACHE_DIR / f"nws_{zone_id}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    url = NWS_ZONE_URL.format(zone_id)
    print(f"fetching {url} ...")
    req = urllib.request.Request(url, headers={"User-Agent": NWS_UA})
    with urllib.request.urlopen(req) as resp:
        data = resp.read()
    cache.write_bytes(data)
    return json.loads(data)


def largest_real_part(poly, label: str):
    """Collapse a MultiPolygon to its dominant part; error out if any
    dropped part is bigger than sliver scale (~1 km²)."""
    if poly.geom_type != "MultiPolygon":
        return poly
    parts = sorted(poly.geoms, key=lambda g: g.area, reverse=True)
    if any(g.area > MIN_HOLE_AREA for g in parts[1:]):
        raise ValueError(f"{label} has multiple real parts")
    return parts[0]


def main() -> int:
    zip_path = fetch_package()

    seen: dict[str, Polygon] = {}
    # clc -> (site, name, nom, country)
    meta: dict[str, tuple[str, str, str, str]] = {}
    for layer, wanted in ((LAYER, ZONES), (STD_LAYER, STD_ZONES)):
        sf = read_layer(zip_path, layer)
        for i, rec in enumerate(sf.records()):
            d = rec.as_dict()
            clc = d.get("CLC")
            if clc not in wanted or clc in seen:
                continue
            try:
                poly = largest_real_part(
                    shape(sf.shape(i).__geo_interface__), f"{clc} {d['NAME']}"
                )
            except ValueError as e:
                print(f"ERROR: {e}")
                return 1
            if not poly.is_valid or poly.geom_type != "Polygon":
                print(f"ERROR: bad geometry for {clc} {d['NAME']}")
                return 1
            seen[clc] = poly
            meta[clc] = (wanted[clc], d["NAME"].strip(), d["NOM"].strip(), "CA")

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

    # US zones: prune sub-km² island holes, simplify, then clip against
    # everything already accepted (Canadian union + earlier US zones) —
    # the two countries approximate the border midline differently
    # (Canadian geometry wins), and per-zone simplification would
    # otherwise reintroduce overlaps along shared US-US boundaries.
    clip_union = unary_union(list(seen.values()))
    for zone_id in US_ZONES:
        zj = fetch_nws_zone(zone_id)
        name = zj["properties"]["name"].strip()
        try:
            poly = largest_real_part(shape(zj["geometry"]), f"{zone_id} {name}")
        except ValueError as e:
            print(f"ERROR: {e}")
            return 1
        holes = [
            h for h in poly.interiors if Polygon(h).area >= MIN_HOLE_AREA
        ]
        poly = Polygon(poly.exterior, holes).simplify(
            US_SIMPLIFY_TOLERANCE, preserve_topology=True
        )
        clipped = poly.difference(clip_union)
        if clipped.geom_type == "MultiPolygon":
            try:
                clipped = largest_real_part(clipped, f"{zone_id} post-clip")
            except ValueError as e:
                print(f"ERROR: {e}")
                return 1
        if clipped.geom_type != "Polygon" or not clipped.is_valid:
            print(f"ERROR: US zone {zone_id} produced {clipped.geom_type}")
            return 1
        seen[zone_id] = clipped
        meta[zone_id] = (zone_id, name, name, "US")
        clip_union = clip_union.union(clipped)

    features = []
    for clc, poly in seen.items():
        label = polylabel(poly, tolerance=0.005)
        if not poly.contains(label):
            print(f"ERROR: label point outside polygon for {clc}")
            return 1
        site, name, nom, country = meta[clc]
        geo = mapping(poly)
        features.append(
            {
                "type": "Feature",
                "id": clc,
                "properties": {
                    "clc": clc,
                    "site_code": site,
                    "country": country,
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
