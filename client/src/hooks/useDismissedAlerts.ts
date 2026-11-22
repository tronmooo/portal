// One dismiss store for every shape an alert takes.
//
// A dismissal is an id in the `dismissed_notifications` preference: stored on
// the server (so it follows the user across devices and never lapses), shared
// by the bell, the dashboard's alert rows and its document rows
// (shared/alert-ids). The id carries the DATE, so a renewed document raises a
// new alert; nothing here changes the record itself (Rule 8).
//
// The cache is written on the tap and rolled back on failure: the row leaves at
// once instead of waiting for a round-trip and a refetch.
import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export const DISMISSED_ALERTS_KEY = ["/api/preferences/dismissed_notifications"] as const;
export const DISMISSED_ALERT_LIST_KEY = ["/api/notifications", "dismissed"] as const;

export interface DismissedAlert {
  id: string;
  title: string;
  message?: string;
  entityId?: string;
  entityType?: string;
  dueDate?: string;
}

const settle = () => {
  queryClient.invalidateQueries({ queryKey: DISMISSED_ALERTS_KEY });
  queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
};

/** The dismissed ids, for a surface that only filters by them (no writes). */
export function useDismissedAlertIds(enabled = true): string[] {
  const { data } = useQuery<string[]>({
    queryKey: DISMISSED_ALERTS_KEY,
    enabled,
    queryFn: () => apiRequest("GET", "/api/preferences/dismissed_notifications")
      .then(r => r.json())
      .then(d => { try { const v = JSON.parse(d?.value || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } }),
    staleTime: 60_000,
  });
  return useMemo(() => (Array.isArray(data) ? data : []), [data]);
}

export function useDismissedAlerts(enabled = true) {
  const { toast } = useToast();
  const ids = useDismissedAlertIds(enabled);
  const idSet = useMemo(() => new Set(ids), [ids]);

  const write = (kind: "dismiss" | "restore") => ({
    mutationFn: async (list: string[]) => {
      const res = await apiRequest("POST", `/api/notifications/${kind}`, { ids: list });
      return res.json().catch(() => null);
    },
    onMutate: async (list: string[]) => {
      await queryClient.cancelQueries({ queryKey: DISMISSED_ALERTS_KEY });
      const prev = queryClient.getQueryData<string[]>(DISMISSED_ALERTS_KEY);
      queryClient.setQueryData<string[]>(DISMISSED_ALERTS_KEY, (old) => {
        const cur = Array.isArray(old) ? old : [];
        return kind === "dismiss"
          ? Array.from(new Set([...cur, ...list]))
          : cur.filter((id) => !list.includes(id));
      });
      if (kind === "restore") {
        queryClient.setQueryData<DismissedAlert[]>(DISMISSED_ALERT_LIST_KEY, (old) =>
          Array.isArray(old) ? old.filter((a) => !list.includes(a.id)) : old);
      }
      return { prev };
    },
    onSuccess: (data: any) => {
      // The server answers with the whole stored list: adopt it, so a
      // dismissal made on another device meanwhile is not lost from view.
      if (Array.isArray(data?.ids)) queryClient.setQueryData<string[]>(DISMISSED_ALERTS_KEY, data.ids);
    },
    onError: (_e: unknown, _list: string[], ctx: { prev?: string[] } | undefined) => {
      queryClient.setQueryData(DISMISSED_ALERTS_KEY, ctx?.prev);
      toast({ title: kind === "dismiss" ? "Couldn't dismiss alert" : "Couldn't restore alert", variant: "destructive" });
    },
    onSettled: settle,
  });

  const dismiss = useMutation<any, unknown, string[], { prev?: string[] }>(write("dismiss"));
  const restore = useMutation<any, unknown, string[], { prev?: string[] }>(write("restore"));
  return { ids, idSet, dismiss, restore };
}

/** What the user dismissed and could bring back (read only while `enabled`). */
export function useDismissedAlertList(enabled: boolean) {
  return useQuery<DismissedAlert[]>({
    queryKey: DISMISSED_ALERT_LIST_KEY,
    enabled,
    // Rule 7: a failure stays a failure — the list says it could not load
    // rather than claiming nothing was ever dismissed.
    queryFn: async () => {
      const d = await apiRequest("GET", "/api/notifications/dismissed").then(r => r.json());
      if (!Array.isArray(d?.alerts)) throw new Error("Unexpected response");
      return d.alerts as DismissedAlert[];
    },
    staleTime: 30_000,
  });
}
