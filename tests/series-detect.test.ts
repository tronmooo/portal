// tests/series-detect.test.ts — a schedule written as N rows must read as one.
//
// Reported 2026-08-04: the Recurring Dates screen showed "Tasks 0" for an
// account whose calendar clearly carried "Refill Propranolol prescription
// (100mg) – August". The database explained it: the refill schedule is six
// independent task rows, none carrying a `recur:` tag, so nothing in the app
// could tell they were one monthly series.
//
// The rows below are the REAL production rows, verbatim.
import { describe, it, expect } from "vitest";
import {
  seriesStemOf, stemKey, detectCadence, groupMaterializedSeries,
} from "@shared/series-detect";

const OWNER = "ebfd58a4-b170-49ad-8ccb-c2bc752cd816";
const REFILL_TAGS = ["medication", "prescription", "refill"];

/** The six Propranolol rows, exactly as stored. */
const REFILLS = [
  { id: "r-may", title: "Refill Propranolol prescription (100mg) - May", date: "2026-05-10", ownerId: OWNER, tags: REFILL_TAGS },
  { id: "r-jun", title: "Refill Propranolol prescription (100mg) - June", date: "2026-06-09", ownerId: OWNER, tags: REFILL_TAGS },
  { id: "r-jul", title: "Refill Propranolol prescription (100mg) - July", date: "2026-07-09", ownerId: OWNER, tags: REFILL_TAGS },
  { id: "r-aug", title: "Refill Propranolol prescription (100mg) - August", date: "2026-08-08", ownerId: OWNER, tags: REFILL_TAGS },
  { id: "r-sep", title: "Refill Propranolol prescription (100mg) - September", date: "2026-09-07", ownerId: OWNER, tags: REFILL_TAGS },
  { id: "r-oct", title: "Refill Propranolol prescription (100mg) - October", date: "2026-10-07", ownerId: OWNER, tags: REFILL_TAGS },
];

describe("seriesStemOf", () => {
  it("strips the month qualifier a generator appends", () => {
    expect(seriesStemOf("Refill Propranolol prescription (100mg) - August"))
      .toBe("Refill Propranolol prescription (100mg)");
    expect(seriesStemOf("Rent — Sep 2026")).toBe("Rent");
    expect(seriesStemOf("Water bill (October)")).toBe("Water bill");
  });

  it("strips counters and dates", () => {
    expect(seriesStemOf("Refill #3")).toBe("Refill");
    expect(seriesStemOf("Physio - 2 of 12")).toBe("Physio");
    expect(seriesStemOf("Standup - 2026-08-08")).toBe("Standup");
    expect(seriesStemOf("Chemo — Week 3")).toBe("Chemo");
  });

  it("leaves a real title alone, including a leading month", () => {
    expect(seriesStemOf("August Budget Review")).toBe("August Budget Review");
    expect(seriesStemOf("Call the dentist")).toBe("Call the dentist");
    expect(seriesStemOf("Task 3014")).toBe("Task 3014");
  });

  it("strips only ONE qualifier, so a real title is not eaten", () => {
    expect(seriesStemOf("Invoice 3 of 6 - August")).toBe("Invoice 3 of 6");
  });

  it("stemKey ignores dash style and casing", () => {
    expect(stemKey("Refill Propranolol (100mg) - August"))
      .toBe(stemKey("refill propranolol (100mg) — September"));
  });
});

describe("detectCadence", () => {
  it("names the real refill spacing as monthly", () => {
    expect(detectCadence(REFILLS.map(r => r.date))).toBe("monthly");
  });

  it("names the common cadences", () => {
    expect(detectCadence(["2026-08-03", "2026-08-10", "2026-08-17"])).toBe("weekly");
    expect(detectCadence(["2026-08-03", "2026-08-17", "2026-08-31"])).toBe("biweekly");
    expect(detectCadence(["2026-01-01", "2026-04-01", "2026-07-01"])).toBe("quarterly");
    expect(detectCadence(["2024-02-11", "2025-02-11", "2026-02-11"])).toBe("yearly");
  });

  it("refuses a pile of dates that is not a schedule", () => {
    // The seeded rows: thousands of tasks sharing ONE due date.
    expect(detectCadence(["2026-02-23", "2026-02-23", "2026-02-23"])).toBeNull();
    // Irregular scatter.
    expect(detectCadence(["2026-01-01", "2026-01-03", "2026-04-19"])).toBeNull();
    expect(detectCadence(["2026-01-01"])).toBeNull();
  });
});

describe("groupMaterializedSeries", () => {
  it("groups the six real refill rows into ONE monthly series", () => {
    const groups = groupMaterializedSeries(REFILLS);
    expect(groups).toHaveLength(1);
    expect(groups[0].recurrence).toBe("monthly");
    expect(groups[0].stem).toBe("Refill Propranolol prescription (100mg)");
    expect(groups[0].rows.map(r => r.id)).toEqual(
      ["r-may", "r-jun", "r-jul", "r-aug", "r-sep", "r-oct"]); // ascending
  });

  // The account this was reported on holds 3,481 open tasks, almost all seeded
  // as "Task NNNN" due 2026-02-23. Collapsing those would hide thousands of
  // rows behind one fake series — far worse than the bug being fixed.
  it("never groups bulk-seeded rows that merely share a due date", () => {
    const seeded = Array.from({ length: 40 }, (_, i) => ({
      id: `t${i}`, title: `Task ${1000 + i}`, date: "2026-02-23", ownerId: OWNER, tags: [] as string[],
    }));
    expect(groupMaterializedSeries(seeded)).toEqual([]);
  });

  it("does not group across owners or across different tag sets", () => {
    const otherOwner = REFILLS.map(r => ({ ...r, id: `${r.id}-x`, ownerId: "someone-else" }));
    // Same stem and cadence, but two owners → two groups, never one.
    expect(groupMaterializedSeries([...REFILLS, ...otherOwner])).toHaveLength(2);

    const retagged = REFILLS.map(r => ({ ...r, id: `${r.id}-y`, tags: ["other"] }));
    expect(groupMaterializedSeries([...REFILLS, ...retagged])).toHaveLength(2);
  });

  it("needs at least three rows before believing in a series", () => {
    expect(groupMaterializedSeries(REFILLS.slice(0, 2))).toEqual([]);
    expect(groupMaterializedSeries(REFILLS.slice(0, 3))).toHaveLength(1);
  });

  it("ignores rows with no usable date", () => {
    const dateless = [
      { id: "a", title: "Refill X", date: null, ownerId: OWNER, tags: [] },
      { id: "b", title: "Refill X", date: "", ownerId: OWNER, tags: [] },
      { id: "c", title: "Refill X", date: "nonsense", ownerId: OWNER, tags: [] },
    ];
    expect(groupMaterializedSeries(dateless as any)).toEqual([]);
  });

  it("leaves unrelated one-off tasks ungrouped", () => {
    const oneOffs = [
      { id: "1", title: "Call the dentist", date: "2026-08-04", ownerId: OWNER, tags: [] },
      { id: "2", title: "Renew passport", date: "2026-08-15", ownerId: OWNER, tags: [] },
      { id: "3", title: "Oil change", date: "2026-09-01", ownerId: OWNER, tags: [] },
    ];
    expect(groupMaterializedSeries(oneOffs)).toEqual([]);
  });
});
