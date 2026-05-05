# San Juan Islands — tide & current station expansion

Working notes for filling out NOAA tide and current coverage in the San Juan Islands proper. Today:

- **Tides** — [`stations_tides.json`](../us_data/stations_tides.json) has **zero** NOAA stations inside the archipelago. The "FRIDAY HARBOR" pill currently visible on the map comes from CHS data (CHS bundles 6 US tide stations as cross-border references; Friday Harbor is one).
- **Currents** — [`stations_currents.json`](../us_data/stations_currents.json) has only **2 stations inside the archipelago** (Cattle Pass / SJ Channel south, Spieden Channel) plus the surrounding Rosario Strait and Guemes Channel W/E. CHS does not carry US-side current stations.

Plan: add the picks below, then prune after seeing them on the map together (some will look too clustered).

Companion doc for the south side of Juan de Fuca: [`juan_de_fuca_us_stations.md`](juan_de_fuca_us_stations.md).

## Naming convention recap

Each pick carries three name fields:

- **`placename`** — internal admin label; can be verbose / multi-name (e.g. `"Mukilteo / Possession Sound"`).
- **`name`** for tides, **`primary_name`** for currents — NOAA's verbatim official name.
- **`NOAA_short_name`** — **the label rendered on the map**. Pick the boater-recognized noun phrase already inside the official name; trim qualifiers like "Bridge", "Ferry Terminal", "1.2 nm SE of", or trailing island names.

Existing precedents:
- Tides: `"Tacoma Narrows"` (from "Tacoma Narrows Bridge"), `"Sinclair Inlet"` (from "Bremerton, Sinclair Inlet, Port Orchard"), `"Yukon Harbor"` (substitute station for Blake Island).
- Currents: `"Bush Point"` (from "Admiralty Inlet (off Bush Point)") — when official is `[Channel], [Point Name]`, short uses the point name. `"Guemes Channel W"` / `"E"` for paired entrance stations.

Consequence for substitutions: a destination aliased to a substitute station (Mukilteo→Glendale, Blake Island→Yukon Harbor) **does not add its own pin or label** — the map shows the substitute's short name. The substitution `placename` and `note` are internal documentation only.

## Tide picks (15 stations)

All confirmed in [`2026_noaa_tidepredictions_wa.json`](../us_data/2026_noaa_tidepredictions_wa.json).

| # | NOAA ID | Type | Official NOAA name | `NOAA_short_name` | Why |
|---|---|---|---|---|---|
| 1 | `9449834` | S | Roche Harbor, San Juan Island | **Roche Harbor** | Customs POE, resort marina; top-3 destination |
| 2 | `9449798` | S | Orcas, Orcas Island | **Orcas Landing** | Ferry landing; "Orcas" alone is the island name |
| 3 | `9449771` | R | Rosario, East Sound, Orcas Island | **Rosario** | Iconic resort/anchorage; primary R for E. Sound |
| 4 | `9449712` | S | Echo Bay, Sucia Islands | **Sucia Island** | Sucia is the marquee destination; Echo Bay is one of three anchorages on it |
| 5 | `9449704` | S | Patos Island Wharf | **Patos Island** | Active Cove, lighthouse, north-islands reference |
| 6 | `9449746` | R | Waldron Island, Puget Sound | **Waldron Island** | Quiet anchorages; primary R reference |
| 7 | `9449828` | R | Hanbury Point, Mosquito Pass, San Juan I. | **Mosquito Pass** | Boater-recognized chokepoint name (matches `Tacoma Narrows` / `Sinclair Inlet` precedent) |
| 8 | `9449856` | R | Kanaka Bay, San Juan Island | **Kanaka Bay** | West-side / False Bay / Cattle Pt approach |
| 9 | `9449904` | S | Shaw Island Ferry, Harney Channel | **Blind Bay** | Cruising destination right next to the ferry terminal; matches "trim Ferry Terminal" precedent |
| 10 | `9449911` | R | Upright Head, Lopez Island | **Upright Head** | Lopez ferry landing; top of Upright Channel |
| 11 | `9449932` | R | Armitage Island, Thatcher Pass | **Thatcher Pass** | Famous Anacortes ferry route; Armitage Island is obscure |
| 12 | `9449982` | R | Richardson, Lopez Island | **Richardson** | South Lopez / Mackaye Harbor / Outer Bay |
| 13 | `9449994` | S | Aleck Bay, Lopez Island | **Aleck Bay** | South Lopez anchorage |
| 14 | `9448876` | S | Strawberry Bay, Cypress Island | **Strawberry Bay** | Cypress Head / Pelican Beach / Eagle Harbor (DNR sites) |
| 15 | `9449988` | R | Telegraph Bay, Puget Sound | **Telegraph Bay** | Decatur / James I. / SE Lopez; primary R "for free" |

R = Reference/Harmonic primary; S = Subordinate.

