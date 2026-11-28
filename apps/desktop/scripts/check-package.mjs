// Checks a packaged Sondine.app against ADR 010: locked fuses, Info.plist
// usage strings, the helpers, migrations and unpacked browser extension in
// place, the bundled main registering the playback scheme and the renderer's
// CSP allowing only it for media (architecture §11), and (when signed) the
// hardened runtime and explicit entitlements of the app and of its helpers,
// which run under App Sandbox without network entitlements but for the
// iPhone relay's (ADR 008), whose sandbox it proves at run time (no file in
// the home folder). For speech.cpp's worker (ADR 016) it also
// proves the sandbox at run time: Metal works, the models folder is
// readable, writes outside its container and reads of the database are
// denied, and a twin signed with its entitlements cannot connect out.
// Usage: node scripts/check-package.mjs [--app <Sondine.app>] [--release] [--ad-hoc | --unsigned]
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { LLAMA_CPP_RUNTIME } from "../../../packages/engines/src/llama-cpp/runtime.ts";
import { SPEECH_CPP_RUNTIME } from "../../../packages/engines/src/speech-cpp/runtime.ts";
import { WESPEAKER_MODEL } from "../../../packages/engines/src/voice/wespeaker.ts";
import { signingIdentity, utf8TextEncoding } from "./signing.mjs";

const { values } = parseArgs({
  options: {
    app: {
      type: "string",
      default: new URL("../release/mac-arm64/Sondine.app", import.meta.url).pathname,
    },
    release: { type: "boolean", default: false },
    "ad-hoc": { type: "boolean", default: false },
    unsigned: { type: "boolean", default: false },
  },
});
const app = values.app;
const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};
/** Runs a command; `ok` is its success, never inferred from its output. */
const run = (command, args, input, env = process.env) => {
  const result = spawnSync(command, args, { encoding: "utf8", input, env });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    // codesign prints its details on stderr.
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    error: (result.stderr || result.error?.message || `exit ${result.status}`).trim(),
  };
};

if (!existsSync(app)) {
  console.error(`No app at ${app}`);
  process.exit(1);
}

