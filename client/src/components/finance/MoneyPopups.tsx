// ── MoneyPopups — one bespoke drill-down per Money KPI card (2026-07) ─────────
// Before this file, five different cards (Cash Flow, Spend, Income, Bills Due,
// Savings Rate + the Cash Flow Overview "View") all opened the SAME CashFlowPopup,
// so pressing different tiles felt broken. Each popup here has its own visual
// identity and its own chart language:
//
//   CashFlowWaterfallPopup — sky · waterfall chart (In → Recurring → One-time → Net)
//   SpendPopup             — amber · daily heat calendar + category bars + receipts
//   IncomePopup            — emerald · stacked source ribbon + per-source shares
//   BillsDuePopup          — rose · due-date timeline with calendar chips + Pay
//   SavingsRatePopup       — violet · semicircle gauge + income−spend equation
//   CashFlowOverviewPopup  — indigo · glowing donut + 6-month trend + month table
//
// UPDATE 2026-07-30: the charts below still differ — a waterfall and a gauge
// really are different things — but the *chrome* no longer does. This file used
// to state as a goal that "no two of them share a header design", and six
// bespoke full-bleed gradient heroes with six eyebrow treatments is a large
// part of why the app read as several products. They all use BubbleModal +
// PopupHero now: one medallion, one title, one headline number, one stat strip.
//
// Pure presentation: every number arrives as a prop from finance.tsx, which
// already owns the queries — no fetching here, so these stay jsdom-testable.
import { useMemo } from "react";
import { useLocation } from "wouter";
import { BubbleModal, PopupHero } from "@/components/ui/bubble-modal";
import { Button } from "@/components/ui/button";
import {
  ComposedChart, Bar, Area, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer,
} from "recharts";
import {
  ArrowDownToLine, ArrowUpFromLine, CalendarDays, Flame, Gauge, Layers,
  Receipt, RefreshCw, Sparkles, Waves, Zap, ShoppingCart, Utensils, Car,
  HeartPulse, Home, Film, CreditCard, Package, PiggyBank,
} from "lucide-react";
import { toMonthlyAmount } from "@shared/obligation-windows";
import { parseLocalDate } from "@/lib/format";
import { dayLabel } from "@shared/now-rank";
import type { MoneyBill } from "@/components/finance/MoneyOverview";

const fmt = (n: number) => Math.round(Math.abs(n)).toLocaleString("en-US");
const signed = (n: number) => `${n < 0 ? "-" : "+"}$${fmt(n)}`;

// Category → icon (same vocabulary as the Budget Progress list).
const CAT_ICON: Record<string, any> = {
  groceries: ShoppingCart, food: Utensils, dining: Utensils, "food & dining": Utensils,
  transport: Car, vehicle: Car, health: HeartPulse, medical: HeartPulse,
  housing: Home, rent: Home, utilities: Zap, entertainment: Film,
  subscriptions: CreditCard, shopping: ShoppingCart,
};
const catIcon = (name: string) => CAT_ICON[String(name || "").toLowerCase()] || Package;

// One accent per popup, as HSL triples — BubbleModal and PopupHero wrap them.
const SKY = "203 92% 60%", AMBER = "38 96% 54%", EMERALD = "155 65% 45%";
const ROSE = "350 80% 58%", VIOLET = "262 80% 66%", INDIGO = "234 85% 68%";

// ═════════════════════════════════════════════════════════════════════════════
// 1 · CASH FLOW — sky waterfall
// ═════════════════════════════════════════════════════════════════════════════

