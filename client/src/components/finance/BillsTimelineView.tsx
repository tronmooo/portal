// ── Bills & Payments: Upcoming / Past (owner design, 2026-11-21) ─────────────
// One view for the Finance tab's Bills card and the Bills popup it opens. The
// rows come from the server's `financeSnapshot.billsTimeline`
// (shared/bills-timeline): a recurring bill's elapsed due dates are assumed
// paid, so nothing here is "overdue" and nothing here has a Pay button.
// A row opens the bill itself, where a payment can still be recorded by hand.
import { useLocation } from "wouter";
import { CalendarDays, Check, History, Info } from "lucide-react";
import { formatMoney } from "@/lib/format";
import { parseLocalDate } from "@/lib/format";
import type { BillTimelineRow, BillsTimeline } from "@shared/bills-timeline";
import { PAST_BILL_WINDOW_DAYS } from "@shared/bills-timeline";
import { UPCOMING_BILL_WINDOW_DAYS } from "@shared/obligation-windows";

export const EMPTY_BILLS_TIMELINE: BillsTimeline = { upcoming: [], past: [] };

/** The server's timeline, or an empty one for a snapshot that predates it. */
export function readBillsTimeline(snap: any): BillsTimeline {
  const t = snap?.billsTimeline;
  if (!t || !Array.isArray(t.upcoming) || !Array.isArray(t.past)) return EMPTY_BILLS_TIMELINE;
  return t as BillsTimeline;
}

const VIOLET = "262 80% 66%";
const EMERALD = "155 65% 45%";

const FREQ_LABEL: Record<string, string> = {
  weekly: "Weekly", biweekly: "Every 2 weeks", "bi-weekly": "Every 2 weeks", monthly: "Monthly",
  quarterly: "Quarterly", yearly: "Yearly", annually: "Yearly", annual: "Yearly",
  once: "One-time", "one-time": "One-time", one_time: "One-time", semiannual: "Every 6 months",
};
function freqLabel(f: string): string {
  const k = String(f || "").toLowerCase();
  return FREQ_LABEL[k] || (k ? k[0].toUpperCase() + k.slice(1).replace(/[-_]/g, " ") : "");
}
function titleCase(s: string): string {
  const t = String(s || "").replace(/[-_]/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

function rowSubtitle(r: BillTimelineRow): string {
  const kind = r.kind === "subscription" ? "Subscription" : (r.category && r.category !== "general" ? titleCase(r.category) : "Bill");
  return [kind, freqLabel(r.frequency)].filter(Boolean).join(" • ");
}

function DateChip({ date, accent }: { date: string; accent: string }) {
  const d = parseLocalDate(date);
  return (
    <div className="w-11 shrink-0 rounded-lg border overflow-hidden text-center"
      style={{ borderColor: `hsl(${accent} / 0.45)` }}>
      <div className="micro-label py-0.5 font-bold" style={{ background: `hsl(${accent} / 0.22)`, color: `hsl(${accent})` }}>
        {d ? d.toLocaleDateString("en-US", { month: "short" }).toUpperCase() : "—"}
      </div>
      <div className="py-0.5 text-base font-bold tabular-nums bg-card">{d ? d.getDate() : "?"}</div>
    </div>
  );
}

function inDays(n: number): string {
  if (n <= 0) return "today";
  if (n === 1) return "tomorrow";
  return `in ${n} days`;
}

function TimelineRow({ r, onOpen }: { r: BillTimelineRow; onOpen?: (r: BillTimelineRow) => void }) {
  const upcoming = r.state === "upcoming";
  const accent = upcoming ? VIOLET : EMERALD;
  const d = parseLocalDate(r.date);
  const shortDate = d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : r.date;
  const clickable = !!(onOpen && r.linkedLiabilityId);
  return (
    <button type="button" disabled={!clickable} onClick={() => clickable && onOpen!(r)}
      className={`w-full flex items-center gap-3 bubble px-3 py-2.5 text-left ${clickable ? "cursor-pointer bubble-interactive" : "cursor-default"}`}
      data-testid={`bill-timeline-${r.state === "upcoming" ? "upcoming" : "past"}-${r.billId}`}
      data-state={r.state}>
      <DateChip date={r.date} accent={accent} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold truncate">{r.name}</p>
        <p className="text-[11px] text-muted-foreground truncate">{rowSubtitle(r)}</p>
      </div>
      <span className="text-sm font-bold tabular-nums shrink-0">{formatMoney(r.amount)}</span>
      <div className="w-[4.75rem] shrink-0 flex flex-col items-center gap-0.5">
        <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
          style={{ background: `hsl(${accent} / 0.18)`, color: `hsl(${accent})` }}
          title={r.state === "assumed" ? "This date has passed — assumed paid" : r.state === "paid" ? "Payment recorded" : undefined}>
          {upcoming ? "Upcoming" : <><Check className="w-3 h-3" />Past</>}
        </span>
        <span className="text-[11px] text-muted-foreground tabular-nums">{upcoming ? inDays(r.daysUntil) : shortDate}</span>
      </div>
    </button>
  );
}

function SectionTitle({ icon: Icon, title, chip, accent }: { icon: any; title: string; chip: string; accent: string }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <Icon className="w-4 h-4" style={{ color: `hsl(${accent})` }} />
      <p className="text-sm font-bold flex-1">{title}</p>
      <span className="text-[11px] text-muted-foreground border border-border rounded-full px-2 py-0.5">{chip}</span>
    </div>
  );
}

/** The two counts, side by side — the header of the mockup. */
export function BillsTimelineSummary({ timeline }: { timeline: BillsTimeline }) {
  const cell = (icon: any, accent: string, label: string, window: string, n: number, testId: string) => {
    const Icon = icon;
    return (
      <div className="flex-1 flex items-center gap-2.5 min-w-0" data-testid={testId}>
        <span className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center" style={{ background: `hsl(${accent} / 0.16)` }}>
          <Icon className="w-4 h-4" style={{ color: `hsl(${accent})` }} />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] text-muted-foreground truncate"><span className="font-semibold text-foreground">{label}</span> ({window})</p>
          <p className="text-sm"><span className="text-xl font-bold tabular-nums mr-1">{n}</span><span className="text-muted-foreground">payment{n === 1 ? "" : "s"}</span></p>
        </div>
      </div>
    );
  };
  return (
    <div className="flex items-stretch gap-3 rounded-xl border border-border p-3 mb-3">
      {cell(CalendarDays, VIOLET, "Upcoming", `Next ${UPCOMING_BILL_WINDOW_DAYS} Days`, timeline.upcoming.length, "bills-summary-upcoming")}
      <div className="w-px bg-border" />
      {cell(History, EMERALD, "Past", `Last ${PAST_BILL_WINDOW_DAYS} Days`, timeline.past.length, "bills-summary-past")}
    </div>
  );
}

