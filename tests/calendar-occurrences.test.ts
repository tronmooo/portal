// Pins the calendar occurrence engine.
//
// User report 2026-07-25 (calendar screenshot): "Joe's birthday is appearing
// twice. Every recurring event should only generate a single occurrence for
// each date."
//
// Joe's birthday existed in two systems — his profile's date-of-birth field
// and a hand-created recurring calendar event — and they had computed
// DIFFERENT next dates (Feb 11 2027 vs Feb 11 2029). The old dedup key
// included the computed date, so it could never collapse two records that
// disagreed about the date. Identity here is date-free by construction.
import { describe, it, expect } from "vitest";
import {
  seriesIdentityKey,
  seriesPriority,
  dedupeSeries,
  generateSeriesOccurrences,
  buildCalendarOccurrences,
  occurrencesOnDate,
  nextOccurrenceOf,
  needsHorizonExtension,
  extendedHorizonFor,
  horizonDaysFor,
  sourceHref,
  relativeDayLabel,
  nextAnnual,
  type CalendarSeries,
} from "../shared/calendar-occurrences";

const TODAY = "2026-07-25";
const JOE = "joe-profile-id";

const joeBirthdayFromProfile: CalendarSeries = {
  id: "profile:joe-profile-id:birthday",
  kind: "birthday",
  title: "Joe's Birthday",
  source: { system: "profile", id: JOE, profileId: JOE, label: "Joe", href: `#/profiles/${JOE}` },
  baseDate: "1990-02-11",
  recurrence: "yearly",
};

// The hand-typed event, whose arithmetic had drifted to 2029.
const joeBirthdayFromEvent: CalendarSeries = {
  id: "event:evt-1",
  kind: "birthday",
  title: "Joe's Birthday",
  source: { system: "event", id: "evt-1", profileId: JOE, href: "#/calendar?event=evt-1" },
  baseDate: "2029-02-11",
  recurrence: "yearly",
  shadow: true,
};

describe("identity is date-free, so disagreeing sources still collapse", () => {
  it("gives one birthday per profile regardless of source or base date", () => {
    expect(seriesIdentityKey(joeBirthdayFromProfile)).toBe(`birthday:${JOE}`);
    expect(seriesIdentityKey(joeBirthdayFromEvent)).toBe(`birthday:${JOE}`);
    expect(seriesIdentityKey(joeBirthdayFromProfile)).toBe(seriesIdentityKey(joeBirthdayFromEvent));
  });

  it("keeps different people's birthdays distinct", () => {
    const bob = { ...joeBirthdayFromProfile, source: { ...joeBirthdayFromProfile.source, profileId: "bob" } };
    expect(seriesIdentityKey(bob)).not.toBe(seriesIdentityKey(joeBirthdayFromProfile));
  });

  it("identifies non-singleton kinds by profile + kind + title", () => {
    const netflixSub: CalendarSeries = {
      id: "obligation:n1", kind: "subscription", title: "Netflix",
      source: { system: "obligation", id: "n1", profileId: "me", href: "#" },
      baseDate: "2026-08-02", recurrence: "monthly",
    };
    const netflixAgain = { ...netflixSub, id: "obligation:n2", title: "netflix  " };
    const spotify = { ...netflixSub, id: "obligation:n3", title: "Spotify" };
    expect(seriesIdentityKey(netflixSub)).toBe(seriesIdentityKey(netflixAgain));
    expect(seriesIdentityKey(netflixSub)).not.toBe(seriesIdentityKey(spotify));
  });

  it("falls back to the record itself when there is nothing to merge on", () => {
    const bare: CalendarSeries = {
      id: "event:x", kind: "custom", title: "",
      source: { system: "event", id: "x", href: "#" },
      baseDate: "2026-08-01", recurrence: "weekly",
    };
    expect(seriesIdentityKey(bare)).toBe("custom:record:event:x");
  });
});

