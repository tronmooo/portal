import { Switch, Route, Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
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
import { Button } from "@/components/ui/button";
import { Sun, Moon, Settings, Calendar, Lock, LogOut, Users } from "lucide-react";
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

import { OfflineIndicator } from "@/components/OfflineIndicator";
import { InstallPrompt } from "@/components/InstallPrompt";
import { KeyboardShortcuts } from "@/components/KeyboardShortcuts";
import { lazy, Suspense, useEffect, useRef, useCallback, useState } from "react";
import { SectionErrorBoundary } from "@/components/ErrorBoundary";

// Keep lightweight pages as direct imports
import NotFound from "@/pages/not-found";
import ChatPage from "@/pages/chat";

// Lazy load heavy pages
const _dashImport = () => import("@/pages/dashboard");
const _trackImport = () => import("@/pages/trackers");
const _profImport  = () => import("@/pages/profiles");
const _profDImport = () => import("@/pages/profile-detail");
const _docDImport  = () => import("@/pages/document-detail");
const _authImport  = () => import("@/pages/auth");
const _resetImport = () => import("@/pages/reset-password");
const _settImport  = () => import("@/pages/settings");
const _calImport   = () => import("@/pages/calendar-page");
const _artImport   = () => import("@/pages/artifacts");
const _finImport   = () => import("@/pages/finance");
const _habImport   = () => import("@/pages/habits");
const _jourImport  = () => import("@/pages/journal");
const _oblImport   = () => import("@/pages/obligations");
const _taskImport  = () => import("@/pages/tasks");
const _privImport  = () => import("@/pages/privacy");
const _termsImport = () => import("@/pages/terms");

const DashboardPage    = lazy(_dashImport);
const TrackersPage     = lazy(_trackImport);
const ProfilesPage     = lazy(_profImport);
const ProfileDetailPage = lazy(_profDImport);
const DocumentDetailPage = lazy(_docDImport);
const AuthPage         = lazy(_authImport);
const ResetPasswordPage = lazy(_resetImport);
const SettingsPage     = lazy(_settImport);
const CalendarPage     = lazy(_calImport);
const ArtifactsPage    = lazy(_artImport);
const FinancePage      = lazy(_finImport);
const HabitsPage       = lazy(_habImport);
const JournalPage      = lazy(_jourImport);
const ObligationsPage  = lazy(_oblImport);
const TasksPage        = lazy(_taskImport);
const PrivacyPage      = lazy(_privImport);
const TermsPage        = lazy(_termsImport);

// Preload ALL main tab pages immediately so switching tabs is instant — no spinner on first visit.
// This fires the bundle fetches in parallel as soon as the app JS loads.
_dashImport();
_trackImport();
_profImport();
_settImport();
_calImport();
_artImport();
_finImport();
_habImport();
_jourImport();
_oblImport();
_taskImport();

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
  const { theme, toggle } = useTheme();
  return (
    <Button variant="ghost" size="icon" onClick={toggle} className="h-9 w-9" aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} data-testid="button-theme-toggle">
      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
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
        <DropdownMenuItem onClick={() => navigate("/settings")} data-testid="menu-change-password">
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

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading, authRequired } = useAuth();

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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
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

