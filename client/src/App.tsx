import { Switch, Route, Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { parse as parseRoutePattern } from "regexparam";
import { seedDashboardCaches } from "@/lib/bootstrap-seed";
import { queryClient, apiRequest } from "./lib/queryClient";
import { getUserCurrentMonth } from "@shared/timezone";
import { getProfileFilter } from "@/lib/profileFilter";
import { warmup } from "@/lib/warmup";
import { hashNavigate } from "./lib/hashNavigate";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { MobileBottomNav } from "@/components/mobile-nav";
import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { initErrorReporter } from "@/lib/errorReporter";

// Initialize error reporter immediately
initErrorReporter();
import { AuthProvider, useAuth, installAuthInterceptor } from "@/lib/auth";
import { invalidateDomains, type Domain } from "@/lib/cache-bus";
import { perfMark, perfMeasure } from "@/lib/perf-marks";
import { Button } from "@/components/ui/button";
import { Sun, Moon, Settings, Calendar, Lock, LogOut } from "lucide-react";
import { Loader2 } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CommandSearch,
  CommandSearchProvider,
  CommandSearchTrigger,
} from "@/components/CommandSearch";
import { NotificationBell } from "@/components/NotificationBell";
import { HubShell } from "@/components/hub/HubShell";
import { HubChromeContext } from "@/components/hub/hub-context";
import { isHubRoute, isHubLocationForNav } from "@/components/hub/hub-routes";

import { OfflineIndicator } from "@/components/OfflineIndicator";
import { InstallPrompt } from "@/components/InstallPrompt";
import { KeyboardShortcuts } from "@/components/KeyboardShortcuts";
import { lazy, Suspense, useEffect, useRef, useCallback, useState } from "react";
import { SectionErrorBoundary } from "@/components/ErrorBoundary";

// Keep lightweight pages as direct imports
import NotFound from "@/pages/not-found";
import { getActiveTimezone } from "@/lib/timezone";

// Lazy load heavy pages
// PERF Phase 1.5 (2026-07-16): ChatPage was a static import — 3.7k lines of
// page code riding in the entry bundle for every user on every route. It now
// lazy-loads like every other page and is FIRST in the idle-time preload list
// (it's the "/" route), so signed-in users still get an instant chat tab.
const _chatImport = () => import("@/pages/chat");
const _dashImport = () => import("@/pages/dashboard");
const _trackImport = () => import("@/pages/trackers");
const _profDispatchImport = () => import("@/pages/profile-route-dispatch");
const _profInfoImport = () => import("@/pages/profile-info");
const _profListImport = () => import("@/pages/profiles-list");
const _docDImport  = () => import("@/pages/document-detail");
const _docRImport  = () => import("@/pages/document-review");
const _authImport  = () => import("@/pages/auth");
const _resetImport = () => import("@/pages/reset-password");
const _settImport  = () => import("@/pages/settings");
const _calImport   = () => import("@/pages/calendar-page");
const _artImport   = () => import("@/pages/artifacts");
const _finImport   = () => import("@/pages/finance");
const _wellImport  = () => import("@/pages/wellness");
const _habImport   = () => import("@/pages/habits");
const _jourImport  = () => import("@/pages/journal");
const _oblImport   = () => import("@/pages/obligations");
const _taskImport  = () => import("@/pages/tasks");
const _goalsImport = () => import("@/pages/goals");
const _privImport  = () => import("@/pages/privacy");
const _termsImport = () => import("@/pages/terms");
const _editImport  = () => import("@/pages/editor");
const _insightsImport = () => import("@/pages/insights");
const _shareViewImport = () => import("@/pages/share-view");

const ChatPage         = lazy(_chatImport);
const DashboardPage    = lazy(_dashImport);
const TrackersPage     = lazy(_trackImport);
const ProfileRouteDispatch = lazy(_profDispatchImport);
const ProfileInfoPage  = lazy(_profInfoImport);
const ProfilesListPage = lazy(_profListImport);
const DocumentDetailPage = lazy(_docDImport);
const DocumentReviewPage = lazy(_docRImport);
const AuthPage         = lazy(_authImport);
const ResetPasswordPage = lazy(_resetImport);
const SettingsPage     = lazy(_settImport);
const CalendarPage     = lazy(_calImport);
const ArtifactsPage    = lazy(_artImport);
const FinancePage      = lazy(_finImport);
const WellnessPage     = lazy(_wellImport);
const HabitsPage       = lazy(_habImport);
const JournalPage      = lazy(_jourImport);
const ObligationsPage  = lazy(_oblImport);
const TasksPage        = lazy(_taskImport);
const GoalsPage        = lazy(_goalsImport);
const PrivacyPage      = lazy(_privImport);
const TermsPage        = lazy(_termsImport);
const EditorPage       = lazy(_editImport);
const InsightsPage     = lazy(_insightsImport);
const ShareViewPage    = lazy(_shareViewImport);

