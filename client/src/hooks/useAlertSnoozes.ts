// The synced alert-snooze store (shared/alert-snoozes.ts) as a hook: one
// server preference, read through React Query so every surface and every
// device shows the same hidden set.
import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { ALERT_SNOOZES_PREF, activeSnoozes, addDaysISO, isSnoozed, mergeSnooze, parseSnoozes, type SnoozeMap } from "@shared/alert-snoozes";

const KEY = [`/api/preferences/${ALERT_SNOOZES_PREF}`];

function todayISO(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: BROWSER_TIMEZONE });
}

async function readLatest(): Promise<SnoozeMap> {
  const res = await apiRequest("GET", `/api/preferences/${ALERT_SNOOZES_PREF}`);
  const body = await res.json();
  return parseSnoozes(body?.value);
}

export function useAlertSnoozes() {
  const { data } = useQuery<SnoozeMap>({ queryKey: KEY, queryFn: readLatest, staleTime: 60_000 });
  const today = todayISO();
  const active = useMemo(() => activeSnoozes(data || {}, today), [data, today]);

  /** Hide `key` for `days` days (1 = the rest of today). Returns false on failure. */
  const snooze = useCallback(async (key: string, days: number): Promise<boolean> => {
    const t = todayISO();
    const until = addDaysISO(t, Math.max(0, days - 1));
    const prev = queryClient.getQueryData<SnoozeMap>(KEY) || {};
    queryClient.setQueryData<SnoozeMap>(KEY, mergeSnooze(prev, key, until, t)); // instant
    try {
      // Read-merge-write against the server's latest copy (Rule 7), so a
      // snooze made on another device a moment ago is kept, not overwritten.
      const merged = mergeSnooze(await readLatest(), key, until, t);
      await apiRequest("PUT", `/api/preferences/${ALERT_SNOOZES_PREF}`, { value: JSON.stringify(merged) });
      queryClient.setQueryData<SnoozeMap>(KEY, merged);
      return true;
    } catch {
      queryClient.setQueryData<SnoozeMap>(KEY, prev);
      return false;
    }
  }, []);

  const has = useCallback((key: string) => isSnoozed(active, key, today), [active, today]);
  return { snoozes: active, isSnoozed: has, snooze };
}
