// Health file import — pick a file, parse it on-device, review, upload.
//
//   1) pick      choose export.xml (Apple Health) or a CSV
//   2) parsing   stream + bucket into daily totals, in the browser
//   3) review    what was found, per metric, before anything is sent
//   4) uploading daily totals only, in chunks
//   5) done
//
// Nothing but daily aggregates ever leaves the device. The raw export — which
// is routinely hundreds of megabytes and contains every heartbeat Apple ever
// recorded — is read locally and discarded.

import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { HeartPulse, Upload, Loader2, Check, AlertTriangle, FileText } from "lucide-react";
import {
  parseHealthFile, UnsupportedHealthFile, type ParsedHealthFile,
} from "@/lib/health-file-parse";
import {
  getHealthMetric, HEALTH_IMPORT_CHUNK_SIZE, type DailyRow,
} from "@shared/health-metrics";

type Step = "pick" | "parsing" | "review" | "uploading" | "done";

interface MetricSummary {
  metricId: string;
  label: string;
  unit: string;
  days: number;
  firstDay: string;
  lastDay: string;
}

function summarizeByMetric(rows: DailyRow[]): MetricSummary[] {
  const byMetric = new Map<string, { days: number; first: string; last: string }>();
  for (const r of rows) {
    const cur = byMetric.get(r.metric);
    if (!cur) byMetric.set(r.metric, { days: 1, first: r.day, last: r.day });
    else {
      cur.days++;
      if (r.day < cur.first) cur.first = r.day;
      if (r.day > cur.last) cur.last = r.day;
    }
  }
  return Array.from(byMetric.entries())
    .map(([metricId, v]) => ({
      metricId,
      label: getHealthMetric(metricId)?.label || metricId,
      unit: getHealthMetric(metricId)?.unit || "",
      days: v.days,
      firstDay: v.first,
      lastDay: v.last,
    }))
    .sort((a, b) => b.days - a.days);
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border/60 p-2.5">
      <div className="micro-label text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold mt-0.5 tabular-nums">{value}</div>
    </div>
  );
}

const fmtDay = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });

