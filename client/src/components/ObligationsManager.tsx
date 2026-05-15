// Obligations management UI extracted from /obligations into a reusable
// component so it can be embedded as a tab on /calendar. Owns:
//   • Live occurrence panel (Overdue / Due today / Next 14 days)
//   • Full list of recurring obligations with edit / delete / mark-paid
//   • Create dialog with kind-aware defaults
// This is intentionally self-contained — drop it anywhere there's a page shell.

import { formatApiError } from "@/lib/formatError";
import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import EditableTitle from "@/components/EditableTitle";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { getProfileFilter } from "@/lib/profileFilter";
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
import { DollarSign, Calendar, CreditCard, CheckCircle, AlertTriangle, Clock, Repeat, Building2, Plus, AlertCircle, Trash2, Pencil, Receipt, Pill, Wrench, CalendarClock, Activity, FileWarning, CheckSquare, SkipForward, RotateCcw } from "lucide-react";
import type { Obligation } from "@shared/schema";
import { OBLIGATION_KIND_META, type ObligationKind } from "@shared/schema";

const KIND_ICON: Record<ObligationKind, any> = {
  bill: Receipt, subscription: Repeat, loan_payment: CreditCard,
  medication: Pill, maintenance: Wrench, appointment: CalendarClock,
  habit: Activity, doc_expiration: FileWarning, task: CheckSquare,
};

const CATEGORY_ICONS: Record<string, any> = {
  housing: Building2, loan: CreditCard, insurance: AlertTriangle,
  health: CheckCircle, investment: DollarSign,
};

// Shared cache invalidator so every mutation refreshes the same surfaces.
function invalidateAll() {
  queryClient.invalidateQueries({ queryKey: ["/api/obligation-occurrences"] });
  queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
  queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
  queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
  queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
  queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
}

