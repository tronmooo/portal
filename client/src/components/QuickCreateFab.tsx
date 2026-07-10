/**
 * QuickCreateFab — Wave 12
 *
 * Global floating action button rendered on every authenticated page.
 * Opens a popup with a grid of quick-create options:
 *   Asset · Subscription · Loan · Profile · Document
 *   Tracker · Doc · Sheet · Task · Bill
 *
 * Each option either:
 *   • opens an inline mini-dialog (Task, Bill, Tracker)
 *   • opens the existing CreateProfileDialog with category pre-filter
 *     (Asset, Subscription, Loan, Profile)
 *   • navigates to a creation route (Doc → /editor/new/doc, Sheet →
 *     /editor/new/sheet, Document → /dashboard/artifacts)
 *
 * The FAB is suppressed on /editor/* and on the chat page so it doesn't
 * collide with their own UI.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Plus, X,
  Wallet, CreditCard, Landmark, User, FileText,
  BarChart3, FileEdit, Sheet as SheetIcon, CheckSquare, Receipt,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CreateProfileDialog } from "@/components/CreateProfileDialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type CreateKind =
  | "asset" | "subscription" | "loan" | "profile" | "document"
  | "doc" | "sheet" | "task" | "bill";
// Note: "tracker" was removed 2026-05-21 — trackers can only be created via chat.

type Tile = {
  key: CreateKind;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Tailwind background class applied to the icon tile. */
  tone: string;
};

const TILES: Tile[] = [
  { key: "asset",        label: "Asset",        icon: Wallet,     tone: "bg-purple-500/15 text-purple-500" },
  { key: "subscription", label: "Subscription", icon: CreditCard, tone: "bg-pink-500/15 text-pink-500" },
  { key: "loan",         label: "Loan",         icon: Landmark,   tone: "bg-amber-500/15 text-amber-600" },
  { key: "profile",      label: "Profile",      icon: User,       tone: "bg-sky-500/15 text-sky-500" },
  { key: "document",     label: "Document",     icon: FileText,   tone: "bg-blue-500/15 text-blue-500" },
  // "Tracker" tile removed 2026-05-21 — trackers can only be created via chat.
  { key: "doc",          label: "Doc",          icon: FileEdit,   tone: "bg-indigo-500/15 text-indigo-500" },
  { key: "sheet",        label: "Sheet",        icon: SheetIcon,  tone: "bg-teal-500/15 text-teal-500" },
  { key: "task",         label: "Task",         icon: CheckSquare,tone: "bg-orange-500/15 text-orange-500" },
  { key: "bill",         label: "Bill",         icon: Receipt,    tone: "bg-rose-500/15 text-rose-500" },
];

// Routes where the FAB must stay hidden
function shouldHideOn(pathname: string): boolean {
  if (pathname.startsWith("/editor")) return true;
  if (pathname === "/" || pathname === "/chat") return true; // chat already uses bottom space
  if (pathname.startsWith("/share/")) return true;
  if (pathname === "/auth" || pathname === "/login" || pathname === "/signup") return true;
  if (pathname === "/reset-password") return true;
  if (pathname === "/terms" || pathname === "/privacy") return true;
  return false;
}

