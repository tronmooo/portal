import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

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
    const res = await fetch(`${API_BASE}${url}`, {
      method,
      headers: data ? { "Content-Type": "application/json" } : {},
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
    const res = await window.fetch(`${API_BASE}${url}`);

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "returnNull" }),
      refetchInterval: false,
      refetchOnWindowFocus: false, // Don't refetch when switching tabs
      refetchOnMount: true, // Refetch on mount if stale
      staleTime: 0, // Data is always stale — refetch on every mount, but show cached instantly
      gcTime: 10 * 60 * 1000, // Keep cached data for 10 minutes (shows instantly while refetching)
      retry: (failureCount, error) => {
        // Don't retry auth errors or client errors
        if (error instanceof Error) {
          const msg = error.message;
          if (msg.includes("401") || msg.includes("403") || msg.includes("404")) return false;
          // Retry 5xx server errors up to 2 times
          if (msg.includes("500") || msg.includes("502") || msg.includes("503")) return failureCount < 2;
        }
        return failureCount < 1;
      },
    },
    mutations: {
      retry: false,
      onError: (error: Error) => {
        // Global fallback — individual mutation onError handlers take precedence
        console.error("Mutation failed:", error.message);
      },
    },
  },
});
