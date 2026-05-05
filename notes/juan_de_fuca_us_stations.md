# US Strait of Juan de Fuca — tide & current station expansion

Working notes for filling NOAA tide and current coverage along the **US south shore of JDF** (Olympic Peninsula coast: Cape Flattery → Discovery Bay) and the mid-strait crossing pivots.

Companion to [`san_juan_islands_stations.md`](san_juan_islands_stations.md) (SJI tides + currents). Same naming convention.

## What's already covered (and what isn't)

CHS bundles **6 US tide stations** as cross-border secondary computations in their chartbook. Three are in this region's scope: **Neah Bay, Crescent Bay, Port Angeles** — all already showing on the map from CHS data. We **drop these from our NOAA picks** to avoid duplicate pins. (See "Open questions" for the upgrade-to-NOAA-primary option.)

CHS does **not** carry any US-side current stations, so all our current picks are genuine gap-fillers.

The remaining tide gaps for a US JDF boater are:
1. **Olympic Peninsula south shore between Sekiu and Discovery Bay** — Sekiu, Dungeness, Sequim Bay, Discovery Bay anchorages. None of these are in CHS.
2. **East-strait transition into Admiralty** — Smith Island / New Dungeness / Protection Island corner is mid-strait, beyond what CHS extrapolates from Trial/Discovery Island.
3. **Cross-strait current variability** — Coriolis, eddies, and Olympic coastal effects make BC-side current timing unreliable for US south-shore boats.

## Scope

Focused expansion — recreationally relevant US ports/anchorages and the mid-strait crossing pivots. **Not** trying to fully cover outer-coast (Cape Flattery west, Tatoosh, Cape Alava) — those serve offshore cruisers, different audience.

## Tide picks (4 stations)

All confirmed in [`2026_noaa_tidepredictions_wa.json`](../us_data/2026_noaa_tidepredictions_wa.json).

| # | NOAA ID | Type | Official NOAA name | `NOAA_short_name` | Why |
|---|---|---|---|---|---|
| 1 | `9443361` | R | Sekiu, Clallam Bay | **Sekiu** | Major salmon fishing port; halfway Neah Bay → Port Angeles |
| 2 | `9444471` | S | Dungeness | **Dungeness** | Dungeness Spit / Sequim approach; key east-strait waypoint |
| 3 | `9444555` | S | Sequim Bay entrance | **Sequim Bay** | John Wayne Marina; popular destination |
| 4 | `9444705` | S | Gardiner, Discovery Bay | **Discovery Bay** | Popular cruising anchorage south of Port Townsend |

R = Reference/Harmonic primary; S = Subordinate.

Existing pick `9444900` Port Townsend (R) anchors the eastern end of this corridor and remains the reference for several of the subordinates above.

**Dropped from earlier draft** (already in CHS, would create duplicate pins):
- `9443090` Neah Bay — CHS index 8512
- `9443826` Crescent Bay — CHS index 7050
- `9444090` Port Angeles — CHS index 7060

(Plus `9447985` Smith Island and outer-coast stations, dropped for other reasons — see "Considered and dropped" below.)

## Current picks (4 stations)

All confirmed in [`2026_noaa_currentpredictions_wa.json`](../us_data/2026_noaa_currentpredictions_wa.json).

| # | NOAA ID | Type | Official NOAA name | `NOAA_short_name` | Why |
|---|---|---|---|---|---|
| 1 | `PUG1640` | H | Race Rocks, 4.5 mi S of | **Race Rocks (US)** | US-side counterpart to the famous BC Race Rocks rip; "(US)" disambiguates from the CHS BC station |
| 2 | `PUG1638` | H | Ediz Hook Light, 1.2 mi N of | **Ediz Hook** | Port Angeles harbor; only US deep-water port between Sequim and Neah Bay |
| 3 | `PUG1635` | H | New Dungeness Light, 2.8 mi NNW of | **Dungeness Spit** | Off Dungeness Spit — popular destination, key waypoint for east-strait |
| 4 | `PUG1632` | H | Smith Island, 5.5 mi WNW of | **Smith Island** | Mid-strait east; pivot for SJI ↔ Olympic Peninsula crossings |

