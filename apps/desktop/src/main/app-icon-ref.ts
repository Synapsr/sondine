import { isAbsolute, normalize } from "node:path";
import type { AppIconRef } from "../shared/bridge";

export type { AppIconRef };

// What the window may ask main an icon for: a bundle ID, or an app bundle's
// own absolute path. Anything else is refused before main looks at the disk.

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/** The bundle a request names, or null when it names none Sondine should look at. */
export function iconTarget(ref: unknown): AppIconRef | null {
  if (typeof ref !== "object" || ref === null) return null;
  const { bundleId, appPath } = ref as Record<string, unknown>;
  if (typeof bundleId === "string") return BUNDLE_ID.test(bundleId) ? { bundleId } : null;
  if (typeof appPath === "string") {
    return isAbsolute(appPath) && normalize(appPath) === appPath && appPath.endsWith(".app")
      ? { appPath }
      : null;
  }
  return null;
}
