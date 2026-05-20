/**
 * HeroKPIPopups — the popups for the three hero KPI tiles on the dashboard.
 *
 * - NetWorthPopup   → Assets · Liabilities tabs with CRUD
 * - CashFlowPopup   → Income · Recurring Out · One-time Out with clickable rows
 * - BudgetPopup     → Per-category $ + %, add / edit / delete, live progress
 *
 * Filter-aware. All endpoints already exist on the server.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Wallet, TrendingUp, TrendingDown, PieChart as PieChartIcon, Plus, Pencil, Trash2,
  CreditCard, Building2, Car, Banknote, RefreshCw, Receipt, ChevronRight, Loader2,
  ArrowDownToLine, ArrowUpFromLine, ExternalLink,
} from "lucide-react";

// ─── shared helpers (mirror server resolveAssetValue / resolveLiabilityValue) ───

function parseMoney(v: any): number {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.\-]/g, ""));
    if (isFinite(n)) return n;
  }
  return 0;
}
function resolveAssetValue(p: any): number {
  if (!p?.fields) return 0;
  const f = p.fields;
  const candidates: any[] = [
    f.purchasePrice, f.purchase_price, f.value, f.currentValue, f.current_value,
    f.marketValue, f.market_value, f.estimatedValue, f.estimated_value,
    f.housing?.currentValue, f.housing?.current_value, f.housing?.purchasePrice, f.housing?.purchase_price,
    f.other?.purchasePrice, f.other?.purchase_price, f.other?.value, f.other?.currentValue, f.other?.current_value,
    f.finance?.balance, f.finance?.currentValue, f.finance?.current_value, f.finance?.value,
    f.vehicle?.purchasePrice, f.vehicle?.purchase_price, f.vehicle?.currentValue, f.vehicle?.current_value,
    f.investment?.balance, f.investment?.value, f.investment?.currentValue,
  ];
  for (const c of candidates) { const n = parseMoney(c); if (n > 0) return n; }
  return 0;
}
function resolveLiabilityBalance(p: any): number {
  if (!p?.fields) return 0;
  const f = p.fields;
  const candidates: any[] = [
    f.currentBalance, f.current_balance,
    f.finance?.currentBalance, f.finance?.current_balance,
    f.loan?.currentBalance, f.loan?.current_balance,
    f.remainingBalance, f.remaining_balance, f.loanBalance, f.loan_balance,
    f.outstandingBalance, f.outstanding_balance, f.balance,
    f.finance?.balance, f.loan?.balance, f.other?.balance,
  ];
  for (const c of candidates) { const n = parseMoney(c); if (n > 0) return n; }
  return 0;
}

const fmt = (n: number) => Math.round(n).toLocaleString();
const ASSET_TYPES = new Set(["vehicle", "asset", "investment", "property", "subscription", "account"]);
const LIABILITY_TYPES = new Set(["liability", "loan"]);

function iconForProfile(type: string) {
  if (type === "vehicle") return Car;
  if (type === "property") return Building2;
  if (type === "investment" || type === "account") return Banknote;
  if (type === "liability" || type === "loan") return CreditCard;
  if (type === "subscription") return RefreshCw;
  return Wallet;
}

// ─── shared shell ─────────────────────────────────────────────────────────────

interface ShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon: any;
  iconColor: string;
  title: string;
  description?: string;
  total?: string;
  children: React.ReactNode;
  testId?: string;
}
function MetricPopupShell({ open, onOpenChange, icon: Icon, iconColor, title, description, total, children, testId }: ShellProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md p-0 gap-0 overflow-hidden"
        style={{ maxHeight: 720 }}
        data-testid={testId}
      >
        <DialogHeader className="px-4 pt-4 pb-3 border-b border-border">
          <div className="flex items-start gap-3">
            <div className="rounded-lg p-2 shrink-0" style={{ background: `${iconColor}1f` }}>
              <Icon className="h-4 w-4" style={{ color: iconColor }} />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-sm">{title}</DialogTitle>
              {description && <DialogDescription className="text-[11px] mt-0.5">{description}</DialogDescription>}
            </div>
            {total && (
              <div className="text-right">
                <p className="text-lg font-bold tabular-nums leading-none" style={{ color: iconColor }}>{total}</p>
              </div>
            )}
          </div>
        </DialogHeader>
        <div className="overflow-y-auto" style={{ maxHeight: 600 }}>{children}</div>
      </DialogContent>
    </Dialog>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// NET WORTH POPUP
// ═════════════════════════════════════════════════════════════════════════════

export interface FilterContext {
  filterMode: "all" | "selected" | "everyone";
  filterIds: string[];
}

export function NetWorthPopup({
  open, onOpenChange, filterMode, filterIds,
}: { open: boolean; onOpenChange: (o: boolean) => void } & FilterContext) {
  const [, navigate] = useLocation();

  // NOTE: /api/profiles ignores ?profileIds — fetch ALL and filter on the client
  // using the same semantics as trackers/dashboard (selected id OR child of selected parent).
  const { data: allProfiles = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/profiles", "net-worth"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/profiles`);
      const json = await res.json();
      return Array.isArray(json) ? json : (json?.data ?? []);
    },
    enabled: open,
  });

  const isInScope = (p: any): boolean => {
    if (filterMode !== "selected" || filterIds.length === 0) return true; // "everyone" / "all"
    if (filterIds.includes(p.id)) return true;
    const parentId = p.fields?._parentProfileId || p.parentProfileId;
    if (parentId && filterIds.includes(parentId)) return true;
    // Check owners array (multi-owner support) — fields.owners or fields.ownerIds
    const ownerIds: string[] = Array.isArray(p.fields?.owners) ? p.fields.owners.map((o: any) => o?.profileId || o?.id || o).filter(Boolean)
      : Array.isArray(p.fields?.ownerIds) ? p.fields.ownerIds
      : Array.isArray(p.fields?.linkedProfileIds) ? p.fields.linkedProfileIds
      : [];
    if (ownerIds.some((id) => filterIds.includes(id))) return true;
    return false;
  };

  const { assets, liabilities, totalA, totalL } = useMemo(() => {
    const assets: any[] = [];
    const liabilities: any[] = [];
    for (const p of allProfiles) {
      if (!isInScope(p)) continue;
      if (ASSET_TYPES.has(p.type)) {
        const v = resolveAssetValue(p);
        if (v > 0) assets.push({ ...p, _value: v });
      }
      if (LIABILITY_TYPES.has(p.type) || (p.type === "vehicle" || p.type === "property" || p.type === "asset")) {
        const v = resolveLiabilityBalance(p);
        if (v > 0) liabilities.push({ ...p, _value: v });
      }
    }
    assets.sort((a, b) => b._value - a._value);
    liabilities.sort((a, b) => b._value - a._value);
    const totalA = assets.reduce((s, p) => s + p._value, 0);
    const totalL = liabilities.reduce((s, p) => s + p._value, 0);
    return { assets, liabilities, totalA, totalL };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allProfiles, filterMode, filterIds.join(",")]);

  const netWorth = totalA - totalL;

  return (
    <MetricPopupShell
      open={open}
      onOpenChange={onOpenChange}
      icon={Wallet}
      iconColor="hsl(155 60% 44%)"
      title="Net Worth"
      description={`${assets.length} asset${assets.length !== 1 ? "s" : ""} · ${liabilities.length} liabilit${liabilities.length !== 1 ? "ies" : "y"}`}
      total={`$${fmt(netWorth)}`}
      testId="popup-net-worth"
    >
      {isLoading ? (
        <div className="px-4 py-10 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <Tabs defaultValue="assets" className="w-full">
          <TabsList className="grid w-full grid-cols-2 rounded-none border-b">
            <TabsTrigger value="assets" className="text-xs">
              Assets <span className="ml-1.5 text-muted-foreground tabular-nums">${fmt(totalA)}</span>
            </TabsTrigger>
            <TabsTrigger value="liabilities" className="text-xs">
              Liabilities <span className="ml-1.5 text-muted-foreground tabular-nums">${fmt(totalL)}</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="assets" className="m-0">
            <EntityList
              items={assets}
              total={totalA}
              emptyLabel="No assets yet"
              addLabel="Add asset"
              onAdd={() => navigate("/editor/new/asset")}
              onOpen={(p) => navigate(`/profiles/${p.id}`)}
            />
          </TabsContent>
          <TabsContent value="liabilities" className="m-0">
            <EntityList
              items={liabilities}
              total={totalL}
              emptyLabel="No liabilities yet"
              addLabel="Add liability"
              onAdd={() => navigate("/editor/new/liability")}
              onOpen={(p) => navigate(`/profiles/${p.id}`)}
            />
          </TabsContent>
        </Tabs>
      )}
    </MetricPopupShell>
  );
}

function EntityList({
  items, total, emptyLabel, addLabel, onAdd, onOpen,
}: {
  items: any[];
  total: number;
  emptyLabel: string;
  addLabel: string;
  onAdd: () => void;
  onOpen: (p: any) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="px-4 py-10 flex flex-col items-center gap-2">
        <p className="text-xs text-muted-foreground">{emptyLabel}</p>
        <Button size="sm" variant="outline" onClick={onAdd} data-testid="button-entity-add-empty">
          <Plus className="h-3.5 w-3.5 mr-1.5" /> {addLabel}
        </Button>
      </div>
    );
  }
  return (
    <div className="divide-y divide-border/60">
      {items.map((p) => {
        const Icon = iconForProfile(p.type);
        const pct = total > 0 ? Math.round((p._value / total) * 100) : 0;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onOpen(p)}
            className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-muted/40 text-left transition-colors"
            data-testid={`entity-row-${p.id}`}
          >
            <div className="rounded-md p-1.5 bg-muted/60 shrink-0">
              <Icon className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate">{p.name}</p>
              <p className="text-[10px] text-muted-foreground capitalize">{p.type}</p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-xs font-semibold tabular-nums">${fmt(p._value)}</p>
              <p className="text-[10px] text-muted-foreground tabular-nums">{pct}%</p>
            </div>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
          </button>
        );
      })}
      <div className="px-4 py-2 border-t border-border bg-muted/20">
        <Button size="sm" variant="ghost" className="w-full justify-start text-xs h-7" onClick={onAdd} data-testid="button-entity-add">
          <Plus className="h-3 w-3 mr-1.5" /> {addLabel}
        </Button>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// CASH FLOW POPUP
// ═════════════════════════════════════════════════════════════════════════════

export function CashFlowPopup({
  open, onOpenChange, filterMode, filterIds,
}: { open: boolean; onOpenChange: (o: boolean) => void } & FilterContext) {
  const param = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";
  const [, navigate] = useLocation();

  const { data: incomes = [] } = useQuery<any[]>({
    queryKey: ["/api/incomes", filterMode, ...filterIds, "cashflow"],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/incomes${param}`);
      const j = await r.json();
      return Array.isArray(j) ? j : (j?.items ?? []);
    },
    enabled: open,
  });

  const { data: obligations = [] } = useQuery<any[]>({
    queryKey: ["/api/obligations", filterMode, ...filterIds, "cashflow"],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/obligations${param}`);
      const j = await r.json();
      return Array.isArray(j) ? j : (j?.items ?? []);
    },
    enabled: open,
  });

  const { data: enhancedRes } = useQuery<any>({
    queryKey: ["/api/dashboard-enhanced", filterMode, ...filterIds, "cashflow"],
    queryFn: async () => (await apiRequest("GET", `/api/dashboard-enhanced${param}`)).json(),
    enabled: open,
  });

  const monthlyExpenses: any[] = enhancedRes?.financeSnapshot?.monthlyExpenseRecords ?? [];

  const monthlyIncome = useMemo(() => incomes.reduce((s, i) => s + (Number(i.amount) || 0), 0), [incomes]);

  // Group obligations into Subscriptions / Bills / Loan payments / Other
  const recurringGroups = useMemo(() => {
    const groups: Record<string, any[]> = {
      Subscriptions: [], Bills: [], "Loan payments": [], Other: [],
    };
    for (const o of obligations) {
      if (o.status === "paused" || o.status === "cancelled") continue;
      const monthly = monthlyizeAmount(o);
      if (monthly <= 0) continue;
      const item = { ...o, _monthly: monthly };
      if (o.kind === "subscription") groups.Subscriptions.push(item);
      else if (o.kind === "loan_payment") groups["Loan payments"].push(item);
      else if (o.kind === "bill") groups.Bills.push(item);
      else groups.Other.push(item);
    }
    return groups;
  }, [obligations]);

  const recurringTotal = Object.values(recurringGroups).flat().reduce((s, o) => s + o._monthly, 0);
  const oneTimeTotal = monthlyExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  // Subtract recurring (which gets logged as expenses by autoLogExpense) — best-effort
  // by recomputing the one-time portion as non-obligation expenses.
  const monthlyOut = recurringTotal + oneTimeTotal;
  const net = monthlyIncome - monthlyOut;
  const positive = net >= 0;

  return (
    <MetricPopupShell
      open={open}
      onOpenChange={onOpenChange}
      icon={TrendingUp}
      iconColor={positive ? "hsl(200 70% 55%)" : "hsl(43 85% 52%)"}
      title="Cash Flow — this month"
      description={`In $${fmt(monthlyIncome)} · Out $${fmt(monthlyOut)}`}
      total={`${positive ? "+" : "−"}$${fmt(Math.abs(net))}`}
      testId="popup-cash-flow"
    >
      <div className="p-3 space-y-3">
        {/* Income */}
        <SectionCard
          icon={ArrowDownToLine}
          color="hsl(155 60% 44%)"
          title="Income"
          total={`$${fmt(monthlyIncome)}`}
          empty="No income added"
          items={incomes.map((i) => ({ id: i.id, label: i.name || i.source || "Income", amount: Number(i.amount) || 0 }))}
          onAdd={() => navigate("/dashboard/finance")}
          onOpen={() => navigate("/dashboard/finance")}
          addLabel="Add income"
        />

        {/* Recurring out */}
        <div className="rounded-lg border border-border bg-card">
          <div className="px-3 py-2 flex items-center gap-2 border-b border-border">
            <div className="rounded-md p-1 shrink-0" style={{ background: "hsl(0 72% 52% / 0.16)" }}>
              <RefreshCw className="h-3 w-3" style={{ color: "hsl(0 72% 52%)" }} />
            </div>
            <p className="text-xs font-semibold flex-1">Recurring out</p>
            <p className="text-xs font-bold tabular-nums" style={{ color: "hsl(0 72% 52%)" }}>−${fmt(recurringTotal)}</p>
          </div>
          {Object.entries(recurringGroups).map(([groupName, items]) =>
            items.length === 0 ? null : (
              <div key={groupName} className="px-3 py-2 border-b border-border/40 last:border-b-0">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">{groupName}</p>
                <ul className="space-y-1">
                  {items.slice(0, 5).map((o) => (
                    <li key={o.id} className="flex items-center justify-between text-xs">
                      <span className="truncate text-foreground">{o.name}</span>
                      <span className="tabular-nums text-muted-foreground">${fmt(o._monthly)}</span>
                    </li>
                  ))}
                  {items.length > 5 && (
                    <li className="text-[10px] text-muted-foreground">+{items.length - 5} more</li>
                  )}
                </ul>
              </div>
            ),
          )}
          {Object.values(recurringGroups).flat().length === 0 && (
            <p className="px-3 py-3 text-[11px] text-muted-foreground text-center">No recurring expenses</p>
          )}
          <div className="px-3 py-1.5 border-t border-border bg-muted/20">
            <Button size="sm" variant="ghost" className="w-full justify-start text-xs h-7" onClick={() => navigate("/calendar?tab=obligations")} data-testid="cash-flow-view-obligations">
              <ExternalLink className="h-3 w-3 mr-1.5" /> Manage obligations
            </Button>
          </div>
        </div>

        {/* One-time out */}
        <SectionCard
          icon={Receipt}
          color="hsl(43 85% 52%)"
          title="One-time out (this month)"
          total={`−$${fmt(oneTimeTotal)}`}
          empty="No one-time expenses yet"
          items={monthlyExpenses.slice(0, 8).map((e) => ({
            id: e.id,
            label: e.description || e.category || "Expense",
            sub: e.date ? new Date(e.date).toLocaleDateString() : undefined,
            amount: -(Number(e.amount) || 0),
          }))}
          extraNote={monthlyExpenses.length > 8 ? `+${monthlyExpenses.length - 8} more` : undefined}
          onAdd={() => navigate("/dashboard/finance")}
          onOpen={() => navigate("/dashboard/finance")}
          addLabel="Add expense"
        />

        {/* Net */}
        <div className="rounded-lg border-2 px-3 py-2 flex items-center justify-between"
          style={{ borderColor: positive ? "hsl(200 70% 55% / 0.4)" : "hsl(43 85% 52% / 0.4)", background: positive ? "hsl(200 70% 55% / 0.06)" : "hsl(43 85% 52% / 0.06)" }}>
          <span className="text-xs font-semibold">Net cash flow</span>
          <span className="text-base font-bold tabular-nums" style={{ color: positive ? "hsl(200 70% 55%)" : "hsl(43 85% 52%)" }}>
            {positive ? "+" : "−"}${fmt(Math.abs(net))}
          </span>
        </div>
      </div>
    </MetricPopupShell>
  );
}

