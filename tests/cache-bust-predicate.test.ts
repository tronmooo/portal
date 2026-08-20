import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { shouldBustCaches } from "../server/routes";

// Fix (2026-07-17): read-only POST generators/analyzers must NOT bust the
// per-user response cache, but every genuine mutation still must. These tests
// pin both halves so a future edit can't silently start busting on AI summaries
// (the perf regression) or stop busting on a real write (a staleness bug).

describe("shouldBustCaches — genuine mutations still bust", () => {
  it("busts on direct REST writes", () => {
    expect(shouldBustCaches("POST", "/api/expenses")).toBe(true);
    expect(shouldBustCaches("PATCH", "/api/trackers/123")).toBe(true);
    expect(shouldBustCaches("PUT", "/api/profiles/123")).toBe(true);
    expect(shouldBustCaches("DELETE", "/api/documents/123")).toBe(true);
  });

  it("busts on AI-tool mutators (chat/upload) that write via internal tool calls", () => {
    expect(shouldBustCaches("POST", "/api/chat")).toBe(true);
    expect(shouldBustCaches("POST", "/api/chat/confirm-extraction")).toBe(true);
    expect(shouldBustCaches("POST", "/api/upload")).toBe(true);
    expect(shouldBustCaches("POST", "/api/upload/batch")).toBe(true);
  });

  it("busts on mutating POST generators that DO write (not on the allowlist)", () => {
    // smart-fill/render creates a Document + Obligations; weekly-review generates
    // an artifact; finance-import/commit writes rows.
    expect(shouldBustCaches("POST", "/api/smart-fill/render")).toBe(true);
    expect(shouldBustCaches("POST", "/api/weekly-review/generate")).toBe(true);
    expect(shouldBustCaches("POST", "/api/finance-import/commit")).toBe(true);
    expect(shouldBustCaches("POST", "/api/trackers")).toBe(true);
  });
});

describe("shouldBustCaches — read-only POSTs do NOT bust", () => {
  it("skips the verified read-only generators/analyzers", () => {
    expect(shouldBustCaches("POST", "/api/ai/summary")).toBe(false);
    expect(shouldBustCaches("POST", "/api/ai-transform")).toBe(false);
    expect(shouldBustCaches("POST", "/api/receipt-extract")).toBe(false);
    expect(shouldBustCaches("POST", "/api/client-errors")).toBe(false);
    expect(shouldBustCaches("POST", "/api/smart-fill/analyze")).toBe(false);
    expect(shouldBustCaches("POST", "/api/wellness/insights")).toBe(false);
    expect(shouldBustCaches("POST", "/api/finance-import/prompt")).toBe(false);
    expect(shouldBustCaches("POST", "/api/finance-import/preview")).toBe(false);
  });
});

describe("shouldBustCaches — idempotent reads never bust", () => {
  it("never busts on GET/HEAD/OPTIONS", () => {
    expect(shouldBustCaches("GET", "/api/stats")).toBe(false);
    expect(shouldBustCaches("GET", "/api/dashboard-enhanced")).toBe(false);
    expect(shouldBustCaches("HEAD", "/api/profiles")).toBe(false);
    expect(shouldBustCaches("OPTIONS", "/api/expenses")).toBe(false);
  });
});

// The AI change manifest names domains the cache bus must be able to expand.
// Two were added with it (artifacts, memories) because chat can create both and
// neither had a domain — those writes had to fall back to the nuclear refresh.
describe("cache bus domain coverage", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../client/src/lib/cache-bus.ts"),
    "utf8",
  );

  it("knows how to expand the artifacts and memories domains", () => {
    expect(src).toMatch(/^\s{2}artifacts:\s*\[/m);
    expect(src).toMatch(/^\s{2}memories:\s*\[/m);
    expect(src).toContain('["/api/artifacts"]');
    expect(src).toContain('["/api/memories"]');
  });

  it("takes its Domain union from the shared vocabulary the server also uses", () => {
    // If these drift apart the server can name a domain the client silently
    // ignores — an invalidation that refreshes nothing.
    expect(src).toContain('from "@shared/entity-domains"');
  });
});
