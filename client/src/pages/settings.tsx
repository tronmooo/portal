import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useTheme } from "@/components/theme-provider";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  Settings, Download, Upload, Sun, Moon, Trash2, Database, Shield, Bell,
} from "lucide-react";

export default function SettingsPage() {
  const { theme, toggle } = useTheme();
  const { user, authRequired } = useAuth();
  const { toast } = useToast();
  const [importing, setImporting] = useState(false);

  // Notification preference
  const { data: notifPref } = useQuery({
    queryKey: ["/api/preferences/notifications_enabled"],
    queryFn: async () => {
      try {
        const res = await apiRequest("GET", "/api/preferences/notifications_enabled");
        const data = await res.json();
        return data.value === "true";
      } catch { return true; }
    },
  });

  const toggleNotifications = useMutation({
    mutationFn: async (enabled: boolean) => {
      await apiRequest("PUT", "/api/preferences/notifications_enabled", { value: String(enabled) });
      if (enabled && "Notification" in window) {
        await Notification.requestPermission();
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/preferences/notifications_enabled"] });
      toast({ title: "Notifications updated" });
    },
  });

  // Export data
  const handleExport = async () => {
    try {
      const res = await apiRequest("GET", "/api/export");
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `lifeos-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Data exported", description: "Your data has been downloaded as JSON." });
    } catch {
      toast({ title: "Export failed", variant: "destructive" });
    }
  };

  // Import data
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await apiRequest("POST", "/api/import", data);
      queryClient.invalidateQueries();
      toast({ title: "Data imported", description: `Imported data from ${file.name}` });
    } catch (err: any) {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    } finally {
      setImporting(false);
      e.target.value = "";
    }
  };

  // Clear all data
  const [confirmClear, setConfirmClear] = useState(false);
  const handleClearData = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    try {
      // Export first as backup
      const res = await apiRequest("GET", "/api/export");
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `lifeos-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Backup downloaded", description: "A backup was saved before clearing." });
      setConfirmClear(false);
    } catch {
      toast({ title: "Backup failed", variant: "destructive" });
      setConfirmClear(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto p-4 md:p-6 space-y-6">
        <div className="flex items-center gap-3">
          <Settings className="h-6 w-6 text-primary" />
          <h1 className="text-xl font-bold">Settings</h1>
        </div>

        {/* Appearance */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              {theme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
              Appearance
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Dark Mode</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Currently using {theme} theme
                </p>
              </div>
              <Switch checked={theme === "dark"} onCheckedChange={toggle} />
            </div>
          </CardContent>
        </Card>

        {/* Notifications */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Bell className="h-4 w-4" />
              Notifications
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Browser Notifications</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Get reminders for tasks, habits, and bills
                </p>
              </div>
              <Switch
                checked={notifPref ?? true}
                onCheckedChange={(v) => toggleNotifications.mutate(v)}
              />
            </div>
          </CardContent>
        </Card>

        {/* Account */}
        {authRequired && user && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Shield className="h-4 w-4" />
                Account
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label className="text-xs text-muted-foreground">Email</Label>
                <p className="text-sm font-medium">{user.email}</p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Data Management */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Database className="h-4 w-4" />
              Data Management
            </CardTitle>
            <CardDescription className="text-xs">
              Export, import, or clear your data
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <Button variant="outline" size="sm" onClick={handleExport} className="flex-1">
                <Download className="h-4 w-4 mr-2" />
                Export Data (JSON)
              </Button>
              <div className="flex-1">
                <Input
                  type="file"
                  accept=".json"
                  onChange={handleImport}
                  disabled={importing}
                  className="hidden"
                  id="import-file"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => document.getElementById("import-file")?.click()}
                  disabled={importing}
                >
                  <Upload className="h-4 w-4 mr-2" />
                  {importing ? "Importing..." : "Import Data"}
                </Button>
              </div>
            </div>

            <div className="pt-3 border-t">
              <Button
                variant={confirmClear ? "destructive" : "outline"}
                size="sm"
                onClick={handleClearData}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                {confirmClear ? "Click again to confirm (backup will download)" : "Clear All Data"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Keyboard Shortcuts */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Keyboard Shortcuts</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-sm">
              {[
                ["Cmd/Ctrl + K", "Search"],
                ["D", "Dashboard"],
                ["C", "Chat"],
                ["T", "Trackers"],
                ["P", "Profiles"],
                ["K", "Tasks"],
                ["E", "Expenses"],
                ["H", "Habits"],
                ["A", "Calendar"],
                ["J", "Journal"],
                ["B", "Bills"],
                ["N", "Notes"],
              ].map(([key, label]) => (
                <div key={key} className="flex items-center justify-between">
                  <span className="text-muted-foreground">{label}</span>
                  <kbd className="inline-flex h-5 items-center rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
                    {key}
                  </kbd>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground pb-6">
          LifeOS v3.0
        </p>
      </div>
    </div>
  );
}
