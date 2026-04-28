# Calculating tide heights and current speeds for primary stations

## What this document covers

This is the plan for the front-end module that, given:

- the JSON we already produce for primary tide stations (`{year}_tct_tidal_primary_stations.json`)
- the JSON we already produce for primary current stations (`{year}_tct_current_primary_stations.json`)
- a specific instant in time (the timeline scrubber position)

…returns the **interpolated tide height (m)** and/or **interpolated current speed (signed knots, + flood / − ebb)** for any primary station at that instant.

Secondary stations are *not* covered here — they are derived from a primary station via published differences and will live in a separate document.

## Architectural decision (recap)

We chose **option (b): compute on the fly**, *not* (a) precompute every 15-minute slot.

The reasons in one paragraph: the source JSON we already emit is small (~3 MB for vol 5 today, projected ~25 MB across all 7 volumes), the published HW/LW and slack/max points *are* CHS's canonical predictions (everyone interpolates between the same extremes), and the interpolation is one cosine evaluation behind a binary search. Sub-microsecond per call on a phone, no precomputation pipeline to maintain, no extra storage, and 2027's data plugs in by just dropping the next year's JSON next to this year's.

## The algorithm: sinusoidal between consecutive extremes

Tides and currents both interpolate sinusoidally between published events, but the *shape* of each segment differs because of what each published event physically is.

### Tides: half-cosine between two peaks

Every published tide event (HW or LW) is an extremum — slope zero. For two consecutive events at `(t₁, v₁)` and `(t₂, v₂)`:

```
τ    = (t − t₁) / (t₂ − t₁)                      # 0..1 within this segment
v(t) = (v₁ + v₂) / 2  +  (v₁ − v₂) / 2 · cos(π · τ)
```

Half a cosine cycle, stretched horizontally per segment to match its actual clock duration. Each segment is independently fitted regardless of the segment's actual clock duration, so:

- **Asymmetric durations are free.** A long ebb followed by a short flood at the same primary just stretches each half-cosine to its own duration.
- **Asymmetric magnitudes are free.** Vertical scaling per segment.
- **dv/dt = 0 at every extreme.** Correct — HW and LW are mathematical extrema. The curve is C¹-continuous through every published event.

### Currents: piecewise quarter-cycle (slacks vs maxes)

Currents are *not* a sequence of peaks. Published events alternate between **zero-crossings** (slacks at v=0, and weak/variable maxes also stored at v=0) and **true extrema** (signed maxes at v=±M). At a zero-crossing the current's slope is at its steepest — it's *crossing* zero, not sitting at it.

Half-cosine through both endpoints would force zero slope at slacks, which is physically wrong: it produces a "plateau-shoulder-plateau" curve that lingers near zero for too long and accelerates abruptly between slacks and maxes. The correct shape is a single sinusoid where slacks sit at zero crossings and maxes at peaks. Plugging the segment-pair classification into the standard `sin`/`cos`:

| Endpoint pair | Formula | Notes |
|---|---|---|
| slack (v=0) → max (v=M) | `v(τ) = M · sin(π τ / 2)` | quarter-sine; slope max at τ=0, zero at τ=1 |
| max (v=M) → slack (v=0) | `v(τ) = M · cos(π τ / 2)` | quarter-cosine; zero slope at τ=0, max slope at τ=1 |
| max → max (no slack between) | half-cosine, same form as tides | both endpoints are real extrema (e.g. consecutive same-sign maxes at JOHNSTONE STR. CEN.) |
| slack → slack (rare) | `0` | conservative; no information about where peak would have sat |

This matches the marine-navigation **50-90 rule** widely cited in tidal-stream guides (Starpath, RYA, NOAA): from a slack, the current reaches 50% of peak after 1/3 of the slack-to-max segment and ~87% (the rule says "90%") after 2/3. Plug `τ = 1/3` into `sin(πτ/2)` → `sin(30°) = 0.5` and `τ = 2/3` → `sin(60°) = 0.866`. Match.

The curve is **C¹-continuous at every max** (zero slope on both sides). At slacks it has a slope discontinuity in the general case — that's correct, because each side of a slack typically has a different segment duration; the magnitudes of `dv/dt` on each side scale with the inverse of those durations. Visually this is invisible (the discontinuity is at v=0, where the line crosses the axis cleanly).