All H (harmonic primary).

## Considered and dropped

| ID | Name | Why dropped |
|---|---|---|
| `9442971` | Tatoosh Island, Cape Flattery (tide) | Outer coast; offshore cruiser audience |
| `9442705` | Tskawahyah Island, Cape Alava (tide) | Outer coast |
| `9442861` | Makah Bay (tide) | Outer coast |
| `9443551` | Jim Creek (tide) | Minor, far west |
| `9443644` | Twin Rivers (tide) | Minor, between Sekiu and Crescent |
| `9444122` | Ediz Hook, Port Angeles (tide) | ~1 nm from Port Angeles tide station; redundant |
| `9447985` | Smith Island (tide) | No anchorage / shore access (wildlife refuge); current station covers it |
| `9447934` | Point Partridge, Whidbey I. (tide) | W Whidbey coast has limited anchorages |
| `9447951` | Sunset Beach, Whidbey I. (tide) | Same |
| `PUG1642` | Strait of Juan de Fuca Entrance (current) | Outer mouth — offshore cruiser audience |
| `PUG1641` | Pillar Point, 6 mi NNE of (current) | Mid-strait W; minor recreational use |
| `PUG1639` | Angeles Point, 2 mi NNE of (current) | Redundant with Ediz Hook (PUG1638) |
| `PUG1637` | Ediz Hook Light, 5.3 mi ENE of (current) | Redundant with PUG1638 |
| `PUG1636` | Discovery Island SSE (current) | Closer to BC Discovery Island; CHS likely covers area |
| `PUG1634` | Smith Island, 3.4 mi ESE (current) | Redundant with PUG1632; ESE side faces Rosario which has its own picks |

## Likely-to-prune after map review

- **Ediz Hook current (`PUG1638`) vs Port Angeles tide (`9444090`)** — same harbor, ~1 nm apart, different data products. Both valid (one is tide, one is current); keep both, but consider whether the tide pin and current pin overlap visually.
- **Sequim Bay (`9444555`) vs Dungeness (`9444471`)** — ~5 nm apart; different anchorages. Probably keep both.
- **Crescent Bay (`9443826`)** — only S-class anchorage between Sekiu and Port Angeles; arguable whether we need it given the gap is otherwise wide. Hold for map review.

## No-NOAA-station boater destinations (alias candidates, deferred)

These have no NOAA station and would be aliased to the nearest pick (no extra map pin):

- **Pillar Point** (anchorage west of Port Angeles) → Crescent Bay or Sekiu
- **Freshwater Bay** (anchorage west of Port Angeles) → Crescent Bay
- **Protection Island** (wildlife refuge, no anchorage but a navigation reference) → Discovery Bay
- **John Wayne Marina** → Sequim Bay (already aliased there essentially)
- **Diamond Point** (Discovery Bay entrance) → Discovery Bay
- **Mystery Bay** is on the Admiralty side, already covered by SJI/Puget tide picks

## Open questions

- **Upgrade CHS-secondary US tide stations to NOAA primaries?** CHS's Neah Bay, Crescent Bay, Port Angeles (also Friday Harbor, Bellingham, Blaine in other docs' scopes) are computed as offsets from BC primaries. NOAA's harmonic-primary versions (`9443090`, `9443826`, `9444090`) would be theoretically more accurate. The upgrade requires (1) adding the NOAA stations and (2) suppressing the CHS duplicates via a new `suppress_index_nos` field in the Canadian pipeline or render-time dedup. Deferred — same question as in the SJI tides doc.
- **Race Rocks naming**: "Race Rocks (US)" disambiguates from the CHS BC station, but reads awkwardly. Alternatives: "Race Rocks S" (geographic), or just "Race Rocks" if the CHS station has a different short name in the existing pipeline. Confirm before committing.
- **Outer coast scope**: cruising community for Pacific NW outer coast (Neah Bay → La Push → Westport) is small but real. Adding Tatoosh / Cape Flattery / La Push tide stations would serve them. Out of scope here; revisit if/when audience expands.
- **Bin selection** for currents: same caveat as SJI currents — pipeline picks shallowest by default; spot-check that selected bins are surface-relevant (Race Rocks station may only have deeper bins).
