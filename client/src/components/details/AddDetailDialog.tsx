// ── "Add detail" — name a characteristic, pick its type, give its value ─────
// Typing a name that already exists REUSES that characteristic (one
// "Condition" across the car, the house and the guitar) — its type is fixed
// and the dialog says so. A new name asks for a type; a dropdown or
// condition scale asks for its options; and where it applies (this kind of
// record, its family, or everything). The value is entered with the type's own
// input, never as free text standing in for a structure.
import { useEffect, useMemo, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DetailInput } from "./DetailInput";
import { defineAndSetDetail, detailErrorMessage } from "@/lib/record-details";
import type { RecordDetailsPayloadShape } from "@/lib/record-details-types";
import {
  DEFAULT_CONDITION_SCALE, DETAIL_KINDS, DETAIL_KIND_LABELS, findDefinitionByLabel, labelIdentity, scopeLabel,
  type DetailDefinition, type DetailKind, type DetailTemplate, type DetailValue,
} from "@shared/record-details";

export type AddDetailPreset =
  | { definition: DetailDefinition }
  | { template: DetailTemplate }
  | null;

const FAMILIES = ["asset", "liability", "person"];

const KIND_HINTS: Record<DetailKind, string> = {
  text: "A short word or phrase",
  longtext: "A paragraph",
  number: "A count or measurement",
  currency: "An amount of money",
  percent: "A percentage",
  date: "A calendar day",
  boolean: "Yes or no",
  select: "One choice from a list",
  multiselect: "Several choices from a list",
  condition: "Excellent → Poor scale",
  rating: "Stars, 1 to 5",
  url: "A web link",
};

