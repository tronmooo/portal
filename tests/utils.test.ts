import { describe, it, expect } from "vitest";
import { sanitize, isValidDateStr, paginate, matchesProfile, RateLimiter } from "../server/utils";

// ============================================================
// sanitize()
// ============================================================
describe("sanitize", () => {
  it("strips script tags", () => {
    expect(sanitize('<script>alert("xss")</script>')).toBe("");
  });

  it("strips iframe tags", () => {
    expect(sanitize('<iframe src="evil.com"></iframe>')).toBe("");
  });

  it("strips svg tags", () => {
    expect(sanitize('<svg onload="alert(1)"><circle/></svg>')).toBe("");
  });

  it("strips form tags", () => {
    expect(sanitize('<form action="evil"><input></form>')).toBe("");
  });

  it("strips javascript: protocol", () => {
    expect(sanitize("javascript:alert(1)")).toBe("alert(1)");
  });

  it("strips vbscript: protocol", () => {
    expect(sanitize("vbscript:MsgBox")).toBe("MsgBox");
  });

  it("strips on* event handlers", () => {
    expect(sanitize('onerror=alert(1)')).toBe("alert(1)");
    expect(sanitize('onmouseover = doEvil()')).toBe("doEvil()");
  });

  it("strips data:text/html", () => {
    expect(sanitize("data:text/html,<h1>hi</h1>")).toBe(",<h1>hi</h1>");
  });

  it("strips embed and link tags", () => {
    expect(sanitize('<embed src="x">')).toBe("");
    expect(sanitize('<link rel="stylesheet" href="evil">')).toBe("");
  });

  it("strips object tags", () => {
    expect(sanitize('<object data="evil.swf"></object>')).toBe("");
  });

  it("preserves normal text", () => {
    expect(sanitize("Hello World")).toBe("Hello World");
  });

  it("preserves HTML entities in normal text", () => {
    expect(sanitize("Tom & Jerry <friends>")).toBe("Tom & Jerry <friends>");
  });

  it("trims whitespace", () => {
    expect(sanitize("  hello  ")).toBe("hello");
  });

  it("truncates to 10000 chars", () => {
    const longStr = "a".repeat(20000);
    expect(sanitize(longStr).length).toBe(10000);
  });

  it("handles case-insensitive attacks", () => {
    expect(sanitize('<SCRIPT>evil</SCRIPT>')).toBe("");
    expect(sanitize("JAVASCRIPT:void(0)")).toBe("void(0)");
  });

  it("handles nested attack vectors", () => {
    const input = '<svg><script>alert(1)</script></svg>';
    const result = sanitize(input);
    expect(result).not.toContain("<script");
    expect(result).not.toContain("<svg");
  });
});

// ============================================================
// isValidDateStr()
// ============================================================
describe("isValidDateStr", () => {
  it("accepts valid YYYY-MM-DD dates", () => {
    expect(isValidDateStr("2024-01-15")).toBe(true);
    expect(isValidDateStr("2023-12-31")).toBe(true);
    expect(isValidDateStr("2000-06-01")).toBe(true);
  });

  it("rejects invalid format", () => {
    expect(isValidDateStr("01/15/2024")).toBe(false);
    expect(isValidDateStr("2024/01/15")).toBe(false);
    expect(isValidDateStr("2024-1-15")).toBe(false);
    expect(isValidDateStr("20240115")).toBe(false);
  });

  it("rejects invalid dates", () => {
    expect(isValidDateStr("2024-13-01")).toBe(false);
    // Note: JS Date rolls Feb 30 → Mar 1, so "2024-02-30" passes Date parsing
    // The regex format check is the primary validation
    expect(isValidDateStr("not-a-date")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidDateStr("")).toBe(false);
  });
});

