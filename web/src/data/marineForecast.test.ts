// Parser tests against a saved live response from the GeoMet
// marineweather-realtime collection (fetched 2026-07-24, skipGeometry).
// That evening had a usefully rich warning state: strong wind warnings in
// four zones (including ONLY the northern half of the Strait of Georgia)
// and gale warnings in two of the three Juan de Fuca sub-zones — so the
// fixture exercises sub-zone joins, the French-name quirk, and severity
// typing. See notes/weather_plan.md §1.1.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  formatIssued,
  parseMarineForecast,
  zoneExtendedForecast,
  zoneRegularForecast,
  zoneWarnings,
} from "./marineForecast";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/marineweather-2026-07-24.json", import.meta.url),
    "utf-8",
  ),
);

const data = parseMarineForecast(fixture);

describe("parseMarineForecast", () => {
  it("parses all six areas by site code", () => {
    expect([...data.areasBySite.keys()].sort()).toEqual([
      "m0000009", // Juan de Fuca Strait
      "m0000010", // Johnstone Strait
      "m0000028", // Strait of Georgia
      "m0000064", // Haro Strait
      "m0000065", // WCVI South
      "m0000102", // Howe Sound
    ]);
  });

  it("keeps sub-locations for split areas, single location otherwise", () => {
    expect(data.areasBySite.get("m0000028")!.regular).toHaveLength(2);
    expect(data.areasBySite.get("m0000009")!.regular).toHaveLength(3);
    const haro = data.areasBySite.get("m0000064")!;
    expect(haro.regular).toHaveLength(1);
    expect(haro.regular[0].nameFr).toBeNull();
  });

  it("extracts forecast text fields", () => {
    const georgiaSouth = zoneRegularForecast(
      data,
      "m0000028",
      "détroit de Georgie - au sud de Nanaimo",
    );
    expect(georgiaSouth).not.toBeNull();
    expect(georgiaSouth!.wind).toMatch(/^Wind variable 5 to 15 knots/);
    expect(georgiaSouth!.weatherVisibility).toBe("Showers overnight.");
    expect(georgiaSouth!.periodOfCoverage).toBe("Tonight and Saturday.");
  });

  it("matches split-area sub-locations case-insensitively (API capitalises, shapefile doesn't)", () => {
    const north = zoneRegularForecast(
      data,
      "m0000028",
      "détroit de Georgie - au nord de Nanaimo",
    );
    const south = zoneRegularForecast(
      data,
      "m0000028",
      "détroit de Georgie - au sud de Nanaimo",
    );
    expect(north).not.toBeNull();
    expect(south).not.toBeNull();
    expect(north!.wind).not.toBe(south!.wind);
  });

  it("returns per-sub-location extended forecasts for Juan de Fuca", () => {
    const ext = zoneExtendedForecast(
      data,
      "m0000009",
      "détroit de Juan de Fuca - partie centrale",
    );
    expect(ext).not.toBeNull();
    expect(ext!.periods).toHaveLength(3);
    expect(ext!.periods[0].day).toBe("Sunday");
    expect(ext!.periods[0].text).toMatch(/^Wind/);
  });

  it("keys warnings by English sub-zone name with severity type", () => {
    // Strong wind warning applies to the NORTH half of Georgia only.
    expect(
      zoneWarnings(data, "m0000028", "Strait of Georgia - north of Nanaimo"),
    ).toEqual([{ name: "Strong wind warning", type: "warning" }]);
    expect(
      zoneWarnings(data, "m0000028", "Strait of Georgia - south of Nanaimo"),
    ).toEqual([]);
    // Gale warnings in two of three Juan de Fuca sub-zones.
    expect(
      zoneWarnings(data, "m0000009", "Juan de Fuca Strait - east entrance"),
    ).toEqual([{ name: "Gale warning", type: "warning" }]);
    expect(
      zoneWarnings(data, "m0000009", "Juan de Fuca Strait - west entrance"),
    ).toEqual([]);
  });

  it("drops ENDED events", () => {
    const doctored = JSON.parse(JSON.stringify(fixture));
    const first = doctored.features.find(
      (f: { id: string }) => f.id === "m0000064",
    );
    first.properties.warnings.locations[0].events[0].status.en = "ENDED";
    const parsed = parseMarineForecast(doctored);
    expect(zoneWarnings(parsed, "m0000064", "Haro Strait")).toEqual([]);
  });

  it("classifies watch events as watch", () => {
    const doctored = JSON.parse(JSON.stringify(fixture));
    const first = doctored.features.find(
      (f: { id: string }) => f.id === "m0000064",
    );
    const ev = first.properties.warnings.locations[0].events[0];
    ev.type.en = "watch";
    ev.name.en = "Squall watch";
    const parsed = parseMarineForecast(doctored);
    expect(zoneWarnings(parsed, "m0000064", "Haro Strait")).toEqual([
      { name: "Squall watch", type: "watch" },
    ]);
  });

  it("records issue timestamps", () => {
    expect(data.areasBySite.get("m0000028")!.issuedLocal).toBe(
      "2026-07-24T16:00:00-07:00",
    );
  });

  it("survives missing branches without throwing", () => {
    const parsed = parseMarineForecast({
      features: [{ id: "m0000001", properties: { area: {} } }],
    });
    const area = parsed.areasBySite.get("m0000001")!;
    expect(area.regular).toEqual([]);
    expect(area.extended).toEqual([]);
    expect(area.warningsByZone.size).toBe(0);
  });
});

describe("formatIssued", () => {
  it("formats from the string's own components (already BC local)", () => {
    expect(formatIssued("2026-07-24T16:00:00-07:00")).toBe(
      "Issued 4:00 PM Jul 24",
    );
    expect(formatIssued("2026-01-02T00:30:00-08:00")).toBe(
      "Issued 12:30 AM Jan 2",
    );
    expect(formatIssued(null)).toBeNull();
  });
});
