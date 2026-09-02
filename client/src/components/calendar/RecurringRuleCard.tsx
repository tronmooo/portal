// ── Compact recurring-rule card ──────────────────────────────────────────────
//
// ONE card shape for every category. Icon · title · category + owner + amount ·
// recurrence · next date · status · chevron · overflow menu. Nothing else.
//
// User report 2026-07-25: "The cards are unnecessarily large… they consume too
// much vertical space and still truncate important information", and "Do not
// place a giant Done button on birthdays or recurring financial dates. A
// birthday is not a task to complete."
//
// So the row-level quick action is gone. `hasPrimaryAction` decides whether a
// kind even HAS one, and its label comes from `actionLabelFor` — a bill is
// "Mark paid", a task is "Complete", a birthday gets neither. Everything else
// lives in the overflow menu or the detail sheet.

import {
  Cake, CalendarHeart, CreditCard, Receipt, Wallet, RefreshCw, Wrench,
  Stethoscope, Bell, CheckSquare, FileText, CalendarDays, Repeat,
  ChevronRight, MoreHorizontal, Check, SkipForward, Trash2, CalendarClock,
  Pencil, ExternalLink,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  KIND_LABELS, relativeDayLabel, ruleValidity, isImportantDate,
  type CalendarOccurrence, type CalendarSeries, type OccurrenceKind,
} from "@shared/calendar-occurrences";
import {
  capabilitiesFor, actionLabelFor, hasPrimaryAction, type CalendarAction,
} from "@shared/calendar-capabilities";
import { humanRecurrenceLabel } from "@shared/recurring-dates";
import { countdownLabel, RULE_TYPE_FOR_KIND, type DateRuleType } from "@shared/date-rules";
import { formatMoney } from "@/lib/format";

export const RULE_ICONS: Record<OccurrenceKind, any> = {
  birthday: Cake, anniversary: CalendarHeart, subscription: CreditCard,
  liability: Wallet, bill: Receipt, renewal: RefreshCw, maintenance: Wrench,
  appointment: Stethoscope, task: CheckSquare, habit: Repeat,
  document: FileText, event: CalendarDays, custom: CalendarDays,
  expiration: FileText, income: Wallet,
};

// Muted accents. The old cards let a category colour take over the whole card;
// here it tints only the icon chip so the list reads as one system.
export const RULE_HSL: Record<OccurrenceKind, string> = {
  birthday: "262 60% 62%", anniversary: "330 55% 60%", subscription: "220 60% 60%",
  liability: "270 50% 60%", bill: "0 55% 58%", renewal: "38 65% 52%",
  maintenance: "199 55% 52%", appointment: "155 45% 46%",
  task: "210 55% 58%", habit: "170 45% 46%", document: "215 12% 58%",
  event: "240 8% 58%", custom: "240 8% 58%",
  expiration: "22 70% 55%", income: "150 45% 46%",
};

const ACTION_ICONS: Record<CalendarAction, any> = {
  edit: Pencil, move: CalendarClock, complete: Check, skip: SkipForward,
  deleteOccurrence: Trash2, deleteFuture: Trash2, deleteSeries: Trash2,
};

const fmtDate = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });

// Same semantics as the shared formatter — 0dp on whole dollars, 2 otherwise.
export const fmtMoney = formatMoney;

/** "Subscription · $20/month" / "Joe · Birthday" / "Bill · Honda CR-V · $155/month" */
function metaLine(series: CalendarSeries, ownerName?: string): string {
  const parts: string[] = [KIND_LABELS[series.kind]];
  // Don't repeat the owner when it's just the record's own name ("ChatGPT Pro
  // · ChatGPT Pro" was pure noise in the reported screenshots).
  if (ownerName && ownerName.trim().toLowerCase() !== series.title.trim().toLowerCase()) {
    parts.push(ownerName);
  }
  if (series.amount != null) {
    const per = series.recurrence === "monthly" ? "/month"
      : series.recurrence === "yearly" ? "/year"
        : series.recurrence === "weekly" ? "/week" : "";
    parts.push(`${fmtMoney(series.amount)}${per}`);
  }
  return parts.join(" · ");
}

export interface RecurringRuleCardProps {
  series: CalendarSeries;
  /** The next live occurrence, or null when the series has finished. */
  next: CalendarOccurrence | null;
  /** How many future dates this rule has generated. */
  upcomingCount: number;
  ownerName?: string;
  todayISO: string;
  onOpen: () => void;
  onAction: (action: CalendarAction) => void;
  /** Set when this rule absorbed a duplicate, e.g. a linked liability record. */
  linkedNote?: string;
}

