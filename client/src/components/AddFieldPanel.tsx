// ── "Add field": Field | Value | Add, on any profile ────────────────────────
// Owner, 2026-11-21: the person Info page's Add field is the simple way to add
// a detail; asset and liability profiles get the exact same thing. A field is
// written with the same PATCH the Info page uses, and removed with the
// explicit `fieldsToDelete` signal (the storage layer merges `fields`, so
// omitting a key removes nothing).
//
// `showFields` also lists the free-form fields a page doesn't show anywhere
// else (a liability's Overview has no field list), each tap-to-change and X to
// remove (two taps, Rule 8). Money, rate, date and ownership fields are NOT listed here:
// they have their own editors (L2/L3 — a rate typed as text would lose its
// unit marker).
import { useEffect, useState, type ReactNode } from "react";
import { Check, Pencil, Plus, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateDomains } from "@/lib/cache-bus";
import { useToast } from "@/hooks/use-toast";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import { formatApiError } from "@/lib/formatError";
import { isReservedFieldKey } from "@shared/profile-field-identity";
import { fieldSemantics, isAdministrativeKey } from "@shared/overview-semantics";
import { humanizeFieldName } from "@shared/field-label";
import { canonicalFieldKey } from "@shared/profile-field-canon";

// Money, rates, due days, dates, ownership shares and coverage limits have
// their own editors; everything else a person typed is listed here.
//
// "Has its own editor" is decided by the KEY being one the screens own, or by
// the VALUE being a figure or a date — never by the name merely sounding
// financial. The role alone hid "Loan number: HF-88213", "Payment method: ACH"
// and "Interest type: Fixed": saved, then nowhere on the page (2026-11-23).
const OWN_EDITOR_ROLES = new Set(["financial", "date", "ownership", "coverage"]);
// The canonical money/rate keys (and every alias that folds into them, L2).
const OWN_EDITOR_CANON = new Set(["balance", "interestRate", "monthlyPayment", "originalBalance", "currentValue", "purchasePrice"]);
// Settings the liability screens own (schedule, type, Auto Pay state, terms).
const SCREEN_OWNED_KEYS = new Set([
  "frequency", "billingfrequency", "liabilitytype", "subtype", "category", "liabilitycategory",
  "paymentstatus", "status", "autopay", "autorenew", "paused", "pauseduntil", "recurrence",
  "recurrenceend", "occurrences", "remindme", "reminderleaddays", "ownername", "loan", "finance",
  // Shown (and edited) as a row of the liability's own details.
  "lender", "creditor", "servicer",
  // Terms and schedule: the loan-terms / bill-details forms write these.
  "dueday", "paymentdueday", "duedate", "nextduedate", "firstpaymentdate", "loanstartdate", "startdate",
  "lastpaymentdate", "lastpaid", "autorecordsince", "termmonths", "remainingtermmonths", "loantermmonths",
  "term", "count", "amount", "cost", "principal", "minimumpayment", "minpayment", "creditlimit", "extrapayment",
]);
const FIGURE_RE = /^[\s$€£]*-?[\d,]+(\.\d+)?\s*%?$/;
const DATE_VALUE_RE = /^\d{4}-\d{2}(-\d{2})?([T ].*)?$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
// A name that says the value is a label, not an amount ("Loan number: 88213").
const LABEL_NAME_RE = /(number|num|no|id|code|ref|reference|vin|phone|method|type|name|note|notes|contact|plan|website|url|email)$/i;

// Where a record came from is the app's bookkeeping, not a detail the user
// typed: a liability converted from a bill carried "Source: obligation" and
// "Obligation ID: 2b6ad3c2-…" as two cards on its page (owner, 2026-11-22).
const PROVENANCE_ID_KEYS = new Set(["obligationid", "sourceid", "sourceobligationid", "legacyid", "externalid"]);
const PROVENANCE_SOURCES = new Set(["obligation", "chat", "manual", "import", "document", "migration", "plaid", "ai", "system"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isProvenanceField(key: string, value: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z]/g, "");
  if (PROVENANCE_ID_KEYS.has(k)) return true;
  if (k === "source" && PROVENANCE_SOURCES.has(value.trim().toLowerCase())) return true;
  // A bare record id is never something a person typed in as a detail.
  return k.endsWith("id") && UUID_RE.test(value.trim());
}

