import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DollarSign, Calendar, CreditCard, CheckCircle, AlertTriangle, Clock, Repeat, Building2, ArrowLeft, Plus } from "lucide-react";
import { Link } from "wouter";
import type { Obligation } from "@shared/schema";

const CATEGORY_ICONS: Record<string, any> = {
  housing: Building2, loan: CreditCard, insurance: AlertTriangle,
  health: CheckCircle, investment: DollarSign,
};

function ObligationCard({ ob }: { ob: Obligation }) {
  const Icon = CATEGORY_ICONS[ob.category] || DollarSign;
  const dueDate = new Date(ob.nextDueDate);
  const now = new Date();
  const daysUntilDue = Math.ceil((dueDate.getTime() - now.getTime()) / 86400000);
  const isOverdue = daysUntilDue < 0;
  const isDueSoon = daysUntilDue >= 0 && daysUntilDue <= 7;

  const payMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/obligations/${ob.id}/pay`, { amount: ob.amount }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/obligations"] }); queryClient.invalidateQueries({ queryKey: ["/api/stats"] }); },
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
          <Button
            size="sm"
            variant="outline"
            onClick={() => payMutation.mutate()}
            disabled={payMutation.isPending}
            className="h-7 text-xs shrink-0"
            data-testid={`button-pay-${ob.id}`}
          >
            Mark Paid
          </Button>
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
  const { data: obligations = [], isLoading } = useQuery<Obligation[]>({
    queryKey: ["/api/obligations"],
    queryFn: () => apiRequest("GET", "/api/obligations").then(r => r.json()),
  });

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
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-4">
            <Link href="/dashboard">
              <button className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors" data-testid="button-back">
                <ArrowLeft className="w-4 h-4" />
              </button>
            </Link>
            <h1 className="text-lg font-semibold">Obligations</h1>
          </div>
          <p className="text-xs text-muted-foreground">Recurring bills and payments</p>
        </div>
        <Link href="/">
          <Button size="sm" data-testid="button-add-obligation">
            <Plus className="w-4 h-4 mr-1" /> New
          </Button>
        </Link>
      </div>

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
