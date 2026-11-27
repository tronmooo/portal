// Tasks, events, habits, trackers, goals, journal, notes, artifacts, documents,
// characteristics. Each write is read back from Postgres and from whatever
// other screen's data depends on it.
import { scenario, listOf, must, type Ctx } from "../framework";
import * as O from "../oracle";

const timeline = async (ctx: Ctx, from: string, to: string, sourceId: string) =>
  listOf(must(await ctx.api("GET", `/calendar/timeline?start=${from}&end=${to}`), "timeline")).filter((i: any) => i.sourceId === sourceId);
const gone = (row: any) => row === null || row.deleted_at != null;

scenario({
  id: "records.task-lifecycle",
  title: "A task: create, edit one field, complete, delete, restore — list, calendar and counts agree",
  area: "Tasks",
  covers: ["task.create.api", "task.edit.api", "task.complete.api", "task.delete.api", "task.restore.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const stats0 = must(await ctx.api("GET", "/stats"), "stats");
    const due = O.addDays(ctx.today, ctx.int(2, 20));
    const task = must(await ctx.api("POST", "/tasks", { title: `${ctx.tag} renew licence`, dueDate: due, priority: "high", tags: ["errand"] }), "create task");
    ctx.cleanup(() => ctx.api("DELETE", `/tasks/${task.id}`));
    const undated = must(await ctx.api("POST", "/tasks", { title: `${ctx.tag} someday` }), "create undated");
    ctx.cleanup(() => ctx.api("DELETE", `/tasks/${undated.id}`));

    let row = await ctx.db.row("tasks", task.id);
    ctx.check("db", row?.due_date === due && row.status === "todo" && row.priority === "high" && JSON.stringify(row.tags) === '["errand"]', "the row stores date, status, priority and tags", JSON.stringify(row).slice(0, 240));
    const stats1 = must(await ctx.api("GET", "/stats"), "stats");
    ctx.same("derived", [stats1.totalTasks - stats0.totalTasks, stats1.activeTasks - stats0.activeTasks], [2, 2], "task counts rose by two (total, active)");
    const on = await timeline(ctx, O.addDays(ctx.today, -1), O.addDays(ctx.today, 30), task.id);
    ctx.check("derived", on.length === 1 && on[0].date === due && !on[0].completed, `the calendar shows it once, on ${due}`, JSON.stringify(on.map((i: any) => i.date)));
    const off = await timeline(ctx, O.addDays(ctx.today, -30), O.addDays(ctx.today, 60), undated.id);
    ctx.check("derived", off.length === 0, "a task with no due date is not on the calendar", `${off.length} items`);

    // edit one field: nothing else moves (Rule 6)
    must(await ctx.api("PATCH", `/tasks/${task.id}`, { title: `${ctx.tag} renew licence online` }), "rename");
    row = await ctx.db.row("tasks", task.id);
    ctx.check("db", row.title === `${ctx.tag} renew licence online` && row.due_date === due && row.priority === "high" && JSON.stringify(row.tags) === '["errand"]', "a rename kept date, priority and tags", JSON.stringify({ d: row.due_date, p: row.priority, t: row.tags }));

    // a half-typed date is refused and changes nothing
    const bad = await ctx.api("PATCH", `/tasks/${task.id}`, { dueDate: "0002-11-25x" });
    ctx.check("action", bad.status >= 400 && bad.status < 500, "a malformed due date is refused", `${bad.status}`);
    ctx.same("db", (await ctx.db.row("tasks", task.id)).due_date, due, "the refused edit left the date");

    // complete
    must(await ctx.api("PATCH", `/tasks/${task.id}`, { status: "done" }), "complete");
    ctx.same("db", (await ctx.db.row("tasks", task.id)).status, "done", "stored status");
    const stats2 = must(await ctx.api("GET", "/stats"), "stats");
    ctx.same("derived", stats2.activeTasks - stats1.activeTasks, -1, "active tasks fell by one");
    const done = await timeline(ctx, O.addDays(ctx.today, -1), O.addDays(ctx.today, 30), task.id);
    ctx.check("derived", done.length === 1 && done[0].completed === true, "the calendar item reads completed", JSON.stringify(done.map((i: any) => i.completed)));

    // delete → restore
    must(await ctx.api("DELETE", `/tasks/${task.id}`), "delete");
    ctx.check("db", gone(await ctx.db.row("tasks", task.id)), "the row is deleted or marked deleted");
    ctx.check("action", !listOf(must(await ctx.api("GET", "/tasks"), "tasks")).some((t: any) => t.id === task.id), "it left the task list");
    ctx.check("derived", (await timeline(ctx, O.addDays(ctx.today, -1), O.addDays(ctx.today, 30), task.id)).length === 0, "and the calendar");
    const rest = await ctx.api("PATCH", `/tasks/${task.id}/restore`);
    ctx.check("action", rest.ok, "restore is accepted", `${rest.status}`);
    row = await ctx.db.row("tasks", task.id);
    ctx.check("db", row?.deleted_at == null && row.title === `${ctx.tag} renew licence online` && row.due_date === due, "the restored row is the same task, unchanged", JSON.stringify(row).slice(0, 200));
    ctx.check("db", (await ctx.db.count("tasks", `title=like.${ctx.tag}*&deleted_at=is.null`)) === 2, "two live rows: restore made no copy");
  },
});

