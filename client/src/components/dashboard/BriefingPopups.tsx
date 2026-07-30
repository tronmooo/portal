// ── Executive-briefing detail popups (2026-07-15 v2) ─────────────────────────
// Every stat tile / section row on the briefing opens one of these in place.
// v2 (user request): "more detailed, useful, and visually polished … not
// simple placeholder boxes". Each popup now shows what the item is, who it
// belongs to, its important dates, current status, related records, and REAL
// in-place actions (pay/skip/edit/delete/renew/dismiss) — not just nav links.
// TasksPopup/HabitsPopup already live in TaskHabitPopups.tsx.
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { addMonthsClamped, addYearsClamped, toISODate } from "@shared/date-math";
import { useToast } from "@/hooks/use-toast";
import { loadDocSnoozeMap, saveDocSnoozeMap } from "@/lib/docSnooze";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertTriangle, ArrowRight, BellOff, CalendarDays, Check, ChevronDown,
  Clock, CreditCard, FileText, MapPin, Pencil, RefreshCw,
  Trash2, User,
} from "lucide-react";

// ── Shared date/format helpers ───────────────────────────────────────────────
function fmtDate(d?: string | null): string {
  const s = String(d || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s || "—";
  return new Date(s + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
/** "14:30" → "2:30 PM". Calendar rows store bare HH:MM strings, not ISO. */
export function fmtClock(t?: string | null): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ""));
  if (!m) return String(t || "");
  const h = parseInt(m[1], 10);
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? "PM" : "AM"}`;
}
/** "Expires in 7 days" / "Expires today" / "Expired 3 days ago" */
function expiryLabel(daysUntil: number): string {
  if (daysUntil === 0) return "Expires today";
  if (daysUntil === 1) return "Expires tomorrow";
  if (daysUntil > 0) return `Expires in ${daysUntil} days`;
  const ago = Math.abs(daysUntil);
  return ago === 1 ? "Expired yesterday" : `Expired ${ago} days ago`;
}
function dueLabel(daysUntil: number): string {
  if (daysUntil === 0) return "Due today";
  if (daysUntil === 1) return "Due tomorrow";
  if (daysUntil > 0) return `Due in ${daysUntil} days`;
  const ago = Math.abs(daysUntil);
  return ago === 1 ? "1 day overdue" : `${ago} days overdue`;
}
const FREQ_LABEL: Record<string, string> = {
  weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly",
  quarterly: "Quarterly", yearly: "Yearly", once: "One-time",
};
const FREQ_DAYS: Record<string, number> = { weekly: 7, biweekly: 14, monthly: 30, quarterly: 91, yearly: 365 };
function addFrequency(dateStr: string, freq: string, anchorDay?: number): string | null {
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  if (freq === "once") return null;
  // Month/year steps clamp to the target month's last day (shared/date-math)
  // instead of overflowing a "day 31" bill into the following month.
  if (freq === "monthly") return toISODate(addMonthsClamped(d, 1, anchorDay));
  if (freq === "quarterly") return toISODate(addMonthsClamped(d, 3, anchorDay));
  if (freq === "yearly") return toISODate(addYearsClamped(d, 1, anchorDay));
  d.setDate(d.getDate() + (FREQ_DAYS[freq] || 30));
  return d.toLocaleDateString("en-CA");
}

/** Owner names for a linkedProfiles list. Empty links = primary (Self). */
function useOwnerNames() {
  const { data: profiles = [] } = useQuery<any[]>({ queryKey: ["/api/profiles"], staleTime: 60_000 });
  const byId = useMemo(() => new Map((profiles || []).map((p: any) => [p.id, p])), [profiles]);
  const selfName = useMemo(() => (profiles || []).find((p: any) => p.type === "self")?.name, [profiles]);
  return {
    byId,
    names(linked?: string[] | null, fallbackToSelf = true): string {
      const ids = Array.isArray(linked) ? linked : [];
      const named = ids.map(id => byId.get(id)?.name).filter(Boolean);
      if (named.length > 0) return named.join(", ");
      return fallbackToSelf && selfName ? selfName : "";
    },
    nameOf(id?: string | null): string { return (id && byId.get(id)?.name) || ""; },
  };
}

// ── Shared shell + primitives ────────────────────────────────────────────────
function PopupShell({ open, onClose, title, icon: Icon, accent, count, subtitle, footerLabel, footerHref, children }: {
  open: boolean; onClose: () => void; title: string; icon: any; accent: string;
  count?: number; subtitle?: string; footerLabel?: string; footerHref?: string; children: React.ReactNode;
}) {
  const [, navigate] = useLocation();
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md max-h-[82vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-4 pt-4 pb-2 border-b border-border/40">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: `hsl(${accent})`, boxShadow: `0 0 6px hsl(${accent} / 0.7)` }} />
            <Icon className="h-4 w-4" style={{ color: `hsl(${accent})` }} />
            {title}
            {typeof count === "number" && (
              <span className="text-[11px] px-1.5 rounded-full font-normal" style={{ background: `hsl(${accent} / 0.15)`, color: `hsl(${accent})` }}>{count}</span>
            )}
          </DialogTitle>
          {subtitle && <p className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>}
        </DialogHeader>
        <div className="flex-1 overflow-y-auto px-2 py-1.5">{children}</div>
        {footerLabel && footerHref && (
          <div className="px-3 py-2 border-t border-border/40">
            <Button variant="ghost" size="sm" className="w-full h-8 text-xs justify-between"
              onClick={() => { onClose(); navigate(footerHref); }}>
              {footerLabel} <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const EmptyNote = ({ label }: { label: string }) => (
  <p className="text-xs text-muted-foreground py-4 text-center">{label}</p>
);

/** Tiny labelled chip for type/category/status metadata. */
function Chip({ children, tone }: { children: React.ReactNode; tone?: "neg" | "warn" | "pos" | "muted" }) {
  const cls = tone === "neg" ? "bg-red-500/10 text-red-500"
    : tone === "warn" ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
    : tone === "pos" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
    : "bg-muted text-muted-foreground";
  return <span className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-px rounded-full font-medium ${cls}`}>{children}</span>;
}

