import { defineConfig } from "vitest/config";

// The tests talk to a real server over HTTP, sealed both ways: a shared CI
// runner takes up to five seconds for one, and more than the one second
// `expect.poll` waits by default for what the server does meanwhile.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    expect: { poll: { timeout: 10_000 } },
  },
});
