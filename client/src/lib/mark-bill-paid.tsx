// client/src/lib/mark-bill-paid.tsx — One way to record a bill payment.
//
// Recording a payment is the most consequential write a user can trigger by
// accident in this app: it writes a `liability_payments` row, rolls the bill's
// due date forward, and drops the overdue count. Four surfaces fired it, and
// only one of them was safe:
//
//   ObligationsManager  POST /pay → toast with a working Undo   ← the good one
//   ExecutiveBriefing   POST /pay → toast "Payment recorded"
//   finance.tsx         POST /pay → toast "Payment recorded"
//   BriefingPopups      POST /pay → toast "Payment recorded"
//
// The three bare-toast surfaces render the trigger as a neutral outline button
// labelled "Pay" on a *summary* card, where every neighbouring control merely
// navigates. Audit 2026-07-29 (finding P1) recorded a real $90.50 payment by
// misclick during a read-only click-through, and had no way to take it back:
// the only route to removing a single payment was deleting the entire bill.
//
// So this module exists to make the safe path the only path. It is the good
// surface's pattern, extracted verbatim and given the undo window it always
// needed (the shared toast auto-dismissed in 4s, which is not an undo).
//
// Two deliberate choices:
//
//   * The label is "Mark paid", never "Pay". The button records that a payment
//     happened; it does not move money. Naming it "Pay" promised an action the
//     app cannot perform and hid the one it does.
//   * Undo is offered instead of a confirm dialog. Marking a bill paid is a
//     high-frequency action on a summary card, and a modal on every click
//     would be worse than the problem. An undo keeps one click for the common
//     case and still makes the rare misclick reversible.

import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { useToast } from "@/hooks/use-toast";
import { formatApiError } from "@/lib/formatError";
import { Button } from "@/components/ui/button";

/** How long the Undo action stays reachable, in ms. */
export const UNDO_WINDOW_MS = 12_000;

/** The user-facing verb for this action. Import it; do not retype "Pay". */
export const MARK_PAID_LABEL = "Mark paid";

/** Minimum shape a caller must supply. Any bill/obligation row satisfies it. */
export interface PayableBill {
  id: string;
  name?: string | null;
  amount?: number | string | null;
}

function billLabel(bill: PayableBill): string {
  const n = String(bill.name ?? "").trim();
  return n ? `"${n}"` : "Bill";
}

function amountLabel(bill: PayableBill): string | null {
  const n = Number(bill.amount);
  return Number.isFinite(n) && n > 0 ? `$${n.toFixed(2)}` : null;
}

// Every surface that records a payment invalidates the same set. Previously
// each one picked its own subset, so paying from the dashboard left the
// Finance page's bill list stale and vice versa.
function invalidatePaymentSurfaces() {
  // The obligations domain covers /api/obligations, dashboard-enhanced, stats,
  // cashflow and loans/schedule. Bootstrap and the calendar timeline have no
  // matching domain entry, so they stay explicit.
  invalidateDomain("obligations");
  queryClient.invalidateQueries({ queryKey: ["/api/dashboard-bootstrap"] });
  queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
}

/**
 * Record a bill payment, with an undo the user can actually reach.
 *
 * Returns `markPaid(bill)` plus `pendingId` so a caller can disable the one
 * row being written without freezing the whole list.
 */
export function useMarkBillPaid() {
  const { toast } = useToast();

  const undoPay = useMutation<unknown, Error, PayableBill>({
    // The dedicated DELETE route removes the most recent payment row. An
    // earlier attempt at undo elsewhere PATCHed `{ isPaid: false }` against a
    // route with no such field: the server dropped it and the bill stayed paid.
    mutationFn: (bill) => apiRequest("DELETE", `/api/obligations/${bill.id}/last-payment`),
    onSuccess: (_d, bill) => {
      invalidatePaymentSurfaces();
      toast({ title: `${billLabel(bill)} payment undone` });
    },
    onError: (err) => toast({
      title: "Couldn't undo the payment",
      description: formatApiError(err),
      variant: "destructive",
    }),
  });

  const pay = useMutation<unknown, Error, PayableBill>({
    mutationFn: (bill) => apiRequest("POST", `/api/obligations/${bill.id}/pay`, {}),
    onSuccess: (_d, bill) => {
      invalidatePaymentSurfaces();
      const amt = amountLabel(bill);
      toast({
        title: `${billLabel(bill)} marked paid`,
        description: amt
          ? `${amt} recorded · next due date advanced`
          : "Next due date advanced",
        // Radix auto-closes on this too, so the visible toast and the
        // dismiss timer agree on one window.
        duration: UNDO_WINDOW_MS,
        action: (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => undoPay.mutate(bill)}
            data-testid={`undo-pay-${bill.id}`}
          >
            Undo
          </Button>
        ),
      });
    },
    onError: (err, bill) => toast({
      title: `Couldn't mark ${billLabel(bill)} paid`,
      description: formatApiError(err),
      variant: "destructive",
    }),
  });

  return {
    markPaid: (bill: PayableBill) => pay.mutate(bill),
    isPending: pay.isPending,
    /** Id of the bill currently being written, for per-row disabled state. */
    pendingId: pay.isPending ? (pay.variables?.id ?? null) : null,
  };
}
