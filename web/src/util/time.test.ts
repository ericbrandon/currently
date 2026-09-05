import { describe, it, expect } from "vitest";
import {
  localDateOf,
  localNoonUtcMs,
  localMidnightUtcMs,
  compareLocalDates,
} from "./time";

const CHECK = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Vancouver",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
const wall = (ms: number) => CHECK.format(new Date(ms)).replace(", ", " ");

// Dates chosen to straddle the DST transitions the zone database knows
// about for 2026 (Mar 8 spring-forward, Nov 1 fall-back / permanent UTC-7).
const DATES = [
  "2026-01-15", "2026-03-07", "2026-03-08", "2026-03-09",
  "2026-07-01", "2026-10-31", "2026-11-01", "2026-11-02", "2026-12-31",
];

describe("localNoonUtcMs", () => {
  it.each(DATES)("resolves 12:00 wall clock on %s", (d) => {
    const [y, m, day] = d.split("-").map(Number);
    expect(wall(localNoonUtcMs({ year: y, month: m, day }))).toBe(`${d} 12:00`);
  });
});

describe("localMidnightUtcMs", () => {
  it.each(DATES)("resolves 00:00 wall clock on %s", (d) => {
    const [y, m, day] = d.split("-").map(Number);
    const noon = localNoonUtcMs({ year: y, month: m, day });
    expect(wall(localMidnightUtcMs(noon))).toBe(`${d} 00:00`);
  });
});

describe("localDateOf", () => {
  it("uses the BC calendar date, not UTC's", () => {
    // 2026-07-02 03:00Z is still the evening of Jul 1 in Vancouver (UTC-7).
    const ms = Date.parse("2026-07-02T03:00:00Z");
    expect(localDateOf(ms)).toEqual({ year: 2026, month: 7, day: 1 });
  });
  it("round-trips through localNoonUtcMs", () => {
    const d = { year: 2026, month: 11, day: 1 };
    expect(localDateOf(localNoonUtcMs(d))).toEqual(d);
  });
});

describe("compareLocalDates", () => {
  it("orders by year, then month, then day", () => {
    const a = { year: 2026, month: 3, day: 9 };
    expect(compareLocalDates(a, { year: 2026, month: 3, day: 9 })).toBe(0);
    expect(compareLocalDates(a, { year: 2026, month: 3, day: 10 })).toBeLessThan(0);
    expect(compareLocalDates(a, { year: 2026, month: 2, day: 28 })).toBeGreaterThan(0);
    expect(compareLocalDates(a, { year: 2025, month: 12, day: 31 })).toBeGreaterThan(0);
  });
});
