import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

/** Detect browser timezone once and reuse across all requests */
export const BROWSER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles';

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
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
      refetchOnWindowFocus: false, // Don't refetch when switching browser tabs
      refetchOnMount: true,        // Refetch if data is stale on mount
      // 2-minute stale time: data fetched < 2 min ago is served from cache INSTANTLY.
      // Balances freshness vs performance — 2 min is enough for normal browsing
      // but still refetches if you've been away from a page for a while.
      staleTime: 2 * 60 * 1000,
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
        // Global: after ANY successful mutation, invalidate dashboard data
        // This ensures deleted documents, updated profiles, etc. are reflected everywhere
        queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
        queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      },
      onError: (error: Error) => {
        console.error("Mutation failed:", error.message);
      },
    },
  },
});

// Expose queryClient for pull-to-refresh
(window as any).__portol_queryClient = queryClient;
