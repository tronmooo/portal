// ── Asset lifecycle on screen ────────────────────────────────────────────────
// A drawing of GET /api/assets/lifecycle (server/asset-lifecycle-service.ts):
// every figure is the deterministic engine's (shared/asset-lifecycle.ts), so
// the asset page, the Assets tab and Needs Attention can never disagree
// (Rule 1). Compact for a phone: one recommendation line, a small grid of
// figures, and the reasoning, assumptions, confidence and sources behind a
// tap. Nothing here asks the user for a formula or a salvage value.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { ChevronDown, RefreshCw } from "lucide-react";
import { formatMoneyCompact, parseLocalDate } from "@/lib/format";
import { summarizeLifecycles, type AssetLifecycle, type LifecycleAction, type LifecycleRow } from "@shared/asset-lifecycle";
import { Link } from "wouter";

export const LIFECYCLE_QUERY_KEY = ["/api/assets/lifecycle"] as const;

/**
 * Every owned asset's lifecycle, one request shared by every screen. Pass the
 * profile scope to narrow it (Rule 4: a list the scope can hide says so); the
 * key stays under LIFECYCLE_QUERY_KEY so one invalidation reaches every scope.
 */
export function useAssetLifecycles(enabled = true, scope?: { mode: string; ids: string[] }) {
  const selected = scope?.mode === "selected" && scope.ids.length > 0 ? scope.ids : [];
  return useQuery<{ rows: LifecycleRow[]; computedAt: string }>({
    queryKey: selected.length ? [...LIFECYCLE_QUERY_KEY, "selected", ...selected] : LIFECYCLE_QUERY_KEY,
    queryFn: () => apiRequest("GET", `/api/assets/lifecycle${selected.length ? `?profileIds=${selected.join(",")}` : ""}`).then((r) => r.json()),
    enabled,
    staleTime: 60_000,
  });
}

/** One asset's row from the shared answer. */
export function useAssetLifecycle(profileId: string | undefined) {
  const q = useAssetLifecycles(!!profileId);
  const row = q.data?.rows?.find((r) => r.profileId === profileId) ?? null;
  return { row, isLoading: q.isLoading, isError: q.isError && !q.data, refetch: q.refetch };
}

const TONE: Record<LifecycleAction, string> = {
  keep: "bg-emerald-500/15 text-emerald-400",
  monitor: "bg-sky-500/15 text-sky-400",
  consider_selling: "bg-amber-500/15 text-amber-400",
  replace: "bg-orange-500/15 text-orange-400",
  dispose: "bg-red-500/15 text-red-400",
};

