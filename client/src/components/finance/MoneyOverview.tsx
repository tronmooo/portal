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

// One compact KPI card: label, big value, trend %, sparkline, color, click.
function KpiCard({ label, value, trend, tone, series, sub, onClick, testId }: {
  label: string; value: string; trend?: string; tone: "pos" | "neg" | "warn" | "neutral";
  series?: number[]; sub?: string; onClick: () => void; testId: string;
}) {
  const color = tone === "pos" ? "155 65% 45%" : tone === "neg" ? "0 72% 58%" : tone === "warn" ? "38 96% 54%" : "213 90% 62%";
  return (
    <button onClick={onClick} data-testid={testId}
      className="text-left rounded-xl border bg-card/40 p-3 hover:bg-muted/30 transition-colors min-w-[8.5rem] flex-1"
      style={{ borderColor: `hsl(${color} / 0.28)` }}>
      <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="text-xl font-bold tabular-nums mt-0.5" style={{ color: `hsl(${color})` }}>{value}</div>
      {trend && <div className="text-[10px] font-mono mt-0.5" style={{ color: `hsl(${color})` }}>{trend}</div>}
      {series && series.length >= 2 ? <div className="mt-1.5"><Sparkline series={series} /></div>
        : sub ? <div className="text-[10px] font-mono text-muted-foreground mt-1.5 truncate">{sub}</div> : null}
    </button>
  );
}

