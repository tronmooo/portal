// The parts of a custom AI Mode that read or write the person's own records
// (shared/ai-modes.ts):
//   ChartsTab   — graphs over trackers and readings, drawn by the Wellness
//                 widget system (H1/H3: one system, one `summarize`); health
//                 is read for ONE person, the account holder (H10).
//   LogTab      — a form that saves an entry to the mode's tracker; the
//                 tracker is created only on the person's tap (Rule 11 reuses
//                 one with the same name).
//   Reminders   — a reminder is a real recurring task; on/off is read from
//                 the task list (tag `ai-mode:<mode>:<reminder>`), never
//                 stored (Rule 5). Turning one off takes two taps (Rule 8).
// Every list here is an error with a retry when it fails, never empty (Rule 7);
// opening writes nothing (Rule 3).
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, Loader2, Plus } from "lucide-react";
import { apiRequest, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import { aiErrorText } from "@/components/workspace/WorkspaceShell";
import { LoadError, TabPage } from "@/components/workspace/WorkspaceApp";
import { WellnessWidgetCardBody } from "@/components/wellness/WellnessCustomize";
import { getUserToday } from "@shared/timezone";
import { collectMetrics, resolveWellnessSubject, belongsToSubject } from "@shared/wellness-readout";
import { findTrackerByName, wellnessWidgetNeeds, type WellnessSourceData } from "@shared/wellness-widgets";
import { WELLNESS_RANGES, type WellnessRange } from "@shared/wellness-period";
import { reminderTask, reminderTaskTag, type AiMode, type ModeReminder, type ModeTab } from "@shared/ai-modes";

const RANGE_LABEL: Record<WellnessRange, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days", "1y": "1 year", all: "All" };

const list = (endpoint: string) => async () => {
  const data = await apiRequest("GET", endpoint).then((r) => r.json());
  if (!Array.isArray(data)) throw new Error("Unexpected response");
  return data as any[];
};

/** The account holder's trackers (health is one person's — H10). */
export function useOwnTrackers() {
  const trackersQ = useQuery<any[]>({ queryKey: ["/api/trackers", "everyone", "ai-mode"], queryFn: list("/api/trackers"), staleTime: 60_000 });
  const peopleQ = useQuery<any[]>({ queryKey: ["/api/profiles", "lite"], queryFn: () => apiRequest("GET", "/api/profiles/lite").then((r) => r.json()), staleTime: 300_000 });
  const people = Array.isArray(peopleQ.data) ? peopleQ.data : [];
  const { subject, isSelf } = resolveWellnessSubject(people as any[], []);
  const subjectId = (subject as any)?.id ?? null;
  const trackers = useMemo(
    () => (Array.isArray(trackersQ.data) ? trackersQ.data.filter((t: any) => belongsToSubject(t.linkedProfiles, subject, isSelf)) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trackersQ.data, subjectId, isSelf],
  );
  return { trackers, subjectId, failed: trackersQ.isError && trackersQ.data === undefined, retry: () => void trackersQ.refetch() };
}

export function ChartsTab({ tab }: { tab: ModeTab }) {
  const graphs = tab.graphs ?? [];
  const [range, setRange] = useState<WellnessRange>(tab.range ?? "30d");
  const own = useOwnTrackers();
  const needs = new Set(graphs.flatMap((g) => wellnessWidgetNeeds(g)));
  const journalQ = useQuery<any[]>({ queryKey: ["/api/journal", "everyone", "ai-mode"], queryFn: list("/api/journal"), enabled: needs.has("journal"), staleTime: 60_000 });
  const expensesQ = useQuery<any[]>({ queryKey: ["/api/expenses", "everyone", "ai-mode"], queryFn: list("/api/expenses"), enabled: needs.has("expenses"), staleTime: 60_000 });
  const todayISO = getUserToday(BROWSER_TIMEZONE);
  const data: WellnessSourceData | null = useMemo(() => (own.trackers ? {
    metrics: collectMetrics(own.trackers as any, { timezone: BROWSER_TIMEZONE }),
    trackers: own.trackers,
    journal: journalQ.data,
    expenses: expensesQ.data,
    timezone: BROWSER_TIMEZONE,
  } : null), [own.trackers, journalQ.data, expensesQ.data]);
  const state = (q: typeof journalQ) => ({ loading: q.data === undefined && !q.isError, error: q.isError && q.data === undefined, retry: () => void q.refetch() });

  return (
    <TabPage testId={`mode-charts-${tab.id}`}>
      <div className="flex gap-1 overflow-x-auto no-scrollbar pb-2" data-swipe-ignore role="group" aria-label="Time range">
        {WELLNESS_RANGES.map((r) => (
          <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}
            className={`h-7 px-2.5 rounded-full text-xs shrink-0 ${range === r ? "bg-foreground text-background font-semibold" : "border border-border text-muted-foreground"}`}>{RANGE_LABEL[r]}</button>
        ))}
      </div>
      {graphs.length === 0 ? <p className="text-sm text-muted-foreground">No graphs on this tab yet. Add one in Settings, or say "add a graph of my sleep".</p>
        : own.failed ? <LoadError what="your trackers" onRetry={own.retry} testId="mode-charts-error" />
        : !data ? <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
        : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {graphs.map((g) => (
              <div key={g.id} className="bubble p-3 min-w-0" data-testid={`mode-graph-${g.id}`}>
                <p className="text-[13px] font-bold mb-1.5 truncate">{g.title}</p>
                <WellnessWidgetCardBody widget={g} data={data} lists={{ journal: state(journalQ), expenses: state(expensesQ) }} range={range} todayISO={todayISO} />
              </div>
            ))}
          </div>
        )}
      <p className="text-[11px] text-muted-foreground mt-3">Drawn from your own trackers — the same figures the Wellness tab shows. A pattern in your records, not a medical conclusion.</p>
    </TabPage>
  );
}

