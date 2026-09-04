import { queryClient, apiRequest } from "@/lib/queryClient";
import { getProfileFilter } from "@/lib/profileFilter";
import { prefetchScopeBootstrap } from "@/lib/scope-prefetch";
import {
  canonicalTimelineWindow,
  timelineQueryKey,
  timelineUrl,
} from "@shared/calendar-window";

/**
 * Route chunks used by persistent navigation.
 *
 * Keep this map small and user-intent driven. Loading a chunk on hover/focus
 * moves parsing ahead of the click without recreating the old startup storm
 * where every large page was imported in the same idle callback.
 */
const NAVIGATION_CHUNKS: Record<string, () => Promise<unknown>> = {
  "/chat": () => import("@/pages/chat"),
  "/dashboard": () => import("@/pages/dashboard"),
  "/calendar": () => import("@/pages/calendar-page"),
  "/artifacts": () => import("@/pages/artifacts"),
  "/settings": () => import("@/pages/settings"),
};

function canonicalNavigationPath(href: string): string {
  const path = href.split("?")[0].replace(/\/$/, "") || "/";
  return path === "/" ? "/chat" : path;
}

/** Warm only JavaScript for a likely destination. Never blocks navigation. */
export function preloadNavigationChunk(href: string): void {
  const load = NAVIGATION_CHUNKS[canonicalNavigationPath(href)];
  if (!load) return;
  void load().catch(() => {
    // Best effort. React.lazy retries through its own import on navigation.
  });
}

/**
 * Warm the primary data needed for the destination's first paint.
 *
 * Called on pointer-down/touch-start so request latency overlaps the physical
 * tap-to-click interval and route transition. React Query dedupes an in-flight
 * request and skips fresh cache entries, so repeated taps add no extra work.
 */
export function prefetchNavigationData(href: string): void {
  try {
    const path = canonicalNavigationPath(href);
    const { mode, selectedIds } = getProfileFilter();
    const ids = mode === "selected" ? (selectedIds || []).filter(Boolean) : [];

    switch (path) {
      case "/dashboard":
        prefetchScopeBootstrap(ids.length > 0 ? "selected" : "everyone", ids);
        break;
      case "/calendar": {
        const win = canonicalTimelineWindow(new Date().toLocaleDateString("en-CA"));
        const timelineMode = ids.length > 0 ? "selected" : "everyone";
        void queryClient.prefetchQuery({
          queryKey: timelineQueryKey(win, timelineMode, ids),
          queryFn: () =>
            apiRequest("GET", timelineUrl(win, timelineMode, ids)).then((r) =>
              r.json(),
            ),
        });
        break;
      }
      case "/artifacts":
        void queryClient.prefetchQuery({ queryKey: ["/api/artifacts"] });
        break;
      case "/chat":
        void queryClient.prefetchQuery({ queryKey: ["/api/profiles"] });
        break;
    }
  } catch {
    // Prefetch is an optimization and must never interfere with a click.
  }
}

/** Warm both code and first-paint data for touch/pointer intent. */
export function prefetchNavigationTarget(href: string): void {
  preloadNavigationChunk(href);
  prefetchNavigationData(href);
}
