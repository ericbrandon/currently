// Calendar popover for jumping the timeline to a chosen day.
//
// Opened by tapping the date/time pill above the scrubber thumb (in the
// bare scrubber and at the top of the tide/current charts). Sits just
// above the scrubber panel, horizontally centred on the thumb and clamped
// to the viewport. A transparent full-screen backdrop closes it on any
// outside tap without letting that tap reach the map or scrubber (so
// closing the calendar never also selects a station or pans the
// timeline). Escape closes it too.
//
// Picking a day closes the popover and recenters the thumb on 12:00 BC
// wall-clock time of that day. Days outside the loaded data range are
// disabled, and month navigation stops at the range's first/last months,
// so the user can never land on a date we have no predictions for.

import { useEffect, useRef, useState } from "preact/hooks";
import {
  datePickerOpen,
  scrubberMs,
  scrubberRange,
  recenterAt,
  THUMB_FRACTION,
} from "../state/store";
import {
  localDateOf,
  localNoonUtcMs,
  compareLocalDates,
  type LocalDate,
} from "../util/time";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

// Month/year label. The calendar grid is pure calendar arithmetic on
// (year, month, day) so it's zone-independent; formatting the 1st of the
// month as UTC just avoids any zone shifting the label.
const MONTH_FMT = new Intl.DateTimeFormat("en-CA", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function firstWeekday(year: number, month: number): number {
  return new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
}
function monthLabel(year: number, month: number): string {
  return MONTH_FMT.format(new Date(Date.UTC(year, month - 1, 1)));
}
function compareMonths(a: { year: number; month: number }, b: { year: number; month: number }) {
  return a.year - b.year || a.month - b.month;
}

function close() {
  datePickerOpen.value = false;
}

export function DatePicker() {
  const range = scrubberRange.value;
  const selected = localDateOf(scrubberMs.value);
  const today = localDateOf(Date.now());
  const [view, setView] = useState({ year: selected.year, month: selected.month });
  const selectedRef = useRef<HTMLButtonElement>(null);

  // Horizontal anchor: the pill is centred at THUMB_FRACTION of the
  // scrubber-main column. Measured once on open; the popover's `left` is
  // derived from it in CSS with viewport clamping.
  const [anchorX, setAnchorX] = useState<number | null>(null);
  useEffect(() => {
    const main = document.querySelector(".scrubber-main");
    if (!main) return;
    const r = main.getBoundingClientRect();
    setAnchorX(r.left + THUMB_FRACTION * r.width);
  }, []);

  useEffect(() => {
    selectedRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  if (!range) return null;
  const minDate = localDateOf(range.min);
  const maxDate = localDateOf(range.max);
  const canPrev = compareMonths(view, minDate) > 0;
  const canNext = compareMonths(view, maxDate) < 0;

  function step(delta: number) {
    setView((v) => {
      const m = v.month + delta;
      if (m < 1) return { year: v.year - 1, month: 12 };
      if (m > 12) return { year: v.year + 1, month: 1 };
      return { year: v.year, month: m };
    });
  }

  function pick(date: LocalDate) {
    recenterAt(localNoonUtcMs(date));
    close();
  }

  const cells: (LocalDate | null)[] = [];
  for (let i = 0; i < firstWeekday(view.year, view.month); i++) cells.push(null);
  const n = daysInMonth(view.year, view.month);
  for (let d = 1; d <= n; d++) cells.push({ year: view.year, month: view.month, day: d });

  return (
    <>
      <div class="datepicker-backdrop" onClick={close} />
      <div
        class="datepicker"
        role="dialog"
        aria-label="Choose a date"
        style={anchorX !== null ? { "--cal-x": `${anchorX}px` } : undefined}
      >
        <div class="datepicker-header">
          <button
            type="button"
            class="datepicker-nav"
            aria-label="Previous month"
            disabled={!canPrev}
            onClick={() => step(-1)}
          >
            ‹
          </button>
          <span class="datepicker-title" aria-live="polite">
            {monthLabel(view.year, view.month)}
          </span>
          <button
            type="button"
            class="datepicker-nav"
            aria-label="Next month"
            disabled={!canNext}
            onClick={() => step(1)}
          >
            ›
          </button>
        </div>
        <div class="datepicker-grid">
          {WEEKDAYS.map((w, i) => (
            <div key={`w${i}`} class="datepicker-weekday" aria-hidden="true">{w}</div>
          ))}
          {cells.map((c, i) =>
            c === null ? (
              <div key={`b${i}`} />
            ) : (
              <button
                key={`d${c.day}`}
                type="button"
                ref={compareLocalDates(c, selected) === 0 ? selectedRef : undefined}
                class={
                  "datepicker-day" +
                  (compareLocalDates(c, selected) === 0 ? " is-selected" : "") +
                  (compareLocalDates(c, today) === 0 ? " is-today" : "")
                }
                disabled={
                  compareLocalDates(c, minDate) < 0 || compareLocalDates(c, maxDate) > 0
                }
                aria-current={compareLocalDates(c, today) === 0 ? "date" : undefined}
                onClick={() => pick(c)}
              >
                {c.day}
              </button>
            ),
          )}
        </div>
      </div>
    </>
  );
}
