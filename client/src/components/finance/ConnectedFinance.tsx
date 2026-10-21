/**
 * The connected-bank section of the Finance tab.
 *
 * Renders real Stripe Financial Connections data: connected net worth,
 * accounts grouped by institution, a filterable/searchable transaction list
 * with a detail panel, cash flow, spending, income and liabilities.
 *
 * Every number here comes from the server's `/api/finance/*` endpoints, which
 * compute through shared/finance-calc.ts. This component does not add up money
 * itself — that is the whole point of the calculation module.
 *
 * Money arrives as integer minor units and is formatted exactly once, at
 * render, via `formatMinor`.
 */

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  ArrowDownRight, ArrowUpRight, Search, X, Loader2, RefreshCw,
  ChevronRight, AlertTriangle, Repeat, CreditCard, Wallet, TrendingUp, Info,
  Landmark, Scale, CalendarDays, PiggyBank, ArrowLeftRight,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { getUserToday, getUserCurrentMonth, addDays as tzAddDays } from "@shared/timezone";
import { formatMinor, minorToMajor } from "@shared/money";
import {
  ACCOUNT_TYPE_LABEL, ACCOUNT_SUBCATEGORY_LABEL, financeErrorMessage, isDebtAccount,
  type FinancialAccountRecord, type FinancialTransactionRecord,
} from "@shared/finance-connections";
import type { BreakdownRow, MoneyByCurrency, RecurringGroup } from "@shared/finance-calc";
import { cn } from "@/lib/utils";
import { TimeRangeSelector } from "@/components/ui/time-range";
import {
  HeroMetric, StatTile, CoverageNote, DeltaChip, SectionTitle, MeterRow, accentScope, tone,
} from "@/components/tracker-detail";
import { invalidateFinanceConnections } from "./FinanceConnectionCard";
import {
  CategoryBreakdown, PeriodBars, FlowCompare, FinanceLoadError, FINANCE_HS,
  breakdownSlices, singleCurrency, firstChangePct, periodPoints, periodLabel, monthTitle,
} from "./finance-visuals";

const EXPENSE_CATEGORIES = [
  "food", "housing", "transport", "utilities", "health", "entertainment",
  "shopping", "insurance", "pet", "general",
];

// ── Formatting helpers ──────────────────────────────────────────────────────

/**
 * Render a per-currency total.
 *
 * When more than one currency is present we show them side by side rather than
 * summing — the app has no FX conversion, and a fabricated single number would
 * be wrong.
 */
