/** Date formatting for management tables (English, the viewer's time zone). */

const dateFormat = new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric" });
const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** `Oct 21, 2026`. */
export function formatDate(date: Date): string {
  return dateFormat.format(date);
}

/** `3 days ago`, `in 2 weeks`, `just now`. */
export function formatRelative(date: Date, now: Date = new Date()): string {
  const diff = date.getTime() - now.getTime();
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return relativeFormat.format(Math.round(diff / ms), unit);
  }
  return "just now";
}