describe("dedupeSeries — the profile record wins", () => {
  it("collapses Joe's two birthdays to the profile one", () => {
    const out = dedupeSeries([joeBirthdayFromEvent, joeBirthdayFromProfile]);
    expect(out).toHaveLength(1);
    expect(out[0].series.id).toBe("profile:joe-profile-id:birthday");
    expect(out[0].duplicateIds).toEqual(["event:evt-1"]);
  });

  it("does not depend on input order", () => {
    const a = dedupeSeries([joeBirthdayFromProfile, joeBirthdayFromEvent]);
    const b = dedupeSeries([joeBirthdayFromEvent, joeBirthdayFromProfile]);
    expect(a[0].series.id).toBe(b[0].series.id);
    expect(a[0].duplicateIds).toEqual(b[0].duplicateIds);
  });

  it("ranks an explicit shadow below everything", () => {
    expect(seriesPriority(joeBirthdayFromEvent)).toBe(0);
    expect(seriesPriority(joeBirthdayFromProfile)).toBeGreaterThan(0);
  });

  it("prefers the authoritative system for each kind", () => {
    const subFromObligation: CalendarSeries = {
      id: "obligation:s1", kind: "subscription", title: "Netflix",
      source: { system: "obligation", id: "s1", profileId: "me", href: "#" },
      baseDate: "2026-08-02", recurrence: "monthly", amount: 9.99,
    };
    const subFromEvent: CalendarSeries = {
      id: "event:s2", kind: "subscription", title: "Netflix",
      source: { system: "event", id: "s2", profileId: "me", href: "#" },
      baseDate: "2026-08-02", recurrence: "monthly",
    };
    const out = dedupeSeries([subFromEvent, subFromObligation]);
    expect(out).toHaveLength(1);
    expect(out[0].series.source.system).toBe("obligation");
  });

  it("leaves genuinely distinct records alone", () => {
    const netflix: CalendarSeries = {
      id: "obligation:a", kind: "subscription", title: "Netflix",
      source: { system: "obligation", id: "a", profileId: "me", href: "#" },
      baseDate: "2026-08-02", recurrence: "monthly",
    };
    const spotify = { ...netflix, id: "obligation:b", title: "Spotify" };
    expect(dedupeSeries([netflix, spotify])).toHaveLength(2);
  });
});