scenario({
  id: "records.task-recurring",
  title: "A repeating task: skipping one date keeps every later date; completing rolls to the next scheduled date",
  area: "Tasks",
  covers: ["task.reschedule.api", "task.skip.api", "task.complete.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const start = O.addDays(ctx.today, 3);
    const task = must(await ctx.api("POST", "/tasks", { title: `${ctx.tag} mow the lawn`, dueDate: start }), "create");
    ctx.cleanup(() => ctx.api("DELETE", `/tasks/${task.id}`));
    const sch = await ctx.api("POST", `/tasks/${task.id}/schedule`, { freq: "weekly" });
    ctx.check("action", sch.ok, "the weekly repeat is accepted", `${sch.status} ${JSON.stringify(sch.data).slice(0, 160)}`);
    let row = await ctx.db.row("tasks", task.id);
    ctx.check("db", (row.tags || []).includes("recur:weekly") && row.due_date === start, "the row carries the repeat rule and keeps its date", JSON.stringify(row.tags));

    const to = O.addDays(start, 35);
    const dates = async () => (await timeline(ctx, ctx.today, to, task.id)).filter((i: any) => !i.completed && i.meta?.status !== "skipped" && !i.meta?.skipped).map((i: any) => i.date).sort();
    ctx.same("derived", await dates(), O.occurrencesBetween(start, "weekly", ctx.today, to), "weekly dates on the calendar");

    const second = O.addDays(start, 7);
    const skip = await ctx.api("POST", `/tasks/${task.id}/occurrence`, { action: "skip", date: second });
    ctx.check("action", skip.ok, `skipping ${second} is accepted`, `${skip.status} ${JSON.stringify(skip.data).slice(0, 160)}`);
    row = await ctx.db.row("tasks", task.id);
    ctx.check("db", (row.tags || []).includes(`rskip:${second}`) && row.due_date === start, "the skip is a mark on that date; the stored date did not move", JSON.stringify({ t: row.tags, d: row.due_date }));
    ctx.same("derived", await dates(), O.occurrencesBetween(start, "weekly", ctx.today, to, [second]), "after the skip every other date is still there");
    must(await ctx.api("POST", `/tasks/${task.id}/occurrence`, { action: "unskip", date: second }), "unskip");
    ctx.same("derived", await dates(), O.occurrencesBetween(start, "weekly", ctx.today, to), "un-skipping brings the date back");

    // completing the open occurrence: that row is done, and ONE new row carries
    // the series on the next scheduled date
    must(await ctx.api("PATCH", `/tasks/${task.id}`, { status: "done" }), "complete occurrence");
    row = await ctx.db.row("tasks", task.id);
    ctx.check("db", row.status === "done" && row.due_date === start, `the completed occurrence keeps its own date ${start}`, JSON.stringify({ d: row.due_date, s: row.status }));
    const rowsNow = await ctx.db.rows("tasks", `title=like.${ctx.tag}*&deleted_at=is.null`);
    for (const r of rowsNow) if (r.id !== task.id) ctx.cleanup(() => ctx.api("DELETE", `/tasks/${r.id}`));
    const next = rowsNow.filter((r: any) => r.id !== task.id);
    ctx.check("db", next.length === 1 && next[0].due_date === second && next[0].status === "todo" && (next[0].tags || []).includes("recur:weekly"),
      `exactly one next occurrence exists, open, on ${second}, still weekly`, JSON.stringify(next.map((r: any) => ({ d: r.due_date, s: r.status, t: r.tags }))));
    // completing the same row again must not spawn another
    await ctx.api("PATCH", `/tasks/${task.id}`, { status: "done" });
    ctx.check("db", (await ctx.db.count("tasks", `title=like.${ctx.tag}*&deleted_at=is.null`)) === 2, "saving 'done' a second time spawns no further occurrence");

    const bad = await ctx.api("POST", `/tasks/${task.id}/occurrence`, { action: "explode", date: second });
    ctx.check("action", bad.status === 400, "an unknown occurrence action is refused", `${bad.status}`);
  },
});