Implementation lives at `valueAt.ts → currentSegment` / `currentValueAt`. `valueAt` (the half-cosine form) remains the tide-only interpolator.

### Why sinusoidal, not the rule of twelfths

The rule of twelfths (1/12, 2/12, 3/12, 3/12, 2/12, 1/12 of the range per hour) is a coarse mental approximation of the same sinusoidal curve, hard-quantized to 1-hour buckets and assuming a 6-hour symmetric interval. Use sinusoidal:

- it's continuous (no quarter-hour quantization stair-steps when the user scrubs);
- it works for any segment duration, not just 6 h;
- the cost is identical (one trig call vs. a six-bucket lookup).

### Why not full harmonic analysis

CHS does not publish per-station harmonic constants in the TCT PDFs, and fitting them from a year of HW/LW points alone is noisy. The marginal accuracy gain over sinusoidal-between-extremes (typically tens of centimetres for tides, fractions of a knot for currents) is not worth the implementation cost for a visualization app. If we ever ship a navigation/dive-planning feature that needs sub-decimetre or sub-tenth-knot accuracy, revisit.

There's also a CHS caveat to be aware of (PDF p. 7, *Reference Ports and Current Stations*): asymmetric ebb streams can have their max occur up to two hours away from the mid-point between turns, and *"the time given in the tables is chosen to represent the central time of the period of stronger flow rather than the time of the actual mathematical extreme."* Our sinusoidal model treats each published max time as a zero-slope extremum; in those asymmetric cases the published time is slightly off the true mathematical peak. This is a small visualization artefact that no two-event interpolator can avoid without harmonic constants.

## Behavioural decisions

### Weak/variable maxes (`*` in the PDF)

Per the source: when CHS prints `*` instead of a knots value in a maximum row, the current was too weak/turbulent to characterize cleanly. We model these as **`knots = 0`** with **`weak_variable: true`** in the JSON.

**Render rule:** treat them as actual extremes with v = 0 when interpolating. Reason: if we *skipped* them, the interpolator would draw a straight cosine between the surrounding ebb and ebb (or flood and flood) extremes, producing a curve that never actually crosses zero — visually wrong and physically misleading near the weak-current period.

**UI rule:** preserve the `weak_variable` flag through the front-end. The chart should distinguish a `*` zero from a real slack (e.g., a hollow dot vs. solid dot, or a hatched marker). The interpolated curve still passes through 0 at that timestamp; the UI just labels it differently.

### Out-of-year queries

If the scrubber's timestamp is before the first extreme of the year or after the last extreme, the interpolator returns `null`. We do **not** extrapolate, because there is no honest way to do so without the previous/next year's data. The caller renders nothing for that station at that instant (or a "no data" indicator).

### Day boundaries are invisible

The interpolator works on a single sorted array of all extremes for the year — it never thinks in terms of "today's events vs. tomorrow's". A query at 23:55 on Jan 1 properly interpolates between Jan 1's last extreme and Jan 2's first extreme, even when those straddle midnight.

The flatten-and-sort happens once when the JSON loads.

## Time zone & DST handling

This needs careful attention because BC has just changed its civil time policy.

### What's actually true (as of April 2026)

BC's last spring-forward was March 8, 2026. After November 1, 2026 — when the rest of the Pacific time zone falls back — BC will *not*, and will be on permanent UTC-7 (rebranded "Pacific time", but it's PDT year-round). Currently BC is on UTC-7 (PDT, the seasonal offset, identical to the post-Nov-1 permanent state).

### What CHS publishes

The 2026 TCT volume 5 PDF is internally **PST = UTC-8** throughout (every page header and Table 4 footer say "(UTC-8h)" or "PST"). CHS uses standard time consistently — they did not switch their published times when DST starts/ends, and they have not yet switched their published times to match BC's new permanent offset.

So as of right now, the user's wall clock (UTC-7) is one hour *ahead* of every time printed in the PDF.

### The architectural rule: trust the PDF, don't shift

The parser already extracts the offset from the page header (`(UTC-8h)`) and stores it on each station as `utc_offset: -8`. The interpolator uses this to convert PDF clock-times to absolute UTC ms once at load time.

```
absolute_utc_ms = Date.UTC(year, month-1, day, hh − utc_offset, mm)
```

