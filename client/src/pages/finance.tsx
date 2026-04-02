import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DollarSign, TrendingUp, ShoppingCart, ArrowLeft, Plus, Filter } from "lucide-react";
import { Link } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { getUserTimezone } from "@/lib/utils";
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
  const { toast } = useToast();
  const { data: expenses, isLoading } = useQuery<Expense[]>({
    queryKey: ["/api/expenses"],
  });
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [addOpen, setAddOpen] = useState(false);
  const [newExpense, setNewExpense] = useState({ description: "", amount: "", category: "general", vendor: "" });

  const handleAddExpense = () => {
    if (!newExpense.description.trim()) {
      toast({ title: "Description required", description: "Please enter a description", variant: "destructive" });
      return;
    }
    const amount = parseFloat(newExpense.amount);
    if (!amount || amount <= 0) {
      toast({ title: "Invalid amount", description: "Amount must be greater than 0", variant: "destructive" });
      return;
    }
    addExpenseMutation.mutate();
  };

  const addExpenseMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/expenses", {
        description: newExpense.description,
        amount: parseFloat(newExpense.amount),
        category: newExpense.category,
        vendor: newExpense.vendor || undefined,
        date: new Date().toLocaleDateString('en-CA', { timeZone: getUserTimezone() }),
        tags: [],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      setAddOpen(false);
      setNewExpense({ description: "", amount: "", category: "general", vendor: "" });
      toast({ title: "Expense added" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add expense", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <div className="h-8 w-40 rounded skeleton-shimmer" />
        <div className="h-48 rounded-lg skeleton-shimmer" />
      </div>
    );
  }

  const filtered = filterCategory === "all" ? (expenses || []) : (expenses || []).filter(e => e.category === filterCategory);
  const total = filtered.reduce((s, e) => s + e.amount, 0);

  // Group by category
  const byCategory = filtered.reduce((acc: Record<string, number>, e) => {
    acc[e.category] = (acc[e.category] || 0) + e.amount;
    return acc;
  }, {});
  const chartData = Object.entries(byCategory).map(([name, amount]) => ({ name, amount: Number(amount.toFixed(2)) }));
  const categories = [...new Set((expenses || []).map(e => e.category))];

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
                  <div><Label className="text-xs">Description</Label>
                    <Input placeholder="What was it for?" value={newExpense.description} onChange={e => setNewExpense(p => ({ ...p, description: e.target.value }))} data-testid="input-expense-description" /></div>
                  <div className="grid grid-cols-2 gap-3">
                    <div><Label className="text-xs">Amount ($)</Label>
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
                  <Button className="w-full" onClick={handleAddExpense} disabled={!newExpense.description || !newExpense.amount || addExpenseMutation.isPending} data-testid="button-save-expense">
                    {addExpenseMutation.isPending ? "Saving..." : "Save Expense"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">Expense tracking and analysis{filterCategory !== "all" && ` — ${filterCategory}`}</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Total Spent</p>
            <p className="text-2xl font-semibold mt-1 tabular-nums" data-testid="text-total-spent">${total.toFixed(2)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Transactions</p>
            <p className="text-2xl font-semibold mt-1 tabular-nums">{(expenses || []).length}</p>
          </CardContent>
        </Card>
      </div>

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
          {(!expenses || expenses.length === 0) ? (
            <div className="text-center py-10">
              <DollarSign className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No expenses logged yet.</p>
              <p className="text-xs text-muted-foreground mt-1">Try: "spent $50 on groceries"</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filtered.map((expense) => (
                <div key={expense.id} className="flex items-center gap-3 py-3" data-testid={`expense-${expense.id}`}>
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
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
