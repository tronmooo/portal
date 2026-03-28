import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  DollarSign, Calendar, CreditCard, CheckCircle, AlertTriangle,
  Repeat, Building2, ArrowLeft, Plus, Pencil, Trash2,
} from "lucide-react";
import { Link } from "wouter";
import type { Obligation } from "@shared/schema";

const CATEGORY_ICONS: Record<string, any> = {
  housing: Building2, loan: CreditCard, insurance: AlertTriangle,
  health: CheckCircle, investment: DollarSign,
};

const CATEGORIES = [
  { value: "housing", label: "Housing" },
  { value: "loan", label: "Loan" },
  { value: "insurance", label: "Insurance" },
  { value: "health", label: "Health" },
  { value: "subscription", label: "Subscription" },
  { value: "utility", label: "Utility" },
  { value: "investment", label: "Investment" },
  { value: "other", label: "Other" },
];

const FREQUENCIES = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Biweekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
  { value: "once", label: "One-time" },
];

interface ObFormState {
  name: string;
  amount: string;
  frequency: string;
  category: string;
  nextDueDate: string;
  autopay: boolean;
  notes: string;
}

function blankForm(ob?: Obligation): ObFormState {
  return {
    name: ob?.name ?? "",
    amount: ob ? String(ob.amount) : "",
    frequency: ob?.frequency ?? "monthly",
    category: ob?.category ?? "housing",
    nextDueDate: ob?.nextDueDate ?? new Date().toISOString().slice(0, 10),
    autopay: ob?.autopay ?? false,
    notes: ob?.notes ?? "",
  };
}

