// Unified "add data from the dashboard" dialog. One component, switched on
// `kind`, so every dashboard pop-up's Add button opens an in-place saving form
// instead of redirecting to another page. Generalizes the AddHoldingDialog
// pattern (apiRequest POST → toast → broad invalidate → close) and routes the
// body through the pure builders in shared/quick-add.ts.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Receipt, ArrowDownToLine, CreditCard, StickyNote, Bell } from "lucide-react";
import {
  buildExpensePayload, buildIncomePayload, buildBillPayload, buildNotePayload, buildReminderPayload,
  type BuildResult,
} from "@shared/quick-add";

export type QuickAddKind = "expense" | "income" | "bill" | "note" | "reminder";

const EXPENSE_CATEGORIES = ["entertainment", "food", "general", "health", "housing", "insurance", "pet", "shopping", "subscription", "transport", "travel", "utilities", "vehicle"];
const INCOME_CATEGORIES = ["bonus", "business", "dividends", "gift", "interest", "rental", "salary", "other"];
const BILL_CATEGORIES = ["bill", "insurance", "loan", "rent", "subscription", "utilities"];
const FREQUENCIES = ["daily", "weekly", "biweekly", "monthly", "quarterly", "yearly"];

const CONFIG: Record<QuickAddKind, {
  title: string; description: string; icon: any; endpoint: string;
  build: (input: any, owner?: string) => BuildResult; successNoun: string;
}> = {
  expense: { title: "Add expense", description: "A one-time spend.", icon: Receipt, endpoint: "/api/expenses", build: buildExpensePayload, successNoun: "Expense" },
  income: { title: "Add income", description: "A pay or income stream.", icon: ArrowDownToLine, endpoint: "/api/incomes", build: buildIncomePayload, successNoun: "Income" },
  bill: { title: "Add bill", description: "A recurring obligation.", icon: CreditCard, endpoint: "/api/obligations", build: buildBillPayload, successNoun: "Bill" },
  note: { title: "Add note", description: "A quick journal note.", icon: StickyNote, endpoint: "/api/journal", build: buildNotePayload, successNoun: "Note" },
  reminder: { title: "Add reminder", description: "We'll surface it when it's due.", icon: Bell, endpoint: "/api/reminders", build: buildReminderPayload, successNoun: "Reminder" },
};

function sortProfilesForSelect(a: { type?: string; name?: string }, b: { type?: string; name?: string }) {
  if (a.type === "self" && b.type !== "self") return -1;
  if (b.type === "self" && a.type !== "self") return 1;
  return (a.name || "").localeCompare(b.name || "");
}

