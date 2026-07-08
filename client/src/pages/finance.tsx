import { formatApiError } from "@/lib/formatError";
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
import { useState, useEffect, useMemo, lazy, Suspense } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useProfileScope } from "@/hooks/useProfileScope";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { useHubChrome } from "@/components/hub/hub-context";
import { MoneyOverview } from "@/components/finance/MoneyOverview";
import { QuickAddDialog, type QuickAddKind } from "@/components/dashboard/quick-add/QuickAddDialog";
import { hashNavigate } from "@/lib/hashNavigate";

// Money-card drill-downs (2026-07): every card on the Money overview opens the
// SAME popup the dashboard hero tiles use (user rule: never duplicate a popup).
// Lazy so the recharts-heavy chunk loads on first card click, not page mount.
const NetWorthPopup = lazy(() => import("@/components/dashboard/HeroKPIPopups").then(m => ({ default: m.NetWorthPopup })));
const CashFlowPopup = lazy(() => import("@/components/dashboard/HeroKPIPopups").then(m => ({ default: m.CashFlowPopup })));
const BudgetPopup = lazy(() => import("@/components/dashboard/HeroKPIPopups").then(m => ({ default: m.BudgetPopup })));
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
  // U2 fix: confirmation state for paycheck deletion. Holds the paycheck object
  // pending confirmation, or null when no dialog is showing.
  const [paycheckToDelete, setPaycheckToDelete] = useState<{ id: string; source: string; amount: number } | null>(null);
  const [addPaycheckOpen, setAddPaycheckOpen] = useState(false);
  const [newPaycheck, setNewPaycheck] = useState({ source: "", amount: "", expectedDate: "" });

  // ── Income CRUD state ──────────────────────────────────────────────
  // Bug #5: both dialogs now carry profileId so users can re-assign income
  // ownership without delete + recreate (matches Edit Expense at line ~831).
  const [addIncomeOpen, setAddIncomeOpen] = useState(false);
  const [newIncome, setNewIncome] = useState({ description: "", amount: "", category: "salary", frequency: "monthly", date: "", profileId: "" });
  const [editingIncome, setEditingIncome] = useState<any | null>(null);
  const [editIncomeForm, setEditIncomeForm] = useState({ description: "", amount: "", category: "salary", frequency: "monthly", date: "", profileId: "" });
  const [incomeToDelete, setIncomeToDelete] = useState<{ id: string; description: string; amount: number } | null>(null);
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

  // Money-card drill-downs: which dashboard popup is open, plus the quick-add
  // dialog behind the "+ Bill" button on the Bills card.
  const [moneyPopup, setMoneyPopup] = useState<"networth" | "cashflow" | "budget" | null>(null);
  const [quickAddKind, setQuickAddKind] = useState<QuickAddKind | null>(null);

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
  type NewExpenseVars = { description: string; amount: number; category: string; vendor?: string; date: string; profileId?: string };
  const addExpenseMutation = useMutation<{ amount: number; description: string }, Error, NewExpenseVars, { prev: [readonly unknown[], unknown][]; tempId: string }>({
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
      await apiRequest("POST", "/api/expenses", {
        description: desc,
        amount: vars.amount,
        category: vars.category,
        vendor: vars.vendor || undefined,
        date: expenseDate,
        tags: [],
        ...(vars.profileId ? { linkedProfiles: [vars.profileId] } : {}),
      });
      return { amount: vars.amount, description: desc };
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
        linkedProfiles: vars.profileId ? [vars.profileId] : [],
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
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/budgets/summary"] });
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
  // Paychecks
  const { data: paychecks = [] } = useQuery<any[]>({ queryKey: ["/api/paychecks"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/paychecks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/paychecks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      toast({ title: "Paycheck confirmed" });
    },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: "Failed to confirm paycheck", description: formatApiError(err), variant: "destructive" });
    },
  });
  const deletePaycheckMut = useMutation<string, Error, string, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/paychecks/${id}`); return id; },
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ["/api/paychecks"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/paychecks"] });
      queryClient.setQueriesData({ queryKey: ["/api/paychecks"] }, (old: any) =>
        Array.isArray(old) ? old.filter((item: any) => item.id !== id) : old
      );
      return { prev };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/paychecks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      toast({ title: "Paycheck deleted" });
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
      queryClient.invalidateQueries({ queryKey: ["/api/loans/schedule"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      toast({ title: "Loan payment marked as paid" });
    },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: "Failed to mark payment", description: formatApiError(err), variant: "destructive" });
    },
  });

  // ── Incomes (separate from paychecks: recurring income streams) ──────────
  const { data: incomes = [] } = useQuery<any[]>({ queryKey: ["/api/incomes"] });

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
      queryClient.invalidateQueries({ queryKey: ["/api/incomes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/incomes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Income updated" });
    },
    onError: (err: Error, _v, ctx) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: "Failed to update income", description: formatApiError(err), variant: "destructive" });
    },
  });

  const deleteIncomeMut = useMutation<string, Error, string, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/incomes/${id}`); return id; },
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ["/api/incomes"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/incomes"] });
      queryClient.setQueriesData({ queryKey: ["/api/incomes"] }, (old: any) =>
        Array.isArray(old) ? old.filter((i: any) => i.id !== id) : old
      );
      return { prev };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/incomes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Income deleted" });
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
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
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
      <div className="p-4 space-y-3">
        <div className="h-8 w-48 rounded skeleton-shimmer" />
        <div className="h-20 rounded skeleton-shimmer" />
        <div className="h-20 rounded skeleton-shimmer" />
      </div>
    );
  }

  if (error) return (
    <div className="p-4 text-center">
      <AlertCircle className="h-8 w-8 text-destructive mx-auto mb-2" />
      <p className="text-sm text-destructive">Failed to load data</p>
      <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>Retry</Button>
    </div>
  );

  // Monthly income (recurring streams, monthlyized) — powers the Cash Flow
  // card and the BudgetPopup's %-of-income budgeting mode.
  const monthlyIncome = (incomes || []).reduce(
    (s: number, i: any) => s + toMonthlyAmount(Number(i.amount) || 0, i.frequency), 0);

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
            <Dialog open={addOpen} onOpenChange={(open) => { setAddOpen(open); if (!open) { setNewExpense({ description: "", amount: "", category: "general", vendor: "", date: todayLocalISO }); setAddAttempt(false); } }}>
              <DialogTrigger asChild>
                <Button size="sm" className="h-8 text-xs" data-testid="button-add-expense">
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add Expense
                </Button>
              </DialogTrigger>
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
                      });
                      // Close immediately — optimistic insert already populated the list.
                      setAddOpen(false);
                      setNewExpense({ description: "", amount: "", category: "general", vendor: "", date: todayLocalISO });
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
        const spendMtd = Number(snap.totalMonthlySpend || 0);
        const cashOut = spendMtd + Number(snap.monthlyObligationTotal || 0);

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

        // MTD spend by category → the mini strip on the Spend card.
        const spendCats = Object.entries(spendByCat).map(([name, v]) => ({ name, amount: Number(v) || 0 }));

        // Subscriptions summary card (full list stays in the card further down).
        const subsMonthly = subscriptions.reduce((s: number, sub: any) =>
          s + toMonthlyAmount(Number(sub.fields?.cost ?? sub.fields?.amount ?? 0), sub.fields?.frequency || "monthly"), 0);

        // Recent transactions: merged expenses (−) + incomes (+), newest first.
        const recentTxns = [
          ...profileFiltered.map(e => ({
            id: e.id, date: (e.date || "").slice(0, 10),
            name: e.description, category: e.category || "general",
            amount: -Math.abs(Number(e.amount) || 0),
          })),
          ...(incomes || []).filter((i: any) => showTestData || !isTestEntity(i)).map((i: any) => ({
            id: i.id, date: (i.date || "").slice(0, 10),
            name: i.description || "Income", category: "income",
            amount: Math.abs(Number(i.amount) || 0),
          })),
        ].filter(t => t.date).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);

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
            budgets={budgetRows}
            bills={bills14}
            assetBreakdown={Array.isArray(snap.assetBreakdown) ? snap.assetBreakdown.map((a: any) => ({ id: a.id, name: a.name, type: a.type, value: Number(a.value ?? a.grossValue ?? 0) })) : []}
            liabilityBreakdown={Array.isArray(snap.liabilityBreakdown) ? snap.liabilityBreakdown.map((l: any) => ({ id: l.id, name: l.name, type: l.type, value: Number(l.value ?? l.grossValue ?? 0) })) : []}
            monthLabel={monthLabel}
            onAddExpense={() => setAddOpen(true)}
            onPayBill={(bill) => payBillMut.mutate({ id: bill.id, amount: bill.amount })}
            payingId={payBillMut.isPending ? (payBillMut.variables as any)?.id : null}
            onOpenNetWorth={() => setMoneyPopup("networth")}
            onOpenCashFlow={() => setMoneyPopup("cashflow")}
            onOpenSpend={() => setMoneyPopup("budget")}
            onAddBudget={() => setMoneyPopup("budget")}
            onAddBill={() => setQuickAddKind("bill")}
            spendCats={spendCats}
            subs={{ count: subscriptions.length, monthlyTotal: subsMonthly }}
            onViewSubs={() => {
              const el = document.querySelector('[data-testid="subscriptions-card"]');
              if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
              else hashNavigate("/editor/new/subscription");
            }}
            onAddSub={() => hashNavigate("/editor/new/subscription")}
            transactions={recentTxns}
            onTransactionClick={(id) => {
              const exp = (expenses || []).find(e => e.id === id);
              if (exp) { setEditingExpense(exp); return; }
              const inc = (incomes || []).find((i: any) => i.id === id);
              // The Edit Income dialog lives inside the collapsible "More"
              // section — expand it so the dialog can mount.
              if (inc) { setShowMore(true); setEditingIncome(inc); }
            }}
          />
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

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Recent Expenses</CardTitle>
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
                  queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/budgets/summary"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
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
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
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
                      <p className="text-[10px] text-muted-foreground">
                        Expected {new Date(pc.expected_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                      </p>
                    </div>
                    <span className="text-xs font-bold tabular-nums">{formatMoney(pc.actual_amount || pc.amount)}</span>
                    {pc.confirmed ? (
                      <span className="text-[10px] font-semibold text-green-500 flex items-center gap-0.5 shrink-0"><Check className="h-3 w-3" /> Received</span>
                    ) : isFuture ? (
                      <span className="text-[10px] font-medium text-muted-foreground shrink-0">Upcoming</span>
                    ) : (
                      <span className="text-[10px] font-semibold text-red-500 shrink-0">Overdue</span>
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
                        onClick={stopProp(() => setPaycheckToDelete({ id: pc.id, source: pc.source, amount: (pc.actual_amount || pc.amount) }))}>
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
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
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
                      <p className="text-[10px] text-muted-foreground capitalize">
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
                      <Button variant="outline" size="sm" className="h-7 text-xs gap-1 text-destructive" disabled={deleteIncomeMut.isPending} onClick={stopProp(() => setIncomeToDelete({ id: inc.id, description: inc.description, amount: Number(inc.amount || 0) }))} data-testid={`btn-delete-income-${inc.id}`}>
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
              {incomeToDelete ? `"${incomeToDelete.description}" ($${incomeToDelete.amount.toLocaleString()}) will be permanently deleted.` : "This income will be permanently deleted."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="btn-confirm-delete-income"
              onClick={() => {
                if (incomeToDelete) deleteIncomeMut.mutate(incomeToDelete.id);
                setIncomeToDelete(null);
              }}
            >Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Loan Amortization Section ── */}
      <div className="space-y-2">
        <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
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
                  <p className="text-[10px] text-muted-foreground">{payments.filter((p: any) => p.paid).length}/{payments.length} payments made</p>
                </div>
                <div className="max-h-48 overflow-y-auto">
                  <table className="w-full text-[10px]">
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
                            className={`${p.paid ? 'bg-green-500/5 text-muted-foreground' : ''} ${isCurrent ? 'bg-primary/10 font-medium' : ''}`}>
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
                                <Button variant="ghost" size="sm" className="h-5 px-1 text-[10px]"
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
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
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
                    <p className="text-[10px] font-semibold text-muted-foreground">Week {wk.week}</p>
                    <div className="space-y-0.5">
                      <div className="flex justify-between text-[9px]">
                        <span className="text-green-500">In</span>
                        <span className="tabular-nums font-medium text-green-500">${(wk.projected_income || 0).toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-[9px]">
                        <span className="text-red-400">Out</span>
                        <span className="tabular-nums font-medium text-red-400">${(wk.projected_expenses || 0).toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-[9px] border-t border-border/30 pt-0.5">
                        <span className="font-medium">Net</span>
                        <span className={`tabular-nums font-bold ${projNet >= 0 ? 'text-green-500' : 'text-red-400'}`}>
                          {projNet >= 0 ? '+' : ''}${projNet.toLocaleString()}
                        </span>
                      </div>
                    </div>
                    {actNet != null && (
                      <div className="mt-1 pt-1 border-t border-dashed border-border/30 space-y-0.5">
                        <p className="text-[8px] font-medium text-muted-foreground uppercase">Actual</p>
                        <div className="flex justify-between text-[9px]">
                          <span className="text-green-500">In</span>
                          <span className="tabular-nums text-green-500">${(wk.actual_income || 0).toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between text-[9px]">
                          <span className="text-red-400">Out</span>
                          <span className="tabular-nums text-red-400">${(wk.actual_expenses || 0).toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between text-[9px]">
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
            <p className="text-[10px] text-muted-foreground">Upserts on (month, week). Leave any number blank to keep its current value.</p>
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
              {paycheckToDelete ? `“${paycheckToDelete.source}” ($${paycheckToDelete.amount.toLocaleString()}) will be permanently deleted.` : "This paycheck will be permanently deleted."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="btn-confirm-delete-paycheck"
              onClick={() => {
                if (paycheckToDelete) deletePaycheckMut.mutate(paycheckToDelete.id);
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
                toast({ title: `"${expense?.description}" deleted` });
                try {
                  await apiRequest("DELETE", `/api/expenses/${targetId}`);
                  queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/budgets/summary"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
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

      {/* Money-card drill-downs — the SAME popups the dashboard hero tiles
          open: full net worth (assets/liabilities CRUD + trend), full cash
          flow (income / recurring / one-time), full budget + spending
          breakdown (donut, category details, budget CRUD). */}
      <Suspense fallback={null}>
        {moneyPopup === "networth" && (
          <NetWorthPopup open onOpenChange={(o) => { if (!o) setMoneyPopup(null); }} filterMode={filterMode as any} filterIds={filterIds} />
        )}
        {moneyPopup === "cashflow" && (
          <CashFlowPopup open onOpenChange={(o) => { if (!o) setMoneyPopup(null); }} filterMode={filterMode as any} filterIds={filterIds} />
        )}
        {moneyPopup === "budget" && (
          <BudgetPopup open onOpenChange={(o) => { if (!o) setMoneyPopup(null); }} filterMode={filterMode as any} filterIds={filterIds} monthlyIncome={monthlyIncome} />
        )}
      </Suspense>
      {quickAddKind && (
        <QuickAddDialog open kind={quickAddKind} ownerProfileId={selfProfile?.id || ""} onClose={() => setQuickAddKind(null)} />
      )}
    </div>
  );
}
