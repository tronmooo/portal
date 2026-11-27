// The AI Mode library (owner request 2026-11-27: "users could publish their
// own configurations, discover popular modes, install templates and customize
// them further"). server/ai-mode-library.ts over an in-memory stand-in for the
// service-role client.
//
// What is pinned:
//  - What is published is built from the STORED mode, and is its setup only:
//    no id, dates, pin, journal switch, conversation or memories. The author is
//    never returned — a card says only whether it is yours.
//  - Only the author can unpublish. Installing hands back a fresh proposal
//    (journal off) and counts an install. Three reports hide an entry.
//  - A missing table is "not available yet" (503), never an empty library.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { AI_MODES_PREF, MODE_TEMPLATES, modeFromTemplate, serializeAiModes } from "../shared/ai-modes";

const prefs: Record<string, string> = {};
vi.mock("../server/storage", () => ({ storage: { getPreference: async (k: string) => prefs[k] ?? null } }));

type Row = Record<string, any>;
let rows: Row[] = [];
let reports: Array<{ library_id: string; reporter_id: string }> = [];
let missingTable = false;
let seq = 0;

/** Just enough of the PostgREST builder for the module. */
function fakeClient() {
  const from = (_table: string) => {
    let op: "select" | "insert" | "delete" = "select";
    let filters: Array<(r: Row) => boolean> = [];
    let payload: Row | null = null;
    let order: Array<[string, boolean]> = [];
    let lim = 1000;
    let head = false;
    let single: "single" | "maybe" | null = null;
    const run = () => {
      if (missingTable) return { data: null, error: { code: "42P01", message: 'relation "public.ai_mode_library" does not exist' }, count: null };
      if (op === "insert") {
        const r = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, installs: 0, reports: 0, created_at: new Date(Date.now() + seq).toISOString(), ...payload };
        rows.push(r);
        return { data: single ? r : [r], error: null };
      }
      let out = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "delete") { rows = rows.filter((r) => !out.includes(r)); return { data: out.map((r) => ({ id: r.id })), error: null }; }
      for (const [k, asc] of [...order].reverse()) out = [...out].sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (asc ? 1 : -1));
      out = out.slice(0, lim);
      if (head) return { data: null, error: null, count: out.length };
      if (single) return { data: out[0] ?? null, error: null };
      return { data: out, error: null };
    };
    const b: any = {
      select: (_c?: string, o?: { head?: boolean }) => { if (o?.head) head = true; return b; },
      insert: (p: Row) => { op = "insert"; payload = p; return b; },
      delete: () => { op = "delete"; return b; },
      eq: (k: string, v: any) => { filters.push((r) => r[k] === v); return b; },
      lt: (k: string, v: any) => { filters.push((r) => r[k] < v); return b; },
      or: (expr: string) => { const term = /ilike\.%(.*?)%/.exec(expr)?.[1]?.toLowerCase() ?? ""; filters.push((r) => `${r.name} ${r.tagline}`.toLowerCase().includes(term)); return b; },
      order: (k: string, o?: { ascending?: boolean }) => { order.push([k, o?.ascending !== false]); return b; },
      limit: (n: number) => { lim = n; return b; },
      single: () => { single = "single"; return b; },
      maybeSingle: () => { single = "maybe"; return b; },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  };
  const rpc = async (name: string, args: Row) => {
    if (missingTable) return { data: null, error: { code: "42883", message: "function does not exist" } };
    if (name === "ai_mode_library_installed") { const r = rows.find((x) => x.id === args.p_id); if (r) r.installs++; return { data: null, error: null }; }
    if (!reports.some((x) => x.library_id === args.p_id && x.reporter_id === args.p_reporter)) reports.push({ library_id: args.p_id, reporter_id: args.p_reporter });
    const n = reports.filter((x) => x.library_id === args.p_id).length;
    const r = rows.find((x) => x.id === args.p_id); if (r) r.reports = n;
    return { data: n, error: null };
  };
  return { from, rpc };
}

