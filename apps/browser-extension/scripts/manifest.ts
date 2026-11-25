import type { ConfigEnv, UserManifest } from "wxt";

/**
 * The extension's public key (no private key exists in the repository). It
 * pins the unpacked build's id, which Sondine's native host manifest allows.
 * The stores refuse a key: their builds go without it and get the store's id.
 */
export const EXTENSION_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvfobYsyKfZxbiwcrYwRIGV8Jor995DTnIyLSKVpG9KBYR3Wj3M0JDliLVHSXU0/vp1AQjG9xpB1OjflAkZgonpuWgU171mB8oAbH//VpILxyVLg+voPVXOQe5dQrG8PaHEa697Xj+oD1F2P5Jc16heeg/vBW/J/7bONxuIPKquXqF6N0wWGIqUDFCZTTkbnLH0s24p+pDvSCFPPFuk7nz/n2J7ClI8mpGMuJlNkU8VnFmOIZsDWdwjUW1uKcsPJ3swhEEJrWU+8J9U1HOs1iBVxTDEj3BvzbyB6SEcTdQwsVYzld4w102g6L/1LaktWotEUIiIYtsM/XZhU819oLiwIDAQAB";
export const EXTENSION_ID = "nnieeegenbmpfllllldjpkolkldjmmdb";
/** The extension's id in Firefox, for its native host manifest's `allowed_extensions`. */
export const FIREFOX_ID = "browser@sondine.app";

/** The mode `pnpm zip` builds in: what the stores receive, without the key. */
export const STORE_MODE = "store";

export const ICON_SIZES = [16, 32, 48, 128] as const;

/** The strings the browser shows, in `_locales/<lang>/messages.json`. */
export const LOCALES = {
  en: {
    description: { message: "Tells Sondine, on this Mac only, which tab plays sound." },
  },
  fr: {
    description: { message: "Indique à Sondine, sur ce Mac uniquement, quel onglet joue du son." },
  },
} as const;

/**
 * The manifest's keys for one build. WXT adds the version (package.json's),
 * the background script and the content script from `entrypoints/`.
 */
export function manifest({ browser, mode }: Pick<ConfigEnv, "browser" | "mode">): UserManifest {
  return {
    name: "Sondine",
    description: "__MSG_description__",
    default_locale: "en",
    incognito: "not_allowed",
    permissions: ["tabs", "nativeMessaging", "alarms"],
    icons: Object.fromEntries(ICON_SIZES.map((size) => [String(size), `icons/${size}.png`])),
    ...(browser === "chrome" && {
      // The unpacked build Sondine ships; `pnpm zip` builds the store's without it.
      ...(mode !== STORE_MODE && { key: EXTENSION_KEY }),
      // Array#toSorted is in Chrome 110 (a native port keeps the worker alive from 105).
      minimum_chrome_version: "110",
    }),
    ...(browser === "firefox" && {
      browser_specific_settings: {
        gecko: {
          id: FIREFOX_ID,
          // The current ESR; it grants an MV3 extension its hosts at install
          // (from 127) and reads the data consent below (from 140).
          strict_min_version: "140.0",
          // What leaves the browser goes to Sondine on this Mac, never off it.
          data_collection_permissions: { required: ["none"] },
        },
      },
    }),
  };
}