export function QuickAddDialog({
  open, kind, onClose, ownerProfileId = "",
}: {
  open: boolean;
  kind: QuickAddKind;
  onClose: () => void;
  ownerProfileId?: string;
}) {
  const cfg = CONFIG[kind];
  const { toast } = useToast();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: BROWSER_TIMEZONE });

  // PERF (QA scorecard): don't do non-critical work (profile list fetch /
  // option building) in the same frame that opens the dialog — it delayed the
  // first paint of the dialog shell. Defer it until the browser is idle
  // (requestIdleCallback, setTimeout fallback) after the shell has painted.
  const [deferredReady, setDeferredReady] = useState(false);
  useEffect(() => {
    if (!open) { setDeferredReady(false); return; }
    const ric: (cb: () => void) => any =
      typeof (window as any).requestIdleCallback === "function"
        ? (cb) => (window as any).requestIdleCallback(cb, { timeout: 500 })
        : (cb) => setTimeout(cb, 50);
    const cancel: (id: any) => void =
      typeof (window as any).cancelIdleCallback === "function"
        ? (id) => (window as any).cancelIdleCallback(id)
        : (id) => clearTimeout(id);
    const id = ric(() => setDeferredReady(true));
    return () => cancel(id);
  }, [open]);

  // Shared field state (only the relevant ones are rendered per kind).
  const [text1, setText1] = useState("");        // description / name / content / title
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState(kind === "income" ? "salary" : kind === "bill" ? "bill" : "general");
  const [frequency, setFrequency] = useState("monthly");
  const [vendor, setVendor] = useState("");
  const [date, setDate] = useState(today);
  const [autopay, setAutopay] = useState(false);
  const [profileId, setProfileId] = useState(ownerProfileId);
  const [attempted, setAttempted] = useState(false);

  const showProfile = kind === "expense" || kind === "income" || kind === "bill";
  const { data: profiles = [] } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    // Deferred until after first paint (see above) — the Profile select simply
    // pops in a moment later; the rest of the form is usable immediately.
    enabled: open && showProfile && deferredReady,
  });
  const profileOptions = useMemo(
    () => (profiles || []).filter((p: any) => ["self", "person", "pet", "business"].includes(p.type)).sort(sortProfilesForSelect),
    [profiles],
  );

  const owner = profileId || ownerProfileId || undefined;
  const result: BuildResult = useMemo(() => {
    switch (kind) {
      case "expense": return cfg.build({ description: text1, amount, category, vendor, date }, owner);
      case "income": return cfg.build({ description: text1, amount, category, frequency, date }, owner);
      case "bill": return cfg.build({ name: text1, amount, frequency, category, nextDueDate: date, autopay }, owner);
      case "note": return cfg.build({ content: text1, date }, owner);
      case "reminder": return cfg.build({ title: text1, fireAt: date }, owner);
    }
  }, [kind, text1, amount, category, vendor, date, frequency, autopay, owner, cfg]);

  const mut = useMutation({
    mutationFn: async () => {
      if (!result.ok) throw new Error(result.error);
      const res = await apiRequest("POST", cfg.endpoint, result.body);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: `${cfg.successNoun} added`, description: text1.trim().slice(0, 60) });
      // Everything finance/dashboard is derived — refresh every /api surface
      // via the cache bus's nuclear domain (same predicate, one shot).
      invalidateDomain("everything");
      onClose();
    },
    onError: (e: any) => toast({ title: "Couldn't save", description: e?.message || "Try again", variant: "destructive" }),
  });

  const submit = () => {
    setAttempted(true);
    if (result.ok && !mut.isPending) mut.mutate();
  };
  const onKey = (e: React.KeyboardEvent) => { if (e.key === "Enter" && kind !== "note") submit(); };
  const Icon = cfg.icon;
  const text1Label = kind === "bill" ? "Name" : kind === "reminder" ? "Title" : kind === "note" ? "Note" : "Description";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm" data-testid={`dialog-quick-add-${kind}`}>
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2"><Icon className="h-4 w-4" /> {cfg.title}</DialogTitle>
          <DialogDescription className="text-xs">{cfg.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">{text1Label} <span className="text-destructive">*</span></Label>
            {kind === "note" ? (
              <Textarea value={text1} autoFocus rows={4} placeholder="What's on your mind?"
                onChange={(e) => setText1(e.target.value)} data-testid={`input-quick-add-${kind}-text`} />
            ) : (
              <Input value={text1} autoFocus onKeyDown={onKey}
                placeholder={kind === "bill" ? "e.g. Rent" : kind === "reminder" ? "e.g. Pay water bill" : "What was it for?"}
                onChange={(e) => setText1(e.target.value)}
                aria-invalid={attempted && !text1.trim() ? true : undefined}
                className={attempted && !text1.trim() ? "border-destructive focus-visible:ring-destructive" : ""}
                data-testid={`input-quick-add-${kind}-text`} />
            )}
          </div>

          {(kind === "expense" || kind === "income" || kind === "bill") && (
            <div className="space-y-1">
              <Label className="text-xs">Amount ($) <span className="text-destructive">*</span></Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">$</span>
                <Input type="text" inputMode="decimal" className="pl-7" value={amount} placeholder="0.00" onKeyDown={onKey}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-invalid={attempted && !result.ok ? true : undefined}
                  data-testid={`input-quick-add-${kind}-amount`} />
              </div>
            </div>
          )}

          {(kind === "income" || kind === "bill") && (
            <div className="space-y-1">
              <Label className="text-xs">Frequency</Label>
              <Select value={frequency} onValueChange={setFrequency}>
                <SelectTrigger className="h-9 text-sm" data-testid={`select-quick-add-${kind}-frequency`}><SelectValue /></SelectTrigger>
                <SelectContent>{FREQUENCIES.map((f) => <SelectItem key={f} value={f} className="capitalize">{f}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}

          {(kind === "expense" || kind === "income" || kind === "bill") && (
            <div className="space-y-1">
              <Label className="text-xs">Category</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="h-9 text-sm" data-testid={`select-quick-add-${kind}-category`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(kind === "income" ? INCOME_CATEGORIES : kind === "bill" ? BILL_CATEGORIES : EXPENSE_CATEGORIES)
                    .map((c) => <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          {kind === "expense" && (
            <div className="space-y-1">
              <Label className="text-xs">Vendor <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input value={vendor} placeholder="e.g. Whole Foods" onChange={(e) => setVendor(e.target.value)} onKeyDown={onKey} data-testid="input-quick-add-expense-vendor" />
            </div>
          )}

          {kind !== "note" && (
            <div className="space-y-1">
              <Label className="text-xs">{kind === "bill" ? "Next due" : kind === "reminder" ? "When" : "Date"}</Label>
              <Input type={kind === "reminder" ? "datetime-local" : "date"} value={date} onChange={(e) => setDate(e.target.value)} data-testid={`input-quick-add-${kind}-date`} />
            </div>
          )}

          {kind === "bill" && (
            <div className="flex items-center justify-between">
              <Label className="text-xs">Autopay</Label>
              <Switch checked={autopay} onCheckedChange={setAutopay} data-testid="switch-quick-add-bill-autopay" />
            </div>
          )}

          {showProfile && profileOptions.length > 0 && (
            <div className="space-y-1">
              <Label className="text-xs">Profile</Label>
              <Select value={owner || ""} onValueChange={setProfileId}>
                <SelectTrigger className="h-9 text-sm" data-testid={`select-quick-add-${kind}-profile`}><SelectValue placeholder="Profile" /></SelectTrigger>
                <SelectContent>
                  {profileOptions.map((p: any) => <SelectItem key={p.id} value={p.id}>{p.type === "self" ? "Me" : p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          {attempted && !result.ok && (
            <p className="text-xs text-destructive" data-testid={`error-quick-add-${kind}`}>{result.error}</p>
          )}

          <div className="flex gap-2 justify-end pt-1">
            <Button variant="outline" size="sm" onClick={onClose} disabled={mut.isPending}>Cancel</Button>
            <Button size="sm" disabled={mut.isPending} onClick={submit} data-testid={`btn-quick-add-${kind}-save`}>
              {mut.isPending ? <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Saving…</> : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
