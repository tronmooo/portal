// ── explain_dashboard_item ────────────────────────────────────────────────────
// Answers "why is X showing in today's agenda / upcoming items / my dashboard".
// A rule table that mirrors the dashboard section predicates closely enough to
// EXPLAIN placement (due dates, recurrence, overdue state) — it reads the same
// entity fields the client sections read, and never guesses: when nothing
// matches the name it says so.
import type { IStorage } from "./storage";
import { getEntityList, getEntityName, BULK_ENTITY_TYPES } from "./ai-envelope";

const norm = (s: any) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const DAY = 86400000;

function dayDiff(dateStr: string | undefined | null, today: Date): number | null {
  if (!dateStr) return null;
  const d = new Date(String(dateStr).length <= 10 ? `${String(dateStr).slice(0, 10)}T12:00:00` : String(dateStr));
  if (isNaN(d.getTime())) return null;
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const t1 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((t1 - t0) / DAY);
}

function explainRow(type: string, row: any, today: Date): string[] {
  const reasons: string[] = [];
  const when = (label: string, diff: number) =>
    diff < 0 ? `${label} was ${-diff} day${diff === -1 ? "" : "s"} ago (OVERDUE)`
    : diff === 0 ? `${label} is TODAY`
    : `${label} is in ${diff} day${diff === 1 ? "" : "s"}`;

  if (type === "task") {
    const diff = dayDiff(row.dueDate, today);
    if (row.completed) reasons.push("it is completed — it appears in Recent Activity, not in upcoming sections");
    else if (diff !== null && diff < 0) reasons.push(`${when("its due date", diff)} — overdue tasks surface in Today's Agenda and notifications`);
    else if (diff !== null && diff === 0) reasons.push("it is due today — due-today tasks appear in Today's Agenda");
    else if (diff !== null && diff <= 7) reasons.push(`${when("its due date", diff)} — tasks due within 7 days appear in Upcoming Items`);
    else if (diff !== null) reasons.push(`${when("its due date", diff)} — outside the 7-day upcoming window, so it only shows in the full task list`);
    else reasons.push("it has no due date — undated open tasks show in the task list but not in date-driven sections");
  } else if (type === "event") {
    const diff = dayDiff(row.date || row.startDate, today);
    if (diff !== null && diff === 0) reasons.push("the event is today — today's events appear in Today's Agenda and the calendar");
    else if (diff !== null && diff > 0 && diff <= 7) reasons.push(`${when("the event date", diff)} — events within 7 days appear in Upcoming Items`);
    else if (diff !== null && diff < 0) reasons.push(`${when("the event date", diff)} — past events only show in the calendar and Recent Activity`);
    else reasons.push("its date is outside the dashboard windows — it shows on the Calendar page only");
  } else if (type === "obligation") {
    const diff = dayDiff(row.nextDueDate || row.dueDate, today);
    const freq = row.frequency ? ` (recurs ${row.frequency})` : "";
    if (diff !== null && diff < 0) reasons.push(`${when("its due date", diff)}${freq} — overdue bills surface in Today's Agenda and notifications until paid`);
    else if (diff !== null && diff <= 7) reasons.push(`${when("its due date", diff)}${freq} — bills due within 7 days appear in Upcoming Items and the bills tile`);
    else if (diff !== null) reasons.push(`${when("its next due date", diff)}${freq} — it will enter Upcoming Items 7 days before`);
    else reasons.push("it has no next due date set");
    if (row.paused) reasons.push("note: it is PAUSED, so recurrence is not advancing");
  } else if (type === "reminder") {
    const diff = dayDiff(row.fireAt, today);
    if (diff !== null && diff <= 0) reasons.push("its fire time has arrived — active reminders show in notifications until dismissed");
    else if (diff !== null) reasons.push(`${when("it fires", diff)}`);
  } else if (type === "habit") {
    reasons.push(`it is a ${row.frequency || "daily"} habit — habits appear in the daily habit strip until checked in`);
  } else if (type === "expense") {
    const diff = dayDiff(row.date || row.createdAt, today);
    if (diff !== null && diff >= -31 && diff <= 0) reasons.push("it was logged this month — it counts toward the Monthly Spend tile and Recent Activity");
    else reasons.push("it is older than the current month — it shows in Finance history, not the spend tile");
  } else {
    reasons.push(`${type} records appear in their own section/tab; they don't drive the date-based dashboard sections`);
  }

  const linked = Array.isArray(row.linkedProfiles) ? row.linkedProfiles : [];
  if (linked.length === 0) reasons.push("it has no explicit profile links, so it belongs to your self profile and shows in the default dashboard scope");
  return reasons;
}

export async function explainDashboardItem(storage: IStorage, name: string, entityType?: string): Promise<any> {
  const needle = norm(name);
  if (!needle) return { error: "Tell me which item to explain (its name as shown on the dashboard)." };

  const types = entityType ? [norm(entityType)] : BULK_ENTITY_TYPES.filter((t) => t !== "profile");
  const today = new Date();
  const matches: Array<{ type: string; name: string; id: string; reasons: string[] }> = [];

  for (const type of types) {
    const listP = getEntityList(storage, type);
    if (!listP) continue;
    let rows: any[] = [];
    try { rows = await listP; } catch { continue; }
    for (const row of rows) {
      if (!norm(getEntityName(type, row)).includes(needle)) continue;
      matches.push({ type, name: getEntityName(type, row), id: row.id, reasons: explainRow(type, row, today) });
      if (matches.length >= 5) break;
    }
    if (matches.length >= 5) break;
  }

  // Obligations aren't in BULK_ENTITY_TYPES' default sweep — check explicitly.
  if (!entityType || norm(entityType) === "obligation") {
    try {
      const obs = await storage.getObligations();
      for (const o of obs) {
        if (!norm(o.name).includes(needle) || matches.some((m) => m.id === o.id)) continue;
        matches.push({ type: "obligation", name: o.name, id: o.id, reasons: explainRow("obligation", o, today) });
        if (matches.length >= 5) break;
      }
    } catch { /* best effort */ }
  }

  if (matches.length === 0) {
    return { matches: [], message: `I couldn't find any record named like "${name}" — so if something with that name is on your dashboard, try the exact wording shown on the card.` };
  }
  return {
    matches,
    message: matches.map((m) => `${m.name} (${m.type}): ${m.reasons.join("; ")}`).join(" | ").slice(0, 600),
  };
}
