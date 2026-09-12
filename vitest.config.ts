import { defineConfig } from "vitest/config";

// Parser tests run in plain Node against the golden fixtures (fast, no
// workerd). The deployed Worker is exercised live by tool/benchmark.mjs.
export default defineConfig({
  test: {
    include: ["test/*.test.ts"],
    testTimeout: 60_000,
  },
});
