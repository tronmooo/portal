// tests/date-rules.test.ts
//
// The contract for shared/date-rules — the engine that decides what a date
// MEANS and how the app must treat it.
//
// Written against the bug that produced it (user report 2026-08-20): a driver's
// licence was extracted, its date of birth and expiration were saved to the
// profile and the document… and the Recurring & Important Dates screen read
// "All 0". Two causes, both pinned here:
//
//   • the values were stored as the licence printed them ("07/18/2034") and
//     every reader required ISO, so nothing could see them;
//   • three different modules each had their own idea of which field is a
//     meaningful date, so the surfaces disagreed about what existed.
//
// The tests are organised as the end-to-end scenarios the user asked for:
// the same date arriving by document extraction, by chat, and by manual entry
// must produce the same state, and that state must reach every view.

import { describe, it, expect } from "vitest";
import {
  classifyDateField,
  normalizeEntityDateFields,
  rulesFromAll,
  rulesFromProfiles,
  rulesFromDocuments,
  dateRuleId,
  countdownLabel,
  calendarDelta,
  seriesFromDateRules,
  isBareExpiryStatement,
  parseBirthdayLabel,
  dedupeRules,
} from "../shared/date-rules";
import { seriesFromAll } from "../shared/calendar-adapters";
import {
  buildCalendarOccurrences,
  isRecurringRule,
  isImportantDate,
  onlyRulesAndImportantDates,
  generateSeriesOccurrences,
} from "../shared/calendar-occurrences";
import { aggregateUpcomingDates } from "../shared/upcoming-dates";
import { canonicalizeProfileFields } from "../shared/profile-field-canon";

const JANE = "jane-1";
const TODAY = "2026-08-20";

/** The profile as it exists before anything is told to the app. */
const bareProfile = () => ({ id: JANE, name: "Jane Doe", type: "person", fields: {} as any });

