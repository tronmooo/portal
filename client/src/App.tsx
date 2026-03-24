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
import { AuthProvider, useAuth, installAuthInterceptor } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Sun, Moon, Settings, Calendar } from "lucide-react";
import { Loader2 } from "lucide-react";
import { PerplexityAttribution } from "@/components/PerplexityAttribution";
import {
  CommandSearch,
  CommandSearchProvider,
  CommandSearchTrigger,
} from "@/components/CommandSearch";
import { NotificationBell } from "@/components/NotificationBell";
import { OnboardingWizard } from "@/components/OnboardingWizard";
import { OfflineIndicator } from "@/components/OfflineIndicator";
import { InstallPrompt } from "@/components/InstallPrompt";
import { KeyboardShortcuts } from "@/components/KeyboardShortcuts";
import NotFound from "@/pages/not-found";
import ChatPage from "@/pages/chat";
import DashboardPage from "@/pages/dashboard";
import TrackersPage from "@/pages/trackers";
import ProfilesPage from "@/pages/profiles";
import ProfileDetailPage from "@/pages/profile-detail";
import DocumentDetailPage from "@/pages/document-detail";
import AuthPage from "@/pages/auth";
import ResetPasswordPage from "@/pages/reset-password";
import SettingsPage from "@/pages/settings";
import CalendarPage from "@/pages/calendar-page";

// Install auth interceptor to add JWT to all API requests
installAuthInterceptor();

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <Button variant="ghost" size="icon" onClick={toggle} className="h-8 w-8" data-testid="button-theme-toggle">
      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}

function CalendarButton() {
  const [, navigate] = useLocation();
  return (
    <Button variant="ghost" size="icon" onClick={() => navigate("/calendar")} className="h-8 w-8" title="Calendar" data-testid="button-calendar-header">
      <Calendar className="h-4 w-4" />
    </Button>
  );
}

function SettingsButton() {
  const [, navigate] = useLocation();
  return (
    <Button variant="ghost" size="icon" onClick={() => navigate("/settings")} className="h-8 w-8" title="Settings" data-testid="button-settings-header">
      <Settings className="h-4 w-4" />
    </Button>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading, authRequired } = useAuth();

  // Allow reset-password page through without auth
  if (window.location.hash.startsWith("#/reset-password")) {
    return <ResetPasswordPage />;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading LifeOS...</p>
        </div>
      </div>
    );
  }

  // If auth not required (SQLite mode), show app directly
  if (!authRequired) return <>{children}</>;

  // Auth required but not signed in — show login
  if (!user) return <AuthPage />;

  // Authenticated — show app
  return <>{children}</>;
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={ChatPage} />
      <Route path="/dashboard" component={DashboardPage} />
      <Route path="/trackers" component={TrackersPage} />
      <Route path="/profiles" component={ProfilesPage} />
      <Route path="/profiles/:id" component={ProfileDetailPage} />
      <Route path="/documents/:id" component={DocumentDetailPage} />
      <Route path="/calendar" component={CalendarPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/reset-password" component={ResetPasswordPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

const sidebarStyle = {
  "--sidebar-width": "14rem",
  "--sidebar-width-icon": "3rem",
};

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
        <TooltipProvider>
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
                        <span className="text-sm font-semibold tracking-tight text-foreground">LifeOS</span>
                      </div>
                      {/* Search trigger — centre-right in header */}
                      <div className="flex items-center gap-2 flex-1 justify-end mr-1">
                        <CommandSearchTrigger />
                        <NotificationBell />
                        <CalendarButton />
                        <SettingsButton />
                        <ThemeToggle />
                      </div>
                    </header>
                    <main className="flex-1 overflow-hidden pb-[60px] md:pb-0">
                      <OnboardingWizard />
                      <AppRouter />
                    </main>
                    <div className="hidden md:block">
                      <PerplexityAttribution />
                    </div>
                  </div>
                </div>
                <MobileBottomNav />
              </SidebarProvider>
              {/* Global command palette — renders its own Dialog portal */}
              <CommandSearch />
            </CommandSearchProvider>
            </AuthGate>
          </Router>
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
