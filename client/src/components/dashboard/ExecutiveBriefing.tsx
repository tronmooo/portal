// ── Executive briefing (2026-07-08, v2 multi-column) ─────────────────────────
// Dense, colorful command-center layout: compact spreadsheet-like sections in
// a responsive masonry (1/2/3 columns), each with a colored accent dot, thin
// dividers, mono headers, minimal whitespace. Every section is collapsible and
// every row opens the EXISTING popup/surface for its module — TasksPopup and
// HabitsPopup are the same components the dashboard KPI tiles always used
// (extracted to TaskHabitPopups.tsx), documents/bills/calendar/journal rows
// deep-link to their existing surfaces. Nothing here duplicates functionality.
import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { loadDocSnoozeMap } from "@/lib/docSnooze";
import { ChevronDown } from "lucide-react";
import { TasksPopup, HabitsPopup } from "@/components/dashboard/TaskHabitPopups";
import { BillsPopup, EventsPopup, DocsPopup, ProjectsPopup, NotesPopup, RemindersPopup } from "@/components/dashboard/BriefingPopups";
import type { DashboardStats } from "@shared/schema";

type PopupKind = "tasks" | "habits" | "bills" | "events" | "docs" | "projects" | "notes" | "reminders" | null;

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

// Photo-2-style top stat tile — big count, small sub-line, clickable.
function StatTile({ label, value, sub, accent, onClick, testId }: {
  label: string; value: string; sub?: string; accent: string;
  onClick: () => void; testId: string;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className="flex-1 min-w-[7.5rem] rounded-xl border px-2.5 py-2 text-left card-lift transition-all"
      style={{ borderColor: `hsl(${accent} / 0.30)`, background: `linear-gradient(135deg, hsl(${accent} / 0.12) 0%, hsl(var(--card)) 75%)` }}
    >
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: `hsl(${accent})`, boxShadow: `0 0 5px hsl(${accent} / 0.7)` }} />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      <div className="metric-value text-xl mt-0.5" style={{ color: `hsl(${accent})` }}>{value}</div>
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

