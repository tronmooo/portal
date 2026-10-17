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
  NUTRIENT_LABELS,
  formatNutrient,
  type NutrientKey,
  type NutritionEnrichment,
} from "@shared/nutrition-enrichment";

const SHOWN: NutrientKey[] = ["calories", "protein", "carbs", "fat", "sugar", "sodium", "caffeine"];

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
            {names.join(" + ")} · {confidence}
            {e.userProvided.length > 0 ? ` · ${e.userProvided.map((k) => NUTRIENT_LABELS[k].toLowerCase()).join(", ")} as you stated` : ""}
          </div>
        </div>
      </div>
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
      {e.components.length > 1 && (
        <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
          {e.components.map((c, i) => (
            <li key={i} className="truncate" title={c.source}>
              {c.sourceItem || c.name} — {c.userQuantity || `${c.servings} serving`}
              {c.nutrients.calories ? ` · ${formatNutrient("calories", c.nutrients.calories.value)}` : ""}
              {` · ${CONFIDENCE_LABEL[c.confidence]}`}
            </li>
          ))}
        </ul>
      )}
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
