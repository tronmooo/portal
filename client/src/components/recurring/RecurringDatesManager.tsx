// ── Recurring Dates manager (2026-07-21) ──────────────────────────────────────
// The dedicated management screen for recurring dates — anniversaries,
// birthdays, bills, renewals, maintenance, appointments, subscriptions, and
// custom repeating dates. Lives as a tab on the Calendar page.
//
// A recurring date IS a CalendarEvent with recurrence + rd:* tags (see
// shared/recurring-dates for the full model), so everything managed here
// automatically syncs to the calendar timeline, the dashboard's Upcoming
// Dates, the notification bell, and the linked profile/asset pages. Checking
// off ONE occurrence marks only that date done — the series stays live and
// the next occurrence rolls forward automatically.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { WeekdayPicker, isCustomDaySet, seedDaySet, CUSTOM_DAYS_VALUE } from "@/components/recurring/WeekdayPicker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { passesProfileFilter } from "@shared/profile-filter";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  CalendarHeart, Cake, Receipt, RefreshCw, Wrench, Stethoscope, CreditCard,
  Repeat, Plus, Check, ChevronDown, ChevronRight, MoreHorizontal, Pause, Play,
  Archive, ArchiveRestore, Pencil, CalendarClock, SkipForward, Trash2, Users, Bell,
  Wallet, CheckSquare, FileText, Banknote,
} from "lucide-react";
import {
  RECURRING_KINDS, kindDef, parseRecurringMeta, metaToTags, markOccurrence,
  setSeriesFlag, pruneOccurrenceTags, expandRecurrenceDates, nextOccurrence,
  occurrenceStatus, seriesStatus, humanRecurrenceLabel, addDaysISO,
  REMINDER_PRESETS, RD_TAG,
  type RecurringKind, type SeriesStatus,
} from "@shared/recurring-dates";
import {
  KIND_LABELS, relativeDayLabel,
  type CalendarOccurrence, type OccurrenceKind,
} from "@shared/calendar-occurrences";
import { useCalendarOccurrences } from "@/hooks/useCalendarOccurrences";
import { CalendarItemDetail } from "@/components/calendar/CalendarItemDetail";
import { useLocation } from "wouter";

// Icon + accent per calendar kind. The detail panel uses the same mapping, so
// a birthday looks identical wherever it appears.
const OCC_ICONS: Record<OccurrenceKind, any> = {
  birthday: Cake, anniversary: CalendarHeart, subscription: CreditCard,
  liability: Wallet, bill: Receipt, renewal: RefreshCw, maintenance: Wrench,
  appointment: Stethoscope, reminder: Bell, task: CheckSquare, habit: Repeat,
  document: FileText, event: CalendarClock, custom: Repeat, income: Banknote,
};
const KIND_HSL: Record<OccurrenceKind, string> = {
  birthday: "262 75% 64%", anniversary: "330 75% 60%", subscription: "220 80% 62%",
  liability: "270 70% 62%", bill: "0 72% 58%", renewal: "38 92% 52%",
  maintenance: "199 85% 55%", appointment: "155 62% 44%", reminder: "48 90% 55%",
  task: "210 80% 60%", habit: "170 60% 45%", document: "215 15% 60%",
  event: "240 8% 60%", custom: "240 8% 60%", income: "150 62% 44%",
};

const KIND_ICONS: Record<RecurringKind, any> = {
  anniversary: CalendarHeart, birthday: Cake, bill: Receipt, renewal: RefreshCw,
  maintenance: Wrench, appointment: Stethoscope, subscription: CreditCard, custom: Repeat,
};

const todayISO = () => new Date().toLocaleDateString("en-CA");

const fmtDate = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const fmtShort = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** Kind for series created OUTSIDE the manager (plain recurring events). */
function inferKind(ev: any): RecurringKind {
  const meta = parseRecurringMeta(ev.tags);
  if (meta.kind) return meta.kind;
  const t = String(ev.title || "").toLowerCase();
  if (t.includes("birthday")) return "birthday";
  if (t.includes("anniversary")) return "anniversary";
  if (/\b(bill|payment|rent)\b/.test(t)) return "bill";
  if (/\b(renew|renewal|registration)\b/.test(t)) return "renewal";
  if (/\b(maintenance|service|oil change|filter)\b/.test(t)) return "maintenance";
  if (/\b(appointment|doctor|dentist|vet|checkup|check-up)\b/.test(t)) return "appointment";
  if (/\b(subscription)\b/.test(t)) return "subscription";
  return "custom";
}