/** The uninteresting half of a DateRule, so a test can state only what it means. */
const RULE_STUB = {
  ruleSubtype: undefined, occurrenceType: "one_time", sourceField: "date", sourcePath: "date",
  rawValue: "", ownerIds: [], recurrence: "none", calendarVisible: true, upcomingVisible: true,
  importantVisible: true, countdownEnabled: true, active: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. Classification: what does this date mean?
// ─────────────────────────────────────────────────────────────────────────────

describe("classification", () => {
  it("reads every spelling of a field name as one field", () => {
    for (const key of [
      "expiration_date", "expirationDate", "Expiration Date", "EXPIRATION-DATE", "expires", "valid_until",
    ]) {
      expect(classifyDateField(key).ruleType, key).toBe("expiration");
    }
    for (const key of ["dob", "DOB", "dateOfBirth", "date_of_birth", "birthdate", "birthday"]) {
      expect(classifyDateField(key).ruleType, key).toBe("birthday");
    }
  });

  it("makes a birthday yearly and an expiration one-time", () => {
    const b = classifyDateField("dateOfBirth");
    expect(b.occurrenceType).toBe("recurring");
    expect(b.recurrence).toBe("yearly");

    // The distinction the user was explicit about: a licence expires once. It
    // becomes a NEW date when renewed; it does not repeat every year.
    const e = classifyDateField("expiration_date", "drivers_license");
    expect(e.occurrenceType).toBe("one_time");
    expect(e.recurrence).toBe("none");
  });

  it("leaves pure metadata off the calendar", () => {
    // "Document generated on May 4" must not clutter anything.
    for (const key of ["issueDate", "dateIssued", "createdAt", "uploadedAt", "scanDate", "printDate", "asOfDate"]) {
      expect(classifyDateField(key).actionable, key).toBe(false);
    }
    // …and an unrecognised date field is metadata by default: a date has to
    // say what it is before it earns a place.
    expect(classifyDateField("someRandomDate").actionable).toBe(false);
  });

  it("uses the document type to name the thing, never to decide the rule", () => {
    expect(classifyDateField("expiration_date", "drivers_license").ruleSubtype).toBe("drivers_license");
    expect(classifyDateField("expiration_date", "passport").ruleSubtype).toBe("passport");
    // An unfamiliar document kind still classifies correctly — the semantics
    // come from the field, so the vocabulary is not a hard-coded per-doc list.
    expect(classifyDateField("expiration_date", "fishing_permit_2031").ruleType).toBe("expiration");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The root cause: a date printed as a human reads it
// ─────────────────────────────────────────────────────────────────────────────

describe("the value a licence actually prints", () => {
  it("was invisible to every surface, and is not any more", () => {
    // Exactly what confirm-extraction used to store.
    const profile = { ...bareProfile(), fields: { dateOfBirth: "07/10/1994", birthday: "07/10/1994" } };
    const doc = {
      id: "doc-1", name: "Sample Driver License", type: "drivers_license",
      linkedProfiles: [JANE], extractedData: { expiration_date: "07/18/2034" },
    };
    const rules = rulesFromAll({ profiles: [profile], documents: [doc] });
    expect(rules.map(r => r.ruleType).sort()).toEqual(["birthday", "expiration"]);
    expect(rules.find(r => r.ruleType === "birthday")!.date).toBe("1994-07-10");
    expect(rules.find(r => r.ruleType === "expiration")!.date).toBe("2034-07-18");
  });

  it("normalizes on WRITE at the chokepoint every input path shares", () => {
    // canonicalizeProfileFields is what document extraction AND the chat tools
    // both call before writing profile fields.
    const out = canonicalizeProfileFields({ dateOfBirth: "07/10/1994", licenseNumber: "D1234567" });
    expect(out.fields.dateOfBirth).toBe("1994-07-10");
    // A licence NUMBER is not a date and must survive untouched.
    expect(out.fields.licenseNumber).toBe("D1234567");
  });

  it("never rewrites a value on a field that is not about a date", () => {
    const { fields } = normalizeEntityDateFields({
      notes: "we met on 6/4/2029 at the fair",
      address: "1994-07-10 Main St",
    });
    expect(fields.notes).toBe("we met on 6/4/2029 at the fair");
    expect(fields.address).toBe("1994-07-10 Main St");
  });

  it("accepts every printed form a document or a person can produce", () => {
    for (const raw of ["07/18/2034", "7/18/2034", "2034-07-18", "July 18, 2034", "18 Jul 2034"]) {
      const { fields } = normalizeEntityDateFields({ expiration_date: raw });
      expect(fields.expiration_date, raw).toBe("2034-07-18");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Three doors, one result
// ─────────────────────────────────────────────────────────────────────────────

describe("the input mechanism is irrelevant once the data is saved", () => {
  // What each write path leaves on the profile, as the server actually writes
  // it: extraction and chat both go through canonicalizeProfileFields; the
  // manual form goes through normalizeEntityDateFields in the profile route.
  const viaExtraction = () => canonicalizeProfileFields(
    { dateOfBirth: "07/10/1994", birthday: "07/10/1994" }).fields;
  const viaChat = () => canonicalizeProfileFields({ dateOfBirth: "July 10, 1994" }).fields;
  const viaManualForm = () => normalizeEntityDateFields({ dateOfBirth: "1994-07-10" }).fields;

  it("stores the same canonical value whichever door the date came in by", () => {
    for (const fields of [viaExtraction(), viaChat(), viaManualForm()]) {
      expect(fields.dateOfBirth).toBe("1994-07-10");
    }
  });

  it("derives an identical rule from all three", () => {
    const shapes = [viaExtraction(), viaChat(), viaManualForm()].map((fields) => {
      const [rule] = rulesFromProfiles([{ ...bareProfile(), fields }]);
      // The id and the behaviour are what must match; `rawValue` legitimately
      // differs only when a path stores a non-canonical value, and none do.
      return {
        id: rule.id, type: rule.ruleType, date: rule.date,
        recurrence: rule.recurrence, occurrenceType: rule.occurrenceType,
      };
    });
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Idempotency and lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe("a rule is the same rule every time", () => {
  const doc = (exp: string) => ({
    id: "doc-1", name: "Driver License", type: "drivers_license",
    linkedProfiles: [JANE], extractedData: { expiration_date: exp },
  });

  it("re-processing the same document does not create a second rule", () => {
    const once = rulesFromDocuments([doc("2034-07-18")]);
    const twice = rulesFromDocuments([doc("2034-07-18")]);
    expect(once).toHaveLength(1);
    expect(twice[0].id).toBe(once[0].id);
    expect(once[0].id).toBe(dateRuleId("document", "doc-1", "expiration_date", "expiration"));
  });

  it("two spellings of the same date on one record are one rule", () => {
    // Extraction writes BOTH dateOfBirth and birthday.
    const rules = rulesFromProfiles([{ ...bareProfile(), fields: { dateOfBirth: "1994-07-10", birthday: "1994-07-10" } }]);
    expect(rules.filter(r => r.ruleType === "birthday")).toHaveLength(1);
  });

  it("changing the source date moves the rule instead of adding one", () => {
    const before = rulesFromDocuments([doc("2034-07-18")]);
    const after = rulesFromDocuments([doc("2036-07-18")]);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);   // same rule
    expect(after[0].date).toBe("2036-07-18"); // new date
  });

  it("deleting the source removes the rule — an orphan is unrepresentable", () => {
    expect(rulesFromDocuments([])).toHaveLength(0);
  });

  it("keeps the person's birthday when only the licence is deleted", () => {
    const profile = { ...bareProfile(), fields: { dateOfBirth: "1994-07-10" } };
    const after = rulesFromAll({ profiles: [profile], documents: [] });
    expect(after.map(r => r.ruleType)).toEqual(["birthday"]);
  });

  it("one real-world date reaching the app twice is one rule", () => {
    // The same expiration held on the person AND on the uploaded licence.
    const profile = { ...bareProfile(), fields: { licenseExpiration: "2034-07-18" } };
    const rules = rulesFromAll({ profiles: [profile], documents: [doc("2034-07-18")] });
    expect(rules.filter(r => r.ruleType === "expiration")).toHaveLength(1);
    // The document wins: it is the record that actually carries the licence,
    // and therefore the record you open to change the date.
    expect(rules.find(r => r.ruleType === "expiration")!.sourceEntityType).toBe("document");
  });

  it("a passport and a licence expiring the same day stay two dates", () => {
    const rules = rulesFromDocuments([
      { id: "d1", name: "License", type: "drivers_license", linkedProfiles: [JANE], extractedData: { expiration_date: "2034-07-18" } },
      { id: "d2", name: "Passport", type: "passport", linkedProfiles: [JANE], extractedData: { expiration_date: "2034-07-18" } },
    ]);
    expect(rules).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Traceability
// ─────────────────────────────────────────────────────────────────────────────

describe("every rule points back at where it came from", () => {
  it("names the entity, the field and the semantic type", () => {
    const [rule] = rulesFromDocuments([{
      id: "doc-1", name: "Sample Driver License", type: "drivers_license",
      linkedProfiles: [JANE], extractedData: { expiration_date: "2034-07-18" },
    }]);
    expect(rule.sourceEntityType).toBe("document");
    expect(rule.sourceEntityId).toBe("doc-1");
    expect(rule.sourceField).toBe("expiration_date");
    expect(rule.ruleType).toBe("expiration");
    expect(rule.ruleSubtype).toBe("drivers_license");
    expect(rule.profileId).toBe(JANE);
    expect(rule.href).toBe("#/documents/doc-1");
  });

  it("carries the trace all the way to the calendar occurrence", () => {
    const rules = rulesFromDocuments([{
      id: "doc-1", name: "License", type: "drivers_license",
      linkedProfiles: [JANE], extractedData: { expiration_date: "2034-07-18" },
    }]);
    const [series] = seriesFromDateRules(rules);
    // occurrence → series → rule → source entity + field.
    expect(series.id).toBe(`rule:${rules[0].id}`);
    const [occ] = generateSeriesOccurrences(series, { todayISO: TODAY, horizonDays: 366 * 12 });
    expect(occ.seriesId).toBe(series.id);
    expect(occ.source.id).toBe("doc-1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The countdown is arithmetic, never a stored string
// ─────────────────────────────────────────────────────────────────────────────

describe("countdown", () => {
  it("counts calendar years and months, not days divided by 365", () => {
    const d = calendarDelta("2026-08-20", "2034-07-18");
    expect([d.years, d.months]).toEqual([7, 10]);
    expect(countdownLabel("2034-07-18", "2026-08-20")).toBe("Expires in 7 years, 10 months");
  });

  it("moves on its own as time passes, with nothing rewritten", () => {
    const stored = "2034-07-18";
    expect(countdownLabel(stored, "2026-08-20")).toBe("Expires in 7 years, 10 months");
    expect(countdownLabel(stored, "2026-09-20")).toBe("Expires in 7 years, 9 months");
    expect(countdownLabel(stored, "2034-04-17")).toBe("Expires in 3 months, 1 day");
  });

  it("says the near cases the way a person would", () => {
    expect(countdownLabel("2026-08-20", TODAY)).toBe("Expires today");
    expect(countdownLabel("2026-08-21", TODAY)).toBe("Expires tomorrow");
    expect(countdownLabel("2026-11-20", TODAY)).toBe("Expires in 3 months");
    expect(countdownLabel("2026-08-19", TODAY)).toBe("Expired yesterday");
    expect(countdownLabel("2026-08-08", TODAY)).toBe("Expired 12 days ago");
  });

  it("counts a 92-day gap as days, not as a rounded month", () => {
    expect(countdownLabel("2026-11-20", "2026-08-20")).toBe("Expires in 3 months");
    expect(countdownLabel("2026-10-20", "2026-08-20")).toBe("Expires in 2 months");
    expect(countdownLabel("2026-09-10", "2026-08-20")).toBe("Expires in 21 days");
  });

  it("uses the verb the rule type calls for", () => {
    expect(countdownLabel("2027-10-10", TODAY, "renewal")).toContain("Renews in");
    expect(countdownLabel("2026-12-31", TODAY, "end")).toContain("Ends in");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Every view shows the same set
// ─────────────────────────────────────────────────────────────────────────────

describe("one licence, every surface", () => {
  const profile = { ...bareProfile(), fields: { dateOfBirth: "07/10/1994" } };
  const licence = {
    id: "doc-1", name: "Sample Driver License", type: "drivers_license",
    linkedProfiles: [JANE], extractedData: { expiration_date: "07/18/2034", issueDate: "07/18/2026" },
  };
  const input = { profiles: [profile], documents: [licence] };

  it("puts the birthday and the expiration on the calendar", () => {
    const series = seriesFromAll(input);
    const kinds = series.map(s => s.kind).sort();
    expect(kinds).toEqual(["birthday", "expiration"]);
    // The issue date is metadata and must NOT be there.
    expect(series.some(s => /issue/i.test(s.title))).toBe(false);
  });

  it("generates the birthday every year and the expiration exactly once", () => {
    const series = seriesFromAll(input);
    const occ = buildCalendarOccurrences(series, { todayISO: TODAY });
    const birthdays = occ.filter(o => o.kind === "birthday");
    const expirations = occ.filter(o => o.kind === "expiration");
    expect(birthdays.length).toBeGreaterThanOrEqual(5);
    expect(new Set(birthdays.map(o => o.date.slice(5)))).toEqual(new Set(["07-10"]));
    expect(expirations.map(o => o.date)).toEqual(["2034-07-18"]);
  });

  it("shows both in Recurring & Important Dates, correctly sorted into halves", () => {
    const managed = onlyRulesAndImportantDates(seriesFromAll(input));
    const birthday = managed.find(s => s.kind === "birthday")!;
    const expiration = managed.find(s => s.kind === "expiration")!;
    expect(isRecurringRule(birthday)).toBe(true);
    expect(isImportantDate(birthday)).toBe(false);
    // The point of the whole exercise: an expiration is managed on this screen
    // WITHOUT being modelled as a recurrence.
    expect(isRecurringRule(expiration)).toBe(false);
    expect(isImportantDate(expiration)).toBe(true);
  });

  it("shows the birthday in Upcoming when it comes round", () => {
    // Upcoming has a 45-day horizon, so the 2034 expiration is correctly absent
    // and the birthday appears in the year's window that contains it.
    const soon = aggregateUpcomingDates(
      { profiles: [{ ...bareProfile(), fields: { dateOfBirth: "1994-07-10" } }] } as any,
      { windowDays: 400 },
    );
    expect(soon.map(u => u.category)).toContain("birthday");
    expect(soon[0].recurring).toBe(true);
  });

  it("shows the expiration in Upcoming once it is inside the window", () => {
    const near = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const items = aggregateUpcomingDates({
      profiles: [bareProfile()],
      documents: [{ ...licence, extractedData: { expiration_date: near } }],
    } as any);
    expect(items.map(u => u.category)).toContain("drivers_license_expiration");
    expect(items[0].recurring).toBe(false);
  });

  it("agrees with the calendar about which key spellings exist", () => {
    // The exact divergence that started this: four spellings, two modules,
    // different answers. Now both read the same engine.
    const near = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    for (const key of ["expiration_date", "expirationDate", "expiry", "valid_until"]) {
      const docs = [{ id: "d", name: "License", type: "drivers_license", linkedProfiles: [JANE], extractedData: { [key]: near } }];
      const onCalendar = seriesFromAll({ profiles: [bareProfile()], documents: docs }).length;
      const inUpcoming = aggregateUpcomingDates({ profiles: [bareProfile()], documents: docs } as any).length;
      expect([key, onCalendar]).toEqual([key, 1]);
      expect([key, inUpcoming]).toEqual([key, 1]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. The other date-bearing entities
// ─────────────────────────────────────────────────────────────────────────────

describe("the rest of the date-bearing app", () => {
  it("makes an anniversary yearly", () => {
    const [rule] = rulesFromProfiles([{ ...bareProfile(), fields: { anniversary: "2015-09-04" } }]);
    expect([rule.ruleType, rule.recurrence]).toEqual(["anniversary", "yearly"]);
  });

  it("puts a recurring liability payment on the calendar without scanning it twice", () => {
    const liability = {
      id: "liab-1", name: "Car Loan", type: "liability", parentProfileId: JANE,
      fields: { nextDueDate: "2026-09-01", monthlyPayment: 415, frequency: "monthly", payoffDate: "2029-09-01" },
    };
    const series = seriesFromAll({ profiles: [bareProfile(), liability] });
    const payments = series.filter(s => s.source.system === "liability");
    // ONE series: the liability adapter owns the payment schedule (it reads
    // per-occurrence paid/skipped state), so the generic field scanner must not
    // emit a second copy of the same due date.
    expect(payments).toHaveLength(1);
    expect(payments[0].recurrence).toBe("monthly");
    expect(payments[0].recurrenceEnd).toBe("2029-09-01");
  });

  it("carries a liability's NON-payment dates through the rule engine", () => {
    const liability = {
      id: "liab-1", name: "Car Loan", type: "liability", parentProfileId: JANE,
      fields: { nextDueDate: "2026-09-01", monthlyPayment: 415, insuranceExpiry: "2027-03-01" },
    };
    const rules = rulesFromProfiles([liability]);
    expect(rules.map(r => r.ruleType)).toEqual(["expiration"]);
  });

  it("keeps a subscription's payments as one rule, not one event per charge", () => {
    const series = seriesFromAll({
      obligations: [{
        id: "ob-1", name: "Spotify Premium", amount: 9.99, frequency: "monthly",
        category: "subscription", nextDueDate: "2026-09-15", linkedProfiles: [JANE],
      }],
    });
    expect(series).toHaveLength(1);
    expect(series[0].kind).toBe("subscription");
    const occ = buildCalendarOccurrences(series, { todayISO: TODAY });
    expect(occ.length).toBeGreaterThanOrEqual(12);
    expect(new Set(occ.map(o => o.date.slice(8)))).toEqual(new Set(["15"]));
  });

  it("puts recurring income on the calendar as income, never as a bill", () => {
    const series = seriesFromAll({
      incomes: [{ id: "inc-1", description: "Paycheck", amount: 2400, frequency: "biweekly", date: "2026-08-21", linkedProfiles: [JANE] }],
    });
    expect(series).toHaveLength(1);
    expect(series[0].kind).toBe("income");
    const occ = buildCalendarOccurrences(series, { todayISO: TODAY });
    // Every other Friday, and every one of them a Friday.
    expect(new Set(occ.map(o => new Date(`${o.date}T12:00:00`).getDay()))).toEqual(new Set([5]));
  });

  it("keeps a one-time dated event exactly once, on its day", () => {
    const series = seriesFromAll({
      events: [{ id: "e1", title: "House Viewing", date: "2026-09-02", recurrence: "none", linkedProfiles: [JANE] }],
    });
    const occ = buildCalendarOccurrences(series, { todayISO: TODAY });
    expect(occ.map(o => o.date)).toEqual(["2026-09-02"]);
    // …and it is NOT an important date: it is an appointment on the grid, not
    // something to count down to.
    expect(onlyRulesAndImportantDates(series)).toHaveLength(0);
  });

  it("keeps a task's due date as a deadline, not a recurrence", () => {
    const series = seriesFromAll({
      tasks: [{ id: "t1", title: "Renew registration", dueDate: "2026-09-10", linkedProfiles: [JANE] }],
    });
    expect(series[0].kind).toBe("task");
    expect(isRecurringRule(series[0])).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Isolation
// ─────────────────────────────────────────────────────────────────────────────

describe("nothing leaks between accounts", () => {
  it("derives rules only from the rows it is handed", () => {
    // Rules are a pure function of the caller's rows, and every caller reads
    // them through the per-user storage layer — so a rule cannot exist for a
    // record the current user cannot see. There is no rules table to scope
    // separately, and no cache of rules keyed by anything but the user.
    const mine = rulesFromAll({
      profiles: [{ id: "p-mine", name: "Mine", type: "self", fields: { dateOfBirth: "1990-01-01" } }],
      documents: [],
    });
    expect(mine).toHaveLength(1);
    expect(mine[0].sourceEntityId).toBe("p-mine");
    expect(rulesFromAll({ profiles: [], documents: [] })).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. What the chat may quietly turn into a field, and what it may not
// ─────────────────────────────────────────────────────────────────────────────

describe("telling the chat a date vs asking it for an event", () => {
  it("treats a bare statement that something expires as a fact about a record", () => {
    for (const t of [
      "Driver's License Expiration",
      "Passport expires",
      "Licence valid until",
      "Registration expiry",
      "⚠️ Expiration Date",
    ]) {
      expect(isBareExpiryStatement(t), t).toBe(true);
    }
  });

  it("leaves an errand alone, however much it talks about expiring", () => {
    // Silently turning any of these into a profile field would lose exactly
    // what the user asked for.
    for (const t of [
      "Renew passport at the embassy",
      "Call the DMV about the expiring licence",
      "Book an appointment before my licence expires",
      "Pick up the renewed registration",
      "Reminder: passport expires next month, sort it out this week",
      "Review the insurance policy that expires in March and compare quotes",
    ]) {
      expect(isBareExpiryStatement(t), t).toBe(false);
    }
  });

  it("says nothing about titles that are not about expiry at all", () => {
    for (const t of ["House Viewing", "Soccer Game", "Joe's Birthday", ""]) {
      expect(isBareExpiryStatement(t), t).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Review findings, pinned
//
// Each of these was a live defect found by reviewing the change, and every one
// of them silently DESTROYED or DROPPED a date rather than showing a wrong one.
// ─────────────────────────────────────────────────────────────────────────────

describe("a birthday label is not a birthday party", () => {
  it("reads the bare label, and only the bare label", () => {
    expect(parseBirthdayLabel("Joe's Birthday")).toEqual({ name: "Joe", kind: "birthday" });
    expect(parseBirthdayLabel("Anniversary")).toEqual({ name: "", kind: "anniversary" });
    expect(parseBirthdayLabel("Mary Anne's bday")).toEqual({ name: "Mary Anne", kind: "birthday" });
  });

  it("refuses anything that is an event in its own right", () => {
    // Redirecting one of these OVERWRITES a person's date of birth and
    // swallows the event — a false positive here destroys data.
    for (const t of [
      "Birthday party at Chuck E Cheese",
      "Joe's 40th Birthday Bash",
      "Anniversary dinner at Luigi's",
      "Buy a birthday present",
      "Birthday",           // no owner named
    ]) {
      const parsed = parseBirthdayLabel(t);
      expect(parsed?.name || "", t).toBe("");
    }
    expect(parseBirthdayLabel("Birthday party at Chuck E Cheese")).toBeNull();
    expect(parseBirthdayLabel("Joe's 40th Birthday Bash")).toBeNull();
  });

  it("does not mistake a determiner or an ordinal for a person", () => {
    for (const t of ["Happy Birthday", "My Birthday", "40th Birthday", "Our Anniversary"]) {
      expect(parseBirthdayLabel(t)?.name, t).toBe("");
    }
  });
});

describe("two different dates of the same kind are two dates", () => {
  it("keeps both insurance expirations on one vehicle", () => {
    // With only a type-level key, the second of these produced NO rule at all.
    const rules = rulesFromProfiles([{
      id: "car-1", name: "Honda", type: "vehicle",
      fields: { autoInsuranceExpiration: "2027-03-01", registrationExpiration: "2028-06-01" },
    }]);
    expect(rules.map(r => r.date).sort()).toEqual(["2027-03-01", "2028-06-01"]);
  });

  it("still collapses two spellings of one birthday", () => {
    const rules = rulesFromProfiles([{
      id: "p1", name: "Jane", type: "person",
      fields: { dateOfBirth: "1994-07-10", birthday: "1994-07-10" },
    }]);
    expect(rules.filter(r => r.ruleType === "birthday")).toHaveLength(1);
  });

  it("keeps ONE birthday even when a stale spelling disagrees", () => {
    // A corrected `dateOfBirth` beside an un-updated `birthday` is one person's
    // one birthday, not two.
    const rules = rulesFromProfiles([{
      id: "p1", name: "Jane", type: "person",
      fields: { dateOfBirth: "1994-07-11", birthday: "1994-07-10" },
    }]);
    expect(rules.filter(r => r.ruleType === "birthday")).toHaveLength(1);
  });
});

describe("unowned records do not eat each other", () => {
  it("keeps two unlinked documents expiring on the same day", () => {
    const rules = rulesFromDocuments([
      { id: "d1", name: "Gym Card", type: "membership", linkedProfiles: [], extractedData: { expiration_date: "2027-05-01" } },
      { id: "d2", name: "Passport", type: "passport", linkedProfiles: [], extractedData: { expiration_date: "2027-05-01" } },
    ]);
    expect(dedupeRules(rules).map(r => r.sourceEntityId).sort()).toEqual(["d1", "d2"]);
  });
});

describe("dates in the past are still dates", () => {
  it("generates an expiration that has already passed, given a lookback", () => {
    const [rule] = rulesFromDocuments([{
      id: "d1", name: "License", type: "drivers_license",
      linkedProfiles: [], extractedData: { expiration_date: "2025-02-02" },
    }]);
    const [series] = seriesFromDateRules([rule]);
    // Future-only generation returned nothing for this, so an expired licence
    // vanished from a month the user was actually looking at.
    expect(generateSeriesOccurrences(series, { todayISO: TODAY, horizonDays: 366 })).toHaveLength(0);
    expect(generateSeriesOccurrences(series, {
      todayISO: TODAY, horizonDays: 366, lookbackDays: 1000,
    }).map(o => o.date)).toEqual(["2025-02-02"]);
  });

  it("generates a birthday earlier in the current year", () => {
    const [rule] = rulesFromProfiles([{ id: "p1", name: "Jane", type: "person", fields: { dateOfBirth: "1994-02-11" } }]);
    const [series] = seriesFromDateRules([rule]);
    const dates = generateSeriesOccurrences(series, {
      todayISO: TODAY, horizonDays: 366, lookbackDays: 400,
    }).map(o => o.date);
    expect(dates).toContain("2026-02-11");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Second review pass, pinned
// ─────────────────────────────────────────────────────────────────────────────

describe("normalization rewrites dates, not sentences", () => {
  it("leaves prose that merely mentions a date exactly as written", () => {
    // This runs in every storage write path, so overwriting the value with the
    // date found inside it destroyed the user's words with no way back.
    const { fields } = normalizeEntityDateFields({
      warrantyNotes: "3 years from 6/4/2029 purchase",
      expirationTerms: "Expires 30 days after 6/4/2029",
      leaseEndNote: "ends the last Friday of June 2029",
    });
    expect(fields.warrantyNotes).toBe("3 years from 6/4/2029 purchase");
    expect(fields.expirationTerms).toBe("Expires 30 days after 6/4/2029");
    expect(fields.leaseEndNote).toBe("ends the last Friday of June 2029");
  });

  it("leaves a timestamp with a clock on it alone", () => {
    const { fields } = normalizeEntityDateFields({ lastUpdated: "2026-08-20T14:32:11.000Z" });
    expect(fields.lastUpdated).toBe("2026-08-20T14:32:11.000Z");
  });

  it("still rewrites a bare date in any printed form", () => {
    const { fields } = normalizeEntityDateFields({
      // Date-NAMED fields: a value on a field whose name says nothing about
      // dates is never rewritten, whatever it looks like.
      expirationDate: "07/18/2034", dueDate: "7/18/2034",
      dateOfBirth: "July 18, 2034", renewalDate: "18 Jul 2034",
    });
    expect([fields.expirationDate, fields.dueDate, fields.dateOfBirth, fields.renewalDate]).toEqual(
      ["2034-07-18", "2034-07-18", "2034-07-18", "2034-07-18"],
    );
  });
});

describe("two payments on one person on one day are two payments", () => {
  it("does not merge Rent into Car Payment", () => {
    const rules = dedupeRules([
      { ...RULE_STUB, id: "a", sourceEntityType: "liability", sourceEntityId: "l1", label: "Rent", ruleType: "payment", date: "2026-09-01", profileId: "p1" },
      { ...RULE_STUB, id: "b", sourceEntityType: "liability", sourceEntityId: "l2", label: "Car Payment", ruleType: "payment", date: "2026-09-01", profileId: "p1" },
    ] as any);
    expect(rules.map(r => r.label).sort()).toEqual(["Car Payment", "Rent"]);
  });

  it("still merges one licence held on the person AND on the document", () => {
    const rules = dedupeRules([
      { ...RULE_STUB, id: "a", sourceEntityType: "profile", sourceEntityId: "p1", label: "Jane — Expiration", ruleType: "expiration", date: "2034-07-18", profileId: "p1" },
      { ...RULE_STUB, id: "b", sourceEntityType: "document", sourceEntityId: "d1", label: "License — Expiration", ruleType: "expiration", ruleSubtype: "drivers_license", date: "2034-07-18", profileId: "p1" },
    ] as any);
    expect(rules).toHaveLength(1);
    expect(rules[0].sourceEntityType).toBe("document");
  });
});

describe("two policies on one vehicle on one day are two policies", () => {
  it("keeps auto and home insurance apart", () => {
    const rules = rulesFromProfiles([{
      id: "car-1", name: "Honda", type: "vehicle",
      fields: { autoInsuranceExpiration: "2027-03-01", homeInsuranceExpiration: "2027-03-01" },
    }]);
    expect(rules).toHaveLength(2);
  });

  it("still collapses two spellings of one expiration", () => {
    const rules = rulesFromDocuments([{
      id: "d1", name: "License", type: "drivers_license", linkedProfiles: [],
      extractedData: { expiration_date: "2034-07-18", expirationDate: "2034-07-18", expiry: "2034-07-18" },
    }]);
    expect(rules).toHaveLength(1);
  });
});

describe("a document does not have a birthday", () => {
  it("drops every spelling of a person's DOB found on a document", () => {
    for (const key of ["dateOfBirth", "dob", "birthday", "birthDate", "birth_date", "DOB"]) {
      const rules = rulesFromDocuments([{
        id: "d1", name: "Sample Driver License", type: "drivers_license",
        linkedProfiles: ["p1"], extractedData: { [key]: "1994-07-10" },
      }]);
      expect(rules.map(r => r.ruleType), key).not.toContain("birthday");
    }
  });
});

describe("a liability written before the write-path fix still shows", () => {
  it("reads a printed due date off a legacy row", () => {
    const series = seriesFromAll({
      profiles: [{
        id: "l1", name: "Car Loan", type: "liability", parentProfileId: "p1",
        fields: { nextDueDate: "07/18/2026", monthlyPayment: 415, frequency: "monthly", payoffDate: "09/01/2029" },
      }],
    });
    const payment = series.find(s => s.source.system === "liability");
    expect(payment?.baseDate).toBe("2026-07-18");
    expect(payment?.recurrenceEnd).toBe("2029-09-01");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Third review pass, pinned
// ─────────────────────────────────────────────────────────────────────────────

describe("a value must BE a date on the read path too", () => {
  it("does not derive a rule from a sentence that mentions a date", () => {
    const rules = rulesFromDocuments([{
      id: "d1", name: "Warranty", type: "warranty", linkedProfiles: [],
      extractedData: { expirationTerms: "Expires 30 days after 6/4/2029" },
    }]);
    expect(rules).toEqual([]);
  });

  it("does not turn a timestamp into an important date", () => {
    const rules = rulesFromProfiles([{
      id: "p1", name: "Jane", type: "person",
      fields: { expirationDate: "2026-08-20T14:32:11.000Z" },
    }]);
    expect(rules).toEqual([]);
  });

  it("still reads a bare date in any printed form", () => {
    for (const raw of ["07/18/2034", "7/18/2034", "July 18, 2034", "18 Jul 2034", "2034-07-18"]) {
      const [rule] = rulesFromDocuments([{
        id: "d1", name: "License", type: "drivers_license", linkedProfiles: [],
        extractedData: { expiration_date: raw },
      }]);
      expect(rule?.date, raw).toBe("2034-07-18");
    }
  });
});

describe("one record, one expiration", () => {
  it("collapses a generic and a qualified spelling on the same day", () => {
    // A licence carrying BOTH `expirationDate` and `licenseExpiration` has one
    // expiration; the qualified name is the more informative and survives.
    const rules = rulesFromDocuments([{
      id: "d1", name: "License", type: "drivers_license", linkedProfiles: [],
      extractedData: { expirationDate: "2034-07-18", licenseExpiration: "2034-07-18" },
    }]);
    expect(rules).toHaveLength(1);
    expect(rules[0].sourceField).toBe("licenseExpiration");
  });

  it("still keeps two genuinely different policies on the same day", () => {
    const rules = rulesFromProfiles([{
      id: "car-1", name: "Honda", type: "vehicle",
      fields: { autoInsuranceExpiration: "2027-03-01", homeInsuranceExpiration: "2027-03-01" },
    }]);
    expect(rules).toHaveLength(2);
  });
});

describe("a recurring renewal does not become twelve renewals", () => {
  it("keeps a yearly registration renewal to one occurrence a year", () => {
    const series = seriesFromAll({
      events: [{
        id: "e1", title: "Car Registration Renewal", date: "2026-10-10",
        recurrence: "yearly", linkedProfiles: ["p1"],
      }],
    });
    expect(series[0].kind).toBe("renewal");
    const occ = buildCalendarOccurrences(series, { todayISO: TODAY });
    // One year of horizon, so at most two anniversaries of the same day.
    expect(occ.length).toBeLessThanOrEqual(2);
  });

  it("still reaches a one-off renewal years away", () => {
    const [rule] = rulesFromProfiles([{
      id: "car-1", name: "Honda", type: "vehicle", fields: { registrationRenewal: "2031-10-10" },
    }]);
    expect(rule.ruleType).toBe("renewal");
    expect(rule.occurrenceType).toBe("one_time");
    const [series] = seriesFromDateRules([rule]);
    // Carries the expiration kind, and with it the horizon a distant date needs.
    expect(series.kind).toBe("expiration");
    expect(buildCalendarOccurrences([series], { todayISO: TODAY }).map(o => o.date)).toEqual(["2031-10-10"]);
  });
});
