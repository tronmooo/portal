import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DollarSign, TrendingUp, TrendingDown, ShoppingCart, Plus, ArrowUpRight, ArrowDownRight } from "lucide-react";
import type { Expense } from "@shared/schema";
import { useState, useMemo } from "react";
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
  shopping: "hsl(var(--chart-1))",
  utilities: "hsl(var(--chart-2))",
  housing: "hsl(var(--chart-3))",
};

export default function FinancePage() {
  const [quickAmount, setQuickAmount] = useState("");
  const [quickDesc, setQuickDesc] = useState("");

  const { data: expenses = [], isLoading } = useQuery<Expense[]>({
    queryKey: ["/api/expenses"],
    queryFn: () => apiRequest("GET", "/api/expenses").then(r => r.json()),
  });

  const createMutation = useMutation({
    mutationFn: (data: { amount: number; description: string }) =>
      apiRequest("POST", "/api/expenses", { ...data, category: "general" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      setQuickAmount(""); setQuickDesc("");
    },
  });

  const analytics = useMemo(() => {
    const now = new Date();
    const thisMonth = now.toISOString().slice(0, 7);
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonth = lastMonthDate.toISOString().slice(0, 7);

    const thisMonthExpenses = expenses.filter(e => e.date?.startsWith(thisMonth));
    const lastMonthExpenses = expenses.filter(e => e.date?.startsWith(lastMonth));

    const thisMonthTotal = thisMonthExpenses.reduce((s, e) => s + e.amount, 0);
    const lastMonthTotal = lastMonthExpenses.reduce((s, e) => s + e.amount, 0);
    const change = lastMonthTotal > 0 ? ((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100 : 0;

    // Daily spending for last 30 days
    const dailySpending: { date: string; amount: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const dateStr = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const dayTotal = expenses.filter(e => e.date === dateStr).reduce((s, e) => s + e.amount, 0);
      dailySpending.push({ date: dateStr, amount: dayTotal });
    }

    const avgDaily = thisMonthExpenses.length > 0
      ? thisMonthTotal / now.getDate()
      : 0;

    return { thisMonthTotal, lastMonthTotal, change, dailySpending, avgDaily, thisMonthCount: thisMonthExpenses.length };
  }, [expenses]);

  const total = expenses.reduce((s, e) => s + e.amount, 0);

  // Group by category
  const byCategory = expenses.reduce((acc: Record<string, number>, e) => {
    acc[e.category] = (acc[e.category] || 0) + e.amount;
    return acc;
  }, {});
  const chartData = Object.entries(byCategory)
    .map(([name, amount]) => ({ name, amount: Number(amount.toFixed(2)) }))
    .sort((a, b) => b.amount - a.amount);

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <div className="h-8 w-40 rounded skeleton-shimmer" />
        <div className="h-48 rounded-lg skeleton-shimmer" />
      </div>
    );
  }

  const handleQuickCreate = () => {
    const amount = parseFloat(quickAmount);
    if (!amount || !quickDesc.trim()) return;
    createMutation.mutate({ amount, description: quickDesc.trim() });
  };

  return (
    <div className="p-4 md:p-6 space-y-4 overflow-y-auto h-full" data-testid="page-finance">
      <div>
        <h1 className="text-xl font-semibold" data-testid="text-finance-title">Finance</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Expense tracking and analysis</p>
      </div>

      {/* Quick add */}
      <div className="flex gap-2">
        <Input
          type="number"
          placeholder="Amount"
          value={quickAmount}
          onChange={e => setQuickAmount(e.target.value)}
          className="w-24"
          step="0.01"
        />
        <Input
          placeholder="Description..."
          value={quickDesc}
          onChange={e => setQuickDesc(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleQuickCreate()}
          className="flex-1"
        />
        <Button size="sm" onClick={handleQuickCreate} disabled={createMutation.isPending}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">All Time</p>
          <p className="text-lg font-bold tabular-nums">${total.toFixed(2)}</p>
        </Card>
        <Card className="p-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">This Month</p>
          <p className="text-lg font-bold tabular-nums">${analytics.thisMonthTotal.toFixed(2)}</p>
          {analytics.change !== 0 && (
            <div className={`flex items-center gap-0.5 text-[10px] ${analytics.change > 0 ? "text-red-500" : "text-green-500"}`}>
              {analytics.change > 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
              {Math.abs(analytics.change).toFixed(0)}% vs last month
            </div>
          )}
        </Card>
        <Card className="p-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Avg/Day</p>
          <p className="text-lg font-bold tabular-nums">${analytics.avgDaily.toFixed(2)}</p>
        </Card>
        <Card className="p-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Transactions</p>
          <p className="text-lg font-bold tabular-nums">{expenses.length}</p>
        </Card>
      </div>

      {/* 30-day daily spending sparkline */}
      {analytics.dailySpending.some(d => d.amount > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Daily Spending (30 days)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-24">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={analytics.dailySpending}>
                  <XAxis dataKey="date" tick={false} axisLine={false} />
                  <Tooltip
                    formatter={(v: number) => [`$${v.toFixed(2)}`, "Spent"]}
                    labelFormatter={(l: string) => new Date(l).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    contentStyle={{
                      background: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "8px",
                      fontSize: "12px",
                    }}
                  />
                  <Bar dataKey="amount" radius={[2, 2, 0, 0]} fill="hsl(var(--primary))" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Category breakdown */}
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

      {/* Recent expenses list */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Recent Expenses</CardTitle>
        </CardHeader>
        <CardContent>
          {expenses.length === 0 ? (
            <div className="text-center py-10">
              <DollarSign className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No expenses logged yet.</p>
              <p className="text-xs text-muted-foreground mt-1">Try: "spent $50 on groceries"</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {expenses.map((expense) => (
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
