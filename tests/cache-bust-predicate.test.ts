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

// ─── Domain dependency gaps ────────────────────────────────────────────────
// A domain that omits a key its data feeds is a screen that stays stale until
// something unrelated happens to refetch it. These were the actual omissions
// behind "I recorded a payment and the budget/net-worth/dashboard didn't move".
describe("cache bus — a finance write reaches everything it feeds", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../client/src/lib/cache-bus.ts"),
    "utf8",
  );

  /** The keys listed under one domain in DOMAIN_KEYS. */
  function keysFor(domain: string): string[] {
    const start = src.indexOf(`\n  ${domain}: [`);
    expect(start, `domain ${domain} not found`).toBeGreaterThan(-1);
    const end = src.indexOf("\n  ],", start);
    return [...src.slice(start, end).matchAll(/\["([^"]+)"\]/g)].map((m) => m[1]);
  }

  it("routes a liability write into the money surfaces it moves", () => {
    const keys = keysFor("liabilities");
    // A payment is money out: it belongs in the spend totals and this month's
    // budget exactly like any other outflow, and it moves net worth.
    for (const key of [
      "/api/profiles", "/api/dashboard-enhanced", "/api/stats",
      "/api/expenses", "/api/budgets/summary", "/api/net-worth/history",
      "/api/dashboard-bootstrap", "/api/obligations", "/api/accounts",
    ]) {
      expect(keys, key).toContain(key);
    }
  });

  it("routes an asset write into the persisted bootstrap payload", () => {
    // dashboard-bootstrap SEEDS ~24 list caches on next launch and is persisted
    // to localStorage. Omitting it meant a revalued car came back at its old
    // value after a reload.
    const keys = keysFor("assets");
    for (const key of [
      "/api/profiles", "/api/dashboard-enhanced", "/api/stats",
      "/api/dashboard-bootstrap", "/api/net-worth/history", "/api/insights",
    ]) {
      expect(keys, key).toContain(key);
    }
  });

  it("lists no key that nothing in the app reads", () => {
    // ["/api/activity"] sat in eight domains. No query ever used it — recent
    // activity comes from stats.recentActivity — so every one of those entries
    // was invalidation theatre.
    const app = fs.readFileSync(path.resolve(__dirname, "../client/src/lib/cache-bus.ts"), "utf8");
    expect(app).not.toContain('["/api/activity"]');
  });
});

// ─── Cross-instance cache busting must stay per-user ───────────────────────
describe("server cache busts name a user", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../server/routes.ts"), "utf8");

  it("never busts a per-user prefix for every user on the instance", () => {
    // bustCache("enhanced:") reads as "clear my dashboard" and actually clears
    // the dashboard of every user sharing this warm lambda, cold-starting a
    // ~15-query recompute for each of them. Dozens of these had accumulated.
    const offenders = [...src.matchAll(/bustCache\(`([a-z-]+:)`\)/g)].map((m) => m[1]);
    expect(offenders).toEqual([]);
  });
});

// ─── The slim profile list must be busted with the full one ────────────────
// 2026-08-27 ("where is Bob Robertson"): /api/profiles/lite caches under the
// prefix "profiles-lite:", which does NOT start with "profiles:". So neither
// the write middleware's prefix sweep nor any per-route bustCache(`profiles:…`)
// ever reached it — the list behind the hub profile switcher was the one
// profile cache a write left standing.
describe("profile list caches are busted in pairs", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../server/routes.ts"), "utf8");

  it("sweeps profiles-lite: on every write", () => {
    const start = src.indexOf("const USER_CACHE_PREFIXES = [");
    expect(start).toBeGreaterThan(-1);
    const list = src.slice(start, src.indexOf("];", start));
    expect(list).toContain('"profiles:"');
    expect(list).toContain('"profiles-lite:"');
  });

  it("busts both prefixes from the one helper the routes call", () => {
    const start = src.indexOf("function bustProfileCaches(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}", start));
    expect(body).toContain("bustCache(`profiles:${uid}`)");
    expect(body).toContain("bustCache(`profiles-lite:${uid}`)");
  });

  it("leaves no route busting the full list without its lite sibling", () => {
    // Every per-route site must go through the helper, so a new one can't
    // reintroduce the half-bust.
    const halfBusts = [...src.matchAll(/bustCache\(`profiles:\$\{[A-Za-z0-9_]+\}`\)/g)]
      .filter((m) => src.slice(Math.max(0, m.index! - 200), m.index!).indexOf("function bustProfileCaches(") === -1);
    expect(halfBusts).toEqual([]);
  });
});
