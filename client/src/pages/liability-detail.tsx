/**
 * Dedicated profile page for liabilities (mortgage / auto loan / credit card / etc.).
 *
 * Phase 2 scope: Overview · Details · Payments v1 · Amortization tabs.
 * Phase 3+ will layer in payoff calculator, smart actions, viz, linked tabs,
 * documents OCR, calendar auto-events, and subtype-specific UI on top of this.
 */

import { useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ArrowLeft,
  Wallet,
  Calendar as CalendarIcon,
  TrendingDown,
  Percent,
  DollarSign,
  Plus,
  Loader2,
  ChevronRight,
  Calculator,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatApiError } from "@/lib/formatError";
import {
  buildAmortization,
  summarizeLiability,
  allocatePayment,
  normalizeAnnualRate,
  type AmortizationRow,
} from "@shared/liability-calc";

interface LiabilityProfileLike {
  id: string;
  name: string;
  type: string;          // "liability" or legacy "loan"
  type_key?: string | null;  // canonical subtype from DB column
  subtype?: string | null;   // legacy alias
  fields?: any;
  createdAt?: string;
}

interface LiabilityPayment {
  id: string;
  liabilityProfileId: string;
  paymentDate: string;     // ISO YYYY-MM-DD
  amount: number;
  principal: number;
  interest: number;
  fees: number;
  remainingBalanceAfter?: number | null;
  notes?: string | null;
  createdAt?: string;
}

const SUBTYPE_LABELS: Record<string, string> = {
  mortgage: "Mortgage",
  auto_loan: "Auto loan",
  credit_card: "Credit card",
  student_loan: "Student loan",
  medical_debt: "Medical debt",
  business_loan: "Business loan",
  tax_debt: "Tax debt",
  line_of_credit: "Line of credit",
  bnpl: "Buy now pay later",
  personal_loan: "Personal loan",
  financing: "Financing",
  utility_plan: "Utility plan",
  custom: "Other liability",
};

// ─── Formatting helpers ──────────────────────────────────────────────────────

const fmtUSD = (n: number) =>
  Number.isFinite(n)
    ? n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })
    : "$0.00";

const fmtUSDShort = (n: number) =>
  Number.isFinite(n)
    ? n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
    : "$0";

const fmtPct = (decimal: number) => `${(decimal * 100).toFixed(2)}%`;

const fmtDate = (iso?: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

// Read a liability term consistently — data lives across many key shapes:
//   * camelCase keys written by LiabilityProfilePage / older flows
//     (currentBalance, monthlyPayment, annualInterestRate)
//   * snake_case keys written by the registry-driven CreateProfileDialog
//     (current_balance, monthly_payment, interest_rate, loan_term_months,
//      start_date, original_balance, extra_payment)
//   * legacy nested paths (fields.loan.*, fields.finance.*)
function readTerms(profile: LiabilityProfileLike) {
  const f = profile.fields || {};
  const loan = f.loan || {};
  const finance = f.finance || {};
  const pick = (...vals: any[]) => {
    for (const v of vals) {
      if (v == null || v === "") continue;
      const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.\-]/g, "")) : Number(v);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  };
  const currentBalance =
    pick(
      f.currentBalance, f.current_balance,
      f.remainingBalance, f.remaining_balance,
      f.loanBalance, f.loan_balance,
      f.balance,
      finance.currentBalance, finance.current_balance,
      finance.remainingBalance, finance.remaining_balance, finance.balance,
      loan.currentBalance, loan.current_balance,
      loan.remainingBalance, loan.remaining_balance, loan.balance,
    ) || 0;
  const originalBalance =
    pick(
      f.originalBalance, f.original_balance,
      f.originalAmount, f.original_amount,
      f.principal,
      finance.originalBalance, finance.original_balance,
      finance.originalAmount, finance.original_amount,
      loan.originalBalance, loan.original_balance,
      loan.originalAmount, loan.original_amount,
    ) || 0;
  const annualRate = normalizeAnnualRate(
    f.annualInterestRate ??
    f.annual_interest_rate ??
    f.interestRate ??
    f.interest_rate ??
    f.rate ??
    f.apr ??
    finance.interestRate ??
    finance.interest_rate ??
    finance.apr ??
    loan.interestRate ??
    loan.interest_rate ??
    0,
  );
  const monthlyPayment =
    pick(
      f.monthlyPayment, f.monthly_payment,
      f.minimumPayment, f.minimum_payment, f.min_payment,
      finance.monthlyPayment, finance.monthly_payment,
      loan.monthlyPayment, loan.monthly_payment,
    ) || 0;
  // term may be stored as a number, or as "60 months" string
  const parseTermNumber = (raw: any): number => {
    if (raw == null) return 0;
    if (typeof raw === "number") return raw;
    const m = String(raw).match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  };
  const remainingTermMonthsRaw =
    pick(
      f.remainingTermMonths, f.remaining_term_months,
      f.loanTermMonths, f.loan_term_months,
      f.termMonths, f.term_months,
      finance.termMonths, finance.term_months,
      loan.termMonths, loan.term_months,
    ) ||
    parseTermNumber(f.term) ||
    parseTermNumber(finance.term) ||
    parseTermNumber(loan.term);
  const remainingTermMonths = remainingTermMonthsRaw > 0 ? remainingTermMonthsRaw : undefined;
  const rawDate =
    f.firstPaymentDate ??
    f.first_payment_date ??
    f.loanStartDate ??
    f.loan_start_date ??
    f.startDate ??
    f.start_date ??
    finance.startDate ??
    finance.start_date ??
    loan.startDate ??
    loan.start_date ??
    undefined;
  // Reject obviously broken date strings (e.g. accidental year 12024 from a
  // browser date input fat-finger). Year must be 1900–2100.
  let firstPaymentDate: string | undefined = undefined;
  if (typeof rawDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(rawDate)) {
    const yr = parseInt(rawDate.slice(0, 4), 10);
    if (yr >= 1900 && yr <= 2100) firstPaymentDate = rawDate.slice(0, 10);
  }
  const lender = (f.lender || f.creditor || f.servicer || "").toString();
  const accountNumberLast4 = (
    f.accountNumberLast4 ||
    f.account_number_last4 ||
    f.loanNumber ||
    f.loan_number ||
    f.last4 ||
    ""
  ).toString();
  const dueDay =
    pick(f.dueDay, f.due_day, f.paymentDueDay, f.payment_due_day) || undefined;

  return {
    currentBalance,
    originalBalance,
    annualRate,
    monthlyPayment,
    remainingTermMonths,
    firstPaymentDate,
    lender,
    accountNumberLast4,
    dueDay,
  };
}

