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
  SOURCE_CATEGORIES,
  isImportant,
  IMPORTANT_WINDOW_DAYS,
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
    // Each kind gets a real source category. "Important" is NOT a source type.
    expect(categoryForKind("anniversary")).toBe("anniversaries");
    expect(categoryForKind("document")).toBe("documents");
    expect(categoryForKind("renewal")).toBe("events");
    expect(categoryForKind("appointment")).toBe("events");
    expect(categoryForKind("custom")).toBe("other");
    for (const k of Object.keys(KIND_LABELS) as OccurrenceKind[]) {
      expect(categoryForKind(k), k).not.toBe("important");
    }
  });

  it("offers the chips in the specified order", () => {
    expect(CALENDAR_CATEGORIES.map((c) => c.id)).toEqual([
      "all", "important", "birthdays", "anniversaries", "bills",
      "subscriptions", "liabilities", "income", "documents", "tasks",
      "reminders", "events", "other",
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

  it("all equals the sum of the SOURCE chips (important overlaps by design)", () => {
    const c = countRules(rules);
    const sum = SOURCE_CATEGORIES.reduce((n, x) => n + c[x], 0);
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
    expect(chips.find((c) => c.id === "other")!.count).toBe(0);
  });

  it("can drop empty chips but always keeps All", () => {
    const chips = categoryChips(countRules([mk({ id: "s1", kind: "subscription" })]), { hideEmpty: true });
    expect(chips.map((c) => c.id)).toEqual(["all", "subscriptions"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// "Important contains routine monthly bills and renewals and is massively
// overpopulated" — it read 40 of 49. It was a source-type dumping ground for
// everything that wasn't money, people, or to-dos. It is now a STATUS.
// ─────────────────────────────────────────────────────────────────────────────
describe("Important is a status, not a source type", () => {
  const TODAY_I = "2026-07-25";
  const bill = mk({ id: "b", kind: "bill" });

  it("excludes an ordinary bill due far in the future", () => {
    expect(isImportant(bill, { todayISO: TODAY_I, nextDate: "2027-01-30" })).toBe(false);
  });

  it("includes anything overdue", () => {
    expect(isImportant(bill, { todayISO: TODAY_I, nextDate: "2026-07-01" })).toBe(true);
  });

  it("includes anything inside the warning window", () => {
    expect(isImportant(bill, { todayISO: TODAY_I, nextDate: "2026-07-30" })).toBe(true);
    // …and excludes the day after it.
    const past = new Date(`${TODAY_I}T12:00:00`);
    past.setDate(past.getDate() + IMPORTANT_WINDOW_DAYS + 1);
    expect(isImportant(bill, { todayISO: TODAY_I, nextDate: past.toLocaleDateString("en-CA") })).toBe(false);
  });

  it("includes anything the user starred, whatever its date", () => {
    expect(isImportant(bill, {
      todayISO: TODAY_I, nextDate: "2030-01-01", starred: new Set(["b"]),
    })).toBe(true);
  });

  it("excludes a rule with no upcoming date at all", () => {
    expect(isImportant(bill, { todayISO: TODAY_I, nextDate: null })).toBe(false);
  });

  it("does not inflate: 12 monthly bills a year out give Important 0", () => {
    const many = Array.from({ length: 12 }, (_, i) => mk({ id: `b${i}`, kind: "bill" }));
    const counts = countRules(many, { todayISO: TODAY_I, nextDateFor: () => "2027-06-01" });
    expect(counts.bills).toBe(12);
    expect(counts.important).toBe(0);
  });
});
