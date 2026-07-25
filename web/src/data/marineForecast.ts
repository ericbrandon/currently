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
  "?f=json&bbox=-125.5,48,-122.5,50.5&limit=50&skipGeometry=true";

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

/** Active warning/watch events for one sub-zone (empty array if none). */
export function zoneWarnings(
  data: MarineForecastData,
  siteCode: string,
  zoneNameEn: string,
): MarineWarningEvent[] {
  return (
    data.areasBySite.get(siteCode)?.warningsByZone.get(zoneNameEn) ?? []
  );
}

/** The regular-forecast text for one sub-zone: matched by French name for
 *  split areas, or the area's single location otherwise. */
export function zoneRegularForecast(
  data: MarineForecastData,
  siteCode: string,
  nomFr: string,
): MarineSubLocationForecast | null {
  const area = data.areasBySite.get(siteCode);
  if (!area) return null;
  if (area.regular.length === 1) return area.regular[0];
  return area.regular.find((l) => sameLoc(l.nameFr, nomFr)) ?? null;
}

/** Extended-forecast periods for one sub-zone, same matching rule. */
export function zoneExtendedForecast(
  data: MarineForecastData,
  siteCode: string,
  nomFr: string,
): MarineExtendedForecast | null {
  const area = data.areasBySite.get(siteCode);
  if (!area) return null;
  if (area.extended.length === 1) return area.extended[0];
  return area.extended.find((l) => sameLoc(l.nameFr, nomFr)) ?? null;
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
