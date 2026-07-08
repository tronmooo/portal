// ── Money overview (Finance tab redesign, 2026-07) ───────────────────────────
// The mockup "Money" dashboard: MONEY section header, snapshot row (Net Worth +
// trend, Cash Flow in/out bar, Spend MTD + category strip), budget chips (MTD
// vs limit), Bills · next 14d with Pay, Balance Sheet, Subscriptions summary,
// Recent Transactions, and compact Assets / Liabilities summaries.
// Pure presentation over data finance.tsx already fetches — all values come in
// as props so this stays testable and finance.tsx owns the queries/mutations.
// Every card is a drill-down: the onOpen* handlers open the SAME popups the
// dashboard hero tiles use (NetWorthPopup / CashFlowPopup / BudgetPopup) —
// never a duplicate implementation.
import { useState } from "react";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Minus, Plus } from "lucide-react";

export interface MoneyBill {
  id: string; name: string; amount: number; dueDate?: string;
  daysUntil: number; status?: string; category?: string;
}
export interface Breakdown { id: string; name: string; type: string; value: number; }
export interface MoneyTxn { id: string; date: string; name: string; category: string; amount: number; }

const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
const money2 = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

// Fixed categorical order for the MTD spend strip — same palette order the
// dashboard's SpendingBreakdown uses, so the two surfaces read as one system.
const STRIP_COLORS = ["#8b5cf6", "#3b82f6", "#10b981", "#f59e0b", "#94a3b8"];

function txnDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "2-digit" }).toUpperCase();
}

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

