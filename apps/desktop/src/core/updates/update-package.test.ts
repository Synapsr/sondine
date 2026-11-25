import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  macosAtLeast,
  runTool,
  unpackUpdate,
  verifyUpdateApp,
  type Expected,
  type RunTool,
} from "./update-package";

// A fake Sondine.app and the real ditto, plutil and codesign: the signature is
// what codesign answers, so the checks of a real one are told yes or no here.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sondine-package-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const expected: Expected = {
  version: "0.8.0",
  current: "0.7.0",
  macosVersion: "27.0.1",
  notarized: true,
};

function appAt(parent: string, info: Record<string, string> = {}): string {
  const app = join(parent, "Sondine.app");
  mkdirSync(join(app, "Contents"), { recursive: true });
  const all = {
    CFBundleIdentifier: "app.sondine",
    CFBundleShortVersionString: "0.8.0",
    LSMinimumSystemVersion: "27.0",
    ...info,
  };
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${Object.entries(all)
      .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
      .join("")}</dict></plist>`,
  );
  return app;
}

/** The real tools, codesign answering `signed` and `notarized`. */
function tools(signed = true, notarized = true) {
  const asked: string[][] = [];
  const run: RunTool = (tool, args, signal) => {
    if (tool !== "/usr/bin/codesign") return runTool(tool, args, signal);
    asked.push([...args]);
    const ok = args.includes("-R=notarized") ? notarized : signed;
    return Promise.resolve({ ok, output: "" });
  };
  return { run, asked };
}

const archive = (parent: string, names: readonly string[]) => {
  const zip = join(dir, "update.zip");
  const tree = join(dir, "tree");
  mkdirSync(tree);
  for (const name of names) execFileSync("ditto", [join(parent, name), join(tree, name)]);
  execFileSync("ditto", ["-c", "-k", tree, zip]);
  return zip;
};

const refused = (problem: string) => ({ name: "UpdateRefusal", problem });

describe("an update's app", () => {
  it("is asked for Sondine's identifier, team and Developer ID, nested code and notarization", async () => {
    const { run, asked } = tools();
    await verifyUpdateApp(appAt(dir), expected, run);
    expect(asked[0]?.slice(0, 3)).toEqual(["--verify", "--deep", "--strict"]);
    expect(asked[0]?.[3]).toContain('identifier "app.sondine"');
    expect(asked[0]?.[3]).toContain('subject.OU] = "P5G8WAJ2G2"');
    expect(asked[0]?.[3]).toContain("anchor apple generic");
    expect(asked[1]).toContain("-R=notarized");
  });

  it("is refused by codesign's own answer, or Apple's", async () => {
    const app = appAt(dir);
    await expect(verifyUpdateApp(app, expected, tools(false).run)).rejects.toMatchObject(
      refused("signature"),
    );
    await expect(verifyUpdateApp(app, expected, tools(true, false).run)).rejects.toMatchObject(
      refused("notarization"),
    );
    // A test build's own feed: what it installs was never sent to Apple.
    await verifyUpdateApp(app, { ...expected, notarized: false }, tools(true, false).run);
  });

  it.skipIf(process.platform !== "darwin")("unsigned is refused by the real codesign", async () => {
    await expect(verifyUpdateApp(appAt(dir), expected)).rejects.toMatchObject(refused("signature"));
  });

  it.each([
    [{ CFBundleShortVersionString: "0.8.1" }, "version"],
    [{ CFBundleShortVersionString: "0.7.0" }, "version"],
    [{ CFBundleIdentifier: "app.other" }, "signature"],
    [{ LSMinimumSystemVersion: "28.0" }, "macos"],
  ])("is refused with %j", async (info, problem) => {
    await expect(verifyUpdateApp(appAt(dir, info), expected, tools().run)).rejects.toMatchObject(
      refused(problem),
    );
  });

  it("is never an older version, even if announced", async () => {
    const app = appAt(dir, { CFBundleShortVersionString: "0.6.0" });
    await expect(
      verifyUpdateApp(app, { ...expected, version: "0.6.0" }, tools().run),
    ).rejects.toMatchObject(refused("version"));
  });

  it("compares macOS versions", () => {
    expect(macosAtLeast("27.0.1", "27.0")).toBe(true);
    expect(macosAtLeast("27.0", "27.0")).toBe(true);
    expect(macosAtLeast("27.0", "27.1")).toBe(false);
  });
});

describe.skipIf(process.platform !== "darwin")("an update's archive", () => {
  it("becomes ready once checked whole", async () => {
    appAt(dir);
    const app = await unpackUpdate(
      archive(dir, ["Sondine.app"]),
      join(dir, "u"),
      expected,
      tools().run,
    );
    expect(app).toBe(join(dir, "u", "ready", "Sondine.app"));
    expect(readdirSync(join(dir, "u"))).toEqual(["ready"]);
  });

  it("leaves nothing behind when refused", async () => {
    appAt(dir);
    await expect(
      unpackUpdate(archive(dir, ["Sondine.app"]), join(dir, "u"), expected, tools(false).run),
    ).rejects.toMatchObject(refused("signature"));
    expect(readdirSync(join(dir, "u"))).toEqual([]);
  });

  it("holds one Sondine.app and nothing else", async () => {
    appAt(dir);
    mkdirSync(join(dir, "extra"));
    await expect(
      unpackUpdate(archive(dir, ["Sondine.app", "extra"]), join(dir, "u"), expected, tools().run),
    ).rejects.toMatchObject(refused("corrupt"));
  });

  it("is refused when it is no archive", async () => {
    const zip = join(dir, "bad.zip");
    writeFileSync(zip, "not a zip");
    await expect(unpackUpdate(zip, join(dir, "u"), expected, tools().run)).rejects.toMatchObject(
      refused("corrupt"),
    );
    expect(existsSync(join(dir, "u", "ready"))).toBe(false);
  });
});
