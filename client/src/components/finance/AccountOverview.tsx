// ── The account profile page ─────────────────────────────────────────────────
//
// An account IS a profile, so it opens the same detail page as a car or a
// house. But "what is this thing?" has a completely different answer for a
// credit card than for a Honda Civic, and the generic asset Overview — which
// shows trackers and nothing else — answered it for neither.
//
// This is the account's own identity block. Every figure comes from
// shared/finance-accounts.ts, the same helpers the Finance tab, the server and
// the AI use, so the balance shown here is the balance everywhere.
//
// WHAT RENDERS IS KIND-DEPENDENT, on purpose. A checking account has no credit
// limit and no utilization, so it shows neither — a row reading "Credit limit —"
// costs a line of screen to say nothing. A credit card leads with what is OWED
// and how much of the line is used. Eight kinds, eight genuinely different
// cards, from one component.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { invalidateDomains } from "@/lib/cache-bus";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { History } from "lucide-react";
import { formatMoney, formatListDate } from "@/lib/format";
import { toAccountView } from "@shared/finance-accounts";

/** How stale is this balance? Drives the "as of" caption's tone. */
function staleness(asOf: string | null, todayISO: string): { label: string; stale: boolean } {
  if (!asOf) return { label: "never updated", stale: true };
  const days = Math.round(
    (new Date(todayISO + "T00:00:00").getTime() - new Date(asOf + "T00:00:00").getTime()) / 86400000,
  );
  if (!Number.isFinite(days)) return { label: `as of ${formatListDate(asOf)}`, stale: false };
  if (days <= 0) return { label: "updated today", stale: false };
  if (days === 1) return { label: "updated yesterday", stale: false };
  if (days < 30) return { label: `updated ${days} days ago`, stale: days > 14 };
  return { label: `as of ${formatListDate(asOf)}`, stale: true };
}

