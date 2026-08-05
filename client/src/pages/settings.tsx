import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-shell";
import { Settings as SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  User, Download, Upload, FileSpreadsheet, Moon, Sun, LogOut, Shield, Database,
  Palette, Info, CheckCircle2, Loader2, ArrowLeft, Bell, BellOff, Bot, Zap,
  Globe, Calendar, Lock, Trash2, HardDrive, RefreshCw, ExternalLink,
  Smartphone, Monitor, ChevronRight, Key, Eye, EyeOff, Clock,
  Users, Activity, ListTodo, FileText, Sparkles,
} from "lucide-react";
import { ChatGPTImportDialog, ChatGPTImportHistory } from "@/components/ChatGPTImportDialog";
import { HealthConnectionsCard } from "@/components/health/HealthConnectionsCard";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { useTheme, COLOR_PRESETS } from "@/components/theme-provider";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

function PWAInstallCard() {
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => { e.preventDefault(); setDeferredPrompt(e); };
    window.addEventListener('beforeinstallprompt', handler);
    window.addEventListener('appinstalled', () => setInstalled(true));
    // Check if already installed
    if (window.matchMedia('(display-mode: standalone)').matches) setInstalled(true);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  if (installed || !deferredPrompt) return null;

  return (
    <div className=" bubble border -primary/30 bg-primary/5 p-4 flex items-center gap-3 mb-4">
      <div className="w-14 h-14 rounded-xl bg-primary/15 flex items-center justify-center shrink-0">
        <img src="/portol-logo-clean.png" alt="Portol" className="w-9 h-9 object-contain" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-foreground">Install Portol</p>
        <p className="text-xs text-muted-foreground">Add to your home screen for the full app experience</p>
      </div>
      <button
        onClick={async () => {
          deferredPrompt.prompt();
          const result = await deferredPrompt.userChoice;
          if (result.outcome === 'accepted') setInstalled(true);
          setDeferredPrompt(null);
        }}
        className="shrink-0 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90"
      >
        Install
      </button>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, href, accent }: { icon: any; label: string; value: number | string; href: string; accent: string }) {
  const [, navigate] = useLocation();
  return (
    <button
      onClick={() => navigate(href)}
      className="flex items-center gap-3 p-3 bubble  active:scale-[0.98] transition-all text-left card-lift w-full"
      style={{ ["--accent-hsl" as any]: accent }}
    >
      <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: `hsl(${accent} / 0.15)` }}>
        <Icon className="h-4 w-4" style={{ color: `hsl(${accent})` }} />
      </div>
      <div>
        <p className="text-lg font-bold metric-value" style={{ color: `hsl(${accent})` }}>{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </button>
  );
}

function NotificationToggle({ prefKey, label, description, icon }: { prefKey: string; label: string; description: string; icon: React.ReactNode }) {
  const { toast } = useToast();
  const { data: pref } = useQuery<{ value: string | null }>({
    queryKey: [`/api/preferences/${prefKey}`],
    queryFn: () => apiRequest("GET", `/api/preferences/${prefKey}`).then(r => r.json()),
  });

  const enabled = pref?.value !== "false";

  async function toggle(checked: boolean) {
    // Optimistic: update the preference value immediately so the Switch reflects the change with no flicker
    const queryKey = [`/api/preferences/${prefKey}`];
    const prev = queryClient.getQueryData<{ value: string | null }>(queryKey);
    queryClient.setQueryData(queryKey, { value: String(checked) });
    try {
      await apiRequest("PUT", `/api/preferences/${prefKey}`, { value: String(checked) });
      queryClient.invalidateQueries({ queryKey });
    } catch (err: any) {
      // Rollback to previous value
      if (prev !== undefined) queryClient.setQueryData(queryKey, prev);
      toast({ title: "Failed to update setting", description: err.message, variant: "destructive" });
    }
  }

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        {icon}
        <div>
          <Label className="text-sm font-medium">{label}</Label>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
      </div>
      <Switch checked={enabled} onCheckedChange={toggle} data-testid={`switch-${prefKey}`} />
    </div>
  );
}

