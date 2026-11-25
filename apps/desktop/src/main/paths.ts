import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { app } from "electron";

// Where main finds the pieces it launches. Development runs from
// apps/desktop (app.getAppPath()); a packaged app is laid out by
// electron-builder.yml:
//
//   Sondine.app/Contents/Helpers/sondine-audio       extraFiles (signed with its own entitlements)
//   Sondine.app/Contents/Helpers/Sondine Speech.app  extraFiles (speech.cpp, sandboxed, its own signature)
//   Sondine.app/Contents/Helpers/Sondine Text.app    extraFiles (llama.cpp's server for the journal, sandboxed)
//   Sondine.app/Contents/Helpers/Sondine Voice.app   extraFiles (sondine-voice and its model, sandboxed)
//   Sondine.app/Contents/Helpers/Sondine Notch.app   extraFiles (sondine-notch, call context beside the notch, sandboxed)
//   Sondine.app/Contents/Helpers/sondine-mcp         extraFiles (agents' relay, sandboxed, its own signature)
//   Sondine.app/Contents/Helpers/sondine-browser     extraFiles (browsers' native host, sandboxed, its own signature)
//   Sondine.app/Contents/Helpers/sondine-lan         extraFiles (paired phones' relay, sandboxed, its own signature)
//   Sondine.app/Contents/Resources/browser-extension extraResources (the unpacked extension)
//   Sondine.app/Contents/Resources/drizzle/          extraResources (migrations)
//   Sondine.app/Contents/Resources/models/           extraResources (bundled VAD model)
//   Sondine.app/Contents/Resources/app.asar          out/{main,preload,renderer} and resources/tray

export function helperExecutable(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "..", "Helpers", "sondine-audio")
    : resolve(app.getAppPath(), "../../native/.build/release/sondine-audio");
}

const SPEECH_APP = "Sondine Speech.app";

/**
 * The speech.cpp worker executable (ADR 016). Packaged: the sandboxed
 * `Sondine Speech.app` that scripts/build-mac.mjs staged and signed.
 * Development: `SONDINE_SPEECH_BINARY` when set, else the app staged by the
 * last `pnpm build:mac` (build/stage), else none and analysis waits.
 */
export function speechExecutable(): string | null {
  if (app.isPackaged) {
    return join(process.resourcesPath, "..", "Helpers", SPEECH_APP, "Contents", "MacOS", "speech");
  }
  const override = process.env.SONDINE_SPEECH_BINARY;
  if (override !== undefined && override !== "") return override;
  const staged = join(
    app.getAppPath(),
    "build",
    "stage",
    SPEECH_APP,
    "Contents",
    "MacOS",
    "speech",
  );
  return existsSync(staged) ? staged : null;
}

const TEXT_APP = "Sondine Text.app";
/** Its bundle id: the sandbox gives it `~/Library/Containers/<id>/Data/tmp` for its socket. */
const TEXT_BUNDLE_ID = "app.sondine.text";

/**
 * llama.cpp's server for the daily journal (ADR 028) and the Unix socket it
 * listens on. Packaged: the sandboxed `Sondine Text.app`, its socket in its
 * own container's temporary folder, the one place it may write. Development:
 * `SONDINE_TEXT_SERVER`, else the app staged by the last `pnpm build:mac`,
 * its socket in the user's temporary folder.
 */
export function textServer(home: string): { binary: string; socket: string } | null {
  if (app.isPackaged) {
    return {
      binary: join(
        process.resourcesPath,
        "..",
        "Helpers",
        TEXT_APP,
        "Contents",
        "MacOS",
        "llama-server",
      ),
      socket: join(
        home,
        "Library",
        "Containers",
        TEXT_BUNDLE_ID,
        "Data",
        "tmp",
        "sondine-text.sock",
      ),
    };
  }
  const override = process.env.SONDINE_TEXT_SERVER;
  const staged = join(
    app.getAppPath(),
    "build",
    "stage",
    TEXT_APP,
    "Contents",
    "MacOS",
    "llama-server",
  );
  const binary =
    override !== undefined && override !== "" ? override : existsSync(staged) ? staged : null;
  return binary === null ? null : { binary, socket: join(tmpdir(), "sondine-text-dev.sock") };
}

const VOICE_APP = "Sondine Voice.app";

/**
 * sondine-voice and its WeSpeaker model (architecture §8). Packaged: the
 * sandboxed `Sondine Voice.app`. Development: native/'s release build and
 * native/.models (scripts/fetch-models.sh), when both are there.
 */
