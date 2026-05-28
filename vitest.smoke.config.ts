/**
 * Vitest config dedicated to the regression-proof smoke contracts.
 *
 * Run with:
 *   npx vitest run --config vitest.smoke.config.ts
 *
 * The pre-push hook invokes this via `npm run test:contracts`. Keep the
 * include list focused — anything in tests/smoke/ that ends in .test.ts is
 * gating, anything else is opt-in.
 */
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/smoke/contracts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Network-bound — generous timeout per test plus an overall hook timeout
    // for the one-time seed.
    testTimeout: 60_000,
    hookTimeout: 180_000,
    // Run sequentially: parallel files would all try to seed at once and the
    // server's dedupe windows would make the fixture flaky.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
});
