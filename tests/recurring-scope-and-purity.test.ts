// Pins the two failures behind the reported Recurring Dates screen.
//
// Screenshot (profile filter = "robert sennabaum"):
//
//   Important 17 · Bills 0 · Subs 0 · Liabilities 0 · Tasks 3
//
//   ⚠ Florida Driver License — Expiration    Custom · Does not repeat · No upcoming date
//   ⚠ Florida Driver License – Sennabaum …   Custom · Does not repeat · No upcoming date
//   📅 date Of Birth: 03/12/2034             Custom · Does not repeat · No upcoming date
//   House Viewing                            Custom · Does not repeat · No upcoming date
//   Soccer Game                              Custom · Does not repeat · No upcoming date
//
// 1. NON-RECURRING RECORDS WERE BEING MANAGED AS RULES. One-off dates were
//    adapted into "rules", so a recurrence manager listed items it captioned
//    "Does not repeat".
// 2. THE PROFILE SCOPE DROPPED EVERY PAYMENT. `profileId` served double duty as
//    both the navigation target and the scope key. A bill owned by Robert but
//    attached to the ChatGPT Pro *liability profile* had `profileId` set to the
//    liability, so filtering to Robert matched nothing → Bills/Subs/Liabilities 0.
import { describe, it, expect } from "vitest";
import {
  seriesFromAll,
  filterSeriesByProfiles,
  ownerCandidates,
  humanizeTitle,
} from "../shared/calendar-adapters";
import {
  isRecurringRule,
  onlyRecurringRules,
  ruleValidity,
  generateSeriesOccurrences,
  type CalendarSeries,
} from "../shared/calendar-occurrences";
import { countRules, SOURCE_CATEGORIES } from "../shared/calendar-categories";

const TODAY = "2026-07-25";
const ROBERT = "robert-id";
const CHATGPT_LIABILITY = "chatgpt-liability-id";
const HONDA = "honda-id";

// The account as it actually is: Robert owns everything, but the payments hang
// off their own liability profiles.
const RAW = {
  profiles: [
    { id: ROBERT, name: "robert sennabaum", type: "self", fields: { birthday: "1985-03-12" } },
    { id: CHATGPT_LIABILITY, name: "ChatGPT Pro", type: "liability",
      parentProfileId: ROBERT, fields: { nextDueDate: "2026-07-30", monthlyPayment: 20 } },
  ],
  events: [
    // Junk that was filling the screen — all one-off.
    { id: "e1", title: "Florida Driver License — Expiration", date: "2025-03-12", recurrence: "none", linkedProfiles: [ROBERT] },
    { id: "e2", title: "Florida Driver License – Sennabaum — Expiration", date: "2025-03-12", recurrence: "none", linkedProfiles: [ROBERT] },
    { id: "e3", title: "dateOfBirth: 03/12/2034", date: "2034-03-12", recurrence: "none", linkedProfiles: [ROBERT] },
    { id: "e4", title: "House Viewing", date: "2026-06-01", recurrence: "none", linkedProfiles: [ROBERT] },
    { id: "e5", title: "Soccer Game", date: "2026-06-08", recurrence: "none", linkedProfiles: [ROBERT] },
    // A genuine recurring event.
    { id: "e6", title: "Trash day", date: "2026-07-27", recurrence: "weekly", linkedProfiles: [ROBERT] },
  ],
  obligations: [
    { id: "ob-chatgpt", name: "ChatGPT Pro", amount: 20, frequency: "monthly", category: "subscription",
      nextDueDate: "2026-07-30", linkedProfiles: [ROBERT], linkedLiabilityId: CHATGPT_LIABILITY },
    { id: "ob-prog", name: "Progressive Auto Insurance", amount: 155, frequency: "monthly", category: "insurance",
      nextDueDate: "2026-07-30", linkedProfiles: [ROBERT], linkedAssetId: HONDA },
  ],
  tasks: [
    { id: "t1", title: "Refill Propranolol prescription", dueDate: "2026-08-08", tags: ["recur:monthly"], linkedProfiles: [ROBERT] },
    { id: "t2", title: "One-off errand", dueDate: "2026-08-02", linkedProfiles: [ROBERT] },
    // A timed task with NO owner at all — the soft-orphan case. (This was a
    // reminder row until reminders were retired on 2026-08-09.)
    { id: "t3", title: "Call the vet", dueDate: "2026-08-03", dueTime: "10:00", linkedProfiles: [] },
  ],
  documents: [{ id: "d1", name: "Passport", extractedData: { expiration_date: "2029-01-01" } }],
};

