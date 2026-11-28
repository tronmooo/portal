// ── The calendar detail screen ───────────────────────────────────────────────
//
// ONE screen for every kind of date — a birthday, a mortgage payment, a
// recurring chore, a plain event — in four connected views:
//
//   Overview      next date · repeats / ends · completion · upcoming dates
//   Occurrences   every date with its state  ·  History  ·  Options
//   This date     Complete · Skip · Change date · Edit future · Delete (one)
//   Edit          Details · Repeat · Reminders · Advanced (EditSeriesScreen)
//
// What changed from the seven-button panel this replaces: an action that does
// not apply is NOT ON THE SCREEN. A birthday used to show five greyed-out
// buttons whose reasons lived in hover tooltips a phone never shows; now it
// shows Edit and More. Each per-date action says how far it reaches ("Keep
// future schedule", "Move just this occurrence"), and skipping never deletes:
// the date is recorded as skipped and the series keeps running.
//
// Nothing here computes dates. Occurrences come from the one engine
// (shared/calendar-occurrences); what is offered comes from the one capability
// matrix (shared/calendar-capabilities `occurrenceMenuFor`); performing an
// action is routed by client/src/lib/calendar-mutations; history is derived
// from the series' own marks (shared/occurrence-history). This renders.

import { ownerLabelForDatedItem } from "@shared/birthday-event";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import {
  ArrowLeft, Bell, CalendarClock, CalendarDays, Check, ChevronRight, ChevronsRight,
  ExternalLink, History as HistoryIcon, Infinity as InfinityIcon, MoreHorizontal,
  Pencil, PauseCircle, PlayCircle, Repeat, RotateCcw, Scissors, Tag, Trash2, X,
} from "lucide-react";
import {
  KIND_LABELS, relativeDayLabel, isPaymentKind,
  type CalendarOccurrence, type CalendarSeries,
} from "@shared/calendar-occurrences";
import {
  can, actionLabelFor, hasPerOccurrenceMoney, occurrenceMenuFor, editsInPlace, canEndSeriesBefore, canPauseSeries,
  MONEY_ACTIONS, MONEY_ACTION_LABELS,
  type CalendarAction, type CalendarMoneyAction, type OccurrenceMenuAction, type OccurrenceMenuItem,
} from "@shared/calendar-capabilities";
import { humanRecurrenceLabel, parseRecurringMeta } from "@shared/recurring-dates";
import {
  seriesHistory, completionStats, hasHistory, HISTORY_LABELS, type HistoryStatus,
} from "@shared/occurrence-history";
import { applyCalendarAction, applyCalendarMoneyAction, restoreOccurrence, setSeriesPaused } from "@/lib/calendar-mutations";
import { KIND_ICONS, KIND_HSL, fmtDate, fmtShort, fmtDay } from "./detail/kind-style";
import { EditSeriesScreen } from "./detail/EditSeriesScreen";

const fmtMoney = (n?: number) => (n == null ? null : formatMoney(n));

const MENU_ICONS: Record<OccurrenceMenuAction, any> = {
  complete: Check,
  skip: ChevronsRight,
  move: CalendarClock,
  restore: RotateCcw,
  editFuture: Scissors,
  deleteOccurrence: Trash2,
};

/** Chip colours, as HSL triplets. */
const CHIP_HSL = {
  open: "142 64% 45%",
  scheduled: "220 10% 60%",
  today: "38 92% 52%",
  overdue: "0 72% 58%",
  done: "155 62% 44%",
  skipped: "240 6% 60%",
  missed: "0 72% 58%",
  moved: "199 85% 55%",
} as const;

const HISTORY_HSL: Record<HistoryStatus, string> = {
  completed: CHIP_HSL.done,
  skipped: CHIP_HSL.skipped,
  missed: CHIP_HSL.missed,
  rescheduled: CHIP_HSL.moved,
};

function Chip({ hsl, children }: { hsl: string; children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold leading-none"
      style={{ background: `hsl(${hsl} / 0.16)`, color: `hsl(${hsl})` }}>
      {children}
    </span>
  );
}

/** The state chip for one occurrence. `isOpen` = the series' next open date. */
function statusChip(o: CalendarOccurrence, isOpen: boolean, payment: boolean): { label: string; hsl: string } {
  if (o.status === "done") return { label: payment ? "Paid" : "Completed", hsl: CHIP_HSL.done };
  if (o.status === "skipped") return { label: "Skipped", hsl: CHIP_HSL.skipped };
  if (o.missed) return { label: "Missed", hsl: CHIP_HSL.missed };
  if (o.status === "overdue") return { label: "Overdue", hsl: CHIP_HSL.overdue };
  if (o.status === "today") return { label: "Today", hsl: CHIP_HSL.today };
  if (o.status === "past") return { label: "Past", hsl: CHIP_HSL.scheduled };
  return isOpen ? { label: "Upcoming", hsl: CHIP_HSL.open } : { label: "Scheduled", hsl: CHIP_HSL.scheduled };
}

const cap1 = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export interface CalendarItemDetailProps {
  /** The occurrence the user tapped. Null closes the panel. */
  occurrence: CalendarOccurrence | null;
  /** Every occurrence of the same series, ascending — the schedule list. */
  seriesOccurrences: CalendarOccurrence[];
  /** Raw event rows, so tag-based mutations edit current tags. */
  getEventRow?: (eventId: string) => any | undefined;
  /** Profile display names, for the "Source profile" row. */
  profileName?: (profileId: string) => string | undefined;
  todayISO: string;
  onClose: () => void;
  /** Series ids collapsed into this one, disclosed rather than hidden. */
  duplicateNote?: string;
  /** Open straight on the series editor (a rule card's Edit). */
  initialScreen?: "edit";
}

