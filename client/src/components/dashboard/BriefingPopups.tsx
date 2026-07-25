// ── Executive-briefing detail popups (2026-07-15 v2) ─────────────────────────
// Every stat tile / section row on the briefing opens one of these in place.
// v2 (user request): "more detailed, useful, and visually polished … not
// simple placeholder boxes". Each popup now shows what the item is, who it
// belongs to, its important dates, current status, related records, and REAL
// in-place actions (pay/skip/edit/delete/renew/dismiss) — not just nav links.
// TasksPopup/HabitsPopup already live in TaskHabitPopups.tsx.
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { addMonthsClamped, addYearsClamped, toISODate } from "@shared/date-math";
import { useToast } from "@/hooks/use-toast";
import { loadDocSnoozeMap, saveDocSnoozeMap } from "@/lib/docSnooze";
import { Button } from "@/components/ui/button";
import { Windowed } from "@/components/dashboard/popups/Windowed";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertTriangle, ArrowRight, Bell, BellOff, CalendarDays, Check, ChevronDown,
  Clock, CreditCard, FileText, MapPin, NotebookPen, Pencil, RefreshCw, Target,
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

/** Owner names for a linkedProfiles list. Empty links = primary (Self).
 *  PERF: `enabled` MUST be the owning popup's `open` flag. Without the gate
 *  this hook fired /api/profiles for every popup that merely existed in the
 *  tree, which — before panels became mount-on-open — meant several redundant
 *  fetches per dashboard render. */