// PERF-2 (2026-06-10): main-tab chunk preloads used to fire at module load,
// before auth — logged-out users downloaded megabytes of route chunks they
// never used. They now run from <RoutePreloader /> below, only once the user
// is authenticated, and during browser idle time.
const MAIN_TAB_IMPORTS = [
  _chatImport,
  _dashImport,
  _trackImport,
  _profInfoImport,
  _settImport,
  _calImport,
  _artImport,
  _finImport,
  _habImport,
  _jourImport,
  _oblImport,
  _taskImport,
];

// Install auth interceptor to add JWT to all API requests
installAuthInterceptor();

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-full">
      <Loader2 className="w-6 h-6 animate-spin text-primary" />
    </div>
  );
}

function ThemeToggle() {
  const { resolvedMode, toggle } = useTheme();
  return (
    <Button variant="ghost" size="icon" onClick={toggle} className="h-8 w-8" aria-label={resolvedMode === "dark" ? "Switch to light mode" : "Switch to dark mode"} title={resolvedMode === "dark" ? "Switch to light mode" : "Switch to dark mode"} data-testid="button-theme-toggle">
      {resolvedMode === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}

function CalendarButton() {
  const [, navigate] = useLocation();
  return (
    <Button variant="ghost" size="icon" onClick={() => navigate("/calendar")} className="h-9 w-9" title="Calendar" aria-label="Open calendar" data-testid="button-calendar-header">
      <Calendar className="h-4 w-4" />
    </Button>
  );
}

function SettingsButton() {
  const [, navigate] = useLocation();
  return (
    <Button variant="ghost" size="icon" onClick={() => navigate("/settings")} className="h-9 w-9" title="Settings" aria-label="Open settings" data-testid="button-settings-header">
      <Settings className="h-4 w-4" />
    </Button>
  );
}

function ProfileButton() {
  const { user, signOut } = useAuth();
  const [, navigate] = useLocation();
  const initial = user?.email?.charAt(0).toUpperCase() || "?";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full p-0.5" title="Account" data-testid="button-profile-avatar" style={{ background: 'linear-gradient(135deg, hsl(188 55% 50%), hsl(262 65% 62%))' }}>
          <div className="h-full w-full rounded-full bg-background flex items-center justify-center text-xs font-bold text-primary">
            {initial}
          </div>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <div className="px-2 py-1.5 text-xs text-muted-foreground truncate">{user?.email}</div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/settings")} data-testid="menu-settings">
          <Settings className="h-3.5 w-3.5 mr-2" /> Settings
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("/settings?changePassword=1")} data-testid="menu-change-password">
          <Lock className="h-3.5 w-3.5 mr-2" /> Change Password
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={signOut} className="text-red-500" data-testid="menu-signout">
          <LogOut className="h-3.5 w-3.5 mr-2" /> Sign Out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Progressively preload main pages after first paint. Importing every chunk in
// one idle callback used to create a burst of downloads + parse work that could
// make buttons and filters feel stuck on slower phones. One chunk is now loaded
// per idle slice; persistent navigation also preloads the exact destination on
// hover/focus/pointer-down (lib/navigation-prefetch.ts).
function RoutePreloader() {
  const { user } = useAuth();
  const fired = useRef(false);
  useEffect(() => {
    if (!user || fired.current) return;
    fired.current = true;
    let cancelled = false;
    let index = 0;
    let idleHandle: number | null = null;
    let timerHandle: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (cancelled || index >= MAIN_TAB_IMPORTS.length) return;
      if (typeof window.requestIdleCallback === "function") {
        idleHandle = window.requestIdleCallback(runOne, { timeout: 5000 });
      } else {
        timerHandle = setTimeout(runOne, index === 0 ? 1500 : 250);
      }
    };
    const runOne = () => {
      if (cancelled || index >= MAIN_TAB_IMPORTS.length) return;
      const load = MAIN_TAB_IMPORTS[index++];
      // Wait for this chunk to finish before scheduling another idle slice.
      // This bounds concurrent downloads and main-thread module evaluation.
      void load()
        .catch(() => {/* best-effort; route lazy() retries on demand */})
        .finally(schedule);
    };

    schedule();
    return () => {
      cancelled = true;
      if (idleHandle !== null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleHandle);
      }
      if (timerHandle !== null) clearTimeout(timerHandle);
    };
  }, [user]);
  return null;
}

