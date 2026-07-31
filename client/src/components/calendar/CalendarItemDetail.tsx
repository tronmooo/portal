// ── The standardized calendar detail panel ───────────────────────────────────
//
// ONE panel for every kind of date. A birthday, a mortgage payment, a Netflix
// renewal, a recurring task and a plain event all open the exact same layout,
// in the same order:
//
//   Source profile · Title · Type · Recurrence · Next occurrence
//   Full list of future occurrences (each individually actionable)
//   Edit · Move · Skip · Delete one · Delete future · Delete series
//
// Nothing here computes dates. Occurrences come from the one engine
// (shared/calendar-occurrences); which actions are live comes from the one
// capability matrix (shared/calendar-capabilities); performing them is routed
// by client/src/lib/calendar-mutations. This component only renders.

import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Medallion } from "@/components/dashboard/visuals";
import { formatMoney } from "@/lib/format";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import {
  Cake, CalendarHeart, CreditCard, Receipt, Wallet, RefreshCw, Wrench,
  Stethoscope, Bell, CheckSquare, FileText, CalendarDays, Repeat,
  Check, SkipForward, Trash2, CalendarClock, Pencil, ExternalLink, ChevronRight,
} from "lucide-react";
import {
  KIND_LABELS, relativeDayLabel,
  type CalendarOccurrence, type CalendarSeries, type OccurrenceKind,
} from "@shared/calendar-occurrences";
import {
  capabilitiesFor, ACTION_LABELS, type CalendarAction,
} from "@shared/calendar-capabilities";
import { humanRecurrenceLabel } from "@shared/recurring-dates";
import { applyCalendarAction } from "@/lib/calendar-mutations";

const KIND_ICONS: Record<OccurrenceKind, any> = {
  birthday: Cake,
  anniversary: CalendarHeart,
  subscription: CreditCard,
  liability: Wallet,
  bill: Receipt,
  renewal: RefreshCw,
  maintenance: Wrench,
  appointment: Stethoscope,
  reminder: Bell,
  task: CheckSquare,
  habit: Repeat,
  document: FileText,
  event: CalendarDays,
  custom: CalendarDays,
};

const KIND_HSL: Record<OccurrenceKind, string> = {
  birthday: "262 75% 64%",
  anniversary: "330 75% 60%",
  subscription: "220 80% 62%",
  liability: "270 70% 62%",
  bill: "0 72% 58%",
  renewal: "38 92% 52%",
  maintenance: "199 85% 55%",
  appointment: "155 62% 44%",
  reminder: "48 90% 55%",
  task: "210 80% 60%",
  habit: "170 60% 45%",
  document: "215 15% 60%",
  event: "240 8% 60%",
  custom: "240 8% 60%",
};

const STATUS_HSL: Record<CalendarOccurrence["status"], string> = {
  done: "155 62% 44%",
  skipped: "240 6% 55%",
  overdue: "0 72% 58%",
  past: "220 10% 55%",
  today: "38 92% 52%",
  upcoming: "220 10% 55%",
};

const ACTION_ICONS: Record<CalendarAction, any> = {
  edit: Pencil,
  move: CalendarClock,
  complete: Check,
  skip: SkipForward,
  deleteOccurrence: Trash2,
  deleteFuture: Trash2,
  deleteSeries: Trash2,
};

const fmtDate = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  });
const fmtShort = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const fmtMoney = (n?: number) => (n == null ? null : formatMoney(n));

/** One labelled row in the summary block. */
function Field({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5" data-testid={testId}>
      <span className="micro-label text-muted-foreground shrink-0 pt-px">{label}</span>
      <span className="text-xs font-medium text-right min-w-0">{children}</span>
    </div>
  );
}

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
}

