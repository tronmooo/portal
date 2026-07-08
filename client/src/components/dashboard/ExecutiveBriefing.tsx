// ── Executive briefing (2026-07-08) ──────────────────────────────────────────
// The dense, spreadsheet-style daily briefing the Executive tab leads with:
// compact rows, thin dividers, mono headers, no big cards or charts. Every
// section is collapsible; every row opens the EXISTING popup/surface for its
// module (TasksPopup, HabitsPopup, documents, calendar, finance…) — nothing
// here duplicates functionality. Data comes from the same profile-scoped
// query keys the dashboard already uses, so on the happy path this renders
// from cache.
import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ChevronDown } from "lucide-react";
import { TasksPopup, HabitsPopup } from "@/components/dashboard/TaskHabitPopups";
import type { DashboardStats } from "@shared/schema";

type PopupKind = "tasks" | "habits" | null;

function Section({ title, count, children, defaultOpen = true, testId }: {
  title: string; count?: number; children: React.ReactNode; defaultOpen?: boolean; testId: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border/40 pb-1.5" data-testid={testId}>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 py-1.5 text-left group"
        aria-expanded={open}
      >
        <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-muted-foreground group-hover:text-foreground transition-colors">{title}</span>
        {typeof count === "number" && count > 0 && (
          <span className="text-[10px] font-mono px-1.5 rounded-full bg-muted text-muted-foreground">{count}</span>
        )}
        <ChevronDown className={`h-3 w-3 ml-auto text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && children}
    </div>
  );
}

function Row({ cells, onClick, testId, urgent }: {
  cells: React.ReactNode[]; onClick?: () => void; testId?: string; urgent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className={`w-full grid items-baseline gap-2 py-[3px] px-1 text-left text-xs hover:bg-muted/40 rounded-sm ${urgent ? "text-red-500" : ""}`}
      style={{ gridTemplateColumns: `5rem 1fr ${cells.length > 2 ? "auto" : ""} ${cells.length > 3 ? "auto" : ""}`.trim() }}
    >
      {cells.map((c, i) => (
        <span key={i} className={i === 0 ? "font-mono text-[10px] uppercase text-muted-foreground truncate" : i === 1 ? "truncate" : "font-mono text-[11px] tabular-nums text-right shrink-0"}>{c}</span>
      ))}
    </button>
  );
}

const Empty = ({ label }: { label: string }) => (
  <p className="text-[11px] text-muted-foreground py-1 px-1">{label}</p>
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
  const in14 = new Date(Date.now() + 14 * 86400000).toLocaleDateString("en-CA", { timeZone: BROWSER_TIMEZONE });

  const { data: tasks = [] } = useQuery<any[]>({
    queryKey: ["/api/tasks", mode, ...ids],
    queryFn: () => apiRequest("GET", `/api/tasks${param}`).then(r => r.json()),
    staleTime: 30_000,
  });
  const { data: habits = [] } = useQuery<any[]>({
    queryKey: ["/api/habits", mode, ...ids],
    queryFn: () => apiRequest("GET", `/api/habits${param}`).then(r => r.json()),
    staleTime: 30_000,
  });
  const { data: timeline = [] } = useQuery<any[]>({
    queryKey: ["/api/calendar/timeline", todayStr, in14, mode, ...ids],
    queryFn: () => apiRequest("GET", `/api/calendar/timeline${param}${amp}start=${todayStr}&end=${in14}`).then(r => r.json()),
    staleTime: 60_000,
  });
  const { data: reminders = [] } = useQuery<any[]>({
    queryKey: ["/api/reminders"],
    queryFn: () => apiRequest("GET", "/api/reminders").then(r => r.json()).catch(() => []),
    staleTime: 60_000,
  });
  const { data: goals = [] } = useQuery<any[]>({
    queryKey: ["/api/goals", mode, ...ids],
    queryFn: () => apiRequest("GET", `/api/goals${param}`).then(r => r.json()),
    staleTime: 60_000,
  });
  const { data: journal = [] } = useQuery<any[]>({
    queryKey: ["/api/journal", mode, ...ids],
    queryFn: () => apiRequest("GET", `/api/journal${param}`).then(r => r.json()).catch(() => []),
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

  // ── Derivations (all from data above) ──────────────────────────────────────
  const pending = (tasks || []).filter((t: any) => t.status !== "done");
  const agendaTasks = pending.filter((t: any) => t.dueDate && t.dueDate.slice(0, 10) <= todayStr);
  const todayItems = (timeline || []).filter((i: any) => (i.date || "").slice(0, 10) === todayStr);
  const upcomingTasks = pending
    .slice()
    .sort((a: any, b: any) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"))
    .slice(0, 15);
  const habitRows = (habits || []).slice(0, 12).map((h: any) => {
    const doneToday = (h.checkins || []).some((c: any) => (c.date || "").slice(0, 10) === todayStr);
    return { id: h.id, name: h.name, doneToday, streak: h.currentStreak ?? h.streak ?? 0 };
  });
  const bills = (enhanced?.financeSnapshot?.upcomingBills || []).filter((b: any) => b.daysUntil <= 21).slice(0, 10);
  const docs = (enhanced?.expiringDocuments || []).slice(0, 10);
  const importantDates = (timeline || [])
    .filter((i: any) => i.type === "event" && (i.date || "").slice(0, 10) > todayStr)
    .slice(0, 10);
  const calendarDays: Array<{ day: string; items: any[] }> = [];
  for (const item of timeline || []) {
    const d = (item.date || "").slice(0, 10);
    if (!d) continue;
    const label = dayLabel(d, todayStr);
    const bucket = calendarDays.find(b => b.day === label);
    if (bucket) { if (bucket.items.length < 4) bucket.items.push(item); }
    else if (calendarDays.length < 7) calendarDays.push({ day: label, items: [item] });
  }
  const projects = (goals || []).filter((g: any) => g.status === "active" || !g.status).slice(0, 8);
  const activity = (stats?.recentActivity || []).slice(0, 8);
  const notes = (journal || []).slice(0, 4);
  const activeReminders = (Array.isArray(reminders) ? reminders : []).filter((r: any) => !r.completed && !r.dismissed).slice(0, 8);

  const daysLeft = (dateStr: string) => Math.max(0, Math.round((new Date(dateStr + "T00:00:00").getTime() - new Date(todayStr + "T00:00:00").getTime()) / 86400000));

  return (
    <div className="space-y-1" data-testid="executive-briefing">
      <Section title="Today's Agenda" count={todayItems.length + agendaTasks.length} testId="brief-agenda">
        {todayItems.length + agendaTasks.length === 0 ? <Empty label="Nothing scheduled today." /> : (
          <div className="divide-y divide-border/30">
            {todayItems.map((i: any) => (
              <Row key={i.id} testId={`brief-agenda-${i.id}`}
                cells={[i.time || (i.allDay ? "all day" : "today"), i.title, i.type]}
                urgent={i.type === "bill" || i.type === "obligation"}
                onClick={() => i.type === "task" ? setPopup("tasks") : navigate("/calendar")} />
            ))}
            {agendaTasks.map((t: any) => (
              <Row key={t.id} testId={`brief-agenda-task-${t.id}`}
                cells={[t.dueDate?.slice(0, 10) < todayStr ? "overdue" : "today", t.title, t.priority || "—"]}
                urgent={t.dueDate?.slice(0, 10) < todayStr}
                onClick={() => setPopup("tasks")} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Upcoming Tasks" count={upcomingTasks.length} testId="brief-tasks">
        {upcomingTasks.length === 0 ? <Empty label="No open tasks." /> : (
          <div className="divide-y divide-border/30">
            {upcomingTasks.map((t: any) => (
              <Row key={t.id} cells={[t.dueDate ? dayLabel(t.dueDate.slice(0, 10), todayStr) : "—", t.title, t.priority || "—"]}
                urgent={!!t.dueDate && t.dueDate.slice(0, 10) < todayStr}
                onClick={() => setPopup("tasks")} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Habits" count={habitRows.length} testId="brief-habits">
        {habitRows.length === 0 ? <Empty label="No habits yet." /> : (
          <div className="divide-y divide-border/30">
            {habitRows.map(h => (
              <Row key={h.id} cells={[h.doneToday ? "✓ done" : "✗ due", h.name, `${h.streak}🔥`]}
                urgent={!h.doneToday}
                onClick={() => setPopup("habits")} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Reminders" count={activeReminders.length} testId="brief-reminders" defaultOpen={activeReminders.length > 0}>
        {activeReminders.length === 0 ? <Empty label="No reminders." /> : (
          <div className="divide-y divide-border/30">
            {activeReminders.map((r: any) => (
              <Row key={r.id} cells={[r.dueDate ? dayLabel(String(r.dueDate).slice(0, 10), todayStr) : "—", r.title || r.message || r.content]}
                onClick={() => navigate("/calendar")} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Important Dates" count={importantDates.length} testId="brief-dates">
        {importantDates.length === 0 ? <Empty label="Nothing in the next two weeks." /> : (
          <div className="divide-y divide-border/30">
            {importantDates.map((i: any) => (
              <Row key={i.id} cells={[i.date?.slice(5, 10), i.title, `${daysLeft(i.date.slice(0, 10))}d`]}
                onClick={() => navigate("/calendar")} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Document Expirations" count={docs.length} testId="brief-docs">
        {docs.length === 0 ? <Empty label="Nothing expiring soon." /> : (
          <div className="divide-y divide-border/30">
            {docs.map((d: any) => (
              <Row key={d.documentId || d.id}
                cells={[d.expirationDate?.slice(5, 10) || "—", d.name || d.fieldName || "Document", `${d.daysUntil}d`]}
                urgent={typeof d.daysUntil === "number" && d.daysUntil <= 21}
                onClick={() => d.documentId && navigate(`/documents/${d.documentId}`)} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Bills & Obligations" count={bills.length} testId="brief-bills">
        {bills.length === 0 ? <Empty label="No bills due soon." /> : (
          <div className="divide-y divide-border/30">
            {bills.map((b: any) => (
              <div key={b.id} className="flex items-baseline gap-2">
                <div className="flex-1 min-w-0">
                  <Row
                    cells={[b.status === "overdue" ? "overdue" : b.daysUntil === 0 ? "today" : `${b.daysUntil}d`, b.name, `$${Number(b.amount).toLocaleString()}`]}
                    urgent={b.status === "overdue" || b.daysUntil === 0}
                    onClick={() => b.linkedLiabilityId ? navigate(`/profiles/${b.linkedLiabilityId}`) : navigate("/dashboard/finance")} />
                </div>
                <button
                  onClick={() => payBill.mutate(b.id)}
                  disabled={payBill.isPending}
                  className="text-[10px] font-mono uppercase px-2 py-0.5 rounded border border-border hover:bg-muted shrink-0"
                  data-testid={`brief-pay-${b.id}`}
                >Pay</button>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Calendar · Next 14d" count={calendarDays.length} testId="brief-calendar">
        {calendarDays.length === 0 ? <Empty label="Nothing scheduled." /> : (
          <div className="space-y-1">
            {calendarDays.map(d => (
              <div key={d.day}>
                <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground px-1 pt-1">{d.day}</div>
                {d.items.map((i: any) => (
                  <Row key={i.id} cells={[i.time || "", i.title]} onClick={() => navigate("/calendar")} />
                ))}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Open Projects" count={projects.length} testId="brief-projects" defaultOpen={projects.length > 0}>
        {projects.length === 0 ? <Empty label="No active goals." /> : (
          <div className="divide-y divide-border/30">
            {projects.map((g: any) => (
              <Row key={g.id}
                cells={["goal", g.title, g.target ? `${Math.round(((g.current ?? 0) / g.target) * 100)}%` : ""]}
                onClick={() => navigate("/goals")} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Recent Activity" count={activity.length} testId="brief-activity" defaultOpen={false}>
        {activity.length === 0 ? <Empty label="No recent activity." /> : (
          <div className="divide-y divide-border/30">
            {activity.map((a: any, i: number) => (
              <Row key={i} cells={["✓", a.description]} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Quick Notes" count={notes.length} testId="brief-notes" defaultOpen={false}>
        {notes.length === 0 ? <Empty label="No notes." /> : (
          <div className="divide-y divide-border/30">
            {notes.map((n: any) => (
              <Row key={n.id} cells={[String(n.date || n.createdAt || "").slice(5, 10), String(n.content || "").slice(0, 90)]}
                onClick={() => navigate("/journal")} />
            ))}
          </div>
        )}
      </Section>

      {popup === "tasks" && <TasksPopup open onClose={() => setPopup(null)} filterMode={mode} filterIds={ids} />}
      {popup === "habits" && <HabitsPopup open onClose={() => setPopup(null)} filterMode={mode} filterIds={ids} />}
    </div>
  );
}