const expectedFuses = {
  [FuseV1Options.RunAsNode]: FuseState.DISABLE,
  [FuseV1Options.EnableCookieEncryption]: FuseState.ENABLE,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE,
  [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.ENABLE,
  [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: FuseState.DISABLE,
};
const wire = await getCurrentFuseWire(`${app}/Contents/MacOS/Sondine`);
for (const [option, expected] of Object.entries(expectedFuses)) {
  check(
    wire[option] === expected,
    `fuse ${FuseV1Options[option]} is ${expected === FuseState.ENABLE ? "on" : "off"}`,
  );
}

/** An Info.plist value, or null when plutil cannot read it. */
const info = (key) => {
  const result = run("plutil", ["-extract", key, "raw", "-o", "-", `${app}/Contents/Info.plist`]);
  return result.ok ? result.stdout.trim() : null;
};
check(info("CFBundleIdentifier") === "app.sondine", "bundle identifier app.sondine");
check(info("LSMinimumSystemVersion") === "27.0", "minimum macOS 27.0");
check(info("LSUIElement") === null, "the app is in the Dock (no LSUIElement)");
for (const key of [
  "NSMicrophoneUsageDescription",
  "NSAudioCaptureUsageDescription",
  "NSLocalNetworkUsageDescription",
]) {
  const value = info(key);
  check(value !== null && value.length > 20, value === null ? `${key} (missing)` : key);
}

const helper = `${app}/Contents/Helpers/sondine-audio`;
let helperRuns = true;
try {
  accessSync(helper, constants.X_OK);
} catch {
  helperRuns = false;
}
check(helperRuns, "Contents/Helpers/sondine-audio is executable");

/** The Info.plist linked into a tool's __TEXT,__info_plist section; {} when there is none. */
const embeddedInfo = (path) => {
  const section = run("otool", ["-P", path]);
  const start = section.stdout.indexOf("<?xml");
  if (!section.ok || start === -1) return {};
  const json = run("plutil", ["-convert", "json", "-o", "-", "-"], section.stdout.slice(start));
  return json.ok ? JSON.parse(json.stdout) : {};
};
// App Sandbox will not start the helper unless its signature binds an
// Info.plist with a bundle identifier (the __TEXT,__info_plist section).
const helperInfo = embeddedInfo(helper);
check(
  helperInfo.CFBundleIdentifier === "app.sondine.audio",
  "helper Info.plist bundle identifier app.sondine.audio",
);
for (const key of ["NSMicrophoneUsageDescription", "NSAudioCaptureUsageDescription"]) {
  check(info(key) !== null && helperInfo[key] === info(key), `helper ${key} matches the app's`);
}
// The relays agent clients (ADR 011) and browsers (ADR 023) start: sandboxed
// tools like the helper, so each needs the same bound Info.plist to start.
const relays = [
  { label: "relay", tool: "sondine-mcp", id: "app.sondine.mcp" },
  { label: "browser relay", tool: "sondine-browser", id: "app.sondine.browser" },
].map((relay) => ({ ...relay, path: `${app}/Contents/Helpers/${relay.tool}` }));
for (const { label, tool, id, path } of relays) {
  check(
    embeddedInfo(path).CFBundleIdentifier === id,
    `${label} Info.plist bundle identifier ${id}`,
  );
  // Started outside the app, as an agent client or a browser starts it: the sandbox lets it run.
  // Ad hoc, it does not start: the application group belongs to the team's signature.
  if (!values["ad-hoc"]) {
    const version = run(path, ["--version"]);
    check(
      version.ok && version.stdout.startsWith(`${tool} `),
      `${label} starts under its sandbox (${version.ok ? version.stdout.trim() : "failed"})`,
    );
  }
}
// The relay for paired iPhones (ADR 008), the one native child with a
// network entitlement: its bound Info.plist, the app's local network string
// (macOS credits its network use to Sondine), and its sandbox proven at run
// time, as core starts it: a file in the home folder refused, listening allowed.
const lanRelay = `${app}/Contents/Helpers/sondine-lan`;
const lanInfo = embeddedInfo(lanRelay);
check(
  lanInfo.CFBundleIdentifier === "app.sondine.lan",
  "iPhone relay Info.plist bundle identifier app.sondine.lan",
);
check(
  info("NSLocalNetworkUsageDescription") !== null &&
    lanInfo.NSLocalNetworkUsageDescription === info("NSLocalNetworkUsageDescription"),
  "iPhone relay NSLocalNetworkUsageDescription matches the app's",
);
const lanVersion = run(lanRelay, ["--version"]);
check(
  lanVersion.ok && lanVersion.stdout.startsWith("sondine-lan "),
  `iPhone relay starts (${lanVersion.ok ? lanVersion.stdout.trim() : "failed"})`,
);
if (!values.unsigned) {
  const selfTest = run(lanRelay, ["self-test", "sandbox"]);
  const lines = selfTest.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const outcome = (name) => lines.find((line) => line.check === name);
  check(
    selfTest.ok &&
      outcome("file.home-write-denied")?.ok === true &&
      outcome("network.listen-allowed")?.ok === true,
    `iPhone relay may listen and is sandboxed (${
      outcome("file.home-write-denied")?.outcome ?? selfTest.error
    })`,
  );
}
// The unpacked extension the user loads in their browser (ADR 023).
const extensionManifest = (() => {
  try {
    return JSON.parse(
      readFileSync(`${app}/Contents/Resources/browser-extension/manifest.json`, "utf8"),
    );
  } catch {
    return null;
  }
})();
check(
  extensionManifest?.manifest_version === 3,
  "browser extension (Manifest V3) in Contents/Resources/browser-extension",
);
// speech.cpp's worker (ADR 016): a minimal app bundle, so App Sandbox can start it.
const speechApp = `${app}/Contents/Helpers/Sondine Speech.app`;
const speech = `${speechApp}/Contents/MacOS/speech`;
// speech.cpp checks for updates unless told not to; the sandbox would stop it anyway.
const speechEnv = { ...process.env, SPEECH_NO_UPDATE_CHECK: "1" };
let speechRuns = true;
try {
  accessSync(speech, constants.X_OK);
} catch {
  speechRuns = false;
}
check(speechRuns, "Contents/Helpers/Sondine Speech.app/Contents/MacOS/speech is executable");
const speechInfo = (key) => {
  const result = run("plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    `${speechApp}/Contents/Info.plist`,
  ]);
  return result.ok ? result.stdout.trim() : null;
};
check(
  speechInfo("CFBundleIdentifier") === "app.sondine.speech",
  "speech app bundle identifier app.sondine.speech",
);
check(speechInfo("CFBundleExecutable") === "speech", "speech app executable is speech");
check(speechInfo("LSUIElement") === "true", "speech app has no Dock icon (LSUIElement)");
for (const notice of SPEECH_CPP_RUNTIME.notices) {
  const path = `${speechApp}/Contents/Resources/${notice.file}`;
  check(
    existsSync(path) &&
      createHash("sha256").update(readFileSync(path)).digest("hex") === notice.sha256,
    `speech app ships ${notice.file}`,
  );
}
const speechVersion = speechRuns ? run(speech, ["--version"], undefined, speechEnv) : null;
check(
  speechVersion?.ok === true &&
    speechVersion.stdout.startsWith(`speech.cpp ${SPEECH_CPP_RUNTIME.version},`),
  `speech app launches and reports speech.cpp ${SPEECH_CPP_RUNTIME.version}`,
);

// The daily journal's server (ADR 028): llama-server and the libraries it
// loads from its own folder, in a minimal app bundle, with its license.
const textApp = `${app}/Contents/Helpers/Sondine Text.app`;
const textServer = `${textApp}/Contents/MacOS/llama-server`;
for (const file of LLAMA_CPP_RUNTIME.files) {
  const path = `${textApp}/Contents/MacOS/${file.name}`;
  check(existsSync(path), `text app holds ${file.name}`);
}
const textInfo = (key) => {
  const result = run("plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    `${textApp}/Contents/Info.plist`,
  ]);
  return result.ok ? result.stdout.trim() : null;
};
check(
  textInfo("CFBundleIdentifier") === "app.sondine.text",
  "text app bundle identifier app.sondine.text",
);
check(textInfo("CFBundleExecutable") === "llama-server", "text app executable is llama-server");
check(textInfo("LSUIElement") === "true", "text app has no Dock icon (LSUIElement)");
check(
  existsSync(`${textApp}/Contents/Resources/LICENSE.txt`) &&
    createHash("sha256")
      .update(readFileSync(`${textApp}/Contents/Resources/LICENSE.txt`))
      .digest("hex") === LLAMA_CPP_RUNTIME.notice.sha256,
  "text app ships llama.cpp's LICENSE",
);
// Loads every library under the hardened runtime's library validation, sandboxed.
// Ad hoc, library validation refuses them: no team signed both.
if (!values["ad-hoc"]) {
  const textVersion = run(textServer, ["--version"]);
  check(
    textVersion.ok &&
      textVersion.output.includes(`build ${LLAMA_CPP_RUNTIME.version.replace(/^b/, "")}`),
    `text app launches and reports llama.cpp ${LLAMA_CPP_RUNTIME.version}`,
  );
}