const STATUS_META: Record<SeriesStatus, { label: string; hsl: string }> = {
  upcoming: { label: "Upcoming", hsl: "155 62% 44%" },
  overdue: { label: "Overdue", hsl: "0 72% 58%" },
  completed: { label: "Completed", hsl: "220 10% 55%" },
  paused: { label: "Paused", hsl: "38 92% 52%" },
  archived: { label: "Archived", hsl: "240 6% 50%" },
};
const STATUS_ORDER: Array<SeriesStatus | "all"> = ["all", "upcoming", "overdue", "completed", "paused", "archived"];

function invalidateRecurringSurfaces() {
  for (const key of ["/api/events", "/api/calendar/timeline", "/api/dashboard-enhanced", "/api/notifications", "/api/stats", "/api/profiles"]) {
    queryClient.invalidateQueries({ queryKey: [key] });
  }
}

// ─── Series form dialog (add · edit series · edit this-and-future) ────────────

interface SeriesFormState {
  title: string;
  kind: RecurringKind;
  profileId: string;
  date: string;
  recurrence: string;
  recurrenceEnd: string;
  remindDays: string; // "" = none
  notes: string;
  requireComplete: boolean;
}

function formFromEvent(ev: any | null): SeriesFormState {
  const meta = ev ? parseRecurringMeta(ev.tags) : null;
  return {
    title: ev?.title || "",
    kind: ev ? inferKind(ev) : "custom",
    profileId: ev?.linkedProfiles?.[0] || "",
    date: (ev?.date || todayISO()).slice(0, 10),
    recurrence: ev?.recurrence && ev.recurrence !== "none" ? ev.recurrence : "yearly",
    recurrenceEnd: (ev?.recurrenceEnd || "").slice(0, 10),
    remindDays: meta && meta.remindDays != null ? String(meta.remindDays) : "",
    notes: ev?.description || "",
    requireComplete: !!meta?.requireComplete,
  };
}

