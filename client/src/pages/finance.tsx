import { formatApiError } from "@/lib/formatError";
import { stopProp } from "@/lib/event-utils";
import { normalizeFilter } from "@/lib/filter-utils";
import { passesProfileFilter } from "@shared/profile-filter";
import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { getProfileFilter } from "@/lib/profileFilter";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
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
import { DollarSign, TrendingUp, ShoppingCart, ArrowLeft, Plus, Filter, AlertCircle, Pencil, Trash2, Check, Wallet, Landmark, BarChart3, Loader2 } from "lucide-react";
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

export default function FinancePage() {
  useEffect(() => { document.title = "Finance — Portol"; }, []);
  const { toast } = useToast();
  const [filterIds, setFilterIds] = useState<string[]>(() => getProfileFilter().selectedIds);
  const [filterMode, setFilterMode] = useState(() => getProfileFilter().mode);
  useEffect(() => {
    const handleFocus = () => {
      const { mode, selectedIds } = getProfileFilter();
      setFilterMode(mode);
      setFilterIds(selectedIds);
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);
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
  const [filterCategory, setFilterCategory] = useState<string>("all");
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

  // ── Income CRUD state ────────────────────────────────────────────────────
  const [addIncomeOpen, setAddIncomeOpen] = useState(false);
  const [newIncome, setNewIncome] = useState({ description: "", amount: "", category: "salary", frequency: "monthly", date: "" });
  const [editingIncome, setEditingIncome] = useState<any | null>(null);
  const [editIncomeForm, setEditIncomeForm] = useState({ description: "", amount: "", category: "salary", frequency: "monthly", date: "" });
  const [incomeToDelete, setIncomeToDelete] = useState<{ id: string; description: string; amount: number } | null>(null);
  useEffect(() => {
    if (editingIncome) {
      setEditIncomeForm({
        description: editingIncome.description ?? "",
        amount: String(editingIncome.amount ?? ""),
        category: editingIncome.category ?? "salary",
        frequency: editingIncome.frequency ?? "monthly",
        date: editingIncome.date?.slice(0, 10) ?? "",
      });
    }
  }, [editingIncome?.id]);

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

  const addExpenseMutation = useMutation({
    mutationFn: async () => {
      // Defense-in-depth: validate amount before sending. The submit button
      // already guards this, but if mutation is invoked any other way we
      // refuse to send a non-finite amount that would coerce to $0 server-side.
      const amt = parseFloat(newExpense.amount);
      if (!isFinite(amt) || amt <= 0) {
        throw new Error("Amount must be a positive number");
      }
      const desc = (newExpense.description || "").trim();
      if (!desc) {
        throw new Error("Description is required");
      }
      // Round-6 fix (BUG-016): honour the user-entered date. Falls back to today
      // in the user's timezone if for some reason the field is cleared.
      const expenseDate = (newExpense.date || "").trim()
        || new Date().toLocaleDateString('en-CA', { timeZone: BROWSER_TIMEZONE });
      await apiRequest("POST", "/api/expenses", {
        description: desc,
        amount: amt,
        category: newExpense.category,
        vendor: newExpense.vendor || undefined,
        date: expenseDate,
        tags: [],
        ...(expenseProfileId ? { linkedProfiles: [expenseProfileId] } : {}),
      });
      return { amount: amt, description: desc };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/budgets/summary"] });
      setAddOpen(false);
      setNewExpense({ description: "", amount: "", category: "general", vendor: "", date: todayLocalISO });
      setAddAttempt(false);
      toast({ title: `$${result.amount.toFixed(2)} expense added`, description: result.description });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add expense", description: formatApiError(err), variant: "destructive" });
    },
  });

  // ── ALL hooks MUST be above early returns (React Rules of Hooks) ──
  // Paychecks
  const { data: paychecks = [] } = useQuery<any[]>({ queryKey: ["/api/paychecks"] });
  const addPaycheckMut = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/paychecks", {
        source: newPaycheck.source.trim(),
        amount: parseFloat(newPaycheck.amount),
        expected_date: newPaycheck.expectedDate,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/paychecks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      toast({ title: "Paycheck added", description: `${newPaycheck.source} — $${parseFloat(newPaycheck.amount).toFixed(2)}` });
      setAddPaycheckOpen(false);
      setNewPaycheck({ source: "", amount: "", expectedDate: "" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add paycheck", description: formatApiError(err), variant: "destructive" });
    },
  });
  const confirmPaycheckMut = useMutation({
    mutationFn: async ({ id, actual_amount }: { id: string; actual_amount?: number }) => {
      await apiRequest("PATCH", `/api/paychecks/${id}/confirm`, { actual_amount });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/paychecks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      toast({ title: "Paycheck confirmed" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to confirm paycheck", description: formatApiError(err), variant: "destructive" });
    },
  });
  const deletePaycheckMut = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/paychecks/${id}`); return id; },
    onSuccess: (_data, id) => {
      queryClient.setQueryData(["/api/paychecks"], (old: any[]) => old?.filter(item => item.id !== id));
      queryClient.invalidateQueries({ queryKey: ["/api/paychecks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      toast({ title: "Paycheck deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete paycheck", description: formatApiError(err), variant: "destructive" });
    },
  });

  // Loan Amortization
  const { data: loanSchedules = [] } = useQuery<any[]>({ queryKey: ["/api/loans/schedule"] });
  const markLoanPaymentMut = useMutation({
    mutationFn: async (id: string) => { await apiRequest("PATCH", `/api/loans/payment/${id}/mark`, {}); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/loans/schedule"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      toast({ title: "Loan payment marked as paid" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to mark payment", description: formatApiError(err), variant: "destructive" });
    },
  });

  // ── Incomes (separate from paychecks: recurring income streams) ──────────
  const { data: incomes = [] } = useQuery<any[]>({ queryKey: ["/api/incomes"] });

  const addIncomeMut = useMutation({
    mutationFn: async () => {
      const amt = parseFloat(newIncome.amount);
      if (!isFinite(amt) || amt <= 0) throw new Error("Amount must be a positive number");
      const desc = newIncome.description.trim();
      if (!desc) throw new Error("Description is required");
      await apiRequest("POST", "/api/incomes", {
        description: desc,
        amount: amt,
        category: newIncome.category,
        frequency: newIncome.frequency,
        date: newIncome.date || new Date().toLocaleDateString('en-CA', { timeZone: BROWSER_TIMEZONE }),
        tags: [],
        ...(expenseProfileId ? { linkedProfiles: [expenseProfileId] } : {}),
      });
      return { description: desc, amount: amt };
    },
    onSuccess: ({ description, amount }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/incomes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      setAddIncomeOpen(false);
      setNewIncome({ description: "", amount: "", category: "salary", frequency: "monthly", date: "" });
      toast({ title: `Income added`, description: `${description} — $${amount.toFixed(2)}` });
    },
    onError: (err: Error) => toast({ title: "Failed to add income", description: formatApiError(err), variant: "destructive" }),
  });

  const editIncomeMut = useMutation({
    mutationFn: async (input: { id: string }) => {
      const amt = parseFloat(editIncomeForm.amount);
      if (!isFinite(amt) || amt <= 0) throw new Error("Amount must be a positive number");
      const desc = editIncomeForm.description.trim();
      if (!desc) throw new Error("Description is required");
      await apiRequest("PATCH", `/api/incomes/${input.id}`, {
        description: desc,
        amount: amt,
        category: editIncomeForm.category,
        frequency: editIncomeForm.frequency,
        ...(editIncomeForm.date ? { date: editIncomeForm.date } : {}),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/incomes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      setEditingIncome(null);
      toast({ title: "Income updated" });
    },
    onError: (err: Error) => toast({ title: "Failed to update income", description: formatApiError(err), variant: "destructive" }),
  });

  const deleteIncomeMut = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/incomes/${id}`); return id; },
    onSuccess: (_data, id) => {
      queryClient.setQueryData(["/api/incomes"], (old: any[]) => old?.filter(i => i.id !== id) || []);
      queryClient.invalidateQueries({ queryKey: ["/api/incomes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Income deleted" });
    },
    onError: (err: Error) => toast({ title: "Failed to delete income", description: formatApiError(err), variant: "destructive" }),
  });

  // Cashflow
  // BUG-021: must use user-local month — toISOString() returns UTC, which can
  // tip into next month for Pacific users in the evening (Dashboard shows May
  // while Finance showed April). Match dashboard's `currentMonth` derivation.
  const cfMonth = new Date().toLocaleDateString('en-CA', { timeZone: BROWSER_TIMEZONE }).slice(0, 7);
  const { data: cashflow = [] } = useQuery<any[]>({ queryKey: ["/api/cashflow", cfMonth] });

  // ── Cashflow upsert mutation (POST /api/cashflow) ────────────────────────
  const addCashflowMut = useMutation({
    mutationFn: async () => {
      const wk = parseInt(newCashflow.week, 10);
      if (!isFinite(wk) || wk < 1 || wk > 6) throw new Error("Week must be between 1 and 6");
      if (!/^\d{4}-\d{2}$/.test(newCashflow.month)) throw new Error("Month must be in YYYY-MM format");
      const body: Record<string, any> = { month: newCashflow.month, week: wk };
      for (const k of ["projected_income", "projected_expenses", "actual_income", "actual_expenses"] as const) {
        const raw = (newCashflow as any)[k] as string;
        if (raw === "" || raw == null) continue;
        const n = Number(raw);
        if (!isFinite(n)) throw new Error(`${k} must be a number`);
        body[k] = n;
      }
      await apiRequest("POST", "/api/cashflow", body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      setAddCashflowOpen(false);
      setNewCashflow({
        month: new Date().toISOString().slice(0, 7),
        week: "1", projected_income: "", projected_expenses: "", actual_income: "", actual_expenses: "",
      });
      toast({ title: "Cashflow entry saved" });
    },
    onError: (err: Error) => toast({ title: "Failed to save cashflow", description: formatApiError(err), variant: "destructive" }),
  });

  // ── ALL useMemo hooks MUST be before early returns (React Rules of Hooks) ──
  // Apply profile filter client-side using the shared rule so finance,
  // calendar, dashboard and the server agree on what "active filter" means.
  const filterCtx = useMemo(() => ({
    selectedIds: filterMode === "everyone" ? [] : filterIds,
    allProfiles: (profiles || []).map((p: any) => ({ id: p.id, type: p.type })),
  }), [filterMode, filterIds, profiles]);
  const profileFiltered = useMemo(() => (expenses || []).filter(e => passesProfileFilter(e.linkedProfiles, filterCtx)), [expenses, filterCtx]);
  const filtered = useMemo(() => filterCategory === "all" ? profileFiltered : profileFiltered.filter(e => normalizeFilter(e.category) === normalizeFilter(filterCategory)), [profileFiltered, filterCategory]);
  const total = useMemo(() => filtered.reduce((s, e) => s + e.amount, 0), [filtered]);

  // Group by category
  const byCategory = useMemo(() => filtered.reduce((acc: Record<string, number>, e) => {
    acc[e.category] = (acc[e.category] || 0) + e.amount;
    return acc;
  }, {}), [filtered]);
  const chartData = useMemo(() => Object.entries(byCategory).map(([name, amount]) => ({ name, amount: Number(amount.toFixed(2)) })).sort((a, b) => a.name.localeCompare(b.name)), [byCategory]);
  const categories = useMemo(() => [...new Set(profileFiltered.map(e => e.category))].sort((a, b) => a.localeCompare(b)), [profileFiltered]);

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

  return (
    <div className="p-4 md:p-6 space-y-6 overflow-y-auto h-full pb-24" data-testid="page-finance">
      <div>
        <div className="flex items-center gap-3 mb-4">
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
            onChange={({ mode, selectedIds }) => { setFilterMode(mode); setFilterIds(selectedIds); }}
            compact
          />
          <div className="ml-auto flex items-center gap-2">
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
                        {(profiles || []).filter((p: any) => ["self", "person", "pet"].includes(p.type)).map((p: any) => (
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
                      addExpenseMutation.mutate();
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

      {/* Financial KPIs */}
      {(() => {
        const now = new Date();
        const thisMonth = profileFiltered.filter(e => {
          const raw = e.date?.slice(0, 10) || "";
          const d = new Date(raw + "T00:00:00");
          return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        });
        const monthTotal = thisMonth.reduce((s, e) => s + e.amount, 0);
        
        // Asset values from profiles. We constrain to asset-bearing types
        // (vehicle/asset/investment/property) and apply the SAME profile
        // filter rule used elsewhere: if a filter is active, an asset only
        // counts when its parent profile is selected, OR the asset itself
        // is selected directly.
        const assetProfiles = (profiles || []).filter(p => {
          if (!["vehicle", "asset", "investment", "property"].includes(p.type)) return false;
          if (filterMode === "everyone" || filterIds.length === 0) return true;
          const pParent = p.fields?._parentProfileId || p.parentProfileId;
          if (pParent && filterIds.includes(pParent)) return true;
          // Allow direct selection of the asset itself (e.g. selecting the
          // F150 directly should still surface its value).
          return filterIds.includes(p.id);
        });
        // Robust value resolver — reads camelCase, snake_case, and nested namespaces
        // (fields.finance.balance, fields.other.purchase_price, etc.). Without this
        // the top KPI would silently report $0 even though the live data has values.
        const toNumLocal = (c: any): number => {
          if (c == null || c === '') return 0;
          const n = typeof c === 'number' ? c : parseFloat(String(c).replace(/[^0-9.\-]/g, ''));
          return Number.isFinite(n) && n > 0 ? n : 0;
        };
        const NS = ['', 'finance', 'other', 'housing', 'vehicle', 'vehicles', 'investment', 'investments', 'asset', 'assets', 'property', 'properties', 'account', 'accounts'];
        const KEYS = ['currentValue', 'current_value', 'value', 'purchasePrice', 'purchase_price', 'balance', 'amount', 'cost', 'price'];
        const readVal = (fields: any): number => {
          if (!fields || typeof fields !== 'object') return 0;
          for (const ns of NS) {
            const root = ns ? fields[ns] : fields;
            if (!root || typeof root !== 'object') continue;
            for (const k of KEYS) {
              const n = toNumLocal((root as any)[k]);
              if (n > 0) return n;
            }
          }
          return 0;
        };
        const totalAssetValue = assetProfiles.reduce((s, p) => s + readVal(p.fields), 0);

        // Liabilities from obligations. Use the unified rule so this view
        // matches expense filtering (previously this lane silently included
        // every orphan obligation when filtering, which inflated
        // "Bob's monthly bills" with bills that weren't linked to anyone).
        const oblData = (obligations || []).filter((o: any) => passesProfileFilter(o.linkedProfiles, filterCtx));
        const monthlyLiabilities = oblData.reduce((s: number, o: any) => {
          const amt = Number(o.amount) || 0;
          switch (o.frequency) {
            case "weekly": return s + amt * 52 / 12;
            case "biweekly": return s + amt * 26 / 12;
            case "monthly": return s + amt;
            case "quarterly": return s + amt * 4 / 12;
            case "yearly": return s + amt / 12;
            default: return s + amt; // assume monthly
          }
        }, 0);
        
        return (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="rounded-lg border p-2.5">
              <p className="text-xs-tight text-muted-foreground font-medium uppercase tracking-wider">Total Spent</p>
              <p className="text-lg font-bold tabular-nums mt-0.5" data-testid="text-total-spent">${total.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}</p>
            </div>
            <div className="rounded-lg border p-2.5">
              <p className="text-xs-tight text-muted-foreground font-medium uppercase tracking-wider">This Month</p>
              <p className="text-lg font-bold tabular-nums mt-0.5">${monthTotal.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}</p>
            </div>
            <div className="rounded-lg border p-2.5">
              <p className="text-xs-tight text-muted-foreground font-medium uppercase tracking-wider">Asset Value</p>
              <p className="text-lg font-bold tabular-nums mt-0.5 text-green-600">${totalAssetValue.toLocaleString()}</p>
            </div>
            <div className="rounded-lg border p-2.5">
              <p className="text-xs-tight text-muted-foreground font-medium uppercase tracking-wider">Monthly Bills</p>
              <p className="text-lg font-bold tabular-nums mt-0.5 text-amber-600">${monthlyLiabilities.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}</p>
            </div>
          </div>
        );
      })()}

      {/* Net Worth KPIs */}
      {(() => {
        const assetValue = enhanced?.financeSnapshot?.totalAssetValue || 0;
        const liabilities = enhanced?.financeSnapshot?.totalLiabilities || 0;
        // Proper monthly bills with frequency conversion + profile filtering
        const filteredObl = (obligations || []).filter((o: any) => {
          if (filterMode === "everyone" || filterIds.length === 0) return true;
          const linked = o.linkedProfiles || [];
          return linked.length === 0 || linked.some((id: string) => filterIds.includes(id));
        });
        const monthlyBills = filteredObl.reduce((s: number, o: any) => {
          const amt = Number(o.amount) || 0;
          switch (o.frequency) {
            case "weekly": return s + amt * 52 / 12;
            case "biweekly": return s + amt * 26 / 12;
            case "monthly": return s + amt;
            case "quarterly": return s + amt * 4 / 12;
            case "yearly": return s + amt / 12;
            default: return s + amt;
          }
        }, 0);
        const netWorth = assetValue - liabilities;
        const now = new Date();
        const thisMonthExpenses = filtered.filter(e => {
          const raw = e.date?.slice(0, 10) || "";
          const d = new Date(raw + "T00:00:00");
          return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        });
        const thisMonthTotal = thisMonthExpenses.reduce((s, e) => s + e.amount, 0);
        return (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card className="p-3">
              <p className="text-xs text-muted-foreground uppercase">This Month</p>
              <p className="text-lg font-bold tabular-nums">${thisMonthTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
              <p className="text-xs text-muted-foreground">{thisMonthExpenses.length} expenses</p>
            </Card>
            <Card className="p-3">
              <p className="text-xs text-muted-foreground uppercase">Monthly Bills</p>
              <p className="text-lg font-bold tabular-nums">${monthlyBills.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">{obligations?.length || 0} obligations</p>
            </Card>
            <Card className="p-3">
              <p className="text-xs text-muted-foreground uppercase">Assets</p>
              <p className="text-lg font-bold tabular-nums text-green-500">${assetValue.toLocaleString()}</p>
            </Card>
            <Card className="p-3">
              <p className="text-xs text-muted-foreground uppercase">Net Worth</p>
              <p className={`text-lg font-bold tabular-nums ${netWorth >= 0 ? "text-green-500" : "text-red-500"}`}>
                ${netWorth.toLocaleString()}
              </p>
              {liabilities > 0 && <p className="text-xs text-muted-foreground">Liabilities: ${liabilities.toLocaleString()}</p>}
            </Card>
          </div>
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

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Recent Expenses</CardTitle>
        </CardHeader>
        <CardContent>
          {profileFiltered.length === 0 ? (
            <div className="text-center py-10">
              <DollarSign className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No expenses logged yet.</p>
              <p className="text-xs text-muted-foreground mt-1">Try: "spent $50 on groceries"</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filtered.length === 0 && profileFiltered.length > 0 && (
                <div className="text-center py-6">
                  <p className="text-sm text-muted-foreground">No expenses match the selected filter.</p>
                </div>
              )}
              {filtered.slice().sort((a, b) => a.description.localeCompare(b.description) || new Date(b.date || '').getTime() - new Date(a.date || '').getTime()).map((expense) => (
                <div key={expense.id} className="flex items-center gap-3 py-3 group" data-testid={`expense-${expense.id}`}>
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <ShoppingCart className="h-3.5 w-3.5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{expense.description}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Badge variant="secondary" className="text-xs capitalize">{expense.category}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {new Date((expense.date?.slice(0, 10) || "") + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </span>
                    </div>
                  </div>
                  <span className="text-sm font-semibold tabular-nums shrink-0">${expense.amount.toFixed(2)}</span>
                  <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    {/* ST5: form is now seeded by an effect on editingExpense?.id,
                       so we just set the target row here. */}
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={stopProp(() => setEditingExpense(expense))} title="Edit"><Pencil className="h-3 w-3" /></Button>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive" onClick={stopProp(() => setDeleteConfirmId(expense.id))} title="Delete"><Trash2 className="h-3 w-3" /></Button>
                  </div>
                </div>
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
                  {(profiles || []).filter((p: any) => ["self", "person", "pet"].includes(p.type)).map((p: any) => (
                    <SelectItem key={p.id} value={p.id}>{p.type === "self" ? "Me" : p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setEditingExpense(null)} disabled={editSaving}>Cancel</Button>
              <Button className="flex-1" disabled={!editForm.description.trim() || !editForm.amount || parseFloat(editForm.amount) <= 0 || editSaving} onClick={async () => {
                if (!editingExpense) return;
                setEditSaving(true);
                try {
                  await apiRequest("PATCH", `/api/expenses/${editingExpense.id}`, {
                    description: editForm.description,
                    amount: parseFloat(editForm.amount),
                    category: editForm.category,
                    vendor: editForm.vendor || undefined,
                    date: editForm.date || undefined,
                    // Round-6 fix (BUG-017): persist the chosen profile linkage.
                    ...(editForm.profileId ? { linkedProfiles: [editForm.profileId] } : {}),
                  });
                  queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/budgets/summary"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
                  toast({ title: `"${editForm.description}" updated` });
                  setEditingExpense(null);
                } catch (err: any) { toast({ title: "Failed to update", description: formatApiError(err), variant: "destructive" }); }
                finally { setEditSaving(false); }
              }}>{editSaving ? "Saving…" : "Save Changes"}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

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
            {paychecks.slice().sort((a: any, b: any) => (a.source || '').localeCompare(b.source || '')).map((pc: any) => {
              // Round-6 fix (BUG-024): user reported the "Received" badge appearing on
              // paychecks before their expected date. The server allowed confirm at any
              // time. Gate the Received button at the UI layer so a paycheck can only be
              // marked received once expected_date has actually arrived (in the user's TZ).
              const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: BROWSER_TIMEZONE });
              const expectedISO = (pc.expected_date || '').slice(0, 10);
              const isFuture = expectedISO && expectedISO > todayISO;
              return (
              <div key={pc.id} className="flex items-center gap-3 px-3 py-2 group" style={{ background: pc.confirmed ? 'hsl(142 60% 50% / 0.05)' : undefined }}>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{pc.source}</p>
                  <p className="text-[10px] text-muted-foreground">
                    Expected {new Date(pc.expected_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    {pc.confirmed && pc.received_date && <> · Received {new Date(pc.received_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</>}
                  </p>
                </div>
                <span className="text-xs font-bold tabular-nums">${(pc.actual_amount || pc.amount).toLocaleString()}</span>
                {pc.confirmed ? (
                  <span className="text-[10px] font-semibold text-green-500 flex items-center gap-0.5"><Check className="h-3 w-3" /> Received</span>
                ) : isFuture ? (
                  <span className="text-[10px] font-medium text-muted-foreground">Upcoming</span>
                ) : (
                  <Button variant="outline" size="sm" className="h-7 text-xs gap-1 text-green-600 border-green-500/30"
                    disabled={confirmPaycheckMut.isPending}
                    onClick={stopProp(() => confirmPaycheckMut.mutate({ id: pc.id }))}>
                    <Check className="h-3 w-3" /> Received
                  </Button>
                )}
                {/* U2 fix: open confirmation dialog instead of deleting immediately.
                    Also disable while a previous delete is in flight (avoids spam clicks). */}
                <button className="text-muted-foreground/40 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity h-8 w-8 flex items-center justify-center disabled:opacity-50"
                  disabled={deletePaycheckMut.isPending}
                  data-testid={`btn-delete-paycheck-${pc.id}`}
                  onClick={stopProp(() => setPaycheckToDelete({ id: pc.id, source: pc.source, amount: (pc.actual_amount || pc.amount) }))}>
                  {deletePaycheckMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                </button>
              </div>
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
            <Button className="w-full" onClick={() => addPaycheckMut.mutate()} disabled={!newPaycheck.source.trim() || !newPaycheck.amount || parseFloat(newPaycheck.amount) <= 0 || !newPaycheck.expectedDate || addPaycheckMut.isPending} data-testid="button-save-paycheck">
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
            {incomes.slice().sort((a: any, b: any) => (a.description || '').localeCompare(b.description || '')).map((inc: any) => (
              <div key={inc.id} className="flex items-center gap-3 px-3 py-2 group">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{inc.description}</p>
                  <p className="text-[10px] text-muted-foreground capitalize">
                    {inc.category || 'income'} · {inc.frequency || 'monthly'}
                    {inc.date ? ` · ${new Date(inc.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}
                  </p>
                </div>
                <span className="text-xs font-bold tabular-nums">${Number(inc.amount || 0).toLocaleString()}</span>
                <button
                  className="text-muted-foreground/60 hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity h-8 w-8 flex items-center justify-center disabled:opacity-50"
                  onClick={stopProp(() => setEditingIncome(inc))}
                  data-testid={`btn-edit-income-${inc.id}`}
                  aria-label="Edit income"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  className="text-muted-foreground/40 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity h-8 w-8 flex items-center justify-center disabled:opacity-50"
                  disabled={deleteIncomeMut.isPending}
                  onClick={stopProp(() => setIncomeToDelete({ id: inc.id, description: inc.description, amount: Number(inc.amount || 0) }))}
                  data-testid={`btn-delete-income-${inc.id}`}
                  aria-label="Delete income"
                >
                  {deleteIncomeMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add Income Dialog */}
      <Dialog open={addIncomeOpen} onOpenChange={(open) => { if (!open) setNewIncome({ description: "", amount: "", category: "salary", frequency: "monthly", date: "" }); setAddIncomeOpen(open); }}>
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
            <Button
              className="w-full"
              onClick={() => addIncomeMut.mutate()}
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
            <Button
              className="w-full"
              onClick={() => editingIncome && editIncomeMut.mutate({ id: editingIncome.id })}
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
              onClick={() => addCashflowMut.mutate()}
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
                const expense = profileFiltered.find(x => x.id === deleteConfirmId);
                try {
                  await apiRequest("DELETE", `/api/expenses/${deleteConfirmId}`);
                  // Round-6 fix (BUG-018): previous code optimistically updated only the
                  // unparameterised ["/api/expenses"] key, but the active page query key is
                  // ["/api/expenses", filterMode, ...filterIds] — so the on-screen list and
                  // the "X expenses" counter weren't updated until a full refetch round-trip.
                  // Use setQueriesData with a prefix matcher to update every cached expense
                  // list immediately, then invalidate to reconcile against the server.
                  queryClient.setQueriesData<any[] | { items?: any[] } | undefined>(
                    { queryKey: ["/api/expenses"] },
                    (old: any) => {
                      if (!old) return old;
                      if (Array.isArray(old)) return old.filter((item: any) => item.id !== deleteConfirmId);
                      if (Array.isArray(old?.items)) return { ...old, items: old.items.filter((item: any) => item.id !== deleteConfirmId) };
                      return old;
                    }
                  );
                  queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/budgets/summary"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
                  toast({ title: `"${expense?.description}" deleted` });
                } catch (err: any) {
                  toast({ title: "Failed to delete", description: err?.message || "Unknown error", variant: "destructive" });
                }
                setDeleteConfirmId(null);
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