// ─── Component ───────────────────────────────────────────────────────────────

interface LiabilityProfilePageProps {
  profile: LiabilityProfileLike;
}

type TabKey = "overview" | "details" | "payments" | "amortization" | "calculator";

export function LiabilityProfilePage({ profile }: LiabilityProfilePageProps) {
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<TabKey>("overview");
  const { toast } = useToast();
  const qc = useQueryClient();

  const terms = useMemo(() => readTerms(profile), [profile]);
  // Subtype lookup: type_key is the canonical column on the profiles table
  // (e.g. 'auto_loan', 'mortgage'). We fall back to legacy fields for older
  // rows that might still carry the value inside the JSON blob.
  const subtypeRaw = (
    profile.type_key ||
    profile.subtype ||
    profile.fields?.subtype ||
    profile.fields?.type_key ||
    profile.fields?.liabilityType ||
    ""
  ).toString();
  const subtypeLabel = SUBTYPE_LABELS[subtypeRaw] || "Liability";

  // Payments fetch
  const paymentsQuery = useQuery<LiabilityPayment[]>({
    queryKey: [`/api/liabilities/${profile.id}/payments`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/liabilities/${profile.id}/payments`);
      return res.json();
    },
    enabled: !!profile.id,
  });
  const payments = paymentsQuery.data || [];
  const paymentsTotal = useMemo(
    () => payments.reduce((s, p) => s + (Number(p.amount) || 0), 0),
    [payments],
  );
  const interestPaidToDate = useMemo(
    () => payments.reduce((s, p) => s + (Number(p.interest) || 0), 0),
    [payments],
  );

  // Summary + amortization
  const summary = useMemo(
    () =>
      summarizeLiability({
        currentBalance: terms.currentBalance,
        originalBalance: terms.originalBalance,
        monthlyPayment: terms.monthlyPayment || undefined,
        annualRate: terms.annualRate,
        remainingTermMonths: terms.remainingTermMonths,
        firstPaymentDate: terms.firstPaymentDate,
      }),
    [terms],
  );

  const amortization = useMemo(
    () =>
      buildAmortization({
        currentBalance: terms.currentBalance,
        annualInterestRate: terms.annualRate,
        monthlyPayment: terms.monthlyPayment || undefined,
        remainingTermMonths: terms.remainingTermMonths,
        firstPaymentDate: terms.firstPaymentDate,
      }),
    [terms],
  );

  // Quick payment dialog
  const [paymentDialog, setPaymentDialog] = useState<{
    open: boolean;
    preset: "minimum" | "custom" | "extra" | "interest_only";
    amount: string;
    paymentDate: string;
    notes: string;
  }>({
    open: false,
    preset: "minimum",
    amount: "",
    paymentDate: new Date().toISOString().slice(0, 10),
    notes: "",
  });

  function openPaymentDialog(preset: "minimum" | "custom" | "extra" | "interest_only") {
    let initial = "";
    const monthlyInterest = (terms.currentBalance * terms.annualRate) / 12;
    if (preset === "minimum") initial = (terms.monthlyPayment || summary.monthlyPayment || 0).toFixed(2);
    else if (preset === "extra")
      initial = ((terms.monthlyPayment || summary.monthlyPayment || 0) + 100).toFixed(2);
    else if (preset === "interest_only") initial = monthlyInterest.toFixed(2);
    setPaymentDialog({
      open: true,
      preset,
      amount: initial,
      paymentDate: new Date().toISOString().slice(0, 10),
      notes: "",
    });
  }

  // Reverse a payment — deletes the row and adds the principal+fees back to the balance.
  const reversePaymentMutation = useMutation({
    mutationFn: async (payment: LiabilityPayment) => {
      // Restore principal + fees to the balance (interest doesn't change balance,
      // it accrued separately).
      const restoreAmount = (Number(payment.principal) || 0) + (Number(payment.fees) || 0);
      const newBalance = (terms.currentBalance || 0) + restoreAmount;
      await apiRequest("DELETE", `/api/liability-payments/${payment.id}`);
      await apiRequest("PATCH", `/api/profiles/${profile.id}`, {
        fields: {
          ...(profile.fields || {}),
          currentBalance: newBalance,
          remainingBalance: newBalance,
          loanBalance: newBalance,
        },
      });
    },
    onSuccess: () => {
      toast({ title: "Payment reversed" });
      qc.invalidateQueries({ queryKey: [`/api/liabilities/${profile.id}/payments`] });
      qc.invalidateQueries({ queryKey: ["/api/profiles", profile.id, "detail"] });
      qc.invalidateQueries({ queryKey: ["/api/profiles"] });
      qc.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      qc.invalidateQueries({ queryKey: ["/api/stats"] });
    },
    onError: (err: Error) =>
      toast({
        title: "Could not reverse payment",
        description: formatApiError(err),
        variant: "destructive",
      }),
  });

  const recordPaymentMutation = useMutation({
    mutationFn: async (input: {
      amount: number;
      paymentDate: string;
      notes?: string;
    }) => {
      const split = allocatePayment(
        input.amount,
        terms.currentBalance,
        terms.annualRate,
        0,
      );
      const res = await apiRequest("POST", `/api/liabilities/${profile.id}/payments`, {
        paymentDate: input.paymentDate,
        amount: input.amount,
        principal: split.principal,
        interest: split.interest,
        fees: split.fees,
        remainingBalanceAfter: split.remainingBalanceAfter,
        notes: input.notes || null,
      });
      // Update the profile balance to keep dashboards in sync.
      await apiRequest("PATCH", `/api/profiles/${profile.id}`, {
        fields: {
          ...(profile.fields || {}),
          currentBalance: split.remainingBalanceAfter,
          remainingBalance: split.remainingBalanceAfter,
          loanBalance: split.remainingBalanceAfter,
        },
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Payment recorded" });
      qc.invalidateQueries({ queryKey: [`/api/liabilities/${profile.id}/payments`] });
      qc.invalidateQueries({ queryKey: ["/api/profiles", profile.id, "detail"] });
      qc.invalidateQueries({ queryKey: ["/api/profiles"] });
      qc.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      qc.invalidateQueries({ queryKey: ["/api/stats"] });
      setPaymentDialog((s) => ({ ...s, open: false }));
    },
    onError: (err: Error) =>
      toast({
        title: "Could not record payment",
        description: formatApiError(err),
        variant: "destructive",
      }),
  });

  function submitPayment() {
    const amt = parseFloat(paymentDialog.amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast({
        title: "Enter a payment amount",
        description: "Amount must be greater than zero.",
        variant: "destructive",
      });
      return;
    }
    recordPaymentMutation.mutate({
      amount: amt,
      paymentDate: paymentDialog.paymentDate,
      notes: paymentDialog.notes,
    });
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="overflow-y-auto h-full pb-24" data-testid="liability-profile-page">
      {/* Hero */}
      <div className="px-4 md:px-6 pt-4 pb-5 border-b">
        <div className="flex items-center justify-between mb-3">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 text-muted-foreground"
            onClick={() => navigate("/profiles")}
            data-testid="liability-back"
          >
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back
          </Button>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => openPaymentDialog("minimum")} data-testid="quick-pay-min">
              <Plus className="w-4 h-4 mr-1" />
              Pay minimum
            </Button>
          </div>
        </div>
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-2xl bg-rose-500/10 text-rose-600 flex items-center justify-center">
            <Wallet className="w-7 h-7" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl md:text-2xl font-semibold" data-testid="liability-title">
                {profile.name || subtypeLabel}
              </h1>
              <Badge variant="secondary" data-testid="liability-subtype-badge">
                {subtypeLabel}
              </Badge>
            </div>
            {terms.lender ? (
              <div className="text-sm text-muted-foreground mt-0.5">
                {terms.lender}
                {terms.accountNumberLast4 ? ` · ····${terms.accountNumberLast4}` : ""}
              </div>
            ) : null}
          </div>
        </div>
        {/* KPI strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-4">
          <KpiTile
            label="Current balance"
            value={fmtUSDShort(summary.currentBalance)}
            icon={<DollarSign className="w-4 h-4" />}
            testid="kpi-balance"
          />
          <KpiTile
            label="Monthly payment"
            value={fmtUSDShort(summary.monthlyPayment)}
            icon={<CalendarIcon className="w-4 h-4" />}
            testid="kpi-monthly"
          />
          <KpiTile
            label="APR"
            value={fmtPct(summary.annualRate)}
            icon={<Percent className="w-4 h-4" />}
            testid="kpi-apr"
          />
          <KpiTile
            label="Payoff"
            value={
              summary.remainingMonths > 0
                ? `${summary.remainingMonths} mo`
                : "Paid off"
            }
            sub={summary.remainingMonths > 0 ? fmtDate(summary.payoffDate) : undefined}
            icon={<TrendingDown className="w-4 h-4" />}
            testid="kpi-payoff"
          />
        </div>
        {summary.originalBalance > 0 && (
          <div className="mt-3" data-testid="liability-progress">
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>Paid down</span>
              <span>{summary.payoffProgressPct.toFixed(1)}%</span>
            </div>
            <Progress value={summary.payoffProgressPct} className="h-2" />
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="px-4 md:px-6 pt-4">
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} data-testid="liability-tabs">
          <TabsList className="grid grid-cols-5 w-full max-w-3xl">
            <TabsTrigger value="overview" data-testid="tab-overview">Overview</TabsTrigger>
            <TabsTrigger value="details" data-testid="tab-details">Details</TabsTrigger>
            <TabsTrigger value="payments" data-testid="tab-payments">Payments</TabsTrigger>
            <TabsTrigger value="calculator" data-testid="tab-calculator">Payoff</TabsTrigger>
            <TabsTrigger value="amortization" data-testid="tab-amortization">Schedule</TabsTrigger>
          </TabsList>

          {/* OVERVIEW */}
          <TabsContent value="overview" className="mt-4 space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Quick actions</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <QuickActionButton
                  label="Pay minimum"
                  hint={fmtUSD(terms.monthlyPayment || summary.monthlyPayment)}
                  onClick={() => openPaymentDialog("minimum")}
                  testid="action-min"
                />
                <QuickActionButton
                  label="Pay custom"
                  hint="Choose amount"
                  onClick={() => openPaymentDialog("custom")}
                  testid="action-custom"
                />
                <QuickActionButton
                  label="Extra principal"
                  hint="+$100"
                  onClick={() => openPaymentDialog("extra")}
                  testid="action-extra"
                />
                <QuickActionButton
                  label="Interest only"
                  hint={fmtUSD((terms.currentBalance * terms.annualRate) / 12)}
                  onClick={() => openPaymentDialog("interest_only")}
                  testid="action-interest"
                />
              </CardContent>
            </Card>

            <div className="grid md:grid-cols-2 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Cost of borrowing</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <Row label="Remaining interest"
                    value={fmtUSD(summary.totalRemainingInterest)} />
                  <Row label="Interest paid (history)"
                    value={fmtUSD(interestPaidToDate)} />
                  <Row label="Total payments made"
                    value={fmtUSD(paymentsTotal)} />
                  <Row label="Original balance"
                    value={summary.originalBalance ? fmtUSD(summary.originalBalance) : "—"} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Schedule</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <Row label="Next payment due"
                    value={summary.remainingMonths > 0 ? fmtDate(amortization.rows[0]?.dueDate) : "—"} />
                  <Row label="Payoff date"
                    value={summary.remainingMonths > 0 ? fmtDate(summary.payoffDate) : "Paid off"} />
                  <Row label="Months remaining"
                    value={summary.remainingMonths > 0 ? `${summary.remainingMonths}` : "0"} />
                  <Row label="Lender" value={terms.lender || "—"} />
                </CardContent>
              </Card>
            </div>

            {/* Recent payments preview */}
            <Card>
              <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-base">Recent payments</CardTitle>
                <Button variant="ghost" size="sm" onClick={() => setTab("payments")}>
                  See all
                  <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </CardHeader>
              <CardContent>
                {paymentsQuery.isLoading ? (
                  <div className="space-y-2">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ) : payments.length === 0 ? (
                  <div className="text-sm text-muted-foreground py-3" data-testid="no-payments">
                    No payments recorded yet. Use a quick action above to log one.
                  </div>
                ) : (
                  <div className="divide-y">
                    {payments.slice(0, 5).map((p) => (
                      <PaymentRow key={p.id} p={p} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* DETAILS */}
          <TabsContent value="details" className="mt-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Loan terms</CardTitle>
              </CardHeader>
              <CardContent className="grid md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <Row label="Subtype" value={subtypeLabel} />
                <Row label="Lender / creditor" value={terms.lender || "—"} />
                <Row label="Account ····" value={terms.accountNumberLast4 || "—"} />
                <Row label="Original balance" value={terms.originalBalance ? fmtUSD(terms.originalBalance) : "—"} />
                <Row label="Current balance" value={fmtUSD(terms.currentBalance)} />
                <Row label="Annual interest rate" value={fmtPct(terms.annualRate)} />
                <Row label="Monthly payment" value={fmtUSD(terms.monthlyPayment || summary.monthlyPayment)} />
                <Row label="Remaining term"
                  value={terms.remainingTermMonths ? `${terms.remainingTermMonths} mo` : `${summary.remainingMonths} mo`} />
                <Row label="First payment date" value={fmtDate(terms.firstPaymentDate)} />
                <Row label="Due day of month"
                  value={terms.dueDay ? `Day ${terms.dueDay}` : "—"} />
              </CardContent>
            </Card>
            <p className="text-xs text-muted-foreground mt-3">
              Edit these terms from the standard profile editor. (Inline editing
              comes in Phase 5.)
            </p>
          </TabsContent>

          {/* PAYMENTS */}
          <TabsContent value="payments" className="mt-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm text-muted-foreground">
                {payments.length} payment{payments.length === 1 ? "" : "s"} on record
              </div>
              <Button size="sm" onClick={() => openPaymentDialog("custom")} data-testid="payments-add">
                <Plus className="w-4 h-4 mr-1" />
                Record payment
              </Button>
            </div>
            <Card>
              <CardContent className="p-0">
                {paymentsQuery.isLoading ? (
                  <div className="p-4 space-y-2">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ) : payments.length === 0 ? (
                  <div className="p-6 text-sm text-muted-foreground" data-testid="payments-empty">
                    No payments recorded yet.
                  </div>
                ) : (
                  <div className="divide-y" data-testid="payments-list">
                    {payments.map((p) => (
                      <PaymentRow
                        key={p.id}
                        p={p}
                        expanded
                        onReverse={() => reversePaymentMutation.mutate(p)}
                        reversing={reversePaymentMutation.isPending}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* PAYOFF CALCULATOR */}
          <TabsContent value="calculator" className="mt-4">
            <PayoffCalculator terms={terms} baseSummary={summary} />
          </TabsContent>

          {/* AMORTIZATION */}
          <TabsContent value="amortization" className="mt-4">
            <Card>
              <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-base">Amortization schedule</CardTitle>
                <div className="text-xs text-muted-foreground">
                  {amortization.rows.length} period{amortization.rows.length === 1 ? "" : "s"} ·
                  total interest {fmtUSD(amortization.totalInterest)}
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {amortization.rows.length === 0 ? (
                  <div className="p-6 text-sm text-muted-foreground" data-testid="amort-empty">
                    No schedule available — set a balance, rate, and either a monthly payment or a remaining term.
                  </div>
                ) : (
                  <div className="overflow-x-auto" data-testid="amort-table">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40 text-muted-foreground">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium">#</th>
                          <th className="text-left px-3 py-2 font-medium">Due</th>
                          <th className="text-right px-3 py-2 font-medium">Payment</th>
                          <th className="text-right px-3 py-2 font-medium">Principal</th>
                          <th className="text-right px-3 py-2 font-medium">Interest</th>
                          <th className="text-right px-3 py-2 font-medium">Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {amortization.rows.map((r) => (
                          <AmortRow key={r.paymentNumber} row={r} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Quick payment dialog */}
      <Dialog open={paymentDialog.open} onOpenChange={(o) => setPaymentDialog((s) => ({ ...s, open: o }))}>
        <DialogContent data-testid="payment-dialog">
          <DialogHeader>
            <DialogTitle>
              {paymentDialog.preset === "minimum"
                ? "Pay minimum"
                : paymentDialog.preset === "extra"
                ? "Pay extra principal"
                : paymentDialog.preset === "interest_only"
                ? "Pay interest only"
                : "Record payment"}
            </DialogTitle>
            <DialogDescription>
              We'll split this payment into interest and principal automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="liability-payment-amount">Amount</Label>
              <Input
                id="liability-payment-amount"
                type="number"
                step="0.01"
                min="0"
                value={paymentDialog.amount}
                onChange={(e) => setPaymentDialog((s) => ({ ...s, amount: e.target.value }))}
                data-testid="payment-amount-input"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Estimated split: {(() => {
                  const amt = parseFloat(paymentDialog.amount) || 0;
                  const split = allocatePayment(amt, terms.currentBalance, terms.annualRate, 0);
                  return `${fmtUSD(split.principal)} principal · ${fmtUSD(split.interest)} interest`;
                })()}
              </p>
            </div>
            <div>
              <Label htmlFor="liability-payment-date">Date</Label>
              <Input
                id="liability-payment-date"
                type="date"
                value={paymentDialog.paymentDate}
                onChange={(e) => setPaymentDialog((s) => ({ ...s, paymentDate: e.target.value }))}
                data-testid="payment-date-input"
              />
            </div>
            <div>
              <Label htmlFor="liability-payment-notes">Notes (optional)</Label>
              <Input
                id="liability-payment-notes"
                value={paymentDialog.notes}
                onChange={(e) => setPaymentDialog((s) => ({ ...s, notes: e.target.value }))}
                placeholder="e.g. paid via Chase auto-pay"
                data-testid="payment-notes-input"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPaymentDialog((s) => ({ ...s, open: false }))}>
              Cancel
            </Button>
            <Button onClick={submitPayment} disabled={recordPaymentMutation.isPending} data-testid="payment-submit">
              {recordPaymentMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                "Record payment"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function KpiTile({
  label,
  value,
  sub,
  icon,
  testid,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  testid?: string;
}) {
  return (
    <div className="rounded-lg border p-3 bg-card" data-testid={testid}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-lg font-semibold mt-1 leading-tight">{value}</div>
      {sub ? <div className="text-xs text-muted-foreground mt-0.5">{sub}</div> : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-right">{value}</span>
    </div>
  );
}

function QuickActionButton({
  label,
  hint,
  onClick,
  testid,
}: {
  label: string;
  hint: string;
  onClick: () => void;
  testid?: string;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-lg border p-3 text-left hover:bg-accent transition-colors"
      data-testid={testid}
      type="button"
    >
      <div className="text-sm font-medium">{label}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>
    </button>
  );
}

function PaymentRow({
  p,
  expanded,
  onReverse,
  reversing,
}: {
  p: LiabilityPayment;
  expanded?: boolean;
  onReverse?: () => void;
  reversing?: boolean;
}) {
  return (
    <div className="px-3 py-2 flex items-center justify-between gap-3" data-testid={`payment-row-${p.id}`}>
      <div className="min-w-0">
        <div className="text-sm font-medium">{fmtUSD(Number(p.amount) || 0)}</div>
        <div className="text-xs text-muted-foreground">{fmtDate(p.paymentDate)}</div>
        {expanded && p.notes ? (
          <div className="text-xs text-muted-foreground mt-0.5 truncate">{p.notes}</div>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <div className="text-right text-xs text-muted-foreground shrink-0">
          <div>P {fmtUSD(Number(p.principal) || 0)}</div>
          <div>I {fmtUSD(Number(p.interest) || 0)}</div>
          {expanded && p.remainingBalanceAfter != null ? (
            <div className="mt-0.5">Bal {fmtUSD(Number(p.remainingBalanceAfter) || 0)}</div>
          ) : null}
        </div>
        {expanded && onReverse ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={onReverse}
            disabled={reversing}
            title="Reverse this payment"
            data-testid={`reverse-payment-${p.id}`}
          >
            {reversing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ─── Payoff Calculator ───────────────────────────────────────────────────────

function PayoffCalculator({
  terms,
  baseSummary,
}: {
  terms: ReturnType<typeof readTerms>;
  baseSummary: ReturnType<typeof summarizeLiability>;
}) {
  const [extra, setExtra] = useState<string>("100");
  const [lumpSum, setLumpSum] = useState<string>("0");
  const [targetMonths, setTargetMonths] = useState<string>("");

  const extraNum = Math.max(0, parseFloat(extra) || 0);
  const lumpSumNum = Math.max(0, parseFloat(lumpSum) || 0);
  const targetMonthsNum = Math.max(0, parseInt(targetMonths) || 0);

  const accelerated = useMemo(() => {
    if (terms.currentBalance <= 0) return null;
    const adjustedBalance = Math.max(0, terms.currentBalance - lumpSumNum);
    return buildAmortization({
      currentBalance: adjustedBalance,
      annualInterestRate: terms.annualRate,
      monthlyPayment: terms.monthlyPayment || baseSummary.monthlyPayment || undefined,
      remainingTermMonths: terms.remainingTermMonths,
      firstPaymentDate: terms.firstPaymentDate,
      extraPerPeriod: extraNum,
    });
  }, [terms, lumpSumNum, extraNum, baseSummary.monthlyPayment]);

  // "Pay it off in N months" reverse-solve: compute the required monthly payment
  // for a given target term, given current balance + APR.
  const targetSolve = useMemo(() => {
    if (!targetMonthsNum || terms.currentBalance <= 0) return null;
    const required =
      ((terms.currentBalance) * (terms.annualRate / 12)) /
      (1 - Math.pow(1 + terms.annualRate / 12, -targetMonthsNum));
    const safeRequired = Number.isFinite(required) && required > 0 ? required : terms.currentBalance / targetMonthsNum;
    const projection = buildAmortization({
      currentBalance: terms.currentBalance,
      annualInterestRate: terms.annualRate,
      monthlyPayment: safeRequired,
      firstPaymentDate: terms.firstPaymentDate,
    });
    return { requiredMonthlyPayment: safeRequired, projection };
  }, [terms, targetMonthsNum]);

  const baseMonths = baseSummary.remainingMonths;
  const baseInterest = baseSummary.totalRemainingInterest;
  const accMonths = accelerated?.payoffMonths ?? baseMonths;
  const accInterest = accelerated?.totalInterest ?? baseInterest;
  const monthsSaved = Math.max(0, baseMonths - accMonths);
  const interestSaved = Math.max(0, baseInterest - accInterest);

  return (
    <div className="space-y-4" data-testid="payoff-calculator">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Calculator className="w-4 h-4 text-primary" />
            What if you paid more?
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="calc-extra">Extra principal per month</Label>
              <Input
                id="calc-extra"
                type="number"
                step="10"
                min="0"
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
                data-testid="calc-extra-input"
              />
              <p className="text-xs text-muted-foreground mt-1">Applied on top of the regular monthly payment.</p>
            </div>
            <div>
              <Label htmlFor="calc-lump">One-time lump sum</Label>
              <Input
                id="calc-lump"
                type="number"
                step="100"
                min="0"
                value={lumpSum}
                onChange={(e) => setLumpSum(e.target.value)}
                data-testid="calc-lump-input"
              />
              <p className="text-xs text-muted-foreground mt-1">Applied immediately to the principal balance.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-3 gap-3" data-testid="calc-impact">
        <ImpactTile
          label="Months saved"
          value={monthsSaved > 0 ? `${monthsSaved} mo` : "—"}
          accent="text-emerald-600"
          icon={<TrendingDown className="w-4 h-4" />}
          testid="impact-months"
        />
        <ImpactTile
          label="Interest saved"
          value={interestSaved > 0 ? fmtUSD(interestSaved) : "—"}
          accent="text-emerald-600"
          icon={<DollarSign className="w-4 h-4" />}
          testid="impact-interest"
        />
        <ImpactTile
          label="New payoff date"
          value={accelerated && accMonths > 0 ? fmtDate(accelerated.payoffDate) : "—"}
          accent="text-foreground"
          icon={<CalendarIcon className="w-4 h-4" />}
          testid="impact-payoff"
        />
      </div>

      {/* Side-by-side schedule */}
      <div className="grid md:grid-cols-2 gap-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Current pace</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <Row label="Months remaining" value={`${baseMonths}`} />
            <Row label="Total interest" value={fmtUSD(baseInterest)} />
            <Row label="Payoff date" value={baseMonths > 0 ? fmtDate(baseSummary.payoffDate) : "—"} />
          </CardContent>
        </Card>
        <Card className="border-emerald-500/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              Accelerated
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <Row label="Months remaining" value={`${accMonths}`} />
            <Row label="Total interest" value={fmtUSD(accInterest)} />
            <Row label="Payoff date" value={accMonths > 0 && accelerated ? fmtDate(accelerated.payoffDate) : "—"} />
          </CardContent>
        </Card>
      </div>

      {/* Balance-over-time mini chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Balance over time</CardTitle>
        </CardHeader>
        <CardContent>
          <BalanceChart
            baseRows={baseSummary.remainingMonths > 0 ? buildAmortization({
              currentBalance: terms.currentBalance,
              annualInterestRate: terms.annualRate,
              monthlyPayment: terms.monthlyPayment || baseSummary.monthlyPayment || undefined,
              remainingTermMonths: terms.remainingTermMonths,
              firstPaymentDate: terms.firstPaymentDate,
            }).rows : []}
            acceleratedRows={accelerated?.rows ?? []}
          />
          <div className="flex items-center gap-4 text-xs text-muted-foreground mt-3">
            <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-muted-foreground/50" /> Current pace</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-emerald-500" /> Accelerated</span>
          </div>
        </CardContent>
      </Card>

      {/* Reverse-solve: target months → required payment */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Pay it off by a target date</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label htmlFor="calc-target">Target months until payoff</Label>
            <Input
              id="calc-target"
              type="number"
              step="1"
              min="0"
              value={targetMonths}
              onChange={(e) => setTargetMonths(e.target.value)}
              placeholder="e.g. 36"
              data-testid="calc-target-input"
            />
          </div>
          {targetSolve ? (
            <div className="text-sm space-y-1" data-testid="calc-target-result">
              <Row
                label="Required monthly payment"
                value={fmtUSD(targetSolve.requiredMonthlyPayment)}
              />
              <Row
                label="Total interest at this pace"
                value={fmtUSD(targetSolve.projection.totalInterest)}
              />
              <Row
                label="Final payment"
                value={fmtDate(targetSolve.projection.payoffDate)}
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Enter a target term to see the monthly payment required.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ImpactTile({
  label,
  value,
  accent,
  icon,
  testid,
}: {
  label: string;
  value: string;
  accent: string;
  icon: React.ReactNode;
  testid?: string;
}) {
  return (
    <div className="rounded-lg border p-3 bg-card" data-testid={testid}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className={`text-xl font-semibold mt-1 leading-tight ${accent}`}>{value}</div>
    </div>
  );
}

function BalanceChart({
  baseRows,
  acceleratedRows,
}: {
  baseRows: AmortizationRow[];
  acceleratedRows: AmortizationRow[];
}) {
  if (baseRows.length === 0 && acceleratedRows.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-4" data-testid="chart-empty">
        Set a balance, rate, and payment to see the projection.
      </div>
    );
  }

  const W = 600;
  const H = 140;
  const padding = 8;
  const allRows = [...baseRows, ...acceleratedRows];
  const maxBalance = Math.max(
    1,
    ...allRows.map((r) => r.remainingBalance),
    baseRows[0]?.remainingBalance || 0,
    acceleratedRows[0]?.remainingBalance || 0,
  );
  const maxMonths = Math.max(1, baseRows.length, acceleratedRows.length);

  const toPath = (rows: AmortizationRow[]): string => {
    if (rows.length === 0) return "";
    const startBalance =
      rows[0].remainingBalance + rows[0].principal + rows[0].extraPrincipal;
    const points = [
      [0, startBalance] as const,
      ...rows.map((r, i) => [i + 1, r.remainingBalance] as const),
    ];
    return points
      .map(([m, b], i) => {
        const x = padding + (m / maxMonths) * (W - padding * 2);
        const y = padding + (1 - b / maxBalance) * (H - padding * 2);
        return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" data-testid="balance-chart">
      {/* Grid */}
      <line x1={padding} y1={H - padding} x2={W - padding} y2={H - padding} stroke="currentColor" strokeOpacity="0.1" />
      <line x1={padding} y1={padding} x2={padding} y2={H - padding} stroke="currentColor" strokeOpacity="0.1" />
      {baseRows.length > 0 && (
        <path d={toPath(baseRows)} fill="none" stroke="currentColor" strokeOpacity="0.4" strokeWidth="1.5" />
      )}
      {acceleratedRows.length > 0 && (
        <path d={toPath(acceleratedRows)} fill="none" stroke="#10b981" strokeWidth="2" />
      )}
    </svg>
  );
}

function AmortRow({ row }: { row: AmortizationRow }) {
  return (
    <tr className="border-t">
      <td className="px-3 py-2 text-muted-foreground">{row.paymentNumber}</td>
      <td className="px-3 py-2">{fmtDate(row.dueDate)}</td>
      <td className="px-3 py-2 text-right">{fmtUSD(row.payment)}</td>
      <td className="px-3 py-2 text-right">{fmtUSD(row.principal + row.extraPrincipal)}</td>
      <td className="px-3 py-2 text-right">{fmtUSD(row.interest)}</td>
      <td className="px-3 py-2 text-right">{fmtUSD(row.remainingBalance)}</td>
    </tr>
  );
}

export default LiabilityProfilePage;
