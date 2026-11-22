// ── Edit Event / Edit Task ───────────────────────────────────────────────────
//
// The edit half of the calendar detail flow: Details · Repeat · Reminders ·
// Advanced, with a live preview of the dates the schedule produces.
//
// It edits the two kinds of record that OWN their schedule — a calendar event
// and a task. Everything else (a bill, a profile's birthday, a document
// expiry) is edited on the record it comes from (shared/calendar-capabilities
// `editsInPlace`).
//
// Opening the screen writes nothing (Rule 3). Save sends only what changed,
// and everything stored in a tag list (reminders, the repeat rule of a task)
// is applied by the server to the row as stored (Rule 6):
//   event  PATCH /api/events/:id  +  POST /api/events/:id/series-settings
//   task   PATCH /api/tasks/:id   +  POST /api/tasks/:id/schedule
// A failed load is an error state with a retry, never an empty form (Rule 7).

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft, Bell, CalendarDays, Check, CircleSlash, Infinity as InfinityIcon,
  ListOrdered, Plus, Repeat, Trash2, X, AlertTriangle, PauseCircle,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import { refreshCalendarSurfaces } from "@/lib/calendar-mutations";
import { setEventSeriesFlag } from "@/lib/event-occurrence";
import { WeekdayPicker, isCustomDaySet, seedDaySet } from "@/components/recurring/WeekdayPicker";
import {
  RECURRING_KINDS, kindDef, parseRecurringMeta, applySeriesSettings,
  expandRecurrenceDates, humanRecurrenceLabel, nthOccurrenceDate, addDaysISO,
  REMINDER_PRESETS, reminderLabel, type RecurringKind,
} from "@shared/recurring-dates";
import { parseRecurrence, recurrenceToTags, freqToUnit, humanSummary, withAnchorDay } from "@shared/recurrence";
import { taskOccurrenceDates } from "@shared/task-occurrences";
import { relativeDayLabel, type CalendarSeries } from "@shared/calendar-occurrences";
import { fmtDate, fmtShort } from "./kind-style";

type Tab = "details" | "repeat" | "reminders" | "advanced";
type RepeatChoice = "none" | "daily" | "weekly" | "monthly" | "yearly" | "custom";
type EndChoice = "never" | "date" | "count";

export interface EditSeriesScreenProps {
  series: CalendarSeries;
  /** "future": the change applies from `fromDate` forward; history is kept. */
  mode: "series" | "future";
  fromDate?: string;
  initialTab?: Tab;
  accent: string;
  todayISO: string;
  getEventRow?: (eventId: string) => any | undefined;
  onBack: () => void;
  /** Saved; the caller decides whether to stay or close. */
  onSaved: (info: { split: boolean }) => void;
  /** The series was deleted or paused and has nothing left to show. */
  onGone: () => void;
}