export function QuickCreateFab() {
  const [location, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  // Sub-dialog state: which kind is currently being created via a mini-form?
  const [profileDialog, setProfileDialog] = useState<null | {
    category?: string | string[];
    title?: string;
  }>(null);
  const [taskOpen, setTaskOpen] = useState(false);
  const [billOpen, setBillOpen] = useState(false);
  // Tracker quick-create removed 2026-05-21 — chat-only.


  // Hide on routes where it doesn't belong
  if (shouldHideOn(location)) return null;

  const handleTile = (kind: CreateKind) => {
    setOpen(false);
    switch (kind) {
      case "asset":
        setProfileDialog({ category: "assets", title: "Add asset" });
        return;
      case "subscription":
        setProfileDialog({ category: "subscriptions", title: "Add subscription" });
        return;
      case "loan":
        setProfileDialog({ category: "liabilities", title: "Add loan" });
        return;
      case "profile":
        setProfileDialog({ title: "Add profile" });
        return;
      case "document":
        // Documents are uploaded through the artifacts page (camera/upload buttons)
        navigate("/dashboard/artifacts");
        return;
      case "doc":
        navigate("/editor/new/doc");
        return;
      case "sheet":
        navigate("/editor/new/sheet");
        return;
      case "task":
        setTaskOpen(true);
        return;
      case "bill":
        setBillOpen(true);
        return;
    }
  };

  return (
    <>
      {/* Floating action button — sits above the mobile bottom nav. */}
      <button
        onClick={() => setOpen(true)}
        className="fixed right-4 z-40 flex items-center justify-center w-14 h-14 rounded-full shadow-xl active:scale-95 transition-transform"
        style={{
          bottom: "calc(var(--mobile-nav-height, 64px) + 16px)",
          background: "linear-gradient(135deg, hsl(155 60% 44%) 0%, hsl(168 60% 40%) 100%)",
          color: "white",
          boxShadow: "0 8px 24px hsl(155 60% 30% / 0.35), 0 2px 6px hsl(155 60% 30% / 0.25)",
        }}
        data-testid="quick-create-fab"
        aria-label="Quick create"
      >
        <Plus className="w-6 h-6" />
      </button>

      {/* Picker dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md p-0 overflow-hidden">
          <div className="flex items-center justify-between px-4 pt-4 pb-2 border-b border-border/50">
            <DialogTitle className="text-base font-semibold">Quick create</DialogTitle>
            <button
              onClick={() => setOpen(false)}
              className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted transition-colors"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 p-3">
            {TILES.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.key}
                  onClick={() => handleTile(t.key)}
                  className="flex flex-col items-center gap-2 p-3 rounded-xl border border-border/50 bg-card hover:bg-muted/50 active:scale-95 transition-all"
                  data-testid={`quick-create-${t.key}`}
                >
                  <div className={`w-10 h-10 flex items-center justify-center rounded-lg ${t.tone}`}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <span className="text-xs font-medium">{t.label}</span>
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      {/* CreateProfileDialog — handles Asset / Subscription / Loan / Profile */}
      {profileDialog && (
        <CreateProfileDialog
          open={!!profileDialog}
          onClose={() => setProfileDialog(null)}
          initialCategoryFilter={profileDialog.category}
          titleOverride={profileDialog.title}
        />
      )}

      <QuickTaskDialog open={taskOpen} onClose={() => setTaskOpen(false)} />
      <QuickBillDialog open={billOpen} onClose={() => setBillOpen(false)} />
      {/* QuickTrackerDialog removed 2026-05-21 — tracker creation is chat-only. */}
    </>
  );
}

// ─── Mini Task dialog ─────────────────────────────────────────
function QuickTaskDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<"low" | "medium" | "high">("medium");
  const [dueDate, setDueDate] = useState("");

  useEffect(() => { if (!open) { setTitle(""); setPriority("medium"); setDueDate(""); } }, [open]);

  const m = useMutation<any, Error, { title: string; priority: string; dueDate?: string }, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: async (payload) => {
      const res = await apiRequest("POST", "/api/tasks", payload);
      return res.json();
    },
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ["/api/tasks"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/tasks"] });
      const temp = {
        id: `temp-${Date.now()}`,
        title: vars.title,
        priority: vars.priority,
        dueDate: vars.dueDate,
        completed: false,
        _optimistic: true,
      };
      queryClient.setQueriesData({ queryKey: ["/api/tasks"] }, (old: any) => {
        if (Array.isArray(old)) return [temp, ...old];
        return old;
      });
      return { prev };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Task created" });
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: "Could not create task", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle>Add task</DialogTitle>
        <div className="space-y-3">
          <div>
            <Label htmlFor="qt-title">Title</Label>
            <Input id="qt-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs to be done?" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Priority</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="qt-due">Due date</Label>
              <Input id="qt-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={() => {
              const payload: any = { title: title.trim(), priority };
              if (dueDate) payload.dueDate = dueDate;
              m.mutate(payload);
              onClose();
            }} disabled={!title.trim()}>Create</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Mini Bill dialog (creates an Obligation) ─────────────────
function QuickBillDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [nextDueDate, setNextDueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [frequency, setFrequency] = useState<"monthly" | "weekly" | "biweekly" | "quarterly" | "yearly" | "once">("monthly");
  const [category, setCategory] = useState("general");

  useEffect(() => {
    if (!open) {
      setName(""); setAmount(""); setNextDueDate(new Date().toISOString().slice(0, 10));
      setFrequency("monthly"); setCategory("general");
    }
  }, [open]);

  const m = useMutation<any, Error, { name: string; amount: number; frequency: string; category: string; nextDueDate: string }, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: async (vars) => {
      const res = await apiRequest("POST", "/api/obligations", { ...vars, autopay: false });
      return res.json();
    },
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ["/api/obligations"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/obligations"] });
      const temp = { id: `temp-${Date.now()}`, ...vars, autopay: false, _optimistic: true };
      queryClient.setQueriesData({ queryKey: ["/api/obligations"] }, (old: any) => {
        if (Array.isArray(old)) return [temp, ...old];
        return old;
      });
      return { prev };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar"] });
      toast({ title: "Bill added" });
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: "Could not add bill", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle>Add bill</DialogTitle>
        <div className="space-y-3">
          <div>
            <Label htmlFor="qb-name">Name</Label>
            <Input id="qb-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rent, Internet, Gym" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="qb-amount">Amount</Label>
              <Input id="qb-amount" type="number" inputMode="decimal" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            </div>
            <div>
              <Label htmlFor="qb-due">Next due</Label>
              <Input id="qb-due" type="date" value={nextDueDate} onChange={(e) => setNextDueDate(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Frequency</Label>
              <Select value={frequency} onValueChange={(v) => setFrequency(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="biweekly">Bi-weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="quarterly">Quarterly</SelectItem>
                  <SelectItem value="yearly">Yearly</SelectItem>
                  <SelectItem value="once">One-time</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Category</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="general">General</SelectItem>
                  <SelectItem value="rent">Rent / Mortgage</SelectItem>
                  <SelectItem value="utilities">Utilities</SelectItem>
                  <SelectItem value="insurance">Insurance</SelectItem>
                  <SelectItem value="subscription">Subscription</SelectItem>
                  <SelectItem value="loan">Loan</SelectItem>
                  <SelectItem value="phone">Phone / Internet</SelectItem>
                  <SelectItem value="medical">Medical</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={() => {
              const amt = parseFloat(amount);
              if (!name.trim() || !Number.isFinite(amt) || amt <= 0) {
                toast({ title: "Invalid input", description: "Name and positive amount required", variant: "destructive" });
                return;
              }
              m.mutate({ name: name.trim(), amount: amt, frequency, category, nextDueDate });
              onClose();
            }} disabled={!name.trim() || !amount.trim()}>
              Create
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Mini Tracker dialog ──────────────────────────────────────
function QuickTrackerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const [category, setCategory] = useState("custom");

  useEffect(() => { if (!open) { setName(""); setUnit(""); setCategory("custom"); } }, [open]);

  const m = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error("Name required");
      const res = await apiRequest("POST", "/api/trackers", {
        name: name.trim(),
        category,
        unit: unit.trim() || undefined,
        fields: [
          { name: "value", type: "number", unit: unit.trim() || undefined, isPrimary: true },
        ],
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      toast({ title: "Tracker created" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Could not create tracker", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle>Add tracker</DialogTitle>
        <div className="space-y-3">
          <div>
            <Label htmlFor="qtr-name">Name</Label>
            <Input id="qtr-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Weight, Steps, Mood" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="qtr-unit">Unit (optional)</Label>
              <Input id="qtr-unit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="lbs, miles, hrs…" />
            </div>
            <div>
              <Label>Category</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="custom">Custom</SelectItem>
                  <SelectItem value="health">Health</SelectItem>
                  <SelectItem value="fitness">Fitness</SelectItem>
                  <SelectItem value="finance">Finance</SelectItem>
                  <SelectItem value="productivity">Productivity</SelectItem>
                  <SelectItem value="mood">Mood</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={() => m.mutate()} disabled={!name.trim() || m.isPending}>
              {m.isPending ? "Saving…" : "Create"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
