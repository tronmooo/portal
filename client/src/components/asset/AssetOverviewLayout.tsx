// ─── Asset profile layout (owner's design, 2026-11-23) ──────────────────────
//
// The asset's Overview as the owner settled it ("we're gonna simplify this
// completely"): the Value card, a three-sentence AI summary, and ONE plain
// list of details with a pencil per line.
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
  Bell, BellOff, Calendar, CalendarPlus, Check, ChevronDown, ChevronRight, CircleDot, FileText, Hash,
  MapPin, MoreHorizontal, Package, Pencil, Plus, RefreshCw, ShoppingCart, StickyNote, Tag, Type, Users, Trash2, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateDomains } from "@/lib/cache-bus";
import { formatApiError } from "@/lib/formatError";
import { formatMoneyCompact, parseLocalDate } from "@/lib/format";
import { localTodayISO } from "@/lib/dates";
import { useToast } from "@/hooks/use-toast";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import { useAssetValuation, useAssetValuationHistory } from "@/hooks/useAssetValuation";
import { SALVAGE_KEY, SALVAGE_BASIS_KEY, SALVAGE_BOOKKEEPING_KEYS, salvageSource } from "@shared/asset-salvage";
import { projectDepreciation, recentChange, seriesInRange, valueSeries, VALUE_RANGES, type ValuePoint, type ValueRangeKey } from "@shared/asset-depreciation";
import { formatTimeAgo } from "@/lib/format";
import { useDismissedAlerts } from "@/hooks/useDismissedAlerts";
import { AddFieldPanel } from "@/components/AddFieldPanel";
import { CurrentValueCard } from "@/components/asset/CurrentValueCard";
import {
  formatValue, useFieldWrite,
} from "@/components/overview/DynamicOverview";
import { parseMoney, resolveAssetValue } from "@shared/asset-value";
import { currentAssetValue, isAutoValuationEnabled } from "@shared/valuation/context";
import { countdownLabel, isAlertDateRule, rulesFromAll, type DateRule } from "@shared/date-rules";
import { dateAlertId } from "@shared/alert-ids";
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
const PURCHASE_PRICE_KEYS = ["purchasePrice", "originalPrice", "costBasis"];
const PURCHASE_DATE_RE = /^(purchase|purchased|acquisition|acquired|bought)[_ ]?(date|on)$|^date[_ ]?(of[_ ]?)?purchased?$/i;
/** Sections with a shape of their own; everything else is a card of fields. */
const SPECIAL = new Set([
  "financialSummary", "progressIndicator", "relationshipSummary", "ownershipSummary", "dateCard",
  "documentSummary", "maintenanceSummary", "miniTimeline", "missingInfo", "aiInsight",
]);

// ── Asset details: one plain list ────────────────────────────────────────────

/**
 * One line of the Asset details list, as the owner drew it: the label on the
 * left, the value on the right, a pencil. The pencil turns the value into an
 * input in place; the check writes it — the same field the chat's
 * update_profile writes — and the X (two taps, Rule 8) removes it.
 */