export function AddDetailDialog({
  open, onOpenChange, payload, definitions, preset, onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payload: RecordDetailsPayloadShape;
  definitions: DetailDefinition[];
  preset: AddDetailPreset;
  onSaved?: (label: string, created: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<DetailKind>("text");
  const [optionsText, setOptionsText] = useState("");
  const [unit, setUnit] = useState("");
  const [scope, setScope] = useState(payload.defaultScope);
  const [value, setValue] = useState<DetailValue | string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset whenever the dialog opens, from the preset if there is one.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);
    setValue(null);
    setScope(payload.defaultScope);
    if (preset && "definition" in preset) {
      setName(preset.definition.label);
    } else if (preset && "template" in preset) {
      const t = preset.template;
      setName(t.label);
      setKind(t.kind);
      setOptionsText((t.options || (t.kind === "condition" ? [...DEFAULT_CONDITION_SCALE] : [])).join("\n"));
      setUnit(t.unit || "");
    } else {
      setName("");
      setKind("text");
      setOptionsText("");
      setUnit("");
    }
  }, [open, preset, payload.defaultScope]);

  const existing = useMemo(() => (name.trim() ? findDefinitionByLabel(definitions, name) : undefined), [definitions, name]);

  // A template the typed name matches (when it isn't defined yet) fills in its type.
  const templateMatch = useMemo(() => {
    if (existing || !name.trim()) return undefined;
    return payload.suggestions.find((t) => labelIdentity(t.label) === labelIdentity(name));
  }, [existing, name, payload.suggestions]);

  const options = useMemo(() => optionsText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean), [optionsText]);
  const needsOptions = kind === "select" || kind === "multiselect" || kind === "condition";

  // The definition the value input is built from: the existing one, or the draft.
  const draft: DetailDefinition = existing || {
    id: "draft",
    label: name.trim() || "Value",
    kind,
    ...(needsOptions ? { options: options.length ? options : kind === "condition" ? [...DEFAULT_CONDITION_SCALE] : [] } : {}),
    ...(kind === "number" && unit.trim() ? { unit: unit.trim() } : {}),
    ...(kind === "rating" ? { scaleMax: templateMatch?.scaleMax || 5 } : {}),
    appliesTo: [scope],
    createdAt: "",
    updatedAt: "",
  };

  const scopeChoices = useMemo(() => {
    const out = [payload.defaultScope];
    for (const f of FAMILIES) if (payload.scopeTokens.includes(f) && !out.includes(f)) out.push(f);
    out.push("*");
    return out;
  }, [payload.defaultScope, payload.scopeTokens]);

  // Quick picks under the name: what this record could carry, then the library.
  const quickPicks = useMemo(() => {
    const q = labelIdentity(name);
    const defs = definitions
      .filter((d) => !payload.rows.some((r) => r.definition.id === d.id))
      .filter((d) => !q || labelIdentity(d.label).includes(q))
      .sort((a, b) => Number(payload.available.some((x) => x.id === b.id)) - Number(payload.available.some((x) => x.id === a.id)))
      .slice(0, 8);
    const templates = payload.suggestions.filter((t) => !q || labelIdentity(t.label).includes(q)).slice(0, 6);
    return { defs, templates };
  }, [name, definitions, payload]);

  const hasValue = value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);
  const canSave = !!name.trim() && hasValue && !saving && (existing || !needsOptions || kind === "condition" || options.length > 0);

  const applyTemplate = (t: DetailTemplate) => {
    setName(t.label);
    setKind(t.kind);
    setOptionsText((t.options || (t.kind === "condition" ? [...DEFAULT_CONDITION_SCALE] : [])).join("\n"));
    setUnit(t.unit || "");
    setValue(null);
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const definition: Partial<DetailDefinition> & { label: string } = existing
        ? { label: existing.label }
        : {
            label: name.trim(),
            kind,
            ...(needsOptions ? { options: draft.options } : {}),
            ...(kind === "number" && unit.trim() ? { unit: unit.trim() } : {}),
            ...(kind === "rating" ? { scaleMax: draft.scaleMax } : {}),
            ...(templateMatch?.rules ? { rules: templateMatch.rules.map((r, i) => ({ ...r, id: `r${i + 1}` })) } : {}),
            appliesTo: [scope],
          };
      const res = await defineAndSetDetail(payload.entityType, payload.entityId, definition, value);
      onSaved?.(res.definition.label, res.createdDefinition);
      onOpenChange(false);
    } catch (err) {
      setError(detailErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90dvh] overflow-y-auto" data-testid="add-detail-dialog">
        <DialogHeader>
          <DialogTitle>Add a detail</DialogTitle>
          <DialogDescription>
            Record any characteristic of {payload.name} — define a new one or reuse one you already track.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="micro-label text-muted-foreground" htmlFor="detail-name">Characteristic</label>
            <Input
              id="detail-name"
              value={name}
              onChange={(e) => { setName(e.target.value); setValue(null); }}
              placeholder="Condition, Color, Roof age, Signed…"
              className="h-9 text-sm"
              autoFocus={!preset}
              maxLength={60}
              data-testid="add-detail-name"
            />
            {(quickPicks.defs.length > 0 || quickPicks.templates.length > 0) && !existing && !templateMatch && (
              <div className="flex flex-wrap gap-1 pt-1" data-testid="add-detail-quickpicks">
                {quickPicks.defs.map((d) => (
                  <button key={d.id} type="button" onClick={() => { setName(d.label); setValue(null); }}
                    className="h-6 rounded-full border border-border px-2 text-[11px] hover:bg-muted"
                    data-testid={`add-detail-pick-${d.id}`}>
                    {d.label}
                  </button>
                ))}
                {quickPicks.templates.map((t) => (
                  <button key={`t-${t.label}`} type="button" onClick={() => applyTemplate(t)}
                    className="h-6 rounded-full border border-dashed border-border px-2 text-[11px] text-muted-foreground hover:bg-muted inline-flex items-center gap-1"
                    data-testid={`add-detail-template-${labelIdentity(t.label).replace(/\s+/g, "-")}`}>
                    <Sparkles className="h-3 w-3" /> {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {existing ? (
            <p className="text-xs text-muted-foreground rounded-md bg-muted/50 px-2.5 py-2" data-testid="add-detail-existing">
              Uses your existing <span className="font-medium text-foreground">{existing.label}</span> ({DETAIL_KIND_LABELS[existing.kind].toLowerCase()}
              {existing.appliesTo.includes("*") ? ", on every record" : `, for ${existing.appliesTo.map(scopeLabel).join(", ").toLowerCase()}`}).
            </p>
          ) : name.trim() ? (
            <>
              <div className="space-y-1.5">
                <span className="micro-label text-muted-foreground">Type</span>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5" role="radiogroup" aria-label="Type" data-testid="add-detail-kinds">
                  {DETAIL_KINDS.map((k) => (
                    <button
                      key={k} type="button" role="radio" aria-checked={kind === k}
                      onClick={() => {
                        setKind(k);
                        setValue(null);
                        if (k === "condition" && options.length === 0) setOptionsText(DEFAULT_CONDITION_SCALE.join("\n"));
                      }}
                      className={`rounded-md border px-2 py-1.5 text-left transition-colors ${kind === k ? "border-primary bg-primary/10" : "border-border hover:bg-muted"}`}
                      data-testid={`add-detail-kind-${k}`}
                    >
                      <span className="block text-xs font-medium">{DETAIL_KIND_LABELS[k]}</span>
                      <span className="block text-[11px] text-muted-foreground leading-tight">{KIND_HINTS[k]}</span>
                    </button>
                  ))}
                </div>
              </div>

              {needsOptions && (
                <div className="space-y-1.5">
                  <label className="micro-label text-muted-foreground" htmlFor="detail-options">
                    {kind === "condition" ? "Scale, best to worst (one per line)" : "Options (one per line)"}
                  </label>
                  <Textarea
                    id="detail-options" rows={4} value={optionsText}
                    onChange={(e) => { setOptionsText(e.target.value); setValue(null); }}
                    className="text-xs" data-testid="add-detail-options"
                  />
                </div>
              )}

              {kind === "number" && (
                <div className="space-y-1.5">
                  <label className="micro-label text-muted-foreground" htmlFor="detail-unit">Unit (optional)</label>
                  <Input id="detail-unit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="mi, sq ft, years…" className="h-8 text-xs" maxLength={16} data-testid="add-detail-unit" />
                </div>
              )}

              <div className="space-y-1.5">
                <span className="micro-label text-muted-foreground">Applies to</span>
                <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Applies to" data-testid="add-detail-scope">
                  {scopeChoices.map((s) => (
                    <button key={s} type="button" role="radio" aria-checked={scope === s} onClick={() => setScope(s)}
                      className={`h-7 rounded-full border px-2.5 text-xs ${scope === s ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted"}`}
                      data-testid={`add-detail-scope-${s === "*" ? "all" : s}`}>
                      {scopeLabel(s)}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : null}

          {name.trim() && (!needsOptions || existing || (draft.options || []).length > 0) && (
            <div className="space-y-1.5">
              <span className="micro-label text-muted-foreground">Value</span>
              <DetailInput
                key={`${existing?.id || "draft"}-${kind}-${(draft.options || []).join("|")}`}
                definition={draft}
                value={(value ?? null) as DetailValue | null}
                onChange={(v) => setValue(v)}
                testId="add-detail-value"
              />
            </div>
          )}

          {error && <p className="text-xs text-destructive" role="alert" data-testid="add-detail-error">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Close</Button>
          <Button onClick={save} disabled={!canSave} data-testid="add-detail-save">
            {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
