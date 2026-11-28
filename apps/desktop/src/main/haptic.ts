import { join } from "node:path";
import { app } from "electron";

// The haptic addon (native/haptic.m, built by scripts/build-mac.mjs): a light
// tap of the trackpad, felt only with a finger on it while Sondine is
// active. Packaged builds only: in development the tap does nothing.

interface HapticAddon {
  readonly tap: () => void;
}

const isAddon = (value: unknown): value is HapticAddon =>
  typeof value === "object" && value !== null && "tap" in value && typeof value.tap === "function";

/** Taps the trackpad, or does nothing where the addon is not there. */
export function loadHaptic(): () => void {
  if (!app.isPackaged) return () => {};
  const addon: { exports: unknown } = { exports: {} };
  try {
    process.dlopen(addon, join(process.resourcesPath, "native", "haptic.node"));
  } catch {
    return () => {};
  }
  const loaded = addon.exports;
  return isAddon(loaded) ? () => loaded.tap() : () => {};
}
