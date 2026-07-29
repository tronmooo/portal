// ── Executive briefing (2026-07-16, v3 attention-first top) ──────────────────
// Top of the board answers "what needs my attention today, what's coming up,
// and what's going wrong" — not just totals. Row 1: Attention Required (the
// Score replacement, most prominent) / Tasks / Events; row 2: Bills /
// Documents / Habits; then a full-width Today's Overview strip. Projects moved
// down into the section grid. Below that, the dense multi-column command-center
// sections remain: compact spreadsheet-like sections in a responsive masonry
// (1/2/3 columns), each collapsible, and every row opens the EXISTING
// popup/surface for its module — TasksPopup and HabitsPopup are the same
// components the dashboard KPI tiles always used (TaskHabitPopups.tsx); the
// rest live in BriefingPopups.tsx. Nothing here duplicates functionality.
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, recoverWedgedQueries, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { useToast } from "@/hooks/use-toast";
import { loadDocSnoozeMap } from "@/lib/docSnooze";
import { useMarkBillPaid, MARK_PAID_LABEL } from "@/lib/mark-bill-paid";
import { ChevronDown } from "lucide-react";
import { TasksPopup, HabitsPopup } from "@/components/dashboard/TaskHabitPopups";
import {
  BillsPopup, EventsPopup, DocsPopup, ProjectsPopup, NotesPopup, RemindersPopup,
  AttentionPopup, TodayOverviewPopup, fmtClock,
  type AttentionEntry, type TodayEntry,
} from "@/components/dashboard/BriefingPopups";
import type { DashboardStats } from "@shared/schema";
// One relative-due formatter for the whole app. Interpolating a raw `daysUntil`
// here is what produced "Lawn care ($40) due in -29d".
import { dayLabel as relativeDay, dueLabel } from "@shared/now-rank";
import { isTestDataRow } from "@shared/test-data";
import { goalProgress } from "@shared/goal-progress";
import { isRecurring as isRecurringRule, parseRecurrence } from "@shared/recurrence";
import { useShowTestData } from "@/lib/showTestData";

type PopupKind = "tasks" | "habits" | "bills" | "events" | "docs" | "projects" | "notes" | "reminders" | "attention" | "today" | null;

// Per-section accent colors (HSL) — the "colorful, visually organized" pass.
const ACCENTS: Record<string, string> = {
  agenda:        "199 89% 60%",  // sky
  overdue:       "0 72% 58%",    // red
  tasks:         "217 91% 65%",  // blue
  priority:      "25 95% 58%",   // orange
  habits:        "155 65% 45%",  // emerald
  reminders:     "43 96% 56%",   // amber
  birthdays:     "330 80% 62%",  // pink
  appointments:  "262 80% 66%",  // violet
  dates:         "187 80% 50%",  // cyan
  docs:          "0 72% 58%",    // red
  bills:         "48 96% 53%",   // yellow
  calendar:      "239 84% 67%",  // indigo
  notifications: "350 85% 62%",  // rose
  projects:      "142 70% 45%",  // green
  alerts:        "280 75% 62%",  // purple
  activity:      "173 60% 44%",  // teal
  notes:         "240 10% 60%",  // stone
};