// Keyboard-accessible click props for a card/chip that drills into a popup.
function drill(onOpen?: () => void) {
  if (!onOpen) return {};
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: onOpen,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); }
    },
  };
}
const drillClass = (onOpen?: () => void) =>
  onOpen ? " cursor-pointer hover:border-primary/50 transition-colors" : "";

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
  // Drill-downs — wired by finance.tsx to the dashboard's existing popups.
  onOpenNetWorth?: () => void;    // Net Worth card, Balance Sheet, breakdowns
  onOpenCashFlow?: () => void;    // Cash Flow card
  onOpenSpend?: () => void;       // Spend card + budget chips → BudgetPopup
  onAddBudget?: () => void;
  onAddBill?: () => void;
  spendCats?: Array<{ name: string; amount: number }>; // MTD spend by category
  subs?: { count: number; monthlyTotal: number };
  onViewSubs?: () => void;
  onAddSub?: () => void;
  transactions?: MoneyTxn[];      // newest first; income positive, spend negative
  onTransactionClick?: (id: string) => void;
}) {
  const {
    netWorth, assets, liabilities, momPct, nwSeries, cashIn, cashOut, spendMtd,
    budgets, bills, assetBreakdown, liabilityBreakdown, monthLabel,
    onAddExpense, onPayBill, payingId,
    onOpenNetWorth, onOpenCashFlow, onOpenSpend, onAddBudget, onAddBill,
    spendCats, subs, onViewSubs, onAddSub, transactions, onTransactionClick,
  } = props;
  const [collapsed, setCollapsed] = useState(false);
  const cashFlow = cashIn - cashOut;
  const worstBudget = budgets.slice().sort((a, b) => (b.spent / (b.limit || 1)) - (a.spent / (a.limit || 1)))[0];
  const worstPct = worstBudget ? Math.round((worstBudget.spent / (worstBudget.limit || 1)) * 100) : 0;

  // MTD spend strip: top 4 categories in fixed color order + "other" fold.
  const cats = (spendCats || []).filter(c => c.amount > 0).sort((a, b) => b.amount - a.amount);
  const otherAmt = cats.slice(4).reduce((s, c) => s + c.amount, 0);
  const stripCats = otherAmt > 0 ? [...cats.slice(0, 4), { name: "other", amount: otherAmt }] : cats.slice(0, 4);
  const stripTotal = stripCats.reduce((s, c) => s + c.amount, 0);

  return (
    <div className="space-y-3" data-testid="money-overview">
      {/* Section header — mockup "MONEY · NET +1.8% MO" with collapse */}
      <div className="flex items-center gap-3 pt-1">
        <span className="text-xs font-bold uppercase tracking-[0.25em]">Money</span>
        {momPct != null && (
          <span className={`text-[10px] font-mono uppercase tracking-widest ${momPct >= 0 ? "text-emerald-500" : "text-red-500"}`}>
            Net {momPct >= 0 ? "+" : ""}{momPct.toFixed(1)}% MO
          </span>
        )}
        <button
          type="button"
          onClick={() => setCollapsed(c => !c)}
          className="ml-auto p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          aria-label={collapsed ? "Expand Money section" : "Collapse Money section"}
          data-testid="money-collapse"
        >
          {collapsed ? <Plus className="h-3.5 w-3.5" /> : <Minus className="h-3.5 w-3.5" />}
        </button>
      </div>
      {!collapsed && (<>

      {/* Snapshot row — each card opens its full popup */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card className={`p-4${drillClass(onOpenNetWorth)}`} {...drill(onOpenNetWorth)} data-testid="money-networth">
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Net Worth</div>
          <div className={`text-2xl font-bold tabular-nums mt-1 ${netWorth < 0 ? "text-red-500" : ""}`}>{money(netWorth)}</div>
          {momPct != null && (
            <div className={`text-xs font-mono mt-0.5 ${momPct >= 0 ? "text-emerald-500" : "text-red-500"}`}>
              {momPct >= 0 ? "+" : ""}{momPct.toFixed(1)}% MO
            </div>
          )}
          <div className="mt-2"><Sparkline series={nwSeries} /></div>
        </Card>
        <Card className={`p-4${drillClass(onOpenCashFlow)}`} {...drill(onOpenCashFlow)} data-testid="money-cashflow">
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Cash Flow · {monthLabel}</div>
          <div className={`text-2xl font-bold tabular-nums mt-1 ${cashFlow >= 0 ? "text-emerald-500" : "text-red-500"}`}>
            {cashFlow >= 0 ? "+" : "-"}{money(Math.abs(cashFlow))}
          </div>
          <div className="text-xs font-mono text-muted-foreground mt-2">IN {money(cashIn)} · OUT {money(cashOut)}</div>
          {(cashIn + cashOut) > 0 && (
            <div className="mt-2 flex h-1.5 w-full gap-0.5 overflow-hidden" aria-hidden="true">
              <div className="rounded-full bg-emerald-500" style={{ width: `${(cashIn / (cashIn + cashOut)) * 100}%` }} />
              <div className="rounded-full bg-red-500" style={{ width: `${(cashOut / (cashIn + cashOut)) * 100}%` }} />
            </div>
          )}
        </Card>
        <Card className={`p-4${drillClass(onOpenSpend)}`} {...drill(onOpenSpend)} data-testid="money-spend">
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Spend · MTD</div>
          <div className="text-2xl font-bold tabular-nums mt-1">{money(spendMtd)}</div>
          {worstBudget && (
            <div className={`text-xs font-mono mt-2 ${budgetTone(worstPct).text}`}>
              {worstBudget.category.toUpperCase()} {worstPct}% BUDGET
            </div>
          )}
          {stripTotal > 0 && (
            <div className="mt-2" data-testid="money-spend-strip">
              <div className="flex h-1.5 w-full gap-0.5 overflow-hidden" aria-hidden="true">
                {stripCats.map((c, i) => (
                  <div key={c.name} className="rounded-full" style={{ width: `${(c.amount / stripTotal) * 100}%`, background: STRIP_COLORS[i % STRIP_COLORS.length] }} />
                ))}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                {stripCats.slice(0, 3).map((c, i) => (
                  <span key={c.name} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: STRIP_COLORS[i % STRIP_COLORS.length] }} />
                    <span className="capitalize">{c.name}</span>
                    <span className="tabular-nums">{money2(c.amount)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* Budgets */}
      {(budgets.length > 0 || onAddBudget) && (
        <Card className="p-4" data-testid="money-budgets">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Budgets · MTD vs limit</span>
            <div className="flex items-center gap-2">
              {onAddBudget && (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onAddBudget} data-testid="money-add-budget">+ Budget</Button>
              )}
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onAddExpense} data-testid="money-add-expense">+ Expense</Button>
            </div>
          </div>
          {budgets.length === 0 ? (
            <p className="text-xs text-muted-foreground">No budgets yet — set per-category limits with + Budget.</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
              {budgets.map(b => {
                const pct = Math.round((b.spent / (b.limit || 1)) * 100);
                const tone = budgetTone(pct);
                return (
                  <div
                    key={b.category}
                    className={`rounded-lg border p-2.5 ${tone.ring}${onOpenSpend ? " cursor-pointer hover:brightness-110 transition-all" : ""}`}
                    {...drill(onOpenSpend)}
                    data-testid={`money-budget-${b.category}`}
                  >
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
          )}
        </Card>
      )}

      {/* Bills + Balance sheet + Subscriptions (3-up like the mockup; the
          Subscriptions card only renders when finance.tsx passes the summary) */}
      <div className={`grid grid-cols-1 gap-3 ${subs ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}>
        <Card className="p-4" data-testid="money-bills">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Bills · next 14d</span>
            {onAddBill && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onAddBill} data-testid="money-add-bill">+ Bill</Button>
            )}
          </div>
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

        <Card className={`p-4${drillClass(onOpenNetWorth)}`} {...drill(onOpenNetWorth)} data-testid="money-balance-sheet">
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-3">Balance Sheet</div>
          <div className="space-y-2">
            <div className="flex justify-between text-sm"><span className="text-muted-foreground">Assets</span><span className="tabular-nums">{money(assets)}</span></div>
            <div className="flex justify-between text-sm"><span className="text-muted-foreground">Liabilities</span><span className="tabular-nums text-red-500">-{money(liabilities)}</span></div>
            <div className="border-t border-border pt-2 flex justify-between text-sm font-bold">
              <span>Net worth</span><span className={`tabular-nums ${netWorth < 0 ? "text-red-500" : "text-emerald-500"}`}>{money(netWorth)}</span>
            </div>
          </div>
          {/* Assets vs liabilities split bar */}
          {(assets + liabilities) > 0 && (
            <div className="mt-3 flex h-1.5 w-full gap-0.5 overflow-hidden" aria-hidden="true">
              <div className="rounded-full bg-emerald-500" style={{ width: `${(assets / (assets + liabilities)) * 100}%` }} />
              <div className="rounded-full bg-red-500" style={{ width: `${(liabilities / (assets + liabilities)) * 100}%` }} />
            </div>
          )}
          {onOpenNetWorth && <p className="mt-2 text-[10px] text-muted-foreground">Tap for the full breakdown</p>}
        </Card>

        {subs && (
          <Card className={`p-4${drillClass(onViewSubs)}`} {...drill(onViewSubs)} data-testid="money-subs">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Subscriptions</span>
              <span className="text-sm font-bold tabular-nums">{money2(subs.monthlyTotal)}/mo</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {subs.count === 0 ? "No subscriptions yet." : `${subs.count} active`}
            </p>
            <div className="mt-3 flex items-center gap-2">
              {onViewSubs && subs.count > 0 && (
                <Button size="sm" variant="outline" className="h-7 text-xs" data-testid="money-view-subs"
                  onClick={(e) => { e.stopPropagation(); onViewSubs(); }}>View all</Button>
              )}
              {onAddSub && (
                <Button size="sm" variant="outline" className="h-7 text-xs" data-testid="money-add-sub"
                  onClick={(e) => { e.stopPropagation(); onAddSub(); }}>+ Sub</Button>
              )}
            </div>
          </Card>
        )}
      </div>

      {/* Recent transactions — merged expenses (−) and income (+), newest first */}
      {transactions && (
        <Card className="p-4" data-testid="money-transactions">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">Recent Transactions</span>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onAddExpense} data-testid="money-txn-add-expense">+ Expense</Button>
          </div>
          {transactions.length === 0 ? (
            <p className="text-xs text-muted-foreground">No transactions yet.</p>
          ) : (
            <div className="space-y-0.5">
              {transactions.map(t => (
                <div
                  key={t.id}
                  className={`flex items-center gap-3 py-1.5 rounded px-1${onTransactionClick ? " cursor-pointer hover:bg-muted/40" : ""}`}
                  {...drill(onTransactionClick ? () => onTransactionClick(t.id) : undefined)}
                  data-testid={`money-txn-${t.id}`}
                >
                  <span className="text-[10px] font-mono uppercase w-14 shrink-0 text-muted-foreground">{txnDate(t.date)}</span>
                  <span className="flex-1 text-sm truncate">{t.name}</span>
                  <span className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground shrink-0">{t.category}</span>
                  <span className={`text-sm font-semibold tabular-nums shrink-0 w-24 text-right ${t.amount > 0 ? "text-emerald-500" : ""}`}>
                    {t.amount > 0 ? "+" : "−"}${Math.abs(t.amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Assets + Liabilities summaries */}
      {(assetBreakdown.length > 0 || liabilityBreakdown.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {assetBreakdown.length > 0 && (
            <Card className="p-4" data-testid="money-assets">
              <div className="flex items-center justify-between mb-2">
                <span
                  className={`text-[10px] font-mono uppercase tracking-widest text-muted-foreground${onOpenNetWorth ? " cursor-pointer hover:text-foreground transition-colors" : ""}`}
                  {...drill(onOpenNetWorth)}
                >Assets · {money(assets)}</span>
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
                <span
                  className={`text-[10px] font-mono uppercase tracking-widest text-muted-foreground${onOpenNetWorth ? " cursor-pointer hover:text-foreground transition-colors" : ""}`}
                  {...drill(onOpenNetWorth)}
                >Liabilities · {money(liabilities)}</span>
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
      </>)}
    </div>
  );
}
