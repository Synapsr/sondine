// Builds a signed Sondine.app and DMG (ADR 010):
//   1. builds sondine-audio (swift build -c release in native/),
//   2. stages it with the bundled VAD model in build/stage/ and signs it with
//      its own entitlements and hardened runtime,
//   3. stages speech.cpp's worker as build/stage/Sondine Speech.app from the
//      pinned release archive (downloaded once into ~/Library/Caches, checked
//      by sha256) with its licenses, and signs it with its own entitlements
//      (ADR 016),
//   3a. stages llama.cpp's server as build/stage/Sondine Text.app from the
//      pinned release archive (checked by sha256, then every staged file by
//      its own) with its license, signs each library and the app with its
//      own entitlements (ADR 028),
//   3b. stages sondine-voice as build/stage/Sondine Voice.app with the WeSpeaker
//      model (native/scripts/fetch-models.sh, checked by sha256) and its
//      notices, and signs it with its own entitlements (architecture §8),
//   3b'. stages sondine-notch as build/stage/Sondine Notch.app, the call
//      context beside the notch (ADR 025), and signs it with App Sandbox only,
//   3c. builds sondine-mcp, the relay agents start (ADR 011), and
//      sondine-browser, the native messaging host browsers start for
//      Sondine's extension (ADR 023), and signs each with its own
//      entitlements (App Sandbox and the app group), and sondine-lan, the
//      relay for paired iPhones (ADR 008: the same, plus network.server),
//   4. compiles the group container addon (native/group-container.m), the
//      notification settings addon (native/notification-settings.m), the
//      updates addon (native/update.m) and the haptic addon (native/haptic.m) into
//      build/stage/native/,
//   5. builds the app (electron-vite) and the browser extension
//      (apps/browser-extension/dist/chrome-mv3, shipped unpacked for the user to load),
//      and packages them with the Electron the install fetched
//      (electron-builder signs everything else and sets the fuses; no
//      download, so a GitHub outage does not stop a build),
//   6. checks the result (scripts/check-package.mjs),
//   7. with `--release` (`pnpm release:mac`), notarizes: electron-builder
//      notarizes and staples the app, the files an installed Sondine updates
//      from are written and read back (update-files.mjs), then the DMG is
//      notarized and stapled, and Gatekeeper must accept both. A test build
//      (`SONDINE_UPDATE_FEED`, this Mac's own server) has those files too.
// Development builds carry no secure timestamp: only notarization needs one,
// and it costs one request to Apple per signed file, so only `--release`
// signs with it. Notarization reads an App Store Connect API key:
// APPLE_API_KEY_ID, APPLE_API_ISSUER, and the key itself, APPLE_API_KEY_P8
// (the .p8 in base64, as Infisical `sondine-next` /desktop holds it; written
// to a private temporary file for the run) or APPLE_API_KEY (a .p8 path).
// Contributors without the Developer ID certificate run
// `SONDINE_SIGN_IDENTITY=- pnpm build:mac` for an ad-hoc build.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { LLAMA_CPP_RUNTIME } from "../../../packages/engines/src/llama-cpp/runtime.ts";
import { SPEECH_CPP_RUNTIME } from "../../../packages/engines/src/speech-cpp/runtime.ts";
import { WESPEAKER_MODEL } from "../../../packages/engines/src/voice/wespeaker.ts";
import { TEST_UPDATE_FEED } from "../src/shared/updates.ts";
import { signingIdentity, utf8TextEncoding } from "./signing.mjs";
import { checkUpdateFiles, writeUpdateFiles } from "./update-files.mjs";

