// ── Nutrition enrichment card ────────────────────────────────────────────────
// Rendered under an assistant reply once the Item Enrichment Layer has looked
// up a logged food. Two states:
//   applied  — the entry was refined; shows what matched, the totals, and lets
//              the user fix the portion.
//   proposed — the lookup is waiting for the user (Ask mode, or confidence too
//              low to apply by itself): Use exact match / Use generic estimate.
// Every number carries its confidence word so an estimate never reads as a
// label value.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { chooseEnrichment, rescaleEntry, type NutritionEnrichmentCardData } from "@/lib/nutrition-enrichment";
import {
  CONFIDENCE_LABEL,
  ENTRY_VALUE_NUTRIENTS,
  NUTRIENT_KEYS,
  NUTRIENT_LABELS,
  VERIFICATION_LABEL,
  componentAmount,
  describeSources,
  formatNutrient,
  netCarbsOf,
  verificationOf,
  type NutrientKey,
  type NutrientVector,
  type NutritionEnrichment,
} from "@shared/nutrition-enrichment";

const SHOWN: NutrientKey[] = ["calories", "protein", "carbs", "fat", "sugar", "sodium", "caffeine"];
/** The rest of a nutrition panel, listed under "All nutrients" when the source states them. */
const DETAIL: NutrientKey[] = NUTRIENT_KEYS.filter((k) => !SHOWN.includes(k) && k !== "fluidMl");
/** What a standard label carries: when the source is silent on one of these, the card says so instead of showing 0. */
const PANEL: NutrientKey[] = ["saturatedFat", "fiber", "sugar", "sodium", "cholesterol"];

