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
  Bell, BellOff, Calendar, CalendarPlus, ChevronDown, ChevronRight, CircleDot, FileText, Hash,
  MapPin, MoreHorizontal, Package, Pencil, Plus, RefreshCw, ShoppingCart, StickyNote, Tag, Trash2, Type, Users, X,
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
  AttentionStrip, FindValueButton, ProvenanceMark, formatValue, renderSection, toneClass, useFieldWrite,
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

const PANEL = "bubble px-3.5 py-3";
/** A row of a panel: label on the left, value beside it, a pencil to change it. */
const ROW = "w-full flex items-center gap-2.5 min-h-[36px] py-1.5 text-left border-b border-border/30 last:border-b-0";
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
const shortDate = (iso: string) =>
  parseLocalDate(iso)?.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) ?? iso;

function Panel({ title, action, children, testId, grow }: {
  title: string; action?: React.ReactNode; children: React.ReactNode; testId?: string;
  /** Takes the height left in its column, so two columns end on the same line. */
  grow?: boolean;
}) {
  return (
    <section className={`${PANEL} ${grow ? "flex-1" : ""}`} data-testid={testId}>
      <div className="flex items-center justify-between gap-2 min-h-[32px]">
        <h2 className="text-[16px] font-semibold tracking-tight">{title}</h2>
        {action && <div className="flex items-center gap-1.5 shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

function RowBody({ icon: Icon, label, value, unset, trailing }: {
  icon: any; label: string; value: React.ReactNode; unset?: boolean; trailing?: React.ReactNode;
}) {
  return (
    <>
      <Icon className="h-[17px] w-[17px] shrink-0 text-muted-foreground" strokeWidth={1.8} />
      <span className="w-[38%] max-w-[150px] shrink-0 text-[13px] text-muted-foreground truncate">{label}</span>
      <span className={`flex-1 min-w-0 truncate text-[14px] ${unset ? "text-muted-foreground/70" : "font-semibold tabular-nums"}`}>{value}</span>
      {trailing}
    </>
  );
}

// ── One field as a row ───────────────────────────────────────────────────────

function FieldRow({
  profileId, fieldKey, label, display, raw, kind = "text", reason, readOnly, testId, removeTestId, wide,
  removable = true, iconKey,
}: {
  profileId: string;
  fieldKey: string;
  label: string;
  /** What the row shows; null means the field is not set. */
  display: React.ReactNode | null;
  raw?: string;
  kind?: "text" | "money" | "date";
  /** Why this field is worth filling — shown while it is not set. */
  reason?: string;
  readOnly?: boolean;
  testId?: string;
  removeTestId?: string;
  /** Takes the whole row of a two-column panel. */
  wide?: boolean;
  removable?: boolean;
  /** Picks the icon when the stored key does not say what the row is. */
  iconKey?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const { confirm, isArmed } = useConfirmArm();
  const write = useFieldWrite(profileId);
  const Icon = iconFor(iconKey || fieldKey);
  const unset = display == null;
  const span = wide ? "sm:col-span-2" : "";

  const save = async () => {
    const text = draft.trim();
    if (!text) return;
    // Money is stored as a number, like every other amount the app writes.
    const value = kind === "money" ? parseMoney(text) : text;
    setSaving(true);
    const ok = await write(fieldKey, value);
    setSaving(false);
    if (ok) setEditing(false);
  };

  if (editing) {
    return (
      <div className={`sm:col-span-2 my-1 ${TILE_BOX} ring-1 ring-primary/40 space-y-1.5`}>
        <label className="text-[12px] text-muted-foreground" htmlFor={`row-${fieldKey}`}>{label}</label>
        <div className="flex flex-wrap items-center gap-1.5">
          <Input
            id={`row-${fieldKey}`}
            className="h-9 text-[14px] flex-1 min-w-[120px]"
            type={kind === "date" ? "date" : "text"}
            inputMode={kind === "money" ? "decimal" : undefined}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }}
            data-testid={`overview-field-input-${fieldKey}`}
          />
          <Button size="sm" className="h-9 text-xs" disabled={saving || !draft.trim()} onClick={() => void save()}>
            {saving ? "…" : "Save"}
          </Button>
          {!unset && removable && (
            <Button
              size="sm"
              variant={isArmed("rm") ? "destructive" : "ghost"}
              className="h-9 text-xs px-2"
              disabled={saving}
              aria-label={isArmed("rm") ? `Tap again to remove ${label}` : `Remove ${label}`}
              data-testid={removeTestId}
              onClick={() => confirm("rm", async () => {
                setSaving(true);
                const ok = await write(fieldKey, null);
                setSaving(false);
                if (ok) setEditing(false);
              })}
            >
              {isArmed("rm") ? "Remove?" : <Trash2 className="h-3.5 w-3.5" />}
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-9 px-2" aria-label="Cancel" onClick={() => setEditing(false)}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        {unset && reason && <p className="text-[11px] text-muted-foreground">{reason}</p>}
      </div>
    );
  }

  if (readOnly) {
    return <div className={`${ROW} ${span}`} data-testid={testId}><RowBody icon={Icon} label={label} value={unset ? "Not set" : display} unset={unset} /></div>;
  }
  return (
    <button type="button" className={`${ROW} ${span}`} title={unset ? reason : undefined}
      onClick={() => { setDraft(raw ?? ""); setEditing(true); }} data-testid={testId}>
      <RowBody icon={Icon} label={label} value={unset ? "Not set" : display} unset={unset}
        trailing={<Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />} />
    </button>
  );
}

/** The record's own name or notes, edited where they are shown (the same
 *  `name` / `notes` the Edit dialog and the chat's update_profile write). */
function RecordTextRow({ profileId, prop, label, value, icon, placeholder, testId }: {
  profileId: string; prop: "name" | "notes"; label: string; value: string; icon: any; placeholder: string; testId: string;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const multiline = prop === "notes";
  const text = draft.trim();
  // A name cannot be blank; notes can be cleared.
  const canSave = text !== value.trim() && (multiline || text.length > 0);
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await apiRequest("PATCH", `/api/profiles/${profileId}`, { [prop]: text });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      void invalidateDomains("profiles");
      setEditing(false);
    } catch (err: any) {
      toast({ title: `Failed to save ${label.toLowerCase()}`, description: formatApiError(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };
  if (editing) {
    return (
      <div className={`sm:col-span-2 my-1 ${TILE_BOX} ring-1 ring-primary/40 space-y-1.5`}>
        <label className="text-[12px] text-muted-foreground" htmlFor={`${prop}-${profileId}`}>{label}</label>
        {multiline ? (
          <textarea id={`${prop}-${profileId}`} rows={3} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-[14px]"
            placeholder={placeholder} data-testid={`asset-${prop}-input`} />
        ) : (
          <Input id={`${prop}-${profileId}`} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={120}
            className="h-9 text-[14px]" placeholder={placeholder} data-testid={`asset-${prop}-input`}
            onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }} />
        )}
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" className="h-9 text-xs" onClick={() => setEditing(false)}>Cancel</Button>
          <Button size="sm" className="h-9 text-xs" disabled={saving || !canSave} onClick={() => void save()} data-testid={`asset-${prop}-save`}>
            {saving ? "…" : "Save"}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <button type="button" className={`${ROW} sm:col-span-2`} onClick={() => { setDraft(value); setEditing(true); }} data-testid={testId}>
      <RowBody icon={icon} label={label} value={value.trim() || placeholder} unset={!value.trim()}
        trailing={<Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />} />
    </button>
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

/** The four numbers in the header: Current Value, Purchase Price, the change, Confidence. */
export function AssetHeroStats({ profile }: { profile: AssetLayoutProfile }) {
  const v = useValuePosition(profile);
  const cell = (label: string, value: React.ReactNode, tone: string, testId: string) => (
    <div className="px-3 py-1.5 min-w-0 text-center" data-testid={testId}>
      <p className="text-[11px] text-muted-foreground whitespace-nowrap">{label}</p>
      <p className={`text-[17px] font-bold tabular-nums leading-tight whitespace-nowrap ${tone}`}>{value}</p>
    </div>
  );
  const none = <span className="text-[14px] font-medium text-muted-foreground/70">Not set</span>;
  return (
    <div className="bubble-row !rounded-2xl grid grid-cols-2 sm:grid-cols-4 divide-x divide-border/40" data-testid="asset-hero-stats">
      {cell(v.auto ? "Current Value" : "Your Value", v.now > 0 ? formatMoneyCompact(v.now) : none, "text-emerald-400", "hero-stat-current-value")}
      {cell("Purchase Price", v.paid > 0 ? formatMoneyCompact(v.paid) : none, "", "hero-stat-purchase-price")}
      {cell(v.delta > 0 ? "Appreciation" : "Depreciation",
        v.hasChange ? `${signed(v.delta)} (${Math.abs(v.pct).toFixed(0)}%)` : <span className="text-[14px] font-medium text-muted-foreground/70">—</span>,
        v.delta > 0 ? "text-emerald-400" : "text-red-400", "hero-stat-change")}
      {cell("Confidence", v.confidence != null ? `${v.confidence}%` : <span className="text-[14px] font-medium text-muted-foreground/70">—</span>,
        v.confidence != null && v.confidence >= 70 ? "text-emerald-400" : v.confidence != null && v.confidence >= 45 ? "text-amber-400" : "", "hero-stat-confidence")}
    </div>
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
  ];

  return (
    <section className={PANEL} data-testid="asset-value-card">
      <div className="flex items-center justify-between gap-2 min-h-[32px]">
        <h2 className="text-[16px] font-semibold tracking-tight">{up ? "Value & Appreciation" : "Value & Depreciation"}</h2>
        {v.auto && v.supported && (
          <Button size="sm" variant="outline" className="h-8 text-xs gap-1" onClick={() => { void v.refresh(); }} disabled={v.refreshing} data-testid="asset-value-refresh">
            <RefreshCw className={`h-3.5 w-3.5 ${v.refreshing ? "animate-spin" : ""}`} />
            {v.refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        )}
      </div>
      <div className={`grid gap-3 items-center ${xy.length >= 2 ? "grid-cols-1 min-[420px]:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]" : "grid-cols-1"}`}>
        {xy.length >= 2 && (
          <svg viewBox="0 0 200 80" className="w-full h-auto max-h-[110px]" preserveAspectRatio="none" role="img" aria-label={`Value from ${formatMoneyCompact(points[0])} to ${formatMoneyCompact(points[points.length - 1])}`}>
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
            <div key={label} className="flex items-center justify-between gap-3 py-1" data-testid={`asset-value-row-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
              <span className="text-[13px] text-muted-foreground">{label}</span>
              <span className={`text-[14px] font-semibold tabular-nums ${cls}`}>{value}</span>
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
  spec, profile, autoValuation, ownerLabel, onOpenOwnership, onEdit, summarySlot,
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
}) {
  const [addingField, setAddingField] = useState(false);
  const [addingDate, setAddingDate] = useState(false);
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
  const dateOptions = [
    ...missingDates.map((m) => ({ key: m.fieldKey, label: m.label })),
    ...COMMON_DATES,
  ].filter((o, i, all) => !fields[o.key] && all.findIndex((x) => x.key === o.key) === i);

  const headlineValueKey = spec.identity.headline?.editable && /value$/i.test(spec.identity.headline.semanticKey)
    ? spec.identity.headline.editable.fieldKey : null;
  const missingValueKey = spec.missingInformation.find((m) => m.semanticKey === "currentValue")?.fieldKey || null;
  const valueLookupKey = autoValuation ? (headlineValueKey || missingValueKey) : null;

  const valueRow = (v: OverviewValue) => (wide: boolean) => v.editable ? (
    <FieldRow key={v.semanticKey} profileId={profile.id} fieldKey={v.editable.fieldKey} label={v.label} wide={wide}
      display={formatValue(v)} raw={rawOf(v)} kind={kindOf(v)}
      testId={`overview-field-${v.semanticKey}`} removeTestId={`overview-field-remove-${v.semanticKey}`} />
  ) : (
    <FieldRow key={v.semanticKey} profileId={profile.id} fieldKey={v.semanticKey} label={v.label} wide={wide}
      display={formatValue(v)} readOnly testId={`overview-field-${v.semanticKey}`} />
  );

  // The rows between Name and Notes, as a list: an odd one out takes the
  // whole row instead of leaving half of it empty.
  const detailRows: Array<(wide: boolean) => React.ReactNode> = [
    (wide) => (
      <div key="category" className={`${ROW} ${wide ? "sm:col-span-2" : ""}`} data-testid="asset-detail-category">
        <RowBody icon={Package} label="Category" value={<span className="capitalize">{spec.identity.entityLabel || profile.type}</span>} />
      </div>
    ),
    (wide) => onOpenOwnership ? (
      <button key="owner" type="button" className={`${ROW} ${wide ? "sm:col-span-2" : ""}`} onClick={onOpenOwnership} data-testid="asset-detail-ownership">
        <RowBody icon={Users} label="Ownership" value={ownerLabel} trailing={<ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70" />} />
      </button>
    ) : (
      <div key="owner" className={`${ROW} ${wide ? "sm:col-span-2" : ""}`} data-testid="asset-detail-ownership">
        <RowBody icon={Users} label="Ownership" value={ownerLabel} />
      </div>
    ),
    (wide) => (
      <FieldRow key="price" profileId={profile.id} fieldKey={priceKey} iconKey="purchasePrice" label="Purchase Price" kind="money" wide={wide}
        display={price > 0 ? formatMoneyCompact(price) : null} raw={price > 0 ? String(price) : ""}
        reason="Unlocks appreciation since you bought it"
        testId="overview-missing-purchasePrice" removeTestId="overview-field-remove-purchasePrice" />
    ),
    (wide) => (
      <FieldRow key="pdate" profileId={profile.id} fieldKey={purchaseDateKey} iconKey="purchaseDate" label="Purchase Date" kind="date" wide={wide}
        display={purchaseDate ? shortDate(purchaseDate) : null}
        raw={/^\d{4}-\d{2}-\d{2}/.test(purchaseDate) ? purchaseDate.slice(0, 10) : ""}
        reason="Dates how long you have owned it"
        testId="asset-detail-purchase-date" removeTestId="overview-field-remove-purchaseDate" />
    ),
    (wide) => (
      <FieldRow key="location" profileId={profile.id} fieldKey="location" label="Location" wide={wide}
        display={location || null} raw={location} reason="Where it is kept — a room, a garage, a safe"
        testId="asset-detail-location" removeTestId="overview-field-remove-location" />
    ),
    ...dateValues.map(valueRow),
    ...missingDates.map((m) => (wide: boolean) => (
      <FieldRow key={m.semanticKey} profileId={profile.id} fieldKey={m.fieldKey} label={m.label} kind="date" wide={wide}
        display={null} reason={m.reason} testId={`overview-missing-${m.semanticKey}`} />
    )),
  ];

  const charRows = [
    ...characteristics.map((v) => valueRow(v)(false)),
    ...missingFields.map((m) => (
      <FieldRow key={m.semanticKey} profileId={profile.id} fieldKey={m.fieldKey} label={m.label}
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
  // Quick Info sits under whichever column is shorter, so neither card is
  // left holding a blank area to reach the other's height.
  const quickLines = hasQuick ? 1 + (age ? 1 : 0) + worked.length + (nextAlert ? 1 : 0) : 0;
  const charLines = 1 + Math.max(charRows.length, 1);
  const pairedLines = 4 + Math.ceil(detailRows.length / 2);   // title, Name, Notes, add-date + the pairs
  const singleLines = 4 + detailRows.length;
  const quickOnLeft = hasQuick && pairedLines + quickLines <= charLines;
  // Asset Details pairs its rows two to a line — unless the column beside it
  // is taller, when one row per line fills the card instead of leaving it
  // half empty.
  // A second card in the column costs about a line of padding and gap.
  const rightLines = charLines + (quickOnLeft || !hasQuick ? 0 : quickLines + 1);
  const pairRows = quickOnLeft || Math.abs(pairedLines - rightLines) <= Math.abs(singleLines - rightLines);
  const quickInfo = hasQuick ? (
    <Panel title="Quick Info" testId="asset-quick-info" grow>
      {age && (
        <div className={ROW} data-testid="asset-quick-age"><RowBody icon={Calendar} label="Age" value={age} /></div>
      )}
      {worked.map((m) => (
        <div key={m.semanticKey} className={ROW} data-testid={`overview-metric-${m.semanticKey}`}>
          <RowBody icon={iconFor(m.semanticKey)} label={m.label}
            value={<span className={toneClass(m.tone)}>{formatValue(m)}</span>} trailing={<ProvenanceMark value={m} />} />
        </div>
      ))}
      {nextAlert && (
        <div className={ROW} data-testid="asset-alert-row">
          <RowBody icon={Bell} label={nextAlert.title} value={nextAlert.when} />
        </div>
      )}
    </Panel>
  ) : null;

  const sectionsOf = (...components: string[]) =>
    spec.sections.filter((s) => components.includes(s.component)).map((s) => renderSection(s, profile.id));

  return (
    <>
      <AttentionStrip spec={spec} />

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] gap-3">
        <div className="flex flex-col gap-3 min-w-0">
        {/* ── Asset Details ── */}
        <Panel
          title="Asset Details"
          testId="asset-details"
          grow={!quickOnLeft}
          action={<>
            {valueLookupKey && <FindValueButton profileId={profile.id} fieldKey={valueLookupKey} />}
            <Button variant="outline" size="sm" className="h-8 text-xs gap-1" onClick={onEdit} data-testid="asset-details-edit">
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
          </>}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
            <RecordTextRow profileId={profile.id} prop="name" label="Name" value={profile.name || ""} icon={Type}
              placeholder="Name this asset" testId="asset-detail-name" />
            {detailRows.map((r, i) => r(!pairRows || (detailRows.length % 2 === 1 && i === detailRows.length - 1)))}
            <RecordTextRow profileId={profile.id} prop="notes" label="Notes" value={profile.notes || ""} icon={StickyNote}
              placeholder="No notes yet" testId="asset-detail-notes" />
          </div>
          {addingDate ? (
            <div className="mt-2"><AddDateForm profileId={profile.id} options={dateOptions} onDone={() => setAddingDate(false)} /></div>
          ) : (
            <button type="button" className="mt-1.5 text-[12px] text-muted-foreground hover:text-foreground flex items-center gap-1"
              onClick={() => setAddingDate(true)} data-testid="asset-add-date">
              <CalendarPlus className="h-3.5 w-3.5" /> Add a date (warranty, renewal, expiration)
            </button>
          )}
        </Panel>
        {quickOnLeft && quickInfo}
        </div>

        <div className="flex flex-col gap-3 min-w-0">
          {/* ── Characteristics ── */}
          <Panel
            title="Characteristics"
            testId="asset-characteristics"
            grow={quickOnLeft || !hasQuick}
            action={
              <Button variant="outline" size="sm" className="h-8 text-xs gap-1" onClick={() => setAddingField((a) => !a)} data-testid="asset-add-characteristic">
                <Plus className="h-3.5 w-3.5" /> Add Characteristic
              </Button>
            }
          >
            {charRows.length > 0
              ? <div>{charRows}</div>
              : !addingField && (
                <p className="py-2 text-[13px] text-muted-foreground" data-testid="asset-characteristics-empty">
                  Nothing here yet. Add a colour, a model, a serial number, a condition.
                </p>
              )}
            {addingField && <div className="mt-2"><AddFieldPanel profileId={profile.id} inline onAdded={() => setAddingField(false)} /></div>}
          </Panel>

          {!quickOnLeft && quickInfo}
        </div>
      </div>

      {sectionsOf("progressIndicator", "relationshipSummary", "ownershipSummary", "maintenanceSummary", "miniTimeline", "aiInsight")}

      {/* ── AI Summary | Value & Depreciation ── */}
      <div className={`grid grid-cols-1 gap-3 ${summarySlot ? "lg:grid-cols-2" : ""}`}>
        {summarySlot && <div className="min-w-0 [&>*]:h-full">{summarySlot}</div>}
        <ValueCard profile={profile} />
      </div>
    </>
  );
}

// ── Quick add: the buttons beside the tabs ───────────────────────────────────

/**
 * + Task, + Expense, + Note and More. Each creates an ordinary record linked
 * to this asset through the route every other screen uses, so it shows on the
 * Tasks page, in Finance and under Notes as well as on this profile.
 */
export function AssetQuickAdd({ profileId, onOpenDocuments, onEdit }: {
  profileId: string; onOpenDocuments?: () => void; onEdit: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState<null | "task" | "expense" | "note">(null);
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
  const btn = "h-8 text-xs gap-1 shrink-0";

  return (
    <div className="flex items-center gap-1.5" data-testid="asset-quick-add">
      <Button variant="outline" size="sm" className={btn} onClick={() => setOpen("task")} data-testid="quick-add-task"><Plus className="h-3.5 w-3.5" /> Task</Button>
      <Button variant="outline" size="sm" className={btn} onClick={() => setOpen("expense")} data-testid="quick-add-expense"><Plus className="h-3.5 w-3.5" /> Expense</Button>
      <Button variant="outline" size="sm" className={btn} onClick={() => setOpen("note")} data-testid="quick-add-note"><Plus className="h-3.5 w-3.5" /> Note</Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className={btn} data-testid="quick-add-more"><MoreHorizontal className="h-3.5 w-3.5" /> More</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[180px]">
          {onOpenDocuments && (
            <DropdownMenuItem onSelect={onOpenDocuments} data-testid="quick-add-document"><FileText className="h-4 w-4 mr-2" /> Add a document</DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onEdit} data-testid="quick-edit-details"><Pencil className="h-4 w-4 mr-2" /> Edit all details</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={open !== null} onOpenChange={(o) => { if (!o) close(); }}>
        <DialogContent className="max-w-sm" data-testid="quick-add-dialog">
          <DialogHeader>
            <DialogTitle>{open === "task" ? "New task for this asset" : open === "expense" ? "New expense for this asset" : "New note for this asset"}</DialogTitle>
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
