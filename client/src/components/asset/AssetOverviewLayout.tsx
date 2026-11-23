// ─── Asset profile layout (owner's design, 2026-11-23) ──────────────────────
//
// The asset's Overview drawn to the owner's mock-up: the value stats in the
// header, Asset Details as rows, Characteristics and Quick Info beside it, and
// AI Summary next to Value & Depreciation underneath.
//
// Layout only. Every number and row here is read from a store another screen
// already reads, so nothing on this page can disagree with the rest of the app:
//
//   details / dates / suggestions → the composed OverviewSpec (DynamicOverview)
//   current value                 → currentAssetValue (Rule 1): the estimate
//                                   while Portol tracks the value
//   alerts                        → the date-rule engine over this record and
//                                   its documents (Rule 5), dismissed into the
//                                   server's one dismiss list (Rule 8)
//
// A row writes one field with the same PATCH the chat's update_profile uses.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bell, BellOff, Calendar, CalendarPlus, Check, ChevronDown, CircleDot, FileText, Hash,
  MapPin, MoreHorizontal, Package, Pencil, Plus, RefreshCw, ShoppingCart, StickyNote, Tag, Type, Users, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateDomains } from "@/lib/cache-bus";
import { formatApiError } from "@/lib/formatError";
import { formatMoneyCompact, parseLocalDate } from "@/lib/format";
import { localTodayISO } from "@/lib/dates";
import { useToast } from "@/hooks/use-toast";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import { useAssetValuation, useAssetValuationHistory } from "@/hooks/useAssetValuation";
import { useDismissedAlerts } from "@/hooks/useDismissedAlerts";
import { AddFieldPanel } from "@/components/AddFieldPanel";
import { NewNoteForm } from "@/components/notes/NewNoteForm";
import { CurrentValueCard } from "@/components/asset/CurrentValueCard";
import {
  ProvenanceMark, formatValue, renderSection, toneClass, useFieldWrite,
} from "@/components/overview/DynamicOverview";
import { parseMoney, resolveAssetValue } from "@shared/asset-value";
import { currentAssetValue, isAutoValuationEnabled } from "@shared/valuation/context";
import { calendarDelta, countdownLabel, isAlertDateRule, rulesFromAll, type DateRule } from "@shared/date-rules";
import { dateAlertId } from "@shared/alert-ids";
import { fieldSemantics } from "@shared/overview-semantics";
import { humanizeFieldName } from "@shared/field-label";
import type { OverviewSection, OverviewSpec, OverviewValue } from "@shared/overview-spec";

export interface AssetLayoutProfile {
  id: string;
  name: string;
  type: string;
  notes?: string | null;
  fields?: Record<string, any> | null;
}

const PANEL = "bubble !rounded-2xl px-3 py-2.5";
/** The editor a row opens into. */
const TILE_BOX = "rounded-xl bg-muted/30 px-3 py-2.5";
const PURCHASE_PRICE_KEYS = ["purchasePrice", "originalPrice", "costBasis"];
const PURCHASE_DATE_RE = /^(purchase|purchased|acquisition|acquired|bought)[_ ]?(date|on)$|^date[_ ]?(of[_ ]?)?purchased?$/i;
/** Sections with a shape of their own; everything else is a card of fields. */
const SPECIAL = new Set([
  "financialSummary", "progressIndicator", "relationshipSummary", "ownershipSummary", "dateCard",
  "documentSummary", "maintenanceSummary", "miniTimeline", "missingInfo", "aiInsight",
]);

function iconFor(key: string) {
  const k = key.toLowerCase();
  if (/purchase.*price|cost|paid/.test(k)) return ShoppingCart;
  if (/value|worth|price/.test(k)) return Tag;
  if (/date|expir|renew|due|year/.test(k)) return Calendar;
  if (/location|address|city|room/.test(k)) return MapPin;
  if (/note|description/.test(k)) return StickyNote;
  if (/serial|vin|model|number|plate|identifier|sku/.test(k)) return Hash;
  if (/brand|make|manufacturer|category|type/.test(k)) return Package;
  return CircleDot;
}

