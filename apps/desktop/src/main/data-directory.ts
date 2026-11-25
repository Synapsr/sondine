import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_LAYOUT, MAX_SOCKET_PATH_BYTES } from "../shared/data-layout";
import type { GroupContainerAccess } from "./group-container";

export const TEAM_ID = "P5G8WAJ2G2";
export const APP_GROUP = `${TEAM_ID}.app.sondine`;

export type DataDirectoryKind = "group-container" | "app-data" | "override";

export interface DataDirectory {
  readonly path: string;
  readonly kind: DataDirectoryKind;
  /** Why this location was chosen; logged at startup. */
  readonly reason: string;
}

export interface DataDirectoryInput {
  readonly isPackaged: boolean;
  /** `app.getPath("appData")`, `~/Library/Application Support`. */
  readonly appDataDir: string;
  /** `SONDINE_DATA_DIR`; honoured by development builds only. */
  readonly override?: string | undefined;
  /** Packaged builds: the native addon that asks macOS for the container; null when missing. */
  readonly groupContainer?: GroupContainerAccess | null;
  /** Creates the directory if needed and reports whether a file can be written in it. */
  readonly usable?: (path: string) => boolean;
}

/**
 * Writes and removes a probe file: macOS protects group containers below
 * POSIX permissions, so only a real write tells.
 */
export function usableDirectory(path: string): boolean {
  const probe = join(path, `.sondine-write-probe-${process.pid}`);
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(probe, "", { flag: "wx", mode: 0o600 });
    rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where Sondine keeps its database, spool and sockets (ADR 013).
 *
 * - Builds signed by team P5G8WAJ2G2 carry the `P5G8WAJ2G2.app.sondine`
 *   application group and use its container (covered by macOS app data
 *   protection). Main asks macOS for it first: without that request macOS
 *   refuses the unsandboxed app, silently.
 * - Development builds run as Electron.app, which is not entitled to the
 *   group; touching another team's container could show a macOS prompt, so
 *   they never try and use `~/Library/Application Support/Sondine Dev`.
 * - Unsigned and ad-hoc packaged builds never touch the container either and
 *   fall back to `~/Library/Application Support/Sondine`, as does a signed
 *   build whose container is not writable. The packaged helper runs under App
 *   Sandbox (ADR 010) and reaches only the group container, so it cannot
 *   serve from that fallback.
 */
export function resolveDataDirectory(input: DataDirectoryInput): DataDirectory {
  const usable = input.usable ?? usableDirectory;
  if (!input.isPackaged && input.override !== undefined && input.override !== "") {
    return {
      path: input.override,
      kind: "override",
      reason: "SONDINE_DATA_DIR (development only)",
    };
  }
  if (!input.isPackaged) {
    return {
      path: join(input.appDataDir, "Sondine Dev"),
      kind: "app-data",
      reason: "development build: not entitled to the app group, so the container is never touched",
    };
  }
  const fallback = (why: string): DataDirectory => ({
    path: join(input.appDataDir, "Sondine"),
    kind: "app-data",
    reason: `${why}; a sandboxed helper cannot reach this directory`,
  });
  const access = input.groupContainer ?? null;
  if (access === null) return fallback("the group container addon is missing");
  const team = access.teamIdentifier();
  if (team !== TEAM_ID) {
    return fallback(
      `signed by ${team === null ? "no team (unsigned or ad-hoc)" : `team ${team}`}, so the ${APP_GROUP} container is not touched`,
    );
  }
  const container = access.groupContainerPath(APP_GROUP);
  if (container === null) return fallback(`macOS returned no container for ${APP_GROUP}`);
  if (!usable(container)) return fallback(`group container ${APP_GROUP} is not writable`);
  return { path: container, kind: "group-container", reason: `app group ${APP_GROUP}` };
}

/** Whether a sandboxed helper (packaged builds) can open its spool and socket here. */
export function sandboxedHelperCanReach(directory: DataDirectory): boolean {
  return directory.kind === "group-container";
}

/** Paths inside the data directory, with the socket length checked against macOS's limit. */
export function dataPaths(root: string) {
  const socket = join(root, DATA_LAYOUT.audioSocket);
  const socketBytes = Buffer.byteLength(socket);
  if (socketBytes > MAX_SOCKET_PATH_BYTES) {
    throw new RangeError(
      `helper socket path is ${socketBytes} bytes; macOS allows ${MAX_SOCKET_PATH_BYTES}`,
    );
  }
  return {
    root,
    runDir: join(root, DATA_LAYOUT.runDir),
    audioSocket: socket,
  };
}
