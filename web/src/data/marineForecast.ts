// Marine forecast fetch + parse + polling, both countries.
//
// Canada — one slim request against the GeoMet OGC API
// (marineweather-realtime, skipGeometry — polygons are pre-baked locally)
// returns structured forecast text and warnings for every Canadian zone.
// US — api.weather.gov serves no marine-zone forecast JSON, so text comes
// from the raw Coastal Waters Forecast (CWF) product of the Seattle
// office (parsed here), and warnings from the CAP alerts endpoint.
// All endpoints are CORS-enabled; no proxy. See notes/weather_plan.md.
//
// Freshness/connectivity model:
//   - Polling always runs (armed at app startup): the data also feeds
//     the Weather button's alert dot, and every fetch is a few KB.
//   - Refresh on: startup, hourly timer, tab resume (visibilitychange /
//     pageshow), browser `online` event, manual retry (grey button tap).
//   - The two sources fail INDEPENDENTLY: a NWS outage nulls only
//     usWeatherData — Canadian zones keep rendering (and vice versa).
//     The button greys only when no source produced data.
//   - Never-stale rule: a failed refresh nulls that source's data; held
//     text is discarded rather than shown stale.

import {
  usWeatherData,
  weatherData,
  weatherOnline,
} from "../state/store";
import { formatThumb } from "../util/time";
import type {
  MarineAreaForecast,
  MarineExtendedForecast,
  MarineForecastData,
  MarineSubLocationForecast,
  MarineWarningEvent,
  UsZoneForecast,
} from "../types";

const CA_API_URL =
  "https://api.weather.gc.ca/collections/marineweather-realtime/items" +
  "?f=json&bbox=-134.5,48,-122.5,55&limit=50&skipGeometry=true";

// Seattle forecast office covers all six US zones with one product.
const US_ZONE_IDS = [
  "PZZ130", "PZZ131", "PZZ132", "PZZ133", "PZZ134", "PZZ135",
];
const CWF_LIST_URL =
  "https://api.weather.gov/products/types/CWF/locations/SEW";
const US_ALERTS_URL =
  "https://api.weather.gov/alerts/active?zone=" + US_ZONE_IDS.join(",");

export const POLL_MS = 60 * 60 * 1000; // 1 h — forecasts issue ~4×/day
// Toggling the layer on refreshes only if held data is older than this.
const REFRESH_IF_OLDER_MS = 15 * 60 * 1000;

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------
// Severity display class. Red is reserved for true warnings (gale,
// storm, hurricane-force, strong wind); watches, advisories (Small
// Craft Advisory), statements, and anything unrecognised render yellow.
// ---------------------------------------------------------------

function eventClassFromEcccType(typeEn: string): "warning" | "watch" {
  return typeEn.toLowerCase() === "warning" ? "warning" : "watch";
}

function eventClassFromNwsName(event: string): "warning" | "watch" {
  return /warning/i.test(event) ? "warning" : "watch";
}

