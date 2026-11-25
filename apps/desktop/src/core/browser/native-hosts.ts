import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_HOST_NAME } from "@sondine/protocol";
import { shellQuote } from "../agents/agent-services";

// Where browsers look for Sondine's native messaging host (ADR 023): a JSON
// manifest named after the host, in each browser's NativeMessagingHosts
// folder, naming the relay and the extension allowed to start it. Sondine
// writes it while the browser link is on, only for browsers installed here,
// and takes it back when the link is turned off.

/**
 * The extension ids allowed to start the relay: the unpacked extension's
 * (pinned by the public key in its manifest). The Chrome Web Store's joins
 * it once the extension is published there.
 */
export const EXTENSION_IDS: readonly string[] = ["nnieeegenbmpfllllldjpkolkldjmmdb"];

/** A Chromium browser, or one that reads Chromium's host manifests (Yab). */
export interface KnownBrowser {
  readonly bundleId: string;
  readonly name: string;
  /** Its profile folder under `~/Library/Application Support`: present when it is installed and was opened. */
  readonly root: string;
}

/**
 * Yab reads its own folder and adopts the manifests it finds in the other
 * browsers'; every other browser reads only its own.
 */
export const KNOWN_BROWSERS: readonly KnownBrowser[] = [
  { bundleId: "dev.serafim.fast", name: "Yab", root: "Yab/Chromium" },
  { bundleId: "net.imput.helium", name: "Helium", root: "net.imput.helium" },
  { bundleId: "com.google.Chrome", name: "Google Chrome", root: "Google/Chrome" },
  { bundleId: "org.chromium.Chromium", name: "Chromium", root: "Chromium" },
  { bundleId: "company.thebrowser.Browser", name: "Arc", root: "Arc/User Data" },
  { bundleId: "com.brave.Browser", name: "Brave", root: "BraveSoftware/Brave-Browser" },
  { bundleId: "com.microsoft.edgemac", name: "Microsoft Edge", root: "Microsoft Edge" },
  { bundleId: "com.vivaldi.Vivaldi", name: "Vivaldi", root: "Vivaldi" },
];

const MANIFEST_FILE = `${BROWSER_HOST_NAME}.json`;
/** The development wrapper that gives the debug relay its socket. */
const DEV_WRAPPER = "sondine-browser-host";

export interface HostInstall {
  /** `~/Library/Application Support`, or a test folder holding browser profiles. */
  readonly supportDir: string;
  /** The relay a browser starts. */
  readonly relayPath: string;
  /** Development: the relay needs `--socket`, given by a wrapper script in `runDir`. */
  readonly socket: { readonly path: string; readonly runDir: string } | null;
  /**
   * Development tests: write the manifest in these folders only, so a
   * development build never replaces the installed app's in real browsers.
   */
  readonly onlyDirs?: readonly string[];
}

export interface BrowserHostState {
  readonly bundleId: string;
  readonly name: string;
  /** Sondine's manifest is in its folder and starts this build's relay. */
  readonly installed: boolean;
}

function hostsDir(supportDir: string, browser: KnownBrowser): string {
  return join(supportDir, browser.root, "NativeMessagingHosts");
}

function targets(install: Pick<HostInstall, "supportDir" | "onlyDirs">): string[] {
  if (install.onlyDirs !== undefined) return [...install.onlyDirs];
  return KNOWN_BROWSERS.filter((browser) => existsSync(join(install.supportDir, browser.root))).map(
    (browser) => hostsDir(install.supportDir, browser),
  );
}

/** What this build's manifests name: the relay, or in development its wrapper. */
const expectedPath = (install: HostInstall) =>
  install.socket === null ? install.relayPath : join(install.socket.runDir, DEV_WRAPPER);

/** The same, the wrapper written. */
function hostPath(install: HostInstall): string {
  if (install.socket === null) return install.relayPath;
  const wrapper = expectedPath(install);
  mkdirSync(install.socket.runDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    wrapper,
    // The browser's arguments first: the relay reads the extension's origin as the first one.
    `#!/bin/sh\nexec ${shellQuote(install.relayPath)} "$@" --socket ${shellQuote(install.socket.path)}\n`,
    { mode: 0o700 },
  );
  chmodSync(wrapper, 0o700);
  return wrapper;
}

export function manifestFor(path: string): string {
  return `${JSON.stringify(
    {
      name: BROWSER_HOST_NAME,
      description: "Sondine: which tab plays sound, kept on this Mac",
      path,
      type: "stdio",
      allowed_origins: EXTENSION_IDS.map((id) => `chrome-extension://${id}/`),
    },
    null,
    2,
  )}\n`;
}

/** Writes the manifest for every browser installed here; returns the folders written. */
export function installHosts(install: HostInstall): string[] {
  const text = manifestFor(hostPath(install));
  const written: string[] = [];
  for (const dir of targets(install)) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, MANIFEST_FILE);
    if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
    written.push(dir);
  }
  return written;
}

/**
 * Takes this build's manifest back from every browser's folder, and one left
 * by a Sondine that is gone. Others' manifests stay, another Sondine's
 * included: a development build starting with the link off never cuts the
 * installed app's.
 */
export function removeHosts(install: HostInstall): number {
  let removed = 0;
  const own = expectedPath(install);
  const dirs =
    install.onlyDirs ?? KNOWN_BROWSERS.map((browser) => hostsDir(install.supportDir, browser));
  for (const dir of dirs) {
    const file = join(dir, MANIFEST_FILE);
    if (!existsSync(file)) continue;
    try {
      const value: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (typeof value !== "object" || value === null || !("name" in value)) continue;
      if (value.name !== BROWSER_HOST_NAME) continue;
      const path = "path" in value && typeof value.path === "string" ? value.path : null;
      if (path !== null && path !== own && existsSync(path)) continue;
    } catch {
      continue;
    }
    unlinkSync(file);
    removed += 1;
  }
  return removed;
}

/** The browsers installed here, and whether each can start this build's relay. */
export function hostStates(install: HostInstall): BrowserHostState[] {
  const expected = expectedPath(install);
  return KNOWN_BROWSERS.filter((browser) => existsSync(join(install.supportDir, browser.root))).map(
    (browser) => {
      const file = join(hostsDir(install.supportDir, browser), MANIFEST_FILE);
      let installed = false;
      try {
        const value: unknown = JSON.parse(readFileSync(file, "utf8"));
        installed =
          typeof value === "object" && value !== null && "path" in value && value.path === expected;
      } catch {
        installed = false;
      }
      return { bundleId: browser.bundleId, name: browser.name, installed };
    },
  );
}
