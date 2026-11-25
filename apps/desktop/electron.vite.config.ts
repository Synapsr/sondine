import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import { releaseNotes } from "./scripts/release-notes.mjs";
import { paraglideOptions } from "./scripts/paraglide-options.mjs";
import { developmentCsp, PRODUCTION_CSP } from "./src/shared/csp";

const root = import.meta.dirname;
const at = (path: string) => resolve(root, path);

/** Puts the renderer's Content Security Policy in its HTML (ADR 010). */
function contentSecurityPolicy(): Plugin {
  let policy = PRODUCTION_CSP;
  return {
    name: "sondine:csp",
    configureServer(server) {
      server.httpServer?.once("listening", () => {
        const url = server.resolvedUrls?.local[0];
        if (url !== undefined) policy = developmentCsp(new URL(url).origin);
      });
    },
    transformIndexHtml: {
      order: "pre",
      handler: () => [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: policy },
          injectTo: "head-prepend",
        },
      ],
    },
  };
}

/**
 * Graphical's theme editor (ADR 033), installed in the git-ignored
 * graphical/packages. Without it, the app runs alone.
 */
const EDITOR_HOST = at("../../graphical/packages/package.json");

function editorInstalled(): boolean {
  try {
    createRequire(EDITOR_HOST).resolve("@graphical/editor/analyze-styles");
    return true;
  } catch {
    return false;
  }
}

function graphicalEditor(): Plugin {
  return {
    name: "sondine:graphical-editor",
    enforce: "pre",
    resolveId(id) {
      return id.startsWith("@graphical/editor/")
        ? this.resolve(id, EDITOR_HOST, { skipSelf: true })
        : undefined;
    },
  };
}

export default defineConfig(({ command }) => {
  const development = command === "serve";
  const editor = editorInstalled();
  if (!editor) process.env["VITE_SONDINE_NO_EDITOR"] = "1";
  return {
    main: {
      // The anonymous statistics' endpoint (ADR 042), in release builds only (build-mac.mjs).
      define: {
        COMPILED_STATS_ENDPOINT: JSON.stringify(
          !development && process.env["SONDINE_RELEASE"] === "1"
            ? (process.env["SONDINE_STATS_ENDPOINT"] ?? "")
            : "",
        ),
        // Whether this app updates itself, and a test build's own feed (ADR 045).
        COMPILED_RELEASE: JSON.stringify(!development && process.env["SONDINE_RELEASE"] === "1"),
        COMPILED_UPDATE_FEED: JSON.stringify(
          !development && process.env["SONDINE_RELEASE"] !== "1"
            ? (process.env["SONDINE_UPDATE_FEED"] ?? "")
            : "",
        ),
      },
      build: {
        rolldownOptions: {
          // The core utility process is bundled through its `?modulePath` import.
          // `electron-vite dev` also builds the fake helper that SONDINE_FAKE_HELPER=1 runs.
          input: development
            ? { index: at("src/main/index.ts"), "fake-helper": at("test/fake-helper/cli.ts") }
            : { index: at("src/main/index.ts") },
        },
      },
    },
    preload: {
      build: {
        rolldownOptions: {
          input: { index: at("src/preload/index.ts") },
          // A sandboxed preload cannot load ES modules.
          output: { format: "cjs", entryFileNames: "[name].cjs" },
        },
      },
    },
    renderer: {
      root: at("src/renderer"),
      // What this version brings, for the note after an update (ADR 045).
      define: {
        RELEASE_NOTES: JSON.stringify(
          releaseNotes(
            readFileSync(at("../../CHANGELOG.md"), "utf8"),
            String(JSON.parse(readFileSync(at("package.json"), "utf8")).version),
          ),
        ),
      },
      plugins: [
        contentSecurityPolicy(),
        graphicalEditor(),
        react(),
        tailwindcss(),
        paraglideVitePlugin(paraglideOptions),
      ],
      // The editor's folder has its own React; the app's serves both.
      resolve: { dedupe: ["react", "react-dom"] },
      // Vite's dependency scan follows the editor's import even when it is off.
      optimizeDeps: editor ? {} : { exclude: ["@graphical/editor"] },
      build: {
        rolldownOptions: { input: at("src/renderer/index.html") },
      },
    },
  };
});
