// Pins the filter chips and, more importantly, WHAT THEIR NUMBERS COUNT.
//
// User report 2026-07-25: "Do not show Upcoming 135 as though there are 135
// different items. That number is counting future occurrences and duplicates,
// which is misleading."
//
// A rule is a thing you own; an occurrence is a generated date. Chip counts
// are always over deduplicated RULES.
import { describe, it, expect } from "vitest";
import {
  CALENDAR_CATEGORIES,
  categoryForKind,
  seriesInCategory,
  filterSeriesByCategory,
  countRules,
  categoryChips,
} from "../shared/calendar-categories";
import {
  dedupeSeries,
  buildCalendarOccurrences,
  KIND_LABELS,
  type CalendarSeries,
  type OccurrenceKind,
} from "../shared/calendar-occurrences";

const TODAY = "2026-07-25";

const mk = (over: Partial<CalendarSeries> & { id: string; kind: OccurrenceKind }): CalendarSeries => ({
  title: over.title ?? over.id,
  source: { system: "obligation", id: over.id, profileId: over.id, href: "#" },
  baseDate: "2026-08-02",
  recurrence: "monthly",
  ...over,
});

describe("every kind lands in exactly one chip", () => {
  it("maps all kinds", () => {
    const kinds = Object.keys(KIND_LABELS) as OccurrenceKind[];
    for (const k of kinds) {
      const cat = categoryForKind(k);
      expect(CALENDAR_CATEGORIES.some((c) => c.id === cat), `${k} -> ${cat}`).toBe(true);
      expect(cat).not.toBe("all");
    }
  });

  it("routes the reported categories where the user expects", () => {
    expect(categoryForKind("birthday")).toBe("birthdays");
    expect(categoryForKind("bill")).toBe("bills");
    expect(categoryForKind("subscription")).toBe("subscriptions");
    expect(categoryForKind("liability")).toBe("liabilities");
    expect(categoryForKind("task")).toBe("tasks");
    expect(categoryForKind("reminder")).toBe("reminders");
    // Important Dates is the home for non-money, non-person, non-todo dates.
    expect(categoryForKind("anniversary")).toBe("important");
    expect(categoryForKind("renewal")).toBe("important");
    expect(categoryForKind("appointment")).toBe("important");
    expect(categoryForKind("document")).toBe("important");
  });

  it("offers the chips in the specified order", () => {
    expect(CALENDAR_CATEGORIES.map((c) => c.id)).toEqual([
      "all", "birthdays", "important", "bills",
      "subscriptions", "liabilities", "tasks", "reminders",
    ]);
  });
});

describe("counts are unique RULES, never occurrences", () => {
  const rules = [
    mk({ id: "b1", kind: "birthday", recurrence: "yearly", baseDate: "1990-02-11" }),
    mk({ id: "bill1", kind: "bill" }),
    mk({ id: "s1", kind: "subscription" }),
    mk({ id: "s2", kind: "subscription" }),
    mk({ id: "s3", kind: "subscription" }),
    mk({ id: "l1", kind: "liability" }),
    mk({ id: "t1", kind: "task" }),
  ];

  it("matches the counts the user asked for", () => {
    const counts = countRules(rules);
    expect(counts.birthdays).toBe(1);
    expect(counts.bills).toBe(1);
    expect(counts.subscriptions).toBe(3);
    expect(counts.liabilities).toBe(1);
    expect(counts.tasks).toBe(1);
    expect(counts.all).toBe(7);
  });

  it("does NOT grow with the number of generated occurrences", () => {
    // The same 7 rules generate hundreds of dates. The chips must not move.
    const occurrences = buildCalendarOccurrences(rules, { todayISO: TODAY });
    expect(occurrences.length).toBeGreaterThan(50); // the misleading "135"
    expect(countRules(rules).all).toBe(7);
  });

  it("counts each rule once even if passed twice", () => {
    expect(countRules([...rules, ...rules]).all).toBe(7);
  });

  it("all equals the sum of the other chips", () => {
    const c = countRules(rules);
    const sum = CALENDAR_CATEGORIES
      .filter((x) => x.id !== "all")
      .reduce((n, x) => n + c[x.id], 0);
    expect(sum).toBe(c.all);
  });

  it("returns all-zero for an empty list", () => {
    const c = countRules([]);
    expect(c.all).toBe(0);
    expect(c.subscriptions).toBe(0);
  });
});

describe("a merged payment is counted once, under one chip", () => {
  // The reported duplicate: one ChatGPT Pro charge modelled as a subscription
  // obligation AND as a liability profile.
  const liabilityRecord: CalendarSeries = {
    id: "liability:chatgpt", kind: "liability", title: "ChatGPT Pro",
    source: {
      system: "liability", id: "chatgpt", profileId: "chatgpt",
      href: "#/profiles/chatgpt", linkedRecordId: "chatgpt", linkedLabel: "Liability",
    },
    baseDate: "2026-07-30", recurrence: "monthly", amount: 20,
  };
  const subscriptionRecord: CalendarSeries = {
    id: "obligation:ob-chatgpt", kind: "subscription", title: "ChatGPT Pro",
    source: {
      system: "obligation", id: "ob-chatgpt", profileId: "chatgpt",
      href: "#/profiles/chatgpt", linkedRecordId: "chatgpt", linkedLabel: "Liability",
    },
    baseDate: "2026-07-30", recurrence: "monthly", amount: 20,
  };

  it("collapses to one rule under Subscriptions, not one under each chip", () => {
    const survivors = dedupeSeries([liabilityRecord, subscriptionRecord]).map((d) => d.series);
    expect(survivors).toHaveLength(1);
    const counts = countRules(survivors);
    expect(counts.all).toBe(1);
    expect(counts.subscriptions).toBe(1);
    expect(counts.liabilities).toBe(0);
  });
});

describe("filtering", () => {
  const rules = [
    mk({ id: "b1", kind: "birthday", recurrence: "yearly" }),
    mk({ id: "s1", kind: "subscription" }),
    mk({ id: "t1", kind: "task" }),
  ];

  it("'all' matches everything", () => {
    expect(filterSeriesByCategory(rules, "all")).toHaveLength(3);
    expect(rules.every((r) => seriesInCategory(r, "all"))).toBe(true);
  });

  it("narrows to one chip", () => {
    expect(filterSeriesByCategory(rules, "subscriptions").map((r) => r.id)).toEqual(["s1"]);
    expect(filterSeriesByCategory(rules, "birthdays").map((r) => r.id)).toEqual(["b1"]);
    expect(filterSeriesByCategory(rules, "liabilities")).toEqual([]);
  });
});

describe("categoryChips", () => {
  it("returns every chip with its count by default", () => {
    const chips = categoryChips(countRules([mk({ id: "s1", kind: "subscription" })]));
    expect(chips).toHaveLength(CALENDAR_CATEGORIES.length);
    expect(chips.find((c) => c.id === "subscriptions")!.count).toBe(1);
    expect(chips.find((c) => c.id === "important")!.count).toBe(0);
  });

  it("can drop empty chips but always keeps All", () => {
    const chips = categoryChips(countRules([mk({ id: "s1", kind: "subscription" })]), { hideEmpty: true });
    expect(chips.map((c) => c.id)).toEqual(["all", "subscriptions"]);
  });
});
