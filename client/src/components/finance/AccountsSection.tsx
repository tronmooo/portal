// ── Accounts (Finance tab) ───────────────────────────────────────────────────
//
// Where the user's money actually sits: checking, savings, cash, credit cards,
// brokerage, loan accounts, lines of credit. Manually maintained — this is the
// counterpart to the connected-bank card above it, for the accounts a user
// tracks by hand.
//
// One source of truth: an account is a `type: "account"` PROFILE, so the
// balances shown here are the same rows that feed Net Worth, the balance sheet,
// cash flow and the AI's answers. Nothing on this screen is computed a second
// way — the summary comes from `summarizeAccounts` and each row from
// `toAccountView`, the same helpers the server and the chat tools use.

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { invalidateDomains } from "@/lib/cache-bus";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeading } from "@/components/ui/section-heading";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Wallet, Plus, Pencil, Trash2, CreditCard, Landmark, PiggyBank, Banknote,
  TrendingUp, CircleDollarSign, History, ChevronDown, ChevronRight,
} from "lucide-react";
import { formatMoney, formatListDate } from "@/lib/format";
import {
  ACCOUNT_KINDS, accountViews, summarizeAccounts,
  type AccountKind, type AccountView,
} from "@shared/finance-accounts";

const KIND_ICONS: Record<string, any> = {
  checking: Wallet,
  savings: PiggyBank,
  cash: Banknote,
  investment: TrendingUp,
  credit_card: CreditCard,
  line_of_credit: CreditCard,
  loan: Landmark,
  other: CircleDollarSign,
};

const GROUP_ORDER = ["cash", "investment", "credit", "loan", "other"] as const;
const GROUP_LABELS: Record<string, string> = {
  cash: "Cash", investment: "Investments", credit: "Credit", loan: "Loans", other: "Other",
};

interface AccountForm {
  name: string;
  accountKind: AccountKind;
  institution: string;
  balance: string;
  availableBalance: string;
  creditLimit: string;
  accountNumberLast4: string;
  balanceAsOf: string;
  ownerProfileId: string;
}

const emptyForm = (): AccountForm => ({
  name: "", accountKind: "checking", institution: "", balance: "",
  availableBalance: "", creditLimit: "", accountNumberLast4: "",
  balanceAsOf: new Date().toLocaleDateString("en-CA"), ownerProfileId: "",
});

