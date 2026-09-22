// ─── CurrentValueCard ───────────────────────────────────────────────────────
// The asset profile's "what is it worth right now" card. Renders the stored
// estimate immediately (it arrives with the profile bootstrap), shows the
// range, confidence, when it was last valued and whether a background refresh
// is running, and opens into the full explanation: methodology, every piece
// of evidence with its source and age, the facts that were used, and what
// would tighten the estimate. Presentation only — all numbers come from the
// ValuationRecord the server computed.
//
// It also carries the ONE switch that turns automatic tracking off for this
// asset (`fields.valuationMode`, read through isAutoValuationEnabled — absent
// means auto, so every existing asset is unchanged). Off, the card becomes
// the user's own value with an inline editor; the last estimate stays
// reachable under the disclosure, labelled as history.

import { useState } from "react";
import { ChevronDown, ChevronUp, RefreshCw, Sparkles, History as HistoryIcon, AlertCircle, Pencil } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateDomains } from "@/lib/cache-bus";
import { useToast } from "@/hooks/use-toast";
import { formatMoneyCompact, formatTimeAgo } from "@/lib/format";
import { formatLocalDate } from "@/lib/dates";
import { useAssetValuation, useAssetValuationHistory, valuationQueryKey } from "@/hooks/useAssetValuation";
import { isEstimatorOwnedValue, isAutoValuationEnabled, VALUATION_MODE_FIELD } from "@shared/valuation/context";
import { METHOD_LABEL } from "@shared/valuation/engine";
import { parseMoney } from "@shared/asset-value";
import type { ValuationRecord } from "@shared/valuation/types";

// "2d ago", not "2 d ago" — the app-wide relative formatter (F-58).
const relative = (iso: string | null | undefined) => formatTimeAgo(iso);

function confidenceClass(label: ValuationRecord["confidenceLabel"]): string {
  switch (label) {
    case "high": return "bg-emerald-500/15 text-emerald-400";
    case "medium": return "bg-amber-500/15 text-amber-400";
    case "low": return "bg-muted text-muted-foreground";
    default: return "bg-muted text-muted-foreground";
  }
}

