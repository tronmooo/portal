import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { DollarSign, Calendar, CreditCard, CheckCircle, AlertTriangle, Clock, Repeat, Building2, ArrowLeft, Plus, Trash2 } from "lucide-react";
import { Link } from "wouter";
import type { Obligation } from "@shared/schema";

const CATEGORY_ICONS: Record<string, any> = {
  housing: Building2, loan: CreditCard, insurance: AlertTriangle,
  health: CheckCircle, investment: DollarSign,
};

function ObligationCard({ ob, onDelete }: { ob: Obligation; onDelete: (id: string) => void }) {
  const { toast } = useToast();
  const Icon = CATEGORY_ICONS[ob.category] || DollarSign;
  const dueDate = new Date(ob.nextDueDate);
  const now = new Date();
  const daysUntilDue = Math.ceil((dueDate.getTime() - now.getTime()) / 86400000);
  const isOverdue = daysUntilDue < 0;
  const isDueSoon = daysUntilDue >= 0 && daysUntilDue <= 7;

  const payMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/obligations/${ob.id}/pay`, { amount: ob.amount }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/obligations"] }); queryClient.invalidateQueries({ queryKey: ["/api/stats"] }); },
    onError: () => toast({ title: "Failed to record payment", variant: "destructive" }),
  });

  return (
    <Card className={`${isOverdue ? "border-red-500/50" : isDueSoon ? "border-yellow-500/30" : ""}`} data-testid={`card-obligation-${ob.id}`}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className={`p-2 rounded-lg ${isOverdue ? "bg-red-500/10" : isDueSoon ? "bg-yellow-500/10" : "bg-primary/10"}`}>
              <Icon className={`h-4 w-4 ${isOverdue ? "text-red-500" : isDueSoon ? "text-yellow-500" : "text-primary"}`} />
            </div>
            <div>
              <h3 className="text-sm font-medium">{ob.name}</h3>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-lg font-semibold">${ob.amount.toLocaleString()}</span>
                <Badge variant="outline" className="text-[10px] h-5">
                  <Repeat className="h-2.5 w-2.5 mr-0.5" />{ob.frequency}
                </Badge>
              </div>
              <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                <Calendar className="h-3 w-3" />
                <span>Due: {dueDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                {isOverdue && <Badge variant="destructive" className="text-[10px] h-4 ml-1">{Math.abs(daysUntilDue)}d overdue</Badge>}
                {isDueSoon && !isOverdue && <Badge className="text-[10px] h-4 ml-1 bg-yellow-500/20 text-yellow-600 border-yellow-500/30">{daysUntilDue === 0 ? "Today" : `${daysUntilDue}d`}</Badge>}
              </div>
              {ob.autopay && (
                <div className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground">
                  <CheckCircle className="h-2.5 w-2.5 text-green-500" /> Autopay enabled
                </div>
              )}
              {ob.notes && <p className="text-[10px] text-muted-foreground mt-1">{ob.notes}</p>}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
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
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onDelete(ob.id)}
              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
              data-testid={`button-delete-${ob.id}`}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </div>

        {/* Payment history */}
        {ob.payments.length > 0 && (
          <div className="mt-3 pt-2 border-t border-border">
            <p className="text-[10px] text-muted-foreground mb-1">Recent payments</p>
            <div className="flex gap-2 overflow-x-auto">
              {ob.payments.slice(-3).map(p => (
                <div key={p.id} className="text-[10px] text-muted-foreground bg-muted rounded px-2 py-0.5 shrink-0">
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
  const [newName, setNewName] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [newFrequency, setNewFrequency] = useState("monthly");
  const [newCategory, setNewCategory] = useState("housing");
  const [newDueDate, setNewDueDate] = useState(new Date().toISOString().slice(0, 10));

  const { data: obligations = [], isLoading } = useQuery<Obligation[]>({
    queryKey: ["/api/obligations"],
    queryFn: () => apiRequest("GET", "/api/obligations").then(r => r.json()),
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/obligations", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Obligation created" });
      setAddOpen(false);
      setNewName(""); setNewAmount(""); setNewFrequency("monthly"); setNewCategory("housing");
    },
    onError: () => toast({ title: "Failed to create obligation", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/obligations/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      toast({ title: "Obligation deleted" });
    },
    onError: () => toast({ title: "Failed to delete obligation", variant: "destructive" }),
  });

  const handleDelete = (id: string) => {
    if (confirm("Delete this obligation?")) deleteMutation.mutate(id);
  };

  const sorted = [...obligations].sort((a, b) => new Date(a.nextDueDate).getTime() - new Date(b.nextDueDate).getTime());
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
  const upcomingCount = obligations.filter(o => {
    const d = new Date(o.nextDueDate);
    return d >= now && d <= new Date(now.getTime() + 7 * 86400000);
  }).length;

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
            <h1 className="text-lg font-semibold">Obligations</h1>
          </div>
          <p className="text-xs text-muted-foreground">Recurring bills and payments</p>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)} data-testid="button-add-obligation">
          <Plus className="w-4 h-4 mr-1" /> New
        </Button>
      </div>

      {/* Add Obligation Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">New Obligation</DialogTitle>
            <DialogDescription className="text-xs">Add a recurring bill or payment</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs">Name</Label>
              <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Rent, Netflix, Car Payment" data-testid="input-obligation-name" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Amount ($)</Label>
                <Input type="number" min="0" step="0.01" value={newAmount} onChange={e => setNewAmount(e.target.value)} placeholder="0.00" data-testid="input-obligation-amount" />
              </div>
              <div>
                <Label className="text-xs">Frequency</Label>
                <Select value={newFrequency} onValueChange={setNewFrequency}>
                  <SelectTrigger data-testid="select-obligation-frequency"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="biweekly">Biweekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
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
                    <SelectItem value="housing">Housing</SelectItem>
                    <SelectItem value="loan">Loan</SelectItem>
                    <SelectItem value="insurance">Insurance</SelectItem>
                    <SelectItem value="health">Health</SelectItem>
                    <SelectItem value="subscription">Subscription</SelectItem>
                    <SelectItem value="utility">Utility</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Next Due Date</Label>
                <Input type="date" value={newDueDate} onChange={e => setNewDueDate(e.target.value)} data-testid="input-obligation-due-date" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button size="sm" disabled={!newName.trim() || !newAmount || createMutation.isPending}
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
          {[1, 2, 3].map(i => <div key={i} className="h-24 rounded-lg bg-muted animate-pulse" />)}
        </div>
      ) : sorted.length === 0 ? (
        <div className="text-center py-12">
          <CreditCard className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
          <h3 className="text-sm font-medium mb-1">No obligations yet</h3>
          <p className="text-xs text-muted-foreground mb-4">Track recurring bills, subscriptions, and payments.</p>
          <Button size="sm" onClick={() => setAddOpen(true)} data-testid="button-add-obligation-empty">
            <Plus className="w-4 h-4 mr-1" /> Add Your First Obligation
          </Button>
        </div>
      ) : (
        <div className="grid gap-3">
          {sorted.map(ob => (
            <ObligationCard key={ob.id} ob={ob} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  );
}
