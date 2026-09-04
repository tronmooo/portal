/**
 * Vitest config for the live end-to-end API tests.
 *
 * Run with:
 *   npm run test:e2e            (or)
 *   npx vitest run --config vitest.e2e.config.ts
 *
 * These tests hit the real production API at https://portol.me (signin → seed →
 * assert → teardown), so they are deliberately kept OUT of vitest.config.ts's
 * gating `include` list and the pre-push hook. This config has its own focused
 * include list and runs the files sequentially so concurrent seeds don't race.
 */
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/api-e2e.test.ts", "tests/e2e-dashboard-filters.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: "forks",
    // Vitest 4 moved this option out of the removed poolOptions.forks object.
    singleFork: true,
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
});
