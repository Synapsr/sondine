// One set of Paraglide compiler options for the Vite plugin and the
// standalone compile that typecheck runs. Paths are relative to apps/desktop.
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** @type {import("@inlang/paraglide-js").CompilerOptions} */
export const paraglideOptions = {
  project: `${root}project.inlang`,
  outdir: `${root}src/renderer/paraglide`,
  // The user's choice, then the OS locale main passes to the preload, then English.
  strategy: ["localStorage", "custom-os", "baseLocale"],
  localStorageKey: "sondine.locale",
  emitReadme: false,
  emitPrettierIgnore: false,
};
