// Side panel listing today + next 4 days of HW/LW for the selected
// tide station. Slides a translucent yellow bar through the panel that
// represents the chart's visible 15-h window — events behind the bar
// are visually highlighted by the tint.
//
// Layout uses linear time mapping: pos(t) = (t − panelStart) / 5d × 100%.
// Each day occupies exactly 1/5 of the timeline, so day-boundary lines
// fall at 20% / 40% / 60% / 80%. Day labels sit in a left gutter; events
// are positioned absolutely at their time-proportional positions.

import {
  selectedStationId,
  loadedData,
  windowStartMs,
  WINDOW_MS,
} from "../state/store";
import { classifyHiLow } from "../interp/secondaryTides";
import { localMidnightUtcMs } from "../util/time";

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

export function TidePanel() {
  const id = selectedStationId.value;
  const data = loadedData.value;
  // Bar matches the chart's exact visible 15-h window: top edge of the
  // bar corresponds to the leftmost time on the timeline, bottom edge to
  // the rightmost. Only changes when the window itself moves (edge-pan
  // at either side of the timeline track, or "Now"); intentionally does
  // not move during normal thumb dragging in the middle of the track,
  // because the chart's contents don't change in that case either.
  const start = windowStartMs.value;

  if (id === null || !data) return null;
  const meta = data.stationsById.get(id);
  const extremes = data.tideExtremesById.get(id);
  if (!meta || !extremes) return null;
  if (meta.kind !== "tide-primary" && meta.kind !== "tide-secondary") return null;

  // Today's local midnight (Vancouver) — stable for the rest of the day.
  const panelStart = localMidnightUtcMs(Date.now());
  const panelEnd = panelStart + PANEL_DURATION_MS;

  // Five days. Day i's "anchor" is panelStart + i*24h; the FORMATTED date
  // is correct even if a DST transition falls in the window (rare in BC
  // post-Mar-8 2026; harmless when it does).
  const days = Array.from({ length: PANEL_DAYS }, (_, i) => {
    const anchorMs = panelStart + i * DAY_MS;
    return {
      isToday: i === 0,
      weekday: i === 0 ? "TODAY" : fmtWeekday(anchorMs),
      date: fmtDate(anchorMs),
    };
  });

  // Events within the 5-day window.
  const isHi = classifyHiLow(extremes);
  const events: { t: number; v: number; isHW: boolean }[] = [];
  for (let i = 0; i < extremes.length; i++) {
    const e = extremes[i];
    if (e.t < panelStart) continue;
    if (e.t >= panelEnd) break;
    events.push({ t: e.t, v: e.v, isHW: isHi[i] });
  }

  // Linear time → vertical % of timeline area.
  const pos = (t: number) => ((t - panelStart) / PANEL_DURATION_MS) * 100;

  // Highlighted bar: matches the chart's visible window exactly,
  // clamped to the panel's 5-day range.
  const winStartPct = pos(start);
  const winEndPct = pos(start + WINDOW_MS);
  const barTop = Math.max(0, winStartPct);
  const barBottom = Math.min(100, winEndPct);
  const showBar = barBottom > 0 && barTop < 100;

  return (
    <div
      class="tide-panel"
      onClick={() => { selectedStationId.value = null; }}
    >
      <div class="tide-panel-header">{meta.name}</div>
      <div class="tide-panel-timeline">
        <div class="tide-panel-gutter">
          {days.map((d, i) => (
            <div
              key={i}
              class={`tide-panel-day${d.isToday ? " today" : ""}`}
              style={{
                top: `${(i / PANEL_DAYS) * 100}%`,
                height: `${(1 / PANEL_DAYS) * 100}%`,
              }}
            >
              <div class="tide-panel-day-weekday">{d.weekday}</div>
              <div class="tide-panel-day-date">{d.date}</div>
            </div>
          ))}
        </div>
        <div class="tide-panel-events">
          {events.map((e, i) => (
            <div
              key={i}
              class={`tide-panel-event ${e.isHW ? "hw" : "lw"}`}
              style={{ top: `${pos(e.t)}%` }}
            >
              <span class="tide-panel-event-time">{fmtTime(e.t)}</span>
              <span class="tide-panel-event-kind">{e.isHW ? "HW" : "LW"}</span>
              <span class="tide-panel-event-height">{e.v.toFixed(1)} m</span>
            </div>
          ))}
        </div>
        {/* Day-boundary divider lines, drawn at the timeline level so they
            cross both gutter and events cleanly. */}
        {[1, 2, 3, 4].map((i) => (
          <div
            key={`d${i}`}
            class="tide-panel-divider"
            style={{ top: `${(i / PANEL_DAYS) * 100}%` }}
          />
        ))}
        {showBar && (
          <div
            class="tide-panel-bar"
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