scenario({
  id: "records.event-series",
  title: "Repeating events across month ends, a leap day and the year boundary",
  area: "Calendar",
  covers: ["event.create.api", "event.edit.api", "event.skip.api", "event.reschedule.api", "event.delete.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    // weekly, from this week across New Year
    const start = O.addDays(ctx.today, 1);
    const weekly = must(await ctx.api("POST", "/events", { title: `${ctx.tag} yoga`, date: start, time: "18:00", recurrence: "weekly" }), "weekly event");
    ctx.cleanup(() => ctx.api("DELETE", `/events/${weekly.id}`));
    const to = O.addDays(start, 63);
    const open = async (id: string, a: string, b: string) => (await timeline(ctx, a, b, id)).filter((i: any) => !i.meta?.skipped && i.meta?.status !== "skipped").map((i: any) => i.date).sort();
    ctx.same("derived", await open(weekly.id, start, to), O.occurrencesBetween(start, "weekly", start, to), "ten weekly dates, across the year boundary");

    const third = O.addDays(start, 14);
    must(await ctx.api("POST", `/events/${weekly.id}/occurrence`, { date: third, state: "skip" }), "skip third");
    ctx.same("derived", await open(weekly.id, start, to), O.occurrencesBetween(start, "weekly", start, to, [third]), "skipping the third keeps the fourth onward");
    const row = await ctx.db.row("events", weekly.id);
    ctx.check("db", row.date === start && row.recurrence === "weekly" && (row.tags || []).some((t: string) => t.includes(third)), "the row keeps its start and rule; the skip is a mark for that date", JSON.stringify({ d: row.date, r: row.recurrence, t: row.tags }));

    // monthly on the 31st: short months clamp, then return to the 31st
    const monthly = must(await ctx.api("POST", "/events", { title: `${ctx.tag} rent review`, date: "2027-01-31", recurrence: "monthly" }), "monthly event");
    ctx.cleanup(() => ctx.api("DELETE", `/events/${monthly.id}`));
    const got31 = await open(monthly.id, "2027-01-01", "2027-06-30");
    const want31 = O.occurrencesBetween("2027-01-31", "monthly", "2027-01-01", "2027-06-30");
    const ok31 = ctx.same("derived", got31, want31, "a monthly event on the 31st (Feb 28, then back to the 31st)");
    if (!ok31) ctx.finding({ severity: "discrepancy", title: "A monthly event anchored on the 31st does not follow the anchor day through short months", detail: `calendar ${JSON.stringify(got31)} vs calendar arithmetic ${JSON.stringify(want31)}` });

    // yearly on Feb 29
    const leap = must(await ctx.api("POST", "/events", { title: `${ctx.tag} leap day`, date: "2028-02-29", recurrence: "yearly" }), "yearly event");
    ctx.cleanup(() => ctx.api("DELETE", `/events/${leap.id}`));
    const gotLeap = await open(leap.id, "2028-01-01", "2032-12-31");
    const wantLeap = O.occurrencesBetween("2028-02-29", "yearly", "2028-01-01", "2032-12-31");
    const okLeap = ctx.same("derived", gotLeap, wantLeap, "a yearly event on Feb 29 (Feb 28 in common years, Feb 29 again in 2032)");
    if (!okLeap) ctx.finding({ severity: "discrepancy", title: "A yearly event on Feb 29 is not shown every year", detail: `calendar ${JSON.stringify(gotLeap)} vs ${JSON.stringify(wantLeap)}` });

    // a multi-day event moved: the end date moves with the start
    const trip = must(await ctx.api("POST", "/events", { title: `${ctx.tag} trip`, date: "2027-03-10", endDate: "2027-03-13" }), "trip");
    ctx.cleanup(() => ctx.api("DELETE", `/events/${trip.id}`));
    const moved = await ctx.api("PATCH", `/events/${trip.id}`, { date: "2027-03-20" });
    ctx.check("action", moved.ok, "moving a multi-day event's start is accepted", `${moved.status} ${JSON.stringify(moved.data).slice(0, 160)}`);
    const tripRow = await ctx.db.row("events", trip.id);
    ctx.same("db", [tripRow.date, tripRow.end_date], ["2027-03-20", "2027-03-23"], "the stored span moved whole (3 days kept)");

    const badDate = await ctx.api("PATCH", `/events/${trip.id}`, { date: "2027-02-30" });
    ctx.check("action", badDate.status === 400, "moving it to Feb 30 is refused", `${badDate.status}`);
    ctx.same("db", (await ctx.db.row("events", trip.id)).date, "2027-03-20", "and the date stays");

    must(await ctx.api("DELETE", `/events/${weekly.id}`), "delete series");
    ctx.check("derived", (await timeline(ctx, start, to, weekly.id)).length === 0, "deleting the series clears every date from the calendar");
    ctx.check("db", gone(await ctx.db.row("events", weekly.id)), "its row is deleted");
  },
});

scenario({
  id: "records.habit",
  title: "A habit: one check-in per day, the streak is counted from the check-ins, delete and restore",
  area: "Habits",
  covers: ["habit.create.api", "habit.checkin.api", "habit.uncheck.api", "habit.delete.api", "habit.restore.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const habit = must(await ctx.api("POST", "/habits", { name: `${ctx.tag} stretch`, frequency: "daily" }), "create habit");
    ctx.cleanup(() => ctx.api("DELETE", `/habits/${habit.id}`));
    const days = [ctx.today, O.addDays(ctx.today, -1), O.addDays(ctx.today, -2), O.addDays(ctx.today, -4)];
    const ids: Record<string, string> = {};
    for (const d of days) {
      const r = must(await ctx.api("POST", `/habits/${habit.id}/checkin`, { date: d }), `checkin ${d}`);
      ids[d] = r.id ?? r.checkin?.id ?? r.checkinId;
    }
    const twice = await ctx.api("POST", `/habits/${habit.id}/checkin`, { date: ctx.today });
    const n = () => ctx.db.count("habit_checkins", `habit_id=eq.${habit.id}`);
    ctx.check("db", (await n()) === 4, `four check-in rows; checking in today a second time (answer ${twice.status}) adds none`, `${await n()} rows`);
    const read = async () => listOf(must(await ctx.api("GET", "/habits"), "habits")).find((h: any) => h.id === habit.id);
    ctx.same("derived", (await read())?.currentStreak, O.dailyStreak(days, ctx.today), "current streak (today, yesterday, the day before; the gap ends it)");

    const future = await ctx.api("POST", `/habits/${habit.id}/checkin`, { date: "2099-01-01" });
    ctx.check("action", future.status >= 400 && future.status < 500, "a check-in dated 2099 is refused", `${future.status}`);

    ids[ctx.today] = (await ctx.db.rows("habit_checkins", `habit_id=eq.${habit.id}&date=eq.${ctx.today}`))[0]?.id;
    must(await ctx.api("DELETE", `/habits/${habit.id}/checkin/${ids[ctx.today]}`), "uncheck today");
    ctx.check("db", (await n()) === 3, "un-checking today removes that one row");
    ctx.same("derived", (await read())?.currentStreak, O.dailyStreak(days.slice(1), ctx.today), "the streak now ends yesterday");

    must(await ctx.api("DELETE", `/habits/${habit.id}`), "delete habit");
    ctx.check("action", !(await read()), "the habit left the list");
    ctx.check("db", gone(await ctx.db.row("habits", habit.id)), "its row is deleted or marked deleted");
    const rest = await ctx.api("PATCH", `/habits/${habit.id}/restore`);
    ctx.check("action", rest.ok, "restore is accepted", `${rest.status}`);
    ctx.check("db", (await n()) === 3, "the restored habit still has its three check-ins");
    ctx.same("derived", (await read())?.currentStreak, O.dailyStreak(days.slice(1), ctx.today), "and the same streak");
  },
});

