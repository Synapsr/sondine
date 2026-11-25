import { join } from "node:path";
import { app } from "electron";

// The native addon (native/group-container.m, built by scripts/build-mac.mjs)
// through which main asks macOS for the app group container. An unsandboxed
// app may enter its container only after that request (ADR 013). Packaged
// builds only: development never touches the container.

export interface GroupContainerAccess {
  /** The container path. The request authorizes this process and its children. */
  readonly groupContainerPath: (groupId: string) => string | null;
  /** The team that signed this process; null when unsigned or ad-hoc signed. */
  readonly teamIdentifier: () => string | null;
}

const isGroupContainerAccess = (value: unknown): value is GroupContainerAccess =>
  typeof value === "object" &&
  value !== null &&
  "groupContainerPath" in value &&
  typeof value.groupContainerPath === "function" &&
  "teamIdentifier" in value &&
  typeof value.teamIdentifier === "function";

export function loadGroupContainerAccess(): GroupContainerAccess | null {
  if (!app.isPackaged) return null;
  const addon: { exports: unknown } = { exports: {} };
  try {
    process.dlopen(addon, join(process.resourcesPath, "native", "group-container.node"));
  } catch {
    return null;
  }
  return isGroupContainerAccess(addon.exports) ? addon.exports : null;
}