/**
 * Upcoming then Past. `limit` caps each section (the Finance card shows a few;
 * the popup shows everything) and says how many more there are.
 */
export function BillsTimelineView({ timeline, limit, showSummary = true, onNavigate }: {
  timeline: BillsTimeline;
  limit?: number;
  showSummary?: boolean;
  /** Called before the app navigates to a bill (a popup closes itself). */
  onNavigate?: () => void;
}) {
  const [, navigate] = useLocation();
  const open = (r: BillTimelineRow) => {
    if (!r.linkedLiabilityId) return;
    onNavigate?.();
    setTimeout(() => navigate(`/profiles/${r.linkedLiabilityId}`), 0);
  };
  const cap = <T,>(xs: T[]) => (limit != null ? xs.slice(0, limit) : xs);
  const more = (n: number) => (limit != null && n > limit ? n - limit : 0);
  const { upcoming, past } = timeline;
  return (
    <div data-testid="bills-timeline">
      {showSummary && <BillsTimelineSummary timeline={timeline} />}
      <SectionTitle icon={CalendarDays} title="Upcoming Payments" chip={`Next ${UPCOMING_BILL_WINDOW_DAYS} Days`} accent={VIOLET} />
      {upcoming.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-4" data-testid="bills-upcoming-empty">Nothing due in the next {UPCOMING_BILL_WINDOW_DAYS} days.</p>
      ) : (
        <div className="space-y-1.5">
          {cap(upcoming).map((r) => <TimelineRow key={r.key} r={r} onOpen={open} />)}
          {more(upcoming.length) > 0 && <p className="text-[11px] text-muted-foreground text-center">+{more(upcoming.length)} more upcoming</p>}
        </div>
      )}
      <div className="mt-4">
        <SectionTitle icon={History} title="Past Payments" chip={`Last ${PAST_BILL_WINDOW_DAYS} Days`} accent={EMERALD} />
        {past.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4" data-testid="bills-past-empty">No payments in the last {PAST_BILL_WINDOW_DAYS} days.</p>
        ) : (
          <div className="space-y-1.5">
            {cap(past).map((r) => <TimelineRow key={r.key} r={r} onOpen={open} />)}
            {more(past.length) > 0 && <p className="text-[11px] text-muted-foreground text-center">+{more(past.length)} more past</p>}
          </div>
        )}
      </div>
      <p className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground text-center" data-testid="bills-timeline-note">
        <Info className="w-3.5 h-3.5 shrink-0" />
        A recurring bill's past due dates are assumed paid. Past payments drop off after {PAST_BILL_WINDOW_DAYS} days.
      </p>
    </div>
  );
}
