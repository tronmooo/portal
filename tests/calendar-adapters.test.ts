// Pins the system→calendar adapters: every record arrives in ONE shape, and
// shadow records lose to the system that actually owns the date.
//
// The end-to-end case is the reported screenshot: Joe's birthday listed once as
// a managed recurring event ("Every year on Feb 11 · Joe · Next: Feb 11 2029")
// and again in the cross-app feed ("Joe — Birthday · Feb 11 · IN 7 MO").
import { describe, it, expect } from "vitest";
import {
  seriesFromProfiles,
  seriesFromEvents,
  seriesFromObligations,
  seriesFromLiabilityProfiles,
  seriesFromTasks,
  seriesFromReminders,
  seriesFromDocuments,
  seriesFromAll,
  filterSeriesByProfiles,
  frequencyToRecurrence,
  inferKindFromText,
  parseAmountFromTitle,
} from "../shared/calendar-adapters";
import {
  buildCalendarOccurrences, generateSeriesOccurrences, seriesIdentityKey, dedupeSeries,
} from "../shared/calendar-occurrences";

const TODAY = "2026-07-25";
const JOE = "joe-id";

const joeProfile = {
  id: JOE, name: "Joe", type: "person",
  fields: { birthday: "1990-02-11" },
};

// The hand-typed recurring event, drifted to 2029 (as in the screenshot).
const joeBirthdayEvent = {
  id: "evt-joe-bday",
  title: "Joe's Birthday",
  date: "2029-02-11",
  recurrence: "yearly",
  linkedProfiles: [JOE],
  tags: ["rdate", "rd:kind:birthday"],
};

describe("the reported duplicate: Joe's birthday renders once", () => {
  it("collapses the profile DOB and the typed-in event into one series", () => {
    const all = seriesFromAll({ profiles: [joeProfile], events: [joeBirthdayEvent] });
    // Both records are adapted — we never silently drop a record...
    expect(all.filter((s) => s.kind === "birthday")).toHaveLength(2);
    // ...but they share one identity, and the event is marked as the shadow.
    const keys = all.filter((s) => s.kind === "birthday").map(seriesIdentityKey);
    expect(new Set(keys).size).toBe(1);
    expect(all.find((s) => s.source.system === "event")!.shadow).toBe(true);
  });

  it("renders a single occurrence per date, from the profile record", () => {
    const all = seriesFromAll({ profiles: [joeProfile], events: [joeBirthdayEvent] });
    const occ = buildCalendarOccurrences(all, { todayISO: TODAY })
      .filter((o) => o.kind === "birthday");
    expect(new Set(occ.map((o) => o.date)).size).toBe(occ.length);
    expect(occ[0].date).toBe("2027-02-11"); // the real next birthday, not 2029
    expect(occ.every((o) => o.source.system === "profile")).toBe(true);
  });

  it("navigates to Joe's profile, not a generic calendar page", () => {
    const all = seriesFromAll({ profiles: [joeProfile], events: [joeBirthdayEvent] });
    const [birthday] = buildCalendarOccurrences(all, { todayISO: TODAY })
      .filter((o) => o.kind === "birthday");
    expect(birthday.source.href).toBe(`#/profiles/${JOE}`);
    expect(birthday.source.profileId).toBe(JOE);
  });

  it("keeps a non-birthday event of Joe's as its own series", () => {
    const dentist = {
      id: "evt-dentist", title: "Dentist checkup", date: "2026-09-01",
      recurrence: "yearly", linkedProfiles: [JOE], tags: ["rdate", "rd:kind:appointment"],
    };
    const all = seriesFromAll({ profiles: [joeProfile], events: [dentist] });
    const s = all.find((x) => x.source.id === "evt-dentist")!;
    expect(s.shadow).toBe(false);
    expect(s.kind).toBe("appointment");
    // Its own identity, so it never merges with the birthday.
    expect(seriesIdentityKey(s)).not.toBe(`birthday:${JOE}`);
  });

  it("shadows a birthday event even when only its title says so", () => {
    // No rd:kind tag — the title alone must still be recognized, or a typed-in
    // "Joe's Birthday" event would slip past the dedup and render twice.
    const untagged = {
      id: "evt-plain", title: "Joe's Birthday", date: "2029-02-11",
      recurrence: "yearly", linkedProfiles: [JOE],
    };
    const all = seriesFromAll({ profiles: [joeProfile], events: [untagged] });
    expect(all.find((s) => s.source.id === "evt-plain")!.shadow).toBe(true);
    const occ = buildCalendarOccurrences(all, { todayISO: TODAY }).filter((o) => o.kind === "birthday");
    expect(occ.every((o) => o.source.system === "profile")).toBe(true);
  });
});

