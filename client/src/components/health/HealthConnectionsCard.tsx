// Health Connections — the Settings card that replaces the dead "Apple Health:
// Coming Soon" row.
//
// Three sources, each with an honest state:
//   Apple Health   native-only; the row says so on the web instead of offering
//                  a button that cannot work
//   Health Connect needs an Android app that doesn't exist yet
//   File import    works everywhere, today
//
// Rows follow GoogleCalendarRow in pages/settings.tsx: a status query, a
// medallion icon, a status line, and either an action button or a badge.

import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { HeartPulse, Smartphone, Upload, Activity, Loader2 } from "lucide-react";
import { HealthImportDialog } from "./HealthImportDialog";
import {
  getHealthCapability, requestHealthAuthorization, queryDailyAggregates,
  NATIVE_SYNCABLE_METRICS, type HealthCapability,
} from "@/lib/health-bridge";
import { HEALTH_IMPORT_CHUNK_SIZE, type DailyRow } from "@shared/health-metrics";

interface ProviderState {
  id: string;
  label: string;
  connected?: boolean;
  lastSync?: string | null;
  lastImport?: { rows: number; metrics: string[]; firstDay: string | null; lastDay: string | null } | null;
}

interface MetricState {
  id: string;
  label: string;
  trackerId: string | null;
  entryCount: number;
  lastDay: string | null;
}

interface ConnectionsResponse {
  providers: ProviderState[];
  metrics: MetricState[];
}

