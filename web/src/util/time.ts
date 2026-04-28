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
