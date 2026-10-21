// Payoff outlook for an amortizing / revolving liability: the hero (remaining
// balance, payoff date, interest left), the balance falling to zero, and how
// the remaining payments split between principal and interest.
//
// Pure presentation over the page's OWN schedule. liability-detail.tsx already
// builds `summary` (summarizeLiability) and `amortization` (buildAmortization)
// from one set of terms; both are passed in, and the chart series and split are
// read off that same AmortizationResult (shared/liability-payoff), so every
// number here matches the KPI tiles, the Cost-of-borrowing card and the
// amortization table to the cent. Nothing is recomputed.
import { useId, useMemo } from "react";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, PieChart, Pie, Cell,
} from "recharts";
import { TrendingDown, CalendarCheck, Percent } from "lucide-react";
import {
  HeroMetric, StatTile, CoverageNote, SectionTitle, MeterRow, accentScope, tone,
} from "@/components/tracker-detail";
import { formatMoney, formatMoneyRound, formatFullDate, parseLocalDate } from "@/lib/format";
import type { AmortizationResult, LiabilitySummary } from "@shared/liability-calc";
import {
  payoffSeries, principalInterestSplit, type PayoffMissing, type PayoffPoint,
} from "@shared/liability-payoff";

/** Debt palette: amber → orange. */
const DEBT_HS = "43 85%";
const DEBT_HS2 = "25 85%";
const PRINCIPAL_HS = DEBT_HS;
const INTEREST_HS = "350 75%";

const cents = (n: number) => formatMoney(Math.round(n * 100) / 100);

const monthYear = (iso: string) => {
  const d = parseLocalDate(iso);
  return d ? d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }) : "";
};

function listPhrase(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function BalanceTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const p: PayoffPoint = payload[0].payload;
  return (
    <div className="surface-panel bg-popover px-3 py-2 text-xs">
      <p className="font-semibold">{p.paymentNumber === 0 ? "Today" : `${formatFullDate(p.date)} · payment ${p.paymentNumber}`}</p>
      <p className="mt-0.5 tabular-nums"><span className="font-bold text-sm">{cents(p.balance)}</span> <span className="text-muted-foreground">left</span></p>
      {p.paymentNumber > 0 && (
        <p className="text-muted-foreground tabular-nums">{cents(p.interestPaid)} interest paid by then</p>
      )}
    </div>
  );
}

export interface PayoffOutlookProps {
  summary: LiabilitySummary;
  amortization: AmortizationResult;
  todayISO: string;
  /** From shared/liability-payoff payoffMissingFields; non-empty ⇒ a note instead of charts. */
  missing: PayoffMissing[];
}