/** Small bordered action button used in expanded cards. */
function ActionBtn({ label, icon: Icon, onClick, danger, disabled, testId }: {
  label: string; icon?: any; onClick: () => void; danger?: boolean; disabled?: boolean; testId?: string;
}) {
  return (
    <button onClick={onClick} disabled={disabled} data-testid={testId}
      className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md border transition-colors disabled:opacity-50 ${
        danger ? "border-red-500/40 text-red-500 hover:bg-red-500/10" : "border-border hover:bg-muted"}`}>
      {Icon && <Icon className="h-3 w-3" />}{label}
    </button>
  );
}

/** Expandable detail card: dense summary row; tap to reveal detail + actions. */
function ExpandCard({ summary, urgentBorder, children, testId }: {
  summary: React.ReactNode; urgentBorder?: "red" | "amber"; children?: React.ReactNode; testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const border = urgentBorder === "red" ? "border-l-red-500" : urgentBorder === "amber" ? "border-l-amber-500" : "border-l-transparent";
  return (
    <div className={`mb-1 rounded-md border border-border/40 border-l-2 ${border} bg-card/50`} data-testid={testId}>
      <button onClick={() => setOpen(o => !o)} className="w-full text-left px-2.5 py-2 hover:bg-muted/30 rounded-md">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">{summary}</div>
          {children && <ChevronDown className={`h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />}
        </div>
      </button>
      {open && children && <div className="px-2.5 pb-2 pt-0.5 border-t border-border/30">{children}</div>}
    </div>
  );
}

const invalidateFinance = () => {
  // Cache bus: obligations domain covers /api/obligations + dashboard-enhanced
  // + stats + cashflow + loans/schedule. Bootstrap + timeline have no matching
  // domain entry, so they stay explicit.
  invalidateDomain("obligations");
  queryClient.invalidateQueries({ queryKey: ["/api/dashboard-bootstrap"] });
  queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
};

