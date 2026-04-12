import { formatApiError } from "@/lib/formatError";
import { stopProp } from "@/lib/event-utils";
import { normalizeFilter } from "@/lib/filter-utils";
import { useState, useEffect } from "react";
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
import { DollarSign, TrendingUp, ShoppingCart, ArrowLeft, Plus, Filter, AlertCircle, Pencil, Trash2, Check, Wallet, Landmark, BarChart3 } from "lucide-react";
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

const EXPENSE_CATEGORIES = ["food", "transport", "health", "entertainment", "pet", "vehicle", "housing", "utilities", "general"];

export default function FinancePage() {
  useEffect(() => { document.title = "Finance — Portol"; }, []);
  const { toast } = useToast();
  const [filterIds, setFilterIds] = useState<string[]>(() => getProfileFilter().selectedIds);
  const [filterMode, setFilterMode] = useState(() => getProfileFilter().mode);
  const { data: profiles } = useQuery<any[]>({ queryKey: ["/api/profiles"] });
  const profileParam = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";
  const { data: obligations } = useQuery<any[]>({ queryKey: ["/api/obligations", filterMode, ...filterIds] });
  const { data: enhanced } = useQuery<any>({ queryKey: ["/api/dashboard-enhanced", filterMode, ...filterIds] });
  const { data: expenses, isLoading, error, refetch } = useQuery<Expense[]>({
    queryKey: ["/api/expenses", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/expenses${profileParam}`).then(r => r.json()),
  });
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [addOpen, setAddOpen] = useState(false);
  const [newExpense, setNewExpense] = useState({ description: "", amount: "", category: "general", vendor: "" });
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [editForm, setEditForm] = useState({ description: "", amount: "", category: "", vendor: "", date: "" });
  const [editSaving, setEditSaving] = useState(false);

  const addExpenseMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/expenses", {
        description: newExpense.description,
        amount: parseFloat(newExpense.amount),
        category: newExpense.category,
        vendor: newExpense.vendor || undefined,
        date: new Date().toLocaleDateString('en-CA', { timeZone: BROWSER_TIMEZONE }),
        tags: [],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      setAddOpen(false);
      setNewExpense({ description: "", amount: "", category: "general", vendor: "" });
      toast({ title: `$${Number(newExpense.amount).toFixed(2)} expense added`, description: newExpense.description });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add expense", description: formatApiError(err), variant: "destructive" });
    },
  });

  // ── ALL hooks MUST be above early returns (React Rules of Hooks) ──
  // Paychecks
  const { data: paychecks = [] } = useQuery<any[]>({ queryKey: ["/api/paychecks"] });
  const confirmPaycheckMut = useMutation({
    mutationFn: async ({ id, actual_amount }: { id: string; actual_amount?: number }) => {
      await apiRequest("PATCH", `/api/paychecks/${id}/confirm`, { actual_amount });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/paychecks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
    },
  });
  const deletePaycheckMut = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/paychecks/${id}`); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/paychecks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
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
    },
  });

  // Cashflow
  const cfMonth = new Date().toISOString().slice(0, 7);
  const { data: cashflow = [] } = useQuery<any[]>({ queryKey: ["/api/cashflow", cfMonth] });

  // ── Early returns (after ALL hooks) ──
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

  // ── Derived data (after hooks + early returns) ──
  // Apply profile filter client-side
  const profileFiltered = (expenses || []).filter(e => {
    if (filterMode === "everyone" || filterIds.length === 0) return true;
    const linked = e.linkedProfiles || [];
    return linked.some(id => filterIds.includes(id));
  });
  const filtered = filterCategory === "all" ? profileFiltered : profileFiltered.filter(e => normalizeFilter(e.category) === normalizeFilter(filterCategory));
  const total = filtered.reduce((s, e) => s + e.amount, 0);

  // Group by category
  const byCategory = filtered.reduce((acc: Record<string, number>, e) => {
    acc[e.category] = (acc[e.category] || 0) + e.amount;
    return acc;
  }, {});
  const chartData = Object.entries(byCategory).map(([name, amount]) => ({ name, amount: Number(amount.toFixed(2)) }));
  const categories = [...new Set(profileFiltered.map(e => e.category))];

  // Group loans by loan_name
  const loanGroups = loanSchedules.reduce((acc: Record<string, any[]>, entry: any) => {
    const name = entry.loan_name || "Unknown";
    (acc[name] = acc[name] || []).push(entry);
    return acc;
  }, {});

  return (
    <div className="p-4 md:p-6 space-y-6 overflow-y-auto h-full pb-24" data-testid="page-finance">
      <div>
        <div className="flex items-center gap-3 mb-4">
          <Link href="/dashboard">
            <button className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors" aria-label="Back" data-testid="button-back">
              <ArrowLeft className="w-4 h-4" />
            </button>
          </Link>

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
            <Dialog open={addOpen} onOpenChange={(open) => { setAddOpen(open); if (!open) setNewExpense({ description: "", amount: "", category: "general", vendor: "" }); }}>
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
        
        // Asset values from profiles (filtered by active profile selection)
        const assetProfiles = (profiles || []).filter(p => {
          if (!["vehicle", "asset", "investment", "property"].includes(p.type)) return false;
          if (filterMode === "everyone" || filterIds.length === 0) return true;
          const pParent = p.fields?._parentProfileId || p.parentProfileId;
          return pParent && filterIds.includes(pParent);
        });
        const totalAssetValue = assetProfiles.reduce((s, p) => {
          const val = p.fields?.purchasePrice || p.fields?.cost || p.fields?.value || p.fields?.amount || 0;
          return s + Number(val);
        }, 0);

        // Liabilities from obligations (filtered + proper frequency conversion)
        const oblData = (obligations || []).filter((o: any) => {
          if (filterMode === "everyone" || filterIds.length === 0) return true;
          const linked = o.linkedProfiles || [];
          return linked.length === 0 || linked.some((id: string) => filterIds.includes(id));
        });
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
                        {new Date((expense.date?.slice(0, 10) || "") + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </span>
                    </div>
                  </div>
                  <span className="text-sm font-semibold tabular-nums shrink-0">${expense.amount.toFixed(2)}</span>
                  <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={stopProp(() => {
                      setEditingExpense(expense);
                      setEditForm({ description: expense.description, amount: String(expense.amount), category: expense.category, vendor: expense.vendor || "", date: expense.date?.slice(0, 10) || "" });
                    })} title="Edit"><Pencil className="h-3 w-3" /></Button>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive" onClick={stopProp(async () => {
                      if (!confirm(`Delete "${expense.description}"?`)) return;
                      try {
                        await apiRequest("DELETE", `/api/expenses/${expense.id}`);
                        queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
                        queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
                        queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
                        toast({ title: `"${expense.description}" deleted` });
                      } catch (err: any) { toast({ title: "Failed to delete", description: err?.message || "Unknown error", variant: "destructive" }); }
                    })} title="Delete"><Trash2 className="h-3 w-3" /></Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit Expense Dialog */}
      <Dialog open={!!editingExpense} onOpenChange={(open) => { if (!open) { setEditingExpense(null); setEditForm({ description: "", amount: "", category: "", vendor: "", date: "" }); setEditSaving(false); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Edit Expense</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Description</Label><Input value={editForm.description} onChange={e => setEditForm(f => ({...f, description: e.target.value}))} /></div>
            <div><Label>Amount</Label><Input type="number" step="0.01" value={editForm.amount} onChange={e => setEditForm(f => ({...f, amount: e.target.value}))} /></div>
            <div><Label>Category</Label>
              <Select value={editForm.category} onValueChange={v => setEditForm(f => ({...f, category: v}))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["general","food","transport","housing","utilities","health","entertainment","shopping","subscription","insurance","education","pet","automotive","travel"].map(c => (
                    <SelectItem key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div><Label>Vendor</Label><Input value={editForm.vendor} onChange={e => setEditForm(f => ({...f, vendor: e.target.value}))} placeholder="Optional" /></div>
            <div><Label>Date</Label><Input type="date" value={editForm.date} onChange={e => setEditForm(f => ({...f, date: e.target.value}))} /></div>
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
                  });
                  queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
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
        <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <Wallet className="h-3.5 w-3.5" /> Expected Paychecks ({paychecks.length})
        </h2>
        {paychecks.length === 0 ? (
          <div className="rounded-xl border border-border/40 px-3 py-6 text-center">
            <p className="text-sm text-muted-foreground">No paychecks scheduled.</p>
          </div>
        ) : (
          <div className="rounded-xl border border-border/40 divide-y divide-border/30 overflow-hidden">
            {paychecks.map((pc: any) => (
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
                ) : (
                  <Button variant="outline" size="sm" className="h-7 text-xs gap-1 text-green-600 border-green-500/30"
                    disabled={confirmPaycheckMut.isPending}
                    onClick={stopProp(() => confirmPaycheckMut.mutate({ id: pc.id }))}>
                    <Check className="h-3 w-3" /> Received
                  </Button>
                )}
                <button className="text-muted-foreground/40 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity h-8 w-8 flex items-center justify-center"
                  onClick={stopProp(() => deletePaycheckMut.mutate(pc.id))}>
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

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
          <>{Object.entries(loanGroups).map(([loanName, payments]: [string, any[]]) => {
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
        <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <BarChart3 className="h-3.5 w-3.5" /> Cash Flow — {new Date(cfMonth + '-01').toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        </h2>
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
    </div>
  );
}