// A-3 deep-link: key where the intended route is stashed while an
// unauthenticated user is parked on AuthPage, restored right after login.
const AUTH_RETURN_TO_KEY = "portol_auth_return_to";

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading, authRequired } = useAuth();
  const [, navigate] = useLocation();
  const restoredReturnTo = useRef(false);

  // Stash the intended route (hash-router path incl. query) while AuthPage is
  // shown, so login lands the user where they meant to go.
  useEffect(() => {
    if (loading || !authRequired || user) return;
    // useHashLocation: the route lives in the hash — "#/dashboard?x=1".
    const target = window.location.hash.replace(/^#/, "");
    if (!target || target === "/") return;
    // Never stash auth/public pages.
    if (/^\/(auth|reset-password|privacy|terms|share)(\/|\?|$)/.test(target)) return;
    try {
      sessionStorage.setItem(AUTH_RETURN_TO_KEY, target);
    } catch { /* storage unavailable — skip */ }
  }, [user, loading, authRequired]);

  // Once authenticated, navigate to the stashed route exactly once.
  useEffect(() => {
    if (!user || restoredReturnTo.current) return;
    restoredReturnTo.current = true;
    let target: string | null = null;
    try {
      target = sessionStorage.getItem(AUTH_RETURN_TO_KEY);
      sessionStorage.removeItem(AUTH_RETURN_TO_KEY);
    } catch { /* storage unavailable — skip */ }
    if (target && target !== "/" && !target.startsWith("/auth")) {
      navigate(target, { replace: true });
    }
  }, [user, navigate]);

  // Allow public pages through without auth
  if (window.location.hash.startsWith("#/reset-password")) {
    return <Suspense fallback={<PageLoader />}><ResetPasswordPage /></Suspense>;
  }
  if (window.location.hash.startsWith("#/privacy")) {
    return <Suspense fallback={<PageLoader />}><PrivacyPage /></Suspense>;
  }
  if (window.location.hash.startsWith("#/terms")) {
    return <Suspense fallback={<PageLoader />}><TermsPage /></Suspense>;
  }
  // Public share viewer — read-only, no sidebar/header chrome, no auth required.
  if (window.location.hash.startsWith("#/share/")) {
    return <Suspense fallback={<PageLoader />}><ShareViewPage /></Suspense>;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-dvh bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading Portol...</p>
        </div>
      </div>
    );
  }

  // If auth not required (SQLite mode), show app directly
  if (!authRequired) return <>{children}</>;

  // Auth required but not signed in — show login
  if (!user) return <Suspense fallback={<PageLoader />}><AuthPage /></Suspense>;

  // Authenticated — show app
  return <>{children}</>;
}

