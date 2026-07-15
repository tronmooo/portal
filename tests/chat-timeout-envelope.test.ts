/**
 * Chat timeout envelope guard.
 *
 * Multi-action chat turns run up to 15 model round-trips server-side. Three
 * timeouts must stay strictly ordered or long turns get killed mid-write and
 * the user sees "connection dropped" while the server keeps (or stops)
 * executing silently:
 *
 *   server wall-clock budget  <  client chat timeout  <  platform maxDuration
 *   (ai-engine stops starting    (queryClient aborts     (vercel.json — the
 *    new rounds, reports          the fetch)              hard SIGKILL)
 *    partial results honestly)
 *
 * Regression this guards against: commit 6b3d891 dropped vercel.json
 * maxDuration from 300 → 60 in an unrelated dashboard commit, so the platform
 * killed every multi-action chat turn at 60s — before the server's 90s
 * graceful cutoff could ever fire. Even two-action messages started failing
 * with "That took too long or the connection dropped."
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

function extractConst(src: string, name: string): number {
  const m = src.match(new RegExp(`${name}\\s*=\\s*([\\d_]+)`));
  if (!m) throw new Error(`Could not find constant ${name}`);
  return Number(m[1].replace(/_/g, ""));
}

describe("chat timeout envelope", () => {
  const vercel = JSON.parse(read("vercel.json"));
  const maxDurationMs = vercel.functions["api/index.js"].maxDuration * 1000;
  const serverBudgetMs = extractConst(read("server/ai-engine.ts"), "WALL_CLOCK_BUDGET_MS");
  const clientChatTimeoutMs = extractConst(read("client/src/lib/queryClient.ts"), "CHAT_TIMEOUT_MS");

  it("server wall-clock budget leaves room for a final round-trip before the client aborts", () => {
    // The budget only stops NEW rounds — the in-flight round (model call +
    // tool execution + response serialization) still needs to finish before
    // the client's abort. Keep ≥60s of headroom.
    expect(clientChatTimeoutMs - serverBudgetMs).toBeGreaterThanOrEqual(60_000);
  });

  it("client chat timeout is under the platform function limit", () => {
    expect(clientChatTimeoutMs).toBeLessThan(maxDurationMs);
  });

  it("platform maxDuration can host the full designed envelope (≥300s)", () => {
    // 15 round-trips × heavy system prompt makes 60s laughably small; the
    // envelope was designed around 300s. Anything lower is a regression.
    expect(maxDurationMs).toBeGreaterThanOrEqual(300_000);
  });
});
