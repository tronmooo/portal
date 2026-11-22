// Cards the user builds for their own Executive tab (shared/exec-widgets,
// server/exec-widget-builder). Owner request 2026-11-22: "develop AI and stuff
// for own customizations of what you wanna follow and keep track of — can do
// journal entries, etc., anything."
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  WIDGET_TEMPLATES, sanitizeWidget, inferWidgetFromText, buildWidgetView, describeWidget, newWidgetId, widgetNeeds,
  type ExecWidget,
} from "../shared/exec-widgets";
import { buildWidgetFromPrompt, extractJsonObject } from "../server/exec-widget-builder";
import { startHarness, type Harness } from "./helpers/route-harness";

const TODAY = "2026-11-22";
const w = (over: Partial<ExecWidget>): ExecWidget => ({ id: "x", title: "X", icon: "star", source: "journal", limit: 4, ...over });

describe("a widget is a typed description, held to what the app can draw", () => {
  it("accepts a well-formed widget and fills in the rest", () => {
    expect(sanitizeWidget({ id: "v", title: "Vehicle Overview", source: "profiles", types: ["vehicle", "spaceship"], limit: 99 }))
      .toEqual({ id: "v", title: "Vehicle Overview", icon: "users", source: "profiles", types: ["vehicle"], limit: 8 });
  });
  it("refuses a source the app does not have, a missing title or id", () => {
    expect(sanitizeWidget({ id: "a", title: "Secrets", source: "passwords" })).toBeNull();
    expect(sanitizeWidget({ id: "a", title: "", source: "journal" })).toBeNull();
    expect(sanitizeWidget({ title: "No id", source: "journal" })).toBeNull();
    expect(sanitizeWidget(null)).toBeNull();
    expect(sanitizeWidget("journal")).toBeNull();
  });
  it("drops what does not apply: types on a non-profile source, a blank filter, a silly window", () => {
    expect(sanitizeWidget({ id: "j", title: "Journal", source: "journal", types: ["pet"], match: "  ", days: -3, icon: "nope" }))
      .toEqual({ id: "j", title: "Journal", icon: "book", source: "journal", limit: 4 });
  });
  it("every Widget Idea is a valid widget", () => {
    expect(WIDGET_TEMPLATES.map((t) => t.widget.title)).toEqual(
      ["Vehicle Overview", "Fitness Summary", "Pet Care Tracker", "Home & Property", "Spending This Month", "Recent Journal"]);
    for (const t of WIDGET_TEMPLATES) expect(sanitizeWidget({ ...t.widget, id: t.key }), t.key).not.toBeNull();
  });
  it("gives each new card its own id", () => {
    expect(newWidgetId([], "Recent Journal")).toBe("recent-journal");
    expect(newWidgetId([w({ id: "recent-journal" })], "Recent Journal")).toBe("recent-journal-2");
    expect(newWidgetId([], "!!!")).toBe("widget");
  });
});

describe("a sentence becomes a widget by fixed rules (the builder's fallback)", () => {
  const read = (text: string) => { const { id, title, limit, icon, ...rest } = inferWidgetFromText(text); return rest; };
  it("reads what the request is about", () => {
    expect(read("journal entries about work")).toEqual({ source: "journal", match: "work" });
    expect(read("how much I spend on groceries")).toEqual({ source: "expenses", match: "groceries" });
    expect(read("my dog's vet visits")).toEqual({ source: "profiles", types: ["pet"] });
    expect(read("my cars")).toEqual({ source: "profiles", types: ["vehicle"] });
    expect(read("goals I'm working on")).toMatchObject({ source: "goals" });
    expect(read("my workouts")).toEqual({ source: "trackers", match: "fitness" });
    expect(read("track my sleep")).toEqual({ source: "trackers", match: "sleep" });
    expect(read("my notes")).toEqual({ source: "notes" });
  });
  it("always answers with something valid, and titles it from the request", () => {
    const got = inferWidgetFromText("show me my spending on coffee", "c1");
    expect(got.id).toBe("c1");
    expect(got.title).toBe("Spending on coffee");
    expect(sanitizeWidget(got)).toEqual(got);
    expect(sanitizeWidget(inferWidgetFromText("asdf qwer"))).not.toBeNull();
    expect(sanitizeWidget(inferWidgetFromText(""))).not.toBeNull();
  });
});

