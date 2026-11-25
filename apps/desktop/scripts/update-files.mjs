// The two files an update needs beside the disk image (ADR 045): the app in a
// zip, and the small file that names its version, size and sha256.
// `build-mac.mjs --release` writes them from the notarized, stapled app, and
// checks them back from what it wrote; publishing both in the release is what
// makes a version installable. A test build (`SONDINE_UPDATE_FEED`) has them
// too, from an app Apple never saw.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPDATE_REQUIREMENT } from "../src/shared/update-requirement.ts";
import { UPDATE_FEED_NAME, updateArchiveName, UpdateFeed } from "../src/shared/updates.ts";

const plist = (app, key) =>
  execFileSync("plutil", ["-extract", key, "raw", "-o", "-", `${app}/Contents/Info.plist`], {
    encoding: "utf8",
  }).trim();

const cdHash = (app) =>
  /^CDHash=([0-9a-f]+)$/mu.exec(
    spawnSync("codesign", ["-dv", "--verbose=4", app], { encoding: "utf8" }).stderr,
  )?.[1] ?? null;

/** Writes the archive and the file in `out` from `app`; returns their paths. */
export function writeUpdateFiles(app, out) {
  const version = plist(app, "CFBundleShortVersionString");
  const archive = join(out, updateArchiveName(version));
  const feedPath = join(out, UPDATE_FEED_NAME);
  rmSync(archive, { force: true });
  rmSync(feedPath, { force: true });
  // Finder's own format: the bundle's links and its signature are kept.
  execFileSync("ditto", ["-c", "-k", "--keepParent", app, archive]);
  const bytes = readFileSync(archive);
  const feed = UpdateFeed.parse({
    format: "sondine-update",
    formatVersion: 1,
    version,
    minimumMacos: plist(app, "LSMinimumSystemVersion"),
    archive: {
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  });
  writeFileSync(feedPath, `${JSON.stringify(feed, null, 2)}\n`);
  return { archive, feed: feedPath };
}

/**
 * Reads the two files back as an installed Sondine will: `check(ok, message)`
 * for each thing it needs. `notarized`: a release's app, stapled.
 */
export function checkUpdateFiles(app, out, { notarized, check }) {
  const version = plist(app, "CFBundleShortVersionString");
  const parsed = UpdateFeed.safeParse(
    JSON.parse(readFileSync(join(out, UPDATE_FEED_NAME), "utf8")),
  );
  check(parsed.success, `${UPDATE_FEED_NAME} is a feed Sondine reads`);
  if (!parsed.success) return;
  const feed = parsed.data;
  check(feed.version === version, `${UPDATE_FEED_NAME} names ${version}`);
  check(
    feed.minimumMacos === plist(app, "LSMinimumSystemVersion"),
    `${UPDATE_FEED_NAME} names the app's minimum macOS`,
  );
  const archive = join(out, updateArchiveName(version));
  const bytes = readFileSync(archive);
  check(
    bytes.byteLength === feed.archive.sizeBytes &&
      createHash("sha256").update(bytes).digest("hex") === feed.archive.sha256,
    "the archive has the size and sha256 announced",
  );
  const unpacked = mkdtempSync(join(tmpdir(), "sondine-update-check-"));
  try {
    execFileSync("ditto", ["-x", "-k", archive, unpacked]);
    const names = readdirSync(unpacked);
    check(names.length === 1 && names[0] === "Sondine.app", "the archive is one Sondine.app");
    const copy = join(unpacked, "Sondine.app");
    const ok = (command, args) => spawnSync(command, args, { encoding: "utf8" }).status === 0;
    check(
      ok("codesign", ["--verify", "--deep", "--strict", `-R=${UPDATE_REQUIREMENT}`, copy]),
      "the archive's app is signed as installed Sondines require",
    );
    check(cdHash(copy) !== null && cdHash(copy) === cdHash(app), "it is the app just built");
    if (notarized) {
      check(
        ok("codesign", ["--verify", "-R=notarized", copy]) &&
          ok("xcrun", ["stapler", "validate", copy]),
        "the archive's app is notarized and stapled",
      );
    }
  } finally {
    rmSync(unpacked, { recursive: true, force: true });
  }
}
