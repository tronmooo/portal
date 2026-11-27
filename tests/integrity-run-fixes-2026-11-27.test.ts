// Fixes for what the first integrity run found on production (2026-11-27).
// Each test names the scenario in tests/integrity/scenarios that caught it;
// those scenarios are the live check, this file is the local guard.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startHarness, type Harness } from "./helpers/route-harness";
import { writeFromStoredRow } from "../server/stored-row-write";
import { resolveAssetValue } from "../shared/asset-value";
import { MemStorage } from "../server/storage";
import { recordDetailsKey } from "../shared/record-details";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

// ── money.legacy-loan-counted-once ──────────────────────────────────────────
describe("a loan-typed profile is a debt, never also an asset", () => {
  const loan = { type: "loan", fields: { balance: 20000, interestRate: 5, monthlyPayment: 300 } };

  it("resolved from the PROFILE its asset value is zero; from bare fields the balance leaks in", () => {
    expect(resolveAssetValue(loan)).toBe(0);
    // why the server's finance snapshot listed a mortgage among assets: it
    // passed `p.fields`, which carries no type, so the loan rule could not apply
    expect(resolveAssetValue(loan.fields)).toBe(20000);
    // a loan that also records the financed thing's value still reports that
    expect(resolveAssetValue({ type: "loan", fields: { balance: 20000, currentValue: 31000 } })).toBe(31000);
  });

  it("no server code resolves an asset value from bare `.fields` of a profile", () => {
    const offenders: string[] = [];
    for (const rel of ["server/supabase-storage.ts", "server/routes.ts", "server/storage.ts", "server/finance-routes.ts"]) {
      read(rel).split("\n").forEach((line, i) => {
        if (/resolveAssetValue\(\s*\(?\s*\w+(\s+as\s+any)?\s*\)?\.fields\s*\)/.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders, "pass the profile, not profile.fields: the loan rule needs the type").toEqual([]);
  });
});

// ── hardening.simultaneous-edits ────────────────────────────────────────────
describe("a change computed from the stored row survives a simultaneous one", () => {
  /** A row with a version, like a table with a trigger-maintained updated_at. */
  function store() {
    const row = { tags: [] as string[], updatedAt: "v0" };
    let version = 0;
    return {
      row,
      read: async () => ({ ...row, tags: [...row.tags] }),
      write: async (patch: { tags: string[]; expectedUpdatedAt?: string }) => {
        await new Promise((r) => setTimeout(r, 5));
        if (patch.expectedUpdatedAt !== undefined && patch.expectedUpdatedAt !== row.updatedAt) {
          throw Object.assign(new Error("Conflict"), { name: "ConflictError", statusCode: 409 });
        }
        row.tags = patch.tags;
        row.updatedAt = `v${++version}`;
        return { ...row };
      },
    };
  }
  const mark = (s: ReturnType<typeof store>, tag: string) => writeFromStoredRow({
    read: s.read,
    compute: (r) => ({ patch: { tags: [...r.tags, tag] } }),
    write: s.write,
    sleep: async () => undefined,
  });

  it("two marks written at the same moment are both stored", async () => {
    const s = store();
    const [a, b] = await Promise.all([mark(s, "rskip:2026-12-08"), mark(s, "rskip:2026-12-15")]);
    expect(a.ok && b.ok).toBe(true);
    expect([...s.row.tags].sort()).toEqual(["rskip:2026-12-08", "rskip:2026-12-15"]);
  });

  it("the unguarded write this replaced loses one (the bug)", async () => {
    const s = store();
    const naive = async (tag: string) => { const r = await s.read(); await s.write({ tags: [...r.tags, tag] }); };
    await Promise.all([naive("a"), naive("b")]);
    expect(s.row.tags).toHaveLength(1);
  });

  it("eight at once all land; a rule that refuses is answered, not retried", async () => {
    const s = store();
    await Promise.all(Array.from({ length: 8 }, (_, i) => mark(s, `t${i}`)));
    expect(s.row.tags).toHaveLength(8);
    let calls = 0;
    const refused = await writeFromStoredRow({ read: s.read, compute: () => { calls++; return { status: 409, error: "That date is not part of the series" }; }, write: s.write });
    expect(refused).toEqual({ ok: false, status: 409, error: "That date is not part of the series" });
    expect(calls).toBe(1);
    expect(await writeFromStoredRow({ read: async () => undefined, compute: () => ({ patch: { tags: [] } }), write: s.write })).toMatchObject({ ok: false, status: 404 });
  });

  it("the five routes that rewrite a tag list from the stored row all use it", () => {
    const src = read("server/routes.ts");
    for (const route of ["/api/tasks/:id/occurrence", "/api/tasks/:id/schedule", "/api/events/:id/occurrence", "/api/events/:id/series-flag", "/api/events/:id/series-settings"]) {
      const at = src.indexOf(`app.post("${route}"`);
      expect(at, route).toBeGreaterThan(0);
      const body = src.slice(at, src.indexOf("\n  }));", at));
      expect(body, `${route} writes through writeFromStoredRow`).toMatch(/writeFromStoredRow\(/);
      expect(body, `${route} has no unguarded write`).not.toMatch(/await storage\.update(Task|Event)\(req\.params\.id, \{ (dueDate|tags)/);
    }
  });
});

// ── hardening.refused-input-writes-nothing ──────────────────────────────────
describe("inputs the create routes used to take", () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.close(); });

  it("an event whose title is only spaces is refused, and nothing is stored", async () => {
    const r = await h.api("POST", "/api/events", { title: "   ", date: "2026-12-01" });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/title/i);
    expect(h.db.events).toHaveLength(0);
    const ok = await h.api("POST", "/api/events", { title: "Dentist", date: "2026-12-01" });
    expect(ok.status).toBe(201);
  });

  it("an income whose amount is a list or a switch is refused", async () => {
    for (const amount of [[5], true, { n: 5 }]) {
      const r = await h.api("POST", "/api/incomes", { description: "Pay", amount, category: "salary" });
      expect(r.status, JSON.stringify(amount)).toBe(400);
    }
    expect(h.db.incomes).toHaveLength(0);
    // a number typed as text is still an amount
    const ok = await h.api("POST", "/api/incomes", { description: "Pay", amount: "1200.50", category: "salary" });
    expect(ok.status).toBe(201);
    expect(ok.data.amount).toBe(1200.5);
  });

  it("a note's title is text: an object is not saved as \"[object Object]\"", () => {
    const src = read("server/routes.ts");
    const at = src.indexOf('app.post("/api/notes"');
    const body = src.slice(at, src.indexOf("\n  }));", at));
    expect(body).not.toMatch(/sanitize\(String\(req\.body\.title\)\)/);
    expect(body).toMatch(/typeof req\.body\.title === "string" \|\| typeof req\.body\.title === "number"/);
  });
});

// ── records.details ─────────────────────────────────────────────────────────
describe("deleting a profile deletes its characteristic values", () => {
  it("in-memory storage: the details row goes with the profile", async () => {
    const s = new MemStorage();
    await s.createProfile({ name: "Me", type: "self", fields: {} } as any);
    const amp = await s.createProfile({ name: "Amp", type: "asset", fields: { currentValue: 100 } } as any);
    await s.saveRecordDetails("profile", amp.id, { values: { condition: { value: "Fair", updatedAt: "2026-11-27T00:00:00Z" } }, updatedAt: "2026-11-27T00:00:00Z" } as any);
    expect(await s.getPreference(recordDetailsKey("profile", amp.id))).not.toBeNull();
    expect(await s.deleteProfile(amp.id)).toBe(true);
    expect(await s.getPreference(recordDetailsKey("profile", amp.id))).toBeNull();
    expect(await s.listRecordDetails()).toEqual([]);
  });

  it("Supabase storage: both delete paths prune the details row", () => {
    const src = read("server/supabase-storage.ts");
    expect(src.match(/await this\.pruneDetailsForProfile\(id\)/g)?.length).toBe(2);
    expect(src).toMatch(/private async pruneDetailsForProfile\(profileId: string\)[\s\S]{0,200}saveRecordDetails\("profile", profileId, \{ values: \{\}, updatedAt: "" \}\)/);
  });
});
