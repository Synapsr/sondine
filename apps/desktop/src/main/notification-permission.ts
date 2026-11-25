import { join } from "node:path";
import { app } from "electron";
import type { NotificationPermission } from "../shared/bridge";

// Whether macOS lets Sondine's notifications reach the screen (ADR 036), read
// through the native addon (native/notification-settings.m, built by
// scripts/build-mac.mjs). Electron asks macOS for the authorization at launch
// but never says the answer; Settings ▸ Écoute shows it, with a way to System
// Settings when it blocks them. Packaged builds only: a development build is
// not signed, so macOS has no settings for it.

interface NotificationSettingsAddon {
  readonly settings: (callback: (authorization: string, alertStyle: string) => void) => void;
}

const isAddon = (value: unknown): value is NotificationSettingsAddon =>
  typeof value === "object" &&
  value !== null &&
  "settings" in value &&
  typeof value.settings === "function";

/** What Settings says, from macOS's authorization and alert style. */
export function permissionOf(authorization: string, alertStyle: string): NotificationPermission {
  switch (authorization) {
    case "authorized":
      return alertStyle === "none" ? "silent" : "allowed";
    // Delivered quietly to Notification Center: nothing on screen.
    case "provisional":
      return "silent";
    case "denied":
    case "not-determined":
      return "blocked";
    default:
      return "unknown";
  }
}

export type ReadNotificationPermission = () => Promise<NotificationPermission>;

export function loadNotificationPermission(): ReadNotificationPermission {
  let addon: NotificationSettingsAddon | null = null;
  if (app.isPackaged) {
    const module: { exports: unknown } = { exports: {} };
    try {
      process.dlopen(module, join(process.resourcesPath, "native", "notification-settings.node"));
      if (isAddon(module.exports)) addon = module.exports;
    } catch {
      addon = null;
    }
  }
  const loaded = addon;
  if (loaded === null) return () => Promise.resolve("unknown");
  return () =>
    new Promise((resolve) => {
      try {
        loaded.settings((authorization, alertStyle) =>
          resolve(permissionOf(authorization, alertStyle)),
        );
      } catch {
        resolve("unknown");
      }
    });
}
