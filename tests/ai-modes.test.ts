// Custom AI Modes, the pure rules (owner request 2026-11-27; shared/ai-modes.ts).
//
// A mode is a DESCRIPTION built from approved parts. Whatever made it — the
// model, a template, the fixed rules, an imported file — it passes
// `sanitizeAiMode`: unknown parts are dropped (never coerced), there is
// always exactly one Chat tab, and no builder turns the journal on (WA2).
import { describe, it, expect } from "vitest";
import {
  MAX_MODE_TABS, MODE_TEMPLATES, applyModePatch, describeModeChanges, exportModeTemplate, importModeTemplate, inferModeFromText,
  modeFromTemplate, newModeId, parseAiModes, parseModeInsights, reviseModeByRules, sanitizeAiMode, serializeAiModes, type AiMode,
} from "../shared/ai-modes";

const NOW = new Date("2026-11-27T12:00:00Z");
const base = (extra: Record<string, unknown> = {}) => ({
  id: "coach", name: "Coach", icon: "compass", color: "violet", tagline: "t", personality: "p", instructions: "Help me.",
  access: ["tasks"], remember: true, pinned: false,
  tabs: [{ title: "Overview", kind: "overview", widgets: [{ title: "Goals", source: "goals", limit: 3 }] }, { title: "Chat", kind: "chat" }],
  prompts: ["Where do I start?"], ...extra,
});
const mode = (extra: Record<string, unknown> = {}) => sanitizeAiMode(base(extra), { now: NOW, keepJournal: true })!;

describe("sanitizeAiMode: only approved parts", () => {
  it("drops unknown icons, colors, sources, tab kinds and widget sources — never coerced into something plausible", () => {
    const m = sanitizeAiMode(base({
      icon: "<script>", color: "neon", access: ["tasks", "passwords", "finance", "tasks"],
      tabs: [
        { title: "Run code", kind: "html", html: "<img onerror=alert(1)>" },
        { title: "Cards", kind: "widgets", widgets: [{ title: "Bad", source: "sql" }, { title: "Bills", source: "bills", limit: 99 }] },
        { title: "Chat", kind: "chat" },
      ],
    }), { now: NOW })!;
    expect(m.icon).toBe("sparkles");
    expect(m.color).toBe("violet");
    expect(m.access).toEqual(["tasks", "finance"]);
    expect(m.tabs.map((t) => t.kind)).toEqual(["widgets", "chat"]);
    expect(m.tabs[0].widgets).toHaveLength(1);
    expect(m.tabs[0].widgets![0]).toMatchObject({ source: "bills", limit: 8 });
    expect(JSON.stringify(m)).not.toContain("onerror");
  });

  it("always exactly one Chat tab, last; at most eight tabs", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `Tab ${i}`, kind: "insights", focus: "x" }));
    const m = sanitizeAiMode(base({ tabs: [{ title: "Chat", kind: "chat" }, ...many, { title: "Talk", kind: "chat" }] }), { now: NOW })!;
    expect(m.tabs).toHaveLength(MAX_MODE_TABS);
    expect(m.tabs.filter((t) => t.kind === "chat")).toHaveLength(1);
    expect(m.tabs[m.tabs.length - 1].kind).toBe("chat");
    const none = sanitizeAiMode(base({ tabs: [{ title: "Look", kind: "insights" }] }), { now: NOW })!;
    expect(none.tabs.map((t) => t.kind)).toEqual(["insights", "chat"]);
    expect(none.tabs[0].focus).toMatch(/look/i); // an empty focus is filled from the title, never left blank
  });

  it("a mode needs a name and a valid id", () => {
    expect(sanitizeAiMode(base({ name: "" }), { now: NOW })).toBeNull();
    expect(sanitizeAiMode(base({ id: "../etc" }), { now: NOW })).toBeNull();
    expect(sanitizeAiMode("not an object")).toBeNull();
  });

  it("the journal is never turned on by a builder; the person's own switch is kept", () => {
    expect(sanitizeAiMode(base({ access: ["journal", "tasks"] }), { now: NOW, keepJournal: false })!.access).toEqual(["tasks"]);
    expect(sanitizeAiMode(base({ access: ["journal", "tasks"] }), { now: NOW, keepJournal: true })!.access).toEqual(["tasks", "journal"]);
  });
});

describe("the stored row", () => {
  it("round-trips, and an unreadable row is no modes (not a crash)", () => {
    const a = mode(); const b = mode({ id: "money", name: "Money" });
    expect(parseAiModes(serializeAiModes([a, b])).map((m) => m.id)).toEqual(["coach", "money"]);
    expect(parseAiModes("{broken")).toEqual([]);
    expect(parseAiModes(null)).toEqual([]);
    // A duplicate id is kept once.
    expect(parseAiModes(serializeAiModes([a, a]))).toHaveLength(1);
  });

  it("a stored mode keeps the journal switch the person set", () => {
    expect(parseAiModes(serializeAiModes([mode({ access: ["journal"] })]))[0].access).toEqual(["journal"]);
  });

  it("a patch never changes the id or the date it was made", () => {
    const m = mode();
    const next = applyModePatch(m, { id: "other", createdAt: "2000-01-01T00:00:00Z", name: "Better coach", pinned: true }, NOW)!;
    expect(next).toMatchObject({ id: "coach", createdAt: m.createdAt, name: "Better coach", pinned: true });
  });

  it("new ids are unique and readable", () => {
    expect(newModeId([{ id: "life-coach" }], "Life Coach")).toBe("life-coach-2");
    expect(newModeId([], "!!!")).toBe("mode");
  });
});

