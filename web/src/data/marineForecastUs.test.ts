// US (NWS) marine weather parsing tests: the CWF text-product parser
// against a saved live product (Seattle office, 2026-07-24 12:59 PM PDT
// issuance) and the CAP alerts mapper against a saved live response
// (one Small Craft Advisory spanning both central/east US Juan de Fuca
// zones that afternoon).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { expandUgc, parseCwf, parseUsAlerts } from "./marineForecast";

const cwfText = readFileSync(
  new URL("./fixtures/cwf-sew-2026-07-24.txt", import.meta.url),
  "utf-8",
);
const alertsFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/nws-alerts-2026-07-24.json", import.meta.url),
    "utf-8",
  ),
);

describe("expandUgc", () => {
  it("handles single zones and ignores the expiry stamp", () => {
    expect(expandUgc("PZZ133-250900")).toEqual(["PZZ133"]);
  });
  it("expands lists sharing the prefix", () => {
    expect(expandUgc("PZZ131-132-250900")).toEqual(["PZZ131", "PZZ132"]);
  });
  it("expands ranges", () => {
    expect(expandUgc("PZZ131>133-250900")).toEqual([
      "PZZ131",
      "PZZ132",
      "PZZ133",
    ]);
  });
});

describe("parseCwf (live fixture)", () => {
  const { synopsis, forecastsByZone } = parseCwf(cwfText);

  it("parses every app zone from the product", () => {
    for (const id of ["PZZ130", "PZZ131", "PZZ132", "PZZ133", "PZZ134", "PZZ135"]) {
      expect(forecastsByZone.has(id), id).toBe(true);
    }
  });

  it("extracts named periods with combined wind/waves text", () => {
    const sanJuans = forecastsByZone.get("PZZ133")!;
    expect(sanJuans.periods[0].name).toBe("TONIGHT");
    expect(sanJuans.periods[0].text).toMatch(/^S wind 5 to 10 kt/);
    expect(sanJuans.periods[0].text).toMatch(/Waves around 2 ft or less/);
    expect(sanJuans.periods.length).toBeGreaterThanOrEqual(8);
  });

  it("captures the synopsis segment and keeps it out of the zone map", () => {
    expect(synopsis).toBeTruthy();
    expect(forecastsByZone.has("PZZ100")).toBe(false);
  });
});

describe("parseCwf (synthetic shapes)", () => {
  const synthetic = [
    "PZZ131-132-251000-",
    "Combined Waters-",
    "100 PM PDT Fri Jul 24 2026",
    "",
    "...SMALL CRAFT ADVISORY IN EFFECT THROUGH SATURDAY EVENING...",
    "",
    ".TONIGHT...W wind 15 to 25 kt. Wind waves 2 to 4 ft.",
    ".SAT...W wind 10 to 20 kt.",
    "",
    "$$",
  ].join("\n");

  it("applies a combined-UGC segment to every listed zone, with headlines", () => {
    const { forecastsByZone } = parseCwf(synthetic);
    for (const id of ["PZZ131", "PZZ132"]) {
      const fc = forecastsByZone.get(id)!;
      expect(fc.headlines).toEqual([
        "SMALL CRAFT ADVISORY IN EFFECT THROUGH SATURDAY EVENING",
      ]);
      expect(fc.periods.map((p) => p.name)).toEqual(["TONIGHT", "SAT"]);
      expect(fc.periods[0].text).toBe(
        "W wind 15 to 25 kt. Wind waves 2 to 4 ft.",
      );
    }
  });
});

describe("parseUsAlerts", () => {
  it("maps the live Small Craft Advisory to yellow on both its zones", () => {
    const byZone = parseUsAlerts(alertsFixture);
    const expected = [{ name: "Small Craft Advisory", type: "watch" }];
    expect(byZone.get("PZZ131")).toEqual(expected);
    expect(byZone.get("PZZ132")).toEqual(expected);
    expect(byZone.has("PZZ133")).toBe(false);
  });

  it("maps warnings to red and ignores zones outside the app set", () => {
    const byZone = parseUsAlerts({
      features: [
        {
          properties: {
            event: "Gale Warning",
            geocode: { UGC: ["PZZ135", "PZZ156"] },
          },
        },
      ],
    });
    expect(byZone.get("PZZ135")).toEqual([
      { name: "Gale Warning", type: "warning" },
    ]);
    expect(byZone.has("PZZ156")).toBe(false);
  });
});
