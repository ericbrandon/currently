// Marine forecast text panel. Opens when a weather zone is tapped
// (selectedZoneId non-null) and is fully modal: a scrim covers the whole
// app underneath — map, stations, scrubber, controls — so nothing else is
// interactive until it closes (X button or any tap on the scrim).
//
// Content order (notes/weather_plan.md §2): zone name + issue time +
// period of coverage, warnings/watches (with the badge glyph matching the
// map), wind, weather & visibility, extended forecast, status statements.

import { useEffect } from "preact/hooks";
import { marineZones, selectedZoneId, weatherData } from "../state/store";
import {
  formatIssued,
  subLocationLabel,
  zoneExtendedForecasts,
  zoneRegularForecasts,
  zoneWarnings,
} from "../data/marineForecast";

function close() {
  selectedZoneId.value = null;
}

export function WeatherPanel() {
  const clc = selectedZoneId.value;
  const data = weatherData.value;
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

  if (clc === null || !data || !zones) return null;
  const zone = zones.find((z) => z.clc === clc);
  if (!zone) return null;

  const area = data.areasBySite.get(zone.site_code);
  const regulars = zoneRegularForecasts(data, zone.site_code, zone.nom_fr);
  const extendeds = zoneExtendedForecasts(data, zone.site_code, zone.nom_fr);
  const warnings = zoneWarnings(data, zone.site_code, zone.name_en);
  const issued = formatIssued(area?.issuedLocal ?? null);
  // More than one block only when a whole-area zone's forecast is split
  // into sub-locations (e.g. Queen Charlotte Sound halves) — then each
  // block gets a labelled heading.
  const splitRegular = regulars.length > 1;
  const splitExtended = extendeds.length > 1;

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
            {regulars[0]?.periodOfCoverage && (
              <div class="weather-period">
                Valid: {regulars[0].periodOfCoverage}
              </div>
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
          {warnings.length > 0 && (
            <div class="weather-warnings">
              {warnings.map((w) => (
                <div class="weather-warning-row" key={w.name}>
                  <span class={`weather-badge inline ${w.type}`}>!</span>
                  <span class="weather-warning-name">{w.name}</span>
                </div>
              ))}
            </div>
          )}

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
        </div>
      </div>
    </div>
  );
}
