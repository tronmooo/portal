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
//
// Visual language: every surface is the shared .bubble (tinted through
// --accent-hsl), icons sit in Medallions, and colour follows the category —
// blue profile data · amber dates · green money · purple entities · orange
// actions · red validation — the same accent-HSL system the dashboard speaks.

import { Fragment, useState, useEffect, useMemo, useCallback, lazy, Suspense } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft, FileText, Search, Check, AlertTriangle, Loader2, ChevronDown,
  CalendarDays, DollarSign, User, Building2, Landmark, Home, Car, PawPrint,
  CreditCard, TrendingUp, Zap, Link2, Maximize2, Minus, Plus, RefreshCw,
  ShieldCheck, StickyNote,
} from "lucide-react";
import { apiRequest, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { getUserToday } from "@shared/timezone";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Medallion } from "@/components/ui/kit-index";
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
import { groupItemsIntoSections } from "@shared/extraction-sections";
import { itemsClaimedByActions, OPERATION_LABEL, type ProposedAction } from "@shared/extraction-actions";
import type { SemanticEntity } from "@shared/semantic-document";
import { CONFIDENCE_HIGH, CONFIDENCE_MEDIUM } from "@shared/semantic-document";

const PdfCanvas = lazy(() => import("@/components/PdfCanvas"));

// ─── Accent vocabulary ───────────────────────────────────────────────────────
// Raw HSL triples, same encoding the dashboard's Pill/Medallion system uses,
// so this page's colour choices can never drift from the app's.

const ACCENT = {
  blue: "215 70% 58%",
  teal: "183 60% 42%",
  green: "155 60% 45%",
  amber: "43 96% 53%",
  orange: "25 95% 58%",
  red: "0 72% 58%",
  purple: "280 75% 62%",
} as const;

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

const CATEGORY_ACCENT: Record<RowCategory, string> = {
  profile: ACCENT.blue,
  dates: ACCENT.amber,
  financial: ACCENT.green,
  entities: ACCENT.purple,
  actions: ACCENT.orange,
};

const PROFILE_DESTS: readonly ExtractionDestination[] = [
  "profile", "profile_tracker", "entity_field", "entity_record", "structured_append",
];
const FINANCIAL_DESTS: readonly ExtractionDestination[] = [
  "expense", "income", "obligation", "liability_payment",
];

// Role annotations only exist on rows the reasoner read into facts, so the
// chips also recognise a date or a money amount by its shape — a filter that
// says "Dates 0" over a table showing three of them reads as broken.
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}/;
const DATE_KEY = /(date|expir|renew|due|birth|effective)/i;
const MONEY_KEY = /(premium|amount|total|price|cost|\bfees?\b|balance|payment|deductible|coverage|limit)/i;
const MONEY_VALUE = /^\$?\s?-?[\d,]+(\.\d+)?$/;

function categoriesOf(item: ExtractionItem): RowCategory[] {
  const cats: RowCategory[] = [];
  const roles = item.roles ?? [];
  const value = String(item.value ?? "");
  const keyAndLabel = `${item.key} ${item.label}`;
  const isDate = Boolean(item.date) || roles.includes("actionable_date")
    || item.destination === "calendar"
    || DATE_VALUE.test(value) || DATE_KEY.test(keyAndLabel);
  const isMoney = !isDate && (roles.includes("financial")
    || FINANCIAL_DESTS.includes(item.destination)
    || (MONEY_KEY.test(keyAndLabel) && MONEY_VALUE.test(value.trim())));
  if (roles.includes("profile_data") || roles.includes("entity_data") || PROFILE_DESTS.includes(item.destination)) {
    cats.push("profile");
  }
  if (isDate) cats.push("dates");
  if (isMoney) cats.push("financial");
  if (roles.includes("relationship") || item.destination === "relationship_link") {
    cats.push("entities");
  }
  if (item.actionIds && item.actionIds.length > 0) {
    cats.push("actions");
  }
  return cats;
}

/** The one category a row is COLOURED by — its most specific membership. */
function primaryCategory(item: ExtractionItem): RowCategory | null {
  const cats = categoriesOf(item);
  for (const c of ["dates", "financial", "entities", "profile", "actions"] as const) {
    if (cats.includes(c)) return c;
  }
  return null;
}