describe("seriesFromProfiles", () => {
  it("emits a yearly birthday from the profile's date of birth", () => {
    const [s] = seriesFromProfiles([joeProfile]);
    expect(s).toMatchObject({
      kind: "birthday", title: "Joe's Birthday", baseDate: "1990-02-11", recurrence: "yearly",
    });
    expect(s.source).toMatchObject({ system: "profile", id: JOE, profileId: JOE });
  });

  it("recognizes every spelling of the birthday field", () => {
    for (const key of ["birthday", "birthDate", "birth_date", "dob", "dateOfBirth", "date_of_birth"]) {
      const out = seriesFromProfiles([{ id: "p", name: "P", type: "person", fields: { [key]: "1990-02-11" } }]);
      expect(out.map((s) => s.kind)).toContain("birthday");
    }
  });

  it("emits ONE birthday even when two field spellings are present", () => {
    const out = seriesFromProfiles([
      { id: "p", name: "P", type: "person", fields: { dob: "1990-02-11", birthday: "1990-02-11" } },
    ]);
    expect(out.filter((s) => s.kind === "birthday")).toHaveLength(1);
  });

  it("finds a date nested one level down", () => {
    const out = seriesFromProfiles([
      { id: "p", name: "P", type: "person", fields: { personal: { birthday: "1990-02-11" } } },
    ]);
    expect(out).toHaveLength(1);
  });

  it("emits anniversaries too", () => {
    const out = seriesFromProfiles([
      { id: "p", name: "P", type: "person", fields: { anniversary: "2010-06-05" } },
    ]);
    expect(out[0]).toMatchObject({ kind: "anniversary", recurrence: "yearly", baseDate: "2010-06-05" });
  });

  it("ignores non-date and unrelated fields", () => {
    expect(seriesFromProfiles([
      { id: "p", name: "P", type: "person", fields: { birthday: "sometime", nickname: "Jo", color: "blue" } },
    ])).toEqual([]);
    expect(seriesFromProfiles([{ id: "p", name: "P", type: "person" }])).toEqual([]);
    expect(seriesFromProfiles([null as any, undefined as any])).toEqual([]);
  });
});

describe("seriesFromObligations", () => {
  const netflix = {
    id: "ob-netflix", name: "Netflix", amount: 9.99, frequency: "monthly",
    category: "subscription", nextDueDate: "2026-08-02", linkedProfiles: ["me"],
  };

  it("classifies a subscription and carries its amount", () => {
    const [s] = seriesFromObligations([netflix]);
    expect(s).toMatchObject({ kind: "subscription", title: "Netflix", amount: 9.99, recurrence: "monthly" });
  });

  it("routes a liability-backed bill to that liability's profile", () => {
    const [s] = seriesFromObligations([{ ...netflix, linkedLiabilityId: "liab-7" }]);
    expect(s.source.profileId).toBe("liab-7");
    expect(s.source.href).toBe("#/profiles/liab-7");
  });

  it("folds category spellings before classifying", () => {
    // "utility" and "utilities" must not produce two different kinds.
    const a = seriesFromObligations([{ ...netflix, id: "a", category: "utility", name: "Power" }])[0];
    const b = seriesFromObligations([{ ...netflix, id: "b", category: "utilities", name: "Power" }])[0];
    expect(a.kind).toBe(b.kind);
  });

  it("drops cancelled obligations and marks paused ones", () => {
    expect(seriesFromObligations([{ ...netflix, status: "cancelled" }])).toEqual([]);
    expect(seriesFromObligations([{ ...netflix, status: "paused" }])[0].paused).toBe(true);
  });

  it("ignores rows with no usable due date", () => {
    expect(seriesFromObligations([{ ...netflix, nextDueDate: null }])).toEqual([]);
  });
});