const ME = "11111111-1111-4111-8111-111111111111";
const YOU = "22222222-2222-4222-8222-222222222222";
let lib: typeof import("../server/ai-mode-library");
beforeEach(async () => {
  rows = []; reports = []; missingTable = false;
  const fit = { ...modeFromTemplate(MODE_TEMPLATES.find((t) => t.key === "fitness")!, [], new Date()), access: ["health", "journal"] as any, pinned: true, instructions: "Help me train for the Boston marathon." };
  prefs[AI_MODES_PREF] = serializeAiModes([fit]);
  lib = await import("../server/ai-mode-library");
  lib.setLibraryClientForTests(fakeClient());
});
const ok = <T extends { ok: boolean }>(r: T) => { expect(r.ok, JSON.stringify(r)).toBe(true); return r as Extract<T, { ok: true }>; };

describe("publishing", () => {
  it("publishes the stored mode's setup only; the author is never returned", async () => {
    const r = ok(await lib.publishMode(ME, "fitness-coach"));
    expect(r.item).toMatchObject({ name: "Fitness Coach", mine: true, installs: 0 });
    expect(JSON.stringify(r.item)).not.toContain(ME);
    const stored = rows[0];
    expect(stored.author_id).toBe(ME);
    expect(stored.template.mode.id).toBeUndefined();
    expect(stored.template.mode.pinned).toBeUndefined();
    expect(stored.template.mode.createdAt).toBeUndefined();
    expect(stored.template.mode.access).toEqual(["health"]); // the journal switch is never shared
    expect((await lib.publishMode(ME, "not-mine")).ok).toBe(false);

    const seen = ok(await lib.listLibrary(YOU, {}));
    expect(seen.items).toHaveLength(1);
    expect(seen.items[0]).toMatchObject({ name: "Fitness Coach", mine: false });
    expect(JSON.stringify(seen.items)).not.toContain(ME);
  });

  it("only the author can unpublish", async () => {
    const { item } = ok(await lib.publishMode(ME, "fitness-coach"));
    expect(await lib.unpublishMode(YOU, item.id)).toMatchObject({ ok: false, status: 404 });
    expect(rows).toHaveLength(1);
    ok(await lib.unpublishMode(ME, item.id));
    expect(rows).toHaveLength(0);
  });
});

describe("browsing and installing", () => {
  it("search, popular first; installing is a fresh proposal with the journal off, and counts", async () => {
    const { item } = ok(await lib.publishMode(ME, "fitness-coach"));
    expect(ok(await lib.listLibrary(YOU, { q: "marathon" })).items).toHaveLength(0); // searches name and tagline only
    expect(ok(await lib.listLibrary(YOU, { q: "fitness" })).items).toHaveLength(1);
    const got = ok(await lib.installMode(item.id));
    expect(got.mode.name).toBe("Fitness Coach");
    expect(got.mode.id).toBe("fitness-coach-2"); // next to the installer's own copy, never over it
    expect(got.mode.pinned).toBe(false);
    expect(got.mode.access).not.toContain("journal");
    expect(rows[0].installs).toBe(1);
    expect(await lib.installMode("not-a-uuid")).toMatchObject({ ok: false, status: 404 });
  });

  it("three different people's reports hide an entry; one person counts once", async () => {
    const { item } = ok(await lib.publishMode(ME, "fitness-coach"));
    await lib.reportMode(YOU, item.id);
    await lib.reportMode(YOU, item.id);
    expect(ok(await lib.listLibrary(YOU, {})).items).toHaveLength(1);
    await lib.reportMode("33333333-3333-4333-8333-333333333333", item.id);
    expect(ok(await lib.reportMode("44444444-4444-4444-8444-444444444444", item.id)).hidden).toBe(true);
    expect(ok(await lib.listLibrary(YOU, {})).items).toHaveLength(0);
    expect(await lib.installMode(item.id)).toMatchObject({ ok: false, status: 404 });
  });

  it("a library whose table is missing says so — it is never an empty library", async () => {
    missingTable = true;
    expect(await lib.listLibrary(YOU, {})).toMatchObject({ ok: false, status: 503 });
  });
});
