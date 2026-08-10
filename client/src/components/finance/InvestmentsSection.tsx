// ── Finance tab · Investments ────────────────────────────────────────────────
// Investment accounts (Roth IRA, 401k, brokerage, crypto wallet…) with their
// stock / ETF / crypto holdings — the same records the chat's
// add/update/remove_investment_holding tools write. Holdings live in the
// account profile's fields.holdings (shared/investments); every edit here
// recomputes the account's currentValue/totalInvested through the SAME
// helpers the server uses, so net worth and the chat's summaries always agree.
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { invalidateDomains } from "@/lib/cache-bus";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { formatMoney } from "@/lib/format";
import { Plus, TrendingUp, Trash2, Pencil, ChevronDown, Loader2 } from "lucide-react";
import {
  ACCOUNT_TYPE_LABELS, INVESTMENT_ACCOUNT_TYPES, ASSET_CLASSES,
  detectAccountType, normalizeHolding, mergeHolding, holdingsOf,
  holdingValue, holdingsValue, holdingsInvested, accountFieldsPatch,
  type Holding, type InvestmentAccountType,
} from "@shared/investments";

const gainClass = (n: number) => (n > 0 ? "text-green-500" : n < 0 ? "text-red-500" : "text-muted-foreground");
const fmtGain = (n: number) => `${n >= 0 ? "+" : "−"}${formatMoney(Math.abs(n))}`;

interface HoldingDraft {
  symbol: string; quantity: string; price: string; assetClass: string;
}
const EMPTY_DRAFT: HoldingDraft = { symbol: "", quantity: "", price: "", assetClass: "" };