describe("seriesFromLiabilityProfiles", () => {
  const mortgage = {
    id: "liab-1", name: "Lakeview mortgage", type: "liability", type_key: "mortgage",
    fields: { nextDueDate: "2026-08-01", monthlyPayment: 1850, payoffDate: "2041-08-01" },
  };

  it("builds a monthly payment series that ends at payoff", () => {
    const [s] = seriesFromLiabilityProfiles([mortgage]);
    expect(s).toMatchObject({
      kind: "liability", recurrence: "monthly", baseDate: "2026-08-01",
      recurrenceEnd: "2041-08-01", amount: 1850,
    });
    expect(s.source.href).toBe("#/profiles/liab-1");
  });

  it("ignores non-liability profiles and liabilities with no due date", () => {
    expect(seriesFromLiabilityProfiles([joeProfile])).toEqual([]);
    expect(seriesFromLiabilityProfiles([{ ...mortgage, fields: {} }])).toEqual([]);
  });
});

describe("seriesFromTasks / Reminders / Documents", () => {
  it("reads a recurring task's rule from its tags", () => {
    const [s] = seriesFromTasks([
      { id: "t1", title: "Water plants", dueDate: "2026-07-26", tags: ["recur:weekly"], linkedProfiles: ["me"] },
    ]);
    expect(s).toMatchObject({ kind: "task", recurrence: "weekly", baseDate: "2026-07-26" });
    expect(s.source.href).toBe("#/tasks?focus=t1");
  });

  it("treats an untagged task as one-off and drops completed ones", () => {
    expect(seriesFromTasks([{ id: "t2", title: "X", dueDate: "2026-07-26" }])[0].recurrence).toBe("none");
    expect(seriesFromTasks([{ id: "t3", title: "X", dueDate: "2026-07-26", status: "done" }])).toEqual([]);
  });

  it("turns a reminder's fireAt instant into a calendar date", () => {
    const [s] = seriesFromReminders([{ id: "r1", title: "Call mom", fireAt: "2026-08-03T17:00:00.000Z" }]);
    expect(s).toMatchObject({ kind: "reminder", baseDate: "2026-08-03", recurrence: "none" });
  });

  it("picks up a document expiration under any of its field spellings", () => {
    for (const key of ["expiration_date", "expirationDate", "valid_until", "renewalDate"]) {
      const out = seriesFromDocuments([{ id: "d1", name: "Passport", extractedData: { [key]: "2027-01-01" } }]);
      expect(out[0]).toMatchObject({ kind: "document", baseDate: "2027-01-01" });
      expect(out[0].source.href).toBe("#/documents/d1");
    }
    expect(seriesFromDocuments([{ id: "d2", name: "X", extractedData: { note: "hello" } }])).toEqual([]);
  });
});

describe("frequencyToRecurrence / inferKindFromText", () => {
  it("maps every frequency the app writes", () => {
    expect(frequencyToRecurrence("monthly")).toBe("monthly");
    expect(frequencyToRecurrence("bi-weekly")).toBe("biweekly");
    expect(frequencyToRecurrence("annual")).toBe("yearly");
    expect(frequencyToRecurrence("quarterly")).toBe("quarterly");
    expect(frequencyToRecurrence("once")).toBe("none");
    expect(frequencyToRecurrence(undefined)).toBe("none");
  });

  it("classifies free-text titles", () => {
    expect(inferKindFromText("Joe's Birthday")).toBe("birthday");
    expect(inferKindFromText("Wedding anniversary")).toBe("anniversary");
    expect(inferKindFromText("Netflix subscription")).toBe("subscription");
    expect(inferKindFromText("Car loan payment")).toBe("liability");
    expect(inferKindFromText("Rent")).toBe("bill");
    expect(inferKindFromText("Registration renewal")).toBe("renewal");
    expect(inferKindFromText("Oil change")).toBe("maintenance");
    expect(inferKindFromText("Dentist appointment")).toBe("appointment");
    expect(inferKindFromText("Watch the sunset")).toBe("custom");
  });
});