export function CalendarItemDetail({
  occurrence, seriesOccurrences, getEventRow, profileName, todayISO, onClose, duplicateNote,
}: CalendarItemDetailProps) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<CalendarOccurrence | null>(null);
  const [moveDate, setMoveDate] = useState("");
  const [confirm, setConfirm] = useState<
    { action: CalendarAction; occ: CalendarOccurrence } | null
  >(null);

  const series: CalendarSeries | null = occurrence?.series ?? null;
  const capabilities = useMemo(() => (series ? capabilitiesFor(series) : []), [series]);
  const capOf = (a: CalendarAction) => capabilities.find((c) => c.action === a);

  const future = useMemo(
    () => seriesOccurrences.filter((o) => o.effectiveDate >= todayISO),
    [seriesOccurrences, todayISO],
  );
  const next = useMemo(
    () => future.find((o) => o.status !== "done" && o.status !== "skipped") ?? null,
    [future],
  );

  if (!occurrence || !series) return null;

  const Icon = KIND_ICONS[series.kind] ?? CalendarDays;
  const hsl = KIND_HSL[series.kind] ?? KIND_HSL.custom;
  const ownerId = series.source.profileId;
  const ownerName = ownerId ? profileName?.(ownerId) : undefined;
  const isRecurring = !!series.recurrence && series.recurrence !== "none";

  const run = async (action: CalendarAction, occ: CalendarOccurrence, newDate?: string) => {
    setBusy(`${action}:${occ.id}`);
    try {
      await applyCalendarAction({
        action, series, occurrence: occ, newDate, todayISO, getEventRow,
      });
      toast({ title: SUCCESS_MESSAGE[action](occ.date) });
      // Deleting the series (or the only occurrence) leaves nothing to show.
      if (action === "deleteSeries" || (action === "deleteOccurrence" && !isRecurring)) onClose();
    } catch (e: any) {
      toast({
        title: "Couldn't complete that",
        description: e?.message || "Try again",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
      setConfirm(null);
      setMoveTarget(null);
    }
  };

  const goToSource = () => {
    onClose();
    const href = String(series.source.href || "").replace(/^#/, "");
    if (href) navigate(href);
  };

  /** An action button that is either live or disabled with its reason. */
  const ActionButton = ({ action, occ, variant = "outline" }: {
    action: CalendarAction; occ: CalendarOccurrence; variant?: "outline" | "ghost";
  }) => {
    const cap = capOf(action);
    const ActionIcon = ACTION_ICONS[action];
    const destructive = action.startsWith("delete");
    const btn = (
      <Button
        size="sm"
        variant={variant}
        disabled={!cap?.enabled || busy != null}
        className={`h-8 text-[11px] justify-start ${destructive && cap?.enabled ? "text-red-500 hover:text-red-500" : ""}`}
        onClick={() => {
          if (action === "edit") return goToSource();
          if (action === "move") { setMoveTarget(occ); setMoveDate(occ.effectiveDate); return; }
          if (destructive) { setConfirm({ action, occ }); return; }
          void run(action, occ);
        }}
        data-testid={`cal-action-${action}`}
      >
        <ActionIcon className="h-3.5 w-3.5 mr-1.5" />
        {ACTION_LABELS[action]}
      </Button>
    );
    if (cap?.enabled) return btn;
    return (
      <Tooltip>
        {/* A disabled button swallows pointer events, so the wrapper carries them. */}
        <TooltipTrigger asChild><span className="inline-flex">{btn}</span></TooltipTrigger>
        <TooltipContent side="top" className="max-w-[220px] text-[11px]">{cap?.reason}</TooltipContent>
      </Tooltip>
    );
  };

  return (
    <TooltipProvider delayDuration={200}>
      <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
        <SheetContent side="bottom" className="max-h-[92dvh] overflow-y-auto rounded-t-2xl p-0" data-testid="calendar-item-detail">
          {/* ── Header ─────────────────────────────────────────────────── */}
          <SheetHeader className="px-4 pt-4 pb-3 space-y-0 text-left">
            <div className="flex items-start gap-3">
              <Medallion icon={Icon} accent={hsl} />
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-base font-bold tracking-tight leading-tight" data-testid="cal-detail-title">
                  {series.title}
                </SheetTitle>
                <SheetDescription className="text-xs mt-0.5">
                  {fmtDate(occurrence.effectiveDate)}
                  {occurrence.moved && <span className="text-muted-foreground"> · moved from {fmtShort(occurrence.date)}</span>}
                </SheetDescription>
              </div>
              <Badge variant="outline" className="text-[11px] border-0 shrink-0"
                style={{ background: `hsl(${hsl} / 0.14)`, color: `hsl(${hsl})` }}
                data-testid="cal-detail-type">
                {KIND_LABELS[series.kind]}
              </Badge>
            </div>
          </SheetHeader>

          {/* ── Summary: source · type · recurrence · next ───────────────── */}
          <div className="px-4 pb-3 border-b border-border/60 divide-y divide-border/40">
            <Field label="Source" testId="cal-detail-source">
              <button type="button" onClick={goToSource}
                className="inline-flex items-center gap-1 text-primary hover:underline"
                data-testid="cal-detail-source-link">
                {ownerName || series.source.label || KIND_LABELS[series.kind]}
                <ExternalLink className="h-3 w-3" />
              </button>
            </Field>
            <Field label="Type">{KIND_LABELS[series.kind]}</Field>
            <Field label="Repeats" testId="cal-detail-recurrence">
              {isRecurring ? humanRecurrenceLabel(series.recurrence, series.baseDate) : "Does not repeat"}
              {series.recurrenceEnd && (
                <span className="block text-[11px] text-muted-foreground font-normal">
                  until {fmtShort(series.recurrenceEnd)}
                </span>
              )}
            </Field>
            <Field label="Next" testId="cal-detail-next">
              {next ? (
                <>
                  {fmtDate(next.effectiveDate)}
                  <span className="block text-[11px] text-muted-foreground font-normal">
                    {relativeDayLabel(next.effectiveDate, todayISO)}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground font-normal">No upcoming occurrence</span>
              )}
            </Field>
            {series.amount != null && <Field label="Amount">{fmtMoney(series.amount)}</Field>}
            {duplicateNote && (
              <p className="pt-2 text-[11px] text-muted-foreground" data-testid="cal-detail-duplicate-note">
                {duplicateNote}
              </p>
            )}
          </div>

          {/* ── Actions for THIS occurrence ──────────────────────────────── */}
          <div className="px-4 py-3 border-b border-border/60">
            <p className="micro-label text-muted-foreground mb-2">
              This occurrence · {fmtShort(occurrence.effectiveDate)}
            </p>
            <div className="grid grid-cols-2 gap-1.5">
              <ActionButton action="edit" occ={occurrence} />
              <ActionButton action="move" occ={occurrence} />
              <ActionButton action="complete" occ={occurrence} />
              <ActionButton action="skip" occ={occurrence} />
              <ActionButton action="deleteOccurrence" occ={occurrence} />
              <ActionButton action="deleteFuture" occ={occurrence} />
            </div>
            <div className="mt-1.5">
              <ActionButton action="deleteSeries" occ={occurrence} />
            </div>
          </div>

          {/* ── Every future occurrence, individually actionable ─────────── */}
          <div className="px-4 py-3">
            <div className="flex items-baseline justify-between mb-2">
              <p className="micro-label text-muted-foreground">
                Upcoming occurrences
              </p>
              <span className="text-[11px] text-muted-foreground tabular-nums">{future.length}</span>
            </div>
            {future.length === 0 ? (
              <p className="text-xs text-muted-foreground py-3 text-center">
                Nothing scheduled ahead.
              </p>
            ) : (
              <div className="rounded-xl border border-border divide-y divide-border/40 overflow-hidden"
                data-testid="cal-detail-occurrences">
                {future.map((o) => {
                  const done = o.status === "done" || o.status === "skipped";
                  const canCheck = capOf("complete")?.enabled;
                  const canSkip = capOf("skip")?.enabled;
                  const canMove = capOf("move")?.enabled;
                  return (
                    <div key={o.id}
                      className={`flex items-center gap-2 px-2.5 py-2 ${o.id === occurrence.id ? "bg-muted/40" : ""}`}
                      data-testid={`cal-occ-${o.date}`}>
                      <span className="h-1.5 w-1.5 rounded-full shrink-0"
                        style={{ background: `hsl(${STATUS_HSL[o.status]})` }} />
                      <div className="flex-1 min-w-0">
                        <p className={`text-xs tabular-nums ${done ? "line-through text-muted-foreground" : ""}`}>
                          {fmtShort(o.effectiveDate)}
                          {o.moved && <span className="text-[11px] text-muted-foreground"> (moved)</span>}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {relativeDayLabel(o.effectiveDate, todayISO)}
                          {o.status === "done" ? " · done" : o.status === "skipped" ? " · skipped" : ""}
                        </p>
                      </div>
                      {canCheck && (
                        <Button size="sm" variant="ghost"
                          className={`h-6 w-6 p-0 ${done ? "text-muted-foreground" : "text-emerald-500"}`}
                          disabled={busy != null}
                          title={done ? "Undo" : "Check off"}
                          onClick={() => void run("complete", o)}
                          data-testid={`cal-occ-done-${o.date}`}>
                          <Check className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {canMove && (
                        <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-muted-foreground"
                          disabled={busy != null} title="Move this date"
                          onClick={() => { setMoveTarget(o); setMoveDate(o.effectiveDate); }}
                          data-testid={`cal-occ-move-${o.date}`}>
                          <CalendarClock className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {canSkip && (
                        <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-muted-foreground"
                          disabled={busy != null} title="Skip this occurrence"
                          onClick={() => void run("skip", o)}
                          data-testid={`cal-occ-skip-${o.date}`}>
                          <SkipForward className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-muted-foreground/60"
                        onClick={goToSource} title="Open source">
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Move dialog ────────────────────────────────────────────────── */}
      <AlertDialog open={!!moveTarget} onOpenChange={(o) => { if (!o) setMoveTarget(null); }}>
        <AlertDialogContent className="max-w-xs">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">Move this occurrence</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              {moveTarget && `Currently ${fmtDate(moveTarget.effectiveDate)}. Only this date moves — the rest of the series keeps its schedule.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input type="date" value={moveDate} onChange={(e) => setMoveDate(e.target.value)}
            data-testid="cal-move-date" />
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8 text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction className="h-8 text-xs" disabled={!moveDate || busy != null}
              onClick={(e) => {
                e.preventDefault();
                if (moveTarget && moveDate) void run("move", moveTarget, moveDate);
              }}
              data-testid="cal-move-confirm">
              Move
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Destructive confirmation ───────────────────────────────────── */}
      <AlertDialog open={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">
              {confirm ? CONFIRM_TITLE[confirm.action](series.title) : ""}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              {confirm ? CONFIRM_BODY[confirm.action](confirm.occ.date, series) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8 text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction className="h-8 text-xs bg-red-600 hover:bg-red-700"
              onClick={(e) => { e.preventDefault(); if (confirm) void run(confirm.action, confirm.occ); }}
              data-testid="cal-confirm-delete">
              {confirm ? ACTION_LABELS[confirm.action] : ""}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}

const SUCCESS_MESSAGE: Record<CalendarAction, (date: string) => string> = {
  edit: () => "Opening source",
  move: (d) => `Moved the ${fmtShort(d)} occurrence`,
  complete: (d) => `Checked off ${fmtShort(d)} — the series stays on schedule`,
  skip: (d) => `Skipped ${fmtShort(d)}`,
  deleteOccurrence: (d) => `Removed ${fmtShort(d)}`,
  deleteFuture: (d) => `Series ends before ${fmtShort(d)}`,
  deleteSeries: () => "Series deleted",
};

const CONFIRM_TITLE: Record<CalendarAction, (title: string) => string> = {
  edit: () => "",
  move: () => "",
  complete: () => "",
  skip: () => "",
  deleteOccurrence: (t) => `Remove this occurrence of "${t}"?`,
  deleteFuture: (t) => `End "${t}" from this date?`,
  deleteSeries: (t) => `Delete "${t}" entirely?`,
};

const CONFIRM_BODY: Record<CalendarAction, (date: string, series: CalendarSeries) => string> = {
  edit: () => "",
  move: () => "",
  complete: () => "",
  skip: () => "",
  deleteOccurrence: (d) =>
    `Only ${fmtShort(d)} is removed. Every other occurrence stays, and the series keeps running.`,
  deleteFuture: (d) =>
    `${fmtShort(d)} and everything after it are removed. Past occurrences keep their history.`,
  deleteSeries: (_d, s) =>
    s.source.system === "profile"
      ? `The date is cleared from the profile. The profile itself is not deleted.`
      : s.source.system === "liability"
        ? `The payment schedule stops. The liability record itself is kept.`
        : `The whole series and its history disappear from the calendar, dashboard, and notifications. To remove one date, skip that occurrence instead.`,
};

export default CalendarItemDetail;