describe("what a card shows comes from the user's own records", () => {
  it("Recent Journal: newest first, titled, limited", () => {
    const view = buildWidgetView(w({ source: "journal", limit: 2 }), { journal: [
      { id: "a", date: "2026-11-20", title: "Old", content: "…", mood: "good", createdAt: "2026-11-20T10:00:00Z" },
      { id: "b", date: "2026-11-22", title: "Lake day", content: "…", mood: "great", createdAt: "2026-11-22T10:00:00Z" },
      { id: "c", date: "2026-11-21", content: "No title, so the text is the title", mood: "ok", createdAt: "2026-11-21T10:00:00Z" },
    ] }, TODAY);
    expect(view.rows.map((r) => r.title)).toEqual(["Lake day", "No title, so the text is the title"]);
    expect(view.total).toBe(3);
    expect(view.rows[0].sub).toBe("Nov 22 · great");
  });

  it("a filter keeps only what matches", () => {
    const view = buildWidgetView(w({ source: "journal", match: "work" }), { journal: [
      { id: "a", date: TODAY, title: "Work was rough", content: "", createdAt: "2026-11-22T10:00:00Z" },
      { id: "b", date: TODAY, title: "Dinner", content: "nothing about it", createdAt: "2026-11-22T11:00:00Z" },
      { id: "c", date: TODAY, title: "Friday", content: "", tags: ["work"], createdAt: "2026-11-22T09:00:00Z" },
    ] }, TODAY);
    expect(view.rows.map((r) => r.key)).toEqual(["journal:a", "journal:c"]);
  });

  it("Spending This Month: the month's total and its categories, largest first", () => {
    const view = buildWidgetView(w({ source: "expenses", limit: 5 }), { expenses: [
      { id: "1", amount: 120, category: "groceries", date: "2026-11-03" },
      { id: "2", amount: 30, category: "dining", date: "2026-11-10" },
      { id: "3", amount: 80, category: "groceries", date: "2026-11-21" },
      { id: "4", amount: 999, category: "travel", date: "2026-10-30" },       // last month
      { id: "5", amount: 50, category: "dining", date: "2026-11-12", deletedAt: "2026-11-13" }, // deleted
    ] }, TODAY);
    expect(view.headline).toEqual({ label: "This month", value: "$230" });
    expect(view.rows.map((r) => [r.title, r.right])).toEqual([["Groceries", "$200"], ["Dining", "$30"]]);
    expect(view.rows[0].sub).toBe("87% of spending");
  });

  it("spending on one thing lists those purchases", () => {
    const view = buildWidgetView(w({ source: "expenses", match: "coffee", days: 30 }), { expenses: [
      { id: "1", amount: 5, category: "dining", description: "Coffee", date: "2026-11-20" },
      { id: "2", amount: 60, category: "groceries", description: "Market", date: "2026-11-20" },
    ] }, TODAY);
    expect(view.headline).toEqual({ label: "Last 30 days", value: "$5" });
    expect(view.rows.map((r) => r.title)).toEqual(["Coffee"]);
  });

  it("Vehicle Overview: each vehicle with its value and the next task for it", () => {
    const view = buildWidgetView(w({ source: "profiles", types: ["vehicle"] }), {
      profiles: [
        { id: "car", type: "vehicle", name: "Honda CR-V", fields: { currentValue: 21500 } },
        { id: "me", type: "self", name: "Me", fields: {} },
        { id: "dog", type: "pet", name: "Rex", fields: {} },
      ],
      tasks: [
        { id: "t1", title: "Change the oil", status: "todo", dueDate: "2026-12-01", linkedProfiles: ["car"] },
        { id: "t2", title: "Done already", status: "done", dueDate: "2026-11-01", linkedProfiles: ["car"] },
      ],
    }, TODAY);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ title: "Honda CR-V", sub: "Next: Change the oil · Dec 1", right: "$21,500" });
    expect(view.headline).toEqual({ label: "Total value", value: "$21,500" });
  });

  it("trackers: the latest reading of each, most recently logged first", () => {
    const view = buildWidgetView(w({ source: "trackers", match: "sleep" }), { trackers: [
      { id: "s", name: "Sleep", category: "health", fields: [{ name: "hours", unit: "h" }], entries: [
        { timestamp: "2026-11-21T07:00:00Z", values: { hours: 6.5 } }, { timestamp: "2026-11-22T07:00:00Z", values: { hours: 7.5 } }] },
      { id: "w", name: "Weight", category: "health", entries: [] },
    ] }, TODAY);
    expect(view.rows.map((r) => [r.title, r.right])).toEqual([["Sleep", "7.5 h"]]);
  });

  it("a list that has not loaded yields no rows rather than throwing", () => {
    expect(buildWidgetView(w({ source: "goals" }), {}, TODAY)).toEqual({ headline: undefined, rows: [], total: 0 });
  });

  it("says which lists a card reads, and what it shows", () => {
    expect(widgetNeeds(w({ source: "profiles" }))).toEqual(["profiles", "tasks"]);
    expect(widgetNeeds(w({ source: "journal" }))).toEqual(["journal"]);
    expect(describeWidget(w({ source: "journal", match: "work", limit: 3 }))).toBe("Your latest journal entries matching “work” (up to 3).");
    expect(describeWidget(w({ source: "profiles", types: ["pet"], limit: 4 }))).toBe("Your pets, with value and the next task for each (up to 4).");
  });
});