function Fact({ label, value, tone, testId }: {
  label: string; value: React.ReactNode; tone?: "neg" | "pos"; testId?: string;
}) {
  const color = tone === "neg" ? "text-red-500" : tone === "pos" ? "text-emerald-500" : "";
  return (
    <div className="bubble-row px-3 py-2" data-testid={testId}>
      <p className="micro-label text-muted-foreground">{label}</p>
      <p className={`metric-value text-[17px] leading-tight mt-0.5 tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

export function AccountOverview({ profile, todayISO, hideHeadline = false }: {
  profile: any;
  /** Caller's tz-local today, for the staleness caption. */
  todayISO?: string;
  /**
   * The investment dashboard states the portfolio value itself, so it renders
   * this card without the balance headline — one number, one place.
   */
  hideHeadline?: boolean;
}) {
  const { toast } = useToast();
  const [adjust, setAdjust] = useState("");
  const view = toAccountView(profile);
  const today = todayISO || new Date().toLocaleDateString("en-CA");
  const asOf = staleness(view.balanceAsOf, today);

  const adjustMut = useMutation({
    mutationFn: async (delta: number) =>
      (await apiRequest("POST", `/api/accounts/${view.id}/adjust`, {
        delta, reason: delta >= 0 ? "Manual increase" : "Manual decrease",
      })).json(),
    onSuccess: async () => {
      await invalidateDomains("profiles", "assets", "liabilities", "dashboard");
      setAdjust("");
      toast({ title: "Balance updated" });
    },
    onError: (e: any) =>
      toast({ title: "Couldn't update the balance", description: e?.message, variant: "destructive" }),
  });

  const applyAdjust = (sign: 1 | -1) => {
    const n = Number(String(adjust).replace(/[$,]/g, ""));
    if (!Number.isFinite(n) || n === 0) return;
    adjustMut.mutate(sign * Math.abs(n));
  };

  return (
    <div className="space-y-3" data-testid="account-overview">
      <Card>
        <CardContent className="p-3 space-y-3">
          {/* Headline. A debt account says what is OWED — the single most
              important word on the page for a credit card, and the one the
              generic asset layout had no way to say. */}
          {!hideHeadline && (
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className="text-[11px] h-5" data-testid="account-kind-badge">
                {view.kindLabel}
              </Badge>
              {view.excluded && (
                <Badge variant="outline" className="text-[11px] h-5 text-muted-foreground">
                  Excluded from totals
                </Badge>
              )}
            </div>
            <p className="micro-label text-muted-foreground mt-2">
              {view.isDebt ? "Balance owed" : "Current balance"}
            </p>
            <p
              className={`text-[28px] font-bold leading-none tabular-nums mt-0.5 ${view.isDebt ? "text-red-500" : ""}`}
              data-testid="account-balance"
            >
              {view.isDebt ? "−" : ""}{formatMoney(view.balance)}
            </p>
            <p className={`text-[11px] mt-1 ${asOf.stale ? "text-amber-600" : "text-muted-foreground"}`}
              data-testid="account-as-of">
              {asOf.label}
            </p>
          </div>
          )}

          {/* Only the facts this KIND actually has. */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {view.institution && (
              <Fact label="Institution" value={view.institution} testId="account-institution" />
            )}
            {view.availableBalance != null && (
              <Fact
                label={view.isDebt ? "Available credit" : "Available"}
                value={formatMoney(view.availableBalance)}
                tone="pos"
                testId="account-available"
              />
            )}
            {view.creditLimit != null && (
              <Fact label="Credit limit" value={formatMoney(view.creditLimit)} testId="account-credit-limit" />
            )}
            {view.utilization != null && (
              <Fact
                label="Utilization"
                value={`${view.utilization.toFixed(0)}%`}
                // 30% is the conventional line above which utilization starts
                // hurting a credit score, so it earns the warning colour.
                tone={view.utilization > 30 ? "neg" : "pos"}
                testId="account-utilization"
              />
            )}
            {view.lastFour && (
              <Fact label="Account number" value={`•••• ${view.lastFour}`} testId="account-last-four" />
            )}
            {view.currency !== "usd" && (
              <Fact label="Currency" value={view.currency.toUpperCase()} testId="account-currency" />
            )}
          </div>

          {/* Utilization bar — a credit line is the one account where the
              balance means nothing without the limit beside it. */}
          {view.utilization != null && view.creditLimit != null && (
            <div data-testid="account-utilization-bar">
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full ${view.utilization > 30 ? "bg-red-500" : "bg-emerald-500"}`}
                  style={{ width: `${Math.min(100, Math.max(0, view.utilization))}%` }}
                />
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">
                {formatMoney(view.balance)} of {formatMoney(view.creditLimit)} used
              </p>
            </div>
          )}

          {/* Manual balance adjustment. A balance CHANGE is an event with a
              reason, not a field to silently overwrite — the before/after pair
              lands in the history below. */}
          <div className="flex items-center gap-1.5 border-t pt-3">
            <Input
              type="number" step="0.01" inputMode="decimal"
              value={adjust} onChange={(e) => setAdjust(e.target.value)}
              placeholder="Adjust balance by…" className="h-8 text-xs"
              data-testid="account-adjust-input"
            />
            <Button size="sm" variant="outline" className="h-8 px-2 text-xs"
              disabled={!adjust || adjustMut.isPending}
              onClick={() => applyAdjust(1)} data-testid="account-adjust-up">+ Add</Button>
            <Button size="sm" variant="outline" className="h-8 px-2 text-xs"
              disabled={!adjust || adjustMut.isPending}
              onClick={() => applyAdjust(-1)} data-testid="account-adjust-down">− Subtract</Button>
          </div>
        </CardContent>
      </Card>

      {/* Every balance change, so "why is this $40 lower than last week" is
          always answerable. */}
      {view.adjustments.length > 0 && (
        <Card>
          <CardContent className="p-3">
            <p className="micro-label text-muted-foreground mb-2 flex items-center gap-1">
              <History className="w-3 h-3" />Balance history ({view.adjustments.length})
            </p>
            <div className="rounded-lg border border-border/40 divide-y divide-border/30 overflow-hidden"
              data-testid="account-balance-history">
              {view.adjustments.slice().reverse().slice(0, 20).map((adj) => (
                <div key={adj.id} className="flex items-center justify-between gap-2 px-2.5 py-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">{adj.reason || "Balance updated"}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {formatListDate(adj.date)}
                      {adj.source && adj.source !== "user" ? ` · via ${adj.source}` : ""}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={`text-xs font-semibold tabular-nums ${adj.delta < 0 ? "text-red-500" : "text-emerald-600"}`}>
                      {adj.delta >= 0 ? "+" : "−"}{formatMoney(Math.abs(adj.delta))}
                    </p>
                    <p className="text-[11px] text-muted-foreground tabular-nums">
                      → {formatMoney(adj.newBalance)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * The hero stat tiles for an account.
 *
 * The generic builder offers Docs / Expenses / Tasks counts, which for a
 * freshly-added account are all zero and get dropped — leaving an account page
 * with no stats at all. These are the numbers an account actually has.
 */
export function accountHeroStats(profile: any): Array<{
  label: string; value: string; testId: string;
}> {
  const view = toAccountView(profile);
  const out: Array<{ label: string; value: string; testId: string }> = [
    {
      label: view.isDebt ? "Owed" : "Balance",
      value: formatMoney(view.balance),
      testId: "hero-stat-account-balance",
    },
  ];
  if (view.availableBalance != null) {
    out.push({
      label: view.isDebt ? "Available credit" : "Available",
      value: formatMoney(view.availableBalance),
      testId: "hero-stat-account-available",
    });
  }
  if (view.utilization != null) {
    out.push({
      label: "Utilization",
      value: `${view.utilization.toFixed(0)}%`,
      testId: "hero-stat-account-utilization",
    });
  }
  return out;
}