function ObligationFormDialog({
  open,
  onClose,
  obligation,
}: {
  open: boolean;
  onClose: () => void;
  obligation?: Obligation;
}) {
  const { toast } = useToast();
  const isEdit = !!obligation;
  const [form, setForm] = useState<ObFormState>(() => blankForm(obligation));

  const mutation = useMutation({
    mutationFn: async () => {
      const amount = parseFloat(form.amount);
      if (!form.name.trim()) throw new Error("Name required");
      if (!amount || amount <= 0) throw new Error("Positive amount required");
      const payload = {
        name: form.name.trim(),
        amount,
        frequency: form.frequency,
        category: form.category,
        nextDueDate: form.nextDueDate,
        autopay: form.autopay,
        notes: form.notes.trim() || undefined,
      };
      if (isEdit) {
        const res = await apiRequest("PATCH", `/api/obligations/${obligation!.id}`, payload);
        return res.json();
      } else {
        const res = await apiRequest("POST", "/api/obligations", payload);
        return res.json();
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: isEdit ? "Obligation updated" : "Obligation created" });
      onClose();
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message || "Failed to save", variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm" data-testid={isEdit ? "dialog-edit-obligation" : "dialog-add-obligation"}>
        <DialogHeader>
          <DialogTitle className="text-sm">{isEdit ? "Edit Obligation" : "New Obligation"}</DialogTitle>
          <DialogDescription className="text-xs">
            {isEdit ? "Update this recurring bill or payment" : "Add a recurring bill or payment"}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3 py-2"
          onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }}
        >
          <div>
            <Label className="text-xs">Name</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Rent, Netflix, Car Payment"
              required
              data-testid="input-obligation-name"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Amount ($)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                placeholder="0.00"
                required
                data-testid="input-obligation-amount"
              />
            </div>
            <div>
              <Label className="text-xs">Frequency</Label>
              <Select value={form.frequency} onValueChange={(v) => setForm((f) => ({ ...f, frequency: v }))}>
                <SelectTrigger data-testid="select-obligation-frequency"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FREQUENCIES.map((f) => (
                    <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Category</Label>
              <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v }))}>
                <SelectTrigger data-testid="select-obligation-category"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Next Due Date</Label>
              <Input
                type="date"
                value={form.nextDueDate}
                onChange={(e) => setForm((f) => ({ ...f, nextDueDate: e.target.value }))}
                required
                data-testid="input-obligation-due-date"
              />
            </div>
          </div>
          <div>
            <Label className="text-xs">Notes (optional)</Label>
            <Input
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="Account number, website, etc."
              data-testid="input-obligation-notes"
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="ob-autopay"
              checked={form.autopay}
              onCheckedChange={(v) => setForm((f) => ({ ...f, autopay: v }))}
              data-testid="switch-autopay"
            />
            <Label htmlFor="ob-autopay" className="text-xs">Autopay enabled</Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button
              type="submit"
              size="sm"
              disabled={!form.name.trim() || !form.amount || mutation.isPending}
              data-testid="button-save-obligation"
            >
              {mutation.isPending ? "Saving..." : isEdit ? "Save Changes" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ObligationCard({
  ob,
  onEdit,
  onDelete,
}: {
  ob: Obligation;
  onEdit: (ob: Obligation) => void;
  onDelete: (ob: Obligation) => void;
}) {
  const { toast } = useToast();
  const Icon = CATEGORY_ICONS[ob.category] || DollarSign;
  const dueDate = new Date(ob.nextDueDate + "T12:00:00");
  const now = new Date();
  const daysUntilDue = Math.ceil((dueDate.getTime() - now.getTime()) / 86400000);
  const isOverdue = daysUntilDue < 0;
  const isDueSoon = daysUntilDue >= 0 && daysUntilDue <= 7;

  const payMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/obligations/${ob.id}/pay`, { amount: ob.amount }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Payment recorded" });
    },
    onError: () => toast({ title: "Failed to record payment", variant: "destructive" }),
  });

  return (
    <Card
      className={`${isOverdue ? "border-red-500/50" : isDueSoon ? "border-yellow-500/30" : ""}`}
      data-testid={`card-obligation-${ob.id}`}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-3 min-w-0">
            <div className={`p-2 rounded-lg shrink-0 ${isOverdue ? "bg-red-500/10" : isDueSoon ? "bg-yellow-500/10" : "bg-primary/10"}`}>
              <Icon className={`h-4 w-4 ${isOverdue ? "text-red-500" : isDueSoon ? "text-yellow-500" : "text-primary"}`} />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-medium truncate">{ob.name}</h3>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-lg font-semibold">${ob.amount.toLocaleString()}</span>
                <Badge variant="outline" className="text-[10px] h-5">
                  <Repeat className="h-2.5 w-2.5 mr-0.5" />{ob.frequency}
                </Badge>
              </div>
              <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                <Calendar className="h-3 w-3" />
                <span>Due: {dueDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                {isOverdue && (
                  <Badge variant="destructive" className="text-[10px] h-4 ml-1">
                    {Math.abs(daysUntilDue)}d overdue
                  </Badge>
                )}
                {isDueSoon && !isOverdue && (
                  <Badge className="text-[10px] h-4 ml-1 bg-yellow-500/20 text-yellow-600 border-yellow-500/30">
                    {daysUntilDue === 0 ? "Today" : `${daysUntilDue}d`}
                  </Badge>
                )}
              </div>
              {ob.autopay && (
                <div className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground">
                  <CheckCircle className="h-2.5 w-2.5 text-green-500" /> Autopay enabled
                </div>
              )}
              {ob.notes && <p className="text-[10px] text-muted-foreground mt-1">{ob.notes}</p>}
            </div>
          </div>
          {/* Actions */}
          <div className="flex flex-col items-end gap-1 shrink-0">
            <Button
              size="sm"
              variant="outline"
              onClick={() => payMutation.mutate()}
              disabled={payMutation.isPending}
              className="h-7 text-xs"
              data-testid={`button-pay-${ob.id}`}
            >
              Mark Paid
            </Button>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                onClick={() => onEdit(ob)}
                aria-label={`Edit ${ob.name}`}
                data-testid={`button-edit-obligation-${ob.id}`}
              >
                <Pencil className="h-3 w-3" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                onClick={() => onDelete(ob)}
                aria-label={`Delete ${ob.name}`}
                data-testid={`button-delete-obligation-${ob.id}`}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </div>

        {/* Payment history */}
        {ob.payments.length > 0 && (
          <div className="mt-3 pt-2 border-t border-border">
            <p className="text-[10px] text-muted-foreground mb-1">Recent payments</p>
            <div className="flex gap-2 overflow-x-auto">
              {ob.payments.slice(-3).map((p) => (
                <div
                  key={p.id}
                  className="text-[10px] text-muted-foreground bg-muted rounded px-2 py-0.5 shrink-0"
                >
                  ${p.amount} — {new Date(p.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  {p.method && ` (${p.method})`}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function ObligationsPage() {
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Obligation | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Obligation | null>(null);

  const { data: obligations = [], isLoading } = useQuery<Obligation[]>({
    queryKey: ["/api/obligations"],
    queryFn: () => apiRequest("GET", "/api/obligations").then((r) => r.json()),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/obligations/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Obligation deleted" });
      setDeleteTarget(null);
    },
    onError: () => toast({ title: "Failed to delete obligation", variant: "destructive" }),
  });

  const sorted = [...obligations].sort(
    (a, b) => new Date(a.nextDueDate).getTime() - new Date(b.nextDueDate).getTime()
  );

  const monthlyTotal = obligations.reduce((s, o) => {
    switch (o.frequency) {
      case "weekly": return s + o.amount * 4.33;
      case "biweekly": return s + o.amount * 2.17;
      case "monthly": return s + o.amount;
      case "quarterly": return s + o.amount / 3;
      case "yearly": return s + o.amount / 12;
      default: return s;
    }
  }, 0);

  const now = new Date();
  const upcomingCount = obligations.filter((o) => {
    const d = new Date(o.nextDueDate);
    return d >= now && d <= new Date(now.getTime() + 7 * 86400000);
  }).length;

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4 pb-24">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-4">
            <Link href="/dashboard">
              <button
                className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors"
                data-testid="button-back"
                aria-label="Back to Dashboard"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            </Link>
            <h1 className="text-lg font-semibold">Obligations</h1>
          </div>
          <p className="text-xs text-muted-foreground">Recurring bills and payments</p>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)} data-testid="button-add-obligation">
          <Plus className="w-4 h-4 mr-1" /> New
        </Button>
      </div>

      {/* Add / Edit Dialog */}
      {addOpen && (
        <ObligationFormDialog open={addOpen} onClose={() => setAddOpen(false)} />
      )}
      {editTarget && (
        <ObligationFormDialog
          open={!!editTarget}
          onClose={() => setEditTarget(null)}
          obligation={editTarget}
        />
      )}

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete obligation?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{deleteTarget?.name}" and all its payment history. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete-obligation"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="p-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Monthly Total</p>
          <p className="text-lg font-bold">${monthlyTotal.toFixed(0)}</p>
        </Card>
        <Card className="p-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Active</p>
          <p className="text-lg font-bold">{obligations.length}</p>
        </Card>
        <Card className="p-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Due This Week</p>
          <p className={`text-lg font-bold ${upcomingCount > 0 ? "text-yellow-500" : ""}`}>{upcomingCount}</p>
        </Card>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="text-center py-12">
          <CreditCard className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
          <h3 className="text-sm font-medium mb-1">No obligations yet</h3>
          <p className="text-xs text-muted-foreground mb-4">
            Track recurring bills, subscriptions, and payments.
          </p>
          <Button size="sm" onClick={() => setAddOpen(true)} data-testid="button-add-obligation-empty">
            <Plus className="w-4 h-4 mr-1" /> Add Your First Obligation
          </Button>
        </div>
      ) : (
        <div className="grid gap-3">
          {sorted.map((ob) => (
            <ObligationCard
              key={ob.id}
              ob={ob}
              onEdit={setEditTarget}
              onDelete={setDeleteTarget}
            />
          ))}
        </div>
      )}
    </div>
  );
}
