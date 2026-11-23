// ─── Asset profile layout (owner's design, 2026-11-22) ──────────────────────
//
// The asset's Overview drawn to the owner's mock-up: Asset details as tiles,
// Financial position, Documents beside Alerts, Calendar & reminders, and (at
// the bottom of the tab) Profile actions.
//
// Layout only. Every number and row here is read from a store another screen
// already reads, so nothing on this page can disagree with the rest of the app:
//
//   details / dates / suggestions → the composed OverviewSpec (DynamicOverview)
//   current value                 → currentAssetValue (Rule 1)
//   alerts                        → the date-rule engine over this record and
//                                   its documents (Rule 5), dismissed into the
//                                   server's one dismiss list (Rule 8)
//   documents                     → /api/profiles/:id/documents
//
// A tile writes one field with the same PATCH the old rows used.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Bell, BellOff, Calendar, CalendarPlus, ChevronDown, ChevronRight, CircleDot, FileText, Hash,
  MapPin, Package, Pencil, Plus, ShoppingCart, StickyNote, Tag, Trash2, TrendingDown, TrendingUp, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateDomains } from "@/lib/cache-bus";
import { formatApiError } from "@/lib/formatError";
import { formatMoneyCompact, parseLocalDate } from "@/lib/format";
import { localTodayISO } from "@/lib/dates";
import { useToast } from "@/hooks/use-toast";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import { useAssetValuation } from "@/hooks/useAssetValuation";
import { useDismissedAlerts } from "@/hooks/useDismissedAlerts";
import { AddFieldPanel } from "@/components/AddFieldPanel";
import { userEnteredAssetValue } from "@/components/asset/CurrentValueCard";
import {
  AttentionStrip, FindValueButton, ProvenanceMark, formatValue, renderSection, toneClass, useFieldWrite,
} from "@/components/overview/DynamicOverview";
import { parseMoney, resolveAssetValue } from "@shared/asset-value";
import { currentAssetValue, isAutoValuationEnabled } from "@shared/valuation/context";
import { countdownLabel, isAlertDateRule, rulesFromAll, type DateRule } from "@shared/date-rules";
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
  relatedEvents?: any[];
}

// The app's card surface at tile size.
const TILE_BOX = "bubble !rounded-2xl px-3 py-2.5";
const TILE = `${TILE_BOX} min-h-[58px] w-full flex items-center gap-3 text-left`;
const PANEL = "bubble p-4";
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
  if (/date|expir|renew|due/.test(k)) return Calendar;
  if (/location|address|city|room/.test(k)) return MapPin;
  if (/note|description/.test(k)) return StickyNote;
  if (/serial|vin|model|number|plate|identifier|sku/.test(k)) return Hash;
  if (/brand|make|manufacturer|category|type/.test(k)) return Package;
  return CircleDot;
}

const isDateKey = (key: string) => fieldSemantics(key, "2026-01-01").role === "date";

function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-0.5">
      <h2 className="text-[15px] font-semibold tracking-tight">{children}</h2>
      {action}
    </div>
  );
}

// ── One field as a tile ──────────────────────────────────────────────────────