scenario({
  id: "records.tracker",
  title: "A tracker: one per name, entries stored, an edit re-derives pace, delete takes its entries",
  area: "Trackers",
  covers: ["tracker.create.api", "trackerEntry.create.api", "trackerEntry.edit.api", "trackerEntry.delete.api", "tracker.delete.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const body = { name: `${ctx.tag} Running`, category: "fitness", fields: [{ name: "distance", type: "number", unit: "mi", isPrimary: true }, { name: "duration", type: "number", unit: "min" }] };
    const made = await Promise.all([1, 2, 3, 4, 5].map(() => ctx.api("POST", "/trackers", body)));
    const idsMade = new Set(made.filter((r) => r.ok).map((r) => r.data.id));
    for (const id of idsMade) ctx.cleanup(() => ctx.api("DELETE", `/trackers/${id}`));
    ctx.check("action", made.every((r) => r.status < 500), "five simultaneous creates of one name: no server error", made.map((r) => r.status).join(","));
    const live = await ctx.db.rows("trackers", `name=eq.${encodeURIComponent(body.name)}&deleted_at=is.null`).catch(() => ctx.db.rows("trackers", `name=eq.${encodeURIComponent(body.name)}`));
    const okOne = ctx.check("db", live.length === 1 && idsMade.size === 1, "exactly one tracker row exists for the name, and every answer names it", `${live.length} rows, ${idsMade.size} ids`);
    if (!okOne) ctx.finding({ severity: "bug", title: "Simultaneous creates of one tracker name make more than one tracker", detail: `${live.length} rows / ${idsMade.size} ids for "${body.name}"` });
    const id = [...idsMade][0];

    const e1 = must(await ctx.api("POST", `/trackers/${id}/entries`, { values: { distance: 1.25, duration: 14 } }), "log run");
    const entryId = e1.id ?? e1.entry?.id;
    let row = await ctx.db.row("tracker_entries", entryId);
    ctx.check("db", row?.tracker_id === id && row.entry_values?.distance === 1.25 && row.entry_values?.duration === 14, "the entry row stores distance and duration", JSON.stringify(row?.entry_values));
    const p1 = O.pace(1.25, 14);
    const text1 = JSON.stringify(row);
    ctx.check("derived", text1.includes(p1.text) || text1.includes(String(p1.mph)), `the entry's derived pace is ${p1.text}/mi (${p1.mph} mph)`, text1.slice(0, 400));

    // edit the distance: the pace is derived again, not kept
    must(await ctx.api("PATCH", `/trackers/${id}/entries/${entryId}`, { values: { distance: 1.5, duration: 14 } }), "edit run");
    row = await ctx.db.row("tracker_entries", entryId);
    const p2 = O.pace(1.5, 14);
    const text2 = JSON.stringify(row);
    ctx.check("db", row.entry_values?.distance === 1.5, "the edited distance is stored");
    ctx.check("derived", (text2.includes(p2.text) || text2.includes(String(p2.mph))) && !text2.includes(p1.text), `after the edit the pace is ${p2.text}/mi and the old ${p1.text} is gone`, text2.slice(0, 400));
    ctx.check("db", (await ctx.db.count("tracker_entries", `tracker_id=eq.${id}`)) === 1, "the edit did not add an entry");

    const bad = await ctx.api("POST", `/trackers/${id}/entries`, { values: { distance: "far" } });
    ctx.check("action", bad.status >= 400 && bad.status < 500, "a distance of \"far\" is refused", `${bad.status}`);
    ctx.check("db", (await ctx.db.count("tracker_entries", `tracker_id=eq.${id}`)) === 1, "and nothing is stored for it");

    const e2 = must(await ctx.api("POST", `/trackers/${id}/entries`, { values: { distance: 3, duration: 30 } }), "log second");
    must(await ctx.api("DELETE", `/trackers/${id}/entries/${e2.id ?? e2.entry?.id}`), "delete entry");
    ctx.check("db", (await ctx.db.count("tracker_entries", `tracker_id=eq.${id}`)) === 1, "deleting one entry leaves the other");

    must(await ctx.api("DELETE", `/trackers/${id}`), "delete tracker");
    ctx.check("action", !listOf(must(await ctx.api("GET", "/trackers"), "trackers")).some((t: any) => t.id === id), "the tracker left the list");
    const orphans = await ctx.db.rows("tracker_entries", `tracker_id=eq.${id}`);
    const trRow = await ctx.db.row("trackers", id);
    ctx.check("db", gone(trRow) && (orphans.length === 0 || trRow !== null), "no entry is left pointing at a tracker row that no longer exists", `${orphans.length} entries, tracker row ${trRow === null ? "absent" : "soft-deleted"}`);
  },
});

