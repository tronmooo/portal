// ─── CurrentValueCard ───────────────────────────────────────────────────────
// The asset profile's "what is it worth right now" card. Renders the stored
// estimate immediately (it arrives with the profile bootstrap), shows the
// range, confidence, when it was last valued and whether a background refresh
// is running, and opens into the full explanation: methodology, every piece
// of evidence with its source and age, the facts that were used, and what
// would tighten the estimate. Presentation only — all numbers come from the
// ValuationRecord the server computed.

import { useState } from "react";
import { ChevronDown, ChevronUp, RefreshCw, Sparkles, History as HistoryIcon, AlertCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatMoneyCompact, formatTimeAgo } from "@/lib/format";
import { formatLocalDate } from "@/lib/dates";
import { useAssetValuation, useAssetValuationHistory } from "@/hooks/useAssetValuation";
import { isEstimatorOwnedValue } from "@shared/valuation/context";
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
  const history = useAssetValuationHistory(profileId, showHistory && open);

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

  return (
    <Card className={className} data-testid="current-value-card">
      <CardContent className="pt-4 pb-3 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="micro-label text-muted-foreground flex items-center gap-1.5">
              <Sparkles className="h-3 w-3 text-primary" /> Estimated current value
            </p>
            {record?.status === "valued" && record.value != null ? (
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
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground" data-testid="current-value-meta">
          {record?.valuedAt && <span title={record.valuedAt}>Valued {relative(record.valuedAt)}</span>}
          {refreshing && <span className="text-primary" data-testid="current-value-refreshing">Refreshing in background…</span>}
          {!refreshing && stale && record && <span>Re-check due ({snapshot.freshness.reason?.replace(/_/g, " ")})</span>}
          {record?.methodSummary && <span className="truncate max-w-full">Method: {record.methodSummary}</span>}
          {userOwned > 0 && record?.value != null && userOwned !== record.value && (
            <span data-testid="current-value-user-value">Your entered value: {formatMoneyCompact(userOwned)} (kept)</span>
          )}
        </div>

        {record?.status === "error" && record.error && (
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
            How this was estimated
          </button>
        )}

        {open && record && (
          <div className="space-y-2 text-[12px] border-t border-border/40 pt-2" data-testid="current-value-details">
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
            {record.missingInfo.length > 0 && (
              <p className="text-muted-foreground"><span className="font-medium text-foreground/80">Would tighten it:</span> {record.missingInfo.join(" · ")}</p>
            )}
            <p className="text-muted-foreground">
              Inputs used: {Object.keys((record.materialInputs as any)?.attributes || {}).length} characteristics
              {record.marketDataAsOf ? ` · market data as of ${formatLocalDate(record.marketDataAsOf, { month: "short", day: "numeric" })}` : " · no live market data"}
              {` · next check ${relative(record.nextRefreshAt) || "soon"}`}
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
      </CardContent>
    </Card>
  );
}

export default CurrentValueCard;