export function LogTab({ tab }: { tab: ModeTab }) {
  const spec = tab.tracker!;
  const own = useOwnTrackers();
  const qc = useQueryClient();
  const reread = () => qc.invalidateQueries({ queryKey: ["/api/trackers"] });
  const { toast } = useToast();
  const tracker = own.trackers ? findTrackerByName(own.trackers, spec.name) : null;
  const exact = tracker && String(tracker.name).toLowerCase() === spec.name.toLowerCase() ? tracker : null;
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      await apiRequest("POST", "/api/trackers", {
        name: spec.name, category: "custom", ...(spec.unit ? { unit: spec.unit } : {}),
        fields: spec.fields.map((f, i) => ({ name: f.key, type: f.type, ...(f.unit ? { unit: f.unit } : {}), ...(i === 0 ? { isPrimary: true } : {}) })),
        ...(own.subjectId ? { linkedProfiles: [own.subjectId] } : {}),
      });
      await reread();
    } catch (err) { toast({ title: "Couldn't create the tracker", description: aiErrorText(err), variant: "destructive" }); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!exact) return;
    const out: Record<string, number | string> = {};
    for (const f of spec.fields) {
      const v = (values[f.key] ?? "").trim();
      if (!v) continue;
      if (f.type === "number") {
        const n = Number(v);
        if (!Number.isFinite(n)) { toast({ title: `${f.label} must be a number`, variant: "destructive" }); return; }
        out[f.key] = n;
      } else out[f.key] = v;
    }
    if (Object.keys(out).length === 0) { toast({ title: "Fill in at least one field", variant: "destructive" }); return; }
    setBusy(true);
    try {
      await apiRequest("POST", `/api/trackers/${exact.id}/entries`, { values: out });
      setValues({});
      await reread();
      toast({ title: `Saved to ${exact.name}` });
    } catch (err) { toast({ title: "Couldn't save the entry", description: aiErrorText(err), variant: "destructive" }); }
    finally { setBusy(false); }
  };

  const recent = exact ? [...(exact.entries || [])].sort((a: any, b: any) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, 6) : [];
  return (
    <TabPage testId={`mode-log-${tab.id}`}>
      {own.failed ? <LoadError what="your trackers" onRetry={own.retry} testId="mode-log-error" />
        : !own.trackers ? <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
        : !exact ? (
          <div className="bubble p-4" data-testid="mode-log-missing">
            <p className="text-sm font-semibold">This tab saves to a tracker called “{spec.name}”.</p>
            <p className="text-[12px] text-muted-foreground mt-1">You don't have it yet. Creating it adds it to your Trackers, with {spec.fields.map((f) => f.label).join(", ")}.</p>
            <button type="button" onClick={() => void create()} disabled={busy} className="mt-3 h-9 px-4 rounded-full bg-primary text-primary-foreground text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50" data-testid="mode-log-create">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create the tracker
            </button>
          </div>
        ) : (
          <>
            <form className="bubble p-3 space-y-2" onSubmit={(e) => { e.preventDefault(); void save(); }} data-testid="mode-log-form">
              <p className="text-sm font-bold">{exact.name}</p>
              {spec.fields.map((f) => (
                <label key={f.key} className="block">
                  <span className="block text-[11px] font-semibold text-muted-foreground mb-1">{f.label}{f.unit ? ` (${f.unit})` : ""}</span>
                  <input value={values[f.key] ?? ""} onChange={(e) => setValues((m) => ({ ...m, [f.key]: e.target.value }))}
                    inputMode={f.type === "number" ? "decimal" : "text"}
                    className="ws-field w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary/60" data-testid={`mode-log-field-${f.key}`} />
                </label>
              ))}
              <button type="submit" disabled={busy} className="h-9 w-full rounded-full bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-1.5" data-testid="mode-log-save">
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save entry
              </button>
            </form>
            <section className="mt-3">
              <p className="text-sm font-bold mb-1.5">Recent</p>
              {recent.length === 0 ? <p className="text-[12px] text-muted-foreground">Nothing logged yet.</p> : (
                <ul className="space-y-1" data-testid="mode-log-recent">
                  {recent.map((e: any) => (
                    <li key={e.id} className="text-[13px] flex gap-2">
                      <span className="text-muted-foreground shrink-0 tabular-nums">{new Date(e.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                      <span className="min-w-0 truncate">{Object.entries(e.values || {}).map(([k, v]) => `${spec.fields.find((f) => f.key === k)?.label ?? k}: ${v}`).join(" · ")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
    </TabPage>
  );
}

const FREQ_LABEL = { daily: "Every day", weekly: "Every week", monthly: "Every month" } as const;

/** The mode's reminders: each on (a recurring task exists) or off. */
export function RemindersPanel({ mode }: { mode: AiMode }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  // Every task list re-reads, not only this panel's (Rule 2).
  const reread = () => qc.invalidateQueries({ queryKey: ["/api/tasks"] });
  const { confirm, isArmed } = useConfirmArm();
  const tasksQ = useQuery<any[]>({ queryKey: ["/api/tasks", "everyone", "ai-mode"], queryFn: list("/api/tasks"), staleTime: 30_000, enabled: mode.reminders.length > 0 });
  const [busy, setBusy] = useState<string | null>(null);
  if (mode.reminders.length === 0) return null;
  const taskFor = (r: ModeReminder) => (tasksQ.data || []).find((t: any) => Array.isArray(t.tags) && t.tags.includes(reminderTaskTag(mode.id, r.id)) && t.status !== "done");
  const turnOn = async (r: ModeReminder) => {
    setBusy(r.id);
    try { await apiRequest("POST", "/api/tasks", reminderTask(mode, r, getUserToday(BROWSER_TIMEZONE))); await reread(); }
    catch (err) { toast({ title: "Couldn't turn the reminder on", description: aiErrorText(err), variant: "destructive" }); }
    finally { setBusy(null); }
  };
  const turnOff = async (taskId: string) => {
    setBusy(taskId);
    try { await apiRequest("DELETE", `/api/tasks/${taskId}`); await reread(); }
    catch (err) { toast({ title: "Couldn't turn the reminder off", description: aiErrorText(err), variant: "destructive" }); }
    finally { setBusy(null); }
  };
  return (
    <section className="mt-4" data-testid="mode-reminders">
      <p className="text-sm font-bold mb-1">Reminders</p>
      <p className="text-[11px] text-muted-foreground mb-2">A reminder you turn on is a repeating task in Tasks, with the app's usual notifications.</p>
      {tasksQ.isError && tasksQ.data === undefined ? <LoadError what="your tasks" onRetry={() => void tasksQ.refetch()} testId="mode-reminders-error" />
        : !tasksQ.data ? <p className="text-[12px] text-muted-foreground">Loading…</p>
        : (
          <ul className="space-y-1.5">
            {mode.reminders.map((r) => {
              const task = taskFor(r);
              return (
                <li key={r.id} className="bubble px-3 py-2 flex items-center gap-2" data-testid={`mode-reminder-${r.id}`}>
                  {task ? <Bell className="h-4 w-4 text-primary shrink-0" /> : <BellOff className="h-4 w-4 text-muted-foreground shrink-0" />}
                  <span className="flex-1 min-w-0">
                    <span className="text-sm block truncate">{r.title}</span>
                    <span className="text-[11px] text-muted-foreground">{FREQ_LABEL[r.freq]}{r.time ? ` at ${r.time}` : ""}{task ? " · on" : ""}</span>
                  </span>
                  {task ? (
                    <button type="button" disabled={busy !== null} onClick={() => confirm(`off:${r.id}`, () => void turnOff(task.id))}
                      className={`h-7 px-2.5 rounded-full text-[11px] shrink-0 ${isArmed(`off:${r.id}`) ? "bg-destructive text-destructive-foreground" : "border border-border"}`} data-testid={`mode-reminder-off-${r.id}`}>
                      {isArmed(`off:${r.id}`) ? "Tap again" : "Turn off"}
                    </button>
                  ) : (
                    <button type="button" disabled={busy !== null} onClick={() => void turnOn(r)}
                      className="h-7 px-2.5 rounded-full text-[11px] shrink-0 bg-primary text-primary-foreground font-semibold" data-testid={`mode-reminder-on-${r.id}`}>
                      {busy === r.id ? "…" : "Turn on"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}
