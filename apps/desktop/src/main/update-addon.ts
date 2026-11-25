import { join } from "node:path";
import { app } from "electron";
import type { MainToCore } from "../shared/core-messages";

// The native addon of updates (native/update.m, built by scripts/build-mac.mjs,
// ADR 045). Packaged builds only: a development build never updates itself.

type Network = Extract<MainToCore, { type: "network" }>["network"];

export interface UpdateAddon {
  /** Exchanges two paths of one volume in one step: 0, or errno. */
  readonly swap: (a: string, b: string) => number;
  readonly network: () => Network;
}

interface Exports {
  readonly swap: (a: string, b: string) => unknown;
  readonly network: () => unknown;
}

const isAddon = (value: unknown): value is Exports =>
  typeof value === "object" &&
  value !== null &&
  "swap" in value &&
  typeof value.swap === "function" &&
  "network" in value &&
  typeof value.network === "function";

export function loadUpdateAddon(): UpdateAddon | null {
  if (!app.isPackaged) return null;
  const addon: { exports: unknown } = { exports: {} };
  try {
    process.dlopen(addon, join(process.resourcesPath, "native", "update.node"));
  } catch {
    return null;
  }
  const loaded = addon.exports;
  if (!isAddon(loaded)) return null;
  return {
    swap: (a, b) => {
      const result = loaded.swap(a, b);
      return typeof result === "number" ? result : -1;
    },
    network: () => {
      const kind = loaded.network();
      return kind === "free" || kind === "metered" || kind === "offline" ? kind : "unknown";
    },
  };
}
