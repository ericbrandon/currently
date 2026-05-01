// 5-day-style overview for the selected primary current station —
// parallel to TidePanel. Lists every slack and max event in the visible
// time range. Currents are denser than tides (≈ 8 events/day vs 4), so
// rows that would overlap at the fixed pixels-per-hour scale get shifted
// down just enough to avoid touching. The label times remain accurate
// even where the row's vertical position is fudged.

import { useRef } from "preact/hooks";
import {
  selectedStationId,
  loadedData,
  scrubberMs,
  windowStartMs,
  tableOpen,
} from "../state/store";
import { localMidnightUtcMs } from "../util/time";
import { formatCurrentSpeed } from "../util/units";
import {
  DAY_MS,
  PANEL_RENDER_HALF_DAYS,
  PANEL_EVENT_ROW_HEIGHT_PX,
  CURRENT_PANEL_LAYOUT,
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

type EventKind = "flood" | "ebb" | "slack";

// Outer guard. Same split-component pattern as TidePanel — the inner is
// only mounted when the panel is genuinely visible, so its useEffects
// run with `panelRef.current` populated.
export function CurrentPanel() {
  const id = selectedStationId.value;
  const data = loadedData.value;

  if (id === null || !data) return null;
  if (!tableOpen.value) return null;
  const meta = data.stationsById.get(id);
  const extremes = data.currentExtremesById.get(id);
  if (!meta || !extremes) return null;
  if (meta.kind !== "current-primary" && meta.kind !== "current-secondary") return null;

  return <CurrentPanelContent meta={meta} extremes={extremes} />;
}

type ContentProps = {
  meta: { name: string; display_name?: string };
  extremes: { t: number; v: number; weak?: boolean }[];
};

function CurrentPanelContent({ meta, extremes }: ContentProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const gestureHandlers = usePanelGestures(panelRef, CURRENT_PANEL_LAYOUT);

  const start = windowStartMs.value;
  const thumb = scrubberMs.value;

  const visibleMin = thumb - PANEL_RENDER_HALF_DAYS * DAY_MS;
  const visibleMax = thumb + PANEL_RENDER_HALF_DAYS * DAY_MS;
  const todayMs = localMidnightUtcMs(Date.now());

  // Events with classification.
  const events: { t: number; v: number; kind: EventKind; weak: boolean }[] = [];
  for (let i = 0; i < extremes.length; i++) {
    const e = extremes[i];
    if (e.t < visibleMin) continue;
    if (e.t > visibleMax) break;
    const weak = !!e.weak;
    let kind: EventKind;
    if (weak || Math.abs(e.v) < 0.05) kind = "slack";
    else if (e.v > 0) kind = "flood";
    else kind = "ebb";
    events.push({ t: e.t, v: e.v, kind, weak });
  }

  // Anti-collision pass: walk events in time order, shifting any row
  // whose true position would overlap the previous one's tail. The label
  // text keeps the true time; only the visual y is fudged.
  type Placed = (typeof events)[number] & { displayOffsetPx: number };
  const placed: Placed[] = [];
  let lastBottom = -Infinity;
  for (const e of events) {
    const trueOffsetPx = CURRENT_PANEL_LAYOUT.offsetPxForTime(e.t, start);
    const displayOffsetPx = Math.max(trueOffsetPx, lastBottom);
    lastBottom = displayOffsetPx + PANEL_EVENT_ROW_HEIGHT_PX;
    placed.push({ ...e, displayOffsetPx });
  }

  // Day labels.
  const days: { t: number; label: string; date: string; isToday: boolean }[] = [];
  const firstMidnight = localMidnightUtcMs(visibleMin);
  for (let t = firstMidnight; t <= visibleMax; t += DAY_MS) {
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
      class="current-panel station-panel"
      ref={panelRef}
      {...gestureHandlers}
    >
      <div class="station-panel-header">{meta.display_name ?? meta.name}</div>
      <div class="station-panel-timeline">
        {days.map((d) => (
          <div
            key={`d${d.t}`}
            class="station-panel-divider"
            style={{ top: CURRENT_PANEL_LAYOUT.topCssForTime(d.t, start) }}
          />
        ))}
        {days.map((d) => (
          <div
            key={`l${d.t}`}
            class={`station-panel-day${d.isToday ? " today" : ""}`}
            style={{ top: CURRENT_PANEL_LAYOUT.topCssForTime(d.t, start) }}
          >
            <div class="station-panel-day-weekday">{d.label}</div>
            <div class="station-panel-day-date">{d.date}</div>
          </div>
        ))}
        {placed.map((e) => (
          <div
            key={e.t}
            class={`station-panel-event ${e.kind}${e.weak ? " weak" : ""}`}
            style={{ top: CURRENT_PANEL_LAYOUT.topCssForOffset(e.displayOffsetPx) }}
          >
            <span class="station-panel-event-time">{fmtTime(e.t)}</span>
            <span class="station-panel-event-kind">
              {e.kind === "slack"
                ? (e.weak ? "WEAK" : "SLACK")
                : e.kind === "flood" ? "FLOOD" : "EBB"}
            </span>
            <span class="station-panel-event-speed">
              {e.kind === "slack" ? "" : formatCurrentSpeed(Math.abs(e.v))}
            </span>
          </div>
        ))}
        <div
          class="station-panel-bar"
          style={{ top: CURRENT_PANEL_LAYOUT.barTopCss, height: CURRENT_PANEL_LAYOUT.barHeightCss }}
        />
      </div>
    </div>
  );
}
