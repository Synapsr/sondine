import { execFile } from "node:child_process";

// Which of a few known apps are installed on this Mac, by bundle ID, through
// Spotlight (`mdfind`), as main finds an app's icon. Answers are kept a
// minute: Settings asks each time it opens.

const MDFIND = "/usr/bin/mdfind";
const KEEP_MS = 60_000;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

const known = new Map<string, { readonly installed: boolean; readonly atMs: number }>();

function found(bundleId: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      MDFIND,
      [`kMDItemCFBundleIdentifier == "${bundleId}"`],
      { timeout: 2_000, encoding: "utf8" },
      (error, stdout) =>
        resolve(error === null && stdout.split("\n").some((line) => line.endsWith(".app"))),
    );
  });
}

/** The bundle IDs among `bundleIds` that some app on this Mac has. */
export async function installedApps(
  bundleIds: readonly string[],
  nowMs: number = Date.now(),
): Promise<ReadonlySet<string>> {
  const answers = await Promise.all(
    bundleIds.map(async (bundleId) => {
      if (!BUNDLE_ID.test(bundleId)) return null;
      const cached = known.get(bundleId);
      if (cached !== undefined && nowMs - cached.atMs < KEEP_MS) {
        return cached.installed ? bundleId : null;
      }
      const installed = await found(bundleId);
      known.set(bundleId, { installed, atMs: nowMs });
      return installed ? bundleId : null;
    }),
  );
  return new Set(answers.filter((bundleId): bundleId is string => bundleId !== null));
}
