/**
 * Security review 2026-11-12 — the defects it confirmed, pinned.
 *
 *  1. A document row's storage path is only honoured inside its owner's
 *     folder. The column is writable by the row's owner through Supabase
 *     (RLS update-own), and the server signs / downloads / purges whatever it
 *     holds with the service-role key: a row repointed at
 *     `<other-user>/<doc>.pdf` served, or deleted, another account's file.
 *  2. The blocked-document-type rule cannot be padded past ("text/html ;x"),
 *     and /api/import applies it too.
 *  3. A bank sync only follows a holder id that maps to the caller.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownedStoragePath } from "../shared/owned-storage-path";
import { SupabaseStorage } from "../server/supabase-storage";
import { startHarness, type Harness } from "./helpers/route-harness";

const ME = "11111111-1111-4111-8111-111111111111";
const THEM = "22222222-2222-4222-8222-222222222222";

describe("a storage path is honoured only inside its owner's folder", () => {
  it("keeps the owner's own path", () => {
    expect(ownedStoragePath(`${ME}/doc.pdf`, ME)).toBe(`${ME}/doc.pdf`);
    expect(ownedStoragePath(`${ME}/doc.pdf.prev.jpg`, ME)).toBe(`${ME}/doc.pdf.prev.jpg`);
  });
  it.each([
    `${THEM}/doc.pdf`,
    `${ME}/../${THEM}/doc.pdf`,
    `${ME}/./doc.pdf`,
    `${ME}//doc.pdf`,
    `${ME}`,
    `${ME}/`,
    `/${ME}/doc.pdf`,
    `${ME}x/doc.pdf`,
    `${ME}/a\\b.pdf`,
    "",
    null,
    42,
  ])("refuses %j", (path) => {
    expect(ownedStoragePath(path as any, ME)).toBeUndefined();
  });

  /** The real storage class over a fake Supabase client that records Storage calls. */
  function storageWithRow(row: any) {
    const storageCalls: Array<[string, any]> = [];
    const query: any = {
      select: () => query, eq: () => query, is: () => query, not: () => query, limit: () => query,
      update: () => query, delete: () => query,
      maybeSingle: async () => ({ data: { ...row }, error: null }),
      single: async () => ({ data: { ...row }, error: null }),
      then: (ok: any) => ok({ data: [{ ...row }], error: null }),
    };
    const bucket = {
      download: async (p: string) => { storageCalls.push(["download", p]); return { data: null, error: { message: "not found" } }; },
      createSignedUrl: async (p: string) => { storageCalls.push(["sign", p]); return { data: { signedUrl: `https://signed.invalid/${p}` }, error: null }; },
      remove: async (p: string[]) => { storageCalls.push(["remove", p]); return { error: null }; },
      list: async () => ({ data: [], error: null }),
      upload: async () => ({ error: null }),
    };
    const s: any = Object.create(SupabaseStorage.prototype);
    s.userId = ME;
    s.supabase = { from: () => query, storage: { from: () => bucket } };
    s.memoEnabled = false;
    s.memoCache = new Map();
    s.logActivity = () => undefined;
    return { s, storageCalls };
  }
  const foreignRow = { id: "doc-1", user_id: ME, name: "mine", mime_type: "application/pdf", storage_path: `${THEM}/victim.pdf`, file_data: "", created_at: "2026-01-01", updated_at: "2026-01-01" };

  it("getDocumentDelivery never signs a URL for another account's object", async () => {
    const { s, storageCalls } = storageWithRow(foreignRow);
    const out = await s.getDocumentDelivery("doc-1").catch(() => undefined);
    expect(JSON.stringify(out ?? {})).not.toContain(THEM);
    expect(storageCalls.filter(([, p]) => JSON.stringify(p).includes(THEM))).toEqual([]);
  });
  it("getDocumentFile never downloads another account's object", async () => {
    const { s, storageCalls } = storageWithRow(foreignRow);
    await s.getDocumentFile("doc-1").catch(() => undefined);
    expect(storageCalls.filter(([, p]) => JSON.stringify(p).includes(THEM))).toEqual([]);
  });
  it("getDocument never downloads another account's object", async () => {
    const { s, storageCalls } = storageWithRow(foreignRow);
    await s.getDocument("doc-1").catch(() => undefined);
    expect(storageCalls.filter(([, p]) => JSON.stringify(p).includes(THEM))).toEqual([]);
  });
  it("purgeDocument never removes another account's object", async () => {
    const { s, storageCalls } = storageWithRow(foreignRow);
    await s.purgeDocument("doc-1").catch(() => undefined);
    expect(storageCalls.filter(([, p]) => JSON.stringify(p).includes(THEM))).toEqual([]);
  });
  it("the owner's own file is still served (the probe above can see Storage calls)", async () => {
    const { s, storageCalls } = storageWithRow({ ...foreignRow, storage_path: `${ME}/doc-1.pdf` });
    await s.getDocumentFile("doc-1").catch(() => undefined);
    expect(storageCalls).toContainEqual(["download", `${ME}/doc-1.pdf`]);
  });
});

describe("blocked document types cannot be padded past", () => {
  let h: Harness | undefined;
  afterEach(async () => { await h?.close(); h = undefined; });

  it.each(["text/html", "text/html ;x", " TEXT/HTML; charset=utf-8", "image/svg+xml ; a=b"])("POST /api/documents refuses %j", async (mimeType) => {
    h = await startHarness();
    const r = await h.api("POST", "/api/documents", { name: "x", type: "other", mimeType, fileData: "PGI+" });
    expect(r.status).toBe(415);
    expect(h.db.documents).toHaveLength(0);
  });
  it("still accepts a PDF", async () => {
    h = await startHarness();
    const r = await h.api("POST", "/api/documents", { name: "x", type: "other", mimeType: "application/pdf", fileData: "JVBERi0=" });
    expect(r.status).toBeLessThan(300);
  });
  it("/api/import applies the same rule, and the file route reads the type without parameters", () => {
    const src = readFileSync(join(__dirname, "../server/routes.ts"), "utf8");
    const importBlock = src.slice(src.indexOf('tryImport("documents"'), src.indexOf('tryImport("documents"') + 400);
    expect(importBlock).toContain("acceptableDocumentMime(d.mimeType)");
    expect(src).toMatch(/activeMime\.has\(baseMime\(mimeType\)\)/);
  });
});

describe("uploads are not logged by name or content", () => {
  it("the upload log line carries neither the file name nor any bytes", () => {
    const src = readFileSync(join(__dirname, "../server/routes.ts"), "utf8");
    const lines = src.split("\n").filter((l) => l.includes("console.log(`[Upload]"));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).not.toContain("fileName");
      expect(l).not.toMatch(/fileData\?*\.slice/);
    }
  });
});

describe("a bank sync follows only a holder that maps to the caller", () => {
  it("syncFinancialData checks the holder before asking Stripe for its accounts", () => {
    const src = readFileSync(join(__dirname, "../server/finance-sync.ts"), "utf8");
    const body = src.slice(src.indexOf("for (const conn of connections)"));
    const check = body.indexOf("userIdForCustomer(conn.stripe_account_holder_id)) !== userId");
    const list = body.indexOf("stripe.financialConnections.accounts.list");
    expect(check).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(check);
  });
});
