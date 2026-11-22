// tests/recurring-occurrence-actions.test.ts
//
// One occurrence at a time: skip, change date, restore — and the series keeps
// its schedule. Owner request 2026-11-21 ("Mow the Lawn"):
//
//   Skip:        December 15 is recorded as skipped. January 15 stays scheduled.
//   Change date: move December's mowing to December 18 without changing
//                future months.
//   Skipping must never delete the series.
//
// Three layers: the pure rule (shared/recurrence), what the calendar and the
// History tab read from it (shared/calendar-adapters, shared/task-occurrences,
// shared/occurrence-history), and the REAL routes (tests/helpers/route-harness).

import { describe, it, expect, afterEach } from "vitest";
import {
  applyTaskOccurrenceAction, applyTaskSchedule, nextRecurringTaskSpawn,
  parseRecurrence, rollForwardRecurringTask, userTags,
} from "../shared/recurrence";
import { taskOccurrenceDates } from "../shared/task-occurrences";
import { seriesFromTasks } from "../shared/calendar-adapters";
import { generateSeriesOccurrences } from "../shared/calendar-occurrences";
import { can, occurrenceMenuFor, editsInPlace } from "../shared/calendar-capabilities";
import { seriesHistory, completionStats } from "../shared/occurrence-history";
import {
  applySeriesSettings, parseRecurringMeta, nthOccurrenceDate, markOccurrence,
} from "../shared/recurring-dates";
import { startHarness, type Harness } from "./helpers/route-harness";

