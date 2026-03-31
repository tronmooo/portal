/**
 * Portol Calculation Engine Registry
 *
 * Each engine receives:
 *   fields:   Record<string, any>  — profile.fields (actual data)
 *   fieldMap: Record<string, string> — maps engine input keys to profile field keys
 *   profileName?: string
 *
 * Usage: fields[fieldMap["principal"]] to get the principal value.
 *
 * Exports:
 *   ENGINE_REGISTRY  — Record<string, React.FC<EngineProps>>
 *   EngineRenderer   — renders the right engine by name
 */

import React, { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import {
  CalendarDays,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Shield,
  Zap,
  Clock,
  AlertCircle,
} from "lucide-react";

// ─────────────────────────────────────────────
// Shared Interface
// ─────────────────────────────────────────────

export interface EngineProps {
  fields: Record<string, any>;
  fieldMap: Record<string, string>;
  profileName?: string;
}

// ─────────────────────────────────────────────
// Helper Utilities
// ─────────────────────────────────────────────

/** Safely read a field value from fields via fieldMap */
function getField(
  fields: Record<string, any>,
  fieldMap: Record<string, string>,
  key: string
): any {
  const mapped = fieldMap[key];
  if (!mapped) return undefined;
  return fields[mapped];
}

/** Format a number as USD currency */
function fmtCurrency(value: number | null | undefined): string {
  if (value == null || isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

/** Format a percentage */
function fmtPct(value: number | null | undefined, decimals = 2): string {
  if (value == null || isNaN(value)) return "—";
  return `${value.toFixed(decimals)}%`;
}

/** Format a date string into readable form */
function fmtDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

/** Add months to a date */
function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

/** Difference in months between two dates */
function monthsDiff(from: Date, to: Date): number {
  return (
    (to.getFullYear() - from.getFullYear()) * 12 +
    (to.getMonth() - from.getMonth())
  );
}

/** PMT — monthly payment for a loan */
function calcPMT(
  principal: number,
  annualRate: number,
  termMonths: number
): number {
  if (annualRate === 0) return principal / termMonths;
  const r = annualRate / 100 / 12;
  return (principal * (r * Math.pow(1 + r, termMonths))) /
    (Math.pow(1 + r, termMonths) - 1);
}

/** CAGR — compound annual growth rate */
function calcCAGR(
  startValue: number,
  endValue: number,
  years: number
): number {
  if (startValue <= 0 || years <= 0) return 0;
  return (Math.pow(endValue / startValue, 1 / years) - 1) * 100;
}

/** Days between two dates */
function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

/** Short month label like "Jan '24" */
function shortMonth(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

// Recharts colour palette
const CHART_COLORS = {
  blue: "#3b82f6",
  green: "#22c55e",
  red: "#ef4444",
  amber: "#f59e0b",
  purple: "#a855f7",
  teal: "#14b8a6",
  slate: "#94a3b8",
};

// ─────────────────────────────────────────────
// Shared sub-components
// ─────────────────────────────────────────────

function StatRow({
  label,
  value,
  valueClass = "",
}: {
  label: string;
  value: React.ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border/40 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-sm tabular-nums font-bold ${valueClass}`}>
        {value}
      </span>
    </div>
  );
}

function MissingData({ message = "Missing required fields" }: { message?: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-2 py-6 text-muted-foreground">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span className="text-sm">{message}</span>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────
// 1. AmortizationEngine
// ─────────────────────────────────────────────

export const AmortizationEngine: React.FC<EngineProps> = ({
  fields,
  fieldMap,
}) => {
  const [showFull, setShowFull] = useState(false);

  const principal = parseFloat(getField(fields, fieldMap, "principal")) || 0;
  const rate = parseFloat(getField(fields, fieldMap, "rate")) || 0;
  const termMonths = parseInt(getField(fields, fieldMap, "term_months")) || 0;
  const startDateStr = getField(fields, fieldMap, "start_date");
  const extraPayment =
    parseFloat(getField(fields, fieldMap, "extra_payment")) || 0;

  if (!principal || !termMonths) {
    return <MissingData message="Set principal and term_months to see amortization." />;
  }

  const monthlyPayment = calcPMT(principal, rate, termMonths);
  const startDate = startDateStr ? new Date(startDateStr) : new Date();

  // Build full amortization schedule
  const schedule: {
    month: number;
    date: string;
    payment: number;
    principal: number;
    interest: number;
    balance: number;
  }[] = [];

  let balance = principal;
  let totalInterest = 0;
  const r = rate / 100 / 12;

  for (let m = 1; m <= termMonths && balance > 0.01; m++) {
    const interestCharge = balance * r;
    const principalCharge = Math.min(
      balance,
      monthlyPayment - interestCharge + extraPayment
    );
    const payment = interestCharge + principalCharge;
    balance = Math.max(0, balance - principalCharge);
    totalInterest += interestCharge;
    schedule.push({
      month: m,
      date: fmtDate(addMonths(startDate, m - 1).toISOString()),
      payment,
      principal: principalCharge,
      interest: interestCharge,
      balance,
    });
    if (balance <= 0) break;
  }

  const payoffDate = fmtDate(
    addMonths(startDate, schedule.length - 1).toISOString()
  );

  // Accelerated schedule (with extra payment)
  let accelMonths = 0;
  let accelInterest = 0;
  if (extraPayment > 0) {
    let b = principal;
    while (b > 0.01 && accelMonths < termMonths) {
      const intCharge = b * r;
      const princCharge = Math.min(
        b,
        monthlyPayment - intCharge + extraPayment
      );
      b = Math.max(0, b - princCharge);
      accelInterest += intCharge;
      accelMonths++;
    }
  }

  // Chart data — yearly aggregates for area chart
  const chartData = schedule
    .filter((_, i) => i % 12 === 0 || i === schedule.length - 1)
    .map((row) => ({
      month: row.date.split(" ")[1]
        ? `${row.date.split(" ")[0]} ${row.date.split(" ")[2]}`
        : row.date,
      principal: Math.round(row.balance),
      interest: Math.round(totalInterest - (schedule.slice(0, row.month).reduce((s, r2) => s + r2.interest, 0))),
    }));

  // Area chart data (balance over time, sampled)
  const areaData = schedule
    .filter((_, i) => i % Math.max(1, Math.floor(schedule.length / 24)) === 0)
    .map((row) => ({
      name: row.date,
      balance: Math.round(row.balance),
      cumulativeInterest: Math.round(
        schedule.slice(0, row.month).reduce((s, r2) => s + r2.interest, 0)
      ),
    }));

  const displayRows = showFull
    ? schedule
    : [...schedule.slice(0, 12), ...(schedule.length > 13 ? [schedule[schedule.length - 1]] : [])];

  return (
    <div className="space-y-4">
      {/* Summary Card */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <DollarSign className="h-4 w-4" />
            Amortization Summary
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-0">
            <StatRow label="Monthly Payment" value={fmtCurrency(monthlyPayment)} valueClass="text-blue-500" />
            <StatRow label="Total Principal" value={fmtCurrency(principal)} />
            <StatRow label="Total Interest" value={fmtCurrency(totalInterest)} valueClass="text-red-500" />
            <StatRow label="Total Cost" value={fmtCurrency(principal + totalInterest)} />
            <StatRow label="Payoff Date" value={payoffDate} />
            {extraPayment > 0 && (
              <>
                <StatRow
                  label={`Accelerated Payoff (extra ${fmtCurrency(extraPayment)}/mo)`}
                  value={fmtDate(addMonths(startDate, accelMonths - 1).toISOString())}
                  valueClass="text-green-500"
                />
                <StatRow
                  label="Interest Saved"
                  value={fmtCurrency(totalInterest - accelInterest)}
                  valueClass="text-green-500"
                />
                <StatRow
                  label="Months Saved"
                  value={`${schedule.length - accelMonths} months`}
                  valueClass="text-green-500"
                />
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Balance Over Time</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={areaData}>
              <defs>
                <linearGradient id="balGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_COLORS.blue} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={CHART_COLORS.blue} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="intGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_COLORS.red} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={CHART_COLORS.red} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/30" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} tickLine={false} />
              <YAxis tick={{ fontSize: 10 }} tickLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
              <Tooltip formatter={(v: number, n: string) => [fmtCurrency(v), n === "balance" ? "Remaining Balance" : "Cumulative Interest"]} />
              <Area type="monotone" dataKey="balance" stroke={CHART_COLORS.blue} fill="url(#balGrad)" strokeWidth={2} />
              <Area type="monotone" dataKey="cumulativeInterest" stroke={CHART_COLORS.red} fill="url(#intGrad)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Amortization Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Amortization Schedule</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/60 bg-muted/30">
                  <th className="text-left px-4 py-2 text-muted-foreground font-medium">#</th>
                  <th className="text-left px-4 py-2 text-muted-foreground font-medium">Date</th>
                  <th className="text-right px-4 py-2 text-muted-foreground font-medium">Payment</th>
                  <th className="text-right px-4 py-2 text-muted-foreground font-medium">Principal</th>
                  <th className="text-right px-4 py-2 text-muted-foreground font-medium">Interest</th>
                  <th className="text-right px-4 py-2 text-muted-foreground font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((row, i) => {
                  const isLast = !showFull && i === 12 && schedule.length > 13;
                  return (
                    <React.Fragment key={row.month}>
                      {isLast && (
                        <tr>
                          <td colSpan={6} className="text-center py-1 text-muted-foreground">
                            <button
                              className="text-xs underline hover:text-foreground"
                              onClick={() => setShowFull(true)}
                            >
                              Show all {schedule.length} payments…
                            </button>
                          </td>
                        </tr>
                      )}
                      <tr className="border-b border-border/30 hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-1.5 tabular-nums">{row.month}</td>
                        <td className="px-4 py-1.5">{row.date}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums">{fmtCurrency(row.payment)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums text-blue-500">{fmtCurrency(row.principal)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums text-red-500">{fmtCurrency(row.interest)}</td>
                        <td className="px-4 py-1.5 text-right tabular-nums font-bold">{fmtCurrency(row.balance)}</td>
                      </tr>
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {showFull && (
            <div className="px-4 py-2">
              <button
                className="text-xs underline text-muted-foreground hover:text-foreground"
                onClick={() => setShowFull(false)}
              >
                Show less
              </button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

// ─────────────────────────────────────────────
// 2. PaymentCalendarEngine
// ─────────────────────────────────────────────

export const PaymentCalendarEngine: React.FC<EngineProps> = ({
  fields,
  fieldMap,
}) => {
  const amount = parseFloat(getField(fields, fieldMap, "amount")) || 0;
  const frequency: string = getField(fields, fieldMap, "frequency") || "monthly";
  const startDateStr: string = getField(fields, fieldMap, "start_date");
  const endDateStr: string | undefined = getField(fields, fieldMap, "end_date");

  if (!amount || !startDateStr) {
    return <MissingData message="Set amount and start_date to see payment calendar." />;
  }

  const startDate = new Date(startDateStr);
  const today = new Date();

  // Frequency config
  const freqConfig: Record<string, { label: string; paymentsPerYear: number; intervalDays: number }> = {
    weekly:    { label: "Weekly",    paymentsPerYear: 52,   intervalDays: 7 },
    monthly:   { label: "Monthly",   paymentsPerYear: 12,   intervalDays: 30 },
    quarterly: { label: "Quarterly", paymentsPerYear: 4,    intervalDays: 91 },
    annual:    { label: "Annual",    paymentsPerYear: 1,    intervalDays: 365 },
  };

  const cfg = freqConfig[frequency] ?? freqConfig["monthly"];
  const annualCost = amount * cfg.paymentsPerYear;

  // Find next payment date
  let nextDate = new Date(startDate);
  while (nextDate <= today) {
    nextDate = new Date(nextDate.getTime() + cfg.intervalDays * 24 * 60 * 60 * 1000);
  }

  // Cancel-by date: if cancelled today, when does service end?
  const cancelByDate = new Date(nextDate.getTime() - 24 * 60 * 60 * 1000);
  const daysUntilNext = daysBetween(today, nextDate);

  // Upcoming 6 payment dates
  const upcomingDates: Date[] = [];
  let d = new Date(nextDate);
  for (let i = 0; i < 6; i++) {
    if (endDateStr && d > new Date(endDateStr)) break;
    upcomingDates.push(new Date(d));
    d = new Date(d.getTime() + cfg.intervalDays * 24 * 60 * 60 * 1000);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarDays className="h-4 w-4" />
            Payment Calendar
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-0">
            <StatRow label="Amount" value={fmtCurrency(amount)} valueClass="text-blue-500" />
            <StatRow label="Frequency" value={cfg.label} />
            <StatRow label="Annual Cost" value={fmtCurrency(annualCost)} />
            <StatRow label="Next Payment" value={fmtDate(nextDate.toISOString())} valueClass="text-amber-500" />
            <StatRow label="Days Until Next" value={`${daysUntilNext} days`} />
            <StatRow label="Cancel By (no charge)" value={fmtDate(cancelByDate.toISOString())} valueClass="text-muted-foreground" />
            {endDateStr && (
              <StatRow label="Service End" value={fmtDate(endDateStr)} />
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Upcoming Payments</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="space-y-2">
            {upcomingDates.map((date, i) => (
              <div key={i} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`h-2 w-2 rounded-full ${i === 0 ? "bg-amber-500" : "bg-muted-foreground/40"}`} />
                  <span className="text-xs text-muted-foreground">
                    {i === 0 ? "Next" : `+${i}`}
                  </span>
                  <span className="text-sm">{fmtDate(date.toISOString())}</span>
                </div>
                <span className="text-sm tabular-nums font-bold">{fmtCurrency(amount)}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

// ─────────────────────────────────────────────
// 3. DepreciationEngine
// ─────────────────────────────────────────────

export const DepreciationEngine: React.FC<EngineProps> = ({
  fields,
  fieldMap,
}) => {
  const purchasePrice = parseFloat(getField(fields, fieldMap, "purchase_price")) || 0;
  const purchaseDateStr: string = getField(fields, fieldMap, "purchase_date");
  const usefulLifeYears = parseFloat(getField(fields, fieldMap, "useful_life_years")) || 0;
  const salvageValue = parseFloat(getField(fields, fieldMap, "salvage_value")) || 0;
  const method: string = getField(fields, fieldMap, "method") || "straight_line";

  if (!purchasePrice || !usefulLifeYears || !purchaseDateStr) {
    return <MissingData message="Set purchase_price, purchase_date, and useful_life_years." />;
  }

  const purchaseDate = new Date(purchaseDateStr);
  const today = new Date();
  const yearsElapsed = Math.max(0, (today.getTime() - purchaseDate.getTime()) / (1000 * 60 * 60 * 24 * 365.25));

  const depreciableBase = purchasePrice - salvageValue;

  // Build year-by-year schedule
  type YearRow = { year: number; bookValue: number; depreciation: number; accumulated: number };
  const schedule: YearRow[] = [];

  if (method === "declining_balance") {
    const rate = 2 / usefulLifeYears; // Double declining
    let bookValue = purchasePrice;
    let accumulated = 0;
    for (let y = 1; y <= usefulLifeYears; y++) {
      const dep = Math.min(bookValue - salvageValue, bookValue * rate);
      accumulated += dep;
      bookValue -= dep;
      schedule.push({ year: y, bookValue: Math.max(salvageValue, bookValue), depreciation: dep, accumulated });
    }
  } else {
    // Straight line
    const annualDep = depreciableBase / usefulLifeYears;
    let bookValue = purchasePrice;
    let accumulated = 0;
    for (let y = 1; y <= usefulLifeYears; y++) {
      bookValue -= annualDep;
      accumulated += annualDep;
      schedule.push({ year: y, bookValue: Math.max(salvageValue, bookValue), depreciation: annualDep, accumulated });
    }
  }

  // Current book value (interpolated)
  const currentYear = Math.min(Math.floor(yearsElapsed), usefulLifeYears - 1);
  const currentBookValue = schedule[currentYear]?.bookValue ?? salvageValue;
  const totalDepreciationToDate = purchasePrice - currentBookValue;
  const currentYearDep = schedule[currentYear]?.depreciation ?? 0;

  // Chart data
  const chartData = [
    { year: "Purchase", value: purchasePrice },
    ...schedule.map((row) => ({ year: `Yr ${row.year}`, value: Math.round(row.bookValue) })),
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingDown className="h-4 w-4" />
            Depreciation Summary
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-0">
            <StatRow label="Purchase Price" value={fmtCurrency(purchasePrice)} />
            <StatRow label="Method" value={method === "declining_balance" ? "Double Declining Balance" : "Straight Line"} />
            <StatRow label="Useful Life" value={`${usefulLifeYears} years`} />
            <StatRow label="Salvage Value" value={fmtCurrency(salvageValue)} />
            <StatRow label="Years Elapsed" value={yearsElapsed.toFixed(1)} />
            <StatRow label="Current Book Value" value={fmtCurrency(currentBookValue)} valueClass="text-blue-500" />
            <StatRow label="Total Depreciation to Date" value={fmtCurrency(totalDepreciationToDate)} valueClass="text-red-500" />
            <StatRow label="This Year's Depreciation" value={fmtCurrency(currentYearDep)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Value Over Time</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/30" />
              <XAxis dataKey="year" tick={{ fontSize: 10 }} tickLine={false} />
              <YAxis tick={{ fontSize: 10 }} tickLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
              <Tooltip formatter={(v: number) => [fmtCurrency(v), "Book Value"]} />
              <Line type="monotone" dataKey="value" stroke={CHART_COLORS.blue} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Depreciation Schedule</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/60 bg-muted/30">
                  <th className="text-left px-4 py-2 text-muted-foreground font-medium">Year</th>
                  <th className="text-right px-4 py-2 text-muted-foreground font-medium">Depreciation</th>
                  <th className="text-right px-4 py-2 text-muted-foreground font-medium">Accumulated</th>
                  <th className="text-right px-4 py-2 text-muted-foreground font-medium">Book Value</th>
                </tr>
              </thead>
              <tbody>
                {schedule.map((row) => (
                  <tr
                    key={row.year}
                    className={`border-b border-border/30 hover:bg-muted/20 transition-colors ${Math.floor(yearsElapsed) + 1 === row.year ? "bg-blue-500/10" : ""}`}
                  >
                    <td className="px-4 py-1.5 tabular-nums">{row.year}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums text-red-500">{fmtCurrency(row.depreciation)}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums">{fmtCurrency(row.accumulated)}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums font-bold">{fmtCurrency(row.bookValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

// ─────────────────────────────────────────────
// 4. PayoffEngine
// ─────────────────────────────────────────────

export const PayoffEngine: React.FC<EngineProps> = ({ fields, fieldMap }) => {
  const [extraMonthly, setExtraMonthly] = useState(0);

  const balance = parseFloat(getField(fields, fieldMap, "balance")) || 0;
  const rate = parseFloat(getField(fields, fieldMap, "rate")) || 0;
  const minPayment = parseFloat(getField(fields, fieldMap, "min_payment")) || 0;

  if (!balance || !minPayment) {
    return <MissingData message="Set balance and min_payment to see payoff projection." />;
  }

  const r = rate / 100 / 12;

  function calcPayoff(payment: number): { months: number; totalInterest: number } {
    if (payment <= 0) return { months: Infinity, totalInterest: Infinity };
    let b = balance;
    let months = 0;
    let totalInterest = 0;
    while (b > 0.01 && months < 1200) {
      const interest = b * r;
      const principal = Math.min(b, payment - interest);
      if (principal <= 0) return { months: Infinity, totalInterest: Infinity };
      b -= principal;
      totalInterest += interest;
      months++;
    }
    return { months, totalInterest };
  }

  const base = calcPayoff(minPayment);
  const accelerated = calcPayoff(minPayment + extraMonthly);

  const today = new Date();
  const basePayoffDate =
    base.months < 1200
      ? fmtDate(addMonths(today, base.months).toISOString())
      : "Never";
  const accelPayoffDate =
    accelerated.months < 1200
      ? fmtDate(addMonths(today, accelerated.months).toISOString())
      : "Never";

  const interestSaved = base.totalInterest - accelerated.totalInterest;
  const monthsSaved = base.months - accelerated.months;

  const maxExtra = Math.round(balance / 10 / 50) * 50 + 50;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Debt Payoff Projection
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-0">
            <StatRow label="Current Balance" value={fmtCurrency(balance)} valueClass="text-red-500" />
            <StatRow label="Interest Rate" value={fmtPct(rate)} />
            <StatRow label="Minimum Payment" value={fmtCurrency(minPayment)} />
            <StatRow label="Months to Payoff" value={base.months < 1200 ? `${base.months} mo` : "—"} />
            <StatRow label="Total Interest (min pay)" value={fmtCurrency(base.totalInterest)} valueClass="text-red-500" />
            <StatRow label="Total Cost" value={fmtCurrency(balance + base.totalInterest)} />
            <StatRow label="Debt-Free Date" value={basePayoffDate} valueClass="text-green-500" />
          </div>
        </CardContent>
      </Card>

      {/* What-if slider */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">What If You Pay More?</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="flex justify-between text-xs text-muted-foreground mb-2">
              <span>Extra per month</span>
              <span className="font-bold tabular-nums text-foreground">{fmtCurrency(extraMonthly)}</span>
            </div>
            <Slider
              min={0}
              max={maxExtra}
              step={25}
              value={[extraMonthly]}
              onValueChange={([v]) => setExtraMonthly(v)}
            />
            <div className="flex justify-between text-xs text-muted-foreground mt-1">
              <span>$0</span>
              <span>{fmtCurrency(maxExtra)}</span>
            </div>
          </div>

          {extraMonthly > 0 && (
            <div className="space-y-0 border-t border-border/40 pt-3">
              <StatRow label="Total Payment" value={fmtCurrency(minPayment + extraMonthly)} valueClass="text-blue-500" />
              <StatRow label="New Payoff" value={`${accelerated.months} months`} valueClass="text-green-500" />
              <StatRow label="Months Saved" value={monthsSaved > 0 ? `${monthsSaved} months` : "—"} valueClass="text-green-500" />
              <StatRow label="Accelerated Payoff Date" value={accelPayoffDate} valueClass="text-green-500" />
              <StatRow label="Interest Saved" value={fmtCurrency(interestSaved)} valueClass="text-green-500" />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

// ─────────────────────────────────────────────
// 5. EquityEngine
// ─────────────────────────────────────────────

export const EquityEngine: React.FC<EngineProps> = ({ fields, fieldMap }) => {
  const marketValue = parseFloat(getField(fields, fieldMap, "market_value")) || 0;
  const loanBalance = parseFloat(getField(fields, fieldMap, "loan_balance")) || 0;

  if (!marketValue) {
    return <MissingData message="Set market_value to see equity calculation." />;
  }

  const equity = marketValue - loanBalance;
  const equityPct = (equity / marketValue) * 100;
  const ltvRatio = loanBalance > 0 ? (loanBalance / marketValue) * 100 : 0;

  const pieData = [
    { name: "Equity", value: Math.max(0, equity) },
    { name: "Debt", value: Math.max(0, loanBalance) },
  ];

  const PIE_COLORS = [CHART_COLORS.green, CHART_COLORS.red];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Equity Position
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-0">
            <StatRow label="Market Value" value={fmtCurrency(marketValue)} />
            <StatRow label="Loan Balance" value={fmtCurrency(loanBalance)} valueClass="text-red-500" />
            <StatRow label="Current Equity" value={fmtCurrency(equity)} valueClass={equity >= 0 ? "text-green-500" : "text-red-500"} />
            <StatRow label="Equity %" value={fmtPct(equityPct)} valueClass={equityPct >= 20 ? "text-green-500" : "text-amber-500"} />
            <StatRow label="LTV Ratio" value={fmtPct(ltvRatio)} valueClass={ltvRatio > 80 ? "text-red-500" : "text-green-500"} />
          </div>
          {ltvRatio > 80 && (
            <div className="mt-3 flex items-center gap-2 text-xs text-amber-500 bg-amber-500/10 rounded-md px-3 py-2">
              <AlertCircle className="h-3 w-3 shrink-0" />
              LTV above 80% — PMI may apply
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Equity vs Debt</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={pieData}
                cx="50%"
                cy="50%"
                innerRadius={55}
                outerRadius={80}
                dataKey="value"
                label={({ name, percent }) =>
                  `${name} ${(percent * 100).toFixed(0)}%`
                }
                labelLine={false}
              >
                {pieData.map((_, index) => (
                  <Cell key={index} fill={PIE_COLORS[index]} />
                ))}
              </Pie>
              <Tooltip formatter={(v: number) => fmtCurrency(v)} />
            </PieChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
};

// ─────────────────────────────────────────────
// 6. CostAccumulatorEngine
// ─────────────────────────────────────────────

interface Expense {
  amount: number;
  date: string;
  description?: string;
}

export const CostAccumulatorEngine: React.FC<EngineProps> = ({ fields }) => {
  const expenses: Expense[] = Array.isArray(fields._expenses) ? fields._expenses : [];

  if (expenses.length === 0) {
    return <MissingData message="No expense data found (_expenses array is empty or missing)." />;
  }

  const today = new Date();
  const thisMonth = today.getMonth();
  const thisYear = today.getFullYear();

  let totalAllTime = 0;
  let totalThisMonth = 0;
  let totalThisYear = 0;

  // Monthly aggregation (last 12 months)
  const monthlyMap: Record<string, number> = {};

  expenses.forEach((exp) => {
    const amt = Number(exp.amount) || 0;
    totalAllTime += amt;

    const d = new Date(exp.date);
    if (d.getMonth() === thisMonth && d.getFullYear() === thisYear) {
      totalThisMonth += amt;
    }
    if (d.getFullYear() === thisYear) {
      totalThisYear += amt;
    }

    // Group by month key for last 12 months
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthlyMap[key] = (monthlyMap[key] || 0) + amt;
  });

  // Last 12 months for bar chart
  const last12: { month: string; amount: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    last12.push({
      month: d.toLocaleDateString("en-US", { month: "short" }),
      amount: Math.round(monthlyMap[key] || 0),
    });
  }

  const monthsWithData = Object.keys(monthlyMap).length;
  const monthlyAvg = monthsWithData > 0 ? totalAllTime / monthsWithData : 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <DollarSign className="h-4 w-4" />
            Cost Summary
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-0">
            <StatRow label="Total (All Time)" value={fmtCurrency(totalAllTime)} valueClass="text-red-500" />
            <StatRow label="This Month" value={fmtCurrency(totalThisMonth)} />
            <StatRow label="This Year" value={fmtCurrency(totalThisYear)} />
            <StatRow label="Monthly Average" value={fmtCurrency(monthlyAvg)} />
            <StatRow label="# Transactions" value={expenses.length.toString()} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Spending Last 12 Months</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={last12}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/30" />
              <XAxis dataKey="month" tick={{ fontSize: 10 }} tickLine={false} />
              <YAxis tick={{ fontSize: 10 }} tickLine={false} tickFormatter={(v) => `$${v}`} />
              <Tooltip formatter={(v: number) => [fmtCurrency(v), "Spent"]} />
              <Bar dataKey="amount" fill={CHART_COLORS.blue} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
};

// ─────────────────────────────────────────────
// 7. YieldEngine
// ─────────────────────────────────────────────

interface ValueHistoryEntry {
  date: string;
  value: number;
}

export const YieldEngine: React.FC<EngineProps> = ({ fields, fieldMap }) => {
  const investedAmount = parseFloat(getField(fields, fieldMap, "invested_amount")) || 0;
  const currentValue = parseFloat(getField(fields, fieldMap, "current_value")) || 0;
  const startDateStr: string = getField(fields, fieldMap, "start_date");
  const valueHistory: ValueHistoryEntry[] = Array.isArray(fields._value_history)
    ? fields._value_history
    : [];

  if (!investedAmount || !currentValue) {
    return <MissingData message="Set invested_amount and current_value to see yield." />;
  }

  const totalReturn = currentValue - investedAmount;
  const returnPct = (totalReturn / investedAmount) * 100;

  let cagr: number | null = null;
  if (startDateStr) {
    const startDate = new Date(startDateStr);
    const years = (new Date().getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
    if (years > 0) {
      cagr = calcCAGR(investedAmount, currentValue, years);
    }
  }

  const isPositive = totalReturn >= 0;

  // Chart data — use history if available, otherwise simple two-point
  const chartData =
    valueHistory.length >= 2
      ? valueHistory.map((entry) => ({
          date: fmtDate(entry.date),
          value: entry.value,
        }))
      : [
          { date: fmtDate(startDateStr), value: investedAmount },
          { date: fmtDate(new Date().toISOString()), value: currentValue },
        ];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            {isPositive ? (
              <TrendingUp className="h-4 w-4 text-green-500" />
            ) : (
              <TrendingDown className="h-4 w-4 text-red-500" />
            )}
            Investment Yield
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-0">
            <StatRow label="Amount Invested" value={fmtCurrency(investedAmount)} />
            <StatRow label="Current Value" value={fmtCurrency(currentValue)} />
            <StatRow
              label="Total Return"
              value={`${isPositive ? "+" : ""}${fmtCurrency(totalReturn)}`}
              valueClass={isPositive ? "text-green-500" : "text-red-500"}
            />
            <StatRow
              label="Return %"
              value={`${isPositive ? "+" : ""}${fmtPct(returnPct)}`}
              valueClass={isPositive ? "text-green-500" : "text-red-500"}
            />
            {cagr !== null && (
              <StatRow
                label="Annualized Return (CAGR)"
                value={`${cagr >= 0 ? "+" : ""}${fmtPct(cagr)}`}
                valueClass={cagr >= 0 ? "text-green-500" : "text-red-500"}
              />
            )}
            {startDateStr && (
              <StatRow label="Investment Start" value={fmtDate(startDateStr)} />
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Value History</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="yieldGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={isPositive ? CHART_COLORS.green : CHART_COLORS.red} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={isPositive ? CHART_COLORS.green : CHART_COLORS.red} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/30" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} tickLine={false} />
              <YAxis tick={{ fontSize: 10 }} tickLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
              <Tooltip formatter={(v: number) => [fmtCurrency(v), "Value"]} />
              <Area
                type="monotone"
                dataKey="value"
                stroke={isPositive ? CHART_COLORS.green : CHART_COLORS.red}
                fill="url(#yieldGrad)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
};

// ─────────────────────────────────────────────
// 8. UtilizationEngine
// ─────────────────────────────────────────────

export const UtilizationEngine: React.FC<EngineProps> = ({
  fields,
  fieldMap,
}) => {
  const capacity = parseFloat(getField(fields, fieldMap, "capacity")) || 0;
  const currentUsage = parseFloat(getField(fields, fieldMap, "current_usage")) || 0;
  const unit: string = getField(fields, fieldMap, "unit") || "";

  if (!capacity) {
    return <MissingData message="Set capacity and current_usage to see utilization." />;
  }

  const usagePct = Math.min(100, (currentUsage / capacity) * 100);
  const remaining = capacity - currentUsage;

  type StatusLevel = "Low" | "Medium" | "High" | "Full";
  const getStatus = (pct: number): StatusLevel => {
    if (pct > 95) return "Full";
    if (pct > 80) return "High";
    if (pct > 50) return "Medium";
    return "Low";
  };

  const status = getStatus(usagePct);

  const statusConfig: Record<StatusLevel, { color: string; bg: string; bar: string }> = {
    Low:    { color: "text-green-500",  bg: "bg-green-500/10",  bar: "bg-green-500" },
    Medium: { color: "text-blue-500",   bg: "bg-blue-500/10",   bar: "bg-blue-500" },
    High:   { color: "text-amber-500",  bg: "bg-amber-500/10",  bar: "bg-amber-500" },
    Full:   { color: "text-red-500",    bg: "bg-red-500/10",    bar: "bg-red-500" },
  };

  const cfg = statusConfig[status];

  const fmt = (v: number) =>
    unit ? `${v.toLocaleString()} ${unit}` : v.toLocaleString();

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Zap className="h-4 w-4" />
              Utilization
            </span>
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${cfg.color} ${cfg.bg}`}>
              {status}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-0">
            <StatRow label="Total Capacity" value={fmt(capacity)} />
            <StatRow label="Current Usage" value={fmt(currentUsage)} />
            <StatRow label="Remaining" value={fmt(remaining)} valueClass={remaining > 0 ? "text-green-500" : "text-red-500"} />
            <StatRow label="Utilization %" value={fmtPct(usagePct, 1)} valueClass={cfg.color} />
          </div>

          {/* Progress bar */}
          <div>
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>0{unit ? ` ${unit}` : ""}</span>
              <span>{fmt(capacity)}</span>
            </div>
            <div className="h-4 w-full rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${cfg.bar}`}
                style={{ width: `${usagePct}%` }}
              />
            </div>
            <div className="text-center mt-1 text-sm tabular-nums font-bold">
              {usagePct.toFixed(1)}%
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

// ─────────────────────────────────────────────
// 9. InsuranceCalendarEngine
// ─────────────────────────────────────────────

export const InsuranceCalendarEngine: React.FC<EngineProps> = ({
  fields,
  fieldMap,
}) => {
  const premium = parseFloat(getField(fields, fieldMap, "premium")) || 0;
  const frequency: string = getField(fields, fieldMap, "frequency") || "monthly";
  const deductible = parseFloat(getField(fields, fieldMap, "deductible")) || 0;
  const coverageLimit = parseFloat(getField(fields, fieldMap, "coverage_limit")) || 0;
  const renewalDateStr: string = getField(fields, fieldMap, "renewal_date");

  if (!premium) {
    return <MissingData message="Set premium to see insurance calendar." />;
  }

  const freqMultiplier: Record<string, number> = {
    monthly: 12,
    quarterly: 4,
    "semi-annual": 2,
    annual: 1,
    weekly: 52,
  };

  const multiplier = freqMultiplier[frequency] ?? 12;
  const annualPremium = premium * multiplier;

  const today = new Date();

  // Next payment (assume same frequency as payment calendar)
  const intervalDays = Math.round(365 / multiplier);
  let nextPayment = new Date(today.getTime() + intervalDays * 24 * 60 * 60 * 1000);

  let daysUntilRenewal: number | null = null;
  let renewalBadgeVariant: "default" | "destructive" | "secondary" | "outline" = "secondary";

  if (renewalDateStr) {
    const renewalDate = new Date(renewalDateStr);
    daysUntilRenewal = daysBetween(today, renewalDate);
    if (daysUntilRenewal <= 30) renewalBadgeVariant = "destructive";
    else if (daysUntilRenewal <= 90) renewalBadgeVariant = "default";
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Insurance Calendar
            </span>
            {daysUntilRenewal !== null && (
              <Badge variant={renewalBadgeVariant}>
                {daysUntilRenewal <= 0
                  ? "Renewal Due"
                  : `Renews in ${daysUntilRenewal}d`}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-0">
            <StatRow label="Premium" value={fmtCurrency(premium)} />
            <StatRow label="Payment Frequency" value={frequency.charAt(0).toUpperCase() + frequency.slice(1)} />
            <StatRow label="Annual Premium" value={fmtCurrency(annualPremium)} valueClass="text-blue-500" />
            <StatRow label="Next Payment" value={fmtDate(nextPayment.toISOString())} valueClass="text-amber-500" />
            {renewalDateStr && (
              <StatRow label="Renewal Date" value={fmtDate(renewalDateStr)} valueClass={renewalBadgeVariant === "destructive" ? "text-red-500" : ""} />
            )}
            {daysUntilRenewal !== null && (
              <StatRow label="Days Until Renewal" value={daysUntilRenewal <= 0 ? "Overdue" : `${daysUntilRenewal} days`} valueClass={daysUntilRenewal <= 30 ? "text-red-500" : ""} />
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Coverage Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-0">
            <StatRow label="Deductible" value={deductible ? fmtCurrency(deductible) : "Not set"} />
            <StatRow label="Coverage Limit" value={coverageLimit ? fmtCurrency(coverageLimit) : "Not set"} />
            {deductible > 0 && coverageLimit > 0 && (
              <StatRow
                label="Net Coverage (after deductible)"
                value={fmtCurrency(coverageLimit - deductible)}
                valueClass="text-green-500"
              />
            )}
          </div>
          {daysUntilRenewal !== null && daysUntilRenewal <= 30 && daysUntilRenewal >= 0 && (
            <div className="mt-3 flex items-center gap-2 text-xs text-red-500 bg-red-500/10 rounded-md px-3 py-2">
              <AlertCircle className="h-3 w-3 shrink-0" />
              Renewal in {daysUntilRenewal} day{daysUntilRenewal !== 1 ? "s" : ""} — review your policy
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

// ─────────────────────────────────────────────
// ENGINE_REGISTRY
// ─────────────────────────────────────────────

export const ENGINE_REGISTRY: Record<string, React.FC<EngineProps>> = {
  AmortizationEngine,
  PaymentCalendarEngine,
  DepreciationEngine,
  PayoffEngine,
  EquityEngine,
  CostAccumulatorEngine,
  YieldEngine,
  UtilizationEngine,
  InsuranceCalendarEngine,
};

// ─────────────────────────────────────────────
// EngineRenderer
// ─────────────────────────────────────────────

interface EngineRendererProps {
  engineName: string;
  fields: Record<string, any>;
  fieldMap: Record<string, string>;
  profileName?: string;
}

export const EngineRenderer: React.FC<EngineRendererProps> = ({
  engineName,
  fields,
  fieldMap,
  profileName,
}) => {
  const Engine = ENGINE_REGISTRY[engineName];

  if (!Engine) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-muted-foreground">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="text-sm">
            Unknown engine: <span className="font-mono text-xs">{engineName}</span>
          </span>
        </CardContent>
      </Card>
    );
  }

  return <Engine fields={fields} fieldMap={fieldMap} profileName={profileName} />;
};

export default EngineRenderer;
