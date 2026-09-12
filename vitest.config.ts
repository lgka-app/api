import { defineConfig } from "vitest/config";

// Parser tests run in plain Node against the golden fixtures (fast, no
// workerd). Worker integration tests live in test/worker/ and use the
// Cloudflare vitest pool via vitest.worker.config.ts.
export default defineConfig({
  test: {
    include: ["test/*.test.ts"],
    testTimeout: 60_000,
  },
});
