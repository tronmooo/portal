import { useState, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
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
  User,
  Download,
  Upload,
  FileSpreadsheet,
  Moon,
  Sun,
  LogOut,
  Shield,
  Database,
  Palette,
  Info,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Trash2,
  ArrowLeft,
} from "lucide-react";
import { Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { useTheme } from "@/components/theme-provider";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export default function SettingsPage() {
  const { user, signOut } = useAuth();
  const { theme, toggle } = useTheme();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);

  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importingCsv, setImportingCsv] = useState(false);
  const [showSignOutDialog, setShowSignOutDialog] = useState(false);
  const [lastExport, setLastExport] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<string | null>(null);
  const [lastCsvImport, setLastCsvImport] = useState<string | null>(null);

  async function handleExport() {
    setExporting(true);
    try {
      const res = await apiRequest("GET", "/api/export");
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `lifeos-backup-${new Date().toISOString().split("T")[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setLastExport(new Date().toLocaleString());
      const counts = Object.entries(data)
        .filter(([, v]) => Array.isArray(v) && (v as any[]).length > 0)
        .map(([k, v]) => {
          const n = (v as any[]).length;
          const label = n === 1 ? k.replace(/s$/, "") : k;
          return `${n} ${label}`;
        })
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
      const res = await apiRequest("POST", "/api/import", data);
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      setLastImport(new Date().toLocaleString());
      const counts = Object.entries(result.imported || {})
        .filter(([, v]) => (v as number) > 0)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ");
      toast({ title: "Import complete", description: counts || "Data restored successfully." });
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
      toast({
        title: "Bank CSV imported",
        description: `${result.imported} expenses created, ${result.skipped} skipped.`,
      });
    } catch (err: any) {
      toast({ title: "CSV import failed", description: err.message, variant: "destructive" });
    } finally {
      setImportingCsv(false);
      if (csvInputRef.current) csvInputRef.current.value = "";
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto p-4 md:p-6 space-y-6">
        <div>
          <div className="flex items-center gap-3 mb-4">
            <Link href="/">
              <button className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors" data-testid="button-back">
                <ArrowLeft className="w-4 h-4" />
              </button>
            </Link>
            <h1 className="text-xl font-semibold tracking-tight" data-testid="text-settings-title">Settings</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1">Manage your account, appearance, and data.</p>
        </div>

        {/* Account */}
        <Card data-testid="card-account">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Account</CardTitle>
            </div>
            <CardDescription>Your account information and sign out.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Email</Label>
                <p className="text-sm text-muted-foreground mt-0.5" data-testid="text-user-email">
                  {user?.email || "Not signed in"}
                </p>
              </div>
              <Badge variant="secondary" className="text-xs">
                <Shield className="h-3 w-3 mr-1" />
                Authenticated
              </Badge>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Sign Out</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Sign out of your account on this device.</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowSignOutDialog(true)}
                data-testid="button-signout-settings"
              >
                <LogOut className="h-3.5 w-3.5 mr-1.5" />
                Sign Out
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Appearance */}
        <Card data-testid="card-appearance">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Palette className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Appearance</CardTitle>
            </div>
            <CardDescription>Customize how Portol looks.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {theme === "dark" ? (
                  <Moon className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Sun className="h-4 w-4 text-muted-foreground" />
                )}
                <div>
                  <Label className="text-sm font-medium">Dark Mode</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {theme === "dark" ? "Currently using dark theme" : "Currently using light theme"}
                  </p>
                </div>
              </div>
              <Switch
                checked={theme === "dark"}
                onCheckedChange={toggle}
                data-testid="switch-dark-mode"
              />
            </div>
          </CardContent>
        </Card>

        {/* Data Management */}
        <Card data-testid="card-data">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Data Management</CardTitle>
            </div>
            <CardDescription>Export, import, and manage your Portol data.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Export */}
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Export Data</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Download a full JSON backup of all your data.
                </p>
                {lastExport && (
                  <p className="text-xs text-green-600 dark:text-green-400 mt-1 flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> Last export: {lastExport}
                  </p>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleExport}
                disabled={exporting}
                data-testid="button-export"
              >
                {exporting ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1.5" />}
                Export
              </Button>
            </div>

            <Separator />

            {/* Import */}
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Import Data</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Restore from a JSON backup file.
                </p>
                {lastImport && (
                  <p className="text-xs text-green-600 dark:text-green-400 mt-1 flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> Last import: {lastImport}
                  </p>
                )}
              </div>
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  className="hidden"
                  onChange={handleImport}
                  data-testid="input-import-file"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={importing}
                  data-testid="button-import"
                >
                  {importing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Upload className="h-3.5 w-3.5 mr-1.5" />}
                  Import
                </Button>
              </div>
            </div>

            <Separator />

            {/* Bank CSV Import */}
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium flex items-center gap-2">
                  <FileSpreadsheet className="w-4 h-4" />
                  Import Bank CSV
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Upload a bank statement CSV to import transactions into the Finance section
                </p>
                {lastCsvImport && (
                  <p className="text-xs text-green-600 dark:text-green-400 mt-1 flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> Last import: {lastCsvImport}
                  </p>
                )}
              </div>
              <div>
                <input
                  ref={csvInputRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={handleCsvImport}
                  data-testid="input-csv-file"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => csvInputRef.current?.click()}
                  disabled={importingCsv}
                  data-testid="button-csv-import"
                >
                  {importingCsv ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5 mr-1.5" />}
                  Upload CSV
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* About */}
        <Card data-testid="card-about">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Info className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">About</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm text-muted-foreground">
              <div className="flex justify-between">
                <span>Version</span>
                <span className="font-mono text-xs">1.0.0</span>
              </div>
              <div className="flex justify-between">
                <span>Built with</span>
                <span className="text-xs">React + Express + Supabase</span>
              </div>
              <Separator className="my-2" />
              <p className="text-xs">
                Portol — Your personal AI-powered life operating system. Chat to log, track, and manage everything in one place.
              </p>
            </div>
          </CardContent>
        </Card>

        <div className="pb-20" />
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
            <AlertDialogAction
              onClick={signOut}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-signout"
            >
              Sign Out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
