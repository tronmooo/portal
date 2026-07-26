// ── Recurring Dates ──────────────────────────────────────────────────────────
//
// Two concepts, two views, never mixed:
//
//   RULES     — one compact card per recurring source. "Netflix, $9.99,
//               monthly on day 2." You own three subscriptions.
//   UPCOMING  — the generated dates those rules produce, grouped by day.
//               Hundreds of them, which is why they are never counted as
//               though they were things you own.
//
// The previous page ran them together as one scroll, so the header said
// "All 4 · Upcoming 4" while the list below it said "UPCOMING · 135" — three
// numbers, none of which meant "how many recurring items do I have".
//
// Everything on screen comes from ONE engine (shared/calendar-occurrences) via
// one hook, already deduplicated: a payment modelled as both a subscription
// and a liability is one rule and one date, with the financial link kept as
// metadata.

import { useMemo, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Plus, Bell } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  CALENDAR_CATEGORIES, countRules, filterSeriesByCategory, seriesInCategory,
  type CalendarCategory,
} from "@shared/calendar-categories";
import {
  KIND_LABELS, relativeDayLabel, isRecurringRule,
  type CalendarOccurrence, type CalendarSeries,
} from "@shared/calendar-occurrences";
import { humanRecurrenceLabel } from "@shared/recurring-dates";
import { type CalendarAction } from "@shared/calendar-capabilities";
import { useCalendarOccurrences } from "@/hooks/useCalendarOccurrences";
import { applyCalendarAction } from "@/lib/calendar-mutations";
import { CalendarItemDetail } from "@/components/calendar/CalendarItemDetail";
import {
  RecurringRuleCard, RULE_ICONS, RULE_HSL, fmtMoney,
} from "@/components/calendar/RecurringRuleCard";

type ViewMode = "rules" | "upcoming";

const fmtDayHeading = (iso: string) =>
  new Date(`${iso}T12:00:00`)
    .toLocaleDateString("en-US", { month: "long", day: "numeric" })
    .toUpperCase();

/** One generated date in the Upcoming view. */
function OccurrenceRow({
  occ, ownerName, todayISO, onOpen,
}: {
  occ: CalendarOccurrence;
  ownerName?: string;
  todayISO: string;
  onOpen: () => void;
}) {
  const Icon = RULE_ICONS[occ.kind];
  const hsl = RULE_HSL[occ.kind];
  const done = occ.status === "done" || occ.status === "skipped";
  const meta = [KIND_LABELS[occ.kind]];
  if (ownerName && ownerName.trim().toLowerCase() !== occ.title.trim().toLowerCase()) {
    meta.push(ownerName);
  }
  // Say plainly whether this date repeats, so a one-off in the Upcoming list
  // is never mistaken for a rule.
  meta.push(isRecurringRule(occ.series)
    ? humanRecurrenceLabel(occ.series.recurrence, occ.series.baseDate)
    : "One-time");
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-muted/40 transition-colors"
      data-testid={`occ-row-${occ.id}`}
    >
      <span className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center"
        style={{ background: `hsl(${hsl} / 0.13)` }}>
        <Icon className="w-3.5 h-3.5" style={{ color: `hsl(${hsl})` }} />
      </span>
      <span className="flex-1 min-w-0">
        <span className={`block text-[13px] font-medium truncate ${done ? "line-through text-muted-foreground" : ""}`}>
          {occ.title}
        </span>
        <span className="block text-[11px] text-muted-foreground truncate">{meta.join(" · ")}</span>
      </span>
      {occ.amount != null && (
        <span className="text-[13px] font-semibold tabular-nums shrink-0">{fmtMoney(occ.amount)}</span>
      )}
    </button>
  );
}