/** The plain text fields a page can list and edit as text. */
export function freeFormFieldEntries(fields: Record<string, unknown> | null | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(fields || {})) {
    if (k.startsWith("_") || isReservedFieldKey(k) || isAdministrativeKey(k)) continue;
    if (v === null || v === undefined || v === "" || typeof v === "object") continue;
    // Numbers are amounts/counts and booleans are switches — both have their
    // own editors; typing over one as text would change its type.
    if (typeof v !== "string") continue;
    if (SCREEN_OWNED_KEYS.has(k.toLowerCase().replace(/[^a-z]/g, ""))) continue;
    if (OWN_EDITOR_CANON.has(canonicalFieldKey(k))) continue;
    const role = fieldSemantics(k, v).role;
    if (role === "administrative") continue;
    if (OWN_EDITOR_ROLES.has(role)) {
      // A figure or a date stored as text still belongs to its own editor;
      // words under a financial-sounding name are the user's own detail.
      const label = LABEL_NAME_RE.test(k.replace(/[^a-zA-Z]/g, ""));
      if (DATE_VALUE_RE.test(v.trim())) continue;
      if (!label && FIGURE_RE.test(v)) continue;
    }
    if (isProvenanceField(k, v)) continue;
    out.push([k, v]);
  }
  return out;
}

function useProfileFieldWrites(profileId: string) {
  const { toast } = useToast();
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
    queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "overview"] });
    queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId] });
    void invalidateDomains("profiles");
  };
  const save = async (key: string, value: string) => {
    try {
      await apiRequest("PATCH", `/api/profiles/${profileId}`, { fields: { [key]: value } });
      refresh();
      return true;
    } catch (err: any) {
      toast({ title: "Failed to save", description: formatApiError(err), variant: "destructive" });
      return false;
    }
  };
  const remove = async (key: string) => {
    try {
      await apiRequest("PATCH", `/api/profiles/${profileId}`, { fieldsToDelete: [key] });
      refresh();
    } catch (err: any) {
      toast({ title: "Failed to remove", description: formatApiError(err), variant: "destructive" });
    }
  };
  return { save, remove };
}