const app = fileURLToPath(new URL("..", import.meta.url));
const native = fileURLToPath(new URL("../../../native/", import.meta.url));
// The unpacked extension, which electron-builder copies to Resources/browser-extension.
const extensionDist = fileURLToPath(
  new URL("../../browser-extension/dist/chrome-mv3/", import.meta.url),
);
const stage = `${app}build/stage/`;
const speechApp = `${stage}Sondine Speech.app`;
const textApp = `${stage}Sondine Text.app`;
const voiceApp = `${stage}Sondine Voice.app`;
const notchApp = `${stage}Sondine Notch.app`;
// Downloads stay outside the repository.
const cache =
  process.env.SONDINE_BUILD_CACHE ?? join(homedir(), "Library", "Caches", "Sondine", "build");

const run = (command, args, cwd = app) => {
  console.log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      __CF_USER_TEXT_ENCODING: utf8TextEncoding,
    },
  });
};

const identity = signingIdentity();
if (identity === null) {
  console.error(
    `No "${process.env.SONDINE_SIGN_IDENTITY ?? "Developer ID Application"}" certificate in the keychain. Set SONDINE_SIGN_IDENTITY=- for an ad-hoc build.`,
  );
  process.exit(1);
}
const { adHoc } = identity;

const release = process.argv.includes("--release");

/** The .p8 to give notarytool: Infisical's base64 copy in a private file, or a path (~ allowed). */
function notaryKeyPath() {
  const inline = process.env.APPLE_API_KEY_P8 ?? "";
  if (inline === "") return (process.env.APPLE_API_KEY ?? "").replace(/^~(?=\/)/, homedir());
  const dir = mkdtempSync(join(tmpdir(), "sondine-notary-"));
  const file = join(dir, "AuthKey.p8");
  writeFileSync(file, Buffer.from(inline, "base64"), { mode: 0o600 });
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return file;
}

const notaryKey = release
  ? {
      path: notaryKeyPath(),
      id: process.env.APPLE_API_KEY_ID ?? "",
      issuer: process.env.APPLE_API_ISSUER ?? "",
    }
  : null;
