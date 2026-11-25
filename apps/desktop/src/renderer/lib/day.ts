// Calendar days as the API names them: `YYYY-MM-DD` in the Mac's time zone
// (core reads days the same way). Arithmetic goes through local noon, so a
// daylight saving change never skips or repeats a day.

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad2 = (value: number) => String(value).padStart(2, "0");

/** The local day a wall-clock time falls on. */
export function dayOf(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parts(day: string): [number, number, number] | null {
  const match = DAY.exec(day);
  if (match === null) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(year, month - 1, date, 12);
  if (check.getMonth() !== month - 1 || check.getDate() !== date) return null;
  return [year, month, date];
}

/** A real calendar day, written `YYYY-MM-DD`. */
export function isDay(value: unknown): value is string {
  return typeof value === "string" && parts(value) !== null;
}

/** Local noon of a day, for formatting it. */
export function dayNoonMs(day: string): number {
  const found = parts(day);
  if (found === null) throw new RangeError(`not a day: ${day}`);
  const [year, month, date] = found;
  return new Date(year, month - 1, date, 12).getTime();
}

export function addDays(day: string, count: number): string {
  const found = parts(day);
  if (found === null) throw new RangeError(`not a day: ${day}`);
  const [year, month, date] = found;
  return dayOf(new Date(year, month - 1, date + count, 12).getTime());
}

export type RelativeDay = "today" | "yesterday" | "other";

export function relativeDay(day: string, today: string): RelativeDay {
  if (day === today) return "today";
  return day === addDays(today, -1) ? "yesterday" : "other";
}
