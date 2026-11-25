import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDataDir, type TempDataDir } from "../../../test/support";
import { hostStates, installHosts, manifestFor, removeHosts } from "./native-hosts";

let data: TempDataDir;
let support: string;
beforeEach(() => {
  data = tempDataDir();
  support = join(data.dir, "Application Support");
  // Yab and Helium were opened here; Chrome was not.
  mkdirSync(join(support, "Yab", "Chromium"), { recursive: true });
  mkdirSync(join(support, "net.imput.helium"), { recursive: true });
});
afterEach(() => data.cleanup());

const RELAY = "/Applications/Sondine Exp.app/Contents/Helpers/sondine-browser";
const manifest = (root: string) =>
  join(support, root, "NativeMessagingHosts", "app.sondine.browser.json");

describe("native host manifests", () => {
  it("name the relay and the extension, for the browsers installed here only", () => {
    const install = { supportDir: support, relayPath: RELAY, socket: null };
    expect(installHosts(install)).toHaveLength(2);
    const written: unknown = JSON.parse(readFileSync(manifest("Yab/Chromium"), "utf8"));
    expect(written).toEqual({
      name: "app.sondine.browser",
      description: "Sondine: which tab plays sound, kept on this Mac",
      path: RELAY,
      type: "stdio",
      allowed_origins: ["chrome-extension://nnieeegenbmpfllllldjpkolkldjmmdb/"],
    });
    expect(readFileSync(manifest("net.imput.helium"), "utf8")).toBe(manifestFor(RELAY));
    expect(existsSync(join(support, "Google", "Chrome"))).toBe(false);
    expect(hostStates(install)).toEqual([
      { bundleId: "dev.serafim.fast", name: "Yab", installed: true },
      { bundleId: "net.imput.helium", name: "Helium", installed: true },
    ]);
  });

  it("start the debug relay through a wrapper that gives it the socket", () => {
    const runDir = join(data.dir, "run");
    const install = {
      supportDir: support,
      relayPath: "/repo/native/.build/debug/sondine-browser",
      socket: { path: join(runDir, "browser.sock"), runDir },
    };
    installHosts(install);
    const wrapper = join(runDir, "sondine-browser-host");
    expect(readFileSync(wrapper, "utf8")).toBe(
      `#!/bin/sh\nexec '/repo/native/.build/debug/sondine-browser' "$@" --socket '${runDir}/browser.sock'\n`,
    );
    expect(statSync(wrapper).mode & 0o777).toBe(0o700);
    const written = JSON.parse(readFileSync(manifest("net.imput.helium"), "utf8")) as {
      path: string;
    };
    expect(written.path).toBe(wrapper);
  });

  it("go away with the link, and leave other apps' manifests alone", () => {
    const install = { supportDir: support, relayPath: RELAY, socket: null };
    installHosts(install);
    const other = join(support, "Yab", "Chromium", "NativeMessagingHosts", "so.pond.host.json");
    writeFileSync(other, JSON.stringify({ name: "so.pond.host" }));
    expect(removeHosts(install)).toBe(2);
    expect(existsSync(manifest("Yab/Chromium"))).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(hostStates(install).map((state) => state.installed)).toEqual([false, false]);
  });

  it("stay when another Sondine that is still there wrote them", () => {
    const installedRelay = join(data.dir, "installed-relay");
    writeFileSync(installedRelay, "");
    const installed = { supportDir: support, relayPath: installedRelay, socket: null };
    const development = {
      supportDir: support,
      relayPath: join(data.dir, "debug-relay"),
      socket: { path: join(data.dir, "browser.sock"), runDir: join(data.dir, "run") },
    };
    installHosts(installed);
    // Started with the link off, as a fresh development build is.
    expect(removeHosts(development)).toBe(0);
    expect(hostStates(installed).map((state) => state.installed)).toEqual([true, true]);
    // Its own go, and those of a Sondine no longer there.
    installHosts(development);
    expect(removeHosts(installed)).toBe(0);
    expect(removeHosts(development)).toBe(2);
    installHosts(installed);
    rmSync(installedRelay);
    expect(removeHosts(development)).toBe(2);
  });

  it("write only the test folder a development build is given", () => {
    const only = join(data.dir, "profile", "NativeMessagingHosts");
    installHosts({ supportDir: support, relayPath: RELAY, socket: null, onlyDirs: [only] });
    expect(existsSync(join(only, "app.sondine.browser.json"))).toBe(true);
    expect(existsSync(manifest("Yab/Chromium"))).toBe(false);
  });
});