// Donut ring (inflow vs outflow) for the Cash Flow Overview.
function DonutRing({ inflow, outflow, net }: { inflow: number; outflow: number; net: number }) {
  const total = inflow + outflow || 1;
  const inPct = inflow / total;
  const r = 42, c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 120 120" className="w-28 h-28">
      <circle cx="60" cy="60" r={r} fill="none" stroke="hsl(0 72% 55%)" strokeWidth="12" />
      <circle cx="60" cy="60" r={r} fill="none" stroke="hsl(155 60% 48%)" strokeWidth="12"
        strokeDasharray={`${(c * inPct).toFixed(1)} ${c.toFixed(1)}`} strokeLinecap="round"
        transform="rotate(-90 60 60)" />
      <text x="60" y="56" textAnchor="middle" className="fill-foreground" style={{ fontSize: 15, fontWeight: 700 }}>{money(Math.abs(net))}</text>
      <text x="60" y="72" textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 8 }}>NET · MONTH</text>
    </svg>
  );
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
  spendTrendPct?: number | null;  // spend vs last month %
  incomeMtd?: number;
  budgets: Array<{ category: string; limit: number; spent: number }>;
  bills: MoneyBill[];             // already filtered to the next N days
  spendByCategory?: Record<string, number>;
  alerts?: Array<{ id: string; text: string; tone: "pos" | "neg" | "warn"; onClick?: () => void }>;
  assetBreakdown: Breakdown[];
  liabilityBreakdown: Breakdown[];
  monthLabel: string;
  onAddExpense: () => void;
  onPayBill: (bill: MoneyBill) => void;
  payingId?: string | null;
  onOpenNetWorth?: () => void;
  onOpenCashFlow?: () => void;
  onOpenBudget?: () => void;
  onCategoryClick?: (category: string) => void;
}) {
  const {
    netWorth, assets, liabilities, momPct, nwSeries, cashIn, cashOut, spendMtd,
    spendTrendPct, incomeMtd = 0, budgets, bills, spendByCategory = {}, alerts = [],
    assetBreakdown, liabilityBreakdown, monthLabel,
    onAddExpense, onPayBill, payingId,
    onOpenNetWorth, onOpenCashFlow, onOpenBudget, onCategoryClick,
  } = props;
  const cashFlow = cashIn - cashOut;
  const worstBudget = budgets.slice().sort((a, b) => (b.spent / (b.limit || 1)) - (a.spent / (a.limit || 1)))[0];
  const worstPct = worstBudget ? Math.round((worstBudget.spent / (worstBudget.limit || 1)) * 100) : 0;
  const savingsRate = incomeMtd > 0 ? Math.round(((incomeMtd - spendMtd) / incomeMtd) * 100) : null;
  const billsTotal = bills.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  // Sorted category breakdown with % of total spend.
  const catTotal = Object.values(spendByCategory).reduce((s, v) => s + (Number(v) || 0), 0) || 1;
  const categories = Object.entries(spendByCategory)
    .map(([name, amt]) => ({ name, amount: Number(amt) || 0, pct: (Number(amt) || 0) / catTotal }))
    .filter(c => c.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8);
  const CAT_COLORS = ["199 89% 60%", "155 65% 45%", "38 96% 54%", "262 80% 66%", "330 80% 62%", "173 60% 44%", "0 72% 58%", "240 10% 60%"];

  return (
    <div className="space-y-3" data-testid="money-overview">
      {/* Top KPI cards — each opens a drill-down popup or filters. */}
      <div className="flex flex-wrap gap-2">
        <KpiCard label="Net Worth" value={money(netWorth)} tone={netWorth < 0 ? "neg" : "pos"}
          trend={momPct != null ? `${momPct >= 0 ? "▲" : "▼"} ${Math.abs(momPct).toFixed(1)}% mo` : undefined}
          series={nwSeries} onClick={() => onOpenNetWorth?.()} testId="money-networth" />
        <KpiCard label={`Cash Flow · ${monthLabel}`} value={`${cashFlow >= 0 ? "+" : "-"}${money(Math.abs(cashFlow))}`}
          tone={cashFlow >= 0 ? "pos" : "neg"} sub={`IN ${money(cashIn)} · OUT ${money(cashOut)}`}
          onClick={() => onOpenCashFlow?.()} testId="money-cashflow" />
        <KpiCard label="Spend · MTD" value={money(spendMtd)} tone="warn"
          trend={spendTrendPct != null ? `${spendTrendPct >= 0 ? "▲" : "▼"} ${Math.abs(spendTrendPct).toFixed(0)}% mo` : undefined}
          sub={worstBudget ? `${worstBudget.category} ${worstPct}%` : undefined}
          onClick={() => onCategoryClick?.("all")} testId="money-spend" />
        <KpiCard label="Income · MTD" value={money(incomeMtd)} tone="pos" sub="this month"
          onClick={() => onOpenCashFlow?.()} testId="money-income" />
        <KpiCard label="Bills Due" value={String(bills.length)} tone={bills.some(b => b.status === "overdue") ? "neg" : "warn"}
          sub={`${money(billsTotal)} upcoming`} onClick={() => onOpenCashFlow?.()} testId="money-bills-kpi" />
        <KpiCard label="Savings Rate" value={savingsRate != null ? `${savingsRate}%` : "—"}
          tone={savingsRate != null && savingsRate >= 15 ? "pos" : savingsRate != null && savingsRate < 0 ? "neg" : "neutral"}
          sub="income − spend" onClick={() => onOpenCashFlow?.()} testId="money-savings" />
      </div>

      {/* Cash Flow Overview + Spending by Category */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card className="p-4" data-testid="money-cashflow-overview">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Cash Flow Overview</span>
            <button className="text-[10px] font-mono text-primary hover:underline" onClick={() => onOpenCashFlow?.()} data-testid="money-view-cashflow">View →</button>
          </div>
          <div className="flex items-center gap-4">
            <DonutRing inflow={cashIn} outflow={cashOut} net={cashFlow} />
            <div className="space-y-1.5 text-sm">
              <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-emerald-500" /><span className="text-muted-foreground">Inflow</span><span className="ml-auto tabular-nums font-semibold">{money(cashIn)}</span></div>
              <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-red-500" /><span className="text-muted-foreground">Outflow</span><span className="ml-auto tabular-nums font-semibold text-red-500">{money(cashOut)}</span></div>
              <div className="flex items-center gap-2 border-t border-border/50 pt-1.5"><span className="text-muted-foreground">Net</span><span className={`ml-auto tabular-nums font-bold ${cashFlow >= 0 ? "text-emerald-500" : "text-red-500"}`}>{cashFlow >= 0 ? "+" : "-"}{money(Math.abs(cashFlow))}</span></div>
            </div>
          </div>
        </Card>

        <Card className="p-4" data-testid="money-categories">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Spending by Category · MTD</span>
          </div>
          {categories.length === 0 ? <p className="text-xs text-muted-foreground">No spending this month.</p> : (
            <div className="space-y-1.5">
              {categories.map((c, i) => (
                <button key={c.name} onClick={() => onCategoryClick?.(c.name)}
                  className="w-full text-left group" data-testid={`money-cat-${c.name}`}>
                  <div className="flex items-baseline gap-2 text-xs">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: `hsl(${CAT_COLORS[i % CAT_COLORS.length]})` }} />
                    <span className="capitalize truncate group-hover:text-foreground">{c.name}</span>
                    <span className="ml-auto tabular-nums font-semibold">{money(c.amount)}</span>
                    <span className="tabular-nums text-muted-foreground w-10 text-right">{(c.pct * 100).toFixed(1)}%</span>
                  </div>
                  <div className="mt-1 h-1 rounded-full bg-muted overflow-hidden">
                    <div className="h-full" style={{ width: `${Math.min(100, c.pct * 100)}%`, background: `hsl(${CAT_COLORS[i % CAT_COLORS.length]})` }} />
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Budgets */}
      {budgets.length > 0 && (
        <Card className="p-4" data-testid="money-budgets">
          <div className="flex items-center justify-between mb-3">
            <button className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground hover:text-foreground" onClick={() => onOpenBudget?.()} data-testid="money-budgets-header">Budgets · MTD vs limit →</button>
            <div className="flex gap-1.5">
              {onOpenBudget && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onOpenBudget} data-testid="money-manage-budgets">+ Budget</Button>}
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onAddExpense} data-testid="money-add-expense">+ Expense</Button>
            </div>
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

      {/* Financial Alerts & Insights — derived, each row deep-links. */}
      {alerts.length > 0 && (
        <Card className="p-4" data-testid="money-alerts">
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">Financial Alerts & Insights</div>
          <div className="space-y-1">
            {alerts.map(a => (
              <button key={a.id} onClick={a.onClick} disabled={!a.onClick}
                className={`w-full flex items-start gap-2 py-1 px-1 text-left text-xs rounded-sm ${a.onClick ? "hover:bg-muted/40" : ""} ${a.tone === "neg" ? "text-red-500" : a.tone === "warn" ? "text-amber-500" : "text-emerald-500"}`}
                data-testid={`money-alert-${a.id}`}>
                <span className="mt-[2px]">{a.tone === "neg" ? "⚠" : a.tone === "warn" ? "!" : "✓"}</span>
                <span className="flex-1">{a.text}</span>
              </button>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
