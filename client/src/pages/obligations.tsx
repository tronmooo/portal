import { formatApiError } from "@/lib/formatError";
import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import EditableTitle from "@/components/EditableTitle";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { getProfileFilter, getFilterLabel } from "@/lib/profileFilter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { DollarSign, Calendar, CreditCard, CheckCircle, AlertTriangle, Clock, Repeat, Building2, ArrowLeft, Plus, AlertCircle, Trash2, Pencil } from "lucide-react";
import { Link } from "wouter";
import type { Obligation } from "@shared/schema";

const CATEGORY_ICONS: Record<string, any> = {
  housing: Building2, loan: CreditCard, insurance: AlertTriangle,
  health: CheckCircle, investment: DollarSign,
};

function ObligationCard({ ob }: { ob: Obligation }) {
  const { toast } = useToast();
  const Icon = CATEGORY_ICONS[ob.category] || DollarSign;
  const dueDate = new Date(ob.nextDueDate);
  const now = new Date();
  const daysUntilDue = Math.ceil((dueDate.getTime() - now.getTime()) / 86400000);
  const isOverdue = daysUntilDue < 0;
  const isDueSoon = daysUntilDue >= 0 && daysUntilDue <= 7;
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editAmount, setEditAmount] = useState(String(ob.amount));
  const [editDueDate, setEditDueDate] = useState(ob.nextDueDate?.slice(0, 10) || "");
  const [editFrequency, setEditFrequency] = useState<string>(ob.frequency);
  const [editCategory, setEditCategory] = useState(ob.category);

  const undoPayMutation = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/obligations/${ob.id}`, { isPaid: false }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: `"${ob.name}" payment undone` });
    },
    onError: (err: Error) => toast({ title: `Failed to undo payment`, description: formatApiError(err), variant: "destructive" }),
  });

  const payMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/obligations/${ob.id}/pay`, { amount: ob.amount }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({
        title: `"${ob.name}" marked paid`,
        description: `$${ob.amount.toFixed(2)} payment recorded`,
        action: <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => undoPayMutation.mutate()}>Undo</Button>,
      });
    },
    onError: (err: Error) => toast({ title: `Failed to pay "${ob.name}"`, description: formatApiError(err), variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/obligations/${ob.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: `"${ob.name}" deleted` });
    },
    onError: (err: Error) => toast({ title: `Failed to delete "${ob.name}"`, description: formatApiError(err), variant: "destructive" }),
  });

  const editMutation = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/obligations/${ob.id}`, {
      amount: parseFloat(editAmount),
      nextDueDate: editDueDate,
      frequency: editFrequency,
      category: editCategory,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      setEditOpen(false);
      toast({ title: `"${ob.name}" updated` });
    },
    onError: (err: Error) => toast({ title: `Failed to update "${ob.name}"`, description: formatApiError(err), variant: "destructive" }),
  });

  return (
    <>
    <Card className={`${isOverdue ? "border-red-500/50" : isDueSoon ? "border-yellow-500/30" : ""}`} data-testid={`card-obligation-${ob.id}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className={`p-2 rounded-lg ${isOverdue ? "bg-red-500/10" : isDueSoon ? "bg-yellow-500/10" : "bg-primary/10"}`}>
              <Icon className={`h-4 w-4 ${isOverdue ? "text-red-500" : isDueSoon ? "text-yellow-500" : "text-primary"}`} />
            </div>
            <div>
              <h3 className="text-sm font-medium">
                <EditableTitle
                  value={ob.name}
                  onSave={async (newName) => {
                    try {
                      await apiRequest("PATCH", `/api/obligations/${ob.id}`, { name: newName });
                      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
                      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
                      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
                      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
                      toast({ title: `Renamed to "${newName}"` });
                    } catch (err: any) {
                      toast({ title: "Failed to rename", description: formatApiError(err), variant: "destructive" });
                    }
                  }}
                />
              </h3>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-lg font-semibold">${ob.amount.toLocaleString()}</span>
                <Badge variant="outline" className="text-xs h-5">
                  <Repeat className="h-2.5 w-2.5 mr-0.5" />{ob.frequency}
                </Badge>
              </div>
              <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                <Calendar className="h-3 w-3" />
                <span>Due: {dueDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                {isOverdue && <Badge variant="destructive" className="text-xs h-4 ml-1">{Math.abs(daysUntilDue)}d overdue</Badge>}
                {isDueSoon && !isOverdue && <Badge className="text-xs h-4 ml-1 bg-yellow-500/20 text-yellow-600 border-yellow-500/30">{daysUntilDue === 0 ? "Today" : `${daysUntilDue}d`}</Badge>}
              </div>
              {ob.autopay && (
                <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                  <CheckCircle className="h-2.5 w-2.5 text-green-500" /> Autopay enabled
                </div>
              )}
              {ob.notes && <p className="text-xs text-muted-foreground mt-1">{ob.notes}</p>}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setEditAmount(String(ob.amount)); setEditDueDate(ob.nextDueDate?.slice(0, 10) || ""); setEditFrequency(ob.frequency); setEditCategory(ob.category); setEditOpen(true); }}
              className="h-7 w-7 p-0"
              title="Edit"
              data-testid={`button-edit-${ob.id}`}
            >
              <Pencil className="h-3 w-3" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowDeleteConfirm(true)}
              className="h-7 w-7 p-0 text-destructive"
              title="Delete"
              data-testid={`button-delete-${ob.id}`}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
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
          </div>
        </div>

        {/* Payment history */}
        {ob.payments.length > 0 && (
          <div className="mt-3 pt-2 border-t border-border">
            <p className="text-xs text-muted-foreground mb-1">Recent payments</p>
            <div className="flex gap-2 overflow-x-auto">
              {ob.payments.slice(-3).map(p => (
                <div key={p.id} className="text-xs text-muted-foreground bg-muted rounded px-2 py-0.5 shrink-0">
                  ${p.amount} — {new Date(p.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  {p.method && ` (${p.method})`}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>

    {/* Delete Confirmation */}
    <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete "{ob.name}"?</AlertDialogTitle>
          <AlertDialogDescription>This bill and its payment history will be permanently deleted.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => { deleteMutation.mutate(); setShowDeleteConfirm(false); }}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    {/* Edit Dialog */}
    <Dialog open={editOpen} onOpenChange={setEditOpen}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Edit "{ob.name}"</DialogTitle>
          <DialogDescription className="text-xs">Update bill details</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Amount ($)</Label>
              <Input type="number" min="0" step="0.01" value={editAmount} onChange={e => setEditAmount(e.target.value)} data-testid="input-edit-amount" />
            </div>
            <div>
              <Label className="text-xs">Frequency</Label>
              <Select value={editFrequency} onValueChange={setEditFrequency}>
                <SelectTrigger data-testid="select-edit-frequency"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="biweekly">Biweekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="quarterly">Quarterly</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="yearly">Yearly</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Category</Label>
              <Select value={editCategory} onValueChange={setEditCategory}>
                <SelectTrigger data-testid="select-edit-category"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="health">Health</SelectItem>
                  <SelectItem value="housing">Housing</SelectItem>
                  <SelectItem value="insurance">Insurance</SelectItem>
                  <SelectItem value="loan">Loan</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                  <SelectItem value="subscription">Subscription</SelectItem>
                  <SelectItem value="utility">Utility</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Next Due Date</Label>
              <Input type="date" value={editDueDate} onChange={e => setEditDueDate(e.target.value)} data-testid="input-edit-due-date" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setEditOpen(false)}>Cancel</Button>
          <Button size="sm" disabled={!editAmount || parseFloat(editAmount) <= 0 || editMutation.isPending}
            onClick={() => editMutation.mutate()} data-testid="button-save-edit-obligation">
            {editMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

export default function ObligationsPage() {
  useEffect(() => { document.title = "Bills — Portol"; }, []);
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [newFrequency, setNewFrequency] = useState("monthly");
  const [newCategory, setNewCategory] = useState("housing");
  const [newDueDate, setNewDueDate] = useState(new Date().toISOString().slice(0, 10));
  const [filterMode, setFilterMode] = useState(() => getProfileFilter().mode);
  const [filterIds, setFilterIds] = useState<string[]>(() => getProfileFilter().selectedIds);
  useEffect(() => {
    const handleFocus = () => {
      const { mode, selectedIds } = getProfileFilter();
      setFilterMode(mode);
      setFilterIds(selectedIds);
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);
  const filterLabel = getFilterLabel();
  const profileParam = filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";

  const { data: allObligations = [], isLoading, error, refetch } = useQuery<Obligation[]>({
    queryKey: ["/api/obligations", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/obligations${profileParam}`).then(r => r.json()),
  });

  // Client-side profile filter
  const obligations = useMemo(() => filterMode === "selected" && filterIds.length > 0
    ? allObligations.filter(o => o.linkedProfiles.some(id => filterIds.includes(id)))
    : allObligations, [allObligations, filterMode, filterIds]);

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/obligations", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      const savedName = newName;
      toast({ title: `"${savedName}" bill created`, description: `${newFrequency} · $${newAmount}` });
      setAddOpen(false);
      setNewName(""); setNewAmount(""); setNewFrequency("monthly"); setNewCategory("housing");
    },
    onError: (err: Error) => toast({ title: "Failed to create bill", description: formatApiError(err), variant: "destructive" }),
  });

  const sorted = useMemo(() => [...obligations].sort((a, b) => (a.name || '').localeCompare(b.name || '')), [obligations]);
  const monthlyTotal = useMemo(() => obligations.reduce((s, o) => {
    switch (o.frequency) {
      case "weekly": return s + o.amount * 4.33;
      case "biweekly": return s + o.amount * 2.17;
      case "monthly": return s + o.amount;
      case "quarterly": return s + o.amount / 3;
      case "yearly": return s + o.amount / 12;
      default: return s;
    }
  }, 0), [obligations]);

  const now = new Date();
  const upcomingCount = useMemo(() => obligations.filter(o => {
    const d = new Date(o.nextDueDate);
    return d >= now && d <= new Date(now.getTime() + 7 * 86400000);
  }).length, [obligations]);

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4 pb-24">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-4">
            <Link href="/dashboard">
              <button className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors" data-testid="button-back" aria-label="Back to Dashboard">
                <ArrowLeft className="w-4 h-4" />
              </button>
            </Link>
{filterMode === "selected" && filterLabel && (
            <span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-1 rounded-full">{filterLabel}</span>
          )}
          </div>
          <p className="text-xs text-muted-foreground">Recurring bills and payments</p>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)} data-testid="button-add-obligation">
          <Plus className="w-4 h-4 mr-1" /> New
        </Button>
      </div>

      {/* Add Obligation Dialog */}
      <Dialog open={addOpen} onOpenChange={(v) => { if (!v) { setNewName(""); setNewAmount(""); setNewFrequency("monthly"); setNewCategory("housing"); setNewDueDate(new Date().toISOString().slice(0, 10)); } setAddOpen(v); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">New Obligation</DialogTitle>
            <DialogDescription className="text-xs">Add a recurring bill or payment</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs">Name <span className="text-destructive">*</span></Label>
              <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Rent, Netflix, Car Payment" data-testid="input-obligation-name" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Amount ($) <span className="text-destructive">*</span></Label>
                <Input type="number" min="0" step="0.01" value={newAmount} onChange={e => setNewAmount(e.target.value)} placeholder="0.00" data-testid="input-obligation-amount" />
              </div>
              <div>
                <Label className="text-xs">Frequency</Label>
                <Select value={newFrequency} onValueChange={setNewFrequency}>
                  <SelectTrigger data-testid="select-obligation-frequency"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="biweekly">Biweekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="yearly">Yearly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Category</Label>
                <Select value={newCategory} onValueChange={setNewCategory}>
                  <SelectTrigger data-testid="select-obligation-category"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="health">Health</SelectItem>
                    <SelectItem value="housing">Housing</SelectItem>
                    <SelectItem value="insurance">Insurance</SelectItem>
                    <SelectItem value="loan">Loan</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                    <SelectItem value="subscription">Subscription</SelectItem>
                    <SelectItem value="utility">Utility</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Next Due Date <span className="text-destructive">*</span></Label>
                <Input type="date" value={newDueDate} onChange={e => setNewDueDate(e.target.value)} data-testid="input-obligation-due-date" />
              </div>
            </div>
          </div>
          {newDueDate && new Date(newDueDate + "T00:00:00") < new Date(new Date().toLocaleDateString('en-CA') + "T00:00:00") && (
            <div className="flex items-center gap-2 rounded-md bg-yellow-500/10 border border-yellow-500/30 px-3 py-2">
              <AlertTriangle className="h-3.5 w-3.5 text-yellow-600 shrink-0" />
              <p className="text-xs text-yellow-700 dark:text-yellow-400">The due date is in the past. You can still create this bill.</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button size="sm" disabled={!newName.trim() || !newAmount || parseFloat(newAmount) <= 0 || createMutation.isPending}
              onClick={() => createMutation.mutate({
                name: newName.trim(), amount: parseFloat(newAmount), frequency: newFrequency,
                category: newCategory, nextDueDate: newDueDate, autopay: false,
              })} data-testid="button-save-obligation">
              {createMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="p-3">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Monthly Total</p>
          <p className="text-lg font-bold">${monthlyTotal.toFixed(0)}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Active</p>
          <p className="text-lg font-bold">{obligations.length}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Due This Week</p>
          <p className={`text-lg font-bold ${upcomingCount > 0 ? "text-yellow-500" : ""}`}>{upcomingCount}</p>
        </Card>
      </div>

      {isLoading ? (
        <div className="p-4 space-y-3">
          <div className="h-8 w-48 rounded skeleton-shimmer" />
          <div className="h-20 rounded skeleton-shimmer" />
          <div className="h-20 rounded skeleton-shimmer" />
        </div>
      ) : error ? (
        <div className="p-4 text-center">
          <AlertCircle className="h-8 w-8 text-destructive mx-auto mb-2" />
          <p className="text-sm text-destructive">Failed to load data</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>Retry</Button>
        </div>
      ) : sorted.length === 0 ? (
        <div className="text-center py-12">
          <CreditCard className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
          <h3 className="text-sm font-medium mb-1">No bills yet</h3>
          <p className="text-xs text-muted-foreground mb-4">Add one to start tracking recurring bills, subscriptions, and payments.</p>
          <Button size="sm" onClick={() => setAddOpen(true)} data-testid="button-add-obligation-empty">
            <Plus className="w-4 h-4 mr-1" /> Add Your First Obligation
          </Button>
        </div>
      ) : (
        <div className="grid gap-3">
          {sorted.map(ob => (
            <ObligationCard key={ob.id} ob={ob} />
          ))}
        </div>
      )}
    </div>
  );
}
