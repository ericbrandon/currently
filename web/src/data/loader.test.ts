import { describe, expect, it } from "vitest";
import { currentChartBound, dedupeEqualT, trimOverlaps } from "./loader";

describe("dedupeEqualT", () => {
  it("collapses the New Year overlap duplicate and keeps the later copy", () => {
    // 2026 (PST) prints Dec 31 23:32 = 07:32Z; 2027 (PDT) prints Jan 1 00:32 = 07:32Z.
    const t = Date.UTC(2027, 0, 1, 7, 32);
    const merged = [
      { t: t - 6 * 3600_000, v: 0.4 },
      { t, v: 1.8 },
      { t, v: 1.8, weak: true as const },
      { t: t + 6 * 3600_000, v: 0.5 },
    ];
    const out = dedupeEqualT(merged);
    expect(out.map((e) => e.t)).toEqual([t - 6 * 3600_000, t, t + 6 * 3600_000]);
    expect(out[1]).toEqual({ t, v: 1.8, weak: true });
  });

  it("leaves arrays without equal timestamps unchanged", () => {
    const a = [{ t: 1, v: 1 }, { t: 2, v: 2 }, { t: 3, v: 3 }];
    expect(dedupeEqualT(a)).toEqual(a);
  });
});

describe("trimOverlaps", () => {
  it("drops later-year events at or before the previous year's last event", () => {
    const t = Date.UTC(2027, 0, 1, 7, 30);
    const y2026 = [{ t: t - 6 * 3600_000, v: 0.4 }, { t, v: 1.8 }];
    const y2027 = [{ t: t - 5 * 60_000, v: 1.79 }, { t: t + 6 * 3600_000, v: 0.5 }];  // 5-min near-duplicate at the seam
    const out = trimOverlaps([y2026, y2027]);
    expect(out[0]).toEqual(y2026);
    expect(out[1]).toEqual([{ t: t + 6 * 3600_000, v: 0.5 }]);
  });
  it("leaves non-overlapping years alone", () => {
    const a = [{ t: 1, v: 1 }, { t: 2, v: 2 }]; const b = [{ t: 3, v: 3 }];
    expect(trimOverlaps([a, b])).toEqual([a, b]);
  });
});

describe("currentChartBound", () => {
  it("raises the printed bound to the largest emitted magnitude", () => {
    expect(currentChartBound(11, [{ t: 0, v: 11.44 }, { t: 1, v: -9 }])).toBe(11.44);
    expect(currentChartBound(11, [{ t: 0, v: 4 }])).toBe(11);
    expect(currentChartBound(undefined, [{ t: 0, v: -3 }])).toBe(3);
    expect(currentChartBound(undefined, [])).toBeUndefined();
  });
});
