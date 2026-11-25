import type { ModelsStatus } from "@sondine/api";
import { useSyncExternalStore } from "react";

// Development only (Téo, 2026-11-19): pretend this Mac has 16 GB and no
// transcription model, to see the first run and Settings as a Mac too small
// for the local model shows them (ADR 037). Kept in this window's storage;
// production builds fold `import.meta.env.DEV` to false and never read it.

const KEY = "sondine.dev.small-mac";
const CHANGED = "sondine:dev-small-mac";
const SMALL_MAC_BYTES = 16 * 1024 ** 3;

function read(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setSmallMac(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // Storage refused: the simulation simply stays as it was.
  }
  window.dispatchEvent(new Event(CHANGED));
}

export function useSmallMac(): boolean {
  return useSyncExternalStore((onChange) => {
    window.addEventListener(CHANGED, onChange);
    return () => window.removeEventListener(CHANGED, onChange);
  }, read);
}

/** The models as a small Mac without the transcription model would see them. */
export function asSmallMac(status: ModelsStatus): ModelsStatus {
  return {
    ...status,
    memoryBytes: SMALL_MAC_BYTES,
    artifacts: status.artifacts.map((artifact) =>
      artifact.role === "final"
        ? { ...artifact, phase: "missing", progress: null, partialBytes: 0 }
        : artifact,
    ),
  };
}