// ---------------------------------------------------------------
// Canada: parsing the marineweather-realtime feed. Exported for tests.
// Defensive throughout — the collection is labelled experimental, so a
// missing branch degrades to empty rather than throwing.
// ---------------------------------------------------------------

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
        type: eventClassFromEcccType(en(ev?.type)),
      });
    }
    if (events.length > 0) warningsByZone.set(zoneName, events);
  }

  return {
    siteCode: String(f?.id ?? ""),
    areaNameEn: en(p.area?.value),
    issuedUtc: p.regularForecast?.issuedDatetimeUTC ?? null,
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
// US: parsing the CWF text product. Exported for tests.
//
// The product is UGC-segmented:
//   PZZ133-250900-                       <- zone codes + expiry
//   Northern Inland Waters...-           <- name line(s)
//   1259 PM PDT Fri Jul 24 2026          <- issuance stamp
//   ...SMALL CRAFT ADVISORY...           <- optional headlines
//   .TONIGHT...S wind 5 to 10 kt. ...    <- named periods
//   $$                                   <- segment terminator
// A segment's UGC line can name several zones ("PZZ131-132-" or ranges
// "PZZ131>133-"); its text applies to each. The PZZ100 segment carries
// the synopsis.
// ---------------------------------------------------------------

/** Expand a UGC code string ("PZZ131-132-250900" or "PZZ131>133-...")
 *  into zone ids. The trailing 6-digit expiry is ignored. */
export function expandUgc(codes: string): string[] {
  const out: string[] = [];
  let prefix = "";
  for (const token of codes.split("-")) {
    const t = token.trim();
    if (!t || /^\d{6}$/.test(t)) continue; // expiry stamp
    const range = t.match(/^(?:([A-Z]{2}Z))?(\d{3})>(?:[A-Z]{2}Z)?(\d{3})$/);
    if (range) {
      if (range[1]) prefix = range[1];
      const from = parseInt(range[2], 10);
      const to = parseInt(range[3], 10);
      for (let n = from; n <= to; n++) {
        out.push(prefix + String(n).padStart(3, "0"));
      }
      continue;
    }
    const single = t.match(/^(?:([A-Z]{2}Z))?(\d{3})$/);
    if (single) {
      if (single[1]) prefix = single[1];
      out.push(prefix + single[2]);
    }
  }
  return out;
}

export function parseCwf(productText: string): {
  synopsis: string | null;
  forecastsByZone: Map<string, UsZoneForecast>;
} {
  const forecastsByZone = new Map<string, UsZoneForecast>();
  let synopsis: string | null = null;

  for (const rawSegment of productText.split("$$")) {
    const ugcMatch = rawSegment.match(/^([A-Z]{2}Z[\d>-]*\d)-\s*$/m);
    if (!ugcMatch) continue;
    const zoneIds = expandUgc(ugcMatch[1]);
    const body = rawSegment.slice(
      rawSegment.indexOf(ugcMatch[0]) + ugcMatch[0].length,
    );

    // Named periods: ".TONIGHT...text" until the next period or end of
    // segment. Long names wrap lines in the real product (".SYNOPSIS FOR
    // THE NORTHERN AND CENTRAL WASHINGTON COASTAL AND\nINLAND WATERS...").
    const periods: { name: string; text: string }[] = [];
    const periodRe = /^\.([A-Z][A-Z .\r\n]*?)\.\.\./gm;
    const matches = [...body.matchAll(periodRe)];
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index! + matches[i][0].length;
      const end = i + 1 < matches.length ? matches[i + 1].index! : body.length;
      periods.push({
        name: matches[i][1].replace(/\s+/g, " ").trim(),
        text: body.slice(start, end).replace(/\s+/g, " ").trim(),
      });
    }

    // Headlines ("...SMALL CRAFT ADVISORY IN EFFECT...") sit between the
    // issuance stamp and the first period, and wrap lines too.
    const headBlock =
      matches.length > 0 ? body.slice(0, matches[0].index!) : body;
    const headlines = [
      ...headBlock.matchAll(/^\.{3}([\s\S]+?)\.{3}\s*$/gm),
    ].map((m) => m[1].replace(/\s+/g, " ").trim());

    if (zoneIds.includes("PZZ100")) {
      const syn = periods.find((p) => p.name.startsWith("SYNOPSIS"));
      if (syn) synopsis = syn.text;
      continue;
    }
    for (const zoneId of zoneIds) {
      forecastsByZone.set(zoneId, { zoneId, headlines, periods });
    }
  }
  return { synopsis, forecastsByZone };
}

export function parseUsAlerts(json: any): Map<string, MarineWarningEvent[]> {
  const warningsByZone = new Map<string, MarineWarningEvent[]>();
  for (const f of json?.features ?? []) {
    const p = f?.properties ?? {};
    const event = String(p.event ?? "");
    if (!event) continue;
    const ugc: string[] = p.geocode?.UGC ?? [];
    for (const zoneId of ugc) {
      if (!US_ZONE_IDS.includes(zoneId)) continue;
      const list = warningsByZone.get(zoneId) ?? [];
      list.push({ name: event, type: eventClassFromNwsName(event) });
      warningsByZone.set(zoneId, list);
    }
  }
  return warningsByZone;
}

// ---------------------------------------------------------------
// Per-zone lookups (joins between marine_zones.geojson properties and the
// parsed feeds). Used by the zone layer (badges) and the WeatherPanel.
// ---------------------------------------------------------------

function sameLoc(nameFr: string | null, nomFr: string): boolean {
  // The API capitalises the first letter ("Détroit de..."), the shapefile
  // doesn't ("détroit de...").
  return nameFr !== null && nameFr.toLowerCase() === nomFr.toLowerCase();
}

/** Active warning/watch events for one Canadian zone (empty if none).
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

/** Regular-forecast text for one Canadian zone. Usually one entry: the
 *  area's single undivided location, or the sub-location matching the
 *  zone's French name. A whole-area zone whose forecast is currently
 *  split (Queen Charlotte Sound halves) returns every sub-location, in
 *  feed order — the panel renders each with a label. */
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

