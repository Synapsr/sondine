import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import electronBinary from "electron";
import { afterAll, describe, expect, it } from "vitest";

// Runs scripts/check-package.mjs against a fake Sondine.app: the stock
// Electron framework (for the fuse wire) and an Info.plist that lacks the
// usage strings, and optionally a helper binary. The script must report what
// is missing, not plutil's error.

const script = resolve(import.meta.dirname, "../scripts/check-package.mjs");
const dir = mkdtempSync(join(tmpdir(), "sondine-package-"));
const builtHelper = resolve(import.meta.dirname, "../../../native/.build/release/sondine-audio");
let apps = 0;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeApp(info: Record<string, string>, helper?: string): string {
  apps += 1;
  const app = join(dir, `${apps}`, "Sondine.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents", "Frameworks"), { recursive: true });
  const electronApp = String(electronBinary).replace(/(\.app)\/.*$/, "$1");
  symlinkSync(
    join(electronApp, "Contents", "Frameworks", "Electron Framework.framework"),
    join(app, "Contents", "Frameworks", "Electron Framework.framework"),
  );
  writeFileSync(join(app, "Contents", "MacOS", "Sondine"), "");
  if (helper !== undefined) {
    mkdirSync(join(app, "Contents", "Helpers"));
    copyFileSync(helper, join(app, "Contents", "Helpers", "sondine-audio"));
  }
  const entries = Object.entries(info)
    .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
    .join("");
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${entries}</dict></plist>`,
  );
  return app;
}

function check(app: string): string[] {
  const result = spawnSync(process.execPath, [script, "--app", app, "--unsigned"], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });
  return result.stdout.split("\n");
}

describe.skipIf(process.platform !== "darwin")("check-package", () => {
  it("fails on missing usage strings instead of validating plutil's error text", () => {
    const lines = check(fakeApp({ CFBundleIdentifier: "app.sondine" }));
    expect(lines).toContain("ok   bundle identifier app.sondine");
    expect(lines).toContainEqual(expect.stringMatching(/^FAIL NSMicrophoneUsageDescription/));
    expect(lines).toContainEqual(expect.stringMatching(/^FAIL NSAudioCaptureUsageDescription/));
  });

  it("accepts usage strings that are present", () => {
    const lines = check(
      fakeApp({
        CFBundleIdentifier: "app.sondine",
        NSMicrophoneUsageDescription: "Sondine listens to your microphone, locally.",
        NSAudioCaptureUsageDescription: "Sondine records the audio your apps play, locally.",
      }),
    );
    expect(lines).toContain("ok   NSMicrophoneUsageDescription");
    expect(lines).toContain("ok   NSAudioCaptureUsageDescription");
  });

  it("fails a helper without an embedded Info.plist, which App Sandbox refuses to start", () => {
    const lines = check(fakeApp({ CFBundleIdentifier: "app.sondine" }, "/bin/echo"));
    expect(lines).toContain("FAIL helper Info.plist bundle identifier app.sondine.audio");
  });

  it.skipIf(!existsSync(builtHelper))("reads the built helper's Info.plist", () => {
    const lines = check(
      fakeApp(
        {
          CFBundleIdentifier: "app.sondine",
          NSMicrophoneUsageDescription: "Not the helper's microphone usage string.",
        },
        builtHelper,
      ),
    );
    expect(lines).toContain("ok   helper Info.plist bundle identifier app.sondine.audio");
    expect(lines).toContain("FAIL helper NSMicrophoneUsageDescription matches the app's");
  });
});
