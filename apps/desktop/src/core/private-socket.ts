import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { MAX_SOCKET_PATH_BYTES } from "../shared/data-layout";
import { log } from "./log";

// A unix socket only this user can reach: 0600, in the 0700 run directory,
// both checked as this user's (ADR 011). The agents' MCP socket and the
// browser link's socket (ADR 023) listen this way.

/** True when another process already serves this socket. */
function live(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

/**
 * Listens on `socketPath`, or logs why not (`<event>.…`) and returns null:
 * a path too long, a run directory not this user's, a path taken by
 * something else, or a socket another process serves. A stale socket is
 * replaced.
 */
export async function listenPrivate(
  socketPath: string,
  event: string,
  onSocket: (socket: Socket, server: Server) => void,
): Promise<Server | null> {
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    log.error(`${event}.socket-path-too-long`, { bytes: Buffer.byteLength(socketPath) });
    return null;
  }
  const runDir = dirname(socketPath);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);
  const uid = process.getuid?.();
  if (uid !== undefined && lstatSync(runDir).uid !== uid) {
    log.error(`${event}.run-dir-not-ours`, {});
    return null;
  }
  const existing = lstatSync(socketPath, { throwIfNoEntry: false });
  if (existing !== undefined) {
    if (!existing.isSocket()) {
      log.error(`${event}.socket-path-taken`, {});
      return null;
    }
    if (await live(socketPath)) {
      log.error(`${event}.socket-in-use`, {});
      return null;
    }
    unlinkSync(socketPath);
  }
  const server: Server = createServer((socket) => onSocket(socket, server));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(socketPath, 0o600);
  server.on("error", (error) => log.warn(`${event}.server-error`, { message: error.message }));
  return server;
}

/** Stops listening and removes the socket file. */
export async function closePrivate(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    unlinkSync(socketPath);
  } catch {
    // Already gone.
  }
}
