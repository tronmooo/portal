// ── Extraction Confirmation UI (two-phase extraction) ───────────────────────
//
// Phase 1 — review/edit the extracted rows and pick the destinations.
// Phase 2 — a plain-language summary of exactly what will be saved and where,
//           built from the request payload itself, then Save.
//
// Bug report 2026-08-05: a receipt whose only useful number was the $50 total.
// The user unticked every extracted row (merchant, date, category, receipt
// details, profile info) intending to save just the expense — and Confirm went
// dead, because the gate was `fields.every(f => !f.selected)`. The checklist is
// the PROFILE-extraction selection; it is not the list of things to do. The
// gate now asks buildSavePlan whether at least one destination action is
// selected: expense, profile, document, or any combination.
import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CopyButton } from "@/components/ui/copy-button";
import { Check, Calendar, Loader2, ArrowLeft } from "lucide-react";
import { BROWSER_TIMEZONE } from "@/lib/queryClient";
import { getUserToday } from "@shared/timezone";
import { EXPENSE_CATEGORIES, categoryLabel } from "@shared/category-canon";
import {
  buildSavePlan,
  type ConfirmExtractionPayload,
} from "@shared/extraction-save-plan";
import type { ChatMessage } from "@shared/schema";

export type ExtractionConfirmPayload = ConfirmExtractionPayload & {
  extractionId: string;
  confirmedFields: Array<{ key: string; value: any }>;
  createCalendarEvents: Array<{ field: string; date: string; title: string; category: string }>;
  trackerEntries: any[];
};

// Trackable PROFILE fields (height, weight, …) that can ALSO become a
// time-series tracker entry. Bug fix: "create tracker for height" used to have
// no effect because height was hard-coded as a profile-only field.
const TRACKABLE_PROFILE_KEYS = new Set([
  'height', 'weight', 'bmi', 'bodyFat', 'bodyFatPercentage',
  'systolic', 'diastolic', 'bloodPressure', 'heartRate', 'pulse',
  'temperature', 'bodyTemperature', 'restingHeartRate', 'oxygenSaturation', 'spo2',
  'glucose', 'bloodGlucose', 'cholesterol', 'totalCholesterol', 'ldl', 'hdl', 'triglycerides',
  'a1c', 'hba1c',
]);
const isTrackableField = (key: string) =>
  TRACKABLE_PROFILE_KEYS.has(key) || /^(height|weight|bp|bmi|temperature|heart_?rate)$/i.test(key);

