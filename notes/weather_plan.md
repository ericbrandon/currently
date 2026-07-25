# Marine weather feature — design plan

*Drafted 2026-07-24 (weather branch). Facts below were live-tested against ECCC endpoints that evening. No code exists yet; this is the agreed plan.*

Adds Environment and Climate Change Canada (ECCC) marine forecasts, warnings, and watches to the map as a toggleable polygon layer with a tap-to-read text panel. Wind and weather text only — no observed conditions, no wave forecasts (see §2.4).

## 1. Data sources (verified)

Two sources, split by volatility:

| Data | Source | How it reaches the app |
|---|---|---|
| Sub-zone polygons (static) | MSC Geography Package v6.15.0, `water_MarSubZone` shapefile | Converted once to GeoJSON, committed to `web/public/data/` |
| Forecasts + warnings (live) | MSC GeoMet OGC API, `marineweather-realtime` collection | Fetched client-side, no proxy |

### 1.1 Live forecast API

```
https://api.weather.gc.ca/collections/marineweather-realtime/items
    ?f=json&bbox=-125.5,48,-122.5,50.5&limit=50&skipGeometry=true
```

- Sends `Access-Control-Allow-Origin: *` — browser fetches directly, no server component.
- One request returns every forecast area in the bbox (6 areas for the current app coverage). With `skipGeometry=true`: 18 KB raw / ~5 KB gzipped, and it still contains **all** text. Since polygons are local, this slim form is the only network request the feature ever makes.
- Each feature (`id` = site code, e.g. `m0000028`): `lastUpdated`, `area` (names en/fr, region, subRegion), `regularForecast.locations[]` (per sub-location: `periodOfCoverage`, `wind`, `weatherVisibility` — all bilingual), `extendedForecast.locations[].weatherCondition.forecastPeriods[]` (named days, wind only), `warnings.locations[].events[]` (`name`, `type` warning|watch, `category`, `status`), plus `issuedDatetimeUTC`/`issuedDatetimeLocal` per section.
- **Quirks found in testing:**
  - `regularForecast.locations[].name` is French-only (e.g. "Détroit de Georgie - au nord de Nanaimo") even in English output. Join to polygons via the French `NOM` field or CLC ordering, not the English name.
  - `warnings.locations[].name` IS bilingual and its `.en` exactly matches the shapefile `NAME` field ("Strait of Georgia - north of Nanaimo") — join warnings on that.
  - Events with `status: "ENDED"` appear in the feed and must be filtered out.
  - Collection is labelled *experimental* by ECCC — schema could change. Fallback if it breaks: Datamart XML at `dd.weather.gc.ca/today/marine_weather/pacific/{HH}/` (same content + waveForecast, but no CORS → would need a Cloudflare Pages Function proxy, and files exist only under `/today/`, published ~4×/day after each issuance).

### 1.2 Sub-zone polygons

- Package: `https://dd.weather.gc.ca/today/meteocode/geodata/version_6.15.0/MSC_Geography_Pkg_V6_15_0_Water_Unproj.zip` (40 MB, shapefiles).
- Layer `water_MarSubZone_hybrid_unproj`: 380 records national, 28 BC/Pacific. This is the official *sub-location* granularity — the level warnings and forecast text are actually written at. Not available through GeoMet API (verified — only whole-area `marine-standard-forecast-zones` is served there).
- Fields: `CLC` (zone code, joins to `Location_Metadata_V6_15_0_UTF8.txt`), `NAME`/`NOM`, `AREA_KM2`, `LAT_DD`/`LON_DD`, `PROVINCE_C`, `WATRBODY_C`.
- **Tiling verified with shapely:** zero pairwise overlap among all Salish Sea polygons; adjacent zones share exact boundary linework; Georgia north+south union matches the API's whole-area polygon within 0.05%. Coverage gaps are US waters only (NOAA's problem, `api.weather.gov` if ever wanted).
- Initial zone set (Salish Sea, matches current station coverage):
  - `001131` / `001132` Strait of Georgia north / south of Nanaimo
  - `001111` / `001112` / `001113` Juan de Fuca east entrance / central / west entrance
  - `001120` Haro Strait, `001140` Howe Sound, `001150` Johnstone Strait
  - Optional at the edges: `001180` WCVI South, `001160` Queen Charlotte Strait