function MoneyTotal({
  totals, className, signDisplay,
}: { totals: MoneyByCurrency; className?: string; signDisplay?: "auto" | "always" }) {
  const entries = Object.entries(totals ?? {});
  if (entries.length === 0) return <span className={className}>{formatMinor(0, "usd")}</span>;
  if (entries.length === 1) {
    const [currency, amount] = entries[0];
    return <span className={className}>{formatMinor(amount, currency, { signDisplay })}</span>;
  }
  return (
    <span className={cn("inline-flex flex-wrap gap-x-2", className)} title="Multiple currencies are shown separately — Portol does not convert between them.">
      {entries.map(([currency, amount]) => (
        <span key={currency}>{formatMinor(amount, currency, { signDisplay })}</span>
      ))}
    </span>
  );
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function relative(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "never";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function accountLabel(a: FinancialAccountRecord): string {
  const name = a.accountDisplayName || a.accountName || "Account";
  return a.lastFour ? `${name} ••${a.lastFour}` : name;
}

// The user's month/day, not UTC's: on the last evening of a month in the
// Americas the UTC value already pointed "This month" at an empty next month.
function currentMonth(): string {
  return getUserCurrentMonth(BROWSER_TIMEZONE);
}

type RangeKey = "month" | "30d" | "90d" | "year";

// The range is a view of the period, held in component state only — it is
// never persisted, so reopening Finance always starts on "This month".
const RANGE_OPTIONS: ReadonlyArray<{ value: RangeKey; label: string }> = [
  { value: "month", label: "This month" },
  { value: "30d", label: "30D" },
  { value: "90d", label: "90D" },
  { value: "year", label: "1Y" },
];
const RANGE_LABEL: Record<RangeKey, string> = {
  month: "this month", "30d": "last 30 days", "90d": "last 90 days", year: "last 12 months",
};

function rangeBounds(range: RangeKey): { startDate: string; endDate: string } {
  const endDate = getUserToday(BROWSER_TIMEZONE);
  if (range === "month") {
    return { startDate: `${currentMonth()}-01`, endDate };
  }
  const days = range === "30d" ? 30 : range === "90d" ? 90 : 365;
  return { startDate: tzAddDays(endDate, -days), endDate };
}

// ── Root ────────────────────────────────────────────────────────────────────

export function ConnectedFinance() {
  const { toast } = useToast();
  const [range, setRange] = useState<RangeKey>("month");
  const [accountFilter, setAccountFilter] = useState<string>("all");
  const bounds = useMemo(() => rangeBounds(range), [range]);

  const accountIdsParam = accountFilter === "all" ? "" : `&accountIds=${accountFilter}`;

  // One cheap check first: has this user opted in at all? Everything else on
  // this screen is gated behind it, so a user who never connects a bank costs
  // exactly one lightweight request — not a summary computation over an empty
  // dataset on every Finance page load.
  const connectionsQ = useQuery<any>({
    queryKey: ["/api/finance/connections"],
    queryFn: () => apiRequest("GET", "/api/finance/connections").then((r) => r.json()),
    refetchOnWindowFocus: false,
  });

  const accounts: FinancialAccountRecord[] = connectionsQ.data?.accounts ?? [];
  const configured = connectionsQ.data?.configured !== false;
  const hasConnections = (connectionsQ.data?.connections ?? [])
    .filter((c: any) => c.connectionStatus !== "disconnected").length > 0;

  const summaryQ = useQuery<any>({
    queryKey: ["/api/finance/summary", bounds.startDate, bounds.endDate, accountFilter],
    queryFn: () =>
      apiRequest("GET", `/api/finance/summary?startDate=${bounds.startDate}&endDate=${bounds.endDate}${accountIdsParam}`)
        .then((r) => r.json()),
    enabled: hasConnections,
    refetchOnWindowFocus: false,
  });

  const refreshMut = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/finance/refresh", {})).json(),
    onSuccess: (r: any) => {
      invalidateFinanceConnections();
      queryClient.invalidateQueries({ queryKey: ["/api/finance/summary"] });
      toast({
        title: r?.status === "failed" ? "Refresh failed" : "Refreshed",
        description: r?.status === "failed"
          ? financeErrorMessage(r.errorCode)
          : `${r?.transactionsInserted ?? 0} new transaction${r?.transactionsInserted === 1 ? "" : "s"}.`,
        variant: r?.status === "failed" ? "destructive" : undefined,
      });
    },
    onError: (e: any) => toast({
      title: "Couldn't refresh",
      description: financeErrorMessage(/\b429\b/.test(String(e?.message)) ? "rate_limited" : "unknown"),
      variant: "destructive",
    }),
  });

  // OPT-IN ONLY.
  //
  // Bank connection is an option the user turns on in Settings → Connected
  // Services → Finance. Until they do, this component renders NOTHING: no
  // placeholder, no skeleton, no "connect your bank" prompt. A user who never
  // wants this sees a Finance tab identical to the one they had before the
  // feature existed.
  //
  // The same applies while the check is still in flight — a skeleton would
  // flash a card at everyone on every Finance page load, which is the exact
  // thing this guard exists to prevent. Discovery lives in Settings.
  if (connectionsQ.isLoading || !configured || !hasConnections) {
    return null;
  }

  const summary = summaryQ.data;
  const filteredAccount = accountFilter === "all" ? null : accounts.find((a) => a.id === accountFilter) ?? null;
  const needsAction = (connectionsQ.data?.connections ?? []).some((c: any) => c.connectionStatus === "action_required");

  return (
    // .td-scope + the Finance accent: the tracker-popup look for this whole
    // section — hero, tiles, meters and the segmented range control.
    <div className="td-scope space-y-4 min-w-0" style={accentScope(FINANCE_HS.accent, FINANCE_HS.accent2)} data-testid="connected-finance">
      {needsAction && (
        <div className="rounded-lg bg-amber-500/10 px-3 py-2.5 flex items-start gap-2" data-testid="connected-finance-action-banner">
          <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">{financeErrorMessage("relink_required")}</p>
          </div>
          <Button asChild size="sm" variant="outline" className="shrink-0 h-7 text-xs">
            <a href="/settings">Reconnect</a>
          </Button>
        </div>
      )}

      {/* Controls */}
      <div className="space-y-2">
        <TimeRangeSelector
          value={range}
          options={RANGE_OPTIONS}
          onChange={setRange}
          label="Connected finance time frame"
          testId="select-connected-range"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Select value={accountFilter} onValueChange={setAccountFilter}>
            <SelectTrigger className="w-[180px] max-w-full h-8 text-xs" data-testid="select-connected-account">
              <SelectValue placeholder="All accounts" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All accounts</SelectItem>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>{accountLabel(a)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm" variant="outline" className="h-8 text-xs gap-1.5"
            onClick={() => refreshMut.mutate()} disabled={refreshMut.isPending}
            data-testid="btn-connected-refresh"
          >
            {refreshMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Refresh
          </Button>
          <span className="text-[11px] text-muted-foreground ml-auto" data-testid="connected-finance-freshness">
            Updated {relative(summary?.freshness?.newest ?? summary?.netWorth?.balanceAsOf)}
          </span>
        </div>
        {/* Rule 4: an account filter hides the other accounts' money — say so,
            and offer the way back. */}
        {filteredAccount && (
          <p className="text-[11px] text-muted-foreground flex flex-wrap items-center gap-1.5" data-testid="connected-account-filter-note">
            <Info className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span>Showing {accountLabel(filteredAccount)} only.</span>
            <button type="button" className="text-primary hover:underline" onClick={() => setAccountFilter("all")}
              data-testid="btn-connected-account-clear">Show all accounts</button>
          </p>
        )}
      </div>

      <NetWorthCard summary={summary} loading={summaryQ.isLoading}
        failed={summaryQ.isError && !summary} onRetry={() => summaryQ.refetch()} />

      <Tabs defaultValue="accounts" className="w-full">
        <TabsList className="w-full justify-start overflow-x-auto h-9">
          <TabsTrigger value="accounts" className="text-xs" data-testid="tab-connected-accounts">Accounts</TabsTrigger>
          <TabsTrigger value="transactions" className="text-xs" data-testid="tab-connected-transactions">Transactions</TabsTrigger>
          <TabsTrigger value="cashflow" className="text-xs" data-testid="tab-connected-cashflow">Cash flow</TabsTrigger>
          <TabsTrigger value="spending" className="text-xs" data-testid="tab-connected-spending">Spending</TabsTrigger>
          <TabsTrigger value="income" className="text-xs" data-testid="tab-connected-income">Income</TabsTrigger>
          <TabsTrigger value="liabilities" className="text-xs" data-testid="tab-connected-liabilities">Liabilities</TabsTrigger>
        </TabsList>

        <TabsContent value="accounts" className="mt-3">
          <AccountsSection accounts={accounts} />
        </TabsContent>
        <TabsContent value="transactions" className="mt-3">
          <TransactionsSection accounts={accounts} bounds={bounds} accountFilter={accountFilter} />
        </TabsContent>
        <TabsContent value="cashflow" className="mt-3">
          <CashFlowSection bounds={bounds} accountFilter={accountFilter} rangeLabel={RANGE_LABEL[range]} />
        </TabsContent>
        <TabsContent value="spending" className="mt-3">
          <SpendingSection bounds={bounds} accountFilter={accountFilter} rangeLabel={RANGE_LABEL[range]} />
        </TabsContent>
        <TabsContent value="income" className="mt-3">
          <IncomeSection bounds={bounds} accountFilter={accountFilter} rangeLabel={RANGE_LABEL[range]} />
        </TabsContent>
        <TabsContent value="liabilities" className="mt-3">
          <LiabilitiesSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Net worth ───────────────────────────────────────────────────────────────

function NetWorthCard({
  summary, loading, failed, onRetry,
}: { summary: any; loading: boolean; failed?: boolean; onRetry?: () => void }) {
  // Rule 7: a failed summary is not a $0 net worth.
  if (failed) {
    return <FinanceLoadError what="your connected balances" onRetry={() => onRetry?.()} testId="connected-net-worth-error" />;
  }
  if (loading || !summary) {
    return (
      <Card><CardContent className="p-4 space-y-2">
        <Skeleton className="h-4 w-32" /><Skeleton className="h-8 w-48" />
      </CardContent></Card>
    );
  }
  const nw = summary.netWorth ?? {};
  const change = summary.comparison?.spendingChangePct ?? {};
  const totals: MoneyByCurrency = nw.netWorth ?? {};
  const entries = Object.entries(totals);
  // Several currencies are listed side by side, never summed (no FX).
  const display = entries.length === 0
    ? formatMinor(0, "usd")
    : entries.map(([currency, amount]) => formatMinor(amount, currency)).join(" · ");

  return (
    <div className="space-y-2" data-testid="connected-net-worth">
      {/* The label is deliberately "Connected net worth", never "Net worth" —
          Portol only sees linked accounts plus what was typed in. */}
      <HeroMetric
        icon={Landmark}
        eyebrow="Connected net worth"
        display={display}
        delta={nw.deduplicatedManualCount > 0 ? (
          <Badge variant="outline" className="text-[11px] shrink-0" title="A connected account is linked to a manual record, so it is only counted once.">
            {nw.deduplicatedManualCount} deduplicated
          </Badge>
        ) : undefined}
        caption="Linked accounts and records you entered. Not your complete financial picture."
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Metric label="Connected assets" totals={nw.connectedAssets ?? {}} hs={FINANCE_HS.income} icon={Wallet} i={0} testId="metric-connected-assets" />
        <Metric label="Connected debt" totals={nw.connectedLiabilities ?? {}} hs={FINANCE_HS.expense} icon={CreditCard} i={1} testId="metric-connected-liabilities" />
        <Metric label="Manual assets" totals={nw.manualAssets ?? {}} hs="205 80%" icon={PiggyBank} i={2} testId="metric-manual-assets" />
        <Metric label="Manual liabilities" totals={nw.manualLiabilities ?? {}} hs="24 92%" icon={Scale} i={3} testId="metric-manual-liabilities" />
      </div>

      <CoverageNote>
        Balances as of {formatDate(nw.balanceAsOf)}
        {summary.comparison?.currentPeriodIncomplete && " · the current month is still in progress"}
        {Object.keys(change).length > 1 && " · totals are grouped by currency (no conversion)"}
      </CoverageNote>
    </div>
  );
}

function Metric({
  label, totals, hs, icon, i, testId,
}: { label: string; totals: MoneyByCurrency; hs?: string; icon?: typeof Wallet; i?: number; testId?: string }) {
  return (
    <div data-testid={testId} className="min-w-0">
      <StatTile label={label} icon={icon} hs={hs} i={i} value={<MoneyTotal totals={totals} className="tabular-nums" />} />
    </div>
  );
}

// ── Accounts ────────────────────────────────────────────────────────────────

function AccountsSection({ accounts }: { accounts: FinancialAccountRecord[] }) {
  const [detail, setDetail] = useState<FinancialAccountRecord | null>(null);

  const byInstitution = useMemo(() => {
    const map = new Map<string, FinancialAccountRecord[]>();
    for (const a of accounts) {
      const key = a.institutionName || "Other";
      map.set(key, [...(map.get(key) ?? []), a]);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [accounts]);

  if (accounts.length === 0) {
    return <p className="text-sm text-muted-foreground px-1">No connected accounts yet.</p>;
  }

  return (
    <div className="space-y-4" data-testid="connected-accounts-section">
      {byInstitution.map(([institution, list]) => (
        <div key={institution} className="space-y-2">
          <p className="micro-label text-muted-foreground px-1">{institution}</p>
          <div className="bubble divide-y divide-border/40 overflow-hidden">
            {list.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setDetail(a)}
                className="w-full text-left px-3 py-2.5 hover:bg-muted/50 transition-colors flex items-center gap-3"
                data-testid={`account-row-${a.id}`}
              >
                <span className="medallion medallion-sm shrink-0" aria-hidden="true"
                  style={{ ["--accent-hsl" as any]: `${isDebtAccount(a.accountType) ? FINANCE_HS.expense : FINANCE_HS.income} 52%` }}>
                  {isDebtAccount(a.accountType)
                    ? <CreditCard className="h-4 w-4" />
                    : <Wallet className="h-4 w-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{accountLabel(a)}</p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {ACCOUNT_SUBCATEGORY_LABEL[a.accountSubcategory ?? "other"] ?? ACCOUNT_TYPE_LABEL[a.accountType]}
                    {" · "}Updated {relative(a.balanceAsOf)}
                    {a.status !== "active" && ` · ${a.status === "action_required" ? "Needs attention" : a.status}`}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className={cn("text-sm font-semibold tabular-nums", (a.currentBalance ?? 0) < 0 && "text-red-500")}>
                    {a.currentBalance == null ? "—" : formatMinor(a.currentBalance, a.currency)}
                  </p>
                  {a.availableBalance != null && (
                    <p className="text-[11px] text-muted-foreground tabular-nums">
                      {formatMinor(a.availableBalance, a.currency)} available
                    </p>
                  )}
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              </button>
            ))}
          </div>
        </div>
      ))}

      <AccountDetailDialog account={detail} onOpenChange={(open) => !open && setDetail(null)} />
    </div>
  );
}

function AccountDetailDialog({
  account, onOpenChange,
}: { account: FinancialAccountRecord | null; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const patchMut = useMutation({
    mutationFn: async (patch: Record<string, unknown>) =>
      (await apiRequest("PATCH", `/api/finance/accounts/${account!.id}`, patch)).json(),
    onSuccess: () => invalidateFinanceConnections(),
    onError: () => toast({ title: "Couldn't update account", variant: "destructive" }),
  });

  const txnQ = useQuery<{ transactions: FinancialTransactionRecord[] }>({
    queryKey: ["/api/finance/transactions", "account-detail", account?.id],
    queryFn: () => apiRequest("GET", `/api/finance/transactions?accountIds=${account!.id}&limit=15`).then((r) => r.json()),
    enabled: !!account,
    refetchOnWindowFocus: false,
  });

  if (!account) return null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85dvh] overflow-y-auto" data-testid="account-detail-dialog">
        <DialogHeader>
          <DialogTitle>{accountLabel(account)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Field label="Institution" value={account.institutionName ?? "—"} />
            <Field label="Type" value={ACCOUNT_TYPE_LABEL[account.accountType] ?? "Account"} />
            <Field label="Last four" value={account.lastFour ? `••${account.lastFour}` : "Not provided by institution"} />
            <Field label="Currency" value={account.currency.toUpperCase()} />
            <Field label="Current balance" value={account.currentBalance == null ? "Not provided by institution" : formatMinor(account.currentBalance, account.currency)} />
            <Field label="Available balance" value={account.availableBalance == null ? "Not provided by institution" : formatMinor(account.availableBalance, account.currency)} />
            <Field label="Balance as of" value={formatDate(account.balanceAsOf)} />
            <Field label="Connection" value={account.status === "active" ? "Healthy" : account.status === "action_required" ? "Needs attention" : account.status} />
          </div>

          <Separator />

          <div className="flex items-center justify-between gap-3">
            <div>
              <Label className="text-xs font-medium">Include in net worth</Label>
              <p className="text-[11px] text-muted-foreground">Exclude if this account is also tracked manually.</p>
            </div>
            <Switch
              checked={account.includeInNetWorth}
              onCheckedChange={(checked) => patchMut.mutate({ includeInNetWorth: checked })}
              data-testid="switch-detail-networth"
            />
          </div>

          <Separator />

          <div>
            <p className="text-xs font-medium mb-2">Recent transactions</p>
            {txnQ.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : (txnQ.data?.transactions ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">No transactions imported for this account yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {(txnQ.data?.transactions ?? []).map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate">
                      <span className="text-muted-foreground">{formatDate(t.transactionDate)}</span>{" "}
                      {t.merchantName || t.description || "Transaction"}
                    </span>
                    <span className={cn("tabular-nums shrink-0", t.amount < 0 ? "text-red-500" : "text-emerald-600 dark:text-emerald-400")}>
                      {formatMinor(t.amount, t.currency, { signDisplay: "always" })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-sm">{value}</p>
    </div>
  );
}

// ── Transactions ────────────────────────────────────────────────────────────

function TransactionsSection({
  accounts, bounds, accountFilter,
}: {
  accounts: FinancialAccountRecord[];
  bounds: { startDate: string; endDate: string };
  accountFilter: string;
}) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("all");
  const [institution, setInstitution] = useState("all");
  const [selected, setSelected] = useState<FinancialTransactionRecord | null>(null);

  const institutionAccountIds = useMemo(() => {
    if (institution === "all") return null;
    return accounts.filter((a) => (a.institutionName ?? "Other") === institution).map((a) => a.id);
  }, [institution, accounts]);

  const effectiveAccountIds = useMemo(() => {
    if (accountFilter !== "all") return [accountFilter];
    return institutionAccountIds;
  }, [accountFilter, institutionAccountIds]);

  const params = new URLSearchParams({
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    limit: "200",
  });
  if (effectiveAccountIds?.length) params.set("accountIds", effectiveAccountIds.join(","));
  if (search.trim()) params.set("search", search.trim());
  if (category !== "all") params.set("category", category);
  if (type !== "all") params.set("type", type);
  if (status !== "all") params.set("status", status);

  const q = useQuery<{ transactions: FinancialTransactionRecord[]; total: number }>({
    queryKey: ["/api/finance/transactions", params.toString()],
    queryFn: () => apiRequest("GET", `/api/finance/transactions?${params.toString()}`).then((r) => r.json()),
    refetchOnWindowFocus: false,
  });

  const institutions = useMemo(
    () => Array.from(new Set(accounts.map((a) => a.institutionName ?? "Other"))).sort(),
    [accounts],
  );

  const transactions = q.data?.transactions ?? [];

  return (
    <div className="space-y-3" data-testid="connected-transactions-section">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search transactions…"
            className="h-8 pl-8 pr-7 text-xs"
            data-testid="input-txn-search"
          />
          {search && (
            <button
              type="button" onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search" data-testid="btn-clear-txn-search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <Select value={institution} onValueChange={setInstitution}>
          <SelectTrigger className="w-[150px] h-8 text-xs" data-testid="select-txn-institution"><SelectValue placeholder="Institution" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All institutions</SelectItem>
            {institutions.map((i) => <SelectItem key={i} value={i}>{i}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-[140px] h-8 text-xs" data-testid="select-txn-category"><SelectValue placeholder="Category" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            <SelectItem value="uncategorized">Uncategorized</SelectItem>
            {EXPENSE_CATEGORIES.map((c) => <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger className="w-[120px] h-8 text-xs" data-testid="select-txn-type"><SelectValue placeholder="Type" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="income">Income</SelectItem>
            <SelectItem value="expense">Expenses</SelectItem>
            <SelectItem value="transfer">Transfers</SelectItem>
            <SelectItem value="refund">Refunds</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[110px] h-8 text-xs" data-testid="select-txn-status"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any status</SelectItem>
            <SelectItem value="posted">Posted</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : q.isError && !q.data ? (
        <FinanceLoadError what="transactions" onRetry={() => q.refetch()} testId="connected-transactions-error" />
      ) : transactions.length === 0 ? (
        <div className="rounded-xl border border-border/50 px-3 py-8 text-center">
          <p className="text-sm text-muted-foreground">No transactions match these filters.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border/50 divide-y divide-border/40 overflow-hidden">
          {transactions.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSelected(t)}
              className="w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors flex items-center gap-3"
              data-testid={`txn-row-${t.id}`}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate">
                  {t.merchantName || t.description || "Transaction"}
                  {t.override && <span className="ml-1.5 text-[11px] text-muted-foreground">(edited)</span>}
                </p>
                <p className="text-[11px] text-muted-foreground truncate">
                  {formatDate(t.transactionDate)} · {t.accountName ?? "Account"}
                  {t.category && ` · ${t.category}`}
                  {t.isTransfer && " · transfer"}
                  {t.isRefund && " · refund"}
                  {t.excludedFromTotals && " · excluded"}
                </p>
              </div>
              <div className="text-right shrink-0">
                <p className={cn(
                  "text-sm font-medium tabular-nums",
                  t.amount < 0 ? "text-foreground" : "text-emerald-600 dark:text-emerald-400",
                )}>
                  {formatMinor(t.amount, t.currency, { signDisplay: "always" })}
                </p>
                {t.status === "pending" && <Badge variant="outline" className="text-[11px] h-4 px-1">Pending</Badge>}
              </div>
            </button>
          ))}
        </div>
      )}

      <TransactionDetailPanel
        transaction={selected}
        onOpenChange={(open) => !open && setSelected(null)}
      />
    </div>
  );
}

/**
 * Transaction detail panel.
 *
 * Every edit here writes to `financial_transaction_overrides` — a separate
 * table from the imported row — so the next sync refreshes the bank's data
 * without erasing the user's classification, note, or links.
 */
function TransactionDetailPanel({
  transaction, onOpenChange,
}: { transaction: FinancialTransactionRecord | null; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [noteDirty, setNoteDirty] = useState(false);

  const profilesQ = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then((r) => r.json()),
    enabled: !!transaction,
    refetchOnWindowFocus: false,
  });

  const saveMut = useMutation({
    mutationFn: async (patch: Record<string, unknown>) =>
      (await apiRequest("PATCH", `/api/finance/transactions/${transaction!.id}`, patch)).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/finance/transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/spending"] });
      queryClient.invalidateQueries({ queryKey: ["/api/finance/cashflow"] });
    },
    onError: () => toast({ title: "Couldn't save your change", variant: "destructive" }),
  });

  if (!transaction) return null;
  const t = transaction;
  const currentNote = noteDirty ? note : (t.override?.note ?? "");

  const linkableProfiles = (profilesQ.data ?? []).filter((p: any) =>
    ["asset", "liability", "loan", "subscription", "person", "pet", "self"].includes(p.type));

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85dvh] overflow-y-auto" data-testid="txn-detail-panel">
        <DialogHeader>
          <DialogTitle className="truncate">{t.merchantName || t.description || "Transaction"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount" value={formatMinor(t.amount, t.currency, { signDisplay: "always" })} />
            <Field label="Date" value={formatDate(t.transactionDate)} />
            <Field label="Account" value={t.accountName ?? "—"} />
            <Field label="Status" value={t.status === "pending" ? "Pending" : t.status === "void" ? "Void" : "Posted"} />
          </div>
          {t.description && t.description !== t.merchantName && (
            <div>
              <p className="text-[11px] text-muted-foreground">Bank description</p>
              <p className="text-xs font-mono break-words">{t.description}</p>
            </div>
          )}

          <Separator />

          <div>
            <Label className="text-xs font-medium">Category</Label>
            <Select
              value={t.category ?? "uncategorized"}
              onValueChange={(v) => saveMut.mutate({ category: v === "uncategorized" ? null : v })}
            >
              <SelectTrigger className="h-8 text-xs mt-1" data-testid="select-txn-detail-category"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="uncategorized">Uncategorized</SelectItem>
                {EXPENSE_CATEGORIES.map((c) => <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <ToggleRow
              label="Mark as transfer"
              hint="Movement between your own accounts. Excluded from spending and income."
              checked={!!t.isTransfer}
              onChange={(v) => saveMut.mutate({ isTransfer: v })}
              testId="toggle-transfer"
            />
            <ToggleRow
              label="Mark as income"
              hint="Counts toward income totals."
              checked={!!t.isIncome}
              onChange={(v) => saveMut.mutate({ isIncome: v })}
              testId="toggle-income"
            />
            <ToggleRow
              label="Mark as refund"
              hint="Money returned to you. Excluded from income and spending."
              checked={!!t.isRefund}
              onChange={(v) => saveMut.mutate({ isRefund: v })}
              testId="toggle-refund"
            />
            <ToggleRow
              label="Exclude from totals"
              hint="Keeps the record but leaves it out of every calculation."
              checked={!!t.excludedFromTotals}
              onChange={(v) => saveMut.mutate({ excludedFromTotals: v })}
              testId="toggle-excluded"
            />
          </div>

          <Separator />

          <div>
            <Label className="text-xs font-medium">Attach to a record</Label>
            <p className="text-[11px] text-muted-foreground mb-1">
              Link this charge to an asset, liability, subscription, person or profile.
            </p>
            <Select
              value={t.override?.linkedProfileId ?? "none"}
              onValueChange={(v) => saveMut.mutate({ linkedProfileId: v === "none" ? null : v })}
            >
              <SelectTrigger className="h-8 text-xs" data-testid="select-txn-link-profile"><SelectValue placeholder="Not linked" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not linked</SelectItem>
                {linkableProfiles.map((p: any) => (
                  <SelectItem key={p.id} value={p.id}>{p.name} ({p.type})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-xs font-medium">Note</Label>
            <Textarea
              value={currentNote}
              onChange={(e) => { setNote(e.target.value); setNoteDirty(true); }}
              onBlur={() => { if (noteDirty) { saveMut.mutate({ note: note || null }); setNoteDirty(false); } }}
              placeholder="Add a note…"
              className="mt-1 text-xs min-h-[60px]"
              data-testid="input-txn-note"
            />
          </div>

          <p className="text-[11px] text-muted-foreground">
            Your changes are stored separately from the bank's data, so future syncs won't overwrite them.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ToggleRow({
  label, hint, checked, onChange, testId,
}: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; testId: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <Label className="text-xs font-medium">{label}</Label>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} data-testid={testId} />
    </div>
  );
}

// ── Cash flow ───────────────────────────────────────────────────────────────

/** Wider than ~3 months, spending is bucketed by month; otherwise by ISO week. */
function trendGrouping(bounds: { startDate: string; endDate: string }): "week" | "month" {
  const days = (Date.parse(bounds.endDate) - Date.parse(bounds.startDate)) / 86_400_000;
  return Number.isFinite(days) && days > 100 ? "month" : "week";
}

function CashFlowSection({
  bounds, accountFilter, rangeLabel,
}: { bounds: { startDate: string; endDate: string }; accountFilter: string; rangeLabel: string }) {
  const params = new URLSearchParams({ startDate: bounds.startDate, endDate: bounds.endDate });
  if (accountFilter !== "all") params.set("accountIds", accountFilter);

  const q = useQuery<any>({
    queryKey: ["/api/finance/cashflow", params.toString()],
    queryFn: () => apiRequest("GET", `/api/finance/cashflow?${params.toString()}`).then((r) => r.json()),
    refetchOnWindowFocus: false,
  });

  // Spending over the period, bucketed by the server (the same endpoint and
  // key shape the Spending tab reads, so the two share a cache entry).
  const grouping = trendGrouping(bounds);
  const trendParams = new URLSearchParams({ startDate: bounds.startDate, endDate: bounds.endDate, groupBy: grouping });
  if (accountFilter !== "all") trendParams.set("accountIds", accountFilter);
  const trendQ = useQuery<any>({
    queryKey: ["/api/finance/spending", trendParams.toString()],
    queryFn: () => apiRequest("GET", `/api/finance/spending?${trendParams.toString()}`).then((r) => r.json()),
    refetchOnWindowFocus: false,
  });

  if (q.isLoading) return <Skeleton className="h-64 w-full" />;
  if (q.isError && !q.data) {
    return <FinanceLoadError what="cash flow" onRetry={() => q.refetch()} testId="connected-cashflow-error" />;
  }
  const d = q.data ?? {};
  const inflow = singleCurrency(d.inflows);
  const outflow = singleCurrency(d.outflows);
  const flowCurrency = inflow && outflow && inflow.currency === outflow.currency ? inflow.currency
    : inflow && !outflow ? inflow.currency : outflow && !inflow ? outflow.currency : null;
  const trend = periodPoints(trendQ.data?.breakdown ?? []);

  return (
    <div className="space-y-3" data-testid="connected-cashflow-section">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatCard label="Total inflow" totals={d.inflows ?? {}} hs={FINANCE_HS.income} icon={ArrowUpRight} basis={rangeLabel} i={0} testId="cashflow-inflow" />
        <StatCard label="Total outflow" totals={d.outflows ?? {}} hs={FINANCE_HS.expense} icon={ArrowDownRight} basis={rangeLabel} i={1} testId="cashflow-outflow" />
        <StatCard label="Net cash flow" totals={d.net ?? {}} hs={FINANCE_HS.net} icon={ArrowLeftRight} signDisplay="always" basis={rangeLabel} i={2} testId="cashflow-net" />
        <StatCard label="Avg. daily spend" totals={d.averageDailySpend ?? {}} hs="38 90%" icon={CalendarDays} basis={`per day · ${d.dayCount ?? 0}d`} i={3} testId="cashflow-avg-daily" />
      </div>

      {flowCurrency && (
        <div className="bubble p-4" data-testid="cashflow-in-vs-out">
          <SectionTitle title="Money in vs out" hint={`Linked accounts · ${rangeLabel}`} />
          <FlowCompare
            inflow={inflow?.amount ?? 0}
            outflow={outflow?.amount ?? 0}
            net={<MoneyTotal totals={d.net ?? {}} signDisplay="always"
              className={cn((singleCurrency(d.net)?.amount ?? 0) < 0 ? "text-red-500" : "text-emerald-600 dark:text-emerald-400")} />}
            format={(n) => formatMinor(n, flowCurrency)}
          />
        </div>
      )}

      {trend.currency && trend.points.length >= 2 && (
        <div className="bubble p-4" data-testid="cashflow-spend-trend">
          <SectionTitle title={`Spending by ${grouping}`} hint={`Excludes transfers and card payments · ${rangeLabel}`} />
          <PeriodBars data={trend.points} hs={FINANCE_HS.expense}
            format={(n) => formatMinor(n, trend.currency!)}
            compact={(n) => formatMinor(n, trend.currency!, { compact: true })} />
        </div>
      )}

      {/* Honesty line: say what was left out and what is still uncertain. */}
      <p className="text-[11px] text-muted-foreground px-1" data-testid="cashflow-disclosure">
        Over {d.dayCount ?? 0} day{d.dayCount === 1 ? "" : "s"}.
        {" "}{d.excludedTransferCount ?? 0} transfer{d.excludedTransferCount === 1 ? "" : "s"} between your own accounts
        {" "}and credit-card payments were excluded from these totals.
        {(d.uncertainTransferCount ?? 0) > 0 && (
          <> {d.uncertainTransferCount} possible transfer{d.uncertainTransferCount === 1 ? "" : "s"} still need your review and are still counted.</>
        )}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <TransactionMiniList title="Largest expenses" rows={d.largestExpenses ?? []} hs={FINANCE_HS.expense} testId="cashflow-largest-expenses" />
        <TransactionMiniList title="Largest income" rows={d.largestIncome ?? []} hs={FINANCE_HS.income} testId="cashflow-largest-income" />
      </div>
    </div>
  );
}

function StatCard({
  label, totals, hs, icon, signDisplay, basis, i, testId, extra,
}: {
  label: string; totals: MoneyByCurrency; hs?: string;
  icon?: typeof Wallet; signDisplay?: "auto" | "always"; basis?: string; i?: number; testId?: string;
  /** A delta chip under the number. */
  extra?: React.ReactNode;
}) {
  return (
    <div data-testid={testId} className="min-w-0">
      <StatTile
        label={label} icon={icon} hs={hs} i={i} basis={basis}
        value={
          <span className="flex flex-col items-start gap-1">
            <MoneyTotal totals={totals} signDisplay={signDisplay} className="tabular-nums" />
            {extra}
          </span>
        }
      />
    </div>
  );
}

function TransactionMiniList({
  title, rows, hs, testId,
}: { title: string; rows: FinancialTransactionRecord[]; hs: string; testId?: string }) {
  // Bars on one scale per list (amounts may differ in currency; each bar is
  // only compared with rows of its own currency).
  const maxBy = new Map<string, number>();
  for (const t of rows) maxBy.set(t.currency, Math.max(maxBy.get(t.currency) ?? 0, Math.abs(t.amount)));
  return (
    <div className="bubble p-4" style={{ ["--accent-hsl" as any]: `${hs} 52%` }} data-testid={testId}>
      <SectionTitle title={title} />
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing in this period.</p>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((t) => (
            <li key={t.id}>
              <MeterRow
                label={t.merchantName || t.description || "Transaction"}
                value={formatMinor(Math.abs(t.amount), t.currency)}
                pct={(Math.abs(t.amount) / (maxBy.get(t.currency) || 1)) * 100}
                hs={hs}
                sub={formatDate(t.transactionDate)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Spending ────────────────────────────────────────────────────────────────

const GROUP_OPTIONS: ReadonlyArray<{ value: "category" | "merchant" | "account" | "week" | "month"; label: string }> = [
  { value: "category", label: "Category" },
  { value: "merchant", label: "Merchant" },
  { value: "account", label: "Account" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

function SpendingSection({
  bounds, accountFilter, rangeLabel,
}: { bounds: { startDate: string; endDate: string }; accountFilter: string; rangeLabel: string }) {
  const [groupBy, setGroupBy] = useState<(typeof GROUP_OPTIONS)[number]["value"]>("category");
  const params = new URLSearchParams({ startDate: bounds.startDate, endDate: bounds.endDate, groupBy });
  if (accountFilter !== "all") params.set("accountIds", accountFilter);

  const q = useQuery<any>({
    queryKey: ["/api/finance/spending", params.toString()],
    queryFn: () => apiRequest("GET", `/api/finance/spending?${params.toString()}`).then((r) => r.json()),
    refetchOnWindowFocus: false,
  });

  if (q.isLoading) return <Skeleton className="h-64 w-full" />;
  if (q.isError && !q.data) {
    return <FinanceLoadError what="spending" onRetry={() => q.refetch()} testId="connected-spending-error" />;
  }
  const d = q.data ?? {};
  const comparison = d.comparison ?? {};
  const curSpend: MoneyByCurrency = comparison.current?.spending ?? {};
  const prevSpend: MoneyByCurrency = comparison.previous?.spending ?? {};
  const changePct = firstChangePct(comparison.spendingChangePct);
  const curMonth = monthTitle(comparison.current?.start);
  const prevMonth = monthTitle(comparison.previous?.start);
  const rows: BreakdownRow[] = d.breakdown ?? [];
  const byTime = groupBy === "week" || groupBy === "month";

  return (
    <div className="space-y-3" data-testid="connected-spending-section">
      {/* Rule 15: two ledgers, never merged — this one is linked accounts only. */}
      <p className="text-[11px] text-muted-foreground" data-testid="connected-spending-ledger-note">
        Connected ledger (linked accounts only). Expenses you logged by hand are counted on the Money overview, not here.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <StatCard label="Spending this month" totals={curSpend} hs={FINANCE_HS.expense} icon={ArrowDownRight}
          basis={curMonth ?? undefined} i={0} testId="spend-current"
          extra={changePct != null ? <DeltaChip pct={changePct} good={changePct <= 0} label="vs last month" /> : undefined} />
        <StatCard label="Spending last month" totals={prevSpend} hs="215 14%" icon={CalendarDays}
          basis={prevMonth ?? undefined} i={1} testId="spend-previous" />
        <div data-testid="spend-change" className="min-w-0 col-span-2 sm:col-span-1">
          <StatTile label="Month over month" icon={TrendingUp} i={2}
            hs={changePct == null ? undefined : changePct > 0 ? FINANCE_HS.expense : FINANCE_HS.income}
            basis={changePct == null ? "no earlier month to compare" : changePct > 0 ? "spending more" : changePct < 0 ? "spending less" : "about the same"}
            value={changePct == null ? "—" : `${changePct > 0 ? "+" : ""}${firstChangePctExact(comparison.spendingChangePct)}%`} />
        </div>
      </div>

      {comparison.currentPeriodIncomplete && (
        <p className="text-[11px] text-muted-foreground px-1" data-testid="spend-incomplete-note">
          This month isn't over yet, so the comparison isn't like-for-like.
        </p>
      )}
      <p className="text-[11px] text-muted-foreground px-1">
        Excludes internal transfers, matched credit-card payments, refunds, and anything you excluded by hand.
      </p>

      <div className="bubble p-4 space-y-3">
        <SectionTitle title={`Spending by ${groupBy}`} hint={`Linked accounts · ${rangeLabel}`} />
        <TimeRangeSelector value={groupBy} options={GROUP_OPTIONS} onChange={setGroupBy}
          label="Group spending by" testId="select-spend-groupby" />
        {byTime
          ? <SpendingOverTime rows={rows} grouping={groupBy as "week" | "month"} />
          : <SpendingDonut rows={rows} groupBy={groupBy} />}
        <BreakdownList rows={rows} collapsed={!byTime} testId="spend-breakdown" />
      </div>

      {(d.recurring ?? []).length > 0 && (
        <RecurringList groups={d.recurring} testId="spend-recurring" />
      )}

      {(d.unusual ?? []).length > 0 && (
        <div className="bubble p-4" style={{ ["--accent-hsl" as any]: "38 90% 52%" }} data-testid="spend-unusual">
          <SectionTitle title="Unusual spending" hint="Charges well above what this kind of spend usually costs you" />
          <ul className="space-y-2">
            {d.unusual.map((u: any) => (
              <li key={u.transaction.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate">
                  {u.transaction.merchantName || u.transaction.description}
                  <span className="text-muted-foreground"> · {u.multiple}× the usual {u.transaction.category ?? "charge"}</span>
                </span>
                <span className="tabular-nums font-semibold shrink-0">{formatMinor(Math.abs(u.transaction.amount), u.transaction.currency)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One decimal, as the tile always showed it ("+12.5%"). */
function firstChangePctExact(map: Record<string, number | null> | null | undefined): string {
  const first = Object.values(map ?? {})[0];
  return typeof first === "number" && Number.isFinite(first) ? first.toFixed(1) : "—";
}

function SpendingDonut({ rows, groupBy }: { rows: BreakdownRow[]; groupBy: string }) {
  const { currency, slices, total, otherCurrencies } = breakdownSlices(rows, { max: 7 });
  if (!currency || slices.length === 0) return null;
  return (
    <div className="space-y-2">
      <CategoryBreakdown
        slices={slices.map((sl) => ({ ...sl, label: groupBy === "category" ? capitalize(sl.label) : sl.label }))}
        total={total}
        format={(n) => formatMinor(n, currency)}
        centerLabel={`Spent · ${currency.toUpperCase()}`}
        testId="spend-donut"
      />
      {otherCurrencies.length > 0 && (
        <CoverageNote>
          The chart shows {currency.toUpperCase()} only. Spending in {otherCurrencies.map((c) => c.toUpperCase()).join(", ")} is listed below — Portol does not convert between currencies.
        </CoverageNote>
      )}
    </div>
  );
}

function SpendingOverTime({ rows, grouping }: { rows: BreakdownRow[]; grouping: "week" | "month" }) {
  const { currency, points } = periodPoints(rows);
  if (!currency || points.length === 0) return null;
  return (
    <PeriodBars data={points} hs={FINANCE_HS.expense} testId="spend-period-bars"
      format={(n) => formatMinor(n, currency)}
      compact={(n) => formatMinor(n, currency, { compact: true })}
      height={grouping === "month" ? 180 : 168} />
  );
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function BreakdownList({ rows, collapsed, testId }: { rows: BreakdownRow[]; collapsed?: boolean; testId?: string }) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) {
    return (
      <div className="px-3 py-6 text-center" data-testid={testId}>
        <p className="text-sm text-muted-foreground">No spending in this period.</p>
      </div>
    );
  }
  // Under the donut the full list is one tap away rather than repeated.
  if (collapsed && !open) {
    return (
      <div data-testid={testId}>
        <Button variant="ghost" size="sm" className="w-full h-8 text-xs gap-1" onClick={() => setOpen(true)} data-testid="btn-spend-breakdown-all">
          All {Math.min(rows.length, 20)} rows <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }
  const maxBy = new Map<string, number>();
  for (const r of rows) maxBy.set(r.currency, Math.max(maxBy.get(r.currency) ?? 0, r.amount));
  return (
    <div className="divide-y divide-border/40 -mx-1" data-testid={testId}>
      {rows.slice(0, 20).map((r) => (
        <div key={`${r.key}-${r.currency}`} className="px-1 py-2">
          <div className="flex items-center justify-between gap-2 text-xs mb-1">
            <span className="truncate capitalize">{periodLabel(r.label) === r.label ? r.label : `${periodLabel(r.label)} · ${r.label}`}</span>
            <span className="tabular-nums shrink-0">
              {formatMinor(r.amount, r.currency)}
              {r.sharePct != null && <span className="text-muted-foreground ml-1.5">{r.sharePct.toFixed(0)}%</span>}
            </span>
          </div>
          <div className="td-meter">
            <span style={{ width: `${Math.max(2, (r.amount / (maxBy.get(r.currency) || 1)) * 100)}%`, background: `linear-gradient(90deg, ${tone(FINANCE_HS.expense)}, ${tone(FINANCE_HS.expense, 0.6)})` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Probable recurring charges, shown separately with an explicit
 * "Save as subscription" action. Nothing is created automatically — the user
 * confirms before Portol makes a subscription profile.
 */
function RecurringList({ groups, testId }: { groups: RecurringGroup[]; testId?: string }) {
  const { toast } = useToast();
  const [saving, setSaving] = useState<string | null>(null);

  const saveMut = useMutation({
    mutationFn: async (g: RecurringGroup) => {
      // Reuses the existing profile system rather than inventing a parallel
      // subscription model, so it lands in the same lists, calendar and
      // dashboard the user already has.
      const res = await apiRequest("POST", "/api/profiles", {
        name: g.merchantName,
        type: "subscription",
        type_key: "subscription",
        notes: `Detected from connected bank data — ${g.cadence} charge, ${g.occurrences} occurrences.`,
        fields: {
          finance: {
            amount: minorToMajor(g.typicalAmount, g.currency),
            frequency: g.cadence === "irregular" ? "monthly" : g.cadence,
          },
          source: "stripe_financial_connections",
        },
        tags: ["detected"],
      });
      return res.json();
    },
    onSuccess: (_d, g) => {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      toast({ title: "Saved as subscription", description: `${g.merchantName} was added to your subscriptions.` });
    },
    onError: () => toast({ title: "Couldn't save subscription", variant: "destructive" }),
    onSettled: () => setSaving(null),
  });

  return (
    <div className="bubble p-4" style={{ ["--accent-hsl" as any]: "275 65% 52%" }} data-testid={testId}>
      <div className="flex items-center gap-2 mb-3">
        <span className="medallion medallion-sm" aria-hidden="true"><Repeat className="h-4 w-4" /></span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold tracking-tight">Probable recurring charges</h3>
          <p className="text-xs text-muted-foreground">Nothing is saved until you choose to.</p>
        </div>
      </div>
      <div>
        <ul className="space-y-2.5">
          {groups.slice(0, 10).map((g) => (
            <li key={g.key} className="flex items-center justify-between gap-2" data-testid={`recurring-${g.key}`}>
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{g.merchantName}</p>
                <p className="text-[11px] text-muted-foreground">
                  {formatMinor(g.typicalAmount, g.currency)} · {g.cadence} · {g.occurrences} charges
                  {g.nextExpectedDate && ` · next ~${formatDate(g.nextExpectedDate)}`}
                </p>
              </div>
              <Button
                size="sm" variant="outline" className="h-7 text-[11px] shrink-0"
                disabled={saving === g.key}
                onClick={() => { setSaving(g.key); saveMut.mutate(g); }}
                data-testid={`btn-save-subscription-${g.key}`}
              >
                {saving === g.key ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save as subscription"}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ── Income ──────────────────────────────────────────────────────────────────

function IncomeSection({
  bounds, accountFilter, rangeLabel,
}: { bounds: { startDate: string; endDate: string }; accountFilter: string; rangeLabel: string }) {
  const params = new URLSearchParams({ startDate: bounds.startDate, endDate: bounds.endDate });
  if (accountFilter !== "all") params.set("accountIds", accountFilter);

  const q = useQuery<any>({
    queryKey: ["/api/finance/income", params.toString()],
    queryFn: () => apiRequest("GET", `/api/finance/income?${params.toString()}`).then((r) => r.json()),
    refetchOnWindowFocus: false,
  });

  if (q.isLoading) return <Skeleton className="h-64 w-full" />;
  if (q.isError && !q.data) {
    return <FinanceLoadError what="income" onRetry={() => q.refetch()} testId="connected-income-error" />;
  }
  const d = q.data ?? {};
  const changePct = firstChangePct(d.comparison?.incomeChangePct);
  const sources = breakdownSlices(d.bySource ?? [], { max: 6 });

  return (
    <div className="space-y-3" data-testid="connected-income-section">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <StatCard label="Income this period" totals={d.total ?? {}} hs={FINANCE_HS.income} icon={ArrowUpRight}
          basis={rangeLabel} i={0} testId="income-total" />
        <StatCard label="Last month" totals={d.comparison?.previous?.income ?? {}} hs="215 14%" icon={CalendarDays}
          basis={monthTitle(d.comparison?.previous?.start) ?? undefined} i={1} testId="income-previous" />
        <div data-testid="income-trend" className="min-w-0 col-span-2 sm:col-span-1">
          <StatTile label="Trend" icon={TrendingUp} i={2}
            hs={changePct == null ? undefined : changePct < 0 ? FINANCE_HS.expense : FINANCE_HS.income}
            basis={changePct == null ? "no earlier month to compare" : "month over month"}
            value={
              <span className="flex flex-wrap items-center gap-2">
                <span>{changePct == null ? "—" : `${changePct > 0 ? "+" : ""}${firstChangePctExact(d.comparison?.incomeChangePct)}%`}</span>
                {changePct != null && <DeltaChip pct={changePct} good={changePct >= 0} />}
              </span>
            } />
        </div>
      </div>

      <div className="bubble p-4" data-testid="income-by-source">
        <SectionTitle title="Income by source" hint={`Linked accounts · ${rangeLabel}`} />
        {(d.bySource ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">No income identified in this period.</p>
        ) : sources.currency && sources.slices.length > 0 ? (
          <div className="space-y-2">
            <CategoryBreakdown
              slices={sources.slices}
              total={sources.total}
              format={(n) => formatMinor(n, sources.currency!)}
              centerLabel={`Income · ${sources.currency.toUpperCase()}`}
              testId="income-donut"
            />
            {sources.otherCurrencies.length > 0 && (
              <ul className="space-y-1.5 pt-1">
                {(d.bySource as BreakdownRow[]).filter((r) => r.currency !== sources.currency).map((r) => (
                  <li key={`${r.key}-${r.currency}`} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate">{r.label}</span>
                    <span className="tabular-nums shrink-0">{formatMinor(r.amount, r.currency)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>

      {(d.recurring ?? []).length > 0 && (
        <div className="bubble p-4" style={{ ["--accent-hsl" as any]: `${FINANCE_HS.income} 52%` }} data-testid="income-recurring">
          <SectionTitle title="Recurring income" hint="Deposits that arrive on a schedule" />
          <ul className="space-y-2">
            {d.recurring.map((g: RecurringGroup) => (
              <li key={g.key} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate">{g.merchantName} <span className="text-muted-foreground">· {g.cadence}</span></span>
                <span className="tabular-nums font-semibold shrink-0 text-emerald-600 dark:text-emerald-400">{formatMinor(g.typicalAmount, g.currency)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Deposits we deliberately did NOT call income. */}
      <div className="bubble p-4" data-testid="income-needs-review">
        <SectionTitle title="Deposits requiring review" />
        {(d.needsReview ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing needs review.</p>
        ) : (
          <>
            <p className="text-[11px] text-muted-foreground mb-2">
              These deposits could be transfers, refunds or reimbursements, so they are not counted as income.
              Open a transaction to classify it.
            </p>
            <ul className="space-y-1.5">
              {d.needsReview.slice(0, 15).map((t: FinancialTransactionRecord) => (
                <li key={t.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate">{formatDate(t.transactionDate)} · {t.merchantName || t.description}</span>
                  <span className="tabular-nums shrink-0 text-emerald-600 dark:text-emerald-400">
                    {formatMinor(t.amount, t.currency)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

// ── Liabilities ─────────────────────────────────────────────────────────────

function LiabilitiesSection() {
  const q = useQuery<any>({
    queryKey: ["/api/finance/liabilities"],
    queryFn: () => apiRequest("GET", "/api/finance/liabilities").then((r) => r.json()),
    refetchOnWindowFocus: false,
  });

  if (q.isLoading) return <Skeleton className="h-48 w-full" />;
  if (q.isError && !q.data) {
    return <FinanceLoadError what="connected liabilities" onRetry={() => q.refetch()} testId="connected-liabilities-error" />;
  }
  const rows = q.data?.liabilities ?? [];

  if (rows.length === 0) {
    return (
      <div className="bubble px-3 py-8 text-center" data-testid="connected-liabilities-empty">
        <p className="text-sm text-muted-foreground">No connected credit cards or loans.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="connected-liabilities-section">
      {rows.map((row: any) => (
        <Card key={row.account.id} data-testid={`liability-${row.account.id}`}>
          <CardContent className="p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{accountLabel(row.account)}</p>
                <p className="text-[11px] text-muted-foreground">
                  {row.institutionName} · {ACCOUNT_TYPE_LABEL[row.accountType as keyof typeof ACCOUNT_TYPE_LABEL] ?? "Debt"}
                </p>
              </div>
              <p className="text-sm font-semibold tabular-nums text-red-500 shrink-0">
                {row.currentBalance == null ? "—" : formatMinor(Math.abs(row.currentBalance), row.currency)}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-[11px]">
              {/* Stripe Financial Connections does not expose these fields.
                  We say so rather than inventing a number. */}
              <div>
                <p className="text-muted-foreground">Minimum payment</p>
                <p>{row.minimumPayment ?? "Not provided by institution"}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Payment due</p>
                <p>{row.paymentDueDate ?? "Not provided by institution"}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Interest rate</p>
                <p>{row.interestRate ?? "Not provided by institution"}</p>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {row.includeInNetWorth ? "Counted in connected net worth" : "Excluded from net worth"}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
