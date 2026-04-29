// Side panel listing HW/LW for the selected tide station, scrollable
// across the full data range. The panel uses a fixed pixels-per-hour
// scale; the highlighted bar marking the chart's 15-h window is pinned
// at top-quarter, and event rows + day labels scroll past it as the
// user pans (via the timeline scrubber, this panel's drag/wheel, or
// the Now button — all share `windowStartMs`).

import { useRef } from "preact/hooks";
import {
  selectedStationId,
  loadedData,
  scrubberMs,
  windowStartMs,
  showPanels,
} from "../state/store";
import { classifyHiLow } from "../interp/secondaryTides";
import { localMidnightUtcMs } from "../util/time";
import { formatTideHeight } from "../util/units";
import {
  DAY_MS,
  PANEL_RENDER_HALF_DAYS,
  TIDE_PANEL_LAYOUT,
  usePanelGestures,
} from "./panelGestures";

const TZ = "America/Vancouver";

const TIME_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false,
});
const WEEKDAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, weekday: "short",
});
const DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, month: "short", day: "numeric",
});

const fmtTime = (ms: number) => TIME_FMT.format(new Date(ms));
const fmtWeekday = (ms: number) => WEEKDAY_FMT.format(new Date(ms)).toUpperCase();
const fmtDate = (ms: number) => DATE_FMT.format(new Date(ms));

// Outer guard component. Returns null when there's nothing to render so
// the inner component is genuinely unmounted (rather than mounted-but-
// returning-null) — that way the inner's useEffects with [] deps run at
// the right time, with `panelRef.current` populated.
export function TidePanel() {
  const id = selectedStationId.value;
  const data = loadedData.value;

  if (id === null || !data) return null;
  if (!showPanels.value) return null;
  const meta = data.stationsById.get(id);
  const extremes = data.tideExtremesById.get(id);
  if (!meta || !extremes) return null;
  if (meta.kind !== "tide-primary" && meta.kind !== "tide-secondary") return null;

  return <TidePanelContent meta={meta} extremes={extremes} />;
}

type ContentProps = {
  meta: { name: string };
  extremes: { t: number; v: number }[];
};

function TidePanelContent({ meta, extremes }: ContentProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const gestureHandlers = usePanelGestures(panelRef, TIDE_PANEL_LAYOUT);

  const start = windowStartMs.value;
  const thumb = scrubberMs.value;

  // Render only events / day labels within ±N days of the thumb instant.
  const visibleMin = thumb - PANEL_RENDER_HALF_DAYS * DAY_MS;
  const visibleMax = thumb + PANEL_RENDER_HALF_DAYS * DAY_MS;
  const todayMs = localMidnightUtcMs(Date.now());

  // Events.
  const isHi = classifyHiLow(extremes);
  const events: { t: number; v: number; isHW: boolean }[] = [];
  for (let i = 0; i < extremes.length; i++) {
    const e = extremes[i];
    if (e.t < visibleMin) continue;
    if (e.t > visibleMax) break;
    events.push({ t: e.t, v: e.v, isHW: isHi[i] });
  }

  // Day labels: every local-midnight in the visible range.
  const firstMidnight = localMidnightUtcMs(visibleMin);
  const days: { t: number; label: string; date: string; isToday: boolean }[] = [];
  for (let t = firstMidnight; t <= visibleMax; t += DAY_MS) {
    // DST/permanent-PDT-safe re-anchor every iteration in case the simple
    // 24-h step crossed a non-24-h day. (Rare in BC; cheap to redo.)
    const anchor = localMidnightUtcMs(t);
    if (anchor < visibleMin - DAY_MS) continue;
    const isToday = anchor === todayMs;
    days.push({
      t: anchor,
      label: isToday ? "TODAY" : fmtWeekday(anchor),
      date: fmtDate(anchor),
      isToday,
    });
  }

  return (
    <div
      class="tide-panel station-panel"
      ref={panelRef}
      {...gestureHandlers}
    >
      <div class="station-panel-header">{meta.name}</div>
      <div class="station-panel-timeline">
        {/* Day-boundary divider lines. */}
        {days.map((d) => (
          <div
            key={`d${d.t}`}
            class="station-panel-divider"
            style={{ top: TIDE_PANEL_LAYOUT.topCssForTime(d.t, start) }}
          />
        ))}
        {/* Day labels (gutter). */}
        {days.map((d) => (
          <div
            key={`l${d.t}`}
            class={`station-panel-day${d.isToday ? " today" : ""}`}
            style={{ top: TIDE_PANEL_LAYOUT.topCssForTime(d.t, start) }}
          >
            <div class="station-panel-day-weekday">{d.label}</div>
            <div class="station-panel-day-date">{d.date}</div>
          </div>
        ))}
        {/* Events. */}
        {events.map((e) => (
          <div
            key={e.t}
            class={`station-panel-event ${e.isHW ? "hw" : "lw"}`}
            style={{ top: TIDE_PANEL_LAYOUT.topCssForTime(e.t, start) }}
          >
            <span class="station-panel-event-time">{fmtTime(e.t)}</span>
            <span class="station-panel-event-kind">{e.isHW ? "HW" : "LW"}</span>
            <span class="station-panel-event-height">{formatTideHeight(e.v)}</span>
          </div>
        ))}
        {/* Fixed bar marking the chart's visible window. */}
        <div
          class="station-panel-bar"
          style={{ top: TIDE_PANEL_LAYOUT.barTopCss, height: TIDE_PANEL_LAYOUT.barHeightCss }}
        />
      </div>
      {/* Close affordance — chevron on the right edge, points the way out. */}
      <button
        class="panel-close"
        aria-label="Close panel"
        onClick={() => { selectedStationId.value = null; }}
      >
        <svg viewBox="0 0 16 24" aria-hidden="true">
          <path d="M13 4 L7 12 L13 20" />
          <path d="M7 4 L1 12 L7 20" />
        </svg>
      </button>
    </div>
  );
}