// ── Bills & Obligations ──────────────────────────────────────────────────────
// Row source: enhanced.financeSnapshot.upcomingBills (30-day window). Each row
// is enriched from /api/obligations (recurrence, owners, linked asset/liability,
// payment history) and exposes Mark-paid / Skip / Edit / Delete in place.
export function BillsPopup({ open, onClose, bills }: { open: boolean; onClose: () => void; bills: any[] }) {
  const { toast } = useToast();
  const owners = useOwnerNames();
  const { data: obligationsRaw } = useQuery<any[]>({ queryKey: ["/api/obligations"], staleTime: 30_000, enabled: open });
  const obById = useMemo(() => new Map((Array.isArray(obligationsRaw) ? obligationsRaw : []).map((o: any) => [o.id, o])), [obligationsRaw]);
  const [editId, setEditId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [editDue, setEditDue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const payBill = useMutation({
    mutationFn: async (id: string) => { await apiRequest("POST", `/api/obligations/${id}/pay`, {}); },
    onSuccess: () => { toast({ title: "Payment recorded" }); invalidateFinance(); },
    onError: (e: any) => toast({ title: "Payment failed", description: e?.message, variant: "destructive" }),
  });
  const skipBill = useMutation({
    mutationFn: async (b: any) => {
      const due = String(b.dueDate || b.nextDueDate || "").slice(0, 10);
      await apiRequest("POST", `/api/obligation-occurrences/${b.id}:${due}/status`, { status: "skipped" });
    },
    onSuccess: () => { toast({ title: "Payment skipped", description: "This occurrence was skipped; the next one stays scheduled." }); invalidateFinance(); },
    onError: (e: any) => toast({ title: "Couldn't skip", description: e?.message, variant: "destructive" }),
  });
  const editBill = useMutation({
    mutationFn: async (vars: { id: string; amount?: number; nextDueDate?: string }) => {
      const { id, ...body } = vars;
      await apiRequest("PATCH", `/api/obligations/${id}`, body);
    },
    onSuccess: () => { toast({ title: "Bill updated" }); setEditId(null); invalidateFinance(); },
    onError: (e: any) => toast({ title: "Update failed", description: e?.message, variant: "destructive" }),
  });
  const deleteBill = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/obligations/${id}`); },
    onSuccess: () => { toast({ title: "Bill deleted" }); setConfirmDeleteId(null); invalidateFinance(); },
    onError: (e: any) => toast({ title: "Delete failed", description: e?.message, variant: "destructive" }),
  });

  const rows = useMemo(() => (bills || []).slice().sort((a, b) => (a.daysUntil ?? 1e9) - (b.daysUntil ?? 1e9)), [bills]);
  const total = rows.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const overdueCount = rows.filter((b) => b.status === "overdue").length;

  return (
    <PopupShell open={open} onClose={onClose} title="Bills & Obligations" icon={CreditCard}
      accent="48 96% 53%" count={rows.length}
      subtitle={rows.length ? `$${Math.round(total).toLocaleString()} due in the next 30 days${overdueCount ? ` · ${overdueCount} overdue` : ""}` : undefined}
      footerLabel="Open Finance" footerHref="/dashboard/finance">
      {rows.length === 0 ? <EmptyNote label="No bills due in the next 30 days." /> : rows.map((b: any) => {
        const full = obById.get(b.id) || {};
        const freq = full.frequency || "monthly";
        const payments: any[] = Array.isArray(full.payments) ? full.payments.slice().sort((x: any, y: any) => String(y.date || "").localeCompare(String(x.date || ""))) : [];
        const ownerNames = owners.names(full.linkedProfiles);
        const assetName = owners.nameOf(full.linkedAssetId);
        const liabilityName = owners.nameOf(full.linkedLiabilityId);
        const due = String(b.dueDate || full.nextDueDate || "").slice(0, 10);
        // Upcoming occurrences projected from the frequency (next 3 after current).
        const upcoming: string[] = [];
        let cursor: string | null = due;
        for (let i = 0; i < 3 && cursor; i++) {
          cursor = addFrequency(cursor, freq);
          if (!cursor) break;
          if (full.recurrenceEnd && cursor > String(full.recurrenceEnd).slice(0, 10)) break;
          upcoming.push(cursor);
        }
        // Remaining payments when the recurrence has a declared end.
        let remaining: number | null = null;
        if (full.recurrenceEnd && freq !== "once") {
          let c: string | null = due; remaining = 0;
          const end = String(full.recurrenceEnd).slice(0, 10);
          while (c && c <= end && remaining < 500) { remaining++; c = addFrequency(c, freq); }
        }
        const urgent = b.status === "overdue" || b.daysUntil === 0;
        return (
          <ExpandCard key={b.id} urgentBorder={urgent ? "red" : b.daysUntil <= 3 ? "amber" : undefined} testId={`bill-card-${b.id}`}
            summary={
              <div>
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-semibold truncate">{b.name}</span>
                  <span className="ml-auto text-sm font-bold tabular-nums shrink-0">${Number(b.amount).toLocaleString()}</span>
                </div>
                <div className="flex items-center flex-wrap gap-1 mt-1">
                  <Chip tone={urgent ? "neg" : b.daysUntil <= 3 ? "warn" : "muted"}>
                    <Clock className="h-2.5 w-2.5" />{dueLabel(b.daysUntil)} · {fmtDate(due)}
                  </Chip>
                  <Chip>{FREQ_LABEL[freq] || freq}</Chip>
                  {b.autopay && <Chip tone="pos">autopay</Chip>}
                  {full.status === "paused" && <Chip tone="warn">paused</Chip>}
                  {ownerNames && <Chip><User className="h-2.5 w-2.5" />{ownerNames}</Chip>}
                </div>
              </div>
            }>
            <div className="space-y-1.5 text-[11px]">
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 pt-1 text-muted-foreground">
                <span>Category</span><span className="text-foreground capitalize">{b.category || full.category || "general"}</span>
                <span>Status</span><span className="text-foreground">{b.status === "overdue" ? "Overdue — payment missed" : b.status === "due_today" ? "Due today" : "Scheduled"}</span>
                {remaining !== null && (<><span>Payments left</span><span className="text-foreground">{remaining} (ends {fmtDate(full.recurrenceEnd)})</span></>)}
                {assetName && (<><span>Linked asset</span><span className="text-foreground">{assetName}</span></>)}
                {liabilityName && (<><span>Linked liability</span><span className="text-foreground">{liabilityName}</span></>)}
              </div>
              {upcoming.length > 0 && (
                <div>
                  <p className="font-semibold text-muted-foreground uppercase text-[10px] tracking-wide mb-0.5">Upcoming</p>
                  {upcoming.map(d => <div key={d} className="flex justify-between"><span>{fmtDate(d)}</span><span className="tabular-nums">${Number(b.amount).toLocaleString()}</span></div>)}
                </div>
              )}
              <div>
                <p className="font-semibold text-muted-foreground uppercase text-[10px] tracking-wide mb-0.5">Payment history</p>
                {payments.length === 0 ? <p className="text-muted-foreground">No payments recorded yet.</p> :
                  payments.slice(0, 6).map((p: any) => (
                    <div key={p.id} className="flex justify-between">
                      <span>{fmtDate(p.date)}{p.method ? ` · ${p.method}` : ""}</span>
                      <span className="tabular-nums text-emerald-600 dark:text-emerald-400">${Number(p.amount).toLocaleString()}</span>
                    </div>
                  ))}
              </div>
              {editId === b.id ? (
                <div className="flex items-center gap-1.5 pt-1">
                  <input type="number" value={editAmount} onChange={e => setEditAmount(e.target.value)} placeholder="Amount"
                    className="w-20 h-7 px-1.5 rounded border border-border bg-background text-xs" data-testid={`bill-edit-amount-${b.id}`} />
                  <input type="date" value={editDue} onChange={e => setEditDue(e.target.value)}
                    className="h-7 px-1.5 rounded border border-border bg-background text-xs" data-testid={`bill-edit-due-${b.id}`} />
                  <ActionBtn label="Save" icon={Check} disabled={editBill.isPending} testId={`bill-edit-save-${b.id}`}
                    onClick={() => editBill.mutate({ id: b.id, ...(editAmount ? { amount: Number(editAmount) } : {}), ...(editDue ? { nextDueDate: editDue } : {}) })} />
                  <ActionBtn label="Cancel" onClick={() => setEditId(null)} />
                </div>
              ) : confirmDeleteId === b.id ? (
                <div className="flex items-center gap-1.5 pt-1">
                  <span className="text-red-500">Delete "{b.name}" and stop tracking it?</span>
                  <ActionBtn label="Delete" icon={Trash2} danger disabled={deleteBill.isPending} onClick={() => deleteBill.mutate(b.id)} testId={`bill-delete-confirm-${b.id}`} />
                  <ActionBtn label="Keep" onClick={() => setConfirmDeleteId(null)} />
                </div>
              ) : (
                <div className="flex items-center flex-wrap gap-1.5 pt-1">
                  <ActionBtn label="Mark as paid" icon={Check} disabled={payBill.isPending} onClick={() => payBill.mutate(b.id)} testId={`popup-pay-${b.id}`} />
                  <ActionBtn label="Skip payment" icon={RefreshCw} disabled={skipBill.isPending} onClick={() => skipBill.mutate(b)} testId={`popup-skip-${b.id}`} />
                  <ActionBtn label="Edit" icon={Pencil} onClick={() => { setEditId(b.id); setEditAmount(String(b.amount ?? "")); setEditDue(due); }} testId={`popup-edit-${b.id}`} />
                  <ActionBtn label="Delete" icon={Trash2} danger onClick={() => setConfirmDeleteId(b.id)} testId={`popup-delete-${b.id}`} />
                </div>
              )}
            </div>
          </ExpandCard>
        );
      })}
    </PopupShell>
  );
}

// ── Document expirations ─────────────────────────────────────────────────────
// Rows: enhanced.expiringDocuments ({documentId, documentName, documentType,
// fieldName, expirationDate, daysUntil, status}). Grouped by urgency band with
// a 30-day "expiring soon" window; enriched with owner from /api/documents.
export function DocsPopup({ open, onClose, docs }: { open: boolean; onClose: () => void; docs: any[] }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const owners = useOwnerNames();
  const { data: allDocsRaw } = useQuery<any[]>({ queryKey: ["/api/documents"], staleTime: 60_000, enabled: open });
  const docById = useMemo(() => new Map((Array.isArray(allDocsRaw) ? allDocsRaw : []).map((d: any) => [d.id, d])), [allDocsRaw]);
  const [snoozeMap, setSnoozeMap] = useState<Record<string, number>>(() => loadDocSnoozeMap());
  const [renewId, setRenewId] = useState<string | null>(null);
  const [renewDate, setRenewDate] = useState("");

  const renew = useMutation({
    mutationFn: async (vars: { row: any; newDate: string }) => {
      const full = docById.get(vars.row.documentId);
      const extractedData = { ...(full?.extractedData || {}), [vars.row.fieldName]: vars.newDate };
      await apiRequest("PATCH", `/api/documents/${vars.row.documentId}`, { extractedData });
    },
    onSuccess: () => {
      toast({ title: "Expiration updated", description: "The document now carries the renewed date." });
      setRenewId(null);
      // Cache bus: documents domain covers /api/documents + dashboard-enhanced
      // + stats + activity.
      invalidateDomain("documents");
    },
    onError: (e: any) => toast({ title: "Couldn't update", description: e?.message, variant: "destructive" }),
  });
  const dismiss = (docId: string) => {
    const next = { ...snoozeMap, [docId]: Date.now() + 30 * 86400000 };
    setSnoozeMap(next); saveDocSnoozeMap(next);
    toast({ title: "Alert dismissed", description: "Hidden from expiration alerts for 30 days." });
  };

  const visible = (docs || []).filter((d: any) => !snoozeMap[d.documentId]);
  const bands: Array<{ key: string; label: string; tone: "neg" | "warn" | "muted"; rows: any[] }> = [
    { key: "expired", label: "Expired", tone: "neg", rows: visible.filter((d: any) => d.daysUntil < 0) },
    { key: "soon", label: "Expiring soon · next 30 days", tone: "warn", rows: visible.filter((d: any) => d.daysUntil >= 0 && d.daysUntil <= 30) },
    { key: "later", label: "Upcoming · 31–90 days", tone: "muted", rows: visible.filter((d: any) => d.daysUntil > 30) },
  ];

  const renderRow = (d: any) => {
    const full = docById.get(d.documentId);
    const ownerNames = owners.names(full?.linkedProfiles);
    const urgent = d.daysUntil < 0 ? "red" as const : d.daysUntil <= 30 ? "amber" as const : undefined;
    const name = d.documentName || full?.name || d.name || "Document";
    const type = d.documentType || full?.type;
    const fieldLabel = String(d.fieldName || "expiration").replace(/[_-]+/g, " ");
    return (
      <ExpandCard key={`${d.documentId}-${d.fieldName}`} urgentBorder={urgent} testId={`doc-card-${d.documentId}`}
        summary={
          <div>
            <div className="flex items-baseline gap-2">
              {d.daysUntil < 0 ? <AlertTriangle className="h-3.5 w-3.5 text-red-500 shrink-0 self-center" /> : <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0 self-center" />}
              <span className="text-xs font-semibold truncate">{name}</span>
              <span className={`ml-auto text-[11px] font-medium shrink-0 tabular-nums ${d.daysUntil < 0 ? "text-red-500" : d.daysUntil <= 30 ? "text-amber-500" : "text-muted-foreground"}`}>
                {expiryLabel(d.daysUntil)}
              </span>
            </div>
            <div className="flex items-center flex-wrap gap-1 mt-1">
              {type && <Chip>{type}</Chip>}
              {ownerNames && <Chip><User className="h-2.5 w-2.5" />{ownerNames}</Chip>}
              <Chip tone={d.daysUntil < 0 ? "neg" : d.daysUntil <= 30 ? "warn" : "muted"}>
                <CalendarDays className="h-2.5 w-2.5" />{fmtDate(d.expirationDate)}
              </Chip>
            </div>
          </div>
        }>
        <div className="space-y-1.5 text-[11px] pt-1">
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground">
            <span>Field</span><span className="text-foreground capitalize">{fieldLabel}</span>
            <span>Exact date</span><span className="text-foreground">{fmtDate(d.expirationDate)}</span>
            <span>Days remaining</span><span className="text-foreground tabular-nums">{d.daysUntil >= 0 ? d.daysUntil : `${Math.abs(d.daysUntil)} past`}</span>
          </div>
          {renewId === d.documentId ? (
            <div className="flex items-center gap-1.5 pt-1">
              <input type="date" value={renewDate} onChange={e => setRenewDate(e.target.value)}
                className="h-7 px-1.5 rounded border border-border bg-background text-xs" data-testid={`doc-renew-date-${d.documentId}`} />
              <ActionBtn label="Save new date" icon={Check} disabled={renew.isPending || !renewDate}
                onClick={() => renew.mutate({ row: d, newDate: renewDate })} testId={`doc-renew-save-${d.documentId}`} />
              <ActionBtn label="Cancel" onClick={() => setRenewId(null)} />
            </div>
          ) : (
            <div className="flex items-center flex-wrap gap-1.5 pt-1">
              <ActionBtn label="View" icon={FileText} onClick={() => { onClose(); navigate(`/documents/${d.documentId}`); }} testId={`doc-view-${d.documentId}`} />
              <ActionBtn label="Edit" icon={Pencil} onClick={() => { onClose(); navigate(`/documents/${d.documentId}`); }} testId={`doc-edit-${d.documentId}`} />
              <ActionBtn label="Renewed — set new date" icon={RefreshCw} onClick={() => { setRenewId(d.documentId); setRenewDate(""); }} testId={`doc-renew-${d.documentId}`} />
              <ActionBtn label="Dismiss 30d" icon={BellOff} onClick={() => dismiss(d.documentId)} testId={`doc-dismiss-${d.documentId}`} />
            </div>
          )}
        </div>
      </ExpandCard>
    );
  };

  const soonCount = visible.filter((d: any) => d.daysUntil <= 30).length;
  return (
    <PopupShell open={open} onClose={onClose} title="Document Expirations" icon={FileText}
      accent="0 72% 58%" count={visible.length}
      subtitle={visible.length ? `${soonCount} expired or expiring within 30 days` : undefined}
      footerLabel="Open Documents" footerHref="/linked?tab=documents">
      {visible.length === 0 ? <EmptyNote label="Nothing expiring in the next 90 days." /> : bands.map(band => band.rows.length === 0 ? null : (
        <div key={band.key}>
          <div className={`text-[10px] font-semibold uppercase tracking-wider px-1 pt-2 pb-1 ${band.tone === "neg" ? "text-red-500" : band.tone === "warn" ? "text-amber-500" : "text-muted-foreground"}`}>
            {band.label} · {band.rows.length}
          </div>
          {band.rows.map(renderRow)}
        </div>
      ))}
    </PopupShell>
  );
}

// ── Events / calendar (also serves birthdays, appointments, important dates) ─
export function EventsPopup({ open, onClose, items, todayStr, title = "Calendar · Next 45 days" }: {
  open: boolean; onClose: () => void; items: any[]; todayStr: string; title?: string;
}) {
  const owners = useOwnerNames();
  const days = useMemo(() => {
    const buckets: Array<{ day: string; date: string; items: any[] }> = [];
    for (const item of items || []) {
      const d = String(item.date || "").slice(0, 10);
      if (!d) continue;
      const label = d === todayStr ? "Today" : new Date(d + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      const bucket = buckets.find(b => b.day === label);
      if (bucket) bucket.items.push(item);
      else buckets.push({ day: label, date: d, items: [item] });
    }
    return buckets;
  }, [items, todayStr]);
  const daysAway = (d: string) => Math.round((new Date(d + "T00:00:00").getTime() - new Date(todayStr + "T00:00:00").getTime()) / 86400000);
  return (
    <PopupShell open={open} onClose={onClose} title={title} icon={CalendarDays}
      accent="239 84% 67%" count={(items || []).length}
      subtitle={(items || []).length ? "Events, tasks and bills on your combined calendar" : undefined}
      footerLabel="Open Calendar" footerHref="/calendar">
      {days.length === 0 ? <EmptyNote label="Nothing scheduled." /> : days.map(d => (
        <div key={d.day}>
          <div className="flex items-baseline px-1 pt-2 pb-0.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{d.day}</span>
            <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">{daysAway(d.date) === 0 ? "" : `in ${daysAway(d.date)}d`}</span>
          </div>
          {d.items.map((i: any) => {
            const ownerNames = owners.names(i.linkedProfiles, false);
            const urgent = i.type === "bill" || i.type === "obligation";
            return (
              <div key={i.id} className="mb-1 rounded-md border border-border/40 bg-card/50 px-2.5 py-1.5">
                <div className="flex items-baseline gap-2">
                  <span className="text-[10px] uppercase text-muted-foreground w-14 shrink-0 truncate">{i.time || (i.allDay ? "all day" : "")}</span>
                  <span className={`text-xs truncate ${urgent ? "text-red-500 font-medium" : ""}`}>{i.title}</span>
                </div>
                <div className="flex items-center flex-wrap gap-1 mt-0.5 pl-16">
                  {i.type && i.type !== "event" && <Chip tone={urgent ? "neg" : "muted"}>{i.type}</Chip>}
                  {i.category && i.category !== "general" && <Chip>{i.category}</Chip>}
                  {i.location && <Chip><MapPin className="h-2.5 w-2.5" />{i.location}</Chip>}
                  {ownerNames && <Chip><User className="h-2.5 w-2.5" />{ownerNames}</Chip>}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </PopupShell>
  );
}


// Projects, Quick Notes, Reminders, Attention Required and Today's Overview
// popups lived here until the Executive tab became an attention feed. Their
// sections are gone from that tab, and each surface has a real home:
//   goals    -> /goals            notes -> /journal
//   reminders -> /calendar        "attention"/"today" -> the feed itself
// They were removed rather than left unreferenced so the next reader does not
// find two competing answers to "what needs attention".