export function CashFlowWaterfallPopup({
  open, onOpenChange, monthLabel, cashIn, spendMtd, recurringOut, incomes, spendByCategory,
}: {
  open: boolean; onOpenChange: (o: boolean) => void; monthLabel: string;
  cashIn: number; spendMtd: number; recurringOut: number;
  incomes: any[]; spendByCategory: Record<string, number>;
}) {
  const cashOut = spendMtd + recurringOut;
  const net = cashIn - cashOut;
  const sky = "hsl(203 92% 60%)";

  // Waterfall geometry: In drops through Recurring and One-time down to Net.
  const scale = Math.max(cashIn, cashOut, Math.abs(net), 1);
  const H = 118, TOP = 24, BASE = TOP + H;
  const y = (v: number) => BASE - (Math.max(0, v) / scale) * H;
  const lvl1 = cashIn, lvl2 = cashIn - recurringOut, lvl3 = net;
  const cols = [
    { label: "IN", from: 0, to: lvl1, color: "hsl(155 65% 45%)", value: cashIn, sign: "+" },
    { label: "RECURRING", from: lvl2, to: lvl1, color: "hsl(0 72% 58%)", value: recurringOut, sign: "−" },
    { label: "ONE-TIME", from: lvl3, to: lvl2, color: "hsl(38 96% 54%)", value: spendMtd, sign: "−" },
    { label: "NET", from: 0, to: Math.max(0, lvl3), color: sky, value: net, sign: net >= 0 ? "+" : "−" },
  ];
  const X = (i: number) => 16 + i * 82;
  const W = 56;

  const topIncomes = useMemo(() => (incomes || [])
    .map((i: any) => ({ id: i.id, label: i.name || i.source || i.category || "Income", monthly: toMonthlyAmount(Number(i.amount) || 0, i.frequency) }))
    .filter((i) => i.monthly > 0).sort((a, b) => b.monthly - a.monthly).slice(0, 4), [incomes]);
  const topCats = useMemo(() => Object.entries(spendByCategory || {})
    .map(([name, amt]) => ({ name, amt: Number(amt) || 0 })).filter((c) => c.amt > 0)
    .sort((a, b) => b.amt - a.amt).slice(0, 4), [spendByCategory]);

  return (
    <BubbleModal open={open} onClose={() => onOpenChange(false)} testId="popup-cashflow-waterfall"
      title={`Cash Flow · ${monthLabel}`} icon={Waves} accent={SKY}>
      <PopupHero accent={SKY} value={signed(net)}
        valueTone={net >= 0 ? sky : "hsl(38 96% 54%)"}
        caption={<>how money moved<br />through this month</>} />

      <div className="space-y-3">
        {/* Waterfall */}
        <div className="bubble p-3">
          <svg viewBox="0 0 340 172" className="w-full" role="img" aria-label="Cash flow waterfall">
            {/* dashed step connectors */}
            <line x1={X(0) + W} y1={y(lvl1)} x2={X(1) + W} y2={y(lvl1)} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" strokeOpacity="0.5" />
            <line x1={X(1) + W} y1={y(lvl2)} x2={X(2) + W} y2={y(lvl2)} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" strokeOpacity="0.5" />
            <line x1={X(2) + W} y1={y(Math.max(0, lvl3))} x2={X(3)} y2={y(Math.max(0, lvl3))} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" strokeOpacity="0.5" />
            <line x1="10" y1={BASE} x2="330" y2={BASE} stroke="hsl(var(--border))" />
            {cols.map((c, i) => {
              const top = y(c.to), bottom = y(c.from);
              const h = Math.max(3, bottom - top);
              return (
                <g key={c.label}>
                  <rect x={X(i)} y={top} width={W} height={h} rx="5" fill={c.color} fillOpacity="0.85" />
                  <text x={X(i) + W / 2} y={top - 6} textAnchor="middle" style={{ fontSize: 10, fontWeight: 700 }} className="fill-foreground">
                    {c.sign}${fmt(c.value)}
                  </text>
                  <text x={X(i) + W / 2} y={BASE + 14} textAnchor="middle" style={{ fontSize: 8, letterSpacing: 1 }} className="fill-muted-foreground">
                    {c.label}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        {/* Money in / money out side-by-side */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/5 p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <ArrowDownToLine className="h-3.5 w-3.5 text-emerald-500" />
              <span className="micro-label text-emerald-500">Money in</span>
            </div>
            {topIncomes.length === 0 ? <p className="text-[11px] text-muted-foreground">No income sources</p> : (
              <ul className="space-y-1.5">
                {topIncomes.map((i) => (
                  <li key={i.id} className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="truncate">{i.label}</span>
                    <span className="tabular-nums font-semibold text-emerald-500 shrink-0">${fmt(i.monthly)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded-2xl border border-red-500/25 bg-red-500/5 p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <ArrowUpFromLine className="h-3.5 w-3.5 text-red-500" />
              <span className="micro-label text-red-500">Money out</span>
            </div>
            <ul className="space-y-1.5">
              <li className="flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate flex items-center gap-1"><RefreshCw className="h-3 w-3 text-muted-foreground" /> Recurring</span>
                <span className="tabular-nums font-semibold text-red-500 shrink-0">${fmt(recurringOut)}</span>
              </li>
              {topCats.map((c) => (
                <li key={c.name} className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate capitalize">{c.name}</span>
                  <span className="tabular-nums font-semibold text-red-500 shrink-0">${fmt(c.amt)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Keep ratio */}
        {cashIn > 0 && (
          <div className="bubble p-3">
            <div className="flex justify-between micro-label text-muted-foreground mb-1.5">
              <span>Kept {Math.max(0, Math.round((net / cashIn) * 100))}¢ of every $1 earned</span>
              <span className="tabular-nums">{signed(net)}</span>
            </div>
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
              <div style={{ width: `${Math.min(100, Math.max(0, (net / cashIn) * 100))}%`, background: sky }} />
              <div style={{ width: `${Math.min(100, (cashOut / cashIn) * 100)}%`, background: "hsl(0 72% 58% / 0.55)" }} />
            </div>
          </div>
        )}
      </div>
    </BubbleModal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 2 · SPEND — amber heat calendar
// ═════════════════════════════════════════════════════════════════════════════

export function SpendPopup({
  open, onOpenChange, monthLabel, spendMtd, spendTrendPct, spendByCategory, monthExpenses,
}: {
  open: boolean; onOpenChange: (o: boolean) => void; monthLabel: string;
  spendMtd: number; spendTrendPct?: number | null;
  spendByCategory: Record<string, number>;
  monthExpenses: Array<{ id: string; description?: string; category?: string; amount: number; date?: string; vendor?: string }>;
}) {
  const amber = "hsl(38 96% 54%)";
  const now = new Date();
  const yearN = now.getFullYear(), monthN = now.getMonth();
  const daysInMonth = new Date(yearN, monthN + 1, 0).getDate();
  const firstWeekday = new Date(yearN, monthN, 1).getDay();
  const today = now.getDate();

  const byDay = useMemo(() => {
    const m: Record<number, number> = {};
    for (const e of monthExpenses || []) {
      const day = Number(String(e.date || "").slice(8, 10));
      if (day >= 1) m[day] = (m[day] || 0) + (Number(e.amount) || 0);
    }
    return m;
  }, [monthExpenses]);
  const maxDay = Math.max(1, ...Object.values(byDay));
  const busiest = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0];
  const dailyAvg = today > 0 ? spendMtd / today : 0;

  const cats = useMemo(() => Object.entries(spendByCategory || {})
    .map(([name, amt]) => ({ name, amt: Number(amt) || 0 })).filter((c) => c.amt > 0)
    .sort((a, b) => b.amt - a.amt).slice(0, 6), [spendByCategory]);
  const catMax = Math.max(1, ...cats.map((c) => c.amt));
  const biggest = useMemo(() => [...(monthExpenses || [])]
    .sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0)).slice(0, 5), [monthExpenses]);

  return (
    <BubbleModal open={open} onClose={() => onOpenChange(false)} testId="popup-spend"
      title={`Spend · ${monthLabel}`} icon={Flame} accent={AMBER}>
      <PopupHero accent={AMBER} value={`$${fmt(spendMtd)}`}
        caption={spendTrendPct != null ? (
          <span className="font-semibold" style={{ color: spendTrendPct > 0 ? "hsl(0 72% 58%)" : "hsl(155 65% 45%)" }}>
            {spendTrendPct > 0 ? "▲" : "▼"} {Math.abs(Math.round(spendTrendPct))}% vs last month
          </span>
        ) : "spent so far this month"}
        stats={[
          { label: "Daily avg", value: `$${fmt(dailyAvg)}` },
          { label: "Purchases", value: String((monthExpenses || []).length) },
          { label: "Busiest day", value: busiest ? `${monthLabel} ${busiest[0]}` : "—" },
        ]} />

      <div className="space-y-3">
        {/* Daily heat calendar */}
        <div className="bubble p-3">
          <p className="micro-label text-muted-foreground mb-2">Spending heatmap</p>
          <div className="grid grid-cols-7 gap-1 text-center">
            {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
              <span key={`${d}${i}`} className="text-[11px] text-muted-foreground font-medium">{d}</span>
            ))}
            {Array.from({ length: firstWeekday }).map((_, i) => <span key={`pad-${i}`} />)}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const amt = byDay[day] || 0;
              const t = amt / maxDay;
              const isToday = day === today;
              const future = day > today;
              return (
                <div key={day} title={amt > 0 ? `$${fmt(amt)} on day ${day}` : `No spend on day ${day}`}
                  className={`aspect-square rounded-md flex items-center justify-center text-[11px] tabular-nums ${isToday ? "ring-2 ring-offset-1 ring-offset-background" : ""} ${future ? "opacity-35" : ""}`}
                  style={{
                    background: amt > 0 ? `hsl(38 96% 54% / ${0.15 + 0.75 * t})` : "hsl(var(--muted) / 0.5)",
                    color: t > 0.55 ? "hsl(24 30% 12%)" : "hsl(var(--foreground))",
                    ...(isToday ? { ["--tw-ring-color" as any]: amber } : {}),
                  }}>
                  {day}
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
            less
            {[0.15, 0.4, 0.65, 0.9].map((a) => (
              <span key={a} className="h-2.5 w-2.5 rounded-sm" style={{ background: `hsl(38 96% 54% / ${a})` }} />
            ))}
            more
          </div>
        </div>

        {/* Category bars */}
        {cats.length > 0 && (
          <div className="bubble p-3">
            <p className="micro-label text-muted-foreground mb-2">Where it went</p>
            <div className="space-y-2">
              {cats.map((c) => {
                const Icon = catIcon(c.name);
                const pct = spendMtd > 0 ? Math.round((c.amt / spendMtd) * 100) : 0;
                return (
                  <div key={c.name} className="flex items-center gap-2.5">
                    <span className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: "hsl(38 96% 54% / 0.14)" }}>
                      <Icon className="w-3.5 h-3.5" style={{ color: amber }} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="capitalize truncate font-medium">{c.name}</span>
                        <span className="tabular-nums font-semibold shrink-0">${fmt(c.amt)} <span className="text-muted-foreground font-normal">· {pct}%</span></span>
                      </div>
                      <div className="mt-1 h-1.5 rounded-full bg-muted overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${(c.amt / catMax) * 100}%`, background: `linear-gradient(90deg, hsl(38 96% 54%), hsl(24 90% 55%))` }} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Largest purchases — receipt style */}
        {biggest.length > 0 && (
          <div className="bubble -dashed p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <Receipt className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="micro-label text-muted-foreground">Largest purchases</p>
            </div>
            <ul className="divide-y divide-dashed divide-border/70">
              {biggest.map((e) => (
                <li key={e.id} className="flex items-baseline justify-between gap-2 py-1.5 text-xs">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{e.description || e.vendor || e.category || "Expense"}</p>
                    <p className="text-[11px] text-muted-foreground capitalize">{[e.category, e.date ? parseLocalDate(e.date)?.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null].filter(Boolean).join(" · ")}</p>
                  </div>
                  <span className="tabular-nums font-semibold shrink-0">−${fmt(Number(e.amount) || 0)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </BubbleModal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 3 · INCOME — emerald streams
// ═════════════════════════════════════════════════════════════════════════════

const STREAM_COLORS = ["155 65% 45%", "173 60% 44%", "199 89% 60%", "262 80% 66%", "38 96% 54%", "330 80% 62%", "0 72% 58%", "240 10% 60%"];

export function IncomePopup({
  open, onOpenChange, incomes, monthlyIncome,
}: {
  open: boolean; onOpenChange: (o: boolean) => void;
  incomes: any[]; monthlyIncome: number;
}) {
  const emerald = "hsl(155 65% 45%)";
  const sources = useMemo(() => (incomes || [])
    .map((i: any, idx: number) => ({
      id: i.id || String(idx),
      label: i.name || i.source || i.category || "Income",
      freq: String(i.frequency || "monthly"),
      monthly: toMonthlyAmount(Number(i.amount) || 0, i.frequency),
      raw: Number(i.amount) || 0,
    }))
    .filter((s) => s.monthly > 0)
    .sort((a, b) => b.monthly - a.monthly), [incomes]);
  const total = sources.reduce((s, x) => s + x.monthly, 0) || monthlyIncome || 1;
  const top = sources[0];

  return (
    <BubbleModal open={open} onClose={() => onOpenChange(false)} testId="popup-income"
      title="Income · this month" icon={Sparkles} accent={EMERALD}>
      <PopupHero accent={EMERALD} value={`$${fmt(monthlyIncome)}`}
        caption={<>≈ <span className="font-semibold text-foreground">${fmt(monthlyIncome * 12)}</span> / year</>} />
        {/* Stacked source ribbon */}
        {sources.length > 0 && (
          <div className="mt-3">
            <div className="flex h-3 w-full overflow-hidden rounded-full">
              {sources.map((s, i) => (
                <div key={s.id} title={`${s.label} · $${fmt(s.monthly)}/mo`}
                  style={{ width: `${(s.monthly / total) * 100}%`, background: `hsl(${STREAM_COLORS[i % STREAM_COLORS.length]})` }} />
              ))}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
              {sources.slice(0, 4).map((s, i) => (
                <span key={s.id} className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${STREAM_COLORS[i % STREAM_COLORS.length]})` }} />
                  {s.label}
                </span>
              ))}
            </div>
          </div>
        )}

      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          {[
            ["Sources", String(sources.length)],
            ["Largest", top ? `${Math.round((top.monthly / total) * 100)}%` : "—"],
            ["Avg / source", sources.length ? `$${fmt(total / sources.length)}` : "—"],
          ].map(([l, v]) => (
            <div key={l} className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-2 py-2 text-center">
              <p className="micro-label text-muted-foreground">{l}</p>
              <p className="text-sm font-bold tabular-nums" style={{ color: emerald }}>{v}</p>
            </div>
          ))}
        </div>

        {sources.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">No income sources yet — add income from the Finance tab.</p>
        ) : (
          <div className="bubble divide-y divide-/60">
            {sources.map((s, i) => {
              const share = Math.round((s.monthly / total) * 100);
              const color = STREAM_COLORS[i % STREAM_COLORS.length];
              return (
                <div key={s.id} className="px-3 py-2.5" data-testid={`income-source-${s.id}`}>
                  <div className="flex items-center gap-2.5">
                    <span className="h-8 w-1 rounded-full shrink-0" style={{ background: `hsl(${color})` }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold truncate">{s.label}</p>
                      <p className="text-[11px] text-muted-foreground capitalize">
                        {s.freq}{s.freq !== "monthly" ? ` · $${fmt(s.raw)} each` : ""}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-bold tabular-nums" style={{ color: `hsl(${color})` }}>${fmt(s.monthly)}<span className="text-muted-foreground font-normal">/mo</span></p>
                      <p className="text-[11px] text-muted-foreground tabular-nums">{share}% of income</p>
                    </div>
                  </div>
                  <div className="mt-1.5 ml-3.5 h-1 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${share}%`, background: `hsl(${color})` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </BubbleModal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 4 · BILLS DUE — rose timeline
// ═════════════════════════════════════════════════════════════════════════════

function DueChip({ dueDate }: { dueDate?: string }) {
  const d = dueDate ? new Date(dueDate) : null;
  const ok = d && !isNaN(d.getTime());
  return (
    <div className="w-10 shrink-0 rounded-lg border border-border overflow-hidden text-center">
      <div className="micro-label bg-red-500/80 text-white py-0.5">
        {ok ? d!.toLocaleDateString("en-US", { month: "short" }) : "—"}
      </div>
      <div className="py-0.5 text-sm font-bold tabular-nums bg-card">{ok ? d!.getDate() : "?"}</div>
    </div>
  );
}

export function BillsDuePopup({
  open, onOpenChange, bills, onPayBill, payingId,
}: {
  open: boolean; onOpenChange: (o: boolean) => void;
  bills: MoneyBill[]; onPayBill?: (b: MoneyBill) => void; payingId?: string | null;
}) {
  const rose = "hsl(350 80% 58%)";
  const [, navigate] = useLocation();
  // Close before navigating (same body pointer-events fix as HeroKPIPopups).
  const goBill = (b: any) => {
    if (!b.linkedLiabilityId) return;
    onOpenChange(false);
    setTimeout(() => navigate(`/profiles/${b.linkedLiabilityId}`), 0);
  };
  const total = bills.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const groups = useMemo(() => {
    const g: Array<{ key: string; label: string; items: MoneyBill[] }> = [
      { key: "overdue", label: "Overdue", items: [] },
      { key: "today", label: "Due today", items: [] },
      { key: "week", label: "Next 7 days", items: [] },
      { key: "later", label: "Later this month", items: [] },
    ];
    for (const b of bills) {
      const d = Number(b.daysUntil);
      if (d < 0) g[0].items.push(b);
      else if (d === 0) g[1].items.push(b);
      else if (d <= 7) g[2].items.push(b);
      else g[3].items.push(b);
    }
    return g.filter((x) => x.items.length > 0);
  }, [bills]);
  const overdueCount = bills.filter((b) => Number(b.daysUntil) < 0).length;

  return (
    <BubbleModal open={open} onClose={() => onOpenChange(false)} testId="popup-bills"
      title="Bills due · next 30 days" icon={CalendarDays} accent={ROSE} count={bills.length}>
      <PopupHero accent={ROSE}
        value={<>{bills.length}<span className="text-sm font-semibold text-muted-foreground ml-2">bills · ${fmt(total)}</span></>}
        caption={overdueCount > 0
          ? <span className="font-semibold text-red-500">{overdueCount} overdue — needs attention</span>
          : <span className="text-muted-foreground">nothing overdue 🎉</span>} />

      <div>
        {bills.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-8">No bills due in the next 30 days.</p>
        ) : (
          <div className="relative pl-3">
            {/* timeline rail */}
            <div className="absolute left-[3px] top-1 bottom-1 w-px bg-border" />
            <div className="space-y-4">
              {groups.map((g) => (
                <div key={g.key}>
                  <div className="relative mb-1.5">
                    <span className="absolute -left-[13.5px] top-1 h-2.5 w-2.5 rounded-full border-2 border-background"
                      style={{ background: g.key === "overdue" ? "hsl(0 72% 58%)" : g.key === "today" ? "hsl(38 96% 54%)" : rose }} />
                    <p className="micro-label"
                      style={{ color: g.key === "overdue" ? "hsl(0 72% 58%)" : g.key === "today" ? "hsl(38 96% 54%)" : "hsl(var(--muted-foreground))" }}>
                      {g.label} · {g.items.length}
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    {g.items.map((b: any) => (
                      <div key={b.id} className="flex items-center gap-2.5 bubble px-2.5 py-2" data-testid={`bill-row-${b.id}`}>
                        <DueChip dueDate={b.dueDate} />
                        <button type="button" onClick={() => goBill(b)} disabled={!b.linkedLiabilityId}
                          className={`flex-1 min-w-0 text-left ${b.linkedLiabilityId ? "cursor-pointer" : "cursor-default"}`}>
                          <p className="text-xs font-semibold truncate">{b.name}</p>
                          <p className="text-[11px] text-muted-foreground capitalize truncate">
                            {[b.category, (b as any).autopay ? "autopay" : null, dayLabel(Number(b.daysUntil))].filter(Boolean).join(" · ")}
                          </p>
                        </button>
                        <span className="text-sm font-bold tabular-nums shrink-0">${fmt(Number(b.amount) || 0)}</span>
                        {onPayBill && (
                          <Button size="sm" variant={Number(b.daysUntil) < 0 ? "destructive" : "outline"}
                            className="h-7 text-xs shrink-0" disabled={payingId === b.id}
                            onClick={() => onPayBill(b)} data-testid={`bill-pay-${b.id}`}>
                            {payingId === b.id ? "…" : "Pay"}
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </BubbleModal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 5 · SAVINGS RATE — violet gauge
// ═════════════════════════════════════════════════════════════════════════════

const BANDS = [
  { min: -Infinity, max: 0, label: "Spending more than you earn", color: "0 72% 58%" },
  { min: 0, max: 10, label: "Getting started", color: "38 96% 54%" },
  { min: 10, max: 20, label: "Building momentum", color: "199 89% 60%" },
  { min: 20, max: 50, label: "Strong saver", color: "262 80% 66%" },
  { min: 50, max: Infinity, label: "Exceptional", color: "155 65% 45%" },
];

export function SavingsRatePopup({
  open, onOpenChange, incomeMtd, spendMtd,
}: {
  open: boolean; onOpenChange: (o: boolean) => void;
  incomeMtd: number; spendMtd: number;
}) {
  const violet = "hsl(262 80% 66%)";
  const saved = incomeMtd - spendMtd;
  const rate = incomeMtd > 0 ? Math.round((saved / incomeMtd) * 100) : null;
  const r = rate ?? 0;
  const band = r < 0 ? BANDS[0] : (BANDS.find((b) => b.min >= 0 && r >= b.min && r < b.max) || BANDS[BANDS.length - 1]);
  // Semicircle gauge: arc length = π·r; dash the value portion.
  const R = 88, LEN = Math.PI * R;
  const clamped = Math.min(100, Math.max(0, rate ?? 0));

  return (
    <BubbleModal open={open} onClose={() => onOpenChange(false)} testId="popup-savings"
      title="Savings rate · this month" subtitle="Share of income kept after spending"
      icon={Gauge} accent={VIOLET}>
        <div className="flex justify-center">
          <svg viewBox="0 0 220 128" className="w-56">
            <defs>
              <linearGradient id="savings-gauge-grad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="hsl(0 72% 58%)" />
                <stop offset="35%" stopColor="hsl(38 96% 54%)" />
                <stop offset="70%" stopColor="hsl(262 80% 66%)" />
                <stop offset="100%" stopColor="hsl(155 65% 45%)" />
              </linearGradient>
            </defs>
            <path d={`M 22 114 A ${R} ${R} 0 0 1 198 114`} fill="none" stroke="hsl(var(--muted))" strokeWidth="14" strokeLinecap="round" />
            {rate != null && (
              <path d={`M 22 114 A ${R} ${R} 0 0 1 198 114`} fill="none" stroke="url(#savings-gauge-grad)" strokeWidth="14" strokeLinecap="round"
                strokeDasharray={`${(clamped / 100) * LEN} ${LEN}`} />
            )}
            {/* benchmark ticks at 10 / 20 / 50% */}
            {[10, 20, 50].map((p) => {
              const a = Math.PI * (1 - p / 100);
              const x1 = 110 + (R - 12) * Math.cos(a), y1 = 114 - (R - 12) * Math.sin(a);
              const x2 = 110 + (R + 12) * Math.cos(a), y2 = 114 - (R + 12) * Math.sin(a);
              return <line key={p} x1={x1} y1={y1} x2={x2} y2={y2} stroke="hsl(var(--background))" strokeWidth="2.5" />;
            })}
            <text x="110" y="96" textAnchor="middle" className="fill-foreground" style={{ fontSize: 34, fontWeight: 800 }}>
              {rate != null ? `${rate}%` : "—"}
            </text>
            <text x="110" y="112" textAnchor="middle" style={{ fontSize: 9, letterSpacing: 1.5 }} className="fill-muted-foreground">
              OF INCOME KEPT
            </text>
          </svg>
        </div>
        <p className="text-center text-xs font-semibold -mt-1" style={{ color: `hsl(${band.color})` }}>{band.label}</p>

      <div className="space-y-3">
        {/* Equation */}
        <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-1">
          <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-2.5 text-center">
            <p className="micro-label text-muted-foreground">Income</p>
            <p className="text-sm font-bold tabular-nums text-emerald-500">${fmt(incomeMtd)}</p>
          </div>
          <span className="text-lg font-bold text-muted-foreground text-center">−</span>
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-2.5 text-center">
            <p className="micro-label text-muted-foreground">Spend</p>
            <p className="text-sm font-bold tabular-nums text-amber-500">${fmt(spendMtd)}</p>
          </div>
          <span className="text-lg font-bold text-muted-foreground text-center">=</span>
          <div className="rounded-xl border p-2.5 text-center" style={{ borderColor: "hsl(262 80% 66% / 0.4)", background: "hsl(262 80% 66% / 0.08)" }}>
            <p className="micro-label text-muted-foreground">Kept</p>
            <p className="text-sm font-bold tabular-nums" style={{ color: violet }}>{signed(saved)}</p>
          </div>
        </div>

        {/* Benchmark ladder */}
        <div className="bubble p-3">
          <p className="micro-label text-muted-foreground mb-2">Where you stand</p>
          <div className="space-y-1">
            {[...BANDS].reverse().map((b) => {
              const active = b === band;
              const range = b.max === Infinity ? "50%+" : b.min === -Infinity ? "< 0%" : `${b.min}–${b.max}%`;
              return (
                <div key={b.label} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${active ? "font-semibold" : "opacity-60"}`}
                  style={active ? { background: `hsl(${b.color} / 0.12)`, border: `1px solid hsl(${b.color} / 0.35)` } : {}}>
                  <span className="h-2 w-2 rounded-full shrink-0" style={{ background: `hsl(${b.color})` }} />
                  <span className="flex-1">{b.label}</span>
                  <span className="tabular-nums text-muted-foreground">{range}</span>
                  {active && <span style={{ color: `hsl(${b.color})` }}>← you</span>}
                </div>
              );
            })}
          </div>
        </div>

        {/* Projection */}
        {saved > 0 && (
          <div className="bubble p-3 flex items-center gap-3">
            <span className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: "hsl(262 80% 66% / 0.14)" }}>
              <PiggyBank className="w-5 h-5" style={{ color: violet }} />
            </span>
            <p className="text-xs text-muted-foreground">
              Keeping this pace saves <span className="font-bold text-foreground tabular-nums">${fmt(saved * 12)}</span> over the next 12 months.
            </p>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground text-center pb-1">
          Savings rate = (income − spend) ÷ income, using this month&apos;s logged spending.
        </p>
      </div>
    </BubbleModal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 6 · CASH FLOW OVERVIEW — indigo analytics
// ═════════════════════════════════════════════════════════════════════════════

export function CashFlowOverviewPopup({
  open, onOpenChange, cashIn, cashOut, cashTrend, monthLabel,
}: {
  open: boolean; onOpenChange: (o: boolean) => void;
  cashIn: number; cashOut: number; monthLabel: string;
  cashTrend: Array<{ month: string; inflow: number; outflow: number; net: number }>;
}) {
  const indigo = "hsl(234 85% 68%)";
  const net = cashIn - cashOut;
  const total = cashIn + cashOut || 1;
  const R = 52, C = 2 * Math.PI * R;
  const inFrac = cashIn / total;

  return (
    <BubbleModal open={open} onClose={() => onOpenChange(false)} testId="popup-cashflow-overview"
      title="Cash Flow Overview" subtitle="Inflow vs outflow with a six-month trend"
      icon={Layers} accent={INDIGO}>
        <div className="flex items-center gap-4">
          {/* Glowing donut */}
          <svg viewBox="0 0 140 140" className="w-32 h-32 shrink-0">
            <defs>
              <filter id="cfov-glow" x="-40%" y="-40%" width="180%" height="180%">
                <feGaussianBlur stdDeviation="4" result="b" />
                <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>
            <circle cx="70" cy="70" r={R} fill="none" stroke="hsl(0 72% 58% / 0.85)" strokeWidth="14" />
            <circle cx="70" cy="70" r={R} fill="none" stroke="hsl(155 65% 45%)" strokeWidth="14" strokeLinecap="round"
              filter="url(#cfov-glow)" strokeDasharray={`${(C * inFrac).toFixed(1)} ${C.toFixed(1)}`} transform="rotate(-90 70 70)" />
            <text x="70" y="66" textAnchor="middle" className="fill-foreground" style={{ fontSize: 17, fontWeight: 800 }}>{signed(net)}</text>
            <text x="70" y="82" textAnchor="middle" style={{ fontSize: 8, letterSpacing: 1.5 }} className="fill-muted-foreground">NET · {monthLabel}</text>
          </svg>
          <div className="flex-1 space-y-2">
            <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-2.5 py-1.5 flex items-center justify-between">
              <span className="micro-label text-emerald-500">In</span>
              <span className="text-sm font-bold tabular-nums text-emerald-500">${fmt(cashIn)}</span>
            </div>
            <div className="rounded-xl border border-red-500/25 bg-red-500/5 px-2.5 py-1.5 flex items-center justify-between">
              <span className="micro-label text-red-500">Out</span>
              <span className="text-sm font-bold tabular-nums text-red-500">${fmt(cashOut)}</span>
            </div>
            <div className="rounded-xl px-2.5 py-1.5 flex items-center justify-between" style={{ border: `1px solid hsl(234 85% 68% / 0.35)`, background: "hsl(234 85% 68% / 0.08)" }}>
              <span className="micro-label" style={{ color: indigo }}>Net</span>
              <span className="text-sm font-bold tabular-nums" style={{ color: indigo }}>{signed(net)}</span>
            </div>
          </div>
        </div>

      <div className="space-y-3">
        {cashTrend.length >= 2 && (
          <div className="bubble p-3">
            <p className="micro-label text-muted-foreground mb-2">6-month flow</p>
            <div className="h-40 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={cashTrend} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                  <defs>
                    <linearGradient id="cfov-net-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(234 85% 68%)" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="hsl(234 85% 68%)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="month" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} stroke="hsl(var(--muted-foreground))"
                    tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))} />
                  <RTooltip
                    contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 10, fontSize: 12 }}
                    formatter={(v: number, n: string) => [`$${fmt(Number(v))}`, n]} />
                  <Bar dataKey="inflow" name="In" fill="hsl(155 65% 45% / 0.75)" radius={[3, 3, 0, 0]} maxBarSize={14} />
                  <Bar dataKey="outflow" name="Out" fill="hsl(0 72% 58% / 0.75)" radius={[3, 3, 0, 0]} maxBarSize={14} />
                  <Area dataKey="net" name="Net" type="monotone" stroke="hsl(234 85% 68%)" strokeWidth={2.5} fill="url(#cfov-net-fill)" dot={{ r: 2.5 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {cashTrend.length > 0 && (
          <div className="bubble overflow-hidden">
            <div className="micro-label grid grid-cols-4 px-3 py-1.5 border-b border-border bg-muted/30 text-muted-foreground">
              <span>Month</span><span className="text-right">In</span><span className="text-right">Out</span><span className="text-right">Net</span>
            </div>
            {[...cashTrend].reverse().map((m) => (
              <div key={m.month} className="grid grid-cols-4 px-3 py-1.5 border-b border-border/40 last:border-b-0 text-xs tabular-nums">
                <span className="font-medium">{m.month}</span>
                <span className="text-right text-emerald-500">${fmt(m.inflow)}</span>
                <span className="text-right text-red-500">${fmt(m.outflow)}</span>
                <span className="text-right font-bold" style={{ color: m.net >= 0 ? indigo : "hsl(0 72% 58%)" }}>{signed(m.net)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </BubbleModal>
  );
}
