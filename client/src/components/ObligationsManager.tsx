// Obligations management UI extracted from /obligations into a reusable
// component so it can be embedded as a tab on /calendar. Owns:
//   • Live occurrence panel (Overdue / Due today / Next 14 days)
//   • Full list of recurring obligations with edit / delete / mark-paid
//   • Create dialog with kind-aware defaults
// This is intentionally self-contained — drop it anywhere there's a page shell.

import { formatApiError } from "@/lib/formatError";
import { useState, useEffect, useMemo, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import EditableTitle from "@/components/EditableTitle";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { getProfileFilter, subscribeProfileFilter } from "@/lib/profileFilter";
import { passesProfileFilter } from "@shared/profile-filter";
import { addMonthsClamped, addYearsClamped } from "@shared/date-math";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { DollarSign, Calendar, CreditCard, CheckCircle, AlertTriangle, Clock, Repeat, Building2, Plus, AlertCircle, Trash2, Pencil, Receipt, Pill, Wrench, CalendarClock, Activity, FileWarning, CheckSquare, SkipForward, RotateCcw, Pause, Play, ExternalLink, Link2, X, ChevronRight, ChevronDown, User, Calendar as CalIcon } from "lucide-react";
import { useLocation } from "wouter";
import type { Obligation } from "@shared/schema";
import { OBLIGATION_KIND_META, type ObligationKind } from "@shared/schema";

// ----- Recurrence helpers ----------------------------------------------------
// Compute the next N occurrence dates from a start date + frequency, mirroring
// what the server engine does so the create-dialog preview matches reality.
function nextOccurrencesFrom(startISO: string, freq: string, count = 3): string[] {
  if (!startISO) return [];
  try {
    const out: string[] = [];
    const base = new Date(startISO + (startISO.length === 10 ? "T00:00:00" : ""));
    if (isNaN(base.getTime())) return [];
    // Month/year steps index off the base and clamp to month end so a series
    // on the 31st reads 31 → 30 → 31, not 31 → 1 → 1 (shared/date-math).
    const anchorDay = base.getDate();
    const d = new Date(base);
    for (let i = 0; i < count; i++) {
      out.push(d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }));
      switch (freq) {
        case "weekly": d.setDate(d.getDate() + 7); break;
        case "biweekly": d.setDate(d.getDate() + 14); break;
        case "monthly": d.setTime(addMonthsClamped(base, i + 1, anchorDay).getTime()); break;
        case "quarterly": d.setTime(addMonthsClamped(base, 3 * (i + 1), anchorDay).getTime()); break;
        case "yearly": d.setTime(addYearsClamped(base, i + 1, anchorDay).getTime()); break;
        case "once": return out; // no repeats
        default: return out;
      }
    }
    return out;
  } catch { return []; }
}

// Count + first/last occurrence summary for a [start..end] window. Mirrors the
// server engine's expansion semantics. Returns null when inputs aren't sensible.
function occurrenceSeries(
  startISO: string,
  endISO: string | null,
  freq: string,
): { count: number; first: string; last: string } | null {
  if (!startISO) return null;
  try {
    const start = new Date(startISO + "T00:00:00");
    if (isNaN(start.getTime())) return null;
    if (freq === "once") {
      const s = start.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      return { count: 1, first: s, last: s };
    }
    // Default to a 2-year horizon when no end date provided (matches server).
    const end = endISO
      ? new Date(endISO + "T00:00:00")
      : new Date(start.getFullYear() + 2, start.getMonth(), start.getDate());
    if (isNaN(end.getTime()) || end < start) return null;
    let count = 0;
    let lastDate = new Date(start);
    const cur = new Date(start);
    const anchorDay = start.getDate();
    for (let i = 0; i < 500; i++) {
      if (cur > end) break;
      count++;
      lastDate = new Date(cur);
      switch (freq) {
        case "weekly": cur.setDate(cur.getDate() + 7); break;
        case "biweekly": cur.setDate(cur.getDate() + 14); break;
        case "monthly": cur.setTime(addMonthsClamped(start, i + 1, anchorDay).getTime()); break;
        case "quarterly": cur.setTime(addMonthsClamped(start, 3 * (i + 1), anchorDay).getTime()); break;
        case "yearly": cur.setTime(addYearsClamped(start, i + 1, anchorDay).getTime()); break;
        default: return null;
      }
    }
    if (count === 0) return null;
    const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return { count, first: fmt(start), last: fmt(lastDate) };
  } catch { return null; }
}

// Map a kind to the page where its source object lives. Used by the detail
// drawer's "View linked" deep-link.
function linkedSourceRoute(ob: Obligation): { label: string; route: string } | null {
  if (ob.linkedAssetId) return { label: "View asset", route: `/linked` };
  if (ob.linkedLiabilityId) return { label: "View liability", route: `/linked` };
  if (ob.linkedDocumentId) return { label: "View document", route: `/documents/${ob.linkedDocumentId}` };
  if (ob.linkedProfiles && ob.linkedProfiles.length > 0) return { label: "View profile", route: `/profiles/${ob.linkedProfiles[0]}` };
  return null;
}

// Best-effort "where did this come from" label. We don't have a dedicated
// column, so we read an optional fields.source ("chat" | "document" |
// "tracker" | "manual" | "ai") when the creator recorded one.
function obligationSource(ob: Obligation): string | null {
  const s = (ob as any)?.fields?.source;
  if (!s || typeof s !== "string") return null;
  const map: Record<string, string> = {
    chat: "From chat", document: "From document", tracker: "From tracker",
    manual: "Added manually", ai: "From assistant", extraction: "From document",
  };
  return map[s.toLowerCase()] || null;
}

// Build the visible description for a card: the user's notes plus any useful
// structured context the creator stored in fields (vendor, address, service,
// provider, account). Returns "" when there's nothing meaningful to show.
function obligationDescription(ob: Obligation): string {
  const parts: string[] = [];
  if (ob.notes && ob.notes.trim()) parts.push(ob.notes.trim());
  const f = (ob as any)?.fields || {};
  for (const key of ["vendor", "provider", "service", "address", "account", "policyNumber", "location"]) {
    const v = f[key];
    if (v != null && String(v).trim() && !parts.some(p => p.toLowerCase().includes(String(v).toLowerCase()))) {
      const label = key.replace(/([A-Z])/g, " $1").replace(/^\w/, c => c.toUpperCase());
      parts.push(`${label}: ${v}`);
    }
  }
  return parts.join(" · ");
}

const KIND_ICON: Record<ObligationKind, any> = {
  bill: Receipt, subscription: Repeat, loan_payment: CreditCard,
  medication: Pill, maintenance: Wrench, appointment: CalendarClock,
  habit: Activity, doc_expiration: FileWarning, task: CheckSquare,
};

// What "source" group does this obligation belong to in the Linked-Items view?
function sourceGroup(ob: Obligation): { key: string; label: string; icon: any; color: string } {
  const k = (ob.kind as ObligationKind) || "bill";
  const meta = OBLIGATION_KIND_META[k];
  return { key: k, label: `${meta.label}s`, icon: KIND_ICON[k], color: meta.color };
}

const CATEGORY_ICONS: Record<string, any> = {
  housing: Building2, loan: CreditCard, insurance: AlertTriangle,
  health: CheckCircle, investment: DollarSign,
};

// Shared cache invalidator so every mutation refreshes the same surfaces.
function invalidateAll() {
  queryClient.invalidateQueries({ queryKey: ["/api/obligation-occurrences"] });
  queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
  queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
  queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
  queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
  queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
}

