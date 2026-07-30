/**
 * SmartFillDialog — universal PDF form filler.
 *
 * 3 steps inside one dialog:
 *   1. Sources  — multi-select profiles/assets/liabilities/documents to draw from.
 *   2. Review   — every detected field with Keep / Edit / Skip, source label, confidence.
 *                 Missing fields shown separately as manual-entry inputs.
 *   3. Done     — filled PDF link + Open in new tab + auto-created Calendar reminders.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, FileText, CheckCircle2, AlertTriangle, Sparkles, Search, ExternalLink, X } from "lucide-react";
import type { Profile, Document as DocumentT } from "@shared/schema";

export interface SmartFillSource {
  id: string;
  kind: "profile" | "asset" | "liability" | "document";
  name: string;
}

interface DetectedField {
  id: string;
  pdfLabel: string;
  suggestedValue: string;
  source: string;
  sourceId: string | null;
  confidence: number;
  fieldKind: "text" | "date" | "expiration" | "renewal" | "due" | "signature" | "checkbox" | "number" | "currency";
  warning?: string;
}

interface MissingField {
  id: string;
  pdfLabel: string;
  fieldKind: DetectedField["fieldKind"];
}

interface AnalyzeResult {
  documentType: string;
  detectedFields: DetectedField[];
  missingFields: MissingField[];
  dates: Array<{ pdfLabel: string; iso: string; kind: "expiration" | "renewal" | "due" | "appointment" }>;
}

interface FillResult {
  documentId: string;
  documentName: string;
  fileBase64: string;
  createdObligations: Array<{ id: string; name: string; nextDueDate: string; kind: string }>;
}

export interface SmartFillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The PDF to fill — base64 (no prefix) + filename + mime */
  file: { name: string; mimeType: string; base64: string } | null;
  /** Pre-selected sources (e.g. when opened from an asset detail page, that asset is pre-checked) */
  preselectedSources?: SmartFillSource[];
}

type Step = "sources" | "analyzing" | "review" | "filling" | "done";

