// Graphical style analysis of the desktop renderer and the shared UI package.
// Run from the repository root: node graphical/install/analyze-styles.mjs
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// The editor is installed in the git-ignored graphical/packages (ADR 033).
const editor = createRequire(new URL("../packages/package.json", import.meta.url));
const { analyzeAppStyles } = await import(
  pathToFileURL(editor.resolve("@graphical/editor/analyze-styles")).href
);

// Class lists the analyzer cannot follow, converted by hand with the install
// report's table and reviewed. The analyzer resolves only relative imports, so
// cn from "@sondine/ui" is opaque to it, and packages/ui's own cn wraps an
// extended tailwind-merge rather than a plain twMerge. menu.tsx passes its
// trailing classes both to a className and to cn, which reads as data.
// A line that moves after an edit asks for review again.
const reviewed = new Map([
  ["apps/desktop/src/renderer/components/chat/chat-screen.tsx", [188, 297]],
  [
    "apps/desktop/src/renderer/components/episode/context-strip.tsx",
    [216, 377, 436, 451, 464, 536],
  ],
  ["apps/desktop/src/renderer/components/episode/transcript.tsx", [456, 825, 842, 877]],
  ["apps/desktop/src/renderer/components/episode/voice-name.tsx", [124]],
  ["apps/desktop/src/renderer/components/player/speech-scrubber.tsx", [76, 87, 99]],
  ["apps/desktop/src/renderer/components/search/search-screen.tsx", [425, 450, 480]],
  ["apps/desktop/src/renderer/components/shell/app-icon.tsx", [29, 34, 60]],
  ["apps/desktop/src/renderer/components/shell/app-sidebar.tsx", [79, 42, 109]],
  ["apps/desktop/src/renderer/components/shell/listening-banner.tsx", [94]],
  ["apps/desktop/src/renderer/components/shell/listening-panel.tsx", [80, 127, 218]],
  ["apps/desktop/src/renderer/components/status/memory-bar.tsx", [46, 65]],
  ["apps/desktop/src/renderer/components/today/ongoing.tsx", [106]],
  ["apps/desktop/src/renderer/components/welcome/welcome-screen.tsx", [54]],
  ["packages/ui/src/lib/cn.ts", [114]],
  ["packages/ui/src/components/menu.tsx", [69]],
]);

const inventory = await analyzeAppStyles({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  roots: ["apps/desktop/src/renderer", "packages/ui/src"],
  appName: "Sondine",
  tailwind: true,
  exclude: [/\.test\.tsx?$/, /\.d\.ts$/, /\/paraglide\//],
  reviewCoverage({ path, line }) {
    return reviewed.get(path)?.includes(line)
      ? "converted by hand onto Graphical's classes; the analyzer cannot trace this helper."
      : undefined;
  },
  classify({ text, property }) {
    // Focus outlines are their own 2px treatment, not the borderless theme's
    // stroke scale.
    if (property?.startsWith("outline") || /^outline-\d/.test(text ?? ""))
      return { preserve: true };
    return {};
  },
});

await writeFile(
  new URL("./style-inventory.json", import.meta.url),
  `${JSON.stringify(inventory)}\n`,
);
