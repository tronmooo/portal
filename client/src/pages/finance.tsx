import { formatApiError } from "@/lib/formatError";
import { Skeleton } from "@/components/ui/skeleton";
import { BubbleSkeletonGrid } from "@/components/ui/skeleton";
import { StuckLoadingGuard } from "@/components/StuckLoadingGuard";
import { stopProp } from "@/lib/event-utils";
import { normalizeFilter } from "@/lib/filter-utils";
import { passesProfileFilter } from "@shared/profile-filter";
import { matchesExpenseSearch, sortExpenses, type ExpenseSort } from "@shared/expense-view";
import { isTestEntity } from "@shared/test-data";
import { useShowTestData } from "@/lib/showTestData";
import { formatMoney, formatListDate } from "@/lib/format";
import { EmptyState } from "@/components/ui/empty-state";
import { resolveAssetValue } from "@shared/asset-value";
import { toMonthlyAmount } from "@shared/obligation-windows";
import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useProfileScope } from "@/hooks/useProfileScope";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { useHubChrome } from "@/components/hub/hub-context";
import { MoneyOverview } from "@/components/finance/MoneyOverview";
import { ConnectedFinance } from "@/components/finance/ConnectedFinance";
import { AccountsSection } from "@/components/finance/AccountsSection";
import { accountViews } from "@shared/finance-accounts";
import { NetWorthPopup, BudgetPopup } from "@/components/dashboard/HeroKPIPopups";
import {
  CashFlowWaterfallPopup, SpendPopup, IncomePopup, BillsDuePopup,
  SavingsRatePopup, CashFlowOverviewPopup,
} from "@/components/finance/MoneyPopups";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DollarSign, TrendingUp, ShoppingCart, ArrowLeft, Plus, Filter, AlertCircle, Pencil, Trash2, Check, Wallet, Landmark, BarChart3, Loader2, Repeat, ChevronDown, Search, ArrowUpDown, X, CalendarDays } from "lucide-react";
import { cn } from "@/lib/utils";
import { Link } from "wouter";
import { apiRequest, queryClient, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { invalidateDomain, invalidateDomains } from "@/lib/cache-bus";
import { showUndoToast, recreateDeleted } from "@/lib/undo-delete";
import { useToast } from "@/hooks/use-toast";
import type { Expense } from "@shared/schema";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";

const categoryColors: Record<string, string> = {
  food: "hsl(var(--chart-1))",
  pet: "hsl(var(--chart-4))",
  transport: "hsl(var(--chart-2))",
  health: "hsl(var(--chart-3))",
  entertainment: "hsl(var(--chart-5))",
  general: "hsl(var(--primary))",
};

const EXPENSE_CATEGORIES = ["entertainment", "food", "general", "health", "housing", "pet", "transport", "utilities", "vehicle"];

// Six-month in/out/net series shared by the Money overview cards AND the Cash
// Flow Overview popup, so both surfaces plot identical numbers. Outflow is
// summed per calendar month from real expenses; inflow uses the current
// monthly income (no per-month income history yet — honest flat baseline).
function buildCashTrend(expenses: any[], monthlyIncome: number): Array<{ month: string; inflow: number; outflow: number; net: number }> {
  const now = new Date();
  const monthKeys: Array<{ key: string; label: string }> = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthKeys.push({
      key: `${d.getFullYear()}-${d.getMonth()}`,
      label: d.toLocaleDateString("en-US", { month: "short", timeZone: BROWSER_TIMEZONE }),
    });
  }
  const outByMonth: Record<string, number> = {};
  for (const e of (Array.isArray(expenses) ? expenses : [])) {
    const raw = (e as any).date || (e as any).createdAt;
    if (!raw) continue;
    const d = new Date(raw);
    if (isNaN(d.getTime())) continue;
    const k = `${d.getFullYear()}-${d.getMonth()}`;
    outByMonth[k] = (outByMonth[k] || 0) + (Number((e as any).amount) || 0);
  }
  return monthKeys.map(m => {
    const outflow = Math.round(outByMonth[m.key] || 0);
    return { month: m.label, inflow: Math.round(monthlyIncome), outflow, net: Math.round(monthlyIncome) - outflow };
  });
}

/** Order profile-picker options: self ("Me") pinned first, everyone else A→Z. */
function sortProfilesForSelect(a: { type?: string; name?: string }, b: { type?: string; name?: string }) {
  if (a.type === "self" && b.type !== "self") return -1;
  if (b.type === "self" && a.type !== "self") return 1;
  return (a.name || "").localeCompare(b.name || "");
}

/**
 * Collapsible list row used by the Expenses / Income / Paychecks lists.
 *
 * Replaces the old always-on rows with hover-only edit/delete buttons (which
 * the user couldn't discover on touch and which crammed every detail onto one
 * line). The row now shows a compact summary; clicking it expands a drop-down
 * panel with the full details + actions. Self-contained open state so the big
 * page component doesn't need to track per-row toggles.
 */
function ExpandableRow({
  summary, detail, testId,
}: {
  summary: React.ReactNode;
  detail: React.ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid={testId}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-muted/40 transition-colors select-none"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => !o); } }}
      >
        <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform", open ? "rotate-0" : "-rotate-90")} />
        {summary}
      </div>
      {open && (
        <div className="px-3 pb-3 pl-9 bg-muted/20" onClick={stopProp(() => {})}>
          {detail}
        </div>
      )}
    </div>
  );
}