const fmtWhen = (iso?: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;

function Row({
  icon, tint, title, status, action, testId,
}: {
  icon: React.ReactNode;
  tint: string;
  title: string;
  status: string;
  action: React.ReactNode;
  testId: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3" data-testid={testId}>
      <div className="flex items-center gap-3 min-w-0">
        <div className={`h-8 w-8 rounded-lg ${tint} flex items-center justify-center shrink-0`}>
          {icon}
        </div>
        <div className="min-w-0">
          <Label className="text-sm font-medium">{title}</Label>
          <p className="text-xs text-muted-foreground mt-0.5">{status}</p>
        </div>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

export function HealthConnectionsCard() {
  const { toast } = useToast();
  const [importOpen, setImportOpen] = useState(false);
  const [capability, setCapability] = useState<HealthCapability | null>(null);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  const { data } = useQuery<ConnectionsResponse>({
    queryKey: ["/api/health/connections"],
    queryFn: () => apiRequest("GET", "/api/health/connections").then((r) => r.json()),
    refetchOnWindowFocus: false,
  });

  // Capability is a device fact, not server state — probe once on mount.
  useEffect(() => {
    let cancelled = false;
    getHealthCapability().then((c) => { if (!cancelled) setCapability(c); });
    return () => { cancelled = true; };
  }, []);

  const providerBy = (id: string) => data?.providers.find((p) => p.id === id);
  const apple = providerBy("apple_health");
  const file = providerBy("file");

  const importedDays = data?.metrics.reduce((n, m) => n + m.entryCount, 0) ?? 0;
  const metricsWithData = data?.metrics.filter((m) => m.entryCount > 0) ?? [];

  // Apple Health sync: read daily aggregates from the native plugin and push
  // them through the same endpoint the file import uses.
  const appleSync = useMutation({
    mutationFn: async () => {
      const granted = await requestHealthAuthorization(NATIVE_SYNCABLE_METRICS);
      if (!granted) throw new Error("permission-denied");
      const to = new Date();
      const from = new Date(to.getTime() - 90 * 86400000);
      // Only the metrics a native plugin can actually read. The rest (sleep,
      // weight, blood pressure …) come through the file import.
      const rows = await queryDailyAggregates(
        NATIVE_SYNCABLE_METRICS,
        from.toISOString().slice(0, 10),
        to.toISOString().slice(0, 10),
      );
      if (rows.length === 0) return { written: 0 };
      const chunks: DailyRow[][] = [];
      for (let i = 0; i < rows.length; i += HEALTH_IMPORT_CHUNK_SIZE) {
        chunks.push(rows.slice(i, i + HEALTH_IMPORT_CHUNK_SIZE));
      }
      let written = 0;
      for (let i = 0; i < chunks.length; i++) {
        const res = await apiRequest("POST", "/api/health/import", {
          provider: "apple_health",
          rows: chunks[i],
          chunk: { index: i, total: chunks.length },
        }).then((r) => r.json());
        written += res.written || 0;
      }
      return { written };
    },
    onSuccess: (res) => {
      toast({
        title: res.written ? "Apple Health synced" : "Nothing new to sync",
        description: res.written
          ? `${res.written.toLocaleString()} days imported.`
          : "No new health data since the last sync.",
      });
      queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey?.[0] || "").startsWith("/api/") });
    },
    onError: (err: any) => {
      const denied = String(err?.message || "").includes("permission-denied");
      toast({
        title: denied ? "Permission needed" : "Sync failed",
        description: denied
          ? "Allow Portol to read Health data in iPhone Settings › Health › Data Access."
          : "Could not read from Apple Health. Please try again.",
        variant: "destructive",
      });
    },
  });

  const disconnectMut = useMutation({
    mutationFn: async ({ provider, purge }: { provider: string; purge: boolean }) =>
      apiRequest("DELETE", `/api/health/connections/${provider}?purge=${purge}`).then((r) => r.json()),
    onSuccess: (res) => {
      toast({
        title: "Disconnected",
        description: res.purged
          ? `${(res.deleted || 0).toLocaleString()} imported entries removed.`
          : "Imported data was kept in your trackers.",
      });
      queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey?.[0] || "").startsWith("/api/") });
    },
    onError: () => toast({ title: "Could not disconnect", description: "Please try again.", variant: "destructive" }),
  });

  // ── Apple Health row ──────────────────────────────────────────────────────
  let appleStatus: string;
  let appleAction: React.ReactNode;

  if (!capability) {
    appleStatus = "Checking this device…";
    appleAction = <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  } else if (!capability.available) {
    appleStatus = capability.message;
    appleAction = (
      <Badge variant="outline" className="text-xs" data-testid="badge-apple-health-unavailable">
        {capability.reason === "web" ? "iPhone only" : "Unavailable"}
      </Badge>
    );
  } else {
    const last = fmtWhen(apple?.lastSync);
    appleStatus = apple?.connected && last ? `Connected — last synced ${last}` : "Ready to connect";
    appleAction = (
      <Button
        size="sm"
        variant="outline"
        disabled={appleSync.isPending}
        onClick={() => appleSync.mutate()}
        data-testid="button-apple-health-sync"
      >
        {appleSync.isPending ? "Syncing…" : apple?.connected ? "Sync now" : "Connect"}
      </Button>
    );
  }

  // ── File import row ───────────────────────────────────────────────────────
  const fileLast = fmtWhen(file?.lastSync);
  const fileStatus = file?.connected && fileLast
    ? `Last imported ${fileLast}${file?.lastImport?.rows ? ` — ${file.lastImport.rows.toLocaleString()} days` : ""}`
    : "export.xml from Apple Health, or a CSV — read on your device";

  return (
    <>
      <Card data-testid="card-health-connections">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <HeartPulse className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Health Connections</CardTitle>
          </div>
          <CardDescription>
            Bring steps, sleep, heart rate and weight into Portol so you don't have to log them by hand.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Row
            testId="row-apple-health"
            icon={<HeartPulse className="h-4 w-4 text-rose-500" />}
            tint="bg-rose-500/10"
            title="Apple Health"
            status={appleStatus}
            action={appleAction}
          />
          <Separator />
          <Row
            testId="row-health-connect"
            icon={<Smartphone className="h-4 w-4 text-emerald-500" />}
            tint="bg-emerald-500/10"
            title="Health Connect"
            status="Needs the Portol Android app, which isn't released yet."
            action={<Badge variant="outline" className="text-xs">Android soon</Badge>}
          />
          <Separator />
          <Row
            testId="row-health-file-import"
            icon={<Upload className="h-4 w-4 text-sky-500" />}
            tint="bg-sky-500/10"
            title="Import a health file"
            status={fileStatus}
            action={
              <Button size="sm" variant="outline" onClick={() => setImportOpen(true)} data-testid="button-open-health-import">
                Import
              </Button>
            }
          />

          {importedDays > 0 && (
            <>
              <Separator />
              <div className="space-y-2">
                <div className="micro-label text-muted-foreground">In your trackers</div>
                <div className="flex flex-wrap gap-1.5" data-testid="list-health-metrics">
                  {metricsWithData.map((m) => (
                    <Badge key={m.id} variant="secondary" className="text-xs font-normal">
                      <Activity className="h-3 w-3 mr-1 opacity-60" />
                      {m.label} · {m.entryCount.toLocaleString()}
                    </Badge>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  {data?.providers
                    .filter((p) => p.connected)
                    .map((p) => (
                      <Button
                        key={p.id}
                        size="sm"
                        variant="ghost"
                        className="text-xs h-7 text-muted-foreground"
                        onClick={() => setDisconnecting(p.id)}
                        data-testid={`button-disconnect-${p.id}`}
                      >
                        Disconnect {p.label}
                      </Button>
                    ))}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <HealthImportDialog open={importOpen} onOpenChange={setImportOpen} />

      <AlertDialog open={!!disconnecting} onOpenChange={(o) => !o && setDisconnecting(null)}>
        <AlertDialogContent data-testid="dialog-health-disconnect">
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect this health source?</AlertDialogTitle>
            <AlertDialogDescription>
              Portol will stop importing from it. The data already imported stays in your trackers
              unless you remove it — it's feeding your Wellness page and health score.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (disconnecting) disconnectMut.mutate({ provider: disconnecting, purge: true });
                setDisconnecting(null);
              }}
              data-testid="button-disconnect-and-remove"
            >
              Disconnect and remove data
            </Button>
            <AlertDialogAction
              onClick={() => {
                if (disconnecting) disconnectMut.mutate({ provider: disconnecting, purge: false });
                setDisconnecting(null);
              }}
              data-testid="button-disconnect-keep-data"
            >
              Disconnect, keep data
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