// Voice embeddings (architecture §8): sondine-voice in a minimal app bundle
// with the WeSpeaker model and its license and attribution.
const voiceApp = `${app}/Contents/Helpers/Sondine Voice.app`;
const voice = `${voiceApp}/Contents/MacOS/sondine-voice`;
const voiceModel = `${voiceApp}/Contents/Resources/${WESPEAKER_MODEL.name}`;
let voiceRuns = true;
try {
  accessSync(voice, constants.X_OK);
} catch {
  voiceRuns = false;
}
check(voiceRuns, "Contents/Helpers/Sondine Voice.app/Contents/MacOS/sondine-voice is executable");
const voiceInfo = (key) => {
  const result = run("plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    `${voiceApp}/Contents/Info.plist`,
  ]);
  return result.ok ? result.stdout.trim() : null;
};
check(
  voiceInfo("CFBundleIdentifier") === "app.sondine.voice",
  "voice app bundle identifier app.sondine.voice",
);
check(voiceInfo("LSUIElement") === "true", "voice app has no Dock icon (LSUIElement)");
for (const file of WESPEAKER_MODEL.files) {
  const path = `${voiceModel}/${file.path}`;
  check(
    existsSync(path) &&
      createHash("sha256").update(readFileSync(path)).digest("hex") === file.sha256,
    `voice app ships the pinned ${WESPEAKER_MODEL.name}/${file.path}`,
  );
}
for (const notice of WESPEAKER_MODEL.notices) {
  const path = `${voiceApp}/Contents/Resources/${notice.file}`;
  check(
    existsSync(path) &&
      (!("sha256" in notice) ||
        createHash("sha256").update(readFileSync(path)).digest("hex") === notice.sha256),
    `voice app ships the model's ${notice.file}`,
  );
}
if (voiceRuns) {
  // Four seconds of a voiced tone: one embedding comes back, from the sandboxed app.
  const tone = Buffer.alloc(64_000 * 2);
  for (let index = 0; index < 64_000; index++) {
    const t = index / 16_000;
    tone.writeInt16LE(
      Math.round(6000 * Math.sin(2 * Math.PI * 140 * t) * (1 + Math.sin(2 * Math.PI * 3 * t))),
      index * 2,
    );
  }
  const embedded = run(
    voice,
    ["embed", "--model", voiceModel],
    JSON.stringify({ speakers: [{ key: "check", pieces: [tone.toString("base64")] }] }),
  );
  let answer = null;
  try {
    answer = embedded.ok ? JSON.parse(embedded.stdout) : null;
  } catch {
    answer = null;
  }
  check(
    answer?.speakers?.[0]?.embedding?.length === 256 &&
      typeof answer?.modelVersion === "string" &&
      answer.modelVersion.startsWith("wespeaker-v2:"),
    `voice app embeds a voice${embedded.ok ? "" : ` (${embedded.error})`}`,
  );
}