const SELF_IDS = new Set([ROBERT]);

describe("only genuinely repeating rules belong on a recurrence manager", () => {
  it("rejects every one-off record", () => {
    const all = seriesFromAll(RAW);
    const oneOffTitles = [
      "Florida Driver License — Expiration",
      "Florida Driver License – Sennabaum — Expiration",
      "House Viewing",
      "Soccer Game",
      // A document's date is labelled by what the date MEANS, not just by the
      // document's name — "Passport — Expiration" is the important date.
      "Passport — Expiration",
    ];
    for (const title of oneOffTitles) {
      const s = all.find((x) => x.title === title);
      expect(s, title).toBeTruthy();
      expect(isRecurringRule(s!), title).toBe(false);
    }
  });

  it("accepts every real repeat pattern", () => {
    const mk = (recurrence: string): CalendarSeries => ({
      id: "x", kind: "custom", title: "X",
      source: { system: "event", id: "x", href: "#" },
      baseDate: "2026-08-01", recurrence,
    });
    for (const r of ["daily", "weekdays", "weekends", "weekly", "biweekly",
                     "monthly", "quarterly", "semiannual", "yearly"]) {
      expect(isRecurringRule(mk(r)), r).toBe(true);
    }
    for (const r of ["none", "", "once", "sporadic"]) {
      expect(isRecurringRule(mk(r)), r).toBe(false);
    }
  });

  it("leaves the screen with rules only — no 'Does not repeat' rows", () => {
    const rules = onlyRecurringRules(seriesFromAll(RAW));
    expect(rules.every(isRecurringRule)).toBe(true);
    const titles = rules.map((r) => r.title);
    expect(titles).not.toContain("House Viewing");
    expect(titles).not.toContain("Soccer Game");
    expect(titles).not.toContain("Passport");
    expect(titles.some((t) => t.includes("Driver License"))).toBe(false);
  });

  it("drops the raw dateOfBirth field dump", () => {
    const titles = onlyRecurringRules(seriesFromAll(RAW)).map((r) => r.title);
    expect(titles.some((t) => /dateofbirth/i.test(t))).toBe(false);
  });

  it("keeps the real recurring records", () => {
    const titles = onlyRecurringRules(seriesFromAll(RAW)).map((r) => r.title);
    expect(titles).toContain("Trash day");
    expect(titles).toContain("Refill Propranolol prescription");
    expect(titles).toContain("robert sennabaum's Birthday");
    expect(titles).not.toContain("One-off errand");
  });
});

describe("profile scope matches the whole ownership chain", () => {
  const rules = onlyRecurringRules(seriesFromAll(RAW));
  const scoped = filterSeriesByProfiles(rules, [ROBERT], { selfIds: SELF_IDS });

  it("finds the payments Robert owns even though they hang off other profiles", () => {
    // This is the exact regression: Bills 0 · Subs 0 · Liabilities 0.
    const counts = countRules(scoped);
    expect(counts.subscriptions + counts.bills + counts.liabilities).toBeGreaterThan(0);
    expect(scoped.some((s) => s.title === "ChatGPT Pro")).toBe(true);
    expect(scoped.some((s) => s.title === "Progressive Auto Insurance")).toBe(true);
  });

  it("still navigates a bill to its liability profile", () => {
    const chatgpt = scoped.find((s) => s.title === "ChatGPT Pro")!;
    expect(chatgpt.source.profileId).toBe(CHATGPT_LIABILITY);
    expect(chatgpt.source.href).toBe(`#/profiles/${CHATGPT_LIABILITY}`);
    // …while still being in scope for the person who owns it.
    expect(ownerCandidates(chatgpt)).toContain(ROBERT);
  });

  it("keeps an unowned timed task visible for the primary person", () => {
    // The soft-orphan rule: a record with no owner belongs to the primary
    // person. Dropping it is what once made the manager read "Reminders 0".
    const withOrphan = filterSeriesByProfiles(
      seriesFromAll(RAW), [ROBERT], { selfIds: SELF_IDS },
    );
    expect(withOrphan.some((s) => s.title === "Call the vet")).toBe(true);
  });

  it("does NOT leak another person's records into scope", () => {
    const other = filterSeriesByProfiles(rules, ["someone-else"], { selfIds: SELF_IDS });
    expect(other).toEqual([]);
  });

  it("returns everything when no filter is active", () => {
    expect(filterSeriesByProfiles(rules, [])).toHaveLength(rules.length);
  });

  it("matches an asset-linked bill via its asset", () => {
    const prog = rules.find((s) => s.title === "Progressive Auto Insurance")!;
    expect(ownerCandidates(prog)).toContain(HONDA);
    expect(filterSeriesByProfiles(rules, [HONDA], { selfIds: SELF_IDS })
      .some((s) => s.title === "Progressive Auto Insurance")).toBe(true);
  });
});

