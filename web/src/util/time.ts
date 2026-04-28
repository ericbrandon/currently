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

const dateOnlyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
});

const fullPartsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

/** Returns the UTC ms instant of midnight on the *local* date of `forUtcMs`
 *  in `America/Vancouver`. Uses an iterative resolution that converges in
 *  two passes — robust across DST transitions and BC's permanent UTC-7
 *  switch on Nov 1 2026. */
export function localMidnightUtcMs(forUtcMs: number): number {
  const localDateStr = dateOnlyFormatter.format(new Date(forUtcMs));
  const targetLocalUtcMs = Date.parse(`${localDateStr}T00:00:00Z`);

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