export function CurrentValueCard({
  profileId,
  fields,
  showHistory = false,
  className,
}: {
  profileId: string;
  /** The profile's own fields — used to show a user-entered value beside the estimate. */
  fields?: Record<string, any> | null;
  showHistory?: boolean;
  className?: string;
}) {
  const { snapshot, isLoading, refreshing, refresh } = useAssetValuation(profileId);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const { toast } = useToast();
  const history = useAssetValuationHistory(profileId, showHistory && open);

  // One write path for both controls: the app's PATCH + cache-bus pattern, so
  // every screen that shows this asset's value refreshes with it.
  const writeFields = async (patch: Record<string, any>): Promise<boolean> => {
    try {
      await apiRequest("PATCH", `/api/profiles/${profileId}`, { fields: patch });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "overview"] });
      queryClient.invalidateQueries({ queryKey: valuationQueryKey(profileId) });
      await invalidateDomains("profiles");
      return true;
    } catch {
      toast({ title: "Couldn't save", variant: "destructive" });
      return false;
    }
  };

  if (!snapshot && isLoading) {
    return (
      <Card className={className} data-testid="current-value-card-loading">
        <CardContent className="pt-4 pb-3"><div className="h-10 animate-pulse rounded bg-muted/50" /></CardContent>
      </Card>
    );
  }
  if (!snapshot || !snapshot.supported) return null;
  const record = snapshot.record;

  // The number the user typed: kept in userEnteredValue once an estimate has
  // become the canonical currentValue, or still in currentValue before then.
  const userOwned = fields
    ? (parseMoney(fields.userEnteredValue) || (!isEstimatorOwnedValue(fields) ? parseMoney(fields.currentValue ?? fields.current_value) : 0))
    : 0;
  const stale = !snapshot.freshness.fresh;
  // The server is authoritative; a payload from an older build has no mode,
  // and absent means auto — exactly as this asset behaved before the switch.
  const auto = snapshot.mode ? snapshot.mode === "auto" : isAutoValuationEnabled(fields);
  // What the user's own value is worth right now (manual state headline).
  const ownValue = fields ? parseMoney(fields.currentValue ?? fields.current_value) : 0;

  const toggleAuto = async (next: boolean) => {
    setSwitching(true);
    // Only ever written by a deliberate flip — an asset that has never been
    // touched keeps no valuationMode at all and stays automatic.
    await writeFields({ [VALUATION_MODE_FIELD]: next ? "auto" : "manual" });
    setSwitching(false);
  };

  const saveOwnValue = async () => {
    const n = parseMoney(draft);
    if (!Number.isFinite(n) || n < 0 || String(draft).trim() === "") {
      toast({ title: "Enter a value of 0 or more", variant: "destructive" });
      return;
    }
    setSaving(true);
    // `currentValue` is the ONE canonical value every screen reads. The
    // profile PATCH route stamps its provenance (currentValueSource "user",
    // currentValueAsOf, and clears the kept userEnteredValue mirror) — the
    // same convention a value typed anywhere else in the app gets.
    const ok = await writeFields({ currentValue: n });
    setSaving(false);
    if (ok) setEditing(false);
  };

  const trackingSwitch = (
    <div className="flex items-start justify-between gap-3 border-t border-border/40 pt-2" data-testid="valuation-mode-row">
      <div className="min-w-0">
        <p className="text-[12px] font-medium leading-tight">Track value automatically</p>
        <p className="text-[11px] text-muted-foreground leading-tight" data-testid="valuation-mode-help">
          {auto ? "On — Portol estimates and refreshes this value" : "Off — you set the value yourself"}
        </p>
      </div>
      <Switch
        checked={auto}
        disabled={switching}
        onCheckedChange={(v) => { void toggleAuto(v); }}
        aria-label="Track value automatically"
        data-testid="valuation-mode-switch"
      />
    </div>
  );

  return (
    <Card className={className} data-testid="current-value-card">
      <CardContent className="pt-4 pb-3 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {auto ? (
              <p className="micro-label text-muted-foreground flex items-center gap-1.5">
                <Sparkles className="h-3 w-3 text-primary" /> Estimated current value
              </p>
            ) : (
              <p className="micro-label text-muted-foreground flex items-center gap-1.5" data-testid="current-value-manual-heading">
                <Pencil className="h-3 w-3" /> Your current value
              </p>
            )}
            {!auto ? (
              editing ? (
                <div className="flex items-center gap-1.5 pt-1" data-testid="current-value-manual-editor">
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    className="h-8 w-36 text-[15px] tabular-nums"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { void saveOwnValue(); } if (e.key === "Escape") setEditing(false); }}
                    aria-label="Current value"
                    data-testid="current-value-manual-input"
                  />
                  <Button size="sm" className="h-8 text-xs" disabled={saving} onClick={() => { void saveOwnValue(); }} data-testid="current-value-manual-save">
                    {saving ? "Saving…" : "Save"}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setEditing(false)} data-testid="current-value-manual-cancel">Cancel</Button>
                </div>
              ) : (
                <button
                  type="button"
                  className="text-2xl font-bold tabular-nums leading-tight hover:text-primary text-left"
                  onClick={() => { setDraft(ownValue > 0 ? String(ownValue) : ""); setEditing(true); }}
                  data-testid="current-value-manual-amount"
                >
                  {ownValue > 0 ? formatMoneyCompact(ownValue) : <span className="text-sm font-medium text-muted-foreground">Tap to set a value</span>}
                </button>
              )
            ) : record?.status === "valued" && record.value != null ? (
              <>
                <p className="text-2xl font-bold tabular-nums leading-tight" data-testid="current-value-amount">
                  {formatMoneyCompact(record.value)}
                </p>
                {record.low != null && record.high != null && (
                  <p className="text-xs text-muted-foreground tabular-nums" data-testid="current-value-range">
                    Likely {formatMoneyCompact(record.low)} – {formatMoneyCompact(record.high)}
                  </p>
                )}
              </>
            ) : record?.status === "error" && record.value != null ? (
              <p className="text-2xl font-bold tabular-nums leading-tight" data-testid="current-value-amount">{formatMoneyCompact(record.value)}</p>
            ) : (
              <p className="text-sm font-medium text-muted-foreground" data-testid="current-value-unavailable">
                {!record ? (refreshing ? "Estimating…" : "Not estimated yet") : "Not enough information for a defensible estimate"}
              </p>
            )}
          </div>
          <div className="text-right shrink-0 space-y-1">
            {!auto ? (
              <Badge variant="secondary" className="text-[11px]" data-testid="current-value-set-by-you">Set by you</Badge>
            ) : (
              <>
                {record && record.confidenceLabel !== "none" && (
                  <Badge variant="secondary" className={`text-[11px] capitalize ${confidenceClass(record.confidenceLabel)}`} data-testid="current-value-confidence">
                    {record.confidenceLabel} confidence · {Math.round(record.confidence * 100)}%
                  </Badge>
                )}
                <div>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { void refresh(); }} disabled={refreshing} data-testid="current-value-refresh">
                    <RefreshCw className={`h-3 w-3 mr-1 ${refreshing ? "animate-spin" : ""}`} />
                    {refreshing ? "Refreshing…" : "Refresh"}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>

        {auto && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground" data-testid="current-value-meta">
            {record?.valuedAt && <span title={record.valuedAt}>Valued {relative(record.valuedAt)}</span>}
            {refreshing && <span className="text-primary" data-testid="current-value-refreshing">Refreshing in background…</span>}
            {!refreshing && stale && record && <span>Re-check due ({snapshot.freshness.reason?.replace(/_/g, " ")})</span>}
            {record?.methodSummary && <span className="truncate max-w-full">Method: {record.methodSummary}</span>}
            {userOwned > 0 && record?.value != null && userOwned !== record.value && (
              <span data-testid="current-value-user-value">Your entered value: {formatMoneyCompact(userOwned)} (kept)</span>
            )}
          </div>
        )}

        {auto && record?.status === "error" && record.error && (
          <p className="text-[11px] text-amber-500 flex items-center gap-1" data-testid="current-value-error">
            <AlertCircle className="h-3 w-3" /> Last refresh had a problem: {record.error}
          </p>
        )}

        {record && (
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
            onClick={() => setOpen(o => !o)}
            data-testid="current-value-details-toggle"
          >
            {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {auto ? "How this was estimated" : "Last AI estimate (not in use)"}
          </button>
        )}

        {open && record && (
          <div className="space-y-2 text-[12px] border-t border-border/40 pt-2" data-testid="current-value-details">
            {!auto && (
              <p className="text-muted-foreground" data-testid="current-value-historical-note">
                Automatic tracking is off. This is the last estimate Portol made
                {record.value != null ? <> — {formatMoneyCompact(record.value)}{record.valuedAt ? <> on {formatLocalDate(record.valuedAt, { month: "short", day: "numeric", year: "numeric" })}</> : null}</> : null}
                . It is history, not your current value.
              </p>
            )}
            {record.methodology.length > 0 && (
              <p><span className="font-medium text-foreground/80">Methodology:</span> {record.methodology.map(m => METHOD_LABEL[m]).join(" · ")}</p>
            )}
            {record.understanding && (
              <p><span className="font-medium text-foreground/80">Understood as:</span> {record.understanding.kind}
                {record.understanding.valueDrivers.length > 0 && <> — drivers: {record.understanding.valueDrivers.join(", ")}</>}
                <span className="text-muted-foreground"> ({record.understanding.source === "ai" ? "AI" : "rules"})</span>
              </p>
            )}
            {record.evidence.filter(e => e.value != null).length > 0 && (
              <div>
                <p className="font-medium text-foreground/80">Evidence</p>
                <ul className="mt-0.5 space-y-0.5">
                  {record.evidence.filter(e => e.value != null).map(e => (
                    <li key={e.id} className="flex items-baseline justify-between gap-2 text-muted-foreground" data-testid={`current-value-evidence-${e.kind}`}>
                      <span className="truncate">
                        {e.reference && /^https?:\/\//.test(e.reference)
                          ? <a href={e.reference} target="_blank" rel="noreferrer" className="underline">{e.source}</a>
                          : e.source}
                        {e.note ? ` — ${e.note}` : ""}
                      </span>
                      <span className="tabular-nums shrink-0">{formatMoneyCompact(e.value!)} · {relative(e.observedAt)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {record.factors.length > 0 && (
              <p className="text-muted-foreground"><span className="font-medium text-foreground/80">Notes:</span> {record.factors.join(" · ")}</p>
            )}
            {auto && record.missingInfo.length > 0 && (
              <p className="text-muted-foreground"><span className="font-medium text-foreground/80">Would tighten it:</span> {record.missingInfo.join(" · ")}</p>
            )}
            <p className="text-muted-foreground">
              Inputs used: {Object.keys((record.materialInputs as any)?.attributes || {}).length} characteristics
              {record.marketDataAsOf ? ` · market data as of ${formatLocalDate(record.marketDataAsOf, { month: "short", day: "numeric" })}` : " · no live market data"}
              {auto ? ` · next check ${relative(record.nextRefreshAt) || "soon"}` : ""}
              {` · ${record.modelVersion}`}
            </p>
            {showHistory && (
              <div data-testid="current-value-history">
                <p className="font-medium text-foreground/80 flex items-center gap-1"><HistoryIcon className="h-3 w-3" /> History</p>
                {history.data && history.data.length > 0 ? (
                  <ul className="mt-0.5 space-y-0.5 text-muted-foreground">
                    {[...history.data].reverse().slice(0, 12).map(h => (
                      <li key={h.valuedAt} className="flex justify-between gap-2">
                        <span>{formatLocalDate(h.valuedAt, { month: "short", day: "numeric", year: "numeric" })} · {h.refreshReason.replace(/_/g, " ")}</span>
                        <span className="tabular-nums">{h.value != null ? formatMoneyCompact(h.value) : h.status.replace(/_/g, " ")}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground">{history.isLoading ? "Loading…" : "No history yet"}</p>
                )}
              </div>
            )}
          </div>
        )}

        {trackingSwitch}
      </CardContent>
    </Card>
  );
}

export default CurrentValueCard;
