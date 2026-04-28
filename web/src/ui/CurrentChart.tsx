// Current chart that underlies the timeline scrubber. Active when the
// user has tapped a primary current station. Mirrors TideChart's layout
// and time axis (windowStartMs … +WINDOW_MS) but the Y-axis is
// *symmetric around zero*: positive knots (flood) above the centre line,
// negative knots (ebb) below. The bound comes from the station's max
// |knots| so the curve doesn't rescale while the user pans.
//
// Layout zones (mirroring TideChart):
//   0       …  TOP_PAD%       — thumb readout + max-flood labels
//   TOP_PAD …  ZERO%          — flood half (curve above zero)
//   ZERO%   …  BOTTOM_PAD%    — ebb half (curve below zero)
//   BOTTOM_PAD% … 100         — max-ebb labels
//
// Slack and weak/variable max events are labelled with a hollow pill;
// flood/ebb maxes get a filled pill matching the marker palette.

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
import { formatCurrentSpeed } from "../util/units";

const SAMPLE_INTERVAL_MS = 3 * 60 * 1000;
const MIN_BOUND_KT = 0.5;
const TOP_PAD_PCT = 22;
const BOTTOM_PAD_PCT = 88;
const ZERO_PCT = (TOP_PAD_PCT + BOTTOM_PAD_PCT) / 2;

const HHMM = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Vancouver",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function fmtTime(ms: number): string { return HHMM.format(new Date(ms)); }

type Label = {
  x: number;
  y: number;
  t: number;
  v: number;
  kind: "flood" | "ebb" | "slack";
  weak: boolean;
};

type Computed =
  | { empty: true }
  | { empty: false; pathD: string; floodFill: string; ebbFill: string; labels: Label[] };

export function CurrentChart() {
  const id = selectedStationId.value;
  const data = loadedData.value;
  const start = windowStartMs.value;
  const f = thumbFraction.value;
  const ms = scrubberMs.value;

  const meta = id !== null && data ? data.stationsById.get(id) ?? null : null;
  const extremes = id !== null && data ? data.currentExtremesById.get(id) ?? null : null;
  const bound = meta?.current_max_knots;

  const computed = useMemo<Computed | null>(() => {
    if (!extremes || bound === undefined) return null;
    const end = start + WINDOW_MS;
    const hi = Math.max(bound, MIN_BOUND_KT);

    // Map signed knots to chart Y%. v=+hi → TOP_PAD, v=0 → ZERO, v=-hi → BOTTOM_PAD.
    const yOf = (v: number) => {
      const clamped = Math.max(-hi, Math.min(hi, v));
      // clamped/hi runs in [-1, 1]. positive → above ZERO, negative → below.
      return ZERO_PCT - (clamped / hi) * (ZERO_PCT - TOP_PAD_PCT);
    };

    let anySample = false;
    const samples: { x: number; y: number; v: number | null }[] = [];
    for (let t = start; t <= end; t += SAMPLE_INTERVAL_MS) {
      const v = valueAt(extremes, t);
      const x = ((t - start) / WINDOW_MS) * 100;
      samples.push({ x, y: v === null ? 0 : yOf(v), v });
      if (v !== null) anySample = true;
    }
    if (!anySample) return { empty: true };

    let pathD = "";
    let floodFill = "";
    let ebbFill = "";
    let inPath = false;
    for (const s of samples) {
      if (s.v === null) { inPath = false; continue; }
      pathD += inPath
        ? ` L${s.x.toFixed(2)} ${s.y.toFixed(2)}`
        : `M${s.x.toFixed(2)} ${s.y.toFixed(2)}`;
      inPath = true;
    }

    // Flood fill: between curve and zero line, only where v > 0.
    // Ebb fill: between zero line and curve, only where v < 0.
    // Build each as a stack of trapezoidal segments where consecutive
    // samples share the same sign; let SVG fill-rule handle the rest.
    const buildHalfFill = (sign: 1 | -1): string => {
      let d = "";
      let i = 0;
      while (i < samples.length) {
        // Skip non-matching / null samples.
        while (i < samples.length && (samples[i].v === null || (sign > 0 ? samples[i].v! <= 0 : samples[i].v! >= 0))) {
          i++;
        }
        if (i >= samples.length) break;
        const startI = i;
        while (i < samples.length && samples[i].v !== null && (sign > 0 ? samples[i].v! > 0 : samples[i].v! < 0)) {
          i++;
        }
        const endI = i - 1;
        d += `M${samples[startI].x.toFixed(2)} ${ZERO_PCT}`;
        for (let j = startI; j <= endI; j++) {
          d += ` L${samples[j].x.toFixed(2)} ${samples[j].y.toFixed(2)}`;
        }
        d += ` L${samples[endI].x.toFixed(2)} ${ZERO_PCT} Z`;
      }
      return d;
    };
    floodFill = buildHalfFill(1);
    ebbFill = buildHalfFill(-1);

    const labels: Label[] = [];
    for (let i = 0; i < extremes.length; i++) {
      const e = extremes[i];
      if (e.t < start) continue;
      if (e.t > end) break;
      const x = ((e.t - start) / WINDOW_MS) * 100;
      const y = yOf(e.v);
      const weak = !!e.weak;
      let kind: "flood" | "ebb" | "slack";
      if (weak || Math.abs(e.v) < 0.05) kind = "slack";
      else if (e.v > 0) kind = "flood";
      else kind = "ebb";
      labels.push({ x, y, t: e.t, v: e.v, kind, weak });
    }

    return { empty: false, pathD, floodFill, ebbFill, labels };
  }, [extremes, start, bound]);

  if (id === null || !data || !meta || !extremes) return null;
  if (meta.kind !== "current-primary" && meta.kind !== "current-secondary") return null;
  if (!computed) return null;

  if (computed.empty) {
    return (
      <div class="current-chart">
        <div class="current-chart-empty">No current data for this time window</div>
      </div>
    );
  }

  const { pathD, floodFill, ebbFill, labels } = computed;
  const thumbValue = valueAt(extremes, ms);
  const thumbX = f * 100;

  return (
    <div class="current-chart">
      <svg
        class="current-chart-svg"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {floodFill && <path class="current-chart-fill flood" d={floodFill} />}
        {ebbFill && <path class="current-chart-fill ebb" d={ebbFill} />}
        <line
          class="current-chart-zero"
          x1="0"
          y1={ZERO_PCT}
          x2="100"
          y2={ZERO_PCT}
        />
        {pathD && <path class="current-chart-curve" d={pathD} />}
      </svg>
      {labels.map((L, i) => (
        <div
          key={i}
          class={`current-chart-extreme ${L.kind}${L.weak ? " weak" : ""}`}
          style={{ left: `${L.x}%`, top: `${L.y}%` }}
        >
          <span class="current-chart-extreme-time">{fmtTime(L.t)}</span>
          {" "}
          <span class="current-chart-extreme-val">
            {L.kind === "slack" ? (L.weak ? "weak" : "slack") : formatCurrentSpeed(Math.abs(L.v))}
          </span>
        </div>
      ))}
      {thumbValue !== null && (
        <div class="current-chart-thumb-label" style={{ left: `${thumbX}%` }}>
          <span class="current-chart-extreme-time">{fmtTime(ms)}</span>
          {" "}
          <span class="current-chart-extreme-val">
            {formatCurrentSpeed(Math.abs(thumbValue))}
          </span>
        </div>
      )}
    </div>
  );
}