export function SmartFillDialog({ open, onOpenChange, file, preselectedSources = [] }: SmartFillDialogProps) {
  const { toast } = useToast();
  const [step, setStep] = useState<Step>("sources");
  const [search, setSearch] = useState("");
  const [selectedSourceIds, setSelectedSourceIds] = useState<Record<string, SmartFillSource>>({});
  const [analyze, setAnalyze] = useState<AnalyzeResult | null>(null);
  const [fieldStates, setFieldStates] = useState<Record<string, { value: string; included: boolean }>>({});
  const [missingStates, setMissingStates] = useState<Record<string, string>>({});
  const [fillResult, setFillResult] = useState<FillResult | null>(null);

  // Reset on open/close
  useEffect(() => {
    if (open) {
      setStep("sources");
      setAnalyze(null);
      setFieldStates({});
      setMissingStates({});
      setFillResult(null);
      setSearch("");
      // Seed pre-selected
      const seed: Record<string, SmartFillSource> = {};
      for (const s of preselectedSources) seed[`${s.kind}:${s.id}`] = s;
      setSelectedSourceIds(seed);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load all profiles + documents for the picker
  const allSources = useAllSources(open);

  const visibleSources = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allSources;
    return allSources.filter((s) => s.name.toLowerCase().includes(q) || s.kind.includes(q));
  }, [allSources, search]);

  const grouped = useMemo(() => {
    const groups: Record<string, SmartFillSource[]> = { profile: [], asset: [], liability: [], document: [] };
    for (const s of visibleSources) groups[s.kind]?.push(s);
    return groups;
  }, [visibleSources]);

  const selectedCount = Object.keys(selectedSourceIds).length;

  const toggleSource = (s: SmartFillSource) => {
    const key = `${s.kind}:${s.id}`;
    setSelectedSourceIds((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = s;
      return next;
    });
  };

  // ── Step 1 → Step 2 : analyze
  const analyzeMut = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("No file");
      const sources = Object.values(selectedSourceIds);
      const res = await apiRequest("POST", "/api/smart-fill/analyze", {
        fileName: file.name,
        fileData: file.base64,
        mimeType: file.mimeType,
        sources,
      });
      return (await res.json()) as AnalyzeResult;
    },
    onSuccess: (data) => {
      setAnalyze(data);
      // seed field states
      const next: Record<string, { value: string; included: boolean }> = {};
      for (const f of data.detectedFields) {
        next[f.id] = {
          value: f.suggestedValue,
          // signature fields default to skipped; everything else default-included
          included: f.fieldKind !== "signature" && !!f.suggestedValue,
        };
      }
      setFieldStates(next);
      const m: Record<string, string> = {};
      for (const mf of data.missingFields) m[mf.id] = "";
      setMissingStates(m);
      setStep("review");
    },
    onError: (e: any) => {
      toast({ title: "Smart Fill couldn't read this form", description: e?.message || "Try again", variant: "destructive" });
      setStep("sources");
    },
  });

  const runAnalyze = () => {
    if (selectedCount === 0) {
      toast({ title: "Pick at least one source", description: "Smart Fill needs to know whose data to use." });
      return;
    }
    setStep("analyzing");
    analyzeMut.mutate();
  };

  // ── Step 2 → Step 3 : render
  const renderMut = useMutation({
    mutationFn: async () => {
      if (!file || !analyze) throw new Error("No file or analysis");
      // Combine detected fields (kept ones) + answered missing fields.
      const fields: Array<{ pdfLabel: string; value: string; fieldKind: DetectedField["fieldKind"] }> = [];
      for (const f of analyze.detectedFields) {
        const st = fieldStates[f.id];
        if (!st || !st.included) continue;
        fields.push({ pdfLabel: f.pdfLabel, value: st.value, fieldKind: f.fieldKind });
      }
      for (const mf of analyze.missingFields) {
        const v = (missingStates[mf.id] || "").trim();
        if (!v) continue;
        fields.push({ pdfLabel: mf.pdfLabel, value: v, fieldKind: mf.fieldKind });
      }
      const sources = Object.values(selectedSourceIds);
      const linkedProfileIds = sources.filter((s) => s.kind === "profile" || s.kind === "asset" || s.kind === "liability").map((s) => s.id);
      const res = await apiRequest("POST", "/api/smart-fill/render", {
        fileName: file.name,
        fileData: file.base64,
        mimeType: file.mimeType,
        fields,
        documentName: file.name.replace(/\.[^.]+$/, ""),
        linkedProfileIds,
        dates: analyze.dates,
        sources,
      });
      return (await res.json()) as FillResult;
    },
    onSuccess: (data) => {
      setFillResult(data);
      setStep("done");
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      const obCount = data.createdObligations?.length || 0;
      toast({
        title: "PDF filled",
        description: obCount > 0 ? `Saved as document. ${obCount} calendar reminder${obCount > 1 ? "s" : ""} created.` : "Saved as a new document.",
      });
    },
    onError: (e: any) => {
      toast({ title: "Couldn't fill PDF", description: e?.message || "Try again", variant: "destructive" });
      setStep("review");
    },
  });

  const runFill = () => {
    setStep("filling");
    renderMut.mutate();
  };

  const isImageInput = !!file && file.mimeType.startsWith("image/");

  const openFilledPdf = () => {
    if (!fillResult) return;
    try {
      const bin = atob(fillResult.fileBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blobType = isImageInput ? (file?.mimeType || "image/png") : "application/pdf";
      const blob = new Blob([bytes], { type: blobType });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      toast({ title: "Couldn't open file", variant: "destructive" });
    }
  };

  const includedCount = analyze
    ? analyze.detectedFields.reduce((n, f) => n + (fieldStates[f.id]?.included ? 1 : 0), 0)
      + analyze.missingFields.reduce((n, mf) => n + ((missingStates[mf.id] || "").trim() ? 1 : 0), 0)
    : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl p-0 gap-0 overflow-hidden"
        style={{ maxHeight: 720 }}
        data-testid="smart-fill-dialog"
      >
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            Smart Fill
            {file && (
              <span className="text-xs font-normal text-muted-foreground ml-1 truncate">· {file.name}</span>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {step === "sources" && "Pick whose data to draw from. You can choose more than one."}
            {step === "analyzing" && "Reading the form and matching fields to your data…"}
            {step === "review" && "Review every field. Nothing is filled until you approve."}
            {step === "filling" && (isImageInput ? "Saving filled fields…" : "Filling the PDF…")}
            {step === "done" && (isImageInput
              ? "Done. The image is saved with structured filled fields — ready to copy onto the real form."
              : "Done. The original is untouched — a new filled copy was saved.")}
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto" style={{ maxHeight: 540 }}>
          {/* ───────── STEP 1 — SOURCES ───────── */}
          {step === "sources" && (
            <div className="px-5 py-4 space-y-4">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search profiles, assets, liabilities, documents…"
                  className="pl-8 text-sm"
                  data-testid="input-smart-fill-search"
                />
              </div>

              {selectedCount > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {Object.values(selectedSourceIds).map((s) => (
                    <Badge key={`${s.kind}:${s.id}`} variant="secondary" className="gap-1 pl-2 pr-1 py-0.5">
                      <span className="text-[11px] capitalize text-muted-foreground">{s.kind}</span>
                      <span className="text-[11px]">{s.name}</span>
                      <button onClick={() => toggleSource(s)} className="hover:bg-muted rounded p-0.5" aria-label={`Remove ${s.name}`}>
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}

              <SourceGroup title="Profiles" items={grouped.profile} selected={selectedSourceIds} onToggle={toggleSource} />
              <SourceGroup title="Assets" items={grouped.asset} selected={selectedSourceIds} onToggle={toggleSource} />
              <SourceGroup title="Liabilities" items={grouped.liability} selected={selectedSourceIds} onToggle={toggleSource} />
              <SourceGroup title="Documents" items={grouped.document} selected={selectedSourceIds} onToggle={toggleSource} />

              {visibleSources.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-4">No matches.</p>
              )}
            </div>
          )}

          {/* ───────── STEP 1.5 — ANALYZING ───────── */}
          {step === "analyzing" && (
            <div className="px-5 py-12 flex flex-col items-center gap-3">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Reading the PDF…</p>
              <p className="text-xs text-muted-foreground">This usually takes 10–20 seconds.</p>
            </div>
          )}

          {/* ───────── STEP 2 — REVIEW ───────── */}
          {step === "review" && analyze && (
            <div className="px-5 py-4 space-y-4">
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium">{analyze.documentType}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {analyze.detectedFields.length} field{analyze.detectedFields.length !== 1 ? "s" : ""} detected
                    {analyze.missingFields.length > 0 && ` · ${analyze.missingFields.length} missing`}
                    {analyze.dates.length > 0 && ` · ${analyze.dates.length} date${analyze.dates.length > 1 ? "s" : ""} found`}
                  </p>
                </div>
              </div>

              {analyze.detectedFields.length === 0 && analyze.missingFields.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-6">
                  Smart Fill couldn't find any fillable fields in this PDF.
                </p>
              )}

              {/* Detected fields */}
              {analyze.detectedFields.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Detected</p>
                  <div className="rounded-md border border-border divide-y divide-border/60">
                    {analyze.detectedFields.map((f) => {
                      const st = fieldStates[f.id] || { value: "", included: false };
                      const lowConf = f.confidence < 0.7;
                      return (
                        <div key={f.id} className="px-3 py-2 grid grid-cols-12 gap-2 items-start">
                          <div className="col-span-5">
                            <p className="text-xs font-medium truncate" title={f.pdfLabel}>{f.pdfLabel}</p>
                            <div className="flex flex-wrap items-center gap-1 mt-0.5">
                              <Badge variant="outline" className="text-[10px] px-1 py-0 capitalize">{f.fieldKind}</Badge>
                              {f.source && f.source !== "missing" && (
                                <span className="text-[10px] text-muted-foreground truncate" title={f.source}>{f.source}</span>
                              )}
                              {f.fieldKind === "signature" && (
                                <Badge variant="outline" className="text-[10px] px-1 py-0 border-amber-500/50 text-amber-700 dark:text-amber-400">sign manually</Badge>
                              )}
                            </div>
                            {f.warning && (
                              <p className="text-[10px] text-amber-700 dark:text-amber-400 mt-0.5 flex items-start gap-1">
                                <AlertTriangle className="h-2.5 w-2.5 mt-0.5 shrink-0" />
                                <span>{f.warning}</span>
                              </p>
                            )}
                          </div>
                          <div className="col-span-5">
                            <Input
                              type={f.fieldKind === "date" || f.fieldKind === "expiration" || f.fieldKind === "renewal" || f.fieldKind === "due" ? "date" : "text"}
                              value={st.value}
                              onChange={(e) => setFieldStates((p) => ({ ...p, [f.id]: { ...st, value: e.target.value, included: true } }))}
                              disabled={!st.included || f.fieldKind === "signature"}
                              placeholder={f.fieldKind === "signature" ? "—" : "Empty"}
                              className="h-7 text-xs"
                              data-testid={`smart-fill-value-${f.id}`}
                            />
                          </div>
                          <div className="col-span-2 flex items-center justify-end gap-1.5">
                            {!lowConf && f.fieldKind !== "signature" && (
                              <span className="text-[10px] text-muted-foreground tabular-nums">{Math.round(f.confidence * 100)}%</span>
                            )}
                            <input
                              type="checkbox"
                              checked={st.included}
                              onChange={(e) => setFieldStates((p) => ({ ...p, [f.id]: { ...st, included: e.target.checked } }))}
                              className="h-4 w-4 rounded border-border accent-primary"
                              disabled={f.fieldKind === "signature"}
                              data-testid={`smart-fill-include-${f.id}`}
                              aria-label={st.included ? "Include this field" : "Skip this field"}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Missing fields */}
              {analyze.missingFields.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                    <AlertTriangle className="h-3 w-3" /> Missing — type if you want them filled
                  </p>
                  <div className="rounded-md border border-border divide-y divide-border/60">
                    {analyze.missingFields.map((mf) => (
                      <div key={mf.id} className="px-3 py-2 grid grid-cols-12 gap-2 items-center">
                        <Label className="col-span-5 text-xs">{mf.pdfLabel}</Label>
                        <Input
                          type={mf.fieldKind === "date" ? "date" : "text"}
                          value={missingStates[mf.id] || ""}
                          onChange={(e) => setMissingStates((p) => ({ ...p, [mf.id]: e.target.value }))}
                          placeholder="Leave blank to skip"
                          className="col-span-7 h-7 text-xs"
                          data-testid={`smart-fill-missing-${mf.id}`}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Detected dates → calendar */}
              {analyze.dates.length > 0 && (
                <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
                  <p className="text-xs font-medium mb-1">📅 Calendar reminders will be created</p>
                  <ul className="text-[11px] text-muted-foreground space-y-0.5">
                    {analyze.dates.map((d, i) => (
                      <li key={i}>
                        <span className="capitalize">{d.kind}</span> · {d.pdfLabel || "date"} — <span className="tabular-nums">{d.iso}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* ───────── STEP 2.5 — FILLING ───────── */}
          {step === "filling" && (
            <div className="px-5 py-12 flex flex-col items-center gap-3">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Filling…</p>
            </div>
          )}

          {/* ───────── STEP 3 — DONE ───────── */}
          {step === "done" && fillResult && (
            <div className="px-5 py-6 space-y-4">
              <div className="flex flex-col items-center text-center gap-2">
                <div className="rounded-full bg-emerald-500/10 p-3">
                  <CheckCircle2 className="h-8 w-8 text-emerald-600" />
                </div>
                <p className="text-base font-medium">PDF filled</p>
                <p className="text-xs text-muted-foreground">{fillResult.documentName}</p>
                <p className="text-[11px] text-muted-foreground">
                  Original kept untouched · {includedCount} field{includedCount !== 1 ? "s" : ""} filled
                </p>
              </div>
              {fillResult.createdObligations.length > 0 && (
                <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
                  <p className="text-xs font-medium mb-1.5">Reminders added</p>
                  <ul className="text-[11px] text-muted-foreground space-y-0.5">
                    {fillResult.createdObligations.map((ob) => (
                      <li key={ob.id} className="tabular-nums">
                        {ob.name} — {ob.nextDueDate}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex flex-col gap-2">
                <Button onClick={openFilledPdf} className="w-full" data-testid="button-open-filled-pdf">
                  <ExternalLink className="h-4 w-4 mr-2" /> {isImageInput ? "Open filled form" : "Open filled PDF"}
                </Button>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="px-5 py-3 border-t border-border">
          {step === "sources" && (
            <div className="flex items-center justify-between w-full">
              <p className="text-xs text-muted-foreground">{selectedCount} selected</p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button onClick={runAnalyze} disabled={selectedCount === 0} data-testid="button-smart-fill-analyze">
                  <Sparkles className="h-4 w-4 mr-1.5" /> Smart Fill
                </Button>
              </div>
            </div>
          )}
          {step === "review" && (
            <div className="flex items-center justify-between w-full">
              <p className="text-xs text-muted-foreground">{includedCount} field{includedCount !== 1 ? "s" : ""} ready</p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep("sources")}>Back</Button>
                <Button onClick={runFill} disabled={includedCount === 0} data-testid="button-smart-fill-render">
                  Fill PDF
                </Button>
              </div>
            </div>
          )}
          {step === "done" && (
            <div className="flex justify-end w-full">
              <Button onClick={() => onOpenChange(false)} data-testid="button-smart-fill-close">Done</Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function SourceGroup({
  title, items, selected, onToggle,
}: {
  title: string;
  items: SmartFillSource[];
  selected: Record<string, SmartFillSource>;
  onToggle: (s: SmartFillSource) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="micro-label text-muted-foreground">{title}</p>
      <div className="grid grid-cols-2 gap-1.5">
        {items.map((s) => {
          const checked = !!selected[`${s.kind}:${s.id}`];
          return (
            <label
              key={`${s.kind}:${s.id}`}
              className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md border cursor-pointer transition-colors ${
                checked ? "bg-primary/5 border-primary/40" : "border-border hover:bg-muted/50"
              }`}
              data-testid={`smart-fill-source-${s.kind}-${s.id}`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(s)}
                className="h-3.5 w-3.5 rounded accent-primary"
              />
              <span className="text-xs truncate">{s.name}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function useAllSources(active: boolean): SmartFillSource[] {
  const [sources, setSources] = useState<SmartFillSource[]>([]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    (async () => {
      try {
        const [pRes, dRes] = await Promise.all([
          apiRequest("GET", "/api/profiles"),
          apiRequest("GET", "/api/documents"),
        ]);
        const profilesJson = await pRes.json();
        const docsJson = await dRes.json();
        const profiles: Profile[] = Array.isArray(profilesJson) ? profilesJson : (profilesJson?.data ?? []);
        const docs: DocumentT[] = Array.isArray(docsJson) ? docsJson : (docsJson?.data ?? []);
        if (cancelled) return;
        const out: SmartFillSource[] = [];
        for (const p of profiles) {
          const kind: SmartFillSource["kind"] =
            p.type === "asset" || p.type === "vehicle" || p.type === "property" ? "asset"
            : p.type === "liability" || p.type === "loan" ? "liability"
            : "profile";
          out.push({ id: p.id, kind, name: p.name });
        }
        for (const d of docs) {
          // Skip the smart-fill outputs themselves
          if ((d.tags || []).includes("smart-fill")) continue;
          out.push({ id: d.id, kind: "document", name: d.name });
        }
        out.sort((a, b) => a.name.localeCompare(b.name));
        setSources(out);
      } catch {
        if (!cancelled) setSources([]);
      }
    })();
    return () => { cancelled = true; };
  }, [active]);
  return sources;
}
