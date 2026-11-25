import { execFile } from "node:child_process";
import { basename, join } from "node:path";
import { app, dialog, type BrowserWindow, type OpenDialogOptions } from "electron";
import type { PickedApp } from "../shared/bridge";

// « Ajouter une app… » in Settings ▸ Dictées: an open panel on
// /Applications, limited to apps; the chosen bundle's ID (from its
// Info.plist) and its name as Finder shows it. Nothing else is read.

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const NAME_MAX = 120;

function bundleIdAt(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/plutil",
      ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(path, "Contents", "Info.plist")],
      { timeout: 3_000, encoding: "utf8" },
      (error, stdout) => {
        const bundleId = stdout.trim();
        resolve(error === null && BUNDLE_ID.test(bundleId) ? bundleId : null);
      },
    );
  });
}

/** The app the user chose, or null when the panel was closed or the bundle has no ID. */
export async function pickApp(
  window: BrowserWindow | null,
  message: string,
): Promise<PickedApp | null> {
  const options: OpenDialogOptions = {
    properties: ["openFile"],
    message,
    defaultPath: "/Applications",
    filters: [{ name: "Applications", extensions: ["app"] }],
  };
  app.focus({ steal: true });
  const parent = window !== null && !window.isDestroyed() && window.isVisible() ? window : null;
  const result =
    parent === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(parent, options);
  const path = result.canceled ? undefined : result.filePaths[0];
  if (path === undefined || !path.endsWith(".app")) return null;
  const bundleId = await bundleIdAt(path);
  if (bundleId === null) return null;
  return { bundleId, name: basename(path, ".app").slice(0, NAME_MAX) };
}
