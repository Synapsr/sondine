import { join } from "node:path";

// Spool files are `<spoolDir>/<trackDir>/<runId>/NNNN.pcm` (with `NNNN.jsonl`
// next to them); the archive of one is `<archiveDir>/<trackDir>/<runId>/NNNN.pcm`.
// Paths are relative to the data directory, as `spool_files.rel_path` and
// `chunks.archive_rel_path` store them.

export interface RetentionLayout {
  /** Absolute data directory. */
  readonly dataDir: string;
  readonly spoolDir: string;
  readonly archiveDir: string;
}

export interface SpoolFileName {
  readonly trackDir: string;
  readonly runId: string;
  /** `NNNN`, the rotation index as the helper writes it. */
  readonly stem: string;
  readonly seq: number;
}

const STEM = /^(\d{4,})\.pcm$/;

/** A path segment the helper could have written: never empty, `.`-led, or a separator. */
const safeSegment = (segment: string | undefined): segment is string =>
  segment !== undefined && segment !== "" && !segment.startsWith(".") && !segment.includes("\\");

/** Parses `<root>/<trackDir>/<runId>/NNNN.pcm`; null for anything else. */
export function parseLayoutPath(relPath: string, root: string): SpoolFileName | null {
  const parts = relPath.split("/");
  if (parts.length !== 4 || parts[0] !== root) return null;
  const [, trackDir, runId, name] = parts;
  const match = name === undefined ? null : STEM.exec(name);
  if (!safeSegment(trackDir) || !safeSegment(runId) || match?.[1] === undefined) return null;
  return { trackDir, runId, stem: match[1], seq: Number.parseInt(match[1], 10) };
}

export function archiveRelPathOf(layout: RetentionLayout, spoolRelPath: string): string | null {
  const name = parseLayoutPath(spoolRelPath, layout.spoolDir);
  return name === null
    ? null
    : `${layout.archiveDir}/${name.trackDir}/${name.runId}/${name.stem}.pcm`;
}

export function spoolRelPathOf(layout: RetentionLayout, archiveRelPath: string): string | null {
  const name = parseLayoutPath(archiveRelPath, layout.archiveDir);
  return name === null
    ? null
    : `${layout.spoolDir}/${name.trackDir}/${name.runId}/${name.stem}.pcm`;
}

/** Absolute path of a data-relative path. */
export function absolute(layout: RetentionLayout, relPath: string): string {
  return join(layout.dataDir, relPath);
}
