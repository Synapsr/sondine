import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CoreConfigShape } from "../src/core/config";
import type { CoreLayerOptions } from "../src/core/runtime";
import type { MainChannelService } from "../src/core/main-channel";
import type { CoreToMain } from "../src/shared/core-messages";
import { DATA_LAYOUT, MAX_SOCKET_PATH_BYTES } from "../src/shared/data-layout";

export const migrationsDir = resolve(import.meta.dirname, "../../../packages/db/drizzle");

export interface TempDataDir {
  readonly dir: string;
  readonly socketPath: string;
  config(overrides?: Partial<CoreConfigShape>): CoreConfigShape;
  cleanup(): void;
}

/** A data directory short enough for a Unix socket path (macOS: 103 bytes). */
export function tempDataDir(): TempDataDir {
  const dir = mkdtempSync(join(tmpdir(), "sondine-"));
  const socketPath = join(dir, DATA_LAYOUT.audioSocket);
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`socket path too long for this TMPDIR: ${socketPath}`);
  }
  return {
    dir,
    socketPath,
    config: (overrides = {}) => ({
      dataDir: dir,
      databasePath: join(dir, DATA_LAYOUT.database),
      migrationsDir,
      helperSocket: socketPath,
      spoolDir: DATA_LAYOUT.spoolDir,
      spansPath: join(dir, DATA_LAYOUT.spansFile),
      browserTracePath: join(dir, DATA_LAYOUT.browserTraceFile),
      appVersion: "0.0.0-test",
      macosVersion: "27.0.1",
      statsEndpoint: null,
      updates: { blocked: "development", testFeed: null },
      modelsDir: join(dir, "models"),
      speechBinary: null,
      textServer: null,
      voiceTool: null,
      agentSocket: join(dir, DATA_LAYOUT.agentSocket),
      agentRelay: null,
      browserSocket: join(dir, DATA_LAYOUT.browserSocket),
      browserRelay: null,
      browserExtension: null,
      nativeHostsDir: null,
      phoneSocket: join(dir, DATA_LAYOUT.phoneSocket),
      phoneRelay: null,
      voiceReadDir: null,
      ...overrides,
    }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Options every capture test shares: the install counts as onboarded (a
 * first run keeps a fresh install paused), and model files are looked for
 * in the temporary directory, never in the real home.
 */
export function captureOptions(data: TempDataDir) {
  return {
    onboarding: { skipFirstRun: true },
    models: { homeDir: data.dir },
    analysis: { dictationHome: null },
  } satisfies CoreLayerOptions;
}

export function recordingMain(): MainChannelService & { readonly posted: CoreToMain[] } {
  const posted: CoreToMain[] = [];
  return { posted, post: (message) => posted.push(message) };
}

export async function waitUntil<T>(
  probe: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  { timeoutMs = 5_000, label = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}