- Hybrid depiction is what ECCC's own services use; `detail` variant exists if coastline edges look too coarse against our basemap.
- Sub-zone → parent site code (API feature id) mapping comes from the metadata file (parent CLC column) and is baked into the GeoJSON properties at conversion time, so the client join is a simple lookup.

### 1.3 Time-period semantics (for reading, not parsing)

ECCC period words have fixed definitions: Today = issue→18:00, Tonight = 18:00→06:00, Tomorrow = 06:00→18:00; evening ≈ 18:00–24:00, overnight ≈ 00:00–06:00, morning 06:00–noon, afternoon noon–18:00. Forecast wording is *stateful*: a condition persists until the text changes it. We display text verbatim (plus issue time) and let the reader interpret — no NLP.

### 1.4 What this feature deliberately omits

- **Wave/sea-state forecasts**: the JSON API drops the XML's `waveForecast` section — but verified across all 22 Pacific sub-areas: seas are only forecast for exposed outer waters (WCVI, Hecate, Dixon, etc.). Every zone in our coverage gets wind + weather/visibility only, so nothing is lost today. Revisit (XML+proxy) only if coverage expands to outer waters.
- **Synopsis**: not present in either the JSON API or the marine XML tag table.
- **Observed conditions** (buoys/lightstations): separate SWOB feeds; out of scope.

## 2. UI / UX spec (decisions final unless marked open)

### Weather button
- New toggle under Tides and Currents in the Controls stack. Default **off**; state persists (`persistedBoolean`, like siblings).
- **Offline behaviour**: never show stale data. The button greys out when the app has no confirmed connectivity (see §3). *Amended from "untappable": the grey button stays tappable and acts as manual retry* — tap → immediate fetch attempt → success un-greys (and turns the layer on); failure gives brief visual feedback ("no connection" flash/wiggle). Rationale: as an iPhone home-screen app there is no reload button; the grey button is the user's only manual "test my connection" affordance.
- **Badge**: when the layer is off but an active warning/watch exists in the current data, show a small red dot on the Weather button. Only works while polling, so: polling runs only if the user has *ever* enabled weather (persisted flag). Never-users pay zero bytes and see no badge.

### Polygon layer (on)
- Sub-zone polygons render in pale yellow/orange tints (fill + subtle outline) — three colours assigned at extraction time via a 3-colouring of the adjacency graph, so touching zones never share a tint. Tints never change with conditions. *(2026-07-24: revised from "single uniform tint" during first visual test.)*
- No name labels on the map.
- A warning/watch marker — red exclamation point for `warning`, yellow for `watch` — appears at a representative interior point of any sub-zone with an active (non-ENDED) event. Placement uses pole-of-inaccessibility (true centroids fall outside concave zones), with a hand-override table if any point lands badly (same spirit as `coord_overrides.json`).
- Normal map interactions (zoom, pinch, drag, tapping tide/current markers) are completely unaffected by the layer being on. Station markers sit above polygons; a tap on a marker is a station tap, never a polygon tap.

