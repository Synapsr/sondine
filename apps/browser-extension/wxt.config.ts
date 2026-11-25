// WXT builds the extension: one classic script per entry in entrypoints/, the
// manifest for each browser, and the store zips. Its hooks add the locales
// and icons, and check every script once built (scripts/).
// `pnpm build` → dist/chrome-mv3, `pnpm build:firefox` → dist/firefox-mv3,
// `pnpm zip` → dist/*.zip, built in dist/<browser>-mv3-store.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";
import { generatedAssets } from "./scripts/assets.ts";
import { checkBundles } from "./scripts/check-bundles.ts";
import { manifest, STORE_MODE } from "./scripts/manifest.ts";

const packageDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  // Each module imports what it uses.
  imports: false,
  // Firefox too: WXT would build it as MV2.
  manifestVersion: 3,
  outDir: "dist",
  manifest,
  vite: () => ({
    // Readable output: anyone can check what the extension does.
    build: { minify: false, target: "es2022" },
    plugins: [
      {
        // The output names each module it holds by its path, WXT's own
        // entries by their absolute path: no path of this Mac ships.
        name: "sondine:relative-paths",
        renderChunk: (code: string) => code.replaceAll(packageDir, ""),
      },
    ],
  }),
  // `wxt dev` opens no browser.
  webExt: { disabled: true },
  zip: {
    name: "sondine",
    artifactTemplate: "{{name}}-{{version}}-{{browser}}.zip",
    sourcesTemplate: "{{name}}-{{version}}-sources.zip",
  },
  hooks: {
    "build:publicAssets": (wxt, files) => {
      files.push(...generatedAssets(join(wxt.config.wxtDir, "icons")));
    },
    "build:done": (wxt) => checkBundles(wxt.config.outDir),
    "zip:start": (wxt) => {
      if (wxt.config.mode !== STORE_MODE) {
        throw new Error(
          `Store zips build with --mode ${STORE_MODE}, without the key: run pnpm zip.`,
        );
      }
    },
  },
});
