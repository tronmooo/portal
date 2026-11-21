import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { queryClient } from "@/lib/queryClient";
import { invalidateDomains, type Domain } from "@/lib/cache-bus";

// ── Pull-to-refresh scoping (PERF 2026-07-21) ───────────────────────────────
// Maps the current wouter (hash) location to the cache-bus domain(s) whose
// data that route displays. A pull only refreshes those domains instead of
// every cached query in the app — the old unfiltered invalidateQueries()
// refetched EVERYTHING (network storm on iOS). Routes with no mapping fall
// back to the bus's "everything" domain, which is still bounded to /api/*
// keys and refetchType:"active" (only queries with on-screen observers).
export function pullRefreshDomains(location: string): Domain[] | null {
  const path = location.split("?")[0].replace(/\/$/, "") || "/";
  const table: Record<string, Domain[]> = {
    "/dashboard": ["dashboard", "tasks", "habits", "events", "obligations"],
    "/finance": ["expenses", "incomes", "obligations", "budgets", "dashboard"],
    "/dashboard/finance": ["expenses", "incomes", "obligations", "budgets", "dashboard"],
    "/tasks": ["tasks"],
    "/dashboard/tasks": ["tasks"],
    "/habits": ["habits"],
    "/dashboard/habits": ["habits"],
    "/journal": ["journal"],
    "/dashboard/journal": ["journal"],
    "/goals": ["goals"],
    "/dashboard/goals": ["goals"],
    "/obligations": ["obligations"],
    "/bills": ["obligations"],
    "/dashboard/obligations": ["obligations"],
    "/wellness": ["trackers", "habits", "dashboard"],
    "/health": ["trackers", "habits", "dashboard"],
    "/dashboard/health": ["trackers", "habits", "dashboard"],
    "/trackers": ["trackers"],
    "/linked": ["assets", "liabilities", "trackers"],
    "/liabilities": ["liabilities", "trackers"],
    "/calendar": ["events", "tasks", "obligations"],
    "/profiles": ["profiles"],
    "/insights": ["dashboard"],
    "/artifacts": ["documents", "profiles"],
    "/dashboard/documents": ["documents", "profiles"],
    "/dashboard/artifacts": ["documents", "profiles"],
    "/notifications": ["notifications"],
  };
  if (table[path]) return table[path];
  if (path.startsWith("/profiles/") || path.startsWith("/profile/")) return ["profiles"];
  if (path.startsWith("/documents/")) return ["documents"];
  // "/" (redirects), /chat, settings, editor, share, unknown → no mapping
  return null;
}

// /api/artifacts has no cache-bus domain (the bus predates artifacts), so the
// artifacts routes bust that key directly alongside their domain refresh.
function isArtifactsRoute(location: string): boolean {
  const path = location.split("?")[0].replace(/\/$/, "") || "/";
  return path === "/artifacts" || path === "/dashboard/artifacts" || path === "/dashboard/documents";
}

/**
 * True when nothing between the touched element and `boundary` (inclusive),
 * nor the window, is scrolled down.
 *
 * iPhone (2026-11-21): "Pull to refresh" appeared on every upward swipe, deep
 * in the page, and a long swipe refetched the page instead of scrolling. The
 * old check read `#main-content.scrollTop`, but `<main>` is `overflow-hidden`
 * — the page scrolls in an inner `overflow-y-auto` div — so `main.scrollTop`
 * was always 0 and every touch armed the pull. The real question is whether
 * the scroller under the finger is at its top, so ask every ancestor.
 */
export function isScrolledToTop(target: EventTarget | null, boundary: HTMLElement): boolean {
  if (typeof window !== "undefined" && window.scrollY > 0) return false;
  let el: Element | null = target instanceof Element ? target : null;
  while (el) {
    if (el.scrollTop > 0) return false;
    if (el === boundary) break;
    el = el.parentElement;
  }
  return true;
}

