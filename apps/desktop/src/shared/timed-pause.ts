// Timed pauses, as the menu bar and the window both offer and show them
// (« En pause jusqu'à 14:35 »). Environment-free, for main and the renderer.

/** The timed pauses offered next to the pause until resumed. */
export const TIMED_PAUSES_MS = {
  "15-min": 15 * 60_000,
  "1-hour": 60 * 60_000,
} as const;

/** The time alone when the pause ends today, with the weekday on another day. */
export function pauseEndLabel(untilMs: number, nowMs: number, locale: string): string {
  const until = new Date(untilMs);
  const now = new Date(nowMs);
  const sameDay = until.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(locale, {
    ...(sameDay ? {} : { weekday: "long" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(until);
}
