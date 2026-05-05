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

const DEFAULT_TIMEOUT_MS = 30000; // 30s timeout for most API requests
const CHAT_TIMEOUT_MS = 120000; // 120s for chat (complex multi-action queries need multiple AI rounds)

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const timeoutMs = (url.includes('/api/chat') || url.includes('/api/upload')) ? CHAT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
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
  async ({ queryKey }) => {
    // Build URL from queryKey — first element is the path, rest are ignored (used for cache segmentation)
    const url = String(queryKey[0]);
    const res = await window.fetch(`${API_BASE}${url}`, {
      headers: { "X-Timezone": BROWSER_TIMEZONE },
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
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
      // Refetch on window focus so coming back to the tab shows fresh data.
      // This is stale-while-revalidate — cached data renders instantly, then
      // a background fetch updates with anything that changed (e.g. mutations
      // made in another tab or device). Combined with our 5s staleTime so
      // we don't hammer the API for quick alt-tabs.
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,    // Same idea after a network blip
      refetchOnMount: true,        // Refetch if data is stale on mount
      // 5-second stale time: data shows instantly from cache, but refetches in background
      // after 5 seconds. This means navigating between pages always gets fresh data
      // while still feeling instant (cache serves immediately, refetch updates in background).
      staleTime: 5000,
      gcTime: 30 * 60 * 1000, // Keep unused data for 30 minutes
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
