const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const STEPS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
  ["week", 4.35],
  ["month", 12],
  ["year", Number.POSITIVE_INFINITY],
];

/** "just now", "3 minutes ago", "yesterday" for a past date. */
export const timeAgo = (date: Date, now: Date = new Date()): string => {
  let value = (date.getTime() - now.getTime()) / 1000;
  if (Math.abs(value) < 45) return "just now";
  for (const [unit, size] of STEPS) {
    if (Math.abs(value) < size) return relative.format(Math.round(value), unit);
    value /= size;
  }
  return relative.format(Math.round(value), "year");
};