// Google Calendar integration row. The previous implementation showed a static
// "Available" badge with no action — a dead-end UI. This component reads the
// real connection state from /api/calendar/status, exposes a Sync Now button
// when connected, and falls back to clear messaging when no refresh token
// has been provisioned. Connect-the-account flow is intentionally out of
// scope here (it requires OAuth redirect handling); the "Connect" link sends
// the user to the help doc until that's wired.
function GoogleCalendarRow() {
  const { toast } = useToast();
  const [syncing, setSyncing] = useState(false);
  const { data: status } = useQuery<{ connected: boolean; lastSync: string | null; importedCount: number; totalEvents: number }>({
    queryKey: ["/api/calendar/status"],
    queryFn: () => apiRequest("GET", "/api/calendar/status").then(r => r.json()),
    refetchOnWindowFocus: false,
  });
  const connected = !!status?.connected;
  const lastSyncLabel = status?.lastSync
    ? new Date(status.lastSync).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;
  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await apiRequest("POST", "/api/calendar/sync", {}).then(r => r.json());
      toast({ title: "Calendar synced", description: `${res.imported || 0} events imported` });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
    } catch (err: any) {
      // Friendly, actionable messages — the previous "Could not reach Google
      // Calendar" was vague and gave no recovery path. Map common failure modes
      // to specific guidance so users know what to do next.
      const msg: string = String(err?.message || "");
      let description = "Something went wrong. Please try again in a moment.";
      if (/\b502\b|bad gateway/i.test(msg)) {
        description = "Google Calendar sync is temporarily unavailable. We're working on it — please try again in a few minutes.";
      } else if (/\b401\b|unauthor/i.test(msg)) {
        description = "Your Google Calendar connection expired. Please reconnect in Settings.";
      } else if (/\b403\b|forbidden/i.test(msg)) {
        description = "Google denied the request. Re-grant calendar access in your Google account.";
      } else if (/\b429\b|rate.?limit/i.test(msg)) {
        description = "Too many sync requests. Please wait a minute and try again.";
      } else if (/network|fetch|timeout/i.test(msg)) {
        description = "Network issue reaching Google. Check your connection and retry.";
      }
      toast({ title: "Sync failed", description, variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  };
  return (
    <div className="flex items-center justify-between" data-testid="row-google-calendar">
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
          <Calendar className="h-4 w-4 text-blue-500" />
        </div>
        <div>
          <Label className="text-sm font-medium">Google Calendar</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            {connected
              ? `Connected${lastSyncLabel ? ` — last synced ${lastSyncLabel}` : ""}`
              : "Sync events from Google Calendar"}
          </p>
        </div>
      </div>
      {connected ? (
        <Button size="sm" variant="outline" onClick={handleSync} disabled={syncing} data-testid="button-gcal-sync">
          {syncing ? "Syncing…" : "Sync now"}
        </Button>
      ) : (
        <Badge variant="outline" className="text-xs" data-testid="badge-gcal-not-connected">Not connected</Badge>
      )}
    </div>
  );
}

export default function SettingsPage() {
  useEffect(() => { document.title = "Settings — Portol"; }, []);
  const { user, signOut } = useAuth();
  const { mode, resolvedMode, setMode, primary, setPreset, setHue } = useTheme();
  // Pull current hue from the live --primary CSS var so the slider always reflects what's applied.
  const currentHue = (() => {
    const m = primary.match(/^(\d+(?:\.\d+)?)/);
    return m ? parseInt(m[1], 10) : 186;
  })();
  const matchedPreset = COLOR_PRESETS.find((p) => p.primary === primary)?.id;
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);

  const [exporting, setExporting] = useState(false);
  const [chatgptImportOpen, setChatgptImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importingCsv, setImportingCsv] = useState(false);
  const [showSignOutDialog, setShowSignOutDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [lastExport, setLastExport] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<string | null>(null);
  const [lastCsvImport, setLastCsvImport] = useState<string | null>(null);
  const [clearingCache, setClearingCache] = useState(false);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  // QA Bug 8: when arriving from avatar menu "Change Password" we get
  // ?changePassword=1 — auto-expand the form and scroll to it. Also strip the
  // query so a refresh doesn't re-expand on every load.
  useEffect(() => {
    const hash = window.location.hash || "";
    const q = hash.includes("?") ? hash.split("?")[1] : "";
    if (q && new URLSearchParams(q).get("changePassword") === "1") {
      setShowPasswordForm(true);
      const cleaned = hash.split("?")[0];
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${cleaned}`);
      // Scroll after the form mounts so the user lands on it instead of the page top.
      requestAnimationFrame(() => {
        const el = document.querySelector("[data-section='change-password']");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
  }, []);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [, navigate] = useLocation();

  // Fetch stats for data summary
  const { data: stats } = useQuery<any>({
    queryKey: ["/api/stats"],
    queryFn: () => apiRequest("GET", "/api/stats").then(r => r.json()),
  });

  // Fetch profiles count
  const { data: profiles = [] } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });
  // Fetch document count
  const { data: allDocs = [] } = useQuery<any[]>({
    queryKey: ["/api/documents"],
    queryFn: () => apiRequest("GET", "/api/documents").then(r => r.json()),
  });

  // Fetch AI preferences
  const { data: prefChatModel } = useQuery<{ value: string | null }>({
    queryKey: ["/api/preferences/ai_chat_model"],
    queryFn: () => apiRequest("GET", "/api/preferences/ai_chat_model").then(r => r.json()),
  });
  const { data: prefFastPath } = useQuery<{ value: string | null }>({
    queryKey: ["/api/preferences/ai_fast_path"],
    queryFn: () => apiRequest("GET", "/api/preferences/ai_fast_path").then(r => r.json()),
  });
  const { data: prefAutoExpense } = useQuery<{ value: string | null }>({
    queryKey: ["/api/preferences/ai_auto_expense"],
    queryFn: () => apiRequest("GET", "/api/preferences/ai_auto_expense").then(r => r.json()),
  });
  const { data: prefSmartRouting } = useQuery<{ value: string | null }>({
    queryKey: ["/api/preferences/ai_smart_routing"],
    queryFn: () => apiRequest("GET", "/api/preferences/ai_smart_routing").then(r => r.json()),
  });
  const { data: prefAutoCreateTrackers } = useQuery<{ value: string | null }>({
    queryKey: ["/api/preferences/ai_auto_create_trackers"],
    queryFn: () => apiRequest("GET", "/api/preferences/ai_auto_create_trackers").then(r => r.json()),
  });

  // (2026-05-24) Map retired Sonnet 4.5 saved preferences onto the current
  // Sonnet 4.6 so the Select displays the right option and the server doesn't
  // get a dead model id when chat runs. Server-side ai-engine.ts does the
  // same migration on read for safety.
  const RETIRED_SONNET_IDS = new Set([
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-4-5",
    "claude-3-5-sonnet-20241022",
  ]);
  const rawAiChatModel = prefChatModel?.value || "claude-sonnet-4-6";
  const aiChatModel = RETIRED_SONNET_IDS.has(rawAiChatModel) ? "claude-sonnet-4-6" : rawAiChatModel;
  const aiFastPath = prefFastPath?.value !== "false";
  const aiAutoExpense = prefAutoExpense?.value !== "false";
  const aiSmartRouting = prefSmartRouting?.value !== "false";
  const aiAutoCreateTrackers = prefAutoCreateTrackers?.value !== "false";

  async function setAiPreference(key: string, value: string) {
    // Optimistic: reflect the new value immediately so the Switch/Select doesn't flicker back
    const queryKey = [`/api/preferences/${key}`];
    const prev = queryClient.getQueryData<{ value: string | null }>(queryKey);
    queryClient.setQueryData(queryKey, { value });
    try {
      await apiRequest("PUT", `/api/preferences/${key}`, { value });
      queryClient.invalidateQueries({ queryKey });
    } catch (err: any) {
      if (prev !== undefined) queryClient.setQueryData(queryKey, prev);
      toast({ title: "Failed to update setting", description: err.message, variant: "destructive" });
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      const res = await apiRequest("GET", "/api/export");
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `portol-backup-${new Date().toISOString().split("T")[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setLastExport(new Date().toLocaleString());
      const counts = Object.entries(data)
        .filter(([, v]) => Array.isArray(v) && (v as any[]).length > 0)
        .map(([k, v]) => `${(v as any[]).length} ${k}`)
        .join(", ");
      toast({ title: "Export complete", description: counts ? `Exported ${counts}.` : "Your data has been downloaded." });
    } catch (err: any) {
      toast({ title: "Export failed", description: err.message, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const validKeys = ["profiles", "trackers", "tasks", "expenses", "events", "documents", "obligations", "habits", "journal", "goals"];
      if (typeof data !== "object" || data === null || !Object.keys(data).some(k => validKeys.includes(k))) {
        throw new Error("Invalid backup file. Expected a Portol backup with profiles, trackers, tasks, etc.");
      }
      const res = await apiRequest("POST", "/api/import", data);
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      setLastImport(new Date().toLocaleString());
      const counts = Object.entries(result.imported || {})
        .filter(([, v]) => (v as number) > 0)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ");
      toast({ title: "Import complete", description: counts || "Data restored successfully." });
      queryClient.invalidateQueries();
    } catch (err: any) {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleCsvImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportingCsv(true);
    try {
      const csv = await file.text();
      const res = await apiRequest("POST", "/api/import/bank-csv", { csv });
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      setLastCsvImport(new Date().toLocaleString());
      toast({ title: "Bank CSV imported", description: `${result.imported} expenses created, ${result.skipped} skipped.` });
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
    } catch (err: any) {
      toast({ title: "CSV import failed", description: err.message, variant: "destructive" });
    } finally {
      setImportingCsv(false);
      if (csvInputRef.current) csvInputRef.current.value = "";
    }
  }

  async function handleClearCache() {
    setClearingCache(true);
    try {
      queryClient.clear();
      await new Promise(r => setTimeout(r, 500));
      queryClient.invalidateQueries();
      toast({ title: "Cache cleared", description: "All cached data has been refreshed." });
    } finally {
      setClearingCache(false);
    }
  }

  const userInitial = user?.email?.charAt(0).toUpperCase() || "?";
  const memberSince = (user as any)?.created_at ? new Date((user as any).created_at).toLocaleDateString("en-US", { month: "long", year: "numeric" }) : null;

  return (
    <div className="h-full overflow-y-auto pb-24">
      <div className="max-w-2xl mx-auto p-4 md:p-6 space-y-4">
        <PWAInstallCard />
        {/* The page had a back arrow and nothing else — no title anywhere. */}
        <PageHeader title="Settings" subtitle="Account, appearance, data and privacy"
          icon={SettingsIcon} accent="240 5% 55%" backHref="/dashboard" />

        {/* ─── Account ─── */}
        <Card data-testid="card-account">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Account</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center text-xl font-bold text-primary shrink-0">
                {userInitial}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium" data-testid="text-user-email">{user?.email || "Not signed in"}</p>
                {memberSince && <p className="text-xs text-muted-foreground">Member since {memberSince}</p>}
                <div className="flex items-center gap-2 mt-1">
                  <Badge variant="secondary" className="text-xs">
                    <Shield className="h-2.5 w-2.5 mr-1" /> Authenticated
                  </Badge>
                  {(user as any)?.app_metadata?.provider && (
                    <Badge variant="outline" className="text-xs capitalize">
                      {(user as any).app_metadata.provider === "google" ? "Google" : "Email"}
                    </Badge>
                  )}
                </div>
              </div>
            </div>

            <Separator />

            {/* Data Summary */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Your Data</p>
              <div className="grid grid-cols-2 gap-2">
                <StatCard icon={Users} label="Profiles" value={profiles.length} href="/profiles" accent="188 55% 50%" />
                <StatCard icon={ListTodo} label="Active Tasks" value={stats?.activeTasks || 0} href="/dashboard" accent="262 65% 62%" />
                <StatCard icon={Activity} label="Trackers" value={stats?.totalTrackers || 0} href="/linked" accent="173 60% 44%" />
                <StatCard icon={FileText} label="Documents" value={allDocs.length} href="/linked" accent="25 80% 54%" />
              </div>
            </div>

            <Separator />

            {/* Change Password */}
            {(user as any)?.app_metadata?.provider === "google" ? (
              <div className="space-y-2">
                <div>
                  <Label className="text-sm font-medium text-muted-foreground">Change Password</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">Password managed by Google</p>
                </div>
                <Badge variant="outline" className="text-xs">
                  <Globe className="h-2.5 w-2.5 mr-1" /> Google SSO — password changes are handled through your Google account
                </Badge>
              </div>
            ) : (
            <div className="space-y-2" data-section="change-password">
              <div>
                <Label className="text-sm font-medium">Change Password</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Update your account password</p>
              </div>
              {showPasswordForm ? (
                <div className="space-y-2 pl-0">
                  <Input
                    type="password"
                    placeholder="Current password"
                    value={currentPassword}
                    onChange={e => setCurrentPassword(e.target.value)}
                    className="h-8 text-sm"
                    autoComplete="current-password"
                    data-testid="input-current-password"
                  />
                  <Input
                    type="password"
                    placeholder="New password (min 6 characters)"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    className="h-8 text-sm"
                    autoComplete="new-password"
                    data-testid="input-new-password"
                  />
                  <Input
                    type="password"
                    placeholder="Confirm new password"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    className="h-8 text-sm"
                    autoComplete="new-password"
                    data-testid="input-confirm-password"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={!currentPassword || !newPassword || newPassword.length < 6 || newPassword !== confirmPassword || newPassword === currentPassword || changingPassword}
                      onClick={async () => {
                        setChangingPassword(true);
                        try {
                          // apiRequest centralises auth header + error handling
                          await apiRequest('POST', '/api/auth/change-password', { currentPassword, newPassword });
                          toast({ title: 'Password updated', description: 'Your password has been changed successfully.' });
                          setShowPasswordForm(false);
                          setCurrentPassword('');
                          setNewPassword('');
                          setConfirmPassword('');
                        } catch (err: any) {
                          const msg = err?.message || '';
                          // Surface the exact server error when we can. The server
                          // now returns 401 for an incorrect current password, so
                          // distinguish that from a session-level 401.
                          const isCurrentPwdWrong = msg.toLowerCase().includes('current password is incorrect');
                          toast({
                            title: 'Could not change password',
                            description: isCurrentPwdWrong
                              ? 'Current password is incorrect'
                              : msg.includes('401') ? 'Session expired \u2014 sign out and back in'
                              : msg.includes('400') ? 'Password is too weak'
                              : 'Please try again',
                            variant: 'destructive',
                          });
                        } finally {
                          setChangingPassword(false);
                        }
                      }}
                      data-testid="button-save-password"
                    >
                      {changingPassword ? 'Saving...' : 'Save Password'}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => { setShowPasswordForm(false); setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); }}>
                      Cancel
                    </Button>
                  </div>
                  {newPassword && newPassword.length < 6 && (
                    <p className="text-xs text-destructive">Password must be at least 6 characters</p>
                  )}
                  {confirmPassword && newPassword !== confirmPassword && (
                    <p className="text-xs text-destructive">Passwords don't match</p>
                  )}
                </div>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setShowPasswordForm(true)} data-testid="button-change-password">
                  <Lock className="h-3.5 w-3.5 mr-1.5" /> Change Password
                </Button>
              )}
            </div>
            )}

            <Separator />

            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Sign Out</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Sign out on this device</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setShowSignOutDialog(true)} data-testid="button-signout-settings">
                <LogOut className="h-3.5 w-3.5 mr-1.5" /> Sign Out
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ─── Appearance ─── */}
        <Card data-testid="card-appearance">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Palette className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Appearance</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Mode — light / dark / system */}
            <div>
              <Label className="text-sm font-medium">Mode</Label>
              <p className="text-xs text-muted-foreground mt-0.5 mb-2">
                {mode === "system"
                  ? `Following your device (${resolvedMode})`
                  : `${resolvedMode === "dark" ? "Dark" : "Light"} theme active`}
              </p>
              <div className="inline-flex rounded-lg border border-border/60 bg-muted/30 p-0.5" role="radiogroup" aria-label="Theme mode">
                {([
                  { value: "light",  Icon: Sun,     label: "Light"  },
                  { value: "dark",   Icon: Moon,    label: "Dark"   },
                  { value: "system", Icon: Monitor, label: "System" },
                ] as const).map(({ value, Icon, label }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setMode(value)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${mode === value ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    aria-pressed={mode === value}
                    data-testid={`mode-${value}`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <Separator />

            {/* Accent color presets */}
            <div>
              <Label className="text-sm font-medium">Accent color</Label>
              <p className="text-xs text-muted-foreground mt-0.5 mb-2.5">
                Pick a preset, or fine-tune with the hue slider below.
              </p>
              <div className="flex flex-wrap gap-2">
                {COLOR_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPreset(p.id)}
                    className={`relative h-9 w-9 rounded-full border-2 transition-all hover:scale-105 ${matchedPreset === p.id ? "border-foreground shadow-md" : "border-border/40"}`}
                    style={{ backgroundColor: `hsl(${p.primary})` }}
                    aria-label={`Set accent color to ${p.label}`}
                    title={p.label}
                    data-testid={`color-preset-${p.id}`}
                  >
                    {matchedPreset === p.id && (
                      <CheckCircle2 className="absolute -top-1 -right-1 h-4 w-4 bg-background rounded-full text-foreground" />
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Custom hue slider */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <Label className="text-sm font-medium">Custom hue</Label>
                <span className="text-xs text-muted-foreground tabular-nums">{currentHue}°</span>
              </div>
              <input
                type="range"
                min={0}
                max={360}
                value={currentHue}
                onChange={(e) => setHue(parseInt(e.target.value, 10))}
                className="w-full h-3 rounded-full appearance-none cursor-pointer"
                style={{
                  background: "linear-gradient(to right, hsl(0 85% 50%), hsl(60 85% 50%), hsl(120 85% 50%), hsl(180 85% 50%), hsl(240 85% 50%), hsl(300 85% 50%), hsl(360 85% 50%))",
                }}
                aria-label="Custom theme hue"
                data-testid="hue-slider"
              />
              <div className="mt-2 flex items-center gap-3">
                <div
                  className="h-8 w-8 rounded-lg border border-border/40"
                  style={{ backgroundColor: `hsl(${primary})` }}
                  aria-hidden
                />
                <span className="text-xs text-muted-foreground">
                  Live preview — the whole app updates as you drag.
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ─── AI & Chat ─── */}
        <Card data-testid="card-ai">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">AI & Chat</CardTitle>
            </div>
            <CardDescription>Configure how the AI assistant behaves.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Chat Model</Label>
                <p className="text-xs text-muted-foreground mt-0.5">AI model used for chat responses</p>
              </div>
              <Select
                value={aiChatModel}
                onValueChange={(value) => setAiPreference("ai_chat_model", value)}
              >
                <SelectTrigger className="w-[200px] h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude-sonnet-4-6">
                    <span className="flex items-center gap-1.5"><Zap className="h-3 w-3" /> Sonnet 4.6 (powerful)</span>
                  </SelectItem>
                  <SelectItem value="claude-haiku-4-5-20251001">
                    <span className="flex items-center gap-1.5"><Zap className="h-3 w-3" /> Haiku 4.5 (faster)</span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Document Extraction</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Vision model for document scanning</p>
              </div>
              <Badge variant="outline" className="text-xs">
                <Eye className="h-3 w-3 mr-1" /> Claude Sonnet 4.6
              </Badge>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div className="flex-1 mr-4">
                <Label className="text-sm font-medium">Fast-Path Commands</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Instant logging (weight, BP, mood) bypasses AI for speed</p>
              </div>
              <Switch
                checked={aiFastPath}
                onCheckedChange={(checked) => setAiPreference("ai_fast_path", String(checked))}
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div className="flex-1 mr-4">
                <Label className="text-sm font-medium">Auto-Expense from Documents</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Automatically create expenses when scanning receipts</p>
              </div>
              <Switch
                checked={aiAutoExpense}
                onCheckedChange={(checked) => setAiPreference("ai_auto_expense", String(checked))}
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div className="flex-1 mr-4">
                <Label className="text-sm font-medium">Smart Data Routing</Label>
                <p className="text-xs text-muted-foreground mt-0.5">AI routes extracted data to correct profile, calendar, and trackers</p>
              </div>
              <Switch
                checked={aiSmartRouting}
                onCheckedChange={(checked) => setAiPreference("ai_smart_routing", String(checked))}
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div className="flex-1 mr-4">
                <Label className="text-sm font-medium">Auto-Create Trackers</Label>
                <p className="text-xs text-muted-foreground mt-0.5">When you log something without an existing tracker, create one automatically</p>
              </div>
              <Switch
                checked={aiAutoCreateTrackers}
                onCheckedChange={(checked) => setAiPreference("ai_auto_create_trackers", String(checked))}
              />
            </div>
          </CardContent>
        </Card>

        {/* ─── Notifications ─── */}
        <Card data-testid="card-notifications">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Notifications</CardTitle>
            </div>
            <CardDescription>Control how Portol notifies you.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <NotificationToggle
              prefKey="notifications_enabled"
              label="Enable Notifications"
              description="Receive in-app notifications for reminders and updates"
              icon={<Bell className="h-4 w-4 text-muted-foreground" />}
            />
            <Separator />
            <NotificationToggle
              prefKey="email_notifications"
              label="Email Notifications"
              description="Receive email alerts for important events"
              icon={<BellOff className="h-4 w-4 text-muted-foreground" />}
            />
          </CardContent>
        </Card>

        {/* ─── Data Management ─── */}
        <Card data-testid="card-data">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Data Management</CardTitle>
            </div>
            <CardDescription>Export, import, and manage your data.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Export */}
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Export Backup</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Download all data as JSON</p>
                {lastExport && (
                  <p className="text-xs text-green-600 dark:text-green-400 mt-1 flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> {lastExport}
                  </p>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting} data-testid="button-export">
                {exporting ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1.5" />}
                Export
              </Button>
            </div>

            <Separator />

            {/* Import */}
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Restore from Backup</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Upload a Portol JSON backup</p>
                {lastImport && (
                  <p className="text-xs text-green-600 dark:text-green-400 mt-1 flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> {lastImport}
                  </p>
                )}
              </div>
              <div>
                <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImport} data-testid="input-import-file" />
                <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={importing} data-testid="button-import">
                  {importing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Upload className="h-3.5 w-3.5 mr-1.5" />}
                  Import
                </Button>
              </div>
            </div>

            <Separator />

            {/* Bank CSV Import */}
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Import Bank Statement</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Upload CSV to create expense entries</p>
                {lastCsvImport && (
                  <p className="text-xs text-green-600 dark:text-green-400 mt-1 flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> {lastCsvImport}
                  </p>
                )}
              </div>
              <div>
                <input ref={csvInputRef} type="file" accept=".csv" className="hidden" onChange={handleCsvImport} data-testid="input-csv-file" />
                <Button variant="outline" size="sm" onClick={() => csvInputRef.current?.click()} disabled={importingCsv} data-testid="button-csv-import">
                  {importingCsv ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5 mr-1.5" />}
                  Upload CSV
                </Button>
              </div>
            </div>

            <Separator />

            {/* Clear Cache */}
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Clear Cache</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Refresh all cached data from the server</p>
              </div>
              <Button variant="outline" size="sm" onClick={handleClearCache} disabled={clearingCache} data-testid="button-clear-cache">
                {clearingCache ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
                Clear
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Duplicate Export section removed — Data Management → Export Backup above covers this (fix #27) */}

        {/* ─── Privacy & Security ─── */}
        <Card data-testid="card-privacy">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Privacy & Security</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Authentication</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Supabase Auth with JWT tokens</p>
              </div>
              <Badge className="text-xs bg-green-500/10 text-green-600 border-green-500/20">
                <Shield className="h-2.5 w-2.5 mr-1" /> Secure
              </Badge>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Data Storage</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Supabase PostgreSQL with Row Level Security</p>
              </div>
              <Badge className="text-xs bg-green-500/10 text-green-600 border-green-500/20">
                <HardDrive className="h-2.5 w-2.5 mr-1" /> Encrypted
              </Badge>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Document Storage</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Files stored in Supabase Storage, scoped per user</p>
              </div>
              <Badge className="text-xs bg-green-500/10 text-green-600 border-green-500/20">
                <Lock className="h-2.5 w-2.5 mr-1" /> Private
              </Badge>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium text-destructive">Delete All Data</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Permanently delete all your Portol data. This cannot be undone.</p>
              </div>
              <Button variant="destructive" size="sm" onClick={() => setShowDeleteDialog(true)} data-testid="button-delete-data">
                <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Delete
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ─── Import from ChatGPT ─── */}
        <Card data-testid="card-chatgpt-import">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <CardTitle className="text-base">Import from ChatGPT</CardTitle>
            </div>
            <CardDescription>
              Generate a prompt, run it in ChatGPT, then paste the result back to update your finances —
              transactions, bills, subscriptions, accounts, assets, liabilities and budgets — in one import.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button onClick={() => setChatgptImportOpen(true)} className="gap-2" data-testid="btn-open-chatgpt-import">
              <Sparkles className="h-4 w-4" /> Refresh from ChatGPT
            </Button>
            <Separator />
            <div className="space-y-2">
              <Label className="micro-label text-muted-foreground">Import history</Label>
              <ChatGPTImportHistory />
            </div>
          </CardContent>
        </Card>

        {/* ─── Connected Services ─── */}
        <Card data-testid="card-integrations">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Connected Services</CardTitle>
            </div>
            <CardDescription>Integrations and external connections.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <GoogleCalendarRow />
            <Separator />
            {/* Apple Health moved to its own Health Connections card below — it
                is a real integration now rather than a "Coming Soon" placeholder. */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-8 w-8 rounded-lg bg-green-500/10 flex items-center justify-center">
                  <HardDrive className="h-4 w-4 text-green-500" />
                </div>
                <div>
                  <Label className="text-sm font-medium">Plaid (Banking)</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">Auto-import bank transactions</p>
                </div>
              </div>
              <Badge variant="outline" className="text-xs">Coming Soon</Badge>
            </div>
          </CardContent>
        </Card>

        {/* ─── Health Connections ─── */}
        <HealthConnectionsCard />

        {/* ─── About ─── */}
        <Card data-testid="card-about">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Info className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">About Portol</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Version</span>
                <span className="font-mono text-xs">1.0.0</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Platform</span>
                <span className="text-xs">React + Express + Supabase</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">AI Engine</span>
                <span className="text-xs">Anthropic Claude</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Hosting</span>
                <span className="text-xs">Vercel (portol.me)</span>
              </div>
              <Separator />
              <p className="text-xs text-muted-foreground leading-relaxed">
                Portol is your AI-powered personal operating system. Chat to log, track, and manage everything in your life — health, finance, documents, vehicles, pets, and more — all in one place.
              </p>
            </div>
          </CardContent>
        </Card>

        <div className="pb-10" />
      </div>

      {/* Sign out confirmation */}
      <AlertDialog open={showSignOutDialog} onOpenChange={setShowSignOutDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign Out</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to sign out? You'll need to sign in again to access your data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-signout">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={signOut} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" data-testid="button-confirm-signout">
              Sign Out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete data confirmation */}
      <AlertDialog open={showDeleteDialog} onOpenChange={(open) => { setShowDeleteDialog(open); if (!open) setDeleteConfirmText(""); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive">Delete All Data</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>This will permanently delete <strong>ALL</strong> your data. This cannot be undone.</p>
                <p className="text-xs">All expenses, tasks, habits, trackers, obligations, events, documents, journal entries, goals, artifacts, memories, paychecks, cashflow, and loan schedules will be permanently removed. Your profile will be preserved.</p>
                <p className="text-xs font-medium">Type <span className="font-mono bg-muted px-1.5 py-0.5 rounded">DELETE</span> below to confirm:</p>
                <Input
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  placeholder="Type DELETE to confirm"
                  className="h-9 font-mono text-sm"
                  data-testid="input-delete-confirm"
                  autoComplete="off"
                />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteConfirmText !== "DELETE" || deleting}
              onClick={async (e) => {
                e.preventDefault();
                if (deleteConfirmText !== "DELETE") return;
                setDeleting(true);
                try {
                  const res = await apiRequest("DELETE", "/api/data/all", { confirmation: "DELETE" });
                  const result = await res.json();
                  if (result.error) throw new Error(result.error);
                  toast({ title: "All data deleted", description: "Your data has been permanently removed." });
                  queryClient.clear();
                  setShowDeleteDialog(false);
                  setDeleteConfirmText("");
                  navigate("/dashboard");
                } catch (err: any) {
                  toast({ title: "Delete failed", description: err.message, variant: "destructive" });
                } finally {
                  setDeleting(false);
                }
              }}
            >
              {deleting ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Deleting...</> : "I understand, delete everything"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ChatGPTImportDialog open={chatgptImportOpen} onOpenChange={setChatgptImportOpen} />
    </div>
  );
}
