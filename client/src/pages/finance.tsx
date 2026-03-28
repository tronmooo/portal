import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { DollarSign, ShoppingCart, ArrowLeft, Plus, Pencil, Trash2 } from "lucide-react";
import { Link } from "wouter";
import type { Expense } from "@shared/schema";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from "recharts";

const CATEGORIES = ["food", "transport", "health", "entertainment", "pet", "housing", "utilities", "education", "general"] as const;
type ExpenseCategory = typeof CATEGORIES[number];

const categoryColors: Record<string, string> = {
  food: "hsl(var(--chart-1))",
  pet: "hsl(var(--chart-4))",
  transport: "hsl(var(--chart-2))",
  health: "hsl(var(--chart-3))",
  entertainment: "hsl(var(--chart-5))",
  general: "hsl(var(--primary))",
  housing: "hsl(var(--chart-1))",
  utilities: "hsl(var(--chart-2))",
  education: "hsl(var(--chart-3))",
};

interface ExpenseFormState {
  amount: string;
  description: string;
  category: string;
  vendor: string;
  date: string;
}

const blankForm = (): ExpenseFormState => ({
  amount: "",
  description: "",
  category: "general",
  vendor: "",
  date: new Date().toISOString().slice(0, 10),
});

function ExpenseFormDialog({
  open,
  onClose,
  initial,
  expenseId,
}: {
  open: boolean;
  onClose: () => void;
  initial?: ExpenseFormState;
  expenseId?: string;
}) {
  const { toast } = useToast();
  const isEdit = !!expenseId;
  const [form, setForm] = useState<ExpenseFormState>(initial ?? blankForm());

  const mutation = useMutation({
    mutationFn: async () => {
      const amount = parseFloat(form.amount);
      if (!amount || amount <= 0) throw new Error("Positive amount required");
      if (!form.description.trim()) throw new Error("Description required");
      const payload: Record<string, unknown> = {
        amount,
        description: form.description.trim(),
        category: form.category,
        date: form.date,
      };
      if (form.vendor.trim()) payload.vendor = form.vendor.trim();
      if (isEdit) {
        const res = await apiRequest("PATCH", `/api/expenses/${expenseId}`, payload);
        return res.json();
      } else {
        const res = await apiRequest("POST", "/api/expenses", payload);
        return res.json();
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: isEdit ? "Expense updated" : "Expense logged" });
      onClose();
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message || "Failed to save expense", variant: "destructive" });
    },
  });

  // Reset form when dialog opens
  const handleOpenChange = (o: boolean) => {
    if (!o) onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm" data-testid={isEdit ? "dialog-edit-expense" : "dialog-add-expense"}>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Expense" : "Log Expense"}</DialogTitle>
          <DialogDescription className="text-xs">
            {isEdit ? "Update this expense" : "Add a new expense to track"}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3 py-1"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="exp-amount" className="text-xs">Amount ($)</Label>
              <Input
                id="exp-amount"
                type="number"
                min="0.01"
                step="0.01"
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                placeholder="0.00"
                required
                data-testid="input-expense-amount"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exp-date" className="text-xs">Date</Label>
              <Input
                id="exp-date"
                type="date"
                value={form.date}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                required
                data-testid="input-expense-date"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="exp-desc" className="text-xs">Description</Label>
            <Input
              id="exp-desc"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="e.g. Groceries at Whole Foods"
              required
              data-testid="input-expense-description"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Category</Label>
              <Select
                value={form.category}
                onValueChange={(v) => setForm((f) => ({ ...f, category: v }))}
              >
                <SelectTrigger data-testid="select-expense-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c} className="capitalize">
                      {c.charAt(0).toUpperCase() + c.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="exp-vendor" className="text-xs">Vendor (optional)</Label>
              <Input
                id="exp-vendor"
                value={form.vendor}
                onChange={(e) => setForm((f) => ({ ...f, vendor: e.target.value }))}
                placeholder="Store / merchant"
                data-testid="input-expense-vendor"
              />
            </div>
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={mutation.isPending} data-testid="button-save-expense">
              {mutation.isPending ? "Saving..." : isEdit ? "Save Changes" : "Log Expense"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function FinancePage() {
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [editExpense, setEditExpense] = useState<Expense | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Expense | null>(null);

  const { data: expenses, isLoading } = useQuery<Expense[]>({
    queryKey: ["/api/expenses"],
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/expenses/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Expense deleted" });
      setDeleteTarget(null);
    },
    onError: () => toast({ title: "Failed to delete expense", variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <div className="h-8 w-40 rounded skeleton-shimmer" />
        <div className="h-48 rounded-lg skeleton-shimmer" />
      </div>
    );
  }

  const allExpenses = expenses || [];
  const total = allExpenses.reduce((s, e) => s + e.amount, 0);

  const byCategory = allExpenses.reduce((acc: Record<string, number>, e) => {
    acc[e.category] = (acc[e.category] || 0) + e.amount;
    return acc;
  }, {});
  const chartData = Object.entries(byCategory).map(([name, amount]) => ({
    name,
    amount: Number(amount.toFixed(2)),
  }));

  // Sort expenses: newest first
  const sorted = [...allExpenses].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  return (
    <div className="p-4 md:p-6 space-y-6 overflow-y-auto h-full pb-24" data-testid="page-finance">
      {/* Header */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Link href="/dashboard">
              <button
                className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors"
                aria-label="Back"
                data-testid="button-back"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            </Link>
            <h1 className="text-xl font-semibold" data-testid="text-finance-title">
              Finance
            </h1>
          </div>
          <Button size="sm" onClick={() => setAddOpen(true)} data-testid="button-add-expense">
            <Plus className="w-3.5 h-3.5 mr-1" /> Log Expense
          </Button>
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">Expense tracking and analysis</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Total Spent</p>
            <p className="text-2xl font-semibold mt-1 tabular-nums" data-testid="text-total-spent">
              ${total.toFixed(2)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Transactions</p>
            <p className="text-2xl font-semibold mt-1 tabular-nums">{allExpenses.length}</p>
          </CardContent>
        </Card>
      </div>

      {/* Chart */}
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
                      <Cell
                        key={entry.name}
                        fill={categoryColors[entry.name] || categoryColors.general}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Expense list */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">All Expenses</CardTitle>
        </CardHeader>
        <CardContent>
          {sorted.length === 0 ? (
            <div className="text-center py-10">
              <DollarSign className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No expenses logged yet.</p>
              <p className="text-xs text-muted-foreground mt-1">
                Click "Log Expense" above or try: "spent $50 on groceries"
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {sorted.map((expense) => (
                <div
                  key={expense.id}
                  className="flex items-center gap-3 py-3 group"
                  data-testid={`expense-${expense.id}`}
                >
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <ShoppingCart className="h-3.5 w-3.5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{expense.description}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Badge variant="secondary" className="text-xs capitalize">
                        {expense.category}
                      </Badge>
                      {expense.vendor && (
                        <span className="text-xs text-muted-foreground truncate">{expense.vendor}</span>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {new Date(expense.date + "T12:00:00").toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    </div>
                  </div>
                  <span className="text-sm font-semibold tabular-nums shrink-0">
                    ${expense.amount.toFixed(2)}
                  </span>
                  {/* Edit / Delete actions */}
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                      onClick={() => setEditExpense(expense)}
                      aria-label={`Edit ${expense.description}`}
                      data-testid={`button-edit-expense-${expense.id}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteTarget(expense)}
                      aria-label={`Delete ${expense.description}`}
                      data-testid={`button-delete-expense-${expense.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add expense dialog */}
      {addOpen && (
        <ExpenseFormDialog
          open={addOpen}
          onClose={() => setAddOpen(false)}
        />
      )}

      {/* Edit expense dialog */}
      {editExpense && (
        <ExpenseFormDialog
          open={!!editExpense}
          onClose={() => setEditExpense(null)}
          expenseId={editExpense.id}
          initial={{
            amount: String(editExpense.amount),
            description: editExpense.description,
            category: editExpense.category,
            vendor: editExpense.vendor ?? "",
            date: editExpense.date,
          }}
        />
      )}

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete expense?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{deleteTarget?.description}" (${deleteTarget?.amount.toFixed(2)}).
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete-expense"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
