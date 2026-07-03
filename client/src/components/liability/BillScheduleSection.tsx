import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarClock, CheckCircle2, SkipForward, Pause, Play, Pencil, Clock, ChevronDown, ChevronRight, ChevronLeft, Bell } from "lucide-react";
import { BILL_STATUS_META, type BillStatus } from "@shared/liability-status";

type OccStatus = BillStatus | "skipped";
interface Occ {
  date: string; effectiveDate: string; amount: number; status: OccStatus;
  notes?: string; occurrenceId: string; paymentId?: string;
}
interface Schedule {
  id: string; name: string; amount: number; frequency: string;
  family?: string; isRecurring?: boolean;
  firstPayment: string | null; nextDue: { date: string; effectiveDate: string; amount: number } | null;
  lastPaid: string | null; autopay: boolean; paused: boolean; pausedUntil: string | null;
  gracePeriodDays: number | null; lateFee: number | null; reminderLeadDays: number | null;
  totalPayments: number | null; paidCount: number; remainingPayments: number | null; recurrenceEnd: string | null;
  annualTotal: number; calendarSynced: boolean; occurrences: Occ[];
  payments: { id: string; amount: number; date: string }[];
}

const usd = (n: number) => `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dt = (iso?: string | null) => iso ? new Date(iso + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";
const FREQS = ["weekly", "biweekly", "monthly", "quarterly", "yearly"];
const toneClass: Record<string, string> = {
  red: "text-red-600 border-red-600", amber: "text-amber-600 border-amber-600",
  green: "text-green-600 border-green-600", muted: "text-muted-foreground",
};
type Filter = "all" | "upcoming" | "completed" | "missed" | "skipped";

function StatusBadge({ status }: { status: OccStatus }) {
  if (status === "skipped") return <Badge variant="outline" className="text-muted-foreground text-xs h-5">Skipped</Badge>;
  const meta = BILL_STATUS_META[status];
  return <Badge variant="outline" className={`text-xs h-5 ${toneClass[meta.tone]}`}>{meta.label}</Badge>;
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-medium tabular-nums">{value}</p>
    </div>
  );
}

export function BillScheduleSection({ liabilityId }: { liabilityId: string }) {
  const { toast } = useToast();
  const [filter, setFilter] = useState<Filter>("upcoming");
  const [pauseUntil, setPauseUntil] = useState("");
  const [calOpen, setCalOpen] = useState(false);
  const scheduleKey = ["/api/liabilities", liabilityId, "schedule"];

  const { data, isLoading } = useQuery<Schedule>({
    queryKey: scheduleKey,
    queryFn: async () => (await apiRequest("GET", `/api/liabilities/${liabilityId}/schedule?months=12`)).json(),
  });

  const resync = () => {
    queryClient.invalidateQueries({ queryKey: scheduleKey });
    for (const k of ["/api/calendar/timeline", "/api/obligations", "/api/dashboard-enhanced", "/api/profiles", "/api/stats"]) {
      queryClient.invalidateQueries({ queryKey: [k] });
    }
  };
  const run = useMutation({
    mutationFn: async (fn: () => Promise<Response>) => (await fn()).json(),
    onSuccess: (_d, _v, ctx) => { resync(); },
    onError: (e: any) => toast({ title: "Couldn't update the bill", description: e?.message || "Try again.", variant: "destructive" }),
  });
  const act = (fn: () => Promise<Response>, ok: string) =>
    run.mutate(fn, { onSuccess: () => { resync(); toast({ title: ok }); } });

  if (isLoading || !data) {
    return (
      <Card><CardHeader><CardTitle className="text-base flex items-center gap-2"><CalendarClock className="w-4 h-4" />Schedule &amp; Calendar</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">Loading schedule…</p></CardContent></Card>
    );
  }

  const occ = data.occurrences || [];
  const filtered = occ.filter((o) => {
    if (filter === "all") return true;
    if (filter === "upcoming") return o.status === "upcoming" || o.status === "due_today";
    if (filter === "completed") return o.status === "paid";
    if (filter === "missed") return o.status === "overdue";
    if (filter === "skipped") return o.status === "skipped";
    return true;
  });
  const counts = {
    upcoming: occ.filter((o) => o.status === "upcoming" || o.status === "due_today").length,
    completed: occ.filter((o) => o.status === "paid").length,
    missed: occ.filter((o) => o.status === "overdue").length,
    skipped: occ.filter((o) => o.status === "skipped").length,
  };

  return (
    <Card data-testid="bill-schedule-section">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base flex items-center gap-2"><CalendarClock className="w-4 h-4" />Schedule &amp; Calendar</CardTitle>
          {data.isRecurring && (
          <div className="flex items-center gap-2">
            {data.paused ? (
              <Button size="sm" variant="outline" onClick={() => act(() => apiRequest("POST", `/api/liabilities/${liabilityId}/resume`), "Bill resumed")} data-testid="btn-resume">
                <Play className="w-3.5 h-3.5 mr-1" />Resume
              </Button>
            ) : (
              <Popover>
                <PopoverTrigger asChild><Button size="sm" variant="outline" data-testid="btn-pause"><Pause className="w-3.5 h-3.5 mr-1" />Pause</Button></PopoverTrigger>
                <PopoverContent className="w-64 space-y-2">
                  <Label className="text-xs">Pause until (optional)</Label>
                  <Input type="date" value={pauseUntil} onChange={(e) => setPauseUntil(e.target.value)} />
                  <Button size="sm" className="w-full" onClick={() => act(() => apiRequest("POST", `/api/liabilities/${liabilityId}/pause`, pauseUntil ? { until: pauseUntil } : {}), "Bill paused")}>Pause payments</Button>
                </PopoverContent>
              </Popover>
            )}
          </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.paused && (
          <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-xs px-3 py-2">
            Paused{data.pausedUntil ? ` until ${dt(data.pausedUntil)}` : ""} — no occurrences generate while paused.
          </div>
        )}

        {/* Facts grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <Fact label="Next due" value={data.nextDue ? dt(data.nextDue.effectiveDate) : "—"} />
          <Fact label="Amount due" value={usd(data.nextDue?.amount ?? data.amount)} />
          <Fact label="Frequency" value={<span className="capitalize">{data.frequency}</span>} />
          <Fact label="Remaining" value={data.remainingPayments != null
            ? `${data.remainingPayments} of ${data.totalPayments} payment${data.totalPayments === 1 ? "" : "s"}`
            : "Ongoing"} />
          <Fact label="Annual total" value={usd(data.annualTotal)} />
          <Fact label="First payment" value={dt(data.firstPayment)} />
          <Fact label="Last paid" value={dt(data.lastPaid)} />
          <Fact label="Autopay" value={data.autopay ? "On" : "Off"} />
          <Fact label="Calendar" value={data.calendarSynced ? "Synced" : "—"} />
          <Fact label="Grace period" value={data.gracePeriodDays != null ? `${data.gracePeriodDays} days` : "—"} />
          <Fact label="Late fee" value={data.lateFee != null ? usd(data.lateFee) : "—"} />
          <Fact label="Reminder" value={data.reminderLeadDays != null ? `${data.reminderLeadDays} days before` : "—"} />
          <Fact label="Payments made" value={String(data.payments?.length ?? 0)} />
        </div>

        {/* Change recurrence — bills only (a loan's cadence is fixed). */}
        {data.isRecurring && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">Recurrence:</span>
          {FREQS.map((fr) => (
            <Button key={fr} size="sm" variant={data.frequency === fr ? "default" : "outline"} className="h-7 px-2 text-xs capitalize"
              onClick={() => data.frequency !== fr && act(() => apiRequest("PATCH", `/api/obligations/${liabilityId}`, { frequency: fr }), `Now ${fr}`)}
              data-testid={`btn-freq-${fr}`}>{fr}</Button>
          ))}
        </div>
        )}

        {/* Collapsible month calendar — every due date + reminder plotted. */}
        <div className="border-t pt-3">
          <button
            type="button"
            onClick={() => setCalOpen((v) => !v)}
            className="flex items-center gap-1.5 text-sm font-medium hover:text-foreground text-muted-foreground"
            data-testid="btn-toggle-calendar"
          >
            {calOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            Calendar view
            <span className="text-xs text-muted-foreground font-normal">
              — {data.reminderLeadDays != null ? `due dates + reminders (${data.reminderLeadDays}d before)` : "all due dates"}
            </span>
          </button>
          {calOpen && (
            <MiniMonthCalendar
              occurrences={occ}
              reminderLeadDays={data.reminderLeadDays}
              onPickDay={() => setFilter("all")}
            />
          )}
        </div>

        {/* Filters */}
        <div className="flex items-center gap-1.5 flex-wrap border-t pt-3">
          {(["upcoming", "completed", "missed", "skipped", "all"] as Filter[]).map((fk) => (
            <Button key={fk} size="sm" variant={filter === fk ? "secondary" : "ghost"} className="h-7 px-2.5 text-xs capitalize"
              onClick={() => setFilter(fk)} data-testid={`filter-${fk}`}>
              {fk}{fk !== "all" && ` (${(counts as any)[fk] ?? 0})`}
            </Button>
          ))}
        </div>

        {/* Occurrence timeline */}
        <div className="space-y-1.5">
          {filtered.length === 0 && <p className="text-sm text-muted-foreground py-2">No {filter} payments.</p>}
          {filtered.map((o) => (
            <OccurrenceRow key={o.occurrenceId} liabilityId={liabilityId} occ={o} defaultAmount={data.amount} onAct={act} busy={run.isPending} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function OccurrenceRow({
  liabilityId, occ, defaultAmount, onAct, busy,
}: {
  liabilityId: string; occ: Occ; defaultAmount: number;
  onAct: (fn: () => Promise<Response>, ok: string) => void; busy: boolean;
}) {
  const [moveTo, setMoveTo] = useState(occ.effectiveDate);
  const [amt, setAmt] = useState(String(occ.amount ?? defaultAmount));
  const [notes, setNotes] = useState(occ.notes || "");
  const open = occ.status !== "paid" && occ.status !== "skipped";
  const base = `/api/liabilities/${liabilityId}/occurrences/${occ.date}`;

  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2" data-testid={`occ-${occ.date}`}>
      <div className="flex items-center gap-2 min-w-0">
        <Clock className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium tabular-nums">{dt(occ.effectiveDate)}</span>
            <StatusBadge status={occ.status} />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">{usd(occ.amount)}{occ.notes ? ` · ${occ.notes}` : ""}</span>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {open && (
          <>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy}
              onClick={() => onAct(() => apiRequest("POST", `${base}/pay`, { amount: Number(amt) || occ.amount }), "Marked paid")}
              data-testid={`occ-pay-${occ.date}`}><CheckCircle2 className="w-3.5 h-3.5 mr-1" />Pay</Button>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy}
              onClick={() => onAct(() => apiRequest("POST", `${base}/skip`), "Skipped")}
              data-testid={`occ-skip-${occ.date}`}><SkipForward className="w-3.5 h-3.5" /></Button>
          </>
        )}
        <Popover>
          <PopoverTrigger asChild><Button size="sm" variant="ghost" className="h-7 px-2 text-xs" data-testid={`occ-edit-${occ.date}`}><Pencil className="w-3.5 h-3.5" /></Button></PopoverTrigger>
          <PopoverContent className="w-64 space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Reschedule this occurrence</Label>
              <div className="flex gap-1">
                <Input type="date" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className="h-8" />
                <Button size="sm" className="h-8" onClick={() => onAct(() => apiRequest("PATCH", base, { movedTo: moveTo }), "Rescheduled")}>Move</Button>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Amount for this occurrence</Label>
              <div className="flex gap-1">
                <Input type="number" step="0.01" value={amt} onChange={(e) => setAmt(e.target.value)} className="h-8" />
                <Button size="sm" className="h-8" onClick={() => onAct(() => apiRequest("PATCH", base, { amount: Number(amt) }), "Amount updated")}>Save</Button>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Notes</Label>
              <div className="flex gap-1">
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} className="h-8" placeholder="e.g. paid early" />
                <Button size="sm" className="h-8" onClick={() => onAct(() => apiRequest("PATCH", base, { notes }), "Note saved")}>Save</Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

// ─── Month-grid mini calendar ──────────────────────────────────────────────
// Plots every occurrence (colored by status) and, when a reminder lead is set,
// a reminder dot `reminderLeadDays` before each due date. Prev/next month nav.
const DOW = ["S", "M", "T", "W", "T", "F", "S"];
const statusDot: Record<string, string> = {
  paid: "bg-green-600", overdue: "bg-red-600", due_today: "bg-amber-500",
  upcoming: "bg-muted-foreground/60", skipped: "bg-muted-foreground/30",
};
const isoAdd = (iso: string, days: number) => {
  const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() - days);
  return d.toLocaleDateString("en-CA");
};

function MiniMonthCalendar({
  occurrences, reminderLeadDays, onPickDay,
}: {
  occurrences: Occ[]; reminderLeadDays: number | null; onPickDay: (date: string) => void;
}) {
  const firstOcc = occurrences[0]?.effectiveDate;
  const initial = (firstOcc || new Date().toLocaleDateString("en-CA")).slice(0, 7);
  const [ym, setYm] = useState(initial);
  const [y, m] = ym.split("-").map(Number);

  // Map each day → its occurrence + whether it's a reminder day.
  const byDay = new Map<string, Occ>();
  const reminderDays = new Set<string>();
  for (const o of occurrences) {
    byDay.set(o.effectiveDate, o);
    if (reminderLeadDays != null && reminderLeadDays > 0) reminderDays.add(isoAdd(o.effectiveDate, reminderLeadDays));
  }

  const firstDow = new Date(y, m - 1, 1).getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${ym}-${String(d).padStart(2, "0")}`);

  const shift = (delta: number) => {
    const d = new Date(y, m - 1 + delta, 1);
    setYm(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };
  const monthLabel = new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div className="mt-3 rounded-lg border p-3" data-testid="bill-mini-calendar">
      <div className="flex items-center justify-between mb-2">
        <button type="button" onClick={() => shift(-1)} className="p-1 rounded hover:bg-muted" aria-label="Previous month"><ChevronLeft className="w-4 h-4" /></button>
        <span className="text-sm font-medium">{monthLabel}</span>
        <button type="button" onClick={() => shift(1)} className="p-1 rounded hover:bg-muted" aria-label="Next month"><ChevronRight className="w-4 h-4" /></button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center">
        {DOW.map((d, i) => <div key={i} className="text-[10px] uppercase text-muted-foreground py-1">{d}</div>)}
        {cells.map((iso, i) => {
          if (!iso) return <div key={i} />;
          const occ = byDay.get(iso);
          const isReminder = reminderDays.has(iso);
          const day = Number(iso.slice(8));
          return (
            <button
              key={i}
              type="button"
              disabled={!occ}
              onClick={() => occ && onPickDay(iso)}
              className={`relative aspect-square rounded-md text-xs flex items-center justify-center ${occ ? "hover:ring-1 hover:ring-primary cursor-pointer font-medium" : "text-muted-foreground/50"}`}
              data-testid={occ ? `cal-day-${iso}` : undefined}
              title={occ ? `${occ.status} — ${usd(occ.amount)}` : isReminder ? "Reminder" : undefined}
            >
              {day}
              {occ && <span className={`absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full ${statusDot[occ.status] || "bg-muted-foreground"}`} />}
              {isReminder && !occ && <Bell className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-2.5 h-2.5 text-amber-500" />}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3 mt-2 flex-wrap text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60" />Upcoming</span>
        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-green-600" />Paid</span>
        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-red-600" />Overdue</span>
        {reminderLeadDays != null && reminderLeadDays > 0 && <span className="flex items-center gap-1"><Bell className="w-2.5 h-2.5 text-amber-500" />Reminder</span>}
      </div>
    </div>
  );
}