type Screen =
  | { name: "overview" }
  | { name: "occurrences"; tab: "occurrences" | "history" | "options" }
  | { name: "edit"; mode: "series" | "future"; fromDate?: string; tab?: "details" | "repeat" | "reminders" | "advanced" };

export function CalendarItemDetail({
  occurrence: tapped, seriesOccurrences, getEventRow, profileName, todayISO, onClose, duplicateNote, initialScreen,
}: CalendarItemDetailProps) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const arm = useConfirmArm();
  const [busy, setBusy] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>(initialScreen === "edit" ? { name: "edit", mode: "series" } : { name: "overview" });
  /** The occurrence whose action list is open. */
  const [menuOcc, setMenuOcc] = useState<CalendarOccurrence | null>(null);
  const [moveDate, setMoveDate] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const [moneyAction, setMoneyAction] = useState<CalendarMoneyAction>("addCharge");
  const [moneyAmount, setMoneyAmount] = useState("");

  // The tapped occurrence is a snapshot taken when the sheet opened. After a
  // write the stream regenerates, so read the LIVE occurrence and series from
  // it: a date just skipped must read "Skipped" without reopening the sheet.
  const occurrence = useMemo(
    () => (tapped ? seriesOccurrences.find((o) => o.id === tapped.id) ?? tapped : null),
    [tapped, seriesOccurrences],
  );
  const series: CalendarSeries | null = seriesOccurrences[0]?.series ?? occurrence?.series ?? null;

  const future = useMemo(
    () => seriesOccurrences.filter((o) => o.effectiveDate >= todayISO),
    [seriesOccurrences, todayISO],
  );
  const next = useMemo(
    () => future.find((o) => o.status !== "done" && o.status !== "skipped") ?? null,
    [future],
  );
  const history = useMemo(
    () => (series ? seriesHistory(series, seriesOccurrences, todayISO) : []),
    [series, seriesOccurrences, todayISO],
  );
  const stats = useMemo(() => completionStats(history), [history]);

  if (!occurrence || !series) return null;

  const Icon = KIND_ICONS[series.kind] ?? CalendarDays;
  const hsl = KIND_HSL[series.kind] ?? KIND_HSL.custom;
  const ownerId = series.source.profileId;
  // "Source: Bob Robertson" under "Jordan's birthday" names the wrong person
  // as whose date it is (shared/birthday-event).
  const ownerName = ownerLabelForDatedItem(series.title, ownerId ? profileName?.(ownerId) : undefined);
  const isRecurring = !!series.recurrence && series.recurrence !== "none";
  const payment = isPaymentKind(series.kind);
  const isTask = series.source.system === "task";
  const showMoney = hasPerOccurrenceMoney(series);
  const inPlace = editsInPlace(series);
  const showHistory = hasHistory(series);

  // A paused series has no date to act on: the one thing it offers is Resume.
  const paused = !!series.paused;
  const resumable = paused && canPauseSeries(series);
  const menuItemsFor = (o: CalendarOccurrence) => (paused ? [] : occurrenceMenuFor(series, o, { isOpen: !!next && o.id === next.id }));
  const nextMenu = next ? menuItemsFor(next) : [];
  const primaryComplete = nextMenu.find((m) => m.action === "complete");

  const eventRow = series.source.system === "event" ? getEventRow?.(series.source.id) : undefined;
  const reminders = eventRow ? (parseRecurringMeta(eventRow.tags).reminders ?? []) : null;

  const closeMenus = () => { setMenuOcc(null); setMoveDate(null); setMoreOpen(false); arm.disarm(); };

  const run = async (action: CalendarAction, occ: CalendarOccurrence, newDate?: string) => {
    setBusy(`${action}:${occ.id}`);
    try {
      await applyCalendarAction({ action, series, occurrence: occ, newDate, todayISO, getEventRow });
      toast({ title: SUCCESS_MESSAGE[action](occ.date, newDate) });
      // Deleting the series (or the only occurrence) leaves nothing to show.
      // Completing a task retires its open row; the next occurrence is a new
      // row with its own series id, so this sheet has nothing left to follow.
      if (action === "deleteSeries" || (action === "deleteOccurrence" && !isRecurring)
        || (action === "complete" && isTask) || (action === "deleteFuture" && occ.date <= (next?.date ?? occ.date))) onClose();
    } catch (e: any) {
      toast({ title: "Couldn't complete that", description: e?.message || "Try again", variant: "destructive" });
    } finally {
      setBusy(null);
      closeMenus();
    }
  };

  const restore = async (occ: CalendarOccurrence) => {
    setBusy(`restore:${occ.id}`);
    try {
      await restoreOccurrence(series, occ);
      toast({ title: `${fmtShort(occ.date)} is back on the schedule` });
    } catch (e: any) {
      toast({ title: "Couldn't complete that", description: e?.message || "Try again", variant: "destructive" });
    } finally {
      setBusy(null);
      closeMenus();
    }
  };

  const resume = async () => {
    setBusy("resume");
    try {
      await setSeriesPaused(series, false);
      toast({ title: "Series resumed", description: "Its dates are back on the calendar." });
    } catch (e: any) {
      toast({ title: "Couldn't resume", description: e?.message || "Try again", variant: "destructive" });
    } finally {
      setBusy(null);
      closeMenus();
    }
  };

  const goToSource = () => {
    onClose();
    const href = String(series.source.href || "").replace(/^#/, "");
    if (href) navigate(href);
  };

  const openEdit = (tab?: "details" | "repeat" | "reminders" | "advanced") => {
    closeMenus();
    if (!inPlace) return goToSource();
    setScreen({ name: "edit", mode: "series", tab });
  };

  const onMenuAction = (item: OccurrenceMenuItem, occ: CalendarOccurrence) => {
    switch (item.action) {
      case "complete": return void run("complete", occ);
      case "skip": return void run("skip", occ);
      case "move": return setMoveDate(occ.effectiveDate);
      case "restore": return void restore(occ);
      case "editFuture":
        closeMenus();
        return setScreen({ name: "edit", mode: "future", fromDate: occ.date, tab: "repeat" });
      case "deleteOccurrence":
        return arm.confirm(`del:${occ.id}`, () => void run("deleteOccurrence", occ));
    }
  };

  const runMoney = async (occ: CalendarOccurrence) => {
    const amount = Number(moneyAmount);
    if (!Number.isFinite(amount)) {
      toast({ title: "Enter an amount first", variant: "destructive" });
      return;
    }
    setBusy(`${moneyAction}:${occ.id}`);
    try {
      await applyCalendarMoneyAction({
        action: moneyAction, series, occurrence: occ, amount, chargeKind: "usage",
      });
      toast({ title: MONEY_SUCCESS[moneyAction](occ.date) });
      setMoneyAmount("");
    } catch (e: any) {
      toast({ title: "Couldn't update the amount", description: e?.message || "Try again", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const repeatsLabel = isRecurring ? humanRecurrenceLabel(series.recurrence, series.baseDate) : "Does not repeat";
  const subtitle = ownerName
    ? `${series.kind === "birthday" || series.kind === "anniversary" ? "Person" : "For"}: ${ownerName}`
    : isTask ? (isRecurring ? "Recurring Task" : "Task")
    : isRecurring ? "Recurring date" : "One-time date";
  // Where the date lives. An owner's name when there is one; otherwise the
  // place it is managed, never the type repeated ("Source: Birthday").
  const sourceLabel = ownerName || series.source.label
    || (series.source.system === "event" ? "Calendar" : isTask ? "Tasks" : KIND_LABELS[series.kind]);
  // "Edit" on one date of a series edits the series: the label says so (O4).
  const editLabel = inPlace ? (isRecurring ? "Edit series" : "Edit") : actionLabelFor("edit", series.kind);
  /** The tapped date's own actions: the way to change that date alone. */
  const tappedItems = menuItemsFor(occurrence);
  const openOnlyThisDate = () => {
    closeMenus();
    setScreen({ name: "overview" });
    setMenuOcc(occurrence);
  };

  /** One row of the schedule list. */
  const OccurrenceRow = ({ o, compact = false }: { o: CalendarOccurrence; compact?: boolean }) => {
    const chip = statusChip(o, !!next && o.id === next.id, payment);
    const items = menuItemsFor(o);
    const settled = o.status === "done" || o.status === "skipped";
    const body = (
      <>
        <CalendarDays className="h-4 w-4 shrink-0" style={{ color: `hsl(${chip.hsl})` }} />
        <span className="flex-1 min-w-0 text-left">
          <span className={`block text-sm font-semibold tabular-nums ${settled ? "text-muted-foreground" : ""}`}>
            {fmtShort(o.effectiveDate)}
          </span>
          <span className="block text-[12px] text-muted-foreground">
            {cap1(relativeDayLabel(o.effectiveDate, todayISO))}
            {o.moved && ` · moved from ${fmtDay(o.date)}`}
          </span>
        </span>
        <Chip hsl={chip.hsl}>{chip.label}</Chip>
        {items.length > 0 && <MoreHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
      </>
    );
    const cls = `w-full flex items-center gap-3 px-3.5 ${compact ? "py-2.5" : "py-3"} ${o.id === occurrence.id && !compact ? "bg-[hsl(var(--accent-hsl)/0.10)]" : ""}`;
    return items.length > 0 ? (
      <button type="button" className={`${cls} hover:bg-muted/50`} disabled={busy != null}
        onClick={() => { arm.disarm(); setMoveDate(null); setMenuOcc(o); }}
        aria-label={`${fmtShort(o.effectiveDate)}, ${chip.label}. Manage this date`}
        data-testid={`cal-occ-${o.date}`}>
        {body}
      </button>
    ) : (
      <div className={cls} data-testid={`cal-occ-${o.date}`}>{body}</div>
    );
  };

  /** Series-level actions: the More menu and the Options tab share them. */
  const SeriesOptions = ({ inMenu }: { inMenu: boolean }) => (
    <div className="space-y-2">
      {/* One date of a series was tapped: changing that date alone comes
          first, and each row says how far it reaches (O4). */}
      {isRecurring && tappedItems.length > 0 && (
        <ActionRow icon={CalendarClock} label={`Change only ${fmtShort(occurrence.effectiveDate)}`}
          hint="Move, skip or remove just this date. The rest of the series stays."
          onClick={openOnlyThisDate} testId={inMenu ? "cal-more-edit-one" : "cal-option-edit-one"} />
      )}
      <ActionRow icon={Pencil} label={editLabel}
        hint={!inPlace ? "Opens the record this date comes from"
          : isRecurring ? "Name, schedule and reminders, for every date" : "Name, schedule and reminders"}
        onClick={() => openEdit()} testId={inMenu ? "cal-more-edit" : "cal-option-edit"} />
      {inMenu && future.length > 0 && (
        <ActionRow icon={CalendarDays} label="View all occurrences" hint="Every date, with history"
          onClick={() => { closeMenus(); setScreen({ name: "occurrences", tab: "occurrences" }); }}
          testId="cal-more-occurrences" />
      )}
      {resumable && (
        <ActionRow icon={PlayCircle} label="Resume series"
          hint="Puts its dates back on the calendar, with every skip and check-off it had."
          onClick={() => void resume()} testId={inMenu ? "cal-more-resume" : "cal-option-resume"} />
      )}
      {/* Ending before the series' first date would leave no date at all —
          that is Delete, and End series is not offered (O4). */}
      {next && canEndSeriesBefore(series, next.date) && (
        <ActionRow icon={Scissors} destructive
          label={arm.isArmed("future") ? "Tap again to end the series" : "End series"}
          hint={`Stops before ${fmtShort(next.date)}. Earlier dates keep their history.`}
          onClick={() => arm.confirm("future", () => void run("deleteFuture", next))}
          testId="cal-action-deleteFuture" />
      )}
      {can(series, "deleteSeries") && (
        <ActionRow icon={Trash2} destructive
          label={arm.isArmed("series") ? "Tap again to delete" : actionLabelFor("deleteSeries", series.kind)}
          hint={DELETE_SERIES_HINT(series)}
          onClick={() => arm.confirm("series", () => void run("deleteSeries", next ?? occurrence))}
          testId="cal-action-deleteSeries" />
      )}
    </div>
  );

  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="bottom"
        className="h-[94dvh] max-h-[94dvh] rounded-t-3xl p-0 flex flex-col overflow-hidden [&>button]:hidden sm:max-w-lg sm:mx-auto"
        style={{ ["--accent-hsl" as any]: hsl }}
        // Opening must not put a focus ring on Close (the first control).
        onOpenAutoFocus={(e) => e.preventDefault()}
        data-testid="calendar-item-detail">
        {screen.name === "edit" ? (
          <>
            <SheetHeader className="sr-only">
              <SheetTitle>Edit {series.title}</SheetTitle>
              <SheetDescription>Change the name, schedule and reminders.</SheetDescription>
            </SheetHeader>
            <EditSeriesScreen
              series={series} mode={screen.mode} fromDate={screen.fromDate} initialTab={screen.tab}
              accent={hsl} todayISO={todayISO} getEventRow={getEventRow}
              onBack={() => setScreen({ name: "overview" })}
              onSaved={({ split }) => { if (split) onClose(); else setScreen({ name: "overview" }); }}
              onGone={onClose}
              onlyDate={isRecurring && tappedItems.length > 0 ? occurrence.effectiveDate : undefined}
              onEditOnly={openOnlyThisDate}
            />
          </>
        ) : (
          <>
            {/* ── Header ───────────────────────────────────────────────── */}
            <SheetHeader className="px-4 pt-4 pb-3 space-y-0 text-left">
              <div className="flex items-center gap-3">
                {screen.name === "occurrences" && (
                  <button type="button" aria-label="Back" onClick={() => setScreen({ name: "overview" })}
                    className="h-10 w-10 -ml-2 shrink-0 grid place-items-center rounded-full hover:bg-muted"
                    data-testid="cal-back">
                    <ArrowLeft className="h-5 w-5" />
                  </button>
                )}
                {screen.name === "overview" && (
                  <span className="h-14 w-14 shrink-0 grid place-items-center rounded-2xl border"
                    style={{
                      borderColor: `hsl(${hsl} / 0.45)`,
                      background: `linear-gradient(145deg, hsl(${hsl} / 0.32), hsl(${hsl} / 0.10))`,
                      color: `hsl(${hsl})`,
                    }}>
                    <Icon className="h-7 w-7" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <SheetTitle className={`${screen.name === "overview" ? "text-xl" : "text-lg"} font-bold tracking-tight leading-tight`} data-testid="cal-detail-title">
                    {series.title}
                  </SheetTitle>
                  <SheetDescription className="text-[13px] mt-0.5">{subtitle}</SheetDescription>
                  {screen.name === "overview" && (
                    <span className="mt-1.5 inline-block rounded-full px-2.5 py-0.5 text-[11px] font-semibold text-white"
                      style={{ background: `hsl(${hsl})` }} data-testid="cal-detail-type">
                      {KIND_LABELS[series.kind]}
                    </span>
                  )}
                </div>
                <button type="button" aria-label="Close" onClick={onClose}
                  className="h-10 w-10 -mr-1 shrink-0 self-start grid place-items-center rounded-full hover:bg-muted"
                  data-testid="cal-close">
                  <X className="h-5 w-5" />
                </button>
              </div>
            </SheetHeader>

            {/* ═════════════════════════ OVERVIEW ═════════════════════════ */}
            {screen.name === "overview" && (
              <>
                <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 space-y-3">
                  {resumable && (
                    <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3.5 flex items-center gap-3" data-testid="cal-detail-paused">
                      <PauseCircle className="h-5 w-5 shrink-0 text-amber-500" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold">Paused</span>
                        <span className="block text-[13px] text-muted-foreground">Its dates are hidden everywhere. Nothing was deleted.</span>
                      </span>
                      <Button size="sm" className="shrink-0" disabled={busy != null} onClick={() => void resume()} data-testid="cal-resume">
                        <PlayCircle className="h-4 w-4 mr-1" /> Resume
                      </Button>
                    </div>
                  )}
                  {/* Next occurrence — the one thing this screen is for. */}
                  <button type="button"
                    disabled={!next || nextMenu.length === 0 || busy != null}
                    onClick={() => next && setMenuOcc(next)}
                    className="w-full flex items-center gap-3.5 rounded-2xl border p-4 text-left disabled:cursor-default"
                    style={{
                      borderColor: `hsl(${hsl} / 0.55)`,
                      background: `linear-gradient(120deg, hsl(${hsl} / 0.30), hsl(${hsl} / 0.08))`,
                      boxShadow: `0 0 28px -10px hsl(${hsl} / 0.7)`,
                    }}
                    data-testid="cal-detail-next">
                    <span className="h-12 w-12 shrink-0 grid place-items-center rounded-full"
                      style={{ background: `hsl(${hsl} / 0.25)`, color: `hsl(${hsl})` }}>
                      <CalendarDays className="h-6 w-6" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] text-muted-foreground">
                        {payment ? "Next Payment" : isTask ? "Next Due" : "Next Occurrence"}
                      </span>
                      {next ? (
                        <>
                          <span className="block text-xl font-bold tracking-tight tabular-nums">{fmtDate(next.effectiveDate)}</span>
                          <span className="block text-[13px] text-muted-foreground">
                            {cap1(relativeDayLabel(next.effectiveDate, todayISO))}
                            {next.moved && ` · moved from ${fmtShort(next.date)}`}
                          </span>
                        </>
                      ) : (
                        <span className="block text-base font-semibold text-muted-foreground">No upcoming occurrence</span>
                      )}
                    </span>
                    {next && nextMenu.length > 0 && <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />}
                  </button>

                  {/* The date the user tapped, when it is not the next one. */}
                  {!paused && (!next || occurrence.id !== next.id) && (
                    <button type="button"
                      disabled={menuItemsFor(occurrence).length === 0 || busy != null}
                      onClick={() => setMenuOcc(occurrence)}
                      className="w-full flex items-center gap-3 rounded-2xl border border-border px-3.5 py-3 text-left disabled:cursor-default"
                      data-testid="cal-detail-selected">
                      <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12px] text-muted-foreground">Selected date</span>
                        <span className="block text-sm font-semibold tabular-nums">
                          {fmtDate(occurrence.effectiveDate)}
                          {occurrence.moved && <span className="font-normal text-muted-foreground"> · moved from {fmtShort(occurrence.date)}</span>}
                        </span>
                      </span>
                      {(() => { const c = statusChip(occurrence, false, payment); return <Chip hsl={c.hsl}>{c.label}</Chip>; })()}
                      {menuItemsFor(occurrence).length > 0 && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                    </button>
                  )}

                  {/* Repeats · Ends */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-2xl border border-border p-3.5 flex gap-3" data-testid="cal-detail-recurrence">
                      <Repeat className="h-5 w-5 shrink-0 mt-0.5" style={{ color: `hsl(${hsl})` }} />
                      <span className="min-w-0">
                        <span className="block text-[12px] text-muted-foreground">Repeats</span>
                        <span className="block text-sm font-bold leading-snug">{repeatsLabel}</span>
                      </span>
                    </div>
                    <div className="rounded-2xl border border-border p-3.5 flex gap-3" data-testid="cal-detail-ends">
                      <InfinityIcon className="h-5 w-5 shrink-0 mt-0.5" style={{ color: `hsl(${hsl})` }} />
                      <span className="min-w-0">
                        <span className="block text-[12px] text-muted-foreground">Ends</span>
                        <span className="block text-sm font-bold leading-snug">
                          {!isRecurring ? "One time" : series.recurrenceEnd ? fmtShort(series.recurrenceEnd) : "Never"}
                        </span>
                        {isRecurring && !series.recurrenceEnd && (
                          <span className="block text-[12px] text-muted-foreground">(Ongoing)</span>
                        )}
                      </span>
                    </div>
                  </div>

                  {/* Completion — only where "done" means something and something happened. */}
                  {showHistory && stats.total > 0 && (
                    <button type="button" onClick={() => setScreen({ name: "occurrences", tab: "history" })}
                      className="w-full flex items-center gap-3.5 rounded-2xl border border-border p-3.5 text-left hover:bg-muted/40"
                      data-testid="cal-detail-completion">
                      <CompletionRing pct={stats.pct} hsl={hsl} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-bold">{payment ? "Paid on record" : "Completion"}</span>
                        <span className="block text-[13px] text-muted-foreground">
                          {stats.completed} of {stats.total} occurrence{stats.total === 1 ? "" : "s"}
                        </span>
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </button>
                  )}

                  {/* Facts */}
                  <div className="rounded-2xl border border-border divide-y divide-border/60 overflow-hidden">
                    <InfoRow icon={Tag} label={isTask ? "Type" : `${payment ? "Payment" : "Event"} Type`}
                      value={isTask ? (isRecurring ? "Recurring task" : "Task") : KIND_LABELS[series.kind]}
                      onClick={inPlace ? () => openEdit("details") : undefined} testId="cal-detail-kind" />
                    {/* Every row that can be changed opens the page that changes it. */}
                    {inPlace && (
                      <InfoRow icon={CalendarClock} label="Schedule" value={repeatsLabel}
                        onClick={() => openEdit("repeat")} testId="cal-detail-schedule" />
                    )}
                    <div className="flex items-center gap-3 px-3.5 py-3" data-testid="cal-detail-source">
                      <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="flex-1 text-sm font-medium">Source</span>
                      <button type="button" onClick={goToSource}
                        className="inline-flex items-center gap-1 text-sm font-medium hover:underline text-[hsl(var(--accent-hsl))]"
                        data-testid="cal-detail-source-link">
                        {sourceLabel}
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                    {reminders && inPlace && (
                      <InfoRow icon={Bell} label="Reminders"
                        value={reminders.length ? `${reminders.length} active` : "None"}
                        onClick={() => openEdit("reminders")} testId="cal-detail-reminders" />
                    )}
                    {showHistory && (
                      <InfoRow icon={HistoryIcon} label="History"
                        value={history.length ? `${history.length} occurrence${history.length === 1 ? "" : "s"}` : "Nothing yet"}
                        onClick={() => setScreen({ name: "occurrences", tab: "history" })} testId="cal-detail-history" />
                    )}
                    {/* The amount shown is the NEXT occurrence's, not the
                        series'. For a variable bill those differ. */}
                    {(next ?? occurrence).amount != null && (
                      <InfoRow icon={Tag}
                        label={(next ?? occurrence).amountIsEstimate ? "Estimated" : "Amount"}
                        value={fmtMoney((next ?? occurrence).amount) || ""} />
                    )}
                  </div>

                  {duplicateNote && (
                    <p className="text-[12px] text-muted-foreground px-1" data-testid="cal-detail-duplicate-note">
                      {duplicateNote}
                    </p>
                  )}

                  {/* ── What THIS period costs ─────────────────────────────
                      Only rendered for a bill whose amount genuinely moves.
                      Every control here writes to this occurrence alone. */}
                  {showMoney && (
                    <div className="rounded-2xl border border-border p-3.5" data-testid="cal-detail-money">
                      <p className="text-[12px] text-muted-foreground mb-1">Amount for {fmtShort(occurrence.effectiveDate)}</p>
                      <div className="flex items-baseline gap-2 mb-2.5">
                        <span className="text-2xl font-bold tabular-nums">{fmtMoney(occurrence.amount ?? 0)}</span>
                        <span className="text-[12px] text-muted-foreground">
                          {occurrence.amountIsEstimate ? "estimated so far" : "posted"}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Input type="number" step="0.01" inputMode="decimal" value={moneyAmount}
                          onChange={(e) => setMoneyAmount(e.target.value)} placeholder="0.00"
                          className="h-10 text-sm" data-testid="cal-money-input" />
                        <select value={moneyAction}
                          onChange={(e) => setMoneyAction(e.target.value as CalendarMoneyAction)}
                          className="h-10 rounded-md border border-input bg-background px-2 text-[12px]"
                          data-testid="cal-money-action">
                          {MONEY_ACTIONS.map((a) => <option key={a} value={a}>{MONEY_ACTION_LABELS[a]}</option>)}
                        </select>
                        <Button size="sm" className="h-10 text-[12px]" disabled={busy != null || !moneyAmount}
                          onClick={() => void runMoney(occurrence)} data-testid="cal-money-apply">
                          Apply
                        </Button>
                      </div>
                      {occurrence.amountIsEstimate && (
                        <p className="text-[12px] text-muted-foreground mt-2">
                          Recording the actual amount freezes this month — later edits to the bill won't change it.
                        </p>
                      )}
                    </div>
                  )}

                  {/* Upcoming */}
                  <div>
                    <div className="flex items-center justify-between px-1 mb-2">
                      <h3 className="text-base font-bold">Upcoming Occurrences</h3>
                      {future.length > 0 && (
                        <button type="button" onClick={() => setScreen({ name: "occurrences", tab: "occurrences" })}
                          className="inline-flex items-center gap-0.5 text-sm font-semibold text-[hsl(var(--accent-hsl))]"
                          data-testid="cal-view-all">
                          View All <ChevronRight className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                    {future.length === 0 ? (
                      <p className="rounded-2xl border border-border py-5 text-center text-sm text-muted-foreground">
                        Nothing scheduled ahead.
                      </p>
                    ) : (
                      <div className="rounded-2xl border border-border divide-y divide-border/60 overflow-hidden" data-testid="cal-detail-upcoming">
                        {future.slice(0, 3).map((o) => <OccurrenceRow key={o.id} o={o} compact />)}
                      </div>
                    )}
                  </div>
                </div>

                {/* ── Bottom bar: the one thing you do, and everything else ── */}
                <div className="shrink-0 flex gap-3 border-t border-border/60 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                  {primaryComplete && next ? (
                    <button type="button" disabled={busy != null} onClick={() => void run("complete", next)}
                      className="flex-1 h-12 rounded-2xl text-[15px] font-semibold text-white inline-flex items-center justify-center gap-2 disabled:opacity-50"
                      style={{ background: `hsl(${hsl})`, boxShadow: `0 8px 22px -10px hsl(${hsl} / 0.9)` }}
                      data-testid="cal-action-complete">
                      <Check className="h-5 w-5" /> {primaryComplete.label}
                    </button>
                  ) : (
                    <button type="button" disabled={busy != null} onClick={() => openEdit()}
                      className="flex-1 h-12 rounded-2xl text-[15px] font-semibold text-white inline-flex items-center justify-center gap-2 disabled:opacity-50"
                      style={{ background: `hsl(${hsl})`, boxShadow: `0 8px 22px -10px hsl(${hsl} / 0.9)` }}
                      data-testid="cal-action-edit">
                      <Pencil className="h-5 w-5" /> {editLabel}
                    </button>
                  )}
                  <button type="button" onClick={() => { arm.disarm(); setMoreOpen(true); }}
                    className="h-12 px-5 rounded-2xl border border-border text-[15px] font-semibold inline-flex items-center justify-center gap-2 hover:bg-muted/50"
                    data-testid="cal-action-more">
                    <MoreHorizontal className="h-5 w-5" /> More
                  </button>
                </div>
              </>
            )}

            {/* ═══════════════════════ OCCURRENCES ════════════════════════ */}
            {screen.name === "occurrences" && (
              <>
                <div className="mx-4 mb-3 grid gap-1 rounded-2xl border border-border bg-muted/40 p-1"
                  style={{ gridTemplateColumns: `repeat(${showHistory ? 3 : 2}, minmax(0, 1fr))` }} role="tablist">
                  {(["occurrences", ...(showHistory ? ["history"] : []), "options"] as const).map((t) => (
                    <button key={t} type="button" role="tab" aria-selected={screen.tab === t}
                      onClick={() => { arm.disarm(); setScreen({ name: "occurrences", tab: t as any }); }}
                      className={`h-9 rounded-xl text-[13px] font-medium capitalize transition-colors ${screen.tab === t ? "text-white bg-[hsl(var(--accent-hsl))]" : "text-muted-foreground hover:text-foreground"}`}
                      data-testid={`cal-tab-${t}`}>
                      {t}
                    </button>
                  ))}
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-6">
                  {screen.tab === "occurrences" && (
                    future.length === 0 ? (
                      <p className="rounded-2xl border border-border py-6 text-center text-sm text-muted-foreground">
                        Nothing scheduled ahead.
                      </p>
                    ) : (
                      <>
                        <div className="rounded-2xl border border-border divide-y divide-border/60 overflow-hidden"
                          data-testid="cal-detail-occurrences">
                          {future.map((o) => <OccurrenceRow key={o.id} o={o} />)}
                        </div>
                        <p className="px-1 pt-2 text-[12px] text-muted-foreground">
                          {isRecurring && !series.recurrenceEnd
                            ? "The series continues past this list — more dates appear as these pass."
                            : `${future.length} date${future.length === 1 ? "" : "s"} ahead.`}
                        </p>
                      </>
                    )
                  )}

                  {screen.tab === "history" && showHistory && (
                    history.length === 0 ? (
                      <p className="rounded-2xl border border-border px-4 py-6 text-center text-sm text-muted-foreground" data-testid="cal-history-empty">
                        Nothing recorded yet. Completed, skipped, missed and rescheduled dates will be listed here.
                      </p>
                    ) : (
                      <div className="rounded-2xl border border-border divide-y divide-border/60 overflow-hidden" data-testid="cal-detail-history-list">
                        {history.map((h) => (
                          <div key={`${h.date}-${h.status}`} className="flex items-center gap-3 px-3.5 py-3" data-testid={`cal-history-${h.date}`}>
                            <CalendarDays className="h-4 w-4 shrink-0" style={{ color: `hsl(${HISTORY_HSL[h.status]})` }} />
                            <span className="flex-1 min-w-0">
                              <span className="block text-sm font-semibold tabular-nums">{fmtShort(h.date)}</span>
                              <span className="block text-[12px] text-muted-foreground">
                                {h.status === "rescheduled" && h.movedTo
                                  ? `Moved to ${fmtShort(h.movedTo)}`
                                  : cap1(relativeDayLabel(h.date, todayISO))}
                              </span>
                            </span>
                            <Chip hsl={HISTORY_HSL[h.status]}>
                              {h.status === "completed" && payment ? "Paid" : HISTORY_LABELS[h.status]}
                            </Chip>
                          </div>
                        ))}
                      </div>
                    )
                  )}

                  {screen.tab === "options" && <SeriesOptions inMenu={false} />}
                </div>
              </>
            )}

            {/* ═══════════ Action list: one date, or the More menu ═══════════ */}
            {(menuOcc || moreOpen) && (
              <div className="absolute inset-0 z-10 flex flex-col justify-end" data-testid="cal-action-sheet"
                role="group" aria-label={menuOcc ? `Actions for ${fmtShort(menuOcc.effectiveDate)} only` : `Actions for ${series.title}`}>
                <button type="button" aria-label="Close" className="flex-1 bg-black/50" onClick={closeMenus} />
                <div className="rounded-t-3xl border-t border-border bg-background px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] max-h-[80%] overflow-y-auto">
                  <div className="flex items-center gap-3 mb-3">
                    <CalendarDays className="h-5 w-5 shrink-0 text-[hsl(var(--accent-hsl))]" />
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-bold tabular-nums" data-testid="cal-action-sheet-title">
                        {menuOcc ? fmtShort(menuOcc.effectiveDate) : series.title}
                      </p>
                      {menuOcc && isRecurring && (
                        <p className="text-[12px] text-muted-foreground" data-testid="cal-action-sheet-scope">Only this date</p>
                      )}
                    </div>
                    <button type="button" aria-label="Close" onClick={closeMenus}
                      className="h-9 w-9 grid place-items-center rounded-full hover:bg-muted" data-testid="cal-action-sheet-close">
                      <X className="h-5 w-5" />
                    </button>
                  </div>

                  {menuOcc && moveDate != null ? (
                    <div className="space-y-3">
                      <p className="text-[13px] text-muted-foreground">
                        {isRecurring
                          ? `Only this occurrence moves. Scheduled for ${fmtDate(menuOcc.date)} — the rest of the series keeps its dates.`
                          : `Currently ${fmtDate(menuOcc.effectiveDate)}.`}
                      </p>
                      <Input type="date" value={moveDate} onChange={(e) => setMoveDate(e.target.value)}
                        className="h-11" data-testid="cal-move-date" />
                      <div className="flex gap-2">
                        <button type="button" onClick={() => setMoveDate(null)}
                          className="flex-1 h-11 rounded-xl border border-border text-sm font-semibold">Back</button>
                        <button type="button"
                          disabled={!moveDate || moveDate === menuOcc.effectiveDate || busy != null}
                          onClick={() => void run("move", menuOcc, moveDate)}
                          className="flex-1 h-11 rounded-xl text-sm font-semibold text-white disabled:opacity-40 bg-[hsl(var(--accent-hsl))]"
                          data-testid="cal-move-confirm">
                          Change date
                        </button>
                      </div>
                    </div>
                  ) : menuOcc ? (
                    <div className="space-y-2">
                      {menuItemsFor(menuOcc).map((item) => {
                        const armed = item.action === "deleteOccurrence" && arm.isArmed(`del:${menuOcc.id}`);
                        return (
                          <ActionRow key={item.action} icon={MENU_ICONS[item.action]}
                            label={armed ? "Tap again to delete" : item.label} hint={item.hint}
                            destructive={item.destructive} accent={item.action === "complete"}
                            disabled={busy != null}
                            onClick={() => onMenuAction(item, menuOcc)}
                            testId={`cal-menu-${item.action}`} />
                        );
                      })}
                    </div>
                  ) : (
                    <SeriesOptions inMenu />
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** One labelled action in an action list: what it does, and how far it reaches. */
function ActionRow({ icon: Icon, label, hint, onClick, destructive, accent, disabled, testId }: {
  icon: any; label: string; hint: string; onClick: () => void;
  destructive?: boolean; accent?: boolean; disabled?: boolean; testId: string;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`w-full flex items-center gap-3.5 rounded-2xl border px-3.5 py-3 text-left disabled:opacity-50 ${destructive
        ? "border-red-500/40 text-red-500 hover:bg-red-500/10" : "border-border hover:bg-muted/50"}`}
      data-testid={testId}>
      {accent ? (
        <span className="h-8 w-8 shrink-0 grid place-items-center rounded-full text-white bg-[hsl(var(--accent-hsl))]">
          <Icon className="h-4 w-4" />
        </span>
      ) : (
        <span className="h-8 w-8 shrink-0 grid place-items-center"><Icon className="h-5 w-5" /></span>
      )}
      <span className="min-w-0">
        <span className="block text-[15px] font-semibold">{label}</span>
        <span className={`block text-[12px] ${destructive ? "opacity-80" : "text-muted-foreground"}`}>{hint}</span>
      </span>
    </button>
  );
}

/** One fact row on the overview; a button when it leads somewhere. */
function InfoRow({ icon: Icon, label, value, onClick, testId }: {
  icon: any; label: string; value: string; onClick?: () => void; testId?: string;
}) {
  const body = (
    <>
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 text-sm font-medium text-left">{label}</span>
      <span className="text-sm text-muted-foreground">{value}</span>
      {onClick && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className="w-full flex items-center gap-3 px-3.5 py-3 hover:bg-muted/40" data-testid={testId}>
      {body}
    </button>
  ) : (
    <div className="flex items-center gap-3 px-3.5 py-3" data-testid={testId}>{body}</div>
  );
}

function CompletionRing({ pct, hsl }: { pct: number; hsl: string }) {
  const r = 18;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative h-12 w-12 shrink-0 grid place-items-center" role="img" aria-label={`${pct}% complete`}>
      <svg viewBox="0 0 44 44" className="absolute inset-0 -rotate-90">
        <circle cx="22" cy="22" r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth="4" />
        <circle cx="22" cy="22" r={r} fill="none" stroke={`hsl(${hsl})`} strokeWidth="4" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} />
      </svg>
      <span className="text-[12px] font-bold tabular-nums">{pct}%</span>
    </span>
  );
}

const DELETE_SERIES_HINT = (s: CalendarSeries): string =>
  s.source.system === "profile"
    ? "Clears the date from the profile. The profile itself is kept."
    : s.source.system === "liability"
      ? "Stops the payment schedule. The liability record is kept."
      : s.recurrence && s.recurrence !== "none"
        ? "Removes every date and its history. To remove one date, skip it instead."
        : "Removes this date.";

const SUCCESS_MESSAGE: Record<CalendarAction, (date: string, newDate?: string) => string> = {
  edit: () => "Opening source",
  move: (d, n) => (n ? `Moved ${fmtShort(d)} to ${fmtShort(n)} — the rest of the series is unchanged` : `Moved the ${fmtShort(d)} occurrence`),
  complete: (d) => `Checked off ${fmtShort(d)} — the series stays on schedule`,
  skip: (d) => `Skipped ${fmtShort(d)} — future dates stay scheduled`,
  deleteOccurrence: (d) => `Removed ${fmtShort(d)}`,
  deleteFuture: (d) => `Series ends before ${fmtShort(d)}`,
  deleteSeries: () => "Deleted",
};

// Every message names the MONTH the change landed on, because the one thing a
// user must be able to trust here is that only that month moved.
const MONEY_SUCCESS: Record<CalendarMoneyAction, (date: string) => string> = {
  addCharge: (d) => `Charge added to the ${fmtShort(d)} bill`,
  setEstimate: (d) => `Estimate updated for ${fmtShort(d)}`,
  setActual: (d) => `${fmtShort(d)} recorded as the actual amount`,
};

export default CalendarItemDetail;