/** Extended-forecast periods for one Canadian zone, same matching rule. */
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

/** "Issued Fri, Jul 24 16:00" from an ISO UTC timestamp, rendered in the
 *  app's display zone (America/Vancouver) like every other time in the
 *  app. Never derived from the source's local clock: BC is permanent
 *  UTC-7 while Washington still observes DST, so ECCC's and NWS's local
 *  stamps disagree with the app convention part of the year. */
export function formatIssued(issuedUtc: string | null): string | null {
  if (!issuedUtc) return null;
  const ms = Date.parse(issuedUtc);
  if (Number.isNaN(ms)) return null;
  return `Issued ${formatThumb(ms)}`;
}

// ---------------------------------------------------------------
// Fetch + polling.
// ---------------------------------------------------------------

// Cap hung requests: a black-holed connection would otherwise dangle for
// the browser's own timeout (minutes) while the in-flight coalescing
// blocks new refresh rounds.
const FETCH_TIMEOUT_MS = 15_000;

async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`${url} → HTTP ${resp.status}`);
  return resp.json();
}

async function refreshCanada(): Promise<boolean> {
  try {
    weatherData.value = parseMarineForecast(await fetchJson(CA_API_URL));
    return true;
  } catch (e) {
    console.warn("ECCC marine refresh failed:", e);
    weatherData.value = null;
    return false;
  }
}

async function refreshUs(): Promise<boolean> {
  try {
    // Latest CWF product: list endpoint, then the product itself.
    const list = await fetchJson(CWF_LIST_URL);
    const latest = list?.["@graph"]?.[0];
    if (!latest?.["@id"]) throw new Error("no CWF product available");
    const [product, alerts] = await Promise.all([
      fetchJson(latest["@id"]),
      fetchJson(US_ALERTS_URL),
    ]);
    const { synopsis, forecastsByZone } = parseCwf(
      String(product?.productText ?? ""),
    );
    if (forecastsByZone.size === 0) throw new Error("CWF parsed empty");
    usWeatherData.value = {
      fetchedAt: Date.now(),
      issuedUtc: product?.issuanceTime ?? null,
      synopsis,
      forecastsByZone,
      warningsByZone: parseUsAlerts(alerts),
    };
    return true;
  } catch (e) {
    console.warn("NWS marine refresh failed:", e);
    usWeatherData.value = null;
    return false;
  }
}

let inFlight: Promise<boolean> | null = null;

/** Refresh both sources. Resolves true if AT LEAST ONE source produced
 *  data (the button only greys when everything failed). Each source
 *  applies the never-stale rule to itself independently. Coalesces
 *  concurrent callers onto one round. */
export function refreshMarineForecast(): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const [caOk, usOk] = await Promise.all([refreshCanada(), refreshUs()]);
      const ok = caOk || usOk;
      weatherOnline.value = ok;
      return ok;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function goOffline(): void {
  weatherOnline.value = false;
  weatherData.value = null;
  usWeatherData.value = null;
}

function refreshIfDue(): void {
  // navigator.onLine lies when it says "online" (captive portals) but is
  // always right when it says "offline" (airplane mode). Without this
  // check, waking with fresh-enough data attempts no fetch, so nothing
  // fails and the button never greys even though the network is gone.
  if (!navigator.onLine) {
    goOffline();
    return;
  }
  const ca = weatherData.value;
  const us = usWeatherData.value;
  const newest = Math.max(ca?.fetchedAt ?? 0, us?.fetchedAt ?? 0);
  // Refresh when either source is missing (retry a down source on every
  // wake) or the round is simply old.
  if (!ca || !us || Date.now() - newest > REFRESH_IF_OLDER_MS) {
    void refreshMarineForecast();
  }
}

let pollingStarted = false;

/** Idempotent. Called once at app startup. */
export function initMarineWeather(): void {
  if (pollingStarted) return;
  pollingStarted = true;

  const onWake = () => {
    if (document.visibilityState !== "hidden") refreshIfDue();
  };
  const onOnline = () => void refreshMarineForecast();

  void refreshMarineForecast();
  setInterval(() => refreshIfDue(), POLL_MS);
  document.addEventListener("visibilitychange", onWake);
  window.addEventListener("pageshow", onWake);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", goOffline);
}
