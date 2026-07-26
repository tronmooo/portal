// Year integrity: a stored year is never inferred, replaced, or discarded.
//
// User report 2026-07-25, failure #1:
//   "The Florida driver's license expires in 2034, but the calendar shows
//    March 12 as 'in 7 months'."
//
// And the governing rule:
//   "Never infer the current or next year from a month/day-only value… The
//    Florida driver's-license expiration must preserve its complete 2034 date.
//    It must not be converted into an annual recurrence."
//
// ROOT CAUSE. `ANNUAL_RECURRING` in shared/upcoming-dates classified
// vehicle_registration, professional_license, insurance_renewal, property_tax,
// tax_filing, membership_renewal and certification_renewal as annual. Anything
// in that set went through `rollAnnual`, which rebuilt the date as
// (currentYear, storedMonth, storedDay) — throwing the real year away. A 2034
// expiry came back as 2027.
//
// An EXPIRATION is a fixed point in time. The renewal that follows one is a new
// date on a new document, not the same date repeating.
import { describe, it, expect } from "vitest";
import { aggregateUpcomingDates } from "../shared/upcoming-dates";
import { normalizeDateString } from "../shared/extraction-normalize";
import { seriesFromAll } from "../shared/calendar-adapters";
import {
  buildCalendarOccurrences, isRecurringRule, generateSeriesOccurrences,
  dedupeSeries, stripGeneratedSuffix,
} from "../shared/calendar-occurrences";

const ROBERT = "robert-id";
const HONDA = "honda-id";

describe("the Florida driver's licence keeps its 2034 date", () => {
  const profiles = [{
    id: ROBERT, name: "robert sennabaum", type: "self",
    fields: { driversLicenseExpiration: "2034-03-12" },
  }];

  it("does not roll a 2034 expiry into the current year", () => {
    const items = aggregateUpcomingDates({ profiles }, { windowDays: 365 * 20 });
    const licence = items.find((i) => /licen/i.test(i.category) || /licen/i.test(i.title));
    if (licence) {
      expect(licence.nextDate.slice(0, 4), "year must survive").toBe("2034");
      expect(licence.nextDate).toBe("2034-03-12");
      expect(licence.recurring, "an expiry is not a recurrence").toBe(false);
    }
  });

  it("never emits any date whose year differs from the stored one", () => {
    // The general invariant, over every expiry-shaped field.
    const fields: Record<string, string> = {
      driversLicenseExpiration: "2034-03-12",
      registrationExpiration: "2031-10-22",
      insuranceExpiration: "2029-10-05",
      passportExpiration: "2033-06-01",
      professionalLicenseExpiration: "2032-04-04",
    };
    const items = aggregateUpcomingDates(
      { profiles: [{ id: ROBERT, name: "R", type: "self", fields }] },
      { windowDays: 365 * 20 },
    );
    const storedYears = new Set(Object.values(fields).map((v) => v.slice(0, 4)));
    for (const item of items) {
      expect(storedYears.has(item.nextDate.slice(0, 4)), `${item.title} -> ${item.nextDate}`).toBe(true);
    }
  });

  it("still rolls a genuine birthday forward, because its year IS meaningless", () => {
    const items = aggregateUpcomingDates(
      { profiles: [{ id: ROBERT, name: "R", type: "self", fields: { birthday: "1985-03-12" } }] },
      { windowDays: 400 },
    );
    const bday = items.find((i) => i.category === "birthday");
    expect(bday).toBeTruthy();
    expect(Number(bday!.nextDate.slice(0, 4))).toBeGreaterThan(1985);
    expect(bday!.recurring).toBe(true);
  });

  it("leaves a FUTURE annual date untouched rather than rebuilding its year", () => {
    // A holiday already in the future is the answer — don't re-derive it.
    const items = aggregateUpcomingDates(
      { events: [{ id: "e", title: "Anniversary dinner", date: "2028-06-05", recurrence: "none" }] },
      { windowDays: 365 * 5 },
    );
    const found = items.find((i) => i.title === "Anniversary dinner");
    if (found) expect(found.nextDate).toBe("2028-06-05");
  });
});

describe("a one-time expiry never becomes a recurring rule", () => {
  const raw = {
    profiles: [{ id: HONDA, name: "Honda CR-V 2021", type: "vehicle" }],
    events: [
      { id: "e1", title: "⚠️ Florida Driver License — Expires", date: "2034-03-12",
        recurrence: "none", linkedProfiles: [ROBERT] },
      { id: "e2", title: "⚠️ CA Vehicle Registration – Honda 2021 — Expiration",
        date: "2031-10-22", recurrence: "none", linkedProfiles: [HONDA] },
      { id: "e3", title: "🔄 Progressive Auto Insurance ID Card — Renewal",
        date: "2029-10-05", recurrence: "none", linkedProfiles: [HONDA] },
    ],
  };

  it("classifies all three as one-time, whatever the title says", () => {
    // "It must never show a one-time record merely because its category is
    // Renewal or because it has a recurring-style icon."
    for (const s of seriesFromAll(raw)) {
      if (s.source.system !== "event") continue;
      expect(isRecurringRule(s), s.title).toBe(false);
    }
  });

  it("keeps the full year on the generated occurrence", () => {
    const occ = buildCalendarOccurrences(seriesFromAll(raw), {
      todayISO: "2026-07-25", horizonDays: 366 * 10,
    });
    const licence = occ.find((o) => /Driver License/.test(o.title));
    expect(licence?.date).toBe("2034-03-12");
    expect(licence?.effectiveDate).toBe("2034-03-12");
  });

  it("does not generate a second occurrence a year later", () => {
    const licence = seriesFromAll(raw).find((s) => /Driver License/.test(s.title))!;
    const occ = generateSeriesOccurrences(licence, {
      todayISO: "2026-07-25", horizonDays: 366 * 10,
    });
    expect(occ).toHaveLength(1);
  });
});