export function HealthImportDialog({
  open, onOpenChange,
}: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>("pick");
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<ParsedHealthFile | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [parsePct, setParsePct] = useState(0);
  const [uploadPct, setUploadPct] = useState(0);
  const [result, setResult] = useState<{ written: number; skipped: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStep("pick"); setFileName(""); setParsed(null); setExcluded(new Set());
      setParsePct(0); setUploadPct(0); setResult(null); setError(null);
    }
  }, [open]);

  const summaries = parsed ? summarizeByMetric(parsed.rows) : [];
  const selectedRows = parsed
    ? parsed.rows.filter((r) => !excluded.has(r.metric))
    : [];

  async function handleFile(file: File) {
    setFileName(file.name);
    setError(null);
    setStep("parsing");
    setParsePct(0);
    try {
      const out = await parseHealthFile(file, (read, total) => {
        if (total > 0) setParsePct(Math.min(99, Math.round((read / total) * 100)));
      });
      setParsePct(100);
      if (out.rows.length === 0) {
        setError(
          out.recordsIgnored > 0
            ? "That file parsed, but none of its records are health metrics Portol tracks."
            : "No health records were found in that file.",
        );
        setStep("pick");
        return;
      }
      setParsed(out);
      setStep("review");
    } catch (err: any) {
      if (err instanceof UnsupportedHealthFile) setError(err.message);
      else setError("That file could not be read. Make sure it's an unzipped export.xml or a CSV.");
      setStep("pick");
    }
  }

  const uploadMut = useMutation({
    mutationFn: async () => {
      const rows = selectedRows;
      const chunks: DailyRow[][] = [];
      for (let i = 0; i < rows.length; i += HEALTH_IMPORT_CHUNK_SIZE) {
        chunks.push(rows.slice(i, i + HEALTH_IMPORT_CHUNK_SIZE));
      }
      let written = 0;
      let skipped = 0;
      // Sequential on purpose: each chunk is independently idempotent, so a
      // failure can be retried without duplicating, and the progress bar
      // reflects real completed work rather than requests in flight.
      for (let i = 0; i < chunks.length; i++) {
        const res = await apiRequest("POST", "/api/health/import", {
          provider: "file",
          rows: chunks[i],
          chunk: { index: i, total: chunks.length },
        }).then((r) => r.json());
        written += res.written || 0;
        skipped += res.skipped || 0;
        setUploadPct(Math.round(((i + 1) / chunks.length) * 100));
      }
      return { written, skipped };
    },
    onMutate: () => { setStep("uploading"); setUploadPct(0); },
    onSuccess: (res) => {
      setResult(res);
      setStep("done");
      queryClient.invalidateQueries({
        predicate: (q) => String(q.queryKey?.[0] || "").startsWith("/api/"),
      });
    },
    onError: (err: any) => {
      setStep("review");
      toast({
        title: "Import failed",
        description: String(err?.message || "").includes("401")
          ? "Your session expired. Sign in again and retry."
          : "Could not save the health data. Please try again.",
        variant: "destructive",
      });
    },
  });

  function toggleMetric(metricId: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(metricId)) next.delete(metricId);
      else next.add(metricId);
      return next;
    });
  }

  const totalDays = new Set(selectedRows.map((r) => r.day)).size;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[88vh] overflow-y-auto" data-testid="dialog-health-import">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <HeartPulse className="h-4 w-4 text-rose-500" />
            Import health data
          </DialogTitle>
          <DialogDescription className="text-xs">
            Your file is read on this device. Only daily totals are uploaded — never the raw export.
          </DialogDescription>
        </DialogHeader>

        {step === "pick" && (
          <div className="space-y-3">
            <div className="rounded-lg border border-border/60 p-3 space-y-2">
              <div className="micro-label text-muted-foreground">From an iPhone</div>
              <p className="text-xs text-muted-foreground">
                Health app → your profile photo → <strong>Export All Health Data</strong>. Unzip the
                file it gives you, then choose <code className="text-[11px]">export.xml</code> from inside.
              </p>
            </div>
            <div className="rounded-lg border border-border/60 p-3 space-y-2">
              <div className="micro-label text-muted-foreground">From anywhere else</div>
              <p className="text-xs text-muted-foreground">
                A CSV with a <code className="text-[11px]">date</code> column, plus either
                {" "}<code className="text-[11px]">metric,value</code> columns or one column per metric.
              </p>
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                <p className="text-xs text-destructive" data-testid="text-health-import-error">{error}</p>
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept=".xml,.csv,.zip"
              className="hidden"
              data-testid="input-health-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = "";
              }}
            />
            <DialogFooter className="gap-2">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button size="sm" onClick={() => fileInputRef.current?.click()} data-testid="button-choose-health-file">
                <Upload className="h-3.5 w-3.5 mr-1.5" />
                Choose file
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "parsing" && (
          <div className="space-y-3 py-4">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="truncate">Reading {fileName}…</span>
            </div>
            <Progress value={parsePct} />
            <p className="text-xs text-muted-foreground">
              A multi-year Apple Health export can take a minute. You can leave this open.
            </p>
          </div>
        )}

        {step === "review" && parsed && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Metrics" value={summaries.length - excluded.size} />
              <Stat label="Days" value={totalDays.toLocaleString()} />
              <Stat label="Rows" value={selectedRows.length.toLocaleString()} />
            </div>

            <div className="space-y-1.5">
              <div className="micro-label text-muted-foreground">Found in {fileName}</div>
              {summaries.map((s) => {
                const off = excluded.has(s.metricId);
                return (
                  <button
                    key={s.metricId}
                    type="button"
                    onClick={() => toggleMetric(s.metricId)}
                    data-testid={`toggle-metric-${s.metricId}`}
                    className={`w-full flex items-center justify-between rounded-lg border border-border/60 p-2.5 text-left pressable ${off ? "opacity-45" : ""}`}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{s.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {fmtDay(s.firstDay)} – {fmtDay(s.lastDay)}
                      </div>
                    </div>
                    <Badge variant={off ? "outline" : "secondary"} className="text-xs shrink-0 ml-2">
                      {off ? "Skipped" : `${s.days.toLocaleString()} days`}
                    </Badge>
                  </button>
                );
              })}
              <p className="text-xs text-muted-foreground pt-1">
                Tap a metric to leave it out. Anything you logged by hand is kept — imports only
                replace previous imports for the same day.
              </p>
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" size="sm" onClick={() => setStep("pick")}>Back</Button>
              <Button
                size="sm"
                disabled={selectedRows.length === 0}
                onClick={() => uploadMut.mutate()}
                data-testid="button-commit-health-import"
              >
                Import {selectedRows.length.toLocaleString()} days
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "uploading" && (
          <div className="space-y-3 py-4">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              Importing…
            </div>
            <Progress value={uploadPct} />
          </div>
        )}

        {step === "done" && result && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <Check className="h-4 w-4 text-emerald-500" />
              Imported {result.written.toLocaleString()} days of health data.
            </div>
            {result.skipped > 0 && (
              <p className="text-xs text-muted-foreground">
                {result.skipped.toLocaleString()} readings were outside a plausible range and were left out.
              </p>
            )}
            <div className="flex items-start gap-2 rounded-lg border border-border/60 p-3">
              <FileText className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
              <p className="text-xs text-muted-foreground">
                This data now feeds your Wellness page, health score and anything you ask the
                assistant about your health.
              </p>
            </div>
            <DialogFooter>
              <Button size="sm" onClick={() => onOpenChange(false)} data-testid="button-close-health-import">Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
