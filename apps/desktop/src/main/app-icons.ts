import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { app, nativeImage } from "electron";
import { iconTarget, type AppIconRef } from "./app-icon-ref";

// App icons for the window (episodes, calls, media, the memory bar): the
// window names an app by bundle ID, or by its bundle's path; main finds the
// app (Spotlight, for a bundle ID) and hands back its icon as a PNG data URL,
// which the page's CSP allows. Nothing leaves the Mac; answers are cached.

/** Icon edge in pixels: 16 pt rows at 2× and the larger 32 pt spots. */
const ICON_PX = 64;
const CACHE_MAX = 300;

const cache = new Map<string, Promise<string | null>>();

function run(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: 3_000, encoding: "utf8" }, (error, stdout) =>
      resolve(error === null ? stdout : ""),
    );
  });
}

/** Where an app with this bundle ID is installed; the system's and /Applications first. */
async function appPathOf(bundleId: string): Promise<string | null> {
  const found = (await run("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == "${bundleId}"`]))
    .split("\n")
    .filter((path) => path.endsWith(".app"));
  const rank = (path: string) =>
    path.startsWith("/System/Applications/") ? 0 : path.startsWith("/Applications/") ? 1 : 2;
  return found.toSorted((a, b) => rank(a) - rank(b))[0] ?? null;
}

async function iconAt(path: string): Promise<string | null> {
  try {
    if (!(await stat(path)).isDirectory()) return null;
    const thumbnail = await nativeImage
      .createThumbnailFromPath(path, { width: ICON_PX, height: ICON_PX })
      .catch(() => app.getFileIcon(path, { size: "normal" }));
    return thumbnail.isEmpty() ? null : thumbnail.toDataURL();
  } catch {
    return null;
  }
}

/** The icon a request names, as a PNG data URL; null for an app not found. */
export function appIcon(ref: AppIconRef): Promise<string | null> {
  const target = iconTarget(ref);
  if (target === null) return Promise.resolve(null);
  const key = "bundleId" in target ? `id:${target.bundleId}` : `path:${target.appPath}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const answer = (async () => {
    const path = "bundleId" in target ? await appPathOf(target.bundleId) : target.appPath;
    return path === null ? null : iconAt(path);
  })();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value ?? "");
  cache.set(key, answer);
  return answer;
}
