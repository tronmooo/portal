// ── Money overview (Finance tab redesign, 2026-07) ───────────────────────────
// The mockup "Money" dashboard: snapshot row (Net Worth + trend, Cash Flow
// in/out, Spend MTD + worst budget), budget chips (MTD vs limit), Bills · next
// 14d with Pay, Balance Sheet, and compact Assets / Liabilities summaries.
// Pure presentation over data finance.tsx already fetches — all values come in
// as props so this stays testable and finance.tsx owns the queries/mutations.
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export interface MoneyBill {
  id: string; name: string; amount: number; dueDate?: string;
  daysUntil: number; status?: string; category?: string;
}
export interface Breakdown { id: string; name: string; type: string; value: number; }

const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
const money2 = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

function Sparkline({ series }: { series: number[] }) {
  if (!series || series.length < 2) return null;
  const w = 240, h = 44, pad = 3;
  const min = Math.min(...series), max = Math.max(...series);
  const span = max - min || 1;
  const pts = series.map((v, i) => {
    const x = pad + (i / (series.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const up = series[series.length - 1] >= series[0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-11" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={up ? "hsl(155 60% 48%)" : "hsl(0 70% 55%)"} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function budgetTone(pct: number): { bar: string; text: string; ring: string } {
  if (pct > 100) return { bar: "bg-red-500", text: "text-red-500", ring: "border-red-500/40 bg-red-500/5" };
  if (pct >= 85) return { bar: "bg-amber-500", text: "text-amber-500", ring: "border-amber-500/40 bg-amber-500/5" };
  return { bar: "bg-emerald-500", text: "text-emerald-500", ring: "border-emerald-500/30 bg-emerald-500/5" };
}

export function MoneyOverview(props: {
  netWorth: number;
  assets: number;
  liabilities: number;
  momPct: number | null;          // month-over-month net-worth %
  nwSeries: number[];             // oldest→newest net-worth points
  cashIn: number;
  cashOut: number;
  spendMtd: number;
  budgets: Array<{ category: string; limit: number; spent: number }>;
  bills: MoneyBill[];             // already filtered to the next N days
  assetBreakdown: Breakdown[];
  liabilityBreakdown: Breakdown[];
  monthLabel: string;
  onAddExpense: () => void;
  onPayBill: (bill: MoneyBill) => void;
  payingId?: string | null;
}) {
  const {
    netWorth, assets, liabilities, momPct, nwSeries, cashIn, cashOut, spendMtd,
    budgets, bills, assetBreakdown, liabilityBreakdown, monthLabel,
    onAddExpense, onPayBill, payingId,
  } = props;
  const cashFlow = cashIn - cashOut;
  const worstBudget = budgets.slice().sort((a, b) => (b.spent / (b.limit || 1)) - (a.spent / (a.limit || 1)))[0];
  const worstPct = worstBudget ? Math.round((worstBudget.spent / (worstBudget.limit || 1)) * 100) : 0;

  return (
    <div className="space-y-3" data-testid="money-overview">
      {/* Snapshot row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card className="p-4" data-testid="money-networth">
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Net Worth</div>
          <div className={`text-2xl font-bold tabular-nums mt-1 ${netWorth < 0 ? "text-red-500" : ""}`}>{money(netWorth)}</div>
          {momPct != null && (
            <div className={`text-xs font-mono mt-0.5 ${momPct >= 0 ? "text-emerald-500" : "text-red-500"}`}>
              {momPct >= 0 ? "+" : ""}{momPct.toFixed(1)}% MO
            </div>
          )}
          <div className="mt-2"><Sparkline series={nwSeries} /></div>
        </Card>
        <Card className="p-4" data-testid="money-cashflow">
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Cash Flow · {monthLabel}</div>
          <div className={`text-2xl font-bold tabular-nums mt-1 ${cashFlow >= 0 ? "text-emerald-500" : "text-red-500"}`}>
            {cashFlow >= 0 ? "+" : "-"}{money(Math.abs(cashFlow))}
          </div>
          <div className="text-xs font-mono text-muted-foreground mt-2">IN {money(cashIn)} · OUT {money(cashOut)}</div>
        </Card>
        <Card className="p-4" data-testid="money-spend">
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Spend · MTD</div>
          <div className="text-2xl font-bold tabular-nums mt-1">{money(spendMtd)}</div>
          {worstBudget && (
            <div className={`text-xs font-mono mt-2 ${budgetTone(worstPct).text}`}>
              {worstBudget.category.toUpperCase()} {worstPct}% BUDGET
            </div>
          )}
        </Card>
      </div>

      {/* Budgets */}
      {budgets.length > 0 && (
        <Card className="p-4" data-testid="money-budgets">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Budgets · MTD vs limit</span>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onAddExpense} data-testid="money-add-expense">+ Expense</Button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {budgets.map(b => {
              const pct = Math.round((b.spent / (b.limit || 1)) * 100);
              const tone = budgetTone(pct);
              return (
                <div key={b.category} className={`rounded-lg border p-2.5 ${tone.ring}`} data-testid={`money-budget-${b.category}`}>
                  <div className="text-xs font-semibold capitalize truncate">{b.category}</div>
                  <div className={`text-lg font-bold tabular-nums ${tone.text}`}>{pct}%</div>
                  <div className="text-[10px] text-muted-foreground tabular-nums">{money2(b.spent)} / {money2(b.limit)}</div>
                  <div className="mt-1.5 h-1 rounded-full bg-muted overflow-hidden">
                    <div className={`h-full ${tone.bar}`} style={{ width: `${Math.min(100, pct)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Bills + Balance sheet */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card className="p-4" data-testid="money-bills">
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-3">Bills · next 14d</div>
          {bills.length === 0 ? (
            <p className="text-xs text-muted-foreground">No bills due in the next 14 days.</p>
          ) : (
            <div className="space-y-1.5">
              {bills.map(b => (
                <div key={b.id} className="flex items-center gap-3 py-1.5" data-testid={`money-bill-${b.id}`}>
                  <span className="text-[10px] font-mono uppercase w-14 shrink-0 text-muted-foreground">
                    {b.status === "overdue" ? <span className="text-red-500">overdue</span>
                      : b.daysUntil === 0 ? <span className="text-amber-500">today</span>
                      : `${b.daysUntil}d`}
                  </span>
                  <span className="flex-1 text-sm truncate">{b.name}</span>
                  <span className="text-sm font-semibold tabular-nums">{money2(b.amount)}</span>
                  <Button
                    size="sm" variant="outline" className="h-7 text-xs shrink-0"
                    disabled={payingId === b.id}
                    onClick={() => onPayBill(b)}
                    data-testid={`money-pay-${b.id}`}
                  >{payingId === b.id ? "…" : "Pay"}</Button>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-4" data-testid="money-balance-sheet">
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-3">Balance Sheet</div>
          <div className="space-y-2">
            <div className="flex justify-between text-sm"><span className="text-muted-foreground">Assets</span><span className="tabular-nums">{money(assets)}</span></div>
            <div className="flex justify-between text-sm"><span className="text-muted-foreground">Liabilities</span><span className="tabular-nums text-red-500">-{money(liabilities)}</span></div>
            <div className="border-t border-border pt-2 flex justify-between text-sm font-bold">
              <span>Net worth</span><span className={`tabular-nums ${netWorth < 0 ? "text-red-500" : "text-emerald-500"}`}>{money(netWorth)}</span>
            </div>
          </div>
        </Card>
      </div>

      {/* Assets + Liabilities summaries */}
      {(assetBreakdown.length > 0 || liabilityBreakdown.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {assetBreakdown.length > 0 && (
            <Card className="p-4" data-testid="money-assets">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Assets · {money(assets)}</span>
              </div>
              <div className="divide-y divide-border/60">
                {assetBreakdown.slice(0, 8).map(a => (
                  <Link key={a.id} href={`/profiles/${a.id}`}>
                    <div className="flex items-center gap-2 py-2 cursor-pointer hover:bg-muted/40 rounded px-1">
                      <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 shrink-0">{a.type}</span>
                      <span className="flex-1 text-sm truncate">{a.name}</span>
                      <span className="text-sm font-semibold tabular-nums">{money(a.value)}</span>
                    </div>
                  </Link>
                ))}
              </div>
            </Card>
          )}
          {liabilityBreakdown.length > 0 && (
            <Card className="p-4" data-testid="money-liabilities">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Liabilities · {money(liabilities)}</span>
              </div>
              <div className="divide-y divide-border/60">
                {liabilityBreakdown.slice(0, 8).map(l => (
                  <Link key={l.id} href={`/profiles/${l.id}`}>
                    <div className="flex items-center gap-2 py-2 cursor-pointer hover:bg-muted/40 rounded px-1">
                      <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-red-500/10 text-red-500 shrink-0">{l.type}</span>
                      <span className="flex-1 text-sm truncate">{l.name}</span>
                      <span className="text-sm font-semibold tabular-nums text-red-500">{money(l.value)}</span>
                    </div>
                  </Link>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