For PST (utc_offset = −8): `06:00 station-local → 14:00 UTC ms` ✔
For PDT (utc_offset = −7): `07:00 station-local → 14:00 UTC ms` ✔

After this conversion, **everything internal is absolute UTC ms**. The webapp's display layer is responsible for converting absolute UTC to whatever the user sees on their wall clock (using the browser's `Intl.DateTimeFormat` with the appropriate timezone — `"America/Vancouver"` will track BC's permanent UTC-7 from Nov 1, 2026 onward, automatically).

**We never apply a manual ±1 hour shift in the data pipeline.** Doing so would silently break the moment CHS publishes their first volume in UTC-7. Instead:

- If the 2027 PDF still prints "PST (UTC-8h)" → our parser extracts −8, and the webapp's timezone-aware display layer adds the hour for users in BC.
- If the 2027 PDF prints "Pacific (UTC-7h)" or similar → our parser extracts −7 automatically, and no display offset is needed for BC users.

In both cases, the same code does the right thing because the offset is data, not a hardcoded constant.

### Things to flag in the code

The header pattern in `read_tct.py` is the single point where we trust the PDF:

```python
STATION_HEADER_PATTERN = re.compile(
    r"^(?P<name>...)\s+(?P<tz>...)\s+\(UTC(?P<offset>[+-]\d+)\)\s+(?P<year>\d{4})\s+TIDE\s+TABLES"
)
```

If a future volume changes this format, the parser will fail loudly (raise `ValueError`) rather than silently storing the wrong offset. That's the desired behaviour.

The interpolator's `stationTimeToUtcMs(year, month, day, hh:mm, utc_offset)` is the only place absolute UTC is computed. **No other code should reason about timezones**; everything downstream operates in absolute UTC milliseconds.

### What this looks like to a BC user, today

Suppose a primary tide station has a HW reading at `06:00` on April 27, 2026 in the PDF (which is PST, utc_offset = −8).

1. Loader computes: `Date.UTC(2026, 3, 27, 6 − (−8), 0)` = `Date.UTC(2026, 3, 27, 14, 0)` = `2026-04-27T14:00:00Z`.
2. The user, looking at their phone's clock in BC, sees `07:00 PDT` at that instant. The browser, asked to format `2026-04-27T14:00:00Z` for `America/Vancouver`, returns `07:00`.
3. The chart x-axis labels show `07:00` next to that HW dot. Correct.

Same example after Nov 1, 2026 (BC permanent UTC-7): `America/Vancouver` continues to return `07:00` for that instant, because it's tracking BC's *current* offset, not the historical PST. Correct.

## TypeScript implementation