scenario({
  id: "records.goal",
  title: "A goal: create, progress, delete, restore",
  area: "Goals",
  covers: ["goal.create.api", "goal.edit.api", "goal.delete.api", "goal.restore.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const target = ctx.int(4, 20) * 100;
    const goal = must(await ctx.api("POST", "/goals", { title: `${ctx.tag} bike fund`, type: "savings", target, unit: "USD" }), "create goal");
    ctx.cleanup(() => ctx.api("DELETE", `/goals/${goal.id}`));
    const current = ctx.int(1, 3) * 100;
    must(await ctx.api("PATCH", `/goals/${goal.id}`, { current }), "progress");
    const row = await ctx.db.row("goals", goal.id);
    ctx.check("db", Number(row.target) === target && Number(row.current) === current && row.title === `${ctx.tag} bike fund`, "the row stores target and progress; the title is untouched", JSON.stringify({ t: row.target, c: row.current }));
    const g = must(await ctx.api("GET", `/goals/${goal.id}`), "goal");
    const pct = g.progress ?? g.progressPct ?? g.percent ?? g.percentage;
    const wantPct = Math.round((current / target) * 100);
    if (typeof pct === "number") ctx.check("derived", Math.abs(pct - wantPct) <= 1 || Math.abs(pct * 100 - wantPct) <= 1, `progress is ${wantPct}%`, `got ${pct}`);
    else ctx.check("derived", g.current === current && g.target === target, `the goal reads ${current} of ${target} (${wantPct}%, drawn by the screen)`, JSON.stringify(g).slice(0, 200));
    const bad = await ctx.api("PATCH", `/goals/${goal.id}`, { target: "lots" });
    ctx.check("action", bad.status >= 400 && bad.status < 500, "a target of \"lots\" is refused", `${bad.status}`);
    ctx.same("db", Number((await ctx.db.row("goals", goal.id)).target), target, "the refused edit left the target");
    must(await ctx.api("DELETE", `/goals/${goal.id}`), "delete");
    ctx.check("db", gone(await ctx.db.row("goals", goal.id)), "the row is deleted or marked deleted");
    ctx.check("action", (await ctx.api("POST", `/goals/${goal.id}/restore`)).ok, "restore is accepted");
    const back = await ctx.db.row("goals", goal.id);
    ctx.check("db", back?.deleted_at == null && Number(back.current) === current, "the restored goal kept its progress");
  },
});