export function NutritionEnrichmentCard({ data, onChange }: { data: NutritionEnrichmentCardData; onChange: (next: NutritionEnrichmentCardData) => void }) {
  const [busy, setBusy] = useState<"exact" | "generic" | "serving" | null>(null);
  const [editing, setEditing] = useState(false);
  const e = data.enrichment as NutritionEnrichment | undefined;
  const [portion, setPortion] = useState(String(e?.servingFactor ?? 1));
  const { toast } = useToast();
  if (!e || (data.status !== "applied" && data.status !== "proposed")) return null;

  const names = e.components.map((c) => c.sourceItem || c.name);
  const title = data.status === "applied" ? "Nutrition refined" : "Nutrition enrichment available";
  const confidence = CONFIDENCE_LABEL[e.confidence] || e.confidence;
  const verification = VERIFICATION_LABEL[verificationOf(e)];
  const totalsVector: NutrientVector = {};
  for (const k of NUTRIENT_KEYS) { const t = e.totals[k]; if (t) totalsVector[k] = t.value; }
  const netCarbs = netCarbsOf(totalsVector);
  const details = DETAIL.filter((k) => e.totals[k] != null);
  const notStated = PANEL.filter((k) => e.totals[k] == null);
  // The totals are for what the user ate; say so when that is not one serving.
  const scaled = e.components.some((c) => Math.abs(c.servings - 1) > 0.01) || Math.abs((e.servingFactor || 1) - 1) > 0.01;
  const servingBasis = (c: typeof e.components[number]) => {
    return `${componentAmount(c)}${c.servingAssumed ? " (assumed — you did not say how much)" : ""}`;
  };

  const run = async (kind: "exact" | "generic" | "serving") => {
    setBusy(kind);
    try {
      if (kind === "serving") {
        const next = Number(portion);
        const current = e.servingFactor || 1;
        if (!isFinite(next) || next <= 0) throw new Error("Enter a portion like 0.5 or 2");
        if (Math.abs(next - current) < 1e-9) { setEditing(false); return; }
        onChange(await rescaleEntry(data, next / current));
        setEditing(false);
      } else {
        onChange(await chooseEnrichment(data, kind));
      }
    } catch (err: any) {
      toast({ title: "Couldn't update the entry", description: err?.message || String(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs" data-testid={`nutrition-enrichment-${data.entryId}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium">{title}</div>
          <div className="text-muted-foreground truncate" title={names.join(" + ")}>
            <span data-testid={`nutrition-verification-${data.entryId}`}>{verification}</span> · {names.join(" + ")} · {confidence}
            {e.userProvided.length > 0 ? ` · ${e.userProvided.map((k) => NUTRIENT_LABELS[k].toLowerCase()).join(", ")} as you stated` : ""}
          </div>
        </div>
      </div>
      <div className="text-[11px] text-muted-foreground">Source: {describeSources(e)}</div>
      {scaled && <div className="mt-1 text-[11px] text-muted-foreground">Your total ({e.components.map((c) => `${Math.round(c.servings * 100) / 100} serving${Math.abs(c.servings - 1) < 0.01 ? "" : "s"}`).join(" + ")})</div>}
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
        {SHOWN.filter((k) => ENTRY_VALUE_NUTRIENTS.includes(k)).map((k) => {
          const t = e.totals[k];
          if (!t || (k === "caffeine" && t.value <= 0)) return null;
          const est = t.confidence === "medium" || t.confidence === "low";
          return (
            <span key={k} className="text-muted-foreground" title={`${t.source} · ${CONFIDENCE_LABEL[t.confidence]}`}>
              {NUTRIENT_LABELS[k]}: <span className="text-foreground">{est ? "≈" : ""}{formatNutrient(k, t.value)}</span>
            </span>
          );
        })}
      </div>
      {(details.length > 0 || netCarbs != null || notStated.length > 0) && (
        <details className="mt-1.5" data-testid={`nutrition-details-${data.entryId}`}>
          <summary className="cursor-pointer text-[11px] text-muted-foreground">All nutrients</summary>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
            {netCarbs != null && (
              <span className="text-muted-foreground" title="Total carbs less fiber and sugar alcohols">
                Net carbs: <span className="text-foreground">{formatNutrient("carbs", netCarbs)}</span>
              </span>
            )}
            {details.map((k) => {
              const t = e.totals[k]!;
              const est = t.confidence === "medium" || t.confidence === "low";
              return (
                <span key={k} className="text-muted-foreground" title={`${t.source} · ${CONFIDENCE_LABEL[t.confidence]}`}>
                  {NUTRIENT_LABELS[k]}: <span className="text-foreground">{est ? "≈" : ""}{formatNutrient(k, t.value)}</span>
                </span>
              );
            })}
          </div>
          {notStated.length > 0 && (
            <div className="mt-1 text-[11px] text-muted-foreground" data-testid={`nutrition-unknown-${data.entryId}`}>
              Not stated by the source (left unknown, not counted as 0): {notStated.map((k) => NUTRIENT_LABELS[k].toLowerCase()).join(", ")}
            </div>
          )}
        </details>
      )}
      <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
        {e.components.map((c, i) => (
          <li key={i} className="truncate" title={c.source}>
            {e.components.length > 1 ? `${c.sourceItem || c.name} · ` : ""}Amount: {servingBasis(c)}
            {c.perServing?.calories != null && Math.abs(c.servings - 1) > 0.01 ? ` · ${formatNutrient("calories", c.perServing.calories)} per serving` : ""}
            {e.components.length > 1 && c.nutrients.calories ? ` · ${formatNutrient("calories", c.nutrients.calories.value)}` : ""}
            {` · ${CONFIDENCE_LABEL[c.confidence]}`}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {data.status === "proposed" && (
          <>
            <Button size="sm" variant="secondary" className="h-7 text-xs" disabled={!!busy} onClick={() => run("exact")}>
              {busy === "exact" ? "Applying…" : "Use exact match"}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={!!busy} onClick={() => run("generic")}>
              {busy === "generic" ? "Keeping…" : "Use generic estimate"}
            </Button>
          </>
        )}
        {!editing ? (
          <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={!!busy} onClick={() => setEditing(true)}>
            Edit serving size
          </Button>
        ) : (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(ev) => { ev.preventDefault(); void run("serving"); }}
          >
            <label className="text-muted-foreground" htmlFor={`portion-${data.entryId}`}>Portion ×</label>
            <Input
              id={`portion-${data.entryId}`}
              value={portion}
              onChange={(ev) => setPortion(ev.target.value)}
              inputMode="decimal"
              className="h-7 w-16 text-xs"
              aria-label="Portion multiplier"
            />
            <Button size="sm" type="submit" className="h-7 text-xs" disabled={!!busy}>{busy === "serving" ? "Saving…" : "Apply"}</Button>
            <Button size="sm" type="button" variant="ghost" className="h-7 text-xs" disabled={!!busy} onClick={() => setEditing(false)}>Cancel</Button>
          </form>
        )}
      </div>
    </div>
  );
}