export function ExtractionConfirmation({
  extraction,
  onConfirm,
  onSkip,
}: {
  extraction: NonNullable<ChatMessage["pendingExtraction"]>;
  onConfirm: (data: ExtractionConfirmPayload) => Promise<boolean>;
  onSkip: () => void;
}) {
  const [fields, setFields] = useState(
    () => extraction.extractedFields.map((f) => ({ ...f }))
  );
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  // Phase 2 — the review screen. Nothing is sent until the user confirms there.
  const [reviewing, setReviewing] = useState(false);
  // Track which tracker entries the user wants to create (all selected by default)
  const [selectedTrackers, setSelectedTrackers] = useState<boolean[]>(
    () => (extraction.trackerEntries || []).map(() => true)
  );
  const [alsoTrack, setAlsoTrack] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const f of extraction.extractedFields) {
      // Default to ON for trackable fields — user almost always wants the time-series too.
      if (isTrackableField(f.key)) init[f.key] = true;
    }
    return init;
  });
  const [selectedProfileId, setSelectedProfileId] = useState<string | undefined>(extraction.targetProfile?.id);
  // Saving the extracted values to a profile is OPTIONAL and independent of
  // the other destinations — a receipt can produce an expense and nothing else.
  const [saveToProfile, setSaveToProfile] = useState(true);
  // Keeping the original file as a document is itself a destination action.
  const [saveDocument, setSaveDocument] = useState(true);
  const [createExpense, setCreateExpense] = useState(!!extraction.pendingFinancial?.expense);
  const [createObligation, setCreateObligation] = useState(!!extraction.pendingFinancial?.obligation);

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

  // Bulk toggle for the review-table header. Deselecting every row is a
  // legitimate end state (save the expense only), so this never re-selects
  // anything on its own.
  const allSelected = fields.length > 0 && fields.every((f) => f.selected);
  const toggleAllFields = () => {
    const next = !allSelected;
    setFields((prev) => prev.map((f) => ({ ...f, selected: next })));
    setSelectedTrackers((prev) => prev.map(() => next));
  };

  // Heuristic: when the upstream classifier did NOT route this document as an
  // expense, but the user can still see a money-shaped "Total" / "Amount"
  // field in the extracted table, we want a one-click way to push that number
  // into Finance — even if the row itself is deselected, because the total is
  // exactly what the user wants when everything else is off.
  const moneyFieldCandidate = useMemo(() => {
    if (extraction.pendingFinancial?.expense) return null;
    const moneyKeyRe = /(total|amount|price|charge|fee|cost|payment|balance|due|paid|subtotal|grand_?total)/i;
    let best: { amount: number; label: string; key: string; __rank: number } | null = null;
    for (const f of fields) {
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
  }, [fields, extraction.pendingFinancial]);
  // "Add to Finance" toggle — only meaningful when moneyFieldCandidate exists.
  const [addManualExpense, setAddManualExpense] = useState(false);

  const vendorGuess = useMemo(() => {
    const f = fields.find((x) => /vendor|merchant|company|provider|payee|store/i.test(String(x.key || '')));
    return f?.value ? String(f.value) : "";
  }, [fields]);
  const dateGuess = useMemo(() => {
    const f = fields.find((x) => /transaction.?date|purchase.?date|date$|paid/i.test(String(x.key || '')));
    const raw = f?.value ? String(f.value) : "";
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
  }, [fields]);

  // ONE editable expense draft, whether the proposal came from the classifier
  // or from the money-shaped field we detected. Every part of it is editable —
  // amount, category, payment date, description — and what is in the draft is
  // exactly what gets saved. (Bug report: the AI proposed $84.97 while the
  // receipt's Total Amount 92.40 sat in the checklist with no way to correct it.)
  const [expenseDraft, setExpenseDraft] = useState(() => {
    const e = extraction.pendingFinancial?.expense;
    return {
      description: String(e?.description ?? ""),
      amount: String(e?.amount ?? ""),
      category: String(e?.category ?? "general"),
      date: String(e?.date ?? ""),
      vendor: String(e?.vendor ?? ""),
    };
  });
  // Seed the manual draft from the detected total the first time the user opts
  // in, without clobbering anything they have already typed.
  const enableManualExpense = (on: boolean) => {
    setAddManualExpense(on);
    if (on && moneyFieldCandidate && !expenseDraft.amount) {
      setExpenseDraft((prev) => ({
        ...prev,
        amount: String(moneyFieldCandidate.amount),
        description: prev.description
          || `${vendorGuess || extraction.label || extraction.fileName} - ${moneyFieldCandidate.label}`,
        vendor: prev.vendor || vendorGuess,
        date: prev.date || dateGuess || getUserToday(BROWSER_TIMEZONE),
      }));
    }
  };

  const expenseSelected = (createExpense && !!extraction.pendingFinancial?.expense) || addManualExpense;

  const selectedProfile = useMemo(
    () => allProfiles.find((p: any) => p.id === selectedProfileId),
    [allProfiles, selectedProfileId],
  );
  const profileName = selectedProfile?.name || extraction.targetProfile?.name;

  // The payload the Save button will POST. The review screen is rendered from
  // THIS object, so what the user reads and what the server receives cannot
  // drift apart, and anything deselected is absent from both.
  const payload = useMemo<ExtractionConfirmPayload>(() => {
    const confirmedFields = fields.filter((f) => f.selected && f.key).map((f) => {
      const key = f.key === 'dob' ? 'dateOfBirth' : f.key;
      return { key, value: f.value };
    });
    const createCalendarEvents = fields
      .filter((f) => f.selected && f.isDate && f.suggestedEvent && f.key && f.value)
      .map((f) => ({
        field: f.key,
        date: String(f.value),
        title: f.suggestedEvent!,
        category: /expir|renew/i.test(f.key || "") ? "finance" : /appoint|visit/i.test(f.key || "") ? "health" : "other",
      }));

    // Synthetic tracker entries from the trackable profile fields the user
    // opted into — makes the inline "Also track over time" checkbox real.
    const syntheticTrackerEntries = fields
      .filter((f) => f.selected && f.key && alsoTrack[f.key])
      .map((f) => {
        const rawStr = String(f.value ?? '').trim();
        let numValue: number | null = null;
        let unit = '';
        if (/^(\d+)'\s*(\d+)?\"?$/.test(rawStr)) {
          const m = rawStr.match(/^(\d+)'\s*(\d+)?\"?$/)!;
          numValue = parseInt(m[1], 10) * 12 + parseInt(m[2] || '0', 10);
          unit = 'in';
        } else if (/^(\d+(\.\d+)?)\s*(lbs?|kg|cm|in|mmHg|bpm|°F|°C|mg\/dL|%)?$/i.test(rawStr)) {
          const m = rawStr.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z%°\/]*)$/)!;
          numValue = parseFloat(m[1]);
          unit = (m[2] || '').toLowerCase();
        } else if (/^\d+\/\d+$/.test(rawStr)) {
          const [sys, dia] = rawStr.split('/').map((n) => parseInt(n, 10));
          return {
            trackerName: 'Blood Pressure',
            values: { systolic: sys, diastolic: dia },
            unit: 'mmHg',
            category: 'health',
            __fromProfileField: f.key,
          };
        } else {
          const n = parseFloat(rawStr);
          if (!isNaN(n)) numValue = n;
        }
        if (numValue === null) return null;
        if (!unit) {
          if (/height/i.test(f.key)) unit = 'in';
          else if (/weight/i.test(f.key)) unit = 'lbs';
          else if (/temperature/i.test(f.key)) unit = '°F';
          else if (/heart_?rate|pulse/i.test(f.key)) unit = 'bpm';
        }
        const niceName = (f.label || f.key).replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
        return {
          trackerName: niceName,
          values: { value: numValue },
          unit,
          category: 'health',
          __fromProfileField: f.key,
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    // The draft IS the expense — classifier proposal or manual total alike.
    let expensePayload: any = undefined;
    if (expenseSelected) {
      const proposed = extraction.pendingFinancial?.expense;
      const amount = parseFloat(String(expenseDraft.amount).replace(/[$,\s]/g, ""));
      expensePayload = {
        ...(proposed || {}),
        description: expenseDraft.description.trim()
          || proposed?.description
          || `${vendorGuess || extraction.label || extraction.fileName}`,
        amount: isFinite(amount) ? amount : proposed?.amount,
        category: expenseDraft.category || proposed?.category || 'general',
        date: expenseDraft.date || proposed?.date || getUserToday(BROWSER_TIMEZONE),
        vendor: expenseDraft.vendor.trim() || proposed?.vendor || vendorGuess || undefined,
        // Owner/profile the expense is attributed to — the picker above.
        profileId: selectedProfileId || extraction.targetProfile?.id,
      };
    }

    return {
      extractionId: extraction.extractionId,
      confirmedFields,
      targetProfileId: selectedProfileId || extraction.targetProfile?.id,
      saveToProfile,
      saveDocument,
      createCalendarEvents,
      trackerEntries: [
        ...(extraction.trackerEntries || []).filter((_: any, i: number) => selectedTrackers[i]),
        ...syntheticTrackerEntries,
      ],
      createExpense: expensePayload,
      createObligation: createObligation ? extraction.pendingFinancial?.obligation : undefined,
    };
  }, [
    fields, alsoTrack, selectedTrackers, selectedProfileId, saveToProfile, saveDocument,
    expenseSelected, expenseDraft, createObligation, extraction, vendorGuess,
  ]);

  // What will be saved and where — the single source of truth for both the
  // Continue/Save gate and the review screen.
  const plan = useMemo(
    () => buildSavePlan(payload, {
      profileName,
      documentLabel: extraction.label || extraction.fileName,
      fieldLabels: Object.fromEntries(fields.map((f) => [f.key, f.label || f.key])),
      deselectedLabels: fields.filter((f) => !f.selected).map((f) => f.label || f.key),
    }),
    [payload, profileName, fields, extraction.label, extraction.fileName],
  );

  const handleConfirm = async () => {
    setConfirming(true);
    const success = await onConfirm(payload);
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

  // ── Phase 2: review ────────────────────────────────────────────────────────
  if (reviewing) {
    return (
      <div
        className="mt-3 rounded-lg bg-muted/40 border border-border overflow-hidden text-foreground"
        data-testid="extraction-review"
      >
        <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border bg-muted/60">
          <span className="micro-label text-muted-foreground">
            Review — this is what will be saved
          </span>
        </div>
        <div className="p-2.5 space-y-2">
          {plan.destinations.map((dest) => (
            <div
              key={dest.id}
              className="rounded-md border border-border bg-background px-2 py-1.5"
              data-testid={`review-destination-${dest.id}`}
            >
              <div className="text-xs font-semibold text-foreground">{dest.where}</div>
              <div className="text-[11px] text-muted-foreground">{dest.summary}</div>
              <ul className="mt-1 space-y-0.5">
                {dest.items.map((item, i) => (
                  <li key={i} className="text-[11px] text-foreground flex gap-1.5">
                    <span className="text-muted-foreground">•</span>
                    <span className="break-words">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {plan.notSaved.length > 0 && (
            <div
              className="rounded-md border border-dashed border-border px-2 py-1.5"
              data-testid="review-not-saved"
            >
              <div className="text-xs font-semibold text-muted-foreground">Not saved</div>
              <div className="text-[11px] text-muted-foreground break-words">
                {plan.notSaved.join(", ")}
              </div>
            </div>
          )}

          {plan.blockers.length > 0 && (
            <div className="text-[11px] text-destructive" data-testid="review-blockers">
              {plan.blockers.join(" ")}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => handleConfirm()}
              disabled={confirming || !plan.canSave}
              data-testid="button-confirm-extraction-save"
            >
              {confirming ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Check className="h-3 w-3 mr-1" />}
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => setReviewing(false)}
              disabled={confirming}
              data-testid="button-review-back"
            >
              <ArrowLeft className="h-3 w-3 mr-1" />
              Back
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Excel/spreadsheet-friendly TSV (Field<TAB>Value) of all extracted fields so
  // the user can paste the whole table straight into a sheet.
  const buildTsv = () =>
    "Field\tValue\n" +
    fields.map((f) => {
      const v = typeof f.value === 'object' && f.value !== null
        ? JSON.stringify(f.value)
        : String(f.value ?? '');
      return `${f.label || f.key}\t${v}`;
    }).join("\n");

  const selectedCount = fields.filter((f) => f.selected).length;

  return (
    <div className="mt-3 rounded-lg bg-muted/40 border border-border overflow-hidden text-foreground">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border bg-muted/60 flex-wrap">
        <span className="micro-label text-muted-foreground">
          Review extracted data · {fields.length}
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
            aria-label="Owner profile"
          >
            <option value="">Link to profile…</option>
            {allProfiles.slice().sort((a: any, b: any) => (a.name || '').localeCompare(b.name || '')).map((p: any) => (
              <option key={p.id} value={p.id}>{p.name}{p.type === 'self' ? ' (me)' : ` (${p.type})`}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Excel-style grid: tight rows, column lines, header row */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-muted/40 micro-label text-muted-foreground">
              <th className="w-7 border-b border-border px-1 py-1 font-medium"></th>
              <th className="border-b border-border px-2 py-1 text-left font-medium">Field</th>
              <th className="border-b border-border px-2 py-1 text-left font-medium">Value</th>
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
                      data-testid={`field-checkbox-${field.key}`}
                      aria-label={field.label || field.key}
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
                    {field.selected && field.key && isTrackableField(field.key) && (
                      <label
                        className="flex items-center gap-1 mt-0.5 cursor-pointer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Checkbox
                          checked={!!alsoTrack[field.key]}
                          onCheckedChange={(checked) =>
                            setAlsoTrack((prev) => ({ ...prev, [field.key]: !!checked }))
                          }
                          className="h-3 w-3"
                          data-testid={`also-track-${field.key}`}
                        />
                        <span className="text-[11px] text-muted-foreground">Also track over time</span>
                      </label>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="p-2.5 pt-2 space-y-2">

      {/* ── Where this goes ─────────────────────────────────────────────────
          Each row below is an independent destination. None of them requires
          any of the others, so a receipt can save a single expense with every
          extracted row deselected. */}
      <div className="pt-1.5 border-t border-border/50" data-testid="save-destinations">
        <span className="text-xs text-muted-foreground font-medium">Where this gets saved</span>
        <label className="flex items-start gap-2 cursor-pointer ml-1 py-1" data-testid="toggle-save-to-profile">
          <Checkbox
            checked={saveToProfile}
            onCheckedChange={() => setSaveToProfile(!saveToProfile)}
            className="h-3.5 w-3.5 mt-0.5"
            aria-label="Save selected information to a profile"
          />
          <span className={`text-xs ${saveToProfile ? 'text-foreground' : 'text-muted-foreground'}`}>
            Save selected information to {profileName || "a profile"}
            <span className="block text-[11px] text-muted-foreground">
              {selectedCount > 0
                ? `${selectedCount} ticked field${selectedCount === 1 ? '' : 's'} above`
                : 'Nothing ticked above — no profile data will be saved'}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 cursor-pointer ml-1 py-1" data-testid="toggle-save-document">
          <Checkbox
            checked={saveDocument}
            onCheckedChange={() => setSaveDocument(!saveDocument)}
            className="h-3.5 w-3.5 mt-0.5"
            aria-label="Save the original as a document"
          />
          <span className={`text-xs ${saveDocument ? 'text-foreground' : 'text-muted-foreground'}`}>
            Save the original as a document
            <span className="block text-[11px] text-muted-foreground">
              {saveDocument
                ? `Keeps ${extraction.label || extraction.fileName} with the values you kept`
                : 'The file stays in Documents, but no extracted values are written to it'}
            </span>
          </span>
        </label>
      </div>

      {extraction.trackerEntries && extraction.trackerEntries.length > 0 && (
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

      {/* Finance — the expense proposal (classifier) or the detected total
          (manual). Either way it is ONE editable draft, and ticking it is a
          complete destination on its own. */}
      {(extraction.pendingFinancial?.expense || moneyFieldCandidate || extraction.pendingFinancial?.obligation) && (
        <div className="pt-1.5 border-t border-border/50">
          <span className="text-xs text-muted-foreground font-medium">💰 Finance</span>
          {extraction.pendingFinancial?.expense ? (
            <div className="ml-1 py-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={createExpense}
                  onCheckedChange={() => setCreateExpense(!createExpense)}
                  className="h-3.5 w-3.5"
                  aria-label="Save the total as an expense"
                />
                <span className={`text-xs ${createExpense ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                  Save the total as an expense{!createExpense && expenseDraft.amount ? `: $${expenseDraft.amount} — ${expenseDraft.description}` : ""}
                </span>
              </label>
            </div>
          ) : moneyFieldCandidate ? (
            <label className="flex items-center gap-2 cursor-pointer ml-1 py-1" data-testid="manual-add-expense">
              <Checkbox
                checked={addManualExpense}
                onCheckedChange={(checked) => enableManualExpense(!!checked)}
                className="h-3.5 w-3.5"
                aria-label="Save the total as an expense"
              />
              <span className={`text-xs ${addManualExpense ? 'text-foreground' : 'text-muted-foreground'}`}>
                Save ${moneyFieldCandidate.amount.toFixed(2)} as an expense ({moneyFieldCandidate.label})
              </span>
            </label>
          ) : null}

          {/* Every part of the expense is editable — amount, category, payment
              date, merchant, description. What you see here is what saves. */}
          {expenseSelected && (
            <div className="mt-1.5 ml-6 space-y-1.5" data-testid="expense-draft-editor">
              <div className="flex items-center gap-1.5 flex-wrap">
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
                  aria-label="Expense payment date"
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
              <div className="text-[11px] text-muted-foreground">
                Charged to {profileName || "your profile"}
              </div>
            </div>
          )}

          {extraction.pendingFinancial?.obligation && (
            <label className="flex items-center gap-2 cursor-pointer ml-1 py-1">
              <Checkbox checked={createObligation} onCheckedChange={() => setCreateObligation(!createObligation)} className="h-3.5 w-3.5" />
              <span className={`text-xs ${createObligation ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                Create recurring bill: ${Number(extraction.pendingFinancial.obligation.amount).toFixed(2)}/mo — {extraction.pendingFinancial.obligation.name}
              </span>
            </label>
          )}
        </div>
      )}

      <div className="flex gap-2 pt-1 items-center flex-wrap">
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={() => setReviewing(true)}
          // The ONLY precondition is a destination: expense, profile,
          // document, calendar, tracker — or any combination. Ticked
          // extraction rows are not required.
          disabled={confirming || !plan.canSave}
          data-testid="button-confirm-extraction"
        >
          <Check className="h-3 w-3 mr-1" />
          Continue
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
        {!plan.canSave && (
          <span className="text-[11px] text-muted-foreground" data-testid="no-destination-hint">
            Pick at least one place to save this — an expense, a profile, or the document.
          </span>
        )}
      </div>
      </div>
    </div>
  );
}

export default ExtractionConfirmation;