describe("filterSeriesByProfiles", () => {
  it("keeps everything when no filter is active", () => {
    const all = seriesFromAll({ profiles: [joeProfile] });
    expect(filterSeriesByProfiles(all, [])).toHaveLength(all.length);
    expect(filterSeriesByProfiles(all, null)).toHaveLength(all.length);
  });

  it("restricts to the selected profiles", () => {
    const all = seriesFromAll({
      profiles: [joeProfile, { id: "bob", name: "Bob", type: "person", fields: { dob: "1985-03-02" } }],
    });
    expect(filterSeriesByProfiles(all, [JOE]).every((s) => s.source.profileId === JOE)).toBe(true);
    expect(filterSeriesByProfiles(all, [JOE])).toHaveLength(1);
  });
});

describe("seriesFromAll is total and safe", () => {
  it("handles completely empty input", () => {
    expect(seriesFromAll({})).toEqual([]);
  });

  it("produces globally unique series ids", () => {
    const all = seriesFromAll({
      profiles: [joeProfile, { id: "liab-1", name: "Loan", type: "liability", fields: { nextDueDate: "2026-08-01" } }],
      events: [joeBirthdayEvent],
      obligations: [{ id: "ob-1", name: "Netflix", frequency: "monthly", category: "subscription", nextDueDate: "2026-08-02" }],
      tasks: [{ id: "t1", title: "T", dueDate: "2026-08-01" }],
      reminders: [{ id: "r1", title: "R", fireAt: "2026-08-01T10:00:00Z" }],
      documents: [{ id: "d1", name: "D", extractedData: { expiration_date: "2027-01-01" } }],
    });
    const ids = all.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(all.every((s) => !!s.source.href)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The calendar GRID (server timeline) and the recurring STREAM (client hook)
// are two different code paths over the same data. They agree only because
// both run these shared functions. This pins that contract: whatever one
// suppresses as a shadow, the other must suppress too, and the surviving
// birthday must come from the same record.
// ─────────────────────────────────────────────────────────────────────────────
describe("grid and stream cannot diverge", () => {
  const inputs = {
    profiles: [joeProfile],
    events: [joeBirthdayEvent, { id: "evt-other", title: "Team standup", date: "2026-07-27", recurrence: "weekly" }],
  };

  it("both paths suppress the same shadow event", () => {
    // What the server timeline computes to exclude from the grid…
    const profileSeries = seriesFromProfiles(inputs.profiles);
    const knownBirthdayProfiles = new Set(
      profileSeries.filter((s) => s.kind === "birthday").map((s) => s.source.profileId!),
    );
    const shadowIds = new Set(
      seriesFromEvents(inputs.events, { knownBirthdayProfiles })
        .filter((s) => s.shadow)
        .map((s) => s.source.id),
    );
    expect([...shadowIds]).toEqual(["evt-joe-bday"]);

    // …is exactly what the client stream drops during dedup.
    const streamBirthdays = buildCalendarOccurrences(seriesFromAll(inputs), { todayISO: TODAY })
      .filter((o) => o.kind === "birthday");
    expect(streamBirthdays.every((o) => o.source.system === "profile")).toBe(true);
    expect(streamBirthdays.some((o) => o.source.id === "evt-joe-bday")).toBe(false);
  });

  it("both paths render the birthday from the profile, on the same date", () => {
    const fromProfileRecord = seriesFromProfiles(inputs.profiles).find((s) => s.kind === "birthday")!;
    const gridDates = generateSeriesOccurrences(fromProfileRecord, { todayISO: TODAY }).map((o) => o.date);
    const streamDates = buildCalendarOccurrences(seriesFromAll(inputs), { todayISO: TODAY })
      .filter((o) => o.kind === "birthday")
      .map((o) => o.date);
    expect(streamDates).toEqual(gridDates);
    expect(streamDates[0]).toBe("2027-02-11");
  });

  it("leaves ordinary events untouched on both paths", () => {
    const nonShadow = seriesFromEvents(inputs.events, { knownBirthdayProfiles: new Set([JOE]) })
      .filter((s) => !s.shadow);
    expect(nonShadow.map((s) => s.source.id)).toEqual(["evt-other"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: "Lubi why is there a duplicate of that". Lubi appeared twice —
// once as a subscription obligation ("Lubi", $10/month, day 3) and once as a
// hand-created recurring event titled "Lubi — $10" on the same schedule.
//
// Two reasons it survived the payment merge:
//   1. the amount was baked into the event's TITLE, so the normalized slugs
//      were "lubi" and "lubi10" and could never match;
//   2. the event's kind was "event", not a payment kind, so it never entered
//      the payment identity space at all.
// ─────────────────────────────────────────────────────────────────────────────
describe("a recurring money event is the same thing as its obligation", () => {
  const LUBI = "lubi-liability";
  const raw = {
    profiles: [{ id: LUBI, name: "Lubi", type: "liability",
      fields: { nextDueDate: "2026-08-03", monthlyPayment: 10 } }],
    obligations: [{ id: "ob-lubi", name: "Lubi", amount: 10, frequency: "monthly",
      category: "subscription", nextDueDate: "2026-08-03", linkedLiabilityId: LUBI }],
    events: [{ id: "ev-lubi", title: "Lubi — $10", date: "2026-08-03",
      recurrence: "monthly", tags: ["rdate"] }],
  };

  it("strips the amount out of the event title", () => {
    expect(parseAmountFromTitle("Lubi — $10")).toEqual({ title: "Lubi", amount: 10 });
    expect(parseAmountFromTitle("Netflix — $9.99")).toEqual({ title: "Netflix", amount: 9.99 });
    expect(parseAmountFromTitle("Rent ($2,500)")).toEqual({ title: "Rent", amount: 2500 });
  });

  it("leaves a title that merely mentions money alone", () => {
    expect(parseAmountFromTitle("Save $500 for the trip").title).toBe("Save $500 for the trip");
    expect(parseAmountFromTitle("Lubi").amount).toBeUndefined();
  });

  it("collapses all three Lubi records into one subscription", () => {
    const survivors = dedupeSeries(seriesFromAll(raw));
    expect(survivors).toHaveLength(1);
    expect(survivors[0].series).toMatchObject({ kind: "subscription", title: "Lubi", amount: 10 });
    expect(survivors[0].duplicateIds).toEqual(
      expect.arrayContaining(["liability:lubi-liability", "event:ev-lubi"]),
    );
  });

  it("produces exactly one occurrence on the shared due date", () => {
    const aug3 = buildCalendarOccurrences(seriesFromAll(raw), { todayISO: TODAY })
      .filter((o) => o.date === "2026-08-03");
    expect(aug3).toHaveLength(1);
  });

  it("gives a lone money event a real category and amount instead of 'Event'", () => {
    const [netflix] = dedupeSeries(seriesFromAll({
      events: [{ id: "ev-nf", title: "Netflix — $9.99", date: "2026-08-02", recurrence: "monthly" }],
    }));
    expect(netflix.series.kind).not.toBe("event");
    expect(netflix.series).toMatchObject({ title: "Netflix", amount: 9.99 });
  });

  it("does NOT merge same-named payments owned by different people", () => {
    const mine = seriesFromAll({
      obligations: [{ id: "a", name: "Lubi", amount: 10, frequency: "monthly",
        category: "subscription", nextDueDate: "2026-08-03", linkedProfiles: ["me"] }],
    });
    const theirs = seriesFromAll({
      obligations: [{ id: "b", name: "Lubi", amount: 10, frequency: "monthly",
        category: "subscription", nextDueDate: "2026-08-03", linkedProfiles: ["you"] }],
    });
    expect(dedupeSeries([...mine, ...theirs])).toHaveLength(2);
  });

  it("does NOT merge same-named payments with different amounts or schedules", () => {
    const base = { name: "Lubi", frequency: "monthly", category: "subscription",
      nextDueDate: "2026-08-03", linkedProfiles: ["me"] };
    const differentAmount = seriesFromAll({
      obligations: [{ ...base, id: "a", amount: 10 }, { ...base, id: "b", amount: 25 }],
    });
    expect(dedupeSeries(differentAmount)).toHaveLength(2);
    const differentDay = seriesFromAll({
      obligations: [
        { ...base, id: "c", amount: 10 },
        { ...base, id: "d", amount: 10, nextDueDate: "2026-08-17" },
      ],
    });
    expect(dedupeSeries(differentDay)).toHaveLength(2);
  });
});