scenario({
  id: "records.journal-notes",
  title: "Journal and notes: several entries a day, an edit never touches another entry, versions are kept",
  area: "Journal & notes",
  covers: ["journal.create.api", "journal.edit.api", "journal.delete.api", "note.create.api", "note.edit.api", "note.delete.api", "note.restoreVersion.api", "artifact.restore.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const a = must(await ctx.api("POST", "/journal", { date: ctx.today, content: `${ctx.tag} Morning: slept well and felt rested.`, mood: "good" }), "entry a");
    const b = must(await ctx.api("POST", "/journal", { date: ctx.today, content: `${ctx.tag} Evening: frustrated and overwhelmed by the commute.` }), "entry b");
    const idA = a.id ?? a.entry?.id, idB = b.id ?? b.entry?.id;
    ctx.cleanup(() => ctx.api("DELETE", `/journal/${idA}`)); ctx.cleanup(() => ctx.api("DELETE", `/journal/${idB}`));
    ctx.check("action", idA && idB && idA !== idB, "two entries on one day are two entries");
    const rowA0 = await ctx.db.row("journal_entries", idA);
    const rowB0 = await ctx.db.row("journal_entries", idB);
    ctx.check("db", rowA0?.content?.includes("Morning") && rowB0?.content?.includes("Evening") && rowA0.date === ctx.today, "both rows hold their own text and the day", JSON.stringify({ a: rowA0?.content?.slice(0, 30), b: rowB0?.content?.slice(0, 30) }));
    ctx.check("derived", !!rowB0?.mood && rowB0.mood !== "neutral", "the unpicked mood of a frustrated entry was detected, not left neutral", `mood=${rowB0?.mood}`);
    ctx.check("derived", !!rowA0?.title && !!rowB0?.title, "both entries got a title", JSON.stringify({ a: rowA0?.title, b: rowB0?.title }));

    must(await ctx.api("PATCH", `/journal/${idB}`, { content: `${ctx.tag} Evening: long day, but the walk home helped.` }), "edit b");
    const rowA1 = await ctx.db.row("journal_entries", idA);
    const rowB1 = await ctx.db.row("journal_entries", idB);
    ctx.check("db", rowA1.content === rowA0.content && rowA1.mood === rowA0.mood, "editing the evening entry left the morning entry untouched");
    ctx.check("db", rowB1.content.includes("walk home") && rowB1.date === ctx.today, "the evening entry holds the new text");
    const vers = await ctx.api("GET", `/workspace/versions/journal/${idB}`);
    const vlist = vers.ok ? (vers.data.versions ?? vers.data) : [];
    ctx.check("derived", vers.ok && Array.isArray(vlist) && vlist.length >= 1, "the text the edit replaced is kept as a version", `${vers.status} ${JSON.stringify(vers.data).slice(0, 160)}`);

    // notes
    const body = "- [ ] Hallway: Swiss Coffee\n- [x] Door: Hale Navy";
    const note = must(await ctx.api("POST", "/notes", { title: `${ctx.tag} Paint colours`, content: body }), "note");
    const noteId = note.id ?? note.note?.id;
    ctx.cleanup(() => ctx.api("DELETE", `/notes/${noteId}`));
    const again = await ctx.api("POST", "/notes", { title: `${ctx.tag} Paint colours`, content: body });
    const againId = again.data?.id ?? again.data?.note?.id;
    if (againId && againId !== noteId) ctx.cleanup(() => ctx.api("DELETE", `/notes/${againId}`));
    const noteRows = await ctx.db.rows("artifacts", `title=eq.${encodeURIComponent(`${ctx.tag} Paint colours`)}&deleted_at=is.null`).catch(() => ctx.db.rows("artifacts", `title=eq.${encodeURIComponent(`${ctx.tag} Paint colours`)}`));
    ctx.check("db", noteRows.length === 1, `the same note saved twice (answer ${again.status}) is one row`, `${noteRows.length} rows`);
    must(await ctx.api("PATCH", `/notes/${noteId}`, { content: body.replace("[ ]", "[x]") }), "edit note");
    const nRow = await ctx.db.row("artifacts", noteId);
    ctx.check("db", nRow.content.includes("- [x] Hallway") && nRow.title === `${ctx.tag} Paint colours`, "the note row holds the new markdown and keeps its title", JSON.stringify(nRow.content).slice(0, 120));
    const nv = await ctx.api("GET", `/workspace/versions/note/${noteId}`);
    const nvl = nv.ok ? (nv.data.versions ?? nv.data) : [];
    if (nv.ok && nvl.length >= 1) {
      const vid = nvl[0].id ?? nvl[0].versionId;
      const restore = await ctx.api("POST", `/workspace/versions/note/${noteId}/restore`, { versionId: vid });
      ctx.check("action", restore.ok, "restoring the earlier version is accepted", `${restore.status} ${JSON.stringify(restore.data).slice(0, 160)}`);
      const nRow2 = await ctx.db.row("artifacts", noteId);
      ctx.check("db", nRow2.content.includes("- [ ] Hallway") && nRow2.title === `${ctx.tag} Paint colours`, "the restored text is the original; the title is untouched", JSON.stringify(nRow2.content).slice(0, 120));
    } else ctx.check("derived", false, "the note's replaced text is kept as a version", `${nv.status} ${JSON.stringify(nv.data).slice(0, 160)}`);

    must(await ctx.api("DELETE", `/notes/${noteId}`), "delete note");
    ctx.check("db", gone(await ctx.db.row("artifacts", noteId)), "the note row is deleted");
    const vPref = await ctx.db.rows("preferences", `key=eq.versions:note:${noteId}`);
    ctx.check("db", vPref.length === 0 || vPref[0].value === "[]", "its version history is emptied with it", vPref[0]?.value?.slice(0, 120));
    must(await ctx.api("DELETE", `/journal/${idA}`), "delete entry a");
    ctx.check("db", gone(await ctx.db.row("journal_entries", idA)) && !gone(await ctx.db.row("journal_entries", idB)), "deleting one entry of the day leaves the other");
  },
});