// Call context beside the notch (ADR 025): sondine-notch in a minimal app
// bundle. Given one view and then end of input, it shows it (or finds no
// notch) and exits, under its sandbox.
const notchApp = `${app}/Contents/Helpers/Sondine Notch.app`;
const notch = `${notchApp}/Contents/MacOS/sondine-notch`;
let notchRuns = true;
try {
  accessSync(notch, constants.X_OK);
} catch {
  notchRuns = false;
}
check(notchRuns, "Contents/Helpers/Sondine Notch.app/Contents/MacOS/sondine-notch is executable");
const notchInfo = (key) => {
  const result = run("plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    `${notchApp}/Contents/Info.plist`,
  ]);
  return result.ok ? result.stdout.trim() : null;
};
check(
  notchInfo("CFBundleIdentifier") === "app.sondine.notch",
  "notch app bundle identifier app.sondine.notch",
);
check(notchInfo("LSUIElement") === "true", "notch app has no Dock icon (LSUIElement)");
if (notchRuns) {
  const shown = run(
    notch,
    [],
    `${JSON.stringify({
      type: "show",
      view: 1,
      call: null,
      people: [{ personId: 1, label: "Check ?", monogram: "C", conversations: [], none: "None" }],
      dismiss: { label: "Hide", callId: 1 },
      card: null,
      openOnHover: true,
    })}\n`,
    {},
  );
  const first = shown.stdout.split("\n")[0] ?? "";
  check(
    shown.ok && ['{"type":"ready"}', '{"type":"no-notch"}'].includes(first),
    `notch app reads a view and exits under its sandbox (${shown.ok ? first : shown.error})`,
  );
}

const addon = `${app}/Contents/Resources/native/group-container.node`;
check(existsSync(addon), "group container addon in Contents/Resources/native");
check(
  existsSync(`${app}/Contents/Resources/native/update.node`),
  "updates addon in Resources/native",
);
check(
  existsSync(`${app}/Contents/Resources/native/notification-settings.node`),
  "notification settings addon in Contents/Resources/native",
);
check(
  existsSync(`${app}/Contents/Resources/native/haptic.node`),
  "haptic addon in Contents/Resources/native",
);
const migrations = `${app}/Contents/Resources/drizzle`;
check(
  existsSync(migrations) && readdirSync(migrations).length > 0,
  "migrations in Contents/Resources/drizzle",
);
const asar = `${app}/Contents/Resources/app.asar`;
check(existsSync(asar), "app.asar");
check(!existsSync(`${app}/Contents/Resources/app`), "no unpacked app folder");

