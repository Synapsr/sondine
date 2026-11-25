import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installRefusal, relaunchCommand, RELAUNCH_SCRIPT, stillSigned } from "./update-install";

let dir: string;
let updates: string;
let app: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sondine-install-"));
  updates = join(dir, "updates");
  app = join(updates, "0.8.0-aaaa", "ready", "Sondine.app");
  mkdirSync(app, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const refusal = (
  path: string,
  version = "0.8.0",
  target: string | null = "/Applications/Sondine.app",
) =>
  installRefusal({ version, app: path }, { target, current: "0.7.0", updatesDirectory: updates });

describe("what main refuses to install", () => {
  it("nothing, for a later app core checked", () => {
    expect(refusal(app)).toBeNull();
  });

  it("the same version, an older one, or anything where this app cannot be replaced", () => {
    expect(refusal(app, "0.7.0")).toBe("not-newer");
    expect(refusal(app, "0.6.9")).toBe("not-newer");
    expect(refusal(app, "0.8.0", null)).toBe("blocked");
  });

  it("an app anywhere but its own place in the updates folder", () => {
    for (const path of [
      "/Applications/Other.app",
      join(updates, "..", "Sondine.app"),
      join(updates, "0.8.0-aaaa", "unpacking", "Sondine.app"),
      join(updates, "0.8.0-aaaa", "ready", "Other.app"),
      join(updates, "0.8.0-aaaa", "ready"),
    ]) {
      expect(refusal(path)).toBe("outside");
    }
    expect(refusal(join(updates, "0.9.0-bbbb", "ready", "Sondine.app"))).toBe("missing");
  });

  it("a link, on the way or at the end", () => {
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(join(elsewhere, "Sondine.app"), { recursive: true });
    mkdirSync(join(updates, "a"));
    symlinkSync(elsewhere, join(updates, "a", "ready"));
    expect(refusal(join(updates, "a", "ready", "Sondine.app"))).toBe("outside");
    mkdirSync(join(updates, "b", "ready"), { recursive: true });
    symlinkSync(join(elsewhere, "Sondine.app"), join(updates, "b", "ready", "Sondine.app"));
    expect(refusal(join(updates, "b", "ready", "Sondine.app"))).toBe("missing");
  });
});

describe("the shell that opens the app again", () => {
  /** Runs the script with its tools replaced; `open` acknowledges when `started`. */
  function run(window: "front" | "behind" | "closed", started: boolean) {
    const bin = join(dir, "bin");
    const said = join(dir, "said");
    const name = "sondine-update-11111111-1111-1111-1111-111111111111";
    mkdirSync(bin);
    const tool = (tool: string, body: string) => {
      writeFileSync(join(bin, tool), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, tool), 0o755);
    };
    tool("open", `echo "open $*" >> "${said}"${started ? `; : > "${join(dir, name)}"` : ""}`);
    tool("osascript", `echo "alert" >> "${said}"; echo open`);
    tool("sleep", "");
    const command = relaunchCommand(
      999_999,
      "/A b/Sondine.app",
      { window, path: "/episode/3" },
      { directory: dir, name },
      { title: "t", body: "b", close: "c", open: "o", page: "https://page" },
    );
    expect(command.args[1]).toBe(RELAUNCH_SCRIPT);
    spawnSync(command.file, [...command.args], { env: { PATH: `${bin}:/usr/bin:/bin` } });
    expect(existsSync(join(dir, name))).toBe(false);
    return readFileSync(said, "utf8").trim().split("\n");
  }
  const args = (window: string) =>
    `/A b/Sondine.app --args --sondine-updated=${window}/episode/3 --sondine-update-ack=sondine-update-11111111-1111-1111-1111-111111111111`;

  it("opens it behind the others", () => {
    expect(run("closed", true)).toEqual([`open -g ${args("closed")}`]);
  });

  it("in front when it was in front", () => {
    expect(run("front", true)).toEqual([`open ${args("front")}`]);
  });

  it("tries three times without core's word, then says it and offers the page", () => {
    const said = run("behind", false);
    expect(said.slice(0, 3)).toEqual(Array(3).fill(`open -g ${args("behind")}`));
    expect(said[3]).toMatch(/^alert/u);
    expect(said.slice(4)).toEqual(["open https://page"]);
  });

  it("is a script sh reads", () => {
    execFileSync("/bin/sh", ["-n", "-c", RELAUNCH_SCRIPT]);
  });
});

describe("the last look at the signature", () => {
  it.skipIf(process.platform !== "darwin")("refuses an unsigned app", () => {
    expect(stillSigned(app)).toBe(false);
  });
});
