// 15-hour windowed timeline scrubber.
//
// Layout: a horizontal track with hour-number labels, half-hour and
// quarter-hour tick marks, and a draggable thumb. The thumb's fraction
// across the track maps to the displayed instant within the visible
// 15-hour window. Dragging the thumb to either extreme starts an
// auto-pan loop (6 h per real second) that slides the window through
// time until the user releases.

import { useEffect, useRef, useState } from "preact/hooks";
import {
  windowStartMs,
  thumbFraction,
  scrubberMs,
  scrubberRange,
  selectedStationId,
  recenterAt,
  WINDOW_MS,
  STEP_MS,
} from "../state/store";
import { formatScrubber } from "../util/time";
import { TideChart } from "./TideChart";

const HOUR_MS = 60 * 60 * 1000;
const HALF_MS = 30 * 60 * 1000;
const PAN_RATE_MS_PER_SEC = 6 * HOUR_MS;          // 6 h per real second
const EDGE_THRESHOLD = 0.02;                       // 2% from each end

const HOUR_LABEL_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Vancouver",
  hour: "2-digit",
  hour12: false,
});

const DATE_LABEL_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Vancouver",
  month: "short",
  day: "numeric",
});

type Tick = {
  t: number;
  pos: number;
  kind: "hour" | "half" | "quarter";
  label?: string;
};

/** Compute tick positions across the visible window. Each tick's `pos` is
 *  a fraction in [0, 1] of horizontal track width. Hours get labels; half
 *  and quarter ticks are visual only. */
function buildTicks(start: number): Tick[] {
  const out: Tick[] = [];
  // First quarter-hour boundary at or after start (start is already snapped).
  const firstQ = Math.ceil(start / STEP_MS) * STEP_MS;
  const end = start + WINDOW_MS;
  for (let t = firstQ; t <= end; t += STEP_MS) {
    const pos = (t - start) / WINDOW_MS;
    if (t % HOUR_MS === 0) {
      out.push({
        t,
        pos,
        kind: "hour",
        label: HOUR_LABEL_FORMATTER.format(new Date(t)),
      });
    } else if (t % HALF_MS === 0) {
      out.push({ t, pos, kind: "half" });
    } else {
      out.push({ t, pos, kind: "quarter" });
    }
  }
  return out;
}

export function Scrubber() {
  const range = scrubberRange.value;
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const animFrameRef = useRef<number>(0);
  const lastFrameTimeRef = useRef<number>(0);

  // Subscribe to signals by reading their values during render.
  const start = windowStartMs.value;
  const f = thumbFraction.value;
  const ms = scrubberMs.value;

  // "Now" indicator: re-render once a minute so the red dot drifts across
  // the track even when the user isn't interacting.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const nowFraction = (now - start) / WINDOW_MS;
  const showNowDot = nowFraction >= 0 && nowFraction <= 1;

  const ticks = buildTicks(start);
  const outOfRange = !!range && (ms < range.min || ms > range.max);

  // ---------- Pointer handling ----------

  function fractionFromPointer(e: PointerEvent): number {
    const rect = trackRef.current!.getBoundingClientRect();
    const raw = (e.clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(1, raw));
  }

  function ensurePanLoop() {
    if (animFrameRef.current) return;
    lastFrameTimeRef.current = performance.now();
    const tick = (now: number) => {
      const dt = now - lastFrameTimeRef.current;
      lastFrameTimeRef.current = now;
      const tf = thumbFraction.value;
      let direction = 0;
      if (tf <= EDGE_THRESHOLD) direction = -1;
      else if (tf >= 1 - EDGE_THRESHOLD) direction = 1;
      if (direction !== 0 && draggingRef.current) {
        windowStartMs.value += direction * PAN_RATE_MS_PER_SEC * (dt / 1000);
        animFrameRef.current = requestAnimationFrame(tick);
      } else {
        animFrameRef.current = 0;
      }
    };
    animFrameRef.current = requestAnimationFrame(tick);
  }

  function stopPanLoop() {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = 0;
    }
  }

  function handlePointerDown(e: PointerEvent) {
    e.preventDefault();
    draggingRef.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const f = fractionFromPointer(e);
    thumbFraction.value = f;
    if (f <= EDGE_THRESHOLD || f >= 1 - EDGE_THRESHOLD) ensurePanLoop();
  }

  function handlePointerMove(e: PointerEvent) {
    if (!draggingRef.current) return;
    const f = fractionFromPointer(e);
    thumbFraction.value = f;
    if (f <= EDGE_THRESHOLD || f >= 1 - EDGE_THRESHOLD) ensurePanLoop();
  }

  function handlePointerEnd(e: PointerEvent) {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    stopPanLoop();
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Already released or never captured — ignore.
    }
  }

  function nowClick() {
    recenterAt(Date.now());
  }

  if (!range) {
    return <div class="scrubber scrubber-loading">Loading…</div>;
  }

  const hasChart = selectedStationId.value !== null;

  return (
    <div class={`scrubber${hasChart ? " scrubber-with-chart" : ""}`}>
      <div class="scrubber-label">
        <span class="scrubber-time">{formatScrubber(ms)}</span>
        {outOfRange && <span class="scrubber-warn">no data for this time</span>}
      </div>
      <div class="scrubber-row">
        <div class="scrubber-main">
          <TideChart />
          <div
            class="scrubber-track"
            ref={trackRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
          >
            <div class="scrubber-axis" />
            {ticks.map((t, i) => (
              <div
                key={i}
                class={`scrubber-tick scrubber-tick-${t.kind}`}
                style={{ left: `${t.pos * 100}%` }}
              />
            ))}
            {ticks
              .filter((t) => t.kind === "hour")
              .map((t, i) => (
                <div
                  key={`l${i}`}
                  class="scrubber-tick-label"
                  style={{ left: `${t.pos * 100}%` }}
                >
                  {t.label}
                </div>
              ))}
            {ticks
              .filter((t) => t.kind === "hour" && t.label === "00")
              .map((t, i) => (
                <div
                  key={`d${i}`}
                  class="scrubber-date-label"
                  style={{ left: `${t.pos * 100}%` }}
                >
                  {DATE_LABEL_FORMATTER.format(new Date(t.t))}
                </div>
              ))}
            {showNowDot && (
              <div
                class="scrubber-now-dot"
                style={{ left: `${nowFraction * 100}%` }}
              />
            )}
            <div
              class="scrubber-thumb"
              style={{ left: `${f * 100}%` }}
            />
          </div>
          {hasChart && (
            <div
              class="scrubber-thumb-vline"
              style={{ left: `${f * 100}%` }}
            />
          )}
        </div>
        <button class="scrubber-btn scrubber-now" onClick={nowClick}>Now</button>
      </div>
    </div>
  );
}