function Line({ label, display, raw, kind = "text", save, remove, onOpen, hint, testId, inputTestId, removeTestId, multiline }: {
  label: string;
  /** What the line shows; null means it is not set. */
  display: React.ReactNode | null;
  raw?: string;
  kind?: "text" | "money" | "date";
  /** Stores the typed value; absent on a line the app worked out. */
  save?: (value: string | number) => Promise<boolean>;
  remove?: () => Promise<boolean>;
  /** A line that opens somewhere else instead of editing here (Ownership). */
  onOpen?: () => void;
  hint?: string;
  testId?: string; inputTestId?: string; removeTestId?: string;
  multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const { confirm, isArmed } = useConfirmArm();
  const unset = display == null;
  const commit = async () => {
    const text = draft.trim();
    if (!text || !save) return;
    setBusy(true);
    const ok = await save(kind === "money" ? parseMoney(text) : text);
    setBusy(false);
    if (ok) setEditing(false);
  };
  const row = "flex items-center gap-3 min-h-[40px] py-1.5 border-b border-border/30 last:border-b-0";

  if (editing) {
    return (
      <div className={`${row} flex-wrap`}>
        <span className="text-[13px] text-muted-foreground shrink-0">{label}</span>
        <div className="flex-1 min-w-[160px] flex items-center justify-end gap-1">
          {multiline ? (
            <textarea autoFocus rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={label}
              className="flex-1 min-w-0 rounded-md border border-input bg-background px-2 py-1 text-[13px]" data-testid={inputTestId} />
          ) : (
            <Input autoFocus value={draft} type={kind === "date" ? "date" : "text"} inputMode={kind === "money" ? "decimal" : undefined}
              onChange={(e) => setDraft(e.target.value)} aria-label={label}
              onKeyDown={(e) => { if (e.key === "Enter") void commit(); if (e.key === "Escape") setEditing(false); }}
              className="h-8 text-[13px] flex-1 min-w-0 text-right" data-testid={inputTestId} />
          )}
          <button type="button" className="h-8 w-8 grid place-items-center text-emerald-400 disabled:opacity-40" disabled={busy || !draft.trim()}
            onClick={() => void commit()} aria-label={`Save ${label}`} data-testid={inputTestId ? `${inputTestId}-save` : undefined}><Check className="h-4 w-4" /></button>
          {remove && !unset && (
            <button type="button" disabled={busy}
              className={`h-8 min-w-8 px-1 grid place-items-center rounded text-[11px] ${isArmed("rm") ? "bg-destructive text-destructive-foreground" : "text-muted-foreground hover:text-destructive"}`}
              aria-label={isArmed("rm") ? `Tap again to remove ${label}` : `Remove ${label}`} data-testid={removeTestId}
              onClick={() => confirm("rm", async () => { setBusy(true); const ok = await remove(); setBusy(false); if (ok) setEditing(false); })}>
              {isArmed("rm") ? "Remove?" : <Trash2 className="h-3.5 w-3.5" />}
            </button>
          )}
          <button type="button" className="h-8 w-8 grid place-items-center text-muted-foreground" onClick={() => setEditing(false)} aria-label="Cancel"><X className="h-4 w-4" /></button>
        </div>
      </div>
    );
  }

  const value = (
    <span className={`min-w-0 truncate text-right text-[14px] ${unset ? "text-muted-foreground/70" : "font-semibold tabular-nums"}`}>
      {unset ? "Not set" : display}
    </span>
  );
  const open = onOpen ?? (save ? () => { setDraft(raw ?? ""); setEditing(true); } : undefined);
  if (!open) {
    return (
      <div className={row} data-testid={testId}>
        <span className="text-[13px] text-muted-foreground shrink-0">{label}</span>
        <span className="flex-1" />{value}<span className="w-4 shrink-0" />
      </div>
    );
  }
  return (
    <button type="button" className={`${row} w-full text-left`} onClick={open} title={unset ? hint : undefined} data-testid={testId}>
      <span className="text-[13px] text-muted-foreground shrink-0">{label}</span>
      <span className="flex-1" />{value}
      {onOpen ? <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70" /> : <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />}
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

const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/**
 * The value over time: the purchase (when its price and date are on file),
 * every stored valuation, and today — on a real time axis, with the range's
 * first and last points named. A range with fewer than two points says so
 * instead of drawing a line through nothing.
 */
function ValueGraph({ id, points }: { id: string; points: ValuePoint[] }) {
  const [range, setRange] = useState<ValueRangeKey>("all");
  const now = useMemo(() => new Date(), [points]);
  const shown = useMemo(() => seriesInRange(points, range, now), [points, range, now]);
  const drawable = shown.length >= 2;
  const t0 = drawable ? Date.parse(shown[0].at) : 0;
  const t1 = drawable ? Date.parse(shown[shown.length - 1].at) : 1;
  const hi = Math.max(...shown.map((p) => p.value), 1), lo = Math.min(...shown.map((p) => p.value), hi);
  const xy = shown.map((p) => {
    const x = t1 === t0 ? 100 : 6 + ((Date.parse(p.at) - t0) / (t1 - t0)) * 188;
    const y = hi === lo ? 30 : 8 + (1 - (p.value - lo) / (hi - lo)) * 44;
    return [x, y] as const;
  });
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const first = shown[0], last = shown[shown.length - 1];
  const fell = drawable && last.value < first.value;

  return (
    <div className="mt-1.5" data-testid="asset-value-graph">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-muted-foreground">Value over time</span>
        <div className="flex items-center gap-0.5" role="group" aria-label="Time range">
          {VALUE_RANGES.map((r) => (
            <button key={r.key} type="button" onClick={() => setRange(r.key)} aria-pressed={range === r.key}
              className={`h-6 px-2 rounded-md text-[11px] font-semibold ${range === r.key ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              data-testid={`asset-value-range-${r.key}`}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {drawable ? (
        <>
          <svg viewBox="0 0 200 60" preserveAspectRatio="none" className="w-full h-[72px] mt-1" role="img"
            aria-label={`From ${formatMoneyCompact(first.value)} on ${dayLabel(first.at)} to ${formatMoneyCompact(last.value)} on ${dayLabel(last.at)}`}>
            <defs>
              <linearGradient id={`val-fill-${id}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#8b5cf6" stopOpacity="0.35" /><stop offset="1" stopColor="#8b5cf6" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <path d={`${line} L ${xy[xy.length - 1][0].toFixed(1)} 58 L ${xy[0][0].toFixed(1)} 58 Z`} fill={`url(#val-fill-${id})`} />
            <path d={line} fill="none" stroke="#a78bfa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </svg>
          <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground tabular-nums">
            <span data-testid="asset-value-graph-start">{dayLabel(first.at)} · {formatMoneyCompact(first.value)}</span>
            <span className={fell ? "text-red-400" : last.value > first.value ? "text-emerald-400" : ""} data-testid="asset-value-graph-end">
              Today · {formatMoneyCompact(last.value)}
            </span>
          </div>
        </>
      ) : (
        <p className="py-2 text-[12px] text-muted-foreground" data-testid="asset-value-graph-empty">
          Not enough valuations in this range yet. Each new estimate adds a point.
        </p>
      )}
    </div>
  );
}

/**
 * What it would fetch at the end of its useful life. Estimated by the AI on
 * each value-tracking run (shared/asset-salvage.ts, server/valuation/salvage.ts);
 * a figure the user types replaces it until they remove it.
 */
export { SALVAGE_KEY };

/**
 * Value & Depreciation. Owner, 2026-11-23: "make sure it says how much it
 * depreciated — it's just a random graph, that means nothing … add the asset
 * salvage value … remove confidence." So: no chart of past estimates and no
 * confidence figure; ONE bar that is the purchase price, filled by what has
 * been lost, then the money lines — purchase price, current value, total
 * invested, salvage value — each edited in place where it is the user's own.
 */
export function ValueCard({ profile, spent = 0 }: {
  profile: AssetLayoutProfile;
  /** What has been spent on it since (the composition's "Spent to date"). */
  spent?: number;
}) {
  const v = useValuePosition(profile);
  const [details, setDetails] = useState(false);
  const write = useFieldWrite(profile.id);
  const fields = profile.fields || {};
  const priceKey = PURCHASE_PRICE_KEYS.find((k) => parseMoney(fields[k]) > 0) || "purchasePrice";
  const salvage = parseMoney(fields[SALVAGE_KEY]);
  const salvageBy = salvage > 0 ? salvageSource(fields) : null;
  const salvageBasis = salvageBy === "estimate" && typeof fields[SALVAGE_BASIS_KEY] === "string" ? String(fields[SALVAGE_BASIS_KEY]) : "";
  const history = useAssetValuationHistory(profile.id, v.supported);
  const purchaseDateKey = Object.keys(fields).find((k) => PURCHASE_DATE_RE.test(k) && fields[k]);
  const purchaseDate = purchaseDateKey ? String(fields[purchaseDateKey]) : null;
  const points = useMemo(
    () => valueSeries({ history: history.data || [], purchasePrice: v.paid, purchaseDate, currentValue: v.now, now: new Date() }),
    [history.data, v.paid, purchaseDate, v.now],
  );
  const moved = useMemo(() => recentChange(points), [points]);
  const ahead = projectDepreciation({ purchasePrice: v.paid, purchaseDate, currentValue: v.now, salvageValue: parseMoney(fields[SALVAGE_KEY]), now: new Date() });
  const valuedAt = v.record?.valuedAt || null;
  const failed = v.record?.status === "error";
  const up = v.delta > 0;
  const lostShare = v.hasChange && !up ? Math.min(1, Math.abs(v.delta) / v.paid) : 0;
  const salvageShare = salvage > 0 && v.paid > 0 && salvage < v.paid ? salvage / v.paid : null;
  const aboveSalvage = salvage > 0 && v.now > 0 ? v.now - salvage : null;

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

      {/* How much it has depreciated: the bar is the purchase price, the
          filled part is what has been lost. */}
      <div className="bubble-row !rounded-xl px-3 py-2 mt-1 mb-1" data-testid="asset-depreciation">
        {v.hasChange ? (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[13px] text-muted-foreground">{up ? "Gained since purchase" : "Depreciated since purchase"}</span>
              <span className={`text-[16px] font-bold tabular-nums ${up ? "text-emerald-400" : "text-red-400"}`} data-testid="asset-depreciation-amount">
                {signed(v.delta)} <span className="text-[12px] font-semibold">({signedPct(v.pct)})</span>
              </span>
            </div>
            {!up && (
              <div className="relative mt-1.5 h-1.5 rounded-full bg-muted" role="img"
                aria-label={`${Math.round(lostShare * 100)}% of the purchase price lost`}>
                <div className="h-full rounded-full bg-gradient-to-r from-orange-400 to-red-400" style={{ width: `${Math.max(2, Math.round(lostShare * 1000) / 10)}%` }} data-testid="asset-depreciation-bar" />
                {/* Where it stops: the salvage value, measured from the right. */}
                {salvageShare != null && (
                  <span className="absolute -top-0.5 h-2.5 w-0.5 rounded bg-foreground/70" style={{ left: `${(1 - salvageShare) * 100}%` }} title="Salvage value" data-testid="asset-salvage-mark" />
                )}
              </div>
            )}
            <p className="mt-1 text-[11px] text-muted-foreground">
              {up
                ? `Worth ${formatMoneyCompact(v.now)} against ${formatMoneyCompact(v.paid)} paid.`
                : `${Math.round(lostShare * 100)}% of the ${formatMoneyCompact(v.paid)} paid is gone; ${formatMoneyCompact(v.now)} is left.`}
              {aboveSalvage != null && aboveSalvage > 0 && ` ${formatMoneyCompact(aboveSalvage)} of that is above its salvage value.`}
            </p>
          </>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            {v.paid > 0 ? "No current value yet — tap Refresh to estimate it." : "Add the purchase price below to see how much it has depreciated."}
          </p>
        )}
      </div>

      {/* When it was last valued, and whether a fresh estimate is on its way.
          The saved figures above stay on screen while it is. */}
      {v.auto && v.supported && (
        <p className="text-[11px] text-muted-foreground flex flex-wrap items-center gap-x-2" data-testid="asset-value-status">
          {v.refreshing && <span className="text-primary flex items-center gap-1" data-testid="asset-value-updating"><RefreshCw className="h-3 w-3 animate-spin" /> Checking for an updated value…</span>}
          {valuedAt
            ? <span title={valuedAt} data-testid="asset-value-last-valued">{failed ? "Couldn't update just now — showing the estimate from" : "Last valued"} {dayLabel(valuedAt)} ({formatTimeAgo(valuedAt)})</span>
            : !v.refreshing && <span>Not valued yet.</span>}
        </p>
      )}
      {v.supported && <ValueGraph id={profile.id} points={points} />}
      {(moved || ahead) && (
        <div className="mt-1 mb-1 space-y-0.5 text-[12px] text-muted-foreground">
          {moved && (
            <p data-testid="asset-value-recent-change">
              Latest change: <span className={`font-semibold tabular-nums ${moved.delta < 0 ? "text-red-400" : "text-emerald-400"}`}>{signed(moved.delta)} ({signedPct(moved.pct)})</span> since {dayLabel(moved.since)}.
            </p>
          )}
          {ahead && (
            <p data-testid="asset-value-projection">
              At this rate (about {ahead.annualRatePct}% a year), roughly <span className="font-semibold tabular-nums text-foreground">{formatMoneyCompact(ahead.inOneYear)}</span> a year from now. An estimate from the purchase price and date.
            </p>
          )}
        </div>
      )}

      <Line label="Purchase price" kind="money" display={v.paid > 0 ? formatMoneyCompact(v.paid) : null} raw={v.paid > 0 ? String(v.paid) : ""}
        save={(val) => write(priceKey, val)} remove={() => write(priceKey, null)} hint="Unlocks how much it has depreciated"
        testId="overview-missing-purchasePrice" inputTestId="overview-field-input-purchasePrice" removeTestId="overview-field-remove-purchasePrice" />
      <Line label={v.auto ? "Current value" : "Your value"} testId="asset-value-row-current-value"
        display={v.now > 0 ? <span className="text-emerald-400">{formatMoneyCompact(v.now)}</span> : null} />
      {/* Purchase price plus what was spent on it since — only when both are known. */}
      {v.paid > 0 && spent > 0 && (
        <Line label="Total invested" display={formatMoneyCompact(v.paid + spent)} testId="asset-value-row-total-invested" />
      )}
      <Line label="Salvage value" kind="money"
        display={salvage > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            {formatMoneyCompact(salvage)}
            {salvageBy === "estimate" && <span className="rounded bg-primary/15 px-1 py-px text-[11px] font-semibold text-primary" data-testid="asset-salvage-ai">AI</span>}
          </span>
        ) : null}
        raw={salvage > 0 ? String(salvage) : ""}
        save={(val) => write(SALVAGE_KEY, val)} remove={() => write(SALVAGE_KEY, null)}
        hint={v.auto && v.supported
          ? "What it would fetch at the end of its useful life. Portol's AI estimates it when it values the asset."
          : "What it would fetch at the end of its useful life"}
        testId="asset-value-salvage" inputTestId={`overview-field-input-${SALVAGE_KEY}`} removeTestId="overview-field-remove-salvageValue" />
      {salvageBy === "estimate" && (
        <p className="pt-1 text-[11px] text-muted-foreground" data-testid="asset-salvage-basis">
          AI estimate{salvageBasis ? `: ${salvageBasis}` : "."} Tap to use your own figure.
        </p>
      )}
      {salvageBy === "user" && v.auto && v.supported && (
        <p className="pt-1 text-[11px] text-muted-foreground" data-testid="asset-salvage-user">
          Your figure. Remove it to let the AI estimate it on the next refresh.
        </p>
      )}
      {salvage <= 0 && v.auto && v.supported && (
        <p className="pt-1 text-[11px] text-muted-foreground" data-testid="asset-salvage-pending">
          The AI estimates the salvage value on the next valuation{v.refreshing ? " — running now." : "."}
        </p>
      )}

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
    <div className="space-y-2" data-testid="asset-add-date-form">
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
  spec, profile, ownerLabel, onOpenOwnership, summarySlot, tailSlot,
}: {
  spec: OverviewSpec;
  profile: AssetLayoutProfile;
  autoValuation?: boolean;
  /** "You own this" / "Owned by …" — from the owner links, which the page holds. */
  ownerLabel: string;
  /** Opens the tab where ownership is changed. */
  onOpenOwnership?: () => void;
  /** Kept for callers; the list edits in place and the ⋯ menu holds Edit. */
  onEdit?: () => void;
  /** The AI summary card — the page owns it. */
  summarySlot?: React.ReactNode;
  /** The page's own cards (saved characteristic cells; trackers when the
   *  asset has no tab for them), drawn after the list. */
  tailSlot?: React.ReactNode;
}) {
  const [addingField, setAddingField] = useState(false);
  const fields = profile.fields || {};

  const priceKey = PURCHASE_PRICE_KEYS.find((k) => parseMoney(fields[k]) > 0) || "purchasePrice";
  const price = parseMoney(fields[priceKey]);
  const purchaseDateKey = Object.keys(fields).find((k) => PURCHASE_DATE_RE.test(k) && fields[k]) || "purchaseDate";
  const purchaseDate = fields[purchaseDateKey] ? String(fields[purchaseDateKey]) : "";
  const location = typeof fields.location === "string" ? fields.location.trim() : "";
  // Drawn by this layout itself, so the composition's copy is not repeated.
  const staple = new Set([priceKey, purchaseDateKey, "purchasePrice", "purchaseDate", "userEnteredValue", "location", "ownershipPercentage", SALVAGE_KEY, ...SALVAGE_BOOKKEEPING_KEYS]);

  const keyOf = (v: OverviewValue) => v.editable?.fieldKey || v.semanticKey;
  const fieldSections: OverviewSection[] = spec.sections.filter((s) => !SPECIAL.has(s.component));
  const summary = spec.summaryMetrics.filter((m) => m.semanticKey !== spec.identity.headline?.semanticKey
    // Appreciation / depreciation is the header's and the value card's.
    && !/^(appreciation|depreciation)$/.test(m.semanticKey) && !staple.has(keyOf(m)));
  // A summary metric that is simply one of the record's fields (a brand, a
  // model) is a characteristic.
  const fieldMetrics = summary.filter((m) => m.sourceReference?.kind === "field");
  const characteristics = [
    ...fieldMetrics,
    ...fieldSections.flatMap((s) => s.values || []).filter((v) => !staple.has(keyOf(v))),
  ].filter((v, i, all) => all.findIndex((x) => x.semanticKey === v.semanticKey) === i);

  const dateValues = spec.sections.filter((s) => s.component === "dateCard").flatMap((s) => s.values || [])
    .filter((v) => !staple.has(keyOf(v)));
  const write = useFieldWrite(profile.id);
  const saveField = (key: string) => (value: string | number) => write(key, value);
  const removeField = (key: string) => () => write(key, null);
  const { toast } = useToast();
  /** The record's own `name` / `notes` (not a field). */
  const saveRecord = (prop: "name" | "notes") => async (value: string | number) => {
    try {
      await apiRequest("PATCH", `/api/profiles/${profile.id}`, { [prop]: String(value) });
      queryClient.setQueryData(["/api/profiles", profile.id, "detail"], (old: any) => (old ? { ...old, [prop]: String(value) } : old));
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profile.id, "detail"] });
      void invalidateDomains("profiles");
      return true;
    } catch (err: any) {
      toast({ title: "Couldn't save", description: formatApiError(err), variant: "destructive" });
      return false;
    }
  };
  const isoDay = (v: string) => /^\d{4}-\d{2}-\d{2}/.test(v);
  const showDate = (v: string) => (isoDay(v) ? parseLocalDate(v)?.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) ?? v : v);
  const spent = Number(spec.summaryMetrics.find((m) => m.semanticKey === "totalExpenses")?.value) || 0;

  const valueLine = (v: OverviewValue) => {
    const key = v.editable?.fieldKey;
    return (
      <Line key={v.semanticKey} label={v.label} display={formatValue(v)} raw={rawOf(v)} kind={kindOf(v)}
        save={key ? saveField(key) : undefined} remove={key ? removeField(key) : undefined}
        testId={`overview-field-${v.semanticKey}`} inputTestId={key ? `overview-field-input-${key}` : undefined}
        removeTestId={`overview-field-remove-${v.semanticKey}`} />
    );
  };

  // The whole Overview (owner, 2026-11-23: "we're gonna simplify this
  // completely"), in the owner's order (2026-11-23, final): Asset details
  // first, then the summary, then the value. Quick Info, linked
  // sections, trackers and recent activity are not here — they are the other
  // tabs' (Financials, Contained, History).
  return (
    <>
      <section className={PANEL} data-testid="asset-details">
        <h2 className="text-[15px] font-semibold tracking-tight mb-0.5">Asset details</h2>
        {/* One column on a phone; two on a wide screen, so a line's value is
            not a screen's width from its label. */}
        <div className="lg:grid lg:grid-cols-2 lg:gap-x-10">
        <Line label="Name" display={profile.name || null} raw={profile.name || ""} save={saveRecord("name")}
          testId="asset-detail-name" inputTestId="asset-name-input" />
        <Line label="Category" display={<span className="capitalize">{spec.identity.entityLabel || profile.type}</span>} testId="asset-detail-category" />
        {characteristics.map(valueLine)}
        <Line label="Purchase date" kind={!purchaseDate || isoDay(purchaseDate) ? "date" : "text"}
          display={purchaseDate ? showDate(purchaseDate) : null} raw={isoDay(purchaseDate) ? purchaseDate.slice(0, 10) : purchaseDate}
          save={saveField(purchaseDateKey)} remove={removeField(purchaseDateKey)}
          testId="asset-detail-purchase-date" inputTestId={`overview-field-input-${purchaseDateKey}`} removeTestId="overview-field-remove-purchaseDate" />
        <Line label="Location" display={location || null} raw={location} save={saveField("location")} remove={removeField("location")}
          testId="asset-detail-location" inputTestId="overview-field-input-location" removeTestId="overview-field-remove-location" />
        {dateValues.map(valueLine)}
        <Line label="Ownership" display={ownerLabel} onOpen={onOpenOwnership} testId="asset-detail-ownership" />
        <Line label="Notes" display={(profile.notes || "").trim() || null} raw={profile.notes || ""} save={saveRecord("notes")} multiline
          testId="asset-detail-notes" inputTestId="asset-notes-input" />
        </div>
        {addingField ? (
          <div className="pt-2"><AddFieldPanel profileId={profile.id} inline onAdded={() => setAddingField(false)} /></div>
        ) : (
          <button type="button" className="mt-1.5 flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
            onClick={() => setAddingField(true)} data-testid="asset-add-characteristic">
            <Plus className="h-3.5 w-3.5" /> Add characteristic
          </button>
        )}
      </section>

      <div className={`grid grid-cols-1 gap-2.5 ${summarySlot ? "lg:grid-cols-2" : ""}`}>
        {summarySlot && <div className="min-w-0 [&>*]:h-full" data-testid="asset-summary-slot">{summarySlot}</div>}
        <ValueCard profile={profile} spent={spent} />
      </div>

      {tailSlot}
    </>
  );
}

// ── "Add a date", opened from the header's ⋯ menu ────────────────────────────

/** A dialog holding the add-a-date form (a warranty, a renewal, an expiration). */
export function AssetAddDateDialog({ profileId, fields, open, onOpenChange }: {
  profileId: string;
  /** The record's fields, so the form does not offer a date it already has. */
  fields?: Record<string, any> | null;
  open: boolean; onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" data-testid="asset-add-date-dialog">
        <DialogHeader><DialogTitle>Add a date to this asset</DialogTitle></DialogHeader>
        {open && <AddDateForm profileId={profileId} options={COMMON_DATES.filter((o) => !fields?.[o.key])} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
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
