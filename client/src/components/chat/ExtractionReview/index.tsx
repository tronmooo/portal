// client/src/components/chat/ExtractionReview/index.tsx
//
// The review pane: what a document produced, and what the app intends to do
// with it, before anything is written.
//
// Lifted out of client/src/pages/chat.tsx VERBATIM — no behaviour change in the
// move itself. It was ~800 lines inside a 4,600-line page with no direct test
// coverage, and the document-understanding work roughly triples it. Its own
// module keeps the substantive diff readable and lets a .dom test import the
// component directly instead of mounting the whole chat page.

import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Calendar, Check, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { getUserToday } from "@shared/timezone";
import { EXPENSE_CATEGORIES, categoryLabel } from "@shared/category-canon";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CopyButton } from "@/components/chat/CopyButton";
import type { ChatMessage } from "@shared/schema";
import {
  DESTINATION_LABEL, DESTINATION_ORDER, parseMeasurement, matchHealthMetric,
  type ExtractionItem, type ExtractionDestination,
} from "@shared/extraction-destinations";
import {
  extractionDateRows, isUpcomingWithinWindow, UPCOMING_WINDOW_DAYS,
  type ExtractionDateRow, type CalendarDateDecision,
} from "@shared/extraction-calendar";
import { itemsClaimedByActions, type ProposedAction } from "@shared/extraction-actions";
import { DocumentUnderstanding } from "./DocumentUnderstanding";
import { ProposedActions } from "./ProposedActions";
import { ActionGroupSection } from "./ActionGroupSection";
import { AddActionDialog } from "./AddActionDialog";
import { getActiveTimezone } from "@/lib/timezone";