export function ExecutiveBriefing({ filterMode, filterIds, stats, enhanced }: {
  filterMode: string; filterIds: string[];
  stats: DashboardStats | undefined; enhanced: any;
}) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [popup, setPopup] = useState<PopupKind>(null);
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
  const { data: tasks = [], isPending: tasksPending } = useQuery<any[]>({
    queryKey: ["/api/tasks", mode, ...ids],
    queryFn: () => apiRequest("GET", `/api/tasks${param}`).then(r => r.json()),
    staleTime: 30_000,
  });
  const { data: habits = [], isPending: habitsPending } = useQuery<any[]>({
    queryKey: ["/api/habits", mode, ...ids],
    queryFn: () => apiRequest("GET", `/api/habits${param}`).then(r => r.json()),
    staleTime: 30_000,
  });
  // 45-day window: agenda + calendar preview slice ≤14d from it; birthdays /
  // appointments / important dates get the longer horizon. One fetch.
  const { data: timeline = [], isPending: timelinePending } = useQuery<any[]>({
    queryKey: ["/api/calendar/timeline", todayStr, in45, mode, ...ids],
    queryFn: () => apiRequest("GET", `/api/calendar/timeline${param}${amp}start=${todayStr}&end=${in45}`).then(r => r.json()),
    staleTime: 60_000,
  });
  // Reminders are profile-scoped like every other briefing section — pass the
  // active filter so a selected profile shows only its own reminders (the
  // server enforces strict isolation; unlinked reminders appear only in the
  // unfiltered "Everyone" view). Keying on mode/ids makes switching profiles
  // refetch instead of showing another profile's cached reminders.
  const { data: reminders = [] } = useQuery<any[]>({
    queryKey: ["/api/reminders", mode, ...ids],
    queryFn: () => apiRequest("GET", `/api/reminders${param}`).then(r => r.json()),
    staleTime: 60_000,
  });
  const { data: goals = [], isPending: goalsPending } = useQuery<any[]>({
    queryKey: ["/api/goals", mode, ...ids],
    queryFn: () => apiRequest("GET", `/api/goals${param}`).then(r => r.json()),
    staleTime: 60_000,
  });
  const { data: journal = [] } = useQuery<any[]>({
    queryKey: ["/api/journal", mode, ...ids],
    queryFn: () => apiRequest("GET", `/api/journal${param}`).then(r => r.json()),
    staleTime: 60_000,
  });
  const { data: notifications = [] } = useQuery<any[]>({
    queryKey: ["/api/notifications", mode, ...ids],
    queryFn: () => apiRequest("GET", `/api/notifications${param}`).then(r => r.json()),
    staleTime: 60_000,
  });

  const payBill = useMutation({
    mutationFn: async (id: string) => { await apiRequest("POST", `/api/obligations/${id}/pay`, {}); },
    onSuccess: () => {
      toast({ title: "Payment recorded" });
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
    },
    onError: () => toast({ title: "Payment failed", variant: "destructive" }),
  });

  // ── Derivations ─────────────────────────────────────────────────────────────
  const pending = (tasks || []).filter((t: any) => t.status !== "done");
  const overdueTasks = pending.filter((t: any) => t.dueDate && t.dueDate.slice(0, 10) < todayStr)
    .sort((a: any, b: any) => (a.dueDate || "").localeCompare(b.dueDate || "")).slice(0, 10);
  const highPriority = pending.filter((t: any) => ["high", "urgent"].includes(String(t.priority || "").toLowerCase()) && !(t.dueDate && t.dueDate.slice(0, 10) < todayStr)).slice(0, 8);
  const agendaTasks = pending.filter((t: any) => t.dueDate && t.dueDate.slice(0, 10) === todayStr);
  const upcomingTasks = pending
    .filter((t: any) => !t.dueDate || t.dueDate.slice(0, 10) >= todayStr)
    .sort((a: any, b: any) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999")).slice(0, 12);

  const tl = (timeline || []).filter((i: any) => (i.date || "").slice(0, 10) >= todayStr);
  const todayItems = tl.filter((i: any) => (i.date || "").slice(0, 10) === todayStr);
  const events = tl.filter((i: any) => i.type === "event" && (i.date || "").slice(0, 10) > todayStr);
  const birthdays = events.filter((i: any) => BIRTHDAY_RE.test(`${i.title} ${i.category || ""}`)).slice(0, 8);
  const appointments = events.filter((i: any) => APPT_RE.test(`${i.title} ${i.category || ""}`)).slice(0, 8);
  const importantDates = events.filter((i: any) => !BIRTHDAY_RE.test(`${i.title} ${i.category || ""}`) && !APPT_RE.test(`${i.title} ${i.category || ""}`)).slice(0, 10);
  // EVENTS count (top tile) must count only real calendar EVENTS in the next
  // 14 days — not tasks / bills / obligations that also live in the timeline.
  // Counting `tl.length` made the tile read "3 events" for a profile whose only
  // timeline items were a mortgage bill and a task (BUG-20260709: "3 events even
  // when Mike has no events"). Every timeline item is already profile-scoped by
  // the server, so this is purely a count-semantics fix.
  const eventCount = tl.filter((i: any) => i.type === "event" && (i.date || "").slice(0, 10) <= in14).length;

  const habitRows = (habits || []).slice(0, 12).map((h: any) => {
    const doneToday = (h.checkins || []).some((c: any) => (c.date || "").slice(0, 10) === todayStr);
    return { id: h.id, name: h.name, doneToday, streak: h.currentStreak ?? h.streak ?? 0 };
  });
  const missedCount = habitRows.filter(h => !h.doneToday).length;

  const bills = (enhanced?.financeSnapshot?.upcomingBills || []).filter((b: any) => b.daysUntil <= 21).slice(0, 10);
  // Docs: respect the shared 30-day dismisses (same map the KPI section and
  // DocsPopup use) so a dismissed alert disappears everywhere at once. The
  // tile counts the 30-day "expiring soon" window (expired + ≤30d); the
  // section/popup still list the longer 90-day horizon grouped by urgency.
  const docSnooze = loadDocSnoozeMap();
  const allExpiringDocs = (enhanced?.expiringDocuments || []).filter((d: any) => !docSnooze[d.documentId]);
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
  const activeReminders = (Array.isArray(reminders) ? reminders : []).filter((r: any) => !r.completed && !r.dismissed).slice(0, 8);
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

  // ── Executive Score (transparent derivation, presentation-only): start at
  // 100, subtract for overdue tasks / missed habits / overdue bills.
  const overdueBillCount = bills.filter((b: any) => b.status === "overdue").length;
  const score = Math.max(40, Math.min(100,
    100 - Math.min(40, overdueTasks.length * 8) - Math.min(20, missedCount * 4) - Math.min(30, overdueBillCount * 10)));
  const scoreLabel = score >= 90 ? "Excellent" : score >= 75 ? "Good" : "Needs attention";
  // Only show a score when there is actually something to evaluate. A brand-new
  // or empty profile has no tasks / habits / bills, so a "100 · Excellent" tile
  // reads as fake/leaked data (BUG-20260709: empty profile looked populated).
  // With no inputs, show an em dash instead.
  const hasScoreInputs = pending.length > 0 || habitRows.length > 0 || bills.length > 0;
  const billsUpcomingTotal = bills.reduce((s: number, b: any) => s + (Number(b.amount) || 0), 0);
  const doneToday = (tasks || []).filter((t: any) => t.status === "done" && String(t.completedAt || t.updatedAt || "").slice(0, 10) === todayStr).length;

  // AI Executive Brief — honest, instant bullets derived from the data above
  // (no per-load AI call). The AI chat can still create/modify any of the
  // underlying records; these lines just reflect the current state.
  const aiBrief: Array<{ text: string; tone?: "pos" | "neg" | "warn"; go?: () => void }> = [];
  if (overdueTasks.length === 0) aiBrief.push({ text: "No overdue tasks.", tone: "pos" });
  else aiBrief.push({ text: `${overdueTasks.length} task${overdueTasks.length > 1 ? "s" : ""} overdue — start with “${overdueTasks[0].title}”.`, tone: "neg", go: () => setPopup("tasks") });
  const soonestDoc = docs.slice().sort((a: any, b: any) => (a.daysUntil ?? 1e9) - (b.daysUntil ?? 1e9))[0];
  if (soonestDoc) aiBrief.push({ text: `${soonestDoc.documentName || soonestDoc.name || soonestDoc.fieldName || "A document"} ${soonestDoc.daysUntil < 0 ? `expired ${Math.abs(soonestDoc.daysUntil)} days ago` : soonestDoc.daysUntil === 0 ? "expires today" : `expires in ${soonestDoc.daysUntil} days`}.`, tone: soonestDoc.daysUntil <= 21 ? "neg" : "warn", go: () => setPopup("docs") });
  if (missedCount > 0) aiBrief.push({ text: `${missedCount} habit${missedCount > 1 ? "s" : ""} still due today.`, tone: "warn", go: () => setPopup("habits") });
  const soonestBill = bills.slice().sort((a: any, b: any) => (a.daysUntil ?? 1e9) - (b.daysUntil ?? 1e9))[0];
  if (soonestBill) aiBrief.push({ text: `${soonestBill.name} ($${Number(soonestBill.amount).toLocaleString()}) due ${soonestBill.daysUntil === 0 ? "today" : `in ${soonestBill.daysUntil}d`}.`, tone: soonestBill.daysUntil <= 1 ? "neg" : undefined, go: () => setPopup("bills") });
  for (const n of alerts.slice(0, 2)) aiBrief.push({ text: n.title, tone: "neg", go: () => goNotif(n) });
  if (birthdays[0]) aiBrief.push({ text: `${birthdays[0].title} in ${daysLeft(birthdays[0].date.slice(0, 10))} days.`, tone: "warn", go: () => setPopup("events") });

  return (
    <div data-testid="executive-briefing">
      {/* Top stat tiles (photo-2 style) — every tile drills into its module.
          Loading-vs-empty (BUG-20260715-everyone-zeros): while a tile's query
          is still pending (cold Everyone switch, cold reload) it shows "…",
          never a hard 0 — a wall of zeros reads as "aggregation is broken". */}
      <div className="flex flex-wrap gap-2 mb-2" data-testid="brief-stat-row">
        <StatTile label="Score" value={tasksPending ? "…" : hasScoreInputs ? String(score) : "—"} sub={tasksPending ? "loading" : hasScoreInputs ? `${scoreLabel} · ${overdueTasks.length} critical` : "No data yet"} accent={!hasScoreInputs ? "240 10% 60%" : score >= 90 ? "155 65% 45%" : score >= 75 ? "43 96% 56%" : "0 72% 58%"} onClick={() => setPopup("tasks")} testId="brief-stat-score" />
        <StatTile label="Tasks" value={tasksPending ? "…" : String(pending.length)} sub={tasksPending ? "loading" : `${agendaTasks.length} today · ${overdueTasks.length} overdue`} accent={ACCENTS.tasks} onClick={() => setPopup("tasks")} testId="brief-stat-tasks" />
        <StatTile label="Habits" value={habitsPending ? "…" : `${habitRows.length - missedCount}/${habitRows.length}`} sub={habitsPending ? "loading" : missedCount > 0 ? `${missedCount} still due` : "all done"} accent={ACCENTS.habits} onClick={() => setPopup("habits")} testId="brief-stat-habits" />
        <StatTile label="Bills" value={enhanced === undefined ? "…" : String(bills.length)} sub={enhanced === undefined ? "loading" : `$${Math.round(billsUpcomingTotal).toLocaleString()} upcoming`} accent={ACCENTS.bills} onClick={() => setPopup("bills")} testId="brief-stat-bills" />
        <StatTile label="Docs" value={enhanced === undefined ? "…" : String(docsSoonCount)} sub={enhanced === undefined ? "loading" : docsSoonCount ? "≤30d window" : "all good"} accent={ACCENTS.docs} onClick={() => setPopup("docs")} testId="brief-stat-docs" />
        <StatTile label="Events" value={timelinePending ? "…" : String(eventCount)} sub="next 14 days" accent={ACCENTS.calendar} onClick={() => setPopup("events")} testId="brief-stat-events" />
        <StatTile label="Projects" value={goalsPending ? "…" : String(projects.length)} sub={goalsPending ? "loading" : `${doneToday} done today`} accent={ACCENTS.projects} onClick={() => setPopup("projects")} testId="brief-stat-projects" />
      </div>

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

        <Section id="overdue" title="Overdue" count={overdueTasks.length} testId="brief-overdue" defaultOpen={overdueTasks.length > 0}>
          {overdueTasks.length === 0 ? <Empty label="Nothing overdue. 🎉" /> : (
            <div className="divide-y divide-border/30">
              {overdueTasks.map((t: any) => (
                <Row key={t.id} cells={[dayLabel(t.dueDate.slice(0, 10), todayStr), t.title, t.priority || "—"]}
                  urgent onClick={() => setPopup("tasks")} />
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
              {activeReminders.map((r: any) => (
                <Row key={r.id} cells={[r.dueDate ? dayLabel(String(r.dueDate).slice(0, 10), todayStr) : "—", r.title || r.message || r.content]}
                  onClick={() => setPopup("reminders")} />
              ))}
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
                  cells={[d.expirationDate?.slice(5, 10) || "—", d.documentName || d.name || d.fieldName || "Document", `${d.daysUntil}d`]}
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
                      cells={[b.status === "overdue" ? "overdue" : b.daysUntil === 0 ? "today" : `${b.daysUntil}d`, b.name, `$${Number(b.amount).toLocaleString()}`]}
                      urgent={b.status === "overdue" || b.daysUntil === 0}
                      valueTone="pos"
                      onClick={() => setPopup("bills")} />
                  </div>
                  <button
                    onClick={() => payBill.mutate(b.id)}
                    disabled={payBill.isPending}
                    className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded border border-border hover:bg-muted shrink-0"
                    data-testid={`brief-pay-${b.id}`}
                  >Pay</button>
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

        <Section id="projects" title="Open Projects" count={projects.length} testId="brief-projects" defaultOpen={projects.length > 0}>
          {projects.length === 0 ? <Empty label="No active goals." /> : (
            <div className="divide-y divide-border/30">
              {projects.map((g: any) => (
                <Row key={g.id}
                  cells={["goal", g.title, g.target ? `${Math.round(((g.current ?? 0) / g.target) * 100)}%` : ""]}
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
      {popup === "bills" && <BillsPopup open onClose={() => setPopup(null)} bills={enhanced?.financeSnapshot?.upcomingBills || []} />}
      {popup === "events" && <EventsPopup open onClose={() => setPopup(null)} items={tl} todayStr={todayStr} />}
      {popup === "docs" && <DocsPopup open onClose={() => setPopup(null)} docs={allExpiringDocs} />}
      {popup === "projects" && <ProjectsPopup open onClose={() => setPopup(null)} goals={goals} />}
      {popup === "notes" && <NotesPopup open onClose={() => setPopup(null)} notes={(journal || []).slice(0, 20)} />}
      {popup === "reminders" && <RemindersPopup open onClose={() => setPopup(null)} reminders={reminders} />}
    </div>
  );
}
