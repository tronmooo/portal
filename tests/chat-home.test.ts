// The chat home (owner's design, 2026-11-25): every figure is one another
// screen already shows, a list that has not loaded is never a zero, and
// something never recorded is "untracked" (shared/chat-home).
// The wellness fixture is one person's sixty days ending 2026-11-23.
import { describe, it, expect } from "vitest";
import { buildChatHome, homeClock, homeMoney, homeMoneyCompact, type ChatHomeInput, type HomeList } from "../shared/chat-home";
import { overviewTiles } from "../shared/wellness-cards";
import { TODAY, TZ, fixtureMetrics, fixtureTrackers, tracker, entry } from "./helpers/wellness-fixture";

const SNAPSHOT = {
  totalMonthlySpend: 562, lastMonthTotal: 493, totalAssetValue: 60350, totalLiabilities: 18000,
  spendByCategory: { food: 210.4, transport: 95, general: 12 },
  assetBreakdown: [{ id: "a1", name: "Honda CR-V", value: 26800 }, { id: "a2", name: "Savings", value: 33550 }].sort((a, b) => b.value - a.value),
  upcomingBills: [
    { id: "b1", name: "Internet", amount: 92, daysUntil: 2 },
    { id: "b2", name: "Netflix", amount: 9.99, daysUntil: 5 },
    { id: "b2", name: "Netflix", amount: 9.99, daysUntil: 5 },        // the same bill listed twice
    { id: "b3", name: "Rent", amount: 1800, daysUntil: 4, autopay: true }, // on Auto Pay: quiet (A6)
    { id: "b4", name: "Insurance", amount: 140, daysUntil: 20 },
  ],
};
const TASKS = [
  { id: "t1", title: "Call the dentist", status: "todo", dueDate: TODAY },
  { id: "t2", title: "Renew tabs", status: "todo", dueDate: "2026-11-20" },
  { id: "t3", title: "Someday", status: "todo" },
  { id: "t4", title: "Done", status: "done", dueDate: TODAY },
];
const full = (over: Partial<ChatHomeInput> = {}): ChatHomeInput => {
  const trackers = fixtureTrackers();
  return {
    todayISO: TODAY, timezone: TZ, trackers, metrics: fixtureMetrics(trackers), snapshot: SNAPSHOT, tasks: TASKS as any,
    eventsToday: [{ title: "Soccer", time: "21:00" }],
    expiring: [{ baseName: "Driver's license", typesLabel: "Expiration", daysUntil: 31, ruleIds: [], alertIds: [], ruleTypes: [], mergedCount: 1 } as any],
    journal: [{ date: TODAY, mood: "good" }, { date: "2026-11-21", mood: "great" }, { date: "2026-10-01", mood: "bad" }],
    ...over,
  };
};
const kpi = (h: ReturnType<typeof buildChatHome>, key: string) => {
  const k = h.kpis.find((x) => x.key === key);
  if (!k) throw new Error(`no ${key} figure`);
  return k;
};
const glance = (h: ReturnType<typeof buildChatHome>, key: string) => {
  const g = h.glance.find((x) => x.key === key);
  if (!g) throw new Error(`no ${key} chip`);
  return g;
};
const insight = (h: ReturnType<typeof buildChatHome>, key: string) => {
  const g = h.insights.find((x) => x.key === key);
  if (!g) throw new Error(`no ${key} insight`);
  return g;
};

describe("headline figures", () => {
  const h = buildChatHome(full());

  it("are six, in the design's order", () => {
    expect(h.kpis.map((k) => k.key)).toEqual(["activity", "sleep", "rhr", "weight", "spending", "networth"]);
  });
  it("the wellness ones are the Wellness tab's own tiles over 7 days", () => {
    const trackers = fixtureTrackers();
    const tiles = overviewTiles({ metrics: fixtureMetrics(trackers), trackers, range: "7d", todayISO: TODAY, timezone: TZ });
    for (const key of ["activity", "sleep", "weight"] as const) {
      const t = tiles.find((x) => x.key === key)!;
      const k = kpi(h, key);
      expect(t.tracked).toBe(true);
      expect(k.state).toBe("ready");
      expect(`${k.value}${k.unit ? ` ${k.unit}` : ""}`).toBe(String(t.value).replace(/ avg$/, ""));
    }
  });
  it("spending and net worth are the finance snapshot's", () => {
    expect(kpi(h, "spending")).toMatchObject({ value: "$562", note: "this month", delta: { text: "+14%", dir: "up", good: false } });
    expect(kpi(h, "networth")).toMatchObject({ value: "$42,350", state: "ready" });
  });
  it("something never recorded is untracked, with a way to start — never a zero", () => {
    const none = buildChatHome(full({ trackers: [], metrics: fixtureMetrics([]) }));
    for (const key of ["activity", "sleep", "rhr", "weight"]) {
      const k = kpi(none, key);
      expect(k.state).toBe("untracked");
      expect(k.value).toBeNull();
      expect(typeof k.prompt).toBe("string");
    }
  });
});

describe("a list that has not loaded is not an empty list (Rule 7)", () => {
  it("loading figures have no value", () => {
    const h = buildChatHome({ todayISO: TODAY, timezone: TZ });
    expect(h.kpis.length).toBe(6);
    for (const k of h.kpis) { expect(k.state).toBe("loading"); expect(k.value).toBeNull(); }
    for (const g of h.glance) expect(g.state).toBe("loading");
    for (const x of h.insights) expect(x.state).toBe("loading");
    expect(h.lines).toEqual([]);
  });
  it("a failed list says so, and the others still read", () => {
    const h = buildChatHome(full({ tasks: undefined, snapshot: undefined, failed: new Set<HomeList>(["tasks", "snapshot"]) }));
    expect(glance(h, "tasks")).toMatchObject({ state: "error", detail: "Couldn't load" });
    expect(kpi(h, "networth")).toMatchObject({ state: "error", value: null });
    expect(insight(h, "finance").state).toBe("error");
    expect(kpi(h, "sleep").state).toBe("ready");
  });
});