export function InvestmentsSection() {
  const { toast } = useToast();
  const { data: profiles = [] } = useQuery<any[]>({ queryKey: ["/api/profiles"] });
  const accounts = (Array.isArray(profiles) ? profiles : []).filter((p: any) => p.type === "investment");

  const [expanded, setExpanded] = useState<string | null>(null);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [newAccount, setNewAccount] = useState({ name: "", accountType: "" });
  // Holding dialog serves both add (editSymbol null) and edit.
  const [holdingDialog, setHoldingDialog] = useState<{ accountId: string; editSymbol: string | null } | null>(null);
  const [draft, setDraft] = useState<HoldingDraft>(EMPTY_DRAFT);

  const saveFields = useMutation<void, Error, { accountId: string; holdings: Holding[] }>({
    mutationFn: async ({ accountId, holdings }) => {
      const account = accounts.find((a: any) => a.id === accountId);
      await apiRequest("PATCH", `/api/profiles/${accountId}`, {
        fields: { ...(account?.fields || {}), ...accountFieldsPatch(holdings) },
      });
    },
    onSuccess: () => { void invalidateDomains("profiles", "dashboard"); },
    onError: (e) => toast({ title: "Couldn't save holding", description: e.message, variant: "destructive" }),
  });

  const addAccountMut = useMutation<void, Error, { name: string; accountType: string }>({
    mutationFn: async ({ name, accountType }) => {
      await apiRequest("POST", "/api/profiles", {
        type: "investment",
        name,
        fields: { accountType: accountType || detectAccountType(name), holdings: [] },
      });
    },
    onSuccess: () => {
      void invalidateDomains("profiles", "dashboard");
      toast({ title: "Investment account added" });
    },
    onError: (e) => toast({ title: "Couldn't add account", description: e.message, variant: "destructive" }),
  });

  const totalValue = accounts.reduce((s: number, a: any) => {
    const held = holdingsOf(a);
    return s + (held.length ? holdingsValue(held) : Number(a.fields?.currentValue || 0) || 0);
  }, 0);
  const totalInvested = accounts.reduce((s: number, a: any) => {
    const held = holdingsOf(a);
    return s + (held.length ? holdingsInvested(held) : Number(a.fields?.totalInvested || 0) || 0);
  }, 0);

  const openAdd = (accountId: string) => { setDraft(EMPTY_DRAFT); setHoldingDialog({ accountId, editSymbol: null }); };
  const openEdit = (accountId: string, h: Holding) => {
    setDraft({ symbol: h.symbol, quantity: String(h.quantity), price: String(h.currentPrice), assetClass: h.assetClass });
    setHoldingDialog({ accountId, editSymbol: h.symbol });
  };

  const saveHolding = () => {
    if (!holdingDialog) return;
    const account = accounts.find((a: any) => a.id === holdingDialog.accountId);
    if (!account) return;
    try {
      const current = holdingsOf(account);
      let next: Holding[];
      if (holdingDialog.editSymbol) {
        next = current.map((h) => h.symbol === holdingDialog.editSymbol
          ? { ...h, quantity: Number(draft.quantity) || h.quantity, currentPrice: Number(draft.price) || h.currentPrice, lastPricedAt: new Date().toISOString() }
          : h);
      } else {
        const incoming = normalizeHolding({
          symbol: draft.symbol, quantity: draft.quantity,
          price: draft.price || undefined, assetClass: draft.assetClass || undefined,
        });
        next = mergeHolding(current, incoming);
      }
      saveFields.mutate({ accountId: account.id, holdings: next });
      setHoldingDialog(null);
    } catch (e: any) {
      toast({ title: "Invalid holding", description: e?.message, variant: "destructive" });
    }
  };

  const removeHolding = (accountId: string, symbol: string) => {
    const account = accounts.find((a: any) => a.id === accountId);
    if (!account) return;
    saveFields.mutate({ accountId, holdings: holdingsOf(account).filter((h) => h.symbol !== symbol) });
  };

  return (
    <div className="space-y-2" data-testid="investments-section">
      <div className="flex items-center justify-between">
        <h2 className="micro-label text-muted-foreground flex items-center gap-1.5">
          <TrendingUp className="h-3.5 w-3.5" /> Investments ({accounts.length})
          {totalValue > 0 && (
            <span className="tabular-nums normal-case font-semibold text-foreground">
              · {formatMoney(totalValue)}{" "}
              <span className={gainClass(totalValue - totalInvested)}>{fmtGain(totalValue - totalInvested)}</span>
            </span>
          )}
        </h2>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAddAccountOpen(true)} data-testid="button-add-investment-account">
          <Plus className="h-3 w-3 mr-1" /> Add Account
        </Button>
      </div>

      {accounts.length === 0 ? (
        <div className="rounded-xl border border-border/40 px-3 py-6 text-center">
          <p className="text-sm text-muted-foreground">
            No investment accounts yet — add a Roth IRA, 401(k), brokerage, or crypto wallet,
            or tell the chat "I bought 10 shares of VOO at $520 in my Roth IRA".
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-border/40 divide-y divide-border/30 overflow-hidden">
          {accounts.map((account: any) => {
            const held = holdingsOf(account);
            const value = held.length ? holdingsValue(held) : Number(account.fields?.currentValue || 0) || 0;
            const invested = held.length ? holdingsInvested(held) : Number(account.fields?.totalInvested || 0) || 0;
            const typeLabel = ACCOUNT_TYPE_LABELS[(account.fields?.accountType as InvestmentAccountType)] || "Investment";
            const open = expanded === account.id;
            return (
              <div key={account.id} data-testid={`investment-account-${account.id}`}>
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/30 transition-colors"
                  onClick={() => setExpanded(open ? null : account.id)}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{account.name}</p>
                    <p className="text-[11px] text-muted-foreground">{typeLabel} · {held.length} holding{held.length === 1 ? "" : "s"}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs font-bold tabular-nums">{formatMoney(value)}</p>
                    {invested > 0 && (
                      <p className={`text-[11px] tabular-nums ${gainClass(value - invested)}`}>{fmtGain(value - invested)}</p>
                    )}
                  </div>
                  <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
                </button>
                {open && (
                  <div className="px-3 pb-2.5 space-y-1.5">
                    {held.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground py-1">No holdings yet.</p>
                    ) : held.map((h) => {
                      const v = holdingValue(h);
                      return (
                        <div key={h.symbol} className="flex items-center gap-2 rounded-lg bg-muted/30 px-2.5 py-1.5" data-testid={`holding-${account.id}-${h.symbol}`}>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-semibold">{h.symbol} <span className="font-normal text-muted-foreground text-[11px] uppercase">{h.assetClass}</span></p>
                            <p className="text-[11px] text-muted-foreground tabular-nums">{h.quantity} @ {formatMoney(h.currentPrice)}</p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-xs font-semibold tabular-nums">{formatMoney(v)}</p>
                            <p className={`text-[11px] tabular-nums ${gainClass(v - h.costBasis)}`}>{fmtGain(v - h.costBasis)}</p>
                          </div>
                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => openEdit(account.id, h)} data-testid={`btn-edit-holding-${h.symbol}`}>
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" disabled={saveFields.isPending} onClick={() => removeHolding(account.id, h.symbol)} data-testid={`btn-remove-holding-${h.symbol}`}>
                            {saveFields.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                          </Button>
                        </div>
                      );
                    })}
                    <Button variant="outline" size="sm" className="h-7 text-xs w-full" onClick={() => openAdd(account.id)} data-testid={`btn-add-holding-${account.id}`}>
                      <Plus className="h-3 w-3 mr-1" /> Add holding
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add account */}
      <Dialog open={addAccountOpen} onOpenChange={(o) => { if (!o) setNewAccount({ name: "", accountType: "" }); setAddAccountOpen(o); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Add Investment Account</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Account Name <span className="text-destructive">*</span></Label>
              <Input placeholder="e.g. Roth IRA, Fidelity Brokerage, Coinbase" value={newAccount.name}
                onChange={(e) => setNewAccount((p) => ({ ...p, name: e.target.value }))} data-testid="input-investment-name" />
            </div>
            <div>
              <Label className="text-xs">Type</Label>
              <Select value={newAccount.accountType || detectAccountType(newAccount.name)}
                onValueChange={(v) => setNewAccount((p) => ({ ...p, accountType: v }))}>
                <SelectTrigger data-testid="select-investment-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {INVESTMENT_ACCOUNT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{ACCOUNT_TYPE_LABELS[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button className="w-full" disabled={!newAccount.name.trim() || addAccountMut.isPending}
              onClick={() => {
                addAccountMut.mutate({ name: newAccount.name.trim(), accountType: newAccount.accountType });
                setAddAccountOpen(false);
                setNewAccount({ name: "", accountType: "" });
              }} data-testid="button-save-investment-account">
              {addAccountMut.isPending ? "Saving…" : "Add Account"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add / edit holding */}
      <Dialog open={!!holdingDialog} onOpenChange={(o) => { if (!o) setHoldingDialog(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{holdingDialog?.editSymbol ? `Edit ${holdingDialog.editSymbol}` : "Add Holding"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {!holdingDialog?.editSymbol && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Symbol <span className="text-destructive">*</span></Label>
                  <Input placeholder="AAPL, VOO, BTC" value={draft.symbol}
                    onChange={(e) => setDraft((p) => ({ ...p, symbol: e.target.value.toUpperCase() }))} data-testid="input-holding-symbol" />
                </div>
                <div>
                  <Label className="text-xs">Class</Label>
                  <Select value={draft.assetClass || "auto"} onValueChange={(v) => setDraft((p) => ({ ...p, assetClass: v === "auto" ? "" : v }))}>
                    <SelectTrigger data-testid="select-holding-class"><SelectValue placeholder="Auto" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Auto-detect</SelectItem>
                      {ASSET_CLASSES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Quantity <span className="text-destructive">*</span></Label>
                <Input type="number" inputMode="decimal" step="any" min="0" placeholder="10 or 0.05" value={draft.quantity}
                  onChange={(e) => setDraft((p) => ({ ...p, quantity: e.target.value }))} data-testid="input-holding-quantity" />
              </div>
              <div>
                <Label className="text-xs">Price / unit ($)</Label>
                <Input type="number" inputMode="decimal" step="any" min="0" placeholder="180.00" value={draft.price}
                  onChange={(e) => setDraft((p) => ({ ...p, price: e.target.value }))} data-testid="input-holding-price" />
              </div>
            </div>
            <Button className="w-full" disabled={saveFields.isPending || (!holdingDialog?.editSymbol && !draft.symbol.trim()) || !draft.quantity}
              onClick={saveHolding} data-testid="button-save-holding">
              {saveFields.isPending ? "Saving…" : holdingDialog?.editSymbol ? "Save Changes" : "Add Holding"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