/** A file packed in an asar archive, as text; null when it is not there. */
function asarText(archive, path) {
  if (!existsSync(archive)) return null;
  const fd = openSync(archive, "r");
  try {
    // An 8-byte pickle with the header's size, then the header: a pickled JSON index.
    const sizes = Buffer.alloc(8);
    readSync(fd, sizes, 0, 8, 0);
    const headerSize = sizes.readUInt32LE(4);
    const header = Buffer.alloc(headerSize);
    readSync(fd, header, 0, headerSize, 8);
    let node = JSON.parse(header.toString("utf8", 8, 8 + header.readUInt32LE(4)));
    for (const part of path.split("/")) node = node?.files?.[part];
    if (node?.offset === undefined) return null;
    const data = Buffer.alloc(node.size);
    readSync(fd, data, 0, node.size, 8 + headerSize + Number(node.offset));
    return data.toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
// Playback streams episodes through `sondine-media:` (architecture §11): the
// packaged main must register it, streaming, without bypassing the CSP.
const mainBundle = asarText(asar, "out/main/index.js") ?? "";
if (values.release) {
  // A release updates from GitHub alone, notarized apps alone (ADR 045).
  check(
    !/http:\/\/127\.0\.0\.1:\d+\/sondine-mac\.json/u.test(readFileSync(asar, "latin1")),
    "no test update feed in a release",
  );
}
const schemes = /registerSchemesAsPrivileged\(\[([\s\S]*?)\]\)/.exec(mainBundle)?.[1] ?? "";
check(
  /scheme:\s*(MEDIA_SCHEME|"sondine-media")/.test(schemes) &&
    /stream:\s*(true|!0)/.test(schemes) &&
    !schemes.includes("bypassCSP"),
  "main registers sondine-media: as a streaming scheme without CSP bypass",
);
check(
  /protocol\.handle\((MEDIA_SCHEME|"sondine-media")/.test(mainBundle),
  "main serves sondine-media:",
);
const rendererCsp = (
  /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(
    asarText(asar, "out/renderer/index.html") ?? "",
  )?.[1] ?? ""
).replaceAll("&#39;", "'");
check(
  rendererCsp.includes("media-src sondine-media:;") && !rendererCsp.includes("blob:"),
  "renderer CSP plays media only from sondine-media:",
);

if (!values.unsigned) {
  const verify = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  check(verify.ok, "codesign --verify --deep --strict");
  if (!verify.ok) console.log(verify.error);

  /** The signed entitlements as an object; {} when there are none or codesign fails. */
  const entitlements = (path) => {
    const signed = run("codesign", ["-d", "--entitlements", "-", "--xml", path]);
    if (!signed.ok || signed.stdout.trim() === "") return {};
    const json = run("plutil", ["-convert", "json", "-o", "-", "-"], signed.stdout);
    return json.ok ? JSON.parse(json.stdout) : {};
  };
  const flags = (path) => {
    const result = run("codesign", ["-dv", "--verbose=4", path]);
    return result.ok ? result.output : "";
  };
  const group = "P5G8WAJ2G2.app.sondine";
  const inGroup = (ents) =>
    (ents["com.apple.security.application-groups"] ?? []).includes(group) === true;
  const appEntitlements = entitlements(app);
  const helperEntitlements = entitlements(helper);
  for (const key of ["com.apple.security.cs.allow-jit", "com.apple.security.device.audio-input"]) {
    check(appEntitlements[key] === true, `app entitlement ${key}`);
  }
  check(inGroup(appEntitlements), `app entitlement application group ${group}`);

  // ADR 010: the helper runs under App Sandbox, which denies outbound network
  // because it has no network entitlement.
  check(helperEntitlements["com.apple.security.app-sandbox"] === true, "helper is sandboxed");
  check(
    helperEntitlements["com.apple.security.device.audio-input"] === true,
    "helper entitlement com.apple.security.device.audio-input",
  );
  check(inGroup(helperEntitlements), `helper entitlement application group ${group}`);
  for (const key of ["com.apple.security.network.client", "com.apple.security.network.server"]) {
    check(!(key in helperEntitlements), `helper has no ${key}`);
  }
  check(
    !("com.apple.security.cs.allow-jit" in helperEntitlements),
    "helper has no JIT entitlement",
  );
  // ADR 013: the only file exception is read-only access to the models folder.
  const modelsException =
    "com.apple.security.temporary-exception.files.home-relative-path.read-only";
  const exceptions = Object.keys(helperEntitlements).filter((key) =>
    key.startsWith("com.apple.security.temporary-exception."),
  );
  check(
    exceptions.length === 1 &&
      JSON.stringify(helperEntitlements[modelsException]) ===
        JSON.stringify(["/Library/Application Support/Sondine/models/"]),
    "helper reads only ~/Library/Application Support/Sondine/models/ outside its containers",
  );
  check(/flags=0x\w*\(.*runtime.*\)/.test(flags(app)), "app uses the hardened runtime");
  check(/flags=0x\w*\(.*runtime.*\)/.test(flags(helper)), "helper uses the hardened runtime");
  check(/Info\.plist entries=\d+/.test(flags(helper)), "helper Info.plist bound to its signature");
  if (!values["ad-hoc"]) {
    check(flags(app).includes("TeamIdentifier=P5G8WAJ2G2"), "app signed by team P5G8WAJ2G2");
    check(flags(helper).includes("TeamIdentifier=P5G8WAJ2G2"), "helper signed by team P5G8WAJ2G2");
    // Library validation only loads an addon signed by the app's team.
    check(flags(addon).includes("TeamIdentifier=P5G8WAJ2G2"), "addon signed by team P5G8WAJ2G2");
  }

  // ADR 016: speech.cpp's worker gets App Sandbox and the read-only models
  // exception, nothing else: no network, no device, no group container.
  const speechEntitlements = entitlements(speechApp);
  const modelsFolder = "/Library/Application Support/Sondine/models/";
  check(
    JSON.stringify(Object.keys(speechEntitlements).toSorted()) ===
      JSON.stringify(["com.apple.security.app-sandbox", modelsException]) &&
      speechEntitlements["com.apple.security.app-sandbox"] === true &&
      JSON.stringify(speechEntitlements[modelsException]) === JSON.stringify([modelsFolder]),
    "speech app has only App Sandbox and read-only access to ~/Library/Application Support/Sondine/models/",
  );
  const speechFlags = flags(speechApp);
  check(
    speechFlags.includes("Identifier=app.sondine.speech"),
    "speech app signed as app.sondine.speech",
  );
  check(/flags=0x\w*\(.*runtime.*\)/.test(speechFlags), "speech app uses the hardened runtime");
  check(
    /Info\.plist entries=\d+/.test(speechFlags),
    "speech app Info.plist bound to its signature",
  );
  if (!values["ad-hoc"]) {
    check(
      speechFlags.includes("TeamIdentifier=P5G8WAJ2G2"),
      "speech app signed by team P5G8WAJ2G2",
    );
  }
  // ADR 028: the journal's server gets App Sandbox and the read-only models
  // exception, nothing else: no network, no group container. It listens in
  // its own container's temporary folder.
  const textEntitlements = entitlements(textApp);
  check(
    JSON.stringify(Object.keys(textEntitlements).toSorted()) ===
      JSON.stringify(["com.apple.security.app-sandbox", modelsException]) &&
      textEntitlements["com.apple.security.app-sandbox"] === true &&
      JSON.stringify(textEntitlements[modelsException]) === JSON.stringify([modelsFolder]),
    "text app has only App Sandbox and read-only access to ~/Library/Application Support/Sondine/models/",
  );
  const textFlags = flags(textApp);
  check(textFlags.includes("Identifier=app.sondine.text"), "text app signed as app.sondine.text");
  check(/flags=0x\w*\(.*runtime.*\)/.test(textFlags), "text app uses the hardened runtime");
  if (!values["ad-hoc"]) {
    check(textFlags.includes("TeamIdentifier=P5G8WAJ2G2"), "text app signed by team P5G8WAJ2G2");
  }
  // The relays get App Sandbox and the app group, where core's sockets are: no network.
  for (const { label, id, path } of relays) {
    const relayEntitlements = entitlements(path);
    check(
      Object.keys(relayEntitlements).length === 2 &&
        relayEntitlements["com.apple.security.app-sandbox"] === true &&
        JSON.stringify(relayEntitlements["com.apple.security.application-groups"]) ===
          JSON.stringify([group]),
      `${label} has only App Sandbox and the app group`,
    );
    const relayFlags = flags(path);
    check(relayFlags.includes(`Identifier=${id}`), `${label} signed as ${id}`);
    check(/flags=0x\w*\(.*runtime.*\)/.test(relayFlags), `${label} uses the hardened runtime`);
    check(/Info\.plist entries=\d+/.test(relayFlags), `${label} Info.plist bound to its signature`);
    if (!values["ad-hoc"]) {
      check(relayFlags.includes("TeamIdentifier=P5G8WAJ2G2"), `${label} signed by team P5G8WAJ2G2`);
    }
  }
  // ADR 008: the iPhone relay gets App Sandbox, network.server, network.client
  // (Network.framework's listener needs it to answer a peer on the Wi-Fi) and
  // the app group (core's phone socket and the TLS identity).
  const lanEntitlements = entitlements(lanRelay);
  check(
    JSON.stringify(Object.keys(lanEntitlements).toSorted()) ===
      JSON.stringify([
        "com.apple.security.app-sandbox",
        "com.apple.security.application-groups",
        "com.apple.security.network.client",
        "com.apple.security.network.server",
      ]) &&
      lanEntitlements["com.apple.security.app-sandbox"] === true &&
      lanEntitlements["com.apple.security.network.client"] === true &&
      lanEntitlements["com.apple.security.network.server"] === true &&
      JSON.stringify(lanEntitlements["com.apple.security.application-groups"]) ===
        JSON.stringify([group]),
    "iPhone relay has only App Sandbox, network.server, network.client and the app group",
  );
  const lanFlags = flags(lanRelay);
  check(lanFlags.includes("Identifier=app.sondine.lan"), "iPhone relay signed as app.sondine.lan");
  check(/flags=0x\w*\(.*runtime.*\)/.test(lanFlags), "iPhone relay uses the hardened runtime");
  check(/Info\.plist entries=\d+/.test(lanFlags), "iPhone relay Info.plist bound to its signature");
  if (!values["ad-hoc"]) {
    check(lanFlags.includes("TeamIdentifier=P5G8WAJ2G2"), "iPhone relay signed by team P5G8WAJ2G2");
  }
  // The voice app gets App Sandbox and nothing else: no network, no file outside its bundle.
  const voiceEntitlements = entitlements(voiceApp);
  check(
    JSON.stringify(voiceEntitlements) ===
      JSON.stringify({ "com.apple.security.app-sandbox": true }),
    "voice app has only App Sandbox",
  );
  const voiceFlags = flags(voiceApp);
  check(
    voiceFlags.includes("Identifier=app.sondine.voice"),
    "voice app signed as app.sondine.voice",
  );
  check(/flags=0x\w*\(.*runtime.*\)/.test(voiceFlags), "voice app uses the hardened runtime");
  check(/Info\.plist entries=\d+/.test(voiceFlags), "voice app Info.plist bound to its signature");
  if (!values["ad-hoc"]) {
    check(voiceFlags.includes("TeamIdentifier=P5G8WAJ2G2"), "voice app signed by team P5G8WAJ2G2");
  }
  // The notch app gets App Sandbox and nothing else.
  check(
    JSON.stringify(entitlements(notchApp)) ===
      JSON.stringify({ "com.apple.security.app-sandbox": true }),
    "notch app has only App Sandbox",
  );
  const notchFlags = flags(notchApp);
  check(
    notchFlags.includes("Identifier=app.sondine.notch"),
    "notch app signed as app.sondine.notch",
  );
  check(/flags=0x\w*\(.*runtime.*\)/.test(notchFlags), "notch app uses the hardened runtime");
  if (!values["ad-hoc"]) {
    check(notchFlags.includes("TeamIdentifier=P5G8WAJ2G2"), "notch app signed by team P5G8WAJ2G2");
  }
  if (speechRuns) await checkSpeechSandbox(join(homedir(), modelsFolder));
}

/** Resolves true once `child` has run `ms` without exiting, false if it exits first. */
function survives(child, exited, ms) {
  return Promise.race([exited.then(() => false), sleep(ms).then(() => child.exitCode === null)]);
}

/** The probe's JSON lines, or [] when it failed. */
function probeLines(result) {
  if (!result.ok) return [];
  return result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

/**
 * Runs the packaged speech app under its sandbox and asks the sandbox what it
 * allows, then repeats the questions sandbox_check cannot answer (the app's
 * own container, outbound network) on a twin: the probe signed as the same
 * bundle with the same entitlements, doing real writes and a real connect.
 */
async function checkSpeechSandbox(modelsDir) {
  const work = mkdtempSync(join(tmpdir(), "sondine-check-"));
  const home = homedir();
  try {
    const probe = join(work, "sandbox-probe");
    const built = run("clang", [
      "-O2",
      "-Wall",
      "-Werror",
      "-arch",
      "arm64",
      "-mmacosx-version-min=27.0",
      "-o",
      probe,
      fileURLToPath(new URL("../native/sandbox-probe.c", import.meta.url)),
    ]);
    check(built.ok, "sandbox probe builds (native/sandbox-probe.c)");
    if (!built.ok) {
      console.log(built.error);
      return;
    }

    const devices = run(speech, ["devices"], undefined, speechEnv);
    check(
      devices.ok && /^\S+\s+gpu\s/m.test(devices.stdout),
      "speech app reaches the GPU (Metal) under its sandbox",
    );

    // speech.cpp opens its model first. A FIFO in the models folder blocks
    // that open() until a writer comes, which keeps the worker alive and
    // sandboxed while the sandbox is asked about it.
    mkdirSync(modelsDir, { recursive: true });
    const probeDir = mkdtempSync(join(modelsDir, ".check-package-"));
    const fifo = join(probeDir, "probe.gguf");
    // Before the spawn: speech.cpp takes a missing path for a model name to fetch.
    if (!run("mkfifo", [fifo]).ok) throw new Error(`mkfifo ${fifo} failed`);
    const child = spawn(speech, ["worker", fifo, "--device", "cpu", "--threads", "1"], {
      env: speechEnv,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    try {
      const blocked = await survives(child, exited, 1_500);
      check(blocked, "speech app waits on a file in the models folder under its sandbox");
      if (!blocked) {
        console.log(stdout);
        return;
      }
      const queries = [
        // Controls: the probe answers "allowed" where the sandbox allows.
        ["file-read-data", fifo, "allowed", "speech app may read the models folder"],
        ["file-write-data", "/dev/null", "allowed", "sandbox probe sees what the sandbox allows"],
        [
          "file-write-create",
          join(modelsDir, "check"),
          "denied",
          "speech app cannot write in the models folder",
        ],
        [
          "file-write-create",
          join(home, "Library/Application Support/Sondine/check"),
          "denied",
          "speech app cannot write in ~/Library/Application Support/Sondine",
        ],
        [
          "file-write-create",
          join(home, "Documents/check"),
          "denied",
          "speech app cannot write in ~/Documents",
        ],
        [
          "file-write-create",
          "/private/tmp/sondine-check",
          "denied",
          "speech app cannot write in /tmp",
        ],
        [
          "file-read-data",
          join(home, "Library/Group Containers/P5G8WAJ2G2.app.sondine/sondine.db"),
          "denied",
          "speech app cannot read the database or the spool",
        ],
        ["file-read-data", join(home, "Documents"), "denied", "speech app cannot read ~/Documents"],
        [
          "network-outbound",
          "/private/var/run/mDNSResponder",
          "denied",
          "speech app cannot reach DNS (no network entitlement in effect)",
        ],
      ];
      const answers = probeLines(
        run(probe, [
          "check",
          String(child.pid),
          ...queries.map(([operation, path]) => `${operation}=${path}`),
        ]),
      );
      check(answers[0]?.result === "yes", "speech app runs under App Sandbox");
      for (const [index, [, , expected, message]] of queries.entries()) {
        check(answers[index + 1]?.result === expected, message);
      }
      // A non-blocking open for writing succeeds only while a reader holds the
      // FIFO: the sandboxed worker opened a file in the models folder. It
      // opens the file more than once, so feed it until it gives up.
      let opened = false;
      const feedUntil = Date.now() + 10_000;
      while (child.exitCode === null && Date.now() < feedUntil) {
        try {
          const writer = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
          opened = true;
          try {
            writeSync(writer, "not a model\n");
          } catch (error) {
            if (error.code !== "EPIPE" && error.code !== "EAGAIN") throw error;
          } finally {
            closeSync(writer);
          }
        } catch (error) {
          if (error.code !== "ENXIO") throw error;
        }
        await sleep(50);
      }
      check(opened, "speech app opened a file in the models folder for reading");
      const code = await Promise.race([exited, sleep(10_000).then(() => "timeout")]);
      check(
        code === 1 && /"type":"fatal".*"code":"model_file"/.test(stdout),
        "speech app read that file and refused it as a model (fatal model_file)",
      );
    } finally {
      child.kill("SIGKILL");
      rmSync(probeDir, { recursive: true, force: true });
    }

    const identity = values["ad-hoc"] ? { sign: "-" } : signingIdentity();
    const twin = join(work, "Speech Twin.app");
    mkdirSync(join(twin, "Contents", "MacOS"), { recursive: true });
    copyFileSync(join(speechApp, "Contents", "Info.plist"), join(twin, "Contents", "Info.plist"));
    copyFileSync(probe, join(twin, "Contents", "MacOS", "speech"));
    const signedEntitlements = run("codesign", ["-d", "--entitlements", "-", "--xml", speechApp]);
    writeFileSync(join(work, "speech.entitlements"), signedEntitlements.stdout);
    const signed =
      identity !== null &&
      run(
        "codesign",
        [
          "--force",
          "--options",
          "runtime",
          "--timestamp=none",
          "--entitlements",
          join(work, "speech.entitlements"),
          "--sign",
          identity.sign,
          twin,
        ],
        undefined,
        { ...process.env, __CF_USER_TEXT_ENCODING: utf8TextEncoding },
      ).ok;
    check(signed, "twin signed with the speech app's entitlements");
    if (!signed) return;
    const twinProbe = join(twin, "Contents", "MacOS", "speech");

    const server = createServer((socket) => socket.destroy());
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const [attempt] = probeLines(run(twinProbe, ["connect", "127.0.0.1", String(port)]));
    server.close();
    check(
      attempt?.sandboxed === true && attempt.connect === "denied",
      `speech app's entitlements deny an outbound TCP connect (${attempt?.connect ?? "no answer"})`,
    );

    // Never ~/Documents here: if the sandbox failed, macOS would prompt.
    const name = `sondine-check-${process.pid}`;
    const writes = [
      [
        join(home, "Library/Containers/app.sondine.speech/Data/tmp", name),
        "created",
        "its own container",
      ],
      [join(modelsDir, name), "denied", "the models folder"],
      [
        join(home, "Library/Application Support/Sondine", name),
        "denied",
        "~/Library/Application Support/Sondine",
      ],
      [join("/private/tmp", name), "denied", "/tmp"],
    ];
    const written = probeLines(run(twinProbe, ["write", ...writes.map(([path]) => path)]));
    for (const [index, [, expected, where]] of writes.entries()) {
      check(
        written[index]?.write === expected,
        `speech app's entitlements ${expected === "created" ? "allow" : "deny"} creating a file in ${where}`,
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("package checks passed");
