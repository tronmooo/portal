// ── The adaptive Overview of a financial asset ───────────────────────────────
//
// One account profile page, several genuinely different screens. The KIND's
// layout (shared/account-kinds.ts) decides which:
//
//   bank        checking / savings / money market / CD — balance, deposits and
//               withdrawals, balance history, the account facts.
//   investment  brokerage / retirement / HSA / 529 — a lightweight brokerage
//               dashboard: portfolio value, performance over a selectable
//               period, holdings, allocation, gain/loss, contributions and
//               dividends, recent activity.
//   crypto      the investment dashboard in crypto vocabulary (positions,
//               tokens, transfers).
//   cash        the balance and its history; a wallet has no institution.
//   debt        the existing AccountOverview — owed, limit, utilization.
//
// Each section is shown only when the kind has the CAPABILITY for it
// (capabilitiesForKind) and there is something to show, so no account renders
// a meaningless empty table. Every figure comes from shared/financial-assets.ts
// and shared/finance-accounts.ts — the same helpers the cards, the server and
// the chat use.

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { invalidateDomains } from "@/lib/cache-bus";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ArrowLeftRight, Plus, Trash2, Link2, Unplug, PieChart, Activity, Coins, Wallet, AlertTriangle,
} from "lucide-react";
import { formatMoney, formatListDate } from "@/lib/format";
import { localTodayISO } from "@/lib/dates";
import { AccountOverview } from "./AccountOverview";
import { BalanceHistoryChart, ChangeChip } from "./BalanceHistoryChart";
import {
  toAccountView, isAccountProfile, accountKindMeta, accountKindOf,
} from "@shared/finance-accounts";
import { accountLayoutOf } from "@shared/account-kinds";
import {
  hasCapability, balanceSeries, seriesForPeriod, periodStart, holdings, allocationOf, gainLossOf, biggestPositions,
  investmentActivity, summarizeActivity, cashFlowOf, accountConnection, ACTIVITY_KINDS, activityBalanceEffect,
  type AssetClass, type InvestmentActivityKind, type FinancialLayout,
} from "@shared/financial-assets";

const ASSET_CLASS_LABEL: Record<AssetClass, string> = {
  equity: "Stocks", etf: "ETFs", fund: "Funds", bond: "Bonds", crypto: "Crypto", cash: "Cash",
  real_estate: "Real estate", commodity: "Commodities", other: "Other",
};
const ASSET_CLASS_COLOR: Record<AssetClass, string> = {
  equity: "hsl(213 90% 62%)", etf: "hsl(262 60% 62%)", fund: "hsl(175 55% 42%)", bond: "hsl(35 90% 55%)",
  crypto: "hsl(25 80% 54%)", cash: "hsl(142 60% 45%)", real_estate: "hsl(220 60% 55%)", commodity: "hsl(45 70% 50%)", other: "hsl(240 20% 60%)",
};

const ACTIVITY_LABEL: Record<InvestmentActivityKind, string> = {
  contribution: "Contribution", withdrawal: "Withdrawal", buy: "Buy", sell: "Sell", dividend: "Dividend",
  interest: "Interest", fee: "Fee", transfer_in: "Transfer in", transfer_out: "Transfer out",
};

function refresh() {
  return invalidateDomains("profiles", "assets", "liabilities", "dashboard");
}

function Stat({ label, value, tone, sub, testId }: { label: string; value: React.ReactNode; tone?: "pos" | "neg"; sub?: React.ReactNode; testId?: string }) {
  const color = tone === "neg" ? "text-red-500" : tone === "pos" ? "text-emerald-600" : "";
  return (
    <div className="bubble-row px-3 py-2 min-w-0" data-testid={testId}>
      <p className="micro-label text-muted-foreground">{label}</p>
      <p className={`metric-value text-[16px] leading-tight mt-0.5 tabular-nums truncate ${color}`}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{sub}</p>}
    </div>
  );
}

// ─── Connection + duplicate banners ──────────────────────────────────────────

