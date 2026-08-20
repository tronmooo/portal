// The FULL taxonomy: every kind of information a person can have, routed to
// the record that owns it.
//
// The complaint this pins down (2026-08-20, second pass): structured facts —
// an email, a phone number, an address, an employer, an ID number — were
// landing as notes. A note is where information goes when NO typed record
// claims it. An email address has a claim: it belongs on the person.
//
// Three doors have to agree — AI chat, document extraction, manual entry — so
// the classifier and the "already on the calendar" predicate they share are
// what is tested here, not any single door's plumbing.

import { describe, it, expect } from "vitest";
import {
  classifyContent, classifyClause, routeContent, isStructured,
  detectStructuredDomain, readsAsHabit, GENERIC_KINDS,
} from "@shared/content-routing";
import { canonicalDateCoverage, deriveDateRulesForRecord } from "@shared/temporal-rules";
import { seriesFromHabits, seriesFromAll } from "@shared/calendar-adapters";

describe("structured profile data never becomes a note", () => {
  const cases: Array<[string, string]> = [
    ["Robert's email is robert@example.com", "profile_contact"],
    ["Her phone number is (555) 213-9987", "profile_contact"],
    ["Sarah lives at 412 Maple Street", "profile_address"],
    ["Mike works at Kaiser Permanente", "profile_employment"],
    ["His policy number is A-4471-22", "profile_identifier"],
    ["Robert's blood type is O+", "profile_attribute"],
    ["My birthday is July 10, 1994", "profile_dob"],
  ];
  it.each(cases)("%s → profile_field/%s", (msg, domain) => {
    const c = classifyContent(msg);
    expect(c.kind).toBe("profile_field");
    expect(c.structuredDomain).toBe(domain);
    expect(isStructured(c.kind)).toBe(true);
  });

  it("none of them are classified as a note", () => {
    for (const [msg] of cases) expect(classifyContent(msg).kind).not.toBe("note");
  });

  it("but an explicit note request still wins over the structured read", () => {
    const c = classifyContent("Make a note that Robert's email is robert@example.com");
    expect(c.kind).toBe("note");
    expect(c.explicit).toBe(true);
  });
});

describe("domain records are recognised by their own shape", () => {
  it.each([
    ["I spent $38 at Costco", "expense"],
    ["I got paid $2,400 today", "income"],
    ["My Netflix subscription is $22.99", "subscription"],
    ["The car note balance is $14,200", "liability"],
    ["Robert's driver's license expires July 18, 2034", "document"],
    ["Max's breed is border collie", "pet"],
    ["My blood pressure was 128 over 80", "health"],
  ])("%s → %s", (msg, kind) => {
    expect(classifyClause(msg).kind).toBe(kind);
  });

  it("a structured verdict is never one of the generic kinds", () => {
    for (const msg of ["I spent $38 at Costco", "My email is a@b.com"]) {
      expect(GENERIC_KINDS.has(classifyClause(msg).kind)).toBe(false);
    }
  });
});

describe("habit vs recurring task", () => {
  it.each([
    "Take my medication every day at 8 AM",
    "Meditate each morning",
    "Drink water 3x a day",
    "Stretch every evening",
  ])("%s → habit", (msg) => {
    expect(classifyClause(msg).kind).toBe("habit");
  });

  it.each([
    "Take out the trash every Tuesday",
    "Buy dog food every Saturday",
    "Pay rent on the first of every month",
  ])("%s → task (a chore that comes due, not a streak)", (msg) => {
    expect(classifyClause(msg).kind).toBe("task");
  });

  it("no cadence means it is never a habit", () => {
    expect(readsAsHabit("Take my medication").isHabit).toBe(false);
    expect(classifyClause("Take my medication").kind).toBe("task");
  });

  it("explicit wording overrides the inference in both directions", () => {
    expect(classifyContent("Add a task to meditate every morning").kind).toBe("task");
    expect(classifyContent("Make taking out the trash a weekly habit").kind).toBe("habit");
  });
});

