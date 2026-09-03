// ChatGPT Finance Import — the full user-facing flow:
//   1) Generate + copy the strict prompt (seeded with current finance state)
//   2) Paste ChatGPT's JSON → server validates against the strict schema
//   3) Review the diff (new / duplicate / updated / skipped / warnings)
//   4) Import atomically (one batch) → everything refreshes together
//   5) History + Undo
//
// Scope: imports are locked to ONE selected profile (the active profile scope).
// The server re-validates and re-plans on commit — the client preview is never
// trusted as authoritative.

import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useProfileScope } from "@/hooks/useProfileScope";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import {
  Sparkles, Copy, Check, ClipboardPaste, AlertTriangle, ArrowRight, Loader2, Undo2, History, ExternalLink,
} from "lucide-react";

type Step = "prompt" | "paste" | "review" | "done";

interface PlannedOp { section: string; action: string; uniqueId: string; label: string; reason?: string; }
interface Summary { created: number; duplicates: number; updated: number; skipped: number; warnings: number; bySection: Record<string, any>; }
interface Signal { kind: string; severity: "info" | "warn" | "alert"; title: string; detail: string; confidence: number; }
interface Plan { ops: PlannedOp[]; warnings: string[]; summary: Summary; signals?: Signal[]; }

export function ChatGPTImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const scope = useProfileScope();
  // Lock the import to a single profile: the active selection when exactly one
  // is chosen, otherwise let the server fall back to the self profile.
  const profileId = scope.selectedIds.length === 1 ? scope.selectedIds[0] : undefined;

  const [step, setStep] = useState<Step>("prompt");
  const [prompt, setPrompt] = useState("");
  const [profileName, setProfileName] = useState("Me");
  const [copied, setCopied] = useState(false);
  const [pasted, setPasted] = useState("");
  const [errors, setErrors] = useState<{ path: string; message: string }[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [committed, setCommitted] = useState<Summary | null>(null);

  // Reset when reopened.
  useEffect(() => {
    if (open) { setStep("prompt"); setErrors([]); setPlan(null); setPasted(""); setCommitted(null); }
  }, [open]);

  const promptMut = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/finance-import/prompt", { profileId })).json(),
    onSuccess: (d: any) => {
      setPrompt(d.prompt); setProfileName(d.profileName || "Me");
      navigator.clipboard?.writeText(d.prompt).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); }).catch(() => {});
    },
    onError: (e: any) => toast({ title: "Couldn't build the prompt", description: e.message, variant: "destructive" }),
  });

  // Auto-generate the prompt when the dialog opens on the prompt step.
  useEffect(() => { if (open && step === "prompt" && !prompt && !promptMut.isPending) promptMut.mutate(); /* eslint-disable-next-line */ }, [open, step]);

  const previewMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/finance-import/preview", { json: pasted, profileId });
      return res.json();
    },
    onSuccess: (d: any) => {
      if (!d.ok) { setErrors(d.errors || [{ path: "", message: "Validation failed." }]); setPlan(null); return; }
      setErrors([]); setPlan(d.plan); setStep("review");
    },
    onError: async (e: any) => {
      // 422 with structured errors comes back as a thrown Error message; show generic.
      setErrors([{ path: "", message: e.message || "Validation failed." }]);
    },
  });

  const commitMut = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/finance-import/commit", { json: pasted, profileId })).json(),
    onSuccess: (d: any) => {
      if (!d.ok) { setErrors(d.errors || []); setStep("paste"); return; }
      setCommitted(d.summary);
      setStep("done");
      // One atomic refresh — every finance/dashboard surface re-reads together.
      queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey?.[0] || "").startsWith("/api/") });
      queryClient.invalidateQueries({ queryKey: ["finance-import-history"] });
      toast({ title: "Import complete", description: `${d.summary.created} added · ${d.summary.duplicates} duplicates skipped` });
    },
    onError: (e: any) => toast({ title: "Import failed", description: e.message, variant: "destructive" }),
  });

  const s = plan?.summary;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[88vh] overflow-y-auto" data-testid="dialog-chatgpt-import">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> Import from ChatGPT
          </DialogTitle>
          <DialogDescription className="text-xs">
            Importing into <span className="font-medium text-foreground">{profileName}</span>. Data stays locked to this profile.
          </DialogDescription>
        </DialogHeader>

        {/* Step 1 — prompt */}
        {step === "prompt" && (
          <div className="space-y-3">
            <ol className="text-xs text-muted-foreground space-y-1 list-decimal pl-4">
              <li>Copy the prompt below (already on your clipboard).</li>
              <li>Paste it into ChatGPT and run it.</li>
              <li>Copy ChatGPT's JSON reply and come back here.</li>
            </ol>
            <Textarea readOnly value={prompt || (promptMut.isPending ? "Generating prompt…" : "")} rows={8} className="text-[11px] font-mono" data-testid="textarea-import-prompt" />
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => { navigator.clipboard?.writeText(prompt); setCopied(true); setTimeout(() => setCopied(false), 2000); }} disabled={!prompt}>
                {copied ? <><Check className="h-3.5 w-3.5 mr-1" /> Copied</> : <><Copy className="h-3.5 w-3.5 mr-1" /> Copy prompt</>}
              </Button>
              <a href="https://chatgpt.com/" target="_blank" rel="noreferrer" className="text-xs text-primary inline-flex items-center gap-1 hover:underline">
                Open ChatGPT <ExternalLink className="h-3 w-3" />
              </a>
              <Button size="sm" className="ml-auto" onClick={() => setStep("paste")} disabled={!prompt} data-testid="btn-import-next-paste">
                Next <ArrowRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 2 — paste */}
        {step === "paste" && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground flex items-center gap-1.5"><ClipboardPaste className="h-3.5 w-3.5" /> Paste ChatGPT's JSON reply:</p>
            <Textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={9} placeholder='{ "transactions": [ … ] }' className="text-[11px] font-mono" data-testid="textarea-import-paste" />
            {errors.length > 0 && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 space-y-1 max-h-40 overflow-y-auto" data-testid="import-errors">
                <p className="text-xs font-medium text-destructive flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5" /> Can't import — fix these:</p>
                {errors.slice(0, 30).map((er, i) => (
                  <p key={i} className="text-[11px] text-destructive/90 font-mono">{er.path ? `${er.path}: ` : ""}{er.message}</p>
                ))}
              </div>
            )}
            <DialogFooter className="gap-2">
              <Button size="sm" variant="outline" onClick={() => setStep("prompt")}>Back</Button>
              <Button size="sm" onClick={() => previewMut.mutate()} disabled={!pasted.trim() || previewMut.isPending} data-testid="btn-import-validate">
                {previewMut.isPending ? <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Checking…</> : <>Validate & preview</>}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Step 3 — review */}
        {step === "review" && s && (
          <div className="space-y-3" data-testid="import-review">
            <div className="grid grid-cols-4 gap-2 text-center">
              <Stat label="New" value={s.created} tone="good" />
              <Stat label="Updated" value={s.updated} tone="info" />
              <Stat label="Duplicates" value={s.duplicates} tone="muted" />
              <Stat label="Skipped" value={s.skipped} tone="muted" />
            </div>
            {plan!.warnings.length > 0 && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 space-y-1">
                {plan!.warnings.map((w, i) => (
                  <p key={i} className="text-[11px] text-amber-700 dark:text-amber-400 flex items-start gap-1.5"><AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" /> {w}</p>
                ))}
              </div>
            )}
            {plan!.signals && plan!.signals.length > 0 && (
              <div className="space-y-1.5" data-testid="import-signals">
                <p className="micro-label text-muted-foreground flex items-center gap-1.5">
                  <Sparkles className="h-3 w-3 text-primary" /> Smart detection
                </p>
                <div className="space-y-1">
                  {plan!.signals.map((sig, i) => (
                    <div key={i} className="flex items-start gap-2 rounded-md border px-2.5 py-1.5">
                      <SignalDot severity={sig.severity} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-medium">{sig.title}</p>
                        <p className="text-[11px] text-muted-foreground">{sig.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="max-h-56 overflow-y-auto rounded-md border divide-y divide-border/60">
              {plan!.ops.map((op, i) => (
                <div key={i} className="flex items-center gap-2 px-2.5 py-1.5">
                  <ActionBadge action={op.action} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] truncate">{op.label}</p>
                    {op.reason && <p className="text-[11px] text-muted-foreground truncate">{op.reason}</p>}
                  </div>
                  <span className="text-[11px] text-muted-foreground/60 shrink-0">{op.section}</span>
                </div>
              ))}
            </div>
            <DialogFooter className="gap-2">
              <Button size="sm" variant="outline" onClick={() => setStep("paste")}>Back</Button>
              <Button size="sm" onClick={() => commitMut.mutate()} disabled={commitMut.isPending || s.created + s.updated === 0} data-testid="btn-import-commit">
                {commitMut.isPending ? <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Importing…</> : <>Import {s.created + s.updated} {s.created + s.updated === 1 ? "item" : "items"}</>}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Step 4 — done */}
        {step === "done" && committed && (
          <div className="space-y-3 text-center py-2">
            <div className="mx-auto h-10 w-10 rounded-full bg-green-500/10 flex items-center justify-center"><Check className="h-5 w-5 text-green-600" /></div>
            <p className="text-sm font-medium">Imported into {profileName}</p>
            <p className="text-xs text-muted-foreground">{committed.created} added · {committed.updated} updated · {committed.duplicates} duplicates skipped</p>
            <p className="text-[11px] text-muted-foreground">Net worth, cash flow, budgets and the dashboard have all been refreshed.</p>
            <Button size="sm" className="w-full" onClick={() => onOpenChange(false)}>Done</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "good" | "info" | "muted" }) {
  const color = tone === "good" ? "text-green-600" : tone === "info" ? "text-blue-600" : "text-muted-foreground";
  return (
    <div className="rounded-md border py-2">
      <p className={`text-base font-semibold tabular-nums ${color}`}>{value}</p>
      <p className="micro-label text-muted-foreground">{label}</p>
    </div>
  );
}

function SignalDot({ severity }: { severity: "info" | "warn" | "alert" }) {
  const color = severity === "alert" ? "bg-red-500" : severity === "warn" ? "bg-amber-500" : "bg-blue-500";
  return <span className={`mt-1 h-1.5 w-1.5 rounded-full shrink-0 ${color}`} aria-hidden />;
}

function ActionBadge({ action }: { action: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    create: { label: "New", cls: "bg-green-500/10 text-green-600 border-green-500/30" },
    update: { label: "Update", cls: "bg-blue-500/10 text-blue-600 border-blue-500/30" },
    duplicate: { label: "Dup", cls: "bg-muted text-muted-foreground" },
    skip: { label: "Skip", cls: "bg-muted text-muted-foreground" },
  };
  const m = map[action] || map.skip;
  return <Badge variant="outline" className={`text-[11px] px-1.5 py-0 shrink-0 ${m.cls}`}>{m.label}</Badge>;
}

/** Import history + undo — embeddable in Settings. */
export function ChatGPTImportHistory() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ items: any[] }>({
    queryKey: ["finance-import-history"],
    queryFn: async () => (await apiRequest("GET", "/api/finance-import/history")).json(),
  });
  const undoMut = useMutation({
    mutationFn: async (id: string) => (await apiRequest("POST", `/api/finance-import/${id}/undo`)).json(),
    onSuccess: (d: any) => {
      toast({ title: "Import undone", description: `${d.removed} record${d.removed === 1 ? "" : "s"} removed${d.restored ? `, ${d.restored} budget${d.restored === 1 ? "" : "s"} restored` : ""}` });
      queryClient.invalidateQueries({ queryKey: ["finance-import-history"] });
      queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey?.[0] || "").startsWith("/api/") });
    },
    onError: (e: any) => toast({ title: "Undo failed", description: e.message, variant: "destructive" }),
  });
  const items = data?.items || [];
  if (isLoading) return <p className="text-xs text-muted-foreground">Loading history…</p>;
  if (items.length === 0) return <p className="text-xs text-muted-foreground">No imports yet.</p>;
  return (
    <div className="space-y-2" data-testid="import-history">
      {items.map((it) => (
        <div key={it.id} className="flex items-center gap-2 rounded-md border px-2.5 py-2">
          <History className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] truncate">
              {new Date(it.createdAt).toLocaleString()} · {it.summary?.created ?? 0} added{it.summary?.updated ? `, ${it.summary.updated} updated` : ""}
            </p>
            {Array.isArray(it.summary?.signals) && it.summary.signals.length > 0 && (
              <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Sparkles className="h-2.5 w-2.5 text-primary" /> {it.summary.signals.length} insight{it.summary.signals.length === 1 ? "" : "s"}</p>
            )}
            {it.status === "undone" && <p className="text-[11px] text-muted-foreground">Undone</p>}
          </div>
          <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" disabled={it.status === "undone" || undoMut.isPending} onClick={() => undoMut.mutate(it.id)}>
            <Undo2 className="h-3 w-3" /> Undo
          </Button>
        </div>
      ))}
    </div>
  );
}
