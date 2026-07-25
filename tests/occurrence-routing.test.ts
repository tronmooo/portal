// Pins the recurring-occurrence architecture: an occurrence is a generated
// instance that always belongs to a parent object, and selecting one ALWAYS
// opens that parent — never a collection screen.
//
// The bug this locks down: tapping "ChatGPT Pro · Jul 30" on the Recurring
// Dates screen navigated to the Bills list, which reads as "nothing happened"
// because a list can't tell you which of its rows you came from.
import { describe, it, expect } from "vitest";
import {
  resolveOccurrenceTarget, isCollectionRoute, sectionForCategory,
  generationKindFor, generationMonths, generationRule,
  DEFAULT_GENERATION_RULES, COLLECTION_ROUTES,
} from "../shared/occurrence-routing";
import { aggregateUpcomingDates } from "../shared/upcoming-dates";

const todayISO = () => new Date().toLocaleDateString("en-CA");
const daysOut = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("en-CA");
};

describe("isCollectionRoute", () => {
  it("recognizes every bare list screen, with or without a hash", () => {
    for (const r of COLLECTION_ROUTES) {
      expect(isCollectionRoute(r)).toBe(true);
      expect(isCollectionRoute(`#${r}`)).toBe(true);
      expect(isCollectionRoute(`#${r}?tab=recurring`)).toBe(true);
    }
  });

  it("does not flag a specific object's detail route", () => {
    expect(isCollectionRoute("#/profiles/abc")).toBe(false);
    expect(isCollectionRoute("#/profiles/abc?section=birthday")).toBe(false);
    expect(isCollectionRoute("#/documents/xyz")).toBe(false);
  });

  it("does not flag a list route that names the item it should focus", () => {
    // The calendar is where an event series lives; ?focus= keeps the identity
    // of the tapped occurrence, which is what makes it a real destination.
    expect(isCollectionRoute("#/calendar?focus=ev-1&on=2026-08-30")).toBe(false);
    expect(isCollectionRoute("#/tasks?focus=task-1")).toBe(false);
  });
});

describe("resolveOccurrenceTarget", () => {
  it("opens a liability occurrence on its liability profile", () => {
    // A recurring bill IS a liability profile, so both share the profile route.
    const t = resolveOccurrenceTarget({ sourceType: "liability", sourceId: "chatgpt-pro-id" });
    expect(t.path).toBe("/profiles/chatgpt-pro-id");
    expect(isCollectionRoute(t.href)).toBe(false);
  });

  it("opens a birthday on the person's profile, Birthday section selected", () => {
    const t = resolveOccurrenceTarget({
      sourceType: "profile", sourceId: "joe-id", parentSection: "birthday",
    });
    expect(t.path).toBe("/profiles/joe-id?section=birthday");
  });

  it("carries the exact occurrence through for shared destinations", () => {
    // An event series has no page of its own, so the calendar has to be told
    // WHICH series and WHICH date to focus.
    const t = resolveOccurrenceTarget({
      sourceType: "event", sourceId: "ev-1", occurrenceDate: "2026-08-30",
    });
    expect(t.path).toBe("/calendar?focus=ev-1&on=2026-08-30");
    expect(t.sourceId).toBe("ev-1");
  });

  it("never returns a bare collection route for any source type", () => {
    const types = ["liability", "profile", "event", "document", "task", "goal", "reminder"] as const;
    for (const sourceType of types) {
      const t = resolveOccurrenceTarget({ sourceType, sourceId: "id-1", occurrenceDate: "2026-08-30" });
      expect(isCollectionRoute(t.href), `${sourceType} routed to a collection`).toBe(false);
    }
  });
});

describe("sectionForCategory", () => {
  it("maps birthdays and anniversaries to their sections", () => {
    expect(sectionForCategory("birthday")).toBe("birthday");
    expect(sectionForCategory("anniversary")).toBe("anniversary");
    expect(sectionForCategory("bill_due")).toBeUndefined();
  });
});

describe("default generation horizons", () => {
  it("uses the hard-coded rule per kind, not a guess", () => {
    expect(generationMonths("subscription")).toBe(12);
    expect(generationMonths("bill_due")).toBe(12);
    expect(generationMonths("birthday")).toBe(60);       // 5 years
    expect(generationMonths("anniversary")).toBe(60);    // 5 years
    expect(generationMonths("medication_refill")).toBe(12);
    expect(generationMonths("maintenance")).toBe(12);
  });

  it("marks a loan's horizon as bounded by its payoff date", () => {
    expect(generationKindFor("loan_payment")).toBe("loan_payment");
    expect(DEFAULT_GENERATION_RULES.loan_payment.boundedByParent).toBe(true);
    expect(generationRule("credit_card_payment").boundedByParent).toBe(true);
  });

  it("falls back to 12 months for an unrecognized kind", () => {
    expect(generationKindFor("something-new")).toBe("custom");
    expect(generationMonths("something-new")).toBe(12);
  });
});