function useOwnerNames(enabled = true) {
  const { data: profiles = [] } = useQuery<any[]>({ queryKey: ["/api/profiles"], staleTime: 60_000, enabled });
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
function PopupShell({ open, onClose, title, icon: Icon, accent, count, subtitle, footerLabel, footerHref, tabs, activeTab, onTab, children }: {
  open: boolean; onClose: () => void; title: string; icon: any; accent: string;
  count?: number; subtitle?: string; footerLabel?: string; footerHref?: string;
  /** Sub-tabs inside one panel — how Bills and Documents share a single shell
   *  instead of being two popups that each restate the same "dated thing that
   *  costs you if ignored" idea. */
  tabs?: Array<{ id: string; label: string; count?: number }>;
  activeTab?: string; onTab?: (id: string) => void;
  children: React.ReactNode;
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
          {tabs && tabs.length > 1 && (
            <div className="flex items-center gap-1 pt-1.5" role="tablist">
              {tabs.map(t => (
                <button key={t.id} role="tab" aria-selected={activeTab === t.id}
                  onClick={() => onTab?.(t.id)} data-testid={`panel-tab-${t.id}`}
                  className={`text-[11px] font-medium px-2 py-0.5 rounded-full border transition-colors ${
                    activeTab === t.id ? "text-foreground" : "border-border text-muted-foreground hover:bg-muted"}`}
                  style={activeTab === t.id
                    ? { borderColor: `hsl(${accent} / 0.5)`, background: `hsl(${accent} / 0.12)` }
                    : undefined}>
                  {t.label}{typeof t.count === "number" ? ` · ${t.count}` : ""}
                </button>
              ))}
            </div>
          )}
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

// ── Bills (the "Bills" tab of ObligationsPopup) ──────────────────────────────
// Row source: enhanced.financeSnapshot.upcomingBills (30-day window). Each row
// is enriched from /api/obligations (recurrence, owners, linked asset/liability,
// payment history) and exposes Mark-paid / Skip / Edit / Delete in place.
// Body-only: the Dialog shell lives in ObligationsPopup so bills and documents
// share one popup instead of two that say the same thing.
function BillsBody({ open, bills }: { open: boolean; bills: any[] }) {
  const { toast } = useToast();
  const owners = useOwnerNames(open);
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

  return (
    <>
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
    </>
  );
}

// ── Document expirations (the "Documents" tab of ObligationsPopup) ───────────
// Rows: enhanced.expiringDocuments ({documentId, documentName, documentType,
// fieldName, expirationDate, daysUntil, status}). Grouped by urgency band with
// a 30-day "expiring soon" window; enriched with owner from /api/documents.
function DocsBody({ open, onClose, docs }: { open: boolean; onClose: () => void; docs: any[] }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const owners = useOwnerNames(open);
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

  return (
    <>
      {visible.length === 0 ? <EmptyNote label="Nothing expiring in the next 90 days." /> : bands.map(band => band.rows.length === 0 ? null : (
        <div key={band.key}>
          <div className={`text-[10px] font-semibold uppercase tracking-wider px-1 pt-2 pb-1 ${band.tone === "neg" ? "text-red-500" : band.tone === "warn" ? "text-amber-500" : "text-muted-foreground"}`}>
            {band.label} · {band.rows.length}
          </div>
          {band.rows.map(renderRow)}
        </div>
      ))}
    </>
  );
}

// ── Obligations — bills + documents in ONE panel ─────────────────────────────
// Both answer the same question ("what dated thing costs me if I ignore it?"),
// so they share a shell with two tabs instead of being two popups. The Executive
// tab's Obligations tile and every bill/doc row lands here; `sub` picks the tab,
// so a doc row opens on Documents and a bill row on Bills.
export function ObligationsPopup({ open, onClose, bills, docs, sub = "bills" }: {
  open: boolean; onClose: () => void; bills: any[]; docs: any[]; sub?: string;
}) {
  const [tab, setTab] = useState(sub === "docs" ? "docs" : "bills");
  useEffect(() => { if (open) setTab(sub === "docs" ? "docs" : "bills"); }, [open, sub]);

  const billRows = bills || [];
  const billTotal = billRows.reduce((s: number, b: any) => s + (Number(b.amount) || 0), 0);
  const overdueCount = billRows.filter((b: any) => b.status === "overdue").length;
  const snooze = loadDocSnoozeMap();
  const docRows = (docs || []).filter((d: any) => !snooze[d.documentId]);
  const docSoon = docRows.filter((d: any) => typeof d.daysUntil === "number" && d.daysUntil <= 30).length;
  const onBills = tab === "bills";

  return (
    <PopupShell open={open} onClose={onClose}
      title="Obligations" icon={onBills ? CreditCard : FileText}
      accent={onBills ? "48 96% 53%" : "0 72% 58%"}
      count={onBills ? billRows.length : docRows.length}
      subtitle={onBills
        ? (billRows.length ? `$${Math.round(billTotal).toLocaleString()} due in the next 30 days${overdueCount ? ` · ${overdueCount} overdue` : ""}` : undefined)
        : (docRows.length ? `${docSoon} expired or expiring within 30 days` : undefined)}
      tabs={[
        { id: "bills", label: "Bills", count: billRows.length },
        { id: "docs", label: "Documents", count: docRows.length },
      ]}
      activeTab={tab} onTab={setTab}
      footerLabel={onBills ? "Open Finance" : "Open Documents"}
      footerHref={onBills ? "/dashboard/finance" : "/linked?tab=documents"}>
      {onBills
        ? <BillsBody open={open} bills={billRows} />
        : <DocsBody open={open} onClose={onClose} docs={docs || []} />}
    </PopupShell>
  );
}

// ── Timeline — one dated list, with the old section splits as filter chips ───
// Birthdays & Anniversaries, Appointments and Important Dates used to be three
// separate briefing sections carved out of this same timeline by regex, which
// meant "Calendar · Next 14d" then re-rendered all three. They are filters over
// one list now, not sections beside it.
export const BIRTHDAY_RE = /birthday|anniversar|🎂|🎉/i;
export const APPT_RE = /appt|appointment|doctor|dentist|dental|vet\b|exam|check[- ]?up|physical|therapy/i;

type TimelineFilter = "all" | "birthdays" | "appointments" | "events";

const TIMELINE_FILTERS: Array<{ key: TimelineFilter; label: string; test: (i: any) => boolean }> = [
  { key: "all", label: "All", test: () => true },
  { key: "birthdays", label: "Birthdays", test: (i) => BIRTHDAY_RE.test(`${i.title} ${i.category || ""}`) },
  { key: "appointments", label: "Appointments", test: (i) => APPT_RE.test(`${i.title} ${i.category || ""}`) },
  {
    key: "events", label: "Other",
    test: (i) => !BIRTHDAY_RE.test(`${i.title} ${i.category || ""}`) && !APPT_RE.test(`${i.title} ${i.category || ""}`),
  },
];

export function TimelinePopup({ open, onClose, items, todayStr, title = "Calendar · Next 45 days", sub }: {
  open: boolean; onClose: () => void; items: any[]; todayStr: string; title?: string; sub?: string;
}) {
  const owners = useOwnerNames(open);
  const [filter, setFilter] = useState<TimelineFilter>("all");
  useEffect(() => {
    if (!open) return;
    const match = TIMELINE_FILTERS.find(f => f.key === sub);
    setFilter(match ? match.key : "all");
  }, [open, sub]);

  const active = TIMELINE_FILTERS.find(f => f.key === filter) || TIMELINE_FILTERS[0];
  const filtered = useMemo(() => (items || []).filter(active.test), [items, active]);
  const days = useMemo(() => {
    const buckets: Array<{ day: string; date: string; items: any[] }> = [];
    for (const item of filtered) {
      const d = String(item.date || "").slice(0, 10);
      if (!d) continue;
      const label = d === todayStr ? "Today" : new Date(d + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      const bucket = buckets.find(b => b.day === label);
      if (bucket) bucket.items.push(item);
      else buckets.push({ day: label, date: d, items: [item] });
    }
    return buckets;
  }, [filtered, todayStr]);
  const daysAway = (d: string) => Math.round((new Date(d + "T00:00:00").getTime() - new Date(todayStr + "T00:00:00").getTime()) / 86400000);
  return (
    <PopupShell open={open} onClose={onClose} title={title} icon={CalendarDays}
      accent="239 84% 67%" count={filtered.length}
      subtitle={(items || []).length ? "Events, tasks and bills on your combined calendar" : undefined}
      tabs={TIMELINE_FILTERS.map(f => ({
        id: f.key, label: f.label,
        count: f.key === "all" ? (items || []).length : (items || []).filter(f.test).length,
      }))}
      activeTab={filter} onTab={(id) => setFilter(id as TimelineFilter)}
      footerLabel="Open Calendar" footerHref="/calendar">
      {days.length === 0 ? <EmptyNote label="Nothing scheduled." /> : <Windowed items={days} pageSize={20} testId="timeline" render={(d) => (
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
      )} />}
    </PopupShell>
  );
}

// ── Goals ────────────────────────────────────────────────────────────────────
export function GoalsPopup({ open, onClose, goals }: { open: boolean; onClose: () => void; goals: any[] }) {
  const { toast } = useToast();
  const owners = useOwnerNames(open);
  const [progressId, setProgressId] = useState<string | null>(null);
  const [progressVal, setProgressVal] = useState("");
  const updateGoal = useMutation({
    mutationFn: async (vars: { id: string; body: any }) => { await apiRequest("PATCH", `/api/goals/${vars.id}`, vars.body); },
    onSuccess: (_d, vars) => {
      toast({ title: vars.body.status === "completed" ? "Goal completed 🎉" : "Progress updated" });
      setProgressId(null);
      // Cache bus: goals domain also refreshes stats + dashboard-enhanced so
      // the goal KPI/section tiles move with the popup.
      invalidateDomain("goals");
    },
    onError: (e: any) => toast({ title: "Update failed", description: e?.message, variant: "destructive" }),
  });
  const rows = (goals || []).filter((g: any) => g.status === "active" || !g.status);
  const todayMs = Date.now();
  return (
    <PopupShell open={open} onClose={onClose} title="Open Projects" icon={Target}
      accent="142 70% 45%" count={rows.length}
      subtitle={rows.length ? "Active goals with live progress" : undefined}
      footerLabel="Open Goals" footerHref="/goals">
      {rows.length === 0 ? <EmptyNote label="No active goals." /> : rows.map((g: any) => {
        const pct = g.target ? Math.max(0, Math.min(100, Math.round(((g.current ?? 0) / g.target) * 100))) : null;
        const ownerNames = owners.names(g.linkedProfiles, false);
        const deadlineDays = g.deadline ? Math.round((new Date(String(g.deadline).slice(0, 10) + "T00:00:00").getTime() - todayMs) / 86400000) : null;
        const reached = (g.milestones || []).filter((m: any) => m.reached).length;
        return (
          <ExpandCard key={g.id} testId={`project-card-${g.id}`}
            urgentBorder={deadlineDays !== null && deadlineDays < 7 ? "amber" : undefined}
            summary={
              <div>
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-semibold truncate">{g.title}</span>
                  {pct !== null && <span className="ml-auto text-[11px] tabular-nums text-emerald-500 shrink-0">{pct}%</span>}
                </div>
                {pct !== null && (
                  <div className="mt-1.5 h-1 rounded-full bg-muted overflow-hidden">
                    <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                  </div>
                )}
                <div className="flex items-center flex-wrap gap-1 mt-1">
                  {g.target != null && <Chip>{g.current ?? 0} / {g.target}{g.unit ? ` ${g.unit}` : ""}</Chip>}
                  {deadlineDays !== null && <Chip tone={deadlineDays < 0 ? "neg" : deadlineDays < 7 ? "warn" : "muted"}><Clock className="h-2.5 w-2.5" />{deadlineDays < 0 ? `${Math.abs(deadlineDays)}d past due` : deadlineDays === 0 ? "due today" : `${deadlineDays}d left`}</Chip>}
                  {ownerNames && <Chip><User className="h-2.5 w-2.5" />{ownerNames}</Chip>}
                </div>
              </div>
            }>
            <div className="space-y-1.5 text-[11px] pt-1">
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground">
                <span>Started</span><span className="text-foreground">{fmtDate(g.createdAt)}</span>
                {g.deadline && (<><span>Deadline</span><span className="text-foreground">{fmtDate(g.deadline)}</span></>)}
                {(g.milestones || []).length > 0 && (<><span>Milestones</span><span className="text-foreground">{reached}/{g.milestones.length} reached</span></>)}
              </div>
              {progressId === g.id ? (
                <div className="flex items-center gap-1.5 pt-1">
                  <input type="number" value={progressVal} onChange={e => setProgressVal(e.target.value)} placeholder={`Current (${g.current ?? 0})`}
                    className="w-24 h-7 px-1.5 rounded border border-border bg-background text-xs" data-testid={`project-progress-input-${g.id}`} />
                  <ActionBtn label="Save" icon={Check} disabled={updateGoal.isPending || progressVal === ""}
                    onClick={() => updateGoal.mutate({ id: g.id, body: { current: Number(progressVal) } })} testId={`project-progress-save-${g.id}`} />
                  <ActionBtn label="Cancel" onClick={() => setProgressId(null)} />
                </div>
              ) : (
                <div className="flex items-center flex-wrap gap-1.5 pt-1">
                  <ActionBtn label="Update progress" icon={Pencil} onClick={() => { setProgressId(g.id); setProgressVal(String(g.current ?? "")); }} testId={`project-progress-${g.id}`} />
                  <ActionBtn label="Mark complete" icon={Check} disabled={updateGoal.isPending}
                    onClick={() => updateGoal.mutate({ id: g.id, body: { status: "completed" } })} testId={`project-complete-${g.id}`} />
                </div>
              )}
            </div>
          </ExpandCard>
        );
      })}
    </PopupShell>
  );
}

// ── Quick notes / journal ────────────────────────────────────────────────────
export function NotesPopup({ open, onClose, notes }: { open: boolean; onClose: () => void; notes: any[] }) {
  const owners = useOwnerNames(open);
  return (
    <PopupShell open={open} onClose={onClose} title="Quick Notes" icon={NotebookPen}
      accent="240 10% 60%" count={(notes || []).length}
      subtitle={(notes || []).length ? "Latest journal entries — tap one for the full text" : undefined}
      footerLabel="Open Journal" footerHref="/journal">
      {(notes || []).length === 0 ? <EmptyNote label="No notes yet." /> : (notes || []).map((n: any) => {
        const ownerNames = owners.names(n.linkedProfiles, false);
        const content = String(n.content || "");
        return (
          <ExpandCard key={n.id} testId={`note-card-${n.id}`}
            summary={
              <div>
                <div className="flex items-center flex-wrap gap-1">
                  <Chip><CalendarDays className="h-2.5 w-2.5" />{fmtDate(n.date || n.createdAt)}</Chip>
                  {n.mood && <Chip tone="pos">{n.mood}</Chip>}
                  {ownerNames && <Chip><User className="h-2.5 w-2.5" />{ownerNames}</Chip>}
                </div>
                <p className="text-xs mt-1 line-clamp-2 whitespace-pre-wrap break-words">{content.slice(0, 200)}</p>
              </div>
            }>
            <p className="text-xs whitespace-pre-wrap break-words pt-1">{content}</p>
          </ExpandCard>
        );
      })}
    </PopupShell>
  );
}

// ── Reminders ────────────────────────────────────────────────────────────────
export function RemindersPopup({ open, onClose, reminders }: { open: boolean; onClose: () => void; reminders: any[] }) {
  const { toast } = useToast();
  const owners = useOwnerNames(open);
  const dismiss = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/reminders/${id}`); },
    onSuccess: () => { toast({ title: "Reminder dismissed" }); queryClient.invalidateQueries({ queryKey: ["/api/reminders"] }); },
    onError: (e: any) => toast({ title: "Couldn't dismiss", description: e?.message, variant: "destructive" }),
  });
  const now = Date.now();
  const rows = (reminders || []).filter((r: any) => !r.completed && !r.dismissed)
    .slice().sort((a: any, b: any) => String(a.fireAt || a.dueDate || "").localeCompare(String(b.fireAt || b.dueDate || "")));
  const overdueCount = rows.filter((r: any) => r.fireAt && new Date(r.fireAt).getTime() < now).length;
  return (
    <PopupShell open={open} onClose={onClose} title="Reminders" icon={Bell}
      accent="43 96% 56%" count={rows.length}
      subtitle={rows.length ? (overdueCount ? `${overdueCount} already fired · shown until dismissed` : "Scheduled reminders across everyone") : undefined}
      footerLabel="Open Calendar" footerHref="/calendar">
      {rows.length === 0 ? <EmptyNote label="No reminders." /> : rows.map((r: any) => {
        const when = r.fireAt || r.dueDate;
        const fired = when && new Date(when).getTime() < now;
        const ownerName = owners.nameOf(r.profileId) || owners.names(r.linkedProfiles, false);
        return (
          <div key={r.id} className={`mb-1 rounded-md border border-border/40 border-l-2 ${fired ? "border-l-amber-500" : "border-l-transparent"} bg-card/50 px-2.5 py-1.5`} data-testid={`reminder-card-${r.id}`}>
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-xs truncate">{r.title || r.message || r.content}</p>
                <div className="flex items-center flex-wrap gap-1 mt-0.5">
                  <Chip tone={fired ? "warn" : "muted"}>
                    <Clock className="h-2.5 w-2.5" />
                    {when ? `${fmtDate(String(when).slice(0, 10))}${fmtTime(when) ? ` · ${fmtTime(when)}` : ""}` : "no time set"}
                    {fired ? " · fired" : ""}
                  </Chip>
                  {ownerName && <Chip><User className="h-2.5 w-2.5" />{ownerName}</Chip>}
                </div>
              </div>
              <ActionBtn label="Done" icon={Check} disabled={dismiss.isPending} onClick={() => dismiss.mutate(r.id)} testId={`reminder-done-${r.id}`} />
            </div>
          </div>
        );
      })}
    </PopupShell>
  );
}

// ── Attention Required ───────────────────────────────────────────────────────
// The Score replacement (2026-07-16 redesign): one popup that combines every
// urgent issue across the profile — overdue tasks, bills needing action,
// expiring documents, habits still due, critical alerts, fired reminders.
// Items are computed by ExecutiveBriefing (it already holds all the queries);
// each row's `go` closes this popup and opens the owning module's popup.
export type AttentionEntry = {
  id: string;
  title: string;
  reason: string;             // why it was flagged, human sentence
  severity: "critical" | "warning" | "info";
  group: string;              // grouped section label ("Overdue tasks", …)
  go?: () => void;            // open the owning module surface
};

export function AttentionPopup({ open, onClose, items }: {
  open: boolean; onClose: () => void; items: AttentionEntry[];
}) {
  const [filter, setFilter] = useState<"all" | "critical" | "warning">("all");
  const critical = items.filter(i => i.severity === "critical").length;
  const visible = filter === "all" ? items : items.filter(i => i.severity === filter);
  const groups: Array<{ label: string; rows: AttentionEntry[] }> = [];
  for (const i of visible) {
    const g = groups.find(x => x.label === i.group);
    if (g) g.rows.push(i); else groups.push({ label: i.group, rows: [i] });
  }
  const pills: Array<{ key: typeof filter; label: string }> = [
    { key: "all", label: `All · ${items.length}` },
    { key: "critical", label: `Urgent · ${critical}` },
    { key: "warning", label: `Upcoming · ${items.length - critical}` },
  ];
  return (
    <PopupShell open={open} onClose={onClose} title="Attention Required" icon={AlertTriangle}
      accent="0 72% 58%" count={items.length}
      subtitle={items.length ? `${critical} urgent · ${items.length - critical} upcoming — everything that needs review, in one place` : undefined}>
      <div className="flex items-center gap-1 px-1 pt-1 pb-1.5">
        {pills.map(p => (
          <button key={p.key} onClick={() => setFilter(p.key)} data-testid={`attention-filter-${p.key}`}
            className={`text-[10px] font-medium px-2 py-0.5 rounded-full border transition-colors ${
              filter === p.key ? "border-red-500/50 bg-red-500/10 text-red-500" : "border-border text-muted-foreground hover:bg-muted"}`}>
            {p.label}
          </button>
        ))}
      </div>
      {visible.length === 0 ? <EmptyNote label={items.length === 0 ? "Nothing needs your attention. 🎉" : "Nothing in this filter."} /> :
        groups.map(g => (
          <div key={g.label}>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-1 pt-2 pb-1">
              {g.label} · {g.rows.length}
            </div>
            {g.rows.map(i => (
              <div key={i.id} data-testid={`attention-item-${i.id}`}
                className={`mb-1 rounded-md border border-border/40 border-l-2 ${i.severity === "critical" ? "border-l-red-500" : "border-l-amber-500"} bg-card/50 px-2.5 py-1.5`}>
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{i.title}</p>
                    <div className="flex items-center flex-wrap gap-1 mt-0.5">
                      <Chip tone={i.severity === "critical" ? "neg" : "warn"}>{i.reason}</Chip>
                    </div>
                  </div>
                  {i.go && <ActionBtn label="Open" icon={ArrowRight} onClick={i.go} testId={`attention-open-${i.id}`} />}
                </div>
              </div>
            ))}
          </div>
        ))}
    </PopupShell>
  );
}

// ── Today's Overview ─────────────────────────────────────────────────────────
// The full-width executive popup: everything happening TODAY — tasks, events,
// bills, habits, reminders — merged into one Morning/Afternoon/Evening/Anytime
// timeline, plus alerts and a tomorrow preview. Rows open their module popup.
export type TodayEntry = {
  id: string;
  title: string;
  kind: string;               // task | event | bill | obligation | habit | reminder
  time?: string | null;       // bare HH:MM when scheduled, null = anytime
  done?: boolean;
  urgent?: boolean;
  go?: () => void;
};

const KIND_TONE: Record<string, "neg" | "warn" | "pos" | "muted"> = {
  bill: "neg", obligation: "neg", reminder: "warn", habit: "pos",
};

function TodayRow({ e }: { e: TodayEntry }) {
  return (
    <button onClick={e.go} disabled={!e.go} data-testid={`today-row-${e.id}`}
      className={`w-full flex items-baseline gap-2 px-2.5 py-1.5 mb-1 rounded-md border border-border/40 bg-card/50 text-left ${e.go ? "hover:bg-muted/30" : ""}`}>
      <span className="text-[10px] uppercase text-muted-foreground w-14 shrink-0 truncate tabular-nums">{e.time ? fmtClock(e.time) : ""}</span>
      <span className={`flex-1 text-xs truncate ${e.done ? "line-through text-muted-foreground" : e.urgent ? "text-red-500 font-medium" : ""}`}>
        {e.done ? "✓ " : ""}{e.title}
      </span>
      <Chip tone={e.done ? "muted" : KIND_TONE[e.kind] || "muted"}>{e.kind}</Chip>
    </button>
  );
}

export function TodayOverviewPopup({ open, onClose, entries, tomorrow, completedTasks, alerts }: {
  open: boolean; onClose: () => void;
  entries: TodayEntry[];      // everything scheduled today (habits incl. done)
  tomorrow: TodayEntry[];     // preview of tomorrow's calendar
  completedTasks: number;     // tasks completed today (not in `entries`)
  alerts: string[];           // critical attention headlines
}) {
  const hourOf = (t?: string | null) => { const m = /^(\d{1,2}):/.exec(String(t || "")); return m ? parseInt(m[1], 10) : null; };
  const byTime = (a: TodayEntry, b: TodayEntry) => String(a.time || "99").localeCompare(String(b.time || "99"));
  const remaining = entries.filter(e => !e.done);
  const doneCount = entries.filter(e => e.done).length + completedTasks;
  const nowClock = new Date().toTimeString().slice(0, 5);
  const timed = remaining.filter(e => e.time).sort(byTime);
  const next = timed.find(e => String(e.time) >= nowClock) || remaining.find(e => !e.time) || timed[timed.length - 1];
  const buckets: Array<{ label: string; test: (h: number | null) => boolean }> = [
    { label: "Morning", test: h => h !== null && h < 12 },
    { label: "Afternoon", test: h => h !== null && h >= 12 && h < 17 },
    { label: "Evening", test: h => h !== null && h >= 17 },
    { label: "Anytime", test: h => h === null },
  ];
  const dateLabel = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  return (
    <PopupShell open={open} onClose={onClose} title="Today's Overview" icon={CalendarDays}
      accent="262 80% 66%" count={entries.length}
      subtitle={`${dateLabel} · ${remaining.length} remaining · ${doneCount} done`}
      footerLabel="Open Calendar" footerHref="/calendar">
      {alerts.length > 0 && (
        <div className="mb-1.5 rounded-md border border-red-500/30 bg-red-500/5 px-2.5 py-1.5" data-testid="today-alerts">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-red-500 mb-0.5">Important alerts</p>
          {alerts.slice(0, 3).map((a, i) => <p key={i} className="text-xs text-red-500 truncate">⚠ {a}</p>)}
        </div>
      )}
      {next && (
        <div className="mb-1.5 rounded-md border px-2.5 py-1.5" data-testid="today-next"
          style={{ borderColor: "hsl(262 80% 66% / 0.35)", background: "hsl(262 80% 66% / 0.08)" }}>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-0.5">Next action</p>
          <p className="text-xs font-medium truncate" style={{ color: "hsl(262 80% 66%)" }}>
            {next.title}{next.time ? ` · ${fmtClock(next.time)}` : ""}
          </p>
        </div>
      )}
      {entries.length === 0 ? <EmptyNote label="Nothing scheduled today." /> :
        buckets.map(b => {
          const rows = entries.filter(e => b.test(hourOf(e.time))).sort(byTime);
          if (rows.length === 0) return null;
          return (
            <div key={b.label}>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-1 pt-2 pb-1">{b.label} · {rows.length}</div>
              {rows.map(e => <TodayRow key={e.id} e={e} />)}
            </div>
          );
        })}
      {tomorrow.length > 0 && (
        <div data-testid="today-tomorrow">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-1 pt-2 pb-1">Tomorrow preview · {tomorrow.length}</div>
          {tomorrow.map(e => <TodayRow key={e.id} e={e} />)}
        </div>
      )}
    </PopupShell>
  );
}
