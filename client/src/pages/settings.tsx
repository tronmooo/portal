import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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
  Smartphone, Monitor, ChevronRight, Heart, Key, Eye, EyeOff, Clock, ScrollText,
} from "lucide-react";
import { Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/components/theme-provider";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export default function SettingsPage() {
  useEffect(() => { document.title = "Settings — Portol"; }, []);
  const { user, signOut } = useAuth();
  const { theme, toggle } = useTheme();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);

  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importingCsv, setImportingCsv] = useState(false);
  const [showSignOutDialog, setShowSignOutDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [lastExport, setLastExport] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<string | null>(null);
  const [lastCsvImport, setLastCsvImport] = useState<string | null>(null);
  const [clearingCache, setClearingCache] = useState(false);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

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
  const [showAuditLog, setShowAuditLog] = useState(false);
  const { data: auditLog = [], isLoading: auditLoading } = useQuery<any[]>({
    queryKey: ["/api/audit-log"],
    queryFn: () => apiRequest("GET", "/api/audit-log?limit=100").then(r => r.json()),
    enabled: showAuditLog,
  });

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
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
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
        {/* Header */}
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Link href="/dashboard">
              <button className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors" data-testid="button-back" aria-label="Back to Dashboard">
                <ArrowLeft className="w-4 h-4" />
              </button>
            </Link>
            <h1 className="text-xl font-semibold tracking-tight" data-testid="text-settings-title">Settings</h1>
          </div>
        </div>

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
                  <Badge variant="secondary" className="text-[10px]">
                    <Shield className="h-2.5 w-2.5 mr-1" /> Authenticated
                  </Badge>
                  {(user as any)?.app_metadata?.provider && (
                    <Badge variant="outline" className="text-[10px] capitalize">
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
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-lg bg-muted/50 p-2.5 text-center">
                  <p className="text-lg font-bold tabular-nums">{profiles.length}</p>
                  <p className="text-[10px] text-muted-foreground">Profiles</p>
                </div>
                <div className="rounded-lg bg-muted/50 p-2.5 text-center">
                  <p className="text-lg font-bold tabular-nums">{stats?.activeTasks || 0}</p>
                  <p className="text-[10px] text-muted-foreground">Active Tasks</p>
                </div>
                <div className="rounded-lg bg-muted/50 p-2.5 text-center">
                  <p className="text-lg font-bold tabular-nums">{stats?.totalTrackers || 0}</p>
                  <p className="text-[10px] text-muted-foreground">Trackers</p>
                </div>
              </div>
            </div>

            <Separator />

            {/* Change Password */}
            <div className="space-y-2">
              <div>
                <Label className="text-sm font-medium">Change Password</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Update your account password</p>
              </div>
              {showPasswordForm ? (
                <div className="space-y-2 pl-0">
                  <Input
                    type="password"
                    placeholder="New password (min 6 characters)"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    className="h-8 text-sm"
                    data-testid="input-new-password"
                  />
                  <Input
                    type="password"
                    placeholder="Confirm new password"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    className="h-8 text-sm"
                    data-testid="input-confirm-password"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={!newPassword || newPassword.length < 6 || newPassword !== confirmPassword || changingPassword}
                      onClick={async () => {
                        setChangingPassword(true);
                        try {
                          const res = await fetch('/api/auth/change-password', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('portol_session') ? JSON.parse(sessionStorage.getItem('portol_session')!).access_token : ''}` },
                            body: JSON.stringify({ newPassword }),
                          });
                          if (res.ok) {
                            toast({ title: 'Password updated', description: 'Your password has been changed successfully.' });
                            setShowPasswordForm(false);
                            setNewPassword('');
                            setConfirmPassword('');
                          } else {
                            const data = await res.json();
                            toast({ title: 'Failed', description: data.error || 'Could not change password', variant: 'destructive' });
                          }
                        } catch {
                          toast({ title: 'Error', description: 'Failed to change password', variant: 'destructive' });
                        } finally {
                          setChangingPassword(false);
                        }
                      }}
                      data-testid="button-save-password"
                    >
                      {changingPassword ? 'Saving...' : 'Save Password'}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => { setShowPasswordForm(false); setNewPassword(''); setConfirmPassword(''); }}>
                      Cancel
                    </Button>
                  </div>
                  {newPassword && newPassword.length < 6 && (
                    <p className="text-[10px] text-destructive">Password must be at least 6 characters</p>
                  )}
                  {confirmPassword && newPassword !== confirmPassword && (
                    <p className="text-[10px] text-destructive">Passwords don't match</p>
                  )}
                </div>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setShowPasswordForm(true)} data-testid="button-change-password">
                  <Lock className="h-3.5 w-3.5 mr-1.5" /> Change Password
                </Button>
              )}
            </div>

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
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {theme === "dark" ? <Moon className="h-4 w-4 text-muted-foreground" /> : <Sun className="h-4 w-4 text-muted-foreground" />}
                <div>
                  <Label className="text-sm font-medium">Dark Mode</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {theme === "dark" ? "Dark theme active" : "Light theme active"}
                  </p>
                </div>
              </div>
              <Switch checked={theme === "dark"} onCheckedChange={toggle} data-testid="switch-dark-mode" />
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
              <Badge variant="outline" className="text-xs">
                <Zap className="h-3 w-3 mr-1" /> Claude Haiku 4.5
              </Badge>
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
              <div>
                <Label className="text-sm font-medium">Fast-Path Commands</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Instant logging (weight, BP, mood) bypasses AI for speed</p>
              </div>
              <Badge className="text-[10px] bg-green-500/10 text-green-600 border-green-500/20">Enabled</Badge>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Auto-Expense from Documents</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Automatically create expenses when scanning receipts</p>
              </div>
              <Badge className="text-[10px] bg-green-500/10 text-green-600 border-green-500/20">Enabled</Badge>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Smart Data Routing</Label>
                <p className="text-xs text-muted-foreground mt-0.5">AI routes extracted data to correct profile, calendar, and trackers</p>
              </div>
              <Badge className="text-[10px] bg-green-500/10 text-green-600 border-green-500/20">Enabled</Badge>
            </div>
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
              <Badge className="text-[10px] bg-green-500/10 text-green-600 border-green-500/20">
                <Shield className="h-2.5 w-2.5 mr-1" /> Secure
              </Badge>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Data Storage</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Supabase PostgreSQL with Row Level Security</p>
              </div>
              <Badge className="text-[10px] bg-green-500/10 text-green-600 border-green-500/20">
                <HardDrive className="h-2.5 w-2.5 mr-1" /> Encrypted
              </Badge>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Document Storage</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Files stored in Supabase Storage, scoped per user</p>
              </div>
              <Badge className="text-[10px] bg-green-500/10 text-green-600 border-green-500/20">
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
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-8 w-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                  <Calendar className="h-4 w-4 text-blue-500" />
                </div>
                <div>
                  <Label className="text-sm font-medium">Google Calendar</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">Sync events to/from Google Calendar</p>
                </div>
              </div>
              <Badge variant="outline" className="text-[10px]">Available</Badge>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-8 w-8 rounded-lg bg-purple-500/10 flex items-center justify-center">
                  <Heart className="h-4 w-4 text-purple-500" />
                </div>
                <div>
                  <Label className="text-sm font-medium">Apple Health</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">Import health data from iPhone</p>
                </div>
              </div>
              <Badge variant="outline" className="text-[10px]">Coming Soon</Badge>
            </div>
            <Separator />
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
              <Badge variant="outline" className="text-[10px]">Coming Soon</Badge>
            </div>
          </CardContent>
        </Card>

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

        {/* ─── Audit Trail ─── */}
        <Card data-testid="card-audit-trail">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ScrollText className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-base">Activity Log</CardTitle>
              </div>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowAuditLog(v => !v)} data-testid="button-toggle-audit">
                {showAuditLog ? "Hide" : "View Log"}
              </Button>
            </div>
            <CardDescription>A record of all actions taken in your account.</CardDescription>
          </CardHeader>
          {showAuditLog && (
            <CardContent>
              {auditLoading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : auditLog.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">No activity recorded yet.</p>
              ) : (
                <div className="max-h-80 overflow-y-auto space-y-1 pr-1">
                  {auditLog.map((entry: any, i: number) => (
                    <div key={entry.id || i} className="flex items-start gap-2 py-1.5 border-b border-border/40 last:border-0">
                      <div className="w-1.5 h-1.5 rounded-full bg-primary/60 mt-1.5 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs truncate">{entry.entityName || "—"}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <Badge variant="outline" className="text-[9px] capitalize px-1 py-0">{entry.action}</Badge>
                          <Badge variant="secondary" className="text-[9px] capitalize px-1 py-0">{entry.entityType}</Badge>
                          <span className="text-[9px] text-muted-foreground">
                            {new Date(entry.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          )}
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
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive">Delete All Data</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete all your profiles, trackers, expenses, documents, tasks, goals, and every other piece of data in Portol. This action cannot be undone. Export a backup first if you want to keep your data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { toast({ title: "Not implemented yet", description: "Contact support to delete your account data." }); setShowDeleteDialog(false); }}
            >
              I understand, delete everything
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