describe("the AI builder", () => {
  const key = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => { delete process.env.ANTHROPIC_API_KEY; });
  afterEach(() => { if (key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = key; });

  it("reads the model's JSON out of whatever surrounds it", () => {
    expect(extractJsonObject('Sure!\n```json\n{"title":"Dog Care","source":"profiles"}\n```')).toEqual({ title: "Dog Care", source: "profiles" });
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject("[1,2]")).toBeNull();
    expect(extractJsonObject("{broken")).toBeNull();
  });

  it("answers by the fixed rules when no model is available", async () => {
    const got = await buildWidgetFromPrompt("journal entries about work", {}, "w1");
    expect(got.by).toBe("rules");
    expect(got.widget).toMatchObject({ id: "w1", source: "journal", match: "work" });
  });

  describe("GET /api/exec-widgets/suggest", () => {
    let h: Harness | null = null;
    afterEach(async () => { await h?.close(); h = null; });

    it("answers with a valid widget and writes nothing", async () => {
      h = await startHarness({});
      const before = Object.keys(h.db.preferences ?? {}).filter((k) => k !== "timezone");
      const r = await h.api("GET", `/api/exec-widgets/suggest?prompt=${encodeURIComponent("how much I spend on groceries")}`);
      expect(r.status).toBe(200);
      expect(r.data.by).toBe("rules");
      expect(sanitizeWidget(r.data.widget)).toEqual(r.data.widget);
      expect(r.data.widget).toMatchObject({ source: "expenses", match: "groceries" });
      // Nothing is stored by asking (the request's own timezone note aside).
      expect(Object.keys(h.db.preferences ?? {}).filter((k) => k !== "timezone")).toEqual(before);
      expect((h.db.preferences ?? {}).exec_card_prefs).toBeUndefined();
    });

    it("refuses an empty or oversized description", async () => {
      h = await startHarness({});
      expect((await h.api("GET", "/api/exec-widgets/suggest?prompt=")).status).toBe(400);
      expect((await h.api("GET", `/api/exec-widgets/suggest?prompt=${"x".repeat(301)}`)).status).toBe(400);
    });
  });
});