**Dropped from earlier draft**:
- `9449880` Friday Harbor — already covered by CHS as secondary station index 7240; would create duplicate map pin. See "Open questions" for the upgrade-to-NOAA-primary option.
- Fisherman Bay alias to Upright Head — see below.

### Fisherman Bay → Upright Head alias

Fisherman Bay (Lopez Village area) has no NOAA station. The natural data substitute is **Upright Head (`9449911`)** — ~3 nm north and on the same San Juan Channel tidal regime that drives the Fisherman Bay entrance. (An earlier draft mapped it to Richardson, but Richardson is ~7 nm south on the Juan de Fuca side — wrong regime.)

Per the schema convention, this alias does **not** add a "Fisherman Bay" pin to the map — it's an internal `placename` entry pointing at station `9449911`, which already shows up as **Upright Head**. Aliasing is documentation, not display.

### Tide picks likely-to-prune after map review

- **Roche Harbor (`9449834`) vs Mosquito Pass / Hanbury Point (`9449828`)** — ~1 nm apart. Hanbury/Mosquito Pass is the R primary; Roche is the recognizable name. Likely keep Roche, drop Mosquito Pass — or keep both since they label different things to the user.
- **Upright Head (`9449911`) vs Blind Bay (`9449904`)** — ~2.5 nm across Upright Channel, different islands; probably keep both.
- **Richardson (`9449982`) vs Aleck Bay (`9449994`)** — ~3 nm on south Lopez; could reduce to one if cluttered.
- **Strawberry Bay vs Tide Point** (Cypress, `9448876` vs `9448918`) — only added Strawberry; Tide Point would be redundant.

## Current picks (21 stations)

All confirmed in [`2026_noaa_currentpredictions_wa.json`](../us_data/2026_noaa_currentpredictions_wa.json). 5 already picked + 16 new.

| # | NOAA ID | Type | Official NOAA name | `NOAA_short_name` | Status |
|---|---|---|---|---|---|
| 1 | `PUG1742` | H | Cattle Point, 1.2 nm SE of | **Cattle Point** | NEW — replaces existing PUG1703; see Cattle Pass note |
| 2 | `PUG1702` | H | Rosario Strait | **Rosario Strait** | existing |
| 3 | `PUG1733` | H | Thatcher Pass | **Thatcher Pass** | NEW |
| 4 | `PUG1704` | H | Peavine Pass, west entrance | **Peavine Pass** | NEW |
| 5 | `PUG1705` | H | Obstruction Pass, N of Obstruction Island | **Obstruction Pass** | NEW |
| 6 | `PUG1721` | H | Wasp Passage narrows | **Wasp Passage** | NEW |
| 7 | `PUG1722` | H | Harney Channel, N of Point Hudson | **Harney Channel** | NEW |
| 8 | `PUG1723` | H | Upright Channel narrows | **Upright Channel** | NEW |
| 9 | `PUG1717` | H | Turn Point, Boundary Pass | **Turn Point** | NEW — famous Stuart Island lighthouse/chokepoint |
| 10 | `PUG1718` | H | Haro Strait, 1.2 nm W of Kellett Bluff | **Kellett Bluff** | NEW — point-name precedent (Bush Point) |
| 11 | `PUG1724` | H | South Haro Strait, S of Lime Kiln Light | **Lime Kiln** | NEW — Lime Kiln is the well-known whale-watch park/light |
| 12 | `PUG1719` | H | Spieden Channel, N of Limestone Point | **Spieden Channel** | existing |
| 13 | `PUG1715` | H | President Channel, E of Point Disney | **President Channel** | NEW |
| 14 | `PUG1730` | H | Lopez Pass | **Lopez Pass** | NEW |
| 15 | `PUG1738` | H | Burrows Pass | **Burrows Pass** | NEW |
| 16 | `PUG1734` | H | Guemes Channel, West Entrance | **Guemes Channel W** | existing |
| 17 | `PUG1735` | H | Guemes Channel, East Entrance | **Guemes Channel E** | existing |
| 18 | `PUG1729` | H | Belle Rock Light, east of | **Belle Rock** | NEW — well-known Rosario Strait waypoint |
| 19 | `PUG1713` | H | Patos Island, south of Toe Point | **Patos Island** | NEW |
| 20 | `PUG1711` | H | Matia Island, west of | **Matia Island** | NEW |
| 21 | `PUG1706` | H | Peapod Rocks Light, 1.2 nm S of | **Peapod Rocks** | NEW — mid-Rosario Strait gap-filler between Rosario Strait and Belle Rock stations |

All H (harmonic primary) — currents in this region are well-instrumented; no S or W-class stations needed.

### Cattle Pass: PUG1742 replaces PUG1703

