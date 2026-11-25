import { addDays, dayNoonMs } from "../../lib/day";
import { dayTitle } from "../../lib/labels";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";

// What a day, a week or a month's header says, always as a title and a line
// under it (Téo, 2026-11-20: the header changed shape with its words, and
// everything under it moved). A day: « Aujourd'hui » or « Hier » over its
// date, an older one its weekday over its date; a week its days over its
// number; a month its name over its year.

export interface PeriodHeading {
  readonly title: string;
  readonly subtitle: string;
}

const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase(getLocale()) + text.slice(1);

function format(day: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(getLocale(), options).format(dayNoonMs(day));
}

export function dayHeading(day: string, today: string): PeriodHeading {
  const otherYear = day.slice(0, 4) !== today.slice(0, 4);
  const date = format(day, {
    day: "numeric",
    month: "long",
    ...(otherYear ? { year: "numeric" } : {}),
  });
  const weekday = capitalize(format(day, { weekday: "long" }));
  if (day === today || day === addDays(today, -1)) {
    return { title: dayTitle(day, today), subtitle: `${weekday} ${date}` };
  }
  return { title: weekday, subtitle: date };
}

/** `start` is the week's Monday. */
export function weekHeading(start: string, today: string): PeriodHeading {
  const thisYear = start.slice(0, 4) === today.slice(0, 4);
  const title = new Intl.DateTimeFormat(getLocale(), {
    day: "numeric",
    month: "long",
    ...(thisYear ? {} : { year: "numeric" }),
  }).formatRange(dayNoonMs(start), dayNoonMs(addDays(start, 6)));
  return { title, subtitle: m.calendar_week_number({ number: isoWeek(start) }) };
}

/** `start` is the month's first day. */
export function monthHeading(start: string): PeriodHeading {
  return {
    title: capitalize(format(start, { month: "long" })),
    subtitle: format(start, { year: "numeric" }),
  };
}

/** The ISO 8601 week number of a Monday: the week holding its Thursday. */
export function isoWeek(monday: string): number {
  const thursday = addDays(monday, 3);
  const january4 = `${thursday.slice(0, 4)}-01-04`;
  const firstThursday = addDays(january4, 3 - ((new Date(dayNoonMs(january4)).getDay() + 6) % 7));
  return Math.round((dayNoonMs(thursday) - dayNoonMs(firstThursday)) / (7 * 86_400_000)) + 1;
}