function PullToRefresh() {
  const pullRef = useRef<HTMLDivElement>(null);
  const startY = useRef<number | null>(null);
  const [pulling, setPulling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const threshold = 80;

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
        // Invalidate all React Query cache
        const qc = (window as any).__portol_queryClient;
        if (qc) await qc.invalidateQueries();
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

  const TAB_ORDER = ['/', '/dashboard', '/linked', '/calendar', '/artifacts'];

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
    const currentTab = TAB_ORDER.find(t => t === location || (t !== '/' && location.startsWith(t))) || '/';
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

// Keep the Vercel serverless function warm so there's never a cold-start delay.
// Ping every 90 seconds — Vercel keeps functions alive for ~5 min after last request.
function KeepAlive() {
  const { user } = useAuth();
  const { getAuthHeader } = useAuth();
  useEffect(() => {
    if (!user) return;
    const ping = () => {
      fetch("/api/warmup", { headers: getAuthHeader() }).catch(() => {});
    };
    ping(); // Immediate ping to pre-warm cache on mount
    const id = setInterval(ping, 90_000); // Then every 90 seconds

    // ── Visibility recovery: when user returns after ≥15s absence, warm server + refresh data
    let hiddenAt = 0;
    const onVisChange = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
      } else {
        const awayMs = Date.now() - hiddenAt;
        if (hiddenAt > 0 && awayMs >= 15_000) {
          ping(); // Re-warm Vercel cold-started function immediately
          // Invalidate dashboard + stats so they refresh with fresh data
          setTimeout(() => {
            queryClient.invalidateQueries({ queryKey: ['/api/stats'] });
            queryClient.invalidateQueries({ queryKey: ['/api/dashboard-enhanced'] });
          }, 800); // slight delay to let warmup respond first
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

// Prefetch all main page data immediately after login.
// This eliminates skeleton loading states when switching tabs —
// by the time the user navigates anywhere, data is already in the React Query cache.
const ALL_PREFETCH_KEYS = [
  '/api/trackers',
  '/api/profiles',
  '/api/events',
  '/api/stats',
  '/api/dashboard-enhanced',
  '/api/habits',
  '/api/goals',
  '/api/expenses',
  '/api/obligations',
  '/api/notifications',
];

function DataPrefetch() {
  const { user } = useAuth();
  const prefetched = useRef(false);
  useEffect(() => {
    if (!user || prefetched.current) return;
    prefetched.current = true;
    // Fire all queries in parallel — no await, best-effort
    for (const key of ALL_PREFETCH_KEYS) {
      queryClient.prefetchQuery({ queryKey: [key] }).catch(() => {});
    }
  }, [user]);
  return null;
}

function AppRouter() {
  return (
    <SectionErrorBoundary name="app">
    <Suspense fallback={<PageLoader />}>
      <Switch>
        <Route path="/" component={ChatPage} />
        <Route path="/dashboard" component={DashboardPage} />
        <Route path="/trackers" component={TrackersPage} />
        <Route path="/linked" component={TrackersPage} />
        <Route path="/profiles" component={ProfilesPage} />
        <Route path="/profiles/:id" component={ProfileDetailPage} />
        <Route path="/documents/:id" component={DocumentDetailPage} />
        <Route path="/calendar" component={CalendarPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/reset-password" component={ResetPasswordPage} />
        <Route path="/privacy" component={PrivacyPage} />
        <Route path="/terms" component={TermsPage} />
        <Route path="/artifacts" component={ArtifactsPage} />
        <Route path="/dashboard/documents" component={ArtifactsPage} />
        <Route path="/dashboard/finance" component={FinancePage} />
        <Route path="/dashboard/habits" component={HabitsPage} />
        <Route path="/dashboard/journal" component={JournalPage} />
        <Route path="/dashboard/obligations" component={ObligationsPage} />
        <Route path="/dashboard/tasks" component={TasksPage} />
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
          <Router hook={useHashLocation}>
            <ScrollToTop />
            <KeepAlive />
            <DataPrefetch />
            <SwipeNav />
            <PullToRefresh />
            <AuthGate>
            <CommandSearchProvider>
              <KeyboardShortcuts />
              <SidebarProvider style={sidebarStyle as React.CSSProperties}>
                <div className="flex h-screen w-full max-w-[90rem] mx-auto">
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
                        <img src="/portol-logo-clean.png" alt="Portol" className="w-7 h-7 object-contain" style={{ filter: 'drop-shadow(0 0 4px rgba(0,200,220,0.4))' }} />
                        <span className="text-sm font-bold tracking-tight text-foreground">Portol</span>
                      </div>
                      {/* Search trigger — centre-right in header */}
                      <div className="flex items-center gap-1 sm:gap-2 flex-1 justify-end mr-1">
                        <CommandSearchTrigger />
                        <Button variant="ghost" size="icon" onClick={() => window.location.hash = "#/profiles"} className="h-8 w-8" title="Profiles" aria-label="Open profiles" data-testid="button-profiles-header">
                          <Users className="h-4 w-4" />
                        </Button>
                        <NotificationBell />
                        {/* Calendar + Settings are in the sidebar on desktop — removed redundant header icons (fix #28) */}
                        <ProfileButton />
                      </div>
                    </header>
                    <main id="main-content" className="flex-1 overflow-hidden pb-[var(--mobile-nav-height)] md:pb-0">
                      <div className="h-full">
                        <AppRouter />
                      </div>
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