export default function FinancePage() {
  useEffect(() => { document.title = "Finance — Portol"; }, []);
  const { toast } = useToast();
  // Hub consolidation (2026-07): shell owns back-nav + profile switcher.
  const hubEmbedded = useHubChrome();
  // PROFILE-CONTEXT FIX: read the active scope reactively from the single source
  // of truth. The old code only resynced on the window `focus` event, so a
  // filter change made elsewhere (or by the chip on this page) left Finance
  // showing the previous profile's numbers until you tabbed away and back.
  const { mode: filterMode, selectedIds: filterIds } = useProfileScope();
  const { data: profiles } = useQuery<any[]>({ queryKey: ["/api/profiles"] });
  // Accounts, for the "Paid from" picker. Derived from the profile list that is
  // already loaded — one fetch, one source of truth, no second account list.
  const accountOptions = useMemo(() => accountViews(profiles || []), [profiles]);
  const profileParam = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";
  // CRITICAL: each filtered query MUST set its own queryFn that appends
  // ?profileIds=... to the URL. Without an explicit queryFn the default fetcher
  // hits the bare endpoint and returns unfiltered data — the cache key changes
  // when filter flips but the response never does, so the page silently shows
  // everyone's data even when a profile is selected.
  const { data: obligations } = useQuery<any[]>({
    queryKey: ["/api/obligations", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/obligations${profileParam}`).then(r => r.json()),
  });
  const { data: enhanced } = useQuery<any>({
    queryKey: ["/api/dashboard-enhanced", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/dashboard-enhanced${profileParam}`).then(r => r.json()),
    // Always refetch on mount so KPI tiles never show stale aggregates after navigating here
    refetchOnMount: "always",
  });
  const { data: expenses, isLoading, error, refetch } = useQuery<Expense[]>({
    queryKey: ["/api/expenses", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/expenses${profileParam}`).then(r => r.json()),
    refetchOnMount: "always",
  });
  // Expenses page controls — persisted in localStorage so the toolbar survives
  // reloads (search + category + sort + date range).
  const [filterCategory, setFilterCategory] = useState<string>(() => { try { return localStorage.getItem("portol_exp_cat") || "all"; } catch { return "all"; } });
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [sortBy, setSortBy] = useState<ExpenseSort>(() => { try { return (localStorage.getItem("portol_exp_sort") as ExpenseSort) || "date-desc"; } catch { return "date-desc"; } });
  const [dateRange, setDateRange] = useState<"all" | "month" | "30d" | "year">(() => { try { return (localStorage.getItem("portol_exp_range") as any) || "all"; } catch { return "all"; } });
  useEffect(() => { try { localStorage.setItem("portol_exp_cat", filterCategory); } catch {} }, [filterCategory]);
  useEffect(() => { try { localStorage.setItem("portol_exp_sort", sortBy); } catch {} }, [sortBy]);
  useEffect(() => { try { localStorage.setItem("portol_exp_range", dateRange); } catch {} }, [dateRange]);
  const [addOpen, setAddOpen] = useState(false);
  // QA Bug 7: open Add Expense dialog when arriving via command palette with ?new=expense
  useEffect(() => {
    const hash = window.location.hash || "";
    const q = hash.includes("?") ? hash.split("?")[1] : "";
    if (q && new URLSearchParams(q).get("new") === "expense") {
      setAddOpen(true);
      const cleaned = hash.split("?")[0];
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${cleaned}`);
    }
  }, []);
  // Round-6 fix (BUG-016): Add Expense dialog previously had no Date field and
  // always silently used today's date. Edit Expense had a Date field, so the two
  // were inconsistent. Initialise the form's date to today in the user's timezone
  // and let the user override it.
  const todayLocalISO = new Date().toLocaleDateString('en-CA', { timeZone: BROWSER_TIMEZONE });
  const [newExpense, setNewExpense] = useState({ description: "", amount: "", category: "general", vendor: "", date: todayLocalISO });
  // BUG-023: track whether the user has attempted to submit so we can show
  // red borders on empty required fields instead of just a quiet inline hint.
  const [addAttempt, setAddAttempt] = useState(false);
  const [expenseProfileId, setExpenseProfileId] = useState<string>("");
  /** Which account the expense was paid from. "" = don't touch any balance. */
  const [expenseAccountId, setExpenseAccountId] = useState<string>("");
  const selfProfile = (profiles || []).find((p: any) => p.type === "self");
  useEffect(() => {
    if (selfProfile && !expenseProfileId) setExpenseProfileId(selfProfile.id);
  }, [selfProfile]);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  // Round-6 fix (BUG-017): Edit Expense was missing a Profile field, even though
  // Add Expense had one. Result: re-assigning an expense to a different family
  // member required deleting and recreating the row. Add profileId to the edit
  // form so the field is reachable everywhere it can be set.
  const [editForm, setEditForm] = useState({ description: "", amount: "", category: "", vendor: "", date: "", profileId: "" });
  /* ST5: re-sync the form whenever the editing target changes. Previously
     the form was seeded inside the click handler, so if React re-used the
     dialog without remount the second open briefly showed the prior
     expense's values. Keying the effect on editingExpense?.id keeps the
     form authoritatively in sync with the currently-selected row. */
  useEffect(() => {
    if (editingExpense) {
      setEditForm({
        description: editingExpense.description ?? "",
        amount: String((editingExpense as any).amount ?? ""),
        category: (editingExpense as any).category ?? "",
        vendor: (editingExpense as any).vendor ?? "",
        date: (editingExpense as any).date?.slice(0, 10) ?? "",
        // Pre-select the existing linked profile (first one), or empty string
        // when the expense has no linked profile yet.
        profileId: ((editingExpense as any).linkedProfiles?.[0]) ?? "",
      });
    } else {
      setEditForm({ description: "", amount: "", category: "", vendor: "", date: "", profileId: "" });
    }
  }, [editingExpense?.id]);
  const [editSaving, setEditSaving] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  // U2 fix: confirmation state for paycheck deletion. Holds the FULL paycheck
  // row pending confirmation (P2 undo needs every field for the re-create),
  // or null when no dialog is showing.
  const [paycheckToDelete, setPaycheckToDelete] = useState<any | null>(null);
  const [addPaycheckOpen, setAddPaycheckOpen] = useState(false);
  const [newPaycheck, setNewPaycheck] = useState({ source: "", amount: "", expectedDate: "" });

  // ── Income CRUD state ──────────────────────────────────────────────
  // Bug #5: both dialogs now carry profileId so users can re-assign income
  // ownership without delete + recreate (matches Edit Expense at line ~831).
  const [addIncomeOpen, setAddIncomeOpen] = useState(false);
  const [newIncome, setNewIncome] = useState({ description: "", amount: "", category: "salary", frequency: "monthly", date: "", profileId: "" });
  const [editingIncome, setEditingIncome] = useState<any | null>(null);
  const [editIncomeForm, setEditIncomeForm] = useState({ description: "", amount: "", category: "salary", frequency: "monthly", date: "", profileId: "" });
  // P2 undo: hold the FULL income row (not just id/description/amount) so the
  // delete mutation can capture everything the restore re-create needs.
  const [incomeToDelete, setIncomeToDelete] = useState<any | null>(null);
  useEffect(() => {
    if (editingIncome) {
      // Bug #18 (income subset): re-seed every time the income changes so the
      // dialog never shows stale state from the previously-edited row.
      setEditIncomeForm({
        description: editingIncome.description ?? "",
        amount: String(editingIncome.amount ?? ""),
        category: editingIncome.category ?? "salary",
        frequency: editingIncome.frequency ?? "monthly",
        date: editingIncome.date?.slice(0, 10) ?? "",
        profileId: (editingIncome.linkedProfiles?.[0]) ?? "",
      });
    }
  }, [editingIncome?.id]);

  // Finance redesign (2026-07): deeper tools (paychecks, income, loan
  // schedules, cashflow grid) collapse below the Money overview so the tab
  // leads with the snapshot. Default collapsed.
  const [showMore, setShowMore] = useState(false);
  // Command-center drill-down popups (the SAME dashboard popups — reused).
  // Every Money KPI card now opens its OWN bespoke popup (2026-07 redesign) —
  // previously spend/income/bills/savings all funneled into "cashflow".
  const [financePopup, setFinancePopup] = useState<
    "networth" | "cashflow" | "budget" | "spend" | "income" | "bills" | "savings" | "overview" | null
  >(null);

  // ── Cashflow entry state ─────────────────────────────────────────────────
  const [addCashflowOpen, setAddCashflowOpen] = useState(false);
  const [newCashflow, setNewCashflow] = useState({
    month: new Date().toISOString().slice(0, 7),
    week: "1",
    projected_income: "",
    projected_expenses: "",
    actual_income: "",
    actual_expenses: "",
  });

  // RACE FIX (user report: "Failed to add expense — Amount must be a positive
  // number" despite a filled form): the submit handler called mutate() and then
  // synchronously RESET the form state. React Query re-reads mutationFn's
  // closure after that reset re-render, so the request was built from the
  // EMPTIED form (parseFloat("") = NaN → 400). The payload is now built in the
  // click handler and passed as mutation VARIABLES — captured at call time and
  // immune to re-renders. Same fix applied to paycheck + income below.
  type NewExpenseVars = { description: string; amount: number; category: string; vendor?: string; date: string; profileId?: string; accountId?: string };
  const addExpenseMutation = useMutation<{ amount: number; description: string; created: any }, Error, NewExpenseVars, { prev: [readonly unknown[], unknown][]; tempId: string }>({
    mutationFn: async (vars) => {
      // Defense-in-depth: validate amount before sending. The submit button
      // already guards this, but if mutation is invoked any other way we
      // refuse to send a non-finite amount that would coerce to $0 server-side.
      if (!isFinite(vars.amount) || vars.amount <= 0) {
        throw new Error("Amount must be a positive number");
      }
      const desc = (vars.description || "").trim();
      if (!desc) {
        throw new Error("Description is required");
      }
      // Round-6 fix (BUG-016): honour the user-entered date. Falls back to today
      // in the user's timezone if for some reason the field is cleared.
      const expenseDate = (vars.date || "").trim()
        || new Date().toLocaleDateString('en-CA', { timeZone: BROWSER_TIMEZONE });
      const res = await apiRequest("POST", "/api/expenses", {
        description: desc,
        amount: vars.amount,
        category: vars.category,
        vendor: vars.vendor || undefined,
        date: expenseDate,
        tags: [],
        // The account is linked ALONGSIDE the person, never instead of them:
        // the person link is what the profile filter scopes on, and replacing
        // it would hide the expense from its owner's view.
        ...(vars.profileId || vars.accountId
          ? { linkedProfiles: [vars.profileId, vars.accountId].filter(Boolean) as string[] }
          : {}),
      });
      // Parse the created row so onSuccess can swap the optimistic temp id for
      // the real server id (otherwise edit/delete on the fresh row 404s until
      // the background refetch lands).
      const created = await res.json().catch(() => null);
      // Money spent from an account leaves that account. Without this the
      // expense is recorded while the balance it came out of never moves, and
      // Finance shows two numbers that disagree about the same event.
      if (vars.accountId) {
        await apiRequest("POST", `/api/accounts/${vars.accountId}/adjust`, {
          delta: -vars.amount,
          date: expenseDate,
          reason: desc,
        }).catch(() => { /* the expense is saved either way — never lose it over a balance nudge */ });
      }
      return { amount: vars.amount, description: desc, created };
    },
    onMutate: async (vars) => {
      const amt = vars.amount;
      const desc = (vars.description || "").trim();
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (!isFinite(amt) || amt <= 0 || !desc) {
        // mutationFn will throw — nothing to do
        return { prev: [], tempId };
      }
      const expenseDate = (vars.date || "").trim() || todayLocalISO;
      await queryClient.cancelQueries({ queryKey: ["/api/expenses"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/expenses"] });
      const tempExpense: any = {
        id: tempId,
        description: desc,
        amount: amt,
        category: vars.category,
        vendor: vars.vendor || undefined,
        date: expenseDate,
        tags: [],
        linkedProfiles: [vars.profileId, vars.accountId].filter(Boolean) as string[],
        createdAt: new Date().toISOString(),
        _optimistic: true,
      };
      // Prepend to every cached /api/expenses variant (handles filtered keys)
      queryClient.setQueriesData({ queryKey: ["/api/expenses"] }, (old: any) => {
        if (!old) return old;
        if (Array.isArray(old)) return [tempExpense, ...old];
        if (Array.isArray(old?.items)) return { ...old, items: [tempExpense, ...old.items] };
        return old;
      });
      return { prev, tempId };
    },
    onSuccess: (result, _vars, ctx) => {
      // Swap the optimistic temp row for the real server row (real id) so
      // immediate edit/delete on it works before the refetch settles.
      if (result.created?.id && ctx?.tempId) {
        queryClient.setQueriesData({ queryKey: ["/api/expenses"] }, (old: any) => {
          const swap = (e: any) => (e?.id === ctx.tempId ? { ...e, ...result.created } : e);
          if (!old) return old;
          if (Array.isArray(old)) return old.map(swap);
          if (Array.isArray(old?.items)) return { ...old, items: old.items.map(swap) };
          return old;
        });
      }
      // Cache bus: one call ripples to every surface that reads expense data
      // (dashboard KPIs, stats, budgets, cashflow, activity, insights).
      invalidateDomain("expenses");
      // A spend from an account also moved that account's balance.
      if (_vars.accountId) invalidateDomains("profiles", "assets", "liabilities");
      toast({ title: `$${result.amount.toFixed(2)} expense added`, description: result.description });
    },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) {
        for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data);
      }
      toast({ title: "Failed to add expense", description: formatApiError(err), variant: "destructive" });
    },
  });

  // ── ALL hooks MUST be above early returns (React Rules of Hooks) ──
  // Paychecks — profile-scoped like every other query here (BUG-20260709):
  // the bare query leaked all profiles' paychecks into the "Expected Paychecks"
  // list under every profile. Server filters /api/paychecks by profileIds.
  const { data: paychecks = [] } = useQuery<any[]>({
    queryKey: ["/api/paychecks", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/paychecks${profileParam}`).then(r => r.json()),
  });
  // RACE FIX: payload passed as variables — see addExpenseMutation comment.
  // (User hit "400: source is required" because the form was reset before the
  // mutation read it.)
  const addPaycheckMut = useMutation<void, Error, { source: string; amount: number; expectedDate: string }, { prev: [readonly unknown[], unknown][]; tempId: string }>({
    mutationFn: async (vars) => {
      await apiRequest("POST", "/api/paychecks", {
        source: vars.source.trim(),
        amount: vars.amount,
        expected_date: vars.expectedDate,
      });
    },
    onMutate: async (vars) => {
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await queryClient.cancelQueries({ queryKey: ["/api/paychecks"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/paychecks"] });
      const temp = {
        id: tempId,
        source: vars.source.trim(),
        amount: vars.amount,
        expected_date: vars.expectedDate,
        confirmed: false,
        _optimistic: true,
      };
      queryClient.setQueriesData({ queryKey: ["/api/paychecks"] }, (old: any) =>
        Array.isArray(old) ? [temp, ...old] : old
      );
      return { prev, tempId };
    },
    onSuccess: (_d, vars) => {
      // Cache bus: "incomes" covers paychecks + cashflow + dashboard + stats.
      invalidateDomain("incomes");
      toast({ title: "Paycheck added", description: `${vars.source} — $${vars.amount.toFixed(2)}` });
    },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: "Failed to add paycheck", description: formatApiError(err), variant: "destructive" });
    },
  });
  const confirmPaycheckMut = useMutation<void, Error, { id: string; actual_amount?: number }, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: async ({ id, actual_amount }: { id: string; actual_amount?: number }) => {
      await apiRequest("PATCH", `/api/paychecks/${id}/confirm`, { actual_amount });
    },
    onMutate: async ({ id, actual_amount }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/paychecks"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/paychecks"] });
      queryClient.setQueriesData({ queryKey: ["/api/paychecks"] }, (old: any) => {
        if (!Array.isArray(old)) return old;
        return old.map((p: any) => p.id === id ? { ...p, confirmed: true, actual_amount: actual_amount ?? p.amount } : p);
      });
      return { prev };
    },
    onSuccess: () => {
      // Confirming a paycheck touches income surfaces AND creates an expense-side
      // ledger effect — bust both domains via the bus.
      invalidateDomains("incomes", "expenses");
      toast({ title: "Paycheck confirmed" });
    },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: "Failed to confirm paycheck", description: formatApiError(err), variant: "destructive" });
    },
  });
  // P2 undo: variables carry the FULL paycheck row so the delete toast can
  // offer Undo — restore re-creates via POST /api/paychecks and, if the
  // deleted paycheck had already been marked received, re-confirms it.
  const deletePaycheckMut = useMutation<any, Error, any, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: async (pc: any) => { await apiRequest("DELETE", `/api/paychecks/${pc.id}`); return pc; },
    onMutate: async (pc) => {
      await queryClient.cancelQueries({ queryKey: ["/api/paychecks"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/paychecks"] });
      queryClient.setQueriesData({ queryKey: ["/api/paychecks"] }, (old: any) =>
        Array.isArray(old) ? old.filter((item: any) => item.id !== pc.id) : old
      );
      return { prev };
    },
    onSuccess: (_d, pc) => {
      invalidateDomain("incomes");
      showUndoToast({
        title: "Paycheck deleted",
        description: `${pc.source} — $${Number(pc.actual_amount ?? pc.amount ?? 0).toFixed(2)}`,
        onUndo: async () => {
          const created = await recreateDeleted<any>({
            url: "/api/paychecks",
            body: {
              source: pc.source,
              amount: Number(pc.amount),
              expected_date: pc.expected_date,
              notes: pc.notes || undefined,
            },
            domains: ["incomes"],
            queryKeyHead: "/api/paychecks",
            applyOptimistic: (old: any) => Array.isArray(old) ? [pc, ...old] : old,
            successTitle: "Paycheck restored",
            errorTitle: "Couldn't restore paycheck",
          });
          // The create route can't set confirmed/actual_amount — replay the
          // confirmation so a received paycheck comes back received.
          if (created?.id && pc.confirmed) {
            try {
              await apiRequest("PATCH", `/api/paychecks/${created.id}/confirm`, { actual_amount: pc.actual_amount });
            } catch { /* best-effort — the row itself is restored */ }
            invalidateDomain("incomes");
          }
        },
      });
    },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: "Failed to delete paycheck", description: formatApiError(err), variant: "destructive" });
    },
  });

  // Loan Amortization
  const { data: loanSchedules = [] } = useQuery<any[]>({ queryKey: ["/api/loans/schedule"] });
  const markLoanPaymentMut = useMutation<void, Error, string, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: async (id: string) => { await apiRequest("PATCH", `/api/loans/payment/${id}/mark`, {}); },
    onMutate: async (id) => {
      // Optimistic: flip the payment row to paid immediately so the UI feels instant.
      await queryClient.cancelQueries({ queryKey: ["/api/loans/schedule"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/loans/schedule"] });
      queryClient.setQueriesData({ queryKey: ["/api/loans/schedule"] }, (old: any) => {
        if (!Array.isArray(old)) return old;
        const today = new Date().toLocaleDateString('en-CA', { timeZone: BROWSER_TIMEZONE });
        return old.map((schedule: any) => {
          if (!schedule || !Array.isArray(schedule.payments)) return schedule;
          return {
            ...schedule,
            payments: schedule.payments.map((p: any) =>
              p?.id === id ? { ...p, paid: true, paidDate: p.paidDate || today, status: "paid" } : p
            ),
          };
        });
      });
      return { prev };
    },
    onSuccess: () => {
      // "obligations" covers loans/schedule + cashflow + dashboard + stats;
      // marking a payment also writes an expense row.
      invalidateDomains("obligations", "expenses");
      toast({ title: "Loan payment marked as paid" });
    },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: "Failed to mark payment", description: formatApiError(err), variant: "destructive" });
    },
  });

  // ── Incomes (separate from paychecks: recurring income streams) ──────────
  // PROFILE-SCOPE FIX (BUG-20260709-income-leak): this query MUST send the
  // active profile filter, like every other query on this page. Without the
  // explicit queryFn + scoped key it hit the bare /api/incomes and summed ALL
  // incomes into `monthlyIncome` — so INCOME · MTD and CASH FLOW showed the
  // same total (e.g. $32,700) under EVERY profile, including brand-new ones
  // that have no income. The server already scopes /api/incomes by profileIds
  // (orphans fall through to the self profile only), so passing the param is
  // all that's needed; keying on mode/ids makes switching profiles refetch.
  const { data: incomes = [] } = useQuery<any[]>({
    queryKey: ["/api/incomes", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/incomes${profileParam}`).then(r => r.json()),
  });

  // RACE FIX: payload passed as variables — see addExpenseMutation comment.
  type NewIncomeVars = { description: string; amount: number; category: string; frequency: string; date?: string; profileId?: string };
  const addIncomeMut = useMutation<{ description: string; amount: number }, Error, NewIncomeVars, { prev: [readonly unknown[], unknown][]; tempId: string }>({
    mutationFn: async (vars) => {
      const amt = vars.amount;
      if (!isFinite(amt) || amt <= 0) throw new Error("Amount must be a positive number");
      const desc = vars.description.trim();
      if (!desc) throw new Error("Description is required");
      // Bug #5: prefer the dialog's own profile picker; fall back to the
      // page-level expenseProfileId chip so users who don't change it still
      // get correct attribution.
      const chosenProfileId = vars.profileId || expenseProfileId;
      await apiRequest("POST", "/api/incomes", {
        description: desc,
        amount: amt,
        category: vars.category,
        frequency: vars.frequency,
        date: vars.date || new Date().toLocaleDateString('en-CA', { timeZone: BROWSER_TIMEZONE }),
        tags: [],
        ...(chosenProfileId ? { linkedProfiles: [chosenProfileId] } : {}),
      });
      return { description: desc, amount: amt };
    },
    onMutate: async (vars) => {
      const amt = vars.amount;
      const desc = vars.description.trim();
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (!isFinite(amt) || amt <= 0 || !desc) return { prev: [], tempId };
      const chosenProfileId = vars.profileId || expenseProfileId;
      await queryClient.cancelQueries({ queryKey: ["/api/incomes"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/incomes"] });
      const temp: any = {
        id: tempId,
        description: desc,
        amount: amt,
        category: vars.category,
        frequency: vars.frequency,
        date: vars.date || new Date().toLocaleDateString('en-CA', { timeZone: BROWSER_TIMEZONE }),
        tags: [],
        linkedProfiles: chosenProfileId ? [chosenProfileId] : [],
        _optimistic: true,
      };
      queryClient.setQueriesData({ queryKey: ["/api/incomes"] }, (old: any) =>
        Array.isArray(old) ? [temp, ...old] : old
      );
      return { prev, tempId };
    },
    onSuccess: ({ description, amount }) => {
      invalidateDomain("incomes");
      toast({ title: `Income added`, description: `${description} — $${amount.toFixed(2)}` });
    },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: "Failed to add income", description: formatApiError(err), variant: "destructive" });
    },
  });

  const editIncomeMut = useMutation<void, Error, { id: string }, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: async (input: { id: string }) => {
      const amt = parseFloat(editIncomeForm.amount);
      if (!isFinite(amt) || amt <= 0) throw new Error("Amount must be a positive number");
      const desc = editIncomeForm.description.trim();
      if (!desc) throw new Error("Description is required");
      // Bug #5: Edit Income previously never sent linkedProfiles, so users
      // could not re-attribute an income without delete+recreate. Now sends
      // the chosen profile (or [] to clear). Pairs with bug #4 server fix.
      await apiRequest("PATCH", `/api/incomes/${input.id}`, {
        description: desc,
        amount: amt,
        category: editIncomeForm.category,
        frequency: editIncomeForm.frequency,
        ...(editIncomeForm.date ? { date: editIncomeForm.date } : {}),
        linkedProfiles: editIncomeForm.profileId ? [editIncomeForm.profileId] : [],
      });
    },
    onMutate: async ({ id }) => {
      const amt = parseFloat(editIncomeForm.amount);
      const desc = editIncomeForm.description.trim();
      if (!isFinite(amt) || amt <= 0 || !desc) return { prev: [] };
      await queryClient.cancelQueries({ queryKey: ["/api/incomes"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/incomes"] });
      queryClient.setQueriesData({ queryKey: ["/api/incomes"] }, (old: any) => {
        if (!Array.isArray(old)) return old;
        return old.map((i: any) => i.id === id ? {
          ...i,
          description: desc,
          amount: amt,
          category: editIncomeForm.category,
          frequency: editIncomeForm.frequency,
          ...(editIncomeForm.date ? { date: editIncomeForm.date } : {}),
          linkedProfiles: editIncomeForm.profileId ? [editIncomeForm.profileId] : [],
        } : i);
      });
      return { prev };
    },
    onSuccess: () => {
      invalidateDomain("incomes");
      toast({ title: "Income updated" });
    },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: "Failed to update income", description: formatApiError(err), variant: "destructive" });
    },
  });

  // P2 undo: variables carry the FULL income row (not just the id) so the
  // delete toast can offer Undo — restore re-creates via POST /api/incomes
  // (the insert schema accepts every user-entered field; only id/createdAt
  // are server-generated).
  const deleteIncomeMut = useMutation<any, Error, any, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: async (income: any) => { await apiRequest("DELETE", `/api/incomes/${income.id}`); return income; },
    onMutate: async (income) => {
      await queryClient.cancelQueries({ queryKey: ["/api/incomes"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/incomes"] });
      queryClient.setQueriesData({ queryKey: ["/api/incomes"] }, (old: any) =>
        Array.isArray(old) ? old.filter((i: any) => i.id !== income.id) : old
      );
      return { prev };
    },
    onSuccess: (_d, income) => {
      invalidateDomain("incomes");
      showUndoToast({
        title: "Income deleted",
        description: `${income.description} — $${Number(income.amount || 0).toFixed(2)}`,
        onUndo: () => recreateDeleted({
          url: "/api/incomes",
          body: {
            description: income.description,
            amount: Number(income.amount),
            category: income.category || "salary",
            frequency: income.frequency || "monthly",
            date: income.date ? String(income.date).slice(0, 10) : undefined,
            tags: income.tags || [],
            linkedProfiles: income.linkedProfiles || [],
          },
          domains: ["incomes"],
          queryKeyHead: "/api/incomes",
          applyOptimistic: (old: any) => Array.isArray(old) ? [income, ...old] : old,
          successTitle: `"${income.description}" restored`,
          errorTitle: "Couldn't restore income",
        }),
      });
    },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: "Failed to delete income", description: formatApiError(err), variant: "destructive" });
    },
  });

  // Cashflow
  // BUG-021: must use user-local month — toISOString() returns UTC, which can
  // tip into next month for Pacific users in the evening (Dashboard shows May
  // while Finance showed April). Match dashboard's `currentMonth` derivation.
  const cfMonth = new Date().toLocaleDateString('en-CA', { timeZone: BROWSER_TIMEZONE }).slice(0, 7);
  const { data: cashflow = [] } = useQuery<any[]>({ queryKey: ["/api/cashflow", cfMonth] });

  // ── Money-overview data (2026-07 Finance redesign) ───────────────────────
  // Budgets (per-category limits) + net-worth trend history power the new
  // snapshot/budget cards. Scoped like every other query on this page.
  const { data: budgetData } = useQuery<any>({
    queryKey: ["/api/budgets", cfMonth, filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/budgets?month=${cfMonth}${profileParam ? `&${profileParam.slice(1)}` : ""}`).then(r => r.json()),
  });
  const budgets: any[] = Array.isArray(budgetData?.budgets) ? budgetData.budgets : (Array.isArray(budgetData) ? budgetData : []);
  const { data: nwHistory = [] } = useQuery<any[]>({
    queryKey: ["/api/net-worth/history", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/net-worth/history${profileParam}${profileParam ? "&" : "?"}lookbackDays=120`).then(r => r.json()).catch(() => []),
  });

  // Pay a bill straight from the Finance "Bills · next 14d" card — same
  // endpoint + optimistic pattern as ObligationsManager.payMut.
  const payBillMut = useMutation<void, Error, { id: string; amount: number }>({
    mutationFn: async ({ id }) => { await apiRequest("POST", `/api/obligations/${id}/pay`, {}); },
    onSuccess: () => {
      toast({ title: "Payment recorded" });
      invalidateDomain("obligations");
      // No bus domain maps the calendar timeline to obligations — keep explicit.
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
    },
    onError: (err) => toast({ title: "Failed to record payment", description: formatApiError(err), variant: "destructive" }),
  });

  // ── Cashflow upsert mutation (POST /api/cashflow) ────────────────────────
  // RACE FIX: payload passed as variables — see addExpenseMutation comment.
  type CashflowVars = { month: string; week: string; projected_income: string; projected_expenses: string; actual_income: string; actual_expenses: string };
  const addCashflowMut = useMutation<void, Error, CashflowVars, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: async (vars) => {
      const wk = parseInt(vars.week, 10);
      if (!isFinite(wk) || wk < 1 || wk > 6) throw new Error("Week must be between 1 and 6");
      if (!/^\d{4}-\d{2}$/.test(vars.month)) throw new Error("Month must be in YYYY-MM format");
      const body: Record<string, any> = { month: vars.month, week: wk };
      for (const k of ["projected_income", "projected_expenses", "actual_income", "actual_expenses"] as const) {
        const raw = (vars as any)[k] as string;
        if (raw === "" || raw == null) continue;
        const n = Number(raw);
        if (!isFinite(n)) throw new Error(`${k} must be a number`);
        body[k] = n;
      }
      await apiRequest("POST", "/api/cashflow", body);
    },
    onMutate: async (vars) => {
      // Optimistic upsert: merge the new row into the cached cashflow list so the
      // chart/table updates immediately. Server is the source of truth on refetch.
      const wk = parseInt(vars.week, 10);
      if (!isFinite(wk) || wk < 1 || wk > 6) return { prev: [] };
      if (!/^\d{4}-\d{2}$/.test(vars.month)) return { prev: [] };
      const numeric: Record<string, number> = {};
      for (const k of ["projected_income", "projected_expenses", "actual_income", "actual_expenses"] as const) {
        const raw = (vars as any)[k] as string;
        if (raw === "" || raw == null) continue;
        const n = Number(raw);
        if (isFinite(n)) numeric[k] = n;
      }
      await queryClient.cancelQueries({ queryKey: ["/api/cashflow"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/cashflow"] });
      queryClient.setQueriesData({ queryKey: ["/api/cashflow"] }, (old: any) => {
        if (!Array.isArray(old)) return old;
        const idx = old.findIndex((c: any) => c?.month === vars.month && Number(c?.week) === wk);
        if (idx >= 0) {
          const merged = { ...old[idx], ...numeric, month: vars.month, week: wk };
          return old.map((c: any, i: number) => i === idx ? merged : c);
        }
        const temp = {
          id: `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          month: vars.month,
          week: wk,
          projected_income: numeric.projected_income ?? 0,
          projected_expenses: numeric.projected_expenses ?? 0,
          actual_income: numeric.actual_income ?? 0,
          actual_expenses: numeric.actual_expenses ?? 0,
          _optimistic: true,
        };
        return [...old, temp];
      });
      return { prev };
    },
    onSuccess: () => {
      // No dedicated "cashflow" bus domain — keep the direct key, and let the
      // "dashboard" domain ripple the derived surfaces (stats, insights, digest).
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      invalidateDomain("dashboard");
      toast({ title: "Cashflow entry saved" });
    },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: "Failed to save cashflow", description: formatApiError(err), variant: "destructive" });
    },
  });

  // ── ALL useMemo hooks MUST be before early returns (React Rules of Hooks) ──
  // Apply profile filter client-side using the shared rule so finance,
  // calendar, dashboard and the server agree on what "active filter" means.
  const filterCtx = useMemo(() => ({
    selectedIds: filterMode === "everyone" ? [] : filterIds,
    allProfiles: (profiles || []).map((p: any) => ({ id: p.id, type: p.type })),
  }), [filterMode, filterIds, profiles]);
  const showTestData = useShowTestData();
  const profileFiltered = useMemo(
    () => (expenses || []).filter(e => passesProfileFilter(e.linkedProfiles, filterCtx) && (showTestData || !isTestEntity(e))),
    [expenses, filterCtx, showTestData],
  );
  // Category + free-text search + date range (shared/expense-view drives search).
  const rangeStart = useMemo(() => {
    if (dateRange === "all") return null;
    const now = new Date();
    if (dateRange === "month") return new Date(now.getFullYear(), now.getMonth(), 1);
    if (dateRange === "year") return new Date(now.getFullYear(), 0, 1);
    return new Date(now.getTime() - 30 * 86400000); // 30d
  }, [dateRange]);
  const filtered = useMemo(() => profileFiltered.filter(e => {
    if (filterCategory !== "all" && normalizeFilter(e.category) !== normalizeFilter(filterCategory)) return false;
    if (rangeStart) {
      const d = new Date((e.date?.slice(0, 10) || "") + "T00:00:00");
      if (isNaN(d.getTime()) || d < rangeStart) return false;
    }
    return matchesExpenseSearch(e, searchQuery);
  }), [profileFiltered, filterCategory, searchQuery, rangeStart]);
  // List ordering is user-selectable. Filters (above) drive totals/chart; sort
  // only reorders the rendered rows.
  const sortedExpenses = useMemo(() => sortExpenses(filtered, sortBy), [filtered, sortBy]);
  const total = useMemo(() => filtered.reduce((s, e) => s + e.amount, 0), [filtered]);

  // Group by category
  const byCategory = useMemo(() => filtered.reduce((acc: Record<string, number>, e) => {
    acc[e.category] = (acc[e.category] || 0) + e.amount;
    return acc;
  }, {}), [filtered]);
  const chartData = useMemo(() => Object.entries(byCategory).map(([name, amount]) => ({ name, amount: Number(amount.toFixed(2)) })).sort((a, b) => a.name.localeCompare(b.name)), [byCategory]);
  const categories = useMemo(() => [...new Set(profileFiltered.map(e => e.category))].sort((a, b) => a.localeCompare(b)), [profileFiltered]);

  // BUG-G: Subscriptions section. Subscription profiles (type==="subscription")
  // are owned by a person via parentProfileId. Respect the active profile filter:
  // show all when "everyone", otherwise only subs whose parent is selected (or
  // the sub itself is directly selected). Exclude soft-deleted rows.
  const subscriptions = useMemo(() => {
    const selected = filterMode === "everyone" ? null : new Set(filterIds);
    return (profiles || []).filter((p: any) => {
      if (p.type !== "subscription") return false;
      if (p.deletedAt || p.deleted_at) return false;
      if (!selected) return true;
      return selected.has(p.id) || (p.parentProfileId && selected.has(p.parentProfileId));
    });
  }, [profiles, filterMode, filterIds]);

  // Group loans by loan_name
  const loanGroups = useMemo(() => loanSchedules.reduce((acc: Record<string, any[]>, entry: any) => {
    const name = entry.loan_name || "Unknown";
    (acc[name] = acc[name] || []).push(entry);
    return acc;
  }, {}), [loanSchedules]);

  // ── Early returns (after ALL hooks including useMemo) ──
  if (isLoading) {
    return (
      <StuckLoadingGuard active onRetry={() => refetch()}>
        <div className="p-4 space-y-3">
          <Skeleton className="h-8 w-48 rounded-full" />
          <BubbleSkeletonGrid count={4} rows={2} height={140} className="grid-cols-1 sm:grid-cols-2" />
        </div>
      </StuckLoadingGuard>
    );
  }

  if (error) return (
    <div className="p-4 text-center">
      <AlertCircle className="h-8 w-8 text-destructive mx-auto mb-2" />
      <p className="text-sm text-destructive">Failed to load data</p>
      <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>Retry</Button>
    </div>
  );

  return (
    <div className="p-4 md:p-6 space-y-6 overflow-y-auto h-full pb-24" data-testid="page-finance">
      <div>
        <div className="flex items-center gap-3 mb-4">
          {/* Hub-embedded (2026-07): shell owns back-nav + profile switcher. */}
          {!hubEmbedded && (<>
          {/* Round-6 fix (BUG-014): previously rendered a wouter <Link href="/dashboard"/>
              which navigates but does not pop history. On some platforms (mobile back
              gesture, dashboard → finance → expense detail → back) this could end up
              looking inert. Use a real button that calls history.back() with a hard
              fallback to /dashboard when there's nothing to pop. */}
          <button
            type="button"
            onClick={() => {
              if (window.history.length > 1) {
                window.history.back();
              } else {
                window.location.href = "/dashboard";
              }
            }}
            className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors"
            aria-label="Back"
            data-testid="button-back"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>

          <MultiProfileFilter
            // Reactive via useProfileScope — the chip writes to the global store
            // and this page re-renders from it; no local state to sync.
            onChange={() => {}}
            compact
          />
          </>)}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search expenses…"
                className="h-8 w-[180px] pl-8 pr-7 text-xs"
                data-testid="input-expense-search"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="Clear search"
                  data-testid="btn-clear-expense-search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <Select value={filterCategory} onValueChange={setFilterCategory}>
              <SelectTrigger className="w-[130px] h-8 text-xs" data-testid="select-category-filter">
                <Filter className="h-3 w-3 mr-1" />
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {categories.map(c => (
                  <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={dateRange} onValueChange={(v) => setDateRange(v as typeof dateRange)}>
              <SelectTrigger className="w-[130px] h-8 text-xs" data-testid="select-expense-range">
                <CalendarDays className="h-3 w-3 mr-1" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All time</SelectItem>
                <SelectItem value="month">This month</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
                <SelectItem value="year">This year</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
              <SelectTrigger className="w-[150px] h-8 text-xs" data-testid="select-expense-sort">
                <ArrowUpDown className="h-3 w-3 mr-1" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="date-desc">Newest first</SelectItem>
                <SelectItem value="date-asc">Oldest first</SelectItem>
                <SelectItem value="amount-desc">Amount: high → low</SelectItem>
                <SelectItem value="amount-asc">Amount: low → high</SelectItem>
                <SelectItem value="name-asc">Name: A → Z</SelectItem>
              </SelectContent>
            </Select>
            {/* ADD EXPENSE LIVES WITH THE EXPENSES (2026-08-13, user request).
                Logging a spend was the first thing on the page — above net
                worth, cash flow and every account — which made Finance read as
                a data-entry form rather than a picture of your money. The
                dialog stays here (it is a portal, and `addOpen` is also driven
                by the ?new=expense deep link), but its trigger now sits in the
                Recent Expenses header, where expenses are actually browsed. */}
            <Dialog open={addOpen} onOpenChange={(open) => { setAddOpen(open); if (!open) { setNewExpense({ description: "", amount: "", category: "general", vendor: "", date: todayLocalISO }); setAddAttempt(false); } }}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Expense</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <div><Label className="text-xs">Description <span className="text-destructive">*</span></Label>
                    <Input
                      placeholder="What was it for?"
                      value={newExpense.description}
                      onChange={e => setNewExpense(p => ({ ...p, description: e.target.value }))}
                      data-testid="input-expense-description"
                      aria-invalid={addAttempt && !newExpense.description.trim() ? true : undefined}
                      className={addAttempt && !newExpense.description.trim() ? "border-destructive focus-visible:ring-destructive" : ""}
                    /></div>
                  <div className="grid grid-cols-2 gap-3">
                    <div><Label className="text-xs">Amount ($) <span className="text-destructive">*</span></Label>
                      {/* U5: enforce non-negative amounts at the input level */}
                      <Input
                        type="number" inputMode="decimal" step="0.01" min="0" max="999999999"
                        placeholder="0.00"
                        value={newExpense.amount}
                        onChange={e => setNewExpense(p => ({ ...p, amount: e.target.value }))}
                        data-testid="input-expense-amount"
                        aria-invalid={addAttempt && (!newExpense.amount || parseFloat(newExpense.amount) <= 0) ? true : undefined}
                        className={addAttempt && (!newExpense.amount || parseFloat(newExpense.amount) <= 0) ? "border-destructive focus-visible:ring-destructive" : ""}
                      /></div>
                    <div><Label className="text-xs">Category</Label>
                      <Select value={newExpense.category} onValueChange={v => setNewExpense(p => ({ ...p, category: v }))}>
                        <SelectTrigger data-testid="select-expense-category"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {EXPENSE_CATEGORIES.map(c => (<SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>))}
                        </SelectContent>
                      </Select></div>
                  </div>
                  <div><Label className="text-xs">Vendor (optional)</Label>
                    <Input placeholder="Store or vendor name" value={newExpense.vendor} onChange={e => setNewExpense(p => ({ ...p, vendor: e.target.value }))} data-testid="input-expense-vendor" /></div>
                  {/* Round-6 fix (BUG-016): Add Expense was missing a Date field, while Edit Expense had one.
                      Default to today (user TZ); user can override for backdated entries. */}
                  <div><Label className="text-xs">Date</Label>
                    <Input type="date" value={newExpense.date} onChange={e => setNewExpense(p => ({ ...p, date: e.target.value }))} data-testid="input-expense-date" /></div>
                  <div><Label className="text-xs">Profile</Label>
                    <Select value={expenseProfileId} onValueChange={setExpenseProfileId}>
                      <SelectTrigger data-testid="select-expense-profile"><SelectValue placeholder="Profile" /></SelectTrigger>
                      <SelectContent>
                        {(profiles || []).filter((p: any) => ["self", "person", "pet"].includes(p.type)).sort(sortProfilesForSelect).map((p: any) => (
                          <SelectItem key={p.id} value={p.id}>{p.type === "self" ? "Me" : p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select></div>
                  {/* Paid from — optional. Choosing an account links the expense
                      to it AND moves that account's balance, so the ledger and
                      the balance can't drift apart. Only rendered once the user
                      actually has accounts. */}
                  {accountOptions.length > 0 && (
                    <div><Label className="text-xs">Paid from (optional)</Label>
                      <Select value={expenseAccountId || "__none"} onValueChange={v => setExpenseAccountId(v === "__none" ? "" : v)}>
                        <SelectTrigger data-testid="select-expense-account"><SelectValue placeholder="No account" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none">Don't track an account</SelectItem>
                          {accountOptions.map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.name} — {formatMoney(a.balance)}{a.isDebt ? " owed" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select></div>
                  )}
                  {/* BUG-023: validation feedback. Before submit attempt: show
                      a muted hint. After submit attempt with errors: show a
                      prominent destructive-colour message AND highlight the
                      offending field(s) with red borders (see aria-invalid /
                      className on inputs above). */}
                  {(!newExpense.description.trim() || !newExpense.amount || parseFloat(newExpense.amount) <= 0) && (
                    <p
                      className={addAttempt ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}
                      data-testid="hint-expense-required"
                    >
                      {!newExpense.description.trim() && !newExpense.amount
                        ? "Description and amount are required"
                        : !newExpense.description.trim()
                        ? "Description is required"
                        : !newExpense.amount
                        ? "Amount is required"
                        : "Amount must be greater than $0"}
                    </p>
                  )}
                  <Button
                    className="w-full"
                    onClick={() => {
                      // BUG-023: mark submit-attempted so red borders appear
                      // on the empty required fields. Defensive client-side
                      // checks still surface a toast; server validates too.
                      setAddAttempt(true);
                      if (!newExpense.description.trim()) {
                        toast({ title: "Description is required", variant: "destructive" });
                        return;
                      }
                      const amt = parseFloat(newExpense.amount);
                      if (!newExpense.amount || isNaN(amt) || amt <= 0) {
                        toast({ title: "Amount must be greater than $0", variant: "destructive" });
                        return;
                      }
                      // Snapshot the payload BEFORE resetting the form (see the
                      // RACE FIX comment on addExpenseMutation).
                      addExpenseMutation.mutate({
                        description: newExpense.description,
                        amount: amt,
                        category: newExpense.category,
                        vendor: newExpense.vendor || undefined,
                        date: newExpense.date,
                        profileId: expenseProfileId || undefined,
                        accountId: expenseAccountId || undefined,
                      });
                      // Close immediately — optimistic insert already populated the list.
                      setAddOpen(false);
                      setNewExpense({ description: "", amount: "", category: "general", vendor: "", date: todayLocalISO });
                      setExpenseAccountId("");
                      setAddAttempt(false);
                    }}
                    disabled={!newExpense.description.trim() || !newExpense.amount || !Number.isFinite(parseFloat(newExpense.amount)) || parseFloat(newExpense.amount) <= 0 || addExpenseMutation.isPending}
                    data-testid="button-save-expense"
                  >
                    {addExpenseMutation.isPending ? "Saving..." : "Save Expense"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">Expense tracking and analysis{filterCategory !== "all" && ` — ${filterCategory}`}</p>
      </div>

      {/* ── Connected accounts (Stripe Financial Connections) ──
          Real bank balances, transactions, cash flow, spending, income and
          liabilities. Renders a compact "connect a bank" prompt when nothing is
          linked, so it never crowds out the manual view below. All totals come
          from the server's shared/finance-calc.ts module. */}
      <ConnectedFinance />

      {/* ── Money overview (2026-07 redesign) ── replaces the two ad-hoc KPI
          grids with the mockup snapshot/budgets/bills/balance-sheet/breakdown
          cards. All values derive from data already fetched above. */}
      {(() => {
        const snap = enhanced?.financeSnapshot || {};
        const assetValue = Number(snap.totalAssetValue || 0);
        const liabilities = Number(snap.totalLiabilities || 0);
        const netWorth = assetValue - liabilities;

        // Net-worth trend: history is newest-first → reverse to oldest→newest.
        const nwSeries = (Array.isArray(nwHistory) ? nwHistory : [])
          .map((r: any) => Number(r.netWorth ?? r.net_worth ?? 0))
          .filter((n: number) => Number.isFinite(n))
          .reverse();
        const momPct = nwSeries.length >= 2 && nwSeries[0] !== 0
          ? ((nwSeries[nwSeries.length - 1] - nwSeries[0]) / Math.abs(nwSeries[0])) * 100
          : (typeof snap.spendTrend === "number" ? null : null);

        // Cash flow: monthly income vs (month spend + monthlyized bills).
        const monthlyIncome = (incomes || []).reduce(
          (s: number, i: any) => s + toMonthlyAmount(Number(i.amount) || 0, i.frequency), 0);
        const spendMtd = Number(snap.totalMonthlySpend || 0);
        const cashOut = spendMtd + Number(snap.monthlyObligationTotal || 0);
        const savingsRate = monthlyIncome > 0 ? Math.round(((monthlyIncome - spendMtd) / monthlyIncome) * 100) : null;

        // Budgets: limit from /api/budgets, spent from snapshot.spendByCategory.
        const spendByCat: Record<string, number> = snap.spendByCategory || {};
        const budgetRows = (budgets || [])
          .map((b: any) => ({
            category: String(b.category || "general"),
            limit: Number(b.amount ?? b.limit ?? 0),
            spent: Number(spendByCat[String(b.category || "").toLowerCase()] ?? spendByCat[b.category] ?? 0),
          }))
          .filter((b: { limit: number }) => b.limit > 0);

        const bills14 = (Array.isArray(snap.upcomingBills) ? snap.upcomingBills : [])
          .filter((b: any) => typeof b.daysUntil === "number" && b.daysUntil <= 14)
          .slice(0, 8);

        const monthLabel = new Date().toLocaleDateString("en-US", { month: "short", timeZone: BROWSER_TIMEZONE }).toUpperCase();

        // Financial alerts & insights — derived, honest, each deep-links.
        const alerts: Array<{ id: string; text: string; tone: "pos" | "neg" | "warn"; onClick?: () => void }> = [];
        const overdue = (Array.isArray(snap.upcomingBills) ? snap.upcomingBills : []).filter((b: any) => b.status === "overdue");
        if (overdue.length > 0) alerts.push({ id: "overdue", tone: "neg", text: `You have ${overdue.length} overdue bill${overdue.length > 1 ? "s" : ""} totaling $${overdue.reduce((s: number, b: any) => s + (Number(b.amount) || 0), 0).toLocaleString()}.`, onClick: () => setFinancePopup("cashflow") });
        const breached = budgetRows.filter(b => b.spent > b.limit);
        for (const b of breached.slice(0, 2)) alerts.push({ id: `budget-${b.category}`, tone: "warn", text: `${b.category[0].toUpperCase()}${b.category.slice(1)} spending is over budget (${Math.round((b.spent / b.limit) * 100)}%).`, onClick: () => setFinancePopup("budget") });
        if (savingsRate != null && savingsRate >= 15) alerts.push({ id: "savings", tone: "pos", text: `Great job — you're saving ${savingsRate}% of income this month.` });
        const soonBill = bills14.filter((b: any) => b.daysUntil >= 0 && b.daysUntil <= 7);
        if (soonBill.length > 0) alerts.push({ id: "soon", tone: "warn", text: `${soonBill.length} bill${soonBill.length > 1 ? "s" : ""} due in the next 7 days totaling $${soonBill.reduce((s: number, b: any) => s + (Number(b.amount) || 0), 0).toLocaleString()}.`, onClick: () => setFinancePopup("cashflow") });

        // Multi-month cash-flow trend (last 6 months) — shared helper so the
        // Cash Flow Overview popup plots the exact same series.
        const cashTrend = buildCashTrend(expenses as any[], monthlyIncome);
        // Per-KPI mini-chart series.
        const spendSeries = cashTrend.map(c => c.outflow);
        const incomeSeries = cashTrend.map(c => c.inflow);
        const billsSeries = bills14.map((b: any) => Number(b.amount) || 0);

        return (
          <MoneyOverview
            netWorth={netWorth}
            assets={assetValue}
            liabilities={liabilities}
            momPct={momPct}
            nwSeries={nwSeries}
            cashIn={monthlyIncome}
            cashOut={cashOut}
            spendMtd={spendMtd}
            spendTrendPct={typeof snap.spendTrend === "number" ? snap.spendTrend : null}
            incomeMtd={monthlyIncome}
            budgets={budgetRows}
            bills={bills14}
            spendByCategory={spendByCat}
            cashTrend={cashTrend}
            spendSeries={spendSeries}
            incomeSeries={incomeSeries}
            billsSeries={billsSeries}
            alerts={alerts}
            assetBreakdown={Array.isArray(snap.assetBreakdown) ? snap.assetBreakdown.map((a: any) => ({ id: a.id, name: a.name, type: a.type, value: Number(a.value ?? a.grossValue ?? 0) })) : []}
            liabilityBreakdown={Array.isArray(snap.liabilityBreakdown) ? snap.liabilityBreakdown.map((l: any) => ({ id: l.id, name: l.name, type: l.type, value: Number(l.value ?? l.grossValue ?? 0) })) : []}
            monthLabel={monthLabel}
            onPayBill={(bill) => payBillMut.mutate({ id: bill.id, amount: bill.amount })}
            payingId={payBillMut.isPending ? (payBillMut.variables as any)?.id : null}
            onOpenNetWorth={() => setFinancePopup("networth")}
            onOpenCashFlow={() => setFinancePopup("cashflow")}
            onOpenBudget={() => setFinancePopup("budget")}
            onOpenSpend={() => setFinancePopup("spend")}
            onOpenIncome={() => setFinancePopup("income")}
            onOpenBills={() => setFinancePopup("bills")}
            onOpenSavings={() => setFinancePopup("savings")}
            onOpenOverview={() => setFinancePopup("overview")}
            onCategoryClick={(cat) => { setFilterCategory(cat); setSearchQuery(""); }}
          />
        );
      })()}

      {/* Money drill-down popups (2026-07 redesign): every KPI card opens its
          OWN bespoke popup — waterfall for cash flow, heat calendar for spend,
          source streams for income, due-date timeline for bills, gauge for
          savings rate, analytics donut+trend for the overview. Net Worth and
          Budget keep their full CRUD popups from HeroKPIPopups. */}
      {(() => {
        const fc: "all" | "selected" | "everyone" = (filterMode === "selected" ? "selected" : "everyone");
        const snap = enhanced?.financeSnapshot || {};
        const monthlyIncome = (incomes || []).reduce((s: number, i: any) => s + toMonthlyAmount(Number(i.amount) || 0, i.frequency), 0);
        const spendMtd = Number(snap.totalMonthlySpend || 0);
        const recurringOut = Number(snap.monthlyObligationTotal || 0);
        const spendByCat: Record<string, number> = snap.spendByCategory || {};
        const upcomingBills = Array.isArray(snap.upcomingBills) ? snap.upcomingBills : [];
        const monthLabel = new Date().toLocaleDateString("en-US", { month: "short", timeZone: BROWSER_TIMEZONE }).toUpperCase();
        const ymNow = new Date().toLocaleDateString("en-CA", { timeZone: BROWSER_TIMEZONE }).slice(0, 7);
        const monthExpenses = (Array.isArray(expenses) ? expenses : []).filter((e: any) => String(e.date || "").slice(0, 7) === ymNow);
        const cashTrend = buildCashTrend(expenses as any[], monthlyIncome);
        const closer = (o: boolean) => !o && setFinancePopup(null);
        return (
          <>
            <NetWorthPopup open={financePopup === "networth"} onOpenChange={closer} filterMode={fc} filterIds={filterIds} />
            <BudgetPopup open={financePopup === "budget"} onOpenChange={closer} filterMode={fc} filterIds={filterIds} monthlyIncome={monthlyIncome} />
            <CashFlowWaterfallPopup open={financePopup === "cashflow"} onOpenChange={closer}
              monthLabel={monthLabel} cashIn={monthlyIncome} spendMtd={spendMtd} recurringOut={recurringOut}
              incomes={incomes || []} spendByCategory={spendByCat} />
            <SpendPopup open={financePopup === "spend"} onOpenChange={closer}
              monthLabel={monthLabel} spendMtd={spendMtd}
              spendTrendPct={typeof snap.spendTrend === "number" ? snap.spendTrend : null}
              spendByCategory={spendByCat} monthExpenses={monthExpenses} />
            <IncomePopup open={financePopup === "income"} onOpenChange={closer}
              incomes={incomes || []} monthlyIncome={monthlyIncome} />
            <BillsDuePopup open={financePopup === "bills"} onOpenChange={closer}
              bills={upcomingBills}
              onPayBill={(bill) => payBillMut.mutate({ id: bill.id, amount: bill.amount })}
              payingId={payBillMut.isPending ? (payBillMut.variables as any)?.id : null} />
            <SavingsRatePopup open={financePopup === "savings"} onOpenChange={closer}
              incomeMtd={monthlyIncome} spendMtd={spendMtd} />
            <CashFlowOverviewPopup open={financePopup === "overview"} onOpenChange={closer}
              cashIn={monthlyIncome} cashOut={spendMtd + recurringOut}
              cashTrend={cashTrend} monthLabel={monthLabel} />
          </>
        );
      })()}

      {chartData.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Spending by Category</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} className="capitalize" />
                  <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `$${v}`} />
                  <Tooltip
                    formatter={(v: number) => [`$${v.toFixed(2)}`, "Amount"]}
                    contentStyle={{
                      background: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "8px",
                      fontSize: "12px",
                    }}
                  />
                  <Bar dataKey="amount" radius={[6, 6, 0, 0]}>
                    {chartData.map((entry) => (
                      <Cell key={entry.name} fill={categoryColors[entry.name] || categoryColors.general} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      {subscriptions.length > 0 && (
        <Card data-testid="subscriptions-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Subscriptions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border">
              {subscriptions.slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((sub: any) => {
                const cost = Number(sub.fields?.cost ?? sub.fields?.amount ?? 0);
                const freq = sub.fields?.frequency || "monthly";
                const parent = (profiles || []).find((p: any) => p.id === sub.parentProfileId);
                return (
                  <Link key={sub.id} href={`/profiles/${sub.id}`}>
                    <div className="flex items-center gap-3 py-3 cursor-pointer hover:bg-muted/40 rounded-md px-1" data-testid={`subscription-${sub.id}`}>
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                        <Repeat className="h-3.5 w-3.5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm truncate">{sub.name}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <Badge variant="secondary" className="text-xs capitalize">{freq}</Badge>
                          {parent && <span className="text-xs text-muted-foreground truncate">{parent.name}</span>}
                        </div>
                      </div>
                      {cost > 0 && <span className="text-sm font-semibold tabular-nums shrink-0">${cost.toFixed(2)}</span>}
                    </div>
                  </Link>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Accounts ──
          Sits down here rather than at the top: the KPIs and cash flow above
          are what you check daily, while account balances are reference data
          you maintain occasionally. These are profiles (`type: "account"`, and
          investment/brokerage profiles too), so the balances here are the same
          rows that feed Net Worth, the balance sheet and cash flow above —
          one record per account, never a second copy of the same money. */}
      <AccountsSection profiles={(profiles as any[]) || []} />

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm font-semibold">Recent Expenses</CardTitle>
            {/* The one manual Add Expense affordance, next to the list it adds to. */}
            <Button size="sm" className="h-8 text-xs" onClick={() => setAddOpen(true)} data-testid="button-add-expense">
              <Plus className="h-3.5 w-3.5 mr-1" /> Add Expense
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {profileFiltered.length === 0 ? (
            <EmptyState icon={DollarSign} label="No expenses logged yet." hint={'Try: "spent $50 on groceries"'} />
          ) : (
            <div className="divide-y divide-border">
              {filtered.length === 0 && profileFiltered.length > 0 && (
                <EmptyState icon={Filter} label="No expenses match the selected filter." />
              )}
              {/* Order driven by the Sort control (defaults to newest first). */}
              {sortedExpenses.map((expense) => (
                <ExpandableRow
                  key={expense.id}
                  testId={`expense-${expense.id}`}
                  summary={
                    <>
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                        <ShoppingCart className="h-3.5 w-3.5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm truncate">{expense.description}</p>
                        <span className="text-xs text-muted-foreground">{formatListDate(expense.date)}</span>
                      </div>
                      <span className="text-sm font-semibold tabular-nums shrink-0">{formatMoney(expense.amount)}</span>
                    </>
                  }
                  detail={
                    <div className="space-y-2 pt-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <Badge variant="secondary" className="capitalize">{expense.category}</Badge>
                        {expense.vendor && <span className="text-muted-foreground">{expense.vendor}</span>}
                        <span className="text-muted-foreground">
                          {new Date((expense.date?.slice(0, 10) || "") + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "long", day: "numeric", year: "numeric" })}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={stopProp(() => setEditingExpense(expense))} data-testid={`btn-edit-expense-${expense.id}`}><Pencil className="h-3 w-3" /> Edit</Button>
                        <Button variant="outline" size="sm" className="h-7 text-xs gap-1 text-destructive" onClick={stopProp(() => setDeleteConfirmId(expense.id))} data-testid={`btn-delete-expense-${expense.id}`}><Trash2 className="h-3 w-3" /> Delete</Button>
                      </div>
                    </div>
                  }
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit Expense Dialog */}
      <Dialog open={!!editingExpense} onOpenChange={(open) => { if (!open) { setEditingExpense(null); setEditForm({ description: "", amount: "", category: "", vendor: "", date: "", profileId: "" }); setEditSaving(false); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Edit Expense</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Description</Label><Input value={editForm.description} onChange={e => setEditForm(f => ({...f, description: e.target.value}))} /></div>
            {/* U5: enforce non-negative amounts at the input level */}
            <div><Label>Amount</Label><Input type="number" inputMode="decimal" step="0.01" min="0" max="999999999" value={editForm.amount} onChange={e => setEditForm(f => ({...f, amount: e.target.value}))} /></div>
            <div><Label>Category</Label>
              <Select value={editForm.category} onValueChange={v => setEditForm(f => ({...f, category: v}))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["automotive","education","entertainment","food","general","health","housing","insurance","pet","shopping","subscription","transport","travel","utilities"].map(c => (
                    <SelectItem key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div><Label>Vendor</Label><Input value={editForm.vendor} onChange={e => setEditForm(f => ({...f, vendor: e.target.value}))} placeholder="Optional" /></div>
            {/* U11: prevent picking a future date for an already-incurred expense */}
            <div><Label>Date</Label><Input type="date" max={new Date().toISOString().slice(0,10)} value={editForm.date} onChange={e => setEditForm(f => ({...f, date: e.target.value}))} /></div>
            {/* Round-6 fix (BUG-017): Edit Expense was missing the Profile field that Add Expense already had.
                Match parity so re-assigning is possible without delete+recreate. */}
            <div><Label>Profile</Label>
              <Select value={editForm.profileId} onValueChange={v => setEditForm(f => ({ ...f, profileId: v }))}>
                <SelectTrigger data-testid="select-edit-expense-profile"><SelectValue placeholder="Profile" /></SelectTrigger>
                <SelectContent>
                  {(profiles || []).filter((p: any) => ["self", "person", "pet"].includes(p.type)).sort(sortProfilesForSelect).map((p: any) => (
                    <SelectItem key={p.id} value={p.id}>{p.type === "self" ? "Me" : p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setEditingExpense(null)} disabled={editSaving}>Cancel</Button>
              <Button className="flex-1" disabled={!editForm.description.trim() || !editForm.amount || parseFloat(editForm.amount) <= 0 || editSaving} onClick={async () => {
                if (!editingExpense) return;
                const targetId = editingExpense.id;
                const newDesc = editForm.description;
                const newAmount = parseFloat(editForm.amount);
                const newCategory = editForm.category;
                const newVendor = editForm.vendor || undefined;
                const newDate = editForm.date || undefined;
                const newProfiles = editForm.profileId ? [editForm.profileId] : undefined;
                // Optimistic in-place edit across every cached expense list
                await queryClient.cancelQueries({ queryKey: ["/api/expenses"] });
                const prev = queryClient.getQueriesData({ queryKey: ["/api/expenses"] });
                queryClient.setQueriesData({ queryKey: ["/api/expenses"] }, (old: any) => {
                  const patch = (e: any) => e.id !== targetId ? e : {
                    ...e,
                    description: newDesc,
                    amount: newAmount,
                    category: newCategory,
                    vendor: newVendor,
                    ...(newDate ? { date: newDate } : {}),
                    ...(newProfiles ? { linkedProfiles: newProfiles } : {}),
                  };
                  if (!old) return old;
                  if (Array.isArray(old)) return old.map(patch);
                  if (Array.isArray(old?.items)) return { ...old, items: old.items.map(patch) };
                  return old;
                });
                // Close the dialog immediately
                toast({ title: `"${newDesc}" updated` });
                setEditingExpense(null);
                setEditSaving(true);
                try {
                  await apiRequest("PATCH", `/api/expenses/${targetId}`, {
                    description: newDesc,
                    amount: newAmount,
                    category: newCategory,
                    vendor: newVendor,
                    date: newDate,
                    // Round-6 fix (BUG-017): persist the chosen profile linkage.
                    ...(newProfiles ? { linkedProfiles: newProfiles } : {}),
                  });
                  invalidateDomain("expenses");
                } catch (err: any) {
                  for (const [key, data] of prev) queryClient.setQueryData(key, data);
                  toast({ title: "Failed to update", description: formatApiError(err), variant: "destructive" });
                }
                finally { setEditSaving(false); }
              }}>{editSaving ? "Saving…" : "Save Changes"}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Deeper tools (collapsible) ── paychecks, income, loans, cashflow */}
      <button
        onClick={() => setShowMore(v => !v)}
        className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors pt-2"
        data-testid="finance-toggle-more"
      >
        <ChevronDown className={`h-4 w-4 transition-transform ${showMore ? "rotate-180" : ""}`} />
        {showMore ? "Hide" : "More"} — paychecks, income, loan schedules, cash flow
      </button>
      {showMore && (<>
      {/* ── Paychecks Section ── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="micro-label text-muted-foreground flex items-center gap-1.5">
            <Wallet className="h-3.5 w-3.5" /> Expected Paychecks ({paychecks.length})
          </h2>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAddPaycheckOpen(true)} data-testid="button-add-paycheck">
            <Plus className="h-3 w-3 mr-1" /> Add Paycheck
          </Button>
        </div>
        {paychecks.length === 0 ? (
          <div className="rounded-xl border border-border/40 px-3 py-6 text-center">
            <p className="text-sm text-muted-foreground">No paychecks scheduled.</p>
          </div>
        ) : (
          <div className="rounded-xl border border-border/40 divide-y divide-border/30 overflow-hidden">
            {/* Most recent expected date first (was alphabetical by source, which
                buried recent paychecks under old stale ones the user flagged). */}
            {paychecks.slice().sort((a: any, b: any) => new Date(b.expected_date || '').getTime() - new Date(a.expected_date || '').getTime() || (a.source || '').localeCompare(b.source || '')).map((pc: any) => {
              // Round-6 fix (BUG-024): user reported the "Received" badge appearing on
              // paychecks before their expected date. The server allowed confirm at any
              // time. Gate the Received button at the UI layer so a paycheck can only be
              // marked received once expected_date has actually arrived (in the user's TZ).
              const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: BROWSER_TIMEZONE });
              const expectedISO = (pc.expected_date || '').slice(0, 10);
              const isFuture = expectedISO && expectedISO > todayISO;
              return (
              <ExpandableRow
                key={pc.id}
                testId={`paycheck-${pc.id}`}
                summary={
                  <>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{pc.source}</p>
                      <p className="text-[11px] text-muted-foreground">
                        Expected {new Date(pc.expected_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                      </p>
                    </div>
                    <span className="text-xs font-bold tabular-nums">{formatMoney(pc.actual_amount || pc.amount)}</span>
                    {pc.confirmed ? (
                      <span className="text-[11px] font-semibold text-green-500 flex items-center gap-0.5 shrink-0"><Check className="h-3 w-3" /> Received</span>
                    ) : isFuture ? (
                      <span className="text-[11px] font-medium text-muted-foreground shrink-0">Upcoming</span>
                    ) : (
                      <span className="text-[11px] font-semibold text-red-500 shrink-0">Overdue</span>
                    )}
                  </>
                }
                detail={
                  <div className="space-y-2 pt-1">
                    <p className="text-[11px] text-muted-foreground">
                      Expected {new Date(pc.expected_date).toLocaleDateString(undefined, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' })}
                      {pc.confirmed && pc.received_date && <> · Received {new Date(pc.received_date).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}</>}
                    </p>
                    <div className="flex items-center gap-2">
                      {!pc.confirmed && !isFuture && (
                        <Button variant="outline" size="sm" className="h-7 text-xs gap-1 text-green-600 border-green-500/30"
                          disabled={confirmPaycheckMut.isPending}
                          onClick={stopProp(() => confirmPaycheckMut.mutate({ id: pc.id }))}>
                          <Check className="h-3 w-3" /> Mark received
                        </Button>
                      )}
                      <Button variant="outline" size="sm" className="h-7 text-xs gap-1 text-destructive"
                        type="button"
                        disabled={deletePaycheckMut.isPending}
                        data-testid={`btn-delete-paycheck-${pc.id}`}
                        onClick={stopProp(() => setPaycheckToDelete(pc))}>
                        {deletePaycheckMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />} Delete
                      </Button>
                    </div>
                  </div>
                }
              />
              );
            })}
          </div>
        )}
      </div>

      {/* Add Paycheck Dialog */}
      <Dialog open={addPaycheckOpen} onOpenChange={(open) => { if (!open) setNewPaycheck({ source: "", amount: "", expectedDate: "" }); setAddPaycheckOpen(open); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Paycheck</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label className="text-xs">Source Name <span className="text-destructive">*</span></Label>
              <Input placeholder="e.g. Employer, Freelance" value={newPaycheck.source} onChange={e => setNewPaycheck(p => ({ ...p, source: e.target.value }))} data-testid="input-paycheck-source" /></div>
            <div className="grid grid-cols-2 gap-3">
              {/* U5: enforce non-negative paycheck amounts */}
              <div><Label className="text-xs">Expected Amount ($) <span className="text-destructive">*</span></Label>
                <Input type="number" inputMode="decimal" step="0.01" min="0" max="999999999" placeholder="0.00" value={newPaycheck.amount} onChange={e => setNewPaycheck(p => ({ ...p, amount: e.target.value }))} data-testid="input-paycheck-amount" /></div>
              {/* U12: paycheck is expected/future income — disallow past dates */}
              <div><Label className="text-xs">Expected Date <span className="text-destructive">*</span></Label>
                <Input type="date" min={new Date().toISOString().slice(0,10)} value={newPaycheck.expectedDate} onChange={e => setNewPaycheck(p => ({ ...p, expectedDate: e.target.value }))} data-testid="input-paycheck-date" /></div>
            </div>
            <Button className="w-full" onClick={() => {
              if (!newPaycheck.source.trim() || !newPaycheck.amount || parseFloat(newPaycheck.amount) <= 0 || !newPaycheck.expectedDate) return;
              // Snapshot payload BEFORE resetting the form (race fix).
              addPaycheckMut.mutate({ source: newPaycheck.source, amount: parseFloat(newPaycheck.amount), expectedDate: newPaycheck.expectedDate });
              // Close immediately — optimistic insert already populated the list.
              setAddPaycheckOpen(false);
              setNewPaycheck({ source: "", amount: "", expectedDate: "" });
            }} disabled={!newPaycheck.source.trim() || !newPaycheck.amount || parseFloat(newPaycheck.amount) <= 0 || !newPaycheck.expectedDate || addPaycheckMut.isPending} data-testid="button-save-paycheck">
              {addPaycheckMut.isPending ? "Saving..." : "Add Paycheck"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Income Section ── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="micro-label text-muted-foreground flex items-center gap-1.5">
            <TrendingUp className="h-3.5 w-3.5" /> Income ({incomes.length})
          </h2>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAddIncomeOpen(true)} data-testid="button-add-income">
            <Plus className="h-3 w-3 mr-1" /> Add Income
          </Button>
        </div>
        {incomes.length === 0 ? (
          <div className="rounded-xl border border-border/40 px-3 py-6 text-center">
            <p className="text-sm text-muted-foreground">No recurring income yet.</p>
          </div>
        ) : (
          <div className="rounded-xl border border-border/40 divide-y divide-border/30 overflow-hidden">
            {/* Newest first by date (was alphabetical by description). */}
            {incomes.slice().sort((a: any, b: any) => new Date(b.date || '').getTime() - new Date(a.date || '').getTime() || (b.description || '').localeCompare(a.description || '')).map((inc: any) => (
              <ExpandableRow
                key={inc.id}
                testId={`income-${inc.id}`}
                summary={
                  <>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{inc.description}</p>
                      <p className="text-[11px] text-muted-foreground capitalize">
                        {inc.frequency || 'monthly'}
                        {inc.date ? ` · ${new Date(inc.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}
                      </p>
                    </div>
                    <span className="text-xs font-bold tabular-nums">{formatMoney(Number(inc.amount || 0))}</span>
                  </>
                }
                detail={
                  <div className="space-y-2 pt-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <Badge variant="secondary" className="capitalize">{inc.category || 'income'}</Badge>
                      <span className="text-muted-foreground capitalize">{inc.frequency || 'monthly'}</span>
                      {inc.date && <span className="text-muted-foreground">{new Date(inc.date).toLocaleDateString(undefined, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' })}</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={stopProp(() => setEditingIncome(inc))} data-testid={`btn-edit-income-${inc.id}`}><Pencil className="h-3 w-3" /> Edit</Button>
                      <Button variant="outline" size="sm" className="h-7 text-xs gap-1 text-destructive" disabled={deleteIncomeMut.isPending} onClick={stopProp(() => setIncomeToDelete(inc))} data-testid={`btn-delete-income-${inc.id}`}>
                        {deleteIncomeMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />} Delete
                      </Button>
                    </div>
                  </div>
                }
              />
            ))}
          </div>
        )}
      </div>

      {/* Add Income Dialog */}
      <Dialog open={addIncomeOpen} onOpenChange={(open) => { if (!open) setNewIncome({ description: "", amount: "", category: "salary", frequency: "monthly", date: "", profileId: "" }); setAddIncomeOpen(open); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Income</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Description <span className="text-destructive">*</span></Label>
              <Input placeholder="e.g. Salary, Rental, Dividends" value={newIncome.description}
                onChange={e => setNewIncome(p => ({ ...p, description: e.target.value }))}
                data-testid="input-income-description" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Amount ($) <span className="text-destructive">*</span></Label>
                <Input type="number" inputMode="decimal" step="0.01" min="0" max="999999999" placeholder="0.00"
                  value={newIncome.amount}
                  onChange={e => setNewIncome(p => ({ ...p, amount: e.target.value }))}
                  data-testid="input-income-amount" />
              </div>
              <div>
                <Label className="text-xs">Date</Label>
                <Input type="date" value={newIncome.date}
                  onChange={e => setNewIncome(p => ({ ...p, date: e.target.value }))}
                  data-testid="input-income-date" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Category</Label>
                <Select value={newIncome.category} onValueChange={v => setNewIncome(p => ({ ...p, category: v }))}>
                  <SelectTrigger data-testid="select-income-category"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="salary">Salary</SelectItem>
                    <SelectItem value="freelance">Freelance</SelectItem>
                    <SelectItem value="business">Business</SelectItem>
                    <SelectItem value="rental">Rental</SelectItem>
                    <SelectItem value="investment">Investment</SelectItem>
                    <SelectItem value="gift">Gift</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Frequency</Label>
                <Select value={newIncome.frequency} onValueChange={v => setNewIncome(p => ({ ...p, frequency: v }))}>
                  <SelectTrigger data-testid="select-income-frequency"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="one_time">One-time</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="biweekly">Biweekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
                    <SelectItem value="yearly">Yearly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {/* Bug #5: Income now has a profile picker. Defaults to the
                page-level expenseProfileId chip so users who don't touch it
                still get attribution. */}
            <div>
              <Label className="text-xs">Profile</Label>
              <Select value={newIncome.profileId || expenseProfileId} onValueChange={v => setNewIncome(p => ({ ...p, profileId: v }))}>
                <SelectTrigger data-testid="select-income-profile"><SelectValue placeholder="Profile" /></SelectTrigger>
                <SelectContent>
                  {(profiles || []).filter((p: any) => ["self", "person", "pet", "business"].includes(p.type)).sort(sortProfilesForSelect).map((p: any) => (
                    <SelectItem key={p.id} value={p.id}>{p.type === "self" ? "Me" : p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              className="w-full"
              onClick={() => {
                // Snapshot payload BEFORE resetting the form (race fix), then
                // close immediately — optimistic insert is in onMutate.
                addIncomeMut.mutate({
                  description: newIncome.description,
                  amount: parseFloat(newIncome.amount),
                  category: newIncome.category,
                  frequency: newIncome.frequency,
                  date: newIncome.date || undefined,
                  profileId: newIncome.profileId || undefined,
                });
                setAddIncomeOpen(false);
                setNewIncome({ description: "", amount: "", category: "salary", frequency: "monthly", date: "", profileId: "" });
              }}
              disabled={!newIncome.description.trim() || !newIncome.amount || parseFloat(newIncome.amount) <= 0 || addIncomeMut.isPending}
              data-testid="button-save-income"
            >
              {addIncomeMut.isPending ? "Saving..." : "Add Income"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Income Dialog */}
      <Dialog open={editingIncome !== null} onOpenChange={(open) => { if (!open) setEditingIncome(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Edit Income</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Description <span className="text-destructive">*</span></Label>
              <Input value={editIncomeForm.description}
                onChange={e => setEditIncomeForm(p => ({ ...p, description: e.target.value }))}
                data-testid="input-edit-income-description" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Amount ($) <span className="text-destructive">*</span></Label>
                <Input type="number" inputMode="decimal" step="0.01" min="0" value={editIncomeForm.amount}
                  onChange={e => setEditIncomeForm(p => ({ ...p, amount: e.target.value }))}
                  data-testid="input-edit-income-amount" />
              </div>
              <div>
                <Label className="text-xs">Date</Label>
                <Input type="date" value={editIncomeForm.date}
                  onChange={e => setEditIncomeForm(p => ({ ...p, date: e.target.value }))}
                  data-testid="input-edit-income-date" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Category</Label>
                <Select value={editIncomeForm.category} onValueChange={v => setEditIncomeForm(p => ({ ...p, category: v }))}>
                  <SelectTrigger data-testid="select-edit-income-category"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="salary">Salary</SelectItem>
                    <SelectItem value="freelance">Freelance</SelectItem>
                    <SelectItem value="business">Business</SelectItem>
                    <SelectItem value="rental">Rental</SelectItem>
                    <SelectItem value="investment">Investment</SelectItem>
                    <SelectItem value="gift">Gift</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Frequency</Label>
                <Select value={editIncomeForm.frequency} onValueChange={v => setEditIncomeForm(p => ({ ...p, frequency: v }))}>
                  <SelectTrigger data-testid="select-edit-income-frequency"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="one_time">One-time</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="biweekly">Biweekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
                    <SelectItem value="yearly">Yearly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {/* Bug #5: Edit Income now has a profile picker so users can
                re-attribute income without delete + recreate. */}
            <div>
              <Label className="text-xs">Profile</Label>
              <Select value={editIncomeForm.profileId} onValueChange={v => setEditIncomeForm(p => ({ ...p, profileId: v }))}>
                <SelectTrigger data-testid="select-edit-income-profile"><SelectValue placeholder="Profile" /></SelectTrigger>
                <SelectContent>
                  {(profiles || []).filter((p: any) => ["self", "person", "pet", "business"].includes(p.type)).sort(sortProfilesForSelect).map((p: any) => (
                    <SelectItem key={p.id} value={p.id}>{p.type === "self" ? "Me" : p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              className="w-full"
              onClick={() => {
                if (!editingIncome) return;
                // Close immediately for snappy UX — optimistic edit is in onMutate.
                editIncomeMut.mutate({ id: editingIncome.id });
                setEditingIncome(null);
              }}
              disabled={!editIncomeForm.description.trim() || !editIncomeForm.amount || parseFloat(editIncomeForm.amount) <= 0 || editIncomeMut.isPending}
              data-testid="button-save-edit-income"
            >
              {editIncomeMut.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Income Confirmation */}
      <AlertDialog open={incomeToDelete !== null} onOpenChange={(open) => { if (!open) setIncomeToDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this income?</AlertDialogTitle>
            <AlertDialogDescription>
              {incomeToDelete ? `"${incomeToDelete.description}" ($${Number(incomeToDelete.amount || 0).toLocaleString()}) will be permanently deleted.` : "This income will be permanently deleted."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="btn-confirm-delete-income"
              onClick={() => {
                if (incomeToDelete) deleteIncomeMut.mutate(incomeToDelete);
                setIncomeToDelete(null);
              }}
            >Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Loan Amortization Section ── */}
      <div className="space-y-2">
        <h2 className="micro-label text-muted-foreground flex items-center gap-1.5">
          <Landmark className="h-3.5 w-3.5" /> Loan Schedules ({Object.keys(loanGroups).length})
        </h2>
        {Object.keys(loanGroups).length === 0 ? (
          <div className="rounded-xl border border-border/40 px-3 py-6 text-center">
            <p className="text-sm text-muted-foreground">No loan schedules found.</p>
          </div>
        ) : (
          <>{Object.entries(loanGroups).sort(([a], [b]) => a.localeCompare(b)).map(([loanName, payments]: [string, any[]]) => {
            const nextUnpaid = payments.find((p: any) => !p.paid);
            return (
              <div key={loanName} className="rounded-xl border border-border/40 overflow-hidden">
                <div className="px-3 py-2 bg-muted/30 border-b border-border/30">
                  <p className="text-xs font-semibold">{loanName}</p>
                  <p className="text-[11px] text-muted-foreground">{payments.filter((p: any) => p.paid).length}/{payments.length} payments made</p>
                </div>
                <div className="max-h-48 overflow-y-auto">
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 bg-background">
                      <tr className="text-muted-foreground">
                        <th className="text-left px-2 py-1 font-medium">#</th>
                        <th className="text-left px-2 py-1 font-medium">Date</th>
                        <th className="text-right px-2 py-1 font-medium">Principal</th>
                        <th className="text-right px-2 py-1 font-medium">Interest</th>
                        <th className="text-right px-2 py-1 font-medium">Total</th>
                        <th className="text-right px-2 py-1 font-medium">Remaining</th>
                        <th className="px-2 py-1"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.map((p: any) => {
                        const isCurrent = nextUnpaid?.id === p.id;
                        return (
                          <tr key={p.id}
                            className={` ${p.paid ? 'bg-green-500/5 text-muted-foreground' : ''} ${isCurrent ? 'bg-primary/10 font-medium' : ''}`}>
                            <td className="px-2 py-1">{p.payment_number}</td>
                            <td className="px-2 py-1">{new Date(p.payment_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })}</td>
                            <td className="px-2 py-1 text-right tabular-nums">${p.principal_amount?.toFixed(0)}</td>
                            <td className="px-2 py-1 text-right tabular-nums">${p.interest_amount?.toFixed(0)}</td>
                            <td className="px-2 py-1 text-right tabular-nums font-medium">${p.total_payment?.toFixed(0)}</td>
                            <td className="px-2 py-1 text-right tabular-nums">${p.remaining_balance?.toLocaleString()}</td>
                            <td className="px-2 py-1 text-center">
                              {p.paid ? (
                                <Check className="h-3 w-3 text-green-500 inline" />
                              ) : isCurrent ? (
                                <Button variant="ghost" size="sm" className="h-5 px-1 text-[11px]"
                                  disabled={markLoanPaymentMut.isPending}
                                  onClick={stopProp(() => markLoanPaymentMut.mutate(p.id))}>
                                  Mark Paid
                                </Button>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}</>
        )}
      </div>

      {/* ── Cash Flow Section ── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="micro-label text-muted-foreground flex items-center gap-1.5">
            <BarChart3 className="h-3.5 w-3.5" /> Cash Flow — {new Date(cfMonth + '-01').toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
          </h2>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAddCashflowOpen(true)} data-testid="button-add-cashflow">
            <Plus className="h-3 w-3 mr-1" /> Add Entry
          </Button>
        </div>
        {cashflow.length === 0 ? (
          <div className="rounded-xl border border-border/40 px-3 py-6 text-center">
            <p className="text-sm text-muted-foreground">No cashflow data available.</p>
          </div>
        ) : (
          <div className="rounded-xl border border-border/40 overflow-hidden">
            <div className="grid grid-cols-4 sm:grid-cols-5 divide-x divide-border/30">
              {cashflow.map((wk: any) => {
                const projNet = (wk.projected_income || 0) - (wk.projected_expenses || 0);
                const actNet = wk.actual_income != null || wk.actual_expenses != null
                  ? (wk.actual_income || 0) - (wk.actual_expenses || 0)
                  : null;
                return (
                  <div key={wk.week} className="px-2 py-2 space-y-1">
                    <p className="text-[11px] font-semibold text-muted-foreground">Week {wk.week}</p>
                    <div className="space-y-0.5">
                      <div className="flex justify-between text-[11px]">
                        <span className="text-green-500">In</span>
                        <span className="tabular-nums font-medium text-green-500">${(wk.projected_income || 0).toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-red-400">Out</span>
                        <span className="tabular-nums font-medium text-red-400">${(wk.projected_expenses || 0).toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-[11px] border-t border-border/30 pt-0.5">
                        <span className="font-medium">Net</span>
                        <span className={`tabular-nums font-bold ${projNet >= 0 ? 'text-green-500' : 'text-red-400'}`}>
                          {projNet >= 0 ? '+' : ''}${projNet.toLocaleString()}
                        </span>
                      </div>
                    </div>
                    {actNet != null && (
                      <div className="mt-1 pt-1 border-t border-dashed border-border/30 space-y-0.5">
                        <p className="text-[11px] font-medium text-muted-foreground uppercase">Actual</p>
                        <div className="flex justify-between text-[11px]">
                          <span className="text-green-500">In</span>
                          <span className="tabular-nums text-green-500">${(wk.actual_income || 0).toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between text-[11px]">
                          <span className="text-red-400">Out</span>
                          <span className="tabular-nums text-red-400">${(wk.actual_expenses || 0).toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between text-[11px]">
                          <span className="font-medium">Net</span>
                          <span className={`tabular-nums font-bold ${actNet >= 0 ? 'text-green-500' : 'text-red-400'}`}>
                            {actNet >= 0 ? '+' : ''}${actNet.toLocaleString()}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Add Cashflow Entry Dialog (POST /api/cashflow upserts {month, week, projected_*, actual_*}) */}
      <Dialog open={addCashflowOpen} onOpenChange={(open) => { if (!open) {
        setNewCashflow({ month: new Date().toISOString().slice(0,7), week: "1", projected_income: "", projected_expenses: "", actual_income: "", actual_expenses: "" });
      } setAddCashflowOpen(open); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Cashflow Entry</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Month <span className="text-destructive">*</span></Label>
                <Input type="month" value={newCashflow.month}
                  onChange={e => setNewCashflow(p => ({ ...p, month: e.target.value }))}
                  data-testid="input-cashflow-month" />
              </div>
              <div>
                <Label className="text-xs">Week (1-6) <span className="text-destructive">*</span></Label>
                <Input type="number" min="1" max="6" step="1" value={newCashflow.week}
                  onChange={e => setNewCashflow(p => ({ ...p, week: e.target.value }))}
                  data-testid="input-cashflow-week" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Projected Income ($)</Label>
                <Input type="number" inputMode="decimal" step="0.01" placeholder="0.00" value={newCashflow.projected_income}
                  onChange={e => setNewCashflow(p => ({ ...p, projected_income: e.target.value }))}
                  data-testid="input-cashflow-projected-income" />
              </div>
              <div>
                <Label className="text-xs">Projected Expenses ($)</Label>
                <Input type="number" inputMode="decimal" step="0.01" placeholder="0.00" value={newCashflow.projected_expenses}
                  onChange={e => setNewCashflow(p => ({ ...p, projected_expenses: e.target.value }))}
                  data-testid="input-cashflow-projected-expenses" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Actual Income ($)</Label>
                <Input type="number" inputMode="decimal" step="0.01" placeholder="0.00" value={newCashflow.actual_income}
                  onChange={e => setNewCashflow(p => ({ ...p, actual_income: e.target.value }))}
                  data-testid="input-cashflow-actual-income" />
              </div>
              <div>
                <Label className="text-xs">Actual Expenses ($)</Label>
                <Input type="number" inputMode="decimal" step="0.01" placeholder="0.00" value={newCashflow.actual_expenses}
                  onChange={e => setNewCashflow(p => ({ ...p, actual_expenses: e.target.value }))}
                  data-testid="input-cashflow-actual-expenses" />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">Upserts on (month, week). Leave any number blank to keep its current value.</p>
            <Button
              className="w-full"
              onClick={() => {
                // Snapshot payload BEFORE resetting the form (race fix), then
                // close immediately — optimistic upsert is in onMutate.
                addCashflowMut.mutate({ ...newCashflow });
                setAddCashflowOpen(false);
                setNewCashflow({
                  month: new Date().toISOString().slice(0, 7),
                  week: "1", projected_income: "", projected_expenses: "", actual_income: "", actual_expenses: "",
                });
              }}
              disabled={
                !/^\d{4}-\d{2}$/.test(newCashflow.month) ||
                !newCashflow.week ||
                parseInt(newCashflow.week, 10) < 1 ||
                parseInt(newCashflow.week, 10) > 6 ||
                addCashflowMut.isPending
              }
              data-testid="button-save-cashflow"
            >
              {addCashflowMut.isPending ? "Saving..." : "Save Entry"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      </>)}{/* end collapsible More */}

      {/* U2 fix: Delete Paycheck Confirmation — mirrors the expense pattern below. */}
      <AlertDialog open={paycheckToDelete !== null} onOpenChange={(open) => { if (!open) setPaycheckToDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this paycheck?</AlertDialogTitle>
            <AlertDialogDescription>
              {paycheckToDelete ? `“${paycheckToDelete.source}” ($${Number(paycheckToDelete.actual_amount ?? paycheckToDelete.amount ?? 0).toLocaleString()}) will be permanently deleted.` : "This paycheck will be permanently deleted."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="btn-confirm-delete-paycheck"
              onClick={() => {
                if (paycheckToDelete) deletePaycheckMut.mutate(paycheckToDelete);
                setPaycheckToDelete(null);
              }}
            >Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Expense Confirmation */}
      <AlertDialog open={deleteConfirmId !== null} onOpenChange={(open) => { if (!open) setDeleteConfirmId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Expense?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteConfirmId && (() => { const e = profileFiltered.find(x => x.id === deleteConfirmId); return e ? `"${e.description}" ($${e.amount.toFixed(2)}) will be permanently deleted.` : 'This expense will be permanently deleted.'; })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (!deleteConfirmId) return;
                const targetId = deleteConfirmId;
                const expense = profileFiltered.find(x => x.id === targetId);
                // Close dialog immediately and apply optimistic remove before the network call.
                setDeleteConfirmId(null);
                await queryClient.cancelQueries({ queryKey: ["/api/expenses"] });
                const prev = queryClient.getQueriesData({ queryKey: ["/api/expenses"] });
                queryClient.setQueriesData(
                  { queryKey: ["/api/expenses"] },
                  (old: any) => {
                    if (!old) return old;
                    if (Array.isArray(old)) return old.filter((item: any) => item.id !== targetId);
                    if (Array.isArray(old?.items)) return { ...old, items: old.items.filter((item: any) => item.id !== targetId) };
                    return old;
                  }
                );
                // P2 undo: the full expense row is captured client-side, so the
                // toast offers Undo — restore re-creates via POST /api/expenses
                // (id/createdAt are server-generated and stripped; everything
                // the insert schema accepts is preserved).
                if (expense) {
                  const exp: any = expense;
                  showUndoToast({
                    title: `"${exp.description}" deleted`,
                    onUndo: () => recreateDeleted({
                      url: "/api/expenses",
                      body: {
                        description: exp.description,
                        amount: Number(exp.amount),
                        category: exp.category || "general",
                        vendor: exp.vendor || undefined,
                        isRecurring: exp.isRecurring || undefined,
                        date: exp.date ? String(exp.date).slice(0, 10) : undefined,
                        tags: exp.tags || [],
                        linkedProfiles: exp.linkedProfiles || [],
                      },
                      domains: ["expenses"],
                      queryKeyHead: "/api/expenses",
                      applyOptimistic: (old: any) => {
                        if (Array.isArray(old)) return [exp, ...old];
                        if (Array.isArray(old?.items)) return { ...old, items: [exp, ...old.items] };
                        return old;
                      },
                      successTitle: `"${exp.description}" restored`,
                      errorTitle: "Couldn't restore expense",
                    }),
                  });
                } else {
                  toast({ title: "Expense deleted" });
                }
                try {
                  await apiRequest("DELETE", `/api/expenses/${targetId}`);
                  invalidateDomain("expenses");
                } catch (err: any) {
                  for (const [key, data] of prev) queryClient.setQueryData(key, data);
                  toast({ title: "Failed to delete", description: err?.message || "Unknown error", variant: "destructive" });
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
