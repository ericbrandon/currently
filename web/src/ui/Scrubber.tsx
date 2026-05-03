// 15-hour windowed timeline scrubber.
//
// The thumb sits at a fixed visual position (THUMB_FRACTION across the
// track). The user pans the timeline content beneath it via:
//   - pointer drag (mouse, pen, or touch — drag right to reveal earlier
//     times, "content follows finger");
//   - mouse wheel / trackpad scroll (down or right → advance into the
//     future).
// Drag is 1:1 with no momentum — boaters need precise minute-level control.
// "Now" snaps the window so `Date.now()` sits exactly under the thumb.

import { useEffect, useRef, useState } from "preact/hooks";
import {
  windowStartMs,
  scrubberMs,
  scrubberRange,
  selectedStationId,
  loadedData,
  tableOpen,
  panWindowTo,
  nowLocked,
  WINDOW_MS,
  STEP_MS,
  THUMB_FRACTION,
} from "../state/store";
import { formatThumb } from "../util/time";
import { TideChart } from "./TideChart";
import { CurrentChart } from "./CurrentChart";

const HOUR_MS = 60 * 60 * 1000;
const HALF_MS = 30 * 60 * 1000;

// Wheel calibration: ~15 min of pan per typical wheel notch (~100 px in
// pixel mode). Trackpads send many small deltas which feels smooth at
// this ratio.
const WHEEL_MS_PER_PX = (15 * 60 * 1000) / 100;
const WHEEL_LINE_PX = 16;
const WHEEL_PAGE_PX = 800;

// Drag speed: 0.5 means dragging the full track width pans the timeline by
// half the visible window (7.5 h instead of 15 h).
const DRAG_SPEED = 0.5;

// Direction-locking thresholds for chart-area gestures. Mirror the
// horizontal flick-to-dismiss in panelGestures.ts but rotated 90° — the
// chart sits at the top of the scrubber strip and exits downward.
const SWIPE_LOCK_PX = 8;
const SWIPE_DISMISS_DY_PX = 60;
const SWIPE_DISMISS_VELOCITY_PX_PER_MS = 0.4;

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

type DragState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startWindowMs: number;
  trackWidth: number;
  // Gestures that begin on the chart area participate in direction-locking
  // so a vertical-down flick can dismiss without also panning the timeline.
  // Gestures that begin on the timeline track skip this and pan as before.
  startedOnChart: boolean;
  mode: "uncommitted" | "pan" | "swipe-down";
  lastY: number;
  lastT: number;
  velocityYPxPerMs: number;
};