function rowIcon(item: ExtractionItem) {
  const primary = primaryCategory(item);
  if (primary === "dates") return CalendarDays;
  if (primary === "financial") return DollarSign;
  if (primary === "entities") return Link2;
  if (primary === "profile") return item.key.toLowerCase().includes("address") ? Home : FileText;
  if (primary === "actions") return Zap;
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

const ENTITY_ACCENT: Record<SemanticEntity["kind"], string> = {
  person: ACCENT.blue,
  property: ACCENT.green,
  vehicle: ACCENT.orange,
  pet: ACCENT.amber,
  asset: ACCENT.teal,
  liability: ACCENT.red,
  account: ACCENT.purple,
  investment: ACCENT.green,
  business: ACCENT.teal,
  organization: ACCENT.teal,
};

/** Icon + accent for a proposed action's medallion, keyed by what it writes. */
function actionVisual(a: ProposedAction): { icon: typeof Zap; accent: string } {
  switch (a.destination) {
    case "calendar": return { icon: CalendarDays, accent: ACCENT.blue };
    case "expense":
    case "income":
    case "obligation":
    case "liability_payment": return { icon: DollarSign, accent: ACCENT.green };
    case "tracker":
    case "profile_tracker": return { icon: TrendingUp, accent: ACCENT.green };
    case "entity_record": return { icon: ShieldCheck, accent: ACCENT.teal };
    case "entity_field": return { icon: RefreshCw, accent: ACCENT.teal };
    case "relationship_link": return { icon: Link2, accent: ACCENT.purple };
    case "note": return { icon: StickyNote, accent: ACCENT.amber };
    case "task": return { icon: Check, accent: ACCENT.blue };
    default: return { icon: Zap, accent: ACCENT.orange };
  }
}

// ─── Confidence display ──────────────────────────────────────────────────────

function confidenceHsl(c: number): string {
  if (c >= CONFIDENCE_HIGH) return ACCENT.green;
  if (c >= CONFIDENCE_MEDIUM) return ACCENT.amber;
  return ACCENT.red;
}

function ConfidenceCell({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground/60">—</span>;
  return (
    <span className="tabular-nums font-semibold" style={{ color: `hsl(${confidenceHsl(value)})` }}>
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
  const [items, setItems] = useState<ExtractionItem[]>(() => initialReviewItems(extraction));
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
  const { toast } = useToast();

  const hasItems = items.length > 0;
  const hasPlan = actions.length > 0;
  const understanding = extraction.actionPlan?.understanding;

  const { data: allProfiles = [] } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then((r) => r.json()),
  });

  // Extracted-at timestamp and document type live on the stored document.
  const { data: docMetaRaw } = useQuery<any>({
    queryKey: ["/api/documents", documentId],
    queryFn: () => apiRequest("GET", `/api/documents/${documentId}`).then((r) => r.json()),
    enabled: !!documentId,
    staleTime: 60_000,
  });
  const docMeta = docMetaRaw && !Array.isArray(docMetaRaw) ? docMetaRaw : undefined;

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
    // No fact and no action cites this row — the honest floor is the
    // reasoner's confidence in the document as a whole, not a blank cell.
    const doc = extraction.actionPlan?.understanding?.confidence ?? extraction.semantic?.confidence;
    return typeof doc === "number" && doc > 0 ? doc : null;
  }, [factConfidence, actionById, extraction.actionPlan, extraction.semantic]);

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

  /* There is no selection floor. The middle table is "facts to save" and the
   * rail is "things to do because of them" — two independent panels, so
   * emptying one of them is a legitimate state. Confirm All stays disabled only
   * when BOTH are empty, and Skip All is still the explicit way out. */

  /**
   * Per-row Confirm / Skip. The citing actions follow the evidence: an action
   * stays selected while ANY of its rows is confirmed, and confirming a row
   * turns its savable actions on — re-confirming something is an act of
   * wanting it saved.
   */
  const setRowChoice = (id: string, choice: "confirm" | "skip") => {
    const nextItems = items.map((i) => (i.id === id ? { ...i, selected: choice === "confirm" } : i));
    const nextActions = actions.map((a) => {
      if (!a.itemIds.includes(id)) return a;
      if (!a.savable || a.operation === "NO_ACTION") return a;
      const anyEvidenceSelected = a.itemIds.some(
        (iid) => nextItems.find((i) => i.id === iid)?.selected,
      );
      return { ...a, selected: anyEvidenceSelected };
    });
    setItems(nextItems);
    setActions(nextActions);
  };

  const toggleAction = (id: string) => {
    setActions((prev) => prev.map((a) => (a.id === id ? { ...a, selected: !a.selected } : a)));
  };

  /** Auto-map off = hand-pick mode; back on = restore the proposed routing.
   *  Off clears the table so nothing is saved by accident, and leaves the rail
   *  alone: the suggested actions are a separate decision from the fields. */
  const handleAutoMap = (on: boolean) => {
    setAutoMap(on);
    if (on) {
      setItems(initialReviewItems(extraction));
      setActions((extraction.actionPlan?.actions ?? []).map((a) => ({ ...a })));
    } else {
      setItems((prev) => prev.map((i) => ({ ...i, selected: false })));
    }
  };

  // ── Filtering ──────────────────────────────────────────────────────────────
  // A row is also an "entity" row when a relationship-link action cites it —
  // the row itself carries no relationship role, but the Mortgagee line IS how
  // the lender got into the plan, and the chip should find it.
  const relationshipItemIds = useMemo(
    () => new Set(actions.filter((a) => a.destination === "relationship_link").flatMap((a) => a.itemIds)),
    [actions],
  );
  const entityNames = useMemo(
    () => (extraction.semantic?.entities ?? [])
      .map((e) => e.name.toLowerCase())
      .filter((n) => n.length >= 4),
    [extraction.semantic],
  );
  const catsFor = useCallback((it: ExtractionItem): RowCategory[] => {
    const cats = categoriesOf(it);
    if (!cats.includes("entities")) {
      const value = String(it.value ?? "").toLowerCase();
      if (relationshipItemIds.has(it.id)
        || (value.length >= 4 && entityNames.some((n) => value.includes(n) || n.includes(value)))) {
        cats.push("entities");
      }
    }
    return cats;
  }, [relationshipItemIds, entityNames]);

  const counts = useMemo(() => {
    const c: Record<RowCategory, number> = { profile: 0, dates: 0, financial: 0, entities: 0, actions: 0 };
    for (const it of items) for (const cat of catsFor(it)) c[cat]++;
    return c;
  }, [items, catsFor]);

  const visibleItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (category !== "all" && !catsFor(it).includes(category)) return false;
      if (!q) return true;
      return [it.label, it.key, String(it.value ?? ""), it.detail ?? ""]
        .some((s) => s.toLowerCase().includes(q));
    });
  }, [items, category, search, catsFor]);

  // Document-driven sections: the same rows, grouped by what the pipeline
  // understood them to BE — Policy Details, Dates & Deadlines, Measurements,
  // Contact Information — instead of one flat 75-row list. The vocabulary is
  // derived from groups, roles and subjects, never from a document-type table
  // (shared/extraction-sections).
  const visibleSections = useMemo(
    () => groupItemsIntoSections(visibleItems, extraction.semantic ?? null),
    [visibleItems, extraction.semantic],
  );

  const selectedCount = items.filter((i) => i.selected).length;
  const selectedActionCount = actions.filter(
    (a) => a.selected && a.operation !== "NO_ACTION",
  ).length;
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
  // Dates the engine deliberately does NOT schedule — a report date, a printed-on
  // date. They used to be filtered out of the rail entirely, so the middle table
  // could list three rows under "Dates & Deadlines" beside an empty rail with no
  // explanation. They are listed, named, and plainly marked as doing nothing.
  const keptDates = useMemo(
    () => actions.filter(
      (a) => a.operation === "NO_ACTION" && a.destination === "reference" && Boolean(a.payload?.date),
    ),
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

    // Partition: a row is withheld from the data path ONLY when a selected
    // action already performs that exact write (shared/extraction-actions).
    // A tracker, expense or obligation action is a CONSEQUENCE of a fact, not
    // its storage — ticking one used to delete the fact from its profile.
    const claimedByActions = itemsClaimedByActions(liveActions, liveItems);
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
  // Extract-only upload: the file was read and dropped, so there is nothing to
  // fetch for a preview. Say that plainly instead of showing an empty frame.
  const imageDiscarded = extraction.documentPreview?.imageDiscarded === true;
  const confidenceScore = understanding?.confidence ?? extraction.semantic?.confidence;

  const chips: Array<{ id: RowCategory | "all"; label: string; count: number; accent: string }> = [
    { id: "all", label: "All", count: items.length, accent: ACCENT.blue },
    ...(["profile", "dates", "financial", "entities", "actions"] as const).map((c) => ({
      id: c, label: CATEGORY_LABEL[c], count: counts[c], accent: CATEGORY_ACCENT[c],
    })),
  ];

  const extractedAt = docMeta?.createdAt
    ? `${new Date(docMeta.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} at ${new Date(docMeta.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
    : "Just now";

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

          {/* ── Left: preview + info + linked-to + summary ── */}
          <aside className="xl:w-64 shrink-0 space-y-4 xl:overflow-y-auto">
            <SectionErrorBoundary name="review-preview" inline>
              <MiniPreview
                documentId={documentId}
                mimeType={previewMime}
                inlineData={inlineData}
                fileName={extraction.fileName}
                imageDiscarded={imageDiscarded}
              />
            </SectionErrorBoundary>

            <div className="bubble p-3.5 space-y-2.5" data-testid="review-doc-info">
              <h3 className="micro-label text-muted-foreground">Document Info</h3>
              <InfoRow label="Document Type" value={understanding?.documentType || prettify(extraction.documentType)} />
              <InfoRow label="Category" value={extraction.label} />
              <InfoRow label="Extracted" value={extractedAt} />
              {typeof confidenceScore === "number" && confidenceScore > 0 && (
                <div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Confidence Score</span>
                    <ConfidenceCell value={confidenceScore} />
                  </div>
                  <div className="mt-1.5 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.round(confidenceScore * 100)}%`,
                        background: `hsl(${confidenceHsl(confidenceScore)})`,
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="bubble p-3.5 space-y-2.5" data-testid="review-linked-to">
              <h3 className="micro-label text-muted-foreground">Linked To</h3>
              {linkedProfile ? (
                <div className="flex items-center gap-2.5">
                  <Medallion icon={Home} accent={ACCENT.green} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold truncate">{linkedProfile.name}</p>
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

            <div className="bubble p-3.5 space-y-1.5" data-testid="review-extraction-summary">
              <h3 className="micro-label text-muted-foreground">Extraction Summary</h3>
              <SummaryRow accent={ACCENT.teal} label="Data Fields" count={items.length} />
              {(["profile", "dates", "financial", "entities", "actions"] as const).map((c) =>
                counts[c] > 0 ? (
                  <SummaryRow key={c} accent={CATEGORY_ACCENT[c]} label={CATEGORY_LABEL[c]} count={counts[c]} />
                ) : null,
              )}
            </div>
          </aside>

          {/* ── Center: the extracted data table ── */}
          <section className="flex-1 min-w-0 bubble flex flex-col overflow-hidden xl:h-full">
            <div className="px-4 pt-3.5 pb-2.5 border-b border-border/60 space-y-2.5 shrink-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h2 className="micro-label text-foreground" data-testid="review-extracted-count">
                  Extracted Data <span className="text-muted-foreground normal-case tracking-normal">({items.length} total)</span>
                </h2>
                <div className="ml-auto flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground cursor-pointer whitespace-nowrap">
                    Auto-map: <span style={{ color: autoMap ? `hsl(${ACCENT.green})` : undefined }}>{autoMap ? "ON" : "OFF"}</span>
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
                {chips.map((chip) => {
                  const active = category === chip.id;
                  return (
                    <button
                      key={chip.id}
                      type="button"
                      onClick={() => setCategory(chip.id as RowCategory | "all")}
                      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors"
                      style={active
                        ? { background: `hsl(${chip.accent})`, color: "white", border: `1px solid hsl(${chip.accent})` }
                        : { background: `hsl(${chip.accent} / 0.12)`, color: `hsl(${chip.accent})`, border: `1px solid hsl(${chip.accent} / 0.28)` }}
                      data-testid={`chip-${chip.id}`}
                    >
                      {chip.label}
                      <span
                        className="tabular-nums rounded-full px-1.5 leading-4"
                        style={active
                          ? { background: "rgba(255,255,255,0.22)" }
                          : { background: `hsl(${chip.accent} / 0.16)` }}
                      >
                        {chip.count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex-1 overflow-auto">
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 bg-card z-10">
                  <tr className="micro-label text-muted-foreground text-left">
                    <th className="w-8 border-b border-border px-2 py-2" />
                    <th className="border-b border-border px-2 py-2 font-medium">Extracted Field</th>
                    <th className="border-b border-border px-2 py-2 font-medium">Value</th>
                    <th className="border-b border-border px-2 py-2 font-medium whitespace-nowrap">Confidence</th>
                    <th className="border-b border-border px-2 py-2 font-medium whitespace-nowrap">Suggested Destination</th>
                    <th className="border-b border-border px-2 py-2 font-medium w-28">Action</th>
                  </tr>
                </thead>
                <tbody data-testid="review-rows">
                  {visibleSections.map((section) => (
                    <Fragment key={section.id}>
                      <tr data-testid={`review-section-${section.id}`}>
                        <td colSpan={6} className="px-3 pt-3 pb-1.5 border-b border-border/50">
                          <span className="micro-label text-muted-foreground">{section.label}</span>
                          {section.owner && (
                            <span className="text-[11px] text-muted-foreground"> · {section.owner}</span>
                          )}
                          <span className="text-[11px] text-muted-foreground/70 tabular-nums ml-1.5">{section.items.length}</span>
                        </td>
                      </tr>
                      {section.items.map((item) => {
                    const Icon = rowIcon(item);
                    const primary = primaryCategory(item);
                    const iconHsl = primary ? CATEGORY_ACCENT[primary] : ACCENT.teal;
                    const warnings = rowWarnings(item);
                    const blocking = warnings.some((w) => w.blocking);
                    const citing = (item.actionIds ?? [])
                      .map((id) => actionById.get(id))
                      .filter(Boolean) as ProposedAction[];
                    // The record this row's DATA belongs to. The planner
                    // resolves it per row, so a policy's lender fields can name
                    // the loan even though the document was filed on the house.
                    const ownerLabel = item.ownerName
                      ?? citing.find((a) => a.target?.kind === "profile")?.target?.name
                      ?? linkedProfile?.name
                      ?? "This document";
                    const targetName = item.group ? prettify(item.group) : undefined;
                    return (
                      <tr
                        key={item.id}
                        className={cn(
                          "border-b border-border/50 last:border-0 align-top",
                          !item.selected && "opacity-55",
                        )}
                        data-testid={`review-row-${item.id}`}
                      >
                        <td className="px-2 py-2.5 text-center">
                          <Checkbox
                            checked={item.selected}
                            onCheckedChange={(c) => setRowChoice(item.id, c ? "confirm" : "skip")}
                            className="h-3.5 w-3.5 mt-0.5"
                            aria-label={`Include ${item.label}`}
                          />
                        </td>
                        <td className="px-2 py-2.5">
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className="flex h-6 w-6 items-center justify-center rounded-md shrink-0"
                              style={{ background: `hsl(${iconHsl} / 0.14)`, color: `hsl(${iconHsl})` }}
                              aria-hidden="true"
                            >
                              <Icon className="h-3.5 w-3.5" />
                            </span>
                            <span className="font-medium truncate max-w-[180px]">{item.label}</span>
                          </div>
                        </td>
                        <td className="px-2 py-2.5 min-w-[140px]">
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
                            <div
                              className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium"
                              style={{ color: `hsl(${ACCENT.red})` }}
                              data-testid={`review-warning-${item.id}`}
                            >
                              <AlertTriangle className="h-3 w-3 shrink-0" />
                              <span className="truncate">{warnings[0].message}</span>
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-2.5 whitespace-nowrap">
                          <ConfidenceCell value={itemConfidence(item)} />
                        </td>
                        {/* Suggested destination — the coloured two-line reading
                            ("Insurance → Policy Number" over the record it lands
                            on), with the REAL destination <select> stretched
                            invisibly across line one so clicking it still opens
                            the full re-routing menu. */}
                        <td className="px-2 py-2.5">
                          <div className="relative max-w-[200px]">
                            <div
                              className="flex items-center gap-1 text-[11px] font-semibold truncate"
                              style={{ color: `hsl(${warnings.length > 0 ? ACCENT.orange : ACCENT.teal})` }}
                            >
                              {/* WHERE THE FACT IS SAVED — never what happens to
                                  it. Tracking, reminders and expenses live in
                                  the rail; this column answers one question:
                                  which record holds this value. */}
                              <span className="truncate">{ownerLabel} → {shortSection(section.label)}</span>
                              <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
                            </div>
                            <select
                              className="absolute inset-0 w-full opacity-0 cursor-pointer"
                              value={item.destination}
                              onChange={(e) => setItemDestination(item.id, e.target.value as ExtractionDestination)}
                              data-testid={`review-destination-${item.id}`}
                              aria-label={`Destination for ${item.label}`}
                              title="Change where this is saved"
                            >
                              {item.destinationOptions.map((d) => (
                                <option key={d} value={d}>{DESTINATION_LABEL[d]}</option>
                              ))}
                            </select>
                          </div>
                          {targetName && (
                            <div className="text-[11px] text-muted-foreground truncate max-w-[200px]">{targetName}</div>
                          )}
                        </td>
                        <td className="px-2 py-2.5">
                          {blocking && item.selected === false ? (
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold"
                              style={{
                                background: `hsl(${ACCENT.blue} / 0.15)`,
                                color: `hsl(${ACCENT.blue})`,
                                border: `1px solid hsl(${ACCENT.blue} / 0.35)`,
                              }}
                              onClick={() => setRowChoice(item.id, "confirm")}
                              data-testid={`review-action-${item.id}`}
                            >
                              Review <ChevronDown className="h-3 w-3" />
                            </button>
                          ) : (
                            <span className="relative inline-flex">
                              <select
                                className="appearance-none rounded-md pl-2.5 pr-6 py-1 text-[11px] font-semibold cursor-pointer bg-transparent"
                                style={item.selected
                                  ? {
                                      background: `hsl(${ACCENT.green} / 0.15)`,
                                      color: `hsl(${ACCENT.green})`,
                                      border: `1px solid hsl(${ACCENT.green} / 0.35)`,
                                    }
                                  : {
                                      background: "hsl(var(--muted) / 0.5)",
                                      color: "hsl(var(--muted-foreground))",
                                      border: "1px solid hsl(var(--border))",
                                    }}
                                value={item.selected ? "confirm" : "skip"}
                                onChange={(e) => setRowChoice(item.id, e.target.value as "confirm" | "skip")}
                                data-testid={`review-action-${item.id}`}
                                aria-label={`Action for ${item.label}`}
                              >
                                <option value="confirm">Confirm</option>
                                <option value="skip">Skip</option>
                              </select>
                              <ChevronDown
                                className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3"
                                style={{ color: item.selected ? `hsl(${ACCENT.green})` : "hsl(var(--muted-foreground))" }}
                              />
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                    </Fragment>
                  ))}
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
            <div className="flex items-center gap-3 px-4 py-3 border-t border-border/60 shrink-0 flex-wrap">
              <span
                className="flex items-center gap-1.5 text-xs font-medium"
                style={{ color: `hsl(${ACCENT.green})` }}
                data-testid="review-selected-summary"
              >
                <Check className="h-3.5 w-3.5" />
                {autoConfirmed > 0
                  ? `${autoConfirmed} field${autoConfirmed === 1 ? "" : "s"} auto-confirmed`
                  : `${selectedCount} of ${items.length} field${items.length === 1 ? "" : "s"}`}
                {selectedActionCount > 0
                  && ` · ${selectedActionCount} action${selectedActionCount === 1 ? "" : "s"}`}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="outline"
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
                      selectedCount === 0
                      && selectedActionCount === 0
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
          <aside className="xl:w-80 shrink-0 space-y-4 xl:overflow-y-auto" data-testid="review-actions-rail">
            {blockedActions.length > 0 && (
              <div
                className="bubble p-3.5 space-y-2.5"
                style={{ ["--accent-hsl" as any]: ACCENT.red }}
                data-testid="review-validation"
              >
                <h3 className="micro-label flex items-center gap-1.5" style={{ color: `hsl(${ACCENT.red})` }}>
                  <AlertTriangle className="h-3.5 w-3.5" /> Validation Required
                </h3>
                {blockedActions.map((a) => {
                  const blocking = a.warnings.filter((w) => w.blocking);
                  return (
                    <div key={a.id} className="space-y-1.5" data-testid={`validation-${a.id}`}>
                      {blocking.map((w, i) => (
                        <div key={i} className="text-xs leading-snug">
                          <p className="font-semibold flex items-center gap-1.5">
                            <AlertTriangle className="h-3 w-3 shrink-0" style={{ color: `hsl(${ACCENT.red})` }} />
                            {w.message}
                          </p>
                          {w.existing !== undefined && w.incoming !== undefined && (
                            <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                              Document shows: {String(w.incoming)}
                              <br />
                              Stored now: {String(w.existing)}
                            </p>
                          )}
                        </div>
                      ))}
                      <div className="flex gap-1.5 pt-0.5">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2.5 text-[11px]"
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
                          className="h-6 px-2.5 text-[11px]"
                          disabled={!a.savable}
                          onClick={() => {
                            // Linking anyway is the human decision the blocking
                            // warning was waiting for: the action AND its
                            // evidence rows turn on together, so the table and
                            // the rail never disagree about what will save.
                            setActions((prev) => prev.map((x) => (x.id === a.id ? { ...x, selected: true } : x)));
                            setItems((prev) => prev.map((i) => (a.itemIds.includes(i.id) ? { ...i, selected: true } : i)));
                          }}
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

            {/* The explanation sits beside the thing it explains: when the
                understanding step degrades it is the ACTIONS that thin out, so
                saying so in the left-hand document panel (where it used to
                live) put the notice nowhere near its consequence. */}
            {extraction.semanticDegraded && (
              <div
                className="bubble p-3.5"
                style={{ ["--accent-hsl" as any]: ACCENT.amber }}
                data-testid="review-degraded-notice"
              >
                <h3 className="micro-label flex items-center gap-1.5" style={{ color: `hsl(${ACCENT.amber})` }}>
                  <AlertTriangle className="h-3.5 w-3.5" /> Understanding degraded
                </h3>
                <p className="text-xs text-muted-foreground leading-snug mt-1.5">
                  Fields were read and routed one by one — {extraction.semanticDegraded}. Anything
                  suggested below comes from the fields themselves.
                </p>
              </div>
            )}

            {/* ALWAYS A BOX. Every block in this rail used to be gated on a
                non-empty list, so a document whose understanding step degraded
                rendered an aside with nothing in it at all — a 320px column of
                blank next to the table, with no hint that anything was missing
                (user report 2026-08-26). The box is the rail's identity: it
                says what it is, counts what it has, and explains an empty list
                rather than becoming invisible. */}
            <div className="bubble p-3.5 space-y-1" data-testid="review-suggested-actions">
                <h3 className="micro-label text-muted-foreground pb-1">
                  Suggested Actions ({suggestedActions.length})
                </h3>
                {suggestedActions.length === 0 && (
                  <p className="text-xs text-muted-foreground leading-snug" data-testid="review-actions-empty">
                    {extraction.semanticDegraded
                      ? "The understanding step didn't finish, so only the fields were read. Everything selected still saves — there just isn't anything extra to do with it."
                      : "Nothing to do beyond saving these fields."}
                  </p>
                )}
                {suggestedActions.map((a) => {
                  const vis = actionVisual(a);
                  return (
                    <label
                      key={a.id}
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg px-2 py-2 cursor-pointer transition-colors hover:bg-muted/40",
                        !a.selected && "opacity-55",
                      )}
                      data-testid={`suggested-action-${a.id}`}
                    >
                      <Medallion icon={vis.icon} accent={vis.accent} size="sm" />
                      <div className="min-w-0 flex-1 text-xs leading-snug">
                        {/* The action's own name, from the app's vocabulary —
                            "Create recurring calendar rule", "Append value to
                            existing tracker". The title says what it does to
                            THIS document; this says which of the named actions
                            it is. */}
                        {a.kindLabel && (
                          <p
                            className="micro-label text-muted-foreground"
                            data-testid={`action-kind-${a.id}`}
                          >
                            {a.kindLabel}
                          </p>
                        )}
                        <p className="font-semibold">{a.title}</p>
                        {a.writesLabel && (
                          <p className="text-[11px] text-muted-foreground truncate">{a.writesLabel}</p>
                        )}
                        {/* Exactly what this action does and to WHAT: creates or
                            appends, which record it targets, and who it belongs
                            to. Without it "Add to Weight" never said whose. */}
                        <p
                          className="text-[11px] text-muted-foreground truncate"
                          data-testid={`action-target-${a.id}`}
                        >
                          {OPERATION_LABEL[a.operation]}
                          {a.target?.name ? ` · ${a.target.name}` : ""}
                          {a.payload?.profileName ? ` · ${a.payload.profileName}` : ""}
                        </p>
                        {!a.savable && a.unsupportedReason && (
                          <p className="text-[11px]" style={{ color: `hsl(${ACCENT.amber})` }}>{a.unsupportedReason}</p>
                        )}
                      </div>
                      <Checkbox
                        checked={a.selected}
                        disabled={!a.savable}
                        onCheckedChange={() => toggleAction(a.id)}
                        className="h-3.5 w-3.5 shrink-0"
                        data-testid={`suggested-action-check-${a.id}`}
                      />
                    </label>
                  );
                })}
                {suggestedActions.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full h-7 text-[11px] mt-1"
                    onClick={() => setCategory("actions")}
                    data-testid="btn-review-all-actions"
                  >
                    Review All Actions
                  </Button>
                )}
              </div>

            {/* Every date on the page is accounted for. These are the ones the
                engine read, understood and deliberately did not schedule — so
                "Dates & Deadlines" in the table can never again sit beside a
                rail that says nothing about them. */}
            {keptDates.length > 0 && (
              <div className="bubble p-3.5 space-y-1" data-testid="review-kept-dates">
                <h3 className="micro-label text-muted-foreground pb-1">
                  Dates kept, not scheduled ({keptDates.length})
                </h3>
                {keptDates.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center gap-2.5 px-2 py-1.5 opacity-70"
                    data-testid={`kept-date-${a.id}`}
                  >
                    <Medallion icon={CalendarDays} accent={ACCENT.blue} size="sm" />
                    <div className="min-w-0 flex-1 text-xs leading-snug">
                      <p className="font-semibold truncate">{a.title}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {a.detail || "Kept on the document · nothing scheduled"}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {entities.length > 0 && (
              <div className="bubble p-3.5 space-y-1" data-testid="review-entities">
                <h3 className="micro-label text-muted-foreground pb-1">
                  Related Entities ({entities.length})
                </h3>
                {entities.map((e) => {
                  const Icon = ENTITY_ICON[e.kind] ?? Building2;
                  return (
                    <div key={e.ref} className="flex items-center gap-2.5 px-2 py-1.5" data-testid={`entity-${e.ref}`}>
                      <Medallion icon={Icon} accent={ENTITY_ACCENT[e.kind] ?? ACCENT.teal} size="sm" />
                      <div className="min-w-0 flex-1 text-xs leading-snug">
                        <p className="font-semibold truncate">{e.name}</p>
                        <p className="text-[11px] text-muted-foreground capitalize">
                          {e.role ? e.role.replace(/_/g, " ") : e.kind.replace(/_/g, " ")}
                        </p>
                      </div>
                    </div>
                  );
                })}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full h-7 text-[11px] mt-1"
                  onClick={() => setCategory("entities")}
                  data-testid="btn-review-all-entities"
                >
                  Review All Entities
                </Button>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

// ─── Small pieces ────────────────────────────────────────────────────────────

/**
 * The review's starting selection. A row whose citing action carries a
 * BLOCKING warning (an address mismatch, a stable-field conflict) starts
 * unticked, matching the action the planner already unticked — without this,
 * the row travelled as a selected loose item and Confirm All wrote the
 * conflicting value the validation card was still asking about.
 */
function initialReviewItems(extraction: PendingExtraction): ExtractionItem[] {
  const blockedRows = new Set(
    (extraction.actionPlan?.actions ?? [])
      .filter((a) => a.warnings.some((w) => w.blocking))
      .flatMap((a) => a.itemIds),
  );
  return (extraction.items || []).map((i) =>
    blockedRows.has(i.id) ? { ...i, selected: false } : { ...i });
}

/**
 * A section name short enough to sit in a table cell: the row already lives
 * under the full heading, so "Property Details" reads as "Property" here.
 */
function shortSection(label: string): string {
  return String(label || "").replace(/\s+(Details|Information)$/i, "").trim() || label;
}

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

function SummaryRow({ accent, label, count }: { accent: string; label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: `hsl(${accent})` }} aria-hidden="true" />
      <span className="tabular-nums font-semibold">{count}</span>
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function MiniPreview({
  documentId,
  mimeType,
  inlineData,
  fileName,
  imageDiscarded,
}: {
  documentId: string;
  mimeType: string;
  inlineData?: string;
  fileName: string;
  imageDiscarded?: boolean;
}) {
  const kind = classifyDocument(mimeType);
  // Nothing was stored, so don't ask the server for bytes that don't exist.
  const { url, blob, error } = useDocumentBlobUrl(documentId, mimeType, imageDiscarded ? undefined : inlineData, !imageDiscarded);
  const [, navigate] = useLocation();
  const [zoom, setZoom] = useState(1);
  const kindLabel = kind === "pdf" ? "PDF Document" : kind === "image" ? "Image" : "Document";

  return (
    <div className="space-y-2">
      {/* File identity card */}
      <div className="bubble p-3 flex items-center gap-2.5">
        <Medallion icon={FileText} accent={ACCENT.red} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold truncate" data-testid="review-preview-name">{fileName}</p>
          <p className="text-[11px] text-muted-foreground">
            {blob ? `${formatBytes(blob.size)} · ` : ""}{kindLabel}
          </p>
        </div>
      </div>

      {/* Preview with zoom bar */}
      <div className="bubble overflow-hidden">
        <div className="px-3 pt-2.5">
          <h3 className="micro-label text-muted-foreground">Document Preview</h3>
        </div>
        <div className="mt-2 h-56 overflow-auto bg-muted/30 relative">
          {imageDiscarded ? (
            <div className="h-full flex flex-col items-center justify-center gap-1.5 px-4 text-center text-muted-foreground" data-testid="review-preview-discarded">
              <FileText className="h-8 w-8" />
              <p className="text-[11px] leading-tight max-w-[220px]">
                This file wasn't kept. It was read once to pull the fields below, then discarded.
              </p>
            </div>
          ) : error || (!url && !blob) ? (
            <div className="h-full flex items-center justify-center text-muted-foreground">
              <FileText className="h-8 w-8" />
            </div>
          ) : kind === "image" && url ? (
            <div className="min-h-full flex items-start justify-center">
              <img
                src={url}
                alt={fileName}
                className="max-w-full object-contain origin-top"
                style={{ transform: `scale(${zoom})` }}
                draggable={false}
              />
            </div>
          ) : kind === "pdf" && blob ? (
            <Suspense fallback={<div className="h-full flex items-center justify-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>}>
              <div className="origin-top" style={{ transform: `scale(${zoom * 0.9})` }}>
                <PdfCanvas blob={blob} />
              </div>
            </Suspense>
          ) : (
            <div className="h-full flex items-center justify-center text-muted-foreground">
              <FileText className="h-8 w-8" />
            </div>
          )}
        </div>
        <div className="flex items-center justify-center gap-1 px-2 py-1.5 border-t border-border/60">
          <Button
            variant="ghost" size="icon" className="h-6 w-6"
            onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.25) * 100) / 100))}
            disabled={zoom <= 0.5}
            aria-label="Zoom out"
            data-testid="btn-review-zoom-out"
          >
            <Minus className="h-3 w-3" />
          </Button>
          <span className="text-[11px] font-medium tabular-nums w-10 text-center text-muted-foreground">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            variant="ghost" size="icon" className="h-6 w-6"
            onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.25) * 100) / 100))}
            disabled={zoom >= 3}
            aria-label="Zoom in"
            data-testid="btn-review-zoom-in"
          >
            <Plus className="h-3 w-3" />
          </Button>
          <div className="w-px h-3.5 bg-border mx-1" />
          <Button
            variant="ghost" size="icon" className="h-6 w-6"
            onClick={() => navigate(`/documents/${documentId}`)}
            aria-label="Open document full screen"
            title="Open document"
            data-testid="btn-open-document"
          >
            <Maximize2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
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
