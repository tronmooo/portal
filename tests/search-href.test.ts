// Rule 23 (2026-09-22): search results are self-describing. Every row
// /api/search returns carries the canonical `href` of its record, including
// the two types that were not searchable at all before (incomes, goals), so
// the palette navigates to the record and never to a generic page.
import { describe, it, expect } from "vitest";
import { searchCorpus, searchRowHref, virtualDateRows, SEARCH_FIELDS, type SearchCorpus } from "../shared/search-match";
import { routeForEntity } from "../shared/entity-routes";
import { MemStorage } from "../server/storage";

const corpus: SearchCorpus = {
  profiles: [
    { id: "p-dana", name: "Dana Zed", type: "person", fields: { birthday: "1990-04-02" } },
    { id: "loan-1", name: "Zed Auto Loan", type: "loan", parentProfileId: "p-dana" },
    { id: "acct-1", name: "Zed Checking", type: "account" },
    { id: "car-1", name: "Zed Civic", type: "vehicle" },
  ],
  trackers: [{ id: "tr-1", name: "Zed weight" }],
  tasks: [{ id: "t-1", title: "Call Zed" }],
  expenses: [{ id: "x-1", description: "Zed groceries", amount: 12 }],
  habits: [{ id: "h-1", name: "Zed run" }],
  obligations: [{ id: "o-1", name: "Zed rent" }],
  artifacts: [{ id: "a-1", title: "Zed plan" }],
  journal: [{ id: "j-1", content: "Saw Zed today" }],
  memories: [{ id: "m-1", key: "zed", value: "likes tea" }],
  events: [{ id: "e-1", title: "Zed lunch", date: "2026-10-01" }],
  documents: [{ id: "d-1", name: "Zed passport", fileData: "AAAA" }],
  incomes: [{ id: "i-1", description: "Zed salary", amount: 5000, frequency: "monthly" }],
  goals: [{ id: "g-1", title: "Zed savings goal", type: "savings", target: 100, current: 0 }],
};

describe("searchCorpus stamps every row with its canonical href", () => {
  const hits = searchCorpus(corpus, "zed");
  const by = (t: string) => hits.filter((h) => h._type === t);

  it("finds income and goal rows (they were not searchable before)", () => {
    expect(by("income").map((h) => h.id)).toEqual(["i-1"]);
    expect(by("goal").map((h) => h.id)).toEqual(["g-1"]);
    expect(SEARCH_FIELDS.income).toContain("description");
    expect(SEARCH_FIELDS.goal).toContain("title");
  });

  it("every row of every type carries a non-empty href", () => {
    const types = new Set(hits.map((h) => h._type));
    for (const t of ["profile", "tracker", "task", "expense", "habit", "obligation", "artifact", "journal", "memory", "event", "document", "income", "goal"]) {
      expect(types.has(t), `type ${t} present`).toBe(true);
    }
    for (const h of hits) {
      expect(typeof h.href, `${h._type}:${h.id}`).toBe("string");
      expect(h.href.length, `${h._type}:${h.id}`).toBeGreaterThan(0);
      expect(h.href.startsWith("/"), `${h._type}:${h.id} hash-free`).toBe(true);
      expect(h.href, `${h._type}:${h.id}`).not.toBe("/documents");
      expect(h.href, `${h._type}:${h.id}`).not.toMatch(/[?&](open|focus|event)=/);
    }
  });

  it("the href is the record's route, per type", () => {
    const expect1 = (t: string, id: string, href: string) => {
      const row = hits.find((h) => h._type === t && h.id === id);
      expect(row, `${t}:${id}`).toBeTruthy();
      expect(row!.href, `${t}:${id}`).toBe(href);
    };
    expect1("task", "t-1", "/dashboard/tasks?highlight=task%3At-1");
    expect1("expense", "x-1", "/dashboard/finance?highlight=expense%3Ax-1");
    expect1("income", "i-1", "/dashboard/finance?highlight=income%3Ai-1");
    expect1("goal", "g-1", "/goals?highlight=goal%3Ag-1");
    expect1("habit", "h-1", "/dashboard/habits?highlight=habit%3Ah-1");
    expect1("obligation", "o-1", "/dashboard/obligations?highlight=obligation%3Ao-1");
    expect1("journal", "j-1", "/dashboard/journal?highlight=journal%3Aj-1");
    expect1("event", "e-1", "/calendar?highlight=event%3Ae-1");
    expect1("tracker", "tr-1", "/trackers?tracker=tr-1");
    expect1("document", "d-1", "/documents/d-1");
    expect1("artifact", "a-1", "/editor/a-1");
  });

  it("a loan / account / vehicle / person profile row opens THAT record, never the profiles list", () => {
    for (const id of ["p-dana", "loan-1", "acct-1", "car-1"]) {
      const row = hits.find((h) => h._type === "profile" && h.id === id)!;
      expect(row.href, id).toBe(`/profiles/${id}`);
    }
  });

  it("a profile-derived date opens the profile that carries it, hash-free", () => {
    const bday = hits.find((h) => h._type === "event" && h.virtual);
    expect(bday, "Dana's birthday").toBeTruthy();
    expect(bday!.href).toBe("/profiles/p-dana");
    for (const v of virtualDateRows(corpus.profiles!)) expect(v.href.startsWith("/")).toBe(true);
  });

  it("documents still never leak their file body", () => {
    const doc = hits.find((h) => h._type === "document")!;
    expect(doc.fileData).toBeUndefined();
    expect(doc.href).toBe("/documents/d-1");
  });
});

describe("searchRowHref", () => {
  it("keeps a row's own href, resolves otherwise, and tolerates unknown types", () => {
    expect(searchRowHref({ _type: "task", id: "t", href: "#/custom" })).toBe("/custom");
    expect(searchRowHref({ _type: "task", id: "t" })).toBe(routeForEntity("task", "t"));
    expect(searchRowHref({ _type: "nope", id: "t" })).toBe("/dashboard");
  });
});

describe("MemStorage.search (the storage contract both backends share)", () => {
  it("returns income and goal rows with hrefs", async () => {
    const s = new MemStorage();
    const anyS = s as any;
    anyS.incomes.set("inc-1", { id: "inc-1", description: "Quux salary", amount: 1, category: "salary", frequency: "monthly", linkedProfiles: [], tags: [], createdAt: "2026-01-01" });
    anyS.goals.set("goal-1", { id: "goal-1", title: "Quux fund", type: "savings", target: 1, current: 0, unit: "$", status: "active", milestones: [], linkedProfiles: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" });
    const rows = await s.search("quux");
    const inc = rows.find((r: any) => r._type === "income");
    const goal = rows.find((r: any) => r._type === "goal");
    expect(inc?.href).toBe("/dashboard/finance?highlight=income%3Ainc-1");
    expect(goal?.href).toBe("/goals?highlight=goal%3Agoal-1");
    for (const r of rows) expect(typeof r.href).toBe("string");
  });
});