```ts
// ============================================================
// Types matching the JSON shape produced by read_tct.py
// ============================================================

export type TideReading = { time: string; metres: number };
export type TideDay = { month: number; day: number; readings: TideReading[] };
export type TideStation = {
  name: string; year: number; utc_offset: number; days: TideDay[];
  // (other Tables 1/2 metadata fields exist on the JSON; not used by the interpolator)
};

export type CurrentEvent = {
  time: string;
  kind: "slack" | "max";
  knots: number;          // 0 for slack, signed for max, 0 + weak_variable=true for "*"
  weak_variable: boolean;
};
export type CurrentDay = { month: number; day: number; events: CurrentEvent[] };
export type CurrentStation = {
  name: string; year: number; utc_offset: number; days: CurrentDay[];
  flood_direction_true: number | null;
  ebb_direction_true: number | null;
  // (other Table 4 metadata fields exist on the JSON; not used by the interpolator)
};

// ============================================================
// Internal flat representation
// ============================================================

/** A single published extreme: an absolute-UTC instant and its value.
 *  For tides, v is height in metres.
 *  For currents, v is signed knots (positive = flood, negative = ebb,
 *  0 for slack and for weak/variable maxes — see `weak` flag). */
export type Extreme = { t: number; v: number; weak?: boolean };

// ============================================================
// Loaders: build a sorted Extreme[] once per station at load time
// ============================================================

export function tideExtremes(s: TideStation): Extreme[] {
  const out: Extreme[] = [];
  for (const d of s.days) {
    for (const r of d.readings) {
      out.push({
        t: stationTimeToUtcMs(s.year, d.month, d.day, r.time, s.utc_offset),
        v: r.metres,
      });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

export function currentExtremes(s: CurrentStation): Extreme[] {
  const out: Extreme[] = [];
  for (const d of s.days) {
    for (const e of d.events) {
      // Treat * (weak/variable) as v=0 so the interpolated curve actually
      // passes through zero at that instant, not a long straight line
      // between the surrounding ebb/flood extremes. The `weak` flag is
      // preserved so the UI can render a distinct marker.
      out.push({
        t: stationTimeToUtcMs(s.year, d.month, d.day, e.time, s.utc_offset),
        v: e.kind === "slack" ? 0 : e.knots,
        weak: e.kind === "max" && e.weak_variable ? true : undefined,
      });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Convert a station-local clock time (as printed in the PDF) to an
 *  absolute UTC instant in milliseconds. The utc_offset is whatever the
 *  PDF page header declared (e.g. -8 for "PST (UTC-8h)"). We never apply
 *  a manual DST adjustment here — that's the display layer's job. */
function stationTimeToUtcMs(
  year: number, month: number, day: number,
  hhmm: string, utcOffset: number,
): number {
  const [hh, mm] = hhmm.split(":").map(Number);
  return Date.UTC(year, month - 1, day, hh - utcOffset, mm);
}

// ============================================================
// Interpolators
// ============================================================

/** Tides: half-cosine between two peaks. Both endpoints (HW and LW) are
 *  extrema with zero slope, so the curve is C¹-continuous everywhere. */
export function valueAt(extremes: Extreme[], t: number): number | null {
  const n = extremes.length;
  if (n < 2) return null;
  if (t < extremes[0].t || t > extremes[n - 1].t) return null;

  // Binary search: find the largest i such that extremes[i].t <= t.
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (extremes[mid].t <= t) lo = mid;
    else hi = mid;
  }

  const e1 = extremes[lo];
  const e2 = extremes[hi];
  if (e2.t === e1.t) return e1.v;       // defensive: zero-duration segment

  const tau = (t - e1.t) / (e2.t - e1.t);    // 0..1 within this segment
  return (e1.v + e2.v) / 2 + (e1.v - e2.v) / 2 * Math.cos(Math.PI * tau);
}

/** Currents: piecewise quarter-cycle. Endpoints alternate between
 *  zero-crossings (slacks and weak/variable maxes, v=0) and true peaks
 *  (signed maxes), so the segment shape depends on which kind sits at
 *  each end. See the table in this document under "Currents: piecewise
 *  quarter-cycle". */
function currentSegment(v1: number, v2: number, tau: number): number {
  const z1 = v1 === 0;
  const z2 = v2 === 0;
  if (z1 && z2) return 0;
  if (z1) return v2 * Math.sin(Math.PI * tau / 2);   // slack → peak
  if (z2) return v1 * Math.cos(Math.PI * tau / 2);   // peak  → slack
  return (v1 + v2) / 2 + (v1 - v2) / 2 * Math.cos(Math.PI * tau);  // peak → peak
}

export function currentValueAt(extremes: Extreme[], t: number): number | null {
  const n = extremes.length;
  if (n < 2) return null;
  if (t < extremes[0].t || t > extremes[n - 1].t) return null;

  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (extremes[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const e1 = extremes[lo];
  const e2 = extremes[hi];
  if (e2.t === e1.t) return e1.v;
  return currentSegment(e1.v, e2.v, (t - e1.t) / (e2.t - e1.t));
}
```

## Usage example

```ts
import primaryTidesJson from "./2026_tct_tidal_primary_stations.json";
import primaryCurrentsJson from "./2026_tct_current_primary_stations.json";

// Once at app startup (or lazily, the first time a station becomes visible):
const portRenfrew = primaryTidesJson.stations.find(s => s.name === "PORT RENFREW")!;
const juanDeFucaEast = primaryCurrentsJson.stations.find(s => s.name === "JUAN DE FUCA-EAST")!;
const portRenfrewExtremes = tideExtremes(portRenfrew);
const juanDeFucaExtremes  = currentExtremes(juanDeFucaEast);

// On every scrubber-render frame, for each visible station:
const t = scrubberTimeUtcMs;                       // absolute UTC ms
const heightM   = valueAt(portRenfrewExtremes, t);          // tides → half-cosine
const flowKnots = currentValueAt(juanDeFucaExtremes, t);    // currents → piecewise quarter-cycle
```