// Per-occurrence row used by the live "Due today / Overdue / Upcoming" panel.
function OccurrenceRow({ occ }: { occ: any }) {
  const { toast } = useToast();
  const kind = (occ.obligation?.kind || "bill") as ObligationKind;
  const meta = OBLIGATION_KIND_META[kind];
  const Icon = KIND_ICON[kind] || Receipt;
  const due = new Date(occ.due_at + "T00:00:00");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const daysOff = Math.round((due.getTime() - today.getTime()) / 86400000);
  const isOverdue = occ.status === "late" || (occ.status === "pending" && daysOff < 0);
  const isDone = occ.status === "done";
  const isSkipped = occ.status === "skipped";

  const setStatus = useMutation({
    mutationFn: (status: string) => apiRequest("POST", `/api/obligation-occurrences/${occ.id}/status`, { status }),
    onSuccess: (_d, status) => { invalidateAll(); toast({ title: status === "done" ? "Marked done" : status === "skipped" ? "Skipped" : "Updated" }); },
    onError: (err: Error) => toast({ title: "Update failed", description: formatApiError(err), variant: "destructive" }),
  });
  const reschedule = useMutation({
    mutationFn: (newDueAt: string) => apiRequest("POST", `/api/obligation-occurrences/${occ.id}/reschedule`, { newDueAt }),
    onSuccess: () => { invalidateAll(); toast({ title: "Rescheduled" }); },
    onError: (err: Error) => toast({ title: "Reschedule failed", description: formatApiError(err), variant: "destructive" }),
  });

  const dateLabel = isOverdue ? `${Math.abs(daysOff)}d overdue`
    : daysOff === 0 ? "Today"
    : daysOff === 1 ? "Tomorrow"
    : daysOff > 0 ? `In ${daysOff}d`
    : due.toLocaleDateString();

  return (
    <div data-testid={`occurrence-row-${occ.id}`} className={`flex items-center gap-3 rounded-md border px-3 py-2 ${isOverdue ? "border-red-500/40 bg-red-500/5" : isDone ? "opacity-60" : isSkipped ? "opacity-50" : "border-border"}`}>
      <span className="shrink-0 inline-flex items-center justify-center rounded-md" style={{ width: 32, height: 32, background: `${meta.color}22`, color: meta.color }}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className={`text-sm font-medium truncate ${isDone ? "line-through" : ""}`}>{occ.obligation?.name || "Untitled"}</p>
          <Badge variant="outline" className="text-[10px] py-0 px-1.5 h-4" style={{ borderColor: meta.color, color: meta.color }}>{meta.label}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {occ.obligation?.amount > 0 && <>${Number(occ.obligation.amount).toFixed(2)} · </>}
          <span className={isOverdue ? "text-red-600 font-medium" : ""}>{dateLabel}</span>
          {occ.obligation?.autopay && <> · Autopay</>}
        </p>
      </div>
      {!isDone && !isSkipped && (
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" className="h-7 px-2" disabled={setStatus.isPending}
            onClick={() => setStatus.mutate("done")} data-testid={`button-mark-done-${occ.id}`}>
            <CheckCircle className="h-3.5 w-3.5 mr-1" /> Done
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" disabled={setStatus.isPending}
            onClick={() => setStatus.mutate("skipped")} data-testid={`button-skip-${occ.id}`} aria-label="Skip">
            <SkipForward className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" disabled={reschedule.isPending}
            onClick={() => {
              const next = prompt("Reschedule to (YYYY-MM-DD):", occ.due_at);
              if (next && /^\d{4}-\d{2}-\d{2}$/.test(next)) reschedule.mutate(next);
            }} data-testid={`button-reschedule-${occ.id}`} aria-label="Reschedule">
            <Clock className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      {(isDone || isSkipped) && (
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={setStatus.isPending}
          onClick={() => setStatus.mutate("pending")} data-testid={`button-undo-${occ.id}`}>
          <RotateCcw className="h-3.5 w-3.5 mr-1" /> Undo
        </Button>
      )}
    </div>
  );
}

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
  const [editKind, setEditKind] = useState<ObligationKind>((ob.kind as ObligationKind) || "bill");

  const undoPayMutation = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/obligations/${ob.id}`, { isPaid: false }),
    onSuccess: () => { invalidateAll(); toast({ title: `"${ob.name}" payment undone` }); },
    onError: (err: Error) => toast({ title: `Failed to undo payment`, description: formatApiError(err), variant: "destructive" }),
  });

  const payMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/obligations/${ob.id}/pay`, { amount: ob.amount }),
    onSuccess: () => {
      invalidateAll();
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
    onSuccess: () => { invalidateAll(); toast({ title: `"${ob.name}" deleted` }); },
    onError: (err: Error) => toast({ title: `Failed to delete "${ob.name}"`, description: formatApiError(err), variant: "destructive" }),
  });

  const editMutation = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/obligations/${ob.id}`, {
      amount: parseFloat(editAmount),
      nextDueDate: editDueDate,
      frequency: editFrequency,
      category: editCategory,
      kind: editKind,
    }),
    onSuccess: () => { invalidateAll(); setEditOpen(false); toast({ title: `"${ob.name}" updated` }); },
    onError: (err: Error) => toast({ title: `Failed to update "${ob.name}"`, description: formatApiError(err), variant: "destructive" }),
  });

  const kindMeta = OBLIGATION_KIND_META[(ob.kind as ObligationKind) || "bill"];
  const KindIcon = KIND_ICON[(ob.kind as ObligationKind) || "bill"] || Icon;

  return (
    <>
      <Card className={`${isOverdue ? "border-red-500/50" : isDueSoon ? "border-yellow-500/30" : ""}`} data-testid={`card-obligation-${ob.id}`}>
        <CardContent className="p-4">
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3 min-w-0">
              <div className="p-2 rounded-lg shrink-0" style={{ background: `${kindMeta.color}1A`, color: kindMeta.color }}>
                <KindIcon className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-medium">
                  <EditableTitle
                    value={ob.name}
                    onSave={async (newName) => {
                      try {
                        await apiRequest("PATCH", `/api/obligations/${ob.id}`, { name: newName });
                        invalidateAll();
                        toast({ title: `Renamed to "${newName}"` });
                      } catch (err: any) {
                        toast({ title: "Failed to rename", description: formatApiError(err), variant: "destructive" });
                      }
                    }}
                  />
                </h3>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="text-lg font-semibold">${ob.amount.toLocaleString()}</span>
                  <Badge variant="outline" className="text-xs h-5" style={{ borderColor: kindMeta.color, color: kindMeta.color }}>
                    {kindMeta.label}
                  </Badge>
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
              <Button size="sm" variant="ghost"
                onClick={() => { setEditAmount(String(ob.amount)); setEditDueDate(ob.nextDueDate?.slice(0, 10) || ""); setEditFrequency(ob.frequency); setEditCategory(ob.category); setEditKind((ob.kind as ObligationKind) || "bill"); setEditOpen(true); }}
                className="h-7 w-7 p-0" title="Edit" data-testid={`button-edit-${ob.id}`}>
                <Pencil className="h-3 w-3" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowDeleteConfirm(true)}
                className="h-7 w-7 p-0 text-destructive" title="Delete" data-testid={`button-delete-${ob.id}`}>
                <Trash2 className="h-3 w-3" />
              </Button>
              <Button size="sm" variant="outline" onClick={() => payMutation.mutate()} disabled={payMutation.isPending}
                className="h-7 text-xs" data-testid={`button-pay-${ob.id}`}>
                Mark Paid
              </Button>
            </div>
          </div>

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

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{ob.name}"?</AlertDialogTitle>
            <AlertDialogDescription>This recurring obligation and its payment history will be permanently deleted. Future occurrences will stop generating.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { deleteMutation.mutate(); setShowDeleteConfirm(false); }}
              disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Edit "{ob.name}"</DialogTitle>
            <DialogDescription className="text-xs">Update obligation details</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs">Type</Label>
              <Select value={editKind} onValueChange={v => setEditKind(v as ObligationKind)}>
                <SelectTrigger data-testid="select-edit-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(OBLIGATION_KIND_META) as ObligationKind[]).map(k => (
                    <SelectItem key={k} value={k}>{OBLIGATION_KIND_META[k].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Amount ($)</Label>
                <Input type="number" inputMode="decimal" min="0" step="0.01" value={editAmount} onChange={e => setEditAmount(e.target.value)} data-testid="input-edit-amount" />
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

// Live panel: Overdue / Due today / Next 14 days.
function ObligationOccurrencePanel() {
  const today = new Date().toLocaleDateString("en-CA");
  const end = new Date(Date.now() + 14 * 86400000).toLocaleDateString("en-CA");
  const start = new Date(Date.now() - 60 * 86400000).toLocaleDateString("en-CA");
  const { data: occurrences = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/obligation-occurrences", start, end],
    queryFn: () => apiRequest("GET", `/api/obligation-occurrences?start=${start}&end=${end}`).then(r => r.json()),
    staleTime: 60_000,
  });

  const { overdue, todayOcc, upcoming } = useMemo(() => {
    const overdue: any[] = [], todayOcc: any[] = [], upcoming: any[] = [];
    for (const o of occurrences) {
      if (o.status === "done" || o.status === "skipped") continue;
      if (o.due_at < today) overdue.push(o);
      else if (o.due_at === today) todayOcc.push(o);
      else upcoming.push(o);
    }
    return { overdue, todayOcc, upcoming };
  }, [occurrences, today]);

  if (isLoading) {
    return <div className="h-24 rounded skeleton-shimmer" />;
  }
  if (overdue.length === 0 && todayOcc.length === 0 && upcoming.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {overdue.length > 0 && (
        <Card className="border-red-500/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500" /> Overdue
              <Badge variant="destructive" className="ml-auto">{overdue.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            {overdue.map(o => <OccurrenceRow key={o.id} occ={o} />)}
          </CardContent>
        </Card>
      )}
      {todayOcc.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <CalendarClock className="h-4 w-4" /> Due today
              <Badge className="ml-auto">{todayOcc.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            {todayOcc.map(o => <OccurrenceRow key={o.id} occ={o} />)}
          </CardContent>
        </Card>
      )}
      {upcoming.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Clock className="h-4 w-4" /> Next 14 days
              <Badge variant="secondary" className="ml-auto">{upcoming.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            {upcoming.slice(0, 8).map(o => <OccurrenceRow key={o.id} occ={o} />)}
            {upcoming.length > 8 && (
              <p className="text-xs text-muted-foreground text-center pt-1">+{upcoming.length - 8} more in the next 14 days</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export interface ObligationsManagerProps {
  /** Render the section header (title + New button). Set false when the host page provides its own. */
  showHeader?: boolean;
  /** Compact mode for tab embeds — drops summary cards. */
  compact?: boolean;
}

export default function ObligationsManager({ showHeader = true, compact = false }: ObligationsManagerProps) {
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [newFrequency, setNewFrequency] = useState("monthly");
  const [newCategory, setNewCategory] = useState("housing");
  const [newKind, setNewKind] = useState<ObligationKind>("bill");
  const [newDueDate, setNewDueDate] = useState("");
  const [filterMode, setFilterMode] = useState(() => getProfileFilter().mode);
  const [filterIds, setFilterIds] = useState<string[]>(() => getProfileFilter().selectedIds);
  const [kindFilter, setKindFilter] = useState<"all" | ObligationKind>("all");

  useEffect(() => {
    const handleFocus = () => {
      const { mode, selectedIds } = getProfileFilter();
      setFilterMode(mode);
      setFilterIds(selectedIds);
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, []);
  const profileParam = filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";

  const { data: allObligations = [], isLoading, error, refetch } = useQuery<Obligation[]>({
    queryKey: ["/api/obligations", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/obligations${profileParam}`).then(r => r.json()),
  });

  const obligations = useMemo(() => filterMode === "selected" && filterIds.length > 0
    ? allObligations.filter(o => o.linkedProfiles.some(id => filterIds.includes(id)))
    : allObligations, [allObligations, filterMode, filterIds]);

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/obligations", data),
    onSuccess: () => {
      invalidateAll();
      const savedName = newName;
      toast({ title: `"${savedName}" created`, description: `${OBLIGATION_KIND_META[newKind].label} · ${newFrequency} · $${newAmount}` });
      setAddOpen(false);
      setNewName(""); setNewAmount(""); setNewFrequency("monthly"); setNewCategory("housing"); setNewKind("bill"); setNewDueDate("");
    },
    onError: (err: Error) => toast({ title: "Failed to create", description: formatApiError(err), variant: "destructive" }),
  });

  const filteredByKind = useMemo(() => kindFilter === "all" ? obligations : obligations.filter(o => (o.kind || "bill") === kindFilter), [obligations, kindFilter]);
  const sorted = useMemo(() => [...filteredByKind].sort((a, b) => (a.name || "").localeCompare(b.name || "")), [filteredByKind]);

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

  // Per-kind counts for the chip row
  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = { all: obligations.length };
    for (const o of obligations) {
      const k = o.kind || "bill";
      counts[k] = (counts[k] || 0) + 1;
    }
    return counts;
  }, [obligations]);

  return (
    <div className="space-y-4" data-testid="obligations-manager">
      {showHeader && (
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Obligations</h2>
            <p className="text-xs text-muted-foreground">Recurring bills, subscriptions, payments, and reminders</p>
          </div>
          <Button size="sm" onClick={() => setAddOpen(true)} data-testid="button-add-obligation">
            <Plus className="w-4 h-4 mr-1" /> New
          </Button>
        </div>
      )}

      {/* Add Obligation Dialog */}
      <Dialog open={addOpen} onOpenChange={(v) => { if (!v) { setNewName(""); setNewAmount(""); setNewFrequency("monthly"); setNewCategory("housing"); setNewDueDate(""); setNewKind("bill"); } setAddOpen(v); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">New Obligation</DialogTitle>
            <DialogDescription className="text-xs">Add a recurring bill, subscription, payment, appointment, or reminder.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs">Type</Label>
              <Select value={newKind} onValueChange={v => setNewKind(v as ObligationKind)}>
                <SelectTrigger data-testid="select-obligation-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(OBLIGATION_KIND_META) as ObligationKind[]).map(k => (
                    <SelectItem key={k} value={k}>{OBLIGATION_KIND_META[k].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Name <span className="text-destructive">*</span></Label>
              <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Rent, Netflix, Dentist, Oil change" data-testid="input-obligation-name" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Amount ($) <span className="text-destructive">*</span></Label>
                <Input type="number" inputMode="decimal" min="0" step="0.01" value={newAmount} onChange={e => setNewAmount(e.target.value)} placeholder="0.00" data-testid="input-obligation-amount" />
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
                    <SelectItem value="once">One-time</SelectItem>
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
          {newDueDate && new Date(newDueDate + "T00:00:00") < new Date(new Date().toLocaleDateString("en-CA") + "T00:00:00") && (
            <div className="flex items-center gap-2 rounded-md bg-yellow-500/10 border border-yellow-500/30 px-3 py-2">
              <AlertTriangle className="h-3.5 w-3.5 text-yellow-600 shrink-0" />
              <p className="text-xs text-yellow-700 dark:text-yellow-400">The due date is in the past. You can still create this.</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button size="sm" disabled={!newName.trim() || !newAmount || parseFloat(newAmount) <= 0 || !newDueDate || createMutation.isPending}
              onClick={() => {
                if (!newDueDate) { toast({ title: "Please pick a due date", variant: "destructive" }); return; }
                createMutation.mutate({
                  name: newName.trim(), amount: parseFloat(newAmount), frequency: newFrequency,
                  category: newCategory, nextDueDate: newDueDate, autopay: false,
                  kind: newKind,
                  leadTimeDays: OBLIGATION_KIND_META[newKind].defaultLeadDays,
                  autoLogExpense: newKind === "subscription" || newKind === "bill",
                });
              }} data-testid="button-save-obligation">
              {createMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Live Overdue / Due today / Next 14 days */}
      <ObligationOccurrencePanel />

      {/* Summary cards (hidden in compact tab mode) */}
      {!compact && (
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
      )}

      {/* Kind filter chip row + inline New button when header is hidden */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" variant={kindFilter === "all" ? "default" : "outline"} className="h-7 text-xs"
          onClick={() => setKindFilter("all")} data-testid="kind-filter-all">
          All <span className="ml-1.5 opacity-60">{kindCounts.all || 0}</span>
        </Button>
        {(Object.keys(OBLIGATION_KIND_META) as ObligationKind[]).map(k => {
          const count = kindCounts[k] || 0;
          if (count === 0) return null;
          const meta = OBLIGATION_KIND_META[k];
          const Icon = KIND_ICON[k];
          return (
            <Button key={k} size="sm" variant={kindFilter === k ? "default" : "outline"} className="h-7 text-xs"
              style={kindFilter === k ? undefined : { borderColor: `${meta.color}55`, color: meta.color }}
              onClick={() => setKindFilter(k)} data-testid={`kind-filter-${k}`}>
              <Icon className="h-3 w-3 mr-1" /> {meta.label} <span className="ml-1.5 opacity-60">{count}</span>
            </Button>
          );
        })}
        {!showHeader && (
          <Button size="sm" onClick={() => setAddOpen(true)} className="ml-auto h-7" data-testid="button-add-obligation-inline">
            <Plus className="w-3.5 h-3.5 mr-1" /> New
          </Button>
        )}
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
          <h3 className="text-sm font-medium mb-1">
            {kindFilter === "all" ? "No obligations yet" : `No ${OBLIGATION_KIND_META[kindFilter].label.toLowerCase()} obligations`}
          </h3>
          <p className="text-xs text-muted-foreground mb-4">
            {kindFilter === "all"
              ? "Add bills, subscriptions, loan payments, medications, appointments, and more — they'll show up on your calendar automatically."
              : "Switch back to All to see other obligations, or add one of this type."}
          </p>
          <Button size="sm" onClick={() => setAddOpen(true)} data-testid="button-add-obligation-empty">
            <Plus className="w-4 h-4 mr-1" /> Add Obligation
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