scenario({
  id: "records.artifact",
  title: "An artifact: checklist ticks are stored, a duplicate is independent, a share link works signed out and stops when turned off",
  area: "Documents & artifacts",
  covers: ["artifact.create.api", "artifact.edit.api", "artifact.complete.api", "artifact.duplicate.api", "artifact.share.api", "artifact.unshare.api", "artifact.delete.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const art = must(await ctx.api("POST", "/artifacts", { type: "checklist", title: `${ctx.tag} packing`, items: [{ text: "Passport" }, { text: "Charger" }] }), "create");
    ctx.cleanup(() => ctx.api("DELETE", `/artifacts/${art.id}`));
    const itemId = art.items?.[0]?.id;
    must(await ctx.api("POST", `/artifacts/${art.id}/toggle/${itemId}`), "tick");
    let row = await ctx.db.row("artifacts", art.id);
    const items = row.items ?? row.data?.items ?? [];
    ctx.check("db", items.find((i: any) => i.id === itemId)?.checked === true && items.filter((i: any) => i.checked).length === 1, "the tick is stored on that one item", JSON.stringify(items));

    const dup = must(await ctx.api("POST", `/artifacts/${art.id}/duplicate`), "duplicate");
    ctx.cleanup(() => ctx.api("DELETE", `/artifacts/${dup.id}`));
    ctx.check("action", dup.id !== art.id, "the duplicate is a new record");
    must(await ctx.api("PATCH", `/artifacts/${dup.id}`, { title: `${ctx.tag} packing copy edited` }), "rename copy");
    row = await ctx.db.row("artifacts", art.id);
    ctx.same("db", row.title, `${ctx.tag} packing`, "renaming the copy left the original's title");
    ctx.check("db", (await ctx.db.count("artifacts", `title=like.${ctx.tag}*`)) === 2, "two rows: original and copy");

    const share = must(await ctx.api("POST", `/artifacts/${art.id}/share`), "share");
    const token = share.token ?? String(share.url || "").split("/").pop();
    const pub = await fetchPublic(`/public/artifacts/${token}`);
    ctx.check("derived", pub.status === 200 && JSON.stringify(pub.data).includes(`${ctx.tag} packing`), "the link shows the artifact to a signed-out reader", `${pub.status}`);
    ctx.check("isolation", !JSON.stringify(pub.data).includes(ctx.self.id) && !/user_?id/i.test(JSON.stringify(pub.data)), "the public copy carries no account or profile ids");
    must(await ctx.api("DELETE", `/artifacts/${art.id}/share`), "unshare");
    const pub2 = await fetchPublic(`/public/artifacts/${token}`);
    ctx.check("derived", pub2.status === 404, "after sharing is turned off the link is dead", `${pub2.status}`);

    must(await ctx.api("DELETE", `/artifacts/${art.id}`), "delete");
    ctx.check("db", gone(await ctx.db.row("artifacts", art.id)) && !gone(await ctx.db.row("artifacts", dup.id)), "deleting the original leaves the copy");
  },
});

