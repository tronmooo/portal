// ── Bills overview list ──────────────────────────────────────────────────────
// The ONE way a bills OVERVIEW is drawn (owner request 2026-11-21): the
// Finance tab's Bills card, the Bills Due popup and the dashboard Money card
// all render this, from the one split in shared/obligation-windows
// (`billsOverview`). It answers three questions and nothing else:
//
//   1. What is due today?
//   2. What became overdue in the last seven days?
//   3. What is coming up in the next 30 days?
//
// It is a READOUT. There is no Pay button here: payments are recorded on the
// bill's own page, on the Bills page, in chat, or by Auto Pay — none of which
// this list touches. A bill overdue by more than seven days is not listed, and
// the footer says so and links to where it still is (Rule 4: a filter must
// never look like deletion).
import { CheckCircle2, ChevronRight, Repeat } from "lucide-react";
import {
  billsOverview, OVERDUE_BILL_VISIBLE_DAYS, UPCOMING_BILL_WINDOW_DAYS,
} from "@shared/obligation-windows";
import { dayLabel } from "@shared/now-rank";
import { parseLocalDate, formatMoney } from "@/lib/format";

export interface OverviewBill {
  id: string; name: string; amount: number | string; dueDate?: string | null;
  daysUntil: number; autopay?: boolean | null; category?: string | null;
  linkedLiabilityId?: string | null;
}

const TONES = {
  today:   { hs: "38 96% 50%",  label: "Due today" },
  overdue: { hs: "0 72% 56%",   label: `Recently overdue · last ${OVERDUE_BILL_VISIBLE_DAYS} days` },
  next:    { hs: "213 90% 60%", label: `Next ${UPCOMING_BILL_WINDOW_DAYS} days` },
} as const;
type GroupKey = keyof typeof TONES;

/** The due date itself: a calendar day computed from `daysUntil` when the row
 *  carries no date (the snapshot always sends both; tests may not). */
function dueDateOf(b: OverviewBill): Date {
  const d = parseLocalDate(b.dueDate ? String(b.dueDate).slice(0, 10) : null);
  if (d) return d;
  const x = new Date();
  x.setDate(x.getDate() + Number(b.daysUntil || 0));
  return x;
}

function DateChip({ date, hs }: { date: Date; hs: string }) {
  return (
    <span className="w-10 shrink-0 rounded-lg overflow-hidden text-center border"
      style={{ borderColor: `hsl(${hs} / 0.35)` }} aria-hidden="true">
      <span className="block micro-label leading-[15px] text-white" style={{ background: `hsl(${hs})` }}>
        {date.toLocaleDateString("en-US", { month: "short" })}
      </span>
      <span className="block text-[13px] font-bold tabular-nums leading-[20px] bg-card">{date.getDate()}</span>
    </span>
  );
}

/** What the row says about payment. Every row here is an occurrence that has
 *  not been recorded as paid — a paid occurrence moves the bill on to its next
 *  due date — so the states are: Auto Pay will record it, it is unpaid and
 *  late, or it is simply scheduled. */
function StatusPill({ bill, group }: { bill: OverviewBill; group: GroupKey }) {
  if (bill.autopay) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[11px] font-semibold shrink-0 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
        data-testid={`bill-status-${bill.id}`}>
        <Repeat className="h-2.5 w-2.5" aria-hidden="true" /> Auto Pay
      </span>
    );
  }
  const [cls, text] = group === "overdue"
    ? ["bg-red-500/12 text-red-600 dark:text-red-400", "Unpaid"]
    : group === "today"
      ? ["bg-amber-500/15 text-amber-700 dark:text-amber-400", "Due"]
      : ["bg-muted text-muted-foreground", "Scheduled"];
  return (
    <span className={`inline-flex items-center rounded-full px-1.5 py-px text-[11px] font-semibold shrink-0 ${cls}`}
      data-testid={`bill-status-${bill.id}`}>{text}</span>
  );
}