const TODAY = "2026-11-21";
const mow = (over: Record<string, any> = {}) => ({
  id: "t-mow", title: "Mow the Lawn", status: "todo", priority: "medium",
  dueDate: "2026-12-15", tags: ["recur:monthly", "ranchor:15", "home"], linkedProfiles: [], ...over,
});
const must = (r: ReturnType<typeof applyTaskOccurrenceAction>) => {
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe("skipping one occurrence of a recurring task", () => {
  it("records December 15 as skipped and leaves January 15 as the open occurrence", () => {
    const r = must(applyTaskOccurrenceAction(mow(), { action: "skip", date: "2026-12-15" }, TODAY));
    expect(r.dueDate).toBe("2027-01-15");
    const rule = parseRecurrence(r.tags);
    expect(rule.skipped).toEqual(["2026-12-15"]);
    // The schedule itself is untouched, and so are the user's own tags.
    expect(rule.freq).toBe("monthly");
    expect(rule.anchorDay).toBe(15);
    expect(userTags(r.tags)).toEqual(["home"]);
    expect(r.ended).toBeUndefined();
  });

  it("skips a LATER occurrence ahead of time without moving the open one", () => {
    const r = must(applyTaskOccurrenceAction(mow(), { action: "skip", date: "2027-02-15" }, TODAY));
    expect(r.dueDate).toBe("2026-12-15");
    // Completing December and then January steps OVER the skipped February.
    const jan = nextRecurringTaskSpawn({ dueDate: r.dueDate, tags: r.tags }, TODAY)!;
    expect(jan.dueDate).toBe("2027-01-15");
    const mar = nextRecurringTaskSpawn({ dueDate: jan.dueDate, tags: jan.tags }, "2027-01-15")!;
    expect(mar.dueDate).toBe("2027-03-15");
  });

  it("keeps the calendar on schedule: the skipped date is gone, the rest stay", () => {
    const r = must(applyTaskOccurrenceAction(mow(), { action: "skip", date: "2027-01-15" }, TODAY));
    const dates = taskOccurrenceDates({ dueDate: r.dueDate, tags: r.tags, status: "todo" }, "2026-12-01", "2027-04-30");
    expect(dates).toEqual(["2026-12-15", "2027-02-15", "2027-03-15", "2027-04-15"]);
  });

  it("the daily rollover never lands on a skipped occurrence", () => {
    const weekly = { dueDate: "2026-11-02", status: "todo", tags: ["recur:weekly", "rskip:2026-11-16"] };
    const roll = rollForwardRecurringTask(weekly, "2026-11-18");
    // Nov 16 is the latest occurrence on or before today, but it was skipped.
    expect(roll).toMatchObject({ dueDate: "2026-11-23" });
  });

  it("bringing a skipped date back makes it the open occurrence again", () => {
    const skipped = must(applyTaskOccurrenceAction(mow(), { action: "skip", date: "2026-12-15" }, TODAY));
    const back = must(applyTaskOccurrenceAction(
      { dueDate: skipped.dueDate, tags: skipped.tags, status: "todo" },
      { action: "unskip", date: "2026-12-15" }, TODAY,
    ));
    expect(back.dueDate).toBe("2026-12-15");
    expect(parseRecurrence(back.tags).skipped).toBeUndefined();
  });

  it("refuses a task that does not repeat, and an occurrence already behind the series", () => {
    expect(applyTaskOccurrenceAction(mow({ tags: [] }), { action: "skip", date: "2026-12-15" }, TODAY))
      .toMatchObject({ ok: false });
    expect(applyTaskOccurrenceAction(mow(), { action: "skip", date: "2026-11-15" }, TODAY))
      .toMatchObject({ ok: false });
  });
});

describe("changing the date of one occurrence", () => {
  it("moves December to the 18th and leaves January on the 15th", () => {
    const r = must(applyTaskOccurrenceAction(mow(), { action: "move", date: "2026-12-15", newDate: "2026-12-18" }, TODAY));
    expect(r.dueDate).toBe("2026-12-18");
    const rule = parseRecurrence(r.tags);
    expect(rule.movedFrom).toBe("2026-12-15");
    expect(rule.anchorDay).toBe(15);
    // Completing the moved occurrence steps from where it BELONGS, not from
    // the 18th — the bug a plain due-date edit would cause.
    const next = nextRecurringTaskSpawn({ dueDate: r.dueDate, tags: r.tags }, "2026-12-18")!;
    expect(next.dueDate).toBe("2027-01-15");
    expect(parseRecurrence(next.tags).movedFrom).toBeUndefined();
  });

  it("a weekly chore moved by two days is back on its weekday next week", () => {
    const weekly = { dueDate: "2026-11-23", status: "todo", tags: ["recur:weekly"] }; // a Monday
    const r = must(applyTaskOccurrenceAction(weekly, { action: "move", date: "2026-11-23", newDate: "2026-11-25" }, TODAY));
    expect(nextRecurringTaskSpawn({ dueDate: r.dueDate, tags: r.tags }, "2026-11-25")!.dueDate).toBe("2026-11-30");
    // And the calendar shows Wednesday this week, Monday every week after.
    expect(taskOccurrenceDates({ dueDate: r.dueDate, tags: r.tags, status: "todo" }, "2026-11-22", "2026-12-08"))
      .toEqual(["2026-11-25", "2026-11-30", "2026-12-07"]);
  });

  it("moves a FUTURE occurrence; the series lands on the new day when it gets there", () => {
    const r = must(applyTaskOccurrenceAction(mow(), { action: "move", date: "2027-01-15", newDate: "2027-01-20" }, TODAY));
    expect(r.dueDate).toBe("2026-12-15");
    const jan = nextRecurringTaskSpawn({ dueDate: r.dueDate, tags: r.tags }, "2026-12-15")!;
    expect(jan.dueDate).toBe("2027-01-20");
    expect(nextRecurringTaskSpawn({ dueDate: jan.dueDate, tags: jan.tags }, "2027-01-20")!.dueDate).toBe("2027-02-15");
  });

  it("the rollover leaves a moved, still-open occurrence where the user put it", () => {
    const r = must(applyTaskOccurrenceAction(mow(), { action: "move", date: "2026-12-15", newDate: "2026-12-18" }, TODAY));
    expect(rollForwardRecurringTask({ dueDate: r.dueDate, tags: r.tags, status: "todo" }, "2026-12-20")).toBeNull();
  });
});

describe("ending and re-scheduling", () => {
  it("'end series' stops it the day before, keeping the rule and the user's tags", () => {
    const r = must(applyTaskOccurrenceAction(mow(), { action: "endBefore", date: "2027-03-15" }, TODAY));
    expect(parseRecurrence(r.tags).until).toBe("2027-03-14");
    expect(parseRecurrence(r.tags).freq).toBe("monthly");
    expect(userTags(r.tags)).toEqual(["home"]);
  });

  it("changing the cadence keeps the series' progress and its skips", () => {
    const tags = applyTaskSchedule(
      { dueDate: "2026-12-15", tags: ["recur:monthly", "ranchor:15", "rdone:11", "rskip:2026-10-15", "home"] },
      { freq: "every-2-weeks" },
    );
    const rule = parseRecurrence(tags);
    expect(rule).toMatchObject({ freq: "every-2-weeks", unit: "week", interval: 2, done: 11 });
    expect(rule.skipped).toEqual(["2026-10-15"]);
    expect(rule.anchorDay).toBeUndefined();
    expect(userTags(tags)).toEqual(["home"]);
  });

  it("an end date and an occurrence count replace each other", () => {
    const base = { dueDate: "2026-12-15", tags: ["recur:monthly", "runtil:2027-06-01"] };
    const counted = parseRecurrence(applyTaskSchedule(base, { count: 6, until: null }));
    expect(counted.count).toBe(6);
    expect(counted.until).toBeUndefined();
    const stopped = applyTaskSchedule(base, { freq: "" });
    expect(parseRecurrence(stopped).freq).toBe("");
  });
});

describe("what the calendar detail screen reads", () => {
  const rows = [
    mow({ tags: ["recur:monthly", "ranchor:15", "rdone:3", "rskip:2026-10-15", "rskip:2027-02-15", "rmove:2027-01-15>2027-01-18"] }),
    ...["2026-11-15", "2026-09-15", "2026-08-15"].map((d, i) => mow({ id: `done-${i}`, status: "done", dueDate: d, tags: ["recur:monthly", "ranchor:15"] })),
    // A different chore's completions are not this series' history.
    { id: "other", title: "Water plants", status: "done", dueDate: "2026-11-10", tags: ["recur:weekly"], linkedProfiles: [] },
  ];
  const series = seriesFromTasks(rows).find((s) => s.id === "task:t-mow")!;
  const occ = generateSeriesOccurrences(series, { todayISO: TODAY, lookbackDays: 62, horizonDays: 150 });

  it("shows the skipped month as skipped and the moved month on its new day", () => {
    const byDate = Object.fromEntries(occ.map((o) => [o.date, o]));
    expect(byDate["2026-12-15"].status).toBe("upcoming");
    expect(byDate["2027-01-15"]).toMatchObject({ effectiveDate: "2027-01-18", moved: true });
    expect(byDate["2027-02-15"].status).toBe("skipped");
    expect(byDate["2027-03-15"].status).toBe("upcoming");
  });

  it("derives history from the series' own rows and marks", () => {
    const history = seriesHistory(series, occ, TODAY);
    expect(history.map((h) => `${h.date}:${h.status}`)).toEqual([
      "2027-02-15:skipped",
      "2027-01-15:rescheduled",
      "2026-11-15:completed",
      "2026-10-15:skipped",
      "2026-09-15:completed",
      "2026-08-15:completed",
    ]);
    // A reschedule is not an outcome: 3 done of 5 that had one.
    expect(completionStats(history)).toEqual({ completed: 3, total: 5, pct: 60 });
  });

  it("offers a task its per-date actions, with what each one reaches", () => {
    expect(can(series, "skip")).toBe(true);
    expect(can(series, "move")).toBe(true);
    const open = occurrenceMenuFor(series, { status: "upcoming", date: "2026-12-15" }, { isOpen: true });
    expect(open.map((m) => m.action)).toEqual(["complete", "skip", "move", "editFuture", "deleteOccurrence"]);
    expect(open.find((m) => m.action === "skip")!.hint).toBe("Keep future schedule");
    // Only the open occurrence can be completed: the task stores one open row.
    const later = occurrenceMenuFor(series, { status: "upcoming", date: "2027-03-15" }, { isOpen: false });
    expect(later.map((m) => m.action)).toEqual(["skip", "move", "editFuture", "deleteOccurrence"]);
    // A skipped date offers exactly one thing: bring it back.
    expect(occurrenceMenuFor(series, { status: "skipped", date: "2027-02-15" }, { isOpen: false }).map((m) => m.action))
      .toEqual(["restore"]);
    expect(editsInPlace(series)).toBe(true);
  });

  it("offers a birthday nothing per date — it cannot be skipped, moved or completed", () => {
    const birthday = {
      id: "event:b", kind: "birthday" as const, title: "Kelly's Birthday",
      source: { system: "event" as const, id: "b", href: "#/calendar" },
      baseDate: "2027-09-22", recurrence: "yearly",
    };
    expect(occurrenceMenuFor(birthday, { status: "upcoming", date: "2027-09-22" }, { isOpen: true })).toEqual([]);
    expect(editsInPlace(birthday)).toBe(true);
  });
});

describe("event series settings", () => {
  it("keeps several reminders, longest lead first, and leaves marks alone", () => {
    const tags = applySeriesSettings(
      ["rdate", "rd:kind:custom", "rd:done:2026-11-02", "work"],
      { kind: "birthday", reminders: [1, 7, 7], requireComplete: true },
    );
    const meta = parseRecurringMeta(tags);
    expect(meta.reminders).toEqual([7, 1]);
    // The bell starts showing the date at the longest lead.
    expect(meta.remindDays).toBe(7);
    expect(meta.kind).toBe("birthday");
    expect(meta.requireComplete).toBe(true);
    expect(meta.completedDates).toEqual(["2026-11-02"]);
    expect(tags).toContain("work");
    // A later check-off rewrites the tags and must not drop a reminder.
    expect(parseRecurringMeta(markOccurrence(tags, "2026-11-09", "done")).reminders).toEqual([7, 1]);
    expect(parseRecurringMeta(applySeriesSettings(tags, { reminders: [] })).remindDays).toBeNull();
  });

  it("turns 'ends after N occurrences' into the date of the Nth", () => {
    expect(nthOccurrenceDate("2026-12-15", "monthly", 3)).toBe("2027-02-15");
    expect(nthOccurrenceDate("2027-09-22", "yearly", 5)).toBe("2031-09-22");
    expect(nthOccurrenceDate("2026-12-15", "monthly", 1)).toBe("2026-12-15");
  });
});

describe("the routes (real Express app)", () => {
  let h: Harness | null = null;
  afterEach(async () => { await h?.close(); h = null; });
  const future = (days: number) => {
    const d = new Date(); d.setDate(d.getDate() + days);
    return d.toLocaleDateString("en-CA");
  };

  it("POST /api/tasks/:id/occurrence skips one date on the stored row", async () => {
    const due = future(10);
    h = await startHarness({ tasks: [mow({ dueDate: due, tags: ["recur:weekly", "home"] })] });
    const r = await h.api("POST", "/api/tasks/t-mow/occurrence", { action: "skip", date: due });
    expect(r.status).toBe(200);
    const row = h.db.tasks.find((t) => t.id === "t-mow")!;
    expect(row.dueDate).toBe(future(17));
    expect(row.tags).toContain(`rskip:${due}`);
    expect(row.tags).toContain("recur:weekly");
    expect(row.tags).toContain("home");
    // The task is still there: skipping never deletes.
    expect(row.status).toBe("todo");
  });

  it("moves one date, and rejects a request it cannot apply", async () => {
    const due = future(10);
    h = await startHarness({ tasks: [mow({ dueDate: due, tags: ["recur:weekly"] }), mow({ id: "t-once", tags: [] })] });
    const moved = await h.api("POST", "/api/tasks/t-mow/occurrence", { action: "move", date: due, newDate: future(12) });
    expect(moved.status).toBe(200);
    const row = h.db.tasks.find((t) => t.id === "t-mow")!;
    expect(row.dueDate).toBe(future(12));
    expect(row.tags).toContain(`rfrom:${due}`);

    expect((await h.api("POST", "/api/tasks/t-mow/occurrence", { action: "move", date: due })).status).toBe(400);
    expect((await h.api("POST", "/api/tasks/t-mow/occurrence", { action: "delete", date: due })).status).toBe(400);
    expect((await h.api("POST", "/api/tasks/t-once/occurrence", { action: "skip", date: "2026-12-15" })).status).toBe(409);
    expect((await h.api("POST", "/api/tasks/nope/occurrence", { action: "skip", date: due })).status).toBe(404);
  });

  it("POST /api/tasks/:id/schedule changes the rule and keeps the user's tags", async () => {
    h = await startHarness({ tasks: [mow({ dueDate: future(10), tags: ["recur:weekly", "home"] })] });
    const r = await h.api("POST", "/api/tasks/t-mow/schedule", { freq: "every-3-days", count: 12 });
    expect(r.status).toBe(200);
    const row = h.db.tasks.find((t) => t.id === "t-mow")!;
    expect(row.tags).toEqual(expect.arrayContaining(["recur:every-3-days", "rcount:12", "home"]));
    expect(row.tags).not.toContain("recur:weekly");
    expect((await h.api("POST", "/api/tasks/t-mow/schedule", { freq: "fortnightly-ish" })).status).toBe(400);
  });

  it("POST /api/events/:id/series-settings stores every reminder and keeps check-offs", async () => {
    h = await startHarness({ events: [{
      id: "ev-1", title: "Kelly's Birthday", date: "2027-09-22", recurrence: "yearly", allDay: true,
      category: "family", linkedProfiles: [], tags: ["rdate", "rd:kind:birthday", "rd:done:2026-09-22", "gift"],
    }] });
    const r = await h.api("POST", "/api/events/ev-1/series-settings", { reminders: [7, 1] });
    expect(r.status).toBe(200);
    const row = h.db.events.find((e) => e.id === "ev-1")!;
    expect(row.tags).toEqual(expect.arrayContaining(["rd:remind:7", "rd:remind:1", "rd:done:2026-09-22", "gift"]));
    expect((await h.api("POST", "/api/events/ev-1/series-settings", { reminders: ["soon"] })).status).toBe(400);
  });
});
