// ECCC marine forecast fetch + parse + polling.
//
// One slim request against the GeoMet OGC API (marineweather-realtime
// collection, skipGeometry — polygons are pre-baked locally) returns the
// forecast text and warnings for every forecast area covering the map.
// ~5 KB gzipped, CORS-enabled, no proxy. See notes/weather_plan.md §1.1/§3.
//
// Freshness/connectivity model:
//   - Poll only if the user has EVER enabled weather (weatherEverEnabled).
//   - Refresh on: enable, hourly timer, tab resume (visibilitychange /
//     pageshow), browser `online` event, manual retry (grey button tap).
//   - Never-stale rule: a failed refresh nulls weatherData and flips
//     weatherOnline false. The Weather button greys out; held text is
//     discarded rather than shown stale.

import {
  weatherData,
  weatherEverEnabled,
  weatherOnline,
} from "../state/store";
import type {
  MarineAreaForecast,
  MarineExtendedForecast,
  MarineForecastData,
  MarineSubLocationForecast,
  MarineWarningEvent,
} from "../types";

const API_URL =
  "https://api.weather.gc.ca/collections/marineweather-realtime/items" +
  "?f=json&bbox=-130.5,48,-122.5,52.4&limit=50&skipGeometry=true";

export const POLL_MS = 60 * 60 * 1000; // 1 h — forecasts issue ~4×/day
// Toggling the layer on refreshes only if held data is older than this.
const REFRESH_IF_OLDER_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------
// Parsing. Exported for tests (marineForecast.test.ts runs it against a
// saved live response). Defensive throughout — the collection is labelled
// experimental, so a missing branch degrades to empty rather than throwing.
// ---------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

function en(v: any): string {
  return typeof v === "string" ? v : (v?.en ?? "");
}

function parseArea(f: any): MarineAreaForecast {
  const p = f?.properties ?? {};
  const regular: MarineSubLocationForecast[] = [];
  const statusStatements: string[] = [];
  for (const loc of p.regularForecast?.locations ?? []) {
    const wc = loc?.weatherCondition ?? {};
    regular.push({
      // French-only in the live feed (weather_plan.md §1.1); may be absent
      // for single-location areas.
      nameFr: typeof loc?.name === "string" ? loc.name : null,
      periodOfCoverage: en(wc.periodOfCoverage),
      wind: en(wc.wind),
      weatherVisibility: en(wc.weatherVisibility),
    });
    const ss = en(loc?.statusStatement);
    if (ss) statusStatements.push(ss);
  }

  const extended: MarineExtendedForecast[] = [];
  for (const loc of p.extendedForecast?.locations ?? []) {
    const periods = (loc?.weatherCondition?.forecastPeriods ?? []).map(
      (fp: any) => ({ day: en(fp?.name), text: en(fp?.value) }),
    );
    extended.push({
      nameFr: typeof loc?.name === "string" ? loc.name : null,
      periods,
    });
  }

  const warningsByZone = new Map<string, MarineWarningEvent[]>();
  for (const loc of p.warnings?.locations ?? []) {
    const zoneName = en(loc?.name);
    if (!zoneName) continue;
    const events: MarineWarningEvent[] = [];
    for (const ev of loc?.events ?? []) {
      // ENDED events remain in the feed after expiry — drop them.
      if (en(ev?.status).toUpperCase() === "ENDED") continue;
      events.push({
        name: en(ev?.name),
        type: en(ev?.type).toLowerCase() === "watch" ? "watch" : "warning",
      });
    }
    if (events.length > 0) warningsByZone.set(zoneName, events);
  }

  return {
    siteCode: String(f?.id ?? ""),
    areaNameEn: en(p.area?.value),
    issuedLocal: p.regularForecast?.issuedDatetimeLocal ?? null,
    regular,
    extended,
    warningsByZone,
    statusStatements,
  };
}

export function parseMarineForecast(json: any): MarineForecastData {
  const areasBySite = new Map<string, MarineAreaForecast>();
  for (const f of json?.features ?? []) {
    const area = parseArea(f);
    if (area.siteCode) areasBySite.set(area.siteCode, area);
  }
  return { fetchedAt: Date.now(), areasBySite };
}

// ---------------------------------------------------------------
// Per-zone lookups (joins between marine_zones.geojson properties and the
// parsed feed). Used by the zone layer (badges) and the WeatherPanel.
// ---------------------------------------------------------------

function sameLoc(nameFr: string | null, nomFr: string): boolean {
  // The API capitalises the first letter ("Détroit de..."), the shapefile
  // doesn't ("détroit de...").
  return nameFr !== null && nameFr.toLowerCase() === nomFr.toLowerCase();
}

/** Active warning/watch events for one zone (empty array if none).
 *  Matches in both directions around ECCC's conditional splitting:
 *  a whole-area zone polygon (Queen Charlotte Sound) collects events
 *  issued for its sub-locations ("Queen Charlotte Sound - northern
 *  half"), and a sub-zone polygon collects an event issued area-wide. */
export function zoneWarnings(
  data: MarineForecastData,
  siteCode: string,
  zoneNameEn: string,
): MarineWarningEvent[] {
  const area = data.areasBySite.get(siteCode);
  if (!area) return [];
  const out: MarineWarningEvent[] = [];
  for (const [locName, events] of area.warningsByZone) {
    if (
      locName === zoneNameEn ||
      locName.startsWith(zoneNameEn + " - ") ||
      zoneNameEn.startsWith(locName + " - ")
    ) {
      out.push(...events);
    }
  }
  return out;
}

