// ── Improve-estimate panel (2026-07-24) ──────────────────────────────────────
// Turns the valuation's "missing info" list (the details the appraiser said
// would tighten the estimate — square footage, bedrooms, trim, mileage…) into
// an actionable inline form INSIDE the asset profile: each missing item maps
// to a real profile field, saves onto the profile, and can immediately re-run
// the estimate. Before this, the list was plain text the user had to act on by
// hunting for the right field name themselves (user request: home valuation
// range too wide because sqft/beds/baths were missing).
import { useMemo, useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RefreshCw, Sparkles } from "lucide-react";

/** Map a free-text missing-info item to a canonical field key + input type.
 * Falls back to a camelCase slug of the label so nothing is ever unmappable. */
const FIELD_SPECS: Array<{ re: RegExp; key: string; label: string; type: "number" | "text"; placeholder?: string }> = [
  { re: /square\s*foot|sq\.?\s*ft|sqft|interior size|floor area/i, key: "sqft", label: "Square footage", type: "number", placeholder: "e.g. 2400" },
  { re: /bedroom/i, key: "bedrooms", label: "Bedrooms", type: "number", placeholder: "e.g. 4" },
  { re: /bath/i, key: "bathrooms", label: "Bathrooms", type: "number", placeholder: "e.g. 3" },
  { re: /lot size|acreage|land size/i, key: "lotSize", label: "Lot size", type: "text", placeholder: "e.g. 0.3 acres" },
  { re: /waterfront|water access/i, key: "waterfront", label: "Waterfront / water access", type: "text", placeholder: "e.g. canal-front with dock" },
  { re: /year built/i, key: "yearBuilt", label: "Year built", type: "number", placeholder: "e.g. 1998" },
  { re: /renovation|remodel|upgrade history/i, key: "renovations", label: "Renovations / upgrades", type: "text", placeholder: "e.g. kitchen remodel 2024" },
  { re: /condition/i, key: "condition", label: "Condition", type: "text", placeholder: "e.g. excellent / good / fair" },
  { re: /trim/i, key: "trim", label: "Trim level", type: "text", placeholder: "e.g. EX-L" },
  { re: /mileage|odometer/i, key: "mileage", label: "Mileage", type: "number", placeholder: "e.g. 42000" },
  { re: /\bvin\b/i, key: "vin", label: "VIN", type: "text" },
  { re: /\byear\b/i, key: "year", label: "Year", type: "number", placeholder: "e.g. 2021" },
  { re: /listing status|sale status|recent sale/i, key: "listingStatus", label: "Listing / sale status", type: "text", placeholder: "e.g. not for sale" },
];

function slugKey(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9]+/g, " ").trim().toLowerCase();
  if (!cleaned) return "";
  return cleaned.split(" ").slice(0, 4).map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join("");
}

export interface MissingFieldSpec { key: string; label: string; type: "number" | "text"; placeholder?: string; original: string }

/** Exported for tests: resolve missing-info strings to field specs, skipping
 * items whose target field already holds a value and de-duping by key. */
export function resolveMissingFields(missingInfo: string[], fields: Record<string, any>): MissingFieldSpec[] {
  const out: MissingFieldSpec[] = [];
  const seen = new Set<string>();
  for (const raw of missingInfo || []) {
    const item = String(raw || "").trim();
    if (!item) continue;
    const spec = FIELD_SPECS.find(s => s.re.test(item));
    const key = spec?.key || slugKey(item);
    if (!key || seen.has(key)) continue;
    const existing = fields?.[key];
    if (existing !== undefined && existing !== null && String(existing).trim() !== "") continue;
    seen.add(key);
    out.push({
      key,
      label: spec?.label || item.replace(/^./, c => c.toUpperCase()),
      type: spec?.type || "text",
      placeholder: spec?.placeholder,
      original: item,
    });
    if (out.length >= 6) break;
  }
  return out;
}

export function ImproveEstimatePanel({ profileId, fields, missingInfo, onSaved, onReestimate, reestimating }: {
  profileId: string;
  fields: Record<string, any>;
  missingInfo: string[];
  /** Called after fields save so the parent can refetch the profile. */
  onSaved: () => void;
  /** When provided, saving offers "Save & re-estimate" which triggers this. */
  onReestimate?: () => void;
  reestimating?: boolean;
}) {
  const { toast } = useToast();
  const specs = useMemo(() => resolveMissingFields(missingInfo, fields), [missingInfo, fields]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  if (specs.length === 0) return null;

  const filled = specs.filter(s => (values[s.key] || "").trim() !== "");

  const save = async (thenReestimate: boolean) => {
    if (filled.length === 0) return;
    setSaving(true);
    try {
      const patch: Record<string, any> = {};
      for (const s of filled) {
        const raw = values[s.key].trim();
        const num = Number(raw.replace(/[,$]/g, ""));
        patch[s.key] = s.type === "number" && Number.isFinite(num) ? num : raw;
      }
      // Server-side updateProfile MERGES fields, so send only the new ones.
      await apiRequest("PATCH", `/api/profiles/${profileId}`, { fields: patch });
      toast({ title: `Saved ${filled.length} detail${filled.length === 1 ? "" : "s"}`, description: thenReestimate ? "Re-running the estimate with the new details…" : "They'll be used on the next estimate." });
      setValues({});
      onSaved();
      if (thenReestimate && onReestimate) onReestimate();
    } catch (e: any) {
      toast({ title: "Couldn't save details", description: e?.message || "Try again", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2.5 space-y-2" data-testid="improve-estimate-panel">
      <div className="flex items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 text-amber-500 shrink-0" />
        <p className="text-xs font-semibold">Tighten this estimate</p>
        <p className="text-[10px] text-muted-foreground ml-auto">fills real profile fields</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {specs.map(s => (
          <div key={s.key} className="space-y-0.5">
            <label className="text-[10px] font-medium text-muted-foreground" title={s.original}>{s.label}</label>
            <Input
              className="h-7 text-xs"
              type={s.type === "number" ? "text" : "text"}
              inputMode={s.type === "number" ? "decimal" : undefined}
              placeholder={s.placeholder || s.original}
              value={values[s.key] || ""}
              onChange={e => setValues(v => ({ ...v, [s.key]: e.target.value }))}
              data-testid={`improve-field-${s.key}`}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-1.5 pt-0.5">
        <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={filled.length === 0 || saving} onClick={() => save(false)} data-testid="improve-save">
          {saving ? "Saving…" : "Save"}
        </Button>
        {onReestimate && (
          <Button size="sm" className="h-7 text-xs" disabled={filled.length === 0 || saving || reestimating} onClick={() => save(true)} data-testid="improve-save-reestimate">
            {reestimating ? <RefreshCw className="h-3 w-3 animate-spin mr-1" /> : null}
            Save &amp; re-estimate
          </Button>
        )}
      </div>
    </div>
  );
}
