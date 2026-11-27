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