export function BillsOverviewList({
  bills, onOpenBill, onViewAll, limit, testIdPrefix = "bill-row", emptyLabel,
}: {
  /** The server's upcoming-bills list, unfiltered (this component windows it). */
  bills: readonly OverviewBill[] | null | undefined;
  /** Opens the bill (its page / the Bills panel). Rows are plain when absent. */
  onOpenBill?: (b: OverviewBill) => void;
  /** Where "View all bills" goes — also the home of the older overdue rows. */
  onViewAll?: () => void;
  /** Cap on listed rows (a dashboard card); the rest fold into the footer. */
  limit?: number;
  testIdPrefix?: string;
  emptyLabel?: string;
}) {
  const o = billsOverview(bills);
  const groups: Array<{ key: GroupKey; items: OverviewBill[] }> = [
    { key: "today" as const, items: o.dueToday },
    { key: "overdue" as const, items: o.recentlyOverdue },
    { key: "next" as const, items: o.upcoming },
  ].filter((g) => g.items.length > 0);

  let room = limit ?? Infinity;
  const shown = groups.map((g) => {
    const items = g.items.slice(0, Math.max(0, room));
    room -= items.length;
    return { ...g, total: g.items.length, items };
  }).filter((g) => g.items.length > 0);
  const hiddenByLimit = o.visible.length - shown.reduce((n, g) => n + g.items.length, 0);

  return (
    <div data-testid="bills-overview">
      {o.visible.length === 0 ? (
        <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground py-1" data-testid="bills-overview-empty">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" aria-hidden="true" />
          {emptyLabel ?? `Nothing due today or in the next ${UPCOMING_BILL_WINDOW_DAYS} days.`}
        </p>
      ) : (
        <div className="space-y-3">
          {shown.map((g) => {
            const t = TONES[g.key];
            return (
              <div key={g.key} data-testid={`bills-group-${g.key}`}>
                <p className="micro-label flex items-center gap-1.5 mb-1.5" style={{ color: `hsl(${t.hs})` }}>
                  <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${t.hs})` }} aria-hidden="true" />
                  {t.label}
                  <span className="text-muted-foreground font-medium">· {g.total}</span>
                </p>
                <div className="space-y-1.5">
                  {g.items.map((b) => {
                    const date = dueDateOf(b);
                    const when = g.key === "today" ? "Due today"
                      : g.key === "overdue" ? `Was due ${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })} · ${dayLabel(b.daysUntil)}`
                      : `Due ${date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · ${dayLabel(b.daysUntil)}`;
                    const body = (
                      <>
                        <DateChip date={date} hs={t.hs} />
                        <span className="flex-1 min-w-0">
                          <span className="flex items-center gap-1.5 min-w-0">
                            <span className="text-[13px] font-semibold leading-tight truncate">{b.name}</span>
                            <StatusPill bill={b} group={g.key} />
                          </span>
                          <span className={`block text-[11px] truncate mt-0.5 ${g.key === "overdue" ? "text-red-500" : "text-muted-foreground"}`}>{when}</span>
                        </span>
                        <span className="shrink-0 text-[13px] font-bold tabular-nums">{formatMoney(Number(b.amount) || 0)}</span>
                      </>
                    );
                    const cls = "bubble-row w-full flex items-center gap-2.5 px-2.5 py-2 min-w-0 text-left";
                    return onOpenBill ? (
                      <button key={b.id} type="button" onClick={() => onOpenBill(b)} className={cls}
                        data-testid={`${testIdPrefix}-${b.id}`} aria-label={`${b.name}, ${formatMoney(Number(b.amount) || 0)}, ${when}`}>
                        {body}
                      </button>
                    ) : (
                      <div key={b.id} className={cls} data-testid={`${testIdPrefix}-${b.id}`}>{body}</div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {hiddenByLimit > 0 && onViewAll && (
        <button type="button" onClick={onViewAll}
          className="w-full flex items-center gap-1 pt-2 text-[12px] font-semibold text-muted-foreground hover:text-foreground transition-colors"
          data-testid="bills-overview-more">
          {hiddenByLimit} more in the next {UPCOMING_BILL_WINDOW_DAYS} days
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}

      {/* Older overdue bills are out of the overview, not out of the app. */}
      {o.olderOverdue.length > 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground" data-testid="bills-overview-older">
          {o.olderOverdue.length} unpaid bill{o.olderOverdue.length === 1 ? "" : "s"} more than {OVERDUE_BILL_VISIBLE_DAYS} days overdue {o.olderOverdue.length === 1 ? "isn't" : "aren't"} listed here.{" "}
          {onViewAll && (
            <button type="button" onClick={onViewAll} className="font-semibold text-foreground/80 hover:underline" data-testid="bills-overview-older-link">
              View all bills
            </button>
          )}
        </p>
      )}
    </div>
  );
}