async function fetchPublic(path: string): Promise<{ status: number; data: any }> {
  const { fetchWithRateLimitRetry } = await import("../../smoke/fixture/api");
  const { API_BASE } = await import("../../smoke/fixture/account");
  const { response } = await fetchWithRateLimitRetry(`${API_BASE}${path}`, { method: "GET" });
  const text = await response.text();
  try { return { status: response.status, data: JSON.parse(text) }; } catch { return { status: response.status, data: text }; }
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

scenario({
  id: "records.document-alerts",
  title: "A document's expiration raises one alert; a newer document, a delete and a restore each change it",
  area: "Documents & artifacts",
  covers: ["document.create.api", "document.edit.api", "document.delete.api", "document.restore.api", "document.purge.api", "alert.dismiss.api", "alert.restore.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const soon = O.addDays(ctx.today, 12);
    const doc = must(await ctx.api("POST", "/documents", { name: `${ctx.tag} Gym Membership`, type: "membership", mimeType: "image/png", fileData: PNG, extractedData: { expirationDate: soon } }), "create doc");
    ctx.cleanup(() => ctx.api("POST", `/documents/${doc.id}/purge`).then(() => ctx.api("DELETE", `/documents/${doc.id}`)));
    const row = await ctx.db.row("documents", doc.id);
    ctx.check("db", row?.extracted_data?.expirationDate === soon && row.name === `${ctx.tag} Gym Membership`, "the row stores the expiration date", JSON.stringify(row?.extracted_data));
    const mine = async () => listOf(must(await ctx.api("GET", "/notifications"), "notifications")).filter((n: any) => JSON.stringify(n).includes(doc.id) || JSON.stringify(n).includes(`${ctx.tag} Gym`));
    let alerts = await mine();
    ctx.check("derived", alerts.length === 1, "one alert is raised for the expiring document", `${alerts.length}: ${JSON.stringify(alerts).slice(0, 240)}`);
    const exp = must(await ctx.api("GET", "/dashboard-enhanced"), "enhanced").expiringDocuments || [];
    ctx.check("derived", exp.filter((d: any) => d.id === doc.id || JSON.stringify(d).includes(doc.id)).length === 1, "the dashboard lists it once among expiring documents");

    if (alerts[0]) {
      const dis = await ctx.api("POST", "/notifications/dismiss", { id: alerts[0].id, ids: [alerts[0].id] });
      ctx.check("action", dis.ok, "dismissing the alert is accepted", `${dis.status} ${JSON.stringify(dis.data).slice(0, 120)}`);
      ctx.check("derived", (await mine()).length === 0, "a dismissed alert is gone from the bell");
      const dismissed = must(await ctx.api("GET", "/notifications/dismissed"), "dismissed");
      ctx.check("derived", JSON.stringify(dismissed).includes(alerts[0].id), "and listed among dismissed alerts, where it can be restored");
      const res = await ctx.api("POST", "/notifications/restore", { id: alerts[0].id, ids: [alerts[0].id] });
      ctx.check("action", res.ok, "restoring it is accepted", `${res.status}`);
      ctx.check("derived", (await mine()).length === 1, "the restored alert is back, once");
    }

    // pushing the date out resolves the alert from the record (no stored flag)
    must(await ctx.api("PATCH", `/documents/${doc.id}`, { extractedData: { expirationDate: O.addDays(ctx.today, 400) } }), "renew");
    ctx.check("derived", (await mine()).length === 0, "moving the expiration a year out clears the alert");
    must(await ctx.api("PATCH", `/documents/${doc.id}`, { extractedData: { expirationDate: soon } }), "back");
    ctx.check("derived", (await mine()).length === 1, "moving it back raises it again");

    must(await ctx.api("DELETE", `/documents/${doc.id}`), "delete");
    ctx.check("derived", (await mine()).length === 0, "a deleted document raises no alert");
    ctx.check("action", !listOf(must(await ctx.api("GET", "/documents"), "documents")).some((d: any) => d.id === doc.id), "it left the documents list");
    ctx.check("action", (await ctx.api("POST", `/documents/${doc.id}/restore`)).ok, "restore is accepted");
    ctx.check("derived", (await mine()).length === 1, "the restored document's alert is back");
    must(await ctx.api("DELETE", `/documents/${doc.id}`), "delete again");
    must(await ctx.api("POST", `/documents/${doc.id}/purge`), "purge");
    ctx.check("db", (await ctx.db.row("documents", doc.id)) === null, "a purged document has no row");
  },
});

scenario({
  id: "records.details",
  title: "A characteristic: one definition per name, typed values, flags derived from the value",
  area: "Record details",
  covers: ["detail.create.api", "detail.edit.api", "detail.delete.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const mk = async (name: string) => {
      const p = must(await ctx.api("POST", "/profiles", { type: "asset", name, fields: { currentValue: 100 } }), "asset");
      ctx.cleanup(() => ctx.api("DELETE", `/profiles/${p.id}`));
      return p;
    };
    const guitar = await mk(`${ctx.tag} Guitar`);
    const amp = await mk(`${ctx.tag} Amp`);
    const label = `${ctx.tag} Condition`;
    const first = await ctx.api("POST", `/details/profile/${guitar.id}`, { definition: { label, kind: "condition" }, value: "good" });
    ctx.check("action", first.status === 201, "the first use creates the definition", `${first.status} ${JSON.stringify(first.data).slice(0, 200)}`);
    const defId = first.data?.definition?.id;
    ctx.cleanup(() => ctx.api("DELETE", `/details/definitions/${defId}`));
    const second = await ctx.api("POST", `/details/profile/${amp.id}`, { definition: { label, kind: "condition" }, value: "Fair" });
    ctx.check("action", second.status === 200 && second.data?.definition?.id === defId, "naming it on a second record reuses the one definition", `${second.status} ${second.data?.definition?.id}`);
    const clash = await ctx.api("POST", `/details/profile/${amp.id}`, { definition: { label, kind: "number" }, value: 4 });
    ctx.check("action", clash.status === 409, "the same name with another type is refused (409)", `${clash.status}`);
    const defs = await ctx.db.rows("preferences", "key=eq.detail_definitions");
    const stored = JSON.parse(defs[0]?.value || "[]");
    const list = Array.isArray(stored) ? stored : stored.definitions || [];
    ctx.check("db", list.filter((d: any) => d.label === label).length === 1, "one definition row entry carries the name", `${list.filter((d: any) => d.label === label).length}`);
    const vals = await ctx.db.rows("preferences", `key=eq.details:profile:${guitar.id}`);
    ctx.check("db", vals.length === 1 && /"Good"/.test(vals[0].value), "\"good\" was stored as the scale's own \"Good\"", vals[0]?.value?.slice(0, 200));

    const bad = await ctx.api("PUT", `/details/profile/${guitar.id}/${defId}`, { value: "sparkly" });
    ctx.check("action", bad.status === 400, "a value the scale does not have is refused with a 400", `${bad.status}`);
    const vals2 = await ctx.db.rows("preferences", `key=eq.details:profile:${guitar.id}`);
    ctx.same("db", vals2[0]?.value, vals[0]?.value, "the refused value changed nothing");

    const report = await ctx.api("GET", `/details/report?definition=${defId}&op=at_or_worse&value=Fair`);
    if (report.ok) {
      const text = JSON.stringify(report.data);
      ctx.check("derived", text.includes(amp.id) && !text.includes(guitar.id), "\"Fair or worse\" finds the amp and not the guitar", text.slice(0, 240));
    } else ctx.check("derived", false, "the report answers", `${report.status} ${JSON.stringify(report.data).slice(0, 200)}`);

    const del = await ctx.api("DELETE", `/details/profile/${guitar.id}/${defId}`);
    ctx.check("action", del.ok, "removing the value is accepted", `${del.status}`);
    const vals3 = await ctx.db.rows("preferences", `key=eq.details:profile:${guitar.id}`);
    ctx.check("db", vals3.length === 0 || !vals3[0].value.includes(defId), "the value is gone from the stored row");
    // deleting the record deletes its values
    must(await ctx.api("DELETE", `/profiles/${amp.id}`), "delete amp");
    const after = await ctx.api("GET", `/details/report?definition=${defId}&op=at_or_worse&value=Fair`);
    const okRep = ctx.check("derived", after.ok && !JSON.stringify(after.data).includes(amp.id), "the report no longer lists the deleted record", JSON.stringify(after.data).slice(0, 240));
    if (!okRep) ctx.finding({ severity: "sync", title: "The characteristics report lists a record that was deleted", detail: `report still names profile ${amp.id}` });
    const left = await ctx.db.rows("preferences", `key=eq.details:profile:${amp.id}`);
    const okLeft = ctx.check("db", left.length === 0, "deleting a record deletes its characteristic values", `${left.length} row(s) left: ${left[0]?.value?.slice(0, 120)}`);
    if (!okLeft) ctx.finding({ severity: "bug", title: "Deleting a profile leaves its characteristic values behind", detail: `preferences row details:profile:${amp.id} survives the profile` });
  },
});
