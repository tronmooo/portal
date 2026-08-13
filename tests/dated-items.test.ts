// tests/dated-items.test.ts — one windowed roll-up, so counters cannot disagree.
//
// Reported 2026-08-04: the Recurring Dates chips, the Calendar tiles and the
// Executive Dashboard each answered "how many?" from a different dataset, and a
// card read 0 while dated items plainly existed. `rollupOccurrences` is the one
// function all three now read, over the engine's deduplicated stream.
import { describe, it, expect } from "vitest";
import {
  rollupOccurrences, bucketsForKind, bucketsForKinds, breakdownLabel,
  timelineItemToOccurrence,
} from "@shared/dated-items";
import type { CalendarOccurrence, OccurrenceKind, OccurrenceStatus } from "@shared/calendar-occurrences";

const TODAY = "2026-08-04";

function occ(
  kind: OccurrenceKind,
  date: string,
  status: OccurrenceStatus = "upcoming",
  id = `${kind}-${date}-${Math.random()}`,
): CalendarOccurrence {
  return {
    id, seriesId: id, identityKey: id, kind, title: `${kind} ${date}`,
    source: { system: "event", id, href: "/calendar" } as any,
    date, effectiveDate: date, moved: false, status,
    series: {} as any,
  };
}

describe("rollupOccurrences", () => {
  it("buckets a mixed stream by urgency, each occurrence once per bucket", () => {
    const r = rollupOccurrences([
      occ("task", "2026-07-20", "overdue"),      // overdue
      occ("task", TODAY, "today"),               // today
      occ("event", "2026-08-06"),                // within 7
      occ("bill", "2026-08-25"),                 // within 30
      occ("birthday", "2027-02-11"),             // beyond the horizon
    ], TODAY);

    expect(r.overdue).toBe(1);
    expect(r.today).toBe(1);
    expect(r.next7).toBe(2);   // today + Aug 6
    expect(r.next30).toBe(3);  // today + Aug 6 + Aug 25
    expect(r.attention).toBe(4);
    expect(r.total).toBe(5);   // the far birthday is real, just not urgent
  });

  it("windows rather than totals — the 3,481 seed tasks cannot drown the card", () => {
    // Every seeded row is due 2026-02-23, long past. They are overdue, but the
    // point is that `next30`/`today` stay truthful and small.
    const seeded = Array.from({ length: 3481 }, (_, i) => occ("task", "2026-02-23", "overdue", `seed-${i}`));
    const real = [occ("task", TODAY, "today"), occ("task", "2026-08-08")];
    const r = rollupOccurrences([...seeded, ...real], TODAY);

    expect(r.today).toBe(1);
    expect(r.next30).toBe(2);
    expect(r.overdue).toBe(3481);
    expect(r.total).toBe(3483);
  });

  it("ignores settled occurrences — done and skipped need nothing", () => {
    const r = rollupOccurrences([
      occ("task", TODAY, "done"),
      occ("task", TODAY, "skipped"),
      occ("task", "2026-07-01", "done"),
    ], TODAY);
    expect(r.attention).toBe(0);
    expect(r.today).toBe(0);
    expect(r.overdue).toBe(0);
    expect(r.total).toBe(3);
  });

  it("counts the effective date when an occurrence was moved", () => {
    const moved = { ...occ("event", "2026-09-30"), effectiveDate: TODAY, moved: true };
    expect(rollupOccurrences([moved], TODAY).today).toBe(1);
  });

  it("is inclusive at both window edges", () => {
    const r = rollupOccurrences([
      occ("event", "2026-08-11"), // today + 7
      occ("event", "2026-08-12"), // today + 8
      occ("event", "2026-09-03"), // today + 30
      occ("event", "2026-09-04"), // today + 31
    ], TODAY);
    expect(r.next7).toBe(1);
    expect(r.next30).toBe(3);
  });

  it("skips malformed dates instead of counting them somewhere wrong", () => {
    const r = rollupOccurrences([
      { ...occ("task", TODAY), date: "", effectiveDate: "" },
      { ...occ("task", TODAY), date: "nonsense", effectiveDate: "nonsense" },
    ] as any, TODAY);
    expect(r.attention).toBe(0);
    expect(r.total).toBe(2);
  });

  it("tolerates an empty or absent stream", () => {
    for (const input of [[], null, undefined]) {
      const r = rollupOccurrences(input as any, TODAY);
      expect(r.total).toBe(0);
      expect(r.attention).toBe(0);
    }
  });

  it("the kind buckets sum to the overall buckets", () => {
    const list = [
      occ("task", "2026-07-20", "overdue"), occ("task", TODAY, "today"),
      occ("event", "2026-08-06"), occ("bill", "2026-08-25"), occ("reminder", TODAY, "today"),
    ];
    const r = rollupOccurrences(list, TODAY);
    const summed = bucketsForKinds(r, Object.keys(r.byKind) as OccurrenceKind[]);
    expect(summed.overdue).toBe(r.overdue);
    expect(summed.today).toBe(r.today);
    expect(summed.next7).toBe(r.next7);
    expect(summed.next30).toBe(r.next30);
  });
});

