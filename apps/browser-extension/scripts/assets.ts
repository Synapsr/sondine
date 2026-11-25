// The files a build adds beside the bundles (WXT's `build:publicAssets`
// hook): the locales, and icons cut from the desktop app's icon with macOS's
// iconutil and sips.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedPublicFile } from "wxt";
import { ICON_SIZES, LOCALES } from "./manifest.ts";

const appIcon = fileURLToPath(new URL("../../desktop/build/icon.icns", import.meta.url));

/** An iconset's images by pixel size, as iconutil writes them. */
const ICONSET = [
  [16, "icon_16x16.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_256x256.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
] as const;

/** The locales and the icons, cut into `iconsDir`, as files for the build to add. */
export function generatedAssets(iconsDir: string): ResolvedPublicFile[] {
  writeIcons(iconsDir);
  return [
    ...Object.entries(LOCALES).map(([lang, messages]) => ({
      relativeDest: `_locales/${lang}/messages.json`,
      contents: `${JSON.stringify(messages, null, 2)}\n`,
    })),
    ...ICON_SIZES.map((size) => ({
      relativeDest: `icons/${size}.png`,
      absoluteSrc: join(iconsDir, `${size}.png`),
    })),
  ];
}

function writeIcons(iconsDir: string): void {
  mkdirSync(iconsDir, { recursive: true });
  const temp = mkdtempSync(join(tmpdir(), "sondine-extension-"));
  try {
    const iconset = join(temp, "icon.iconset");
    execFileSync("iconutil", ["--convert", "iconset", appIcon, "--output", iconset]);
    for (const size of ICON_SIZES) {
      // The smallest drawn size that covers this one: copied when equal, else scaled down.
      const source = ICONSET.find(([pixels]) => pixels >= size);
      if (source === undefined) throw new Error(`No ${size}px source in the app icon`);
      const [pixels, file] = source;
      const from = join(iconset, file);
      const to = join(iconsDir, `${size}.png`);
      if (pixels === size) copyFileSync(from, to);
      else {
        execFileSync("sips", ["--resampleHeightWidth", `${size}`, `${size}`, from, "--out", to], {
          stdio: "ignore",
        });
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
