// Marine forecast text panel. Opens when a weather zone is tapped
// (selectedZoneId non-null) and is fully modal: a scrim covers the whole
// app underneath — map, stations, scrubber, controls — so nothing else is
// interactive until it closes (X button or any tap on the scrim).
//
// Two body layouts by zone country:
//   CA — ECCC structure: warnings, Wind, Weather & visibility, extended
//        forecast (notes/weather_plan.md §2), with labelled sub-location
//        blocks when an area's forecast is split.
//   US — NWS CWF structure: warnings (from CAP alerts), headline lines,
//        one text block per named period (wind+waves+weather combined),
//        then the product synopsis.
// Issue times for both are rendered from UTC in the app's display zone
// (America/Vancouver) — BC and Washington disagree about DST.

import { useEffect } from "preact/hooks";
import {
  marineZones,
  selectedZoneId,
  usWeatherData,
  weatherData,
} from "../state/store";
import {
  formatIssued,
  subLocationLabel,
  zoneExtendedForecasts,
  zoneRegularForecasts,
  zoneWarnings,
} from "../data/marineForecast";
import type {
  MarineForecastData,
  MarineWarningEvent,
  MarineZoneInfo,
  UsMarineForecastData,
} from "../types";

function close() {
  selectedZoneId.value = null;
}

function WarningRows({ warnings }: { warnings: MarineWarningEvent[] }) {
  if (warnings.length === 0) return null;
  return (
    <div class="weather-warnings">
      {warnings.map((w) => (
        <div class="weather-warning-row" key={w.name}>
          <span class={`weather-badge inline ${w.type}`}>!</span>
          <span class="weather-warning-name">{w.name}</span>
        </div>
      ))}
    </div>
  );
}

function CanadaBody({
  zone,
  data,
}: {
  zone: MarineZoneInfo;
  data: MarineForecastData;
}) {
  const area = data.areasBySite.get(zone.site_code);
  const regulars = zoneRegularForecasts(data, zone.site_code, zone.nom_fr);
  const extendeds = zoneExtendedForecasts(data, zone.site_code, zone.nom_fr);
  const warnings = zoneWarnings(data, zone.site_code, zone.name_en);
  // More than one block only when a whole-area zone's forecast is split
  // into sub-locations (e.g. Queen Charlotte Sound halves) — then each
  // block gets a labelled heading.
  const splitRegular = regulars.length > 1;
  const splitExtended = extendeds.length > 1;

  return (
    <>
      <WarningRows warnings={warnings} />

      {regulars.map((r, i) => (
        <div key={r.nameFr ?? i}>
          {splitRegular && (
            <h4 class="weather-subloc">
              {subLocationLabel(r.nameFr) ?? r.nameFr}
            </h4>
          )}
          {r.wind && (
            <section>
              <h3>Wind</h3>
              <p>{r.wind}</p>
            </section>
          )}
          {r.weatherVisibility && (
            <section>
              <h3>Weather &amp; visibility</h3>
              <p>{r.weatherVisibility}</p>
            </section>
          )}
        </div>
      ))}

      {extendeds.some((e) => e.periods.length > 0) && (
        <section>
          <h3>Extended forecast</h3>
          {extendeds.map((e, i) => (
            <div key={e.nameFr ?? i}>
              {splitExtended && (
                <h4 class="weather-subloc">
                  {subLocationLabel(e.nameFr) ?? e.nameFr}
                </h4>
              )}
              {e.periods.map((p) => (
                <p class="weather-extended-row" key={p.day}>
                  <strong>{p.day}</strong> {p.text}
                </p>
              ))}
            </div>
          ))}
        </section>
      )}

      {area?.statusStatements.map((s) => (
        <p class="weather-status-statement" key={s}>
          {s}
        </p>
      ))}

      {regulars.length === 0 &&
        !extendeds.some((e) => e.periods.length > 0) && (
          <p>No forecast text available for this zone.</p>
        )}
    </>
  );
}

function UsBody({
  zone,
  data,
}: {
  zone: MarineZoneInfo;
  data: UsMarineForecastData;
}) {
  const fc = data.forecastsByZone.get(zone.site_code);
  const warnings = data.warningsByZone.get(zone.site_code) ?? [];

  return (
    <>
      <WarningRows warnings={warnings} />
      {fc?.headlines.map((h) => (
        <p class="weather-headline" key={h}>
          {h}
        </p>
      ))}

      {fc && fc.periods.length > 0 ? (
        <section>
          {fc.periods.map((p) => (
            <p class="weather-extended-row" key={p.name}>
              <strong>{p.name}</strong> {p.text}
            </p>
          ))}
        </section>
      ) : (
        <p>No forecast text available for this zone.</p>
      )}

      {data.synopsis && (
        <section>
          <h3>Synopsis</h3>
          <p>{data.synopsis}</p>
        </section>
      )}
    </>
  );
}

export function WeatherPanel() {
  const clc = selectedZoneId.value;
  const caData = weatherData.value;
  const usData = usWeatherData.value;
  const zones = marineZones.value;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  if (clc === null || !zones) return null;
  const zone = zones.find((z) => z.clc === clc);
  if (!zone) return null;
  // The tapped zone's own country's data must be held (never-stale) —
  // if that source just failed mid-view, the panel closes with it.
  if (zone.country === "US" ? !usData : !caData) return null;

  const issued = formatIssued(
    zone.country === "US"
      ? usData!.issuedUtc
      : (caData!.areasBySite.get(zone.site_code)?.issuedUtc ?? null),
  );
  const periodOfCoverage =
    zone.country === "CA"
      ? zoneRegularForecasts(caData!, zone.site_code, zone.nom_fr)[0]
          ?.periodOfCoverage
      : null;

  return (
    <div
      class="weather-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="weather-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div class="weather-panel">
        <div class="weather-header">
          <div class="weather-header-text">
            <h2 id="weather-title" class="weather-title">
              {zone.name_en}
            </h2>
            {issued && <div class="weather-issued">{issued}</div>}
            {periodOfCoverage && (
              <div class="weather-period">Valid: {periodOfCoverage}</div>
            )}
          </div>
          <button
            class="weather-close"
            type="button"
            aria-label="Close"
            onClick={close}
          >
            ×
          </button>
        </div>
        <div class="weather-body">
          {zone.country === "US" ? (
            <UsBody zone={zone} data={usData!} />
          ) : (
            <CanadaBody zone={zone} data={caData!} />
          )}
        </div>
      </div>
    </div>
  );
}