const isDateKey = (key: string) => fieldSemantics(key, "2026-01-01").role === "date";
function Panel({ title, action, children, testId, grow }: {
  title: string; action?: React.ReactNode; children: React.ReactNode; testId?: string;
  /** Takes the height left in its column, so two columns end on the same line. */
  grow?: boolean;
}) {
  return (
    <section className={`${PANEL} ${grow ? "flex-1" : ""}`} data-testid={testId}>
      <div className="flex items-center justify-between gap-2 min-h-[32px]">
        <h2 className="text-[14px] font-semibold tracking-tight">{title}</h2>
        {action && <div className="flex items-center gap-1.5 shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

// ── Asset Details: one form, edited in line ─────────────────────────────────

const BOX = "h-8 w-full rounded-md border border-border/60 bg-background/40 px-2.5 text-[13px] flex items-center min-w-0";

interface FormCell {
  /** Draft key: "name", "notes", or the stored field key. */
  key: string;
  label: string;
  icon?: any;
  kind?: "text" | "money" | "date" | "long";
  /** What is stored now, as the input shows it. */
  original?: string;
  placeholder?: string;
  /** A cell that is not typed into: Category (the app's label), Ownership (opens its tab). */
  fixed?: React.ReactNode;
  testId?: string;
}

/**
 * Asset Details as the owner drew it: every value in its own box, typed into
 * where it stands, and ONE Save for whatever changed. Opening writes nothing
 * (Rule 3); Save sends only the changed values in a single PATCH — the same
 * `name` / `notes` / `fields` the Edit dialog and the chat's update_profile
 * write — and puts them in the page's cache at once.
 */
function AssetDetailsForm({ profileId, rows, onEdit }: {
  profileId: string; rows: FormCell[][]; onEdit: () => void;
}) {
  const { toast } = useToast();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const cells = rows.flat().filter((c) => !c.fixed);
  const valueOf = (c: FormCell) => edits[c.key] ?? c.original ?? "";
  const changed = cells.filter((c) => c.key in edits && edits[c.key].trim() !== (c.original ?? "").trim());
  const set = (key: string, v: string) => setEdits((e) => ({ ...e, [key]: v }));

  const save = async () => {
    if (changed.length === 0) return;
    const body: Record<string, any> = {};
    const fields: Record<string, string | number> = {};
    const remove: string[] = [];
    for (const c of changed) {
      const v = edits[c.key].trim();
      if (c.key === "name") {
        if (!v) { toast({ title: "A name can't be blank", variant: "destructive" }); return; }
        body.name = v;
      } else if (c.key === "notes") body.notes = v;
      else if (!v) remove.push(c.key);
      // Money is stored as a number, like every other amount the app writes.
      else fields[c.key] = c.kind === "money" ? parseMoney(v) : v;
    }
    if (Object.keys(fields).length) body.fields = fields;
    if (remove.length) body.fieldsToDelete = remove;
    setSaving(true);
    try {
      await apiRequest("PATCH", `/api/profiles/${profileId}`, body);
      // The header and every row show the saved values now, not after a refetch.
      queryClient.setQueryData(["/api/profiles", profileId, "detail"], (old: any) => {
        if (!old) return old;
        const nextFields = { ...(old.fields || {}), ...fields };
        for (const k of remove) delete nextFields[k];
        return { ...old, ...(body.name !== undefined ? { name: body.name } : {}), ...(body.notes !== undefined ? { notes: body.notes } : {}), fields: nextFields };
      });
      setEdits({});
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "overview"] });
      void invalidateDomains("profiles");
    } catch (err: any) {
      toast({ title: "Couldn't save", description: formatApiError(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const control = (c: FormCell) => {
    if (c.fixed) return c.fixed;
    const v = valueOf(c);
    if (c.kind === "long") {
      const limit = Math.max(500, (c.original ?? "").length);
      return (
        <span className="relative block w-full">
          <Input value={v} maxLength={limit} placeholder={c.placeholder} onChange={(e) => set(c.key, e.target.value)}
            className="h-8 text-[13px] pr-14" aria-label={c.label} data-testid={c.testId} />
          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground tabular-nums">{v.length}/{limit}</span>
        </span>
      );
    }
    return (
      <Input value={v} placeholder={c.placeholder ?? "Not set"} onChange={(e) => set(c.key, e.target.value)}
        type={c.kind === "date" ? "date" : "text"} inputMode={c.kind === "money" ? "decimal" : undefined}
        onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
        className="h-8 text-[13px] tabular-nums" aria-label={c.label} data-testid={c.testId} />
    );
  };

  return (
    <section className={`${PANEL} flex-1`} data-testid="asset-details">
      <div className="flex items-center justify-between gap-2 min-h-[32px] mb-1">
        <h2 className="text-[14px] font-semibold tracking-tight">Asset Details</h2>
        <div className="flex items-center gap-1.5 shrink-0">
          {changed.length > 0 && (
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setEdits({})} data-testid="asset-details-undo">Undo</Button>
          )}
          <Button variant="outline" size="sm" className="h-8 text-xs gap-1" onClick={onEdit} data-testid="asset-details-edit">
            <Pencil className="h-3.5 w-3.5" /> Edit
          </Button>
          <Button size="sm" className="h-8 text-xs gap-1 bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
            disabled={saving || changed.length === 0} onClick={() => void save()} data-testid="asset-details-save">
            <Check className="h-3.5 w-3.5" /> {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      <div>
        {rows.map((row, i) => (
          <div key={i} className="flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1 py-1 border-b border-border/30 last:border-b-0">
            {row.map((c, j) => {
              const Icon = c.icon;
              return (
                <div key={c.key} className={`flex items-center gap-2.5 min-w-0 ${j === 0 ? "flex-[1.25_1_0%]" : "flex-1"} basis-full sm:basis-0`}>
                  {j === 0 && Icon && <Icon className="h-[17px] w-[17px] shrink-0 text-muted-foreground" strokeWidth={1.8} />}
                  <span className={`shrink-0 text-[13px] truncate ${j === 0 ? "w-[108px]" : "sm:w-auto w-[135px] pl-[27px] sm:pl-0"}`}>{c.label}</span>
                  <span className="flex-1 min-w-0">{control(c)}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

/** One characteristic: label | value, a pencil to change it, an X to remove it (two taps). */
function CharRow({ profileId, fieldKey, label, display, raw, kind = "text", reason, readOnly, testId, removeTestId }: {
  profileId: string; fieldKey: string; label: string; display: React.ReactNode | null; raw?: string;
  kind?: "text" | "money" | "date"; reason?: string; readOnly?: boolean; testId?: string; removeTestId?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const { confirm, isArmed } = useConfirmArm();
  const write = useFieldWrite(profileId);
  const Icon = iconFor(fieldKey);
  const unset = display == null;
  const save = async () => {
    const text = draft.trim();
    if (!text) return;
    setSaving(true);
    const ok = await write(fieldKey, kind === "money" ? parseMoney(text) : text);
    setSaving(false);
    if (ok) setEditing(false);
  };
  return (
    <div className="flex items-center gap-2.5 min-h-[32px] py-0.5 border-b border-border/30 last:border-b-0" title={unset ? reason : undefined}>
      <Icon className="h-[17px] w-[17px] shrink-0 text-muted-foreground" strokeWidth={1.8} />
      <span className="w-[42%] max-w-[190px] shrink-0 text-[13px] truncate">{label}</span>
      <span className="self-stretch w-px bg-border/40" />
      {editing ? (
        <>
          <Input autoFocus value={draft} type={kind === "date" ? "date" : "text"} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }}
            className="h-7 text-[13px] flex-1 min-w-0" aria-label={label} data-testid={`overview-field-input-${fieldKey}`} />
          <button type="button" className="h-7 w-7 grid place-items-center text-emerald-400 disabled:opacity-50" disabled={saving || !draft.trim()}
            onClick={() => void save()} aria-label={`Save ${label}`} data-testid={`overview-field-save-${fieldKey}`}><Check className="h-4 w-4" /></button>
          <button type="button" className="h-7 w-7 grid place-items-center text-muted-foreground" onClick={() => setEditing(false)} aria-label="Cancel"><X className="h-4 w-4" /></button>
        </>
      ) : (
        <>
          <span className={`flex-1 min-w-0 truncate text-[13px] ${unset ? "text-muted-foreground/70" : "tabular-nums"}`}>{unset ? "Not set" : display}</span>
          {readOnly ? <span data-testid={testId} /> : (
            <button type="button" className="h-7 w-7 grid place-items-center text-muted-foreground hover:text-foreground"
              onClick={() => { setDraft(raw ?? ""); setEditing(true); }} aria-label={`Edit ${label}`} data-testid={testId}>
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {!readOnly && !unset && (
            <button type="button" disabled={saving}
              className={`h-7 min-w-7 px-1 grid place-items-center rounded text-[11px] ${isArmed("rm") ? "bg-destructive text-destructive-foreground" : "text-muted-foreground hover:text-destructive"}`}
              aria-label={isArmed("rm") ? `Tap again to remove ${label}` : `Remove ${label}`} data-testid={removeTestId}
              onClick={() => confirm("rm", async () => { setSaving(true); await write(fieldKey, null); setSaving(false); })}>
              {isArmed("rm") ? "Remove?" : <X className="h-4 w-4" />}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function rawOf(v: OverviewValue): string {
  if (v.value == null) return "";
  const s = String(v.value);
  // A date input only takes a bare calendar day.
  if (v.displayType === "date") return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "";
  return s;
}

const kindOf = (v: OverviewValue): "text" | "money" | "date" =>
  v.displayType === "money" ? "money" : v.displayType === "date" ? "date" : "text";

// ── Value: one answer, shown in the header and in Value & Depreciation ───────

/**
 * What the asset is worth now against what was paid for it. "Now" is
 * currentAssetValue — the estimate while Portol tracks the value, the user's
 * own number once tracking is off — the same answer the Assets list and net
 * worth give (Rule 1).
 */
export function useValuePosition(profile: AssetLayoutProfile) {
  const fields = profile.fields || {};
  const { snapshot, refresh, refreshing } = useAssetValuation(profile.id);
  const auto = snapshot?.mode ? snapshot.mode === "auto" : isAutoValuationEnabled(fields);
  const record = snapshot?.record ?? null;
  const priceKey = PURCHASE_PRICE_KEYS.find((k) => parseMoney(fields[k]) > 0);
  const paid = priceKey ? parseMoney(fields[priceKey]) : 0;
  const now = (auto ? currentAssetValue(fields, record, resolveAssetValue).value : resolveAssetValue(fields)) || 0;
  const hasChange = paid > 0 && now > 0;
  const delta = hasChange ? now - paid : 0;
  const pct = hasChange ? (delta / paid) * 100 : 0;
  const confidence = auto && record && record.confidenceLabel !== "none" ? Math.round(record.confidence * 100) : null;
  return { auto, record, paid, now, hasChange, delta, pct, confidence, refresh, refreshing, supported: snapshot?.supported !== false };
}

const signed = (n: number) => `${n >= 0 ? "+" : "−"}${formatMoneyCompact(Math.abs(n))}`;
const signedPct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}%`;

/** The header's one figure: what it is worth now (the same answer as the Value card). */
export function AssetHeroValue({ profile }: { profile: AssetLayoutProfile }) {
  const v = useValuePosition(profile);
  if (!(v.now > 0)) return null;
  return (
    <span className="text-[16px] font-bold tabular-nums text-emerald-400" title={v.auto ? "Estimated current value" : "Your value"} data-testid="hero-stat-current-value">
      {formatMoneyCompact(v.now)}
    </span>
  );
}

/** Value & Depreciation: the history as a line, the same four numbers as a
 *  table, and — one tap away — how the estimate was made and its switch. */
function ValueCard({ profile }: { profile: AssetLayoutProfile }) {
  const v = useValuePosition(profile);
  const [details, setDetails] = useState(false);
  const history = useAssetValuationHistory(profile.id, v.supported);
  const points = useMemo(() => {
    const past = (history.data || []).filter((h) => h.value != null && h.value > 0).map((h) => Number(h.value)).slice(-5);
    const list = [...(v.paid > 0 ? [v.paid] : []), ...past];
    if (v.now > 0 && list[list.length - 1] !== v.now) list.push(v.now);
    return list;
  }, [history.data, v.paid, v.now]);

  const up = v.delta > 0;
  const tone = up ? "text-emerald-400" : "text-red-400";
  const hi = Math.max(...points, 1), lo = Math.min(...points, hi);
  const xy = points.map((n, i) => {
    const x = points.length === 1 ? 100 : 12 + (i * 176) / (points.length - 1);
    const y = hi === lo ? 40 : 16 + (1 - (n - lo) / (hi - lo)) * 46;
    return [x, y] as const;
  });
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");

  const rows: Array<[string, React.ReactNode, string]> = [
    ["Purchase Price", v.paid > 0 ? formatMoneyCompact(v.paid) : "Not set", v.paid > 0 ? "" : "text-muted-foreground/70 font-normal"],
    [v.auto ? "Current Value" : "Your Value", v.now > 0 ? formatMoneyCompact(v.now) : "Not estimated yet", v.now > 0 ? "text-emerald-400" : "text-muted-foreground/70 font-normal"],
    ...(v.hasChange ? [
      [up ? "Appreciation" : "Depreciation", signed(v.delta), tone],
      ["Change", signedPct(v.pct), tone],
    ] as Array<[string, React.ReactNode, string]> : []),
    ...(v.confidence != null ? [
      ["Confidence", `${v.confidence}%`, v.confidence >= 70 ? "text-emerald-400" : v.confidence >= 45 ? "text-amber-400" : ""],
    ] as Array<[string, React.ReactNode, string]> : []),
  ];

  return (
    <section className={`${PANEL} min-w-0`} data-testid="asset-value-card">
      <div className="flex items-center justify-between gap-2 min-h-[32px]">
        <h2 className="text-[14px] font-semibold tracking-tight">{up ? "Value & Appreciation" : "Value & Depreciation"}</h2>
        {v.auto && v.supported && (
          <Button size="sm" variant="outline" className="h-8 text-xs gap-1" onClick={() => { void v.refresh(); }} disabled={v.refreshing} data-testid="asset-value-refresh">
            <RefreshCw className={`h-3.5 w-3.5 ${v.refreshing ? "animate-spin" : ""}`} />
            {v.refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        )}
      </div>
      <div className={`grid gap-3 items-center ${xy.length >= 2 ? "grid-cols-1 min-[420px]:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]" : "grid-cols-1"}`}>
        {xy.length >= 2 && (
          <svg viewBox="0 0 200 80" className="w-full h-auto max-h-[84px]" preserveAspectRatio="none" role="img" aria-label={`Value from ${formatMoneyCompact(points[0])} to ${formatMoneyCompact(points[points.length - 1])}`}>
            <defs>
              <linearGradient id={`val-fill-${profile.id}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#8b5cf6" stopOpacity="0.38" /><stop offset="1" stopColor="#8b5cf6" stopOpacity="0.03" />
              </linearGradient>
            </defs>
            <path d={`${line} L ${xy[xy.length - 1][0]} 76 L ${xy[0][0]} 76 Z`} fill={`url(#val-fill-${profile.id})`} />
            <path d={line} fill="none" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            {xy.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="3" fill="#c4b5fd" />)}
          </svg>
        )}
        <div className="min-w-0">
          {rows.map(([label, value, cls]) => (
            <div key={label} className="flex items-center justify-between gap-3 py-0.5" data-testid={`asset-value-row-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
              <span className="text-[13px] text-muted-foreground">{label}</span>
              <span className={`text-[13px] font-semibold tabular-nums ${cls}`}>{value}</span>
            </div>
          ))}
          {!v.hasChange && v.paid <= 0 && (
            <p className="text-[12px] text-muted-foreground mt-1">Add a purchase price to see how the value has changed.</p>
          )}
        </div>
      </div>
      {v.supported && (
        <>
          <button type="button" className="mt-2 text-[12px] text-muted-foreground hover:text-foreground flex items-center gap-1"
            onClick={() => setDetails((d) => !d)} data-testid="asset-value-details-toggle">
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${details ? "rotate-180" : ""}`} />
            {v.auto ? "How this is estimated, and automatic tracking" : "Automatic tracking is off — your value, and the last estimate"}
          </button>
          {details && <CurrentValueCard profileId={profile.id} fields={profile.fields} showHistory className="mt-2" />}
        </>
      )}
    </section>
  );
}

// ── Alerts: this record's dated fields, through the one rule engine ──────────

export interface RecordAlert { id: string; rule: DateRule; title: string; when: string; cleared: boolean }

/**
 * The dates on this record (and its documents) that raise alerts, and whether
 * each is dismissed. The profile is read from the unflattened list row: the
 * alert id carries the field's stored path, and the bell builds it from that
 * same row.
 */
export function useRecordAlerts(profileId: string) {
  const { data: profiles } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then((r) => r.json()),
  });
  const docsQuery = useQuery<any[]>({
    queryKey: ["/api/profiles", profileId, "documents"],
    queryFn: () => apiRequest("GET", `/api/profiles/${profileId}/documents`).then((r) => r.json()),
    enabled: !!profileId,
    staleTime: 60_000,
  });
  const { idSet, dismiss, restore } = useDismissedAlerts();
  const documents = useMemo(() => (Array.isArray(docsQuery.data) ? docsQuery.data : []), [docsQuery.data]);
  const row = useMemo(() => (Array.isArray(profiles) ? profiles.find((p) => p?.id === profileId) : null), [profiles, profileId]);

  const alerts = useMemo<RecordAlert[]>(() => {
    const today = localTodayISO();
    return rulesFromAll({ profiles: row ? [row] : [], documents })
      .filter((r) => r.active && isAlertDateRule(r))
      .map((rule) => {
        const id = dateAlertId({
          sourceEntityType: rule.sourceEntityType, sourceEntityId: rule.sourceEntityId,
          path: rule.sourcePath || rule.sourceField, date: rule.date,
        });
        const title = rule.sourceEntityType === "document"
          ? (rule.subtitle || rule.label)
          : humanizeFieldName(rule.sourceField);
        return { id, rule, title, when: countdownLabel(rule.date, today, rule.ruleType), cleared: idSet.has(id) };
      })
      .filter((a) => a.id)
      .sort((a, b) => a.rule.date.localeCompare(b.rule.date));
  }, [row, documents, idSet]);

  return { alerts, documents, documentsQuery: docsQuery, dismiss, restore };
}

const COMMON_DATES: Array<{ key: string; label: string }> = [
  { key: "warrantyExpiration", label: "Warranty expiration" },
  { key: "insuranceExpiration", label: "Insurance expiration" },
  { key: "registrationExpiration", label: "Registration expiration" },
];

function AddDateForm({ profileId, options, onDone }: {
  profileId: string; options: Array<{ key: string; label: string }>; onDone: () => void;
}) {
  const [choice, setChoice] = useState(options[0]?.key ?? "__custom");
  const [custom, setCustom] = useState("");
  const [date, setDate] = useState("");
  const [saving, setSaving] = useState(false);
  const write = useFieldWrite(profileId);
  const key = choice === "__custom" ? custom.trim() : choice;
  const save = async () => {
    if (!key || !date) return;
    setSaving(true);
    const ok = await write(key, date);
    setSaving(false);
    if (ok) onDone();
  };
  return (
    <div className={`${TILE_BOX} ring-1 ring-primary/40 space-y-2`} data-testid="asset-add-date-form">
      <p className="text-[12px] text-muted-foreground">
        An expiration or renewal raises an alert before it arrives. Every date shows on your calendar.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[140px]">
          <label className="text-[12px] text-muted-foreground" htmlFor={`add-date-kind-${profileId}`}>What is it?</label>
          <select id={`add-date-kind-${profileId}`} value={choice} onChange={(e) => setChoice(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-[14px]" data-testid="asset-add-date-kind">
            {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            <option value="__custom">Something else…</option>
          </select>
        </div>
        {choice === "__custom" && (
          <div className="flex-1 min-w-[140px]">
            <label className="text-[12px] text-muted-foreground" htmlFor={`add-date-name-${profileId}`}>Name</label>
            <Input id={`add-date-name-${profileId}`} className="h-9 text-[14px]" maxLength={60} placeholder="e.g. Lease end date"
              value={custom} onChange={(e) => setCustom(e.target.value)} data-testid="asset-add-date-name" />
          </div>
        )}
        <div className="flex-1 min-w-[140px]">
          <label className="text-[12px] text-muted-foreground" htmlFor={`add-date-day-${profileId}`}>Date</label>
          <Input id={`add-date-day-${profileId}`} type="date" className="h-9 text-[14px]" value={date}
            onChange={(e) => setDate(e.target.value)} data-testid="asset-add-date-day" />
        </div>
        <Button size="sm" className="h-9 text-xs" disabled={saving || !key || !date} onClick={() => void save()} data-testid="asset-add-date-save">
          {saving ? "…" : "Add"}
        </Button>
        <Button size="sm" variant="ghost" className="h-9 text-xs" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

// ── The layout ───────────────────────────────────────────────────────────────

export function AssetOverviewBody({
  spec, profile, autoValuation, ownerLabel, onOpenOwnership, onEdit, summarySlot, tailSlot,
}: {
  spec: OverviewSpec;
  profile: AssetLayoutProfile;
  autoValuation: boolean;
  /** "You own this" / "Owned by …" — from the owner links, which the page holds. */
  ownerLabel: string;
  /** Opens the tab where ownership is changed. */
  onOpenOwnership?: () => void;
  /** Opens the profile's Edit dialog (every field at once). */
  onEdit: () => void;
  /** The AI summary card — the page owns it. */
  summarySlot?: React.ReactNode;
  /** The page's own cards (trackers, saved characteristic cells), drawn after
   *  Characteristics and before Recent activity. */
  tailSlot?: React.ReactNode;
}) {
  const [addingField, setAddingField] = useState(false);
  const fields = profile.fields || {};
  const { alerts } = useRecordAlerts(profile.id);

  const priceKey = PURCHASE_PRICE_KEYS.find((k) => parseMoney(fields[k]) > 0) || "purchasePrice";
  const price = parseMoney(fields[priceKey]);
  const purchaseDateKey = Object.keys(fields).find((k) => PURCHASE_DATE_RE.test(k) && fields[k]) || "purchaseDate";
  const purchaseDate = fields[purchaseDateKey] ? String(fields[purchaseDateKey]) : "";
  const location = typeof fields.location === "string" ? fields.location.trim() : "";
  // Drawn by this layout itself, so the composition's copy is not repeated.
  const staple = new Set([priceKey, purchaseDateKey, "purchasePrice", "purchaseDate", "userEnteredValue", "location", "ownershipPercentage"]);

  const keyOf = (v: OverviewValue) => v.editable?.fieldKey || v.semanticKey;
  const fieldSections: OverviewSection[] = spec.sections.filter((s) => !SPECIAL.has(s.component));
  const summary = spec.summaryMetrics.filter((m) => m.semanticKey !== spec.identity.headline?.semanticKey
    // Appreciation / depreciation is the header's and the value card's.
    && !/^(appreciation|depreciation)$/.test(m.semanticKey) && !staple.has(keyOf(m)));
  // A summary metric that is simply one of the record's fields (a brand, a
  // model) is a characteristic; what is left is what the app worked out.
  const fieldMetrics = summary.filter((m) => m.sourceReference?.kind === "field");
  const worked = [
    ...summary.filter((m) => m.sourceReference?.kind !== "field"),
    ...spec.sections.filter((s) => s.component === "financialSummary").flatMap((s) => s.values || []),
  ].filter((m, i, all) => all.findIndex((x) => x.semanticKey === m.semanticKey) === i);
  const characteristics = [
    ...fieldMetrics,
    ...fieldSections.flatMap((s) => s.values || []).filter((v) => !staple.has(keyOf(v))),
  ].filter((v, i, all) => all.findIndex((x) => x.semanticKey === v.semanticKey) === i);

  const dateValues = spec.sections.filter((s) => s.component === "dateCard").flatMap((s) => s.values || [])
    .filter((v) => !staple.has(keyOf(v)));
  const missingDates = spec.missingInformation.filter((m) => isDateKey(m.fieldKey) && !staple.has(m.fieldKey));
  const missingFields = spec.missingInformation.filter((m) => !isDateKey(m.fieldKey) && !staple.has(m.fieldKey)
    // A missing current value is set from Value & Depreciation.
    && m.semanticKey !== "currentValue");
  const isoOrBlank = (v: string) => !v || /^\d{4}-\d{2}-\d{2}/.test(v);
  // A date typed as something other than a calendar day ("2024") stays a text
  // box, so opening the form can never lose it.
  const dateCell = (key: string, label: string, stored: string, icon?: any): FormCell => ({
    key, label, icon, original: isoOrBlank(stored) ? stored.slice(0, 10) : stored,
    kind: isoOrBlank(stored) ? "date" : "text", testId: `overview-field-input-${key}`,
  });
  const fixedBox = (children: React.ReactNode) => <span className={BOX}>{children}</span>;
  const extraCells: FormCell[] = [
    { key: "location", label: "Location", icon: MapPin, original: location, testId: "overview-field-input-location" },
    ...dateValues.filter((v) => v.editable).map((v) => dateCell(v.editable!.fieldKey, v.label, v.value == null ? "" : String(v.value), Calendar)),
    ...missingDates.map((m) => dateCell(m.fieldKey, m.label, "", Calendar)),
  ];
  const formRows: FormCell[][] = [
    [{ key: "name", label: "Name", icon: Type, original: profile.name || "", placeholder: "Name this asset", testId: "asset-name-input" }],
    [
      { key: "category", label: "Category", icon: Package, fixed: fixedBox(<span className="capitalize truncate" data-testid="asset-detail-category">{spec.identity.entityLabel || profile.type}</span>) },
      {
        key: "ownership", label: "Ownership", icon: Users,
        fixed: onOpenOwnership ? (
          <button type="button" className={`${BOX} justify-between gap-2 hover:border-primary/50`} onClick={onOpenOwnership} data-testid="asset-detail-ownership">
            <span className="truncate">{ownerLabel}</span><ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        ) : fixedBox(<span className="truncate" data-testid="asset-detail-ownership">{ownerLabel}</span>),
      },
    ],
    [
      { key: priceKey, label: "Purchase Price", icon: ShoppingCart, kind: "money", original: price > 0 ? String(price) : "", testId: "overview-field-input-purchasePrice" },
      dateCell(purchaseDateKey, "Purchase Date", purchaseDate),
    ],
    // What is left, two to a line; an odd one out takes the line.
    ...Array.from({ length: Math.ceil(extraCells.length / 2) }, (_, i) => extraCells.slice(i * 2, i * 2 + 2)),
    [{ key: "notes", label: "Notes", icon: StickyNote, kind: "long", original: profile.notes || "", placeholder: "No notes yet", testId: "asset-notes-input" }],
  ];
  // A second cell on a line carries no icon of its own, like the owner's drawing.
  for (const row of formRows) if (row[1]) row[1] = { ...row[1], icon: undefined };

  const charRows = [
    ...characteristics.map((v) => v.editable ? (
      <CharRow key={v.semanticKey} profileId={profile.id} fieldKey={v.editable.fieldKey} label={v.label}
        display={formatValue(v)} raw={rawOf(v)} kind={kindOf(v)}
        testId={`overview-field-${v.semanticKey}`} removeTestId={`overview-field-remove-${v.semanticKey}`} />
    ) : (
      <CharRow key={v.semanticKey} profileId={profile.id} fieldKey={v.semanticKey} label={v.label}
        display={formatValue(v)} readOnly testId={`overview-field-${v.semanticKey}`} />
    )),
    ...missingFields.map((m) => (
      <CharRow key={m.semanticKey} profileId={profile.id} fieldKey={m.fieldKey} label={m.label}
        display={null} reason={m.reason} testId={`overview-missing-${m.semanticKey}`} />
    )),
  ];

  const today = localTodayISO();
  const ownedFor = /^\d{4}-\d{2}-\d{2}/.test(purchaseDate) && purchaseDate.slice(0, 10) <= today
    ? calendarDelta(purchaseDate.slice(0, 10), today) : null;
  const age = ownedFor
    ? [ownedFor.years ? `${ownedFor.years} yr${ownedFor.years === 1 ? "" : "s"}` : "", ownedFor.months ? `${ownedFor.months} mo` : "",
       !ownedFor.years && !ownedFor.months ? `${ownedFor.totalDays} day${ownedFor.totalDays === 1 ? "" : "s"}` : ""].filter(Boolean).join(" ")
    : "";
  const nextAlert = alerts.find((a) => !a.cleared);
  const hasQuick = !!age || worked.length > 0 || !!nextAlert;
  const quickRow = (icon: any, label: string, value: React.ReactNode, testId: string, trailing?: React.ReactNode) => {
    const Icon = icon;
    return (
      <div key={testId} className="flex items-center gap-2.5 min-h-[32px] py-0.5 border-b border-border/30 last:border-b-0" data-testid={testId}>
        <Icon className="h-[17px] w-[17px] shrink-0 text-muted-foreground" strokeWidth={1.8} />
        <span className="w-[42%] max-w-[190px] shrink-0 text-[13px] truncate">{label}</span>
        <span className="self-stretch w-px bg-border/40" />
        <span className="flex-1 min-w-0 truncate text-[13px] tabular-nums">{value}</span>
        {trailing}
      </div>
    );
  };

  const sectionsOf = (...components: string[]) =>
    spec.sections.filter((s) => components.includes(s.component)).map((s) => renderSection(s, profile.id));

  const linked = sectionsOf("progressIndicator", "relationshipSummary", "ownershipSummary", "maintenanceSummary", "aiInsight");
  const activity = sectionsOf("miniTimeline");

  // Top to bottom (owner, 2026-11-23): what it is worth, what it is, what the
  // app worked out, what it is linked to, the summary — then the long tail:
  // characteristics, and recent activity last. On a wide screen Asset Details
  // sits beside Value + Quick Info; `order` puts Value first on a phone.
  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-2.5">
        <div className="flex flex-col min-w-0 order-2 lg:order-1" data-testid="asset-section-details">
          <AssetDetailsForm profileId={profile.id} rows={formRows} onEdit={onEdit} />
        </div>
        {/* On a phone this column dissolves, so its two cards take their own
            places in the one-column order: Value, Asset Details, Quick Info. */}
        <div className="contents lg:flex lg:flex-col lg:gap-2.5 lg:min-w-0 lg:order-2">
          <div className="order-1 min-w-0"><ValueCard profile={profile} /></div>
          {hasQuick && (
            <div className="order-3 min-w-0 flex flex-col lg:flex-1">
            <Panel title="Quick Info" testId="asset-quick-info" grow>
              {age && quickRow(Calendar, "Age", age, "asset-quick-age")}
              {worked.map((m) => quickRow(iconFor(m.semanticKey), m.label, <span className={toneClass(m.tone)}>{formatValue(m)}</span>,
                `overview-metric-${m.semanticKey}`, <ProvenanceMark value={m} />))}
              {nextAlert && quickRow(Bell, nextAlert.title, nextAlert.when, "asset-alert-row")}
            </Panel>
            </div>
          )}
        </div>
      </div>

      {linked}

      {summarySlot && <div className="min-w-0" data-testid="asset-summary-slot">{summarySlot}</div>}

      {/* ── Characteristics ── */}
      <Panel
        title="Characteristics"
        testId="asset-characteristics"
        action={
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1 border-emerald-500/50" onClick={() => setAddingField((a) => !a)} data-testid="asset-add-characteristic">
            <Plus className="h-3.5 w-3.5 text-emerald-400" /> Add Characteristic
          </Button>
        }
      >
        {charRows.length > 0
          ? <div className="grid grid-cols-1 lg:grid-cols-2 lg:gap-x-6">{charRows}</div>
          : !addingField && (
            <p className="py-1 text-[13px] text-muted-foreground" data-testid="asset-characteristics-empty">
              Nothing here yet. Add a colour, a model, a serial number, a condition.
            </p>
          )}
        {addingField && <div className="mt-2"><AddFieldPanel profileId={profile.id} inline onAdded={() => setAddingField(false)} /></div>}
      </Panel>

      {/* Whatever the page adds (trackers, saved cells) comes here, then
          recent activity, which is always last. */}
      {tailSlot}
      {activity.length > 0 && <div data-testid="asset-section-activity">{activity}</div>}
    </>
  );
}

// ── Quick add: the buttons beside the tabs ───────────────────────────────────

/**
 * + Task, + Expense, + Note and More. Each creates an ordinary record linked
 * to this asset through the route every other screen uses, so it shows on the
 * Tasks page, in Finance and under Notes as well as on this profile.
 */
export function AssetQuickAdd({ profileId, fields, onOpenDocuments, onEdit }: {
  profileId: string;
  /** The record's fields, so "Add a date" does not offer one it already has. */
  fields?: Record<string, any> | null;
  onOpenDocuments?: () => void; onEdit: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState<null | "task" | "expense" | "note" | "date">(null);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [amount, setAmount] = useState("");
  const [what, setWhat] = useState("");
  const [day, setDay] = useState("");
  const [saving, setSaving] = useState(false);
  const close = () => { setOpen(null); setTitle(""); setDue(""); setAmount(""); setWhat(""); setDay(""); };

  const post = async (url: string, body: Record<string, unknown>, done: string, ...domains: Array<"tasks" | "expenses" | "profiles">) => {
    setSaving(true);
    try {
      await apiRequest("POST", url, body);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      void invalidateDomains(...domains);
      toast({ title: done });
      close();
    } catch (err: any) {
      toast({ title: "Couldn't save", description: formatApiError(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };
  const amt = parseMoney(amount);
  const btn = "h-7 px-2.5 text-xs gap-1 shrink-0";

  return (
    <div className="flex flex-nowrap items-center gap-1.5 w-max" data-testid="asset-quick-add">
      <Button variant="outline" size="sm" className={btn} onClick={() => setOpen("task")} data-testid="quick-add-task"><Plus className="h-3.5 w-3.5 text-emerald-400" /> Task</Button>
      <Button variant="outline" size="sm" className={btn} onClick={() => setOpen("expense")} data-testid="quick-add-expense"><Plus className="h-3.5 w-3.5 text-emerald-400" /> Expense</Button>
      <Button variant="outline" size="sm" className={btn} onClick={() => setOpen("note")} data-testid="quick-add-note"><Plus className="h-3.5 w-3.5 text-emerald-400" /> Note</Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className={btn} data-testid="quick-add-more"><MoreHorizontal className="h-3.5 w-3.5" /> More</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[180px]">
          <DropdownMenuItem onSelect={() => setOpen("date")} data-testid="asset-add-date"><CalendarPlus className="h-4 w-4 mr-2" /> Add a date</DropdownMenuItem>
          {onOpenDocuments && (
            <DropdownMenuItem onSelect={onOpenDocuments} data-testid="quick-add-document"><FileText className="h-4 w-4 mr-2" /> Add a document</DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onEdit} data-testid="quick-edit-details"><Pencil className="h-4 w-4 mr-2" /> Edit all details</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={open !== null} onOpenChange={(o) => { if (!o) close(); }}>
        <DialogContent className="max-w-sm" data-testid="quick-add-dialog">
          <DialogHeader>
            <DialogTitle>{open === "task" ? "New task for this asset" : open === "expense" ? "New expense for this asset" : open === "date" ? "Add a date to this asset" : "New note for this asset"}</DialogTitle>
          </DialogHeader>
          {open === "task" && (
            <div className="space-y-2">
              <Input autoFocus placeholder="What needs doing?" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} data-testid="quick-task-title" />
              <label className="text-[12px] text-muted-foreground block" htmlFor="quick-task-due">Due (optional)</label>
              <Input id="quick-task-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} data-testid="quick-task-due" />
              <Button className="w-full" disabled={saving || !title.trim()} data-testid="quick-task-save"
                onClick={() => void post("/api/tasks", { title: title.trim(), ...(due ? { dueDate: due } : {}), linkedProfiles: [profileId] }, "Task added", "tasks", "profiles")}>
                {saving ? "Saving…" : "Add task"}
              </Button>
            </div>
          )}
          {open === "expense" && (
            <div className="space-y-2">
              <Input autoFocus inputMode="decimal" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="quick-expense-amount" />
              <Input placeholder="What was it for?" value={what} onChange={(e) => setWhat(e.target.value)} maxLength={200} data-testid="quick-expense-what" />
              <label className="text-[12px] text-muted-foreground block" htmlFor="quick-expense-day">Date (today if blank)</label>
              <Input id="quick-expense-day" type="date" value={day} onChange={(e) => setDay(e.target.value)} data-testid="quick-expense-day" />
              <Button className="w-full" disabled={saving || !(amt > 0) || !what.trim()} data-testid="quick-expense-save"
                onClick={() => void post("/api/expenses", { amount: amt, description: what.trim(), date: day || localTodayISO(), linkedProfiles: [profileId] }, "Expense added", "expenses", "profiles")}>
                {saving ? "Saving…" : "Add expense"}
              </Button>
            </div>
          )}
          {open === "note" && <NewNoteForm profileId={profileId} onDone={close} />}
          {open === "date" && (
            <AddDateForm profileId={profileId} options={COMMON_DATES.filter((o) => !fields?.[o.key])} onDone={close} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Alert actions for the header's ⋯ menu ────────────────────────────────────

/**
 * "Clear alerts" / "Restore alerts" as menu items. Clearing dismisses this
 * record's dated alerts into the server's dismiss list (the one the bell and
 * the dashboard read), so it follows the user across devices and Restore
 * brings every one of them back.
 */
export function AssetAlertMenuItems({ profileId }: { profileId: string }) {
  const { toast } = useToast();
  const { alerts, dismiss, restore } = useRecordAlerts(profileId);
  const live = alerts.filter((a) => !a.cleared);
  const cleared = alerts.filter((a) => a.cleared);
  const busy = dismiss.isPending || restore.isPending;
  return (
    <>
      <DropdownMenuItem
        disabled={live.length === 0 || busy}
        data-testid="button-clear-document-alerts"
        onSelect={() => dismiss.mutate(live.map((a) => a.id), {
          onSuccess: () => toast({
            title: `Cleared ${live.length} alert${live.length === 1 ? "" : "s"}`,
            description: "The dates stay on the records. Restore brings the alerts back.",
          }),
        })}
      >
        <BellOff className="h-4 w-4 mr-2" />
        {live.length > 0 ? `Clear ${live.length} alert${live.length === 1 ? "" : "s"}` : "No alerts to clear"}
      </DropdownMenuItem>
      {cleared.length > 0 && (
        <DropdownMenuItem
          disabled={busy}
          data-testid="button-restore-document-alerts"
          onSelect={() => restore.mutate(cleared.map((a) => a.id), { onSuccess: () => toast({ title: "Alerts restored" }) })}
        >
          <Bell className="h-4 w-4 mr-2" />
          Restore {cleared.length} cleared alert{cleared.length === 1 ? "" : "s"}
        </DropdownMenuItem>
      )}
    </>
  );
}
