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

import { OfflineIndicator } from "@/components/OfflineIndicator";
import { InstallPrompt } from "@/components/InstallPrompt";
import { KeyboardShortcuts } from "@/components/KeyboardShortcuts";
import { lazy, Suspense } from "react";
import { SectionErrorBoundary } from "@/components/ErrorBoundary";

// Keep lightweight pages as direct imports
import NotFound from "@/pages/not-found";
import ChatPage from "@/pages/chat";

// Lazy load heavy pages
const DashboardPage = lazy(() => import("@/pages/dashboard"));
const TrackersPage = lazy(() => import("@/pages/trackers"));
const ProfilesPage = lazy(() => import("@/pages/profiles"));
const ProfileDetailPage = lazy(() => import("@/pages/profile-detail"));
const DocumentDetailPage = lazy(() => import("@/pages/document-detail"));
const AuthPage = lazy(() => import("@/pages/auth"));
const ResetPasswordPage = lazy(() => import("@/pages/reset-password"));
const SettingsPage = lazy(() => import("@/pages/settings"));
const CalendarPage = lazy(() => import("@/pages/calendar-page"));
const ArtifactsPage = lazy(() => import("@/pages/artifacts"));
const FinancePage = lazy(() => import("@/pages/finance"));
const HabitsPage = lazy(() => import("@/pages/habits"));
const JournalPage = lazy(() => import("@/pages/journal"));
const ObligationsPage = lazy(() => import("@/pages/obligations"));
const TasksPage = lazy(() => import("@/pages/tasks"));
const PrivacyPage = lazy(() => import("@/pages/privacy"));
const TermsPage = lazy(() => import("@/pages/terms"));

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
    <Button variant="ghost" size="icon" onClick={toggle} className="h-8 w-8" aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} data-testid="button-theme-toggle">
      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}

function CalendarButton() {
  const [, navigate] = useLocation();
  return (
    <Button variant="ghost" size="icon" onClick={() => navigate("/calendar")} className="h-8 w-8" title="Calendar" aria-label="Open calendar" data-testid="button-calendar-header">
      <Calendar className="h-4 w-4" />
    </Button>
  );
}

function SettingsButton() {
  const [, navigate] = useLocation();
  return (
    <Button variant="ghost" size="icon" onClick={() => navigate("/settings")} className="h-8 w-8" title="Settings" aria-label="Open settings" data-testid="button-settings-header">
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
        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" title="Account" data-testid="button-profile-avatar">
          <div className="h-6 w-6 rounded-full bg-primary/20 flex items-center justify-center text-[10px] font-bold text-primary">
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
let _knownVersion: string | null = null;
setInterval(async () => {
  try {
    const res = await fetch("/api/version", { cache: "no-store" });
    if (res.ok) {
      const { version } = await res.json();
      if (_knownVersion && version !== _knownVersion) {
        console.log("[Version] New deploy detected, reloading...");
        window.location.reload();
      }
      _knownVersion = version;
    }
  } catch { /* offline, ignore */ }
}, 30000); // Check every 30 seconds

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
        <TooltipProvider>
          <ErrorBoundary>
          <Router hook={useHashLocation}>
            <AuthGate>
            <CommandSearchProvider>
              <KeyboardShortcuts />
              <SidebarProvider style={sidebarStyle as React.CSSProperties}>
                <div className="flex h-screen w-full">
                  {/* Sidebar hidden on mobile */}
                  <div className="hidden md:block">
                    <AppSidebar />
                  </div>
                  <div className="flex flex-col flex-1 min-w-0">
                    <header className="flex items-center justify-between px-3 py-2 border-b border-border bg-background/80 backdrop-blur-sm shrink-0">
                      <div className="hidden md:block">
                        <SidebarTrigger data-testid="button-sidebar-toggle" />
                      </div>
                      <div className="md:hidden">
                        <span className="text-sm font-semibold tracking-tight text-foreground">Portol</span>
                      </div>
                      {/* Search trigger — centre-right in header */}
                      <div className="flex items-center gap-1 sm:gap-2 flex-1 justify-end mr-1">
                        <CommandSearchTrigger />
                        <NotificationBell />
                        <div className="hidden md:flex items-center gap-1">
                          <CalendarButton />
                          <SettingsButton />
                        </div>
                        <ProfileButton />
                      </div>
                    </header>
                    <main className="flex-1 overflow-hidden pb-[60px] md:pb-0">
                      <AppRouter />
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
