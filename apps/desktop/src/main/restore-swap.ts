import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_LAYOUT } from "../shared/data-layout";
import { RESTORED_ITEMS, RestoreMarker } from "../shared/restore-marker";

// The swap of a staged restore (ADR 048). Core unpacks and checks a backup in
// `restore-staging/`, then writes its marker; at the next launch, before the
// helper or core starts, main moves the current data aside, in
// `before-restore/<stamp>/`, and the staging in its place. Renames on one
// volume: nothing is copied, and a crash in the middle finishes at the next
// launch, the marker saying which half was under way.

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
  /** A staging core never marked: it stopped before the restore was complete. It is removed. */
  | { readonly kind: "discarded" };

/**
 * A state the swap cannot settle by itself. Nothing more moves: main stops
 * before the helper or core start, so no new data mixes in, and the folders
 * stay as they are for a person to look at.
 */
export class RestoreSwapError extends Error {
  override readonly name = "RestoreSwapError";
}

/**
 * Applies a staged restore under `root`, the data directory. Call it before
 * anything opens the database or the spool; when it throws, start nothing.
 */
export function applyStagedRestore(root: string): SwapOutcome {
  const staging = join(root, DATA_LAYOUT.restoreStagingDir);
  if (!existsSync(staging)) return { kind: "none" };
  const markerPath = join(root, DATA_LAYOUT.restoreMarker);
  // Core writes the marker last and moves nothing: without it, nothing moved.
  if (!existsSync(markerPath)) {
    rmSync(staging, { recursive: true, force: true });
    return { kind: "discarded" };
  }
  const marker = readMarker(root);
  if (marker === null) throw new RestoreSwapError("the restore's marker is unreadable");
  const aside = join(root, DATA_LAYOUT.beforeRestoreDir, marker.stamp);
  const update = (phase: RestoreMarker["phase"]) => writeMarker(root, { ...marker, phase });
  let moved = 0;
  if (marker.phase === "staged" || marker.phase === "out") {
    for (const item of marker.items) {
      if (!existsSync(join(staging, item))) {
        throw new RestoreSwapError(`${item} is missing from the staging before anything moved in`);
      }
    }
    update("out");
    mkdirSync(aside, { recursive: true, mode: 0o700 });
    for (const item of RESTORED_ITEMS) {
      const from = join(root, item);
      if (!existsSync(from)) continue;
      // Never over what an earlier attempt set aside.
      if (existsSync(join(aside, item))) {
        throw new RestoreSwapError(`${item} is already set aside; it is not replaced`);
      }
      renameSync(from, join(aside, item));
      moved += 1;
    }
  }
  update("in");
  for (const item of marker.items) {
    const from = join(staging, item);
    const to = join(root, item);
    if (!existsSync(from)) {
      // Moved in by the attempt a crash stopped.
      if (existsSync(to)) continue;
      throw new RestoreSwapError(`${item} is neither staged nor in place`);
    }
    // The data it would replace was not set aside: stop rather than lose it.
    if (existsSync(to)) throw new RestoreSwapError(`${item} is still in place; it is not replaced`);
    renameSync(from, to);
    moved += 1;
  }
  rmSync(staging, { recursive: true, force: true });
  return { kind: "swapped", stamp: marker.stamp, moved };
}