export function PayoffOutlook({ summary, amortization, todayISO, missing }: PayoffOutlookProps) {
  const gid = useId().replace(/:/g, "");
  const series = useMemo(
    () => (missing.length === 0 ? payoffSeries(amortization, { startBalance: summary.currentBalance, todayISO, maxPoints: 72 }) : []),
    [amortization, summary.currentBalance, todayISO, missing.length],
  );
  const split = useMemo(
    () => (missing.length === 0 ? principalInterestSplit(amortization) : null),
    [amortization, missing.length],
  );

  const scope = { className: "td-scope space-y-3", style: accentScope(DEBT_HS, DEBT_HS2) };

  if (missing.length > 0) {
    return (
      <section {...scope} data-testid="payoff-outlook">
        <div className="bubble p-3.5" data-testid="payoff-outlook-missing">
          <CoverageNote>
            Add the {listPhrase(missing)} to see when this is paid off and how much of what's left is interest.
          </CoverageNote>
        </div>
      </section>
    );
  }

  if (summary.currentBalance <= 0) return null;

  if (amortization.neverAmortizes || series.length < 2 || !split) {
    return (
      <section {...scope} data-testid="payoff-outlook">
        <div className="bubble p-3.5" data-testid="payoff-outlook-never">
          <CoverageNote>
            At {cents(summary.monthlyPayment)} a month the payment doesn't cover the interest, so the balance never
            falls. Raise the payment to see a payoff date.
          </CoverageNote>
        </div>
      </section>
    );
  }

  const months = summary.remainingMonths;
  const color = tone("var(--td-hs)");
  const xTicks = (() => {
    // About five evenly spaced date ticks, always including both ends.
    const n = series.length;
    const want = Math.min(5, n);
    const idx = new Set<number>();
    for (let k = 0; k < want; k++) idx.add(Math.round((k * (n - 1)) / Math.max(1, want - 1)));
    return [...idx].map((i) => series[i].date);
  })();

  return (
    <section {...scope} data-testid="payoff-outlook">
      <HeroMetric
        icon={TrendingDown}
        eyebrow="Remaining balance"
        value={Math.round(summary.currentBalance * 100) / 100}
        unit="$"
        caption={<span data-testid="payoff-outlook-caption">Paid off {formatFullDate(summary.payoffDate)} · {months} payment{months === 1 ? "" : "s"} left</span>}
      />

      <div className="grid grid-cols-2 gap-2.5">
        <StatTile
          label="Payoff date"
          value={<span data-testid="payoff-outlook-date">{monthYear(summary.payoffDate)}</span>}
          basis={`${months} mo at ${formatMoneyRound(summary.monthlyPayment)}/mo`}
          icon={CalendarCheck}
          hs={DEBT_HS}
        />
        <StatTile
          label="Interest left"
          value={<span data-testid="payoff-outlook-interest">{formatMoneyRound(summary.totalRemainingInterest)}</span>}
          basis={`${Math.round(split.interestPct)}% of what's left to pay`}
          icon={Percent}
          hs={INTEREST_HS}
          i={1}
        />
      </div>

      <div className="bubble p-3.5 sm:p-4" data-testid="payoff-chart">
        <SectionTitle title="Balance until payoff" hint={`${monthYear(series[0].date)} → ${monthYear(summary.payoffDate)}`} />
        <div className="h-[180px] -mx-1" role="img"
          aria-label={`Balance falls from ${cents(summary.currentBalance)} today to zero on ${formatFullDate(summary.payoffDate)}`}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 6, right: 6, bottom: 0, left: 6 }}>
              <defs>
                <linearGradient id={`pb${gid}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.45} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <XAxis dataKey="date" ticks={xTicks} tickFormatter={monthYear} tickLine={false} axisLine={false}
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} interval="preserveStartEnd" minTickGap={12} />
              <YAxis hide domain={[0, "dataMax"]} />
              <Tooltip content={<BalanceTooltip />} cursor={{ stroke: "hsl(var(--muted-foreground))", strokeOpacity: 0.3 }} />
              <Area type="monotone" dataKey="balance" stroke={color} strokeWidth={2.25} fill={`url(#pb${gid})`}
                isAnimationActive={false} dot={false} activeDot={{ r: 3.5 }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
          <span>Today {cents(summary.currentBalance)}</span>
          <span>{formatFullDate(summary.payoffDate)} {cents(0)}</span>
        </div>
      </div>

      <div className="bubble p-3.5 sm:p-4" data-testid="payoff-split">
        <SectionTitle title="Where the rest goes" hint={`${cents(split.total)} still to pay`} />
        <div className="flex items-center gap-4">
          <div className="relative h-[112px] w-[112px] shrink-0" role="img"
            aria-label={`${Math.round(100 - split.interestPct)}% principal, ${Math.round(split.interestPct)}% interest`}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={[
                  { name: "Principal", value: split.principal },
                  { name: "Interest", value: split.interest },
                ]} dataKey="value" innerRadius={38} outerRadius={54} startAngle={90} endAngle={-270}
                  stroke="none" paddingAngle={split.interest > 0 ? 2 : 0} isAnimationActive={false}>
                  <Cell fill={tone(PRINCIPAL_HS)} />
                  <Cell fill={tone(INTEREST_HS)} />
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center leading-tight pointer-events-none">
              <span className="metric-value text-lg">{Math.round(split.interestPct)}%</span>
              <span className="text-[11px] text-muted-foreground">interest</span>
            </div>
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            <MeterRow label="Principal" value={formatMoneyRound(split.principal)}
              pct={(split.principal / split.total) * 100} hs={PRINCIPAL_HS} />
            <MeterRow label="Interest" value={formatMoneyRound(split.interest)}
              pct={split.interestPct} hs={INTEREST_HS} />
          </div>
        </div>
      </div>
    </section>
  );
}
