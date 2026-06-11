import { defineConfig } from "vitest/config";

// Live end-to-end config — drives the DEPLOYED app (portol.me) with the
// smoke account. Run on demand via .github/workflows/live-e2e.yml or
// locally where the network can reach production.
export default defineConfig({
  test: {
    include: ["tests/live-scenarios.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Sequential: scenarios share state (Bob/Jane/Mike ids) deliberately.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
