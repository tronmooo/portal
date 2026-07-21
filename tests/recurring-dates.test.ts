// Pins shared/recurring-dates — the Recurring Dates engine. The critical
// contract: checking off ONE occurrence never completes/deletes the series;
// the next occurrence rolls forward automatically.
import { describe, it, expect } from "vitest";
import {
  parseRecurringMeta, metaToTags, markOccurrence, setSeriesFlag,
  pruneOccurrenceTags, expandRecurrenceDates, nextOccurrence,
  occurrenceStatus, seriesStatus, missedOccurrences, humanRecurrenceLabel,
  addDaysISO, RD_TAG,
} from "../shared/recurring-dates";

const TODAY = "2026-07-21";

describe("tag round-trip", () => {
  it("parses and re-serializes rd tags, preserving foreign tags", () => {
    const tags = ["important", RD_TAG, "rd:kind:anniversary", "rd:remind:7", "rd:require", "rd:done:2026-07-20"];
    const meta = parseRecurringMeta(tags);
    expect(meta.isRecurringDate).toBe(true);
    expect(meta.kind).toBe("anniversary");
    expect(meta.remindDays).toBe(7);
    expect(meta.requireComplete).toBe(true);
    expect(meta.completedDates).toEqual(["2026-07-20"]);
    const out = metaToTags(meta, tags);
    expect(out).toContain("important");
    expect(out).toContain("rd:kind:anniversary");
    expect(out).toContain("rd:done:2026-07-20");
  });

  it("ignores malformed rd tags", () => {
    const meta = parseRecurringMeta(["rd:done:not-a-date", "rd:remind:x", "rd:kind:alien"]);
    expect(meta.completedDates).toEqual([]);
    expect(meta.remindDays).toBeNull();
    expect(meta.kind).toBeNull();
  });
});

describe("expandRecurrenceDates", () => {
  it("expands yearly including the base date", () => {
    const dates = expandRecurrenceDates("2024-07-21", "yearly", { windowStart: "2024-01-01", windowEnd: "2027-12-31" });
    expect(dates).toEqual(["2024-07-21", "2025-07-21", "2026-07-21", "2027-07-21"]);
  });
  it("expands monthly and respects recurrenceEnd", () => {
    const dates = expandRecurrenceDates("2026-01-15", "monthly", { recurrenceEnd: "2026-04-30", windowStart: "2026-01-01", windowEnd: "2026-12-31" });
    expect(dates).toEqual(["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15"]);
  });
  it("returns only the base for non-recurring", () => {
    expect(expandRecurrenceDates("2026-07-25", "none", { windowStart: TODAY, windowEnd: "2026-12-31" })).toEqual(["2026-07-25"]);
  });
});

describe("per-occurrence check-off (the core contract)", () => {
  const anniversary = { date: "2020-07-25", recurrence: "yearly", tags: [RD_TAG, "rd:kind:anniversary"] };

  it("checking off this year's occurrence keeps next year's active", () => {
    expect(nextOccurrence(anniversary, TODAY)).toBe("2026-07-25");
    const tags = markOccurrence(anniversary.tags, "2026-07-25", "done");
    const after = { ...anniversary, tags };
    expect(nextOccurrence(after, TODAY)).toBe("2027-07-25"); // series stays live
    expect(occurrenceStatus(parseRecurringMeta(tags), "2026-07-25", TODAY)).toBe("done");
    expect(seriesStatus(after, TODAY)).toBe("upcoming"); // NOT completed
  });

  it("skipping one occurrence also rolls to the next", () => {
    const tags = markOccurrence(anniversary.tags, "2026-07-25", "skip");
    expect(nextOccurrence({ ...anniversary, tags }, TODAY)).toBe("2027-07-25");
    expect(occurrenceStatus(parseRecurringMeta(tags), "2026-07-25", TODAY)).toBe("skipped");
  });

  it("clearing a mark restores the occurrence", () => {
    let tags = markOccurrence(anniversary.tags, "2026-07-25", "done");
    tags = markOccurrence(tags, "2026-07-25", "clear");
    expect(nextOccurrence({ ...anniversary, tags }, TODAY)).toBe("2026-07-25");
  });

  it("works the same for monthly bills", () => {
    const bill = { date: "2026-01-01", recurrence: "monthly", tags: [RD_TAG, "rd:kind:bill"] };
    expect(nextOccurrence(bill, TODAY)).toBe("2026-08-01");
    const tags = markOccurrence(bill.tags, "2026-08-01", "done");
    expect(nextOccurrence({ ...bill, tags }, TODAY)).toBe("2026-09-01");
  });
});

describe("series flags and status buckets", () => {
  const base = { date: "2026-01-01", recurrence: "monthly", tags: [RD_TAG] };

  it("paused series has no next occurrence and reports paused", () => {
    const tags = setSeriesFlag(base.tags, "paused", true);
    expect(nextOccurrence({ ...base, tags }, TODAY)).toBeNull();
    expect(seriesStatus({ ...base, tags }, TODAY)).toBe("paused");
    const resumed = setSeriesFlag(tags, "paused", false);
    expect(nextOccurrence({ ...base, tags: resumed }, TODAY)).toBe("2026-08-01");
  });

  it("archived wins over everything", () => {
    const tags = setSeriesFlag(setSeriesFlag(base.tags, "paused", true), "archived", true);
    expect(seriesStatus({ ...base, tags }, TODAY)).toBe("archived");
  });

  it("ended series reports completed", () => {
    const ev = { date: "2026-01-01", recurrence: "monthly", recurrenceEnd: "2026-06-30", tags: [RD_TAG] };
    expect(seriesStatus(ev, TODAY)).toBe("completed");
  });

  it("requireComplete turns a missed occurrence into overdue", () => {
    const ev = { date: "2026-07-01", recurrence: "monthly", tags: [RD_TAG, "rd:require"] };
    expect(seriesStatus(ev, TODAY)).toBe("overdue");
    expect(missedOccurrences(ev, TODAY)).toEqual(["2026-07-01"]);
    const done = { ...ev, tags: markOccurrence(ev.tags, "2026-07-01", "done") };
    expect(seriesStatus(done, TODAY)).toBe("upcoming");
    expect(missedOccurrences(done, TODAY)).toEqual([]);
  });

  it("without requireComplete a missed occurrence is just past", () => {
    const ev = { date: "2026-07-01", recurrence: "monthly", tags: [RD_TAG] };
    expect(seriesStatus(ev, TODAY)).toBe("upcoming");
    expect(occurrenceStatus(parseRecurringMeta(ev.tags), "2026-07-01", TODAY)).toBe("past");
  });
});

describe("pruning", () => {
  it("drops marks older than the keep window, keeps recent ones", () => {
    const old = addDaysISO(TODAY, -500);
    const recent = addDaysISO(TODAY, -10);
    let tags = markOccurrence([RD_TAG], old, "done");
    tags = markOccurrence(tags, recent, "done");
    const pruned = pruneOccurrenceTags(tags, TODAY);
    expect(pruned).toContain(`rd:done:${recent}`);
    expect(pruned).not.toContain(`rd:done:${old}`);
  });
});

describe("labels", () => {
  it("humanizes recurrence patterns", () => {
    expect(humanRecurrenceLabel("yearly", "2026-07-25")).toContain("Every year on Jul 25");
    expect(humanRecurrenceLabel("monthly", "2026-07-15")).toContain("day 15");
    expect(humanRecurrenceLabel("weekly", "2026-07-20")).toContain("Monday");
    expect(humanRecurrenceLabel("none")).toBe("Does not repeat");
  });
});
