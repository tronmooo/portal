// client/src/pages/document-review.tsx
//
// The full-screen extraction review — what a freshly uploaded document
// produced, and what the app intends to do with it, before anything is
// written.
//
// This is the same review the chat transcript renders inline
// (components/chat/ExtractionReview), grown into a page: after the user picks
// which profile an upload belongs to and the extractor runs, chat navigates
// here instead of asking them to review 75 rows inside a message bubble.
//
//   ┌ preview ┬ extracted data (table, category chips, per-row routing) ┬ rail ┐
//   │ info    │                                                         │ ⚠ ✓ │
//   │ linked  │                                                         │ ⌘ ⚑ │
//   └─────────┴─────────────────────────────────────────────────────────┴─────┘
//
// The payload arrives through lib/pending-review (stashed by the upload
// success handler) — the extraction only ever lived in chat page state, which
// this page cannot see. Confirm posts the exact same payload shape to the
// exact same route (/api/chat/confirm-extraction) as the inline pane, with the
// same partition rule: a row a selected action is writing never also travels
// as a loose item, so no fact is written twice.

import { useState, useEffect, useMemo, useCallback, lazy, Suspense } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft, FileText, Search, Check, AlertTriangle, Loader2,
  CalendarDays, DollarSign, User, Building2, Landmark, Home, Car, PawPrint,
  CreditCard, TrendingUp, Zap, Link2, ExternalLink,
} from "lucide-react";
import { apiRequest, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { getUserToday } from "@shared/timezone";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { SectionErrorBoundary } from "@/components/ErrorBoundary";
import { applyChatMutations } from "@/lib/chat-sync";
import { useDocumentBlobUrl, classifyDocument, prefetchDocumentBlob } from "@/lib/document-preview";
import { loadPendingReview, clearPendingReview, type PendingExtraction } from "@/lib/pending-review";
import {
  DESTINATION_LABEL, parseMeasurement, matchHealthMetric,
  type ExtractionItem, type ExtractionDestination,
} from "@shared/extraction-destinations";
import { extractionDateRows, type CalendarDateDecision } from "@shared/extraction-calendar";
import type { ProposedAction } from "@shared/extraction-actions";
import type { SemanticEntity } from "@shared/semantic-document";
import { CONFIDENCE_HIGH, CONFIDENCE_MEDIUM } from "@shared/semantic-document";

const PdfCanvas = lazy(() => import("@/components/PdfCanvas"));

// ─── Row categorisation ───────────────────────────────────────────────────────
// The filter chips over the table. A row can belong to several categories —
// an odometer reading is entity data AND evidence for an action — so this
// returns a list, and the chips filter rather than partition.

type RowCategory = "profile" | "dates" | "financial" | "entities" | "actions";

const CATEGORY_LABEL: Record<RowCategory, string> = {
  profile: "Profile Data",
  dates: "Dates",
  financial: "Financial",
  entities: "Entities",
  actions: "Actions",
};

const PROFILE_DESTS: readonly ExtractionDestination[] = [
  "profile", "profile_tracker", "entity_field", "entity_record", "structured_append",
];
const FINANCIAL_DESTS: readonly ExtractionDestination[] = [
  "expense", "income", "obligation", "liability_payment",
];

function categoriesOf(item: ExtractionItem): RowCategory[] {
  const cats: RowCategory[] = [];
  const roles = item.roles ?? [];
  if (roles.includes("profile_data") || roles.includes("entity_data") || PROFILE_DESTS.includes(item.destination)) {
    cats.push("profile");
  }
  if (item.date || roles.includes("actionable_date") || item.destination === "calendar") {
    cats.push("dates");
  }
  if (roles.includes("financial") || FINANCIAL_DESTS.includes(item.destination)) {
    cats.push("financial");
  }
  if (roles.includes("relationship") || item.destination === "relationship_link") {
    cats.push("entities");
  }
  if (item.actionIds && item.actionIds.length > 0) {
    cats.push("actions");
  }
  return cats;
}

function rowIcon(item: ExtractionItem) {
  const cats = categoriesOf(item);
  if (cats.includes("dates")) return CalendarDays;
  if (cats.includes("financial")) return DollarSign;
  if (cats.includes("entities")) return Link2;
  if (cats.includes("profile")) return User;
  if (cats.includes("actions")) return Zap;
  return FileText;
}

const ENTITY_ICON: Record<SemanticEntity["kind"], typeof User> = {
  person: User,
  property: Home,
  vehicle: Car,
  pet: PawPrint,
  asset: Landmark,
  liability: CreditCard,
  account: CreditCard,
  investment: TrendingUp,
  business: Building2,
  organization: Building2,
};

// ─── Confidence display ──────────────────────────────────────────────────────

function confidenceClass(c: number): string {
  if (c >= CONFIDENCE_HIGH) return "text-emerald-600 dark:text-emerald-400";
  if (c >= CONFIDENCE_MEDIUM) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function ConfidenceCell({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground/60">—</span>;
  return (
    <span className={cn("tabular-nums font-medium", confidenceClass(value))}>
      {Math.round(value * 100)}%
    </span>
  );
}

// ─── The screen (route-free, so tests can mount it directly) ─────────────────

export type ReviewConfirmPayload = {
  extractionId: string;
  confirmedFields: Array<{ key: string; value: any }>;
  targetProfileId?: string;
  createCalendarEvents: Array<{ field: string; date: string; title: string; category: string }>;
  items?: ExtractionItem[];
  calendarDates?: CalendarDateDecision[];
  actions?: ProposedAction[];
  trackerEntries: any[];
  createExpense?: any;
  createObligation?: any;
};

export function DocumentReviewScreen({
  documentId,
  extraction,
  onConfirm,
  onDone,
}: {
  documentId: string;
  extraction: PendingExtraction;
  onConfirm: (payload: ReviewConfirmPayload) => Promise<boolean>;
  /** Called when the review is over — confirmed or skipped — to leave the page. */
  onDone: (outcome: "confirmed" | "skipped") => void;
}) {
  const [items, setItems] = useState<ExtractionItem[]>(
    () => (extraction.items || []).map((i) => ({ ...i })),
  );
  const [actions, setActions] = useState<ProposedAction[]>(
    () => (extraction.actionPlan?.actions ?? []).map((a) => ({ ...a })),
  );
  const [selectedProfileId, setSelectedProfileId] = useState<string | undefined>(
    extraction.targetProfile?.id,
  );
  const [autoMap, setAutoMap] = useState(true);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<RowCategory | "all">("all");
  const [confirming, setConfirming] = useState(false);

  const hasItems = items.length > 0;
  const hasPlan = actions.length > 0;
  const understanding = extraction.actionPlan?.understanding;

  const { data: allProfiles = [] } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then((r) => r.json()),
  });

  // Default the linked profile to the self profile when the extraction did not
  // already target someone — same rule as the inline pane.
  useEffect(() => {
    if (selectedProfileId || extraction.targetProfile?.id) return;
    const self = allProfiles.find((p: any) => p.type === "self");
    if (self) setSelectedProfileId(self.id);
  }, [allProfiles, selectedProfileId, extraction.targetProfile?.id]);

  const linkedProfile = useMemo(
    () => allProfiles.find((p: any) => p.id === selectedProfileId)
      ?? (extraction.targetProfile?.id ? { ...extraction.targetProfile } : null),
    [allProfiles, selectedProfileId, extraction.targetProfile],
  );

  // ── Confidence per row ─────────────────────────────────────────────────────
  // A row's confidence is the reasoner's confidence in the FACT it was read
  // into; a row no fact cites falls back to the confidence of the actions that
  // cite it, then to nothing — an invented percentage would be a lie.
  const factConfidence = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of extraction.semantic?.facts ?? []) m.set(f.id, f.confidence);
    return m;
  }, [extraction.semantic]);

  const actionById = useMemo(() => new Map(actions.map((a) => [a.id, a])), [actions]);

  const itemConfidence = useCallback((item: ExtractionItem): number | null => {
    if (item.factId && factConfidence.has(item.factId)) return factConfidence.get(item.factId)!;
    const cited = (item.actionIds ?? [])
      .map((id) => actionById.get(id)?.confidence)
      .filter((c): c is number => typeof c === "number");
    if (cited.length > 0) return Math.min(...cited);
    return null;
  }, [factConfidence, actionById]);

  // Blocking warnings per row — a row whose citing action carries a blocking
  // warning renders as "Review", not "Confirm", until a human decides.
  const rowWarnings = useCallback((item: ExtractionItem) => {
    const out: Array<{ actionId: string; message: string; code: string; blocking: boolean }> = [];
    for (const id of item.actionIds ?? []) {
      const a = actionById.get(id);
      if (!a) continue;
      for (const w of a.warnings) {
        if (!w.field || w.field === item.key) {
          out.push({ actionId: id, message: w.message, code: w.code, blocking: w.blocking });
        }
      }
    }
    return out;
  }, [actionById]);

  // ── Editing ────────────────────────────────────────────────────────────────
  // Value edits re-parse measurements and follow the value into the payloads of
  // the actions that cite the row — same "what you see is what saves" contract
  // as the inline pane (see ExtractionReview/index.tsx for the full history).
  const applyEditToActions = useCallback((itemId: string, value: string, source: ExtractionItem[]) => {
    const row = source.find((i) => i.id === itemId);
    if (!row) return;
    const numeric = Number(String(value).replace(/[$,\s]/g, ""));
    setActions((prev) => prev.map((a) => {
      if (!a.itemIds.includes(itemId)) return a;
      const payload: Record<string, any> = { ...a.payload };
      if (payload.fields && typeof payload.fields === "object" && row.key in payload.fields) {
        payload.fields = { ...payload.fields, [row.key]: value };
      }
      if (payload.key === row.key) payload.value = value;
      if (typeof payload.amount === "number" && isFinite(numeric) && numeric > 0
        && Number(row.value) === payload.amount) {
        payload.amount = numeric;
      }
      if (payload.date && String(row.value) === String(payload.date)) payload.date = value;
      if (payload.nextDueDate && String(row.value) === String(payload.nextDueDate)) payload.nextDueDate = value;
      if (payload.values && typeof payload.values === "object" && "value" in payload.values
        && isFinite(numeric)) {
        payload.values = { ...payload.values, value: numeric };
      }
      return { ...a, payload };
    }));
  }, []);

  const setItemValue = (id: string, value: string) => {
    applyEditToActions(id, value, items);
    setItems((prev) => prev.map((i) => {
      if (i.id !== id) return i;
      if (!i.values) return { ...i, value };
      const reparsed = parseMeasurement(value, matchHealthMetric(i.trackerName ?? i.key));
      return reparsed
        ? { ...i, value, values: reparsed.values, unit: reparsed.unit || i.unit }
        : { ...i, value };
    }));
  };

  const setItemDestination = (id: string, destination: ExtractionDestination) =>
    setItems((prev) => prev.map((i) => (
      i.id === id ? { ...i, destination, selected: destination !== "ignore" } : i
    )));

  /**
   * Per-row Confirm / Skip. The citing actions follow the evidence: an action
   * stays selected while ANY of its rows is confirmed, and confirming a row
   * turns its savable actions on — re-confirming something is an act of
   * wanting it saved.
   */
  const setRowChoice = (id: string, choice: "confirm" | "skip") => {
    const nextItems = items.map((i) => (i.id === id ? { ...i, selected: choice === "confirm" } : i));
    setItems(nextItems);
    setActions((prev) => prev.map((a) => {
      if (!a.itemIds.includes(id)) return a;
      if (!a.savable || a.operation === "NO_ACTION") return a;
      const anyEvidenceSelected = a.itemIds.some(
        (iid) => nextItems.find((i) => i.id === iid)?.selected,
      );
      return { ...a, selected: anyEvidenceSelected };
    }));
  };

  const toggleAction = (id: string) =>
    setActions((prev) => prev.map((a) => (a.id === id ? { ...a, selected: !a.selected } : a)));

  /** Auto-map off = nothing pre-confirmed; back on = restore proposed routing. */
  const handleAutoMap = (on: boolean) => {
    setAutoMap(on);
    if (on) {
      setItems((extraction.items || []).map((i) => ({ ...i })));
      setActions((extraction.actionPlan?.actions ?? []).map((a) => ({ ...a })));
    } else {
      setItems((prev) => prev.map((i) => ({ ...i, selected: false })));
      setActions((prev) => prev.map((a) => ({ ...a, selected: false })));
    }
  };

  // ── Filtering ──────────────────────────────────────────────────────────────
  const counts = useMemo(() => {
    const c: Record<RowCategory, number> = { profile: 0, dates: 0, financial: 0, entities: 0, actions: 0 };
    for (const it of items) for (const cat of categoriesOf(it)) c[cat]++;
    return c;
  }, [items]);

  const visibleItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (category !== "all" && !categoriesOf(it).includes(category)) return false;
      if (!q) return true;
      return [it.label, it.key, String(it.value ?? ""), it.detail ?? ""]
        .some((s) => s.toLowerCase().includes(q));
    });
  }, [items, category, search]);

  const selectedCount = items.filter((i) => i.selected).length;
  const autoConfirmed = items.filter(
    (i) => i.selected && (itemConfidence(i) ?? 0) >= CONFIDENCE_HIGH,
  ).length;

  // ── Validation rail ────────────────────────────────────────────────────────
  const blockedActions = useMemo(
    () => actions.filter((a) => a.warnings.some((w) => w.blocking)),
    [actions],
  );
  const suggestedActions = useMemo(
    () => actions.filter((a) => a.operation !== "NO_ACTION"),
    [actions],
  );
  const entities = extraction.semantic?.entities ?? [];

  // ── Confirm ────────────────────────────────────────────────────────────────
  const todayISO = useMemo(() => getUserToday(BROWSER_TIMEZONE), []);
  const docLabel = extraction.documentName || extraction.label || extraction.fileName;

  const handleConfirm = async () => {
    if (confirming) return;
    const liveItems = items;
    const liveActions = actions;
    setConfirming(true);

    // Legacy shapes only carry the review when there is no item list — same
    // fallback the inline pane keeps for messages rendered from history.
    const fields = extraction.extractedFields ?? [];
    const confirmedFields = hasItems ? [] : fields
      .filter((f) => f.selected && f.key)
      .map((f) => ({ key: f.key === "dob" ? "dateOfBirth" : f.key, value: f.value }));
    const createCalendarEvents = hasItems ? [] : fields
      .filter((f) => f.selected && f.isDate && f.suggestedEvent && f.key && f.value)
      .map((f) => ({
        field: f.key,
        date: String(f.value),
        title: f.suggestedEvent!,
        category: /expir|renew/i.test(f.key || "") ? "finance" : /appoint|visit/i.test(f.key || "") ? "health" : "other",
      }));

    // Every recognised date travels with its default decision — the derived
    // ones come from the record itself, the standalone ones become events.
    const dateRows = extractionDateRows(fields, {
      documentContext: `${extraction.documentType ?? ""} ${extraction.label ?? ""}`,
      today: todayISO,
    });
    const calendarDates: CalendarDateDecision[] = dateRows.map((row) => ({
      field: row.key,
      path: row.path,
      date: row.date || String(row.rawValue),
      ruleType: row.ruleType,
      title: `${row.typeLabel} — ${docLabel}`,
      category: row.ruleType === "appointment" ? "health"
        : (row.ruleType === "due" || row.ruleType === "payment" || row.ruleType === "expiration" || row.ruleType === "renewal") ? "finance"
        : "other",
      addToCalendar: row.defaultAddToCalendar,
      derived: row.derived,
    }));

    // Partition: a row a selected action is writing never also travels as a
    // loose item — the two paths would write the same fact twice.
    const claimedByActions = new Set(
      liveActions
        .filter((a) => a.selected && a.operation !== "NO_ACTION")
        .flatMap((a) => a.itemIds),
    );
    const unclaimedItems = hasPlan
      ? liveItems.filter((i) => !claimedByActions.has(i.id))
      : liveItems;

    const ok = await onConfirm({
      extractionId: extraction.extractionId,
      confirmedFields,
      targetProfileId: selectedProfileId || extraction.targetProfile?.id,
      createCalendarEvents,
      actions: hasPlan ? liveActions : undefined,
      items: hasItems ? unclaimedItems : undefined,
      calendarDates,
      trackerEntries: [],
      createExpense: extraction.pendingFinancial?.expense,
      createObligation: extraction.pendingFinancial?.obligation,
    });
    setConfirming(false);
    if (ok) onDone("confirmed");
  };

  // ── Preview ────────────────────────────────────────────────────────────────
  const previewMime = extraction.documentPreview?.mimeType ?? "application/pdf";
  const inlineData = extraction.documentPreview?.data || undefined;

  const chips: Array<{ id: RowCategory | "all"; label: string; count: number }> = [
    { id: "all", label: "All", count: items.length },
    { id: "profile", label: CATEGORY_LABEL.profile, count: counts.profile },
    { id: "dates", label: CATEGORY_LABEL.dates, count: counts.dates },
    { id: "financial", label: CATEGORY_LABEL.financial, count: counts.financial },
    { id: "entities", label: CATEGORY_LABEL.entities, count: counts.entities },
    { id: "actions", label: CATEGORY_LABEL.actions, count: counts.actions },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden" data-testid="page-document-review">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-background/80 backdrop-blur-sm shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 h-8 px-2 text-xs"
          onClick={() => onDone("skipped")}
          data-testid="btn-back-to-documents"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Documents
        </Button>
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
          <h1 className="text-sm font-semibold truncate" data-testid="heading-review-doc-name">
            {extraction.fileName || docLabel}
          </h1>
        </div>
      </div>

      {/* Three columns on xl; stacked below. */}
      <div className="flex-1 overflow-y-auto xl:overflow-hidden p-4">
        <div className="flex flex-col xl:flex-row gap-4 xl:h-full max-w-[1600px] mx-auto">

          {/* ── Left: preview + info + linked-to ── */}
          <aside className="xl:w-64 shrink-0 space-y-4 xl:overflow-y-auto">
            <SectionErrorBoundary name="review-preview" inline>
              <MiniPreview documentId={documentId} mimeType={previewMime} inlineData={inlineData} fileName={extraction.fileName} />
            </SectionErrorBoundary>

            <div className="bubble p-3 space-y-2" data-testid="review-doc-info">
              <h3 className="micro-label text-muted-foreground">Document Info</h3>
              <InfoRow label="Document Type" value={understanding?.documentType || prettify(extraction.documentType)} />
              <InfoRow label="Category" value={extraction.label} />
              {typeof (understanding?.confidence ?? extraction.semantic?.confidence) === "number" && (
                <div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Confidence Score</span>
                    <ConfidenceCell value={understanding?.confidence ?? extraction.semantic?.confidence ?? null} />
                  </div>
                  <div className="mt-1 h-1 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-emerald-500"
                      style={{ width: `${Math.round(((understanding?.confidence ?? extraction.semantic?.confidence) || 0) * 100)}%` }}
                    />
                  </div>
                </div>
              )}
              {extraction.semanticDegraded && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400 leading-tight">
                  Understanding degraded — routing per field. {extraction.semanticDegraded}
                </p>
              )}
            </div>

            <div className="bubble p-3 space-y-2" data-testid="review-linked-to">
              <h3 className="micro-label text-muted-foreground">Linked To</h3>
              {linkedProfile ? (
                <div className="flex items-center gap-2">
                  <Home className="h-4 w-4 text-primary shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate">{linkedProfile.name}</p>
                    {linkedProfile.type && (
                      <p className="text-[11px] text-muted-foreground capitalize">{String(linkedProfile.type).replace(/_/g, " ")}</p>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Not linked yet</p>
              )}
              <select
                className="w-full text-xs bg-background border border-border rounded-md px-2 py-1.5 text-foreground"
                value={selectedProfileId || ""}
                onChange={(e) => setSelectedProfileId(e.target.value || undefined)}
                data-testid="select-review-profile"
                aria-label="Change linked profile"
              >
                <option value="">Link to profile…</option>
                {allProfiles
                  .slice()
                  .sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""))
                  .map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {p.name}{p.type === "self" ? " (me)" : ` (${p.type})`}
                    </option>
                  ))}
              </select>
            </div>
          </aside>

          {/* ── Center: the extracted data table ── */}
          <section className="flex-1 min-w-0 bubble flex flex-col overflow-hidden xl:h-full">
            <div className="px-4 pt-3 pb-2 border-b border-border/60 space-y-2 shrink-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h2 className="text-sm font-semibold" data-testid="review-extracted-count">
                  Extracted Data <span className="text-muted-foreground font-normal">({items.length} total)</span>
                </h2>
                <div className="ml-auto flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                    Auto-map
                    <Switch
                      checked={autoMap}
                      onCheckedChange={handleAutoMap}
                      aria-label="Auto-map extracted fields"
                      data-testid="switch-auto-map"
                    />
                  </label>
                  <div className="relative">
                    <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search fields…"
                      className="h-7 w-40 pl-7 text-xs"
                      data-testid="input-review-search"
                    />
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap" data-testid="review-category-chips">
                {chips.map((chip) => (
                  <button
                    key={chip.id}
                    type="button"
                    onClick={() => setCategory(chip.id as RowCategory | "all")}
                    className={cn(
                      "text-[11px] px-2 py-0.5 rounded-full border transition-colors",
                      category === chip.id
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground border-border hover:bg-muted",
                    )}
                    data-testid={`chip-${chip.id}`}
                  >
                    {chip.label} <span className="tabular-nums">{chip.count}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-auto">
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 bg-card z-10">
                  <tr className="micro-label text-muted-foreground text-left">
                    <th className="w-8 border-b border-border px-2 py-1.5" />
                    <th className="border-b border-border px-2 py-1.5 font-medium">Extracted Field</th>
                    <th className="border-b border-border px-2 py-1.5 font-medium">Value</th>
                    <th className="border-b border-border px-2 py-1.5 font-medium whitespace-nowrap">Confidence</th>
                    <th className="border-b border-border px-2 py-1.5 font-medium whitespace-nowrap">Suggested Destination</th>
                    <th className="border-b border-border px-2 py-1.5 font-medium w-28">Action</th>
                  </tr>
                </thead>
                <tbody data-testid="review-rows">
                  {visibleItems.map((item) => {
                    const Icon = rowIcon(item);
                    const warnings = rowWarnings(item);
                    const blocking = warnings.some((w) => w.blocking);
                    const citing = (item.actionIds ?? [])
                      .map((id) => actionById.get(id))
                      .filter(Boolean) as ProposedAction[];
                    const targetName = citing[0]?.target?.name
                      ?? linkedProfile?.name;
                    return (
                      <tr
                        key={item.id}
                        className={cn(
                          "border-b border-border/50 last:border-0 align-top",
                          !item.selected && "opacity-55",
                        )}
                        data-testid={`review-row-${item.id}`}
                      >
                        <td className="px-2 py-2 text-center">
                          <Checkbox
                            checked={item.selected}
                            onCheckedChange={(c) => setRowChoice(item.id, c ? "confirm" : "skip")}
                            className="h-3.5 w-3.5 mt-0.5"
                            aria-label={`Include ${item.label}`}
                          />
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <span className="font-medium truncate max-w-[180px]">{item.label}</span>
                          </div>
                        </td>
                        <td className="px-2 py-2 min-w-[140px]">
                          <input
                            type="text"
                            className="w-full bg-transparent text-foreground border-b border-dashed border-border/60 focus:outline-none focus:border-primary focus:bg-primary/5 rounded-t px-0.5 py-0.5"
                            value={
                              typeof item.value === "object" && item.value !== null
                                ? JSON.stringify(item.value)
                                : String(item.value ?? "")
                            }
                            onChange={(e) => setItemValue(item.id, e.target.value)}
                            data-testid={`review-value-${item.id}`}
                          />
                          {warnings.length > 0 && (
                            <div className="mt-0.5 flex items-center gap-1 text-[11px] text-red-600 dark:text-red-400" data-testid={`review-warning-${item.id}`}>
                              <AlertTriangle className="h-3 w-3 shrink-0" />
                              <span className="truncate">{warnings[0].message}</span>
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-2 whitespace-nowrap">
                          <ConfidenceCell value={itemConfidence(item)} />
                        </td>
                        <td className="px-2 py-2">
                          <select
                            className="text-[11px] bg-transparent text-primary font-medium border-0 focus:outline-none focus:ring-1 focus:ring-primary rounded max-w-[190px] cursor-pointer"
                            value={item.destination}
                            onChange={(e) => setItemDestination(item.id, e.target.value as ExtractionDestination)}
                            data-testid={`review-destination-${item.id}`}
                            title="Change where this is saved"
                          >
                            {item.destinationOptions.map((d) => (
                              <option key={d} value={d}>{DESTINATION_LABEL[d]}</option>
                            ))}
                          </select>
                          {targetName && (
                            <div className="text-[11px] text-muted-foreground truncate max-w-[190px]">{targetName}</div>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          {blocking && item.selected === false ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-[11px] gap-1 border-amber-500/50 text-amber-600 dark:text-amber-400"
                              onClick={() => setRowChoice(item.id, "confirm")}
                              data-testid={`review-action-${item.id}`}
                            >
                              <AlertTriangle className="h-3 w-3" /> Review
                            </Button>
                          ) : (
                            <select
                              className={cn(
                                "text-[11px] border rounded-md px-1.5 py-1 cursor-pointer bg-background",
                                item.selected
                                  ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                                  : "border-border text-muted-foreground",
                              )}
                              value={item.selected ? "confirm" : "skip"}
                              onChange={(e) => setRowChoice(item.id, e.target.value as "confirm" | "skip")}
                              data-testid={`review-action-${item.id}`}
                              aria-label={`Action for ${item.label}`}
                            >
                              <option value="confirm">Confirm</option>
                              <option value="skip">Skip</option>
                            </select>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {visibleItems.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                        {items.length === 0
                          ? "This document produced no reviewable fields."
                          : "No fields match the current filter."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Footer */}
            <div className="flex items-center gap-3 px-4 py-2.5 border-t border-border/60 shrink-0 flex-wrap">
              <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400" data-testid="review-selected-summary">
                <Check className="h-3.5 w-3.5" />
                {autoConfirmed > 0
                  ? `${autoConfirmed} field${autoConfirmed === 1 ? "" : "s"} auto-confirmed`
                  : `${selectedCount} of ${items.length} selected`}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => onDone("skipped")}
                  disabled={confirming}
                  data-testid="btn-skip-all"
                >
                  Skip All
                </Button>
                <Button
                  size="sm"
                  className="h-8 text-xs gap-1.5"
                  onClick={() => handleConfirm()}
                  disabled={
                    confirming || (
                      (hasPlan
                        ? !actions.some((a) => a.selected && a.operation !== "NO_ACTION")
                        : selectedCount === 0)
                      && !extraction.pendingFinancial?.expense
                      && !extraction.pendingFinancial?.obligation
                    )
                  }
                  data-testid="btn-confirm-all"
                >
                  {confirming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  Confirm All
                </Button>
              </div>
            </div>
          </section>

          {/* ── Right: validation, actions, entities ── */}
          <aside className="xl:w-80 shrink-0 space-y-4 xl:overflow-y-auto">
            {blockedActions.length > 0 && (
              <div className="bubble p-3 space-y-2 border border-red-500/30" data-testid="review-validation">
                <h3 className="micro-label text-red-600 dark:text-red-400 flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" /> Validation Required
                </h3>
                {blockedActions.map((a) => {
                  const blocking = a.warnings.filter((w) => w.blocking);
                  return (
                    <div key={a.id} className="space-y-1.5" data-testid={`validation-${a.id}`}>
                      {blocking.map((w, i) => (
                        <div key={i} className="text-xs leading-snug">
                          <p className="font-medium">{w.message}</p>
                          {w.existing !== undefined && w.incoming !== undefined && (
                            <p className="text-[11px] text-muted-foreground mt-0.5">
                              Document shows: {String(w.incoming)}
                              <br />
                              Stored now: {String(w.existing)}
                            </p>
                          )}
                        </div>
                      ))}
                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[11px]"
                          onClick={() => {
                            const first = items.find((i) => a.itemIds.includes(i.id));
                            if (first) { setCategory("all"); setSearch(first.label); }
                          }}
                          data-testid={`btn-validation-review-${a.id}`}
                        >
                          Review
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[11px]"
                          disabled={!a.savable}
                          onClick={() => setActions((prev) => prev.map((x) => (x.id === a.id ? { ...x, selected: true } : x)))}
                          data-testid={`btn-validation-accept-${a.id}`}
                        >
                          {a.selected ? "Accepted" : "Link Anyway"}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {suggestedActions.length > 0 && (
              <div className="bubble p-3 space-y-1.5" data-testid="review-suggested-actions">
                <h3 className="micro-label text-muted-foreground">
                  Suggested Actions ({suggestedActions.length})
                </h3>
                {suggestedActions.map((a) => (
                  <label
                    key={a.id}
                    className={cn(
                      "flex items-start gap-2 rounded-md px-2 py-1.5 cursor-pointer transition-colors hover:bg-muted/40",
                      !a.selected && "opacity-55",
                    )}
                    data-testid={`suggested-action-${a.id}`}
                  >
                    <Checkbox
                      checked={a.selected}
                      disabled={!a.savable}
                      onCheckedChange={() => toggleAction(a.id)}
                      className="h-3.5 w-3.5 mt-0.5 shrink-0"
                    />
                    <div className="min-w-0 flex-1 text-xs leading-snug">
                      <p className="font-medium">{a.title}</p>
                      {(a.writesLabel || a.detail) && (
                        <p className="text-[11px] text-muted-foreground truncate">{a.writesLabel || a.detail}</p>
                      )}
                      {!a.savable && a.unsupportedReason && (
                        <p className="text-[11px] text-amber-600 dark:text-amber-400">{a.unsupportedReason}</p>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            )}

            {entities.length > 0 && (
              <div className="bubble p-3 space-y-1.5" data-testid="review-entities">
                <h3 className="micro-label text-muted-foreground">
                  Related Entities ({entities.length})
                </h3>
                {entities.map((e) => {
                  const Icon = ENTITY_ICON[e.kind] ?? Building2;
                  return (
                    <div key={e.ref} className="flex items-center gap-2 px-2 py-1" data-testid={`entity-${e.ref}`}>
                      <Icon className="h-3.5 w-3.5 text-primary shrink-0" />
                      <div className="min-w-0 flex-1 text-xs leading-snug">
                        <p className="font-medium truncate">{e.name}</p>
                        <p className="text-[11px] text-muted-foreground capitalize">
                          {e.role ? e.role.replace(/_/g, " ") : e.kind.replace(/_/g, " ")}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

// ─── Small pieces ────────────────────────────────────────────────────────────

function prettify(s: string | undefined): string {
  return String(s || "document").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-2 text-xs">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="font-medium text-right truncate capitalize">{value}</span>
    </div>
  );
}

function MiniPreview({
  documentId,
  mimeType,
  inlineData,
  fileName,
}: {
  documentId: string;
  mimeType: string;
  inlineData?: string;
  fileName: string;
}) {
  const kind = classifyDocument(mimeType);
  const { url, blob, error } = useDocumentBlobUrl(documentId, mimeType, inlineData);
  const [, navigate] = useLocation();
  return (
    <div className="bubble overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60">
        <span className="shrink-0 rounded bg-red-500/15 text-red-600 dark:text-red-400 text-[11px] font-bold px-1.5 py-0.5">
          {kind === "pdf" ? "PDF" : kind === "image" ? "IMG" : "DOC"}
        </span>
        <p className="text-xs font-medium truncate" data-testid="review-preview-name">{fileName}</p>
      </div>
      <div className="h-56 overflow-hidden bg-muted/30 relative">
        {error || (!url && !blob) ? (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            <FileText className="h-8 w-8" />
          </div>
        ) : kind === "image" && url ? (
          <img src={url} alt={fileName} className="w-full h-full object-contain" draggable={false} />
        ) : kind === "pdf" && blob ? (
          <Suspense fallback={<div className="h-full flex items-center justify-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>}>
            <div className="origin-top scale-[0.9]">
              <PdfCanvas blob={blob} />
            </div>
          </Suspense>
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            <FileText className="h-8 w-8" />
          </div>
        )}
      </div>
      <button
        type="button"
        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs text-primary hover:bg-muted/40 transition-colors"
        onClick={() => navigate(`/documents/${documentId}`)}
        data-testid="btn-open-document"
      >
        <ExternalLink className="h-3 w-3" /> Open document
      </button>
    </div>
  );
}

// ─── The routed page ─────────────────────────────────────────────────────────

export default function DocumentReviewPage() {
  useEffect(() => { document.title = "Review Document — Portol"; }, []);
  const [, params] = useRoute("/documents/:id/review");
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const id = params?.id ?? "";

  // Load once — the stash is a moment in time, and re-reading it after a
  // confirm cleared it would blank the screen mid-navigation.
  const [extraction] = useState(() => (id ? loadPendingReview(id) : null));

  useEffect(() => { if (id) prefetchDocumentBlob(id); }, [id]);

  const handleConfirm = useCallback(async (payload: ReviewConfirmPayload): Promise<boolean> => {
    try {
      const res = await apiRequest("POST", "/api/chat/confirm-extraction", payload);
      const result = await res.json();
      const savedSomething = Array.isArray(result.saved) && result.saved.length > 0;
      if (result.success || savedSomething) {
        void applyChatMutations(result.mutations, result.dataVersion);
        toast(result.success
          ? { title: "Extraction confirmed", description: "Data has been saved." }
          : {
              title: "Saved with warnings",
              description: `Some pieces didn't save: ${Array.isArray(result.failures) ? result.failures.join("; ") : "see logs"}`,
            });
        return true;
      }
      const reason = (result.failures && result.failures.length > 0)
        ? result.failures.join("; ")
        : (result.message || result.error || "The server could not save the data.");
      toast({ title: "Extraction failed", description: reason, variant: "destructive" });
      return false;
    } catch (err) {
      console.error("Confirm extraction failed:", err);
      toast({ title: "Extraction failed", description: "Something went wrong — please try again.", variant: "destructive" });
      return false;
    }
  }, [toast]);

  const handleDone = useCallback((outcome: "confirmed" | "skipped") => {
    if (id) clearPendingReview(id);
    if (outcome === "skipped" && window.history.length > 1) {
      window.history.back();
      return;
    }
    navigate(`/documents/${id}`);
  }, [id, navigate]);

  if (!id || !extraction) {
    // Direct navigation, a reload after confirming, or an expired session
    // stash — nothing is pending, so say so instead of rendering an empty grid.
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center" data-testid="page-document-review-empty">
        <FileText className="h-12 w-12 text-muted-foreground" />
        <p className="text-sm font-medium">Nothing awaiting review</p>
        <p className="text-xs text-muted-foreground max-w-sm">
          This document has no pending extraction to review — it may already be
          confirmed. Upload a document from Chat to start a new review.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => (id ? navigate(`/documents/${id}`) : navigate("/dashboard"))}
          data-testid="btn-review-empty-open-doc"
        >
          {id ? "Open document" : "Back to Dashboard"}
        </Button>
      </div>
    );
  }

  return (
    <DocumentReviewScreen
      documentId={id}
      extraction={extraction}
      onConfirm={handleConfirm}
      onDone={handleDone}
    />
  );
}