describe("habits reach the unified calendar", () => {
  const habit = (over: Record<string, any> = {}) => ({
    id: "h1", name: "Take medication", frequency: "daily", targetPerDay: 1,
    startDate: "2026-08-01", checkins: [], linkedProfiles: ["p-robert"],
    createdAt: "2026-08-01T00:00:00Z", ...over,
  });

  it("a daily habit becomes one daily series", () => {
    const s = seriesFromHabits([habit()]);
    expect(s).toHaveLength(1);
    expect(s[0].kind).toBe("habit");
    expect(s[0].recurrence).toBe("daily");
    expect(s[0].baseDate).toBe("2026-08-01");
    expect(s[0].source.href).toContain("habits");
  });

  it("a weekly habit uses its configured days", () => {
    const s = seriesFromHabits([habit({ frequency: "weekly", targetDays: [1, 4] })]);
    expect(s[0].recurrence).toBe("weekly:1,4");
  });

  it("a 3x-daily habit is ONE occurrence a day, not three", () => {
    const s = seriesFromHabits([habit({ targetPerDay: 3 })]);
    expect(s).toHaveLength(1);
    expect(s[0].subtitle).toBe("3× per day");
  });

  it("a day is complete only when the per-day target is met", () => {
    const partial = seriesFromHabits([habit({
      targetPerDay: 3,
      checkins: [{ date: "2026-08-02" }, { date: "2026-08-02" }],
    })]);
    expect(partial[0].completedDates ?? []).not.toContain("2026-08-02");

    const full = seriesFromHabits([habit({
      targetPerDay: 3,
      checkins: [{ date: "2026-08-02" }, { date: "2026-08-02" }, { date: "2026-08-02" }],
    })]);
    expect(full[0].completedDates).toContain("2026-08-02");
  });

  it("a custom habit with no configured days is scheduled on no day", () => {
    expect(seriesFromHabits([habit({ frequency: "custom", targetDays: [] })])).toEqual([]);
  });

  it("an ended habit carries its end date", () => {
    expect(seriesFromHabits([habit({ endDate: "2026-08-07" })])[0].recurrenceEnd).toBe("2026-08-07");
  });

  it("seriesFromAll includes habits, and the temporal layer derives a rule", () => {
    expect(seriesFromAll({ habits: [habit()] })).toHaveLength(1);
    const rules = deriveDateRulesForRecord("u1", "habit", habit());
    expect(rules).toHaveLength(1);
    expect(rules[0].ruleType).toBe("habit");
    expect(rules[0].recurring).toBe(true);
    expect(rules[0].source.ownerIds).toContain("p-robert");
  });
});

describe("reference, don't duplicate", () => {
  it("a date of birth is already on the calendar via the profile", () => {
    const c = canonicalDateCoverage("dateOfBirth", { hasProfile: true });
    expect(c.covered).toBe(true);
    expect(c.system).toBe("profile");
  });

  it("a document expiration is already on the calendar via the document", () => {
    const c = canonicalDateCoverage("expirationDate", { hasDocument: true });
    expect(c.covered).toBe(true);
    expect(c.system).toBe("document");
  });

  it("a date with no canonical home is NOT covered — it still needs an event", () => {
    expect(canonicalDateCoverage("courtHearing", { hasDocument: true, hasProfile: true }).covered).toBe(false);
  });

  it("an expiration key is not claimed by the document when there is no document", () => {
    expect(canonicalDateCoverage("expirationDate", { hasDocument: false }).covered).toBe(false);
  });

  it("the profile birthday rule and a duplicate event would collide — only one is derived", () => {
    const rules = deriveDateRulesForRecord("u1", "profile", {
      id: "p1", name: "Robert", type: "person", tags: [],
      fields: { dateOfBirth: "1994-07-10" },
    });
    expect(rules.filter(r => r.ruleType === "birthday")).toHaveLength(1);
  });
});

describe("one message, several domains", () => {
  it("splits a mixed message across the records that own each part", () => {
    const plan = routeContent(
      "Robert's email is robert@example.com. Remind me to call him Friday. Journal this: he seemed happier today.",
    );
    const kinds = plan.actions.map(a => a.kind);
    expect(kinds).toContain("profile_field");
    expect(kinds).toContain("task");
    expect(kinds).toContain("journal");
  });

  it("the person is carried on each part", () => {
    const plan = routeContent("Robert's email is robert@example.com. Remind Robert to call the doctor.");
    expect(plan.actions.every(a => a.profileHint === "Robert")).toBe(true);
  });
});
