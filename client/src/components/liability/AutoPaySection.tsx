// The Auto Pay setting of one liability (every liability has it: bills,
// subscriptions, loans, cards).
//
// ON  — Portol records the scheduled payment on each due date, marked
//       "Assumed paid" until the user or a bank transaction confirms it, and
//       raises no due-date reminders (unless the user keeps them).
// OFF — nothing is recorded automatically from now on. Payments already
//       recorded, the schedule and the liability itself are left alone.
//
// The switch saves itself (Rule L7: no Save button to forget) through the one
// server door, POST /api/liabilities/:id/autopay.
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Repeat } from "lucide-react";
import { formatFullDate, formatMoneyCents } from "@/lib/format";

interface ScheduleSettings {
  amount: number;
  autopay: boolean;
  autopayReminders?: boolean;
  autopayAccountId?: string | null;
  paused?: boolean;
  nextDue: { date: string; effectiveDate: string; amount: number } | null;
}

/** The one write for the Auto Pay setting (POST /api/liabilities/:id/autopay),
 *  shared by this card and the switch in the liability page's balance card. */
export function useAutoPaySave(liabilityId: string) {
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (body: { enabled?: boolean; accountId?: string | null; reminders?: boolean }) =>
      (await apiRequest("POST", `/api/liabilities/${liabilityId}/autopay`, body)).json(),
    onSuccess: (_data, body) => {
      for (const key of [["/api/liabilities", liabilityId, "schedule"], ["/api/profiles"], ["/api/obligations"], ["/api/notifications"], ["/api/tasks"]]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      if (typeof body.enabled === "boolean") {
        toast({ title: body.enabled ? "Auto Pay is on" : "Auto Pay is off", description: body.enabled ? undefined : "Nothing more will be recorded automatically. Your payment history is unchanged." });
      }
    },
    onError: (e: any) => toast({ title: "Couldn't save Auto Pay", description: e?.message || "Try again.", variant: "destructive" }),
  });
}

export function AutoPaySection({ liabilityId }: { liabilityId: string }) {
  // The same key and fetch as <BillScheduleSection>, so React Query serves
  // both from one request and one cache entry.
  const scheduleKey = ["/api/liabilities", liabilityId, "schedule"];
  const { data } = useQuery<ScheduleSettings>({
    queryKey: scheduleKey,
    queryFn: async () => (await apiRequest("GET", `/api/liabilities/${liabilityId}/schedule?months=12`)).json(),
  });
  const accountsQuery = useQuery<{ accounts: Array<{ id?: string; name?: string; profile?: { id: string; name: string } }> }>({
    queryKey: ["/api/accounts"],
    queryFn: async () => (await apiRequest("GET", "/api/accounts")).json(),
    staleTime: 60_000,
  });
  const accounts = (accountsQuery.data?.accounts || [])
    .map((a) => ({ id: String(a.profile?.id ?? a.id ?? ""), name: String(a.profile?.name ?? a.name ?? "Account") }))
    .filter((a) => a.id);

  const save = useAutoPaySave(liabilityId);

  if (!data) return null;
  const on = data.autopay === true;
  const next = data.nextDue;
  const amount = next?.amount ?? data.amount ?? 0;
  // Auto Pay can only record a payment that has an amount and a day.
  const cannotRecord = on && (!(amount > 0) || !next);

  return (
    <Card data-testid="autopay-section">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base flex items-center gap-2"><Repeat className="w-4 h-4" />Auto Pay</CardTitle>
          <div className="flex items-center gap-2">
            <Label htmlFor={`autopay-${liabilityId}`} className="text-xs text-muted-foreground">{on ? "On" : "Off"}</Label>
            <Switch
              id={`autopay-${liabilityId}`}
              checked={on}
              disabled={save.isPending}
              onCheckedChange={(enabled) => save.mutate({ enabled })}
              aria-label="Auto Pay"
              data-testid="switch-autopay"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground" data-testid="autopay-summary">
          {on
            ? cannotRecord
              ? "Add a payment amount and a due date so Auto Pay has a payment to record."
              : `Portol records the ${formatMoneyCents(amount)} payment on each due date${next ? ` (next: ${formatFullDate(next.effectiveDate)})` : ""}. It is shown as Assumed paid until you or your bank confirm it, and you won't get due-date reminders.`
            : "You record each payment yourself and get a reminder when one is due."}
          {on && data.paused ? " Paused: nothing is recorded while this bill is paused." : ""}
        </p>

        {on && (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border px-3 py-2">
              <Label htmlFor={`autopay-source-${liabilityId}`} className="text-xs">Paid from</Label>
              <select
                id={`autopay-source-${liabilityId}`}
                className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={data.autopayAccountId || ""}
                disabled={save.isPending}
                onChange={(e) => save.mutate({ accountId: e.target.value || null })}
                data-testid="select-autopay-source"
              >
                <option value="">Not set</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <p className="text-[11px] text-muted-foreground mt-1">
                {accounts.length === 0 ? "Add an account in Finance to track where payments come from." : "That account's balance moves with each recorded payment."}
              </p>
            </div>
            <div className="rounded-lg border px-3 py-2 flex items-center justify-between gap-3">
              <div>
                <Label htmlFor={`autopay-reminders-${liabilityId}`} className="text-xs">Remind me anyway</Label>
                <p className="text-[11px] text-muted-foreground">Keep due-date reminders for this one.</p>
              </div>
              <Switch
                id={`autopay-reminders-${liabilityId}`}
                checked={data.autopayReminders === true}
                disabled={save.isPending}
                onCheckedChange={(reminders) => save.mutate({ reminders })}
                data-testid="switch-autopay-reminders"
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