// ── Pull-to-refresh scoping (PERF 2026-07-21) ───────────────────────────────
// Maps the current wouter (hash) location to the cache-bus domain(s) whose
// data that route displays. A pull only refreshes those domains instead of
// every cached query in the app — the old unfiltered invalidateQueries()
// refetched EVERYTHING (network storm on iOS). Routes with no mapping fall
// back to the bus's "everything" domain, which is still bounded to /api/*
// keys and refetchType:"active" (only queries with on-screen observers).
function pullRefreshDomains(location: string): Domain[] | null {
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

function PullToRefresh() {
  const pullRef = useRef<HTMLDivElement>(null);
  const startY = useRef<number | null>(null);
  const [pulling, setPulling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const threshold = 80;
  // Latest route, readable from the once-bound touch handlers below without
  // re-attaching listeners on every navigation.
  const [location] = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;

  useEffect(() => {
    const main = document.getElementById('main-content');
    if (!main) return;

    const onTouchStart = (e: TouchEvent) => {
      if (main.scrollTop === 0) startY.current = e.touches[0].clientY;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (startY.current === null) return;
      const dy = e.touches[0].clientY - startY.current;
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
      startY.current = null;
      if (pullRef.current) {
        pullRef.current.style.transform = '';
        pullRef.current.style.opacity = '0';
      }
      setPulling(false);
      if (dy >= threshold) {
        setRefreshing(true);
        // Scope the refresh to the current route's data domains (see
        // pullRefreshDomains above). Unmapped routes fall back to the bus's
        // "everything" domain — /api/*-bounded, active observers only —
        // instead of the old unfiltered invalidateQueries() that refetched
        // every cached query app-wide.
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

    main.addEventListener('touchstart', onTouchStart, { passive: true });
    main.addEventListener('touchmove', onTouchMove, { passive: true });
    main.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      main.removeEventListener('touchstart', onTouchStart);
      main.removeEventListener('touchmove', onTouchMove);
      main.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  if (!pulling && !refreshing) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[100] flex justify-center pointer-events-none" style={{ paddingTop: '4px' }}>
      <div
        ref={pullRef}
        className="flex items-center gap-2 px-4 py-2 rounded-full bg-card border border-border shadow-lg text-xs font-medium text-muted-foreground"
        style={{ opacity: 0, transition: 'none' }}
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

function SwipeNav() {
  const [location, navigate] = useLocation();
  const startX = useRef<number | null>(null);
  const startY = useRef<number | null>(null);
  const startTime = useRef<number>(0);
  const didMove = useRef(false);

  // Hub consolidation (2026-07): 4 tabs — any hub route (dashboard, linked,
  // trackers, profiles, finance, ...) counts as the /dashboard swipe slot.
  const TAB_ORDER = ['/', '/dashboard', '/calendar', '/artifacts'];

  const handleTouchStart = useCallback((e: TouchEvent) => {
    // Don't intercept if touch started on an interactive element
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, textarea, select, [role="button"], [data-radix-dialog-content]')) return;
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    startTime.current = Date.now();
    didMove.current = false;
  }, []);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (startX.current === null) return;
    const dx = e.touches[0].clientX - startX.current;
    const dy = e.touches[0].clientY - startY.current!;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) didMove.current = true;
  }, []);

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    if (startX.current === null || !didMove.current) { startX.current = null; return; }
    const dx = e.changedTouches[0].clientX - startX.current;
    const dy = e.changedTouches[0].clientY - startY.current!;
    const elapsed = Date.now() - startTime.current;
    startX.current = null;
    startY.current = null;
    // Require: horizontal > 80px, clearly horizontal (3:1 ratio), completed in < 600ms
    if (Math.abs(dx) < 80 || Math.abs(dx) < Math.abs(dy) * 3 || elapsed > 600) return;
    const currentTab = isHubLocationForNav(location)
      ? '/dashboard'
      : TAB_ORDER.find(t => t === location || (t !== '/' && location.startsWith(t))) || '/';
    const idx = TAB_ORDER.indexOf(currentTab);
    if (dx < 0 && idx < TAB_ORDER.length - 1) navigate(TAB_ORDER[idx + 1]);
    if (dx > 0 && idx > 0) navigate(TAB_ORDER[idx - 1]);
  }, [location, navigate]);

  useEffect(() => {
    const main = document.getElementById('main-content');
    if (!main) return;
    main.addEventListener('touchstart', handleTouchStart, { passive: true });
    main.addEventListener('touchmove', handleTouchMove, { passive: true });
    main.addEventListener('touchend', handleTouchEnd, { passive: true });
    return () => {
      main.removeEventListener('touchstart', handleTouchStart);
      main.removeEventListener('touchmove', handleTouchMove);
      main.removeEventListener('touchend', handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

  return null;
}

function ScrollToTop() {
  const [location] = useLocation();
  useEffect(() => {
    // Use requestAnimationFrame to avoid blocking the navigation render
    requestAnimationFrame(() => { window.scrollTo({ top: 0, behavior: "instant" }); });
  }, [location]);
  return null;
}

// Sets the browser tab title immediately on every route change, BEFORE the
// lazy-loaded page mounts and runs its own useEffect. This kills the QA bug
// where landing on /dashboard/habits briefly (or persistently) shows the
// previous page's title — e.g. "Page not found — Portol" — because the Suspense
// fallback paints first and the previous title hangs on. (QA BUG-001.)
function RouteTitle() {
  const [location] = useLocation();
  useEffect(() => {
    const path = location.split("?")[0].replace(/\/$/, "") || "/";
    const map: Record<string, string> = {
      "/chat": "Chat — Portol",
      "/dashboard": "Dashboard — Portol",
      "/dashboard/finance": "Finance — Portol",
      "/dashboard/habits": "Habits — Portol",
      "/dashboard/journal": "Journal — Portol",
      "/dashboard/obligations": "Bills — Portol",
      "/dashboard/tasks": "Tasks — Portol",
      "/dashboard/documents": "Documents — Portol",
      "/dashboard/artifacts": "Artifacts — Portol",
      "/dashboard/health": "Wellness — Portol",
      "/health": "Wellness — Portol",
      "/wellness": "Wellness — Portol",
      "/trackers": "Trackers — Portol",
      "/linked": "Linked — Portol",
      "/liabilities": "Liabilities — Portol",
      "/profiles": "Profiles — Portol",
      "/profiles/list": "Profiles — Portol",
      "/calendar": "Calendar — Portol",
      "/settings": "Settings — Portol",
      "/artifacts": "Artifacts — Portol",
      "/insights": "Insights — Portol",
      "/tasks": "Tasks — Portol",
      "/finance": "Finance — Portol",
      "/obligations": "Bills — Portol",
      "/bills": "Bills — Portol",
      "/journal": "Journal — Portol",
      "/habits": "Habits — Portol",
      "/privacy": "Privacy — Portol",
      "/terms": "Terms — Portol",
    };
    let title = map[path];
    if (!title) {
      if (path.startsWith("/profiles/") || path.startsWith("/profile/")) title = "Profile — Portol";
      else if (path.startsWith("/documents/")) title = "Document — Portol";
      else if (path.startsWith("/editor/")) title = "Editor — Portol";
      else if (path.startsWith("/share/")) title = "Shared — Portol";
    }
    // Fall back to the product name rather than leaving the PREVIOUS page's
    // title in the tab (QA 2026-07-29 UX-018). An unmapped route used to keep
    // whatever was there before, so the tab claimed to be a page the user had
    // already navigated away from — and browser history recorded it that way.
    document.title = title || "Portol";
  }, [location]);
  return null;
}

// Keep the Vercel serverless function warm so there's never a cold-start delay.
// Ping every 90 seconds — Vercel keeps functions alive for ~5 min after last request.
function KeepAlive() {
  const { user } = useAuth();
  const { getAuthHeader } = useAuth();
  useEffect(() => {
    if (!user) return;
    const ping = () => {
      warmup(getAuthHeader());
    };
    ping(); // Immediate ping to pre-warm cache on mount (deduped — the boot-time
            // authed warmup from auth.tsx already covers the first ~15s, so this
            // mount ping collapses into it instead of stacking a 4th request).
    const id = setInterval(ping, 90_000); // Then every 90 seconds

    // ── Visibility recovery: when the user returns after ≥15s absence, re-warm
    // the (possibly cold-started) serverless function. Data refresh is NOT forced
    // here — React Query's refetchOnWindowFocus + staleTime already refetch stale
    // on-screen queries once on return, and queryClient's recoverWedgedQueries
    // handles genuinely stuck in-flight requests. The old forced invalidate of
    // stats/dashboard-enhanced stacked a second refetch wave on top of both,
    // which is the redundant load this collapses to a single strategy.
    let hiddenAt = 0;
    const onVisChange = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
      } else {
        const awayMs = Date.now() - hiddenAt;
        if (hiddenAt > 0 && awayMs >= 15_000) {
          ping(); // Re-warm Vercel cold-started function immediately
        }
        hiddenAt = 0;
      }
    };
    document.addEventListener('visibilitychange', onVisChange);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisChange);
    };
  }, [user]);
  return null;
}

// Prefetch shared data immediately after login.
//
// PERF (2026-05-31): rewritten. Was firing 9 unfiltered, parallel useQuery
// prefetches on every login (/api/trackers, /api/profiles, /api/events,
// /api/stats, /api/dashboard-enhanced, /api/habits, /api/goals,
// /api/expenses, /api/obligations). Each unfiltered call took ~6 s cold on
// the worst path and they all ran in parallel, saturating the serverless
// instance and producing a ~7 s skeleton on cold app open.
//
// New strategy: a single /api/dashboard-bootstrap call scoped to the user's
// saved profile filter. The bootstrap endpoint already aggregates
// stats + enhanced + profiles + incomes + budget summary in ~300 ms warm
// and ~600 ms cold (verified at portol.me, see perf wave 2026-05-31). The
// individual pages still own their own list fetches when mounted; we just
// stop the upfront 9-call broadside.
function DataPrefetch() {
  const { user } = useAuth();
  const prefetched = useRef(false);
  useEffect(() => {
    if (!user || prefetched.current) return;
    prefetched.current = true;
    const { mode, selectedIds: ids } = getProfileFilter();
    // The user's month (not UTC's): the budget hooks key on the browser-zone
    // month, so a UTC key seeded the wrong slot on the last evening of a month.
    const month = getUserCurrentMonth(getActiveTimezone());
    const qs = (mode === 'selected' && ids.length > 0)
      ? `?profileIds=${ids.join(',')}&month=${month}`
      : `?month=${month}`;
    // Use prefetchQuery so the response also lands in the cache under the
    // bootstrap key the dashboard hook reads, AND so the side-effect inside
    // bootstrap's queryFn (setQueryData for stats/enhanced/profiles/incomes/
    // budgetSummary) runs once instead of being duplicated by the dashboard.
    perfMark('bootstrap-prefetch-start');
    queryClient.prefetchQuery({
      queryKey: ['/api/dashboard-bootstrap', mode, ...ids, month],
      queryFn: async () => {
        const r = await apiRequest('GET', `/api/dashboard-bootstrap${qs}`);
        const b = await r.json();
        // One round trip seeds EVERY dashboard mount-time query key
        // (see lib/bootstrap-seed.ts) — the page paints without firing
        // its ~12 individual GETs.
        seedDashboardCaches(b, mode, ids, month);
        perfMeasure('boot:bootstrap-landed', 'bootstrap-prefetch-start');
        return b ?? null;
      },
    }).catch(() => { /* best-effort */ });

    // Do not automatically fetch the full "Everyone" scope when the user
    // saved a narrower scope. That bootstrap is the broadest server fan-out
    // and used to duplicate nearly all startup data during the first idle
    // window. Scope-prefetch warms it on actual filter intent instead.
  }, [user]);
  return null;
}

// Global safety net for a well-known Radix UI bug: when a Dialog/Popover/Menu
// is open it sets `pointer-events: none` on <body> to enforce modality. If that
// overlay unmounts WITHOUT running its close cleanup — most commonly because the
// app navigates to a new route while the dialog is still open (every Net Worth /
// Cash Flow popup row does `navigate(...)` mid-open) — the stuck style is never
// removed and the ENTIRE app becomes unclickable until a manual reload. This is
// exactly the "I pressed something and now none of the buttons work" symptom.
//
// This guard clears the stuck style after navigations and whenever <body>'s
// style changes, but ONLY when no Radix overlay is actually open, so it never
// breaks a legitimately-open modal.
function isAnyOverlayOpen(): boolean {
  return !!document.querySelector(
    '[data-radix-popper-content-wrapper],' +
    '[role="dialog"][data-state="open"],' +
    '[role="alertdialog"][data-state="open"],' +
    '[role="menu"][data-state="open"],' +
    '[data-state="open"][data-radix-menu-content],' +
    '[data-radix-dialog-overlay],' +
    '[data-radix-alert-dialog-overlay],' +
    '[vaul-overlay],[vaul-drawer][data-state="open"]'
  );
}
function clearStuckBodyPointerEvents() {
  try {
    const body = document.body;
    if (!body || body.style.pointerEvents !== "none") return;
    if (!isAnyOverlayOpen()) body.style.pointerEvents = "";
  } catch { /* ignore */ }
}
function PointerEventsGuard() {
  const [location] = useLocation();
  // After every route change, give the DOM a tick to unmount any open overlay,
  // then clear the stuck style if nothing modal remains.
  useEffect(() => {
    const raf = requestAnimationFrame(clearStuckBodyPointerEvents);
    const t = setTimeout(clearStuckBodyPointerEvents, 200);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, [location]);
  // Belt-and-suspenders: watch <body> directly for the stuck style, since some
  // dismissals (external nav, unmount races) don't change the wouter location.
  useEffect(() => {
    if (typeof MutationObserver === "undefined" || !document.body) return;
    let scheduled = false;
    const obs = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      // Delay so we don't race Radix's own open-time setup (it sets the style
      // and mounts the overlay in the same frame).
      setTimeout(() => { scheduled = false; clearStuckBodyPointerEvents(); }, 150);
    });
    obs.observe(document.body, { attributes: true, attributeFilter: ["style"] });
    return () => obs.disconnect();
  }, []);
  return null;
}

// Hub consolidation (2026-07): the unified hub chrome (KPI strip + profile
// switcher + tab chips) mounts ONCE here — outside AppRouter's <Suspense> —
// so it persists across tab switches while lazy page chunks stream in. Pages
// under a hub route read HubChromeContext to hide their duplicate headers.
function HubArea() {
  const [location] = useLocation();
  const isHub = isHubRoute(location);
  return (
    <>
      {isHub && <HubShell />}
      <div className="flex-1 min-h-0">
        <HubChromeContext.Provider value={isHub}>
          <AppRouter />
        </HubChromeContext.Provider>
      </div>
    </>
  );
}

// wouter has no <Redirect> in this setup — a mount-time replace keeps the bare
// root out of history so Back from the dashboard leaves the app instead of
// bouncing through "/".
function RootRedirect() {
  const [, navigate] = useLocation();
  useEffect(() => { navigate("/dashboard", { replace: true }); }, []);
  return <PageLoader />;
}

function AppRouter() {
  return (
    <SectionErrorBoundary name="app">
    <Suspense fallback={<PageLoader />}>
      <Switch>
        {/* Chat lives at /chat so it is bookmarkable and deep-linkable; the
            bare root redirects to the dashboard, which is the home surface. */}
        <Route path="/chat" component={ChatPage} />
        <Route path="/" component={RootRedirect} />
        <Route path="/dashboard" component={DashboardPage} />
        <Route path="/trackers" component={TrackersPage} />
        <Route path="/linked" component={TrackersPage} />
        <Route path="/liabilities" component={TrackersPage} />
        {/* Info tab. No id → the combined "everyone" Info view (replaces the
            retired profiles grid). */}
        <Route path="/profiles" component={ProfileInfoPage} />
        {/* Profiles index. MUST precede /profiles/:id — "list" is a literal
            segment, not an id. */}
        <Route path="/profiles/list" component={ProfilesListPage} />
        {/* Single-profile Info — MUST precede /profiles/:id so the more
            specific pattern wins under the query-tolerant matcher. */}
        <Route path="/profiles/:id/info" component={ProfileInfoPage} />
        {/* Tab deep-links: /profiles/:id/overview|finance|trackers|documents|
            productivity|history. The dispatcher hands them to the detail page
            with that tab preselected. */}
        <Route path="/profiles/:id/:tab" component={ProfileRouteDispatch} />
        {/* Dispatcher: people redirect to their dashboard + Info; every other
            profile type still renders the per-type detail page. */}
        <Route path="/profiles/:id" component={ProfileRouteDispatch} />
        {/* Review must precede /documents/:id — this matcher takes the first
            pattern that fits, and the less specific one fits both. */}
        <Route path="/documents/:id/review" component={DocumentReviewPage} />
        <Route path="/documents/:id" component={DocumentDetailPage} />
        <Route path="/calendar" component={CalendarPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/reset-password" component={ResetPasswordPage} />
        <Route path="/privacy" component={PrivacyPage} />
        <Route path="/terms" component={TermsPage} />
        <Route path="/artifacts" component={ArtifactsPage} />
        <Route path="/dashboard/documents" component={ArtifactsPage} />
        {/* Legacy alias: QuickCreateFab + trackers page navigate to /dashboard/artifacts. */}
        <Route path="/dashboard/artifacts" component={ArtifactsPage} />
        {/* Legacy singular alias: anywhere /profile/:id was bookmarked, route it
            through the dispatcher (normalizes to /profiles/:id) so we never 404. */}
        <Route path="/profile/:id" component={ProfileRouteDispatch} />
        <Route path="/editor/new/:type" component={EditorPage} />
        <Route path="/editor/:id" component={EditorPage} />
        <Route path="/insights" component={InsightsPage} />
        <Route path="/share/:token" component={ShareViewPage} />
        <Route path="/dashboard/finance" component={FinancePage} />
        <Route path="/dashboard/habits" component={HabitsPage} />
        <Route path="/dashboard/journal" component={JournalPage} />
        <Route path="/dashboard/obligations" component={ObligationsPage} />
        <Route path="/dashboard/tasks" component={TasksPage} />
        {/* Top-level aliases so the AI assistant's confirmation phrases
            ("added to Tasks page", "saved to Finance page") and any external
            deeplinks resolve instead of 404'ing. Each aliases the canonical
            /dashboard/* route above. */}
        <Route path="/tasks" component={TasksPage} />
        <Route path="/goals" component={GoalsPage} />
        <Route path="/dashboard/goals" component={GoalsPage} />
        <Route path="/finance" component={FinancePage} />
        <Route path="/obligations" component={ObligationsPage} />
        <Route path="/journal" component={JournalPage} />
        <Route path="/habits" component={HabitsPage} />
        <Route path="/bills" component={ObligationsPage} />
        {/* Wellness tab (Health→Wellness redesign): a health command center that
            reads the same tracker/habit/stats data as everything else. The deep
            tracker grid still lives under /trackers. /health + /dashboard/health
            stay as aliases so old links land on the new overview. */}
        <Route path="/wellness" component={WellnessPage} />
        <Route path="/dashboard/health" component={WellnessPage} />
        <Route path="/health" component={WellnessPage} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
    </SectionErrorBoundary>
  );
}

const sidebarStyle = {
  "--sidebar-width": "14rem",
  "--sidebar-width-icon": "3rem",
};

// ── Query-tolerant route matching (BUG 2026-07-08: hub tabs 404) ─────────────
// With useHashLocation the query string lives INSIDE the hash, so wouter's
// location is e.g. "/linked?tab=assets". The default regexparam patterns are
// anchored ("^\/linked\/?$") and therefore DON'T match once a query is
// present — every query-carrying link (hub Assets/Documents chips,
// /tasks?new=1, /finance?new=expense, /dashboard/journal?new=1) fell through
// the Switch to the "Page not found" route, and "/profiles/:id?x=1" captured
// the query INTO the id param. This parser keeps regexparam's semantics but
// lets an optional "?..." suffix ride along, and stops param captures at "?".
// Verified: "/linked" matches "/linked?tab=assets"; "/profiles/:id" on
// "/profiles/abc?x=1" captures "abc"; "/linkedextra" still does NOT match.
function queryTolerantParser(route: string, loose?: boolean) {
  const { pattern, keys } = parseRoutePattern(route, loose);
  let src = pattern.source;
  if (src.endsWith("\\/?$")) src = src.slice(0, -4) + "\\/?(?:\\?.*)?$";
  src = src.replace("(?=$|\\/)", "(?=$|\\/|\\?)"); // loose (nested) form
  return { pattern: new RegExp(src, pattern.flags), keys };
}

// Detect new deploys and force reload — prevents stale UI after deployments
// Version check REMOVED — was causing 30-second freeze on iOS.
// BUILD_VERSION changed on every Vercel cold start, triggering window.location.reload()
// in a loop that iOS Safari couldn't handle, freezing all tabs.

function App() {
  return (
    <ThemeProvider>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:top-2 focus:left-2 focus:bg-primary focus:text-primary-foreground focus:px-4 focus:py-2 focus:rounded">
        Skip to content
      </a>
      {/* Screen reader announcements for dynamic content */}
      <div aria-live="polite" aria-atomic="true" className="sr-only" id="sr-announcements" />
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
        <TooltipProvider>
          <ErrorBoundary>
          <Router hook={useHashLocation} parser={queryTolerantParser}>
            <ScrollToTop />
            <PointerEventsGuard />
            <RouteTitle />
            <KeepAlive />
            <DataPrefetch />
            <RoutePreloader />
            <SwipeNav />
            <PullToRefresh />
            <AuthGate>
            <CommandSearchProvider>
              <KeyboardShortcuts />
              <SidebarProvider style={sidebarStyle as React.CSSProperties}>
                {/* h-dvh (dynamic viewport) instead of h-screen so iOS Safari's URL bar
                    doesn't push content off-screen. Falls back to 100vh on browsers
                    that don't support dvh. */}
                <div className="flex h-dvh w-full max-w-[90rem] mx-auto overflow-x-hidden">
                  {/* Sidebar hidden on mobile */}
                  <div className="hidden md:block">
                    <AppSidebar />
                  </div>
                  <div className="flex flex-col flex-1 min-w-0">
                    <header className="flex items-center justify-between px-3 py-2.5 border-b border-border/50 shrink-0" style={{ background: 'linear-gradient(180deg, hsl(var(--background)) 0%, hsl(var(--background) / 0.88) 100%)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
                      <div className="hidden md:block">
                        <SidebarTrigger data-testid="button-sidebar-toggle" />
                      </div>
                      <div className="md:hidden flex items-center gap-2">
                        <img src="/portol-logo-clean.png" alt="" aria-hidden="true" className="w-12 h-12 object-contain" style={{ filter: 'drop-shadow(0 0 6px rgba(0,200,220,0.45))' }} />
                        <span className="text-base font-bold tracking-tight text-foreground">Portol</span>
                      </div>
                      {/* Search trigger — centre-right in header */}
                      <div className="flex items-center gap-1 sm:gap-2 flex-1 justify-end mr-1">
                        <CommandSearchTrigger />
                        <NotificationBell />
                        {/* Top-right dark/light toggle — always visible on every screen size. */}
                        <ThemeToggle />
                        {/* Calendar + Settings are in the sidebar on desktop — removed redundant header icons (fix #28) */}
                        <ProfileButton />
                      </div>
                    </header>
                    <main id="main-content" className="flex-1 min-w-0 overflow-hidden pb-[var(--mobile-nav-height)] md:pb-0 flex flex-col">
                      <HubArea />
                    </main>
                  </div>
                </div>
                <MobileBottomNav />
              </SidebarProvider>
              {/* Global command palette — renders its own Dialog portal */}
              <CommandSearch />
            </CommandSearchProvider>
            </AuthGate>
          </Router>
          </ErrorBoundary>
          <Toaster />
          <OfflineIndicator />
          <InstallPrompt />
        </TooltipProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
