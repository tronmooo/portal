/**
 * Settings → Connections → Finance.
 *
 * Renders every state the connection can be in — not connected, connecting,
 * connected, action required, failed — plus the management actions (refresh,
 * manage accounts, reconnect, disconnect, disconnect + delete).
 *
 * Two rules this component exists to enforce:
 *   1. The loading state ALWAYS ends. Cancelling or closing Stripe's modal
 *      resolves the promise, and every exit path clears `busy` in a finally.
 *   2. The user never sees a raw Stripe error. Codes come back from the server
 *      and are translated by `financeErrorMessage` from shared code.
 */

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Landmark, RefreshCw, ShieldCheck, AlertTriangle, Loader2, Settings2, Unplug, Trash2, Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { runConnectFlow } from "@/lib/stripe-connect";
import {
  financeErrorMessage, ACCOUNT_TYPE_LABEL,
  type FinanceConnectionState, type FinancialAccountRecord, type FinancialConnectionRecord,
} from "@shared/finance-connections";
import { formatMinor } from "@shared/money";
import { cn } from "@/lib/utils";

const FINANCE_QUERY_KEY = ["/api/finance/connections"];

/** Invalidate everything that reads connected finance data. */
export function invalidateFinanceConnections(): void {
  queryClient.invalidateQueries({ queryKey: FINANCE_QUERY_KEY });
  queryClient.invalidateQueries({ queryKey: ["/api/finance/accounts"] });
  queryClient.invalidateQueries({ queryKey: ["/api/finance/summary"] });
  queryClient.invalidateQueries({ queryKey: ["/api/finance/transactions"] });
  queryClient.invalidateQueries({ queryKey: ["/api/finance/sync-runs"] });
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "never";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function accountLabel(a: FinancialAccountRecord): string {
  const name = a.accountDisplayName || a.accountName || "Account";
  return a.lastFour ? `${name} ••${a.lastFour}` : name;
}

export function FinanceConnectionCard() {
  const { toast } = useToast();
  const [connecting, setConnecting] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [disconnectTarget, setDisconnectTarget] = useState<{ id: string; deleteData: boolean } | null>(null);

  const { data, isLoading } = useQuery<FinanceConnectionState & { livemode?: boolean }>({
    queryKey: FINANCE_QUERY_KEY,
    queryFn: () => apiRequest("GET", "/api/finance/connections").then((r) => r.json()),
    refetchOnWindowFocus: false,
  });

  const refreshMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/finance/refresh", {});
      return res.json();
    },
    onSuccess: (result: any) => {
      invalidateFinanceConnections();
      if (result?.status === "failed") {
        toast({
          title: "Refresh failed",
          description: financeErrorMessage(result.errorCode),
          variant: "destructive",
        });
        return;
      }
      const imported = (result?.transactionsInserted ?? 0) + (result?.transactionsUpdated ?? 0);
      toast({
        title: result?.status === "partial" ? "Partly refreshed" : "Refreshed",
        description: result?.status === "partial"
          ? financeErrorMessage(result.accountErrors?.[0] ?? "partial_import")
          : `${result?.accountsProcessed ?? 0} account${result?.accountsProcessed === 1 ? "" : "s"} updated, ${imported} transaction${imported === 1 ? "" : "s"} synced.`,
      });
    },
    onError: (err: any) => {
      const rateLimited = /\b429\b/.test(String(err?.message ?? ""));
      toast({
        title: "Couldn't refresh",
        description: financeErrorMessage(rateLimited ? "rate_limited" : "unknown"),
        variant: "destructive",
      });
    },
  });

  const disconnectMut = useMutation({
    mutationFn: async ({ id, deleteData }: { id: string; deleteData: boolean }) => {
      const res = await apiRequest("POST", `/api/finance/connections/${id}/disconnect`, { deleteData });
      return res.json();
    },
    onSuccess: (result: any, vars) => {
      invalidateFinanceConnections();
      // Manual assets, liabilities, expenses and subscriptions are untouched by
      // either path — say so, so the user isn't left wondering.
      toast({
        title: vars.deleteData ? "Disconnected and data removed" : "Disconnected",
        description: vars.deleteData
          ? `Removed ${result?.transactionsDeleted ?? 0} imported transaction${result?.transactionsDeleted === 1 ? "" : "s"}. Your manually entered records were kept.`
          : "Syncing has stopped. Everything already imported is still here.",
      });
      setDisconnectTarget(null);
    },
    onError: () => {
      toast({ title: "Couldn't disconnect", description: financeErrorMessage("unknown"), variant: "destructive" });
      setDisconnectTarget(null);
    },
  });

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const outcome = await runConnectFlow();
      if (outcome.kind === "completed") {
        invalidateFinanceConnections();
        toast({
          title: "Bank connected",
          description: `${outcome.accountCount} account${outcome.accountCount === 1 ? "" : "s"} linked. Importing balances and transactions now.`,
        });
      } else if (outcome.kind === "cancelled") {
        invalidateFinanceConnections();
        toast({ title: "Connection cancelled", description: "No accounts were linked." });
      } else {
        invalidateFinanceConnections();
        toast({ title: "Couldn't connect", description: financeErrorMessage(outcome.code), variant: "destructive" });
      }
    } finally {
      // The single place the connecting state ends — a thrown error, a
      // cancellation and a success all pass through here, so the card can never
      // be stuck spinning.
      setConnecting(false);
    }
  };

  const configured = data?.configured !== false;
  const connections = (data?.connections ?? []).filter((c) => c.connectionStatus !== "disconnected");
  const accounts = data?.accounts ?? [];
  const status = data?.status ?? "not_connected";

  return (
    <div className="space-y-4" data-testid="finance-connection-card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="h-8 w-8 shrink-0 rounded-lg bg-emerald-500/10 flex items-center justify-center">
            <Landmark className="h-4 w-4 text-emerald-500" />
          </div>
          <div className="min-w-0">
            <Label className="text-sm font-medium">Finance</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Connect a bank, credit card, or loan account to import balances and transactions.
            </p>
          </div>
        </div>
        <StatusBadge status={status} loading={isLoading} configured={configured} />
      </div>

      {/* Test-mode disclosure — a user must know when the data is not real. */}
      {configured && data?.livemode === false && connections.length > 0 && (
        <p className="text-[11px] text-amber-600 dark:text-amber-500" data-testid="finance-testmode-note">
          Connected in Stripe test mode — balances and transactions are sandbox data.
        </p>
      )}

      {!configured ? (
        <NotConfigured />
      ) : connections.length === 0 ? (
        <NotConnected onConnect={handleConnect} connecting={connecting} />
      ) : (
        <Connected
          connections={connections}
          accounts={accounts}
          lastSyncAt={data?.lastSync?.completedAt ?? data?.lastSync?.startedAt ?? null}
          refreshing={refreshMut.isPending}
          connecting={connecting}
          onRefresh={() => refreshMut.mutate()}
          onReconnect={handleConnect}
          onManage={() => setManageOpen(true)}
          onDisconnect={(id, deleteData) => setDisconnectTarget({ id, deleteData })}
        />
      )}

      <ManageAccountsDialog open={manageOpen} onOpenChange={setManageOpen} accounts={accounts} />

      <AlertDialog
        open={!!disconnectTarget}
        onOpenChange={(open) => { if (!open) setDisconnectTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {disconnectTarget?.deleteData ? "Disconnect and delete imported data?" : "Disconnect this institution?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {disconnectTarget?.deleteData
                ? "This revokes Portol's access, stops syncing, and permanently deletes the accounts and transactions imported from this institution. Assets, liabilities, expenses and subscriptions you entered yourself are kept. This cannot be undone."
                : "This revokes Portol's access and stops future syncing. Everything already imported stays in your Finance tab."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="btn-disconnect-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={disconnectTarget?.deleteData ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
              onClick={() => disconnectTarget && disconnectMut.mutate(disconnectTarget)}
              data-testid="btn-disconnect-confirm"
            >
              {disconnectMut.isPending ? "Working…" : disconnectTarget?.deleteData ? "Delete and disconnect" : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function StatusBadge({ status, loading, configured }: { status: string; loading: boolean; configured: boolean }) {
  if (loading) return <Badge variant="outline" className="text-xs">Checking…</Badge>;
  if (!configured) return <Badge variant="outline" className="text-xs" data-testid="finance-badge-unavailable">Unavailable</Badge>;
  if (status === "connected") {
    return (
      <Badge className="text-xs bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-transparent" data-testid="finance-badge-connected">
        Connected
      </Badge>
    );
  }
  if (status === "action_required") {
    return <Badge className="text-xs bg-amber-500/15 text-amber-600 dark:text-amber-400 border-transparent" data-testid="finance-badge-action">Action needed</Badge>;
  }
  if (status === "failed") {
    return <Badge variant="destructive" className="text-xs" data-testid="finance-badge-failed">Sync failed</Badge>;
  }
  return <Badge variant="outline" className="text-xs" data-testid="finance-badge-not-connected">Not connected</Badge>;
}

function NotConfigured() {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-3" data-testid="finance-not-configured">
      <p className="text-xs text-muted-foreground">
        {financeErrorMessage("not_configured")}
      </p>
    </div>
  );
}

function NotConnected({ onConnect, connecting }: { onConnect: () => void; connecting: boolean }) {
  return (
    <div className="rounded-lg border border-border/60 px-3 py-3 space-y-3" data-testid="finance-not-connected">
      <div className="flex items-start gap-2">
        <ShieldCheck className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
        <p className="text-xs text-muted-foreground">
          You sign in <strong className="font-medium text-foreground">directly with your bank</strong> inside
          Stripe's secure window. Portol never sees or stores your banking username or password.
        </p>
      </div>

      <div className="space-y-1">
        <p className="micro-label text-muted-foreground">Portol will request</p>
        <ul className="text-xs text-muted-foreground space-y-0.5">
          <li>• Account details — institution, account name, and last four digits</li>
          <li>• Balances — current and available</li>
          <li>• Transactions — so spending, income and cash flow stay up to date</li>
        </ul>
      </div>

      <Button
        onClick={onConnect}
        disabled={connecting}
        className="w-full sm:w-auto gap-2"
        data-testid="btn-connect-financial-account"
      >
        {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Landmark className="h-4 w-4" />}
        {connecting ? "Opening your bank…" : "Connect Financial Account"}
      </Button>
      {connecting && (
        <p className="text-[11px] text-muted-foreground" data-testid="finance-connecting-hint">
          A Stripe window is opening. Choose your institution and sign in there — you can close it any time to cancel.
        </p>
      )}
    </div>
  );
}

function Connected({
  connections, accounts, lastSyncAt, refreshing, connecting,
  onRefresh, onReconnect, onManage, onDisconnect,
}: {
  connections: FinancialConnectionRecord[];
  accounts: FinancialAccountRecord[];
  lastSyncAt: string | null;
  refreshing: boolean;
  connecting: boolean;
  onRefresh: () => void;
  onReconnect: () => void;
  onManage: () => void;
  onDisconnect: (connectionId: string, deleteData: boolean) => void;
}) {
  return (
    <div className="space-y-3" data-testid="finance-connected">
      {connections.map((conn) => {
        const connAccounts = accounts.filter((a) => a.financialConnectionId === conn.id);
        const needsAction = conn.connectionStatus === "action_required"
          || connAccounts.some((a) => a.status === "action_required" || a.status === "inactive");
        const failed = conn.connectionStatus === "failed";

        return (
          <div
            key={conn.id}
            className="rounded-lg border border-border/60 px-3 py-3 space-y-3"
            data-testid={`finance-connection-${conn.id}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{conn.institutionName || "Financial institution"}</p>
                <p className="text-xs text-muted-foreground">
                  {connAccounts.length} linked account{connAccounts.length === 1 ? "" : "s"}
                  {" · "}
                  Last sync {relativeTime(conn.lastSuccessfulSyncAt ?? lastSyncAt)}
                </p>
              </div>
              <ConnectionHealth status={conn.connectionStatus} />
            </div>

            {/* Linked accounts with last four and balance freshness. */}
            {connAccounts.length > 0 && (
              <ul className="space-y-1" data-testid={`finance-accounts-${conn.id}`}>
                {connAccounts.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate">
                      <span className="text-foreground">{accountLabel(a)}</span>
                      <span className="text-muted-foreground"> · {ACCOUNT_TYPE_LABEL[a.accountType] ?? "Account"}</span>
                    </span>
                    <span className={cn(
                      "shrink-0 tabular-nums",
                      a.currentBalance != null && a.currentBalance < 0 ? "text-red-500" : "text-muted-foreground",
                    )}>
                      {a.currentBalance == null ? "—" : formatMinor(a.currentBalance, a.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {(needsAction || failed) && (
              <div
                className={cn(
                  "rounded-md px-2.5 py-2 flex items-start gap-2",
                  failed ? "bg-destructive/10" : "bg-amber-500/10",
                )}
                data-testid={`finance-alert-${conn.id}`}
              >
                <AlertTriangle className={cn("h-3.5 w-3.5 mt-0.5 shrink-0", failed ? "text-destructive" : "text-amber-500")} />
                <p className="text-xs text-muted-foreground">
                  {financeErrorMessage(conn.lastSyncError ?? (needsAction ? "relink_required" : "unknown"))}
                </p>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {needsAction ? (
                <Button size="sm" onClick={onReconnect} disabled={connecting} className="gap-1.5" data-testid={`btn-reconnect-${conn.id}`}>
                  {connecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Reconnect
                </Button>
              ) : failed ? (
                <Button size="sm" onClick={onRefresh} disabled={refreshing} className="gap-1.5" data-testid={`btn-retry-${conn.id}`}>
                  {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Try again
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={onRefresh} disabled={refreshing} className="gap-1.5" data-testid={`btn-refresh-${conn.id}`}>
                  {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  {refreshing ? "Refreshing…" : "Refresh now"}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={onManage} className="gap-1.5" data-testid={`btn-manage-${conn.id}`}>
                <Settings2 className="h-3.5 w-3.5" /> Manage accounts
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onDisconnect(conn.id, false)} className="gap-1.5" data-testid={`btn-disconnect-${conn.id}`}>
                <Unplug className="h-3.5 w-3.5" /> Disconnect
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onDisconnect(conn.id, true)}
                className="gap-1.5 text-destructive hover:text-destructive"
                data-testid={`btn-disconnect-delete-${conn.id}`}
              >
                <Trash2 className="h-3.5 w-3.5" /> Remove imported data
              </Button>
            </div>
          </div>
        );
      })}

      <Button variant="outline" size="sm" onClick={onReconnect} disabled={connecting} className="gap-1.5" data-testid="btn-connect-another">
        {connecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Landmark className="h-3.5 w-3.5" />}
        Connect another institution
      </Button>
    </div>
  );
}

function ConnectionHealth({ status }: { status: string }) {
  if (status === "active") {
    return (
      <span className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 shrink-0">
        <Check className="h-3 w-3" /> Healthy
      </span>
    );
  }
  if (status === "action_required") {
    return <span className="text-[11px] text-amber-600 dark:text-amber-400 shrink-0">Needs attention</span>;
  }
  if (status === "failed") return <span className="text-[11px] text-destructive shrink-0">Failed</span>;
  return <span className="text-[11px] text-muted-foreground shrink-0">Connecting…</span>;
}

/**
 * Per-account controls: rename, hide, and include/exclude from net worth.
 * Excluding an account is how a user stops a connected balance double-counting
 * with something they track by hand.
 */
function ManageAccountsDialog({
  open, onOpenChange, accounts,
}: { open: boolean; onOpenChange: (open: boolean) => void; accounts: FinancialAccountRecord[] }) {
  const { toast } = useToast();

  const patchMut = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Record<string, unknown> }) => {
      const res = await apiRequest("PATCH", `/api/finance/accounts/${id}`, patch);
      return res.json();
    },
    onSuccess: () => invalidateFinanceConnections(),
    onError: () => toast({ title: "Couldn't update account", variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Manage connected accounts</DialogTitle>
          <DialogDescription>
            Choose which accounts appear in Portol and which count toward your connected net worth.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {accounts.length === 0 && (
            <p className="text-sm text-muted-foreground">No connected accounts yet.</p>
          )}
          {accounts.map((a, i) => (
            <div key={a.id} className="space-y-2" data-testid={`manage-account-${a.id}`}>
              {i > 0 && <Separator />}
              <div className="pt-1">
                <p className="text-sm font-medium">{accountLabel(a)}</p>
                <p className="text-xs text-muted-foreground">
                  {a.institutionName} · {ACCOUNT_TYPE_LABEL[a.accountType] ?? "Account"}
                  {a.currentBalance != null && ` · ${formatMinor(a.currentBalance, a.currency)}`}
                </p>
              </div>

              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label className="text-xs font-medium">Include in net worth</Label>
                  <p className="text-[11px] text-muted-foreground">
                    Turn off if you already track this account manually.
                  </p>
                </div>
                <Switch
                  checked={a.includeInNetWorth}
                  onCheckedChange={(checked) => patchMut.mutate({ id: a.id, patch: { includeInNetWorth: checked } })}
                  data-testid={`switch-networth-${a.id}`}
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label className="text-xs font-medium">Hide from Finance</Label>
                  <p className="text-[11px] text-muted-foreground">
                    Hidden accounts stop appearing in lists. Imported data is kept.
                  </p>
                </div>
                <Switch
                  checked={a.isHidden}
                  onCheckedChange={(checked) => patchMut.mutate({ id: a.id, patch: { isHidden: checked } })}
                  data-testid={`switch-hidden-${a.id}`}
                />
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