/** Regular-forecast text for one zone. Usually one entry: the area's
 *  single undivided location, or the sub-location matching the zone's
 *  French name. A whole-area zone whose forecast is currently split
 *  (Queen Charlotte Sound halves) returns every sub-location, in feed
 *  order — the panel renders each with a label. */
export function zoneRegularForecasts(
  data: MarineForecastData,
  siteCode: string,
  nomFr: string,
): MarineSubLocationForecast[] {
  const area = data.areasBySite.get(siteCode);
  if (!area) return [];
  const match = area.regular.find((l) => sameLoc(l.nameFr, nomFr));
  if (match) return [match];
  return area.regular;
}

/** Extended-forecast periods for one zone, same matching rule. */
export function zoneExtendedForecasts(
  data: MarineForecastData,
  siteCode: string,
  nomFr: string,
): MarineExtendedForecast[] {
  const area = data.areasBySite.get(siteCode);
  if (!area) return [];
  const match = area.extended.find((l) => sameLoc(l.nameFr, nomFr));
  if (match) return [match];
  return area.extended;
}

// Known sub-location qualifiers, French (as the feed spells them) →
// English (as ECCC's English site labels them). Used to head each text
// block when a whole-area zone's forecast is split — the feed only
// carries French sub-location names (weather_plan.md §1.1).
const SUB_LOC_EN: Record<string, string> = {
  "moitié nord": "Northern half",
  "moitié sud": "Southern half",
  "moitié est": "Eastern half",
  "moitié ouest": "Western half",
  "moitié nord-ouest": "Northwestern half",
  "moitié sud-est": "Southeastern half",
  "entrée est": "East entrance",
  "entrée ouest": "West entrance",
  "partie centrale": "Central strait",
  "au nord de nanaimo": "North of Nanaimo",
  "au sud de nanaimo": "South of Nanaimo",
};

/** English label for a French sub-location name ("bassin Reine-Charlotte
 *  - moitié nord" → "Northern half"); null when there is no qualifier. */
export function subLocationLabel(nameFr: string | null): string | null {
  if (!nameFr) return null;
  const dash = nameFr.indexOf(" - ");
  if (dash === -1) return null;
  const suffix = nameFr.slice(dash + 3).trim();
  return SUB_LOC_EN[suffix.toLowerCase()] ?? suffix;
}

/** "Issued 4:00 PM Jul 24" from the API's local-offset ISO timestamp.
 *  Formatted from the string's own components — it is already BC local
 *  time, and round-tripping through Date would re-interpret it in the
 *  viewer's timezone. */
export function formatIssued(issuedLocal: string | null): string | null {
  if (!issuedLocal) return null;
  const m = issuedLocal.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const month = months[parseInt(m[2], 10) - 1];
  const day = parseInt(m[3], 10);
  const h24 = parseInt(m[4], 10);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ampm = h24 < 12 ? "AM" : "PM";
  return `Issued ${h12}:${m[5]} ${ampm} ${month} ${day}`;
}

// ---------------------------------------------------------------
// Fetch + polling.
// ---------------------------------------------------------------

let inFlight: Promise<boolean> | null = null;

/** Fetch the feed once. Resolves true on success. On failure: applies the
 *  never-stale rule (data nulled, weatherOnline=false). Coalesces
 *  concurrent callers onto one request. */
export function refreshMarineForecast(): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const resp = await fetch(API_URL);
      if (!resp.ok) throw new Error(`marine forecast HTTP ${resp.status}`);
      const json = await resp.json();
      weatherData.value = parseMarineForecast(json);
      weatherOnline.value = true;
      return true;
    } catch (e) {
      console.warn("marine forecast refresh failed:", e);
      weatherData.value = null;
      weatherOnline.value = false;
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function refreshIfDue(): void {
  // navigator.onLine lies when it says "online" (captive portals) but is
  // always right when it says "offline" (airplane mode). Without this
  // check, waking with fresh-enough data attempts no fetch, so nothing
  // fails and the button never greys even though the network is gone.
  if (!navigator.onLine) {
    weatherOnline.value = false;
    weatherData.value = null;
    return;
  }
  const d = weatherData.value;
  if (!d || Date.now() - d.fetchedAt > REFRESH_IF_OLDER_MS) {
    void refreshMarineForecast();
  }
}

let pollingStarted = false;

/** Idempotent. Called once at app startup; arms everything lazily off the
 *  weatherEverEnabled latch so never-users trigger no network activity. */
export function initMarineWeather(): void {
  if (pollingStarted) return;
  pollingStarted = true;

  let timer: ReturnType<typeof setInterval> | null = null;

  const onWake = () => {
    if (document.visibilityState !== "hidden") refreshIfDue();
  };
  const onOnline = () => void refreshMarineForecast();
  const onOffline = () => {
    // Hint only in the other direction (captive portals lie about being
    // online), but onLine=false is trustworthy: grey out immediately.
    weatherOnline.value = false;
    weatherData.value = null;
  };

  const arm = () => {
    if (!weatherEverEnabled.value || timer !== null) return false;
    void refreshMarineForecast();
    timer = setInterval(() => refreshIfDue(), POLL_MS);
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("pageshow", onWake);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return true;
  };

  if (!arm()) {
    // Not yet enabled: watch for the first enable, then arm permanently.
    const unwatch = weatherEverEnabled.subscribe((v) => {
      if (v && arm()) queueMicrotask(() => unwatch());
    });
  }
}