export function LifecyclePill({ action, label, className = "" }: { action: LifecycleAction; label: string; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-px text-[11px] font-semibold whitespace-nowrap ${TONE[action]} ${className}`} data-testid={`lifecycle-pill-${action}`}>
      {label}
    </span>
  );
}

const monthYear = (d: string) => (parseLocalDate(d.slice(0, 10)) ?? new Date(d)).toLocaleDateString("en-US", { month: "short", year: "numeric" });
const dayLabel = (d: string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const years = (n: number) => (n <= 0 ? "Past its life" : n < 1 ? `${Math.max(1, Math.round(n * 12))} mo` : `${Math.round(n * 10) / 10} yrs`);

function Fig({ label, value, testId, tone = "" }: { label: string; value: string; testId: string; tone?: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <p className="text-[11px] text-muted-foreground truncate">{label}</p>
      <p className={`text-[13px] font-semibold tabular-nums truncate ${tone}`}>{value}</p>
    </div>
  );
}

/** The recommendation and the figures behind it, under the Value card's money lines. */
export function LifecycleSection({ profileId }: { profileId: string }) {
  const { row, isLoading, isError, refetch } = useAssetLifecycle(profileId);
  const [open, setOpen] = useState(false);
  if (isError) {
    return (
      <div className="mt-2 flex items-center justify-between gap-2 text-[12px] text-muted-foreground" data-testid="asset-lifecycle-error">
        <span>Couldn't load the lifecycle.</span>
        <button type="button" className="flex items-center gap-1 text-primary" onClick={() => void refetch()}><RefreshCw className="h-3 w-3" /> Retry</button>
      </div>
    );
  }
  if (isLoading || !row) return null;
  const l: AssetLifecycle = row.lifecycle;
  if (!l.applicable || !l.recommendation) {
    return l.notApplicableReason && l.valueModel ? (
      <p className="mt-2 text-[12px] text-muted-foreground" data-testid="asset-lifecycle-na">{l.notApplicableReason}</p>
    ) : null;
  }
  const r = l.recommendation;
  const dep = l.depreciationNext12m ?? 0;
  const figs: Array<{ label: string; value: string; testId: string; tone?: string }> = [];
  if (l.remainingLifeYears != null) figs.push({ label: "Useful life left", value: years(l.remainingLifeYears), testId: "lifecycle-remaining" });
  if (l.depreciationNext12m != null) figs.push({ label: dep >= 0 ? "Loss, next 12 months" : "Gain, next 12 months", value: `${dep >= 0 ? "−" : "+"}${formatMoneyCompact(Math.abs(dep))}`, testId: "lifecycle-next12", tone: dep > 0 ? "text-red-400" : dep < 0 ? "text-emerald-400" : "" });
  if (l.sellingWindow && l.sellingWindow.status !== "passed") figs.push({ label: l.sellingWindow.status === "open" ? "Sell by" : "Best time to sell", value: l.sellingWindow.status === "open" ? monthYear(l.sellingWindow.end) : `${monthYear(l.sellingWindow.start)} – ${monthYear(l.sellingWindow.end)}`, testId: "lifecycle-window" });
  if (l.replacementCost.value) figs.push({ label: l.replacementCost.source === "ai" ? "Replacement cost" : "Replacement (est.)", value: formatMoneyCompact(l.replacementCost.value), testId: "lifecycle-replacement" });
  if (l.recommendedReplacementDate) figs.push({ label: "Replace by", value: monthYear(l.recommendedReplacementDate), testId: "lifecycle-replace-by" });
  if (l.accumulatedDepreciation != null && l.accumulatedDepreciation > 0) figs.push({ label: "Depreciated so far", value: formatMoneyCompact(l.accumulatedDepreciation), testId: "lifecycle-accumulated" });
  const by = l.assumptions.source === "ai" ? "AI assumptions" : "Typical figures";

  return (
    <div className="mt-2 rounded-xl border border-border/40 px-3 py-2" data-testid="asset-lifecycle">
      <div className="flex items-start gap-2">
        <LifecyclePill action={r.action} label={r.label} className="mt-px shrink-0" />
        <p className="text-[12px] leading-snug min-w-0" data-testid="lifecycle-headline">{r.headline.replace(/^[^—]+—\s*/, "")}</p>
      </div>
      {figs.length > 0 && (
        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5" data-testid="lifecycle-figures">
          {figs.slice(0, 6).map((f) => <Fig key={f.testId} {...f} />)}
        </div>
      )}
      {row.nested && (
        <p className="mt-1.5 text-[11px] text-muted-foreground" data-testid="lifecycle-nested">
          Not included above: {row.nested.count} item{row.nested.count === 1 ? "" : "s"} inside it, worth {formatMoneyCompact(row.nested.value)} on their own pages.
        </p>
      )}
      <button type="button" className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid="lifecycle-why-toggle">
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
        Confidence: {l.confidence[0].toUpperCase() + l.confidence.slice(1)} · {by}{l.lastUpdated.value ? ` · value ${dayLabel(l.lastUpdated.value)}` : ""}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5 text-[12px] text-muted-foreground" data-testid="lifecycle-why">
          <ul className="list-disc pl-4 space-y-0.5">
            {r.reasons.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
          <div>
            <p className="font-semibold text-foreground/80">{l.assumptions.source === "ai" ? "Assumptions chosen by Portol's AI" : "Typical figures (not yet analysed)"}{l.assumptions.asOf ? ` · ${dayLabel(l.assumptions.asOf)}` : ""}</p>
            {l.assumptions.basis && <p>{l.assumptions.basis}</p>}
            {l.assumptions.items.length > 0 && <ul className="list-disc pl-4">{l.assumptions.items.map((s, i) => <li key={i}>{s}</li>)}</ul>}
            <p className="text-[11px]">These are estimates, not quotes. Portol recalculates them whenever the asset's value or details change.</p>
          </div>
          {l.sources.length > 0 && (
            <div data-testid="lifecycle-sources">
              <p className="font-semibold text-foreground/80">Value sources</p>
              {l.sources.slice(0, 4).map((s) => {
                let host = s; try { host = new URL(s).hostname.replace(/^www\./, ""); } catch { /* keep text */ }
                return <a key={s} href={s} target="_blank" rel="noreferrer" className="block truncate text-primary">{host}</a>;
              })}
            </div>
          )}
          {l.missing.length > 0 && <p data-testid="lifecycle-missing">Would sharpen this: {l.missing.join(", ")}.</p>}
        </div>
      )}
    </div>
  );
}

/**
 * Finance: what the owned assets will cost in lost value over the next year —
 * the hidden cost of owning things, next to the cash flow. Same answer as
 * every asset page (summarizeLifecycles over GET /api/assets/lifecycle).
 */
export function LifecycleFinanceSummary({ filterMode, filterIds }: { filterMode: string; filterIds: string[] }) {
  const q = useAssetLifecycles(true, { mode: filterMode, ids: filterIds });
  if (q.isError && !q.data) {
    return (
      <div className="bubble px-3 py-2 flex items-center justify-between text-[12px] text-muted-foreground" data-testid="finance-lifecycle-error">
        <span>Couldn't load asset depreciation.</span>
        <button type="button" className="text-primary" onClick={() => void q.refetch()}>Retry</button>
      </div>
    );
  }
  if (!q.data) return null;
  const sum = summarizeLifecycles(q.data.rows);
  if (sum.assets === 0) return null;
  return (
    <div className="bubble px-3 py-2.5" data-testid="finance-lifecycle">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[13px] font-semibold">Asset depreciation, next 12 months</p>
        <p className="text-[15px] font-bold tabular-nums text-red-400" data-testid="finance-lifecycle-total">−{formatMoneyCompact(sum.depreciationNext12m)}</p>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Projected across {sum.assets} asset{sum.assets === 1 ? "" : "s"}{sum.appreciationNext12m > 0 ? `; ${formatMoneyCompact(sum.appreciationNext12m)} expected gain elsewhere` : ""}.
        {sum.significant > 0 ? ` ${sum.significant} with a sell or replace recommendation.` : ""}
      </p>
      {sum.biggestLosers.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {sum.biggestLosers.map((l) => (
            <li key={l.profileId} className="flex items-center justify-between gap-2 text-[12px]">
              <Link href={`/profiles/${l.profileId}`} className="truncate text-foreground/90 hover:underline">{l.name}</Link>
              <span className="tabular-nums text-muted-foreground">−{formatMoneyCompact(l.loss)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
