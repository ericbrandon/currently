// Tidal chart that underlies the timeline scrubber.
//
// Active only when the user has tapped a tide station. Spans the same
// time window as the scrubber (windowStartMs … +WINDOW_MS), so panning
// the timeline drags the chart along automatically.
//
// Y-axis is *fixed* per station — bounds come from the station's
// large-tide HHW/LLW (Table 2 for primaries, derived for secondaries).
// This keeps the curve from rescaling as the user pans the timeline.
// Values that exceed the reference range still render; they just sit
// slightly into the padding zones.
//
// Layout zones inside the chart's vertical extent:
//
//   0 …  TOP_PAD%       — reserved for the thumb readout (and HW labels)
//   TOP_PAD … BOTTOM_PAD — curve range; LHHW → TOP_PAD%, LLLW → BOTTOM_PAD%
//   BOTTOM_PAD … 100%   — reserved for LW labels
//
// HW labels are positioned at each peak's (x, y) and pushed up via a
// translateY(-100%); LW labels are positioned at each valley's (x, y)
// and sit just below it. The thumb's vertical line is rendered by the
// Scrubber so it can extend down through the track to the dot — the
// chart owns only the readout text at the line's top.
//
// Curve sampling is memoised on (extremes, start, lhhw, lllw). Dragging
// the thumb (which only changes thumbFraction → scrubberMs) doesn't
// re-sample.

import { useMemo } from "preact/hooks";
import {
  windowStartMs,
  thumbFraction,
  scrubberMs,
  selectedStationId,
  loadedData,
  WINDOW_MS,
} from "../state/store";
import { valueAt } from "../interp/valueAt";
import { classifyHiLow } from "../interp/secondaryTides";
import { formatTideHeight } from "../util/units";

const SAMPLE_INTERVAL_MS = 3 * 60 * 1000;
const MIN_RANGE_M = 0.6;
const TOP_PAD_PCT = 22;
const BOTTOM_PAD_PCT = 88;

const HHMM = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Vancouver",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function fmtTime(ms: number): string { return HHMM.format(new Date(ms)); }

type Computed =
  | { empty: true }
  | {
      empty: false;
      pathD: string;
      labels: { x: number; y: number; t: number; v: number; isHW: boolean }[];
    };

export function TideChart() {
  const id = selectedStationId.value;
  const data = loadedData.value;
  const start = windowStartMs.value;
  const f = thumbFraction.value;
  const ms = scrubberMs.value;

  const meta = id !== null && data ? data.stationsById.get(id) ?? null : null;
  const extremes = id !== null && data ? data.tideExtremesById.get(id) ?? null : null;
  const lhhw = meta?.tide_lhhw;
  const lllw = meta?.tide_lllw;

  const computed = useMemo<Computed | null>(() => {
    if (!extremes || lhhw === undefined || lllw === undefined) return null;
    const end = start + WINDOW_MS;

    // Defensive: if the station's reference range collapses to ~zero, expand
    // symmetrically around its midpoint so the curve stays centred.
    let lo = lllw;
    let hi = lhhw;
    if (hi - lo < MIN_RANGE_M) {
      const mid = (lo + hi) / 2;
      lo = mid - MIN_RANGE_M / 2;
      hi = mid + MIN_RANGE_M / 2;
    }
    const yOf = (v: number) =>
      TOP_PAD_PCT + ((hi - v) / (hi - lo)) * (BOTTOM_PAD_PCT - TOP_PAD_PCT);

    let anySample = false;
    const samples: { x: number; v: number | null }[] = [];
    for (let t = start; t <= end; t += SAMPLE_INTERVAL_MS) {
      const v = valueAt(extremes, t);
      samples.push({ x: (t - start) / WINDOW_MS, v });
      if (v !== null) anySample = true;
    }
    if (!anySample) return { empty: true };

    let pathD = "";
    let inPath = false;
    for (const s of samples) {
      if (s.v === null) { inPath = false; continue; }
      const px = s.x * 100;
      const py = yOf(s.v);
      pathD += inPath
        ? ` L${px.toFixed(2)} ${py.toFixed(2)}`
        : `M${px.toFixed(2)} ${py.toFixed(2)}`;
      inPath = true;
    }

    const isHi = classifyHiLow(extremes);
    const labels: { x: number; y: number; t: number; v: number; isHW: boolean }[] = [];
    for (let i = 0; i < extremes.length; i++) {
      const e = extremes[i];
      if (e.t < start) continue;
      if (e.t > end) break;
      labels.push({
        x: ((e.t - start) / WINDOW_MS) * 100,
        y: yOf(e.v),
        t: e.t,
        v: e.v,
        isHW: isHi[i],
      });
    }

    return { empty: false, pathD, labels };
  }, [extremes, start, lhhw, lllw]);

  if (id === null || !data || !meta || !extremes) return null;
  if (meta.kind !== "tide-primary" && meta.kind !== "tide-secondary") return null;
  if (!computed) return null;

  if (computed.empty) {
    return (
      <div class="tide-chart">
        <div class="tide-chart-empty">No tide data for this time window</div>
      </div>
    );
  }

  const { pathD, labels } = computed;
  const thumbValue = valueAt(extremes, ms);
  const thumbX = f * 100;

  return (
    <div class="tide-chart">
      <svg
        class="tide-chart-svg"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {pathD && <path class="tide-chart-fill" d={`${pathD} L100 100 L0 100 Z`} />}
        {pathD && <path class="tide-chart-curve" d={pathD} />}
      </svg>
      {labels.map((L, i) => (
        <div
          key={i}
          class={`tide-chart-extreme ${L.isHW ? "hw" : "lw"}`}
          style={{ left: `${L.x}%`, top: `${L.y}%` }}
        >
          <span class="tide-chart-extreme-time">{fmtTime(L.t)}</span>
          {" "}
          <span class="tide-chart-extreme-val">{formatTideHeight(L.v)}</span>
        </div>
      ))}
      {thumbValue !== null && (
        <div class="tide-chart-thumb-label" style={{ left: `${thumbX}%` }}>
          <span class="tide-chart-extreme-time">{fmtTime(ms)}</span>
          {" "}
          <span class="tide-chart-extreme-val">{formatTideHeight(thumbValue)}</span>
        </div>
      )}
    </div>
  );
}