function Section({ id, title, count, summary, children, defaultOpen = true, testId }: {
  id: string; title: string; count?: number; summary?: string; children: React.ReactNode;
  defaultOpen?: boolean; testId: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const accent = ACCENTS[id] || "240 10% 60%";
  return (
    <div
      className="break-inside-avoid mb-2 rounded-lg border bg-card/40 px-2 pt-0.5 pb-1.5"
      style={{ borderColor: `hsl(${accent} / 0.25)` }}
      data-testid={testId}
    >
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 py-1.5 text-left group"
        aria-expanded={open}
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: `hsl(${accent})`, boxShadow: `0 0 5px hsl(${accent} / 0.7)` }} />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-foreground transition-colors">{title}</span>
        {typeof count === "number" && count > 0 && (
          <span className="text-[10px] px-1.5 rounded-full" style={{ background: `hsl(${accent} / 0.15)`, color: `hsl(${accent})` }}>{count}</span>
        )}
        {summary && <span className="ml-auto mr-1 text-[10px] tabular-nums" style={{ color: `hsl(${accent})` }}>{summary}</span>}
        <ChevronDown className={`h-3 w-3 ${summary ? "" : "ml-auto"} text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && children}
    </div>
  );
}

// Top stat tile (2026-07-16 redesign) — big count plus a small unit next to it
// ("3 due today"), a decision-oriented sub-line, clickable. `prominent` gives
// the Attention tile the strongest visual weight on the board.
function StatTile({ label, value, unit, sub, accent, onClick, testId, prominent }: {
  label: string; value: string; unit?: string; sub?: string; accent: string;
  onClick: () => void; testId: string; prominent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className="rounded-xl border px-2.5 py-2 text-left card-lift transition-all"
      style={{
        borderColor: `hsl(${accent} / ${prominent ? 0.55 : 0.30})`,
        background: `linear-gradient(135deg, hsl(${accent} / ${prominent ? 0.20 : 0.12}) 0%, hsl(var(--card)) 75%)`,
        ...(prominent ? { boxShadow: `0 0 16px hsl(${accent} / 0.18)` } : {}),
      }}
    >
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: `hsl(${accent})`, boxShadow: `0 0 5px hsl(${accent} / 0.7)` }} />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      <div className="flex items-baseline gap-1 mt-0.5 min-w-0">
        <span className={`metric-value ${prominent ? "text-2xl" : "text-xl"}`} style={{ color: `hsl(${accent})` }}>{value}</span>
        {unit && <span className="text-[11px] font-medium truncate" style={{ color: `hsl(${accent})` }}>{unit}</span>}
      </div>
      {sub && <div className="text-[10px] text-muted-foreground truncate">{sub}</div>}
    </button>
  );
}

function Row({ cells, onClick, testId, urgent, valueTone }: {
  cells: React.ReactNode[]; onClick?: () => void; testId?: string;
  urgent?: boolean; valueTone?: "pos" | "neg" | "warn";
}) {
  const toneCls = valueTone === "pos" ? "text-emerald-500" : valueTone === "neg" ? "text-red-500" : valueTone === "warn" ? "text-amber-500" : "";
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className={`w-full flex items-baseline gap-2 py-[3px] px-1 text-left text-xs hover:bg-muted/40 rounded-sm ${urgent ? "text-red-500" : ""}`}
    >
      <span className="text-[10px] uppercase text-muted-foreground w-16 shrink-0 truncate">{cells[0]}</span>
      <span className="flex-1 truncate">{cells[1]}</span>
      {cells.length > 2 && <span className={`text-[11px] tabular-nums text-right shrink-0 ${toneCls}`}>{cells[2]}</span>}
    </button>
  );
}

const Empty = ({ label }: { label: string }) => (
  <p className="text-[11px] text-muted-foreground py-0.5 px-1">{label}</p>
);

function dayLabel(dateStr: string, todayStr: string): string {
  if (dateStr === todayStr) return "Today";
  const d = new Date(dateStr + "T00:00:00");
  const t = new Date(todayStr + "T00:00:00");
  const diff = Math.round((d.getTime() - t.getTime()) / 86400000);
  if (diff === 1) return "Tomorrow";
  if (diff > 1 && diff < 7) return d.toLocaleDateString("en-US", { weekday: "long" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const BIRTHDAY_RE = /birthday|anniversar|🎂|🎉/i;
const APPT_RE = /appt|appointment|doctor|dentist|dental|vet\b|exam|check[- ]?up|physical|therapy/i;

const normName = (s: any) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

// Display-level bill dedupe: "Verizon Phone Bill payment" and "Phone Bill
// payment" at the same $86.50 are one bill entered twice. Collapses rows only
// when the amounts match exactly AND the normalized names match or nest —
// "rent the 1st" ($2,500) vs "rent" ($300) stays two rows for the user to
// reconcile. The row with the more specific (longer) name survives.
function dedupeBills(rows: any[]): any[] {
  const out: any[] = [];
  for (const b of rows || []) {
    const n = normName(b.name);
    const idx = out.findIndex(o => Number(o.amount) === Number(b.amount) && (() => {
      const m = normName(o.name);
      return m === n || (n && m && (m.includes(n) || n.includes(m)));
    })());
    if (idx === -1) out.push(b);
    else if (n.length > normName(out[idx].name).length) out[idx] = b;
  }
  return out;
}

export function ExecutiveBriefing({ filterMode, filterIds, stats, enhanced, ready = true }: {
  filterMode: string; filterIds: string[];
  stats: DashboardStats | undefined; enhanced: any;
  /** Gate for this component's own queries (PERF 2026-07-16): the dashboard
   * passes bootstrapSettled so these resolve from the bootstrap-seeded cache
   * instead of firing 7 network requests that race the bootstrap download on
   * weak mobile links. Defaults true so other callers are unaffected; the
   * dashboard's gate self-releases after 8s even if bootstrap hangs. */
  ready?: boolean;
}) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [popup, setPopup] = useState<PopupKind>(null);
  // Which bill's Pay button is armed for the confirming second tap.
  const [armedPayId, setArmedPayId] = useState<string | null>(null);
  const mode = filterMode;
  const ids = filterIds;
  const param = mode === "selected" && ids.length > 0 ? `?profileIds=${ids.join(",")}` : "";
  const amp = param ? "&" : "?";
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: BROWSER_TIMEZONE });
  const in45 = new Date(Date.now() + 45 * 86400000).toLocaleDateString("en-CA", { timeZone: BROWSER_TIMEZONE });
  const in14 = new Date(Date.now() + 14 * 86400000).toLocaleDateString("en-CA", { timeZone: BROWSER_TIMEZONE });

  // NOTE (BUG-20260715-everyone-zeros): none of these query functions may
  // swallow errors into a cached-as-success empty value (`.catch(() => [])`).
  // A transient failure — e.g. the pre-auth boot window racing token restore —
  // then renders as "0 in every category" for the whole staleTime window.
  // Letting the error propagate keeps react-query in error state (data stays
  // undefined → section shows empty NOW but refetches on mount/focus/switch).
  const { data: tasksRaw = [], isPending: tasksPending } = useQuery<any[]>({
    queryKey: ["/api/tasks", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/tasks${param}`).then(r => r.json()),
    staleTime: 30_000,
  });
  const { data: habitsRaw = [], isPending: habitsPending } = useQuery<any[]>({
    queryKey: ["/api/habits", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/habits${param}`).then(r => r.json()),
    staleTime: 30_000,
  });
  // 45-day window: agenda + calendar preview slice ≤14d from it; birthdays /
  // appointments / important dates get the longer horizon. One fetch.
  const { data: timelineRaw = [], isPending: timelinePending } = useQuery<any[]>({
    queryKey: ["/api/calendar/timeline", todayStr, in45, mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/calendar/timeline${param}${amp}start=${todayStr}&end=${in45}`).then(r => r.json()),
    staleTime: 60_000,
  });
  // Reminders are profile-scoped like every other briefing section — pass the
  // active filter so a selected profile shows only its own reminders (the
  // server enforces strict isolation; unlinked reminders appear only in the
  // unfiltered "Everyone" view). Keying on mode/ids makes switching profiles
  // refetch instead of showing another profile's cached reminders.
  const { data: remindersRaw = [] } = useQuery<any[]>({
    queryKey: ["/api/reminders", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/reminders${param}`).then(r => r.json()),
    staleTime: 60_000,
  });
  const { data: goalsRaw = [], isPending: goalsPending } = useQuery<any[]>({
    queryKey: ["/api/goals", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/goals${param}`).then(r => r.json()),
    staleTime: 60_000,
  });
  const { data: journal = [] } = useQuery<any[]>({
    queryKey: ["/api/journal", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/journal${param}`).then(r => r.json()),
    staleTime: 60_000,
  });
  const { data: notificationsRaw = [] } = useQuery<any[]>({
    queryKey: ["/api/notifications", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/notifications${param}`).then(r => r.json()),
    staleTime: 60_000,
  });

  // "Hide test data" (default) — the header toggle flips this flag app-wide,
  // but this tab previously never consumed it, so AUDIT/QA/W2/SMOKE rows leaked
  // into every section regardless of the toggle. Same shared detector the
  // finance surfaces use (shared/test-data).
  const showTestData = useShowTestData();
  const isTestRow = (r: any) =>
    isTestDataRow(r?.name) || isTestDataRow(r?.title) || isTestDataRow(r?.description) ||
    isTestDataRow(r?.message) || isTestDataRow(r?.documentName);
  const hideTest = <T,>(rows: T[]): T[] => (showTestData ? rows : (rows || []).filter(r => !isTestRow(r)));
  const tasks = hideTest(tasksRaw || []);
  const habits = hideTest(habitsRaw || []);
  const timeline = hideTest(timelineRaw || []);
  const reminders = hideTest(Array.isArray(remindersRaw) ? remindersRaw : []);
  const notifications = hideTest(Array.isArray(notificationsRaw) ? notificationsRaw : []);
  const goals = hideTest(goalsRaw || []);
  const allBills = dedupeBills(hideTest(enhanced?.financeSnapshot?.upcomingBills || []));

  // STUCK-LOADING DEADLINE (2026-07-16): if any tile-feeding query is still
  // unresolved after 12s (wedged fetch, failed enhanced, cold instance), show
  // the Retry banner instead of letting "loading" tiles sit forever.
  const anyBriefPending = tasksPending || habitsPending || timelinePending || goalsPending || enhanced === undefined;
  const [briefStuck, setBriefStuck] = useState(false);
  useEffect(() => {
    if (!anyBriefPending) { setBriefStuck(false); return; }
    const t = setTimeout(() => setBriefStuck(true), 12_000);
    return () => clearTimeout(t);
  }, [anyBriefPending]);

  // Recording a payment goes through the shared hook so this card offers the
  // same working Undo as every other surface. It previously fired a bare
  // "Payment recorded" toast with no way back (audit finding P1).
  const { markPaid, isPending: payPending } = useMarkBillPaid();

  // ── Derivations ─────────────────────────────────────────────────────────────
  const pending = (tasks || []).filter((t: any) => t.status !== "done");
  const overdueTasks = pending.filter((t: any) => t.dueDate && t.dueDate.slice(0, 10) < todayStr)
    .sort((a: any, b: any) => (a.dueDate || "").localeCompare(b.dueDate || "")).slice(0, 10);
  const highPriority = pending.filter((t: any) => ["high", "urgent"].includes(String(t.priority || "").toLowerCase()) && !(t.dueDate && t.dueDate.slice(0, 10) < todayStr)).slice(0, 8);
  // Same "today" rule as TasksPopup's Today tab (minus its overdue section):
  // due today, or undated — an undated one-off or unpaused recurring chore
  // surfaces today. Keeping the two rules identical is what makes the TASKS
  // tile's "due today" line up with the popup's tab counts.
  const pausedRecurring = (t: any) => isRecurringRule(t.tags || []) && parseRecurrence(t.tags || []).paused;
  const agendaTasks = pending.filter((t: any) =>
    !pausedRecurring(t) && (t.dueDate ? t.dueDate.slice(0, 10) === todayStr : true));
  // Strictly future-dated — today's and undated tasks already live on the
  // agenda, so listing them here too would show one task in two sections.
  const upcomingTasks = pending
    .filter((t: any) => t.dueDate && t.dueDate.slice(0, 10) > todayStr)
    .sort((a: any, b: any) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999")).slice(0, 12);

  const tl = (timeline || []).filter((i: any) => (i.date || "").slice(0, 10) >= todayStr);
  // Loan / credit-card payments (timeline marks them meta.kind === "payment";
  // recurring bills are kind "bill") are amortizing liabilities, not calendar
  // commitments — the Liabilities/Bills lane already tracks them, so they stay
  // off Today's Agenda (type-aware-liabilities rule). They remain on the
  // full Calendar surfaces, which deliberately show every due date.
  const isLoanPayment = (i: any) => i.type === "obligation" && i.meta?.kind === "payment";
  const todayItems = tl.filter((i: any) => (i.date || "").slice(0, 10) === todayStr && !isLoanPayment(i));
  const events = tl.filter((i: any) => i.type === "event" && (i.date || "").slice(0, 10) > todayStr);
  const birthdays = events.filter((i: any) => BIRTHDAY_RE.test(`${i.title} ${i.category || ""}`)).slice(0, 8);
  const appointments = events.filter((i: any) => APPT_RE.test(`${i.title} ${i.category || ""}`)).slice(0, 8);
  // One row per series: a recurring chore ("Lawn Care" weekly) otherwise fills
  // the whole Important Dates list with its next 7 occurrences.
  const importantDates = (() => {
    const seen = new Set<string>();
    return events
      .filter((i: any) => !BIRTHDAY_RE.test(`${i.title} ${i.category || ""}`) && !APPT_RE.test(`${i.title} ${i.category || ""}`))
      .filter((i: any) => { const k = normName(i.title); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 10);
  })();
  // EVENTS tile counts only real calendar EVENTS — not tasks / bills /
  // obligations that also live in the timeline (BUG-20260709: "3 events even
  // when Mike has no events"). `eventsToday` below keeps that semantics.

  const habitRows = (habits || []).slice(0, 12).map((h: any) => {
    const doneToday = (h.checkins || []).some((c: any) => (c.date || "").slice(0, 10) === todayStr);
    return { id: h.id, name: h.name, doneToday, streak: h.currentStreak ?? h.streak ?? 0 };
  });
  const missedCount = habitRows.filter(h => !h.doneToday).length;

  const bills = allBills.filter((b: any) => b.daysUntil <= 21).slice(0, 10);
  // Docs: respect the shared 30-day dismisses (same map the KPI section and
  // DocsPopup use) so a dismissed alert disappears everywhere at once. The
  // tile counts the 30-day "expiring soon" window (expired + ≤30d); the
  // section/popup still list the longer 90-day horizon grouped by urgency.
  const docSnooze = loadDocSnoozeMap();
  const allExpiringDocs = hideTest<any>(enhanced?.expiringDocuments || []).filter((d: any) => !docSnooze[d.documentId]);
  const docs = allExpiringDocs.slice(0, 10);
  const docsSoonCount = allExpiringDocs.filter((d: any) => typeof d.daysUntil === "number" && d.daysUntil <= 30).length;

  const calendarDays: Array<{ day: string; items: any[] }> = [];
  for (const item of tl) {
    const d = (item.date || "").slice(0, 10);
    if (!d || d > in14) continue;
    const label = dayLabel(d, todayStr);
    const bucket = calendarDays.find(b => b.day === label);
    if (bucket) { if (bucket.items.length < 4) bucket.items.push(item); }
    else if (calendarDays.length < 7) calendarDays.push({ day: label, items: [item] });
  }

  const projects = (goals || []).filter((g: any) => g.status === "active" || !g.status).slice(0, 8);
  const activity = (stats?.recentActivity || []).slice(0, 8);
  const notes = (journal || []).slice(0, 4);
  // Reminder rows carry { title, fireAt, firedAt } — there is no completed/
  // dismissed field (done = soft-delete, fired = firedAt set). Un-fired rows
  // are the active ones; sort soonest-first so the next reminder leads.
  const seenReminders = new Set<string>();
  const activeReminders = (Array.isArray(reminders) ? reminders : [])
    .filter((r: any) => !r.firedAt)
    // Exact duplicates (same title, same fire minute) render once. Distinct
    // times survive on purpose — three amoxicillin doses a day is a regimen,
    // not a dupe.
    .filter((r: any) => {
      const k = `${normName(r.title || r.message || r.content)}@${String(r.fireAt || "").slice(0, 16)}`;
      if (seenReminders.has(k)) return false;
      seenReminders.add(k);
      return true;
    })
    .sort((a: any, b: any) => new Date(a.fireAt || 0).getTime() - new Date(b.fireAt || 0).getTime())
    .slice(0, 8);
  const notifs = (Array.isArray(notifications) ? notifications : []).filter((n: any) => !n.dismissed);
  const alerts = notifs.filter((n: any) => n.severity === "critical").slice(0, 6);
  const infoNotifs = notifs.filter((n: any) => n.severity !== "critical").slice(0, 6);

  const daysLeft = (dateStr: string) => Math.max(0, Math.round((new Date(dateStr + "T00:00:00").getTime() - new Date(todayStr + "T00:00:00").getTime()) / 86400000));
  const goNotif = (n: any) => {
    if (n.entityType === "document" && n.entityId) navigate(`/documents/${n.entityId}`);
    else if (n.entityType === "profile" && n.entityId) navigate(`/profiles/${n.entityId}`);
    else if (n.entityType === "task") setPopup("tasks");
    else if (n.entityType === "habit") setPopup("habits");
    else setPopup("events");
  };

  // The overdue-bill LIST and its COUNT come from one filter, so the Overdue
  // section can never disagree with the Attention summary about how many there
  // are (audit finding D3 — a count is the length of the list it labels).
  const overdueBills = bills.filter((b: any) => b.status === "overdue");
  const overdueBillCount = overdueBills.length;
  const billsUpcomingTotal = bills.reduce((s: number, b: any) => s + (Number(b.amount) || 0), 0);
  const doneToday = (tasks || []).filter((t: any) => t.status === "done" && String(t.completedAt || t.updatedAt || "").slice(0, 10) === todayStr).length;

  // ── Top-card derivations (2026-07-16 redesign: attention over totals) ───────
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const fmtShort = (d: string) => new Date(d.slice(0, 10) + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const nowClock = new Date().toTimeString().slice(0, 5);
  const nowMs = Date.now();

  // Tasks: high-priority count includes overdue ones (unlike the section list).
  const highCount = pending.filter((t: any) => ["high", "urgent"].includes(String(t.priority || "").toLowerCase())).length;
  const habitsDone = habitRows.length - missedCount;

  // Events: what's left today, and the single next thing on the calendar.
  const eventsToday = todayItems.filter((i: any) => i.type === "event");
  const nextTodayEvent = eventsToday
    .filter((i: any) => i.time && i.time >= nowClock)
    .sort((a: any, b: any) => String(a.time).localeCompare(String(b.time)))[0]
    || eventsToday.find((i: any) => !i.time);
  const nextFutureEvent = events.slice().sort((a: any, b: any) => String(a.date || "").localeCompare(String(b.date || "")))[0];
  const nextEventLabel = nextTodayEvent
    ? `Next: ${nextTodayEvent.title}${nextTodayEvent.time ? ` · ${fmtClock(nextTodayEvent.time)}` : ""}`
    : nextFutureEvent
      ? `Next: ${nextFutureEvent.title} · ${dayLabel(String(nextFutureEvent.date).slice(0, 10), todayStr)}`
      : "nothing scheduled";

  // Bills: risk + timing, not just a count.
  const nextBill = bills.filter((b: any) => b.status !== "overdue")
    .slice().sort((a: any, b: any) => (a.daysUntil ?? 1e9) - (b.daysUntil ?? 1e9))[0];
  const nextBillDate = nextBill
    ? fmtShort(String(nextBill.dueDate || "").slice(0, 10) || new Date(nowMs + (nextBill.daysUntil || 0) * 86400000).toLocaleDateString("en-CA"))
    : null;

  // Documents: expired or ≤30d, soonest first.
  const docExpiryPhrase = (d: number) =>
    d < 0 ? (d === -1 ? "expired yesterday" : `expired ${Math.abs(d)} days ago`)
    : d === 0 ? "expires today" : d === 1 ? "expires tomorrow" : `expires in ${d} days`;
  const nextDoc = allExpiringDocs
    .filter((d: any) => typeof d.daysUntil === "number" && d.daysUntil <= 30)
    .slice().sort((a: any, b: any) => (a.daysUntil ?? 1e9) - (b.daysUntil ?? 1e9))[0];

  // ── Attention Required: every urgent issue across the profile, one list. ────
  const firedReminders = activeReminders.filter((r: any) => r.fireAt && new Date(r.fireAt).getTime() < nowMs);
  const attention: AttentionEntry[] = [];
  for (const t of overdueTasks) attention.push({
    id: `task-${t.id}`, title: t.title, severity: "critical", group: "Overdue tasks",
    reason: `Overdue — was due ${fmtShort(String(t.dueDate))}`, go: () => setPopup("tasks"),
  });
  for (const b of bills) {
    if (b.status === "overdue") attention.push({
      id: `bill-${b.id}`, title: b.name, severity: "critical", group: "Bills requiring action",
      reason: `$${Number(b.amount).toLocaleString()} overdue`, go: () => setPopup("bills"),
    });
    else if (b.daysUntil === 0) attention.push({
      id: `bill-${b.id}`, title: b.name, severity: "warning", group: "Bills requiring action",
      reason: `$${Number(b.amount).toLocaleString()} due today`, go: () => setPopup("bills"),
    });
  }
  for (const d of allExpiringDocs) {
    if (typeof d.daysUntil !== "number" || d.daysUntil > 30) continue;
    attention.push({
      id: `doc-${d.documentId}-${d.fieldName || ""}`,
      title: d.documentName || d.name || d.fieldName || "Document",
      severity: d.daysUntil < 0 ? "critical" : "warning", group: "Expiring documents",
      reason: docExpiryPhrase(d.daysUntil), go: () => setPopup("docs"),
    });
  }
  for (const h of habitRows) if (!h.doneToday) attention.push({
    id: `habit-${h.id}`, title: h.name, severity: "warning", group: "Habits still due today",
    reason: "Not checked in yet", go: () => setPopup("habits"),
  });
  for (const n of alerts) attention.push({
    id: `alert-${n.id}`, title: n.title, severity: "critical", group: "Alerts",
    reason: "Critical notification", go: () => goNotif(n),
  });
  for (const r of firedReminders) attention.push({
    id: `rem-${r.id}`, title: r.title || r.message || r.content || "Reminder", severity: "warning",
    group: "Reminders", reason: "Fired — not dismissed", go: () => setPopup("reminders"),
  });
  const attnCritical = attention.filter(i => i.severity === "critical").length;
  // Sub-line: top two contributors, most severe first, then a "N more" tail so
  // the parts always account for the headline number (a "29" headline with a
  // "9 · 6" sub-line read as broken math).
  const attnParts: Array<{ label: string; n: number }> = [];
  if (overdueTasks.length) attnParts.push({ label: plural(overdueTasks.length, "overdue task"), n: overdueTasks.length });
  if (overdueBillCount) attnParts.push({ label: plural(overdueBillCount, "overdue bill"), n: overdueBillCount });
  const billsDueTodayCount = bills.filter((b: any) => b.status !== "overdue" && b.daysUntil === 0).length;
  if (billsDueTodayCount) attnParts.push({ label: `${plural(billsDueTodayCount, "bill")} due today`, n: billsDueTodayCount });
  if (alerts.length) attnParts.push({ label: plural(alerts.length, "alert"), n: alerts.length });
  const expiringDocCount = attention.filter(i => i.group === "Expiring documents").length;
  if (nextDoc) attnParts.push({ label: plural(expiringDocCount, "expiring doc"), n: expiringDocCount });
  if (missedCount) attnParts.push({ label: `${plural(missedCount, "habit")} due`, n: missedCount });
  if (firedReminders.length) attnParts.push({ label: `${plural(firedReminders.length, "reminder")} fired`, n: firedReminders.length });
  const attnShown = attnParts.slice(0, 2);
  const attnMore = attention.length - attnShown.reduce((s, p) => s + p.n, 0);
  const attnSub = [...attnShown.map(p => p.label), attnMore > 0 ? `${attnMore} more` : null].filter(Boolean).join(" · ");

  // ── Today's Overview: everything scheduled today, one chronological list. ───
  const tomorrowStr = new Date(nowMs + 86400000).toLocaleDateString("en-CA", { timeZone: BROWSER_TIMEZONE });
  const remindersToday = activeReminders.filter((r: any) => {
    const f = r.fireAt ? new Date(r.fireAt) : null;
    return f && !isNaN(f.getTime()) && f.toLocaleDateString("en-CA") === todayStr;
  });
  const todayEntries: TodayEntry[] = [
    // Timeline supplies events/bills for today; tasks come from /api/tasks so
    // completed-vs-pending state is authoritative (skip timeline task rows).
    ...todayItems.filter((i: any) => i.type !== "task").map((i: any) => ({
      id: String(i.id), title: i.title, kind: String(i.type), time: i.time || null,
      urgent: i.type === "bill" || i.type === "obligation",
      go: () => setPopup(i.type === "bill" || i.type === "obligation" ? "bills" : "events"),
    })),
    ...agendaTasks.map((t: any) => ({ id: `task-${t.id}`, title: t.title, kind: "task", time: null, go: () => setPopup("tasks") })),
    ...habitRows.map(h => ({ id: `habit-${h.id}`, title: h.name, kind: "habit", time: null, done: h.doneToday, go: () => setPopup("habits") })),
    ...remindersToday.map((r: any) => ({
      id: `rem-${r.id}`, title: r.title || r.message || r.content || "Reminder", kind: "reminder",
      time: r.fireAt ? new Date(r.fireAt).toTimeString().slice(0, 5) : null, go: () => setPopup("reminders"),
    })),
  ];
  const tomorrowEntries: TodayEntry[] = tl
    .filter((i: any) => (i.date || "").slice(0, 10) === tomorrowStr && !isLoanPayment(i)).slice(0, 8)
    .map((i: any) => ({ id: `tmw-${i.id}`, title: i.title, kind: String(i.type), time: i.time || null }));
  const todayRemainingTasks = agendaTasks.length;
  const todayDone = doneToday + habitsDone;
  // Day progress runs over COMPLETABLE items only (tasks + habits). Events,
  // bills and reminders in todayEntries have no done-state, so dividing by the
  // full entry list made "4 of 10 habits" render as 33% here while the Habits
  // popup said 40% on the same data — and the bar could never reach 100%.
  const todayCompletable = agendaTasks.length + doneToday + habitRows.length;
  const todayPct = todayCompletable > 0 ? Math.round((todayDone / todayCompletable) * 100) : 0;
  const timedRemaining = todayEntries.filter(e => e.time && !e.done).sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const nextTimed = timedRemaining.find(e => String(e.time) >= nowClock);
  const todayNextLabel = nextTimed
    ? `Next: ${nextTimed.title} · ${fmtClock(nextTimed.time)}`
    : agendaTasks[0] ? `Next: ${agendaTasks[0].title}`
    : nextFutureEvent ? `Next: ${nextFutureEvent.title} · ${dayLabel(String(nextFutureEvent.date).slice(0, 10), todayStr)}`
    : "Nothing scheduled today";
  const firstCritical = attention.find(i => i.severity === "critical");

  // AI Executive Brief — honest, instant bullets derived from the data above
  // (no per-load AI call). The AI chat can still create/modify any of the
  // underlying records; these lines just reflect the current state.
  const aiBrief: Array<{ text: string; tone?: "pos" | "neg" | "warn"; go?: () => void }> = [];
  // Lead bullet covers tasks AND bills: opening with a green "No overdue
  // tasks." while overdue bills sit two bullets down read as a contradiction.
  if (overdueTasks.length > 0) aiBrief.push({ text: `${overdueTasks.length} task${overdueTasks.length > 1 ? "s" : ""} overdue — start with “${overdueTasks[0].title}”.`, tone: "neg", go: () => setPopup("tasks") });
  else if (overdueBillCount > 0) aiBrief.push({ text: `No overdue to-do tasks, but ${plural(overdueBillCount, "overdue bill")} to pay.`, tone: "warn", go: () => setPopup("bills") });
  else aiBrief.push({ text: "Nothing overdue — tasks and bills are clear.", tone: "pos" });
  const soonestDoc = docs.slice().sort((a: any, b: any) => (a.daysUntil ?? 1e9) - (b.daysUntil ?? 1e9))[0];
  if (soonestDoc) aiBrief.push({ text: `${soonestDoc.documentName || soonestDoc.name || soonestDoc.fieldName || "A document"} ${soonestDoc.daysUntil < 0 ? `expired ${Math.abs(soonestDoc.daysUntil)} days ago` : soonestDoc.daysUntil === 0 ? "expires today" : `expires in ${soonestDoc.daysUntil} days`}.`, tone: soonestDoc.daysUntil <= 21 ? "neg" : "warn", go: () => setPopup("docs") });
  if (missedCount > 0) aiBrief.push({ text: `${missedCount} habit${missedCount > 1 ? "s" : ""} still due today.`, tone: "warn", go: () => setPopup("habits") });
  const soonestBill = bills.slice().sort((a: any, b: any) => (a.daysUntil ?? 1e9) - (b.daysUntil ?? 1e9))[0];
  if (soonestBill) aiBrief.push({ text: `${soonestBill.name} ($${Number(soonestBill.amount).toLocaleString()}) ${dueLabel(soonestBill.daysUntil)}.`, tone: soonestBill.daysUntil <= 1 ? "neg" : undefined, go: () => setPopup("bills") });
  for (const n of alerts.slice(0, 2)) aiBrief.push({ text: n.title, tone: "neg", go: () => goNotif(n) });
  if (birthdays[0]) aiBrief.push({ text: `${birthdays[0].title} ${relativeDay(daysLeft(birthdays[0].date.slice(0, 10)))}.`, tone: "warn", go: () => setPopup("events") });

  return (
    <div data-testid="executive-briefing">
      {/* STUCK-LOADING BANNER (2026-07-16): a tile must never say "loading"
          forever. If any feeding query is still unresolved after 12s, surface
          a Retry that cancels wedged requests and refetches what's on screen. */}
      {briefStuck && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2" data-testid="brief-stuck-banner">
          <span className="text-xs text-muted-foreground">Some sections are taking too long to load.</span>
          <button
            className="text-xs font-medium text-primary hover:underline shrink-0"
            onClick={() => { setBriefStuck(false); void recoverWedgedQueries(); }}
            data-testid="brief-stuck-retry"
          >Retry</button>
        </div>
      )}
      {/* Attention-first top grid (2026-07-16 redesign): row 1 = Attention /
          Tasks / Events, row 2 = Bills / Documents / Habits, then a full-width
          Today's Overview strip. Every card answers "what needs my attention,
          what's coming up, what's going wrong" — not just totals. The opaque
          Score tile is replaced by Attention Required (most prominent card);
          Projects moved down into the section grid (Open Projects).
          Loading-vs-empty (BUG-20260715-everyone-zeros): while a tile's query
          is still pending (cold Everyone switch, cold reload) it shows "…",
          never a hard 0 — a wall of zeros reads as "aggregation is broken". */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-2" data-testid="brief-stat-row">
        <StatTile prominent label="Attention"
          value={tasksPending || enhanced === undefined ? "…" : String(attention.length)}
          unit={tasksPending || enhanced === undefined ? undefined : attention.length > 0 ? (attention.length === 1 ? "item needs review" : "items need review") : undefined}
          sub={tasksPending || enhanced === undefined ? "loading" : attention.length === 0 ? "Nothing needs review" : attnSub}
          accent={attention.length === 0 ? "155 65% 45%" : attnCritical > 0 ? "0 72% 58%" : "43 96% 56%"}
          onClick={() => setPopup("attention")} testId="brief-stat-attention" />
        <StatTile label="Tasks"
          value={tasksPending ? "…" : String(agendaTasks.length)} unit={tasksPending ? undefined : "due today"}
          sub={tasksPending ? "loading"
            : overdueTasks.length || highCount ? `${overdueTasks.length} overdue · ${highCount} high priority`
            : doneToday > 0 ? `${plural(doneToday, "task")} completed today`
            : `${plural(pending.length, "open task")}`}
          accent={ACCENTS.tasks} onClick={() => setPopup("tasks")} testId="brief-stat-tasks" />
        <StatTile label="Events"
          value={timelinePending ? "…" : String(eventsToday.length)} unit={timelinePending ? undefined : "today"}
          sub={timelinePending ? "loading" : nextEventLabel}
          accent={ACCENTS.calendar} onClick={() => setPopup("events")} testId="brief-stat-events" />
        <StatTile label="Bills"
          value={enhanced === undefined ? "…" : `$${Math.round(billsUpcomingTotal).toLocaleString()}`}
          unit={enhanced === undefined ? undefined : "due soon"}
          sub={enhanced === undefined ? "loading"
            : overdueBillCount ? `${plural(overdueBillCount, "overdue bill")}${nextBillDate ? ` · next due ${nextBillDate}` : ""}`
            : nextBillDate ? `next due ${nextBillDate}`
            : "nothing due in 3 weeks"}
          accent={ACCENTS.bills} onClick={() => setPopup("bills")} testId="brief-stat-bills" />
        <StatTile label="Documents"
          value={enhanced === undefined ? "…" : String(docsSoonCount)}
          unit={enhanced === undefined ? undefined : docsSoonCount === 1 ? "needs attention" : "need attention"}
          sub={enhanced === undefined ? "loading" : nextDoc ? `${nextDoc.documentName || nextDoc.name || "Document"} ${docExpiryPhrase(nextDoc.daysUntil)}` : "all good"}
          accent={ACCENTS.docs} onClick={() => setPopup("docs")} testId="brief-stat-documents" />
        {/* Zero habits ≠ "all done" — it means nothing is scheduled. */}
        <StatTile label="Habits"
          value={habitsPending ? "…" : habitRows.length === 0 ? "—" : `${habitsDone} of ${habitRows.length}`}
          unit={habitsPending || habitRows.length === 0 ? undefined : "completed"}
          sub={habitsPending ? "loading" : habitRows.length === 0 ? "No habits scheduled today" : missedCount > 0 ? `${missedCount} remaining today` : "all done today"}
          accent={ACCENTS.habits} onClick={() => setPopup("habits")} testId="brief-stat-habits" />
      </div>

      {/* Today's Overview — full-width strip replacing the old Projects tile:
          next action, remaining work, the most urgent issue, day progress. */}
      <button onClick={() => setPopup("today")} data-testid="brief-today-card"
        className="w-full rounded-xl border px-3 py-2.5 text-left card-lift transition-all mb-2"
        style={{ borderColor: "hsl(262 80% 66% / 0.30)", background: "linear-gradient(135deg, hsl(262 80% 66% / 0.10) 0%, hsl(var(--card)) 70%)" }}>
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: "hsl(262 80% 66%)", boxShadow: "0 0 5px hsl(262 80% 66% / 0.7)" }} />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Today</span>
          {todayCompletable > 0 && <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">{todayPct}% done</span>}
        </div>
        <div className="mt-1 text-sm font-medium truncate" style={{ color: "hsl(262 80% 66%)" }}>
          {tasksPending || timelinePending ? "…" : todayNextLabel}
        </div>
        <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
          {plural(todayRemainingTasks, "task")} remaining
          {habitRows.length > 0 ? ` · ${plural(missedCount, "habit")} remaining` : ""}
          {todayDone > 0 ? ` · ${todayDone} done` : ""}
        </div>
        {firstCritical && (
          <div className="text-[11px] text-red-500 mt-0.5 truncate">⚠ {firstCritical.title} — {firstCritical.reason}</div>
        )}
        {todayCompletable > 0 && (
          <div className="mt-1.5 h-1 rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${todayPct}%`, background: "hsl(262 80% 66%)" }} />
          </div>
        )}
      </button>

      <div className="md:columns-2 xl:columns-3 gap-2">
        <Section id="alerts" title="AI Executive Brief" count={aiBrief.length} testId="brief-ai" defaultOpen>
          {aiBrief.length === 0 ? <Empty label="All clear." /> : (
            <div className="space-y-0.5 pb-0.5">
              {aiBrief.map((b, i) => (
                <button key={i} onClick={b.go} disabled={!b.go}
                  className={`w-full flex items-start gap-1.5 py-[3px] px-1 text-left text-xs rounded-sm ${b.go ? "hover:bg-muted/40" : ""} ${b.tone === "neg" ? "text-red-500" : b.tone === "warn" ? "text-amber-500" : b.tone === "pos" ? "text-emerald-500" : ""}`}>
                  <span className="mt-[3px]" style={{ color: "hsl(280 75% 66%)" }}>✦</span>
                  <span className="flex-1">{b.text}</span>
                </button>
              ))}
            </div>
          )}
        </Section>

        <Section id="agenda" title="Today's Agenda" count={todayItems.length + agendaTasks.length} testId="brief-agenda">
          {todayItems.length + agendaTasks.length === 0 ? <Empty label="Nothing scheduled today." /> : (
            <div className="divide-y divide-border/30">
              {todayItems.map((i: any) => (
                <Row key={i.id} testId={`brief-agenda-${i.id}`}
                  cells={[i.time || (i.allDay ? "all day" : "today"), i.title, i.type]}
                  urgent={i.type === "bill" || i.type === "obligation"}
                  onClick={() => i.type === "task" ? setPopup("tasks") : setPopup("events")} />
              ))}
              {agendaTasks.map((t: any) => (
                <Row key={t.id} testId={`brief-agenda-task-${t.id}`}
                  cells={["today", t.title, t.priority || "—"]}
                  onClick={() => setPopup("tasks")} />
              ))}
            </div>
          )}
        </Section>

        {/* One section, one answer. This used to count ONLY overdue tasks while
            wearing the unqualified title "Overdue" and the empty state
            "Nothing overdue. 🎉" — so it cheerfully declared all-clear on a
            screen where Attention, Bills, the brief above and the notification
            bell all reported four overdue bills worth ~$2,817. A user who read
            this card first stopped worrying and missed $2,500 of rent (audit
            finding D3). Bills and tasks are both overdue things; they belong to
            the same count. */}
        <Section id="overdue" title="Overdue" count={overdueTasks.length + overdueBills.length}
          testId="brief-overdue" defaultOpen={overdueTasks.length + overdueBills.length > 0}>
          {overdueTasks.length + overdueBills.length === 0 ? <Empty label="Nothing overdue. 🎉" /> : (
            <div className="divide-y divide-border/30">
              {overdueTasks.map((t: any) => (
                <Row key={t.id} testId={`brief-overdue-task-${t.id}`}
                  cells={[dayLabel(t.dueDate.slice(0, 10), todayStr), t.title, t.priority || "—"]}
                  urgent onClick={() => setPopup("tasks")} />
              ))}
              {overdueBills.map((b: any) => (
                <Row key={b.id} testId={`brief-overdue-bill-${b.id}`}
                  cells={["overdue", b.name, `$${Number(b.amount).toLocaleString()}`]}
                  urgent onClick={() => setPopup("bills")} />
              ))}
            </div>
          )}
        </Section>

        <Section id="tasks" title="Upcoming Tasks" count={upcomingTasks.length} testId="brief-tasks">
          {upcomingTasks.length === 0 ? <Empty label="No open tasks." /> : (
            <div className="divide-y divide-border/30">
              {upcomingTasks.map((t: any) => (
                <Row key={t.id} cells={[t.dueDate ? dayLabel(t.dueDate.slice(0, 10), todayStr) : "—", t.title, t.priority || "—"]}
                  onClick={() => setPopup("tasks")} />
              ))}
            </div>
          )}
        </Section>

        <Section id="priority" title="High Priority" count={highPriority.length} testId="brief-priority" defaultOpen={highPriority.length > 0}>
          {highPriority.length === 0 ? <Empty label="No high-priority items." /> : (
            <div className="divide-y divide-border/30">
              {highPriority.map((t: any) => (
                <Row key={t.id} cells={[t.dueDate ? dayLabel(t.dueDate.slice(0, 10), todayStr) : "—", t.title, "high"]}
                  valueTone="warn" onClick={() => setPopup("tasks")} />
              ))}
            </div>
          )}
        </Section>

        <Section id="habits" title={missedCount > 0 ? `Habits · ${missedCount} due` : "Habits"} count={habitRows.length} testId="brief-habits">
          {habitRows.length === 0 ? <Empty label="No habits yet." /> : (
            <div className="divide-y divide-border/30">
              {habitRows.map(h => (
                <Row key={h.id} cells={[h.doneToday ? "✓ done" : "✗ due", h.name, `${h.streak}🔥`]}
                  urgent={!h.doneToday} valueTone={h.streak > 0 ? "warn" : undefined}
                  onClick={() => setPopup("habits")} />
              ))}
            </div>
          )}
        </Section>

        <Section id="reminders" title="Reminders" count={activeReminders.length} testId="brief-reminders" defaultOpen={activeReminders.length > 0}>
          {activeReminders.length === 0 ? <Empty label="No reminders." /> : (
            <div className="divide-y divide-border/30">
              {activeReminders.map((r: any) => {
                // Reminders fire at a timestamp (fireAt), not a bare date.
                const fire = r.fireAt ? new Date(r.fireAt) : null;
                const when = fire && !isNaN(fire.getTime())
                  ? dayLabel(fire.toLocaleDateString("en-CA"), todayStr)
                  : "—";
                const time = fire && !isNaN(fire.getTime())
                  ? fire.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
                  : "";
                return (
                  <Row key={r.id} cells={[when, r.title || r.message || r.content, time]}
                    onClick={() => setPopup("reminders")} />
                );
              })}
            </div>
          )}
        </Section>

        <Section id="birthdays" title="Birthdays & Anniversaries" count={birthdays.length} testId="brief-birthdays" defaultOpen={birthdays.length > 0}>
          {birthdays.length === 0 ? <Empty label="None in the next 45 days." /> : (
            <div className="divide-y divide-border/30">
              {birthdays.map((i: any) => (
                <Row key={i.id} cells={[i.date?.slice(5, 10), i.title, `${daysLeft(i.date.slice(0, 10))}d`]}
                  onClick={() => setPopup("events")} />
              ))}
            </div>
          )}
        </Section>

        <Section id="appointments" title="Appointments" count={appointments.length} testId="brief-appointments" defaultOpen={appointments.length > 0}>
          {appointments.length === 0 ? <Empty label="No upcoming appointments." /> : (
            <div className="divide-y divide-border/30">
              {appointments.map((i: any) => (
                <Row key={i.id} cells={[i.date?.slice(5, 10), i.title, `${daysLeft(i.date.slice(0, 10))}d`]}
                  onClick={() => setPopup("events")} />
              ))}
            </div>
          )}
        </Section>

        <Section id="dates" title="Important Dates" count={importantDates.length} testId="brief-dates">
          {importantDates.length === 0 ? <Empty label="Nothing coming up." /> : (
            <div className="divide-y divide-border/30">
              {importantDates.map((i: any) => (
                <Row key={i.id} cells={[i.date?.slice(5, 10), i.title, `${daysLeft(i.date.slice(0, 10))}d`]}
                  onClick={() => setPopup("events")} />
              ))}
            </div>
          )}
        </Section>

        <Section id="docs" title="Document Expirations" count={docs.length} testId="brief-docs">
          {docs.length === 0 ? <Empty label="Nothing expiring soon." /> : (
            <div className="divide-y divide-border/30">
              {docs.map((d: any) => (
                <Row key={d.documentId || d.id}
                  cells={[d.expirationDate?.slice(5, 10) || "—", d.documentName || d.name || d.fieldName || "Document", relativeDay(d.daysUntil)]}
                  urgent={typeof d.daysUntil === "number" && d.daysUntil <= 21}
                  valueTone={typeof d.daysUntil === "number" && d.daysUntil <= 45 ? "warn" : undefined}
                  onClick={() => setPopup("docs")} />
              ))}
            </div>
          )}
        </Section>

        <Section id="bills" title="Bills & Obligations" count={bills.length} testId="brief-bills">
          {bills.length === 0 ? <Empty label="No bills due soon." /> : (
            <div className="divide-y divide-border/30">
              {bills.map((b: any) => (
                <div key={b.id} className="flex items-baseline gap-1">
                  <div className="flex-1 min-w-0">
                    <Row
                      cells={[b.status === "overdue" ? "overdue" : relativeDay(b.daysUntil), b.name, `$${Number(b.amount).toLocaleString()}`]}
                      urgent={b.status === "overdue" || b.daysUntil === 0}
                      valueTone="pos"
                      onClick={() => setPopup("bills")} />
                  </div>
                  {/* Two-tap pay (2026-07-29 tester report: rapid clicks landed
                      on re-sorted rows and paid Netflix/Gas by accident). The
                      first tap arms THIS bill id; only a second tap on the SAME
                      id records the payment — a shifted list can't misdirect it.
                      The label says "Mark paid", not "Pay": this records that a
                      payment happened, it does not move any money. */}
                  <button
                    onClick={() => {
                      if (armedPayId === b.id) { setArmedPayId(null); markPaid(b); }
                      else setArmedPayId(b.id);
                    }}
                    disabled={payPending}
                    className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded border shrink-0 ${
                      armedPayId === b.id
                        ? "border-emerald-500 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                        : "border-border hover:bg-muted"}`}
                    data-testid={`brief-pay-${b.id}`}
                  >{armedPayId === b.id ? `Mark $${Number(b.amount).toLocaleString()} paid?` : MARK_PAID_LABEL}</button>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section id="calendar" title="Calendar · Next 14d" count={calendarDays.length} testId="brief-calendar">
          {calendarDays.length === 0 ? <Empty label="Nothing scheduled." /> : (
            <div className="space-y-0.5">
              {calendarDays.map(d => (
                <div key={d.day}>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-1 pt-1">{d.day}</div>
                  {d.items.map((i: any) => (
                    <Row key={i.id} cells={[i.time || "", i.title]} onClick={() => setPopup("events")} />
                  ))}
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section id="notifications" title="Notifications" count={notifs.length} testId="brief-notifications" defaultOpen={alerts.length > 0}>
          {notifs.length === 0 ? <Empty label="All caught up." /> : (
            <div className="divide-y divide-border/30">
              {[...alerts, ...infoNotifs].map((n: any) => (
                <Row key={n.id} cells={[n.severity === "critical" ? "⚠" : n.severity === "warning" ? "!" : "·", n.title]}
                  urgent={n.severity === "critical"}
                  valueTone={n.severity === "warning" ? "warn" : undefined}
                  onClick={() => goNotif(n)} />
              ))}
            </div>
          )}
        </Section>

        {/* Progress is direction-aware AND clamped. This cell rendered an
            unclamped 106% for a weight-loss goal whose own modal said 100%
            (audit findings U3 / D2). */}
        <Section id="projects" title="Open Projects" count={projects.length} testId="brief-projects" defaultOpen={projects.length > 0}>
          {projects.length === 0 ? <Empty label="No active goals." /> : (
            <div className="divide-y divide-border/30">
              {projects.map((g: any) => (
                <Row key={g.id}
                  cells={["goal", g.title, g.target ? `${Math.round(goalProgress(g).percent)}%` : ""]}
                  valueTone="pos"
                  onClick={() => setPopup("projects")} />
              ))}
            </div>
          )}
        </Section>

        <Section id="activity" title="Recently Added" count={activity.length} testId="brief-activity" defaultOpen={false}>
          {activity.length === 0 ? <Empty label="No recent activity." /> : (
            <div className="divide-y divide-border/30">
              {activity.map((a: any, i: number) => (
                <Row key={i} cells={["✓", a.description]} valueTone="pos" />
              ))}
            </div>
          )}
        </Section>

        <Section id="notes" title="Quick Notes" count={notes.length} testId="brief-notes" defaultOpen={false}>
          {notes.length === 0 ? <Empty label="No notes." /> : (
            <div className="divide-y divide-border/30">
              {notes.map((n: any) => (
                <Row key={n.id} cells={[String(n.date || n.createdAt || "").slice(5, 10), String(n.content || "").slice(0, 90)]}
                  onClick={() => setPopup("notes")} />
              ))}
            </div>
          )}
        </Section>
      </div>

      {/* The SAME popups the dashboard KPI tiles use — statically imported here
          (part of the dashboard chunk), so a row click always opens them even
          if a lazy chunk fetch would have failed. */}
      {popup === "tasks" && <TasksPopup open onClose={() => setPopup(null)} filterMode={mode} filterIds={ids} />}
      {popup === "habits" && <HabitsPopup open onClose={() => setPopup(null)} filterMode={mode} filterIds={ids} />}
      {popup === "bills" && <BillsPopup open onClose={() => setPopup(null)} bills={allBills} />}
      {popup === "events" && <EventsPopup open onClose={() => setPopup(null)} items={tl} todayStr={todayStr} />}
      {popup === "docs" && <DocsPopup open onClose={() => setPopup(null)} docs={allExpiringDocs} />}
      {popup === "projects" && <ProjectsPopup open onClose={() => setPopup(null)} goals={goals} />}
      {popup === "notes" && <NotesPopup open onClose={() => setPopup(null)} notes={(journal || []).slice(0, 20)} />}
      {popup === "reminders" && <RemindersPopup open onClose={() => setPopup(null)} reminders={reminders} />}
      {popup === "attention" && <AttentionPopup open onClose={() => setPopup(null)} items={attention} />}
      {popup === "today" && (
        <TodayOverviewPopup open onClose={() => setPopup(null)} entries={todayEntries}
          tomorrow={tomorrowEntries} completedTasks={doneToday}
          alerts={attention.filter(i => i.severity === "critical").slice(0, 3).map(i => `${i.title} — ${i.reason}`)} />
      )}
    </div>
  );
}
