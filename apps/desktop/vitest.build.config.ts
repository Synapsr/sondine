import { defineConfig } from "vitest/config";

// The production build check (test/build.check.ts) runs on its own, after the
// unit tests, because building rewrites the Paraglide output they import.
export default defineConfig({
  test: {
    include: ["test/build.check.ts"],
    environment: "node",
    testTimeout: 120_000,
  },
});