describe("counts reflect the scoped, deduplicated rules", () => {
  it("no longer reports zero for categories that have records", () => {
    const scoped = filterSeriesByProfiles(
      onlyRecurringRules(seriesFromAll(RAW)), [ROBERT], { selfIds: SELF_IDS },
    );
    const counts = countRules(scoped);
    expect(counts.birthdays).toBe(1);
    expect(counts.tasks).toBe(1);       // the recurring one only
    expect(counts.subscriptions).toBe(1);
    // `all` is the sum of the SOURCE categories. `important` is a status that
    // overlaps them, so it is deliberately excluded from this invariant.
    expect(counts.all).toBe(SOURCE_CATEGORIES.reduce((n, c) => n + counts[c], 0));
  });

  it("Important is a status, so it is empty without urgency context", () => {
    // It used to be a source-type dumping ground; now nothing lands in it
    // merely by existing.
    const scoped = filterSeriesByProfiles(
      onlyRecurringRules(seriesFromAll(RAW)), [ROBERT], { selfIds: SELF_IDS },
    );
    expect(countRules(scoped).important).toBe(0);
  });

  it("Important counts only what is overdue or due soon", () => {
    const scoped = filterSeriesByProfiles(
      onlyRecurringRules(seriesFromAll(RAW)), [ROBERT], { selfIds: SELF_IDS },
    );
    const soon = countRules(scoped, { todayISO: TODAY, nextDateFor: () => "2026-07-28" });
    const later = countRules(scoped, { todayISO: TODAY, nextDateFor: () => "2027-07-28" });
    expect(soon.important).toBe(scoped.length);
    expect(later.important).toBe(0);
  });
});

describe("a rule without a next date explains itself", () => {
  const base: CalendarSeries = {
    id: "s", kind: "subscription", title: "Thing",
    source: { system: "obligation", id: "s", profileId: "me", href: "#" },
    baseDate: "2026-08-02", recurrence: "monthly",
  };

  it("reports ok while dates exist", () => {
    const occ = generateSeriesOccurrences(base, { todayISO: TODAY });
    expect(ruleValidity(base, occ.length > 0, TODAY)).toEqual({ state: "ok" });
  });

  it("says paused rather than 'No upcoming date'", () => {
    expect(ruleValidity({ ...base, paused: true }, false, TODAY).state).toBe("paused");
  });

  it("says ended when the series genuinely finished", () => {
    const v = ruleValidity({ ...base, recurrenceEnd: "2026-01-01" }, false, TODAY);
    expect(v.state).toBe("ended");
  });

  it("flags a broken rule with a clear error", () => {
    const noStart = ruleValidity({ ...base, baseDate: "" }, false, TODAY);
    expect(noStart.state).toBe("invalid");
    expect((noStart as any).message).toMatch(/start date/i);

    const noPattern = ruleValidity({ ...base, recurrence: "none" }, false, TODAY);
    expect(noPattern.state).toBe("invalid");
    expect((noPattern as any).message).toMatch(/repeat pattern/i);
  });
});

describe("humanizeTitle never shows a database property name", () => {
  it("rewrites raw field dumps", () => {
    expect(humanizeTitle("dateOfBirth: 03/12/2034")).toBe("Date Of Birth");
    expect(humanizeTitle("expiration_date")).toBe("Expiration Date");
    expect(humanizeTitle("nextDueDate: 2026-08-01")).toBe("Next Due Date");
  });

  it("leaves real titles alone", () => {
    expect(humanizeTitle("House Viewing")).toBe("House Viewing");
    expect(humanizeTitle("Rent: due Friday")).toBe("Rent: due Friday");
    expect(humanizeTitle("Progressive Auto Insurance – Honda CR-V 2021"))
      .toBe("Progressive Auto Insurance – Honda CR-V 2021");
    expect(humanizeTitle("Netflix")).toBe("Netflix");
  });

  it("falls back for empty input", () => {
    expect(humanizeTitle("", "Event")).toBe("Event");
    expect(humanizeTitle(null, "Task")).toBe("Task");
  });
});
