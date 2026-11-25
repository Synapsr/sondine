import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The tests read and run WXT's builds (test/global-setup.ts).
    globalSetup: ["test/global-setup.ts"],
  },
});