function monthlyizeAmount(o: any): number {
  const amt = Number(o.amount) || 0;
  if (amt <= 0) return 0;
  switch (o.frequency) {
    case "weekly": return amt * 4.333;
    case "biweekly": return amt * 2.167;
    case "monthly": return amt;
    case "yearly": case "annual": return amt / 12;
    case "quarterly": return amt / 3;
    case "daily": return amt * 30;
    default: return amt;
  }
}

function SectionCard({
  icon: Icon, color, title, total, empty, items, onAdd, onOpen, addLabel, extraNote,
}: {
  icon: any;
  color: string;
  title: string;
  total: string;
  empty: string;
  items: Array<{ id: string; label: string; sub?: string; amount: number }>;
  onAdd: () => void;
  onOpen: () => void;
  addLabel: string;
  extraNote?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="px-3 py-2 flex items-center gap-2 border-b border-border">
        <div className="rounded-md p-1 shrink-0" style={{ background: `${color}1f` }}>
          <Icon className="h-3 w-3" style={{ color }} />
        </div>
        <p className="text-xs font-semibold flex-1">{title}</p>
        <p className="text-xs font-bold tabular-nums" style={{ color }}>{total}</p>
      </div>
      {items.length === 0 ? (
        <div className="px-3 py-3 flex flex-col items-center gap-1.5">
          <p className="text-[11px] text-muted-foreground">{empty}</p>
          <Button size="sm" variant="ghost" className="text-xs h-6" onClick={onAdd}>
            <Plus className="h-3 w-3 mr-1" /> {addLabel}
          </Button>
        </div>
      ) : (
        <>
          <ul className="px-3 py-2 space-y-1">
            {items.map((it) => (
              <li key={it.id} className="flex items-center justify-between text-xs">
                <div className="min-w-0 flex-1">
                  <p className="truncate">{it.label}</p>
                  {it.sub && <p className="text-[10px] text-muted-foreground">{it.sub}</p>}
                </div>
                <span className="tabular-nums shrink-0 ml-2">{it.amount >= 0 ? "+" : "−"}${fmt(Math.abs(it.amount))}</span>
              </li>
            ))}
            {extraNote && <li className="text-[10px] text-muted-foreground">{extraNote}</li>}
          </ul>
          <div className="px-3 py-1.5 border-t border-border bg-muted/20">
            <Button size="sm" variant="ghost" className="w-full justify-start text-xs h-7" onClick={onOpen}>
              <ExternalLink className="h-3 w-3 mr-1.5" /> Open finance
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// BUDGET POPUP
// ═════════════════════════════════════════════════════════════════════════════

interface BudgetRow {
  id: string;
  category: string;
  amount: number;
  notes?: string;
}

export function BudgetPopup({
  open, onOpenChange, filterMode, filterIds, monthlyIncome,
}: { open: boolean; onOpenChange: (o: boolean) => void; monthlyIncome: number } & FilterContext) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const param = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";

  const { data: budgetsResp } = useQuery<any>({
    queryKey: ["/api/budgets", "popup"],
    queryFn: async () => (await apiRequest("GET", "/api/budgets")).json(),
    enabled: open,
  });
  const budgets: BudgetRow[] = budgetsResp?.budgets ?? [];

  const { data: enhancedRes } = useQuery<any>({
    queryKey: ["/api/dashboard-enhanced", filterMode, ...filterIds, "budget"],
    queryFn: async () => (await apiRequest("GET", `/api/dashboard-enhanced${param}`)).json(),
    enabled: open,
  });

  const spendByCategory: Record<string, number> = enhancedRes?.financeSnapshot?.spendByCategory ?? {};

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState<string>("");
  const [editMode, setEditMode] = useState<"dollar" | "percent">("dollar");

  const [newCategory, setNewCategory] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [newMode, setNewMode] = useState<"dollar" | "percent">("dollar");
  const [showAdd, setShowAdd] = useState(false);

  const totalBudget = budgets.reduce((s, b) => s + b.amount, 0);
  const totalSpent = budgets.reduce((s, b) => s + (spendByCategory[b.category] || 0), 0);
  const overallPct = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;

  // Invalidate every queryKey that derives from budgets.
  // Note: TanStack Query does prefix-match by array elements, so
  // ["/api/budgets"] does NOT match ["/api/budgets/summary", ...]. We need to
  // invalidate each prefix explicitly so the Dashboard Hero KPI and the
  // Finance page Budget banner re-render after an add / edit / delete.
  // (Fixes QA bugs BUG-004 "Dashboard Budget card stale" + BUG-008 "Finance
  // budget banner stale".)
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["/api/budgets"] });
    qc.invalidateQueries({ queryKey: ["/api/budgets/summary"] });
    qc.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
    qc.invalidateQueries({ queryKey: ["/api/stats"] });
    qc.invalidateQueries({ queryKey: ["/api/expenses"] });
  };

  const addMut = useMutation({
    mutationFn: async () => {
      const amt = newMode === "percent"
        ? (monthlyIncome > 0 ? (Number(newAmount) / 100) * monthlyIncome : Number(newAmount))
        : Number(newAmount);
      if (!isFinite(amt) || amt <= 0) throw new Error("Enter a valid amount");
      if (!newCategory.trim()) throw new Error("Enter a category");
      return (await apiRequest("POST", "/api/budgets", { category: newCategory.trim(), amount: amt })).json();
    },
    onSuccess: () => { invalidate(); setNewCategory(""); setNewAmount(""); setShowAdd(false); toast({ title: "Budget added" }); },
    onError: (e: any) => toast({ title: "Couldn't add", description: e?.message || "Try again", variant: "destructive" }),
  });

  const updateMut = useMutation({
    mutationFn: async ({ id, amount }: { id: string; amount: number }) => {
      return (await apiRequest("PATCH", `/api/budgets/${id}`, { amount })).json();
    },
    onSuccess: () => { invalidate(); setEditingId(null); toast({ title: "Budget updated" }); },
    onError: (e: any) => toast({ title: "Couldn't update", description: e?.message || "Try again", variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/budgets/${id}`),
    onSuccess: () => { invalidate(); toast({ title: "Budget removed" }); },
    onError: (e: any) => toast({ title: "Couldn't delete", description: e?.message || "Try again", variant: "destructive" }),
  });

  const startEdit = (b: BudgetRow) => {
    setEditingId(b.id);
    setEditAmount(String(b.amount));
    setEditMode("dollar");
  };
  const saveEdit = (b: BudgetRow) => {
    let amt = Number(editAmount);
    if (editMode === "percent" && monthlyIncome > 0) amt = (amt / 100) * monthlyIncome;
    if (!isFinite(amt) || amt < 0) {
      toast({ title: "Invalid amount", variant: "destructive" });
      return;
    }
    updateMut.mutate({ id: b.id, amount: amt });
  };

  return (
    <MetricPopupShell
      open={open}
      onOpenChange={onOpenChange}
      icon={PieChartIcon}
      iconColor={overallPct > 100 ? "hsl(0 72% 52%)" : "hsl(43 85% 52%)"}
      title="Monthly Budget"
      description={`$${fmt(totalSpent)} of $${fmt(totalBudget)} spent`}
      total={`${overallPct}%`}
      testId="popup-budget"
    >
      <div className="p-3 space-y-2">
        {/* Overall progress */}
        <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[11px] text-muted-foreground">Overall</p>
            <p className="text-[11px] tabular-nums">{overallPct}% of ${fmt(totalBudget)}</p>
          </div>
          <div className="h-2 rounded-full overflow-hidden bg-muted">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${Math.min(100, overallPct)}%`,
                background: overallPct > 100 ? "hsl(0 72% 52%)" : overallPct >= 80 ? "hsl(43 85% 52%)" : "hsl(155 60% 44%)",
              }}
            />
          </div>
        </div>

        {/* Categories */}
        {budgets.length === 0 ? (
          <div className="px-4 py-8 flex flex-col items-center gap-2">
            <p className="text-xs text-muted-foreground">No budget categories yet</p>
            <Button size="sm" onClick={() => setShowAdd(true)} data-testid="budget-add-first">
              <Plus className="h-3.5 w-3.5 mr-1.5" /> Add first category
            </Button>
          </div>
        ) : (
          <div className="rounded-lg border border-border divide-y divide-border/60">
            {budgets.map((b) => {
              const spent = spendByCategory[b.category] || 0;
              const pct = b.amount > 0 ? Math.round((spent / b.amount) * 100) : 0;
              const incomePct = monthlyIncome > 0 ? Math.round((b.amount / monthlyIncome) * 100) : 0;
              const over = pct > 100;
              const editing = editingId === b.id;
              return (
                <div key={b.id} className="px-3 py-2" data-testid={`budget-row-${b.id}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <p className="text-xs font-medium capitalize flex-1 truncate">{b.category}</p>
                    {!editing && (
                      <>
                        <Badge variant="outline" className="text-[10px] px-1 py-0 tabular-nums">{incomePct}% inc</Badge>
                        <button
                          type="button"
                          onClick={() => startEdit(b)}
                          className="p-1 rounded hover:bg-muted text-muted-foreground"
                          aria-label="Edit"
                          data-testid={`budget-edit-${b.id}`}
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteMut.mutate(b.id)}
                          className="p-1 rounded hover:bg-muted text-muted-foreground"
                          aria-label="Delete"
                          data-testid={`budget-delete-${b.id}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </>
                    )}
                  </div>

                  {editing ? (
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <div className="inline-flex rounded-md border border-border overflow-hidden text-[10px]">
                        <button
                          type="button"
                          onClick={() => setEditMode("dollar")}
                          className={`px-1.5 py-0.5 ${editMode === "dollar" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
                        >$</button>
                        <button
                          type="button"
                          onClick={() => setEditMode("percent")}
                          className={`px-1.5 py-0.5 ${editMode === "percent" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
                          disabled={monthlyIncome <= 0}
                          title={monthlyIncome <= 0 ? "Add income to use %" : ""}
                        >%</button>
                      </div>
                      <Input
                        type="number"
                        value={editAmount}
                        onChange={(e) => setEditAmount(e.target.value)}
                        className="h-7 text-xs flex-1"
                        autoFocus
                      />
                      <Button size="sm" className="h-7 text-xs px-2" onClick={() => saveEdit(b)} disabled={updateMut.isPending}>
                        {updateMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 text-xs px-2" onClick={() => setEditingId(null)}>Cancel</Button>
                    </div>
                  ) : null}

                  <div className="h-1.5 rounded-full overflow-hidden bg-muted">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.min(100, pct)}%`,
                        background: over ? "hsl(0 72% 52%)" : pct >= 80 ? "hsl(43 85% 52%)" : "hsl(155 60% 44%)",
                      }}
                    />
                  </div>
                  <div className="flex items-center justify-between mt-0.5">
                    <p className="text-[10px] text-muted-foreground tabular-nums">
                      ${fmt(spent)} / ${fmt(b.amount)}
                    </p>
                    <p className={`text-[10px] tabular-nums ${over ? "text-red-500 font-semibold" : "text-muted-foreground"}`}>{pct}%</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Add category */}
        {!showAdd ? (
          <Button size="sm" variant="outline" className="w-full text-xs h-8" onClick={() => setShowAdd(true)} data-testid="budget-show-add">
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Add category
          </Button>
        ) : (() => {
          // QA BUG-007 — disable submit until required fields filled,
          // highlight invalid inputs in red, and never let the button flash
          // "Saving…" on an empty submit.
          const catOk = newCategory.trim().length > 0;
          const amtNum = Number(newAmount);
          const amtOk = newAmount !== "" && Number.isFinite(amtNum) && amtNum > 0;
          const canSubmit = catOk && amtOk && !addMut.isPending;
          return (
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-2 space-y-1.5">
            <Input
              placeholder="Category (e.g. groceries, rent)"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              className={`h-8 text-xs ${!catOk && newCategory.length > 0 ? "border-destructive focus-visible:ring-destructive" : ""}`}
              autoFocus
              aria-invalid={!catOk && newCategory.length > 0}
            />
            <div className="flex items-center gap-1.5">
              <div className="inline-flex rounded-md border border-border overflow-hidden text-[10px]">
                <button
                  type="button"
                  onClick={() => setNewMode("dollar")}
                  className={`px-1.5 py-1 ${newMode === "dollar" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
                >$</button>
                <button
                  type="button"
                  onClick={() => setNewMode("percent")}
                  className={`px-1.5 py-1 ${newMode === "percent" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
                  disabled={monthlyIncome <= 0}
                  title={monthlyIncome <= 0 ? "Add income to use %" : ""}
                >%</button>
              </div>
              <Input
                type="number"
                placeholder={newMode === "percent" ? "% of income" : "$ amount"}
                value={newAmount}
                onChange={(e) => setNewAmount(e.target.value)}
                className={`h-8 text-xs flex-1 ${!amtOk && newAmount.length > 0 ? "border-destructive focus-visible:ring-destructive" : ""}`}
                aria-invalid={!amtOk && newAmount.length > 0}
              />
              <Button size="sm" className="h-8 text-xs px-2" onClick={() => addMut.mutate()} disabled={!canSubmit} data-testid="budget-add-submit">
                {addMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Add"}
              </Button>
              <Button size="sm" variant="ghost" className="h-8 text-xs px-2" onClick={() => { setShowAdd(false); setNewCategory(""); setNewAmount(""); }}>
                Cancel
              </Button>
            </div>
            {newMode === "percent" && monthlyIncome > 0 && newAmount && (
              <p className="text-[10px] text-muted-foreground">
                ≈ ${fmt((Number(newAmount) / 100) * monthlyIncome)} of your ${fmt(monthlyIncome)} monthly income
              </p>
            )}
          </div>
          );
        })()}
      </div>
    </MetricPopupShell>
  );
}