### Forecast panel (tap a polygon)
- Tapping a polygon (or its `!` badge) opens a text panel at the top of the map.
- **Modal while open**: no map interaction of any kind — no pan/zoom/tap-through, no station-chart interaction. If a station chart was open, it stays open underneath, inert, and is unchanged on close.
- Only the tapped sub-zone stays tinted while the panel is open (other polygons drop to outline-only or hide).
- Content order, top to bottom:
  1. Sub-zone name + **issue time** ("Issued 4:00 PM PDT Jul 24") + period of coverage ("Tonight and Saturday").
  2. **Warnings/watches** — each active event with the matching red/yellow `!` symbol so the map badge visually connects to its text. If none: omit section (or one quiet "No warnings in effect" line — open detail).
  3. Regular forecast: wind, then weather & visibility.
  4. Extended forecast: one line per named day.
  5. `statusStatement` rendered as plain text if ever present (e.g. season-end notices; unused on Pacific but don't drop silently).
- Scrollable; **X always visible top-right of the panel**. Panel must not collide with the Controls stack (sit below it or span narrower).
- Close via: X, or tapping anywhere outside the panel. First outside tap only closes the panel (no tap-through to map/stations).
- Tapping a different polygon is impossible while modal (map is inert) — switching areas = close, tap another.

## 3. Networking, freshness, connectivity

- **One slim fetch** (§1.1 URL) feeds everything: badge, panel text, connectivity state.
- Fetch triggers: app load (if ever-enabled flag set) · hourly timer while foregrounded · `visibilitychange`/`pageshow` (iOS standalone resume) · `online` event · tap on grey button · toggling the layer on when held data is older than ~15 min.
- **Connectivity state** = "last fetch attempt succeeded, and data age < staleness cutoff (~2 h)". `navigator.onLine` is only a hint (false → grey immediately; true is not trusted — captive portals). A failed refresh greys the button and **discards** held data rather than showing it stale.
- Recovery UX on iPhone standalone: automatic on app-resume via `pageshow` (the natural leave-and-come-back gesture), or manual via tapping the grey button. No reload ever required.
- Forecasts issue ~4×/day (Pacific: ~04:00 / 10:30 / 16:00 / 21:30 PT) plus amendments; hourly polling is comfortably fresh. `lastUpdated` per feature detects amendments.

## 4. Persistence keys

- `pref-show-weather` — layer toggle (persisted like other prefs).
- `weather-ever-enabled` — set once on first enable; gates all polling.

## 5. Attribution / terms

- Info modal: "Marine forecasts and warnings: Environment and Climate Change Canada" (per ECCC data licence).
- TOS: add a line that weather display is informational and not a substitute for official broadcasts (Coast Guard / WX radio); bump `TOS_VERSION` in `store.ts` if wording changes require re-acceptance.

## 6. Implementation sketch

Data pipeline (one-time + on package version bumps):
- New script (Python, project venv) `canada_data/marine_zones/extract_subzones.py`: download/read the Water_Unproj zip, filter `water_MarSubZone_hybrid` to the configured CLC list, attach `site_code` (API feature id), `name_en`, `nom_fr`, `clc`, write `web/public/data/marine_zones.geojson`. Static file, fixed path (not year-scoped; manifest registration unnecessary — fetch like `manifest.json`).

Web app (all new files unless noted):
- `web/src/data/marineForecast.ts` — slim fetch, parse into per-sub-zone records (joins per §1.1 quirks), staleness/connectivity signals, poll scheduling.
- `web/src/state/store.ts` (edit) — `showWeather`, `weatherEverEnabled`, `weatherData`, `weatherOnline`, `selectedZoneId` signals.
- `web/src/map/marineZoneLayer.ts` — the app's **first** real MapLibre `addSource`/`addLayer` (geojson fill + line), attached in `map.on("load")` in `app.tsx`; badge markers as DOM `maplibregl.Marker`s (reusing the existing marker idiom); click handling via `map.queryRenderedFeatures` filtered to the fill layer, suppressed when a station marker was hit.
- `web/src/ui/WeatherPanel.tsx` — top panel, modal scrim beneath it to swallow all interaction, X close, scroll.
- `web/src/ui/Controls.tsx` (edit) — Weather button + grey/badge states.
- `web/src/ui/InfoModal.tsx`, `notes/TOS.md` (edit) — attribution.

Testing:
- Unit-test the API→record parser against saved fixtures (the 2026-07-24 responses in repo test fixtures: 6 areas, 6 active warnings incl. Georgia-north-only strong wind + Juan de Fuca gales — exercises sub-zone joins, ENDED filtering, badge logic).
- Data-invariant test on generated `marine_zones.geojson`: polygon validity, zero pairwise overlap, expected CLC set (mirrors `tideDataInvariants.test.ts` pattern).

## 7. Open questions

1. Exact initial zone list: core 9 Salish Sea sub-zones, or include WCVI South / Queen Charlotte Strait edges?
2. Grey-button tap-to-retry confirmed? (Recommended above; alternative is fully inert + automatic recovery only.)
3. Empty warnings section in panel: omit vs. "No warnings in effect" line.
4. Poll interval (default 60 min) and staleness cutoff (default 2 h) — tune later.
5. Badge red dot on the Weather button: colour/size details at implementation time.
