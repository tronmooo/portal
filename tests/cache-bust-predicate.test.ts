import { describe, it, expect } from "vitest";
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
