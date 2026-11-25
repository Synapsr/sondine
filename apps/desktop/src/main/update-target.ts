import { accessSync, constants, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { UpdateBlock } from "@sondine/api";

// The app an update would replace (ADR 045), or why it may not. No Electron
// import, so it is unit-tested.

export const UPDATE_APP_NAME = "Sondine.app";

export interface UpdateTargetInput {
  readonly isPackaged: boolean;
  /** `process.resourcesPath`: `…/Sondine.app/Contents/Resources`. */
  readonly resourcesPath: string;
  /** `release:mac` built this app, or a test build with its own feed. */
  readonly released: boolean;
  /** The team that signed this process; null when unsigned or ad-hoc signed. */
  readonly team: string | null;
  readonly expectedTeam: string;
  /** Where the update is unpacked: the same volume, or the two cannot be exchanged. */
  readonly dataDirectory: string;
  readonly writable?: (path: string) => boolean;
  readonly volume?: (path: string) => number | null;
}

export type UpdateTarget =
  | { readonly app: string; readonly blocked: null }
  | { readonly app: null; readonly blocked: UpdateBlock };

const mayWrite = (path: string) => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const volumeOf = (path: string) => {
  try {
    return statSync(path).dev;
  } catch {
    return null;
  }
};

export function updateTarget(input: UpdateTargetInput): UpdateTarget {
  const blocked = (reason: UpdateBlock): UpdateTarget => ({ app: null, blocked: reason });
  if (!input.isPackaged) return blocked("development");
  if (!input.released || input.team !== input.expectedTeam) return blocked("unreleased");
  const app = resolve(input.resourcesPath, "../..");
  // macOS runs an app just downloaded from a moved, read-only copy.
  if (app.includes("/AppTranslocation/")) return blocked("move");
  // « Sondine Exp.app », a renamed copy: its owner replaces it.
  if (basename(app) !== UPDATE_APP_NAME) return blocked("test-copy");
  const writable = input.writable ?? mayWrite;
  const volume = input.volume ?? volumeOf;
  const here = volume(app);
  if (!writable(dirname(app)) || !writable(app) || here === null) return blocked("move");
  if (here !== volume(input.dataDirectory)) return blocked("move");
  return { app, blocked: null };
}
