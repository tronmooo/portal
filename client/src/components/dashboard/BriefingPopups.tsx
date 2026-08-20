// ── Executive-briefing detail popups (2026-07-15 v2) ─────────────────────────
// Every stat tile / section row on the briefing opens one of these in place.
// v2 (user request): "more detailed, useful, and visually polished … not
// simple placeholder boxes". Each popup now shows what the item is, who it
// belongs to, its important dates, current status, related records, and REAL
// in-place actions (pay/skip/edit/delete/renew/dismiss) — not just nav links.
// TasksPopup/HabitsPopup already live in TaskHabitPopups.tsx.
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { BubbleModal } from "@/components/ui/bubble-modal";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { addMonthsClamped, addYearsClamped, toISODate } from "@shared/date-math";
import { useToast } from "@/hooks/use-toast";
import { loadDocSnoozeMap, saveDocSnoozeMap } from "@/lib/docSnooze";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  // (kept for the confirm dialogs below)
} from "@/components/ui/dialog";
import {
  AlertTriangle, ArrowRight, BellOff, CalendarDays, Check, ChevronDown,
  Clock, CreditCard, FileText, MapPin, Pencil, RefreshCw,
  Trash2, User,
  Receipt, Wifi, Phone, Music, Tv, Droplets, Zap, Car, ShieldCheck, Home,
  Flame, Dumbbell, Pill as PillIcon, Plus, CircleDollarSign, CheckCircle2,
  type LucideIcon,
} from "lucide-react";
import { QuickAddDialog } from "@/components/dashboard/quick-add/QuickAddDialog";
import { formatMoney } from "@/lib/format";
import { useProfileScope } from "@/hooks/useProfileScope";
import { useShowTestData } from "@/lib/showTestData";
import { isTestDataRow } from "@shared/test-data";

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
// PopupShell is now BubbleModal — this file used to hand-roll a fourth popup
// header (a glowing dot, a bare icon, a 14px title) alongside the finance
// heroes, the ModalShell chip and the hub tabs' medallion. The signature is
// unchanged so the three popups below didn't move.
function PopupShell({ open, onClose, title, icon, accent, count, subtitle, footerLabel, footerHref, children }: {
  open: boolean; onClose: () => void; title: string; icon: any; accent: string;
  count?: number; subtitle?: string; footerLabel?: string; footerHref?: string; children: React.ReactNode;
}) {
  return (
    <BubbleModal
      open={open} onClose={onClose} title={title} icon={icon} accent={accent}
      count={count} subtitle={subtitle} footerLabel={footerLabel} footerHref={footerHref}
    >
      {children}
    </BubbleModal>
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
  return <span className={`inline-flex items-center gap-0.5 text-[11px] px-1.5 py-px rounded-full font-medium ${cls}`}>{children}</span>;
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

// ── Bills ────────────────────────────────────────────────────────────────────
// Redesigned 2026-08-13 to the user's reference mock: a four-stat header
// (Total Due · Due Soon · Overdue · Paid), filter chips, and icon rows with a
// status badge — each row expands in place into the full detail card
// (recurrence, owners, payment history, Mark-paid / Skip / Edit / Delete).
//
// Row source: enhanced.financeSnapshot.upcomingBills (30-day window), enriched
// from /api/obligations. The Paid tab is derived from obligation payments
// recorded this calendar month, so paying a bill anywhere moves it here.

/** Icon + tint for a bill, recognised from its name/category the way the mock
 *  draws them (wifi for internet, a droplet for water, …). Order matters:
 *  "Car Insurance" is a car before it is an insurance. */
const BILL_VISUALS: Array<[RegExp, LucideIcon, string]> = [
  [/internet|wifi|comcast|broadband|fiber|isp/i, Wifi, "199 89% 60%"],
  [/phone|mobile|verizon|t-?mobile|at&t|cellular/i, Phone, "155 65% 45%"],
  [/spotify|music|audible|podcast/i, Music, "141 73% 45%"],
  [/netflix|hulu|disney|hbo|stream|cable|tv/i, Tv, "262 70% 62%"],
  [/water|sewer/i, Droplets, "199 89% 60%"],
  [/electric|power|energy|pg&e|utilit/i, Zap, "48 96% 53%"],
  [/car|auto|vehicle/i, Car, "217 91% 65%"],
  [/insurance|coverage|policy/i, ShieldCheck, "217 91% 65%"],
  [/rent|mortgage|hoa|home/i, Home, "25 95% 58%"],
  [/gas|fuel|propane/i, Flame, "25 95% 58%"],
  [/gym|fitness|club/i, Dumbbell, "155 65% 45%"],
  [/medic|pharma|prescription|rx|health/i, PillIcon, "350 85% 62%"],
  [/loan|credit|card|debt/i, CreditCard, "0 72% 58%"],
];
function billVisual(name: any, category: any): { Icon: LucideIcon; hsl: string } {
  const hay = `${name || ""} ${category || ""}`;
  const hit = BILL_VISUALS.find(([re]) => re.test(hay));
  return hit ? { Icon: hit[1], hsl: hit[2] } : { Icon: Receipt, hsl: "155 65% 45%" };
}

/** One of the four headline tiles at the top of the popup. */
function BillStat({ icon: Icon, accent, label, value, sub, testId }: {
  icon: LucideIcon; accent: string; label: string; value: string; sub: string; testId?: string;
}) {
  return (
    <div className="bubble px-2.5 py-2.5" style={{ ["--accent-hsl" as any]: accent }} data-testid={testId}>
      <span
        className="inline-flex h-8 w-8 items-center justify-center rounded-full mb-1.5"
        style={{ background: `hsl(${accent} / 0.15)`, color: `hsl(${accent})` }}
        aria-hidden="true"
      >
        <Icon className="h-4 w-4" strokeWidth={2.2} />
      </span>
      <p className="text-[11px] text-muted-foreground leading-tight">{label}</p>
      <p className="text-[15px] font-extrabold tabular-nums leading-tight" style={{ color: `hsl(${accent})` }}>{value}</p>
      <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">{sub}</p>
    </div>
  );
}

/** The mock's right-hand status column: a tone badge over a small caption. */
function BillStatus({ status, daysUntil, paidDate }: { status: string; daysUntil: number | null; paidDate?: string }) {
  let label = "Upcoming", tone = "bg-muted text-muted-foreground", sub = "";
  if (status === "paid") {
    label = "Paid"; tone = "bg-emerald-500/15 text-emerald-500";
    sub = paidDate ? fmtDate(paidDate) : "";
  } else if (status === "overdue" || (daysUntil != null && daysUntil < 0)) {
    label = "Overdue"; tone = "bg-red-500/15 text-red-500";
    const ago = Math.abs(daysUntil ?? 0);
    sub = ago === 1 ? "1 day overdue" : `${ago} days overdue`;
  } else if (daysUntil === 0) {
    label = "Due Today"; tone = "bg-amber-500/15 text-amber-500"; sub = "today";
  } else if (daysUntil != null && daysUntil <= 7) {
    label = "Due Soon"; tone = "bg-violet-500/15 text-violet-400";
    sub = daysUntil === 1 ? "tomorrow" : `in ${daysUntil} days`;
  } else if (daysUntil != null) {
    sub = `in ${daysUntil} days`;
  }
  return (
    <div className="flex flex-col items-end gap-0.5 shrink-0 w-[86px]">
      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{label}</span>
      {sub && <span className={`text-[11px] ${label === "Overdue" ? "text-red-500" : "text-muted-foreground"}`}>{sub}</span>}
    </div>
  );
}

type BillFilter = "all" | "soon" | "overdue" | "paid";

const normName = (s: any) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Display-level bill dedupe: "Verizon Phone Bill payment" and "Phone Bill
 *  payment" at the same $86.50 are one bill entered twice. Collapses rows only
 *  when the amounts match exactly AND the normalized names match or nest —
 *  "rent the 1st" ($2,500) vs "rent" ($300) stays two rows for the user to
 *  reconcile. The row with the more specific (longer) name survives. */
export function dedupeBills(rows: any[]): any[] {
  const out: any[] = [];
  for (const b of rows || []) {
    const n = normName(b.name);
    const idx = out.findIndex(o => Number(o.amount) === Number(b.amount) && (() => {
      const m = normName(o.name);
      return m === n || (n && m && (m.includes(n) || n.includes(m)));
    })());
    if (idx === -1) out.push(b);
    else if (n.length > normName(out[idx].name).length) out[idx] = b;
  }
  return out;
}

/**
 * THE Bills UI (user rule 2026-08-13: one data type = one canonical UI).
 * Rendered full-page on /dashboard/obligations and inside BillsPopup from the
 * Executive tab — the same component, so there is exactly one Bills interface
 * in the app. `bills` may be passed by a caller that already holds the
 * (deduped, test-filtered) rows; without it the view fetches its own from the
 * scoped finance snapshot.
 */
export function BillsView({ bills, onViewAll }: { bills?: any[]; onViewAll?: () => void }) {
  const { toast } = useToast();
  const owners = useOwnerNames();
  // (navigation out of the view is the caller's business — see onViewAll)
  const scope = useProfileScope();
  const scopeParam = scope.mode === "selected" && scope.selectedIds.length > 0 ? `?profileIds=${scope.selectedIds.join(",")}` : "";
  const showTestData = useShowTestData();
  // Self-fetch fallback for the full-page route — same cache slot the
  // dashboard fills, so on the happy path this is a cache hit.
  const { data: enhanced } = useQuery<any>({
    queryKey: ["/api/dashboard-enhanced", scope.mode, ...scope.selectedIds],
    queryFn: async () => (await apiRequest("GET", `/api/dashboard-enhanced${scopeParam}`)).json(),
    enabled: bills === undefined,
    staleTime: 30_000,
  });
  const sourceBills = useMemo(
    () => bills ?? dedupeBills((enhanced?.financeSnapshot?.upcomingBills || [])
      .filter((b: any) => showTestData || !isTestDataRow(b?.name))),
    [bills, enhanced, showTestData]);
  const { data: obligationsRaw } = useQuery<any[]>({ queryKey: ["/api/obligations"], staleTime: 30_000 });
  const obById = useMemo(() => new Map((Array.isArray(obligationsRaw) ? obligationsRaw : []).map((o: any) => [o.id, o])), [obligationsRaw]);
  const [editId, setEditId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [editDue, setEditDue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [filter, setFilter] = useState<BillFilter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

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

  const rows = useMemo(() => (sourceBills || []).slice().sort((a, b) => (a.daysUntil ?? 1e9) - (b.daysUntil ?? 1e9)), [sourceBills]);
  const monthStr = new Date().toLocaleDateString("en-CA").slice(0, 7);

  // Paid this month — from obligation payments, the same ledger Mark-as-paid
  // writes, so paying a bill anywhere moves it onto this tab immediately.
  const paidRows = useMemo(() => {
    const out: any[] = [];
    for (const o of (Array.isArray(obligationsRaw) ? obligationsRaw : [])) {
      const pays = (Array.isArray(o?.payments) ? o.payments : [])
        .filter((p: any) => String(p?.date || "").slice(0, 7) === monthStr)
        .sort((a: any, b: any) => String(b.date || "").localeCompare(String(a.date || "")));
      if (pays.length === 0) continue;
      out.push({
        id: o.id, name: o.name || "Bill",
        amount: Number(pays[0].amount ?? o.amount) || 0,
        paidTotal: pays.reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0),
        paidDate: String(pays[0].date || "").slice(0, 10),
        category: o.category || o.kind, status: "paid", daysUntil: null,
        dueDate: o.nextDueDate,
      });
    }
    return out.sort((a, b) => String(b.paidDate).localeCompare(String(a.paidDate)));
  }, [obligationsRaw, monthStr]);

  const soonRows = rows.filter((b) => typeof b.daysUntil === "number" && b.daysUntil >= 0 && b.daysUntil <= 7);
  const overdueRows = rows.filter((b) => b.status === "overdue" || (typeof b.daysUntil === "number" && b.daysUntil < 0));
  const sum = (xs: any[], k = "amount") => xs.reduce((s, b) => s + (Number(b[k]) || 0), 0);
  const totalDue = sum(rows);
  const paidTotal = paidRows.reduce((s, b) => s + b.paidTotal, 0);
  const money = formatMoney;

  const FILTERS: Array<{ id: BillFilter; label: string; count?: number }> = [
    { id: "all", label: "All Bills" },
    { id: "soon", label: "Due Soon", count: soonRows.length },
    { id: "overdue", label: "Overdue", count: overdueRows.length },
    { id: "paid", label: "Paid", count: paidRows.length },
  ];
  const visible = filter === "soon" ? soonRows : filter === "overdue" ? overdueRows : filter === "paid" ? paidRows : rows;

  // The expandable detail card under a row — recurrence, links, history, and
  // the real in-place actions. Identical write paths to the previous popup.
  const renderDetail = (b: any) => {
    const full = obById.get(b.id) || {};
    const freq = full.frequency || "monthly";
    const payments: any[] = Array.isArray(full.payments) ? full.payments.slice().sort((x: any, y: any) => String(y.date || "").localeCompare(String(x.date || ""))) : [];
    const ownerNames = owners.names(full.linkedProfiles);
    const assetName = owners.nameOf(full.linkedAssetId);
    const liabilityName = owners.nameOf(full.linkedLiabilityId);
    const due = String(b.dueDate || full.nextDueDate || "").slice(0, 10);
    const upcoming: string[] = [];
    let cursor: string | null = due;
    for (let i = 0; i < 3 && cursor; i++) {
      cursor = addFrequency(cursor, freq);
      if (!cursor) break;
      if (full.recurrenceEnd && cursor > String(full.recurrenceEnd).slice(0, 10)) break;
      upcoming.push(cursor);
    }
    let remaining: number | null = null;
    if (full.recurrenceEnd && freq !== "once") {
      let c: string | null = due; remaining = 0;
      const end = String(full.recurrenceEnd).slice(0, 10);
      while (c && c <= end && remaining < 500) { remaining++; c = addFrequency(c, freq); }
    }
    return (
      <div className="px-3 pb-2.5 pt-1 border-t border-border/30 space-y-1.5 text-[11px]">
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 pt-1 text-muted-foreground">
          <span>Category</span><span className="text-foreground capitalize">{b.category || full.category || "general"}</span>
          <span>Frequency</span><span className="text-foreground">{FREQ_LABEL[freq] || freq}</span>
          <span>Status</span>
          <span className="text-foreground">
            {b.status === "paid" ? `Paid ${fmtDate(b.paidDate)}`
              : b.status === "overdue" ? "Overdue — payment missed"
              : b.daysUntil === 0 ? "Due today" : "Scheduled"}
          </span>
          {due && (<><span>{b.status === "paid" ? "Next due" : "Due date"}</span><span className="text-foreground">{fmtDate(due)}</span></>)}
          {b.autopay && (<><span>Autopay</span><span className="text-emerald-500">on</span></>)}
          {full.status === "paused" && (<><span>Series</span><span className="text-amber-500">paused</span></>)}
          {ownerNames && (<><span>Owner</span><span className="text-foreground">{ownerNames}</span></>)}
          {remaining !== null && (<><span>Payments left</span><span className="text-foreground">{remaining} (ends {fmtDate(full.recurrenceEnd)})</span></>)}
          {assetName && (<><span>Linked asset</span><span className="text-foreground">{assetName}</span></>)}
          {liabilityName && (<><span>Linked liability</span><span className="text-foreground">{liabilityName}</span></>)}
        </div>
        {upcoming.length > 0 && (
          <div>
            <p className="micro-label text-muted-foreground mb-0.5">Upcoming</p>
            {upcoming.map(d => <div key={d} className="flex justify-between"><span>{fmtDate(d)}</span><span className="tabular-nums">${Number(b.amount).toLocaleString()}</span></div>)}
          </div>
        )}
        <div>
          <p className="micro-label text-muted-foreground mb-0.5">Payment history</p>
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
            {b.status !== "paid" && (
              <ActionBtn label="Mark as paid" icon={Check} disabled={payBill.isPending} onClick={() => payBill.mutate(b.id)} testId={`popup-pay-${b.id}`} />
            )}
            {b.status !== "paid" && (
              <ActionBtn label="Skip payment" icon={RefreshCw} disabled={skipBill.isPending} onClick={() => skipBill.mutate(b)} testId={`popup-skip-${b.id}`} />
            )}
            <ActionBtn label="Edit" icon={Pencil} onClick={() => { setEditId(b.id); setEditAmount(String(b.amount ?? "")); setEditDue(due); }} testId={`popup-edit-${b.id}`} />
            <ActionBtn label="Delete" icon={Trash2} danger onClick={() => setConfirmDeleteId(b.id)} testId={`popup-delete-${b.id}`} />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-2" data-testid="bills-view">
      {/* The four headline stats from the mock. */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <BillStat icon={CircleDollarSign} accent="155 65% 45%" label="Total Due" value={money(totalDue)} sub="This Month" testId="bills-stat-total" />
          <BillStat icon={CalendarDays} accent="262 70% 62%" label="Due Soon" value={money(sum(soonRows))} sub="Next 7 Days" testId="bills-stat-soon" />
          <BillStat icon={AlertTriangle} accent="25 95% 58%" label="Overdue" value={money(sum(overdueRows))} sub={`${overdueRows.length} Bill${overdueRows.length === 1 ? "" : "s"}`} testId="bills-stat-overdue" />
          <BillStat icon={CheckCircle2} accent="217 91% 65%" label="Paid" value={money(paidTotal)} sub="This Month" testId="bills-stat-paid" />
        </div>

        {/* Filter chips. */}
        <div className="flex items-center gap-1.5 flex-wrap pt-1">
          {FILTERS.map(f => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              data-testid={`bills-filter-${f.id}`}
              aria-pressed={filter === f.id}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                filter === f.id ? "bg-emerald-500/15 text-emerald-500" : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {f.label}
              {typeof f.count === "number" && f.count > 0 && (
                <span className={`rounded-full px-1.5 py-px text-[11px] font-bold tabular-nums ${
                  f.id === "overdue" ? "bg-red-500/20 text-red-500" : f.id === "soon" ? "bg-violet-500/20 text-violet-400" : "bg-muted text-muted-foreground"
                }`}>{f.count}</span>
              )}
            </button>
          ))}
        </div>

        {/* Rows — tap to expand into the full detail card. */}
        {visible.length === 0 ? (
          <EmptyNote label={filter === "paid" ? "Nothing paid yet this month." : filter === "overdue" ? "Nothing overdue — nice." : "No bills in this view."} />
        ) : (
          <div className="bubble divide-y divide-border/30 overflow-hidden" style={{ ["--accent-hsl" as any]: "155 65% 45%" }}>
            {visible.map((b: any) => {
              const { Icon, hsl } = billVisual(b.name, b.category || obById.get(b.id)?.category);
              const rowOpen = expandedId === `${filter}:${b.id}`;
              const due = String(b.dueDate || obById.get(b.id)?.nextDueDate || "").slice(0, 10);
              return (
                <div key={`${filter}:${b.id}`} data-testid={`bill-card-${b.id}`}>
                  <button
                    onClick={() => setExpandedId(rowOpen ? null : `${filter}:${b.id}`)}
                    aria-expanded={rowOpen}
                    className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/30 transition-colors"
                    data-testid={`bill-row-${b.id}`}
                  >
                    <span
                      className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0"
                      style={{ background: `hsl(${hsl} / 0.15)`, color: `hsl(${hsl})` }}
                      aria-hidden="true"
                    >
                      <Icon className="h-[18px] w-[18px]" strokeWidth={2.1} />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[14px] font-semibold leading-tight truncate">{b.name}</span>
                      <span className="block text-[11px] text-muted-foreground capitalize truncate mt-0.5">
                        {b.category || obById.get(b.id)?.category || obById.get(b.id)?.kind || "bill"}
                      </span>
                    </span>
                    <span className="text-right shrink-0">
                      <span className="block text-[14px] font-bold tabular-nums">{money(Number(b.amount) || 0)}</span>
                      <span className={`block text-[11px] mt-0.5 ${b.status === "overdue" ? "text-red-500" : "text-muted-foreground"}`}>
                        {b.status === "paid" ? fmtDate(b.paidDate) : due ? fmtDate(due) : ""}
                      </span>
                    </span>
                    <BillStatus status={b.status} daysUntil={b.daysUntil} paidDate={b.paidDate} />
                    <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${rowOpen ? "rotate-180" : ""}`} aria-hidden="true" />
                  </button>
                  {rowOpen && renderDetail(b)}
                </div>
              );
            })}
          </div>
        )}

      {/* Bottom actions — Add Bill everywhere; View All only when embedded
          somewhere that isn't already the full Bills page. */}
      <div className="flex items-center justify-between gap-2 pt-1">
        <button
          onClick={() => setAddOpen(true)}
          className="pressable inline-flex items-center gap-1.5 text-[13px] font-semibold text-emerald-500"
          data-testid="bills-add"
        >
          <Plus className="h-4 w-4" /> Add Bill
        </button>
        {onViewAll && (
          <button
            onClick={onViewAll}
            className="pressable inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted-foreground hover:text-foreground"
            data-testid="bills-view-all"
          >
            View All Bills <ArrowRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {addOpen && <QuickAddDialog open kind="bill" onClose={() => setAddOpen(false)} />}
    </div>
  );
}

/** The Bills UI in a modal — the Executive tab's quick drill-down. Same
 *  BillsView as the /dashboard/obligations page; only the frame differs. */
export function BillsPopup({ open, onClose, bills }: { open: boolean; onClose: () => void; bills?: any[] }) {
  const [, navigate] = useLocation();
  return (
    <BubbleModal
      open={open} onClose={onClose} title="Bills" icon={Receipt}
      accent="155 65% 45%" width="lg"
      subtitle="Track and manage your bills"
      testId="bills-popup"
    >
      <BillsView bills={bills} onViewAll={() => { onClose(); navigate("/dashboard/obligations"); }} />
    </BubbleModal>
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

  /** Where this expiration's record actually lives. */
  const recordHref = (row: any): string =>
    String(row?.href || "").replace(/^#/, "") || `/documents/${row?.documentId}`;

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
              {/* This list is no longer documents-only: an expiration can be
                  carried by a PROFILE (a passport typed onto a person), and
                  `/documents/<profileId>` is not a page. The row carries the
                  link to its own record. */}
              <ActionBtn label="View" icon={FileText} onClick={() => { onClose(); navigate(recordHref(d)); }} testId={`doc-view-${d.documentId}`} />
              <ActionBtn label="Edit" icon={Pencil} onClick={() => { onClose(); navigate(recordHref(d)); }} testId={`doc-edit-${d.documentId}`} />
              {/* "Renewed" PATCHes the DOCUMENT's extractedData, so it is only
                  offered for a row a document actually owns. A profile-carried
                  expiration is edited on the profile, which Edit opens. */}
              {d.sourceEntityType !== "profile" && (
                <ActionBtn label="Renewed — set new date" icon={RefreshCw} onClick={() => { setRenewId(d.documentId); setRenewDate(""); }} testId={`doc-renew-${d.documentId}`} />
              )}
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
          <div className={`micro-label px-1 pt-2 pb-1 ${band.tone === "neg" ? "text-red-500" : band.tone === "warn" ? "text-amber-500" : "text-muted-foreground"}`}>
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
            <span className="micro-label text-muted-foreground">{d.day}</span>
            <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{daysAway(d.date) === 0 ? "" : `in ${daysAway(d.date)}d`}</span>
          </div>
          {d.items.map((i: any) => {
            const ownerNames = owners.names(i.linkedProfiles, false);
            const urgent = i.type === "bill" || i.type === "obligation";
            return (
              <div key={i.id} className="mb-1 rounded-md border border-border/40 bg-card/50 px-2.5 py-1.5">
                <div className="flex items-baseline gap-2">
                  <span className="text-[11px] uppercase text-muted-foreground w-14 shrink-0 truncate">{i.time || (i.allDay ? "all day" : "")}</span>
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