// Per-occurrence row used by the live "Due today / Overdue / Upcoming" panel.
function OccurrenceRow({ occ }: { occ: any }) {
  const { toast } = useToast();
  const kind = (occ.obligation?.kind || "bill") as ObligationKind;
  const meta = OBLIGATION_KIND_META[kind];
  const Icon = KIND_ICON[kind] || Receipt;
  const due = new Date(occ.due_at + "T00:00:00");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const daysOff = Math.round((due.getTime() - today.getTime()) / 86400000);
  const isOverdue = occ.status === "late" || (occ.status === "pending" && daysOff < 0);
  const isDone = occ.status === "done";
  const isSkipped = occ.status === "skipped";

  const setStatus = useMutation<unknown, Error, string, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: (status: string) => apiRequest("POST", `/api/obligation-occurrences/${occ.id}/status`, { status }),
    onMutate: async (status) => {
      await queryClient.cancelQueries({ queryKey: ["/api/obligation-occurrences"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/obligation-occurrences"] });
      queryClient.setQueriesData({ queryKey: ["/api/obligation-occurrences"] }, (old: any) =>
        Array.isArray(old) ? old.map((o: any) => o?.id === occ.id ? { ...o, status } : o) : old
      );
      return { prev };
    },
    onSuccess: (_d, status) => { invalidateAll(); toast({ title: status === "done" ? "Marked done" : status === "skipped" ? "Skipped" : "Updated" }); },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) { for (const [k, d] of ctx.prev) queryClient.setQueryData(k, d); }
      toast({ title: "Update failed", description: formatApiError(err), variant: "destructive" });
    },
  });
  const reschedule = useMutation<unknown, Error, string, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: (newDueAt: string) => apiRequest("POST", `/api/obligation-occurrences/${occ.id}/reschedule`, { newDueAt }),
    onMutate: async (newDueAt) => {
      await queryClient.cancelQueries({ queryKey: ["/api/obligation-occurrences"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/obligation-occurrences"] });
      queryClient.setQueriesData({ queryKey: ["/api/obligation-occurrences"] }, (old: any) =>
        Array.isArray(old) ? old.map((o: any) => o?.id === occ.id ? { ...o, due_at: newDueAt } : o) : old
      );
      return { prev };
    },
    onSuccess: () => { invalidateAll(); toast({ title: "Rescheduled" }); },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) { for (const [k, d] of ctx.prev) queryClient.setQueryData(k, d); }
      toast({ title: "Reschedule failed", description: formatApiError(err), variant: "destructive" });
    },
  });

  // BUG-OBL-003: "0d overdue" reads wrong on today's items; show "Due today" instead.
  const dateLabel = daysOff === 0 && !isDone && !isSkipped
    ? "Due today"
    : isOverdue
    ? `${Math.abs(daysOff)}d overdue`
    : daysOff === 1 ? "Tomorrow"
    : daysOff > 0 ? `In ${daysOff}d`
    : due.toLocaleDateString();

  return (
    <div data-testid={`occurrence-row-${occ.id}`} className={`flex items-center gap-3 rounded-md border px-3 py-2 ${isOverdue ? "border-red-500/40 bg-red-500/5" : isDone ? "opacity-60" : isSkipped ? "opacity-50" : "border-border"}`}>
      <span className="shrink-0 inline-flex items-center justify-center rounded-md" style={{ width: 32, height: 32, background: `${meta.color}22`, color: meta.color }}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className={`text-sm font-medium truncate ${isDone ? "line-through" : ""}`}>{occ.obligation?.name || "Untitled"}</p>
          <Badge variant="outline" className="text-[10px] py-0 px-1.5 h-4" style={{ borderColor: meta.color, color: meta.color }}>{meta.label}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {occ.obligation?.amount > 0 && <>${Number(occ.obligation.amount).toFixed(2)} · </>}
          <span className={isOverdue ? "text-red-600 font-medium" : ""}>{dateLabel}</span>
          {occ.obligation?.autopay && <> · Autopay</>}
        </p>
      </div>
      {!isDone && !isSkipped && (
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" className="h-7 px-2" disabled={setStatus.isPending}
            onClick={() => setStatus.mutate("done")} data-testid={`button-mark-done-${occ.id}`}>
            <CheckCircle className="h-3.5 w-3.5 mr-1" /> Done
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" disabled={setStatus.isPending}
            onClick={() => setStatus.mutate("skipped")} data-testid={`button-skip-${occ.id}`} aria-label="Skip">
            <SkipForward className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" disabled={reschedule.isPending}
            onClick={() => {
              const next = prompt("Reschedule to (YYYY-MM-DD):", occ.due_at);
              if (next && /^\d{4}-\d{2}-\d{2}$/.test(next)) reschedule.mutate(next);
            }} data-testid={`button-reschedule-${occ.id}`} aria-label="Reschedule">
            <Clock className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      {(isDone || isSkipped) && (
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={setStatus.isPending}
          onClick={() => setStatus.mutate("pending")} data-testid={`button-undo-${occ.id}`}>
          <RotateCcw className="h-3.5 w-3.5 mr-1" /> Undo
        </Button>
      )}
    </div>
  );
}

function ObligationCard({ ob, onOpen, ownerLabel }: { ob: Obligation; onOpen?: () => void; ownerLabel?: string }) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const Icon = CATEGORY_ICONS[ob.category] || DollarSign;
  const dueDate = new Date(ob.nextDueDate);
  const now = new Date();
  const daysUntilDue = Math.ceil((dueDate.getTime() - now.getTime()) / 86400000);
  const isOverdue = daysUntilDue < 0;
  const isDueToday = daysUntilDue === 0;
  const isDueSoon = daysUntilDue >= 0 && daysUntilDue <= 7;
  const isRecurring = !!ob.frequency && ob.frequency !== "once";
  const [descExpanded, setDescExpanded] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editAmount, setEditAmount] = useState(String(ob.amount));
  const [editDueDate, setEditDueDate] = useState(ob.nextDueDate?.slice(0, 10) || "");
  const [editFrequency, setEditFrequency] = useState<string>(ob.frequency);
  const [editCategory, setEditCategory] = useState(ob.category);
  const [editKind, setEditKind] = useState<ObligationKind>((ob.kind as ObligationKind) || "bill");

  // Bug #18: useState seeds only on first render; if the underlying obligation
  // changes (background refetch, another tab edit, AI chat update) the dialog
  // would show stale values when re-opened. Re-seed whenever we transition
  // from closed → open OR when the source obligation id/updated fields change.
  useEffect(() => {
    if (!editOpen) return;
    setEditAmount(String(ob.amount));
    setEditDueDate(ob.nextDueDate?.slice(0, 10) || "");
    setEditFrequency(ob.frequency);
    setEditCategory(ob.category);
    setEditKind((ob.kind as ObligationKind) || "bill");
  }, [editOpen, ob.id, ob.amount, ob.nextDueDate, ob.frequency, ob.category, ob.kind]);

  const undoPayMutation = useMutation<unknown, Error, void, { prev: [readonly unknown[], unknown][] }>({
    // Bug fix: previously PATCHed { isPaid: false } against a route that has
    // no such field — server silently dropped it and the obligation stayed
    // "paid". Now we hit the dedicated DELETE /last-payment route which
    // removes the most recent obligation_payments row.
    mutationFn: () => apiRequest("DELETE", `/api/obligations/${ob.id}/last-payment`),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/obligations"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/obligations"] });
      queryClient.setQueriesData({ queryKey: ["/api/obligations"] }, (old: any) =>
        Array.isArray(old) ? old.map((o: any) => o?.id === ob.id ? { ...o, isPaid: false, lastPaidAt: null } : o) : old
      );
      return { prev };
    },
    onSuccess: () => { invalidateAll(); toast({ title: `"${ob.name}" payment undone` }); },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) { for (const [k, d] of ctx.prev) queryClient.setQueryData(k, d); }
      toast({ title: `Failed to undo payment`, description: formatApiError(err), variant: "destructive" });
    },
  });

  const payMutation = useMutation<unknown, Error, void, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: () => apiRequest("POST", `/api/obligations/${ob.id}/pay`, { amount: ob.amount }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/obligations"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/obligations"] });
      const nowIso = new Date().toISOString();
      queryClient.setQueriesData({ queryKey: ["/api/obligations"] }, (old: any) =>
        Array.isArray(old) ? old.map((o: any) => o?.id === ob.id ? { ...o, isPaid: true, lastPaidAt: nowIso } : o) : old
      );
      return { prev };
    },
    onSuccess: () => {
      invalidateAll();
      toast({
        title: `"${ob.name}" marked paid`,
        description: `$${ob.amount.toFixed(2)} payment recorded`,
        action: <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => undoPayMutation.mutate()}>Undo</Button>,
      });
    },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) { for (const [k, d] of ctx.prev) queryClient.setQueryData(k, d); }
      toast({ title: `Failed to pay "${ob.name}"`, description: formatApiError(err), variant: "destructive" });
    },
  });

  const deleteMutation = useMutation<unknown, Error, void, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: () => apiRequest("DELETE", `/api/obligations/${ob.id}`),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/obligations"] });
      await queryClient.cancelQueries({ queryKey: ["/api/obligation-occurrences"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/obligations"] });
      queryClient.setQueriesData({ queryKey: ["/api/obligations"] }, (old: any) =>
        Array.isArray(old) ? old.filter((o: any) => o?.id !== ob.id) : old
      );
      // Also drop any occurrences that belong to this obligation so the live
      // "Due today" panel doesn't keep showing rows for a deleted bill.
      queryClient.setQueriesData({ queryKey: ["/api/obligation-occurrences"] }, (old: any) =>
        Array.isArray(old) ? old.filter((o: any) => o?.obligation_id !== ob.id && o?.obligation?.id !== ob.id) : old
      );
      return { prev };
    },
    onSuccess: () => { invalidateAll(); toast({ title: `"${ob.name}" deleted` }); },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) { for (const [k, d] of ctx.prev) queryClient.setQueryData(k, d); }
      toast({ title: `Failed to delete "${ob.name}"`, description: formatApiError(err), variant: "destructive" });
    },
  });

  const editMutation = useMutation<unknown, Error, void, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: () => apiRequest("PATCH", `/api/obligations/${ob.id}`, {
      amount: parseFloat(editAmount),
      nextDueDate: editDueDate,
      frequency: editFrequency,
      category: editCategory,
      kind: editKind,
    }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/obligations"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/obligations"] });
      const amt = parseFloat(editAmount);
      const patch: any = {
        ...(isFinite(amt) ? { amount: amt } : {}),
        nextDueDate: editDueDate,
        frequency: editFrequency,
        category: editCategory,
        kind: editKind,
      };
      queryClient.setQueriesData({ queryKey: ["/api/obligations"] }, (old: any) =>
        Array.isArray(old) ? old.map((o: any) => o?.id === ob.id ? { ...o, ...patch } : o) : old
      );
      return { prev };
    },
    onSuccess: () => { invalidateAll(); toast({ title: `"${ob.name}" updated` }); },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) { for (const [k, d] of ctx.prev) queryClient.setQueryData(k, d); }
      toast({ title: `Failed to update "${ob.name}"`, description: formatApiError(err), variant: "destructive" });
    },
  });

  const kindMeta = OBLIGATION_KIND_META[(ob.kind as ObligationKind) || "bill"];
  const KindIcon = KIND_ICON[(ob.kind as ObligationKind) || "bill"] || Icon;

  return (
    <>
      <Card className={`relative overflow-hidden ${onOpen ? "cursor-pointer hover:bg-muted/30 transition-colors" : ""}`} data-testid={`card-obligation-${ob.id}`}
        onClick={(e) => {
          // Only open the detail drawer when the user clicks the card body, never an action control.
          if (!onOpen) return;
          const target = e.target as HTMLElement;
          if (target.closest('button') || target.closest('a') || target.closest('input') || target.closest('[role="menuitem"]') || target.closest('[contenteditable="true"]')) return;
          onOpen();
        }}>
        {/* Left status accent: red=overdue, amber=due soon, purple=recurring upcoming, neutral=normal */}
        <span
          aria-hidden
          className="absolute left-0 top-0 bottom-0 w-1"
          style={{ background: isOverdue ? "#ef4444" : (isDueToday || isDueSoon) ? "#f59e0b" : isRecurring ? "#7C76D9" : "hsl(var(--border))" }}
        />
        <CardContent className="p-3 pl-4">
          {/* ── Top row: icon + title + type/recurrence/status badges ── */}
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg shrink-0" style={{ background: `${kindMeta.color}1A`, color: kindMeta.color }}>
              <KindIcon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <h3 className="text-sm font-semibold min-w-0 mr-1">
                  <EditableTitle
                    value={ob.name}
                    onSave={async (newName) => {
                      try {
                        await apiRequest("PATCH", `/api/obligations/${ob.id}`, { name: newName });
                        invalidateAll();
                        toast({ title: `Renamed to "${newName}"` });
                      } catch (err: any) {
                        toast({ title: "Failed to rename", description: formatApiError(err), variant: "destructive" });
                      }
                    }}
                  />
                </h3>
                <Badge variant="outline" className="text-[10px] h-5" style={{ borderColor: kindMeta.color, color: kindMeta.color }}>
                  {kindMeta.label}
                </Badge>
                {isRecurring && (
                  <Badge variant="outline" className="text-[10px] h-5 capitalize" style={{ borderColor: "#7C76D955", color: "#8b86e0" }}>
                    <Repeat className="h-2.5 w-2.5 mr-0.5" />{ob.frequency}
                  </Badge>
                )}
                {isOverdue && <Badge variant="destructive" className="text-[10px] h-5">{Math.abs(daysUntilDue)}d overdue</Badge>}
                {isDueToday && <Badge className="text-[10px] h-5 bg-amber-500/20 text-amber-600 border-amber-500/30">Due today</Badge>}
                {isDueSoon && !isDueToday && <Badge className="text-[10px] h-5 bg-amber-500/15 text-amber-600 border-amber-500/30">Due in {daysUntilDue}d</Badge>}
                {!isOverdue && !isDueSoon && <Badge variant="outline" className="text-[10px] h-5 text-muted-foreground">Upcoming</Badge>}
              </div>

              {/* ── Main details: amount · due date · owner · autopay · source ── */}
              <div className="flex items-center gap-x-3 gap-y-0.5 mt-1.5 flex-wrap text-xs">
                {ob.amount > 0 && (
                  <span className="text-base font-semibold tabular-nums leading-none">${ob.amount.toLocaleString()}</span>
                )}
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <Calendar className="h-3 w-3" />
                  Due {dueDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </span>
                {ownerLabel && (
                  <span className="inline-flex items-center gap-1 text-muted-foreground" title="Belongs to">
                    <User className="h-3 w-3" />{ownerLabel}
                  </span>
                )}
                {ob.autopay && (
                  <span className="inline-flex items-center gap-1 text-green-600">
                    <CheckCircle className="h-3 w-3" />Autopay
                  </span>
                )}
                {obligationSource(ob) && (
                  <span className="micro-label text-muted-foreground/70">{obligationSource(ob)}</span>
                )}
              </div>

              {/* ── Description (always visible, with View more for long text) ── */}
              {(() => {
                const desc = obligationDescription(ob);
                if (!desc) return null;
                const long = desc.length > 140;
                return (
                  <div className="mt-1.5">
                    <p className={`text-xs text-muted-foreground ${long && !descExpanded ? "line-clamp-2" : ""}`}>{desc}</p>
                    {long && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setDescExpanded(v => !v); }}
                        className="text-[11px] text-primary mt-0.5 hover:underline"
                        data-testid={`button-desc-toggle-${ob.id}`}
                      >
                        {descExpanded ? "View less" : "View more"}
                      </button>
                    )}
                  </div>
                );
              })()}

              {/* ── Footer actions (no payment actions here — those live in the detail/finance views) ── */}
              <div className="flex items-center gap-1 mt-2 flex-wrap">
                <Button size="sm" variant="ghost"
                  onClick={() => { setEditAmount(String(ob.amount)); setEditDueDate(ob.nextDueDate?.slice(0, 10) || ""); setEditFrequency(ob.frequency); setEditCategory(ob.category); setEditKind((ob.kind as ObligationKind) || "bill"); setEditOpen(true); }}
                  className="h-7 px-2 text-xs gap-1" title="Edit" data-testid={`button-edit-${ob.id}`}>
                  <Pencil className="h-3 w-3" /> Edit
                </Button>
                {(() => {
                  const linked = linkedSourceRoute(ob);
                  if (!linked) return null;
                  return (
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1"
                      onClick={() => navigate(linked.route)} data-testid={`button-view-linked-${ob.id}`}>
                      <Link2 className="h-3 w-3" /> {linked.label}
                    </Button>
                  );
                })()}
                {onOpen && (
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1"
                    onClick={onOpen} data-testid={`button-details-${ob.id}`}>
                    <ExternalLink className="h-3 w-3" /> Details
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setShowDeleteConfirm(true)}
                  className="h-7 px-2 text-xs gap-1 text-destructive ml-auto" title="Delete" data-testid={`button-delete-${ob.id}`}>
                  <Trash2 className="h-3 w-3" /> Delete
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{ob.name}"?</AlertDialogTitle>
            <AlertDialogDescription>This recurring obligation and its payment history will be permanently deleted. Future occurrences will stop generating.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { deleteMutation.mutate(); setShowDeleteConfirm(false); }}
              disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Edit "{ob.name}"</DialogTitle>
            <DialogDescription className="text-xs">Update obligation details</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs">Type</Label>
              <Select value={editKind} onValueChange={v => setEditKind(v as ObligationKind)}>
                <SelectTrigger data-testid="select-edit-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(OBLIGATION_KIND_META) as ObligationKind[]).map(k => (
                    <SelectItem key={k} value={k}>{OBLIGATION_KIND_META[k].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Amount ($)</Label>
                <Input type="number" inputMode="decimal" min="0" step="0.01" value={editAmount} onChange={e => setEditAmount(e.target.value)} data-testid="input-edit-amount" />
              </div>
              <div>
                <Label className="text-xs">Frequency</Label>
                <Select value={editFrequency} onValueChange={setEditFrequency}>
                  <SelectTrigger data-testid="select-edit-frequency"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="biweekly">Biweekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="yearly">Yearly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Category</Label>
                <Select value={editCategory} onValueChange={setEditCategory}>
                  <SelectTrigger data-testid="select-edit-category"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="health">Health</SelectItem>
                    <SelectItem value="housing">Housing</SelectItem>
                    <SelectItem value="insurance">Insurance</SelectItem>
                    <SelectItem value="loan">Loan</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                    <SelectItem value="subscription">Subscription</SelectItem>
                    <SelectItem value="utilities">Utilities</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Next Due Date</Label>
                <Input type="date" value={editDueDate} onChange={e => setEditDueDate(e.target.value)} data-testid="input-edit-due-date" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button size="sm" disabled={!editAmount || parseFloat(editAmount) <= 0 || editMutation.isPending}
              onClick={() => {
                // Close immediately for snappy UX — optimistic patch in onMutate.
                editMutation.mutate();
                setEditOpen(false);
              }} data-testid="button-save-edit-obligation">
              {editMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// Live panel: Overdue / Due today / Next 14 days.
function ObligationOccurrencePanel() {
  const today = new Date().toLocaleDateString("en-CA");
  const end = new Date(Date.now() + 14 * 86400000).toLocaleDateString("en-CA");
  const start = new Date(Date.now() - 60 * 86400000).toLocaleDateString("en-CA");
  // Subscribe to global profile filter so this panel updates when the user
  // changes profiles from the header chip (was showing other profiles' bills).
  const [filterMode, setFilterMode] = useState(() => getProfileFilter().mode);
  const [filterIds, setFilterIds] = useState<string[]>(() => getProfileFilter().selectedIds);
  useEffect(() => {
    const unsub = subscribeProfileFilter(state => {
      setFilterMode(state.mode);
      setFilterIds([...state.selectedIds]);
    });
    return unsub;
  }, []);
  const profileParam = filterMode === "selected" && filterIds.length > 0 ? `&profileIds=${filterIds.join(",")}` : "";
  const { data: rawOccurrences = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/obligation-occurrences", start, end, filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/obligation-occurrences?start=${start}&end=${end}${profileParam}`).then(r => r.json()),
    staleTime: 60_000,
  });
  // Profiles list — needed by the canonical passesProfileFilter (to apply the
  // orphan rule) in the defense-in-depth occurrence filters below and the
  // obligations list filter further down.
  const { data: profilesList = [] } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
    staleTime: 5 * 60_000,
  });
  // Defense-in-depth client filter — if the server is on an older deploy
  // that ignores profileIds, still hide other profiles' occurrences.
  const occurrences = useMemo(() => {
    if (filterMode !== "selected" || filterIds.length === 0) return rawOccurrences;
    return rawOccurrences.filter((occ: any) => {
      const lp: string[] = occ?.obligation?.linked_profiles || occ?.obligation?.linkedProfiles || [];
      return passesProfileFilter(lp, { selectedIds: filterIds, allProfiles: profilesList });
    });
  }, [rawOccurrences, filterMode, filterIds, profilesList]);

  const { overdue, todayOcc, upcoming } = useMemo(() => {
    const overdue: any[] = [], todayOcc: any[] = [], upcoming: any[] = [];
    for (const o of occurrences) {
      if (o.status === "done" || o.status === "skipped") continue;
      if (o.due_at < today) overdue.push(o);
      else if (o.due_at === today) todayOcc.push(o);
      else upcoming.push(o);
    }
    return { overdue, todayOcc, upcoming };
  }, [occurrences, today]);

  if (isLoading) {
    return <div className="h-24 rounded skeleton-shimmer" />;
  }
  if (overdue.length === 0 && todayOcc.length === 0 && upcoming.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {overdue.length > 0 && (
        <Card className="border-red-500/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" /> Overdue
              <Badge variant="destructive" className="ml-auto">{overdue.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            {overdue.map(o => <OccurrenceRow key={o.id} occ={o} />)}
          </CardContent>
        </Card>
      )}
      {todayOcc.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <CalendarClock className="h-4 w-4" /> Due today
              <Badge className="ml-auto">{todayOcc.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            {todayOcc.map(o => <OccurrenceRow key={o.id} occ={o} />)}
          </CardContent>
        </Card>
      )}
      {upcoming.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Clock className="h-4 w-4" /> Next 14 days
              <Badge variant="secondary" className="ml-auto">{upcoming.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            {upcoming.slice(0, 8).map(o => <OccurrenceRow key={o.id} occ={o} />)}
            {upcoming.length > 8 && (
              <p className="text-xs text-muted-foreground text-center pt-1">+{upcoming.length - 8} more in the next 14 days</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Detail Drawer ───────────────────────────────────────────────────────────
// Click any obligation card -> open this. Centerpiece of the Calendar Manager
// pattern: shows everything about the time-based commitment + all the actions
// the user might take on it, with deep-links back to the source object
// (asset/document/profile) that created it.
// Wrapper that mounts the actual drawer body only when `ob` is non-null. This
// keeps a stable hook order regardless of whether the drawer is open: the
// wrapper has zero hooks, and `ObligationDrawerInner` only mounts/unmounts
// (never re-renders with a different hook count). Previously this was a single
// component with an `if (!ob) return null` AFTER several `useState` calls and
// BEFORE four `useMutation` calls -- which caused React error #310 (rendered
// more hooks than the previous render) the moment a user clicked an obligation
// row to open the drawer (e.g. on `/calendar?tab=obligations`).
function ObligationDrawer({ ob, onClose }: { ob: Obligation | null; onClose: () => void }) {
  if (!ob) return null;
  // `key={ob.id}` forces a fresh mount per obligation so internal state
  // (rescheduleDate, etc.) is seeded from the right obligation each time.
  return <ObligationDrawerInner key={ob.id} ob={ob} onClose={onClose} />;
}

function ObligationDrawerInner({ ob, onClose }: { ob: Obligation; onClose: () => void }) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [rescheduleDate, setRescheduleDate] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const kind = (ob.kind as ObligationKind) || "bill";
  const meta = OBLIGATION_KIND_META[kind];
  const Icon = KIND_ICON[kind] || Receipt;
  const dueDate = new Date(ob.nextDueDate);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const daysOff = Math.round((dueDate.getTime() - today.getTime()) / 86400000);
  const isOverdue = daysOff < 0;
  const isPaused = ob.status === "paused";
  const linked = linkedSourceRoute(ob);
  const nextThree = nextOccurrencesFrom(ob.nextDueDate, ob.frequency, 3);
  const seriesSummary = occurrenceSeries(ob.nextDueDate, (ob as any).recurrenceEnd || null, ob.frequency);

  // Per-obligation calendar: pull this obligation's materialized occurrences so
  // the drawer can show a focused timeline. Falls back to nextThree (above)
  // when the materialized table is empty (one-time bills, fresh obligations).
  const { data: occurrencesData } = useQuery<any>({
    queryKey: ["/api/obligation-occurrences", ob.id],
  });
  const myOccurrences = useMemo(() => {
    const list = Array.isArray(occurrencesData)
      ? occurrencesData
      : Array.isArray((occurrencesData as any)?.occurrences)
        ? (occurrencesData as any).occurrences
        : [];
    const todayIso = new Date().toISOString().slice(0, 10);
    return list
      .filter((o: any) => (o?.obligation_id || o?.obligationId || o?.obligation?.id) === ob.id)
      .filter((o: any) => {
        const d = String(o?.due_at || o?.dueAt || "").slice(0, 10);
        return d >= todayIso; // future-and-today only for the mini calendar
      })
      .sort((a: any, b: any) => String(a?.due_at || a?.dueAt || "").localeCompare(String(b?.due_at || b?.dueAt || "")))
      .slice(0, 12);
  }, [occurrencesData, ob.id]);

  const payMut = useMutation<unknown, Error, void, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: () => apiRequest("POST", `/api/obligations/${ob.id}/pay`, { amount: ob.amount }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/obligations"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/obligations"] });
      queryClient.setQueriesData({ queryKey: ["/api/obligations"] }, (old: any) =>
        Array.isArray(old) ? old.map((o: any) => o?.id === ob.id ? { ...o, isPaid: true, lastPaidAt: new Date().toISOString() } : o) : old
      );
      return { prev };
    },
    onSuccess: () => {
      invalidateAll();
      const logged = ob.autoLogExpense || kind === "subscription" || kind === "bill" || kind === "loan_payment";
      toast({
        title: `"${ob.name}" marked paid`,
        description: logged ? `$${ob.amount.toFixed(2)} logged to Finance · next due advanced` : `Next due advanced`,
        action: logged ? <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => navigate("/dashboard/finance")}>View</Button> : undefined,
      });
    },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) { for (const [k, d] of ctx.prev) queryClient.setQueryData(k, d); }
      toast({ title: "Failed to mark paid", description: formatApiError(err), variant: "destructive" });
    },
  });

  const pauseMut = useMutation<unknown, Error, void, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: () => apiRequest("PATCH", `/api/obligations/${ob.id}`, { status: isPaused ? "active" : "paused" }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/obligations"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/obligations"] });
      const nextStatus = isPaused ? "active" : "paused";
      queryClient.setQueriesData({ queryKey: ["/api/obligations"] }, (old: any) =>
        Array.isArray(old) ? old.map((o: any) => o?.id === ob.id ? { ...o, status: nextStatus } : o) : old
      );
      return { prev };
    },
    onSuccess: () => { invalidateAll(); toast({ title: isPaused ? `"${ob.name}" resumed` : `"${ob.name}" paused` }); },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) { for (const [k, d] of ctx.prev) queryClient.setQueryData(k, d); }
      toast({ title: "Update failed", description: formatApiError(err), variant: "destructive" });
    },
  });

  const rescheduleMut = useMutation<unknown, Error, string, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: (newDate: string) => apiRequest("PATCH", `/api/obligations/${ob.id}`, { nextDueDate: newDate }),
    onMutate: async (newDate) => {
      await queryClient.cancelQueries({ queryKey: ["/api/obligations"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/obligations"] });
      queryClient.setQueriesData({ queryKey: ["/api/obligations"] }, (old: any) =>
        Array.isArray(old) ? old.map((o: any) => o?.id === ob.id ? { ...o, nextDueDate: newDate } : o) : old
      );
      return { prev };
    },
    onSuccess: () => { invalidateAll(); setRescheduleDate(""); toast({ title: "Rescheduled" }); },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) { for (const [k, d] of ctx.prev) queryClient.setQueryData(k, d); }
      toast({ title: "Reschedule failed", description: formatApiError(err), variant: "destructive" });
    },
  });

  const deleteMut = useMutation<unknown, Error, void, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: () => apiRequest("DELETE", `/api/obligations/${ob.id}`),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/obligations"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/obligations"] });
      queryClient.setQueriesData({ queryKey: ["/api/obligations"] }, (old: any) =>
        Array.isArray(old) ? old.filter((o: any) => o?.id !== ob.id) : old
      );
      return { prev };
    },
    onSuccess: () => { invalidateAll(); toast({ title: `"${ob.name}" deleted` }); },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) { for (const [k, d] of ctx.prev) queryClient.setQueryData(k, d); }
      toast({ title: "Delete failed", description: formatApiError(err), variant: "destructive" });
    },
  });

  return (
    <Dialog open={!!ob} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto" data-testid="obligation-drawer">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="inline-flex items-center justify-center rounded-lg shrink-0" style={{ width: 32, height: 32, background: `${meta.color}22`, color: meta.color }}>
              <Icon className="h-4 w-4" />
            </span>
            <span className="flex-1 min-w-0 truncate">{ob.name}</span>
            {isPaused && <Badge variant="outline" className="text-[10px]">Paused</Badge>}
          </DialogTitle>
          <DialogDescription className="text-xs">{meta.label} · {ob.frequency}</DialogDescription>
        </DialogHeader>

        {/* Core facts grid */}
        <div className="grid grid-cols-2 gap-3 py-2 text-xs">
          <div>
            <p className="micro-label text-muted-foreground mb-0.5">Amount</p>
            <p className="text-base font-semibold tabular-nums">${ob.amount.toLocaleString()}</p>
          </div>
          <div>
            <p className="micro-label text-muted-foreground mb-0.5">Next due</p>
            <p className={`text-base font-semibold tabular-nums ${isOverdue ? "text-red-500" : ""}`}>
              {dueDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              {isOverdue && <span className="ml-1 text-[10px] text-red-500">({Math.abs(daysOff)}d overdue)</span>}
            </p>
          </div>
          <div>
            <p className="micro-label text-muted-foreground mb-0.5">Repeats</p>
            <p className="text-sm font-medium capitalize">{ob.frequency}</p>
          </div>
          <div>
            <p className="micro-label text-muted-foreground mb-0.5">Category</p>
            <p className="text-sm font-medium capitalize">{ob.category}</p>
          </div>
          {ob.autopay && (
            <div className="col-span-2 flex items-center gap-1.5 text-xs text-green-600">
              <CheckCircle className="h-3 w-3" /> Autopay enabled
            </div>
          )}
          {ob.autoLogExpense && (
            <div className="col-span-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <DollarSign className="h-3 w-3" /> Marking paid auto-logs an expense to Finance
            </div>
          )}
        </div>

        {/* Schedule summary + this obligation's upcoming calendar */}
        {ob.frequency !== "once" && (
          <div className="border-t border-border/40 pt-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="micro-label text-muted-foreground">This obligation's calendar</p>
              {seriesSummary && (
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {seriesSummary.count} occurrence{seriesSummary.count === 1 ? "" : "s"}
                  {(ob as any).recurrenceEnd ? "" : " · ongoing (2y)"}
                </span>
              )}
            </div>
            {seriesSummary && (
              <p className="text-[11px] tabular-nums text-muted-foreground">
                {seriesSummary.first} → {seriesSummary.last}
              </p>
            )}
            {myOccurrences.length > 0 ? (
              <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                {myOccurrences.map((o: any) => {
                  const iso = String(o?.due_at || o?.dueAt || "").slice(0, 10);
                  const d = iso ? new Date(iso + "T00:00:00") : null;
                  const status = String(o?.status || "pending");
                  const isDone = status === "done" || status === "completed";
                  const isSkipped = status === "skipped";
                  return (
                    <div key={String(o?.id ?? iso)} className="flex items-center justify-between gap-2 text-xs px-2 py-1 rounded border border-border/40 bg-muted/30" data-testid={`drawer-occurrence-${o?.id ?? iso}`}>
                      <div className="flex items-center gap-2 min-w-0">
                        <CalIcon className="h-3 w-3 shrink-0 opacity-60" />
                        <span className="tabular-nums truncate">
                          {d ? d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : iso}
                        </span>
                      </div>
                      <span className={`micro-label ${isDone ? "text-green-600" : isSkipped ? "text-muted-foreground line-through" : ob.amount > 0 ? "tabular-nums" : "text-muted-foreground"}`}>
                        {isDone ? "Paid" : isSkipped ? "Skipped" : ob.amount > 0 ? `$${Number(ob.amount).toFixed(2)}` : "Pending"}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : nextThree.length > 0 ? (
              <div className="flex gap-1.5 flex-wrap">
                {nextThree.map((d, i) => (
                  <Badge key={i} variant="outline" className="text-[10px] h-5">
                    <CalIcon className="h-2.5 w-2.5 mr-1" /> {d}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground italic">No upcoming occurrences.</p>
            )}
          </div>
        )}

        {/* Linked source */}
        {linked && (
          <div className="border-t border-border/40 pt-3">
            <p className="micro-label text-muted-foreground mb-1.5">Linked to</p>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => { navigate(linked.route); onClose(); }} data-testid="drawer-view-linked">
              <Link2 className="h-3 w-3 mr-1" /> {linked.label} <ChevronRight className="h-3 w-3 ml-1 opacity-50" />
            </Button>
          </div>
        )}

        {/* Payment history */}
        {ob.payments && ob.payments.length > 0 && (
          <div className="border-t border-border/40 pt-3">
            <p className="micro-label text-muted-foreground mb-1.5">Recent payments</p>
            <div className="space-y-1">
              {ob.payments.slice(-5).reverse().map(p => (
                <div key={p.id} className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">
                    {new Date(p.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    {p.method && <span className="ml-1.5 opacity-60">({p.method})</span>}
                  </span>
                  <span className="font-medium tabular-nums">${p.amount.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Reschedule next occurrence */}
        <div className="border-t border-border/40 pt-3">
          <p className="micro-label text-muted-foreground mb-1.5">Reschedule next occurrence</p>
          <div className="flex gap-2">
            <Input type="date" value={rescheduleDate || ob.nextDueDate?.slice(0, 10) || ""}
              onChange={e => setRescheduleDate(e.target.value)}
              className="h-8 text-xs flex-1" data-testid="drawer-reschedule-date" />
            <Button size="sm" variant="outline" className="h-8 text-xs"
              disabled={!rescheduleDate || rescheduleDate === ob.nextDueDate?.slice(0, 10) || rescheduleMut.isPending}
              onClick={() => rescheduleDate && rescheduleMut.mutate(rescheduleDate)}
              data-testid="drawer-reschedule-save">
              <Clock className="h-3 w-3 mr-1" /> Save
            </Button>
          </div>
        </div>

        {/* Action grid */}
        <DialogFooter className="flex-col sm:flex-col gap-2 mt-2 pt-3 border-t border-border/40">
          <div className="grid grid-cols-2 gap-2 w-full">
            <Button size="sm" onClick={() => {
              // Close drawer immediately for snappy UX — optimistic update in onMutate.
              payMut.mutate();
              onClose();
            }} disabled={payMut.isPending || isPaused}
              data-testid="drawer-mark-paid" className="h-9">
              <CheckCircle className="h-3.5 w-3.5 mr-1.5" /> Mark paid
            </Button>
            <Button size="sm" variant="outline" onClick={() => pauseMut.mutate()} disabled={pauseMut.isPending}
              data-testid="drawer-pause-resume" className="h-9">
              {isPaused ? <><Play className="h-3.5 w-3.5 mr-1.5" /> Resume</> : <><Pause className="h-3.5 w-3.5 mr-1.5" /> Pause</>}
            </Button>
          </div>
          <div className="flex items-center justify-between w-full">
            <Button size="sm" variant="ghost" onClick={() => setShowDeleteConfirm(true)}
              disabled={deleteMut.isPending} className="h-7 text-xs text-destructive hover:text-destructive"
              data-testid="drawer-delete">
              <Trash2 className="h-3 w-3 mr-1" /> Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose} className="h-7 text-xs">Close</Button>
          </div>
        </DialogFooter>

        <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete "{ob.name}"?</AlertDialogTitle>
              <AlertDialogDescription>The recurring obligation and its payment history will be deleted. Future occurrences will stop generating.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => {
                  // Close drawer + confirm immediately — optimistic removal in onMutate.
                  deleteMut.mutate();
                  setShowDeleteConfirm(false);
                  onClose();
                }}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

export interface ObligationsManagerProps {
  /** Render the section header (title + New button). Set false when the host page provides its own. */
  showHeader?: boolean;
  /** Compact mode for tab embeds — drops summary cards. */
  compact?: boolean;
  /** Optional external profile filter override. When set, takes precedence
   *  over the internal subscription to the global filter store. Used by the
   *  standalone /obligations page which owns the filter UI and wants to be
   *  the single source of truth (was a no-op before, hence the bug report). */
  externalFilterMode?: "everyone" | "selected";
  externalFilterIds?: string[];
}

export default function ObligationsManager({ showHeader = true, compact = false, externalFilterMode, externalFilterIds }: ObligationsManagerProps) {
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [newFrequency, setNewFrequency] = useState("monthly");
  const [newCategory, setNewCategory] = useState("housing");
  const [newKind, setNewKind] = useState<ObligationKind>("bill");
  const [newDueDate, setNewDueDate] = useState("");
  const [newRecurrenceEnd, setNewRecurrenceEnd] = useState("");
  // BUG-OBL-004: New Obligation modal advanced fields.
  const [newLinkedProfiles, setNewLinkedProfiles] = useState<string[]>([]);
  const [newRemindDays, setNewRemindDays] = useState<string>("");
  const [newAutopay, setNewAutopay] = useState(false);
  const [newAutoLogExpense, setNewAutoLogExpense] = useState<"auto" | "on" | "off">("auto");
  const [newNotes, setNewNotes] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { data: profilesList = [] } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
    staleTime: 5 * 60_000,
  });
  const [internalFilterMode, setInternalFilterMode] = useState(() => getProfileFilter().mode);
  const [internalFilterIds, setInternalFilterIds] = useState<string[]>(() => getProfileFilter().selectedIds);
  // External props (from parent page) take precedence — lets a host like
  // /obligations own the filter UI without relying on the global event
  // bus, which is what made the filter feel like "nothing happens".
  const filterMode = externalFilterMode ?? internalFilterMode;
  const filterIds = externalFilterIds ?? internalFilterIds;
  const [kindFilter, setKindFilter] = useState<"all" | ObligationKind>("all");
  // Time window: overdue / today / week / month / all
  const [windowFilter, setWindowFilter] = useState<"all" | "overdue" | "today" | "week" | "month">("all");
  // Linked-items grouped view toggle
  const [groupBySource, setGroupBySource] = useState(false);
  // Currently open drawer
  const [drawerOb, setDrawerOb] = useState<Obligation | null>(null);
  // Time-status section collapse state + duplicate banner dismissal.
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const [dupBannerDismissed, setDupBannerDismissed] = useState(false);

  useEffect(() => {
    // Only subscribe to the global filter store when the host did not supply
    // explicit external filter props — otherwise we’d fight the parent.
    if (externalFilterMode !== undefined || externalFilterIds !== undefined) return;
    const unsub = subscribeProfileFilter(state => {
      setInternalFilterMode(state.mode);
      setInternalFilterIds([...state.selectedIds]);
    });
    // Window-focus fallback for cases where the filter changed in another tab.
    const handleFocus = () => {
      const { mode, selectedIds } = getProfileFilter();
      setInternalFilterMode(mode);
      setInternalFilterIds(selectedIds);
    };
    window.addEventListener("focus", handleFocus);
    return () => { unsub(); window.removeEventListener("focus", handleFocus); };
  }, [externalFilterMode, externalFilterIds]);
  const profileParam = filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";

  const { data: allObligations = [], isLoading, error, refetch } = useQuery<Obligation[]>({
    queryKey: ["/api/obligations", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/obligations${profileParam}`).then(r => r.json()),
  });

  // BUG-20260528-profile-filter-leakage: previously a hand-rolled linkedProfiles
  // intersection that dropped orphan obligations (no linked profiles) even when a
  // self-profile was selected and the server correctly returned them.
  // Now uses canonical passesProfileFilter so client and server agree.
  const obligations = useMemo(() => filterMode === "selected" && filterIds.length > 0
    ? allObligations.filter(o => passesProfileFilter(o.linkedProfiles, {
        selectedIds: filterIds,
        allProfiles: profilesList,
      }))
    : allObligations, [allObligations, filterMode, filterIds, profilesList]);

  // BUG-OBL-001/002/PRF-003: Filter tab counts MUST agree with the live
  // "Overdue / Due today / Upcoming" panel above. Both must source from
  // occurrences (per-instance) — using obligation.nextDueDate diverges when
  // a monthly bill has an overdue back-occurrence but its nextDueDate has
  // already advanced to the future.
  // BUG-20260528-calendar-window-stale: previously useMemo([], []) meant the
  // occurrence window was computed once on mount and never updated. If the
  // user left the app open overnight, "today" drifted out of range and
  // overdue/upcoming counts went wrong. Now tied to a daily tick.
  const [todayKey, setTodayKey] = useState(() => new Date().toLocaleDateString("en-CA"));
  useEffect(() => {
    const id = setInterval(() => {
      const next = new Date().toLocaleDateString("en-CA");
      if (next !== todayKey) setTodayKey(next);
    }, 60_000);
    return () => clearInterval(id);
  }, [todayKey]);
  const occStartIso = useMemo(() => new Date(Date.now() - 60 * 86400000).toLocaleDateString("en-CA"), [todayKey]);
  const occEndIso = useMemo(() => new Date(Date.now() + 30 * 86400000).toLocaleDateString("en-CA"), [todayKey]);
  const occProfileParam = filterMode === "selected" && filterIds.length > 0 ? `&profileIds=${filterIds.join(",")}` : "";
  const { data: rawWindowOccurrences = [] } = useQuery<any[]>({
    queryKey: ["/api/obligation-occurrences", "window", occStartIso, occEndIso, filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/obligation-occurrences?start=${occStartIso}&end=${occEndIso}${occProfileParam}`).then(r => r.json()),
    staleTime: 60_000,
  });
  const windowOccurrences = useMemo(() => {
    // Defense-in-depth client filter — match the panel's behavior so counts
    // stay aligned even if the server ignores profileIds on an older deploy.
    if (filterMode !== "selected" || filterIds.length === 0) return rawWindowOccurrences;
    return rawWindowOccurrences.filter((occ: any) => {
      const lp: string[] = occ?.obligation?.linked_profiles || occ?.obligation?.linkedProfiles || [];
      return passesProfileFilter(lp, { selectedIds: filterIds, allProfiles: profilesList });
    });
  }, [rawWindowOccurrences, filterMode, filterIds, profilesList]);

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/obligations", data),
    onSuccess: () => {
      invalidateAll();
      const savedName = newName;
      toast({ title: `"${savedName}" created`, description: `${OBLIGATION_KIND_META[newKind].label} · ${newFrequency} · $${newAmount}` });
      setAddOpen(false);
      setNewName(""); setNewAmount(""); setNewFrequency("monthly"); setNewCategory("housing"); setNewKind("bill"); setNewDueDate(""); setNewRecurrenceEnd("");
      setNewLinkedProfiles([]); setNewRemindDays(""); setNewAutopay(false); setNewAutoLogExpense("auto"); setNewNotes(""); setShowAdvanced(false);
    },
    onError: (err: Error) => toast({ title: "Failed to create", description: formatApiError(err), variant: "destructive" }),
  });

  // Apply kind filter, then time-window filter (overdue/today/week/month/all)
  const todayMs = useMemo(() => { const t = new Date(); t.setHours(0, 0, 0, 0); return t.getTime(); }, []);
  const filteredByKind = useMemo(() => kindFilter === "all" ? obligations : obligations.filter(o => (o.kind || "bill") === kindFilter), [obligations, kindFilter]);
  // ONE window predicate, shared by the list AND the chip counts.
  //
  // BUG (QA 2026-07-25): "The calendar header said Today: 0, This week: 0,
  // Total: 72 — but July 25 visibly contained eight items." The counts were
  // computed purely from the server occurrence feed while the LIST also fell
  // back to each obligation's own nextDueDate. Whenever the feed was empty or
  // still in flight, the list rendered rows the counters said didn't exist.
  // Counting anything the list doesn't show — or vice versa — is the bug, so
  // both now run `matchesWindow` over the same `filteredByKind` array.
  const windowMatchIds = useMemo(() => {
    const todayStr = new Date().toLocaleDateString("en-CA");
    const weekEnd = new Date(Date.now() + 7 * 86400000).toLocaleDateString("en-CA");
    const monthEnd = new Date(Date.now() + 30 * 86400000).toLocaleDateString("en-CA");
    const ids = { overdue: new Set<string>(), today: new Set<string>(), week: new Set<string>(), month: new Set<string>() };
    for (const occ of windowOccurrences) {
      if (occ.status === "done" || occ.status === "skipped") continue;
      const obId = occ.obligation?.id || occ.obligation_id;
      if (!obId) continue;
      const d: string = occ.due_at;
      if (d < todayStr) ids.overdue.add(obId);
      if (d === todayStr) ids.today.add(obId);
      if (d >= todayStr && d <= weekEnd) ids.week.add(obId);
      if (d >= todayStr && d <= monthEnd) ids.month.add(obId);
    }
    return ids;
  }, [windowOccurrences]);

  // True when obligation `o` belongs in time window `w`. Matches on a
  // materialized server occurrence OR on the obligation's own nextDueDate
  // (which covers brand-new obligations the server hasn't expanded yet).
  const matchesWindow = useCallback((o: Obligation, w: "overdue" | "today" | "week" | "month"): boolean => {
    if (windowMatchIds[w].has(o.id)) return true;
    const due = new Date(o.nextDueDate); due.setHours(0, 0, 0, 0);
    const days = Math.round((due.getTime() - todayMs) / 86400000);
    if (w === "overdue") return days < 0;
    if (w === "today") return days === 0;
    if (w === "week") return days >= 0 && days <= 7;
    return days >= 0 && days <= 30;
  }, [windowMatchIds, todayMs]);

  const filteredByWindow = useMemo(() => {
    if (windowFilter === "all") return filteredByKind;
    return filteredByKind.filter(o => matchesWindow(o, windowFilter as any));
  }, [filteredByKind, windowFilter, matchesWindow]);
  // Sort by next-due ascending so the most urgent shows first.
  const sorted = useMemo(() => [...filteredByWindow].sort((a, b) => {
    const da = new Date(a.nextDueDate).getTime();
    const db = new Date(b.nextDueDate).getTime();
    return da - db;
  }), [filteredByWindow]);

  // Group sorted obligations by their source kind for the Linked-Items view.
  const grouped = useMemo(() => {
    if (!groupBySource) return null;
    const map = new Map<string, { meta: ReturnType<typeof sourceGroup>; items: Obligation[] }>();
    for (const o of sorted) {
      const g = sourceGroup(o);
      if (!map.has(g.key)) map.set(g.key, { meta: g, items: [] });
      map.get(g.key)!.items.push(o);
    }
    return Array.from(map.values()).sort((a, b) => a.meta.label.localeCompare(b.meta.label));
  }, [sorted, groupBySource]);

  // BUG-OBL-001/002/PRF-003: Source chip counts from occurrences (same data
  // as the top "Overdue / Due today" panel), filtered by the active kind so
  // "Bills" only counts Bills, etc. "All" still reflects the obligation
  // count (one row per obligation, not per occurrence).
  // Counts = the predicate applied to the same rows the list renders, so a
  // chip can never claim 0 while eight rows sit underneath it.
  const windowCounts = useMemo(() => ({
    overdue: filteredByKind.filter(o => matchesWindow(o, "overdue")).length,
    today: filteredByKind.filter(o => matchesWindow(o, "today")).length,
    week: filteredByKind.filter(o => matchesWindow(o, "week")).length,
    month: filteredByKind.filter(o => matchesWindow(o, "month")).length,
    all: filteredByKind.length,
  }), [filteredByKind, matchesWindow]);

  const monthlyTotal = useMemo(() => obligations.reduce((s, o) => {
    switch (o.frequency) {
      case "weekly": return s + o.amount * 4.33;
      case "biweekly": return s + o.amount * 2.17;
      case "monthly": return s + o.amount;
      case "quarterly": return s + o.amount / 3;
      case "yearly": return s + o.amount / 12;
      default: return s;
    }
  }, 0), [obligations]);

  const now = new Date();
  const upcomingCount = useMemo(() => obligations.filter(o => {
    const d = new Date(o.nextDueDate);
    return d >= now && d <= new Date(now.getTime() + 7 * 86400000);
  }).length, [obligations]);

  // Per-kind counts for the chip row
  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = { all: obligations.length };
    for (const o of obligations) {
      const k = o.kind || "bill";
      counts[k] = (counts[k] || 0) + 1;
    }
    return counts;
  }, [obligations]);

  // Owner labelling: when viewing "Everyone" (or several selected profiles),
  // each card shows who/what it belongs to. A single selected profile needs no
  // label. Maps a linked-profile id to its display name.
  const profileNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of profilesList) m.set(p.id, p.name);
    return m;
  }, [profilesList]);
  const showOwner = !(filterMode === "selected" && filterIds.length === 1);
  const ownerLabelFor = (ob: Obligation): string | undefined => {
    if (!showOwner) return undefined;
    const ids = ob.linkedProfiles || [];
    if (ids.length === 0) return undefined;
    const names = ids.map(id => profileNameById.get(id)).filter(Boolean) as string[];
    if (names.length === 0) return undefined;
    return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0];
  };

  // Duplicate detection: same normalized name + amount + frequency + due date.
  // Surface a banner so the user can remove the extras (we keep the oldest).
  const duplicateGroups = useMemo(() => {
    const map = new Map<string, Obligation[]>();
    for (const o of obligations) {
      const key = `${(o.name || "").trim().toLowerCase()}|${o.amount}|${o.frequency}|${(o.nextDueDate || "").slice(0, 10)}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(o);
    }
    return Array.from(map.values())
      .filter(g => g.length > 1)
      .map(g => [...g].sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || ""))));
  }, [obligations]);

  // Remove the redundant copies in a duplicate group, keeping the first (oldest).
  const removeDuplicates = async (group: Obligation[]) => {
    const extras = group.slice(1);
    try {
      await Promise.all(extras.map(o => apiRequest("DELETE", `/api/obligations/${o.id}`)));
      invalidateAll();
      toast({ title: `Removed ${extras.length} duplicate${extras.length > 1 ? "s" : ""} of "${group[0].name}"` });
    } catch (err: any) {
      toast({ title: "Failed to remove duplicates", description: formatApiError(err), variant: "destructive" });
    }
  };

  // Time-status sections (collapsible). A single obligation appears in exactly
  // one bucket based on its next due date, so nothing is shown twice.
  const timeSections = useMemo(() => {
    const todayStart = todayMs;
    const buckets: { key: string; label: string; color: string; items: Obligation[] }[] = [
      { key: "overdue", label: "Overdue", color: "#ef4444", items: [] },
      { key: "today", label: "Due today", color: "#f59e0b", items: [] },
      { key: "week", label: "Due this week", color: "#f59e0b", items: [] },
      { key: "upcoming", label: "Upcoming", color: "#5591C7", items: [] },
    ];
    for (const o of sorted) {
      const d = new Date(o.nextDueDate); d.setHours(0, 0, 0, 0);
      const days = Math.round((d.getTime() - todayStart) / 86400000);
      if (days < 0) buckets[0].items.push(o);
      else if (days === 0) buckets[1].items.push(o);
      else if (days <= 7) buckets[2].items.push(o);
      else buckets[3].items.push(o);
    }
    const out = buckets.filter(b => b.items.length > 0);
    // "Recurring obligations" — every repeating obligation, gathered again here
    // as an at-a-glance roster of what keeps coming back. Intentionally overlaps
    // with the time buckets above (a recurring bill is also overdue/upcoming).
    const recurring = sorted.filter(o => !!o.frequency && o.frequency !== "once");
    if (recurring.length > 0) {
      out.push({ key: "recurring", label: "Recurring obligations", color: "#7C76D9", items: recurring });
    }
    return out;
  }, [sorted, todayMs]);

  return (
    <div className="space-y-4" data-testid="obligations-manager">
      {showHeader && (
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Bills</h2>
            <p className="text-xs text-muted-foreground">Recurring bills, subscriptions, payments, and reminders</p>
          </div>
          <Button size="sm" onClick={() => setAddOpen(true)} data-testid="button-add-obligation">
            <Plus className="w-4 h-4 mr-1" /> New
          </Button>
        </div>
      )}

      {/* Add Obligation Dialog */}
      <Dialog open={addOpen} onOpenChange={(v) => { if (!v) { setNewName(""); setNewAmount(""); setNewFrequency("monthly"); setNewCategory("housing"); setNewDueDate(""); setNewRecurrenceEnd(""); setNewKind("bill"); setNewLinkedProfiles([]); setNewRemindDays(""); setNewAutopay(false); setNewAutoLogExpense("auto"); setNewNotes(""); setShowAdvanced(false); } setAddOpen(v); }}>
        <DialogContent className="max-w-sm max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-sm">New Bill</DialogTitle>
            <DialogDescription className="text-xs">Add a recurring bill, subscription, payment, appointment, or reminder.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs">Type</Label>
              <Select value={newKind} onValueChange={v => setNewKind(v as ObligationKind)}>
                <SelectTrigger data-testid="select-obligation-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(OBLIGATION_KIND_META) as ObligationKind[]).map(k => (
                    <SelectItem key={k} value={k}>{OBLIGATION_KIND_META[k].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Name <span className="text-destructive">*</span></Label>
              <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Rent, Netflix, Dentist, Oil change" data-testid="input-obligation-name" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Amount ($) <span className="text-destructive">*</span></Label>
                <Input type="number" inputMode="decimal" min="0" step="0.01" value={newAmount} onChange={e => setNewAmount(e.target.value)} placeholder="0.00" data-testid="input-obligation-amount" />
              </div>
              <div>
                <Label className="text-xs">Frequency</Label>
                <Select value={newFrequency} onValueChange={setNewFrequency}>
                  <SelectTrigger data-testid="select-obligation-frequency"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="biweekly">Biweekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
                    <SelectItem value="yearly">Yearly</SelectItem>
                    <SelectItem value="once">One-time</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Category</Label>
                <Select value={newCategory} onValueChange={setNewCategory}>
                  <SelectTrigger data-testid="select-obligation-category"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="health">Health</SelectItem>
                    <SelectItem value="housing">Housing</SelectItem>
                    <SelectItem value="insurance">Insurance</SelectItem>
                    <SelectItem value="loan">Loan</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                    <SelectItem value="subscription">Subscription</SelectItem>
                    <SelectItem value="utilities">Utilities</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Start Date <span className="text-destructive">*</span></Label>
                <Input type="date" value={newDueDate} onChange={e => setNewDueDate(e.target.value)} data-testid="input-obligation-due-date" />
              </div>
            </div>
            {newFrequency !== "once" && (
              <div>
                <Label className="text-xs">End Date <span className="text-muted-foreground font-normal">(optional — leave blank for ongoing)</span></Label>
                <Input
                  type="date"
                  value={newRecurrenceEnd}
                  min={newDueDate || undefined}
                  onChange={e => setNewRecurrenceEnd(e.target.value)}
                  data-testid="input-obligation-recurrence-end"
                />
              </div>
            )}
            {newDueDate && newFrequency !== "once" && (() => {
              const series = occurrenceSeries(newDueDate, newRecurrenceEnd || null, newFrequency);
              if (!series) return null;
              return (
                <div className="rounded-md bg-muted/50 border border-border/50 px-3 py-2 space-y-1" data-testid="recurrence-preview">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Repeat className="h-3 w-3" />
                    <span>
                      {newRecurrenceEnd
                        ? `${series.count} occurrence${series.count === 1 ? "" : "s"}`
                        : `${series.count} occurrence${series.count === 1 ? "" : "s"} over 2 years (ongoing)`}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground tabular-nums">
                    {series.first} → {series.last}
                  </p>
                </div>
              );
            })()}
            {newDueDate && newFrequency === "once" && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground rounded-md bg-muted/50 border border-border/50 px-3 py-2">
                <CalIcon className="h-3 w-3" />
                <span>One-time — won't repeat after due</span>
              </div>
            )}

            {/* BUG-OBL-004: Profile / Advanced fields */}
            <div>
              <Label className="text-xs">Profile <span className="text-muted-foreground font-normal">(who this belongs to)</span></Label>
              {profilesList.length === 0 ? (
                <p className="text-xs text-muted-foreground py-1">Will be linked to you by default.</p>
              ) : (
                <div className="mt-1 flex flex-wrap gap-1.5" data-testid="profile-chip-row">
                  {profilesList.map((p: any) => {
                    const id = p.id;
                    const selected = newLinkedProfiles.includes(id);
                    return (
                      <button key={id} type="button" data-testid={`profile-chip-${id}`}
                        onClick={() => setNewLinkedProfiles(prev => selected ? prev.filter(x => x !== id) : [...prev, id])}
                        className={`text-xs px-2 py-1 rounded-md border transition-colors ${selected ? "bg-primary text-primary-foreground border-primary" : "bg-background border-border hover:bg-muted"}`}>
                        {p.name || p.firstName || "Profile"}
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="text-[11px] text-muted-foreground mt-1">
                {newLinkedProfiles.length === 0
                  ? (filterMode === "selected" && filterIds.length > 0 ? `Will use active filter (${filterIds.length} profile${filterIds.length === 1 ? "" : "s"}).` : "Defaults to you (100% owner).")
                  : `${newLinkedProfiles.length} profile${newLinkedProfiles.length === 1 ? "" : "s"} selected.`}
              </p>
            </div>

            <button type="button"
              onClick={() => setShowAdvanced(s => !s)}
              className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              data-testid="toggle-advanced">
              <ChevronRight className={`h-3 w-3 transition-transform ${showAdvanced ? "rotate-90" : ""}`} />
              Advanced options
            </button>
            {showAdvanced && (
              <div className="space-y-3 rounded-md border border-border/50 bg-muted/30 p-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Remind (days before)</Label>
                    <Input type="number" inputMode="numeric" min="0" step="1"
                      value={newRemindDays}
                      onChange={e => setNewRemindDays(e.target.value)}
                      placeholder={String(OBLIGATION_KIND_META[newKind].defaultLeadDays)}
                      data-testid="input-remind-days" />
                  </div>
                  <div>
                    <Label className="text-xs">Auto-log expense</Label>
                    <Select value={newAutoLogExpense} onValueChange={v => setNewAutoLogExpense(v as any)}>
                      <SelectTrigger data-testid="select-auto-log"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">Auto (kind default)</SelectItem>
                        <SelectItem value="on">Always</SelectItem>
                        <SelectItem value="off">Never</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-xs">Autopay</Label>
                    <p className="text-[11px] text-muted-foreground">Marks paid automatically on the due date.</p>
                  </div>
                  <Switch checked={newAutopay} onCheckedChange={setNewAutopay} data-testid="switch-autopay" />
                </div>
                <div>
                  <Label className="text-xs">Notes</Label>
                  <Textarea value={newNotes} onChange={e => setNewNotes(e.target.value)}
                    placeholder="Account number, login, anything to remember…"
                    className="min-h-16 text-xs"
                    data-testid="input-notes" />
                </div>
              </div>
            )}
          </div>
          {newDueDate && new Date(newDueDate + "T00:00:00") < new Date(new Date().toLocaleDateString("en-CA") + "T00:00:00") && (
            <div className="flex items-center gap-2 rounded-md bg-yellow-500/10 border border-yellow-500/30 px-3 py-2">
              <AlertTriangle className="h-3.5 w-3.5 text-yellow-600 shrink-0" />
              <p className="text-xs text-yellow-700 dark:text-yellow-400">The due date is in the past. You can still create this.</p>
            </div>
          )}
          {/* Warn (don't block) when an identical obligation already exists. */}
          {newName.trim() && newAmount && newDueDate && obligations.some(o =>
            (o.name || "").trim().toLowerCase() === newName.trim().toLowerCase() &&
            o.amount === parseFloat(newAmount) &&
            o.frequency === newFrequency &&
            (o.nextDueDate || "").slice(0, 10) === newDueDate
          ) && (
            <div className="flex items-center gap-2 rounded-md bg-yellow-500/10 border border-yellow-500/30 px-3 py-2" data-testid="duplicate-create-warning">
              <AlertTriangle className="h-3.5 w-3.5 text-yellow-600 shrink-0" />
              <p className="text-xs text-yellow-700 dark:text-yellow-400">An identical obligation already exists (same name, amount, frequency, and due date). Creating this will make a duplicate.</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button size="sm" disabled={!newName.trim() || !newAmount || parseFloat(newAmount) <= 0 || !newDueDate || createMutation.isPending}
              onClick={() => {
                if (!newDueDate) { toast({ title: "Please pick a due date", variant: "destructive" }); return; }
                // Ownership defaults from the active profile filter:
                //   filter = everyone  → omit linkedProfiles, server auto-links to self
                //   filter = selected  → use the selected profile IDs as owners
                // Explicit profile picks win, otherwise fall back to active filter.
                const ownerIds = newLinkedProfiles.length > 0
                  ? [...newLinkedProfiles]
                  : (filterMode === "selected" && filterIds.length > 0 ? [...filterIds] : undefined);
                const leadDays = newRemindDays.trim() === ""
                  ? OBLIGATION_KIND_META[newKind].defaultLeadDays
                  : Math.max(0, parseInt(newRemindDays, 10) || 0);
                const autoLog = newAutoLogExpense === "auto"
                  ? (newKind === "subscription" || newKind === "bill")
                  : newAutoLogExpense === "on";
                createMutation.mutate({
                  name: newName.trim(), amount: parseFloat(newAmount), frequency: newFrequency,
                  category: newCategory, nextDueDate: newDueDate,
                  autopay: newAutopay,
                  kind: newKind,
                  leadTimeDays: leadDays,
                  autoLogExpense: autoLog,
                  ...(newNotes.trim() ? { notes: newNotes.trim() } : {}),
                  ...(ownerIds ? { linkedProfiles: ownerIds } : {}),
                  ...(newRecurrenceEnd && newFrequency !== "once" ? { recurrenceEnd: newRecurrenceEnd } : {}),
                });
              }} data-testid="button-save-obligation">
              {createMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Live Overdue / Due today / Next 14 days */}
      <ObligationOccurrencePanel />

      {/* Summary cards (hidden in compact tab mode) */}
      {!compact && (
        <div className="grid grid-cols-3 gap-3">
          <Card className="p-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Monthly Total</p>
            <p className="text-lg font-bold">${monthlyTotal.toFixed(0)}</p>
          </Card>
          <Card className="p-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Active</p>
            <p className="text-lg font-bold">{obligations.length}</p>
          </Card>
          <Card className="p-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Due This Week</p>
            <p className={`text-lg font-bold ${upcomingCount > 0 ? "text-yellow-500" : ""}`}>{upcomingCount}</p>
          </Card>
        </div>
      )}

      {/* Time-window chip row: Overdue / Today / Week / Month / All */}
      <div className="flex items-center gap-2 flex-wrap" data-testid="window-filter-row">
        <Button size="sm" variant={windowFilter === "overdue" ? "default" : "outline"}
          className={`h-7 text-xs ${windowFilter === "overdue" ? "" : windowCounts.overdue > 0 ? "text-red-500 border-red-500/40" : ""}`}
          onClick={() => setWindowFilter("overdue")} data-testid="window-filter-overdue">
          <AlertTriangle className="h-3 w-3 mr-1" /> Overdue <span className="ml-1.5 opacity-70 tabular-nums">{windowCounts.overdue}</span>
        </Button>
        <Button size="sm" variant={windowFilter === "today" ? "default" : "outline"} className="h-7 text-xs"
          onClick={() => setWindowFilter("today")} data-testid="window-filter-today">
          <CalendarClock className="h-3 w-3 mr-1" /> Today <span className="ml-1.5 opacity-70 tabular-nums">{windowCounts.today}</span>
        </Button>
        <Button size="sm" variant={windowFilter === "week" ? "default" : "outline"} className="h-7 text-xs"
          onClick={() => setWindowFilter("week")} data-testid="window-filter-week">
          <Clock className="h-3 w-3 mr-1" /> This week <span className="ml-1.5 opacity-70 tabular-nums">{windowCounts.week}</span>
        </Button>
        <Button size="sm" variant={windowFilter === "month" ? "default" : "outline"} className="h-7 text-xs"
          onClick={() => setWindowFilter("month")} data-testid="window-filter-month">
          <CalIcon className="h-3 w-3 mr-1" /> Next 30d <span className="ml-1.5 opacity-70 tabular-nums">{windowCounts.month}</span>
        </Button>
        <Button size="sm" variant={windowFilter === "all" ? "default" : "outline"} className="h-7 text-xs"
          onClick={() => setWindowFilter("all")} data-testid="window-filter-all">
          All <span className="ml-1.5 opacity-70 tabular-nums">{windowCounts.all}</span>
        </Button>
        {/* Group-by-source toggle pushes the list into the Linked Items view. */}
        <Button size="sm" variant={groupBySource ? "default" : "ghost"} className="h-7 text-xs ml-auto"
          onClick={() => setGroupBySource(g => !g)} data-testid="toggle-group-source"
          title="Group by source">
          <Link2 className="h-3 w-3 mr-1" /> Linked items
        </Button>
      </div>

      {/* Kind filter chip row + inline New button when header is hidden */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" variant={kindFilter === "all" ? "default" : "outline"} className="h-7 text-xs"
          onClick={() => setKindFilter("all")} data-testid="kind-filter-all">
          All types <span className="ml-1.5 opacity-60">{kindCounts.all || 0}</span>
        </Button>
        {(Object.keys(OBLIGATION_KIND_META) as ObligationKind[]).map(k => {
          const count = kindCounts[k] || 0;
          if (count === 0) return null;
          const meta = OBLIGATION_KIND_META[k];
          const Icon = KIND_ICON[k];
          return (
            <Button key={k} size="sm" variant={kindFilter === k ? "default" : "outline"} className="h-7 text-xs"
              style={kindFilter === k ? undefined : { borderColor: `${meta.color}55`, color: meta.color }}
              onClick={() => setKindFilter(k)} data-testid={`kind-filter-${k}`}>
              <Icon className="h-3 w-3 mr-1" /> {meta.label} <span className="ml-1.5 opacity-60">{count}</span>
            </Button>
          );
        })}
        {!showHeader && (
          <Button size="sm" onClick={() => setAddOpen(true)} className="ml-auto h-7" data-testid="button-add-obligation-inline">
            <Plus className="w-3.5 h-3.5 mr-1" /> New
          </Button>
        )}
      </div>

      {/* Duplicate-obligation warning: same name + amount + frequency + due date. */}
      {!dupBannerDismissed && duplicateGroups.length > 0 && (
        <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/5 p-3" data-testid="duplicate-banner">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-yellow-600 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
                {duplicateGroups.length} possible duplicate{duplicateGroups.length > 1 ? "s" : ""} found
              </p>
              <div className="mt-1.5 space-y-1.5">
                {duplicateGroups.map((g, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-muted-foreground truncate">
                      <span className="font-medium text-foreground">{g[0].name}</span>
                      {" · "}${g[0].amount.toLocaleString()} · {g[0].frequency} · {g.length} copies
                    </span>
                    <Button size="sm" variant="outline" className="h-6 text-xs shrink-0"
                      onClick={() => removeDuplicates(g)} data-testid={`button-dedupe-${i}`}>
                      Remove {g.length - 1} extra{g.length - 1 > 1 ? "s" : ""}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
            <Button size="sm" variant="ghost" className="h-6 w-6 p-0 shrink-0" onClick={() => setDupBannerDismissed(true)} aria-label="Dismiss">
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="p-4 space-y-3">
          <div className="h-8 w-48 rounded skeleton-shimmer" />
          <div className="h-20 rounded skeleton-shimmer" />
          <div className="h-20 rounded skeleton-shimmer" />
        </div>
      ) : error ? (
        <div className="p-4 text-center">
          <AlertCircle className="h-8 w-8 text-destructive mx-auto mb-2" />
          <p className="text-sm text-destructive">Failed to load data</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>Retry</Button>
        </div>
      ) : sorted.length === 0 ? (
        <div className="text-center py-12">
          <CreditCard className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
          <h3 className="text-sm font-medium mb-1">
            {kindFilter === "all" ? "No bills yet" : `No ${OBLIGATION_KIND_META[kindFilter].label.toLowerCase()} bills`}
          </h3>
          <p className="text-xs text-muted-foreground mb-4">
            {kindFilter === "all"
              ? "Add bills, subscriptions, and recurring payments to track what's due and when."
              : "Switch back to All to see other bills, or add one of this type."}
          </p>
          <Button size="sm" onClick={() => setAddOpen(true)} data-testid="button-add-obligation-empty">
            <Plus className="w-4 h-4 mr-1" /> Add Bill
          </Button>
        </div>
      ) : groupBySource && grouped ? (
        // Linked Items view: group obligations by source kind
        <div className="space-y-5" data-testid="obligations-grouped">
          {grouped.map(g => {
            const Icon = g.meta.icon;
            return (
              <div key={g.meta.key}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="inline-flex items-center justify-center rounded-md" style={{ width: 22, height: 22, background: `${g.meta.color}22`, color: g.meta.color }}>
                    <Icon className="h-3 w-3" />
                  </span>
                  <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: g.meta.color }}>
                    {g.meta.label}
                  </h3>
                  <span className="text-xs text-muted-foreground tabular-nums">{g.items.length}</span>
                </div>
                <div className="grid gap-2">
                  {g.items.map(ob => (
                    <ObligationCard key={ob.id} ob={ob} onOpen={() => setDrawerOb(ob)} ownerLabel={ownerLabelFor(ob)} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        // Default view: grouped by time status (Overdue / Due today / Due this
        // week / Upcoming), each section collapsible. Recurrence is shown as a
        // per-card badge rather than a separate bucket so nothing appears twice.
        <div className="space-y-4" data-testid="obligations-by-status">
          {timeSections.map(section => {
            const collapsed = collapsedSections[section.key];
            return (
              <div key={section.key}>
                <button
                  type="button"
                  onClick={() => setCollapsedSections(s => ({ ...s, [section.key]: !s[section.key] }))}
                  className="flex items-center gap-2 mb-2 w-full text-left"
                  data-testid={`section-toggle-${section.key}`}
                >
                  {collapsed ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: section.color }} />
                  <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: section.color }}>{section.label}</h3>
                  <span className="text-xs text-muted-foreground tabular-nums">{section.items.length}</span>
                </button>
                {!collapsed && (
                  <div className="grid gap-2">
                    {section.items.map(ob => (
                      <ObligationCard key={ob.id} ob={ob} onOpen={() => setDrawerOb(ob)} ownerLabel={ownerLabelFor(ob)} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Detail drawer (the "Calendar Manager" detail panel) */}
      <ObligationDrawer ob={drawerOb} onClose={() => setDrawerOb(null)} />
    </div>
  );
}