## Performance

- `valueAt` is **O(log n)** per call. A primary tide station has ~1,500 extremes/year (≈4 readings × 365 days), so ~11 binary-search comparisons + one cosine = single-digit microseconds on a modern phone.
- Per-station flatten happens once at load, not per frame.
- For a very tight per-frame budget at high station counts, replace the binary search with a per-station "last segment cache" that advances forward as the scrubber moves — turns the lookup into amortized O(1) without changing correctness. Implement only if profiling demands it.

Rough budget at 60 fps on a mid-tier phone: 16 ms/frame ÷ ~5 µs/call = ~3,000 station updates per frame is the headroom. Even with 1,000 visible stations, this is comfortably below 1% of frame time.

## What's deliberately not covered here

- **Secondary tide ports.** They're computed by applying time and height differences (from Table 3) to a primary station's HW/LW extremes, then feeding the *adjusted* extreme list into the same `valueAt`. The matching of "is this primary extreme a HHW or a LLW" requires a per-day classification step (not currently in our JSON). Will be a separate document.
- **Secondary current stations.** Same idea — apply Table 4 differences (and, for the LW/HW-referenced ones like Malibu Rapids, look up the *referenced primary's tides* not currents) to produce an adjusted extreme list, then `valueAt`. Separate document.
- **Cross-year scrubbing.** The user can't scrub from late December 2026 into early January 2027 with this module alone — it returns `null` past the last extreme. If we ever want this, the load step should accept multiple years' JSON and concatenate before sorting. Easy to add when needed; intentionally absent now.
- **Direction display for currents.** `flood_direction_true` and `ebb_direction_true` are static metadata on each `CurrentStation`. The instantaneous flow direction is just the flood direction when `valueAt > 0`, the ebb direction when `valueAt < 0`. This is presentation, not interpolation.

## Sanity checks for testing

When implementing, verify against the published values rather than trusting the formula:

1. **Exact-extreme check.** `valueAt(extremes, extremes[i].t)` should return `extremes[i].v` (within float epsilon) for every `i`. The cosine evaluates to ±1 at τ=0 and τ=1, so the formula reduces to `v₁` or `v₂` exactly.
2. **Asymmetric segment check.** Pick a Sechelt Rapids day with a long ebb interval and a short flood interval. The midpoint of each segment should give `(v₁+v₂)/2` regardless of how long the segment is in real time.
3. **Weak-variable check.** Pick a Juan de Fuca East day with a `*` event (e.g., 2026-01-01, 11:46). Confirm `currentValueAt(t = 11:46 PST → UTC ms)` returns ≈ 0.

3b. **50-90 rule check.** Pick a slack→max segment at any current station (e.g., Race Passage 2026-04-28 slack 01:42 PST → max-ebb 06:17 PST −5.0 kt). Sample at τ = 1/3 and τ = 2/3 of the segment; expect 50% and ~87% of the peak magnitude (sin 30° / sin 60°). The half-cosine model would have produced 25% and 75% — visibly wrong.
4. **Boundary check.** `valueAt(extremes, extremes[0].t - 1)` should return `null`. So should `valueAt(extremes, extremes[n-1].t + 1)`.
5. **Day-cross check.** Pick a station and a `t` between its last event of one day and its first event of the next day. Confirm the returned value lies between those two extremes' values and varies smoothly as `t` moves across midnight.
6. **DST check (manual).** Pick a known HW time in the PDF, e.g. `2026-06-15 06:00 PST` at Port Renfrew. Convert: should be `2026-06-15T14:00:00Z`. Format that UTC instant for `America/Vancouver`: should display `07:00` (because BC is on UTC-7 in summer 2026 and permanently UTC-7 from Nov 2026). If it shows `06:00`, the timezone wiring is wrong.

Sources:
- [Adopting permanent daylight saving time — BC Gov News](https://news.gov.bc.ca/releases/2026AG0013-000209)
- [British Columbia (BC) Adopts Permanent Daylight Saving Time — timeanddate.com](https://www.timeanddate.com/news/time/canada-bc-permanent-dst.html)
- [British Columbia to make daylight saving time permanent — NPR](https://www.npr.org/2026/03/07/nx-s1-5741076/british-columbia-daylight-saving-time)