The previous pick **`PUG1703` San Juan Channel south entrance** (48.46, -122.95) sits at the *north end* of the constriction. **`PUG1742` Cattle Point, 1.2 nm SE of** (48.43, -122.95) is at the actual point where the famous Cattle Pass tide rip lives — recreationally the more useful station. Decision: **drop PUG1703, use PUG1742**, labeled "Cattle Point" on the map. The two are only ~2 nm apart and pairing them (à la Admiralty Inlet's Bush Pt + Pt Wilson) was considered but the Cattle Point station carries the relevant boating decision on its own.

`PUG1743` "Cattle Point, 4.6 nm SW of" is far out in Juan de Fuca — skip.

### Current picks likely-to-prune after map review

- **Belle Rock (`PUG1729`) vs Rosario Strait (`PUG1702`) vs Peapod Rocks (`PUG1706`)** — three stations along the Rosario Strait corridor (south → mid → north). All three have meaningfully different timing on a long crossing, but if the map looks dense, Belle Rock is the most droppable since it's closest to PUG1702.
- **Patos (`PUG1713`) + Matia (`PUG1711`)** — only ~3.5 nm apart. Could reduce to one if cluttered around the Sucia/Matia/Patos triangle; keep Patos (it's the more recognizable destination).
- **Lopez Pass (`PUG1730`) vs Thatcher Pass (`PUG1733`)** — ~3 nm apart, both threading Lopez/Decatur cluster. Keep both — different routes (Lopez Pass is the inside passage, Thatcher is the ferry route).

### Currents considered and dropped

These were on the longer Tier 2 candidate list but didn't make the cut. Notes here so we don't relitigate:

| ID | Name | Why dropped |
|---|---|---|
| `PUG1727` | Point Colville, 3.0 nm east of (Lawson Reef) | One of 4 stations within 5 nm of each other in SE Lopez / Rosario; kept Belle Rock only |
| `PUG1728` | Point Colville, 1.4 nm east of | Same cluster as above |
| `PUG1731` | Fauntleroy Point Light, east of | Same cluster as above |
| `PUG1714` | Patos Island Light, 1.4 nm west of | Redundant with PUG1713; this one is well west in open Boundary Pass |
| `PUG1716` | Waldron Island, 1.7 nm west of | Triangulated by Spieden + President + Turn Point; subordinate (S) station |
| `PUG1736` | Saddle Bag Island Passage | East of Guemes E (PUG1735); redundant for Anacortes approach |
| `PUG1737` | Allan Pass | ~2 nm S of Burrows Pass in same channel system; kept Burrows |
| `PUG1743` | Cattle Point, 4.6 nm SW of | Far out in Juan de Fuca; PUG1742 covers the actual rip |

## Destinations / passages with no NOAA station (alias candidates, deferred)

These have no NOAA station and would be added as `placename` aliases on the nearest pick (no extra map pin — the map shows the substitute's short name). Out of scope for this first pass; revisit after the picks above land on the map.

**Tide aliases:**
- Reid Harbor / Prevost Harbor (Stuart Island) → Roche Harbor
- Jones Island Marine State Park → Friday Harbor or Orcas Landing
- Deer Harbor, West Sound, Eastsound village (Orcas) → Orcas Landing / Rosario
- Spencer Spit (Lopez) → Upright Head
- Doe Bay / Olga (Orcas E side) → Rosario
- Blakely Island Marina → Thatcher Pass
- Matia / Clark / James Islands → Sucia Island / Thatcher Pass
- Cypress anchorages beyond Strawberry Bay (Eagle Harbor, Pelican Beach) → Strawberry Bay
- Garrison Bay / Wescott Bay / English Camp → Mosquito Pass
- False Bay (San Juan I.) → Kanaka Bay
- Watmough Bay (S Lopez) → Aleck Bay

**Current aliases:**
- **Mosquito Pass** (San Juan ↔ Henry I., back door to Roche Harbor) → nearest is Spieden Channel; current is short and locally driven, hard to substitute well
- **Pole Pass** (Crane I. ↔ Orcas, between Wasp Passage and Deer Harbor) → Wasp Passage is the natural alias
- **Spring Passage / New Channel** (Jones I. / Orcas) → Spieden Channel or Wasp Passage
- **Active Pass** (BC) — covered by CHS data, not our concern here

## Open questions

- **Upgrade CHS-secondary US tide stations to NOAA primaries?** CHS provides Friday Harbor, Bellingham, Blaine, Port Angeles, Crescent Bay, Neah Bay as secondary computations (offsets from BC primaries). NOAA's harmonic-primary versions are theoretically more accurate. Doing the upgrade requires (1) adding the NOAA stations to picks and (2) suppressing the CHS duplicates via a new `suppress_index_nos` field in the Canadian pipeline or a render-time dedup. Out of scope for this expansion; revisit as a separate task. Same question applies in the JDF doc.
- **Lummi Island tide coverage?** `9449161` Village Point (R) is right there — only Inati Bay is a real recreational draw, so probably skip unless the map looks bare on the east side.
- **Ship Harbor `9448772`** (Anacortes ferry terminal) likely redundant with existing `9448794` Anacortes/Guemes Channel — confirm by distance on the map.
- **Bin selection** for new currents: pipeline picks shallowest by default. Spot-check that the chosen bins are reasonable (some Haro Strait stations only have deep bins).