function SeriesDialog({ mode, event, profiles, onClose }: {
  mode: "add" | "edit" | "future";
  event: any | null;
  profiles: any[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<SeriesFormState>(() => {
    const f = formFromEvent(event);
    if (mode === "future" && event) {
      // Editing "this and future": the NEW series starts at the next occurrence.
      const next = nextOccurrence(event, todayISO());
      if (next) f.date = next;
    }
    return f;
  });
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof SeriesFormState>(k: K, v: SeriesFormState[K]) => setForm(s => ({ ...s, [k]: v }));

  const buildBody = () => {
    const kd = kindDef(form.kind);
    const meta = parseRecurringMeta(mode === "edit" && event ? event.tags : []);
    meta.isRecurringDate = true;
    meta.kind = form.kind;
    meta.remindDays = form.remindDays === "" ? null : Math.max(0, parseInt(form.remindDays, 10) || 0);
    meta.requireComplete = form.requireComplete;
    return {
      title: form.title.trim(),
      date: form.date,
      allDay: true,
      category: kd.eventCategory,
      recurrence: form.recurrence,
      ...(form.recurrenceEnd ? { recurrenceEnd: form.recurrenceEnd } : {}),
      description: form.notes.trim() || undefined,
      linkedProfiles: form.profileId ? [form.profileId] : [],
      tags: metaToTags(meta, mode === "edit" && event ? event.tags : []),
    };
  };

  const save = async () => {
    if (!form.title.trim() || !form.date) return;
    setSaving(true);
    try {
      const body = buildBody();
      if (mode === "edit" && event) {
        await apiRequest("PATCH", `/api/events/${event.id}`, body);
        toast({ title: "Recurring date updated", description: form.title.trim() });
      } else if (mode === "future" && event) {
        // Split the series: the old one ends the day before the new start;
        // past occurrences and their checked-off state stay intact on it.
        await apiRequest("PATCH", `/api/events/${event.id}`, { recurrenceEnd: addDaysISO(form.date, -1) });
        await apiRequest("POST", "/api/events", { ...body, source: "manual" });
        toast({ title: "Series updated from " + fmtShort(form.date), description: "Past occurrences kept their history." });
      } else {
        await apiRequest("POST", "/api/events", { ...body, source: "manual" });
        toast({ title: "Recurring date added", description: form.title.trim() });
      }
      invalidateRecurringSurfaces();
      onClose();
    } catch (e: any) {
      toast({ title: "Couldn't save", description: e?.message || "Try again", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const profileGroups: Array<{ label: string; items: any[] }> = useMemo(() => {
    const people = profiles.filter(p => ["self", "person", "pet"].includes(p.type));
    const assets = profiles.filter(p => ["vehicle", "asset", "property", "investment", "account"].includes(p.type));
    const liabilities = profiles.filter(p => ["liability", "loan", "subscription", "insurance"].includes(p.type));
    const other = profiles.filter(p => !people.includes(p) && !assets.includes(p) && !liabilities.includes(p));
    return [
      { label: "People & pets", items: people },
      { label: "Assets", items: assets },
      { label: "Liabilities & plans", items: liabilities },
      { label: "Other", items: other },
    ].filter(g => g.items.length > 0);
  }, [profiles]);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md max-h-[90dvh] overflow-y-auto" data-testid="dialog-recurring-date">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {mode === "add" ? "New recurring date" : mode === "edit" ? "Edit series" : "Edit this & future occurrences"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {mode === "future"
              ? "Past occurrences keep their dates and check-off history; changes apply from the next occurrence onward."
              : "Repeats forever until you end, pause, or archive it. Each occurrence can be checked off on its own."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Title</Label>
            <Input value={form.title} autoFocus placeholder="e.g. Our anniversary, Car registration renewal"
              onChange={e => set("title", e.target.value)} data-testid="input-rd-title" />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Type</Label>
            <div className="grid grid-cols-4 gap-1.5">
              {RECURRING_KINDS.map(k => {
                const Icon = KIND_ICONS[k.kind];
                const active = form.kind === k.kind;
                return (
                  <button key={k.kind} type="button" onClick={() => set("kind", k.kind)}
                    className={`rounded-lg border px-1 py-1.5 flex flex-col items-center gap-0.5 text-[11px] transition-colors ${active ? "font-semibold" : "text-muted-foreground hover:text-foreground"}`}
                    style={active ? { borderColor: `hsl(${k.hsl} / 0.6)`, background: `hsl(${k.hsl} / 0.12)`, color: `hsl(${k.hsl})` } : {}}
                    data-testid={`rd-kind-${k.kind}`}>
                    <Icon className="h-3.5 w-3.5" />
                    {k.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Linked to</Label>
            <Select value={form.profileId || "none"} onValueChange={v => set("profileId", v === "none" ? "" : v)}>
              <SelectTrigger className="h-9 text-xs" data-testid="select-rd-profile"><SelectValue placeholder="No link" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not linked</SelectItem>
                {profileGroups.map(g => (
                  <div key={g.label}>
                    <p className="px-2 pt-1.5 pb-0.5 micro-label text-muted-foreground">{g.label}</p>
                    {g.items.map((p: any) => (
                      <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                    ))}
                  </div>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">{mode === "future" ? "Applies from" : "First date"}</Label>
              <Input type="date" value={form.date} onChange={e => set("date", e.target.value)} data-testid="input-rd-date" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Repeats</Label>
              <Select
                value={isCustomDaySet(form.recurrence) ? CUSTOM_DAYS_VALUE : form.recurrence}
                onValueChange={v => set("recurrence", v === CUSTOM_DAYS_VALUE ? seedDaySet(form.date) : v)}
              >
                <SelectTrigger className="h-9 text-xs" data-testid="select-rd-recurrence"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekdays">Every weekday</SelectItem>
                  <SelectItem value="weekends">Weekends</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="biweekly">Every 2 weeks</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="yearly">Yearly</SelectItem>
                  <SelectItem value={CUSTOM_DAYS_VALUE}>Specific days…</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {isCustomDaySet(form.recurrence) && (
            <WeekdayPicker
              recurrence={form.recurrence}
              onChange={r => set("recurrence", r)}
              testId="rd-weekday-picker"
            />
          )}

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Ends <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input type="date" value={form.recurrenceEnd} onChange={e => set("recurrenceEnd", e.target.value)} data-testid="input-rd-end" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Reminder</Label>
              <Select value={form.remindDays === "" ? "none" : form.remindDays} onValueChange={v => set("remindDays", v === "none" ? "" : v)}>
                <SelectTrigger className="h-9 text-xs" data-testid="select-rd-remind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {REMINDER_PRESETS.map(r => (
                    <SelectItem key={String(r.value)} value={r.value == null ? "none" : String(r.value)}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Notes <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Textarea value={form.notes} rows={2} className="text-xs" placeholder="Anything worth remembering about this date"
              onChange={e => set("notes", e.target.value)} data-testid="input-rd-notes" />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <div>
              <p className="text-xs font-medium">Requires check-off</p>
              <p className="text-[11px] text-muted-foreground">Missed occurrences show as overdue until done or skipped</p>
            </div>
            <Switch checked={form.requireComplete} onCheckedChange={v => set("requireComplete", v)} data-testid="switch-rd-require" />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" disabled={!form.title.trim() || !form.date || saving} onClick={save} data-testid="btn-rd-save">
              {saving ? "Saving…" : mode === "add" ? "Add" : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Small action dialogs ─────────────────────────────────────────────────────

function MoveNextDialog({ event, onClose }: { event: any; onClose: () => void }) {
  const { toast } = useToast();
  const next = nextOccurrence(event, todayISO());
  const [date, setDate] = useState(next || todayISO());
  const [busy, setBusy] = useState(false);
  const move = async () => {
    if (!next || !date) return;
    setBusy(true);
    try {
      // Skip the scheduled occurrence and place a one-off on the chosen date.
      // The rest of the series is untouched.
      const meta = parseRecurringMeta(event.tags);
      await apiRequest("PATCH", `/api/events/${event.id}`, { tags: markOccurrence(event.tags, next, "skip") });
      await apiRequest("POST", "/api/events", {
        title: event.title,
        date,
        allDay: true,
        category: event.category,
        recurrence: "none",
        description: event.description || undefined,
        linkedProfiles: event.linkedProfiles || [],
        tags: metaToTags({ ...meta, paused: false, archived: false, completedDates: [], skippedDates: [] }, []),
        source: "manual",
      });
      invalidateRecurringSurfaces();
      toast({ title: `Moved to ${fmtShort(date)}`, description: `${fmtShort(next)} was skipped; the series continues on schedule after that.` });
      onClose();
    } catch (e: any) {
      toast({ title: "Couldn't move", description: e?.message || "Try again", variant: "destructive" });
    } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xs" data-testid="dialog-rd-move">
        <DialogHeader>
          <DialogTitle className="text-sm">Move next occurrence</DialogTitle>
          <DialogDescription className="text-xs">
            {next ? `Currently ${fmtDate(next)}. Only this occurrence moves — the series keeps its schedule.` : "No upcoming occurrence to move."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input type="date" value={date} onChange={e => setDate(e.target.value)} data-testid="input-rd-move-date" />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" disabled={!next || !date || busy} onClick={move} data-testid="btn-rd-move-save">{busy ? "Moving…" : "Move"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReassignDialog({ event, profiles, onClose }: { event: any; profiles: any[]; onClose: () => void }) {
  const { toast } = useToast();
  const [profileId, setProfileId] = useState(event.linkedProfiles?.[0] || "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await apiRequest("PATCH", `/api/events/${event.id}`, { linkedProfiles: profileId ? [profileId] : [] });
      invalidateRecurringSurfaces();
      const name = profiles.find(p => p.id === profileId)?.name;
      toast({ title: name ? `Reassigned to ${name}` : "Unlinked", description: event.title });
      onClose();
    } catch (e: any) {
      toast({ title: "Couldn't reassign", description: e?.message || "Try again", variant: "destructive" });
    } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xs" data-testid="dialog-rd-reassign">
        <DialogHeader>
          <DialogTitle className="text-sm">Reassign</DialogTitle>
          <DialogDescription className="text-xs">Link "{event.title}" to a different profile, asset, or liability.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Select value={profileId || "none"} onValueChange={v => setProfileId(v === "none" ? "" : v)}>
            <SelectTrigger className="h-9 text-xs" data-testid="select-rd-reassign"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Not linked</SelectItem>
              {profiles.map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" disabled={busy} onClick={save} data-testid="btn-rd-reassign-save">{busy ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Series card ──────────────────────────────────────────────────────────────

function SeriesCard({ ev, profiles, onEdit, onEditFuture, onMove, onReassign }: {
  ev: any;
  profiles: any[];
  onEdit: () => void;
  onEditFuture: () => void;
  onMove: () => void;
  onReassign: () => void;
}) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const today = todayISO();
  const meta = parseRecurringMeta(ev.tags);
  const kind = inferKind(ev);
  const kd = kindDef(kind);
  const Icon = KIND_ICONS[kind];
  const status = seriesStatus(ev, today);
  const sm = STATUS_META[status];
  const next = nextOccurrence(ev, today);
  const owner = profiles.find((p: any) => (ev.linkedProfiles || []).includes(p.id));
  const daysUntil = next ? Math.round((new Date(`${next}T12:00:00`).getTime() - new Date(`${today}T12:00:00`).getTime()) / 86400000) : null;

  const patchTags = async (tags: string[], msg: string) => {
    try {
      await apiRequest("PATCH", `/api/events/${ev.id}`, { tags });
      invalidateRecurringSurfaces();
      toast({ title: msg });
    } catch (e: any) {
      toast({ title: "Couldn't update", description: e?.message || "Try again", variant: "destructive" });
    }
  };
  const mark = (date: string, action: "done" | "skip" | "clear") =>
    patchTags(
      pruneOccurrenceTags(markOccurrence(ev.tags, date, action), today),
      action === "done" ? `Checked off ${fmtShort(date)} — next one stays on schedule`
        : action === "skip" ? `Skipped ${fmtShort(date)}` : `Restored ${fmtShort(date)}`,
    );

  const occurrences = useMemo(() => {
    const all = expandRecurrenceDates(ev.date, ev.recurrence, {
      recurrenceEnd: ev.recurrenceEnd || undefined,
      windowStart: addDaysISO(today, -62),
      windowEnd: addDaysISO(today, 370),
      cap: 450,
    });
    const past = all.filter(d => d < today).slice(-3);
    const future = all.filter(d => d >= today).slice(0, 5);
    return [...past, ...future];
  }, [ev.date, ev.recurrence, ev.recurrenceEnd, today]);

  const deleteSeries = async () => {
    try {
      await apiRequest("DELETE", `/api/events/${ev.id}`);
      invalidateRecurringSurfaces();
      toast({ title: "Series deleted", description: ev.title });
    } catch (e: any) {
      toast({ title: "Couldn't delete", description: e?.message || "Try again", variant: "destructive" });
    }
  };

  return (
    <div className="bubble overflow-hidden" style={{ ["--accent-hsl" as any]: kd.hsl }} data-testid={`rd-series-${ev.id}`}>
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <button type="button" onClick={() => setExpanded(e => !e)} className="flex items-start gap-2.5 flex-1 min-w-0 text-left">
          <span className="mt-0.5 shrink-0 w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: `hsl(${kd.hsl} / 0.14)` }}>
            <Icon className="w-4 h-4" style={{ color: `hsl(${kd.hsl})` }} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="text-sm font-semibold truncate">{ev.title}</p>
              <Badge variant="outline" className="text-[11px] px-1.5 py-0 h-4 border-0" style={{ background: `hsl(${sm.hsl} / 0.14)`, color: `hsl(${sm.hsl})` }}>{sm.label}</Badge>
            </div>
            <p className="text-[11px] text-muted-foreground truncate">
              {humanRecurrenceLabel(ev.recurrence, ev.date)}
              {owner ? ` · ${owner.name}` : ""}
              {meta.remindDays != null ? ` · 🔔 ${meta.remindDays === 0 ? "day of" : `${meta.remindDays}d before`}` : ""}
            </p>
            {next && status !== "paused" && (
              <p className="text-[11px] mt-0.5 font-medium tabular-nums" style={{ color: `hsl(${kd.hsl})` }}>
                Next: {fmtDate(next)}{daysUntil != null ? ` · ${daysUntil === 0 ? "today" : daysUntil === 1 ? "tomorrow" : `in ${daysUntil} days`}` : ""}
              </p>
            )}
          </div>
          {expanded ? <ChevronDown className="h-4 w-4 mt-1 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 mt-1 text-muted-foreground shrink-0" />}
        </button>

        {/* Quick check-off for the next occurrence */}
        {next && (status === "upcoming" || status === "overdue") && (
          <Button size="sm" variant="outline" className="h-7 text-[11px] shrink-0 mt-0.5"
            onClick={() => mark(next, "done")} data-testid={`rd-checkoff-${ev.id}`}>
            <Check className="h-3 w-3 mr-1" /> Done
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0 mt-0.5" data-testid={`rd-menu-${ev.id}`}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="text-xs">
            <DropdownMenuItem onClick={onEdit}><Pencil className="h-3.5 w-3.5 mr-2" />Edit series</DropdownMenuItem>
            <DropdownMenuItem onClick={onEditFuture}><CalendarClock className="h-3.5 w-3.5 mr-2" />Edit this &amp; future</DropdownMenuItem>
            <DropdownMenuItem onClick={onMove} disabled={!next}><CalendarClock className="h-3.5 w-3.5 mr-2" />Move next date</DropdownMenuItem>
            <DropdownMenuItem onClick={() => next && mark(next, "skip")} disabled={!next}><SkipForward className="h-3.5 w-3.5 mr-2" />Skip next occurrence</DropdownMenuItem>
            <DropdownMenuItem onClick={onReassign}><Users className="h-3.5 w-3.5 mr-2" />Reassign profile</DropdownMenuItem>
            <DropdownMenuSeparator />
            {meta.paused
              ? <DropdownMenuItem onClick={() => patchTags(setSeriesFlag(ev.tags, "paused", false), "Resumed")}><Play className="h-3.5 w-3.5 mr-2" />Resume</DropdownMenuItem>
              : <DropdownMenuItem onClick={() => patchTags(setSeriesFlag(ev.tags, "paused", true), "Paused — occurrences hidden until resumed")}><Pause className="h-3.5 w-3.5 mr-2" />Pause</DropdownMenuItem>}
            {meta.archived
              ? <DropdownMenuItem onClick={() => patchTags(setSeriesFlag(ev.tags, "archived", false), "Unarchived")}><ArchiveRestore className="h-3.5 w-3.5 mr-2" />Unarchive</DropdownMenuItem>
              : <DropdownMenuItem onClick={() => patchTags(setSeriesFlag(ev.tags, "archived", true), "Archived — hidden everywhere except here")}><Archive className="h-3.5 w-3.5 mr-2" />Archive</DropdownMenuItem>}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-red-500 focus:text-red-500" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-3.5 w-3.5 mr-2" />Delete series
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {ev.description && expanded && (
        <p className="px-3 pb-1 -mt-1 text-[11px] text-muted-foreground">{ev.description}</p>
      )}

      {/* Occurrence list — each date checks off / skips independently */}
      {expanded && (
        <div className="border-t border-border/60 divide-y divide-border/40" data-testid={`rd-occurrences-${ev.id}`}>
          {occurrences.length === 0 && (
            <p className="px-3 py-3 text-[11px] text-muted-foreground text-center">No occurrences in the surrounding window.</p>
          )}
          {occurrences.map(d => {
            const st = occurrenceStatus(meta, d, today);
            const stColor = st === "done" ? "155 62% 44%" : st === "skipped" ? "240 6% 55%" : st === "overdue" ? "0 72% 58%" : st === "today" ? "38 92% 52%" : "220 10% 55%";
            return (
              <div key={d} className="flex items-center gap-2 px-3 py-1.5" data-testid={`rd-occ-${ev.id}-${d}`}>
                <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: `hsl(${stColor})` }} />
                <span className={`text-xs tabular-nums flex-1 ${st === "done" || st === "skipped" ? "line-through text-muted-foreground" : ""}`}>{fmtDate(d)}</span>
                <span className="micro-label font-semibold" style={{ color: `hsl(${stColor})` }}>
                  {st === "past" ? "" : st}
                </span>
                {(st === "done" || st === "skipped") ? (
                  <Button size="sm" variant="ghost" className="h-6 text-[11px] px-2" onClick={() => mark(d, "clear")} data-testid={`rd-occ-undo-${d}`}>Undo</Button>
                ) : (
                  <>
                    <Button size="sm" variant="ghost" className="h-6 text-[11px] px-2 text-emerald-500" onClick={() => mark(d, "done")} data-testid={`rd-occ-done-${d}`}>
                      <Check className="h-3 w-3 mr-0.5" />Done
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 text-[11px] px-2 text-muted-foreground" onClick={() => mark(d, "skip")} data-testid={`rd-occ-skip-${d}`}>Skip</Button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">Delete "{ev.title}"?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              The whole recurring series and its check-off history disappear from the calendar, dashboard,
              notifications, and any linked profile. To remove just one date, use Skip on that occurrence instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8 text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction className="h-8 text-xs bg-red-600 hover:bg-red-700" onClick={deleteSeries} data-testid={`rd-delete-confirm-${ev.id}`}>
              Delete series
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Unified occurrence list ──────────────────────────────────────────────────
// Everything the calendar knows about — birthdays, anniversaries, bills,
// subscriptions, liabilities, reminders, tasks, documents and plain events —
// comes from ONE engine (shared/calendar-occurrences) via one hook, already
// deduplicated. There is no longer a second "from across your app" collection
// competing with this one: two lists meant two answers, and it was never clear
// which was authoritative.
//
// Each row opens the standardized detail panel, which is identical for every
// type and routes Edit straight to the source record.

function OccurrenceRow({ occ, todayISO, profileName, onOpen }: {
  occ: CalendarOccurrence;
  todayISO: string;
  profileName: (id: string) => string | undefined;
  onOpen: (o: CalendarOccurrence) => void;
}) {
  const hsl = KIND_HSL[occ.kind] ?? "240 8% 60%";
  const Icon = OCC_ICONS[occ.kind] ?? Repeat;
  const owner = occ.source.profileId ? profileName(occ.source.profileId) : undefined;
  const done = occ.status === "done" || occ.status === "skipped";
  return (
    <button type="button" onClick={() => onOpen(occ)}
      className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-muted/40 transition-colors"
      data-testid={`cal-row-${occ.id}`}>
      <span className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center"
        style={{ background: `hsl(${hsl} / 0.14)` }}>
        <Icon className="w-3.5 h-3.5" style={{ color: `hsl(${hsl})` }} />
      </span>
      <div className="flex-1 min-w-0">
        <p className={`text-xs font-semibold truncate ${done ? "line-through text-muted-foreground" : ""}`}>
          {occ.title}
        </p>
        <p className="text-[11px] text-muted-foreground truncate">
          {KIND_LABELS[occ.kind]}
          {owner ? ` · ${owner}` : ""}
          {occ.amount != null ? ` · $${occ.amount.toFixed(2)}` : ""}
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className="text-[11px] font-semibold tabular-nums">{fmtShort(occ.effectiveDate)}</p>
        <p className="text-[11px] text-muted-foreground">{relativeDayLabel(occ.effectiveDate, todayISO)}</p>
      </div>
      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
    </button>
  );
}

// ─── Manager ──────────────────────────────────────────────────────────────────

export function RecurringDatesManager({ filterIds, filterMode }: {
  filterIds: string[];
  filterMode: "all" | "selected" | "everyone";
}) {
  const [statusFilter, setStatusFilter] = useState<SeriesStatus | "all">("all");
  const [detail, setDetail] = useState<CalendarOccurrence | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: "add" }
    | { kind: "edit" | "future" | "move" | "reassign"; event: any }
    | null
  >(null);

  const { data: events = [] } = useQuery<any[]>({
    queryKey: ["/api/events"],
    queryFn: () => apiRequest("GET", "/api/events").then(r => r.json()).catch(() => []),
  });
  const { data: profilesRaw } = useQuery<any>({ queryKey: ["/api/profiles"] });
  const profiles: any[] = Array.isArray(profilesRaw) ? profilesRaw : (profilesRaw?.data ?? []);

  // ONE source for every date on this screen. The hook fetches each system's
  // records, runs them through the adapters and the occurrence engine, and
  // returns a deduplicated stream — so a birthday that exists both as a profile
  // field and as a typed-in event arrives once, not twice.
  const cal = useCalendarOccurrences({ filterIds, filterMode });
  const today = todayISO();

  // Managed rd:* series still get their own editable cards above the stream.
  const series = useMemo(() => {
    let list = (Array.isArray(events) ? events : []).filter(e => e.recurrence && e.recurrence !== "none");
    if (filterMode === "selected" && filterIds.length > 0) {
      list = list.filter(e => passesProfileFilter(e.linkedProfiles, { selectedIds: filterIds, allProfiles: profiles }));
    }
    return list
      .map(e => ({ ev: e, status: seriesStatus(e, today), next: nextOccurrence(e, today) }))
      .sort((a, b) => {
        const rank: Record<SeriesStatus, number> = { overdue: 0, upcoming: 1, paused: 2, completed: 3, archived: 4 };
        if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
        return (a.next || "9999").localeCompare(b.next || "9999");
      });
    // `profiles` is a real dependency: passesProfileFilter resolves self-owned
    // profile ids from `allProfiles`, so orphan recurring events are dropped
    // when profiles is still empty and must be re-evaluated once it loads.
    // Omitting it left the empty state stuck after navigation (BUG 2026-07-21).
  }, [events, filterMode, filterIds, today, profiles]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: series.length };
    for (const s of series) c[s.status] = (c[s.status] || 0) + 1;
    return c;
  }, [series]);

  const visible = statusFilter === "all" ? series : series.filter(s => s.status === statusFilter);

  // The stream. Series already shown as an editable card above are omitted so
  // the same date never appears twice on one screen — the old "All 23" vs
  // "From across your app · 69" split is gone: one list, one count.
  const cardSeriesIds = useMemo(
    () => new Set(series.map(s => `event:${s.ev.id}`)),
    [series],
  );
  const streamOccurrences = useMemo(
    () => cal.occurrences.filter(o => o.effectiveDate >= today && !cardSeriesIds.has(o.seriesId)),
    [cal.occurrences, today, cardSeriesIds],
  );

  // When two records described the same date, we kept the authoritative one and
  // collapsed the other. Say so rather than silently hiding a record the user
  // created — "where did my event go?" is a worse bug than a duplicate.
  const duplicateNoteFor = (occ: CalendarOccurrence): string | undefined => {
    const dupes = cal.duplicatesBySeries.get(occ.seriesId);
    if (!dupes || dupes.length === 0) return undefined;
    const systems = Array.from(new Set(dupes.map(id => id.split(":")[0])));
    return `Also tracked as ${systems.join(" and ")} ${dupes.length === 1 ? "a record" : "records"} — shown once here, managed at the source above.`;
  };

  return (
    <div className="space-y-2.5" data-testid="recurring-dates-manager">
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1 overflow-x-auto pb-0.5">
          {STATUS_ORDER.map(s => {
            const label = s === "all" ? "All" : STATUS_META[s].label;
            const n = counts[s] || 0;
            if (s !== "all" && n === 0) return null;
            return (
              <button key={s} type="button" onClick={() => setStatusFilter(s)}
                className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${statusFilter === s ? "bg-primary text-primary-foreground" : "bg-muted/60 text-muted-foreground hover:text-foreground"}`}
                data-testid={`rd-filter-${s}`}>
                {label} {n > 0 && <span className="tabular-nums opacity-70">{n}</span>}
              </button>
            );
          })}
        </div>
        <Button size="sm" className="h-8 text-xs shrink-0" onClick={() => setDialog({ kind: "add" })} data-testid="btn-rd-add">
          <Plus className="h-3.5 w-3.5 mr-1" /> Recurring date
        </Button>
      </div>

      {visible.length === 0 && streamOccurrences.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-6 text-center">
          <Bell className="h-6 w-6 mx-auto text-muted-foreground/50 mb-2" />
          <p className="text-sm font-medium">No recurring dates{statusFilter !== "all" ? ` (${statusFilter})` : ""}</p>
          <p className="text-xs text-muted-foreground mt-0.5 max-w-xs mx-auto">
            Track anniversaries, birthdays, bills, renewals, maintenance, and appointments — each occurrence
            checks off on its own while the series keeps going.
          </p>
          <Button size="sm" className="mt-3 h-8 text-xs" onClick={() => setDialog({ kind: "add" })} data-testid="btn-rd-add-empty">
            <Plus className="h-3.5 w-3.5 mr-1" /> Add your first
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map(({ ev }) => (
            <SeriesCard key={ev.id} ev={ev} profiles={profiles}
              onEdit={() => setDialog({ kind: "edit", event: ev })}
              onEditFuture={() => setDialog({ kind: "future", event: ev })}
              onMove={() => setDialog({ kind: "move", event: ev })}
              onReassign={() => setDialog({ kind: "reassign", event: ev })} />
          ))}
        </div>
      )}

      {/* THE calendar stream: every date the app knows about, from one engine,
          already deduplicated. Tapping any row opens the same detail panel. */}
      {statusFilter === "all" && streamOccurrences.length > 0 && (
        <div className="pt-1" data-testid="rd-stream-section">
          <div className="flex items-baseline justify-between px-1 mb-1.5">
            <p className="micro-label text-muted-foreground">
              Upcoming · {streamOccurrences.length}
            </p>
            <p className="text-[11px] text-muted-foreground">birthdays · bills · subscriptions · reminders</p>
          </div>
          <div className="bubble divide-y divide-/50 overflow-hidden">
            {streamOccurrences.slice(0, 60).map(occ => (
              <OccurrenceRow key={occ.id} occ={occ} todayISO={cal.todayISO}
                profileName={cal.profileName} onOpen={setDetail} />
            ))}
          </div>
          <p className="px-1 pt-1 text-[11px] text-muted-foreground">
            Tap any date to see its full schedule, edit it, move it, or remove one occurrence — every
            type opens the same panel, and Edit goes straight to the record it came from.
          </p>
        </div>
      )}

      {detail && (
        <CalendarItemDetail
          occurrence={detail}
          seriesOccurrences={cal.occurrencesForSeries(detail.seriesId)}
          getEventRow={cal.getEventRow}
          profileName={cal.profileName}
          todayISO={cal.todayISO}
          duplicateNote={duplicateNoteFor(detail)}
          onClose={() => setDetail(null)}
        />
      )}

      {dialog?.kind === "add" && <SeriesDialog mode="add" event={null} profiles={profiles} onClose={() => setDialog(null)} />}
      {dialog?.kind === "edit" && <SeriesDialog mode="edit" event={dialog.event} profiles={profiles} onClose={() => setDialog(null)} />}
      {dialog?.kind === "future" && <SeriesDialog mode="future" event={dialog.event} profiles={profiles} onClose={() => setDialog(null)} />}
      {dialog?.kind === "move" && <MoveNextDialog event={dialog.event} onClose={() => setDialog(null)} />}
      {dialog?.kind === "reassign" && <ReassignDialog event={dialog.event} profiles={profiles} onClose={() => setDialog(null)} />}
    </div>
  );
}

// ─── Series dialog host ───────────────────────────────────────────────────────
// The "New recurring date" form is still the right way to CREATE a managed
// series, so RecurringDatesPage borrows it rather than duplicating the form.
// The host owns the dialog state and hands the child an opener.

export function SeriesDialogHost({ children }: {
  children: (openAdd: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { data: profilesRaw } = useQuery<any>({ queryKey: ["/api/profiles"] });
  const profiles: any[] = Array.isArray(profilesRaw) ? profilesRaw : (profilesRaw?.data ?? []);
  return (
    <>
      {children(() => setOpen(true))}
      {open && <SeriesDialog mode="add" event={null} profiles={profiles} onClose={() => setOpen(false)} />}
    </>
  );
}

export default RecurringDatesManager;