export function RecurringRuleCard({
  series, next, upcomingCount, ownerName, todayISO, onOpen, onAction, linkedNote,
}: RecurringRuleCardProps) {
  const Icon = RULE_ICONS[series.kind] ?? CalendarDays;
  const hsl = RULE_HSL[series.kind] ?? RULE_HSL.custom;
  const caps = capabilitiesFor(series);
  const showPrimary = hasPrimaryAction(series) && !!next;
  // An important one-off (a licence, a passport, a lease end) reads as a
  // countdown rather than as a schedule — see isImportantDate.
  const important = isImportantDate(series);
  // What this date DOES, so the countdown says it. Hardcoding "expiration" told
  // the user their car service and their court date expired; re-deriving it
  // from the calendar KIND told them a subscription's start date "Was due" —
  // that round-trip is lossy, since `start` and `event` share one kind. The
  // rule says so itself.
  const countdownType = (series.ruleType as DateRuleType)
    ?? RULE_TYPE_FOR_KIND[series.kind] ?? "expiration";
  const overdue = important
    ? series.baseDate < todayISO
    : !!next && next.effectiveDate < todayISO;
  // A live rule with no next date is paused, finished, or broken — say which
  // rather than the bare "No upcoming date" the old card showed.
  const validity = ruleValidity(series, !!next, todayISO);

  return (
    <div
      className="bubble flex items-center gap-2.5 pl-2.5 pr-1.5 py-2"
      data-testid={`rule-card-${series.id}`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
        data-testid={`rule-open-${series.id}`}
      >
        <span
          className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center"
          style={{ background: `hsl(${hsl} / 0.13)` }}
        >
          <Icon className="w-4 h-4" style={{ color: `hsl(${hsl})` }} />
        </span>

        <span className="flex-1 min-w-0">
          <span className="block text-[13px] font-semibold truncate leading-tight">
            {series.title}
          </span>
          <span className="block text-[11px] text-muted-foreground truncate leading-tight mt-px">
            {metaLine(series, ownerName)}
          </span>
          <span className="block text-[11px] text-muted-foreground truncate leading-tight">
            {series.recurrence && series.recurrence !== "none"
              ? humanRecurrenceLabel(series.recurrence, series.baseDate)
              : important
                ? "One-time — important date"
                : "Does not repeat"}
          </span>
          <span
            className={`block text-[11px] font-medium tabular-nums truncate leading-tight ${
              overdue || validity.state === "invalid" ? "text-red-500" : ""
            }`}
            style={overdue || validity.state !== "ok" ? undefined : { color: `hsl(${hsl})` }}
            data-testid={`rule-next-${series.id}`}
          >
            {important
              // The whole point of an important date: how long is left. Always
              // computed from the stored date against today, never stored —
              // "Expires in 7 years, 10 months" today is "…9 months" next
              // month without anything being rewritten.
              ? `${fmtDate(series.baseDate)} · ${countdownLabel(series.baseDate, todayISO, countdownType)}`
              : next
              ? `Next: ${fmtDate(next.effectiveDate)} · ${relativeDayLabel(next.effectiveDate, todayISO)}`
              : validity.state === "paused" ? "Paused — resume to schedule dates"
                : validity.state === "ended" ? validity.message
                  : validity.state === "invalid" ? validity.message
                    : "No upcoming date"}
          </span>
          {/* End condition + how many dates are generated, per spec. An
              important one-off has neither: it is a single date, and saying
              "No end date · 1 upcoming" about a licence would be noise. */}
          {!important && (
            <span className="block text-[11px] text-muted-foreground truncate leading-tight">
              {series.recurrenceEnd ? `Ends ${fmtDate(series.recurrenceEnd)}` : "No end date"}
              {upcomingCount > 0 ? ` · ${upcomingCount} upcoming` : ""}
            </span>
          )}
          {linkedNote && (
            <span className="block text-[11px] text-muted-foreground/80 truncate leading-tight">
              {linkedNote}
            </span>
          )}
        </span>
      </button>

      {/* Only kinds that HAVE a primary action get one, correctly named. */}
      {showPrimary && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-[11px] px-2 shrink-0"
          onClick={() => onAction("complete")}
          data-testid={`rule-primary-${series.id}`}
        >
          <Check className="h-3 w-3 mr-1" />
          {actionLabelFor("complete", series.kind)}
        </Button>
      )}

      <ChevronRight
        className="h-4 w-4 text-muted-foreground/50 shrink-0 cursor-pointer"
        onClick={onOpen}
        aria-hidden="true"
      />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label="More actions" data-testid={`rule-menu-${series.id}`}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="text-xs">
          <DropdownMenuItem onClick={onOpen}>
            <ExternalLink className="h-3.5 w-3.5 mr-2" />
            Open {series.source.linkedLabel ? "linked record" : "details"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {caps.map((cap) => {
            const ActionIcon = ACTION_ICONS[cap.action];
            const destructive = cap.action.startsWith("delete");
            return (
              <DropdownMenuItem
                key={cap.action}
                disabled={!cap.enabled}
                title={cap.reason}
                className={destructive && cap.enabled ? "text-red-500 focus:text-red-500" : ""}
                onClick={() => cap.enabled && onAction(cap.action)}
                data-testid={`rule-action-${series.id}-${cap.action}`}
              >
                <ActionIcon className="h-3.5 w-3.5 mr-2" />
                {actionLabelFor(cap.action, series.kind)}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default RecurringRuleCard;
