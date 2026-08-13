// tests/task-overdue-indicator.test.ts
//
// Reported 2026-08-13, with a screenshot of one dashboard contradicting itself:
//
//   TASKS      1 needs action   ·  Overdue 1
//   ATTENTION  0                ·  "Nothing is overdue"
//   TODAY      100% done        ·  "1 of 1 tasks & habits"
//
// The account's only task had been created and completed the same minute. The
// Attention and Today tiles read the task ROWS and were right; the Tasks tile
// reads the calendar timeline (shared/dated-items buckets whatever the calendar
// draws) and was wrong, because the timeline never marked that row complete.
//
// Two defects, both in how a task becomes a timeline row:
//
//   1. The Supabase timeline gave a task with NO due date an occurrence on its
//      `createdAt` date — a creation timestamp, not a deadline, recorded in UTC.
//      Every dated counter then read it as due that day, and OVERDUE from the
//      next midnight on. MemStorage never did this, so the two storages
//      disagreed about the same account.
//   2. `completed` was computed as `status === "done" && date === dueDate`.
//      With no due date that comparison is `date === ""` — false forever — so
//      completing the task could not clear it.
//
// The rule now lives in shared/task-occurrences and both storages call it.
import { describe, it, expect } from "vitest";
import { MemStorage, requestStorageContext } from "../server/storage";
import { isTaskOccurrenceDone, taskOccurrenceDates } from "@shared/task-occurrences";
import { rollupOccurrences, bucketsForKinds } from "@shared/dated-items";
import type { CalendarOccurrence } from "@shared/calendar-occurrences";

const TODAY = "2026-08-13";
const YESTERDAY = "2026-08-12";

const run = <T>(storage: MemStorage, fn: () => Promise<T>) => requestStorageContext.run(storage, fn);

/**
 * Exactly what ExecutiveBriefing does with `/api/calendar/timeline` before
 * handing it to the shared roll-up — the tile's own arithmetic, nothing more.
 */
function tileBuckets(timeline: any[], todayISO: string) {
  const rows = timeline.map((item: any) => ({
    kind: (item?.type || "event"),
    date: String(item?.date || "").slice(0, 10),
    effectiveDate: String(item?.date || "").slice(0, 10),
    status: item?.completed ? "done" : "upcoming",
  })) as unknown as CalendarOccurrence[];
  return bucketsForKinds(rollupOccurrences(rows, todayISO), ["task", "habit"]);
}

describe("a completed task is complete on the timeline too", () => {
  it("marks the stored occurrence of a dated task done", () => {
    const task = { dueDate: YESTERDAY, status: "done", tags: [] };
    expect(isTaskOccurrenceDone(task, YESTERDAY)).toBe(true);
  });

  it("marks an UNDATED task done wherever it was anchored — the reported bug", () => {
    // `d === dueDate` was `d === ""` here, so the tile counted a finished task.
    expect(isTaskOccurrenceDone({ status: "done", tags: [] }, TODAY)).toBe(true);
    expect(isTaskOccurrenceDone({ dueDate: null, status: "done" }, YESTERDAY)).toBe(true);
  });

  it("leaves an open task open", () => {
    expect(isTaskOccurrenceDone({ dueDate: YESTERDAY, status: "todo" }, YESTERDAY)).toBe(false);
    expect(isTaskOccurrenceDone({ status: "in_progress" }, TODAY)).toBe(false);
  });

  it("still treats a projected future occurrence of a recurring task as to-do", () => {
    // A recurring task advances its due date when checked off, so only the
    // stored date can be the completed one.
    const task = { dueDate: YESTERDAY, status: "done", tags: ["recur:weekly"] };
    expect(isTaskOccurrenceDone(task, YESTERDAY)).toBe(true);
    expect(isTaskOccurrenceDone(task, "2026-08-19")).toBe(false);
  });
});

describe("an undated task is not a dated item", () => {
  it("generates no calendar occurrence at all", () => {
    expect(taskOccurrenceDates({ status: "todo", tags: [] }, "2026-08-01", "2026-09-30")).toEqual([]);
  });

  it("keeps an undated task off the timeline instead of parking it on today", async () => {
    const storage = new MemStorage();
    await run(storage, () => storage.createTask({ title: "Someday: fix the gate", priority: "medium" } as any));
    const items = await run(storage, () => storage.getCalendarTimeline("2026-01-01", "2027-12-31"));
    expect(items.filter(i => i.title === "Someday: fix the gate")).toEqual([]);
  });
});

describe("the Tasks tile agrees with the Attention tile", () => {
  it("reports nothing overdue once the only task is complete", async () => {
    const storage = new MemStorage();
    const task = await run(storage, () =>
      storage.createTask({ title: "delete-test-task", priority: "medium", dueDate: YESTERDAY } as any));

    // Before completion the tile is right to flag it.
    const before = await run(storage, () => storage.getCalendarTimeline("2026-07-01", "2026-09-30"));
    expect(tileBuckets(before, TODAY).overdue).toBe(1);

    await run(storage, () => storage.updateTask(task.id, { status: "done" } as any));

    const after = await run(storage, () => storage.getCalendarTimeline("2026-07-01", "2026-09-30"));
    const buckets = tileBuckets(after, TODAY);
    // The screenshot said "1 needs action · Overdue 1" at this point.
    expect(buckets.overdue).toBe(0);
    expect(buckets.attention).toBe(0);
  });
});
