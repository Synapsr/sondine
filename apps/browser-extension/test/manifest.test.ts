import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BrowserMessage } from "@sondine/protocol";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import {
  EXTENSION_ID,
  EXTENSION_KEY,
  FIREFOX_ID,
  ICON_SIZES,
  LOCALES,
} from "../scripts/manifest.ts";
import { YOUTUBE_HOSTS } from "../src/youtube-state.ts";
import { builtFolder, readBuiltJson, SCRIPTS } from "./bundled.ts";
import { BUILDS } from "./global-setup.ts";

/** Chrome's extension id: the key's SHA-256, its first 32 hex digits written a to p. */
function extensionId(key: string): string {
  const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
}

const manifests = BUILDS.map(({ name }) => ({
  name,
  manifest: readBuiltJson(name, "manifest.json"),
}));
const unpacked = readBuiltJson("unpacked", "manifest.json");
const chromeStore = readBuiltJson("chromeStore", "manifest.json");
const firefoxStore = readBuiltJson("firefoxStore", "manifest.json");

describe("manifest", () => {
  it("pins the id Sondine's native host allows, in the unpacked build only", () => {
    expect(extensionId(EXTENSION_KEY)).toBe(EXTENSION_ID);
    expect(unpacked).toHaveProperty("key", EXTENSION_KEY);
    expect(chromeStore).not.toHaveProperty("key");
    expect(firefoxStore).not.toHaveProperty("key");
  });

  it("gives the Chrome Web Store the unpacked build without its key", () => {
    const { key: _, ...withoutKey } = unpacked;
    expect(chromeStore).toEqual(withoutKey);
  });

  it("asks for tabs, native messaging and alarms only, and no host", () => {
    for (const { manifest } of manifests) {
      expect(manifest.manifest_version).toBe(3);
      expect(manifest.permissions).toEqual(["tabs", "nativeMessaging", "alarms"]);
      expect(manifest).not.toHaveProperty("host_permissions");
      expect(manifest).not.toHaveProperty("optional_permissions");
      expect(manifest).not.toHaveProperty("externally_connectable");
      expect(manifest).not.toHaveProperty("web_accessible_resources");
      expect(manifest).not.toHaveProperty("content_security_policy");
      expect(manifest).not.toHaveProperty("commands");
      expect(manifest.incognito).toBe("not_allowed");
    }
  });

  it("runs a classic background script, YouTube's script there, and the page script elsewhere", () => {
    expect(unpacked.background).toEqual({ service_worker: SCRIPTS.background });
    expect(firefoxStore.background).toEqual({ scripts: [SCRIPTS.background] });
    // WXT sorts them.
    const youtube = YOUTUBE_HOSTS.map((host) => `https://${host}/*`).toSorted();
    for (const { manifest } of manifests) {
      expect(manifest.content_scripts).toEqual([
        {
          // Every web page's top frame (ADR 023, 2026-11-10 night: Téo's yes).
          matches: ["http://*/*", "https://*/*"],
          exclude_matches: youtube,
          js: [SCRIPTS.pages],
          run_at: "document_idle",
        },
        { matches: youtube, js: [SCRIPTS.youtube], run_at: "document_idle" },
      ]);
    }
  });

  it("names Sondine's Firefox id, and the Chrome version it needs elsewhere", () => {
    expect(firefoxStore.browser_specific_settings).toEqual({
      gecko: {
        id: FIREFOX_ID,
        strict_min_version: "140.0",
        data_collection_permissions: { required: ["none"] },
      },
    });
    expect(firefoxStore).not.toHaveProperty("minimum_chrome_version");
    expect(unpacked.minimum_chrome_version).toBe("110");
    expect(unpacked).not.toHaveProperty("browser_specific_settings");
  });

  it("has a version Chrome and the protocol's hello accept", () => {
    expect(packageJson.version).toMatch(/^\d{1,5}(\.\d{1,5}){0,3}$/);
    const hello = { type: "hello", extension: packageJson.version };
    expect(BrowserMessage.safeParse(hello).success).toBe(true);
    for (const { manifest } of manifests) {
      expect(manifest.name).toBe("Sondine");
      expect(manifest.version).toBe(packageJson.version);
      expect(manifest).not.toHaveProperty("version_name");
    }
  });

  it("describes itself in English and French, within Chrome's 132 characters", () => {
    expect(Object.keys(LOCALES)).toEqual(["en", "fr"]);
    for (const messages of Object.values(LOCALES)) {
      expect(messages.description.message.length).toBeLessThanOrEqual(132);
    }
    for (const { name, manifest } of manifests) {
      expect(manifest.description).toBe("__MSG_description__");
      expect(manifest.default_locale).toBe("en");
      for (const [lang, messages] of Object.entries(LOCALES)) {
        expect(readBuiltJson(name, `_locales/${lang}/messages.json`)).toEqual(messages);
      }
    }
  });

  it("carries its icons", () => {
    for (const { name, manifest } of manifests) {
      expect(manifest.icons).toEqual(
        Object.fromEntries(ICON_SIZES.map((size) => [String(size), `icons/${size}.png`])),
      );
      for (const size of ICON_SIZES) {
        expect(existsSync(join(builtFolder(name), "icons", `${size}.png`))).toBe(true);
      }
    }
  });
});