export function AddFieldPanel({
  profileId, fields, showFields = false, title, openSignal, hideHeader = false, rows: rowLayout = false, list = false, leading, emptyHint,
  inline = false, onAdded,
}: {
  /** The form itself, always open, with no "Add field" button of its own —
   *  for a caller whose own control opens it (the asset's Profile actions). */
  inline?: boolean;
  onAdded?: () => void;
  /** The page draws its own heading and Add button (it bumps `openSignal`). */
  hideHeader?: boolean;
  /** List the fields as two-column rows, matching a page's detail rows. */
  rows?: boolean;
  /** List the fields as label | value | pencil | X lines (a "Characteristics" card). */
  list?: boolean;
  /** Rows the page puts at the top of the list (a linked record, say). */
  leading?: ReactNode;
  /** Shown in the list layout when there is nothing to list. */
  emptyHint?: string;
  /** Bump to open the Field | Value form from outside (a page's "Add custom field" action). */
  openSignal?: number;
  profileId: string;
  fields?: Record<string, unknown> | null;
  showFields?: boolean;
  title?: string;
}) {
  const { save, remove } = useProfileFieldWrites(profileId);
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (openSignal) setAdding(true); }, [openSignal]);
  const rows = showFields ? freeFormFieldEntries(fields) : [];

  const add = async () => {
    const k = newKey.trim();
    const v = newVal.trim();
    if (!k || !v) return;
    setSaving(true);
    const ok = await save(k, v);
    setSaving(false);
    if (ok) { setNewKey(""); setNewVal(""); setAdding(false); onAdded?.(); }
  };

  return (
    <div className={hideHeader && !list && !adding && rows.length === 0 ? "hidden" : "space-y-2"} data-testid="add-field-panel">
      {!hideHeader && !inline && <div className="flex items-center justify-between gap-2">
        <p className="micro-label text-muted-foreground px-0.5">{title || ""}</p>
        <Button variant="outline" size="sm" className="h-8 gap-1 text-xs" onClick={() => setAdding((a) => !a)} data-testid="add-field-button">
          <Plus className="h-3.5 w-3.5" /> Add field
        </Button>
      </div>}

      {(adding || inline) && (
        <Card className="p-3 flex flex-wrap items-end gap-2" data-testid="add-field-form">
          <div className="flex-1 min-w-[120px]">
            <label className="micro-label text-muted-foreground" htmlFor={`add-field-key-${profileId}`}>Field</label>
            <Input id={`add-field-key-${profileId}`} value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="e.g. Nickname" className="h-8 text-xs" maxLength={60} data-testid="add-field-key" />
          </div>
          <div className="flex-1 min-w-[120px]">
            <label className="micro-label text-muted-foreground" htmlFor={`add-field-val-${profileId}`}>Value</label>
            <Input id={`add-field-val-${profileId}`} value={newVal} onChange={(e) => setNewVal(e.target.value)} placeholder="Value" className="h-8 text-xs"
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }} data-testid="add-field-value" />
          </div>
          <Button size="sm" className="h-8 text-xs" disabled={saving || !newKey.trim() || !newVal.trim()} onClick={() => void add()} data-testid="add-field-save">
            {saving ? "…" : "Add"}
          </Button>
          {!inline && (
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => { setAdding(false); setNewKey(""); setNewVal(""); }} data-testid="add-field-cancel">
              Cancel
            </Button>
          )}
        </Card>
      )}

      {list && (
        <div className="divide-y divide-foreground/10" data-testid="add-field-list">
          {leading}
          {rows.map(([k, v]) => (
            <FieldLine key={k} fieldKey={k} label={humanizeFieldName(k)} value={v} onSave={(nv) => save(k, nv)} onRemove={() => remove(k)} />
          ))}
          {rows.length === 0 && !leading && emptyHint && !adding && (
            <p className="py-2 text-[13px] text-muted-foreground" data-testid="add-field-empty">{emptyHint}</p>
          )}
        </div>
      )}

      {!list && rows.length > 0 && (
        <div className={rowLayout ? "grid grid-cols-2 gap-2" : "grid grid-cols-2 sm:grid-cols-3 gap-2"} data-testid="add-field-list">
          {rows.map(([k, v]) => (
            <FieldCard key={k} row={rowLayout} wide={rowLayout && rows.length % 2 === 1 && k === rows[rows.length - 1][0]} fieldKey={k} label={humanizeFieldName(k)} value={v} onSave={(nv) => save(k, nv)} onRemove={() => remove(k)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One characteristic: label | value | pencil | X (two taps, Rule 8). */
function FieldLine({ fieldKey, label, value, onSave, onRemove }: {
  fieldKey: string; label: string; value: string;
  onSave: (v: string) => Promise<boolean>; onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const { confirm, isArmed } = useConfirmArm();
  const armKey = `rm-${fieldKey}`;
  const commit = async () => {
    const t = draft.trim();
    if (!t || t === value) { setEditing(false); return; }
    if (await onSave(t)) setEditing(false);
  };
  return (
    <div className="flex items-center gap-2 py-1.5 min-w-0" data-testid={`add-field-cell-${fieldKey}`}>
      <span className="w-[38%] shrink-0 text-[13px] text-muted-foreground leading-tight break-words">{label}</span>
      {editing ? (
        <>
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} className="h-8 text-[13px] flex-1 min-w-0" autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") void commit(); if (e.key === "Escape") { setDraft(value); setEditing(false); } }}
            data-testid={`add-field-edit-${fieldKey}`} />
          <button onClick={() => void commit()} className="grid h-7 w-7 shrink-0 place-items-center text-emerald-500" aria-label="Save"><Check className="h-4 w-4" /></button>
          <button onClick={() => { setDraft(value); setEditing(false); }} className="grid h-7 w-7 shrink-0 place-items-center text-muted-foreground" aria-label="Cancel"><X className="h-4 w-4" /></button>
        </>
      ) : (
        <>
          <button type="button" className="flex-1 min-w-0 text-left text-[14px] font-medium break-words" onClick={() => { setDraft(value); setEditing(true); }} title={`Edit ${label}`}>{value}</button>
          <button type="button" onClick={() => { setDraft(value); setEditing(true); }} aria-label={`Edit ${label}`}
            className="pressable grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5" data-testid={`add-field-pencil-${fieldKey}`}>
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => confirm(armKey, onRemove)}
            className={`h-7 min-w-7 px-1 shrink-0 grid place-items-center rounded-md text-[11px] transition-colors ${isArmed(armKey) ? "bg-destructive text-destructive-foreground" : "text-muted-foreground hover:text-destructive hover:bg-destructive/10"}`}
            aria-label={isArmed(armKey) ? `Tap again to remove ${label}` : `Remove ${label}`}
            data-testid={`add-field-remove-${fieldKey}`}
          >{isArmed(armKey) ? "Remove?" : <X className="h-3.5 w-3.5" />}</button>
        </>
      )}
    </div>
  );
}

function FieldCard({ fieldKey, label, value, onSave, onRemove, wide = false, row = false }: {
  fieldKey: string; label: string; value: string; wide?: boolean;
  /** Drawn as one of a page's detail rows (same surface, same type sizes). */
  row?: boolean;
  onSave: (v: string) => Promise<boolean>; onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const { confirm, isArmed } = useConfirmArm();
  const armKey = `rm-${fieldKey}`;
  const commit = async () => {
    const t = draft.trim();
    if (!t || t === value) { setEditing(false); return; }
    if (await onSave(t)) setEditing(false);
  };
  if (editing) {
    return (
      <Card className={`p-2.5 ${wide ? "col-span-2" : ""}`}>
        <label className="micro-label text-muted-foreground">{label}</label>
        <div className="flex items-center gap-1 mt-1">
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} className="h-7 text-xs" autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") void commit(); if (e.key === "Escape") { setDraft(value); setEditing(false); } }}
            data-testid={`add-field-edit-${fieldKey}`} />
          <button onClick={() => void commit()} className="text-emerald-500" aria-label="Save"><Check className="h-4 w-4" /></button>
          <button onClick={() => { setDraft(value); setEditing(false); }} className="text-muted-foreground" aria-label="Cancel"><X className="h-4 w-4" /></button>
        </div>
      </Card>
    );
  }
  const remove = (
    <button
      onClick={(e) => { e.stopPropagation(); confirm(armKey, onRemove); }}
      className={`${row ? "shrink-0" : "absolute top-0.5 right-0.5"} h-6 min-w-6 px-1 grid place-items-center rounded-md text-[11px] transition-colors ${isArmed(armKey) ? "bg-destructive text-destructive-foreground" : "text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10"}`}
      aria-label={isArmed(armKey) ? `Tap again to remove ${label}` : `Remove ${label}`}
      data-testid={`add-field-remove-${fieldKey}`}
    >{isArmed(armKey) ? "Remove?" : <X className="h-3.5 w-3.5" />}</button>
  );
  if (row) {
    return (
      <div
        role="button" tabIndex={0}
        className={`bubble bubble-interactive !rounded-2xl flex items-center gap-2 px-3.5 py-2.5 min-h-[56px] min-w-0 cursor-pointer ${wide ? "col-span-2" : ""}`}
        onClick={() => { setDraft(value); setEditing(true); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDraft(value); setEditing(true); } }}
        data-testid={`add-field-cell-${fieldKey}`}
      >
        <span className="flex-1 min-w-0">
          <span className="block text-[12px] text-muted-foreground leading-tight truncate">{label}</span>
          <span className="block text-[14px] font-semibold leading-snug line-clamp-2 break-words">{value}</span>
        </span>
        {remove}
      </div>
    );
  }
  return (
    <Card className={`p-2.5 relative cursor-pointer hover:border-primary/50 ${wide ? "col-span-2" : ""}`} onClick={() => { setDraft(value); setEditing(true); }} data-testid={`add-field-cell-${fieldKey}`}>
      <div className="micro-label text-muted-foreground pr-6 truncate">{label}</div>
      <div className="text-sm font-medium truncate mt-0.5">{value}</div>
      {remove}
    </Card>
  );
}
