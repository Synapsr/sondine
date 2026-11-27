import * as z from "zod";
import { DATA_LAYOUT } from "./data-layout";

// The marker of a staged restore (ADR 048), shared by core, which writes it
// once the staging is complete and checked, and main, which swaps the
// staging in at the next launch.

/** What a restore replaces: the data of the database and the files it points to. */
export const RESTORED_ITEMS = [
  DATA_LAYOUT.database,
  `${DATA_LAYOUT.database}-wal`,
  `${DATA_LAYOUT.database}-shm`,
  DATA_LAYOUT.archiveDir,
  DATA_LAYOUT.spoolDir,
  DATA_LAYOUT.contextDir,
  DATA_LAYOUT.lanDir,
  DATA_LAYOUT.phoneInboxDir,
] as const;

export const RestoreMarker = z.strictObject({
  /** `before-restore/<stamp>` gets the data it replaces. */
  stamp: z.string().regex(/^\d{8}-\d{6}$/),
  /** `staged`: nothing moved yet; `out`: the current data is moving aside; `in`: the staging is moving in. */
  phase: z.enum(["staged", "out", "in"]),
  /** What the staging holds, written by core: every one of them must end in the data folder. */
  items: z
    .array(z.enum(RESTORED_ITEMS))
    .min(1)
    .refine((items) => new Set(items).size === items.length),
});
export type RestoreMarker = z.output<typeof RestoreMarker>;

/** `20261127-101500` in UTC, the before-restore folder's name. */
export function restoreStamp(atMs: number): string {
  const iso = new Date(atMs).toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
}

/** `restoreStamp` back to milliseconds; null for another name. */
export function stampMs(stamp: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (match === null) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  return Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, s ?? 0);
}
