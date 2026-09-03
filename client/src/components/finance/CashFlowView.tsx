// ── CashFlowView — THE Cash Flow drill-down, for every entry point ───────────
// One data type, one UI (user rule 2026-08-13): pressing "Cash Flow" anywhere
// in the app — the Executive overview bar, the hub KPI strip, the dashboard
// hero tiles, the Finance tab — must open the SAME interface. That interface
// is the sky waterfall (CashFlowWaterfallPopup in finance/MoneyPopups): In →
// Recurring → One-time → Net, with the money-in / money-out ledgers under it.
//
// MoneyPopups stays pure presentation by charter (finance.tsx passes it
// props), so this wrapper owns the fetching for the callers that don't
// already hold the numbers. The derivations mirror finance.tsx exactly —
// monthly income via toMonthlyAmount, spend and recurring from the server's
// finance snapshot — so the popup shows the same figures wherever it was
// opened from.
//
// The previous second implementation (HeroKPIPopups.CashFlowPopup, the
// "Cash Flow — this month" list view) is deleted; two UIs for one number is
// how the app stops feeling like one product.
import { useQuery } from "@tanstack/react-query";
import { apiRequest, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { toMonthlyAmount, sumMonthlyIncomeNow } from "@shared/obligation-windows";
import { CashFlowWaterfallPopup } from "@/components/finance/MoneyPopups";

export function CashFlowView({ open, onOpenChange, filterMode, filterIds }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  filterMode: string;
  filterIds: string[];
}) {
  const param = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";

  // Same cache slots the dashboard/bootstrap already fill — on the happy path
  // opening this popup issues zero new requests.
  const { data: enhanced } = useQuery<any>({
    queryKey: ["/api/dashboard-enhanced", filterMode, ...filterIds],
    queryFn: async () => (await apiRequest("GET", `/api/dashboard-enhanced${param}`)).json(),
    enabled: open,
    staleTime: 30_000,
  });
  const { data: incomesRaw } = useQuery<any>({
    queryKey: ["/api/incomes", filterMode, ...filterIds, "hero"],
    queryFn: () => apiRequest("GET", `/api/incomes${param}`).then(r => r.json()),
    enabled: open,
    staleTime: 60_000,
  });

  const incomes: any[] = Array.isArray(incomesRaw) ? incomesRaw : incomesRaw?.items || [];
  // Mirrors finance.tsx: incomes normalised to monthly via their frequency.
  const monthlyIncome = sumMonthlyIncomeNow(incomes, BROWSER_TIMEZONE);
  const snap = enhanced?.financeSnapshot || {};
  const monthLabel = new Date().toLocaleDateString("en-US", { month: "short", timeZone: BROWSER_TIMEZONE }).toUpperCase();

  return (
    <CashFlowWaterfallPopup
      open={open}
      onOpenChange={onOpenChange}
      monthLabel={monthLabel}
      cashIn={monthlyIncome}
      spendMtd={Number(snap.totalMonthlySpend || 0)}
      recurringOut={Number(snap.monthlyObligationTotal || 0)}
      incomes={incomes}
      spendByCategory={snap.spendByCategory || {}}
    />
  );
}

export default CashFlowView;
