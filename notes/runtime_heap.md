# Runtime heap reduction — typed-array `Extreme[]`

Proposal for the next memory-side win after publish-time stripping (see [combined_data_processing.md §Publish-time stripping](combined_data_processing.md#publish-time-stripping)). Not yet implemented.

## What problem this solves

Publish-time stripping cut the *download* by ~70% (32 MB → 9 MB raw, ~3 MB → ~1 MB gzipped) — the bytes that travel over the wire and get parsed. It does **not** reduce what the app holds in JavaScript memory after parse, because the loader builds its own derived structures (`tideExtremesById`, `currentExtremesById`) and the original parsed JSON is then garbage-collected.

Those derived structures are what dominate the runtime heap.

## Where the bytes go

The loader produces, per station, a sorted `Extreme[]`:

```ts
export type Extreme = { t: number; v: number; weak?: boolean };
```

These arrays back the per-frame interpolation in `tideStateAt` / `currentStateAt` / `valueAt` and the curve sampler in `TideChart` / `CurrentChart`. They have to stay around for the whole session.

Magnitude (2026 data):

| Source | Stations | Events/station/year | Approx. total events |
|---|---|---|---|
| CHS tide primaries | 23 | ~1,500 (4/day × 365) | 35,000 |
| CHS tide secondaries | 268 | ~1,500 | 400,000 |
| CHS current primaries | 22 | ~2,750 (~7.5/day) | 60,000 |
| CHS current secondaries | 39 | ~2,500 | 100,000 |
| NOAA tide stations | 33 | ~1,400 | 46,000 |
| NOAA current stations | 25 | ~2,750 | 69,000 |
| **Total** | 410 | | **~710,000** |

Each `Extreme` is a V8 object. Per object, V8 carries:

- A map (hidden-class) pointer: 8 bytes
- An elements pointer: 8 bytes
- An out-of-line properties pointer (for objects with the `weak` slot present, since object shapes diverge): 8 bytes
- The slots themselves: `t` (Number — 8 bytes boxed inline), `v` (Number — 8 bytes), `weak` if present (Smi tagged — 4 bytes, with alignment overhead)

Empirical figure for an array of small homogeneous objects in V8: **~50–60 bytes per object** including the per-element overhead in the backing store. For 710k events that's roughly **35–40 MB** on the heap, just for the extremes. Add the `Map<string, Extreme[]>` overhead (one entry per station × 2 maps), the `StationMeta` record, and the marker DOM, and the runtime working set is uncomfortable on a phone.

The shape `{t, v}` is 16 bytes of *actual data*. Everything else is plumbing.

## Proposed shape

Per station, replace `Extreme[]` with parallel typed-array buffers:

```ts
type ExtremeSeries = {
  /** Absolute UTC ms. Float64 because Date.UTC produces full-precision
   *  ms timestamps that exceed 32-bit range. */
  ts: Float64Array;
  /** Signed metres (tides) or signed knots (currents). Float32 is fine —
   *  CHS publishes one decimal place; NOAA at most three. */
  vs: Float32Array;
  /** Optional weak/variable flag. Allocated only for current series; null
   *  for tide series. Uint8Array stores 0/1. */
  weak: Uint8Array | null;
};
```

Per event:

- `ts[i]`: 8 bytes
- `vs[i]`: 4 bytes
- `weak[i]`: 1 byte (currents only)

That's **13 bytes per current event, 12 per tide event**, vs ~55 today. Adjusting for ~710k events, the heap drops from ~35–40 MB to **~10 MB**. Also: typed arrays are stored in flat C-style buffers, so iteration is cache-friendly and the segment binary search inside `findSegment` (see [interp/valueAt.ts](../web/src/interp/valueAt.ts)) becomes faster for the cold-path miss as a side effect.

The `LoadedData` map types change from `Map<string, Extreme[]>` to `Map<string, ExtremeSeries>`, and every consumer reads `series.ts[i]` / `series.vs[i]` instead of `extremes[i].t` / `.v`.

## Implementation plan

Six files materially affected. None of the changes are conceptually hard — they're mechanical translations of `extremes[i].t` → `series.ts[i]` everywhere. The hard part is making sure no consumer is missed.

### 1. `web/src/types.ts`

Add the `ExtremeSeries` type alongside the existing `Extreme` (keep `Extreme` for now — used by the chart's labels list and a few other small spots that would benefit less from typed arrays). Update `LoadedData`:

```ts
export type LoadedData = {
  years: number[];
  scrubberRangeMs: { min: number; max: number };
  stationsById: Map<string, StationMeta>;
  tideExtremesById: Map<string, ExtremeSeries>;
  currentExtremesById: Map<string, ExtremeSeries>;
};
```

### 2. `web/src/interp/extremes.ts`

`tideExtremes()` and `currentExtremes()` already iterate the parsed JSON and produce a sorted `Extreme[]`. Change them to return `ExtremeSeries`:

```ts
export function tideExtremes(s: TideSeries): ExtremeSeries {
  // First pass: collect into a flat (t, v) tuple list so we can sort
  // before transferring into typed arrays.
  const tuples: { t: number; v: number }[] = [];
  for (const d of s.days) {
    for (const r of d.readings) {
      tuples.push({
        t: stationTimeToUtcMs(s.year, d.month, d.day, r.time, s.utc_offset),
        v: r.metres,
      });
    }
  }
  tuples.sort((a, b) => a.t - b.t);
  const n = tuples.length;
  const ts = new Float64Array(n);
  const vs = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    ts[i] = tuples[i].t;
    vs[i] = tuples[i].v;
  }
  return { ts, vs, weak: null };
}
```

`currentExtremes()` is the same shape with a `Uint8Array` for weak (using `e.kind === "max" && e.weak_variable === true` to set the bit).

### 3. `web/src/interp/valueAt.ts`

The four public functions plus `findSegment` all receive the series instead of `Extreme[]` and read `ts[i]` / `vs[i]`:

```ts
export type SegmentCache = { i: number };

function findSegment(
  series: ExtremeSeries,
  t: number,
  cache?: SegmentCache,
): number {
  const ts = series.ts;
  const n = ts.length;
  if (cache) {
    const i = cache.i;
    if (i < n - 1 && ts[i] <= t && t < ts[i + 1]) return i;
    if (i + 2 < n && ts[i + 1] <= t && t < ts[i + 2]) {
      cache.i = i + 1;
      return i + 1;
    }
    if (i > 0 && ts[i - 1] <= t && t < ts[i]) {
      cache.i = i - 1;
      return i - 1;
    }
  }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid;
  }
  if (cache) cache.i = lo;
  return lo;
}

export function valueAt(
  series: ExtremeSeries,
  t: number,
  cache?: SegmentCache,
): number | null {
  const ts = series.ts;
  const vs = series.vs;
  const n = ts.length;
  if (n < 2) return null;
  if (t < ts[0] || t > ts[n - 1]) return null;
  const lo = findSegment(series, t, cache);
  const t1 = ts[lo], t2 = ts[lo + 1];
  if (t2 === t1) return vs[lo];
  const v1 = vs[lo], v2 = vs[lo + 1];
  const tau = (t - t1) / (t2 - t1);
  return (v1 + v2) / 2 + ((v1 - v2) / 2) * Math.cos(Math.PI * tau);
}
```

`tideStateAt`, `currentValueAt`, and `currentStateAt` follow the same pattern. `currentStateAt` reads weak via `series.weak![i]` (the `!` is safe for current series, which always carry a weak buffer).

### 4. `web/src/interp/secondaryTides.ts`

`secondaryTideExtremes()` consumes a primary's extremes and produces a secondary's. Translate both ends to `ExtremeSeries`. The classified-Hi/Lo flag array (`classifyHiLow`) stays as a plain `boolean[]` — it's small (one bool per extreme) and indexed alongside the typed arrays.

### 5. `web/src/interp/secondaryCurrents.ts`

Same translation. The internal `Raw[]` intermediate stays as a small array of objects during the classification pass; only the *final* output becomes a typed-array series. Conceptually no different from the existing primary-current path.

### 6. `web/src/data/loader.ts`

`pushExtremes` / `pushTo` and `flattenPerYear` operate on lists of `Extreme[]` today, concatenating across years. Replace with list of `ExtremeSeries` and a per-station merge that allocates one combined series at flatten time:

```ts
function flattenPerYear(
  bucket: Map<string, ExtremeSeries[]>,
): Map<string, ExtremeSeries> {
  const out = new Map<string, ExtremeSeries>();
  for (const [id, perYear] of bucket) {
    if (perYear.length === 1) {
      out.set(id, perYear[0]);
      continue;
    }
    let total = 0;
    for (const s of perYear) total += s.ts.length;
    const ts = new Float64Array(total);
    const vs = new Float32Array(total);
    const hasWeak = perYear.some((s) => s.weak !== null);
    const weak = hasWeak ? new Uint8Array(total) : null;
    let off = 0;
    for (const s of perYear) {
      ts.set(s.ts, off);
      vs.set(s.vs, off);
      if (weak && s.weak) weak.set(s.weak, off);
      off += s.ts.length;
    }
    // Merge isn't strictly sorted across year boundaries — re-sort.
    // Build an index permutation, apply.
    const idx = new Uint32Array(total);
    for (let i = 0; i < total; i++) idx[i] = i;
    idx.sort((a, b) => ts[a] - ts[b]);
    const ts2 = new Float64Array(total);
    const vs2 = new Float32Array(total);
    const weak2 = weak ? new Uint8Array(total) : null;
    for (let i = 0; i < total; i++) {
      const j = idx[i];
      ts2[i] = ts[j];
      vs2[i] = vs[j];
      if (weak2 && weak) weak2[i] = weak[j];
    }
    out.set(id, { ts: ts2, vs: vs2, weak: weak2 });
  }
  return out;
}
```

(For the single-year case — which is today's only case — the cross-year merge code is unreachable. Keeping it correct from day one means future-year additions don't introduce a regression at midnight Jan 1.)

### 7. UI consumers

`TidePanel.tsx`, `CurrentPanel.tsx`, `TideChart.tsx`, `CurrentChart.tsx` iterate over the extremes to build label/event lists and to sample the curve. They all read `e.t` / `e.v` today; switch to `series.ts[i]` / `series.vs[i]`. The event-shape they emit *to* their own renderers (`{t, v, isHW: bool}` etc.) doesn't need to change.

`classifyHiLow` in `interp/secondaryTides.ts` takes `Extreme[]` today and returns `boolean[]`. Rewrite it to take an `ExtremeSeries` and return `boolean[]` of the same length.

### 8. Marker layers

`stationLayer.ts` and `currentStationLayer.ts` already pass the extremes blob into `tideStateAt(ext, t, this.segmentCache.get(id))` and `currentStateAt`. The signature changes from `Extreme[]` to `ExtremeSeries`; the layer code itself doesn't need other edits. The segment-cache (`SegmentCache = { i: number }`) is unaffected — its cached index is into the same logical sequence.

## Estimated impact

| Metric | Today | After typed arrays | Delta |
|---|---|---|---|
| Heap held by extremes | ~35–40 MB | ~10 MB | **~25–30 MB freed** |
| Per-event memory | ~55 bytes | 12–13 bytes | ~4× smaller |
| Cold binary-search cost | ~11 comparisons over object array | ~11 comparisons over typed array | 1.5–2× faster (cache-friendly) |
| Cache-hit cost | 2 comparisons | 2 comparisons | unchanged (already minimal) |
| Cross-year merge allocation | one `Array.flat().sort()` per station | one typed-array indexed sort per station | similar |

The dominant win is heap memory. Per-frame CPU is already fast enough after the off-screen cull and segment cache; this optimisation doesn't change the per-frame story meaningfully, just the resting memory cost.

## What you'll actually notice

The numbers above are real, but most of them aren't perceptible to a human using the app. Translating each row of the table into a user-experience claim:

### Per-frame scrub work — imperceptible

The hot path is already fast after the cull + segment cache. Per visible marker per frame: a bounds check, two `Map` lookups, a cache-hit segment lookup (1–2 comparisons), the cosine math, a DOM mutation. For ~200 visible markers at 60 fps, total JS work per frame is well under 1 ms. Switching `extremes[i].t` → `series.ts[i]` shaves perhaps 10–20% off the array-read cost (typed arrays are cache-friendly and skip V8's hidden-class lookups), but that's saving fractions of a millisecond on a sub-millisecond pass. Below human perception.

### Cold binary search — imperceptible

The cache-miss path runs ~11 lookups + comparisons. Goes from ~110 ns to ~60 ns. You'd never see it.

### Initial load construction — small, real

This is the only frame-rate-adjacent win. Today the loader allocates ~710,000 small `Extreme` objects at startup. That's a lot of object creation and a lot of pressure on V8's young-generation GC. Typed arrays allocate ~410 buffers instead, with the same total bytes. Probably **50–150 ms faster** on the construction phase post-parse, on a mid-tier phone. Network and parse aren't affected — those already finished. So this trims off the very tail of the cold-load timeline rather than improving the perceived first-paint.

### GC pauses during long scrub sessions — already fine

The extreme arrays are long-lived (allocated once at load, never freed). They sit in the old generation and don't get touched by minor GCs. Per-frame allocation today is small (a `LngLatBounds` per pan, basically nothing else). Major-GC triggers don't happen during scrub today, so reducing the resident set won't change perceived stutter.

### iOS / Android tab eviction resistance — the real win

This is what justifies the work. Mobile Safari (and Chrome on Android, similar story) evicts background tabs when memory pressure rises. A ~40 MB heap puts the app closer to that threshold than ~10 MB does, especially on older devices with 3–4 GB total RAM. The user-visible symptom isn't a stutter — it's that they switch apps, come back ten minutes later, and the page reloads from cache instead of resuming where they left off. Disruptive but not a "performance" issue you'd ever see while actively using the app.

### Future-year scalability

Today's heap (~40 MB) covers one year. Adding 2027 roughly doubles the extremes count to ~1.4 M events; the heap grows to ~80 MB. With typed arrays, that same expansion is 10 MB → 20 MB. The bigger the year horizon, the larger the relative payoff and the more the eviction-resistance argument matters.

### Bottom line

If today's app feels smooth on your test devices, the typed-array refactor will not move the perceived-smoothness needle. Its job is to buy memory headroom — for additional years, for more stations, for surviving multitasking on older phones. The frame-rate work is already done by the cull, the segment cache, and the movestart hook.

## Risk and rollback

The change is mechanical but wide. Risk profile:

- **Correctness risk on the cross-year merge.** The current `perYear.flat().sort()` is a familiar sort over a flat array of objects. The typed-array equivalent uses an index permutation. Easy to write, easy to test against today's path: feed the same input into both, assert the same output sequence. Add a unit test before the migration.
- **Hidden consumers.** Anything I missed in the file list above will break at compile time (the type changes from `Extreme[]` to `ExtremeSeries`, so callers either get the new shape or fail to type-check). `tsc -b` is the safety net. Run it after each file's translation, not at the end.
- **Re-introducing object allocation.** Easy regression: code that does `for (const e of extremes)` becomes `for (let i = 0; i < series.ts.length; i++) { const t = series.ts[i]; const v = series.vs[i]; ... }`. If a code reviewer (or an LLM) rewrites a parallel-array loop back into an object form `{ t, v }` for ergonomics, the win evaporates locally. The point is that *long-lived* extreme storage stays in typed arrays; per-render scratch arrays can keep being objects.
- **Float32 precision for `v`.** Float32 has ~7 significant digits. CHS publishes tide heights to 1 decimal place (largest values ~6 m), currents to 1 decimal place (largest ~12 kn). NOAA publishes heights to 3 decimals (~10 ft) and currents to 2 decimals. All comfortably fit in Float32. The only place Float32 could bite is during interpolation — but the cosine math runs in JS Number (Float64) and only the input `vs[i]` is downcast, so the loss is bounded by the original publish precision.
- **Weak array allocation when not needed.** Tide series get `weak: null`. Reading `series.weak![i]` would crash; reading `series.weak ? series.weak[i] : 0` is safe. The new `tideStateAt` shouldn't read `weak` at all (tides have no weak-variable concept), so this is a typing question more than a runtime one.

Rollback path: the change is one PR, lands behind the existing public API names (`tideExtremes`, `valueAt`, etc.) so any external code (tests, future MCP integrations) sees no surface change. Revert is `git revert`.

## When to do this — and when not to

**Do it when any of these is true:**
- You've added 2027 (or further years) and DevTools' Performance tab shows the post-load construction phase taking ≥500 ms on a mid-tier phone.
- Users start reporting that the page reloads after multitasking on iPhones (the iOS-eviction symptom from the previous section).
- DevTools' Memory snapshot shows `Array` and `Object` together accounting for >50% of the heap and the dominant retainers are `tideExtremesById` / `currentExtremesById`.
- You're already touching the interpolator code for another reason and the migration cost is amortised.

**Skip it when:**
- None of the above is true. iOS Safari will tolerate a ~50 MB heap without complaint as long as it's not still growing, and most users won't multitask aggressively enough to evict the tab.
- You're in the middle of a feature push and the migration's blast radius across 6–8 files isn't worth the risk for a non-user-visible win.

The publish-time strip was chosen as the first memory-side change precisely because it's narrow (one Python file plus one TypeScript field made optional) and doesn't change the loader's public contract. This proposal is the next-easiest tier of win, not the easiest. Defer until measurement says it's needed.

## Open questions

- **Should `valueAt` and friends gain a non-cache fast path that takes raw `(ts, vs)` instead of the wrapping series object?** Probably not — the `series.ts` / `series.vs` reads in V8 inline well, and bookkeeping a triple-argument call is awkward.
- **Are there other long-lived structures worth migrating?** `StationMeta` is ~410 records; not material. The MapLibre marker DOM dominates anything else by an order of magnitude. Skip.
- **PMTiles range-request cache lives outside the JS heap; relevant?** No — that's in MapLibre's internal store and capped by browser tile-cache policy, not by this PR.
