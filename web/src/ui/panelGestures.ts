// Shared layout + gesture logic for TidePanel and CurrentPanel.
//
// Each panel chooses its own pixels-per-hour scale (tides are denser
// vertically because they have only HW/LW; currents are looser because
// they have ~8 events per day). The shared bar / event positioning is
// derived from that scale via `makePanelLayout`. Gestures + wheel on
// the panel pan `windowStartMs`, the same signal the timeline scrubber
// drives — so dragging either surface moves both.

import { useEffect, useRef } from "preact/hooks";
import type { RefObject } from "preact";
import {
  panWindowTo,
  selectedStationId,
  windowStartMs,
  WINDOW_MS,
  THUMB_FRACTION,
} from "../state/store";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/** Per-panel layout helpers, all derived from a chosen pixels-per-hour. */
export type PanelLayout = {
  pxPerHour: number;
  /** CSS top for the fixed 15-h bar — sits at 25% of the panel timeline
   *  area minus the bar's THUMB_FRACTION offset, so the bar's "scrubber
   *  instant" line is exactly at the 25% line regardless of viewport. */
  barTopCss: string;
  barHeightCss: string;
  offsetPxForTime: (t: number, windowStart: number) => number;
  topCssForOffset: (offsetPx: number) => string;
  topCssForTime: (t: number, windowStart: number) => string;
};

export function makePanelLayout(pxPerHour: number): PanelLayout {
  const barHeight = (WINDOW_MS / HOUR_MS) * pxPerHour;
  const barThumbOffset = THUMB_FRACTION * barHeight;

  const offsetPxForTime = (t: number, windowStart: number) =>
    ((t - windowStart) / HOUR_MS) * pxPerHour;
  const topCssForOffset = (offsetPx: number) =>
    `calc(25% - ${barThumbOffset}px + ${offsetPx}px)`;
  const topCssForTime = (t: number, windowStart: number) =>
    topCssForOffset(offsetPxForTime(t, windowStart));

  return {
    pxPerHour,
    barTopCss: `calc(25% - ${barThumbOffset}px)`,
    barHeightCss: `${barHeight}px`,
    offsetPxForTime,
    topCssForOffset,
    topCssForTime,
  };
}

// Tides have ~4 events/day with ~6-h spacing, so they tolerate a much
// tighter scale than currents. 7 px/h → 1 day ≈ 168 px; 6-h gap = 42 px,
// well clear of the 22-px event row height.
export const TIDE_PANEL_LAYOUT = makePanelLayout(7);
// Currents have ~8 events/day; 14 px/h → 1 day ≈ 336 px; 3-h gap = 42 px.
export const CURRENT_PANEL_LAYOUT = makePanelLayout(14);

/** Number of days to render on either side of the thumb instant. Events
 *  outside this window are skipped — keeps the rendered DOM small while
 *  still covering any plausible viewport. */
export const PANEL_RENDER_HALF_DAYS = 3;

/** Shared event row height. The collision-avoidance pass uses this as
 *  the minimum gap between successive event rows. */
export const PANEL_EVENT_ROW_HEIGHT_PX = 22;

// ---------------- Gestures ----------------

// Wheel: 6× the timeline-scrubber's calibration so the panel pans at a
// usefully brisk rate (otherwise scrolling through several days takes
// forever). Calibration is in *time per px of wheel delta* and is
// independent of the panel's pxPerHour — both panels travel the same
// number of hours per wheel notch.
const WHEEL_MS_PER_PX = (6 * 15 * 60 * 1000) / 100;
const WHEEL_LINE_PX = 16;
const WHEEL_PAGE_PX = 800;

const SWIPE_LOCK_PX = 8;
const SWIPE_DISMISS_DX_PX = -60;
const SWIPE_DISMISS_VELOCITY_PX_PER_MS = -0.4;

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  startWindowMs: number;
  mode: "uncommitted" | "pan" | "swipe";
  lastX: number;
  lastT: number;
  velocityXPxPerMs: number;
};

/** Wires drag (vertical pan + horizontal flick-to-dismiss) and wheel
 *  handlers to a panel element. The element must include a child with
 *  class `panel-close` for the close-button bypass to work. */
export function usePanelGestures(
  elRef: RefObject<HTMLElement | null>,
  layout: PanelLayout,
) {
  const dragRef = useRef<DragState | null>(null);

  function isCloseTarget(t: EventTarget | null): boolean {
    return !!(t as Element | null)?.closest(".panel-close");
  }

  function handlePointerDown(e: PointerEvent) {
    if (isCloseTarget(e.target)) return;
    e.preventDefault();
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startWindowMs: windowStartMs.value,
      mode: "uncommitted",
      lastX: e.clientX,
      lastT: performance.now(),
      velocityXPxPerMs: 0,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e: PointerEvent) {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;

    if (d.mode === "uncommitted" && Math.max(Math.abs(dx), Math.abs(dy)) >= SWIPE_LOCK_PX) {
      d.mode = Math.abs(dy) >= Math.abs(dx) ? "pan" : "swipe";
    }

    if (d.mode === "pan") {
      // Drag down → reveal earlier times → windowStartMs decreases.
      panWindowTo(d.startWindowMs - (dy * HOUR_MS) / layout.pxPerHour);
    }

    const now = performance.now();
    const sampleDt = now - d.lastT;
    if (sampleDt > 0) {
      d.velocityXPxPerMs = (e.clientX - d.lastX) / sampleDt;
    }
    d.lastX = e.clientX;
    d.lastT = now;
  }

  function handlePointerEnd(e: PointerEvent) {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Already released — ignore.
    }
    if (d.mode === "swipe") {
      const dx = e.clientX - d.startX;
      if (dx <= SWIPE_DISMISS_DX_PX || d.velocityXPxPerMs <= SWIPE_DISMISS_VELOCITY_PX_PER_MS) {
        selectedStationId.value = null;
      }
    }
  }

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (isCloseTarget(e.target)) return;
      e.preventDefault();
      const scale =
        e.deltaMode === 1 ? WHEEL_LINE_PX :
        e.deltaMode === 2 ? WHEEL_PAGE_PX : 1;
      const px = (e.deltaY + e.deltaX) * scale;
      panWindowTo(windowStartMs.value + px * WHEEL_MS_PER_PX);
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return {
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerEnd,
    onPointerCancel: handlePointerEnd,
  };
}
