import { describe, expect, it } from "vitest";
import { dedupeEqualT } from "./loader";

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
