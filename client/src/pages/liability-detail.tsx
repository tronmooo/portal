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
  subtype?: string | null;
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

// Read a liability term consistently — historic data lives across multiple keys.
function readTerms(profile: LiabilityProfileLike) {
  const f = profile.fields || {};
  const currentBalance = Number(
    f.currentBalance ??
      f.remainingBalance ??
      f.loanBalance ??
      f.balance ??
      0,
  ) || 0;
  const originalBalance = Number(
    f.originalBalance ?? f.originalAmount ?? f.principal ?? 0,
  ) || 0;
  const annualRate = normalizeAnnualRate(
    f.annualInterestRate ?? f.interestRate ?? f.rate ?? 0,
  );
  const monthlyPayment = Number(f.monthlyPayment ?? f.minimumPayment ?? 0) || 0;
  const remainingTermMonths =
    Number(f.remainingTermMonths ?? f.termMonths ?? 0) || undefined;
  const firstPaymentDate =
    typeof f.firstPaymentDate === "string"
      ? f.firstPaymentDate
      : typeof f.loanStartDate === "string"
      ? f.loanStartDate
      : typeof f.startDate === "string"
      ? f.startDate
      : undefined;
  const lender = (f.lender || f.creditor || "").toString();
  const accountNumberLast4 = (f.accountNumberLast4 || f.last4 || "").toString();
  const dueDay = Number(f.dueDay ?? f.paymentDueDay ?? 0) || undefined;

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

type TabKey = "overview" | "details" | "payments" | "amortization";

export function LiabilityProfilePage({ profile }: LiabilityProfilePageProps) {
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<TabKey>("overview");
  const { toast } = useToast();
  const qc = useQueryClient();

  const terms = useMemo(() => readTerms(profile), [profile]);
  const subtypeLabel =
    profile.subtype && SUBTYPE_LABELS[profile.subtype]
      ? SUBTYPE_LABELS[profile.subtype]
      : SUBTYPE_LABELS[(profile.fields?.subtype || "").toString()] || "Liability";

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
          <TabsList className="grid grid-cols-4 w-full max-w-2xl">
            <TabsTrigger value="overview" data-testid="tab-overview">Overview</TabsTrigger>
            <TabsTrigger value="details" data-testid="tab-details">Details</TabsTrigger>
            <TabsTrigger value="payments" data-testid="tab-payments">Payments</TabsTrigger>
            <TabsTrigger value="amortization" data-testid="tab-amortization">Amortization</TabsTrigger>
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
                      <PaymentRow key={p.id} p={p} expanded />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
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

function PaymentRow({ p, expanded }: { p: LiabilityPayment; expanded?: boolean }) {
  return (
    <div className="px-3 py-2 flex items-center justify-between gap-3" data-testid={`payment-row-${p.id}`}>
      <div className="min-w-0">
        <div className="text-sm font-medium">{fmtUSD(Number(p.amount) || 0)}</div>
        <div className="text-xs text-muted-foreground">{fmtDate(p.paymentDate)}</div>
        {expanded && p.notes ? (
          <div className="text-xs text-muted-foreground mt-0.5 truncate">{p.notes}</div>
        ) : null}
      </div>
      <div className="text-right text-xs text-muted-foreground shrink-0">
        <div>P {fmtUSD(Number(p.principal) || 0)}</div>
        <div>I {fmtUSD(Number(p.interest) || 0)}</div>
        {expanded && p.remainingBalanceAfter != null ? (
          <div className="mt-0.5">Bal {fmtUSD(Number(p.remainingBalanceAfter) || 0)}</div>
        ) : null}
      </div>
    </div>
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