export function Scrubber() {
  const range = scrubberRange.value;
  const scrubberRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [grabbing, setGrabbing] = useState(false);

  const start = windowStartMs.value;
  const ms = scrubberMs.value;

  // "Now" indicator: re-render once a minute so the red dot drifts across
  // the track even when the user isn't interacting.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const locked = nowLocked.value;
  const nowFraction = (now - start) / WINDOW_MS;
  // While locked the now-dot sits under the thumb; the thumb's own
  // red border stands in for it, and a sub-pixel drift between the
  // 1-min `now` state and 1-s `windowStartMs` updates would otherwise
  // make the red dot creep visibly out from behind the thumb.
  const showNowDot = !locked && nowFraction >= 0 && nowFraction <= 1;

  const ticks = buildTicks(start);
  const outOfRange = !!range && (ms < range.min || ms > range.max);

  // ---------- Pointer drag ----------
  //
  // Handlers are attached at the .scrubber level so the gesture activates
  // anywhere in the white panel — chart area included — and not just over
  // the timeline track itself. The `closest('.scrubber-btn')` guard lets
  // button clicks (Now) pass through normally.

  function handlePointerDown(e: PointerEvent) {
    const target = e.target as Element | null;
    if (target?.closest(".scrubber-btn, .chart-close, .table-open")) return;
    e.preventDefault();
    const rect = trackRef.current!.getBoundingClientRect();
    const startedOnChart = !!target?.closest(".tide-chart, .current-chart");
    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startWindowMs: windowStartMs.value,
      trackWidth: rect.width,
      startedOnChart,
      // Gestures on the timeline track commit to pan immediately so the
      // existing horizontal-pan feel is unchanged.
      mode: startedOnChart ? "uncommitted" : "pan",
      lastY: e.clientY,
      lastT: performance.now(),
      velocityYPxPerMs: 0,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setGrabbing(true);
  }

  function handlePointerMove(e: PointerEvent) {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startClientX;
    const dy = e.clientY - d.startClientY;

    if (d.mode === "uncommitted" && Math.max(Math.abs(dx), Math.abs(dy)) >= SWIPE_LOCK_PX) {
      // Lock to swipe-down only when the dominant axis is vertical AND the
      // direction is downward. Horizontal-dominant or upward-vertical flicks
      // fall through to pan, preserving the existing horizontal scrub on
      // the chart area.
      d.mode = dy > 0 && Math.abs(dy) > Math.abs(dx) ? "swipe-down" : "pan";
    }

    if (d.mode === "pan") {
      // Drag right → reveal earlier times → windowStartMs decreases.
      panWindowTo(d.startWindowMs - DRAG_SPEED * (dx / d.trackWidth) * WINDOW_MS);
    }

    const now = performance.now();
    const sampleDt = now - d.lastT;
    if (sampleDt > 0) {
      d.velocityYPxPerMs = (e.clientY - d.lastY) / sampleDt;
    }
    d.lastY = e.clientY;
    d.lastT = now;
  }

  function handlePointerEnd(e: PointerEvent) {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dy = e.clientY - d.startClientY;
    dragRef.current = null;
    setGrabbing(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Already released — ignore.
    }
    if (
      d.mode === "swipe-down" &&
      (dy >= SWIPE_DISMISS_DY_PX || d.velocityYPxPerMs >= SWIPE_DISMISS_VELOCITY_PX_PER_MS)
    ) {
      selectedStationId.value = null;
    }
  }

  // ---------- Wheel ----------
  //
  // Attached via addEventListener with { passive: false } so we can
  // preventDefault — Preact's JSX onWheel gives no direct way to pin
  // passivity, and Chrome treats wheel listeners on the document tree
  // as passive by default in some setups.

  useEffect(() => {
    const el = scrubberRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if ((e.target as Element | null)?.closest(".scrubber-btn, .chart-close, .table-open")) return;
      e.preventDefault();
      const scale =
        e.deltaMode === 1 ? WHEEL_LINE_PX :
        e.deltaMode === 2 ? WHEEL_PAGE_PX : 1;
      const px = (e.deltaY + e.deltaX) * scale;
      // Down / right → advance into the future → windowStartMs increases.
      panWindowTo(windowStartMs.value + px * WHEEL_MS_PER_PX);
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [range]);

  function nowClick() {
    // The lock effect snaps windowStartMs to "now" immediately and keeps
    // it pinned every second until any user pan calls panWindowTo.
    nowLocked.value = true;
  }

  if (!range) {
    return <div class="scrubber scrubber-loading">Loading…</div>;
  }

  const sel = selectedStationId.value;
  const selMeta = sel !== null && loadedData.value
    ? loadedData.value.stationsById.get(sel) ?? null
    : null;
  const hasChart = selMeta !== null;
  const stationName = selMeta?.display_name ?? selMeta?.name ?? null;
  const isCurrentSel =
    selMeta?.kind === "current-primary" || selMeta?.kind === "current-secondary";
  const isTideSel =
    selMeta?.kind === "tide-primary" || selMeta?.kind === "tide-secondary";

  return (
    <div
      class={`scrubber${hasChart ? " scrubber-with-chart" : ""}${grabbing ? " is-grabbing" : ""}`}
      ref={scrubberRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
    >
      <div class="scrubber-label">
        <div class="scrubber-label-left">
          {stationName && <span class="scrubber-station-name">{stationName}</span>}
        </div>
        {outOfRange && <span class="scrubber-warn">no data for this time</span>}
      </div>
      {hasChart && (
        <button
          class="chart-close"
          aria-label="Close chart"
          onClick={() => { selectedStationId.value = null; }}
        >
          <svg viewBox="0 0 24 16" aria-hidden="true">
            <path d="M4 3 L12 9 L20 3" />
            <path d="M4 9 L12 15 L20 9" />
          </svg>
        </button>
      )}
      {hasChart && !tableOpen.value && (
        <button
          class="table-open"
          aria-label="Show table"
          onClick={() => { tableOpen.value = true; }}
        >
          <svg viewBox="0 0 24 16" aria-hidden="true">
            <path d="M4 13 L12 7 L20 13" />
            <path d="M4 7 L12 1 L20 7" />
          </svg>
          <span>Table</span>
        </button>
      )}
      <div class="scrubber-row">
        <div class="scrubber-main">
          {isTideSel && <TideChart />}
          {isCurrentSel && <CurrentChart />}
          {!hasChart && (
            <div class="scrubber-thumb-pill-area">
              <div
                class="scrubber-thumb-pill-label"
                style={{ left: `${THUMB_FRACTION * 100}%` }}
              >
                {formatThumb(ms)}
              </div>
            </div>
          )}
          <div class="scrubber-track" ref={trackRef}>
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
              class={`scrubber-thumb${locked ? " is-locked" : ""}`}
              style={{ left: `${THUMB_FRACTION * 100}%` }}
            />
          </div>
          <div
            class="scrubber-thumb-vline"
            style={{ left: `${THUMB_FRACTION * 100}%` }}
          />
        </div>
        <button class="scrubber-btn scrubber-now" onClick={nowClick}>Now</button>
      </div>
    </div>
  );
}
