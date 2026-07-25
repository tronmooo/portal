import { describe, it, expect } from "vitest";
import {
  generateStarterPrompts,
  themeCountsFromMessages,
  classifyMessageTheme,
  parseUsage,
  recordServed,
  recordClick,
  emptyUsage,
  FATIGUE_SERVED_THRESHOLD,
  type StarterPromptSnapshot,
} from "../shared/starter-prompts";

// Fixed "now" so date math is deterministic: Saturday 2026-07-25.
const NOW = "2026-07-25T12:00:00Z";

const RICH: StarterPromptSnapshot = {
  now: NOW,
  tasks: [
    { title: "Renew car insurance", status: "todo", dueDate: "2026-07-20" }, // overdue
    { title: "Call plumber", status: "todo", dueDate: "2026-07-28" },        // due this week
    { title: "Done thing", status: "done", dueDate: "2026-07-01" },
  ],
  events: [{ title: "Dentist", date: "2026-07-27" }],
  habits: [
    { name: "Meditate", frequency: "daily", currentStreak: 4, checkins: [{ date: "2026-07-21" }] }, // stale
  ],
  documents: [
    { name: "Florida Driver License", type: "drivers_license", expirationDate: "2026-08-15", createdAt: "2026-01-01" },
  ],
  expenses: [
    { amount: 900, date: "2026-07-10", category: "groceries" },
    { amount: 500, date: "2026-07-15", category: "dining" },
    { amount: 300, date: "2026-07-20", category: "gas" },
    { amount: 400, date: "2026-06-10", category: "groceries" },
    { amount: 350, date: "2026-06-20", category: "dining" },
  ],
  obligations: [{ name: "Rent", amount: 2000, nextDueDate: "2026-07-31" }],
  trackers: [
    { name: "Weight", category: "health", entries: [{ timestamp: "2026-07-01" }, { timestamp: "2026-07-10" }, { timestamp: "2026-07-20" }] },
  ],
  journalEntries: [{ date: "2026-07-01" }, { date: "2026-07-10" }, { date: "2026-07-20" }],
  profiles: [
    { name: "Me", type: "self" },
    { name: "Honda CR-V", type: "vehicle" },
    { name: "Luna", type: "pet" },
    { name: "Car Loan", type: "loan" },
  ],
};

describe("generateStarterPrompts — data-driven candidates", () => {
  it("surfaces overdue work first for a user with overdue tasks", () => {
    const prompts = generateStarterPrompts(RICH, emptyUsage(), 6);
    expect(prompts[0].id).toBe("overdue_tasks");
    expect(prompts[0].text).toContain("overdue");
  });

  it("includes due-this-week, expiring docs, and habit gaps for the rich profile", () => {
    const ids = generateStarterPrompts(RICH, emptyUsage(), 8).map(p => p.id);
    expect(ids).toContain("due_this_week");
    expect(ids).toContain("docs_expiring");
    expect(ids).toContain("habits_missed");
  });

  it("flags a month-over-month spending spike with a high-priority anomaly prompt", () => {
    const prompts = generateStarterPrompts(RICH, emptyUsage(), 8);
    const anomaly = prompts.find(p => p.id === "spending_anomaly");
    expect(anomaly).toBeDefined();
    expect(anomaly!.reason).toContain(">25%");
  });

  it("returns between 4 and 8 prompts and clamps the requested count", () => {
    expect(generateStarterPrompts(RICH, emptyUsage(), 1).length).toBeGreaterThanOrEqual(4);
    expect(generateStarterPrompts(RICH, emptyUsage(), 50).length).toBeLessThanOrEqual(8);
  });

  it("caps prompts per theme so one hot area can't crowd out the rest", () => {
    const prompts = generateStarterPrompts(RICH, emptyUsage(), 8);
    const perTheme: Record<string, number> = {};
    for (const p of prompts) perTheme[p.theme] = (perTheme[p.theme] || 0) + 1;
    for (const n of Object.values(perTheme)) expect(n).toBeLessThanOrEqual(2);
  });

  it("a brand-new sparse account still gets ≥4 useful onboarding prompts", () => {
    const prompts = generateStarterPrompts({ now: NOW }, emptyUsage(), 6);
    expect(prompts.length).toBeGreaterThanOrEqual(4);
    expect(prompts.every(p => p.text.length > 0)).toBe(true);
    // Nothing data-dependent should appear for an empty account.
    expect(prompts.map(p => p.id)).not.toContain("overdue_tasks");
    expect(prompts.map(p => p.id)).not.toContain("docs_expiring");
  });

  it("prompts change as the data changes (overdue task completed → overdue prompt gone)", () => {
    const cleared: StarterPromptSnapshot = {
      ...RICH,
      tasks: RICH.tasks!.map(t => ({ ...t, status: "done" })),
    };
    const ids = generateStarterPrompts(cleared, emptyUsage(), 8).map(p => p.id);
    expect(ids).not.toContain("overdue_tasks");
    expect(ids).not.toContain("focus_today");
  });
});