// ─── End-to-end through the aggregator ────────────────────────────────────────
// These reproduce the exact rows from the reported screen.

describe("aggregated occurrences point at their parent", () => {
  const netflixId = "netflix-liability-id";
  const chatgptId = "chatgpt-pro-liability-id";
  const joeId = "joe-profile-id";

  const input = {
    profiles: [
      { id: joeId, name: "Joe", type: "person", fields: { birthday: "1990-02-11" } },
      { id: "owner-id", name: "robert sennabaum", type: "self", fields: {} },
    ],
    obligations: [
      {
        id: chatgptId, linkedLiabilityId: chatgptId, name: "ChatGPT Pro",
        amount: 20, frequency: "monthly", kind: "subscription",
        nextDueDate: daysOut(5), linkedProfiles: ["owner-id"], status: "active",
      },
      {
        id: netflixId, linkedLiabilityId: netflixId, name: "Netflix",
        amount: 9.99, frequency: "monthly", kind: "subscription",
        nextDueDate: daysOut(8), linkedProfiles: ["owner-id"], status: "active",
      },
    ],
    events: [
      {
        id: "joe-bday-event", title: "Joe's Birthday", date: "2027-02-11",
        recurrence: "yearly", linkedProfiles: [joeId], tags: [],
      },
    ],
  };

  const items = aggregateUpcomingDates(input, { windowDays: 370 });
  const byTitle = (t: string) => items.find(i => i.title.includes(t));

  it("ChatGPT Pro → the ChatGPT Pro liability profile", () => {
    const it_ = byTitle("ChatGPT Pro")!;
    expect(it_).toBeDefined();
    expect(it_.sourceType).toBe("liability");
    expect(it_.parentId).toBe(chatgptId);
    expect(it_.href).toBe(`#/profiles/${chatgptId}?section=recurring`);
  });

  it("Netflix → the Netflix liability profile", () => {
    const it_ = byTitle("Netflix")!;
    expect(it_.sourceType).toBe("liability");
    expect(it_.parentId).toBe(netflixId);
    expect(it_.href).toBe(`#/profiles/${netflixId}?section=recurring`);
  });

  it("Joe's Birthday → Joe's profile with the Birthday section", () => {
    const it_ = byTitle("Birthday")!;
    expect(it_.sourceType).toBe("profile");
    expect(it_.parentId).toBe(joeId);
    expect(it_.parentSection).toBe("birthday");
    expect(it_.href).toContain(`#/profiles/${joeId}`);
    expect(it_.href).toContain("section=birthday");
  });

  it("routes the bill to the LIABILITY, not to the person who owns it", () => {
    // relatedProfileId is the bill's owner (a person). Routing there would open
    // the wrong object — a regression this test exists to catch.
    const it_ = byTitle("ChatGPT Pro")!;
    expect(it_.relatedProfileId).toBe("owner-id");
    expect(it_.parentId).not.toBe("owner-id");
  });

  it("no aggregated occurrence lands on a collection screen", () => {
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      expect(isCollectionRoute(i.href), `${i.title} → ${i.href}`).toBe(false);
    }
  });

  it("every occurrence carries the full parent-pointer model", () => {
    for (const i of items) {
      expect(i.sourceType).toBeTruthy();
      expect(i.parentId).toBeTruthy();
      expect(i.occurrenceDate).toBe(i.nextDate);
      expect(i.status).toBeTruthy();
      expect(i.generatedFromRule).toBeTruthy();
    }
  });

  it("describes the rule that generated each date", () => {
    expect(byTitle("ChatGPT Pro")!.generatedFromRule).toMatch(/^monthly on day \d+$/);
    expect(byTitle("Birthday")!.generatedFromRule).toContain("every year");
  });
});

describe("occurrence status is per-instance", () => {
  it("marks today's occurrence 'today' and a future one 'upcoming'", () => {
    const items = aggregateUpcomingDates({
      obligations: [
        { id: "a", linkedLiabilityId: "a", name: "Due today", amount: 1, frequency: "monthly", nextDueDate: todayISO(), status: "active", linkedProfiles: [] },
        { id: "b", linkedLiabilityId: "b", name: "Due later", amount: 1, frequency: "monthly", nextDueDate: daysOut(10), status: "active", linkedProfiles: [] },
      ],
    }, { windowDays: 370 });
    expect(items.find(i => i.title === "Due today")!.status).toBe("today");
    expect(items.find(i => i.title === "Due later")!.status).toBe("upcoming");
  });
});
