// One payment's status, and the controls that change THAT payment only.
//
// Used by the payment history (addressed by payment id) and by the schedule
// (addressed by occurrence date). Every action goes to one endpoint
// (POST …/status); the recurring amount, due day and Auto Pay setting of the
// liability are never touched from here.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MoreHorizontal } from "lucide-react";
import { PAYMENT_STATUS_META, type OccurrencePaymentStatus } from "@shared/autopay";

const TONE: Record<string, string> = {
  red: "text-red-600 border-red-600",
  amber: "text-amber-600 border-amber-600",
  green: "text-green-600 border-green-600",
  blue: "text-sky-600 border-sky-600",
  muted: "text-muted-foreground",
};

export function PaymentStatusBadge({ status, autopay }: { status: OccurrencePaymentStatus; autopay?: boolean }) {
  const meta = PAYMENT_STATUS_META[status];
  return (
    <Badge variant="outline" className={`text-xs h-5 ${TONE[meta.tone]}`} title={meta.hint} data-testid={`payment-status-${status}`}>
      {meta.label}{autopay && status === "confirmed_paid" ? " · Auto Pay" : ""}
    </Badge>
  );
}

export interface PaymentStatusTarget {
  liabilityId: string;
  /** The payment row, when one exists (history rows, paid occurrences). */
  paymentId?: string | null;
  /** The occurrence's anchor day (schedule rows). */
  occurrenceDate?: string | null;
}

export function PaymentStatusControls({
  target, status, amount, date, onChanged,
}: {
  target: PaymentStatusTarget;
  status: OccurrencePaymentStatus;
  /** The amount recorded (or scheduled) for this payment. */
  amount: number;
  /** The day it is currently set for (YYYY-MM-DD). */
  date: string;
  onChanged?: () => void;
}) {
  const { toast } = useToast();
  const { confirm, isArmed } = useConfirmArm();
  const [open, setOpen] = useState(false);
  const [partial, setPartial] = useState("");
  const [moveTo, setMoveTo] = useState(date);
  const id = target.paymentId || target.occurrenceDate || "";
  const url = target.paymentId
    ? `/api/liability-payments/${target.paymentId}/status`
    : `/api/liabilities/${target.liabilityId}/occurrences/${target.occurrenceDate}/status`;

  const change = useMutation({
    mutationFn: async (body: Record<string, unknown>) => (await apiRequest("POST", url, body)).json(),
    onSuccess: () => {
      setOpen(false);
      for (const key of [
        ["/api/liabilities", target.liabilityId, "schedule"],
        [`/api/liabilities/${target.liabilityId}/payments`],
        ["/api/profiles"], ["/api/expenses"], ["/api/obligations"], ["/api/notifications"],
      ]) queryClient.invalidateQueries({ queryKey: key });
      onChanged?.();
    },
    onError: (e: any) => toast({ title: "Couldn't update this payment", description: e?.message || "Try again.", variant: "destructive" }),
  });
  const send = (body: Record<string, unknown>, done: string) =>
    change.mutate(body, { onSuccess: () => toast({ title: done }) });

  const paid = status === "assumed_paid" || status === "confirmed_paid" || status === "partial";
  const missedKey = `missed-${id}`;
  const missedArmed = isArmed(missedKey);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 px-2" aria-label="Change this payment" title="Change this payment" data-testid={`payment-controls-${id}`}>
          <MoreHorizontal className="w-4 h-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-3" align="end">
        <p className="text-xs text-muted-foreground">
          Changes apply to this payment only. The recurring schedule stays as it is.
        </p>

        {status === "assumed_paid" && (
          <Button size="sm" className="w-full" disabled={change.isPending}
            onClick={() => send({ status: "confirmed" }, "Payment confirmed")} data-testid={`payment-confirm-${id}`}>
            Confirm it was paid
          </Button>
        )}

        {status === "missed" ? (
          <Button size="sm" variant="outline" className="w-full" disabled={change.isPending}
            onClick={() => send({ status: "scheduled" }, "Payment is scheduled again")} data-testid={`payment-unmiss-${id}`}>
            Not missed after all
          </Button>
        ) : (
          // Rule 8: marking a recorded payment missed reverses it (expense,
          // balance, account), so it takes two taps.
          <Button size="sm" variant="outline" disabled={change.isPending}
            className={`w-full ${missedArmed ? "text-destructive border-destructive" : ""}`}
            onClick={() => (paid
              ? confirm(missedKey, () => send({ status: "missed" }, "Marked missed. The payment was reversed."))
              : send({ status: "missed" }, "Marked missed"))}
            data-testid={`payment-missed-${id}`}>
            {missedArmed ? "Tap again to reverse this payment" : "Mark as missed"}
          </Button>
        )}

        <div className="space-y-1">
          <Label className="text-xs">Only part was paid</Label>
          <div className="flex gap-1">
            <Input type="number" inputMode="decimal" step="0.01" min="0" value={partial} placeholder={amount > 0 ? `of ${amount.toFixed(2)}` : "0.00"}
              onChange={(e) => setPartial(e.target.value)} className="h-8" data-testid={`payment-partial-amount-${id}`} />
            <Button size="sm" variant="outline" className="h-8" disabled={change.isPending || !(Number(partial) > 0)}
              onClick={() => send({ status: "partial", amount: Number(partial) }, "Partial payment recorded")}
              data-testid={`payment-partial-${id}`}>Record</Button>
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">{paid ? "It will be paid on another day instead" : "Move this payment to another day"}</Label>
          <div className="flex gap-1">
            <Input type="date" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className="h-8" data-testid={`payment-move-date-${id}`} />
            <Button size="sm" variant="outline" className="h-8" disabled={change.isPending || !moveTo || moveTo === date}
              onClick={() => send({ status: "delayed", movedTo: moveTo }, paid ? "Payment reversed and rescheduled" : "Payment rescheduled")}
              data-testid={`payment-move-${id}`}>Move</Button>
          </div>
          {paid && <p className="text-[11px] text-muted-foreground">The recorded payment is reversed until the new day.</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