export function voiceTool(): { binary: string; model: string } | null {
  if (app.isPackaged) {
    const bundle = join(process.resourcesPath, "..", "Helpers", VOICE_APP, "Contents");
    return {
      binary: join(bundle, "MacOS", "sondine-voice"),
      model: join(bundle, "Resources", "wespeaker_v2.mlmodelc"),
    };
  }
  const native = resolve(app.getAppPath(), "../../native");
  const binary = join(native, ".build", "release", "sondine-voice");
  const model = join(native, ".models", "wespeaker", "wespeaker_v2.mlmodelc");
  return existsSync(binary) && existsSync(model) ? { binary, model } : null;
}

const NOTCH_APP = "Sondine Notch.app";

/**
 * sondine-notch, call context beside the notch (ADR 025). Packaged: the
 * sandboxed `Sondine Notch.app`. Development: native/'s release build, when
 * it is there; without it the menu bar alone shows the call.
 */
export function notchTool(): string | null {
  if (app.isPackaged) {
    return join(
      process.resourcesPath,
      "..",
      "Helpers",
      NOTCH_APP,
      "Contents",
      "MacOS",
      "sondine-notch",
    );
  }
  const binary = resolve(app.getAppPath(), "../../native/.build/release/sondine-notch");
  return existsSync(binary) ? binary : null;
}

/**
 * sondine-mcp, the relay agents start (ADR 011). Packaged: the signed relay,
 * which reaches only the group container, so none when the data lives
 * elsewhere. Development: native/'s debug build, given the socket path.
 */
export function agentRelay(
  dataInGroupContainer: boolean,
): { path: string; socketArgument: boolean } | null {
  if (app.isPackaged) {
    if (!dataInGroupContainer) return null;
    return {
      path: join(process.resourcesPath, "..", "Helpers", "sondine-mcp"),
      socketArgument: false,
    };
  }
  const debug = resolve(app.getAppPath(), "../../native/.build/debug/sondine-mcp");
  return existsSync(debug) ? { path: debug, socketArgument: true } : null;
}

/**
 * sondine-browser, the native messaging host browsers start for Sondine's
 * extension (ADR 023). Packaged: the signed relay, which reaches only the
 * group container. Development: native/'s debug build, given the socket by a
 * wrapper script core writes.
 */
export function browserRelay(
  dataInGroupContainer: boolean,
): { path: string; socketArgument: boolean } | null {
  if (app.isPackaged) {
    if (!dataInGroupContainer) return null;
    return {
      path: join(process.resourcesPath, "..", "Helpers", "sondine-browser"),
      socketArgument: false,
    };
  }
  const debug = resolve(app.getAppPath(), "../../native/.build/debug/sondine-browser");
  return existsSync(debug) ? { path: debug, socketArgument: true } : null;
}

/**
 * sondine-lan, the relay paired phones reach (ADR 008), which core starts.
 * Packaged: the signed relay, which reaches only the group container, so
 * none when the data lives elsewhere. Development: native/'s debug build,
 * which also accepts loopback peers.
 */
export function phoneRelay(
  dataInGroupContainer: boolean,
): { path: string; loopback: boolean } | null {
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, "..", "Helpers", "sondine-lan");
    return dataInGroupContainer && existsSync(packaged)
      ? { path: packaged, loopback: false }
      : null;
  }
  const debug = resolve(app.getAppPath(), "../../native/.build/debug/sondine-lan");
  return existsSync(debug) ? { path: debug, loopback: true } : null;
}

/** The unpacked browser extension this build carries (ADR 023). */
export function browserExtension(): string | null {
  const folder = app.isPackaged
    ? join(process.resourcesPath, "browser-extension")
    : resolve(app.getAppPath(), "../browser-extension/dist/chrome-mv3");
  return existsSync(join(folder, "manifest.json")) ? folder : null;
}

/**
 * The Silero model bundled with a packaged app. The sandboxed helper cannot read
 * the bundle, so main copies it to the models folder (models-directory.ts);
 * development lets the helper find native/.models.
 */
export function bundledVadModel(): string | null {
  if (!app.isPackaged) return null;
  const model = join(process.resourcesPath, "models", "silero-vad", "silero_vad.onnx");
  return existsSync(model) ? model : null;
}

/** The protocol fake that `electron-vite dev` builds next to main (SONDINE_FAKE_HELPER=1). */
export function fakeHelperScript(): string | null {
  if (app.isPackaged) return null;
  const script = join(import.meta.dirname, "fake-helper.js");
  return existsSync(script) ? script : null;
}

export function migrationsDirectory(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "drizzle")
    : resolve(app.getAppPath(), "../../packages/db/drizzle");
}

export function trayIconDirectory(): string {
  return join(app.getAppPath(), "resources", "tray");
}

/** out/renderer, next to out/main. */
export function rendererDirectory(): string {
  return join(import.meta.dirname, "..", "renderer");
}

export function preloadScript(): string {
  return join(import.meta.dirname, "..", "preload", "index.cjs");
}