describe("theme learning from typed messages", () => {
  it("classifies common messages into themes", () => {
    expect(classifyMessageTheme("how much did I spend on groceries")).toBe("finance");
    expect(classifyMessageTheme("log my blood pressure 120/80")).toBe("health");
    expect(classifyMessageTheme("when does my registration expire")).toBe("documents");
    expect(classifyMessageTheme("hello")).toBeNull();
  });

  it("counts recurring themes across a message history", () => {
    const counts = themeCountsFromMessages([
      "spent $40 on gas", "what's my budget looking like", "pay the water bill",
      "log sleep 7 hours",
    ]);
    expect(counts.finance).toBe(3);
    expect(counts.health).toBe(1);
  });

  it("a finance-heavy history lifts finance prompts in the ranking", () => {
    const base = generateStarterPrompts(RICH, emptyUsage(), 8);
    const financeFan = generateStarterPrompts(RICH, { ...emptyUsage(), themeCounts: { finance: 20 } }, 8);
    const rank = (list: ReturnType<typeof generateStarterPrompts>, id: string) => list.findIndex(p => p.id === id);
    expect(rank(financeFan, "financial_health")).toBeGreaterThanOrEqual(0);
    expect(rank(financeFan, "financial_health")).toBeLessThan(
      rank(base, "financial_health") === -1 ? 99 : rank(base, "financial_health") + 1,
    );
  });
});

describe("click reinforcement and fatigue decay", () => {
  it("a clicked prompt ranks higher on the next generation", () => {
    const usage = emptyUsage();
    recordClick(usage, "health_trends", "health", new Date(NOW));
    recordClick(usage, "health_trends", "health", new Date(NOW));
    const withClicks = generateStarterPrompts(RICH, usage, 8);
    const without = generateStarterPrompts(RICH, emptyUsage(), 8);
    const pos = (l: typeof withClicks) => l.findIndex(p => p.id === "health_trends");
    expect(pos(withClicks)).toBeGreaterThanOrEqual(0);
    expect(pos(withClicks)).toBeLessThan(pos(without) === -1 ? 99 : pos(without) + 1);
  });

  it("served-but-never-clicked prompts decay out of rotation", () => {
    const usage = emptyUsage();
    for (let i = 0; i < FATIGUE_SERVED_THRESHOLD + 2; i++) recordServed(usage, ["calendar_week"]);
    const prompts = generateStarterPrompts(RICH, usage, 6);
    const fatigued = prompts.find(p => p.id === "calendar_week");
    const fresh = generateStarterPrompts(RICH, emptyUsage(), 6).find(p => p.id === "calendar_week");
    // Either it dropped out of the top set entirely, or it scores well below
    // its fresh self — both mean something else gets the slot.
    if (fatigued && fresh) expect(fatigued.score).toBeLessThan(fresh.score);
    else expect(fresh).toBeDefined();
  });

  it("a click protects a frequently-served prompt from fatigue", () => {
    const usage = emptyUsage();
    for (let i = 0; i < FATIGUE_SERVED_THRESHOLD + 2; i++) recordServed(usage, ["calendar_week"]);
    recordClick(usage, "calendar_week", "calendar", new Date(NOW));
    const p = generateStarterPrompts(RICH, usage, 8).find(x => x.id === "calendar_week");
    expect(p).toBeDefined();
  });
});

describe("usage-stats bookkeeping", () => {
  it("parseUsage survives null, garbage, and partial blobs", () => {
    expect(parseUsage(null)).toEqual(emptyUsage());
    expect(parseUsage("not json{{{")).toEqual(emptyUsage());
    expect(parseUsage(JSON.stringify({ served: { a: 1 } })).served.a).toBe(1);
    expect(parseUsage(JSON.stringify({ served: null }))).toEqual(emptyUsage());
  });

  it("recordServed and recordClick bound their maps", () => {
    const usage = emptyUsage();
    for (let i = 0; i < 100; i++) recordServed(usage, [`p${i}`]);
    expect(Object.keys(usage.served).length).toBeLessThanOrEqual(60);
    for (let i = 0; i < 100; i++) recordClick(usage, `c${i}`, "finance");
    expect(Object.keys(usage.clicked).length).toBeLessThanOrEqual(60);
  });

  it("clicks feed theme affinity", () => {
    const usage = emptyUsage();
    recordClick(usage, "spending_anomaly", "finance");
    expect(usage.themeCounts.finance).toBe(2);
  });
});
