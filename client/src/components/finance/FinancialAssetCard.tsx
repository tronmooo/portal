// ── The adaptive card for a financial asset ──────────────────────────────────
//
// The Assets tab paints a car with its mileage and a house with its address.
// A financial account is a different shape: what matters is the institution
// and kind, the balance, how it moved lately, and how fresh the figure is. An
// investment account adds its gain/loss; a bank account its recent cash flow.
//
// Pure derivation from the profile (shared/financial-assets.ts), shared by the
// Assets-tab grid, the Finance Accounts rows and the dashboard so the same
// account never shows two different "recent change" figures.

import { useMemo } from "react";
import { formatMoney, formatListDate } from "@/lib/format";
import {
  accountKindMeta, accountKindOf, toAccountView, type AccountView,
} from "@shared/finance-accounts";
import {
  balanceSeries, seriesForPeriod, cashFlowOf, holdings, gainLossOf, accountConnection,
  periodStart, type BalancePoint, type FinancialLayout,
} from "@shared/financial-assets";
import { accountLayoutOf } from "@shared/account-kinds";
import { BalanceSparkline, ChangeChip } from "./BalanceHistoryChart";

export interface FinancialCardSummary {
  view: AccountView;
  layout: FinancialLayout;
  series: BalancePoint[];
  /** Change over the last month. */
  change: number | null;
  changePct: number | null;
  /** Two meta lines the card shows under the name, chosen by layout. */
  meta: Array<{ label: string; value: string }>;
  /** "updated today" / "as of Aug 3" / "connected · synced 2h ago". */
  freshness: string;
  connected: boolean;
}

function freshnessLabel(view: AccountView, todayISO: string, connected: boolean): string {
  const asOf = view.balanceAsOf;
  if (!asOf) return connected ? "connected" : "not updated yet";
  const days = Math.round((new Date(`${todayISO}T00:00:00`).getTime() - new Date(`${asOf}T00:00:00`).getTime()) / 86400000);
  const rel = !Number.isFinite(days) ? `as of ${formatListDate(asOf)}` : days <= 0 ? "updated today" : days === 1 ? "updated yesterday" : days < 30 ? `updated ${days}d ago` : `as of ${formatListDate(asOf)}`;
  return connected ? `connected · ${rel}` : rel;
}

/** Everything a card needs, from the profile alone. */
export function financialCardSummary(profile: any, todayISO: string): FinancialCardSummary {
  const view = toAccountView(profile);
  const layout = accountLayoutOf(profile);
  const series = balanceSeries(profile, todayISO);
  const month = seriesForPeriod(series, "1M", todayISO);
  const connected = accountConnection(profile)?.status === "active";
  const meta: Array<{ label: string; value: string }> = [];
  const kindLabel = accountKindMeta(accountKindOf(profile)).label;
  if (view.institution) meta.push({ label: "Institution", value: view.institution });
  if (layout === "investment" || layout === "crypto") {
    const gl = gainLossOf(holdings(profile));
    if (gl.gain != null) meta.push({ label: "Gain / loss", value: `${gl.gain >= 0 ? "+" : "−"}${formatMoney(Math.abs(gl.gain))}${gl.gainPct != null ? ` (${gl.gainPct > 0 ? "+" : ""}${gl.gainPct.toFixed(1)}%)` : ""}` });
    else if (holdings(profile).length > 0) meta.push({ label: "Positions", value: String(holdings(profile).length) });
    else meta.push({ label: "Type", value: kindLabel });
  } else if (layout === "bank" || layout === "cash") {
    const cf = cashFlowOf(profile, periodStart("1M", todayISO), todayISO);
    if (cf.count > 0) meta.push({ label: "30-day flow", value: `${cf.net >= 0 ? "+" : "−"}${formatMoney(Math.abs(cf.net))}` });
    else meta.push({ label: "Type", value: kindLabel });
  } else {
    if (view.utilization != null) meta.push({ label: "Utilization", value: `${view.utilization.toFixed(0)}%` });
    else meta.push({ label: "Type", value: kindLabel });
  }
  if (meta.length < 2 && view.lastFour) meta.push({ label: "Account", value: `•••• ${view.lastFour}` });
  if (meta.length < 2) meta.push({ label: "Type", value: kindLabel });
  return {
    view, layout, series, change: month.change, changePct: month.changePct, meta: meta.slice(0, 2),
    freshness: freshnessLabel(view, todayISO, connected), connected,
  };
}

/** The value line + change chip + sparkline block a card body renders. */
export function FinancialCardValue({ profile, todayISO, accent }: { profile: any; todayISO: string; accent?: string }) {
  const s = useMemo(() => financialCardSummary(profile, todayISO), [profile, todayISO]);
  const debt = s.view.isDebt;
  return (
    <div className="flex items-end justify-between gap-2" data-testid={`financial-card-value-${s.view.id}`}>
      <div className="min-w-0">
        <p className={`text-[17px] font-bold tabular-nums leading-tight ${debt ? "text-red-500" : ""}`}>
          {debt ? "−" : ""}{formatMoney(s.view.balance)}
        </p>
        <ChangeChip change={debt && s.change != null ? -s.change : s.change} changePct={s.changePct} />
        <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{s.freshness}</p>
      </div>
      {s.series.length >= 2 && (
        <BalanceSparkline
          points={s.series.slice(-30)}
          color={accent ? `hsl(${accent})` : undefined}
          className="shrink-0 text-muted-foreground"
        />
      )}
    </div>
  );
}