function FieldTile({
  profileId, fieldKey, label, display, raw, kind = "text", reason, readOnly, testId, removeTestId, wide,
  removable = true, iconKey,
}: {
  profileId: string;
  fieldKey: string;
  label: string;
  /** What the tile shows; null means the field is not set. */
  display: React.ReactNode | null;
  raw?: string;
  kind?: "text" | "money" | "date";
  /** Why this field is worth filling — shown while it is not set. */
  reason?: string;
  readOnly?: boolean;
  testId?: string;
  removeTestId?: string;
  wide?: boolean;
  /** False for a value that can be changed but not removed (the value itself). */
  removable?: boolean;
  /** Picks the icon when the stored key does not say what the tile is. */
  iconKey?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const { confirm, isArmed } = useConfirmArm();
  const write = useFieldWrite(profileId);
  const Icon = iconFor(iconKey || fieldKey);
  const unset = display == null;

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
      <div className={`col-span-2 ${TILE_BOX} ring-1 ring-primary/40 space-y-1.5`}>
        <label className="text-[12px] text-muted-foreground" htmlFor={`tile-${fieldKey}`}>{label}</label>
        <div className="flex items-center gap-1.5">
          <Input
            id={`tile-${fieldKey}`}
            className="h-9 text-[14px] flex-1 min-w-0"
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

  const body = (
    <>
      <Icon className="h-[18px] w-[18px] shrink-0 text-muted-foreground" strokeWidth={1.8} />
      <span className="flex-1 min-w-0">
        <span className="block text-[12px] text-muted-foreground truncate">{label}</span>
        <span className={`block truncate ${unset ? "text-[14px] text-muted-foreground/70" : "text-[15px] font-semibold tabular-nums"}`}>
          {unset ? "Not set" : display}
        </span>
      </span>
    </>
  );
  if (readOnly) return <div className={`${TILE} ${wide ? "col-span-2" : ""}`} data-testid={testId}>{body}</div>;
  return (
    <button
      type="button"
      className={`${TILE} ${wide ? "col-span-2" : ""}`}
      title={unset ? reason : undefined}
      onClick={() => { setDraft(raw ?? ""); setEditing(true); }}
      data-testid={testId}
    >
      {body}
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70" />
    </button>
  );
}

/** The record's notes, edited where they are shown (the same `notes` the Edit
 *  dialog and the chat's update_profile write). */
function NotesTile({ profileId, notes }: { profileId: string; notes: string }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await apiRequest("PATCH", `/api/profiles/${profileId}`, { notes: draft.trim() });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      void invalidateDomains("profiles");
      setEditing(false);
    } catch (err: any) {
      toast({ title: "Failed to save notes", description: formatApiError(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };
  if (editing) {
    return (
      <div className={`col-span-2 ${TILE_BOX} ring-1 ring-primary/40 space-y-1.5`}>
        <label className="text-[12px] text-muted-foreground" htmlFor={`notes-${profileId}`}>Notes</label>
        <textarea id={`notes-${profileId}`} rows={3} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-[14px]"
          placeholder="Anything worth remembering about this asset" data-testid="asset-notes-input" />
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" className="h-9 text-xs" onClick={() => setEditing(false)}>Cancel</Button>
          <Button size="sm" className="h-9 text-xs" disabled={saving || draft.trim() === notes.trim()} onClick={() => void save()} data-testid="asset-notes-save">
            {saving ? "…" : "Save"}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <button type="button" className={`${TILE} col-span-2`} onClick={() => { setDraft(notes); setEditing(true); }} data-testid="asset-detail-notes">
      <StickyNote className="h-[18px] w-[18px] shrink-0 text-muted-foreground" strokeWidth={1.8} />
      <span className="flex-1 min-w-0">
        <span className="block text-[12px] text-muted-foreground">Notes</span>
        <span className={`block text-[14px] ${notes.trim() ? "line-clamp-3 whitespace-pre-line" : "text-muted-foreground/70"}`}>
          {notes.trim() || "No notes yet"}
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70" />
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

// ── Financial position ───────────────────────────────────────────────────────

function ValueChangeCard({ profile, extra }: {
  profile: AssetLayoutProfile;
  /** The composition's own financial facts (net worth impact, equity, cost),
   *  shown under the chart so the page has ONE "Financial position". */
  extra: OverviewValue[];
}) {
  const fields = profile.fields || {};
  const { snapshot } = useAssetValuation(profile.id);
  const auto = snapshot?.mode ? snapshot.mode === "auto" : isAutoValuationEnabled(fields);
  const priceKey = PURCHASE_PRICE_KEYS.find((k) => parseMoney(fields[k]) > 0);
  const entered = userEnteredAssetValue(fields);
  const start = priceKey
    ? { value: parseMoney(fields[priceKey]), label: "Purchase price", point: "Purchased" }
    : entered > 0 ? { value: entered, label: "You entered", point: "You entered" } : null;
  // The same answer the value card, the Assets list and net worth give (Rule 1).
  const now = auto ? currentAssetValue(fields, snapshot?.record, resolveAssetValue).value : resolveAssetValue(fields);
  // The user's own number against itself is not a change.
  const hasChange = !!start && !!now && now > 0 && (!!priceKey || start.value !== now);
  if (!hasChange || !start || !now) {
    if (extra.length === 0) return null;
    return (
      <div className={PANEL} data-testid="asset-financial-position">
        <h2 className="text-[15px] font-semibold tracking-tight">Financial position</h2>
        <ExtraFacts values={extra} bare />
      </div>
    );
  }

  const delta = now - start.value;
  const pct = start.value > 0 ? (delta / start.value) * 100 : 0;
  const up = delta >= 0;
  const hi = Math.max(start.value, now), lo = Math.min(start.value, now);
  const y = (n: number) => (hi === lo ? 40 : 24 + (1 - (n - lo) / (hi - lo)) * 34);
  const y0 = y(start.value), y1 = y(now);
  const curve = `M 16 ${y0} C 86 ${y0}, 114 ${y1}, 184 ${y1}`;
  const nowLabel = auto ? "Current estimate" : "Current value";

  return (
    <div className={PANEL} data-testid="asset-financial-position">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-3 items-center">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight">Financial position</h2>
          <p className="text-[12px] text-muted-foreground">How this asset's value has changed</p>
          <div className="flex flex-wrap gap-x-4 gap-y-2 mt-3">
            <div>
              <p className="text-[12px] text-muted-foreground flex items-center gap-1.5 whitespace-nowrap">
                <span className="h-2 w-2 rounded-full bg-violet-400 shrink-0" />{start.label}
              </p>
              <p className="text-[17px] font-bold tabular-nums" data-testid="asset-position-start">{formatMoneyCompact(start.value)}</p>
            </div>
            <div>
              <p className="text-[12px] text-muted-foreground flex items-center gap-1.5 whitespace-nowrap">
                <span className="h-2 w-2 rounded-full bg-cyan-400 shrink-0" />{nowLabel}
              </p>
              <p className="text-[17px] font-bold tabular-nums" data-testid="asset-position-now">{formatMoneyCompact(now)}</p>
            </div>
          </div>
          <span
            className={`inline-flex items-center gap-1 mt-2.5 rounded-full px-2.5 py-1 text-[12px] font-semibold tabular-nums ${up ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}
            data-testid="asset-position-change"
          >
            {up ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
            {up ? "+" : "−"}{Math.abs(pct).toFixed(1)}% ({up ? "+" : "−"}{formatMoneyCompact(Math.abs(delta))})
          </span>
        </div>
        <svg viewBox="0 0 200 96" className="w-full h-auto" role="img" aria-label={`${start.label} ${formatMoneyCompact(start.value)}, ${nowLabel.toLowerCase()} ${formatMoneyCompact(now)}`}>
          <defs>
            <linearGradient id={`pos-line-${profile.id}`} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor="#a78bfa" /><stop offset="1" stopColor="#22d3ee" />
            </linearGradient>
            <linearGradient id={`pos-fill-${profile.id}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#8b5cf6" stopOpacity="0.35" /><stop offset="1" stopColor="#22d3ee" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <path d={`${curve} L 184 76 L 16 76 Z`} fill={`url(#pos-fill-${profile.id})`} />
          <path d={curve} fill="none" stroke={`url(#pos-line-${profile.id})`} strokeWidth="2" strokeLinecap="round" />
          <line x1="16" x2="16" y1={y0} y2="76" stroke="currentColor" strokeOpacity="0.15" />
          <line x1="184" x2="184" y1={y1} y2="76" stroke="currentColor" strokeOpacity="0.15" />
          <circle cx="16" cy={y0} r="4" fill="#a78bfa" stroke="white" strokeWidth="1.5" />
          <circle cx="184" cy={y1} r="4" fill="#22d3ee" stroke="white" strokeWidth="1.5" />
          <text x="16" y={y0 - 9} fontSize="10" fontWeight="600" fill="currentColor" textAnchor="start">{formatMoneyCompact(start.value)}</text>
          <text x="184" y={y1 - 9} fontSize="10" fontWeight="600" fill="currentColor" textAnchor="end">{formatMoneyCompact(now)}</text>
          <text x="16" y="90" fontSize="9" fill="currentColor" fillOpacity="0.6" textAnchor="start">{start.point}</text>
          <text x="184" y="90" fontSize="9" fill="currentColor" fillOpacity="0.6" textAnchor="end">{auto ? "Est. today" : "Today"}</text>
        </svg>
      </div>
      <ExtraFacts values={extra} />
    </div>
  );
}

function ExtraFacts({ values, bare }: { values: OverviewValue[]; bare?: boolean }) {
  if (values.length === 0) return null;
  const frame = bare ? "mt-2" : "mt-3 pt-3 border-t border-border/40";
  // One fact takes the row (label left, number right) rather than a third of it.
  if (values.length === 1) {
    const v = values[0];
    return (
      <div className={`flex items-center justify-between gap-3 ${frame}`} data-testid={`overview-metric-${v.semanticKey}`}>
        <p className="text-[13px] text-muted-foreground flex items-center gap-1.5 min-w-0">{v.label}<ProvenanceMark value={v} /></p>
        <p className={`text-[16px] font-bold tabular-nums ${toneClass(v.tone)}`}>{formatValue(v)}</p>
      </div>
    );
  }
  return (
    <div className={`grid grid-cols-2 gap-3 ${frame}`}>
      {values.map((v, i) => (
        <div key={v.semanticKey} className={`min-w-0 ${values.length % 2 === 1 && i === values.length - 1 ? "col-span-2" : ""}`} data-testid={`overview-metric-${v.semanticKey}`}>
          <p className="text-[12px] text-muted-foreground flex items-center gap-1 truncate">{v.label}<ProvenanceMark value={v} /></p>
          <p className={`text-[16px] font-bold tabular-nums leading-tight ${toneClass(v.tone)}`}>{formatValue(v)}</p>
          {v.note && <p className="text-[11px] text-muted-foreground/80 truncate">{v.note}</p>}
        </div>
      ))}
    </div>
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

function DocumentsCard({ documents, loading, failed, onRetry, onAdd }: {
  documents: any[]; loading: boolean; failed: boolean; onRetry: () => void; onAdd?: () => void;
}) {
  const [, navigate] = useLocation();
  return (
    <div className={`${PANEL} flex flex-col gap-2 min-w-0`} data-testid="asset-documents-card">
      <div className="flex items-center gap-2">
        <FileText className="h-[18px] w-[18px] shrink-0 text-muted-foreground" strokeWidth={1.8} />
        <h2 className="text-[15px] font-semibold tracking-tight">Documents</h2>
      </div>
      {failed ? (
        // Rule 7: a failed load is not "no documents".
        <div className="text-[12px] text-muted-foreground">
          Couldn't load documents.{" "}
          <button type="button" className="underline" onClick={onRetry}>Retry</button>
        </div>
      ) : loading ? (
        <div className="h-9 rounded-lg bg-muted/40 animate-pulse" />
      ) : documents.length === 0 ? (
        <div>
          <p className="text-[13px] font-medium">No documents yet</p>
          <p className="text-[12px] text-muted-foreground leading-snug">Add receipts, warranties, or related files.</p>
        </div>
      ) : (
        <div className="min-w-0">
          <p className="text-[13px] font-medium">{documents.length} on file</p>
          {documents.slice(0, 3).map((d) => (
            <button
              key={d.id}
              type="button"
              className="block w-full text-left text-[12px] text-muted-foreground hover:text-foreground truncate py-0.5"
              onClick={() => navigate(`/documents/${d.id}`)}
              data-testid={`asset-document-${d.id}`}
            >
              {d.title || d.name || "Document"}
            </button>
          ))}
        </div>
      )}
      {onAdd && (
        <Button variant="outline" size="sm" className="h-8 text-xs gap-1 self-start mt-auto" onClick={onAdd} data-testid="asset-add-document">
          <Plus className="h-3.5 w-3.5" /> {documents.length > 0 ? "View all / add" : "Add document"}
        </Button>
      )}
    </div>
  );
}

function AlertsCard({ alerts, profileId, onAdd }: { alerts: RecordAlert[]; profileId: string; onAdd: () => void }) {
  const [, navigate] = useLocation();
  const live = alerts.filter((a) => !a.cleared);
  const cleared = alerts.length - live.length;
  return (
    <div className={`${PANEL} flex flex-col gap-2 min-w-0`} data-testid="asset-alerts-card">
      <div className="flex items-center gap-2">
        <Bell className="h-[18px] w-[18px] shrink-0 text-muted-foreground" strokeWidth={1.8} />
        <h2 className="text-[15px] font-semibold tracking-tight">Alerts</h2>
      </div>
      {alerts.length === 0 ? (
        <div>
          <p className="text-[13px] font-medium">No alerts set</p>
          <p className="text-[12px] text-muted-foreground leading-snug">Add an expiration or renewal date and we'll remind you before it.</p>
        </div>
      ) : (
        <div className="min-w-0">
          {live.slice(0, 3).map((a) => (
            a.rule.sourceEntityType === "document" ? (
              // A document's date is changed on the document.
              <button key={a.id} type="button" className="block w-full text-left py-0.5 min-w-0"
                onClick={() => navigate(`/documents/${a.rule.sourceEntityId}`)} data-testid="asset-alert-row">
                <span className="block text-[13px] font-medium truncate">{a.title}</span>
                <span className="block text-[12px] text-muted-foreground truncate">{a.when}</span>
              </button>
            ) : (
              <div key={a.id} data-testid="asset-alert-row">
                <DateRow profileId={profileId} fieldKey={a.rule.sourcePath || a.rule.sourceField} label={a.title}
                  iso={a.rule.date} note={a.when} compact testId={`asset-alert-edit-${a.rule.sourceField}`} />
              </div>
            )
          ))}
          {live.length > 3 && <p className="text-[12px] text-muted-foreground">+{live.length - 3} more</p>}
          {cleared > 0 && (
            <p className="text-[12px] text-muted-foreground" data-testid="asset-alerts-cleared">
              {cleared} cleared — restore under Profile actions
            </p>
          )}
        </div>
      )}
      <Button variant="outline" size="sm" className="h-8 text-xs gap-1 self-start mt-auto" onClick={onAdd} data-testid="asset-add-alert">
        <Plus className="h-3.5 w-3.5" /> Add alert
      </Button>
    </div>
  );
}

// ── Calendar & reminders ─────────────────────────────────────────────────────

function DateBadge({ iso }: { iso: string | null }) {
  const d = iso ? parseLocalDate(iso) : null;
  if (!d) {
    return (
      <span className="h-11 w-11 shrink-0 rounded-xl border border-dashed border-border/70 grid place-items-center text-muted-foreground">
        <CalendarPlus className="h-4 w-4" />
      </span>
    );
  }
  return (
    <span className="h-11 w-11 shrink-0 rounded-xl bg-muted/50 ring-1 ring-border/60 flex flex-col items-center justify-center leading-none">
      <span className="micro-label text-muted-foreground">{d.toLocaleDateString("en-US", { month: "short" })}</span>
      <span className="text-[15px] font-bold tabular-nums mt-0.5">{d.getDate()}</span>
    </span>
  );
}

function DateRow({ profileId, fieldKey, label, iso, note, chip, reason, removeTestId, compact, testId }: {
  profileId: string; fieldKey: string; label: string; iso: string | null;
  note?: string; chip?: string; reason?: string; removeTestId?: string;
  /** No date badge — a row inside a narrow card. */
  compact?: boolean; testId?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const { confirm, isArmed } = useConfirmArm();
  const write = useFieldWrite(profileId);
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    const ok = await write(fieldKey, draft);
    setSaving(false);
    if (ok) setEditing(false);
  };
  if (editing) {
    return (
      <div className="py-2 space-y-1.5">
        <label className="text-[12px] text-muted-foreground" htmlFor={`date-${fieldKey}`}>{label}</label>
        <div className="flex flex-wrap items-center gap-1.5">
          <Input id={`date-${fieldKey}`} type="date" className="h-9 text-[14px] flex-1 min-w-0" value={draft} autoFocus
            onChange={(e) => setDraft(e.target.value)} data-testid={`asset-date-input-${fieldKey}`} />
          <Button size="sm" className="h-9 text-xs" disabled={saving || !draft} onClick={() => void save()}>{saving ? "…" : "Save"}</Button>
          {iso && (
            <Button size="sm" variant={isArmed("rm") ? "destructive" : "ghost"} className="h-9 text-xs px-2" disabled={saving}
              aria-label={isArmed("rm") ? `Tap again to remove ${label}` : `Remove ${label}`} data-testid={removeTestId}
              onClick={() => confirm("rm", async () => {
                setSaving(true);
                const ok = await write(fieldKey, null);
                setSaving(false);
                if (ok) setEditing(false);
              })}>
              {isArmed("rm") ? "Remove?" : <Trash2 className="h-3.5 w-3.5" />}
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-9 px-2" aria-label="Cancel" onClick={() => setEditing(false)}><X className="h-3.5 w-3.5" /></Button>
        </div>
        {!iso && reason && <p className="text-[11px] text-muted-foreground">{reason}</p>}
      </div>
    );
  }
  return (
    <button type="button" className={`w-full flex items-center text-left ${compact ? "gap-1.5 py-0.5" : "gap-3 py-2"}`}
      onClick={() => { setDraft(iso ? iso.slice(0, 10) : ""); setEditing(true); }}
      data-testid={testId || `asset-date-row-${fieldKey}`}>
      {!compact && <DateBadge iso={iso} />}
      <span className="flex-1 min-w-0">
        <span className={`block truncate ${compact ? "text-[13px] font-medium" : "text-[14px] font-semibold"}`}>{label}</span>
        <span className="block text-[12px] text-muted-foreground truncate">{iso ? (note || "On your calendar") : (reason || "Not set")}</span>
      </span>
      {chip && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{chip}</span>}
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70" />
    </button>
  );
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
  spec, profile, autoValuation, onOpenDocuments,
}: {
  spec: OverviewSpec;
  profile: AssetLayoutProfile;
  autoValuation: boolean;
  /** Opens the tab where documents are listed and uploaded. */
  onOpenDocuments?: () => void;
}) {
  const [, navigate] = useLocation();
  const [showMore, setShowMore] = useState(false);
  const [addingDate, setAddingDate] = useState(false);
  const fields = profile.fields || {};
  const { alerts, documents, documentsQuery } = useRecordAlerts(profile.id);

  const priceKey = PURCHASE_PRICE_KEYS.find((k) => parseMoney(fields[k]) > 0) || "purchasePrice";
  const price = parseMoney(fields[priceKey]);
  const purchaseDateKey = Object.keys(fields).find((k) => PURCHASE_DATE_RE.test(k) && fields[k]) || "purchaseDate";
  const purchaseDate = fields[purchaseDateKey] ? String(fields[purchaseDateKey]) : "";
  // Drawn by this layout itself, so the composition's copy is not repeated.
  const staple = new Set([priceKey, purchaseDateKey, "purchasePrice", "purchaseDate", "userEnteredValue", "location"]);
  const location = typeof fields.location === "string" ? fields.location.trim() : "";
  const entered = userEnteredAssetValue(fields);

  const fieldSections = spec.sections.filter((s) => !SPECIAL.has(s.component));
  const keyOf = (v: OverviewValue) => v.editable?.fieldKey || v.semanticKey;
  const valuesOf = (list: OverviewSection[]) => list.flatMap((s) => s.values || []).filter((v) => !staple.has(keyOf(v)));
  const shown = valuesOf(fieldSections.filter((s) => !s.collapsed));
  const more = valuesOf(fieldSections.filter((s) => s.collapsed));

  const dateValues = spec.sections.filter((s) => s.component === "dateCard").flatMap((s) => s.values || [])
    .filter((v) => !staple.has(keyOf(v)));
  const missingDates = spec.missingInformation.filter((m) => isDateKey(m.fieldKey) && !staple.has(m.fieldKey));
  const missingFields = spec.missingInformation.filter((m) => !isDateKey(m.fieldKey) && !staple.has(m.fieldKey)
    // The value card above is where a missing current value is set.
    && m.semanticKey !== "currentValue");

  const today = localTodayISO();
  const events = (profile.relatedEvents || [])
    .filter((e: any) => typeof e?.date === "string" && e.date.slice(0, 10) >= today)
    .sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)))
    .slice(0, 3);

  const dateOptions = [
    ...missingDates.map((m) => ({ key: m.fieldKey, label: m.label })),
    ...COMMON_DATES,
  ].filter((o, i, all) => !fields[o.key] && all.findIndex((x) => x.key === o.key) === i);

  const headlineValueKey = spec.identity.headline?.editable && /value$/i.test(spec.identity.headline.semanticKey)
    ? spec.identity.headline.editable.fieldKey : null;
  const missingValueKey = spec.missingInformation.find((m) => m.semanticKey === "currentValue")?.fieldKey || null;
  const valueLookupKey = autoValuation ? (headlineValueKey || missingValueKey) : null;
  // A summary metric that is simply one of the record's fields (a brand, a
  // model) is a detail; what is left is what the app worked out.
  const summary = spec.summaryMetrics.filter((m) => m.semanticKey !== spec.identity.headline?.semanticKey
    // Appreciation / depreciation is the Financial position card's change pill.
    && !/^(appreciation|depreciation)$/.test(m.semanticKey) && !staple.has(keyOf(m)));
  const fieldMetrics = summary.filter((m) => m.sourceReference?.kind === "field");
  const metrics = summary.filter((m) => m.sourceReference?.kind !== "field");
  const financial = spec.sections.filter((s) => s.component === "financialSummary").flatMap((s) => s.values || []);

  const tile = (v: OverviewValue) => (wide: boolean) => v.editable ? (
    <FieldTile key={v.semanticKey} profileId={profile.id} fieldKey={v.editable.fieldKey} label={v.label} wide={wide}
      display={formatValue(v)} raw={rawOf(v)} kind={kindOf(v)}
      testId={`overview-field-${v.semanticKey}`} removeTestId={`overview-field-remove-${v.semanticKey}`} />
  ) : (
    <FieldTile key={v.semanticKey} profileId={profile.id} fieldKey={v.semanticKey} label={v.label} wide={wide}
      display={formatValue(v)} readOnly testId={`overview-field-${v.semanticKey}`} />
  );

  // The grid as a list, so an odd tile out takes the row instead of leaving
  // half of it empty.
  const tiles: Array<(wide: boolean) => React.ReactNode> = [
    // The user's own number. Changing it is the same write as typing a value
    // anywhere else: `currentValue`, which the server stamps as the user's.
    ...(autoValuation && entered > 0 ? [(wide: boolean) => (
      <FieldTile key="entered" profileId={profile.id} fieldKey="currentValue" label="Your entered value" kind="money" wide={wide}
        display={formatMoneyCompact(entered)} raw={String(entered)} removable={false} testId="asset-detail-entered-value" />
    )] : []),
    (wide) => (
      <FieldTile key="price" profileId={profile.id} fieldKey={priceKey} iconKey="purchasePrice" label="Purchase price" kind="money" wide={wide}
        display={price > 0 ? formatMoneyCompact(price) : null} raw={price > 0 ? String(price) : ""}
        reason="Unlocks appreciation since you bought it"
        testId="overview-missing-purchasePrice" removeTestId="overview-field-remove-purchasePrice" />
    ),
    (wide) => (
      <FieldTile key="pdate" profileId={profile.id} fieldKey={purchaseDateKey} iconKey="purchaseDate" label="Purchase date" kind="date" wide={wide}
        display={purchaseDate ? (parseLocalDate(purchaseDate)?.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) ?? purchaseDate) : null}
        raw={/^\d{4}-\d{2}-\d{2}/.test(purchaseDate) ? purchaseDate.slice(0, 10) : ""}
        reason="Dates how long you have owned it"
        testId="asset-detail-purchase-date" removeTestId="overview-field-remove-purchaseDate" />
    ),
    (wide) => (
      <FieldTile key="location" profileId={profile.id} fieldKey="location" label="Location" wide={wide}
        display={location || null} raw={location} reason="Where it is kept — a room, a garage, a safe"
        testId="asset-detail-location" removeTestId="overview-field-remove-location" />
    ),
    ...fieldMetrics.map(tile),
    ...shown.filter((v) => !fieldMetrics.some((m) => m.semanticKey === v.semanticKey)).map(tile),
    ...missingFields.map((m) => (wide: boolean) => (
      <FieldTile key={m.semanticKey} profileId={profile.id} fieldKey={m.fieldKey} label={m.label} wide={wide}
        display={null} reason={m.reason} testId={`overview-missing-${m.semanticKey}`} />
    )),
    ...(showMore ? more.map(tile) : []),
  ];

  const sectionsOf = (...components: string[]) =>
    spec.sections.filter((s) => components.includes(s.component)).map((s) => renderSection(s, profile.id));

  return (
    <>
      <AttentionStrip spec={spec} />

      {/* ── Asset details ── */}
      <div className="space-y-2" data-testid="asset-details">
        <SectionTitle action={valueLookupKey ? <FindValueButton profileId={profile.id} fieldKey={valueLookupKey} /> : undefined}>
          Asset details
        </SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          {tiles.map((t, i) => t(tiles.length % 2 === 1 && i === tiles.length - 1))}
          <NotesTile profileId={profile.id} notes={profile.notes || ""} />
        </div>
        {more.length > 0 && (
          <button type="button" className="text-[12px] text-muted-foreground hover:text-foreground flex items-center gap-1 px-0.5"
            onClick={() => setShowMore((s) => !s)} data-testid="asset-details-more">
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showMore ? "rotate-180" : ""}`} />
            {showMore ? "Show fewer details" : `Show ${more.length} more detail${more.length === 1 ? "" : "s"}`}
          </button>
        )}
      </div>

      {metrics.length > 0 && (
        <div className={`grid gap-2 ${metrics.length >= 3 ? "grid-cols-3" : "grid-cols-2"}`} data-testid="overview-summary-metrics">
          {metrics.map((m, i) => (
            <div key={m.semanticKey} className={`${TILE_BOX} min-w-0 ${metrics.length % (metrics.length >= 3 ? 3 : 2) !== 0 && i === metrics.length - 1 ? "col-span-full" : ""}`} data-testid={`overview-summary-${m.semanticKey}`}>
              <p className="text-[12px] text-muted-foreground flex items-center gap-1 truncate">{m.label}<ProvenanceMark value={m} /></p>
              <p className={`text-[16px] font-bold tabular-nums leading-tight ${toneClass(m.tone)}`}>{formatValue(m)}</p>
              {m.note && <p className="text-[11px] text-muted-foreground/80 truncate">{m.note}</p>}
            </div>
          ))}
        </div>
      )}

      <ValueChangeCard profile={profile} extra={financial} />
      {sectionsOf("progressIndicator", "relationshipSummary", "ownershipSummary")}

      {/* ── Documents | Alerts ── */}
      <div className="grid grid-cols-2 gap-2">
        <DocumentsCard documents={documents} loading={documentsQuery.isLoading} failed={documentsQuery.isError}
          onRetry={() => void documentsQuery.refetch()} onAdd={onOpenDocuments} />
        <AlertsCard alerts={alerts} profileId={profile.id} onAdd={() => setAddingDate(true)} />
      </div>

      {/* ── Calendar & reminders ── */}
      <div className={PANEL} data-testid="asset-calendar-card">
        <div className="flex items-start gap-2.5">
          <Calendar className="h-[18px] w-[18px] shrink-0 text-muted-foreground mt-0.5" strokeWidth={1.8} />
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-semibold tracking-tight">Calendar &amp; reminders</h2>
            <p className="text-[12px] text-muted-foreground">Key dates and related reminders for this asset</p>
          </div>
          {!addingDate && (
            <Button variant="outline" size="sm" className="h-8 text-xs gap-1 shrink-0" onClick={() => setAddingDate(true)} data-testid="asset-add-date">
              <Plus className="h-3.5 w-3.5" /> Add date
            </Button>
          )}
        </div>
        <div className="mt-2 divide-y divide-border/40">
          {dateValues.map((v) => v.editable ? (
            <DateRow key={v.semanticKey} profileId={profile.id} fieldKey={v.editable.fieldKey} label={v.label}
              iso={v.value == null ? null : String(v.value)} note={v.note}
              removeTestId={`overview-field-remove-${v.semanticKey}`} />
          ) : (
            <div key={v.semanticKey} className="flex items-center gap-3 py-2">
              <DateBadge iso={v.value == null ? null : String(v.value)} />
              <span className="flex-1 min-w-0">
                <span className="block text-[14px] font-semibold truncate">{v.label}</span>
                {v.note && <span className="block text-[12px] text-muted-foreground truncate">{v.note}</span>}
              </span>
            </div>
          ))}
          {events.map((e: any) => (
            <button key={e.id} type="button" className="w-full flex items-center gap-3 py-2 text-left"
              onClick={() => navigate("/calendar")} data-testid={`asset-event-row-${e.id}`}>
              <DateBadge iso={String(e.date)} />
              <span className="flex-1 min-w-0">
                <span className="block text-[14px] font-semibold truncate">{e.title || "Event"}</span>
                <span className="block text-[12px] text-muted-foreground truncate">Opens your calendar</span>
              </span>
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">Event</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70" />
            </button>
          ))}
          {missingDates.map((m) => (
            <DateRow key={m.semanticKey} profileId={profile.id} fieldKey={m.fieldKey} label={m.label} iso={null} reason={m.reason} />
          ))}
          {dateValues.length + events.length + missingDates.length === 0 && !addingDate && (
            <p className="py-2 text-[13px] text-muted-foreground" data-testid="asset-calendar-empty">
              No dates on this asset yet. Add one and it shows on your calendar.
            </p>
          )}
        </div>
        {addingDate && <div className="mt-2"><AddDateForm profileId={profile.id} options={dateOptions} onDone={() => setAddingDate(false)} /></div>}
      </div>

      {sectionsOf("maintenanceSummary", "miniTimeline", "aiInsight")}
    </>
  );
}

// ── Profile actions ──────────────────────────────────────────────────────────

function ActionRow({ icon: Icon, title, detail, onClick, danger, disabled, testId }: {
  icon: any; title: string; detail: string; onClick: () => void; danger?: boolean; disabled?: boolean; testId?: string;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} data-testid={testId}
      className="w-full flex items-center gap-3 px-4 py-3 text-left disabled:opacity-50 hover:bg-muted/20 transition-colors">
      <Icon className={`h-[18px] w-[18px] shrink-0 ${danger ? "text-red-500" : "text-muted-foreground"}`} strokeWidth={1.8} />
      <span className="flex-1 min-w-0">
        <span className={`block text-[14px] font-semibold ${danger ? "text-red-500" : ""}`}>{title}</span>
        <span className="block text-[12px] text-muted-foreground">{detail}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70" />
    </button>
  );
}

/**
 * What you do TO the record: edit it, add a field, silence its alerts, delete
 * it. Clearing dismisses this record's dated alerts into the server's dismiss
 * list (the one the bell and the dashboard read), so it follows the user
 * across devices and Restore brings every one of them back.
 */
export function AssetProfileActions({ profileId, noun = "asset", onEdit, onDelete }: {
  profileId: string;
  noun?: string;
  onEdit: () => void;
  /** Opens the delete confirmation — this never deletes on its own (Rule 8). */
  onDelete: () => void;
}) {
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const { alerts, dismiss, restore } = useRecordAlerts(profileId);
  const live = alerts.filter((a) => !a.cleared);
  const cleared = alerts.filter((a) => a.cleared);
  const busy = dismiss.isPending || restore.isPending;

  const clear = () => dismiss.mutate(live.map((a) => a.id), {
    onSuccess: () => toast({
      title: `Cleared ${live.length} alert${live.length === 1 ? "" : "s"}`,
      description: "The dates stay on the records. Restore brings the alerts back.",
    }),
  });
  const bringBack = () => restore.mutate(cleared.map((a) => a.id), {
    onSuccess: () => toast({ title: "Alerts restored" }),
  });

  return (
    <div className="mt-6 space-y-2" data-testid="profile-alerts-section">
      <SectionTitle>Profile actions</SectionTitle>
      <div className="bubble overflow-hidden divide-y divide-border/40">
        <ActionRow icon={Pencil} title={`Edit ${noun} details`} detail="Update name, values, dates, location, and notes" onClick={onEdit} testId="action-edit-profile" />
        <ActionRow icon={Plus} title="Add custom field" detail="Track additional details (e.g., serial number, condition)" onClick={() => setAdding((a) => !a)} testId="action-add-field" />
        {adding && (
          <div className="px-4 py-3">
            <AddFieldPanel profileId={profileId} inline onAdded={() => setAdding(false)} />
          </div>
        )}
        <ActionRow
          icon={BellOff}
          title="Clear document alerts"
          detail={alerts.length === 0
            ? "No dates on this record are raising alerts"
            : live.length === 0
              ? "All of this record's alerts are cleared"
              : `Hide ${live.length} alert${live.length === 1 ? "" : "s"} from this record and its documents`}
          onClick={clear}
          disabled={live.length === 0 || busy}
          testId="button-clear-document-alerts"
        />
        {cleared.length > 0 && (
          <ActionRow icon={Bell} title="Restore alerts" detail={`Bring back ${cleared.length} cleared alert${cleared.length === 1 ? "" : "s"}`}
            onClick={bringBack} disabled={busy} testId="button-restore-document-alerts" />
        )}
        <ActionRow icon={Trash2} title={`Delete this ${noun}`} detail={`Permanently remove this ${noun} and all its data`} onClick={onDelete} danger testId="button-delete-profile-info-tab" />
      </div>
    </div>
  );
}