describe("bucketsForKind / bucketsForKinds", () => {
  it("returns zeros for a kind with nothing, never undefined", () => {
    const r = rollupOccurrences([occ("task", TODAY, "today")], TODAY);
    expect(bucketsForKind(r, "liability")).toEqual({
      overdue: 0, today: 0, next7: 0, next30: 0, attention: 0,
    });
  });

  it("sums the kinds one card covers (tasks + habits share a chip)", () => {
    const r = rollupOccurrences([
      occ("task", TODAY, "today"), occ("habit", TODAY, "today"), occ("event", TODAY, "today"),
    ], TODAY);
    expect(bucketsForKinds(r, ["task", "habit"]).today).toBe(2);
  });
});

describe("breakdownLabel", () => {
  it("reads the way the report asked for it", () => {
    // "Tasks (4) — Today: 1, Upcoming: 2, Overdue: 1"
    const b = { overdue: 1, today: 1, next7: 3, next30: 3, attention: 4 };
    expect(breakdownLabel(b)).toBe("Overdue 1 · Today 1 · Upcoming 2");
  });

  it("omits empty buckets rather than printing zeros", () => {
    expect(breakdownLabel({ overdue: 0, today: 2, next7: 2, next30: 2, attention: 2 })).toBe("Today 2");
    expect(breakdownLabel({ overdue: 0, today: 0, next7: 0, next30: 0, attention: 0 })).toBe("");
  });
});

// ── A completed task must not keep reporting as overdue ──────────────────────
//
// Reported 2026-08-13: the Executive tab's Tasks tile read "1 needs action ·
// Overdue 1" while the header's Tasks Due chip and the Attention tile both read
// 0 — for a single task the user had already completed.
//
// The row was UNDATED. The Supabase timeline parked undated tasks on their
// CREATED date so "every task appears on the calendar", and set the
// per-occurrence `completed` flag by comparing that date against the task's due
// date — which is null on an undated task, so the flag was false forever.
// Anything reading only that flag therefore counted a done task as overdue,
// while /api/tasks-based surfaces (shared/attention: "undated tasks are a
// backlog, not an alert") skipped it entirely.
//
// Two guarantees now. The builder no longer puts an undated task on the
// calendar at all (server/supabase-storage.ts, matching MemStorage), and this
// mapper settles an item on the SOURCE ROW's status as well as the flag, so a
// stale or wrong `completed` can't resurrect the phantom.
describe("timelineItemToOccurrence", () => {
  it("settles an item whose source row is done, even when `completed` is false", () => {
    const occurrence = timelineItemToOccurrence({
      type: "task", date: "2026-08-09", completed: false, meta: { status: "done" },
    });
    expect(occurrence.status).toBe("done");
    expect(rollupOccurrences([occurrence], TODAY).overdue).toBe(0);
  });

  it("still counts a genuinely open past-dated task as overdue", () => {
    const occurrence = timelineItemToOccurrence({
      type: "task", date: "2026-07-20", completed: false, meta: { status: "todo" },
    });
    expect(rollupOccurrences([occurrence], TODAY).overdue).toBe(1);
  });

  it("honours the per-occurrence flag on rows that carry no meta.status", () => {
    expect(timelineItemToOccurrence({ type: "event", date: TODAY, completed: true }).status).toBe("done");
    expect(timelineItemToOccurrence({ type: "event", date: TODAY }).status).toBe("upcoming");
  });

  it("treats a skipped or paid occurrence as settled too", () => {
    expect(timelineItemToOccurrence({ type: "task", date: TODAY, meta: { status: "skipped" } }).status).toBe("skipped");
    expect(timelineItemToOccurrence({ type: "obligation", date: TODAY, meta: { status: "paid" } }).status).toBe("done");
    expect(rollupOccurrences([
      timelineItemToOccurrence({ type: "obligation", date: "2026-07-01", meta: { status: "paid" } }),
    ], TODAY).overdue).toBe(0);
  });

  it("defaults a typeless row to an event, the way the tiles always read it", () => {
    expect(timelineItemToOccurrence({ date: TODAY }).kind).toBe("event");
  });
});
