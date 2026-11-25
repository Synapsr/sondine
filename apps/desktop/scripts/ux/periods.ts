// The periods whose header must keep still (Téo, 2026-11-20): today,
// yesterday and an older day, in each zoom, as routes on the seeded data.

/** A local day `daysAgo` before today, as the routes take it. */
export function dayBefore(daysAgo: number): string {
  const at = new Date();
  at.setHours(12, 0, 0, 0);
  at.setDate(at.getDate() - daysAgo);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export interface Period {
  readonly zoom: "day" | "week" | "month";
  readonly name: string;
  readonly route: string;
}

export const periods: readonly Period[] = [
  { zoom: "day", name: "today", route: "/" },
  { zoom: "day", name: "yesterday", route: `/?day=${dayBefore(1)}` },
  { zoom: "day", name: "older", route: `/?day=${dayBefore(5)}` },
  { zoom: "week", name: "today", route: "/calendar?zoom=week" },
  { zoom: "week", name: "before", route: `/calendar?zoom=week&day=${dayBefore(7)}` },
  { zoom: "week", name: "older", route: `/calendar?zoom=week&day=${dayBefore(21)}` },
  { zoom: "month", name: "today", route: "/calendar?zoom=month" },
  { zoom: "month", name: "before", route: `/calendar?zoom=month&day=${dayBefore(32)}` },
  { zoom: "month", name: "older", route: `/calendar?zoom=month&day=${dayBefore(70)}` },
];