describe("today at a glance", () => {
  const h = buildChatHome(full());

  it("counts tasks the way the Tasks card does", () => {
    expect(glance(h, "tasks")).toMatchObject({ label: "2 Tasks Due", detail: "1 late" });
  });
  it("names today's first event with its time", () => {
    expect(glance(h, "events")).toMatchObject({ label: "1 Event", detail: "Soccer – 9:00 PM" });
  });
  it("lists each bill due this week once, and leaves an Auto Pay bill quiet", () => {
    expect(glance(h, "bills")).toMatchObject({ label: "2 Bills Due", detail: "$92, $9.99" });
  });
  it("says so when there is nothing", () => {
    const quiet = buildChatHome(full({ tasks: [], eventsToday: [], snapshot: { ...SNAPSHOT, upcomingBills: [] } }));
    expect(glance(quiet, "tasks")).toMatchObject({ label: "No Tasks Due", state: "ready" });
    expect(glance(quiet, "events").label).toBe("No Events");
    expect(glance(quiet, "bills").label).toBe("No Bills Due");
  });
  it("hydration shows only when water is tracked; the bar is today against the week's average", () => {
    expect(h.glance.some((g) => g.key === "hydration")).toBe(false);
    const water = tracker("t-water", "Water", "health", [{ name: "oz", unit: "oz" }], [entry(TODAY, { oz: 24 }), entry("2026-11-22", { oz: 72 })]);
    const trackers = [...fixtureTrackers(), water];
    const w = glance(buildChatHome(full({ trackers, metrics: fixtureMetrics(trackers) })), "hydration");
    expect(w.detail).toBe("24 oz · avg 48");
    expect(w.progress).toBe(0.5);
  });
});

describe("the daily summary", () => {
  it("puts what is due before the trends, at most five lines, each once", () => {
    const h = buildChatHome(full());
    expect(h.lines.length).toBeLessThanOrEqual(5);
    expect(new Set(h.lines.map((l) => l.key)).size).toBe(h.lines.length);
    expect(h.lines.slice(0, 3).map((l) => l.key)).toEqual(["bills", "tasks", "events"]);
    expect(h.lines.find((l) => l.key === "tasks")!.text).toBe("3 tasks open — 1 due today, 1 late.");
    expect(h.lines.find((l) => l.key === "bills")!.text).toBe("2 bills are due in the next 7 days ($101.99).");
    expect(h.lines.find((l) => l.key === "events")!.text).toBe("Today: Soccer – 9:00 PM.");
  });
  it("names the nearest dated document and what the date is", () => {
    const h = buildChatHome(full({ tasks: [], eventsToday: [] }));
    expect(h.lines.find((l) => l.key === "document")!.text).toBe("Driver's license: expiration in 31 days.");
  });
  it("states spending against last month only when there is a last month", () => {
    const h = buildChatHome(full({ tasks: [], eventsToday: [], expiring: [] }));
    expect(h.lines.find((l) => l.key === "spending")!.text).toBe("Spending is up 14% on last month ($562 so far).");
    const first = buildChatHome(full({ tasks: [], eventsToday: [], expiring: [], snapshot: { ...SNAPSHOT, lastMonthTotal: 0 } }));
    expect(first.lines.find((l) => l.key === "spending")!.text).toBe("You've spent $562 this month.");
    expect(kpi(first, "spending").delta).toBeUndefined();
  });
  it("is empty for an empty account — nothing is invented", () => {
    const h = buildChatHome({ todayISO: TODAY, timezone: TZ, trackers: [], metrics: fixtureMetrics([]), snapshot: {}, tasks: [], eventsToday: [], expiring: [], journal: [] });
    expect(h.lines).toEqual([]);
    expect(h.insights.map((x) => x.state)).toEqual(["untracked", "untracked", "untracked", "untracked"]);
    expect(kpi(h, "spending").value).toBe("$0");
  });
});

describe("insights", () => {
  const h = buildChatHome(full());
  it("one per domain, in order", () => {
    expect(h.insights.map((x) => x.key)).toEqual(["wellness", "finance", "mindset", "assets"]);
  });
  it("finance names the month's two largest categories", () => {
    expect(insight(h, "finance").text).toBe("Food and transport are your highest expenses this month ($210, $95).");
  });
  it("mindset counts this week's entries only", () => {
    expect(insight(h, "mindset").text).toMatch(/^2 journal entries this week\. Mood has averaged /);
  });
  it("assets names how many, their worth and the largest", () => {
    expect(insight(h, "assets").text).toBe("2 assets worth $60,350. Largest: Savings at $33,550.");
  });
  it("every row goes somewhere", () => {
    for (const x of [...h.kpis, ...h.insights, ...h.glance, ...h.lines]) expect(Boolean(x.href) || typeof x.prompt === "string").toBe(true);
  });
});

describe("formatting", () => {
  it("money keeps cents only when there are some", () => {
    expect(homeMoney(92)).toBe("$92");
    expect(homeMoney(9.99)).toBe("$9.99");
    expect(homeMoneyCompact(1_400_000)).toBe("$1.4M");
    expect(homeMoneyCompact(-1250)).toBe("−$1,250");
  });
  it("a clock time reads as one", () => {
    expect(homeClock("21:00")).toBe("9:00 PM");
    expect(homeClock("00:15")).toBe("12:15 AM");
    expect(homeClock(null)).toBe("");
  });
});