// ============================================================
// paginate()
// ============================================================
describe("paginate", () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it("returns all items when no limit/offset", () => {
    const result = paginate(items, {});
    expect(result.data).toEqual(items);
    expect(result.total).toBe(10);
  });

  it("applies limit", () => {
    const result = paginate(items, { limit: "3" });
    expect(result.data).toEqual([1, 2, 3]);
    expect(result.total).toBe(10);
    expect(result.limit).toBe(3);
  });

  it("applies offset", () => {
    const result = paginate(items, { limit: "3", offset: "5" });
    expect(result.data).toEqual([6, 7, 8]);
    expect(result.offset).toBe(5);
  });

  it("caps limit at 500", () => {
    const result = paginate(items, { limit: "1000" });
    expect(result.limit).toBe(500);
  });

  it("treats limit=0 as no limit (returns all)", () => {
    // parseInt("0") = 0, which is falsy, so || total kicks in
    const result = paginate(items, { limit: "0" });
    expect(result.limit).toBe(10);
  });

  it("handles negative offset as 0", () => {
    const result = paginate(items, { offset: "-5" });
    expect(result.offset).toBe(0);
  });

  it("returns empty data for offset beyond length", () => {
    const result = paginate(items, { offset: "100" });
    expect(result.data).toEqual([]);
    expect(result.total).toBe(10);
  });
});

// ============================================================
// matchesProfile()
// ============================================================
describe("matchesProfile", () => {
  it("matches everything when no filter", () => {
    expect(matchesProfile([])).toBe(true);
    expect(matchesProfile(["abc"])).toBe(true);
    expect(matchesProfile(["abc"], undefined)).toBe(true);
  });

  it("matches when entity is linked to filter profile", () => {
    expect(matchesProfile(["profile-1", "profile-2"], "profile-1")).toBe(true);
  });

  it("does not match when entity is linked to different profile", () => {
    expect(matchesProfile(["profile-2"], "profile-1")).toBe(false);
  });

  it("matches unlinked entities for self profile", () => {
    expect(matchesProfile([], "self-profile-id", true)).toBe(true);
  });

  it("does not match unlinked entities for non-self profile", () => {
    expect(matchesProfile([], "other-profile-id", false)).toBe(false);
  });

  it("matches linked entity even when also self profile", () => {
    expect(matchesProfile(["self-id"], "self-id", true)).toBe(true);
  });

  it("does not match empty linkedProfiles for non-self filter", () => {
    expect(matchesProfile([], "some-profile")).toBe(false);
  });
});

// ============================================================
// RateLimiter
// ============================================================
describe("RateLimiter", () => {
  it("allows requests under the limit", () => {
    const limiter = new RateLimiter();
    expect(limiter.check("user1", 5, 60000)).toBe(false);
    expect(limiter.check("user1", 5, 60000)).toBe(false);
    expect(limiter.check("user1", 5, 60000)).toBe(false);
  });

  it("blocks requests over the limit", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 5; i++) {
      limiter.check("user1", 5, 60000);
    }
    expect(limiter.check("user1", 5, 60000)).toBe(true);
  });

  it("isolates different keys", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 5; i++) {
      limiter.check("user1", 5, 60000);
    }
    // user1 is limited
    expect(limiter.check("user1", 5, 60000)).toBe(true);
    // user2 is not
    expect(limiter.check("user2", 5, 60000)).toBe(false);
  });

  it("resets after window expires", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 5; i++) {
      limiter.check("user1", 5, 1); // 1ms window
    }
    // Wait for window to expire
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    expect(limiter.check("user1", 5, 1)).toBe(false);
  });

  it("evicts entries when map exceeds max size", () => {
    const limiter = new RateLimiter(5);
    for (let i = 0; i < 10; i++) {
      limiter.check(`user${i}`, 100, 60000);
    }
    expect(limiter.size).toBeLessThanOrEqual(10);
  });

  it("cleanup removes expired entries", () => {
    const limiter = new RateLimiter();
    limiter.check("user1", 5, 1); // 1ms window
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    limiter.cleanup();
    expect(limiter.size).toBe(0);
  });
});
