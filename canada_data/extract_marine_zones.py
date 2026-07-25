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
import shapely
from shapely.geometry import Polygon, box, mapping, shape
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
# PZZ133 is deliberately LAST: its blockified shape (below) is finished by
# clipping against every neighbour, so they must all be accepted first.
US_ZONES: list[str] = [
    "PZZ130",  # West Entrance U.S. Waters Strait Of Juan De Fuca
    "PZZ131",  # Central U.S. Waters Strait Of Juan De Fuca
    "PZZ132",  # East Entrance U.S. Waters Strait Of Juan De Fuca
    "PZZ134",  # Admiralty Inlet
    "PZZ135",  # Puget Sound and Hood Canal
    "PZZ133",  # Northern Inland Waters Including The San Juan Islands
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


# ------------------------------------------------------------------
# Blockified PZZ133 (Northern Inland Waters / San Juan Islands).
#
# The raw NWS polygon hugs every coastline, which reads as a different
# visual language from the blocky ECCC zones. Per the design decision
# (2026-07-25): all island holes are covered, and the ragged east/south
# boundary is replaced by straight lines. The Canada border, the Haro
# Strait side, and the shared boundary with PZZ132 keep the original
# linework. Points marked "snap" are matched to the nearest existing
# vertex (of this ring, or of PZZ135 where the new boundary must meet
# Puget Sound and Hood Canal without overlap or gap); the final shape is
# also clipped against every neighbour, which trims any remaining
# overlap along those seams. Visual geometry only — forecast/warning
# joins still use the official zone id.
# ------------------------------------------------------------------

# (lon, lat), north → south. snap: "ring" = this zone, "135" = PZZ135.
PZZ133_EAST_BOUNDARY: list[tuple[float, float, str | None]] = [
    (-122.75774563164018, 49.002219103088116, "ring"),
    (-122.48457021193411, 48.75334842360956, None),
    (-122.34003868317473, 48.09681947291731, None),
    (-122.37597396320557, 48.03454298569983, "135"),
    (-122.55138655725212, 47.97282469847735, "135"),
    (-122.70230349018604, 47.913563154310864, "135"),
]

# Whidbey Island cover (2026-07-25): the raw ring wraps Whidbey's
# shoreline, leaving the Oak Harbor lobe carved out of the block. This
# polygon is unioned over the island so the block runs unbroken from the
# East Entrance boundary to the Admiralty Inlet boundary. Its two
# western corners deliberately OVERSHOOT into PZZ132 / PZZ134 water —
# straight chords between boundary junctions leave uncovered slivers
# where the real boundaries bow west — and the neighbour clip then trims
# the cover to their exact shapes, so the block hugs them by
# construction. Corners ordered clockwise; snap keys as above.
PZZ133_WHIDBEY_COVER: list[tuple[float, float, str | None]] = [
    (-122.83, 48.35, None),  # overshoot into PZZ132 (mid east entrance)
    (-122.66474532018788, 48.39056584247043, "ring"),  # Deception junction
    (-122.34003868317473, 48.09681947291731, None),
    (-122.37597396320557, 48.03454298569983, "135"),
    # Deep southern sweep: the official 133/135 boundary runs diagonally
    # (Mukilteo → Possession Point → Foulweather), so straight chords near
    # it always strand land wedges (Double Bluff, Possession Point). Round
    # south Whidbey's SE lobe through Possession Sound, then run far into
    # PZZ135 water; the clip pulls the seam back to the official boundary,
    # and the Kitsap land the last edge crosses is severed and dropped by
    # the fragment allowance.
    (-122.345, 47.947, "135"),  # PZZ135's Mukilteo corner
    (-122.377, 47.905, "135"),  # PZZ135's Possession Point corner
    (-122.43, 47.82, None),
    (-122.70230349018604, 47.913563154310864, "135"),  # Foulweather anchor
    (-122.73, 48.135, None),  # overshoot into PZZ134 (mid Admiralty channel)
]


def nearest_vertex(ring: list, target: tuple[float, float]) -> int:
    return min(
        range(len(ring)),
        key=lambda i: (ring[i][0] - target[0]) ** 2
        + (ring[i][1] - target[1]) ** 2,
    )


def blockify_pzz133(poly: Polygon, pzz135: Polygon) -> Polygon:
    ring = list(poly.exterior.coords)[:-1]  # drop closing duplicate
    ring135 = list(pzz135.exterior.coords)

    def snap_points(
        spec: list[tuple[float, float, str | None]],
    ) -> list[tuple[float, float]]:
        out: list[tuple[float, float]] = []
        for lon, lat, snap in spec:
            if snap == "ring":
                i = nearest_vertex(ring, (lon, lat))
                out.append((ring[i][0], ring[i][1]))
            elif snap == "135":
                i = nearest_vertex(ring135, (lon, lat))
                out.append((ring135[i][0], ring135[i][1]))
            else:
                out.append((lon, lat))
        return out

    snapped = snap_points(PZZ133_EAST_BOUNDARY)

    # Keep the original linework from the south anchor (A, near
    # Foulweather Bluff) around the west/north side to the north anchor
    # (B, on the Canada border): of the two ring paths A→B, the keeper is
    # the one containing the ring's westernmost vertex (the Haro side).
    iB = nearest_vertex(ring, snapped[0])
    iA = nearest_vertex(ring, snapped[-1])
    iWest = nearest_vertex(ring, (-130.0, 48.6))  # min-lon direction probe

    def path(from_i: int, to_i: int) -> list:
        out = []
        i = from_i
        while True:
            out.append(ring[i])
            if i == to_i:
                return out
            i = (i + 1) % len(ring)

    forward = path(iA, iB)
    backward = path(iB, iA)[::-1]  # same endpoints, other way around
    west = tuple(ring[iWest])
    keep = forward if west in {tuple(p) for p in forward} else backward

    # keep runs A→…→B; append the new east/south boundary B→…→A
    # (snapped[0] is B and snapped[-1] is A, already at the keep ends).
    new_ring = keep + [(lon, lat) for lon, lat in snapped[1:-1]]
    block = Polygon(new_ring)
    if not block.is_valid:
        block = block.buffer(0)
    if block.geom_type == "MultiPolygon":
        block = max(block.geoms, key=lambda g: g.area)

    # Union the Whidbey cover over the island so the block runs unbroken
    # between the East Entrance and Admiralty Inlet boundaries.
    cover = Polygon(snap_points(PZZ133_WHIDBEY_COVER))
    if not cover.is_valid:
        cover = cover.buffer(0)
    block = unary_union([block, cover])
    if block.geom_type == "MultiPolygon":
        block = max(block.geoms, key=lambda g: g.area)
    # Drop any interior rings the union stitched up — islands are covered.
    return Polygon(block.exterior)


# ------------------------------------------------------------------
# Cross-border gap fill (2026-07-25). The two countries approximate the
# international water boundary differently, leaving slivers and — at
# zone junctions (the bend south of Victoria; Boundary Pass where Haro
# and Georgia-south meet PZZ133) — visible pockets of unowned water up
# to ~3 km wide. The corridor below runs along the whole shared
# boundary and is partitioned among the border-adjacent zones by
# iterative dilation: each zone grows into unclaimed corridor water
# only, so seams land mid-pocket and zones stay disjoint. The corridor
# deliberately stops short of the Victoria / Esquimalt shoreline
# (nearshore bights ECCC leaves unzoned stay unzoned, consistent with
# the rest of the map) and short of PZZ133's straight Blaine chord.
# ------------------------------------------------------------------

BORDER_CORRIDOR = [
    (-124.75, 48.20, -123.42, 48.33),  # Juan de Fuca midline band
    (-123.42, 48.24, -123.10, 48.40),  # junction pocket south of Victoria
    (-123.28, 48.40, -123.10, 48.46),  # up to the Haro junction
    (-123.30, 48.44, -123.00, 48.80),  # Haro Strait seam
    (-123.10, 48.68, -122.80, 49.005),  # Boundary Pass → 49th parallel
]
BORDER_ZONES = [
    "001111", "001112", "001113",  # CA Juan de Fuca sub-zones
    "001120",  # Haro Strait
    "001132",  # Strait of Georgia - south of Nanaimo
    "PZZ130", "PZZ131", "PZZ132", "PZZ133",
]
FILL_STEP = 0.006  # ~500 m dilation per round
FILL_ROUNDS = 8


def fill_border_gaps(seen: dict[str, Polygon]) -> None:
    """Partition the corridor gaps among the border zones by iterative
    dilation. Splitting pockets (rather than assigning each whole to one
    zone) matters: whole-pocket assignment forms 4-cliques at the
    five-zone junctions and the graph stops being 3-colourable. The
    dilation fronts are low-resolution (quad_segs=1) and the grown zones
    are re-simplified afterwards, clipped against the others so the
    mosaic stays disjoint."""
    corridor = unary_union([box(w, s, e, n) for w, s, e, n in BORDER_CORRIDOR])
    gap = corridor.difference(unary_union(list(seen.values())))
    grown: set[str] = set()
    for _ in range(FILL_ROUNDS):
        if gap.is_empty:
            break
        for clc in BORDER_ZONES:
            grow = seen[clc].buffer(FILL_STEP, quad_segs=1).intersection(gap)
            if grow.is_empty or grow.area < 1e-9:
                continue
            merged = unary_union([seen[clc], grow]).buffer(0)
            if merged.geom_type == "MultiPolygon":
                merged = max(merged.geoms, key=lambda g: g.area)
            seen[clc] = merged
            grown.add(clc)
            gap = gap.difference(grow)

    # Tame the dilation fronts: simplify each grown zone, then clip it
    # against every other zone so simplification can't reintroduce
    # overlap (hairline re-opened gaps are <50 m — invisible).
    for clc in grown:
        others = unary_union([g for c, g in seen.items() if c != clc])
        slim = (
            seen[clc]
            .simplify(0.0004, preserve_topology=True)
            .difference(others)
        )
        if slim.geom_type == "MultiPolygon":
            slim = max(slim.geoms, key=lambda g: g.area)
        if slim.geom_type == "Polygon" and slim.is_valid:
            seen[clc] = slim
    print(f"  border fill: grew {len(grown)} zone(s) into corridor gaps")


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
        if zone_id == "PZZ133":
            # Blockified: islands covered (no holes), straight east/south
            # boundary. Snaps against the already-accepted PZZ135 shape.
            poly = blockify_pzz133(poly, seen["PZZ135"])
        else:
            holes = [
                h for h in poly.interiors if Polygon(h).area >= MIN_HOLE_AREA
            ]
            poly = Polygon(poly.exterior, holes)
        poly = poly.simplify(US_SIMPLIFY_TOLERANCE, preserve_topology=True)
        clipped = poly.difference(clip_union)
        if clipped.geom_type == "MultiPolygon":
            if zone_id == "PZZ133":
                # The blockified cover deliberately overshoots into
                # neighbour water; where its edges cross unzoned land
                # (Marrowstone Island, the Kitsap tip) the clip severs
                # fragments that are MEANT to be discarded. Keep the main
                # block, report what fell away.
                parts = sorted(clipped.geoms, key=lambda g: g.area, reverse=True)
                dropped = sum(g.area for g in parts[1:])
                print(
                    f"  PZZ133: dropped {len(parts) - 1} clip fragment(s) "
                    f"over unzoned land ({dropped:.5f} deg²)"
                )
                clipped = parts[0]
            else:
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

    fill_border_gaps(seen)

    features = []
    for clc, poly in seen.items():
        label = polylabel(poly, tolerance=0.005)
        if not poly.contains(label):
            print(f"ERROR: label point outside polygon for {clc}")
            return 1
        site, name, nom, country = meta[clc]
        # Snap coordinates to the output precision through GEOS rather
        # than naive rounding — rounding complex boundaries by hand can
        # create self-intersections and degenerate rings.
        snapped_poly = shapely.set_precision(poly, 10**-COORD_DECIMALS)
        if snapped_poly.geom_type == "MultiPolygon":
            snapped_poly = max(snapped_poly.geoms, key=lambda g: g.area)
        geo = mapping(snapped_poly)
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
            # Within the pristine Canadian dataset, linework is
            # authoritative: neighbours share exact boundary geometry
            # (point-touches don't count — corner contact doesn't need
            # distinct colours). Any pair involving a US zone OR a zone
            # reshaped by the border fill only APPROXIMATELY coincides
            # with its neighbours (cross-border midline, hairline
            # simplification gaps), so there "within ~200 m" is what
            # touching means — without this, Haro/PZZ133 (and, after the
            # border fill, the CA Juan de Fuca sub-zones themselves)
            # read as non-adjacent and could share a tint across a
            # visually-shared boundary.
            pristine = (
                not a.startswith("PZZ")
                and not b.startswith("PZZ")
                and a not in BORDER_ZONES
                and b not in BORDER_ZONES
            )
            if inter.length > 1e-6 or (
                not pristine and seen[a].distance(seen[b]) < 0.002
            ):
                adjacent[a].add(b)
                adjacent[b].add(a)

    # Exact 3-colouring by backtracking (highest-degree first, least-used
    # colour preferred so all three tints appear even where fewer would
    # do). The graph is planar-ish but the distance-based cross-border
    # edges densify it, so greedy is no longer trustworthy; 27 nodes is
    # trivial to solve exactly. Fails loudly if truly not 3-colourable.
    order = sorted(clcs, key=lambda c: -len(adjacent[c]))
    colors: dict[str, int] = {}

    def solve(i: int) -> bool:
        if i == len(order):
            return True
        clc = order[i]
        used = {colors[n] for n in adjacent[clc] if n in colors}
        counts = {c: sum(1 for v in colors.values() if v == c) for c in range(3)}
        for c in sorted(range(3), key=lambda c: (counts[c], c)):
            if c in used:
                continue
            colors[clc] = c
            if solve(i + 1):
                return True
            del colors[clc]
        return False

    if not solve(0):
        print("ERROR: zone graph is not 3-colourable; a 4th tint is needed")
        return 1
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