export function RecurringDatesPage({ filterIds, filterMode, onAddRecurring }: {
  filterIds: string[];
  filterMode: "all" | "selected" | "everyone";
  onAddRecurring?: () => void;
}) {
  const { toast } = useToast();
  const [view, setView] = useState<ViewMode>("rules");
  const [category, setCategory] = useState<CalendarCategory>("all");
  const [detail, setDetail] = useState<CalendarOccurrence | null>(null);

  // recurringOnly: this screen manages REPEATING RULES. One-off dates —
  // document expirations, a house viewing, a soccer game — stay on the
  // calendar grid where they belong, instead of being listed here under a
  // "Does not repeat" caption.
  const cal = useCalendarOccurrences({ filterIds, filterMode, recurringOnly: true });
  const today = cal.todayISO;

  // Chip counts are over deduplicated RULES — never occurrences.
  // The next live date per rule, and how many future dates it has — both
  // straight from the engine so the card never does its own arithmetic.
  const scheduleByRule = useMemo(() => {
    const m = new Map<string, { next: CalendarOccurrence | null; upcoming: number }>();
    for (const s of cal.series) {
      const own = cal.occurrencesForSeries(s.id);
      const future = own.filter((o) => o.effectiveDate >= today);
      m.set(s.id, {
        next: future.find((o) => o.status !== "done" && o.status !== "skipped") ?? null,
        upcoming: future.length,
      });
    }
    return m;
  }, [cal.series, cal.occurrencesForSeries, today]);
  const nextByRule = useMemo(() => {
    const m = new Map<string, CalendarOccurrence | null>();
    for (const [id, v] of scheduleByRule) m.set(id, v.next);
    return m;
  }, [scheduleByRule]);

  const nextDateFor = useCallback(
    (s: CalendarSeries) => nextByRule.get(s.id)?.effectiveDate ?? null,
    [nextByRule],
  );

  // Counts come from the SAME set the cards are drawn from, in both views —
  // "counts must be derived from the exact same filtered result set as the
  // visible cards". Switching view must never change what a chip says.
  // `important` is computed from urgency, so it needs the schedule.
  const counts = useMemo(
    () => countRules(cal.series, { todayISO: today, nextDateFor }),
    [cal.series, today, nextDateFor],
  );
  const visibleRules = useMemo(
    () => filterSeriesByCategory(cal.series, category, nextDateFor, { todayISO: today }),
    [cal.series, category, nextDateFor, today],
  );

  // Upcoming view: future dates in the active category, grouped by day.
  const grouped = useMemo(() => {
    // RECURRING ONLY — both views.
    //
    // A previous pass let one-off dates into this Upcoming list, reasoning that
    // "dates" is broader than "rules". That was wrong: the whole SCREEN is
    // Recurring Dates, and a driver's-licence expiry is not a recurring date on
    // any view of it. One-off dates live on the Calendar tab. `cal.series` is
    // already gated to genuine repeat patterns by `recurringOnly` above.
    const inCategory = new Set(
      cal.series
        .filter((s) => seriesInCategory(s, category, { todayISO: today, nextDate: nextDateFor(s) }))
        .map((s) => s.id),
    );
    const out: Array<{ date: string; items: CalendarOccurrence[] }> = [];
    let current: { date: string; items: CalendarOccurrence[] } | null = null;
    for (const o of cal.occurrences) {
      if (o.effectiveDate < today) continue;
      if (!inCategory.has(o.seriesId)) continue;
      if (!current || current.date !== o.effectiveDate) {
        current = { date: o.effectiveDate, items: [] };
        out.push(current);
      }
      current.items.push(o);
    }
    return out.slice(0, 120);
  }, [cal.occurrences, cal.series, category, today, nextDateFor]);

  const seriesById = useMemo(() => {
    const m = new Map<string, CalendarSeries>();
    for (const s of cal.series) m.set(s.id, s);
    return m;
  }, [cal.series]);

  const runAction = async (series: CalendarSeries, action: CalendarAction) => {
    const occurrence = nextByRule.get(series.id) ?? undefined;
    if (action === "edit") {
      const href = String(series.source.href || "").replace(/^#/, "");
      if (href) window.location.hash = `#${href}`;
      return;
    }
    try {
      await applyCalendarAction({
        action, series, occurrence, todayISO: today, getEventRow: cal.getEventRow,
      });
      toast({ title: "Updated" });
    } catch (e: any) {
      toast({
        title: "Couldn't complete that",
        description: e?.message || "Try again",
        variant: "destructive",
      });
    }
  };

  const openDetailFor = (series: CalendarSeries) => {
    const occ = nextByRule.get(series.id) ?? cal.occurrencesForSeries(series.id)[0] ?? null;
    if (occ) setDetail(occ);
  };

  const linkedNoteFor = (series: CalendarSeries): string | undefined => {
    const dupes = cal.duplicatesBySeries.get(series.id);
    if (!dupes?.length) return undefined;
    return `Linked financial record: ${series.source.linkedLabel || "Liability"}`;
  };

  return (
    <div className="space-y-2.5" data-testid="recurring-dates-page">
      {/* ── Category chips: horizontally scrollable on mobile ─────────────── */}
      <div className="-mx-1 px-1 overflow-x-auto no-scrollbar" data-testid="category-chips">
        <div className="flex gap-1.5 w-max pb-0.5">
          {CALENDAR_CATEGORIES.map((c) => {
            const active = category === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategory(c.id)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] font-medium transition-colors ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted/60 text-muted-foreground hover:text-foreground"
                }`}
                data-testid={`chip-${c.id}`}
              >
                {c.short}{" "}
                <span className="tabular-nums opacity-70">{counts[c.id]}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Rules | Upcoming dates ────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex rounded-lg bg-muted/60 p-0.5" role="tablist">
          {(["rules", "upcoming"] as ViewMode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={view === m}
              onClick={() => setView(m)}
              className={`rounded-md px-3 py-1 text-[11px] font-semibold transition-colors ${
                view === m ? "bg-background shadow-sm" : "text-muted-foreground"
              }`}
              data-testid={`view-${m}`}
            >
              {m === "rules" ? "Rules" : "Upcoming dates"}
            </button>
          ))}
        </div>
        {onAddRecurring && (
          <Button size="sm" className="h-8 text-xs shrink-0" onClick={onAddRecurring} data-testid="btn-add-recurring">
            <Plus className="h-3.5 w-3.5 mr-1" /> Recurring date
          </Button>
        )}
      </div>

      {/* ── RULES ─────────────────────────────────────────────────────────── */}
      {view === "rules" && (
        visibleRules.length === 0 ? (
          <EmptyState category={category} onAdd={onAddRecurring} />
        ) : (
          <div className="space-y-1.5" data-testid="rules-list">
            {visibleRules.map((s) => (
              <RecurringRuleCard
                key={s.id}
                series={s}
                next={scheduleByRule.get(s.id)?.next ?? null}
                upcomingCount={scheduleByRule.get(s.id)?.upcoming ?? 0}
                ownerName={s.source.profileId ? cal.profileName(s.source.profileId) : undefined}
                todayISO={today}
                onOpen={() => openDetailFor(s)}
                onAction={(a) => void runAction(s, a)}
                linkedNote={linkedNoteFor(s)}
              />
            ))}
          </div>
        )
      )}

      {/* ── UPCOMING DATES ────────────────────────────────────────────────── */}
      {view === "upcoming" && (
        grouped.length === 0 ? (
          <EmptyState category={category} onAdd={onAddRecurring} upcoming />
        ) : (
          <div className="space-y-3" data-testid="upcoming-list">
            {grouped.map((g) => (
              <div key={g.date}>
                <div className="flex items-baseline justify-between px-1 mb-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {fmtDayHeading(g.date)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {relativeDayLabel(g.date, today)}
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-card divide-y divide-border/50 overflow-hidden">
                  {g.items.map((o) => (
                    <OccurrenceRow
                      key={o.id}
                      occ={o}
                      ownerName={o.source.profileId ? cal.profileName(o.source.profileId) : undefined}
                      todayISO={today}
                      onOpen={() => setDetail(o)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {detail && (
        <CalendarItemDetail
          occurrence={detail}
          seriesOccurrences={cal.occurrencesForSeries(detail.seriesId)}
          getEventRow={cal.getEventRow}
          profileName={cal.profileName}
          todayISO={today}
          duplicateNote={
            cal.duplicatesBySeries.get(detail.seriesId)?.length
              ? `Linked financial record: ${seriesById.get(detail.seriesId)?.source.linkedLabel || "Liability"} — one date, shown once.`
              : undefined
          }
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

function EmptyState({ category, onAdd, upcoming }: {
  category: CalendarCategory;
  onAdd?: () => void;
  upcoming?: boolean;
}) {
  const label = CALENDAR_CATEGORIES.find((c) => c.id === category)?.label ?? "recurring dates";
  return (
    <div className="rounded-xl border border-dashed border-border p-6 text-center" data-testid="recurring-empty">
      <Bell className="h-6 w-6 mx-auto text-muted-foreground/50 mb-2" />
      <p className="text-sm font-medium">
        {category === "all"
          ? upcoming ? "Nothing scheduled ahead" : "No recurring dates yet"
          : `No ${label.toLowerCase()}`}
      </p>
      <p className="text-xs text-muted-foreground mt-0.5 max-w-xs mx-auto">
        Birthdays, bills, subscriptions, liabilities, tasks and reminders all appear here — each one
        once, with its own schedule.
      </p>
      {onAdd && category === "all" && (
        <Button size="sm" className="mt-3 h-8 text-xs" onClick={onAdd} data-testid="btn-add-recurring-empty">
          <Plus className="h-3.5 w-3.5 mr-1" /> Add your first
        </Button>
      )}
    </div>
  );
}

export default RecurringDatesPage;
