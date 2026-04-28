// 5-day overview panel for the selected primary current station —
// parallel to TidePanel. Lists every slack and max event in the next
// five local days, with a translucent bar tracking the chart's visible
// 15-h window. Layout mirrors TidePanel exactly so the two feel like
// one feature.

import {
  selectedStationId,
  loadedData,
  windowStartMs,
  WINDOW_MS,
  showPanels,
} from "../state/store";
import { localMidnightUtcMs } from "../util/time";
import { formatCurrentSpeed } from "../util/units";

const TZ = "America/Vancouver";
const DAY_MS = 24 * 3600 * 1000;
const PANEL_DAYS = 5;
const PANEL_DURATION_MS = PANEL_DAYS * DAY_MS;

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

export function CurrentPanel() {
  const id = selectedStationId.value;
  const data = loadedData.value;
  const start = windowStartMs.value;

  if (id === null || !data) return null;
  if (!showPanels.value) return null;
  const meta = data.stationsById.get(id);
  const extremes = data.currentExtremesById.get(id);
  if (!meta || !extremes) return null;
  if (meta.kind !== "current-primary" && meta.kind !== "current-secondary") return null;

  const panelStart = localMidnightUtcMs(Date.now());
  const panelEnd = panelStart + PANEL_DURATION_MS;

  const days = Array.from({ length: PANEL_DAYS }, (_, i) => {
    const anchorMs = panelStart + i * DAY_MS;
    return {
      isToday: i === 0,
      weekday: i === 0 ? "TODAY" : fmtWeekday(anchorMs),
      date: fmtDate(anchorMs),
    };
  });

  // Build the event list. The raw extremes contain both slacks (v=0)
  // and max events (signed knots, with v=0 also for weak/variable maxes
  // — the `weak` flag distinguishes those).
  const events: { t: number; v: number; kind: EventKind; weak: boolean }[] = [];
  for (let i = 0; i < extremes.length; i++) {
    const e = extremes[i];
    if (e.t < panelStart) continue;
    if (e.t >= panelEnd) break;
    const weak = !!e.weak;
    let kind: EventKind;
    if (weak || Math.abs(e.v) < 0.05) kind = "slack";
    else if (e.v > 0) kind = "flood";
    else kind = "ebb";
    events.push({ t: e.t, v: e.v, kind, weak });
  }

  const pos = (t: number) => ((t - panelStart) / PANEL_DURATION_MS) * 100;

  const winStartPct = pos(start);
  const winEndPct = pos(start + WINDOW_MS);
  const barTop = Math.max(0, winStartPct);
  const barBottom = Math.min(100, winEndPct);
  const showBar = barBottom > 0 && barTop < 100;

  return (
    <div
      class="current-panel"
      onClick={() => { selectedStationId.value = null; }}
    >
      <div class="current-panel-header">{meta.name}</div>
      <div class="current-panel-timeline">
        <div class="current-panel-gutter">
          {days.map((d, i) => (
            <div
              key={i}
              class={`current-panel-day${d.isToday ? " today" : ""}`}
              style={{
                top: `${(i / PANEL_DAYS) * 100}%`,
                height: `${(1 / PANEL_DAYS) * 100}%`,
              }}
            >
              <div class="current-panel-day-weekday">{d.weekday}</div>
              <div class="current-panel-day-date">{d.date}</div>
            </div>
          ))}
        </div>
        <div class="current-panel-events">
          {events.map((e, i) => (
            <div
              key={i}
              class={`current-panel-event ${e.kind}${e.weak ? " weak" : ""}`}
              style={{ top: `${pos(e.t)}%` }}
            >
              <span class="current-panel-event-time">{fmtTime(e.t)}</span>
              <span class="current-panel-event-kind">
                {e.kind === "slack"
                  ? (e.weak ? "WEAK" : "SLACK")
                  : e.kind === "flood" ? "FLOOD" : "EBB"}
              </span>
              <span class="current-panel-event-speed">
                {e.kind === "slack" ? "" : formatCurrentSpeed(Math.abs(e.v))}
              </span>
            </div>
          ))}
        </div>
        {[1, 2, 3, 4].map((i) => (
          <div
            key={`d${i}`}
            class="current-panel-divider"
            style={{ top: `${(i / PANEL_DAYS) * 100}%` }}
          />
        ))}
        {showBar && (
          <div
            class="current-panel-bar"
            style={{
              top: `${barTop}%`,
              height: `${barBottom - barTop}%`,
            }}
          />
        )}
      </div>
    </div>
  );
}
