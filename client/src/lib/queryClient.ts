import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

/** Detect browser timezone once and reuse across all requests */
export const BROWSER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles';

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    // Try to parse the body as JSON and extract a friendly message.
    // Server convention: { error: "msg" } or { error: { issues: [{ message }, ...] } } from Zod.
    let friendly = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        const e = parsed.error;
        if (typeof e === 'string') friendly = e;
        else if (e && Array.isArray(e.issues) && e.issues[0]?.message) friendly = e.issues.map((i: any) => i.message).filter(Boolean).join('; ');
        else if (e && typeof e === 'object' && typeof e.message === 'string') friendly = e.message;
        else if (typeof parsed.message === 'string') friendly = parsed.message;
      }
    } catch {
      // Not JSON — keep raw text
    }
    throw new Error(`${res.status}: ${friendly}`);
  }
}

const DEFAULT_TIMEOUT_MS = 60000; // 60s timeout — long enough for document file fetches (base64 PDFs/images can be MBs) but bounded so a truly hung request can't freeze the UI forever
const DOC_TIMEOUT_MS = 90000; // 90s for document binary fetches — file_data can be very large
const CHAT_TIMEOUT_MS = 120000; // 120s for chat (complex multi-action queries need multiple AI rounds)

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const timeoutMs = (url.includes('/api/chat') || url.includes('/api/upload')) ? CHAT_TIMEOUT_MS
    : (url.includes('/api/documents/')) ? DOC_TIMEOUT_MS
    : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { "X-Timezone": BROWSER_TIMEZONE };
    if (data) headers["Content-Type"] = "application/json";
    const res = await fetch(`${API_BASE}${url}`, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
      signal: controller.signal,
    });
    await throwIfResNotOk(res);
    return res;
  } catch (err: any) {
    if (err.name === 'AbortError') throw new Error('Request timed out. Please try again.');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey, signal }) => {
    // Build URL from queryKey — first element is the path, rest are ignored (used for cache segmentation)
    const url = String(queryKey[0]);
    // IDLE-FREEZE FIX: enforce a hard timeout on every query so a stuck refetch
    // after the tab regains focus can't hang the UI. React Query passes its own
    // AbortSignal too; we combine both so either path cancels the request.
    const ctrl = new AbortController();
    // Document fetches can carry large base64 file_data — use the longer doc timeout for those.
    const queryTimeoutMs = url.includes('/api/documents/') ? DOC_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => ctrl.abort(), queryTimeoutMs);
    if (signal) {
      signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    let res: Response;
    try {
      res = await window.fetch(`${API_BASE}${url}`, {
        headers: { "X-Timezone": BROWSER_TIMEZONE },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      // Bug #14/#41: a 401 here means the auth interceptor's refresh attempt
      // also failed (or this query bypassed it). Notify the app so the
      // AuthProvider can clear React state and the UI can redirect to /auth
      // instead of staying stuck rendering with null/empty data.
      try {
        window.dispatchEvent(new CustomEvent("portol:auth-cleared", {
          detail: { reason: "query-401", url },
        }));
      } catch { /* ignore */ }
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

/**
 * Helper for optimistic mutations — updates cache immediately, rolls back on error.
 * Usage: const mutation = useOptimisticMutation("/api/expenses", createExpenseFn);
 */
export function optimisticMutationConfig<T>(
  queryKey: string[],
  mutationFn: (data: T) => Promise<any>,
  addToCache: (old: any[], newItem: T) => any[]
) {
  return {
    mutationFn,
    onMutate: async (newData: T) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (old: any) => {
        if (Array.isArray(old)) return addToCache(old, newData);
        return old;
      });
      return { previous };
    },
    onError: (_err: any, _data: T, context: any) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  };
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "returnNull" }),
      refetchInterval: false,
      /* IDLE-FREEZE FIX (2026-05-10):
         The previous combination (refetchOnWindowFocus: true + 30s staleTime
         + ~25 active queries on the dashboard) caused the tab to lock up when
         the user returned after >2 min — every query refetched in parallel
         and the UI froze waiting for the storm to settle.

         New strategy:
         - 5 min staleTime → coming back after a short break uses cached data
           instantly, no refetch.
         - refetchOnWindowFocus: "always" only kicks in when query IS stale
           (>5 min). Combined with React Query's built-in dedupe, this stops
           the storm.
         - networkMode: "always" → queries continue even on flaky network
           instead of leaving in-flight requests hanging forever. */
      refetchOnWindowFocus: true,
      refetchOnReconnect: "always",
      refetchOnMount: true,
      staleTime: 5 * 60_000,             // 5 minutes
      gcTime: 30 * 60_000,               // Keep unused data for 30 min
      networkMode: "always",             // Don't hang on flaky network
      retry: (failureCount, error) => {
        if (error instanceof Error) {
          const msg = error.message;
          if (msg.includes("401") || msg.includes("403") || msg.includes("404")) return false;
          if (msg.includes("500") || msg.includes("502") || msg.includes("503")) return failureCount < 2;
        }
        return failureCount < 1;
      },
    },
    mutations: {
      retry: false,
      onSuccess: () => {
        // Global: after ANY successful mutation, invalidate every collection the
        // dashboard reads from so the KPI tiles, popups, charts and every linked
        // tab card update in real time. Without invalidating /api/profiles,
        // /api/expenses, /api/obligations, and /api/incomes, the FinanceWidget
        // tile and Net Worth popup can keep stale numbers even after a CRUD
        // mutation succeeds.
        queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
        queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
        queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
        queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
        queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
        queryClient.invalidateQueries({ queryKey: ["/api/incomes"] });
        queryClient.invalidateQueries({ queryKey: ["/api/budgets"] });
        queryClient.invalidateQueries({ queryKey: ["/api/budgets/summary"] });
        queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
        queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
        queryClient.invalidateQueries({ queryKey: ["/api/habits"] });
        queryClient.invalidateQueries({ queryKey: ["/api/events"] });
        queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
        queryClient.invalidateQueries({ queryKey: ["/api/journal-entries"] });
        queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
        queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
        queryClient.invalidateQueries({ queryKey: ["/api/activity"] });
        queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
        queryClient.invalidateQueries({ queryKey: ["/api/insights"] });
        queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
        queryClient.invalidateQueries({ queryKey: ["/api/loans/schedule"] });
        queryClient.invalidateQueries({ queryKey: ["/api/paychecks"] });
        queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
        queryClient.invalidateQueries({ queryKey: ["/api/artifacts"] });
        queryClient.invalidateQueries({ queryKey: ["/api/ai-digest"] });
      },
      onError: (error: Error) => {
        console.error("Mutation failed:", error.message);
      },
    },
  },
});

// Expose queryClient for pull-to-refresh
(window as any).__portol_queryClient = queryClient;