// ── Extraction Confirmation UI (two-phase extraction) ───────────────────────
export function ExtractionConfirmation({
  extraction,
  onConfirm,
  onSkip,
}: {
  extraction: NonNullable<ChatMessage["pendingExtraction"]>;
  onConfirm: (data: {
    extractionId: string;
    confirmedFields: Array<{ key: string; value: any }>;
    targetProfileId?: string;
    createCalendarEvents: Array<{ field: string; date: string; title: string; category: string }>;
    /** The review list, each row carrying the destination the user chose. */
    items?: ExtractionItem[];
    /** One decision per recognized date — see shared/extraction-calendar. */
    calendarDates?: CalendarDateDecision[];
    /** The reviewed plan — see shared/extraction-actions. */
    actions?: ProposedAction[];
    trackerEntries: any[];
    createExpense?: any;
    createObligation?: any;
  }) => Promise<boolean>;
  onSkip: () => void;
}) {
  const [fields, setFields] = useState(
    () => extraction.extractedFields.map((f) => ({ ...f }))
  );
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  // Track which tracker entries the user wants to create (all selected by default)
  const [selectedTrackers, setSelectedTrackers] = useState<boolean[]>(
    () => (extraction.trackerEntries || []).map(() => true)
  );
  // ── The review list ────────────────────────────────────────────────────────
  // One row per extracted fact, each carrying the destination the extractor
  // proposed and the destinations it may be re-routed to. This replaces a
  // hard-coded 25-key allowlist that decided which fields were even ALLOWED to
  // become a tracker — creatinine, sodium, potassium, TSH, respiratory rate and
  // SpO2 were not on it, so a full lab panel was silently flattened into loose
  // profile strings (user report 2026-08-25). The vocabulary now lives in
  // shared/extraction-destinations and the user gets the final say on every row.
  const [items, setItems] = useState<ExtractionItem[]>(
    () => (extraction.items || []).map((i) => ({ ...i })),
  );
  const hasItems = items.length > 0;

  // ── The reviewed plan ──────────────────────────────────────────────────────
  // What the app intends to DO, as opposed to what it found. Present when the
  // understanding stage produced one; absent for a chat message rendered from
  // history, or when reasoning degraded — in which case the pane below falls
  // back to per-field routing and says so.
  const [actions, setActions] = useState<ProposedAction[]>(
    () => (extraction.actionPlan?.actions ?? []).map((a) => ({ ...a })),
  );
  const hasPlan = actions.length > 0;

  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  /** Keep / Don't save. */
  const toggleAction = (id: string) =>
    setActions((prev) => prev.map((a) => (a.id === id ? { ...a, selected: !a.selected } : a)));

  /**
   * Change destination. Re-routing something is an act of WANTING it saved, so
   * it turns the action on — the alternative makes the user pick a destination
   * and then separately notice it is still switched off.
   */
  const setActionDestination = (id: string, destination: ExtractionDestination) =>
    setActions((prev) => prev.map((a) =>
      a.id === id
        ? { ...a, destination, selected: destination !== "ignore" && destination !== "reference" }
        : a));

  const addAction = (action: ProposedAction) =>
    setActions((prev) => [...prev.filter((a) => a.id !== action.id), action]);

  /** Groups, recomputed as the user re-routes so a moved row moves sections. */
  const actionGroups = useMemo(() => {
    const order = extraction.actionPlan?.groups.map((g) => g.destination) ?? [];
    const byDest = new Map<ExtractionDestination, ProposedAction[]>();
    for (const a of actions) {
      const list = byDest.get(a.destination) ?? [];
      list.push(a);
      byDest.set(a.destination, list);
    }
    const labels = new Map(extraction.actionPlan?.groups.map((g) => [g.destination, g.label]) ?? []);
    const seen = new Set<ExtractionDestination>();
    const out: Array<{ destination: ExtractionDestination; label: string; actions: ProposedAction[] }> = [];
    for (const d of [...order, ...byDest.keys()]) {
      if (seen.has(d) || !byDest.has(d)) continue;
      seen.add(d);
      out.push({ destination: d, label: labels.get(d) ?? DESTINATION_LABEL[d], actions: byDest.get(d)! });
    }
    return out;
  }, [actions, extraction.actionPlan]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | undefined>(extraction.targetProfile?.id);
  const [createExpense, setCreateExpense] = useState(!!extraction.pendingFinancial?.expense);
  const [createObligation, setCreateObligation] = useState(!!extraction.pendingFinancial?.obligation);
  // The proposed expense is a SUGGESTION — every part of it is editable before
  // saving. (Bug report: the AI proposed $84.97 while the receipt's Total
  // Amount 92.40 sat in the checklist, and the user had no way to correct it.)
  const [expenseDraft, setExpenseDraft] = useState(() => {
    const e = extraction.pendingFinancial?.expense;
    return e ? {
      description: String(e.description ?? ""),
      amount: String(e.amount ?? ""),
      category: String(e.category ?? "general"),
      date: String(e.date ?? ""),
    } : null;
  });

  // Fetch profiles for the dropdown
  const { data: allProfiles = [] } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
  });

  // Default the linked profile to "my profile" (the self profile) whenever the
  // extraction didn't already target someone specific. Runs once profiles load.
  useEffect(() => {
    if (selectedProfileId) return;
    if (extraction.targetProfile?.id) return;
    const self = allProfiles.find((p: any) => p.type === "self");
    if (self) setSelectedProfileId(self.id);
  }, [allProfiles, selectedProfileId, extraction.targetProfile?.id]);

  const toggleField = (idx: number) => {
    setFields((prev) => prev.map((f, i) => i === idx ? { ...f, selected: !f.selected } : f));
  };

  // Bulk toggle for the review-table header. If every row is currently
  // selected we treat the next click as a Deselect All; otherwise we Select
  // All. This is the same affordance spreadsheets give you — one click to
  // flip the entire column.
  const allSelected = hasItems
    ? items.every((i) => i.selected)
    : (fields.length > 0 && fields.every((f) => f.selected));
  const toggleAllFields = () => {
    const next = !allSelected;
    if (hasItems) {
      // Select-all never resurrects a row the router sent to Ignore — those are
      // document metadata, and ticking them would write "signedBy" to a person.
      setItems((prev) => prev.map((i) => (i.destination === "ignore" ? i : { ...i, selected: next })));
      return;
    }
    setFields((prev) => prev.map((f) => ({ ...f, selected: next })));
    // Mirror the bulk action onto the tracker entry checkboxes so the user's
    // single click clears (or restores) the whole review pane at once.
    setSelectedTrackers((prev) => prev.map(() => next));
  };

  const toggleItem = (id: string) =>
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, selected: !i.selected } : i)));

  /**
   * Edit a row's value. For a measurement the numbers, not the text, are what
   * gets logged — so an edited value is re-parsed through the SAME parser the
   * server used. Without this, correcting a misread height in the review pane
   * changed the label and left the old number on its way to the tracker.
   */
  const setItemValue = (id: string, value: string) => {
    setItems((prev) => prev.map((i) => {
      if (i.id !== id) return i;
      if (!i.values) return { ...i, value };
      const reparsed = parseMeasurement(value, matchHealthMetric(i.trackerName ?? i.key));
      return reparsed
        ? { ...i, value, values: reparsed.values, unit: reparsed.unit || i.unit }
        : { ...i, value };
    }));
    applyEditToActions(id, value);
  };

  /**
   * An edited value has to reach the WRITE, not just the input.
   *
   * The rows under an action are its evidence, and editing one is how a user
   * corrects a misread number before confirming. The action's payload was built
   * from the original reading, so without this the pane would show 1,500 and
   * save 1,428 — the exact "what you see is what saves" contract the expense
   * draft has always kept, applied to every action.
   *
   * Only the fields that came FROM this row are touched; an amount the user
   * never edited is left exactly as the planner computed it.
   */
  const applyEditToActions = (itemId: string, value: string) => {
    const row = items.find((i) => i.id === itemId);
    if (!row) return;
    const numeric = Number(String(value).replace(/[$,\s]/g, ""));
    setActions((prev) => prev.map((a) => {
      if (!a.itemIds.includes(itemId)) return a;
      const payload: Record<string, any> = { ...a.payload };
      if (payload.fields && typeof payload.fields === "object" && row.key in payload.fields) {
        payload.fields = { ...payload.fields, [row.key]: value };
      }
      if (payload.key === row.key) payload.value = value;
      // A money or date field only follows the edit when the row IS that field —
      // a three-row obligation must not take its due date from its premium.
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
  };

  /**
   * Re-route one row. Moving a row OUT of Ignore ticks it — the user only ever
   * changes a destination because they want that row saved somewhere — and
   * moving one INTO Ignore unticks it, so the two controls never disagree.
   */
  const setItemDestination = (id: string, destination: ExtractionDestination) =>
    setItems((prev) => prev.map((i) => (
      i.id === id
        ? { ...i, destination, selected: destination !== "ignore" }
        : i
    )));

  // Rows grouped by destination, in the display order the shared module fixes,
  // so the same document always reads the same way.
  const groupedItems = useMemo(() => {
    const groups = new Map<ExtractionDestination, ExtractionItem[]>();
    for (const it of items) {
      const list = groups.get(it.destination) ?? [];
      list.push(it);
      groups.set(it.destination, list);
    }
    return DESTINATION_ORDER
      .filter((d) => groups.has(d))
      .map((d) => ({ destination: d, rows: groups.get(d)! }));
  }, [items]);

  const selectedItemCount = items.filter((i) => i.selected).length;

  // Heuristic: when the upstream classifier did NOT route this document as an
  // expense, but the user can still see a money-shaped "Total" / "Amount"
  // field in the extracted table, we want a one-click way to push that
  // number into Finance. We scan for a numeric value on a field whose
  // key/label sounds like a charge — only used when
  // extraction.pendingFinancial.expense is absent. This is the missing
  // "Add to Finance" button the user asked for.
  const moneyFieldCandidate = useMemo(() => {
    if (extraction.pendingFinancial?.expense) return null;
    const moneyKeyRe = /(total|amount|price|charge|fee|cost|payment|balance|due|paid|subtotal|grand_?total)/i;
    let best: { amount: number; label: string; key: string; __rank: number } | null = null;
    for (const f of (hasItems ? items : fields)) {
      const keyStr = String(f.key || '');
      const labelStr = String(f.label || '');
      if (!moneyKeyRe.test(keyStr) && !moneyKeyRe.test(labelStr)) continue;
      const raw = String(f.value ?? '').replace(/[$,€£¥₹₩]/g, '').trim();
      const num = parseFloat(raw);
      if (!isNaN(num) && num > 0) {
        // Prefer "total" > "amount/paid" > anything else when multiple match.
        const rank = /total|grand/i.test(keyStr + labelStr) ? 0 : /amount|paid/i.test(keyStr + labelStr) ? 1 : 2;
        if (!best || rank < best.__rank) {
          best = { amount: num, label: labelStr || keyStr, key: keyStr, __rank: rank };
        }
      }
    }
    return best;
  }, [fields, items, hasItems, extraction.pendingFinancial]);
  // "Add to Finance" toggle state — only meaningful when moneyFieldCandidate exists.
  const [addManualExpense, setAddManualExpense] = useState(false);

  // ── Calendar section ───────────────────────────────────────────────────────
  // Every actionable date in this extraction — due, expiration, renewal,
  // deadline, payment, appointment — recomputed from the LIVE field values, so
  // editing a date in the table updates its type, its countdown and what will
  // be written. Before this, an actionable date was shown as an ordinary row
  // with no calendar affordance at all (user report 2026-08-25: a parking
  // citation's due date was extracted and then went nowhere visible).
  const todayISO = useMemo(() => getUserToday(getActiveTimezone()), []);
  const dateRows: ExtractionDateRow[] = useMemo(
    () => extractionDateRows(fields, {
      documentContext: `${extraction.documentType ?? ""} ${extraction.label ?? ""}`,
      today: todayISO,
    }),
    [fields, extraction.documentType, extraction.label, todayISO],
  );
  // Path → whether it goes on the calendar. Defaults ON; a row the user
  // unticks is recorded as a calendar opt-out on the saved record, which turns
  // its derived rule off without deleting the date.
  const [addToCalendar, setAddToCalendar] = useState<Record<string, boolean>>({});
  const calendarChoice = (row: ExtractionDateRow) =>
    addToCalendar[row.path] ?? row.defaultAddToCalendar;
  const dateRowByKey = useMemo(() => {
    const m = new Map<string, ExtractionDateRow>();
    for (const r of dateRows) m.set(r.key, r);
    return m;
  }, [dateRows]);
  const docLabel = extraction.documentName || extraction.label || extraction.fileName;

  const handleConfirm = async () => {
    setConfirming(true);
    // When the review list is present it IS the payload — every row carries the
    // destination the user chose, and the server routes on that. The legacy
    // field/event/tracker shapes below are only built for a chat message
    // rendered from history, which predates the review list.
    const confirmedFields = hasItems ? [] : fields.filter((f) => f.selected && f.key).map((f) => {
      const key = f.key === 'dob' ? 'dateOfBirth' : f.key;
      return { key, value: f.value };
    });
    // Dates the classifier does NOT recognise as a rule (a one-off "House
    // Viewing" printed on an invitation) have no field to be derived from, so
    // a standalone event is the only home they have. When the review list is
    // driving, those rows travel as items with a `calendar` destination; this
    // scan is for a chat message rendered from history, which has no items.
    const createCalendarEvents = hasItems ? [] : fields

      .filter((f) => f.selected && f.isDate && f.suggestedEvent && f.key && f.value)
      .map((f) => ({
        field: f.key,
        date: String(f.value),
        title: f.suggestedEvent!,
        category: /expir|renew/i.test(f.key || "") ? "finance" : /appoint|visit/i.test(f.key || "") ? "health" : "other",
      }));
    // NOTE: the client no longer parses measurements at all.
    //
    // It used to build "synthetic tracker entries" here with three anchored
    // regexes, a bare parseFloat fallback, and a unit GUESSED from the field
    // name. A clinic report printing `Height: 5 ft 7 in (170 cm)` matched none
    // of the regexes, fell through to parseFloat → 5, and was then stamped
    // `in` because the key contained "height" — the "5 in" the user saw on
    // their Height tracker. Parsing now happens once, on the server, through
    // shared/extraction-destinations.parseMeasurement, and arrives on each item
    // as `values` + `unit`. This code's only job is to send back what the user
    // chose.


    // Every RECOGNISED date carries the user's explicit choice. A ticked
    // derived date needs no event — the record already puts it on the calendar
    // — and an unticked one becomes a calendar opt-out on the saved record.
    const calendarDates: CalendarDateDecision[] = dateRows.map((row) => ({
      field: row.key,
      path: row.path,
      date: row.date || String(row.rawValue),
      ruleType: row.ruleType,
      title: `${row.typeLabel} — ${docLabel}`,
      category: row.ruleType === "appointment" ? "health"
        : (row.ruleType === "due" || row.ruleType === "payment" || row.ruleType === "expiration" || row.ruleType === "renewal") ? "finance"
        : "other",
      addToCalendar: calendarChoice(row),
      derived: row.derived,
    }));

    // Build the expense payload. Prefer the classifier-produced one. If the
    // classifier didn't produce a pendingFinancial.expense but the user opted
    // in via the manual "Add to Finance" toggle, synthesize one from the
    // money-shaped field we detected.
    // The user's edits win over the AI proposal — whatever is in the draft is
    // exactly what gets saved.
    let expensePayload: any = (createExpense && extraction.pendingFinancial?.expense)
      ? {
          ...extraction.pendingFinancial.expense,
          ...(expenseDraft ? {
            description: expenseDraft.description.trim() || extraction.pendingFinancial.expense.description,
            amount: (() => {
              const n = parseFloat(String(expenseDraft.amount).replace(/[$,\s]/g, ""));
              return isFinite(n) && n > 0 ? n : extraction.pendingFinancial.expense.amount;
            })(),
            category: expenseDraft.category || extraction.pendingFinancial.expense.category,
            date: expenseDraft.date || extraction.pendingFinancial.expense.date,
          } : {}),
        }
      : undefined;
    if (!expensePayload && addManualExpense && moneyFieldCandidate) {
      const scan: Array<{ key?: string; value?: any }> = hasItems ? items : fields;
      const vendorField = scan.find((f) => /vendor|merchant|company|provider|payee/i.test(String(f.key || '')));
      const dateField = scan.find((f) => /transaction.?date|date$|paid/i.test(String(f.key || '')));
      expensePayload = {
        description: `${vendorField?.value || extraction.label || extraction.fileName} - ${moneyFieldCandidate.label}`,
        amount: moneyFieldCandidate.amount,
        category: 'general',
        vendor: vendorField?.value ? String(vendorField.value) : undefined,
        date: dateField?.value
          ? String(dateField.value)
          : getUserToday(getActiveTimezone()),
      };
    }

    // Partition. A row a live action is writing must NOT also travel as a
    // legacy item — the two paths would write the same fact twice. (The route
    // enforces this as well rather than trusting it, but sending a clean
    // payload is what keeps the two implementations honest about who owns what.)
    // Same rule as the full-screen review: only an action that itself performs
    // the field write withholds its row from the data path.
    const claimedByActions = itemsClaimedByActions(actions, items);
    const unclaimedItems = hasPlan
      ? items.filter((i) => !claimedByActions.has(i.id))
      : items;

    const success = await onConfirm({
      extractionId: extraction.extractionId,
      confirmedFields,
      targetProfileId: selectedProfileId || extraction.targetProfile?.id,
      createCalendarEvents,
      actions: hasPlan ? actions : undefined,
      items: hasItems ? unclaimedItems : undefined,
      calendarDates,
      trackerEntries: hasItems
        ? []
        : (extraction.trackerEntries || []).filter((_: any, i: number) => selectedTrackers[i]),
      createExpense: expensePayload,
      createObligation: createObligation ? extraction.pendingFinancial?.obligation : undefined,
    });
    if (success) {
      setConfirmed(true);
    }
    setConfirming(false);
  };

  if (confirmed) {
    return (
      <div className="mt-2 p-3 rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800">
        <div className="flex items-center gap-2 text-green-700 dark:text-green-400 text-xs font-medium">
          <Check className="h-3.5 w-3.5" />
          Extraction confirmed and saved
        </div>
      </div>
    );
  }

  // Excel/spreadsheet-friendly TSV (Field<TAB>Value) of all extracted fields so
  // the user can paste the whole table straight into a sheet.
  const buildTsv = () =>
    // Three columns, because the Calendar column is part of the table now: a
    // pasted sheet should say which values are dates and what kind.
    "Field\tValue\tCalendar\n" +
    fields.map((f) => {
      const v = typeof f.value === 'object' && f.value !== null
        ? JSON.stringify(f.value)
        : String(f.value ?? '');
      const row = dateRowByKey.get(f.key);
      const cal = row ? `${row.typeLabel}${row.countdown ? ` (${row.countdown})` : ''}` : '';
      return `${f.label || f.key}\t${v}\t${cal}`;
    }).join("\n");

  return (
    <div className="mt-3 rounded-lg bg-muted/40 border border-border overflow-hidden text-foreground">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border bg-muted/60 flex-wrap">
        <span className="micro-label text-muted-foreground" data-testid="extraction-count">
          {hasPlan
            ? `Extracted data · ${items.length}`
            : hasItems
              ? `We found ${items.length} piece${items.length === 1 ? "" : "s"} of data`
              : `Review extracted data · ${fields.length}`}
        </span>
        <button
          type="button"
          onClick={toggleAllFields}
          className="text-[11px] px-1.5 py-0.5 rounded border border-border bg-background hover:bg-muted text-foreground transition-colors"
          data-testid="button-toggle-all-fields"
          title={allSelected ? 'Deselect every row' : 'Select every row'}
        >
          {allSelected ? 'Deselect all' : 'Select all'}
        </button>
        <div className="ml-auto flex items-center gap-1.5">
          <CopyButton value={buildTsv} label="Copy" />
          <select
            className="text-[11px] bg-background border border-border rounded px-1 py-0.5 text-foreground max-w-[150px]"
            value={selectedProfileId || ""}
            onChange={(e) => setSelectedProfileId(e.target.value || undefined)}
            data-testid="select-extraction-profile"
          >
            <option value="">Link to profile…</option>
            {allProfiles.slice().sort((a: any, b: any) => (a.name || '').localeCompare(b.name || '')).map((p: any) => (
              <option key={p.id} value={p.id}>{p.name}{p.type === 'self' ? ' (me)' : ` (${p.type})`}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Level 2: what it MEANS ── */}
      <DocumentUnderstanding
        plan={extraction.actionPlan}
        degraded={extraction.semanticDegraded}
      />

      {/* ── Level 3: what will HAPPEN ── */}
      {hasPlan && (
        <>
          <ProposedActions actions={actions} />
          <div className="divide-y divide-border/60" data-testid="extraction-actions">
            {actionGroups.map((group) => (
              <ActionGroupSection
                key={group.destination}
                group={group}
                itemsById={itemsById}
                onToggle={toggleAction}
                onDestinationChange={setActionDestination}
                onValueChange={setItemValue}
              />
            ))}
          </div>
          <div className="border-t border-border/60">
            <AddActionDialog
              items={items}
              profiles={allProfiles as any[]}
              documentId={extraction.extractionId}
              onAdd={addAction}
            />
          </div>
        </>
      )}

      {/* ── Level 1: everything that was found ──
          Under a plan these rows are EVIDENCE — each is already shown beneath
          the action that cites it — so the full list is collapsed rather than
          removed. Nothing extracted is ever lost, but the reader does not have
          to decipher seventy-five rows to find out what the document means. */}
      {hasPlan && (
        <details className="border-t border-border/60" data-testid="extracted-data-section">
          <summary className="px-2.5 py-1 bg-muted/50 cursor-pointer micro-label text-muted-foreground">
            Extracted data · {items.length}
          </summary>
          <div className="divide-y divide-border/40">
            {items.map((item) => (
              <div key={item.id} className="flex items-baseline gap-2 px-2.5 py-1" data-testid={`extracted-row-${item.id}`}>
                <span className="text-[11px] text-muted-foreground shrink-0 truncate max-w-[40%]">{item.label}</span>
                <input
                  type="text"
                  className="flex-1 min-w-0 bg-transparent text-[11px] text-foreground border-b border-dashed border-border/60 focus:outline-none focus:border-primary focus:bg-primary/5 px-0.5"
                  value={
                    typeof item.value === "object" && item.value !== null
                      ? JSON.stringify(item.value)
                      : String(item.value ?? "")
                  }
                  onChange={(e) => setItemValue(item.id, e.target.value)}
                  data-testid={`extracted-value-${item.id}`}
                />
                {!item.actionIds?.length && (
                  <span className="text-[11px] text-muted-foreground shrink-0">document only</span>
                )}
              </div>
            ))}
          </div>
        </details>
      )}

      {hasItems && !hasPlan && (
        <div className="divide-y divide-border/60" data-testid="extraction-items">
          {groupedItems.map(({ destination, rows }) => (
            <div key={destination}>
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-muted/50">
                <span className="micro-label text-muted-foreground">
                  {DESTINATION_LABEL[destination]}
                </span>
                <span className="text-[11px] text-muted-foreground tabular-nums">{rows.length}</span>
              </div>
              {rows.map((item) => (
                <div
                  key={item.id}
                  className={`flex items-start gap-2 px-2.5 py-1 ${item.selected ? "" : "opacity-50"}`}
                  data-testid={`extraction-item-${item.id}`}
                >
                  <Checkbox
                    checked={item.selected}
                    onCheckedChange={() => toggleItem(item.id)}
                    className="h-3.5 w-3.5 mt-1 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium truncate">{item.label}</div>
                    <input
                      type="text"
                      className="w-full bg-transparent text-xs text-foreground border-b border-dashed border-border/60 focus:outline-none focus:border-primary focus:bg-primary/5 rounded-t px-0.5 py-0.5"
                      value={
                        typeof item.value === "object" && item.value !== null
                          ? JSON.stringify(item.value)
                          : String(item.value ?? "")
                      }
                      onChange={(e) => setItemValue(item.id, e.target.value)}
                      data-testid={`extraction-value-${item.id}`}
                    />
                    {item.detail && (
                      <div className="text-[11px] text-muted-foreground leading-tight">{item.detail}</div>
                    )}
                    {item.trackerName && item.destination !== "medication" && (
                      <div className="text-[11px] text-muted-foreground leading-tight">
                        → {item.trackerName} tracker
                      </div>
                    )}
                    {/* A recognised date is ALSO listed in the Calendar section
                        below, which is where its add-or-not decision lives (it
                        knows whether the record derives the date or a standalone
                        event is its only home). Naming the type and countdown
                        here keeps the two views agreeing instead of looking
                        like two unrelated rows for one date. The server dedupes
                        the two payloads on the field key, so a date can never
                        produce two events. */}
                    {(() => {
                      const row = dateRowByKey.get(item.key);
                      if (!row) return null;
                      const on = calendarChoice(row);
                      return (
                        <div
                          className={`text-[11px] leading-tight ${on ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground"}`}
                          data-testid={`item-calendar-hint-${item.id}`}
                        >
                          → {row.typeLabel}{row.countdown ? ` · ${row.countdown}` : ""}
                          {on ? " · on your calendar" : " · document only"}
                        </div>
                      );
                    })()}
                    {item.destination === "medication" && (
                      <div className="text-[11px] text-muted-foreground leading-tight">
                        → medication record + tracker · no dose logged
                      </div>
                    )}
                  </div>
                  <select
                    className="text-[11px] bg-background border border-border rounded px-1 py-0.5 text-foreground max-w-[130px] shrink-0 mt-0.5"
                    value={item.destination}
                    onChange={(e) => setItemDestination(item.id, e.target.value as ExtractionDestination)}
                    data-testid={`extraction-destination-${item.id}`}
                    title="Change where this is saved"
                  >
                    {item.destinationOptions.map((d) => (
                      <option key={d} value={d}>{DESTINATION_LABEL[d]}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Excel-style grid: tight rows, column lines, header row.
          Legacy path — a chat message rendered from history, extracted before
          the review list existed. */}
      {!hasItems && (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-muted/40 micro-label text-muted-foreground">
              <th className="w-7 border-b border-border px-1 py-1 font-medium"></th>
              <th className="border-b border-border px-2 py-1 text-left font-medium">Field</th>
              <th className="border-b border-border px-2 py-1 text-left font-medium">Value</th>
              {/* Dates get their OWN column — what kind of date it is and
                  whether it is going on the calendar, visible at a glance
                  instead of buried under the value. */}
              <th className="border-b border-border px-2 py-1 text-left font-medium">Calendar</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field, idx) => {
              const strVal = typeof field.value === 'object' && field.value !== null
                ? JSON.stringify(field.value).replace(/[{}"/]/g, '').replace(/,/g, ', ')
                : String(field.value ?? '');
              const isDateField = field.category === 'DATE' || field.isDate;
              const isBoolField = strVal === 'true' || strVal === 'false' || strVal === 'True' || strVal === 'False';
              const isNumField = !isDateField && !isBoolField && /^-?\$?[\d,]+(\.[\d]+)?$/.test(strVal.trim());
              return (
                <tr
                  key={field.key}
                  className={`border-b border-border/60 last:border-0 ${field.selected ? '' : 'opacity-50'}`}
                >
                  <td className="border-r border-border/60 px-1 py-0.5 text-center align-middle">
                    <Checkbox
                      checked={field.selected}
                      onCheckedChange={() => toggleField(idx)}
                      className="h-3.5 w-3.5"
                    />
                  </td>
                  <td className="border-r border-border/60 px-2 py-0.5 align-middle">
                    <div className="flex items-center gap-1">
                      <span className="font-medium capitalize">{field.label}</span>
                      {field.isDate && field.suggestedEvent && (
                        <Calendar className="h-3 w-3 text-blue-500 shrink-0" />
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-0.5 align-middle">
                    {isBoolField ? (
                      <div className="flex items-center gap-1.5">
                        <Checkbox
                          checked={strVal === 'true' || strVal === 'True'}
                          onCheckedChange={(checked) => {
                            const newFields = [...fields];
                            newFields[idx] = { ...newFields[idx], value: String(!!checked) };
                            setFields(newFields);
                          }}
                          className="h-3.5 w-3.5"
                        />
                        <span className="text-muted-foreground">{strVal === 'true' || strVal === 'True' ? 'Yes' : 'No'}</span>
                      </div>
                    ) : (
                      <input
                        type={isDateField ? 'date' : isNumField ? 'number' : 'text'}
                        // Dashed underline signals "tap to edit" — these values
                        // were always editable but looked like static text.
                        className="w-full bg-transparent text-foreground border-b border-dashed border-border/60 focus:outline-none focus:border-primary focus:bg-primary/5 rounded-t px-0.5 py-0.5"
                        value={strVal}
                        onChange={(e) => {
                          const newFields = [...fields];
                          newFields[idx] = { ...newFields[idx], value: e.target.value };
                          setFields(newFields);
                        }}
                      />
                    )}
                    {field.isDate && field.suggestedEvent && field.selected && (
                      <div className="text-[11px] text-blue-600 dark:text-blue-400 leading-tight">
                        → {field.suggestedEvent}
                      </div>
                    )}
                  </td>
                  {/* Calendar column — the date's TYPE and its destination. */}
                  <td className="border-l border-border/60 px-2 py-0.5 align-middle whitespace-nowrap">
                    {(() => {
                      const row = dateRowByKey.get(field.key);
                      if (!row) {
                        return field.isDate
                          ? <span className="text-[11px] text-muted-foreground/60">—</span>
                          : null;
                      }
                      const on = calendarChoice(row);
                      return (
                        <div className="flex items-center gap-1.5" data-testid={`calendar-cell-${field.key}`}>
                          <Checkbox
                            checked={on}
                            onCheckedChange={(checked) =>
                              setAddToCalendar((prev) => ({ ...prev, [row.path]: !!checked }))}
                            className="h-3.5 w-3.5"
                            aria-label={`Add ${row.typeLabel} to calendar`}
                            data-testid={`calendar-toggle-${field.key}`}
                          />
                          <div className="leading-tight">
                            <div className="flex items-center gap-1">
                              <Calendar className={`h-3 w-3 shrink-0 ${on ? 'text-blue-500' : 'text-muted-foreground/50'}`} />
                              <span className={`text-[11px] font-medium ${on ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                                {row.typeLabel}
                              </span>
                            </div>
                            {row.countdown && (
                              <span className={`text-[11px] ${
                                (row.daysUntil ?? 99) < 0 ? 'text-red-500'
                                : (row.daysUntil ?? 99) <= UPCOMING_WINDOW_DAYS ? 'text-amber-500'
                                : 'text-muted-foreground'}`}>
                                {row.countdown}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
      <div className="p-2.5 pt-2 space-y-2">

      {/* ── Calendar ────────────────────────────────────────────────────────
          The section the user asked for: every date that means something to
          act on, with its Type, its Date, an Add-to-Calendar choice, and the
          document it came from. Shown BEFORE confirming, so the decision is
          made with the dates in view rather than discovered afterwards. */}
      {/* The Calendar section and the Financial Records panel below are the
          PRE-PLAN review. With a plan they would be a second, parallel system
          for the same decisions — a date already has its rule action and a
          premium already has its obligation — and two panes proposing the same
          write is how one commitment becomes two records. */}
      {!hasPlan && dateRows.length > 0 && (
        <div className="pt-1.5 border-t border-border/50" data-testid="extraction-calendar-section">
          <div className="flex items-center gap-1.5">
            <Calendar className="h-3.5 w-3.5 text-blue-500" />
            <span className="text-xs text-muted-foreground font-medium">
              Calendar · {dateRows.length} date{dateRows.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="mt-1 space-y-1">
            {dateRows.map((row) => {
              const on = calendarChoice(row);
              const soon = typeof row.daysUntil === 'number' && row.daysUntil <= UPCOMING_WINDOW_DAYS;
              const past = typeof row.daysUntil === 'number' && row.daysUntil < 0;
              return (
                <div
                  key={row.path}
                  className={`rounded-md border px-2 py-1.5 ${
                    past ? 'border-red-500/30 bg-red-500/5'
                    : soon ? 'border-amber-500/30 bg-amber-500/5'
                    : 'border-border/50'}`}
                  data-testid={`calendar-row-${row.key}`}
                >
                  <div className="flex items-start gap-2">
                    <Checkbox
                      checked={on}
                      onCheckedChange={(checked) =>
                        setAddToCalendar((prev) => ({ ...prev, [row.path]: !!checked }))}
                      className="h-3.5 w-3.5 mt-0.5"
                      aria-label={`Add ${row.typeLabel} to calendar`}
                      data-testid={`calendar-section-toggle-${row.key}`}
                    />
                    <div className="min-w-0 flex-1 text-[11px] leading-tight">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-foreground font-medium">{row.typeLabel}</span>
                        <span className="text-muted-foreground tabular-nums">{row.date}</span>
                        {row.countdown && (
                          <span className={past ? 'text-red-500' : soon ? 'text-amber-500' : 'text-muted-foreground'}>
                            · {row.countdown}
                          </span>
                        )}
                      </div>
                      <div className="text-muted-foreground truncate">
                        {row.label} · {docLabel}
                      </div>
                      <div className={on ? 'text-blue-600 dark:text-blue-400' : 'text-muted-foreground'}>
                        {on
                          ? (soon
                              ? `→ Add to Calendar · shows in the Executive Dashboard as due soon`
                              : `→ Add to Calendar`)
                          : '→ Kept on the document only — not on your calendar'}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!hasItems && extraction.trackerEntries && extraction.trackerEntries.length > 0 && (
        <div className="pt-1.5 border-t border-border/50">
          <span className="text-xs text-muted-foreground font-medium">Tracker entries (uncheck to skip):</span>
          {extraction.trackerEntries.map((entry: any, idx: number) => (
            <label key={idx} className="flex items-center gap-2 cursor-pointer ml-1 py-0.5">
              <Checkbox
                checked={selectedTrackers[idx] ?? true}
                onCheckedChange={() => {
                  const next = [...selectedTrackers];
                  next[idx] = !next[idx];
                  setSelectedTrackers(next);
                }}
                className="h-3.5 w-3.5"
              />
              <span className={`text-xs ${selectedTrackers[idx] ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                {(entry.trackerName || '').replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())}:
                {' '}{Object.entries(entry.values || {}).map(([k, v]) => `${v}`).join(', ')} {entry.unit || ''}
              </span>
            </label>
          ))}
        </div>
      )}

      {!hasPlan && extraction.pendingFinancial && (
        <div className="pt-1.5 border-t border-border/50">
          <span className="text-xs text-muted-foreground font-medium">💰 Financial Records</span>
          {extraction.pendingFinancial.expense && (
            <div className="ml-1 py-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox checked={createExpense} onCheckedChange={() => setCreateExpense(!createExpense)} className="h-3.5 w-3.5" />
                <span className={`text-xs ${createExpense ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                  Create expense{!createExpense && expenseDraft ? `: $${expenseDraft.amount} — ${expenseDraft.description}` : ""}
                </span>
              </label>
              {/* Every part of the proposal is editable — amount, description,
                  category, date. What you see here is exactly what saves. */}
              {createExpense && expenseDraft && (
                <div className="mt-1.5 ml-6 space-y-1.5" data-testid="expense-draft-editor">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">$</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      value={expenseDraft.amount}
                      onChange={(e) => setExpenseDraft({ ...expenseDraft, amount: e.target.value })}
                      className="w-24 text-xs bg-background border border-border rounded px-1.5 py-1 text-foreground tabular-nums"
                      data-testid="input-expense-amount"
                      aria-label="Expense amount"
                    />
                    <select
                      value={expenseDraft.category}
                      onChange={(e) => setExpenseDraft({ ...expenseDraft, category: e.target.value })}
                      className="text-xs bg-background border border-border rounded px-1 py-1 text-foreground"
                      data-testid="select-expense-category"
                      aria-label="Expense category"
                    >
                      {(EXPENSE_CATEGORIES as readonly string[]).map((c) => (
                        <option key={c} value={c}>{categoryLabel(c)}</option>
                      ))}
                    </select>
                    <input
                      type="date"
                      value={/^\d{4}-\d{2}-\d{2}$/.test(expenseDraft.date) ? expenseDraft.date : ""}
                      onChange={(e) => setExpenseDraft({ ...expenseDraft, date: e.target.value })}
                      className="text-xs bg-background border border-border rounded px-1.5 py-1 text-foreground"
                      data-testid="input-expense-date"
                      aria-label="Expense date"
                    />
                  </div>
                  <input
                    type="text"
                    value={expenseDraft.description}
                    onChange={(e) => setExpenseDraft({ ...expenseDraft, description: e.target.value })}
                    className="w-full text-xs bg-background border border-border rounded px-1.5 py-1 text-foreground"
                    placeholder="Description"
                    data-testid="input-expense-description"
                    aria-label="Expense description"
                  />
                </div>
              )}
            </div>
          )}
          {extraction.pendingFinancial.obligation && (
            <div className="ml-1 py-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox checked={createObligation} onCheckedChange={() => setCreateObligation(!createObligation)} className="h-3.5 w-3.5" />
                <span className={`text-xs ${createObligation ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                  Update recurring bill: ${extraction.pendingFinancial.obligation.amount.toFixed(2)}/mo — {extraction.pendingFinancial.obligation.name}
                </span>
              </label>
              {/* Says what it can actually do. A new bill is stored as a
                  liability, and document extraction never creates one — so
                  promising "Create recurring bill" here was a promise the
                  server correctly refuses to keep. */}
              <div className="text-[11px] text-muted-foreground leading-tight ml-6">
                Updates a bill you already have. A new one would be a new liability, which extraction never creates.
              </div>
            </div>
          )}
        </div>
      )}

      {/* Manual “Add to Finance” affordance — only when the classifier did NOT
          already produce a pendingFinancial.expense AND we detect a money-
          shaped field (Total / Amount / Price…) in the extracted table. This
          is the missing button the user asked for: a parking receipt with a
          $130.29 Total Amount should always have a one-click path to Finance,
          even if the classifier missed it. */}
      {!hasPlan && !extraction.pendingFinancial?.expense && moneyFieldCandidate && (
        <div className="pt-1.5 border-t border-border/50">
          <span className="text-xs text-muted-foreground font-medium">💰 Add to Finance</span>
          <label className="flex items-center gap-2 cursor-pointer ml-1 py-1" data-testid="manual-add-expense">
            <Checkbox checked={addManualExpense} onCheckedChange={() => setAddManualExpense(!addManualExpense)} className="h-3.5 w-3.5" />
            <span className={`text-xs ${addManualExpense ? 'text-foreground' : 'text-muted-foreground'}`}>
              Save ${moneyFieldCandidate.amount.toFixed(2)} as an expense ({moneyFieldCandidate.label})
            </span>
          </label>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={() => handleConfirm()}
          disabled={
            // Enabled as long as ANYTHING is selected. Requiring a profile
            // field made "just save the $475 total as an expense" impossible —
            // deselect-all + Create expense left a dead Confirm button
            // (2026-08-17 report). The server only needs extractionId; the
            // expense/obligation/tracker saves are independent of the fields.
            confirming || (
              // A plan-driven review has no ticked `items` of its own — the
              // actions are what will be written, so they are what decides
              // whether there is anything to confirm.
              (hasPlan
                ? !actions.some((a) => a.selected && a.operation !== "NO_ACTION")
                : hasItems ? selectedItemCount === 0 : fields.every((f) => !f.selected)) &&
              !createExpense &&
              !createObligation &&
              !addManualExpense &&
              !(hasItems ? false : selectedTrackers.some(Boolean))
            )
          }
        >
          {confirming ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Check className="h-3 w-3 mr-1" />}
          Confirm
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={onSkip}
          disabled={confirming}
        >
          Skip
        </Button>
      </div>
      </div>
    </div>
  );
}