if (
  release &&
  (adHoc ||
    notaryKey === null ||
    !existsSync(notaryKey.path) ||
    notaryKey.id === "" ||
    notaryKey.issuer === "")
) {
  console.error(
    "A release needs the Developer ID certificate and an App Store Connect API key: APPLE_API_KEY_ID, APPLE_API_ISSUER, and APPLE_API_KEY_P8 (base64) or APPLE_API_KEY (a .p8 path). `pnpm release:mac` loads them from Infisical.",
  );
  process.exit(1);
}
// The anonymous statistics' endpoint (ADR 042) is compiled into releases, and
// into nothing else: a missing one would be silence, not an error.
delete process.env.SONDINE_RELEASE;
if (!release) delete process.env.SONDINE_STATS_ENDPOINT;
else if (!/^https:\/\/[a-z0-9.-]+\/v1\/report$/u.test(process.env.SONDINE_STATS_ENDPOINT ?? "")) {
  console.error(
    "A release needs SONDINE_STATS_ENDPOINT, the statistics' Worker (apps/stats): https://stats.sondine.app/v1/report. `pnpm release:mac` sets it.",
  );
  process.exit(1);
} else process.env.SONDINE_RELEASE = "1";
// A test build's own update feed (ADR 045), on this Mac only: never a release's.
const testFeed = release ? "" : (process.env.SONDINE_UPDATE_FEED ?? "");
if (testFeed !== "" && !TEST_UPDATE_FEED.test(testFeed)) {
  console.error("SONDINE_UPDATE_FEED must be http://127.0.0.1:<port>/sondine-mac.json.");
  process.exit(1);
}
process.env.SONDINE_UPDATE_FEED = testFeed;
// electron-builder reads the key from the environment too: the expanded path.
if (notaryKey !== null) process.env.APPLE_API_KEY = notaryKey.path;
const timestamp = release ? "--timestamp" : "--timestamp=none";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The pinned speech.cpp archive, from the cache or downloaded once and checked. */
async function speechArchive() {
  const { archive } = SPEECH_CPP_RUNTIME;
  const path = join(cache, "speech.cpp", basename(new URL(archive.url).pathname));
  if (existsSync(path) && sha256(readFileSync(path)) === archive.sha256) return path;
  mkdirSync(dirname(path), { recursive: true });
  console.log(`downloading ${archive.url}`);
  const response = await fetch(archive.url);
  if (!response.ok || response.body === null) {
    throw new Error(`${archive.url}: HTTP ${response.status}`);
  }
  const partial = `${path}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const bytes = readFileSync(partial);
  if (bytes.byteLength !== archive.sizeBytes || sha256(bytes) !== archive.sha256) {
    rmSync(partial, { force: true });
    throw new Error(`${archive.url} does not match its pinned size and sha256`);
  }
  renameSync(partial, path);
  return path;
}

const speechInfoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleIdentifier</key>
    <string>app.sondine.speech</string>
    <key>CFBundleName</key>
    <string>Sondine Speech</string>
    <key>CFBundleExecutable</key>
    <string>speech</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleShortVersionString</key>
    <string>${SPEECH_CPP_RUNTIME.version}</string>
    <key>CFBundleVersion</key>
    <string>${SPEECH_CPP_RUNTIME.version}</string>
    <key>LSMinimumSystemVersion</key>
    <string>27.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHumanReadableCopyright</key>
    <string>speech.cpp ${SPEECH_CPP_RUNTIME.version}, ${SPEECH_CPP_RUNTIME.license} License (Resources/LICENSE.txt)</string>
  </dict>
</plist>
`;

/**
 * Sondine Speech.app: App Sandbox refuses a bare command-line tool (no bundle
 * identity), so speech.cpp's executable runs as the main executable of a
 * minimal app bundle, with its MIT license and third-party notices.
 */
async function stageSpeechApp() {
  const archive = await speechArchive();
  const executable = execFileSync("unzip", ["-p", archive, SPEECH_CPP_RUNTIME.executable.name], {
    maxBuffer: 256 * 1024 * 1024,
  });
  if (sha256(executable) !== SPEECH_CPP_RUNTIME.executable.sha256) {
    throw new Error(`${SPEECH_CPP_RUNTIME.executable.name} in ${archive} is not the pinned one`);
  }
  mkdirSync(`${speechApp}/Contents/MacOS`, { recursive: true });
  writeFileSync(`${speechApp}/Contents/MacOS/speech`, executable);
  chmodSync(`${speechApp}/Contents/MacOS/speech`, 0o755);
  writeFileSync(`${speechApp}/Contents/Info.plist`, speechInfoPlist);
  for (const notice of SPEECH_CPP_RUNTIME.notices) {
    const from = `${app}build/speech/${notice.file}`;
    if (sha256(readFileSync(from)) !== notice.sha256) {
      throw new Error(`${from} differs from ${notice.source}`);
    }
    const to = `${speechApp}/Contents/Resources/${notice.file}`;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

/** The pinned llama.cpp archive, from the cache or downloaded once and checked. */
async function llamaArchive() {
  const { archive } = LLAMA_CPP_RUNTIME;
  const path = join(cache, "llama.cpp", basename(new URL(archive.url).pathname));
  if (existsSync(path) && sha256(readFileSync(path)) === archive.sha256) return path;
  mkdirSync(dirname(path), { recursive: true });
  console.log(`downloading ${archive.url}`);
  const response = await fetch(archive.url);
  if (!response.ok || response.body === null) {
    throw new Error(`${archive.url}: HTTP ${response.status}`);
  }
  const partial = `${path}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const bytes = readFileSync(partial);
  if (bytes.byteLength !== archive.sizeBytes || sha256(bytes) !== archive.sha256) {
    rmSync(partial, { force: true });
    throw new Error(`${archive.url} does not match its pinned size and sha256`);
  }
  renameSync(partial, path);
  return path;
}

const textInfoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleIdentifier</key>
    <string>app.sondine.text</string>
    <key>CFBundleName</key>
    <string>Sondine Text</string>
    <key>CFBundleExecutable</key>
    <string>llama-server</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleShortVersionString</key>
    <string>${LLAMA_CPP_RUNTIME.version}</string>
    <key>CFBundleVersion</key>
    <string>${LLAMA_CPP_RUNTIME.version.replace(/^b/, "")}</string>
    <key>LSMinimumSystemVersion</key>
    <string>27.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHumanReadableCopyright</key>
    <string>llama.cpp ${LLAMA_CPP_RUNTIME.version}, ${LLAMA_CPP_RUNTIME.license} License (Resources/LICENSE.txt)</string>
  </dict>
</plist>
`;

/**
 * Sondine Text.app: llama.cpp's server as the main executable of a minimal
 * app bundle (App Sandbox needs a bundle identity), the libraries it loads
 * from its own folder (`@loader_path`) beside it under the names it asks
 * for, each checked against its pinned sha256, and the MIT license.
 */
async function stageTextApp() {
  const archive = await llamaArchive();
  const unpacked = mkdtempSync(join(tmpdir(), "sondine-llama-"));
  try {
    const { root } = LLAMA_CPP_RUNTIME.archive;
    const targets = [
      ...new Set([
        ...LLAMA_CPP_RUNTIME.files.map((file) => `${root}/${file.target}`),
        `${root}/${LLAMA_CPP_RUNTIME.notice.file}`,
      ]),
    ];
    execFileSync("tar", ["-xzf", archive, "-C", unpacked, ...targets]);
    rmSync(textApp, { recursive: true, force: true });
    mkdirSync(`${textApp}/Contents/MacOS`, { recursive: true });
    for (const file of LLAMA_CPP_RUNTIME.files) {
      const bytes = readFileSync(join(unpacked, root, file.target));
      if (sha256(bytes) !== file.sha256) {
        throw new Error(`${file.target} in ${archive} is not the pinned one`);
      }
      const to = `${textApp}/Contents/MacOS/${file.name}`;
      writeFileSync(to, bytes);
      chmodSync(to, 0o755);
    }
    writeFileSync(`${textApp}/Contents/Info.plist`, textInfoPlist);
    const license = readFileSync(join(unpacked, root, LLAMA_CPP_RUNTIME.notice.file));
    if (sha256(license) !== LLAMA_CPP_RUNTIME.notice.sha256) {
      throw new Error(`the LICENSE in ${archive} is not the pinned one`);
    }
    mkdirSync(`${textApp}/Contents/Resources`, { recursive: true });
    writeFileSync(`${textApp}/Contents/Resources/LICENSE.txt`, license);
  } finally {
    rmSync(unpacked, { recursive: true, force: true });
  }
}

const voiceInfoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleIdentifier</key>
    <string>app.sondine.voice</string>
    <key>CFBundleName</key>
    <string>Sondine Voice</string>
    <key>CFBundleExecutable</key>
    <string>sondine-voice</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>27.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHumanReadableCopyright</key>
    <string>WeSpeaker speaker embedding, ${WESPEAKER_MODEL.license} (Resources/NOTICE.md)</string>
  </dict>
</plist>
`;

/**
 * Sondine Voice.app: sondine-voice as the main executable of a minimal app
 * bundle (App Sandbox needs a bundle identity), with the WeSpeaker model and
 * its license and attribution in Resources.
 */
function stageVoiceApp() {
  const models = `${native}.models/wespeaker/`;
  mkdirSync(`${voiceApp}/Contents/MacOS`, { recursive: true });
  copyFileSync(`${native}.build/release/sondine-voice`, `${voiceApp}/Contents/MacOS/sondine-voice`);
  writeFileSync(`${voiceApp}/Contents/Info.plist`, voiceInfoPlist);
  const resources = `${voiceApp}/Contents/Resources/`;
  for (const file of WESPEAKER_MODEL.files) {
    const from = `${models}${WESPEAKER_MODEL.name}/${file.path}`;
    if (!existsSync(from) || sha256(readFileSync(from)) !== file.sha256) {
      throw new Error(
        `${from} is missing or not the pinned file: run native/scripts/fetch-models.sh`,
      );
    }
    const to = `${resources}${WESPEAKER_MODEL.name}/${file.path}`;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  for (const notice of WESPEAKER_MODEL.notices) {
    const from = `${models}${notice.file}`;
    if ("sha256" in notice && sha256(readFileSync(from)) !== notice.sha256) {
      throw new Error(`${from} is not the pinned ${notice.file}`);
    }
    copyFileSync(from, `${resources}${notice.file}`);
  }
}

const notchInfoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleIdentifier</key>
    <string>app.sondine.notch</string>
    <key>CFBundleName</key>
    <string>Sondine Notch</string>
    <key>CFBundleExecutable</key>
    <string>sondine-notch</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>27.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSQuitAlwaysKeepsWindows</key>
    <false/>
  </dict>
</plist>
`;

/** Sondine Notch.app: sondine-notch as the main executable of a minimal app bundle. */
function stageNotchApp() {
  mkdirSync(`${notchApp}/Contents/MacOS`, { recursive: true });
  copyFileSync(`${native}.build/release/sondine-notch`, `${notchApp}/Contents/MacOS/sondine-notch`);
  writeFileSync(`${notchApp}/Contents/Info.plist`, notchInfoPlist);
}

run("swift", ["build", "-c", "release", "--product", "sondine-audio"], native);
run("swift", ["build", "-c", "release", "--product", "sondine-voice"], native);
run("swift", ["build", "-c", "release", "--product", "sondine-notch"], native);
run("swift", ["build", "-c", "release", "--product", "sondine-mcp"], native);
run("swift", ["build", "-c", "release", "--product", "sondine-browser"], native);
run("swift", ["build", "-c", "release", "--product", "sondine-lan"], native);

rmSync(stage, { recursive: true, force: true });
mkdirSync(`${stage}models/silero-vad`, { recursive: true });
copyFileSync(`${native}.build/release/sondine-audio`, `${stage}sondine-audio`);
copyFileSync(`${native}.build/release/sondine-mcp`, `${stage}sondine-mcp`);
copyFileSync(`${native}.build/release/sondine-browser`, `${stage}sondine-browser`);
copyFileSync(`${native}.build/release/sondine-lan`, `${stage}sondine-lan`);
const model = `${native}.models/silero-vad/silero_vad.onnx`;
if (existsSync(model)) {
  copyFileSync(model, `${stage}models/silero-vad/silero_vad.onnx`);
  // MIT asks for its notice next to the model (NOTICE); fetch-models.sh puts it there.
  copyFileSync(`${native}.models/silero-vad/LICENSE`, `${stage}models/silero-vad/LICENSE`);
} else {
  console.warn(
    `warning: ${model} is missing (native/scripts/fetch-models.sh); the app ships without a VAD model.`,
  );
  writeFileSync(
    `${stage}models/README.txt`,
    "Bundled models go here (native/scripts/fetch-models.sh).\n",
  );
}

run("codesign", [
  "--force",
  "--options",
  "runtime",
  timestamp,
  "--identifier",
  "app.sondine.audio",
  "--entitlements",
  "build/entitlements.helper.plist",
  "--sign",
  identity.sign,
  `${stage}sondine-audio`,
]);

run("codesign", [
  "--force",
  "--options",
  "runtime",
  timestamp,
  "--identifier",
  "app.sondine.mcp",
  "--entitlements",
  "build/entitlements.mcp.plist",
  "--sign",
  identity.sign,
  `${stage}sondine-mcp`,
]);

run("codesign", [
  "--force",
  "--options",
  "runtime",
  timestamp,
  "--identifier",
  "app.sondine.browser",
  "--entitlements",
  "build/entitlements.browser.plist",
  "--sign",
  identity.sign,
  `${stage}sondine-browser`,
]);

run("codesign", [
  "--force",
  "--options",
  "runtime",
  timestamp,
  "--identifier",
  "app.sondine.lan",
  "--entitlements",
  "build/entitlements.lan.plist",
  "--sign",
  identity.sign,
  `${stage}sondine-lan`,
]);

await stageSpeechApp();
// The identifier comes from the bundle's Info.plist (app.sondine.speech).
run("codesign", [
  "--force",
  "--options",
  "runtime",
  timestamp,
  "--entitlements",
  "build/entitlements.speech.plist",
  "--sign",
  identity.sign,
  speechApp,
]);

await stageTextApp();
// Each library first, as itself, then the app: its seal covers them.
for (const file of LLAMA_CPP_RUNTIME.files.filter((entry) => entry.name.endsWith(".dylib"))) {
  run("codesign", [
    "--force",
    "--options",
    "runtime",
    timestamp,
    "--sign",
    identity.sign,
    `${textApp}/Contents/MacOS/${file.name}`,
  ]);
}
// The identifier comes from the bundle's Info.plist (app.sondine.text).
run("codesign", [
  "--force",
  "--options",
  "runtime",
  timestamp,
  "--entitlements",
  "build/entitlements.text.plist",
  "--sign",
  identity.sign,
  textApp,
]);

stageVoiceApp();
// The identifier comes from the bundle's Info.plist (app.sondine.voice).
run("codesign", [
  "--force",
  "--options",
  "runtime",
  timestamp,
  "--entitlements",
  "build/entitlements.voice.plist",
  "--sign",
  identity.sign,
  voiceApp,
]);

stageNotchApp();
// The identifier comes from the bundle's Info.plist (app.sondine.notch).
run("codesign", [
  "--force",
  "--options",
  "runtime",
  timestamp,
  "--entitlements",
  "build/entitlements.notch.plist",
  "--sign",
  identity.sign,
  notchApp,
]);

// Node-API is ABI-stable, so the headers of the Node running this script
// build an addon that Electron loads.
const nodeHeaders = join(dirname(dirname(process.execPath)), "include", "node");
if (!existsSync(join(nodeHeaders, "node_api.h"))) {
  console.error(`No node_api.h in ${nodeHeaders}: use a Node install that ships its headers.`);
  process.exit(1);
}
mkdirSync(`${stage}native`, { recursive: true });
run("clang", [
  "-bundle",
  "-undefined",
  "dynamic_lookup",
  "-fobjc-arc",
  "-O2",
  "-Wall",
  "-Werror",
  "-arch",
  "arm64",
  "-mmacosx-version-min=27.0",
  "-I",
  nodeHeaders,
  "-framework",
  "Foundation",
  "-framework",
  "Security",
  "-o",
  `${stage}native/group-container.node`,
  "native/group-container.m",
]);
run("clang", [
  "-bundle",
  "-undefined",
  "dynamic_lookup",
  "-fobjc-arc",
  "-O2",
  "-Wall",
  "-Werror",
  "-arch",
  "arm64",
  "-mmacosx-version-min=27.0",
  "-I",
  nodeHeaders,
  "-framework",
  "Foundation",
  "-framework",
  "UserNotifications",
  "-o",
  `${stage}native/notification-settings.node`,
  "native/notification-settings.m",
]);
run("clang", [
  "-bundle",
  "-undefined",
  "dynamic_lookup",
  "-fobjc-arc",
  "-O2",
  "-Wall",
  "-Werror",
  "-arch",
  "arm64",
  "-mmacosx-version-min=27.0",
  "-I",
  nodeHeaders,
  "-framework",
  "Foundation",
  "-framework",
  "Network",
  "-o",
  `${stage}native/update.node`,
  "native/update.m",
]);
run("clang", [
  "-bundle",
  "-undefined",
  "dynamic_lookup",
  "-fobjc-arc",
  "-O2",
  "-Wall",
  "-Werror",
  "-arch",
  "arm64",
  "-mmacosx-version-min=27.0",
  "-I",
  nodeHeaders,
  "-framework",
  "AppKit",
  "-o",
  `${stage}native/haptic.node`,
  "native/haptic.m",
]);

run("pnpm", ["run", "build"]);
run("pnpm", ["--filter", "@sondine/browser-extension", "build"]);
if (!existsSync(`${extensionDist}manifest.json`)) {
  console.error(`No manifest.json in ${extensionDist}: the browser extension did not build.`);
  process.exit(1);
}
// The Electron the install already fetched and checked: packaging needs no network.
const electronDist = `${app}node_modules/electron/dist`;
if (!existsSync(`${electronDist}/Electron.app`)) {
  console.error(`No Electron.app in ${electronDist}: run pnpm install.`);
  process.exit(1);
}
run("pnpm", [
  "exec",
  "electron-builder",
  "--mac",
  "--publish",
  "never",
  `-c.electronDist=${electronDist}`,
  // electron-builder names the certificate without its type prefix.
  `-c.mac.identity=${adHoc ? "-" : identity.name.replace(/^Developer ID Application: /, "")}`,
  // It notarizes with the APPLE_API_* key from the environment, then staples.
  ...(release ? ["-c.mac.notarize=true", "-c.mac.timestamp=http://timestamp.apple.com/ts01"] : []),
]);
run("node", [
  "scripts/check-package.mjs",
  ...(adHoc ? ["--ad-hoc"] : []),
  ...(release ? ["--release"] : []),
]);

// The files an installed Sondine updates from (ADR 045), from the app as
// electron-builder left it: signed, and in a release notarized and stapled.
if (release || testFeed !== "") {
  const out = `${app}release`;
  const built = `${out}/mac-arm64/Sondine.app`;
  const failures = [];
  writeUpdateFiles(built, out);
  checkUpdateFiles(built, out, {
    notarized: release,
    check: (ok, message) => {
      console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
      if (!ok) failures.push(message);
    },
  });
  if (failures.length > 0) process.exit(1);
}

if (notaryKey !== null) {
  const version = JSON.parse(readFileSync(`${app}package.json`, "utf8")).version;
  const dmg = `${app}release/Sondine-${version}-arm64.dmg`;
  // electron-builder leaves the disk image unsigned; Gatekeeper wants its own signature.
  run("codesign", ["--force", "--timestamp", "--sign", identity.sign, dmg]);
  // The key's id and issuer stay out of the log, a failure's included.
  console.log(`$ xcrun notarytool submit ${dmg} --wait`);
  try {
    execFileSync(
      "xcrun",
      [
        "notarytool",
        "submit",
        dmg,
        "--key",
        notaryKey.path,
        "--key-id",
        notaryKey.id,
        "--issuer",
        notaryKey.issuer,
        "--wait",
      ],
      { stdio: "inherit" },
    );
  } catch (error) {
    const status =
      typeof error === "object" && error !== null && "status" in error ? error.status : null;
    console.error(`notarytool submit failed (exit ${status ?? "?"})`);
    process.exit(1);
  }
  run("xcrun", ["stapler", "staple", dmg]);
  run("xcrun", ["stapler", "validate", `${app}release/mac-arm64/Sondine.app`]);
  run("xcrun", ["stapler", "validate", dmg]);
  // Gatekeeper's verdict on a downloaded copy: a notarized Developer ID app and disk image.
  run("spctl", ["--assess", "--type", "execute", "-vv", `${app}release/mac-arm64/Sondine.app`]);
  run("spctl", [
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    "-vv",
    dmg,
  ]);
}