describe("templates", () => {
  it("every built-in template is a valid five-tab mode that does not read the journal", () => {
    expect(MODE_TEMPLATES.length).toBeGreaterThanOrEqual(10);
    for (const t of MODE_TEMPLATES) {
      const m = modeFromTemplate(t, [], NOW);
      expect(m.tabs, t.key).toHaveLength(5);
      expect(m.tabs[4].kind, t.key).toBe("chat");
      expect(m.access, t.key).not.toContain("journal");
      expect(new Set(m.tabs.map((x) => x.kind)).size, `${t.key}: tabs do different work`).toBeGreaterThan(1);
    }
  });

  it("the owner's examples: each tab set is the one asked for", () => {
    const tabs = (key: string) => modeFromTemplate(MODE_TEMPLATES.find((t) => t.key === key)!, [], NOW).tabs.map((t) => t.title);
    expect(tabs("finance")).toEqual(["Overview", "Spending", "Forecasts", "Strategy", "Chat"]);
    expect(tabs("fitness")).toEqual(["Progress", "Workouts", "Recovery", "Plans", "Chat"]);
    expect(tabs("reflection")).toEqual(["Insights", "Emotions", "Patterns", "Journal", "Chat"]);
    expect(tabs("vehicle")).toEqual(["Overview", "Maintenance", "Costs", "Valuation", "Chat"]);
    expect(tabs("life-coach")).toEqual(["Overview", "Patterns", "Goals", "Growth", "Chat"]);
  });
});

describe("a description → a mode, by fixed rules (no model)", () => {
  it("'understand myself emotionally' → reflection; the journal is SUGGESTED, not switched on", () => {
    const p = inferModeFromText("An AI that helps me understand myself emotionally", [], NOW);
    expect(p).toMatchObject({ by: "rules", suggestJournal: true });
    expect(p.mode.name).toBe("Personal Reflection");
    expect(p.mode.access).not.toContain("journal");
    expect(p.mode.instructions).toContain("understand myself emotionally");
  });

  it("business and fitness ideas find their templates", () => {
    expect(inferModeFromText("An AI that manages my business and projects", [], NOW).mode.name).toBe("Business Manager");
    expect(inferModeFromText("An AI that analyzes my fitness", [], NOW).mode.name).toBe("Fitness Coach");
  });

  it("something no template knows still becomes a working mode", () => {
    const p = inferModeFromText("Help me restore antique clocks", [], NOW);
    expect(p.mode.tabs.map((t) => t.kind)).toContain("chat");
    expect(p.mode.tabs).toHaveLength(5);
    expect(p.mode.name.length).toBeGreaterThan(1);
  });
});

describe("changing a mode by talking (fixed rules)", () => {
  const fitness = () => modeFromTemplate(MODE_TEMPLATES.find((t) => t.key === "fitness")!, [], NOW);

  it("'add a sleep analysis tab and compare my sleep against my workout performance' adds an analysis tab before Chat", () => {
    const next = reviseModeByRules(fitness(), "Add a sleep analysis tab and compare my sleep against my workout performance", NOW)!;
    const added = next.tabs.find((t) => t.title === "Sleep")!;
    expect(added.kind).toBe("insights");
    expect(added.focus).toMatch(/compare my sleep against my workout performance/i);
    expect(next.tabs[next.tabs.length - 1].kind).toBe("chat");
    expect(describeModeChanges(fitness(), next)).toContain("New tab: Sleep");
  });

  it("remove and rename; something it can't read is null (never a guess)", () => {
    const m = fitness();
    expect(reviseModeByRules(m, "remove the Recovery tab", NOW)!.tabs.map((t) => t.title)).not.toContain("Recovery");
    expect(reviseModeByRules(m, "rename it to Coach Kim", NOW)!.name).toBe("Coach Kim");
    expect(reviseModeByRules(m, "make it sing", NOW)).toBeNull();
    // Chat cannot be removed.
    expect(reviseModeByRules(m, "remove the Chat tab", NOW)).toBeNull();
  });
});

describe("sharing a mode shares no private data", () => {
  it("an export carries the setup only; an import is a new mode with the journal off", () => {
    const m = mode({ access: ["journal", "tasks"], pinned: true });
    const file = exportModeTemplate(m);
    const text = JSON.stringify(file);
    expect((file as any).mode.id).toBeUndefined();
    expect(text).not.toContain("createdAt");
    expect(text).not.toContain("pinned");
    expect((file as any).mode.access).toEqual(["tasks"]);
    const back = importModeTemplate(text, [m], NOW)!;
    expect(back.id).toBe("coach-2");
    expect(back.pinned).toBe(false);
    expect(back.access).not.toContain("journal");
    expect(importModeTemplate("not json", [], NOW)).toBeNull();
  });
});

describe("insights are grounded in what was sent", () => {
  it("an item naming a source that was not read, or none, is dropped", () => {
    const raw = JSON.stringify({ items: [
      { title: "Sleep is short", detail: "Six hours on average.", sources: ["health"] },
      { title: "From the journal", detail: "You wrote about stress.", sources: ["journal"] },
      { title: "Floating", detail: "No source at all.", sources: [] },
    ] });
    const items = parseModeInsights(raw, ["health", "tasks"])!;
    expect(items.map((i) => i.title)).toEqual(["Sleep is short"]);
    expect(parseModeInsights("no json here", ["health"])).toBeNull();
  });
});

describe("describeModeChanges", () => {
  it("names what a proposal would change", () => {
    const a = mode() as AiMode;
    const b = applyModePatch(a, { name: "Coach 2", access: ["tasks", "finance"] }, NOW)!;
    expect(describeModeChanges(a, b)).toEqual(["Name: Coach → Coach 2", "Can now read: Money"]);
  });
});
