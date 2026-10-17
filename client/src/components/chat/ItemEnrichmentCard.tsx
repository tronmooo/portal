// ── Item enrichment card ─────────────────────────────────────────────────────
// The general form of NutritionEnrichmentCard: under an assistant reply, once
// the Item Identity Layer has identified a medication, supplement, pet food,
// vehicle, device, subscription or account the turn saved. Shows what was
// identified and each attribute with its confidence word, so an estimate
// never reads as a manufacturer figure. "proposed" offers the choice.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { chooseEnrichment, type NutritionEnrichmentCardData } from "@/lib/nutrition-enrichment";
import { CONFIDENCE_LABEL } from "@shared/nutrition-enrichment";
import { formatAttribute, type ItemEnrichment, type ProvenancedAttribute } from "@shared/item-identity";

const KIND_LABEL: Record<string, string> = {
  medication: "Medication identified", supplement: "Supplement identified", pet_food: "Pet food identified",
  vehicle: "Vehicle specs", device: "Device specs", wearable: "Device capabilities", appliance: "Appliance details",
  subscription: "Plan details", account: "Account details", consumable: "Item details",
};

export function ItemEnrichmentCard({ data, onChange }: { data: NutritionEnrichmentCardData; onChange: (next: NutritionEnrichmentCardData) => void }) {
  const [busy, setBusy] = useState<"exact" | "generic" | null>(null);
  const { toast } = useToast();
  const e = data.enrichment as ItemEnrichment | undefined;
  if (!e || !e.attributes || (data.status !== "applied" && data.status !== "proposed")) return null;
  const attrs = Object.entries(e.attributes) as Array<[string, ProvenancedAttribute]>;
  if (attrs.length === 0) return null;
  const title = data.status === "applied" ? (KIND_LABEL[e.kind] || "Item identified") : "Item details available";
  const who = [e.identity.name, e.identity.family && e.identity.family !== e.identity.name ? `(${e.identity.family})` : ""].filter(Boolean).join(" ");

  const run = async (kind: "exact" | "generic") => {
    setBusy(kind);
    try { onChange(await chooseEnrichment(data, kind)); }
    catch (err: any) { toast({ title: "Couldn't update the record", description: err?.message || String(err), variant: "destructive" }); }
    finally { setBusy(null); }
  };

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs" data-testid={`item-enrichment-${data.entryId}`}>
      <div className="font-medium">{title}</div>
      <div className="text-muted-foreground truncate" title={e.sourceText}>
        {who} · {CONFIDENCE_LABEL[e.confidence] || e.confidence}
        {e.userProvided.length > 0 ? ` · ${e.userProvided.length} value${e.userProvided.length === 1 ? "" : "s"} kept as you gave` : ""}
      </div>
      <ul className="mt-1.5 space-y-0.5">
        {attrs.map(([k, a]) => {
          const est = a.confidence === "medium" || a.confidence === "low";
          const written = e.applied?.includes(k);
          return (
            <li key={k} className="flex items-baseline gap-1.5 text-muted-foreground" title={`${a.source} · ${CONFIDENCE_LABEL[a.confidence]}${written ? " · saved on the record" : " · shown here only"}`}>
              <span>{a.label}:</span>
              <span className="text-foreground">{est ? "≈" : ""}{formatAttribute(a)}</span>
              {!written && data.status === "applied" && <span className="text-[11px] opacity-70">(not saved)</span>}
            </li>
          );
        })}
      </ul>
      {data.status === "proposed" && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="secondary" className="h-7 text-xs" disabled={!!busy} onClick={() => run("exact")}>
            {busy === "exact" ? "Saving…" : "Save these details"}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={!!busy} onClick={() => run("generic")}>
            {busy === "generic" ? "Keeping…" : "Keep as saved"}
          </Button>
        </div>
      )}
    </div>
  );
}