interface FormState {
  title: string;
  kind: RecurringKind;
  date: string;
  time: string;
  notes: string;
  profileId: string;
  priority: string;
  choice: RepeatChoice;
  /** Every N (weeks for weekly, days for custom). */
  interval: number;
  /** Event weekly only: a `weekly:<days>` token, or "" for "the date's weekday". */
  daySet: string;
  end: EndChoice;
  endDate: string;
  endCount: string;
  reminders: number[];
  requireComplete: boolean;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** A stored event recurrence → the form's choice + details. */
function choiceFromEventRecurrence(rec: string): Pick<FormState, "choice" | "interval" | "daySet"> {
  if (!rec || rec === "none") return { choice: "none", interval: 1, daySet: "" };
  if (rec === "daily") return { choice: "daily", interval: 1, daySet: "" };
  if (rec === "weekly") return { choice: "weekly", interval: 1, daySet: "" };
  if (rec === "biweekly") return { choice: "weekly", interval: 2, daySet: "" };
  if (rec === "weekdays") return { choice: "weekly", interval: 1, daySet: "weekly:1,2,3,4,5" };
  if (rec === "weekends") return { choice: "weekly", interval: 1, daySet: "weekly:0,6" };
  if (isCustomDaySet(rec)) return { choice: "weekly", interval: 1, daySet: rec };
  if (rec === "monthly") return { choice: "monthly", interval: 1, daySet: "" };
  if (rec === "yearly") return { choice: "yearly", interval: 1, daySet: "" };
  return { choice: "none", interval: 1, daySet: "" };
}

/** The form's choice → the event recurrence token the server stores. */
function eventRecurrenceOf(f: FormState): string {
  switch (f.choice) {
    case "daily": return "daily";
    case "weekly":
      if (f.interval >= 2) return "biweekly";
      if (f.daySet === "weekly:1,2,3,4,5") return "weekdays";
      if (f.daySet === "weekly:0,6") return "weekends";
      return f.daySet || "weekly";
    case "monthly": return "monthly";
    case "yearly": return "yearly";
    default: return "none";
  }
}

/** A stored task `recur:` freq → the form's choice + details. */
function choiceFromTaskFreq(freq: string): Pick<FormState, "choice" | "interval" | "daySet"> {
  if (!freq) return { choice: "none", interval: 1, daySet: "" };
  const { unit, interval } = freqToUnit(freq);
  if (unit === "weekday") return { choice: "weekly", interval: 1, daySet: "weekly:1,2,3,4,5" };
  if (unit === "day") return interval === 1 ? { choice: "daily", interval: 1, daySet: "" } : { choice: "custom", interval, daySet: "" };
  if (unit === "week") return { choice: "weekly", interval, daySet: "" };
  if (unit === "month") return { choice: "monthly", interval: 1, daySet: "" };
  if (unit === "year") return { choice: "yearly", interval: 1, daySet: "" };
  return { choice: "none", interval: 1, daySet: "" };
}

/** The form's choice → the task `recur:` freq. */
function taskFreqOf(f: FormState): string {
  switch (f.choice) {
    case "daily": return "daily";
    case "weekly":
      if (f.daySet === "weekly:1,2,3,4,5") return "weekdays";
      return f.interval >= 2 ? `every-${f.interval}-weeks` : "weekly";
    case "monthly": return "monthly";
    case "yearly": return "yearly";
    case "custom": return f.interval <= 1 ? "daily" : `every-${f.interval}-days`;
    default: return "";
  }
}

const REPEAT_CHOICES: Array<{ value: RepeatChoice; label: string; icon: any }> = [
  { value: "none", label: "Does not repeat", icon: CircleSlash },
  { value: "daily", label: "Daily", icon: CalendarDays },
  { value: "weekly", label: "Weekly", icon: CalendarDays },
  { value: "monthly", label: "Monthly", icon: CalendarDays },
  { value: "yearly", label: "Yearly", icon: CalendarDays },
  { value: "custom", label: "Custom (every X days)", icon: Repeat },
];

const fieldCls =
  "w-full rounded-xl border border-border bg-background/60 px-3.5 h-11 text-sm outline-none " +
  "focus:border-[hsl(var(--accent-hsl)/0.7)] focus:ring-2 focus:ring-[hsl(var(--accent-hsl)/0.25)]";
const labelCls = "block text-[13px] font-semibold mb-1.5";

export function EditSeriesScreen({
  series, mode, fromDate, initialTab = "details", accent, todayISO, getEventRow, onBack, onSaved, onGone,
}: EditSeriesScreenProps) {
  const { toast } = useToast();
  const isTask = series.source.system === "task";
  const id = series.source.id;
  const noun = isTask ? "Task" : "Event";

  const rowQuery = useQuery<any>({
    queryKey: [isTask ? `/api/tasks/${id}` : `/api/events/${id}`],
    queryFn: () => apiRequest("GET", isTask ? `/api/tasks/${id}` : `/api/events/${id}`).then((r) => r.json()),
    initialData: isTask ? undefined : getEventRow?.(id),
  });
  const row = rowQuery.data;

  const { data: profilesRaw } = useQuery<any>({ queryKey: ["/api/profiles"] });
  const profiles: any[] = Array.isArray(profilesRaw) ? profilesRaw : (profilesRaw?.data ?? []);

  const [tab, setTab] = useState<Tab>(initialTab);
  const [form, setForm] = useState<FormState | null>(null);
  const [opened, setOpened] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const arm = useConfirmArm();

  // Seed the form ONCE from the stored row. A refetch behind an open form
  // must not wipe what the user is typing.
  useEffect(() => {
    if (!row || form) return;
    let f: FormState;
    if (isTask) {
      const tags: string[] = Array.isArray(row.tags) ? row.tags.map(String) : [];
      const rule = parseRecurrence(tags);
      f = {
        title: row.title || "",
        kind: "custom",
        date: String(row.dueDate || "").slice(0, 10),
        time: row.dueTime || "",
        notes: row.description || "",
        profileId: row.linkedProfiles?.[0] || "",
        priority: row.priority || "medium",
        ...choiceFromTaskFreq(rule.freq),
        end: rule.until ? "date" : rule.count ? "count" : "never",
        endDate: rule.until || "",
        endCount: rule.count ? String(rule.count) : "",
        reminders: [],
        requireComplete: false,
      };
    } else {
      const meta = parseRecurringMeta(row.tags);
      f = {
        title: row.title || "",
        kind: (meta.kind || (RECURRING_KINDS.some((k) => k.kind === series.kind) ? series.kind : "custom")) as RecurringKind,
        date: String(row.date || "").slice(0, 10),
        time: "",
        notes: row.description || "",
        profileId: row.linkedProfiles?.[0] || "",
        priority: "medium",
        ...choiceFromEventRecurrence(row.recurrence || "none"),
        end: row.recurrenceEnd ? "date" : "never",
        endDate: String(row.recurrenceEnd || "").slice(0, 10),
        endCount: "",
        reminders: meta.reminders ? [...meta.reminders] : [],
        requireComplete: meta.requireComplete,
      };
    }
    // "Edit future occurrences": the new schedule starts at the chosen date.
    if (mode === "future" && fromDate && ISO.test(fromDate) && !isTask) f = { ...f, date: fromDate };
    setForm(f);
    setOpened(f);
  }, [row, form, isTask, mode, fromDate, series.kind]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((s) => (s ? { ...s, [k]: v } : s));

  // ── Derived: the recurrence the form describes, and the dates it produces ──
  const eventRecurrence = form && !isTask ? eventRecurrenceOf(form) : "none";
  const taskFreq = form && isTask ? taskFreqOf(form) : "";
  const repeats = form ? form.choice !== "none" : false;

  /** The end DATE the form means (an event's count is stored as a date). */
  const resolvedEnd: string | null = useMemo(() => {
    if (!form || !repeats || form.end === "never") return null;
    if (form.end === "date") return ISO.test(form.endDate) ? form.endDate : null;
    const n = parseInt(form.endCount, 10);
    if (!Number.isFinite(n) || n < 1) return null;
    if (isTask) return null; // a task keeps the count itself (rcount:)
    return ISO.test(form.date) ? nthOccurrenceDate(form.date, eventRecurrence, n) : null;
  }, [form, repeats, isTask, eventRecurrence]);

  const preview: string[] = useMemo(() => {
    if (!form || !ISO.test(form.date)) return [];
    const from = form.date > todayISO ? form.date : todayISO;
    if (isTask) {
      const n = parseInt(form.endCount, 10);
      const rule = withAnchorDay({
        ...freqToUnit(taskFreq), freq: taskFreq, done: 0, paused: false,
        until: form.end === "date" && ISO.test(form.endDate) ? form.endDate : undefined,
        count: form.end === "count" && Number.isFinite(n) && n > 0 ? n : undefined,
      }, form.date);
      return taskOccurrenceDates(
        { dueDate: form.date, tags: recurrenceToTags(rule, []), status: "todo" },
        from, addDaysISO(from, 366 * 6),
      ).slice(0, 5);
    }
    if (!repeats) return form.date >= todayISO ? [form.date] : [];
    return expandRecurrenceDates(form.date, eventRecurrence, {
      recurrenceEnd: resolvedEnd || undefined,
      windowStart: from,
      windowEnd: addDaysISO(from, 366 * 6),
      cap: 2600,
    }).slice(0, 5);
  }, [form, isTask, taskFreq, eventRecurrence, repeats, resolvedEnd, todayISO]);

  const repeatLabel = useMemo(() => {
    if (!form) return "";
    if (!repeats) return "Does not repeat";
    if (isTask) {
      return humanSummary(withAnchorDay({ ...freqToUnit(taskFreq), freq: taskFreq, done: 0, paused: false }, form.date), form.date)
        .replace(/^Repeats /, "").replace(/^./, (c) => c.toUpperCase());
    }
    return humanRecurrenceLabel(eventRecurrence, form.date);
  }, [form, repeats, isTask, taskFreq, eventRecurrence]);

  const endLabel = !form || !repeats || form.end === "never"
    ? "Never ends"
    : form.end === "date"
      ? (ISO.test(form.endDate) ? `Ends ${fmtShort(form.endDate)}` : "Pick an end date")
      : (parseInt(form.endCount, 10) > 0
        ? `Ends after ${parseInt(form.endCount, 10)} occurrence${parseInt(form.endCount, 10) === 1 ? "" : "s"}`
        : "Enter how many times");

  const problem: string | null = !form ? null
    : !form.title.trim() ? `Give the ${noun.toLowerCase()} a name.`
    : !ISO.test(form.date) ? "Pick a date."
    : repeats && form.end === "date" && !ISO.test(form.endDate) ? "Pick the date the series ends on."
    : repeats && form.end === "date" && form.endDate < form.date ? "The end date is before the first date."
    : repeats && form.end === "count" && !(parseInt(form.endCount, 10) >= 1) ? "Enter how many occurrences before it ends."
    : (form.choice === "custom" || (form.choice === "weekly" && form.interval > 1)) && !(form.interval >= 1) ? "Enter how often it repeats."
    : null;

  const dirty = !!form && !!opened && JSON.stringify(form) !== JSON.stringify(opened);

  // ── Save ───────────────────────────────────────────────────────────────────
  const save = async () => {
    if (!form || !opened || problem || saving) return;
    setSaving(true);
    try {
      let split = false;
      if (isTask) {
        const patch: Record<string, any> = {};
        if (form.title.trim() !== opened.title.trim()) patch.title = form.title.trim();
        if (form.notes.trim() !== opened.notes.trim()) patch.description = form.notes.trim();
        if (form.priority !== opened.priority) patch.priority = form.priority;
        if (form.date !== opened.date) patch.dueDate = form.date;
        if (form.time !== opened.time) patch.dueTime = form.time || null;
        if (form.profileId !== opened.profileId) patch.linkedProfiles = form.profileId ? [form.profileId] : [];
        if (Object.keys(patch).length) await apiRequest("PATCH", `/api/tasks/${id}`, patch);
        const scheduleChanged =
          taskFreqOf(form) !== taskFreqOf(opened) || form.end !== opened.end
          || form.endDate !== opened.endDate || form.endCount !== opened.endCount;
        if (scheduleChanged) {
          await apiRequest("POST", `/api/tasks/${id}/schedule`, {
            freq: taskFreq,
            until: repeats && form.end === "date" ? form.endDate : null,
            count: repeats && form.end === "count" ? parseInt(form.endCount, 10) : null,
          });
        }
      } else {
        const kd = kindDef(form.kind);
        const end = repeats ? resolvedEnd : null;
        const settings = { kind: form.kind, reminders: form.reminders, requireComplete: form.requireComplete };
        if (mode === "future" && fromDate) {
          // Split the series: the old one ends the day before, keeping its
          // history; a new one carries the change forward.
          await apiRequest("PATCH", `/api/events/${id}`, { recurrenceEnd: addDaysISO(form.date, -1) });
          await apiRequest("POST", "/api/events", {
            title: form.title.trim(),
            date: form.date,
            allDay: row?.allDay ?? true,
            ...(row?.time ? { time: row.time } : {}),
            category: kd.eventCategory,
            recurrence: eventRecurrence,
            ...(end ? { recurrenceEnd: end } : {}),
            description: form.notes.trim() || undefined,
            linkedProfiles: form.profileId ? [form.profileId] : [],
            tags: applySeriesSettings([], settings),
            source: "manual",
          });
          split = true;
        } else {
          const patch: Record<string, any> = {};
          if (form.title.trim() !== opened.title.trim()) patch.title = form.title.trim();
          if (form.notes.trim() !== opened.notes.trim()) patch.description = form.notes.trim();
          if (form.date !== opened.date) patch.date = form.date;
          if (form.profileId !== opened.profileId) patch.linkedProfiles = form.profileId ? [form.profileId] : [];
          if (form.kind !== opened.kind) patch.category = kd.eventCategory;
          if (eventRecurrence !== eventRecurrenceOf(opened)) patch.recurrence = eventRecurrence;
          const storedEnd = String(row?.recurrenceEnd || "").slice(0, 10);
          if ((end || "") !== storedEnd) patch.recurrenceEnd = end || "";
          if (Object.keys(patch).length) await apiRequest("PATCH", `/api/events/${id}`, patch);
          const settingsChanged =
            form.kind !== opened.kind || form.requireComplete !== opened.requireComplete
            || form.reminders.join(",") !== opened.reminders.join(",");
          if (settingsChanged) await apiRequest("POST", `/api/events/${id}/series-settings`, settings);
        }
      }
      await refreshCalendarSurfaces();
      toast({ title: split ? `Schedule updated from ${fmtShort(form.date)}` : `${noun} saved`, description: split ? "Earlier occurrences kept their history." : form.title.trim() });
      onSaved({ split });
    } catch (e: any) {
      toast({ title: "Couldn't save", description: e?.message || "Try again", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const pauseSeries = async () => {
    try {
      if (isTask) await apiRequest("POST", `/api/tasks/${id}/schedule`, { paused: true });
      else await setEventSeriesFlag(id, "paused", true);
      await refreshCalendarSurfaces();
      toast({ title: "Series paused", description: "Upcoming dates are hidden until you resume it. Nothing was deleted." });
      onGone();
    } catch (e: any) {
      toast({ title: "Couldn't pause", description: e?.message || "Try again", variant: "destructive" });
    }
  };

  const deleteSeries = async () => {
    try {
      await apiRequest("DELETE", isTask ? `/api/tasks/${id}` : `/api/events/${id}`);
      await refreshCalendarSurfaces();
      toast({ title: isTask ? "Task deleted" : "Series deleted" });
      onGone();
    } catch (e: any) {
      toast({ title: "Couldn't delete", description: e?.message || "Try again", variant: "destructive" });
    }
  };

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "details", label: "Details" },
    { id: "repeat", label: isTask ? "Schedule" : "Repeat" },
    ...(!isTask ? [{ id: "reminders" as Tab, label: "Reminders" }] : []),
    { id: "advanced", label: "Advanced" },
  ];

  const people = profiles.filter((p) => ["self", "person", "pet"].includes(p?.type));
  const others = profiles.filter((p) => !["self", "person", "pet"].includes(p?.type));
  const choices = REPEAT_CHOICES.filter((c) => isTask || c.value !== "custom");

  return (
    <div className="flex flex-col min-h-0 flex-1" style={{ ["--accent-hsl" as any]: accent }} data-testid="cal-edit-screen">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <button type="button" onClick={onBack} aria-label="Back"
          className="h-10 w-10 grid place-items-center rounded-full hover:bg-muted" data-testid="cal-edit-back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h2 className="flex-1 text-center text-lg font-bold tracking-tight">
          {mode === "future" ? "Edit Future" : `Edit ${noun}`}
        </h2>
        <button type="button" onClick={() => void save()}
          disabled={!form || !!problem || saving || (!dirty && mode !== "future")}
          className="h-10 px-5 rounded-full text-sm font-semibold text-white disabled:opacity-40 bg-[hsl(var(--accent-hsl))]"
          data-testid="cal-edit-save">
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────────────── */}
      <div className="mx-4 mb-3 grid gap-1 rounded-2xl border border-border bg-muted/40 p-1"
        style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }} role="tablist">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`h-9 rounded-xl text-[13px] font-medium transition-colors ${tab === t.id ? "text-white bg-[hsl(var(--accent-hsl))]" : "text-muted-foreground hover:text-foreground"}`}
            data-testid={`cal-edit-tab-${t.id}`}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-8 space-y-4">
        {mode === "future" && fromDate && (
          <p className="rounded-xl border border-border bg-muted/40 px-3.5 py-2.5 text-[13px] text-muted-foreground">
            Changes apply from <span className="font-semibold text-foreground">{fmtShort(fromDate)}</span> forward.
            Earlier occurrences keep their dates and history.
          </p>
        )}

        {rowQuery.isError && !form ? (
          <div className="rounded-2xl border border-border p-5 text-center space-y-3" data-testid="cal-edit-error">
            <AlertTriangle className="h-6 w-6 mx-auto text-amber-500" />
            <p className="text-sm">Couldn't load this {noun.toLowerCase()}.</p>
            <button type="button" onClick={() => void rowQuery.refetch()}
              className="h-9 px-4 rounded-full border border-border text-sm font-medium">Try again</button>
          </div>
        ) : !form ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            {/* ═══ Details ═══ */}
            {tab === "details" && (
              <div className="space-y-4">
                <div>
                  <label className={labelCls} htmlFor="cal-edit-title">{noun} Name</label>
                  <input id="cal-edit-title" className={fieldCls} value={form.title}
                    onChange={(e) => set("title", e.target.value)} data-testid="cal-edit-title" />
                </div>

                {!isTask ? (
                  <div>
                    <label className={labelCls} htmlFor="cal-edit-kind">Event Type</label>
                    <select id="cal-edit-kind" className={fieldCls} value={form.kind}
                      onChange={(e) => set("kind", e.target.value as RecurringKind)} data-testid="cal-edit-kind">
                      {RECURRING_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                    </select>
                  </div>
                ) : (
                  <div>
                    <label className={labelCls} htmlFor="cal-edit-priority">Priority</label>
                    <select id="cal-edit-priority" className={fieldCls} value={form.priority}
                      onChange={(e) => set("priority", e.target.value)} data-testid="cal-edit-priority">
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </div>
                )}

                <div className={isTask ? "grid grid-cols-2 gap-3" : ""}>
                  <div>
                    <label className={labelCls} htmlFor="cal-edit-date">
                      {mode === "future" ? "Applies from" : isTask ? "Next due" : "Date"}
                    </label>
                    <input id="cal-edit-date" type="date" className={fieldCls} value={form.date}
                      onChange={(e) => set("date", e.target.value)} data-testid="cal-edit-date" />
                  </div>
                  {isTask && (
                    <div>
                      <label className={labelCls} htmlFor="cal-edit-time">Time <span className="font-normal text-muted-foreground">(optional)</span></label>
                      <input id="cal-edit-time" type="time" className={fieldCls} value={form.time}
                        onChange={(e) => set("time", e.target.value)} data-testid="cal-edit-time" />
                    </div>
                  )}
                </div>

                <div>
                  <label className={labelCls} htmlFor="cal-edit-notes">Notes <span className="font-normal text-muted-foreground">(optional)</span></label>
                  <textarea id="cal-edit-notes" rows={3} maxLength={500}
                    className={`${fieldCls} h-auto py-2.5 resize-none`} value={form.notes}
                    onChange={(e) => set("notes", e.target.value)} data-testid="cal-edit-notes" />
                  <p className="mt-1 text-right text-[11px] text-muted-foreground tabular-nums">{form.notes.length}/500</p>
                </div>

                <div>
                  <label className={labelCls} htmlFor="cal-edit-profile">Person / Profile <span className="font-normal text-muted-foreground">(optional)</span></label>
                  <select id="cal-edit-profile" className={fieldCls} value={form.profileId}
                    onChange={(e) => set("profileId", e.target.value)} data-testid="cal-edit-profile">
                    <option value="">Not linked</option>
                    {people.length > 0 && (
                      <optgroup label="People & pets">
                        {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </optgroup>
                    )}
                    {others.length > 0 && (
                      <optgroup label="Everything else">
                        {others.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </optgroup>
                    )}
                  </select>
                </div>

                <SummaryCard title="Summary" lines={[
                  isTask ? (repeats ? "Recurring task" : "One-time task") : kindDef(form.kind).label,
                  `${repeatLabel} • ${endLabel}`,
                  preview[0] ? `Next${isTask ? " due" : ""}: ${fmtDate(preview[0])}` : "No upcoming date",
                ]} />
              </div>
            )}

            {/* ═══ Repeat / Schedule ═══ */}
            {tab === "repeat" && (
              <div className="space-y-5">
                <section>
                  <h3 className={labelCls}>Repeat</h3>
                  <div className="space-y-1.5" role="radiogroup" aria-label="Repeat">
                    {choices.map((c) => {
                      const active = form.choice === c.value;
                      const Icon = c.icon;
                      return (
                        <button key={c.value} type="button" role="radio" aria-checked={active}
                          onClick={() => setForm((s) => s ? {
                            ...s, choice: c.value,
                            interval: c.value === "custom" ? Math.max(2, s.interval) : c.value === "weekly" ? Math.min(s.interval, isTask ? 52 : 2) : 1,
                            daySet: c.value === "weekly" ? s.daySet : "",
                          } : s)}
                          className={`w-full flex items-center gap-3 rounded-xl border px-3.5 h-11 text-sm text-left transition-colors ${active
                            ? "border-[hsl(var(--accent-hsl)/0.8)] bg-[hsl(var(--accent-hsl)/0.14)] font-semibold"
                            : "border-border hover:bg-muted/50"}`}
                          data-testid={`cal-edit-repeat-${c.value}`}>
                          <Icon className="h-4 w-4 text-muted-foreground" />
                          <span className="flex-1">{c.label}</span>
                          {active && (
                            <span className="h-5 w-5 grid place-items-center rounded-full bg-[hsl(var(--accent-hsl))] text-white">
                              <Check className="h-3 w-3" />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </section>

                {repeats && (
                  <section>
                    <h3 className={labelCls}>{isTask ? "Schedule Details" : "Repeat Details"}</h3>
                    <div className="rounded-2xl border border-border p-3.5 space-y-3">
                      {form.choice === "daily" && <p className="text-sm">Every day</p>}
                      {form.choice === "custom" && (
                        <div className="flex items-center gap-2 text-sm">
                          <span>Repeat every</span>
                          <input type="number" min={1} max={365} inputMode="numeric"
                            className={`${fieldCls} w-20 text-center`} value={form.interval}
                            onChange={(e) => set("interval", Math.max(1, Math.min(365, parseInt(e.target.value, 10) || 1)))}
                            data-testid="cal-edit-interval" />
                          <span>days</span>
                        </div>
                      )}
                      {form.choice === "weekly" && (
                        <>
                          <div className="flex items-center gap-2 text-sm">
                            <span>Repeat every</span>
                            {isTask ? (
                              <input type="number" min={1} max={52} inputMode="numeric"
                                className={`${fieldCls} w-20 text-center`} value={form.interval}
                                onChange={(e) => setForm((s) => s ? { ...s, interval: Math.max(1, Math.min(52, parseInt(e.target.value, 10) || 1)), daySet: "" } : s)}
                                data-testid="cal-edit-interval" />
                            ) : (
                              <select className={`${fieldCls} w-20`} value={form.interval}
                                onChange={(e) => setForm((s) => s ? { ...s, interval: Number(e.target.value), daySet: Number(e.target.value) > 1 ? "" : s.daySet } : s)}
                                data-testid="cal-edit-interval">
                                <option value={1}>1</option>
                                <option value={2}>2</option>
                              </select>
                            )}
                            <span>{form.interval === 1 ? "week" : "weeks"}</span>
                          </div>
                          {form.interval === 1 && (
                            isTask ? (
                              <label className="flex items-center gap-2.5 text-sm">
                                <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--accent-hsl))]"
                                  checked={form.daySet === "weekly:1,2,3,4,5"}
                                  onChange={(e) => set("daySet", e.target.checked ? "weekly:1,2,3,4,5" : "")}
                                  data-testid="cal-edit-weekdays" />
                                Every weekday (Mon–Fri)
                              </label>
                            ) : (
                              <div className="space-y-1.5">
                                <p className="text-[13px] text-muted-foreground">On</p>
                                <WeekdayPicker
                                  recurrence={form.daySet || seedDaySet(form.date)}
                                  onChange={(r) => set("daySet", r === seedDaySet(form.date) ? "" : r)}
                                  testId="cal-edit-weekday-picker" />
                              </div>
                            )
                          )}
                        </>
                      )}
                      {form.choice === "monthly" && ISO.test(form.date) && (
                        <p className="text-sm">
                          On day <span className="font-semibold">{Number(form.date.slice(8, 10))}</span> of every month
                          <span className="block text-[12px] text-muted-foreground mt-0.5">Change the day by changing the date on the Details tab.</span>
                        </p>
                      )}
                      {form.choice === "yearly" && ISO.test(form.date) && (
                        <p className="text-sm">
                          On <span className="font-semibold">
                            {new Date(`${form.date}T12:00:00`).toLocaleDateString("en-US", { month: "long", day: "numeric" })}
                          </span> every year
                          <span className="block text-[12px] text-muted-foreground mt-0.5">Change the day by changing the date on the Details tab.</span>
                        </p>
                      )}
                    </div>
                  </section>
                )}

                {repeats && (
                  <section>
                    <h3 className={labelCls}>Ends</h3>
                    <div className="rounded-2xl border border-border divide-y divide-border/60 overflow-hidden" role="radiogroup" aria-label="Ends">
                      <EndRow active={form.end === "never"} onClick={() => set("end", "never")} icon={InfinityIcon}
                        label="Never (ongoing)" testId="cal-edit-end-never" />
                      <EndRow active={form.end === "date"} onClick={() => set("end", "date")} icon={CalendarDays}
                        label="On a specific date" testId="cal-edit-end-date">
                        {form.end === "date" && (
                          <input type="date" className={`${fieldCls} mt-2`} value={form.endDate} min={form.date}
                            onChange={(e) => set("endDate", e.target.value)} data-testid="cal-edit-end-date-input" />
                        )}
                      </EndRow>
                      <EndRow active={form.end === "count"} onClick={() => set("end", "count")} icon={ListOrdered}
                        label="After a number of occurrences" testId="cal-edit-end-count">
                        {form.end === "count" && (
                          <div className="mt-2 flex items-center gap-2 text-sm">
                            <input type="number" min={1} max={1000} inputMode="numeric" placeholder="12"
                              className={`${fieldCls} w-24 text-center`} value={form.endCount}
                              onChange={(e) => set("endCount", e.target.value)} data-testid="cal-edit-end-count-input" />
                            <span>occurrences</span>
                            {!isTask && resolvedEnd && (
                              <span className="text-[12px] text-muted-foreground">· last on {fmtShort(resolvedEnd)}</span>
                            )}
                          </div>
                        )}
                      </EndRow>
                    </div>
                  </section>
                )}

                <div className="rounded-2xl border p-3.5 flex gap-3 border-[hsl(var(--accent-hsl)/0.35)] bg-[hsl(var(--accent-hsl)/0.08)]">
                  <span className="h-9 w-9 shrink-0 grid place-items-center rounded-full bg-[hsl(var(--accent-hsl)/0.18)] text-[hsl(var(--accent-hsl))]">
                    {repeats && form.end === "never" ? <InfinityIcon className="h-4 w-4" /> : <CalendarDays className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">
                      {!repeats ? "One time" : form.end === "never" ? `Ongoing ${noun}` : "Ends on a set date"}
                    </p>
                    <p className="text-[13px] text-muted-foreground">
                      {!repeats
                        ? `This ${noun.toLowerCase()} happens once${ISO.test(form.date) ? `, on ${fmtShort(form.date)}` : ""}.`
                        : `${repeatLabel}. ${form.end === "never" ? "Continues until you delete or change it." : `${endLabel}.`}`}
                    </p>
                  </div>
                </div>

                <PreviewCard dates={preview} todayISO={todayISO} />
              </div>
            )}

            {/* ═══ Reminders (events) ═══ */}
            {tab === "reminders" && !isTask && (
              <div className="space-y-4">
                <section className="rounded-2xl border border-border p-3.5 space-y-2.5">
                  <h3 className="flex items-center gap-2 text-sm font-semibold"><Bell className="h-4 w-4" /> Reminders</h3>
                  {form.reminders.length === 0 && (
                    <p className="text-[13px] text-muted-foreground">No reminders. Add one to see this date in your alerts ahead of time.</p>
                  )}
                  {form.reminders.map((days, i) => (
                    <div key={`${days}-${i}`} className="flex items-center gap-2">
                      <select className={fieldCls} value={days}
                        onChange={(e) => {
                          const next = [...form.reminders];
                          next[i] = Number(e.target.value);
                          set("reminders", Array.from(new Set(next)).sort((a, b) => b - a));
                        }}
                        data-testid={`cal-edit-reminder-${i}`}>
                        {REMINDER_PRESETS.filter((r) => r.value != null).map((r) => (
                          <option key={String(r.value)} value={r.value as number}
                            disabled={r.value !== days && form.reminders.includes(r.value as number)}>
                            {r.label}
                          </option>
                        ))}
                        {!REMINDER_PRESETS.some((r) => r.value === days) && <option value={days}>{reminderLabel(days)}</option>}
                      </select>
                      <button type="button" aria-label={`Remove reminder ${reminderLabel(days)}`}
                        onClick={() => set("reminders", form.reminders.filter((_, j) => j !== i))}
                        className="h-11 w-11 shrink-0 grid place-items-center rounded-xl hover:bg-muted"
                        data-testid={`cal-edit-reminder-remove-${i}`}>
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                  {(() => {
                    const free = REMINDER_PRESETS.map((r) => r.value).filter((v): v is number => v != null && !form.reminders.includes(v));
                    if (!free.length || form.reminders.length >= 6) return null;
                    // Offer the most useful lead not already taken.
                    const pick = [7, 1, 0, 3, 14, 30].find((v) => free.includes(v)) ?? free[0];
                    return (
                      <button type="button"
                        onClick={() => set("reminders", [...form.reminders, pick].sort((a, b) => b - a))}
                        className="w-full h-11 rounded-xl border border-border text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-muted/50"
                        data-testid="cal-edit-reminder-add">
                        <Plus className="h-4 w-4" /> Add Reminder
                      </button>
                    );
                  })()}
                  <p className="text-[12px] text-muted-foreground">
                    The date appears in your alerts from the earliest reminder until the day itself.
                  </p>
                </section>

                <PreviewCard dates={preview} todayISO={todayISO} />

                <div className={`rounded-2xl border p-3.5 flex gap-3 ${problem
                  ? "border-amber-500/40 bg-amber-500/10" : "border-emerald-500/40 bg-emerald-500/10"}`}
                  data-testid="cal-edit-config">
                  <span className={`h-9 w-9 shrink-0 grid place-items-center rounded-full text-white ${problem ? "bg-amber-500" : "bg-emerald-500"}`}>
                    {problem ? <AlertTriangle className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{problem ? "Something to fix" : "Configuration Valid"}</p>
                    <p className="text-[13px] text-muted-foreground">
                      {problem || `${repeatLabel} • ${endLabel} • ${form.reminders.length} reminder${form.reminders.length === 1 ? "" : "s"}`}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* ═══ Advanced ═══ */}
            {tab === "advanced" && (
              <div className="space-y-3">
                {!isTask && (
                  <label className="flex items-center justify-between gap-3 rounded-2xl border border-border p-3.5">
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">Requires check-off</span>
                      <span className="block text-[13px] text-muted-foreground">A date that passes without being checked off or skipped shows as missed.</span>
                    </span>
                    <input type="checkbox" className="h-5 w-5 shrink-0 accent-[hsl(var(--accent-hsl))]"
                      checked={form.requireComplete} onChange={(e) => set("requireComplete", e.target.checked)}
                      data-testid="cal-edit-require" />
                  </label>
                )}
                {mode === "series" && series.recurrence !== "none" && (
                  <button type="button"
                    onClick={() => arm.confirm("pause", () => void pauseSeries())}
                    className="w-full flex items-center gap-3 rounded-2xl border border-border p-3.5 text-left hover:bg-muted/50"
                    data-testid="cal-edit-pause">
                    <PauseCircle className="h-5 w-5 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">{arm.isArmed("pause") ? "Tap again to pause" : "Pause series"}</span>
                      <span className="block text-[13px] text-muted-foreground">Hides upcoming dates until you resume it. Nothing is deleted.</span>
                    </span>
                  </button>
                )}
                {mode === "series" && (
                  <button type="button"
                    onClick={() => arm.confirm("delete", () => void deleteSeries())}
                    className="w-full flex items-center gap-3 rounded-2xl border border-red-500/40 p-3.5 text-left text-red-500 hover:bg-red-500/10"
                    data-testid="cal-edit-delete">
                    <Trash2 className="h-5 w-5" />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">
                        {arm.isArmed("delete") ? "Tap again to delete" : isTask ? "Delete task" : series.recurrence !== "none" ? "Delete entire series" : "Delete event"}
                      </span>
                      <span className="block text-[13px] opacity-80">
                        {series.recurrence !== "none" ? "Removes every date. To remove one date, skip that occurrence instead." : "Removes this date."}
                      </span>
                    </span>
                  </button>
                )}
              </div>
            )}

            {problem && tab !== "reminders" && (
              <p className="text-[13px] text-amber-500" data-testid="cal-edit-problem">{problem}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function EndRow({ active, onClick, icon: Icon, label, testId, children }: {
  active: boolean; onClick: () => void; icon: any; label: string; testId: string; children?: React.ReactNode;
}) {
  return (
    <div className="px-3.5 py-3">
      <button type="button" role="radio" aria-checked={active} onClick={onClick}
        className="w-full flex items-center gap-3 text-left text-sm" data-testid={testId}>
        <span className={`h-5 w-5 shrink-0 rounded-full border-2 grid place-items-center ${active ? "border-[hsl(var(--accent-hsl))]" : "border-muted-foreground/50"}`}>
          {active && <span className="h-2.5 w-2.5 rounded-full bg-[hsl(var(--accent-hsl))]" />}
        </span>
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className={active ? "font-semibold" : ""}>{label}</span>
      </button>
      {children}
    </div>
  );
}

function SummaryCard({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="rounded-2xl border p-3.5 border-[hsl(var(--accent-hsl)/0.35)] bg-[hsl(var(--accent-hsl)/0.08)]" data-testid="cal-edit-summary">
      <p className="text-sm font-semibold mb-0.5">{title}</p>
      {lines.map((l, i) => <p key={i} className="text-[13px] text-muted-foreground">{l}</p>)}
    </div>
  );
}

function PreviewCard({ dates, todayISO }: { dates: string[]; todayISO: string }) {
  return (
    <section className="rounded-2xl border border-border overflow-hidden" data-testid="cal-edit-preview">
      <div className="flex items-baseline justify-between px-3.5 pt-3 pb-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <CalendarDays className="h-4 w-4 text-[hsl(var(--accent-hsl))]" /> Preview
        </h3>
        <span className="text-[12px] text-muted-foreground">Next {dates.length || ""} Occurrence{dates.length === 1 ? "" : "s"}</span>
      </div>
      {dates.length === 0 ? (
        <p className="px-3.5 pb-3.5 text-[13px] text-muted-foreground">Nothing is scheduled ahead with these settings.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {dates.map((d) => (
            <li key={d} className="flex items-center gap-3 px-3.5 py-2.5 text-sm" data-testid={`cal-edit-preview-${d}`}>
              <CalendarDays className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 tabular-nums">{fmtDate(d)}</span>
              <span className="text-[12px] text-muted-foreground">{relativeDayLabel(d, todayISO)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default EditSeriesScreen;
