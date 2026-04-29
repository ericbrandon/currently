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
  panWindowTo,
  recenterAt,
  WINDOW_MS,
  STEP_MS,
  THUMB_FRACTION,
} from "../state/store";
import { formatScrubber } from "../util/time";
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
  startWindowMs: number;
  trackWidth: number;
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
  const nowFraction = (now - start) / WINDOW_MS;
  const showNowDot = nowFraction >= 0 && nowFraction <= 1;

  const ticks = buildTicks(start);
  const outOfRange = !!range && (ms < range.min || ms > range.max);

  // ---------- Pointer drag ----------
  //
  // Handlers are attached at the .scrubber level so the gesture activates
  // anywhere in the white panel — chart area included — and not just over
  // the timeline track itself. The `closest('.scrubber-btn')` guard lets
  // button clicks (Now) pass through normally.

  function handlePointerDown(e: PointerEvent) {
    if ((e.target as Element | null)?.closest(".scrubber-btn")) return;
    e.preventDefault();
    const rect = trackRef.current!.getBoundingClientRect();
    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startWindowMs: windowStartMs.value,
      trackWidth: rect.width,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setGrabbing(true);
  }

  function handlePointerMove(e: PointerEvent) {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startClientX;
    // Drag right → reveal earlier times → windowStartMs decreases.
    panWindowTo(d.startWindowMs - DRAG_SPEED * (dx / d.trackWidth) * WINDOW_MS);
  }

  function handlePointerEnd(e: PointerEvent) {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    dragRef.current = null;
    setGrabbing(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Already released — ignore.
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
      if ((e.target as Element | null)?.closest(".scrubber-btn")) return;
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
    recenterAt(Date.now());
  }

  if (!range) {
    return <div class="scrubber scrubber-loading">Loading…</div>;
  }

  const sel = selectedStationId.value;
  const selMeta = sel !== null && loadedData.value
    ? loadedData.value.stationsById.get(sel) ?? null
    : null;
  const hasChart = selMeta !== null;
  const stationName = selMeta?.name ?? null;
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
          <span class="scrubber-time">{formatScrubber(ms)}</span>
        </div>
        {outOfRange && <span class="scrubber-warn">no data for this time</span>}
      </div>
      <div class="scrubber-row">
        <div class="scrubber-main">
          {isTideSel && <TideChart />}
          {isCurrentSel && <CurrentChart />}
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
              class="scrubber-thumb"
              style={{ left: `${THUMB_FRACTION * 100}%` }}
            />
          </div>
          {hasChart && (
            <div
              class="scrubber-thumb-vline"
              style={{ left: `${THUMB_FRACTION * 100}%` }}
            />
          )}
        </div>
        <button class="scrubber-btn scrubber-now" onClick={nowClick}>Now</button>
      </div>
    </div>
  );
}