const num = (s: string): number | undefined => {
  const t = s.trim();
  if (!t) return undefined;
  const n = Number(t.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : undefined;
};

export function AccountsSection({ profiles }: { profiles: any[] }) {
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<AccountView | null>(null);
  const [deleting, setDeleting] = useState<AccountView | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [form, setForm] = useState<AccountForm>(emptyForm());

  // Accounts come from the profile list the Finance page already loaded, so
  // this section never disagrees with Net Worth about what exists. The
  // dedicated endpoint stays available for the AI and for other clients.
  const accounts = useMemo(() => accountViews(profiles || []), [profiles]);
  const summary = useMemo(() => summarizeAccounts(profiles || []), [profiles]);

  const people = useMemo(
    () => (profiles || []).filter((p: any) => p.type === "self" || p.type === "person"),
    [profiles],
  );

  const refresh = () => invalidateDomains("profiles", "assets", "liabilities", "dashboard");

  const createMut = useMutation({
    mutationFn: async (f: AccountForm) => (await apiRequest("POST", "/api/accounts", {
      name: f.name.trim(),
      accountKind: f.accountKind,
      institution: f.institution.trim() || undefined,
      balance: num(f.balance) ?? 0,
      availableBalance: num(f.availableBalance),
      creditLimit: num(f.creditLimit),
      accountNumberLast4: f.accountNumberLast4.trim() || undefined,
      balanceAsOf: f.balanceAsOf || undefined,
      ownerProfileId: f.ownerProfileId || undefined,
    })).json(),
    onSuccess: async () => {
      await refresh();
      setAddOpen(false);
      setForm(emptyForm());
      toast({ title: "Account added" });
    },
    onError: (e: any) => toast({ title: "Couldn't add the account", description: e?.message, variant: "destructive" }),
  });

  const updateMut = useMutation({
    mutationFn: async ({ id, changes }: { id: string; changes: Record<string, any> }) =>
      (await apiRequest("PATCH", `/api/accounts/${id}`, changes)).json(),
    onSuccess: async () => {
      await refresh();
      setEditing(null);
      toast({ title: "Account updated" });
    },
    onError: (e: any) => toast({ title: "Couldn't update the account", description: e?.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => (await apiRequest("DELETE", `/api/accounts/${id}`)).json(),
    onSuccess: async () => {
      await refresh();
      setDeleting(null);
      toast({ title: "Account removed" });
    },
    onError: (e: any) => toast({ title: "Couldn't remove the account", description: e?.message, variant: "destructive" }),
  });

  const grouped = useMemo(() => {
    const out = new Map<string, AccountView[]>();
    for (const a of accounts) {
      const list = out.get(a.group) ?? [];
      list.push(a);
      out.set(a.group, list);
    }
    return out;
  }, [accounts]);

  const AddDialog = (
    <Dialog open={addOpen} onOpenChange={(o) => { setAddOpen(o); if (o) setForm(emptyForm()); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 text-xs" data-testid="btn-add-account">
          <Plus className="w-3.5 h-3.5 mr-1" />Add account
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Add a financial account</DialogTitle></DialogHeader>
        <AccountFields form={form} setForm={setForm} people={people} />
        <Button
          className="w-full"
          disabled={!form.name.trim() || createMut.isPending}
          onClick={() => createMut.mutate(form)}
          data-testid="btn-save-account"
        >
          {createMut.isPending ? "Adding…" : "Add account"}
        </Button>
      </DialogContent>
    </Dialog>
  );

  return (
    <Card className="p-4" data-testid="accounts-section">
      <div className="flex items-start justify-between gap-2 mb-3">
        <SectionHeading
          title="Accounts"
          icon={Wallet}
          accent="213 90% 62%"
          count={accounts.length}
          meta={accounts.length > 0 ? formatMoney(summary.net) : undefined}
        />
        {AddDialog}
      </div>

      {accounts.length === 0 ? (
        <EmptyState
          icon={Wallet}
          label="No accounts yet"
          hint="Add your checking, savings, cash, cards and investments so balances, cash flow and net worth all come from the same place."
          ctaLabel="Add account"
          onCta={() => setAddOpen(true)}
          testId="accounts-empty"
        />
      ) : (
        <>
          {/* Rollup: the numbers the rest of Finance is built on. */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
            <Stat label="Cash on hand" value={summary.cash} testId="acct-total-cash" />
            <Stat label="Investments" value={summary.investments} testId="acct-total-investments" />
            <Stat label="Card + credit debt" value={summary.creditDebt} tone="neg" testId="acct-total-credit" />
            <Stat
              label={summary.availableCredit != null ? "Available credit" : "Loan balances"}
              value={summary.availableCredit ?? summary.loanDebt}
              tone={summary.availableCredit != null ? "pos" : "neg"}
              testId="acct-total-secondary"
            />
          </div>

          <div className="space-y-3">
            {GROUP_ORDER.filter((g) => grouped.has(g)).map((group) => (
              <div key={group}>
                <p className="micro-label text-muted-foreground mb-1.5">{GROUP_LABELS[group]}</p>
                <div className="rounded-xl border divide-y divide-border/50 overflow-hidden">
                  {(grouped.get(group) || []).map((a) => (
                    <AccountRow
                      key={a.id}
                      account={a}
                      expanded={expanded === a.id}
                      onToggle={() => setExpanded(expanded === a.id ? null : a.id)}
                      onEdit={() => setEditing(a)}
                      onDelete={() => setDeleting(a)}
                      onAdjust={(delta, reason) =>
                        apiRequest("POST", `/api/accounts/${a.id}/adjust`, { delta, reason }).then(refresh)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Edit */}
      <Dialog open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Edit {editing?.name}</DialogTitle></DialogHeader>
          {editing && (
            <EditAccountBody
              account={editing}
              people={people}
              busy={updateMut.isPending}
              onSave={(changes) => updateMut.mutate({ id: editing.id, changes })}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete */}
      <AlertDialog open={!!deleting} onOpenChange={(o) => { if (!o) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove "{deleting?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              The account and its balance history are deleted. Expenses and bills linked to it are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => deleting && deleteMut.mutate(deleting.id)}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function Stat({ label, value, tone, testId }: {
  label: string; value: number; tone?: "pos" | "neg"; testId?: string;
}) {
  const color = tone === "neg" ? "text-red-500" : tone === "pos" ? "text-emerald-500" : "";
  return (
    <div className="bubble-row px-3 py-2" data-testid={testId}>
      <p className="micro-label text-muted-foreground">{label}</p>
      <p className={`metric-value text-[17px] leading-tight mt-0.5 tabular-nums ${color}`}>{formatMoney(value)}</p>
    </div>
  );
}

function AccountRow({ account, expanded, onToggle, onEdit, onDelete, onAdjust }: {
  account: AccountView;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAdjust: (delta: number, reason: string) => Promise<any>;
}) {
  const Icon = KIND_ICONS[account.kind] ?? CircleDollarSign;
  const [adjust, setAdjust] = useState("");
  const [busy, setBusy] = useState(false);

  const applyAdjust = async (sign: 1 | -1) => {
    const n = Number(adjust.replace(/[$,]/g, ""));
    if (!Number.isFinite(n) || n === 0) return;
    setBusy(true);
    try {
      await onAdjust(sign * Math.abs(n), sign > 0 ? "Manual increase" : "Manual decrease");
      setAdjust("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid={`account-${account.id}`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/40"
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
        <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold truncate">{account.name}</span>
            {account.excluded && <Badge variant="outline" className="h-4 text-[11px]">Excluded</Badge>}
          </div>
          <span className="text-[12px] text-muted-foreground">
            {account.kindLabel}
            {account.institution ? ` · ${account.institution}` : ""}
            {account.lastFour ? ` · ••${account.lastFour}` : ""}
          </span>
        </div>
        <div className="text-right shrink-0">
          <p className={`text-[15px] font-bold tabular-nums ${account.isDebt ? "text-red-500" : ""}`}>
            {account.isDebt ? "−" : ""}{formatMoney(account.balance)}
          </p>
          {account.balanceAsOf && (
            <p className="text-[11px] text-muted-foreground">as of {formatListDate(account.balanceAsOf)}</p>
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 space-y-3 bg-muted/20">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {account.availableBalance != null && (
              <Fact label={account.isDebt ? "Available credit" : "Available"} value={formatMoney(account.availableBalance)} />
            )}
            {account.creditLimit != null && <Fact label="Credit limit" value={formatMoney(account.creditLimit)} />}
            {account.utilization != null && (
              <Fact label="Utilization" value={`${account.utilization.toFixed(0)}%`} />
            )}
            <Fact label="Currency" value={account.currency.toUpperCase()} />
          </div>

          {/* Manual balance adjustment — the reason this is here rather than in
              an edit form is that a balance CHANGE is an event with history,
              not a field you silently overwrite. */}
          <div className="flex items-center gap-1.5">
            <Input
              type="number" step="0.01" inputMode="decimal"
              value={adjust} onChange={(e) => setAdjust(e.target.value)}
              placeholder="Adjust by…" className="h-8 text-xs"
              data-testid={`acct-adjust-input-${account.id}`}
            />
            <Button size="sm" variant="outline" className="h-8 px-2 text-xs" disabled={busy || !adjust}
              onClick={() => void applyAdjust(1)} data-testid={`acct-adjust-up-${account.id}`}>+ Add</Button>
            <Button size="sm" variant="outline" className="h-8 px-2 text-xs" disabled={busy || !adjust}
              onClick={() => void applyAdjust(-1)} data-testid={`acct-adjust-down-${account.id}`}>− Subtract</Button>
          </div>

          {account.adjustments.length > 0 && (
            <div>
              <p className="micro-label text-muted-foreground mb-1 flex items-center gap-1">
                <History className="w-3 h-3" />Balance history
              </p>
              <div className="space-y-0.5">
                {account.adjustments.slice(-5).reverse().map((adj) => (
                  <div key={adj.id} className="flex items-center justify-between text-[12px]">
                    <span className="text-muted-foreground truncate">
                      {formatListDate(adj.date)}{adj.reason ? ` · ${adj.reason}` : ""}
                    </span>
                    <span className={`tabular-nums shrink-0 ml-2 ${adj.delta < 0 ? "text-red-500" : "text-emerald-600"}`}>
                      {adj.delta >= 0 ? "+" : "−"}{formatMoney(Math.abs(adj.delta))} → {formatMoney(adj.newBalance)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onEdit}
              data-testid={`acct-edit-${account.id}`}><Pencil className="w-3 h-3 mr-1" />Edit</Button>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-red-500 hover:text-red-500"
              onClick={onDelete} data-testid={`acct-delete-${account.id}`}>
              <Trash2 className="w-3 h-3 mr-1" />Remove
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bubble-row px-2.5 py-1.5">
      <p className="micro-label text-muted-foreground">{label}</p>
      <p className="text-[14px] font-semibold tabular-nums mt-0.5">{value}</p>
    </div>
  );
}

/** The create form. Fields that don't apply to the chosen kind aren't rendered. */
function AccountFields({ form, setForm, people }: {
  form: AccountForm;
  setForm: (f: AccountForm) => void;
  people: any[];
}) {
  const meta = ACCOUNT_KINDS.find((k) => k.key === form.accountKind) ?? ACCOUNT_KINDS[0];
  const set = (patch: Partial<AccountForm>) => setForm({ ...form, ...patch });

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-xs">Account name</Label>
        <Input value={form.name} onChange={(e) => set({ name: e.target.value })}
          placeholder="Chase Checking" data-testid="input-account-name" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Type</Label>
          <Select value={form.accountKind} onValueChange={(v) => set({ accountKind: v as AccountKind })}>
            <SelectTrigger data-testid="select-account-kind"><SelectValue /></SelectTrigger>
            <SelectContent>
              {ACCOUNT_KINDS.map((k) => <SelectItem key={k.key} value={k.key}>{k.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Institution</Label>
          <Input value={form.institution} onChange={(e) => set({ institution: e.target.value })}
            placeholder="Chase" data-testid="input-account-institution" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">{meta.side === "debt" ? "Balance owed" : "Current balance"}</Label>
          <Input type="number" step="0.01" value={form.balance}
            onChange={(e) => set({ balance: e.target.value })}
            placeholder="0.00" data-testid="input-account-balance" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">As of</Label>
          <Input type="date" value={form.balanceAsOf} onChange={(e) => set({ balanceAsOf: e.target.value })} />
        </div>
      </div>
      {meta.supportsAvailable && (
        <div className="space-y-1">
          <Label className="text-xs">
            {meta.supportsCreditLimit ? "Available credit (optional — derived from the limit)" : "Available balance (optional)"}
          </Label>
          <Input type="number" step="0.01" value={form.availableBalance}
            onChange={(e) => set({ availableBalance: e.target.value })} placeholder="0.00" />
        </div>
      )}
      {meta.supportsCreditLimit && (
        <div className="space-y-1">
          <Label className="text-xs">Credit limit</Label>
          <Input type="number" step="0.01" value={form.creditLimit}
            onChange={(e) => set({ creditLimit: e.target.value })}
            placeholder="0.00" data-testid="input-account-limit" />
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Last 4 digits</Label>
          <Input value={form.accountNumberLast4} maxLength={4}
            onChange={(e) => set({ accountNumberLast4: e.target.value.replace(/\D/g, "").slice(0, 4) })}
            placeholder="1234" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Owner</Label>
          <Select value={form.ownerProfileId || "__self"} onValueChange={(v) => set({ ownerProfileId: v === "__self" ? "" : v })}>
            <SelectTrigger data-testid="select-account-owner"><SelectValue placeholder="Me" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__self">Me</SelectItem>
              {people.filter((p) => p.type !== "self").map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

function EditAccountBody({ account, people, busy, onSave }: {
  account: AccountView;
  people: any[];
  busy: boolean;
  onSave: (changes: Record<string, any>) => void;
}) {
  const [form, setForm] = useState<AccountForm>({
    name: account.name,
    accountKind: account.kind,
    institution: account.institution ?? "",
    balance: String(account.balance ?? ""),
    availableBalance: account.availableBalance != null ? String(account.availableBalance) : "",
    creditLimit: account.creditLimit != null ? String(account.creditLimit) : "",
    accountNumberLast4: account.lastFour ?? "",
    balanceAsOf: account.balanceAsOf ?? new Date().toLocaleDateString("en-CA"),
    ownerProfileId: account.ownerProfileId ?? "",
  });

  return (
    <div className="space-y-3">
      <AccountFields form={form} setForm={setForm} people={people} />
      <Button
        className="w-full"
        disabled={busy || !form.name.trim()}
        onClick={() => onSave({
          name: form.name.trim(),
          accountKind: form.accountKind,
          institution: form.institution.trim() || null,
          // The balance is only sent when it actually changed, so a cosmetic
          // rename doesn't write a no-op $0 adjustment into the history.
          ...(num(form.balance) !== account.balance ? { balance: num(form.balance) ?? 0, balanceAsOf: form.balanceAsOf } : {}),
          availableBalance: num(form.availableBalance) ?? null,
          creditLimit: num(form.creditLimit) ?? null,
          accountNumberLast4: form.accountNumberLast4 || null,
          ownerProfileId: form.ownerProfileId || null,
        })}
        data-testid="btn-update-account"
      >
        {busy ? "Saving…" : "Save changes"}
      </Button>
    </div>
  );
}