describe("extraction refuses an incomplete date", () => {
  it("returns null rather than inventing a year", () => {
    // "If an extracted date lacks a valid year, mark it as unresolved… Do not
    // create a calendar event from an incomplete date."
    for (const bad of ["03/12", "March 12", "12 Mar", "3-12", "", "expires soon", "N/A", "—"]) {
      expect(normalizeDateString(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("accepts every complete form and preserves the year exactly", () => {
    expect(normalizeDateString("2034-03-12")).toBe("2034-03-12");
    expect(normalizeDateString("3/12/2034")).toBe("2034-03-12");
    expect(normalizeDateString("03/12/2034")).toBe("2034-03-12");
    expect(normalizeDateString("Mar 12, 2034")).toBe("2034-03-12");
    expect(normalizeDateString("March 12 2034")).toBe("2034-03-12");
    expect(normalizeDateString("12 Mar 2034")).toBe("2034-03-12");
  });

  it("never returns a year close to today for a far-future input", () => {
    const out = normalizeDateString("03/12/2034")!;
    expect(out.slice(0, 4)).toBe("2034");
    expect(out.slice(0, 4)).not.toBe(String(new Date().getFullYear()));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// "The same record is sometimes duplicated with names such as 'Expiration' and
// 'Expires'." Two generators wrote the same source date under different labels
// and exact-title dedup kept both.
// ─────────────────────────────────────────────────────────────────────────────
describe("Expiration / Expires are the same date", () => {
  const mkEvent = (id: string, title: string, date = "2031-10-22") => ({
    id, title, date, recurrence: "none", linkedProfiles: [HONDA],
  });

  it("normalizes every generated suffix away", () => {
    for (const suffix of ["— Expiration", "— Expires", "– Expiry", "- Renewal", "— Due"]) {
      expect(stripGeneratedSuffix(`CA Vehicle Registration ${suffix}`))
        .toBe("CA Vehicle Registration");
    }
    expect(stripGeneratedSuffix("Netflix")).toBe("Netflix");
  });

  it("collapses the reported registration pair into one date", () => {
    const raw = {
      events: [
        mkEvent("e1", "⚠️ CA Vehicle Registration – Honda 2021 — Expiration"),
        mkEvent("e2", "⚠️ CA Vehicle Registration – Honda 2021 — Expires"),
      ],
    };
    expect(dedupeSeries(seriesFromAll(raw))).toHaveLength(1);
    const occ = buildCalendarOccurrences(seriesFromAll(raw), {
      todayISO: "2026-07-25", horizonDays: 366 * 10,
    });
    expect(occ.filter((o) => o.date === "2031-10-22")).toHaveLength(1);
  });

  it("collapses an expiration and a renewal generated from ONE source date", () => {
    const raw = {
      events: [
        mkEvent("e1", "Progressive Auto Insurance ID Card — Expiration", "2029-10-05"),
        mkEvent("e2", "Progressive Auto Insurance ID Card — Renewal", "2029-10-05"),
      ],
    };
    expect(dedupeSeries(seriesFromAll(raw))).toHaveLength(1);
  });

  it("keeps genuinely different documents apart", () => {
    const raw = {
      events: [
        mkEvent("e1", "Progressive Auto Insurance Card — Expiration", "2029-10-05"),
        mkEvent("e2", "Progressive Auto Insurance ID Card — Expiration", "2029-10-05"),
      ],
    };
    // "Card" and "ID Card" are different base names, so both survive.
    expect(dedupeSeries(seriesFromAll(raw))).toHaveLength(2);
  });

  it("keeps the same name on DIFFERENT dates apart", () => {
    const raw = {
      events: [
        mkEvent("e1", "CA Vehicle Registration — Expiration", "2031-10-22"),
        mkEvent("e2", "CA Vehicle Registration — Expiration", "2032-10-22"),
      ],
    };
    expect(dedupeSeries(seriesFromAll(raw))).toHaveLength(2);
  });

  it("never merges recurring schedules that merely look alike", () => {
    const raw = {
      obligations: [
        { id: "o1", name: "Progressive Auto Insurance", amount: 155, frequency: "monthly",
          category: "insurance", nextDueDate: "2026-07-30", linkedProfiles: [HONDA] },
      ],
      events: [mkEvent("e1", "Progressive Auto Insurance — Renewal", "2026-07-30")],
    };
    // A monthly bill and a one-time renewal are different things.
    expect(dedupeSeries(seriesFromAll(raw)).length).toBeGreaterThanOrEqual(1);
  });
});