describe("occurrence generation", () => {
  it("emits exactly one occurrence per date", () => {
    const occ = generateSeriesOccurrences(joeBirthdayFromProfile, { todayISO: TODAY });
    const dates = occ.map((o) => o.date);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it("generates at least 5 years of birthdays", () => {
    const occ = generateSeriesOccurrences(joeBirthdayFromProfile, { todayISO: TODAY });
    expect(occ.map((o) => o.date)).toEqual([
      "2027-02-11", "2028-02-11", "2029-02-11", "2030-02-11", "2031-02-11",
    ]);
    expect(occ.length).toBeGreaterThanOrEqual(5);
  });

  it("generates at least 12 months for a subscription", () => {
    const netflix: CalendarSeries = {
      id: "obligation:n", kind: "subscription", title: "Netflix",
      source: { system: "obligation", id: "n", profileId: "me", href: "#" },
      baseDate: "2026-08-02", recurrence: "monthly", amount: 9.99,
    };
    const occ = generateSeriesOccurrences(netflix, { todayISO: TODAY });
    expect(occ.length).toBeGreaterThanOrEqual(12);
    expect(occ[0].date).toBe("2026-08-02");
    expect(occ[11].date).toBe("2027-07-02");
  });

  it("keeps a day-31 subscription on month ends, never overflowing", () => {
    const s: CalendarSeries = {
      id: "obligation:x", kind: "subscription", title: "Thing",
      source: { system: "obligation", id: "x", profileId: "me", href: "#" },
      baseDate: "2026-05-31", recurrence: "monthly",
    };
    const dates = generateSeriesOccurrences(s, { todayISO: "2026-05-01" }).slice(0, 4).map((o) => o.date);
    expect(dates).toEqual(["2026-05-31", "2026-06-30", "2026-07-31", "2026-08-31"]);
  });

  it("expands a quarterly liability instead of stopping at the base date", () => {
    const s: CalendarSeries = {
      id: "liability:q", kind: "liability", title: "Quarterly tax",
      source: { system: "liability", id: "q", profileId: "q", href: "#" },
      baseDate: "2026-08-15", recurrence: "quarterly",
    };
    const dates = generateSeriesOccurrences(s, { todayISO: TODAY }).map((o) => o.date);
    expect(dates.slice(0, 4)).toEqual(["2026-08-15", "2026-11-15", "2027-02-15", "2027-05-15"]);
  });

  it("stops a liability at its payoff date", () => {
    const s: CalendarSeries = {
      id: "liability:l", kind: "liability", title: "Car loan",
      source: { system: "liability", id: "l", profileId: "l", href: "#" },
      baseDate: "2026-08-01", recurrence: "monthly", recurrenceEnd: "2026-11-01",
    };
    expect(generateSeriesOccurrences(s, { todayISO: TODAY }).map((o) => o.date))
      .toEqual(["2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01"]);
  });

  it("generates nothing for a paused or archived series", () => {
    expect(generateSeriesOccurrences({ ...joeBirthdayFromProfile, paused: true }, { todayISO: TODAY })).toEqual([]);
    expect(generateSeriesOccurrences({ ...joeBirthdayFromProfile, archived: true }, { todayISO: TODAY })).toEqual([]);
  });

  it("carries source and identity onto every occurrence", () => {
    const [first] = generateSeriesOccurrences(joeBirthdayFromProfile, { todayISO: TODAY });
    expect(first.source.href).toBe(`#/profiles/${JOE}`);
    expect(first.source.profileId).toBe(JOE);
    expect(first.identityKey).toBe(`birthday:${JOE}`);
    expect(first.kind).toBe("birthday");
  });

  it("reflects per-occurrence state", () => {
    const s: CalendarSeries = {
      ...joeBirthdayFromProfile,
      completedDates: ["2027-02-11"],
      skippedDates: ["2028-02-11"],
      movedDates: { "2029-02-11": "2029-02-12" },
    };
    const occ = generateSeriesOccurrences(s, { todayISO: TODAY });
    expect(occ[0].status).toBe("done");
    expect(occ[1].status).toBe("skipped");
    expect(occ[2].effectiveDate).toBe("2029-02-12");
    expect(occ[2].moved).toBe(true);
    expect(occ[3].moved).toBe(false);
  });

  it("marks past occurrences overdue only when completion is required", () => {
    const s: CalendarSeries = {
      id: "event:p", kind: "bill", title: "Rent",
      source: { system: "obligation", id: "p", profileId: "me", href: "#" },
      baseDate: "2026-07-01", recurrence: "monthly",
    };
    const plain = generateSeriesOccurrences(s, { todayISO: TODAY, lookbackDays: 30 });
    expect(plain[0].status).toBe("past");
    const strict = generateSeriesOccurrences(s, { todayISO: TODAY, lookbackDays: 30, requireComplete: true });
    expect(strict[0].status).toBe("overdue");
  });
});

describe("buildCalendarOccurrences — one row per date, app-wide", () => {
  it("renders Joe's birthday once, not twice", () => {
    const all = buildCalendarOccurrences([joeBirthdayFromEvent, joeBirthdayFromProfile], { todayISO: TODAY });
    const joes = all.filter((o) => o.identityKey === `birthday:${JOE}`);
    expect(joes.length).toBeGreaterThan(0);
    // One occurrence per date, and the surviving one is the profile record.
    expect(new Set(joes.map((o) => o.date)).size).toBe(joes.length);
    expect(joes.every((o) => o.source.system === "profile")).toBe(true);
    expect(joes[0].date).toBe("2027-02-11"); // the profile's date, not 2029
  });

  it("never emits two occurrences with the same identity on the same date", () => {
    const all = buildCalendarOccurrences(
      [joeBirthdayFromEvent, joeBirthdayFromProfile, { ...joeBirthdayFromProfile, id: "profile:dupe" }],
      { todayISO: TODAY },
    );
    const keys = all.map((o) => `${o.identityKey}@${o.date}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns a date-sorted stream", () => {
    const all = buildCalendarOccurrences(
      [
        joeBirthdayFromProfile,
        {
          id: "obligation:n", kind: "subscription", title: "Netflix",
          source: { system: "obligation", id: "n", profileId: "me", href: "#" },
          baseDate: "2026-08-02", recurrence: "monthly",
        },
      ],
      { todayISO: TODAY },
    );
    const dates = all.map((o) => o.effectiveDate);
    expect([...dates].sort()).toEqual(dates);
  });

  it("looks up a single day and the next live occurrence", () => {
    const all = buildCalendarOccurrences([joeBirthdayFromProfile], { todayISO: TODAY });
    expect(occurrencesOnDate(all, "2027-02-11")).toHaveLength(1);
    expect(occurrencesOnDate(all, "2027-02-12")).toHaveLength(0);
    expect(nextOccurrenceOf(all, joeBirthdayFromProfile.id, TODAY)?.date).toBe("2027-02-11");
  });

  it("skips done and skipped occurrences when finding the next one", () => {
    const s = { ...joeBirthdayFromProfile, completedDates: ["2027-02-11"], skippedDates: ["2028-02-11"] };
    const all = buildCalendarOccurrences([s], { todayISO: TODAY });
    expect(nextOccurrenceOf(all, s.id, TODAY)?.date).toBe("2029-02-11");
  });
});

describe("horizons and auto-extend", () => {
  it("gives birthdays and anniversaries 5 years, everything else 1", () => {
    expect(horizonDaysFor("birthday")).toBeGreaterThanOrEqual(365 * 5);
    expect(horizonDaysFor("anniversary")).toBeGreaterThanOrEqual(365 * 5);
    expect(horizonDaysFor("subscription")).toBeGreaterThanOrEqual(365);
    expect(horizonDaysFor("liability")).toBeGreaterThanOrEqual(365);
    expect(horizonDaysFor("custom")).toBeGreaterThanOrEqual(365);
  });

  it("asks for an extension when coverage runs short", () => {
    const s: CalendarSeries = {
      id: "obligation:n", kind: "subscription", title: "Netflix",
      source: { system: "obligation", id: "n", profileId: "me", href: "#" },
      baseDate: "2026-08-02", recurrence: "monthly",
    };
    const full = generateSeriesOccurrences(s, { todayISO: TODAY });
    expect(needsHorizonExtension(s, full, TODAY)).toBe(false);
    const short = generateSeriesOccurrences(s, { todayISO: TODAY, horizonDays: 40 });
    expect(needsHorizonExtension(s, short, TODAY)).toBe(true);
    expect(needsHorizonExtension(s, [], TODAY)).toBe(true);
  });

  it("does not extend a series that has genuinely ended", () => {
    const s: CalendarSeries = {
      id: "liability:done", kind: "liability", title: "Paid-off loan",
      source: { system: "liability", id: "d", profileId: "d", href: "#" },
      baseDate: "2026-08-01", recurrence: "monthly", recurrenceEnd: "2026-09-01",
    };
    const occ = generateSeriesOccurrences(s, { todayISO: TODAY });
    expect(needsHorizonExtension(s, occ, TODAY)).toBe(false);
  });

  it("does not extend paused, archived, or non-recurring series", () => {
    expect(needsHorizonExtension({ ...joeBirthdayFromProfile, paused: true }, [], TODAY)).toBe(false);
    expect(needsHorizonExtension({ ...joeBirthdayFromProfile, archived: true }, [], TODAY)).toBe(false);
    expect(needsHorizonExtension({ ...joeBirthdayFromProfile, recurrence: "none" }, [], TODAY)).toBe(false);
  });

  it("doubles the horizon when extending", () => {
    expect(extendedHorizonFor("subscription")).toBe(horizonDaysFor("subscription") * 2);
  });
});

describe("sourceHref — every item knows where it came from", () => {
  it("routes a profile-owned date to that profile", () => {
    expect(sourceHref("event", "evt-1", JOE)).toBe(`#/profiles/${JOE}`);
    expect(sourceHref("obligation", "ob-1", "liab-9")).toBe("#/profiles/liab-9");
    expect(sourceHref("profile", JOE, JOE)).toBe(`#/profiles/${JOE}`);
  });

  it("falls back to the owning system's record when there is no profile", () => {
    expect(sourceHref("obligation", "ob-1")).toBe("#/obligations?focus=ob-1");
    expect(sourceHref("task", "t-1")).toBe("#/tasks?focus=t-1");
    expect(sourceHref("event", "e-1")).toBe("#/calendar?event=e-1");
    expect(sourceHref("document", "d-1")).toBe("#/documents?focus=d-1");
    expect(sourceHref("liability", "l-1")).toBe("#/profiles/l-1");
  });

  it("never returns an empty href", () => {
    const systems = ["event", "profile", "obligation", "liability", "task", "reminder", "habit", "document", "goal"] as const;
    for (const sys of systems) {
      expect(sourceHref(sys, "")).toBeTruthy();
      expect(sourceHref(sys, "id-1")).toBeTruthy();
    }
  });
});

describe("labels", () => {
  it("describes distance from today in human terms", () => {
    expect(relativeDayLabel(TODAY, TODAY)).toBe("today");
    expect(relativeDayLabel("2026-07-26", TODAY)).toBe("tomorrow");
    expect(relativeDayLabel("2026-07-24", TODAY)).toBe("yesterday");
    expect(relativeDayLabel("2026-08-01", TODAY)).toBe("in 7 days");
    expect(relativeDayLabel("2027-02-11", TODAY)).toMatch(/mo$/);
    expect(relativeDayLabel("2031-02-11", TODAY)).toMatch(/yr$/);
  });

  it("rolls an annual date forward to its next occurrence", () => {
    expect(nextAnnual("1990-02-11", TODAY)).toBe("2027-02-11");
    expect(nextAnnual("1990-12-25", TODAY)).toBe("2026-12-25");
    expect(nextAnnual("nonsense", TODAY)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: the second calendar screenshot (2026-07-25). Every recurring
// payment rendered TWICE on the same date under two different labels:
//
//   Liability · ChatGPT Pro · $20.00       Jul 30
//   Subscription · ChatGPT Pro · $20.00    Jul 30
//   Liability · Progressive Auto Ins…      Jul 30
//   Bill · Progressive Auto Insurance      Jul 30
//
// Cause: `kind` was part of the identity key, so `subscription:X:netflix` and
// `liability:X:netflix` never collided. "Subscription", "Liability" and "Bill"
// are DESCRIPTIVE LABELS for one money event, not three different dates.
// ─────────────────────────────────────────────────────────────────────────────
describe("one payment, one occurrence — whatever label it wears", () => {
  const CHATGPT = "chatgpt-liability-id";

  const asLiability: CalendarSeries = {
    id: "liability:chatgpt", kind: "liability", title: "ChatGPT Pro",
    source: {
      system: "liability", id: CHATGPT, profileId: CHATGPT,
      href: `#/profiles/${CHATGPT}`, linkedRecordId: CHATGPT, linkedLabel: "Liability",
    },
    baseDate: "2026-07-30", recurrence: "monthly", amount: 20,
  };
  const asSubscription: CalendarSeries = {
    id: "obligation:ob-chatgpt", kind: "subscription", title: "ChatGPT Pro",
    source: {
      system: "obligation", id: "ob-chatgpt", profileId: CHATGPT,
      href: `#/profiles/${CHATGPT}`, linkedRecordId: CHATGPT, linkedLabel: "Liability",
    },
    baseDate: "2026-07-30", recurrence: "monthly", amount: 20,
  };

  it("gives the liability and the subscription ONE identity", () => {
    expect(seriesIdentityKey(asLiability)).toBe(seriesIdentityKey(asSubscription));
  });

  it("renders one Jul 30 charge, not two", () => {
    const jul30 = buildCalendarOccurrences([asLiability, asSubscription], { todayISO: TODAY })
      .filter((o) => o.date === "2026-07-30");
    expect(jul30).toHaveLength(1);
    expect(jul30[0].amount).toBe(20);
  });

  it("shows it as the Subscription, keeping the liability as metadata", () => {
    // "Type: Subscription · Linked financial record: Liability"
    const [survivor] = dedupeSeries([asLiability, asSubscription]);
    expect(survivor.series.kind).toBe("subscription");
    expect(survivor.series.source.linkedLabel).toBe("Liability");
    expect(survivor.duplicateIds).toEqual(["liability:chatgpt"]);
  });

  it("merges a bill with its liability the same way", () => {
    const PROG = "progressive-id";
    const liab: CalendarSeries = {
      id: "liability:prog", kind: "liability", title: "Progressive Auto Insurance – Honda CR-V 2021",
      source: { system: "liability", id: PROG, profileId: PROG, href: "#", linkedRecordId: PROG },
      baseDate: "2026-07-30", recurrence: "monthly", amount: 155,
    };
    const bill: CalendarSeries = {
      id: "obligation:prog", kind: "bill", title: "Progressive Auto Insurance – Honda CR-V 2021",
      source: { system: "obligation", id: "ob-prog", profileId: PROG, href: "#", linkedRecordId: PROG },
      baseDate: "2026-07-30", recurrence: "monthly", amount: 155,
    };
    const occ = buildCalendarOccurrences([liab, bill], { todayISO: TODAY })
      .filter((o) => o.date === "2026-07-30");
    expect(occ).toHaveLength(1);
    expect(occ[0].kind).toBe("bill");
  });

  it("keeps two genuinely different bills on one liability separate", () => {
    // "Do not delete separate records merely because their names are similar."
    const escrow: CalendarSeries = {
      ...asSubscription, id: "obligation:escrow", title: "Escrow", amount: 400,
    };
    expect(seriesIdentityKey(asSubscription)).not.toBe(seriesIdentityKey(escrow));
    expect(dedupeSeries([asLiability, asSubscription, escrow])).toHaveLength(2);
  });

  it("keeps unrelated subscriptions apart", () => {
    const spotify: CalendarSeries = {
      ...asSubscription, id: "obligation:spotify", title: "Spotify Premium",
      source: { ...asSubscription.source, id: "ob-spotify", profileId: "spotify-id", linkedRecordId: "spotify-id" },
    };
    expect(dedupeSeries([asSubscription, spotify])).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: "Joe's Birthday · Every year on Feb 11 · Next: Sun, Feb 11, 2029
// · in 932 days". The backing event had drifted to a base date of 2029-02-11,
// so expansion "correctly" started in 2029 and skipped 2027 and 2028.
//
// A birthday's stored YEAR is a birth year, never a start date.
// ─────────────────────────────────────────────────────────────────────────────
describe("annual dates always land on the earliest valid date after today", () => {
  const joeBirthdayDrifted: CalendarSeries = {
    id: "event:drifted", kind: "birthday", title: "Joe's Birthday",
    source: { system: "profile", id: JOE, profileId: JOE, href: `#/profiles/${JOE}` },
    baseDate: "2029-02-11", // the corrupt base from the screenshot
    recurrence: "yearly",
  };

  it("returns Feb 11 2027, not 2029, for a base stored in the future", () => {
    const occ = generateSeriesOccurrences(joeBirthdayDrifted, { todayISO: TODAY });
    expect(occ[0].date).toBe("2027-02-11");
    expect(nextOccurrenceOf(occ, joeBirthdayDrifted.id, TODAY)?.date).toBe("2027-02-11");
  });

  it("gives the same answer whatever year is stored", () => {
    for (const baseDate of ["1990-02-11", "2029-02-11", "2005-02-11", "2026-02-11"]) {
      const occ = generateSeriesOccurrences({ ...joeBirthdayDrifted, baseDate }, { todayISO: TODAY });
      expect(occ[0].date, baseDate).toBe("2027-02-11");
    }
  });

  it("still generates five future years from the re-anchored date", () => {
    const dates = generateSeriesOccurrences(joeBirthdayDrifted, { todayISO: TODAY }).map((o) => o.date);
    expect(dates).toEqual([
      "2027-02-11", "2028-02-11", "2029-02-11", "2030-02-11", "2031-02-11",
    ]);
  });

  it("picks this year's date when it is still ahead", () => {
    // On Jan 1st, the Feb 11 birthday later that same year is the next one.
    const occ = generateSeriesOccurrences(joeBirthdayDrifted, { todayISO: "2026-01-01" });
    expect(occ[0].date).toBe("2026-02-11");
  });

  it("keeps a Feb 29 anniversary legal in non-leap years", () => {
    const leapling: CalendarSeries = {
      ...joeBirthdayDrifted, kind: "anniversary", baseDate: "2004-02-29",
    };
    const dates = generateSeriesOccurrences(leapling, { todayISO: TODAY }).map((o) => o.date);
    expect(dates[0]).toBe("2027-02-28");
    expect(dates).toContain("2028-02-29");
  });

  it("does NOT re-anchor a non-annual series that genuinely starts later", () => {
    // A subscription beginning next March must not be dragged into the past.
    const future: CalendarSeries = {
      id: "obligation:future", kind: "subscription", title: "Later",
      source: { system: "obligation", id: "f", profileId: "me", href: "#" },
      baseDate: "2027-03-01", recurrence: "monthly",
    };
    expect(generateSeriesOccurrences(future, { todayISO: TODAY })[0].date).toBe("2027-03-01");
  });
});
