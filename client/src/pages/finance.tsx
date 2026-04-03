import { formatApiError } from "@/lib/formatError";
import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useProfileFilter } from "@/lib/profileFilter";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DollarSign, TrendingUp, ShoppingCart, ArrowLeft, Plus, Filter, AlertCircle, Pencil, Trash2, TrendingDown, Wallet } from "lucide-react";
import { Link } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Expense, Income } from "@shared/schema";
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

const EXPENSE_CATEGORIES = ["food", "transport", "health", "entertainment", "pet", "vehicle", "housing", "utilities", "general"];
const INCOME_CATEGORIES = ["salary", "freelance", "investment", "rental", "gift", "refund", "bonus", "other"];
const INCOME_FREQUENCIES = ["one_time", "weekly", "biweekly", "monthly", "quarterly", "yearly"];

export default function FinancePage() {
  useEffect(() => { document.title = "Finance — Portol"; }, []);
  const { toast } = useToast();
  const { filterIds, filterMode, onChange: onFilterChange } = useProfileFilter();
  const { data: profiles } = useQuery<any[]>({ queryKey: ["/api/profiles"] });
  const { data: obligations } = useQuery<any[]>({ queryKey: ["/api/obligations"] });
  const { data: enhanced } = useQuery<any>({ queryKey: ["/api/dashboard-enhanced"] });
  const { data: expenses, isLoading, error, refetch } = useQuery<Expense[]>({
    queryKey: ["/api/expenses", "all"],
    queryFn: () => apiRequest("GET", "/api/expenses").then(r => r.json()),
  });
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [addOpen, setAddOpen] = useState(false);
  const [newExpense, setNewExpense] = useState({ description: "", amount: "", category: "general", vendor: "" });
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [editForm, setEditForm] = useState({ description: "", amount: "", category: "", vendor: "", date: "", tags: "" as string, isRecurring: false, linkedProfiles: [] as string[] });
  const { data: allProfiles } = useQuery<any[]>({ queryKey: ["/api/profiles"] });
  const [activeTab, setActiveTab] = useState<"expenses" | "income">("expenses");
  const { data: incomes = [] } = useQuery<Income[]>({
    queryKey: ["/api/incomes", filterMode, filterIds],
    queryFn: () => apiRequest("GET", "/api/incomes").then(r => r.json()),
  });
  const [addIncomeOpen, setAddIncomeOpen] = useState(false);
  const [newIncome, setNewIncome] = useState({ source: "", amount: "", category: "salary", frequency: "monthly", description: "" });
  const [editingIncome, setEditingIncome] = useState<Income | null>(null);
  const [editIncomeForm, setEditIncomeForm] = useState({ source: "", amount: "", category: "", frequency: "", description: "", date: "" });

  const addExpenseMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/expenses", {
        description: newExpense.description,
        amount: parseFloat(newExpense.amount),
        category: newExpense.category,
        vendor: newExpense.vendor || undefined,
        date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }),
        tags: [],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      setAddOpen(false);
      setNewExpense({ description: "", amount: "", category: "general", vendor: "" });
      toast({ title: `$${Number(newExpense.amount).toFixed(2)} expense added`, description: newExpense.description });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add expense", description: formatApiError(err), variant: "destructive" });
    },
  });

  const addIncomeMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/incomes", {
        source: newIncome.source,
        amount: parseFloat(newIncome.amount),
        category: newIncome.category,
        frequency: newIncome.frequency,
        description: newIncome.description || undefined,
        isRecurring: newIncome.frequency !== "one_time",
        date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/incomes"] });
      setAddIncomeOpen(false);
      setNewIncome({ source: "", amount: "", category: "salary", frequency: "monthly", description: "" });
      toast({ title: `$${Number(newIncome.amount).toFixed(2)} income logged`, description: newIncome.source });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add income", description: formatApiError(err), variant: "destructive" });
    },
  });

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

  // Apply profile filter client-side
  const profileFiltered = (expenses || []).filter(e => {
    if (filterMode === "everyone" || filterIds.length === 0) return true;
    const linked = e.linkedProfiles || [];
    return linked.some(id => filterIds.includes(id));
  });
  const filtered = filterCategory === "all" ? profileFiltered : profileFiltered.filter(e => e.category === filterCategory);
  const total = filtered.reduce((s, e) => s + e.amount, 0);

  // Group by category
  const byCategory = filtered.reduce((acc: Record<string, number>, e) => {
    acc[e.category] = (acc[e.category] || 0) + e.amount;
    return acc;
  }, {});
  const chartData = Object.entries(byCategory).map(([name, amount]) => ({ name, amount: Number(amount.toFixed(2)) }));
  const categories = [...new Set(profileFiltered.map(e => e.category))];

  return (
    <div className="p-4 md:p-6 space-y-6 overflow-y-auto h-full pb-24" data-testid="page-finance">
      <div>
        <div className="flex items-center gap-3 mb-4">
          <Link href="/dashboard">
            <button className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors" aria-label="Back" data-testid="button-back">
              <ArrowLeft className="w-4 h-4" />
            </button>
          </Link>
          <h1 className="text-xl font-semibold" data-testid="text-finance-title">Finance</h1>
          <MultiProfileFilter
            onChange={onFilterChange}
            compact
          />
          <div className="ml-auto flex items-center gap-2">
            {activeTab === "expenses" && (
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
            )}
            {activeTab === "expenses" ? (
            <Dialog open={addOpen} onOpenChange={setAddOpen}>
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
                    <Input placeholder="What was it for?" value={newExpense.description} onChange={e => setNewExpense(p => ({ ...p, description: e.target.value }))} data-testid="input-expense-description" /></div>
                  <div className="grid grid-cols-2 gap-3">
                    <div><Label className="text-xs">Amount ($) <span className="text-destructive">*</span></Label>
                      <Input type="number" step="0.01" placeholder="0.00" value={newExpense.amount} onChange={e => setNewExpense(p => ({ ...p, amount: e.target.value }))} data-testid="input-expense-amount" /></div>
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
                  <Button className="w-full" onClick={() => addExpenseMutation.mutate()} disabled={!newExpense.description || !newExpense.amount || addExpenseMutation.isPending} data-testid="button-save-expense">
                    {addExpenseMutation.isPending ? "Saving..." : "Save Expense"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
            ) : (
            <Dialog open={addIncomeOpen} onOpenChange={setAddIncomeOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="h-8 text-xs" data-testid="button-add-income">
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add Income
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Log Income</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  <div><Label className="text-xs">Source <span className="text-destructive">*</span></Label>
                    <Input placeholder="Employer, client, etc." value={newIncome.source} onChange={e => setNewIncome(p => ({...p, source: e.target.value}))} /></div>
                  <div className="grid grid-cols-2 gap-3">
                    <div><Label className="text-xs">Amount ($) <span className="text-destructive">*</span></Label>
                      <Input type="number" step="0.01" placeholder="0.00" value={newIncome.amount} onChange={e => setNewIncome(p => ({...p, amount: e.target.value}))} /></div>
                    <div><Label className="text-xs">Category</Label>
                      <Select value={newIncome.category} onValueChange={v => setNewIncome(p => ({...p, category: v}))}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>{INCOME_CATEGORIES.map(c => <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>)}</SelectContent>
                      </Select></div>
                  </div>
                  <div><Label className="text-xs">Frequency</Label>
                    <Select value={newIncome.frequency} onValueChange={v => setNewIncome(p => ({...p, frequency: v}))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{INCOME_FREQUENCIES.map(f => <SelectItem key={f} value={f} className="capitalize">{f.replace("_", " ")}</SelectItem>)}</SelectContent>
                    </Select></div>
                  <div><Label className="text-xs">Notes (optional)</Label>
                    <Input placeholder="Additional details" value={newIncome.description} onChange={e => setNewIncome(p => ({...p, description: e.target.value}))} /></div>
                  <Button className="w-full" onClick={() => addIncomeMutation.mutate()} disabled={!newIncome.source || !newIncome.amount || addIncomeMutation.isPending}>
                    {addIncomeMutation.isPending ? "Saving..." : "Log Income"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
            )}
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">
          {activeTab === "expenses" ? `Expense tracking and analysis${filterCategory !== "all" ? ` — ${filterCategory}` : ""}` : "Income tracking and cash flow"}
        </p>
        {/* Tab pills */}
        <div className="flex gap-1 mt-3">
          {(["expenses", "income"] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-all ${activeTab === tab ? "bg-primary text-primary-foreground border-transparent" : "border-border text-muted-foreground hover:bg-muted"}`}>
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Financial KPIs */}
      {(() => {
        const now = new Date();
        const thisMonth = profileFiltered.filter(e => {
          const d = new Date(e.date);
          return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        });
        const monthExpenses = thisMonth.reduce((s, e) => s + e.amount, 0);

        // Income this month
        const filteredIncomes = (incomes || []).filter(i => {
          if (filterMode === "selected" && filterIds.length > 0) {
            const linked = i.linkedProfiles || [];
            return linked.some(id => filterIds.includes(id));
          }
          return true;
        });
        const monthIncome = filteredIncomes.filter(i => {
          const d = new Date(i.date);
          return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        }).reduce((s, i) => s + i.amount, 0);
        const cashFlow = monthIncome - monthExpenses;

        // Asset values from profiles (respect active profile filter)
        const filteredAssetProfiles = (profiles || []).filter(p => {
          if (!["vehicle", "asset", "investment", "property"].includes(p.type)) return false;
          if (filterMode === "selected" && filterIds.length > 0) return filterIds.includes(p.id);
          return true;
        });
        const totalAssetValue = filteredAssetProfiles.reduce((s, p) => {
          const val = (p as any).fields?.purchasePrice || (p as any).fields?.cost || (p as any).fields?.value || (p as any).fields?.amount || 0;
          return s + Number(val);
        }, 0);

        // Convert all obligations to annual amounts for consistent net worth calc
        const oblData = (obligations || []).filter((o: any) => {
          if (filterMode === "selected" && filterIds.length > 0) {
            const linked = o.linkedProfiles || [];
            return linked.some((id: string) => filterIds.includes(id));
          }
          return true;
        });
        const annualLiabilities = oblData.reduce((s: number, o: any) => {
          const amt = Number(o.amount) || 0;
          switch (o.frequency) {
            case "weekly":     return s + amt * 52;
            case "biweekly":   return s + amt * 26;
            case "monthly":    return s + amt * 12;
            case "quarterly":  return s + amt * 4;
            case "yearly":     return s + amt;
            default:           return s + amt * 12;
          }
        }, 0);
        const netWorth = totalAssetValue - annualLiabilities;

        return (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="rounded-lg border p-2.5">
              <p className="text-[9px] text-muted-foreground font-medium uppercase tracking-wider">Month Spent</p>
              <p className="text-lg font-bold tabular-nums mt-0.5 text-red-500" data-testid="text-total-spent">${monthExpenses.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}</p>
            </div>
            <div className="rounded-lg border p-2.5">
              <p className="text-[9px] text-muted-foreground font-medium uppercase tracking-wider">Month Income</p>
              <p className="text-lg font-bold tabular-nums mt-0.5 text-green-600">${monthIncome.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}</p>
            </div>
            <div className="rounded-lg border p-2.5">
              <p className="text-[9px] text-muted-foreground font-medium uppercase tracking-wider">Cash Flow</p>
              <p className={`text-lg font-bold tabular-nums mt-0.5 ${cashFlow >= 0 ? "text-green-600" : "text-red-500"}`}>
                {cashFlow >= 0 ? "+" : ""}${cashFlow.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}
              </p>
            </div>
            <div className="rounded-lg border p-2.5">
              <p className="text-[9px] text-muted-foreground font-medium uppercase tracking-wider">Est. Net Worth</p>
              <p className={`text-lg font-bold tabular-nums mt-0.5 ${netWorth >= 0 ? "text-green-600" : "text-red-500"}`}>
                ${netWorth.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}
              </p>
            </div>
          </div>
        );
      })()}

      {activeTab === "expenses" && chartData.length > 0 && (
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

      {activeTab === "expenses" && <Card>
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
              {filtered.map((expense) => (
                <div key={expense.id} className="flex items-center gap-3 py-3 group" data-testid={`expense-${expense.id}`}>
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <ShoppingCart className="h-3.5 w-3.5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{expense.description}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Badge variant="secondary" className="text-xs capitalize">{expense.category}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {new Date(expense.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </span>
                    </div>
                  </div>
                  <span className="text-sm font-semibold tabular-nums shrink-0">${expense.amount.toFixed(2)}</span>
                  <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => {
                      setEditingExpense(expense);
                      setEditForm({ description: expense.description, amount: String(expense.amount), category: expense.category, vendor: expense.vendor || "", date: expense.date || "", tags: (expense.tags || []).join(", "), isRecurring: expense.isRecurring || false, linkedProfiles: expense.linkedProfiles || [] });
                    }} title="Edit"><Pencil className="h-3 w-3" /></Button>
                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-destructive" onClick={async () => {
                      if (!confirm(`Delete "${expense.description}"?`)) return;
                      try {
                        await apiRequest("DELETE", `/api/expenses/${expense.id}`);
                        queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
                        queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
                        toast({ title: `"${expense.description}" deleted` });
                      } catch { toast({ title: "Failed to delete", variant: "destructive" }); }
                    }} title="Delete"><Trash2 className="h-3 w-3" /></Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>}

      {/* Income List */}
      {activeTab === "income" && <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Income Records</CardTitle>
        </CardHeader>
        <CardContent>
          {(incomes || []).length === 0 ? (
            <div className="text-center py-10">
              <Wallet className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No income logged yet.</p>
              <p className="text-xs text-muted-foreground mt-1">Try: "logged $5000 salary from Acme Corp"</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {(incomes || []).filter(i => {
                if (filterMode === "selected" && filterIds.length > 0) {
                  const linked = i.linkedProfiles || [];
                  return linked.some(id => filterIds.includes(id));
                }
                return true;
              }).map((income) => (
                <div key={income.id} className="flex items-center gap-3 py-3 group">
                  <div className="w-8 h-8 rounded-full bg-green-500/10 flex items-center justify-center shrink-0">
                    <TrendingUp className="h-3.5 w-3.5 text-green-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{income.source}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Badge variant="secondary" className="text-xs capitalize">{income.category}</Badge>
                      <Badge variant="outline" className="text-xs capitalize">{income.frequency.replace("_", " ")}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {new Date(income.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </span>
                    </div>
                    {income.description && <p className="text-xs text-muted-foreground truncate mt-0.5">{income.description}</p>}
                  </div>
                  <span className="text-sm font-semibold tabular-nums shrink-0 text-green-600">+${income.amount.toFixed(2)}</span>
                  <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => {
                      setEditingIncome(income);
                      setEditIncomeForm({ source: income.source, amount: String(income.amount), category: income.category, frequency: income.frequency, description: income.description || "", date: income.date });
                    }} title="Edit"><Pencil className="h-3 w-3" /></Button>
                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-destructive" onClick={async () => {
                      if (!confirm(`Delete income from "${income.source}"?`)) return;
                      try {
                        await apiRequest("DELETE", `/api/incomes/${income.id}`);
                        queryClient.invalidateQueries({ queryKey: ["/api/incomes"] });
                        queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
                        queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
                        toast({ title: `Income from "${income.source}" deleted` });
                      } catch { toast({ title: "Failed to delete", variant: "destructive" }); }
                    }} title="Delete"><Trash2 className="h-3 w-3" /></Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>}

      {/* Edit Income Dialog */}
      <Dialog open={!!editingIncome} onOpenChange={(open) => !open && setEditingIncome(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Edit Income</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label className="text-xs">Source</Label><Input value={editIncomeForm.source} onChange={e => setEditIncomeForm(f => ({...f, source: e.target.value}))} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">Amount ($)</Label><Input type="number" step="0.01" value={editIncomeForm.amount} onChange={e => setEditIncomeForm(f => ({...f, amount: e.target.value}))} /></div>
              <div><Label className="text-xs">Date</Label><Input type="date" value={editIncomeForm.date} onChange={e => setEditIncomeForm(f => ({...f, date: e.target.value}))} /></div>
            </div>
            <div><Label className="text-xs">Category</Label>
              <Select value={editIncomeForm.category} onValueChange={v => setEditIncomeForm(f => ({...f, category: v}))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{INCOME_CATEGORIES.map(c => <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>)}</SelectContent>
              </Select></div>
            <div><Label className="text-xs">Frequency</Label>
              <Select value={editIncomeForm.frequency} onValueChange={v => setEditIncomeForm(f => ({...f, frequency: v}))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{INCOME_FREQUENCIES.map(f => <SelectItem key={f} value={f} className="capitalize">{f.replace("_", " ")}</SelectItem>)}</SelectContent>
              </Select></div>
            <div><Label className="text-xs">Notes</Label><Input value={editIncomeForm.description} onChange={e => setEditIncomeForm(f => ({...f, description: e.target.value}))} placeholder="Optional" /></div>
            <Button className="w-full" disabled={!editIncomeForm.source.trim() || !editIncomeForm.amount} onClick={async () => {
              if (!editingIncome) return;
              try {
                await apiRequest("PATCH", `/api/incomes/${editingIncome.id}`, {
                  source: editIncomeForm.source,
                  amount: parseFloat(editIncomeForm.amount),
                  category: editIncomeForm.category,
                  frequency: editIncomeForm.frequency,
                  description: editIncomeForm.description || undefined,
                  date: editIncomeForm.date || undefined,
                  isRecurring: editIncomeForm.frequency !== "one_time",
                });
                queryClient.invalidateQueries({ queryKey: ["/api/incomes"] });
                queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
                queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
                toast({ title: `Income updated` });
                setEditingIncome(null);
              } catch (err: any) { toast({ title: "Failed to update", description: formatApiError(err), variant: "destructive" }); }
            }}>Save Changes</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Expense Dialog */}
      <Dialog open={!!editingExpense} onOpenChange={(open) => !open && setEditingExpense(null)}>
        <DialogContent className="max-w-sm max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Edit Expense</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label className="text-xs">Description</Label><Input value={editForm.description} onChange={e => setEditForm(f => ({...f, description: e.target.value}))} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label className="text-xs">Amount ($)</Label><Input type="number" step="0.01" value={editForm.amount} onChange={e => setEditForm(f => ({...f, amount: e.target.value}))} /></div>
              <div><Label className="text-xs">Date</Label><Input type="date" value={editForm.date} onChange={e => setEditForm(f => ({...f, date: e.target.value}))} /></div>
            </div>
            <div><Label className="text-xs">Category</Label>
              <Select value={editForm.category} onValueChange={v => setEditForm(f => ({...f, category: v}))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {EXPENSE_CATEGORIES.map(c => (
                    <SelectItem key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div><Label className="text-xs">Vendor</Label><Input value={editForm.vendor} onChange={e => setEditForm(f => ({...f, vendor: e.target.value}))} placeholder="Optional" /></div>
            <div><Label className="text-xs">Tags (comma-separated)</Label><Input value={editForm.tags} onChange={e => setEditForm(f => ({...f, tags: e.target.value}))} placeholder="e.g. groceries, weekly" /></div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="edit-recurring" checked={editForm.isRecurring} onChange={e => setEditForm(f => ({...f, isRecurring: e.target.checked}))} className="h-4 w-4 rounded border-border accent-primary" />
              <Label htmlFor="edit-recurring" className="text-xs">Recurring expense</Label>
            </div>
            {(allProfiles || []).length > 0 && (
              <div>
                <Label className="text-xs">Linked Profiles</Label>
                <div className="flex flex-wrap gap-1.5 mt-1 max-h-24 overflow-y-auto">
                  {(allProfiles || []).filter(p => ["self","person","pet","vehicle","asset"].includes(p.type)).map((p: any) => {
                    const linked = editForm.linkedProfiles.includes(p.id);
                    return (
                      <button key={p.id} type="button"
                        className={`px-2 py-0.5 rounded-md text-xs border transition-all ${linked ? "bg-primary/10 border-primary text-primary" : "border-border text-muted-foreground hover:border-foreground/30"}`}
                        onClick={() => setEditForm(f => ({...f, linkedProfiles: linked ? f.linkedProfiles.filter(id => id !== p.id) : [...f.linkedProfiles, p.id]}))}
                      >{p.name}</button>
                    );
                  })}
                </div>
              </div>
            )}
            <Button className="w-full" disabled={!editForm.description.trim() || !editForm.amount || parseFloat(editForm.amount) <= 0} onClick={async () => {
              if (!editingExpense) return;
              if (!editForm.description.trim()) { toast({ title: "Description required", variant: "destructive" }); return; }
              if (!editForm.amount || parseFloat(editForm.amount) <= 0) { toast({ title: "Valid amount required", variant: "destructive" }); return; }
              try {
                const parsedTags = editForm.tags.split(",").map(t => t.trim()).filter(Boolean);
                await apiRequest("PATCH", `/api/expenses/${editingExpense.id}`, {
                  description: editForm.description,
                  amount: parseFloat(editForm.amount),
                  category: editForm.category,
                  vendor: editForm.vendor || undefined,
                  date: editForm.date || undefined,
                  tags: parsedTags,
                  isRecurring: editForm.isRecurring,
                  linkedProfiles: editForm.linkedProfiles,
                });
                queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
                queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
                toast({ title: `"${editForm.description}" updated` });
                setEditingExpense(null);
              } catch (err: any) { toast({ title: "Failed to update", description: formatApiError(err), variant: "destructive" }); }
            }}>Save Changes</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
