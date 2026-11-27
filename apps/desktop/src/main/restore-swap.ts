import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DATA_LAYOUT } from "../shared/data-layout";
import { RESTORED_ITEMS, RestoreMarker } from "../shared/restore-marker";

// The swap of a staged restore (ADR 048). Core unpacks and checks a backup in
// `restore-staging/`, then writes its marker; at the next launch, before the
// helper or core starts, main moves the current data aside, in
// `before-restore/<stamp>/`, and the staging in its place. Renames on one
// volume: nothing is copied, and a crash in the middle finishes at the next
// launch, the marker saying which half was under way.

const MARKER_NAME = "READY.json";

function writeMarker(root: string, marker: RestoreMarker): void {
  const path = join(root, DATA_LAYOUT.restoreMarker);
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(marker), { mode: 0o600 });
  renameSync(temp, path);
}

function readMarker(root: string): RestoreMarker | null {
  const path = join(root, DATA_LAYOUT.restoreMarker);
  if (!existsSync(path)) return null;
  try {
    const parsed = RestoreMarker.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type SwapOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "swapped"; readonly stamp: string; readonly moved: number }
  /** A staging without a valid marker: core stopped before it was complete. It is removed. */
  | { readonly kind: "discarded" };

/**
 * Applies a staged restore under `root`, the data directory. Call it before
 * anything opens the database or the spool.
 */
export function applyStagedRestore(root: string): SwapOutcome {
  const staging = join(root, DATA_LAYOUT.restoreStagingDir);
  if (!existsSync(staging)) return { kind: "none" };
  const marker = readMarker(root);
  if (marker === null) {
    rmSync(staging, { recursive: true, force: true });
    return { kind: "discarded" };
  }
  const aside = join(root, DATA_LAYOUT.beforeRestoreDir, marker.stamp);
  let moved = 0;
  if (marker.phase === "staged" || marker.phase === "out") {
    writeMarker(root, { stamp: marker.stamp, phase: "out" });
    mkdirSync(aside, { recursive: true, mode: 0o700 });
    for (const item of RESTORED_ITEMS) {
      const from = join(root, item);
      if (!existsSync(from)) continue;
      renameSync(from, join(aside, item));
      moved += 1;
    }
  }
  writeMarker(root, { stamp: marker.stamp, phase: "in" });
  for (const name of readdirSync(staging)) {
    if (name === MARKER_NAME || name === `${MARKER_NAME}.tmp`) continue;
    // Only what a restore replaces moves in; anything else stays behind and goes.
    if (!(RESTORED_ITEMS as readonly string[]).includes(name)) continue;
    renameSync(join(staging, name), join(root, name));
    moved += 1;
  }
  rmSync(staging, { recursive: true, force: true });
  return { kind: "swapped", stamp: marker.stamp, moved };
}