export function PullToRefresh() {
  const pullRef = useRef<HTMLDivElement>(null);
  const startY = useRef<number | null>(null);
  const startTarget = useRef<EventTarget | null>(null);
  const [pulling, setPulling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const threshold = 80;
  // Latest route, readable from the once-bound touch handlers below without
  // re-attaching listeners on every navigation.
  const [location] = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;

  useEffect(() => {
    const main = document.getElementById("main-content");
    if (!main) return;

    const reset = () => {
      startY.current = null;
      startTarget.current = null;
      if (pullRef.current) {
        pullRef.current.style.transform = "";
        pullRef.current.style.opacity = "0";
      }
      setPulling(false);
    };

    const onTouchStart = (e: TouchEvent) => {
      // A gesture inside a dialog/sheet scrolls that, never the page.
      const t = e.target as Element | null;
      if (t instanceof Element && t.closest('[role="dialog"], [data-radix-dialog-content]')) {
        startY.current = null;
        return;
      }
      if (isScrolledToTop(e.target, main)) {
        startY.current = e.touches[0].clientY;
        startTarget.current = e.target;
      } else {
        startY.current = null;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (startY.current === null) return;
      // The finger went up (content scrolls down) or the scroller moved off
      // its top: this is a scroll, not a pull.
      const dy = e.touches[0].clientY - startY.current;
      if (dy < 0 || !isScrolledToTop(startTarget.current, main)) {
        reset();
        return;
      }
      if (dy > 0 && dy < threshold * 1.5) {
        setPulling(true);
        if (pullRef.current) {
          pullRef.current.style.transform = `translateY(${Math.min(dy * 0.5, 40)}px)`;
          pullRef.current.style.opacity = String(Math.min(dy / threshold, 1));
        }
      }
    };

    const onTouchEnd = async (e: TouchEvent) => {
      if (startY.current === null) return;
      const dy = e.changedTouches[0].clientY - startY.current;
      const stillAtTop = isScrolledToTop(startTarget.current, main);
      reset();
      if (dy >= threshold && stillAtTop) {
        setRefreshing(true);
        // Scope the refresh to the current route's data domains (see
        // pullRefreshDomains above).
        const loc = locationRef.current;
        const domains = pullRefreshDomains(loc);
        const work: Promise<unknown>[] = [
          invalidateDomains(...(domains ?? (["everything"] as Domain[]))),
        ];
        if (isArtifactsRoute(loc)) {
          work.push(queryClient.invalidateQueries({ queryKey: ["/api/artifacts"], refetchType: "active" }));
        }
        await Promise.allSettled(work);
        setTimeout(() => setRefreshing(false), 1200);
      }
    };

    main.addEventListener("touchstart", onTouchStart, { passive: true });
    main.addEventListener("touchmove", onTouchMove, { passive: true });
    main.addEventListener("touchend", onTouchEnd, { passive: true });
    main.addEventListener("touchcancel", reset, { passive: true });
    return () => {
      main.removeEventListener("touchstart", onTouchStart);
      main.removeEventListener("touchmove", onTouchMove);
      main.removeEventListener("touchend", onTouchEnd);
      main.removeEventListener("touchcancel", reset);
    };
  }, []);

  if (!pulling && !refreshing) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[100] flex justify-center pointer-events-none" style={{ paddingTop: "4px" }} data-testid="pull-to-refresh">
      <div
        ref={pullRef}
        className="flex items-center gap-2 px-4 py-2 rounded-full bg-card border border-border shadow-lg text-xs font-medium text-muted-foreground"
        style={{ opacity: 0, transition: "none" }}
      >
        {refreshing ? (
          <><span className="w-3.5 h-3.5 border-2 border-primary border-t-transparent rounded-full animate-spin" /> Refreshing...</>
        ) : (
          <><span className="text-base">↓</span> Pull to refresh</>
        )}
      </div>
    </div>
  );
}
