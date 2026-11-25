// How times and lengths read on screen. Wall-clock times follow the locale;
// a position in an episode reads like a player's ("06:14", "1:02:03").

/** "16:31" in French, "4:31 PM" in English. */
export function formatClock(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(ms);
}

const pad = (value: number) => String(value).padStart(2, "0");

/** A position or a length on a player: minutes and seconds, hours when needed. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export type DurationParts =
  | { readonly unit: "seconds"; readonly seconds: number }
  | { readonly unit: "minutes"; readonly minutes: number }
  | { readonly unit: "hours"; readonly hours: number; readonly minutes: number };

/**
 * A length rounded the way it is said: seconds under a minute, whole
 * minutes under an hour, then hours and minutes. Anything heard lasts at
 * least a second.
 */
export function durationParts(ms: number): DurationParts {
  if (ms < 59_500)
    return { unit: "seconds", seconds: ms <= 0 ? 0 : Math.max(1, Math.round(ms / 1000)) };
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return { unit: "minutes", minutes };
  return { unit: "hours", hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}