function ConnectionBadge({ profile }: { profile: any }) {
  const conn = accountConnection(profile);
  if (!conn) return null;
  const synced = conn.lastSyncAt ? formatListDate(conn.lastSyncAt.slice(0, 10)) : null;
  if (conn.status === "active") {
    return (
      <Badge variant="outline" className="text-[11px] h-5 gap-1 text-emerald-700 dark:text-emerald-400" data-testid="account-connection-badge">
        <Link2 className="w-3 h-3" />Connected{synced ? ` · synced ${synced}` : ""}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[11px] h-5 gap-1 text-muted-foreground" data-testid="account-connection-badge">
      <Unplug className="w-3 h-3" />{conn.status === "action_required" ? "Needs reconnect" : "Disconnected"} · history kept
    </Badge>
  );
}

function PossibleDuplicateBanner({ profile }: { profile: any }) {
  const { toast } = useToast();
  const dup = profile?.fields?.possibleDuplicateOf;
  const dismiss = useMutation({
    mutationFn: async () => (await apiRequest("PATCH", `/api/profiles/${profile.id}`, { fields: { possibleDuplicateOf: null } })).json(),
    onSuccess: refresh,
    onError: (e: any) => toast({ title: "Couldn't update", description: e?.message, variant: "destructive" }),
  });
  if (!dup?.profileId) return null;
  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 flex items-start gap-2" data-testid="account-possible-duplicate">
      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">Same account as “{dup.name}”?</p>
        <p className="text-[12px] text-muted-foreground">
          This connected account looks like one you already track{Array.isArray(dup.reasons) && dup.reasons.length ? ` (${dup.reasons.join(", ")})` : ""}.
          Merging keeps both histories.
        </p>
        <div className="flex items-center gap-1.5 mt-2">
          <Link href={`/profiles/${dup.profileId}`}>
            <Button size="sm" variant="outline" className="h-7 text-xs">Open “{dup.name}”</Button>
          </Link>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => dismiss.mutate()} disabled={dismiss.isPending}>
            Different account
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Transfer dialog ─────────────────────────────────────────────────────────

export function TransferDialog({ open, onOpenChange, fromProfile, accounts }: {
  open: boolean; onOpenChange: (o: boolean) => void; fromProfile: any; accounts: any[];
}) {
  const { toast } = useToast();
  const others = accounts.filter((a) => a.id !== fromProfile?.id);
  const [direction, setDirection] = useState<"out" | "in">("out");
  const [otherId, setOtherId] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(localTodayISO());
  const [note, setNote] = useState("");

  const mut = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/accounts/transfer", {
      fromAccountId: direction === "out" ? fromProfile.id : otherId,
      toAccountId: direction === "out" ? otherId : fromProfile.id,
      amount: Number(amount.replace(/[$,]/g, "")), date, note: note || undefined,
    })).json(),
    onSuccess: async () => {
      await refresh();
      onOpenChange(false);
      setAmount(""); setNote("");
      toast({ title: "Transfer recorded", description: "Both balances moved. Nothing was logged as income or spending." });
    },
    onError: (e: any) => toast({ title: "Couldn't record the transfer", description: e?.message, variant: "destructive" }),
  });

  const n = Number(amount.replace(/[$,]/g, ""));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Transfer between accounts</DialogTitle></DialogHeader>
        <div className="space-y-3" data-testid="transfer-dialog">
          <div className="grid grid-cols-2 gap-2">
            <Button variant={direction === "out" ? "default" : "outline"} size="sm" onClick={() => setDirection("out")}>From {fromProfile?.name}</Button>
            <Button variant={direction === "in" ? "default" : "outline"} size="sm" onClick={() => setDirection("in")}>Into {fromProfile?.name}</Button>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{direction === "out" ? "To" : "From"}</Label>
            <Select value={otherId} onValueChange={setOtherId}>
              <SelectTrigger data-testid="transfer-other-account"><SelectValue placeholder="Pick an account" /></SelectTrigger>
              <SelectContent>
                {others.map((a) => <SelectItem key={a.id} value={a.id}>{a.name} · {formatMoney(toAccountView(a).balance)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Amount</Label>
              <Input type="number" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" data-testid="transfer-amount" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Date</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Note (optional)</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Monthly savings" />
          </div>
          <p className="text-[11px] text-muted-foreground">A transfer changes which account holds the money, not your net worth.</p>
          <Button className="w-full" disabled={!otherId || !Number.isFinite(n) || n <= 0 || mut.isPending} onClick={() => mut.mutate()} data-testid="transfer-submit">
            {mut.isPending ? "Recording…" : "Record transfer"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Activity ────────────────────────────────────────────────────────────────

function ActivityForm({ profile, layout, onDone }: { profile: any; layout: FinancialLayout; onDone: () => void }) {
  const { toast } = useToast();
  const [kind, setKind] = useState<InvestmentActivityKind>("contribution");
  const [amount, setAmount] = useState("");
  const [symbol, setSymbol] = useState("");
  const [quantity, setQuantity] = useState("");
  const [date, setDate] = useState(localTodayISO());
  const [note, setNote] = useState("");
  const investy = layout === "investment" || layout === "crypto";
  const kinds = investy ? ACTIVITY_KINDS : (["contribution", "withdrawal", "interest", "fee"] as const);
  const positional = kind === "buy" || kind === "sell" || kind === "dividend";

  const mut = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/accounts/${profile.id}/activity`, {
      kind, amount: Number(amount.replace(/[$,]/g, "")), date,
      symbol: positional && symbol ? symbol : undefined,
      quantity: positional && quantity ? Number(quantity) : undefined,
      note: note || undefined,
    })).json(),
    onSuccess: async () => {
      await refresh();
      setAmount(""); setSymbol(""); setQuantity(""); setNote("");
      toast({ title: `${ACTIVITY_LABEL[kind]} recorded` });
      onDone();
    },
    onError: (e: any) => toast({ title: "Couldn't record that", description: e?.message, variant: "destructive" }),
  });
  const n = Number(amount.replace(/[$,]/g, ""));
  const effect = activityBalanceEffect(kind);
  return (
    <div className="rounded-xl border border-border/40 p-3 space-y-2" data-testid="activity-form">
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">What happened</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as InvestmentActivityKind)}>
            <SelectTrigger data-testid="activity-kind"><SelectValue /></SelectTrigger>
            <SelectContent>{kinds.map((k) => <SelectItem key={k} value={k}>{ACTIVITY_LABEL[k]}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Amount</Label>
          <Input type="number" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" data-testid="activity-amount" />
        </div>
      </div>
      {positional && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs">{layout === "crypto" ? "Token" : "Ticker"}</Label>
            <Input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder={layout === "crypto" ? "BTC" : "AAPL"} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{layout === "crypto" ? "Units" : "Shares"}</Label>
            <Input type="number" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="10" />
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Date</Label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Note</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {effect > 0 ? "Raises the balance." : effect < 0 ? "Lowers the balance." : "Changes what the account holds, not its total."}
        {kind === "dividend" || kind === "interest" ? " Income tied to this asset — not logged separately." : ""}
      </p>
      <Button size="sm" className="w-full" disabled={!Number.isFinite(n) || n <= 0 || mut.isPending} onClick={() => mut.mutate()} data-testid="activity-submit">
        {mut.isPending ? "Saving…" : "Record"}
      </Button>
    </div>
  );
}

function ActivityList({ profile, limit = 8 }: { profile: any; limit?: number }) {
  const rows = useMemo(() => investmentActivity(profile).slice().reverse().slice(0, limit), [profile, limit]);
  if (rows.length === 0) return null;
  return (
    <div className="rounded-lg border border-border/40 divide-y divide-border/30 overflow-hidden" data-testid="account-activity-list">
      {rows.map((a) => {
        const eff = activityBalanceEffect(a.kind);
        return (
          <div key={a.id} className="flex items-center justify-between gap-2 px-2.5 py-2">
            <div className="min-w-0">
              <p className="text-xs font-medium truncate">
                {ACTIVITY_LABEL[a.kind]}{a.symbol ? ` · ${a.symbol}` : ""}{a.quantity != null ? ` × ${a.quantity}` : ""}
              </p>
              <p className="text-[11px] text-muted-foreground truncate">{formatListDate(a.date)}{a.note ? ` · ${a.note}` : ""}{a.source !== "user" ? ` · via ${a.source}` : ""}</p>
            </div>
            <p className={`text-xs font-semibold tabular-nums shrink-0 ${eff > 0 ? "text-emerald-600" : eff < 0 ? "text-red-500" : ""}`}>
              {eff > 0 ? "+" : eff < 0 ? "−" : ""}{formatMoney(a.amount)}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// ─── Holdings ────────────────────────────────────────────────────────────────

function HoldingsPanel({ profile, layout }: { profile: any; layout: FinancialLayout }) {
  const { toast } = useToast();
  const list = useMemo(() => holdings(profile), [profile]);
  const allocation = useMemo(() => allocationOf(list), [list]);
  const gl = useMemo(() => gainLossOf(list), [list]);
  const biggest = useMemo(() => biggestPositions(list, 5), [list]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ symbol: "", name: "", quantity: "", price: "", value: "", costBasis: "", assetClass: layout === "crypto" ? "crypto" : "equity" });
  const crypto = layout === "crypto";

  const upsert = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/accounts/${profile.id}/holdings`, {
      symbol: form.symbol || undefined, name: form.name || undefined,
      quantity: form.quantity || undefined, price: form.price || undefined, value: form.value || undefined,
      costBasis: form.costBasis || undefined, assetClass: form.assetClass,
    })).json(),
    onSuccess: async () => {
      await refresh();
      setAdding(false);
      setForm({ symbol: "", name: "", quantity: "", price: "", value: "", costBasis: "", assetClass: crypto ? "crypto" : "equity" });
      toast({ title: crypto ? "Position saved" : "Holding saved" });
    },
    onError: (e: any) => toast({ title: "Couldn't save", description: e?.message, variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: async (key: string) => (await apiRequest("DELETE", `/api/accounts/${profile.id}/holdings/${encodeURIComponent(key)}`)).json(),
    onSuccess: refresh,
    onError: (e: any) => toast({ title: "Couldn't remove", description: e?.message, variant: "destructive" }),
  });

  const total = list.reduce((s, h) => s + h.value, 0);
  return (
    <Card>
      <CardContent className="p-3 space-y-3" data-testid="account-holdings">
        <div className="flex items-center justify-between gap-2">
          <p className="micro-label text-muted-foreground flex items-center gap-1">
            {crypto ? <Coins className="w-3 h-3" /> : <PieChart className="w-3 h-3" />}
            {crypto ? "Positions" : "Holdings"}{list.length ? ` (${list.length})` : ""}
          </p>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAdding((v) => !v)} data-testid="btn-add-holding">
            <Plus className="w-3 h-3 mr-1" />{crypto ? "Add position" : "Add holding"}
          </Button>
        </div>

        {adding && (
          <div className="rounded-xl border border-border/40 p-3 space-y-2" data-testid="holding-form">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1"><Label className="text-xs">{crypto ? "Token" : "Ticker"}</Label>
                <Input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })} placeholder={crypto ? "BTC" : "VTI"} data-testid="holding-symbol" /></div>
              <div className="space-y-1"><Label className="text-xs">Name</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={crypto ? "Bitcoin" : "Vanguard Total Market"} /></div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1"><Label className="text-xs">{crypto ? "Units" : "Shares"}</Label>
                <Input type="number" step="any" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} /></div>
              <div className="space-y-1"><Label className="text-xs">Price</Label>
                <Input type="number" step="any" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></div>
              <div className="space-y-1"><Label className="text-xs">Value</Label>
                <Input type="number" step="0.01" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder="auto" data-testid="holding-value" /></div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1"><Label className="text-xs">Cost basis</Label>
                <Input type="number" step="0.01" value={form.costBasis} onChange={(e) => setForm({ ...form, costBasis: e.target.value })} placeholder="Optional" /></div>
              <div className="space-y-1"><Label className="text-xs">Class</Label>
                <Select value={form.assetClass} onValueChange={(v) => setForm({ ...form, assetClass: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{(Object.keys(ASSET_CLASS_LABEL) as AssetClass[]).map((k) => <SelectItem key={k} value={k}>{ASSET_CLASS_LABEL[k]}</SelectItem>)}</SelectContent>
                </Select></div>
            </div>
            <Button size="sm" className="w-full" disabled={(!form.symbol && !form.name) || upsert.isPending} onClick={() => upsert.mutate()} data-testid="holding-submit">
              {upsert.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        )}

        {list.length === 0 && !adding && (
          <p className="text-[12px] text-muted-foreground">
            No {crypto ? "positions" : "holdings"} yet. Add what this account holds to see allocation and gain/loss — or tell the assistant “my {profile.name} holds 50 shares of VTI”.
          </p>
        )}

        {list.length > 0 && (
          <>
            {/* Allocation bar */}
            <div data-testid="account-allocation">
              <div className="h-2 rounded-full overflow-hidden flex bg-muted">
                {allocation.map((a) => (
                  <div key={a.assetClass} style={{ width: `${a.pct}%`, background: ASSET_CLASS_COLOR[a.assetClass] }} title={`${ASSET_CLASS_LABEL[a.assetClass]} ${a.pct}%`} />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
                {allocation.map((a) => (
                  <span key={a.assetClass} className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full" style={{ background: ASSET_CLASS_COLOR[a.assetClass] }} />
                    {ASSET_CLASS_LABEL[a.assetClass]} {a.pct.toFixed(0)}%
                  </span>
                ))}
              </div>
            </div>

            {/* Gain / loss */}
            {gl.gain != null && (
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Holdings value" value={formatMoney(gl.value)} testId="holdings-value" />
                <Stat label="Cost basis" value={formatMoney(gl.costBasis ?? 0)} />
                <Stat label="Unrealized" value={`${gl.gain >= 0 ? "+" : "−"}${formatMoney(Math.abs(gl.gain))}`} tone={gl.gain >= 0 ? "pos" : "neg"}
                  sub={gl.gainPct != null ? `${gl.gainPct > 0 ? "+" : ""}${gl.gainPct.toFixed(1)}%` : undefined} testId="holdings-gain" />
              </div>
            )}

            {/* Positions table */}
            <div className="rounded-lg border border-border/40 divide-y divide-border/30 overflow-hidden">
              {biggest.map((h) => {
                const g = h.costBasis != null ? h.value - h.costBasis : null;
                return (
                  <div key={h.id} className="flex items-center gap-2 px-2.5 py-2" data-testid={`holding-${h.id}`}>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold truncate">{h.symbol ?? h.name}<span className="text-muted-foreground font-normal">{h.symbol && h.name !== h.symbol ? ` · ${h.name}` : ""}</span></p>
                      <p className="text-[11px] text-muted-foreground">
                        {h.quantity != null ? `${h.quantity.toLocaleString()} ${crypto ? "units" : "sh"}` : ASSET_CLASS_LABEL[h.assetClass]}
                        {h.price != null ? ` @ ${formatMoney(h.price)}` : ""} · {h.pct.toFixed(0)}%
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-semibold tabular-nums">{formatMoney(h.value)}</p>
                      {g != null && <p className={`text-[11px] tabular-nums ${g >= 0 ? "text-emerald-600" : "text-red-500"}`}>{g >= 0 ? "+" : "−"}{formatMoney(Math.abs(g))}</p>}
                    </div>
                    <button type="button" className="p-1 text-muted-foreground hover:text-red-500" onClick={() => remove.mutate(h.symbol ?? h.id)} aria-label={`Remove ${h.symbol ?? h.name}`} data-testid={`holding-remove-${h.id}`}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
              {list.length > biggest.length && (
                <p className="px-2.5 py-1.5 text-[11px] text-muted-foreground">+ {list.length - biggest.length} smaller positions · {formatMoney(total)} total</p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Layouts ─────────────────────────────────────────────────────────────────

function InvestmentDashboard({ profile, layout, todayISO, accounts }: { profile: any; layout: FinancialLayout; todayISO: string; accounts: any[] }) {
  const view = toAccountView(profile);
  const series = useMemo(() => balanceSeries(profile, todayISO), [profile, todayISO]);
  const ytd = useMemo(() => seriesForPeriod(series, "YTD", todayISO), [series, todayISO]);
  const month = useMemo(() => seriesForPeriod(series, "1M", todayISO), [series, todayISO]);
  const activity = useMemo(() => investmentActivity(profile), [profile]);
  const ytdActivity = useMemo(() => summarizeActivity(activity, periodStart("YTD", todayISO), todayISO), [activity, todayISO]);
  const [recording, setRecording] = useState(false);
  const [transfer, setTransfer] = useState(false);
  const crypto = layout === "crypto";
  const kindLabel = accountKindMeta(accountKindOf(profile)).label;
  const up = (ytd.change ?? 0) >= 0;

  return (
    <div className="space-y-3" data-testid="investment-dashboard">
      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-[11px] h-5" data-testid="account-kind-badge">{kindLabel}</Badge>
            <ConnectionBadge profile={profile} />
            {view.excluded && <Badge variant="outline" className="text-[11px] h-5 text-muted-foreground">Excluded from totals</Badge>}
          </div>
          <div className="flex items-end justify-between gap-3 flex-wrap">
            <div>
              <p className="micro-label text-muted-foreground">{crypto ? "Portfolio value" : "Portfolio value"}</p>
              <p className="text-[30px] font-bold leading-none tabular-nums mt-0.5" data-testid="account-balance">{formatMoney(view.balance)}</p>
              <div className="flex items-center gap-3 mt-1.5">
                <span className="text-[11px] text-muted-foreground">1M</span><ChangeChip change={month.change} changePct={month.changePct} />
                <span className="text-[11px] text-muted-foreground">YTD</span><ChangeChip change={ytd.change} changePct={ytd.changePct} />
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setTransfer(true)} data-testid="btn-transfer">
                <ArrowLeftRight className="w-3.5 h-3.5 mr-1" />Transfer
              </Button>
              <Button size="sm" variant={recording ? "default" : "outline"} className="h-8 text-xs" onClick={() => setRecording((v) => !v)} data-testid="btn-record-activity">
                <Activity className="w-3.5 h-3.5 mr-1" />Record activity
              </Button>
            </div>
          </div>
          {recording && <ActivityForm profile={profile} layout={layout} onDone={() => setRecording(false)} />}
          <BalanceHistoryChart profile={profile} todayISO={todayISO} title="Performance" accent={up ? "#16a34a" : "#dc2626"} height={180} />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="Contributions YTD" value={formatMoney(ytdActivity.contributions + ytdActivity.transfersIn)} testId="stat-contributions" />
            <Stat label="Withdrawals YTD" value={formatMoney(ytdActivity.withdrawals + ytdActivity.transfersOut)} testId="stat-withdrawals" />
            <Stat label={crypto ? "Staking / interest YTD" : "Dividends YTD"} value={formatMoney(ytdActivity.dividends)} tone={ytdActivity.dividends > 0 ? "pos" : undefined} testId="stat-dividends" />
            <Stat label="Net flow YTD" value={`${ytdActivity.netFlow >= 0 ? "+" : "−"}${formatMoney(Math.abs(ytdActivity.netFlow))}`} tone={ytdActivity.netFlow >= 0 ? "pos" : "neg"} testId="stat-netflow" />
          </div>
        </CardContent>
      </Card>

      <HoldingsPanel profile={profile} layout={layout} />

      {activity.length > 0 && (
        <Card>
          <CardContent className="p-3 space-y-2">
            <p className="micro-label text-muted-foreground flex items-center gap-1"><Activity className="w-3 h-3" />Recent activity ({activity.length})</p>
            <ActivityList profile={profile} />
          </CardContent>
        </Card>
      )}

      {/* Facts, manual adjustment and the adjustment ledger — the headline is
          already above, so the account card renders without it. */}
      <AccountOverview profile={profile} todayISO={todayISO} hideHeadline />
      <TransferDialog open={transfer} onOpenChange={setTransfer} fromProfile={profile} accounts={accounts} />
    </div>
  );
}

function BankOverview({ profile, layout, todayISO, accounts }: { profile: any; layout: FinancialLayout; todayISO: string; accounts: any[] }) {
  const [transfer, setTransfer] = useState(false);
  const [recording, setRecording] = useState(false);
  const month = useMemo(() => cashFlowOf(profile, periodStart("1M", todayISO), todayISO), [profile, todayISO]);
  const view = toAccountView(profile);
  const showChart = hasCapability(profile, "balanceHistory") && layout !== "cash";
  return (
    <div className="space-y-3" data-testid="bank-overview">
      <div className="flex items-center gap-2 flex-wrap">
        <ConnectionBadge profile={profile} />
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setTransfer(true)} data-testid="btn-transfer">
            <ArrowLeftRight className="w-3.5 h-3.5 mr-1" />Transfer
          </Button>
          <Button size="sm" variant={recording ? "default" : "outline"} className="h-8 text-xs" onClick={() => setRecording((v) => !v)} data-testid="btn-record-activity">
            <Wallet className="w-3.5 h-3.5 mr-1" />Deposit / withdrawal
          </Button>
        </div>
      </div>
      {recording && <ActivityForm profile={profile} layout={layout} onDone={() => setRecording(false)} />}
      <AccountOverview profile={profile} todayISO={todayISO} />
      {(showChart || month.count > 0) && (
        <Card>
          <CardContent className="p-3 space-y-3">
            {showChart && <BalanceHistoryChart profile={profile} todayISO={todayISO} isDebt={view.isDebt} />}
            {hasCapability(profile, "cashFlow") && month.count > 0 && (
              <div className="grid grid-cols-3 gap-2" data-testid="account-cash-flow">
                <Stat label="Deposits · 30d" value={`+${formatMoney(month.deposits)}`} tone="pos" />
                <Stat label="Withdrawals · 30d" value={`−${formatMoney(month.withdrawals)}`} tone="neg" />
                <Stat label="Net · 30d" value={`${month.net >= 0 ? "+" : "−"}${formatMoney(Math.abs(month.net))}`} tone={month.net >= 0 ? "pos" : "neg"} />
              </div>
            )}
          </CardContent>
        </Card>
      )}
      <ActivityList profile={profile} limit={5} />
      <TransferDialog open={transfer} onOpenChange={setTransfer} fromProfile={profile} accounts={accounts} />
    </div>
  );
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

export function FinancialAssetOverview({ profile, todayISO }: { profile: any; todayISO?: string }) {
  const today = todayISO || localTodayISO();
  const { data: profiles } = useQuery<any[]>({ queryKey: ["/api/profiles"], staleTime: 30_000 });
  const accounts = useMemo(() => (profiles || []).filter(isAccountProfile), [profiles]);
  if (!isAccountProfile(profile)) return null;
  const layout = accountLayoutOf(profile);
  return (
    <div className="space-y-3" data-testid={`financial-asset-overview-${layout}`}>
      <PossibleDuplicateBanner profile={profile} />
      {layout === "investment" || layout === "crypto" ? (
        <InvestmentDashboard profile={profile} layout={layout} todayISO={today} accounts={accounts} />
      ) : layout === "debt" ? (
        <div className="space-y-3">
          <ConnectionBadge profile={profile} />
          <AccountOverview profile={profile} todayISO={today} />
          {balanceSeries(profile, today).length >= 2 && (
            <Card><CardContent className="p-3"><BalanceHistoryChart profile={profile} todayISO={today} title="Balance owed" isDebt accent="#dc2626" /></CardContent></Card>
          )}
        </div>
      ) : (
        <BankOverview profile={profile} layout={layout} todayISO={today} accounts={accounts} />
      )}
    </div>
  );
}

/** Hero tiles for a financial asset: the balance plus how it moved. */
export function financialHeroStats(profile: any, todayISO: string): Array<{ label: string; value: string; testId: string }> {
  const view = toAccountView(profile);
  const series = balanceSeries(profile, todayISO);
  const month = seriesForPeriod(series, "1M", todayISO);
  const out: Array<{ label: string; value: string; testId: string }> = [];
  if (month.change != null && month.change !== 0) {
    out.push({ label: "1M change", value: `${month.change > 0 ? "+" : "−"}${formatMoney(Math.abs(month.change))}`, testId: "hero-stat-account-change" });
  }
  const list = holdings(profile);
  if (list.length > 0) out.push({ label: view.kind === "crypto" ? "Positions" : "Holdings", value: String(list.length), testId: "hero-stat-account-holdings" });
  return out;
}

