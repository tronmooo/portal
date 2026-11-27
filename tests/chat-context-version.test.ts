// The chat's short-lived snapshot of the account is tied to the account's data
// version: a record added through a form or from another device just before a
// chat message is in the chat's view of the account (integrity run,
// 2026-11-27: "I don't see a 'Truck loan' in your liabilities", one second
// after the loan was created — the snapshot lived five seconds and only the
// chat's own tool calls refreshed it).
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const read = (rel: string) => fs.readFileSync(`${process.cwd()}/${rel}`, "utf8");

describe("the chat's account snapshot follows the data version", () => {
  const engine = read("server/ai-engine.ts");
  const routes = read("server/routes.ts");

  it("a cached snapshot is reused only at the version it was loaded at", () => {
    expect(engine).toMatch(/const stamp = contextVersionStamp\.get\(cacheKey\) \?\? "";/);
    expect(engine).toMatch(/\(now - cached\.timestamp\) < CONTEXT_CACHE_TTL && cached\.stamp === stamp/);
    expect(engine).toMatch(/contextCacheMap\.set\(cacheKey, \{ data, timestamp: now, stamp \}\)/);
  });

  it("the chat route tells the engine the version before the turn runs, merged with the client's own token", () => {
    const at = routes.indexOf('app.post("/api/chat"');
    const body = routes.slice(at, at + 2500);
    expect(body).toMatch(/mergeVersionMaps\(await currentVersions\(uidForVersion\), decodeVersionMap\(req\.headers\[DATA_VERSION_HEADER\]\)\)/);
    expect(body).toMatch(/noteContextVersion\(uidForVersion, encodeVersionMap\(versions\)\)/);
  });

  it("the watcher never drops a navigation's check (it is asked when the gap is over)", () => {
    const app = read("client/src/App.tsx");
    expect(app).toMatch(/else pending\.current = setTimeout\(\(\) => \{ pending\.current = null; ask\(\); \}, wait\);/);
    expect(app).not.toMatch(/if \(now - lastAt\.current < VERSION_CHECK_MIN_GAP_MS\) return;/);
  });
});

// Integrity run, 2026-11-27: "Delete my education budget" was refused about one
// time in four — budgets were not in the chat's context at all, so the model
// read their absence as "you have none". The retry then argued with the
// system's own instruction, and that argument was shown to the person.
describe("budgets are in the chat's context, and retry back-talk is not shown", () => {
  it("this month's budgets are loaded with the snapshot and written into the context", () => {
    const src = read("server/ai-engine.ts");
    const loader = src.slice(src.indexOf("async function getCachedContextData"), src.indexOf("contextCacheMap.set(cacheKey"));
    expect(loader).toContain("storage.getBudgets(");
    // a failed read is null (not loaded), never an empty list
    expect(loader).toMatch(/getBudgets\([^\n]*\.catch\(\(\) => null\)/);
    expect(src).toContain("budgetsContextLine(monthBudgets)");
  });

  it("the context line tells loaded, empty and failed apart", () => {
    const src = read("server/ai-engine.ts");
    const fn = src.slice(src.indexOf("export function budgetsContextLine"), src.indexOf("// Per-user context cache"));
    const line = new Function("budgets", fn.replace(/export function budgetsContextLine\([^)]*\): string \{/, "").replace(/\}\s*$/, "").replace(/\(b: any\)/g, "(b)")) as (b: unknown) => string;
    expect(line([{ category: "education", amount: 120 }])).toContain("education: $120");
    expect(line([])).toContain("none set");
    expect(line(null)).toContain("not loaded");
    expect(line(null)).not.toContain("none set");
  });

  it("a reply that answers the retry instruction is recognised; a plain answer is not", async () => {
    const { isRetryBackTalk } = await import("../shared/ai-claim-check");
    expect(isRetryBackTalk("I didn't claim the request was done — I told you the education budget doesn't exist in your data, so there's nothing to delete. No tool call is needed.")).toBe(true);
    expect(isRetryBackTalk("If you believe a budget was set up, I can try `delete_budget` directly.")).toBe(true);
    expect(isRetryBackTalk("You don't have an education budget this month, so there is nothing to delete.")).toBe(false);
    expect(isRetryBackTalk("Which budget do you mean — groceries or dining?")).toBe(false);
  });

  it("the tool loop replaces back-talk with the plain failure line", () => {
    const src = read("server/ai-engine.ts");
    const at = src.indexOf("isRetryBackTalk(textReply)");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 400)).toContain("textReply = honestFailureReply([])");
  });
});
