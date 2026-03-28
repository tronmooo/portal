import { defineConfig } from "vitest/config";
import path from "path";

// Server-side + unit test config (Node environment)
export default defineConfig({
  test: {
    name: "server",
    environment: "node",
    globals: true,
    include: [
      "tests/unit/**/*.test.ts",
      "tests/integration/**/*.test.ts",
      "tests/regression/**/*.test.ts",
      // Smoke tests only run when BASE_URL is set — run via npm run test:smoke
      ...(process.env.BASE_URL ? ["tests/smoke/**/*.test.ts"] : []),
    ],
    exclude: ["tests/e2e/**"],
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["server/**/*.ts", "shared/**/*.ts"],
      exclude: [
        "server/index.ts",
        "server/vite.ts",
        "server/static.ts",
        "server/vercel-entry.ts",
        "**/*.d.ts",
      ],
      thresholds: {
        lines: 50,
        functions: 50,
        branches: 40,
        statements: 50,
      },
    },
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "./shared"),
      "@": path.resolve(__dirname, "./client/src"),
    },
  },
});
