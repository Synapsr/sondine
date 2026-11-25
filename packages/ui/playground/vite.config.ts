import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Design system playground: pnpm --filter @sondine/ui dev
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // Relative asset URLs so a build also opens from file:// (scripts/screenshot.mjs).
  base: "./",
  plugins: [react(), tailwindcss()],
});
