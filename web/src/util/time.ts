// Time formatting helpers. All internal time is absolute UTC ms; this
// module is the only place that thinks about wall-clock display.
//
// We use America/Vancouver as the display zone for BC. Browsers track its
// offset automatically, so this works correctly through BC's permanent
// UTC-7 transition (Nov 1 2026) without any code changes.

const TZ = "America/Vancouver";

// We deliberately omit timeZoneName: the label would flip between PST and
// PDT as the user scrubs across DST transitions (a real but distracting
// artifact). The user knows their wall clock; showing the abbreviation
// adds noise without information.
const longFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatScrubber(ms: number): string {
  return longFormatter.format(new Date(ms));
}

// Thumb-pill format. Compact date + time, used inside the small pill that
// sits above the timeline thumb (and chart thumb-readouts). en-CA's
// default joiner inserts an "at" between date and time, which feels too
// chatty for a pill — we format the date and time separately and join
// with a space.
const thumbDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  weekday: "short",
  month: "short",
  day: "numeric",
});
const thumbTimeFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
export function formatThumb(ms: number): string {
  const d = new Date(ms);
  return `${thumbDateFormatter.format(d)} ${thumbTimeFormatter.format(d)}`;
}

const dateOnlyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
});

const fullPartsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

export type LocalDate = { year: number; month: number; day: number };

/** Calendar date (1-based month) of `utcMs` on BC's wall clock. */
export function localDateOf(utcMs: number): LocalDate {
  const [y, m, d] = dateOnlyFormatter.format(new Date(utcMs)).split("-");
  return { year: +y, month: +m, day: +d };
}

/** Compare two calendar dates: negative, zero, or positive. */
export function compareLocalDates(a: LocalDate, b: LocalDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/** Resolve wall-clock `hour`:00:00 on the local calendar date to a UTC
 *  instant. Iterative: start from the naive "as if UTC" instant, measure
 *  the zone offset there, correct, and repeat once — converges in two
 *  passes and is robust across DST transitions and BC's permanent UTC-7
 *  switch on Nov 1 2026. If the wall-clock time doesn't exist (the
 *  spring-forward gap) the result lands on the nearest real instant. */
function resolveLocalUtcMs(date: LocalDate, hour: number): number {
  const targetLocalUtcMs = Date.UTC(date.year, date.month - 1, date.day, hour);

  let guess = targetLocalUtcMs;
  for (let i = 0; i < 2; i++) {
    const parts = fullPartsFormatter.formatToParts(new Date(guess));
    const get = (k: string) => parseInt(parts.find((p) => p.type === k)!.value);
    const localUtcMs = Date.UTC(
      get("year"), get("month") - 1, get("day"),
      get("hour") % 24, get("minute"), get("second"),
    );
    const offsetMs = localUtcMs - guess;
    guess = targetLocalUtcMs - offsetMs;
  }
  return guess;
}

/** Returns the UTC ms instant of midnight on the *local* date of `forUtcMs`
 *  in `America/Vancouver`. */
export function localMidnightUtcMs(forUtcMs: number): number {
  return resolveLocalUtcMs(localDateOf(forUtcMs), 0);
}

/** UTC ms instant of 12:00 on the given local calendar date. */
export function localNoonUtcMs(date: LocalDate): number {
  return resolveLocalUtcMs(date, 12);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** First and last local calendar dates the date picker may offer for a
 *  data range [minMs, maxMs]: a day qualifies only if 12:00 on that day
 *  falls inside the range, since picking a day jumps to its noon. This
 *  also trims boundary stubs — the data's last extreme sits just after
 *  local midnight, which would otherwise expose a whole extra month
 *  with one (or zero, depending on the device's zone tables) live day. */
export function selectableDateBounds(
  minMs: number,
  maxMs: number,
): { first: LocalDate; last: LocalDate } {
  let first = localDateOf(minMs);
  if (localNoonUtcMs(first) < minMs) first = localDateOf(localNoonUtcMs(first) + DAY_MS);
  let last = localDateOf(maxMs);
  if (localNoonUtcMs(last) > maxMs) last = localDateOf(localNoonUtcMs(last) - DAY_MS);
  return { first, last };
}
