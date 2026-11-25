// Calendar days of the Mac (ADR 042), as `2026-11-24`. Every rule about days
// goes through these: a day may last 23 or 25 hours.

export function dayOf(ms: number): string {
  const at = new Date(ms);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
}

/** Local midnight at the start of `day`, `offset` days later. */
export function startOfDay(day: string, offset = 0): number {
  const [year = 1970, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(year, month - 1, date + offset).getTime();
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T12:00:00.000Z`) - Date.parse(`${from}T12:00:00.000Z`)) / 86_400_000,
  );
}
