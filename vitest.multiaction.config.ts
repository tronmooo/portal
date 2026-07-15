import { defineConfig } from "vitest/config";
import path from "path";

// Multi-action regression config — drives a REAL deployment (default
// portol.me, override with MULTIACTION_BASE_URL, e.g. http://localhost:5000/api)
// through /api/chat with 5/10/20/50-action prompts. Needs a live server with
// an ANTHROPIC_API_KEY and the smoke account, so it is NOT part of the gating
// `npm test` run. Run on demand:
//   npm run test:multiaction
export default defineConfig({
  test: {
    include: ["tests/multi-action-live.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 180_000,
    // Sequential: tiers share tracker state deliberately, and the chat route
    // is rate-limited per user.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
      "@": path.resolve(__dirname, "client/src"),
    },
  },
});
