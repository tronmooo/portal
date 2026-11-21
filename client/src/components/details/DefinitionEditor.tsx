// ── Edit a characteristic: name, type, options, scope, constraints, rules ──
// Renaming an option in place (same position in the list) carries every
// record's value with it (server: renameOptions). Rules are checked against the
// type on the server too — this form only offers the comparisons that make
// sense for the type (opsForKind).
import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DetailInput } from "./DetailInput";
import { detailErrorMessage, saveDefinition } from "@/lib/record-details";
import {
  DEFAULT_CONDITION_SCALE, DETAIL_KINDS, DETAIL_KIND_LABELS, DETAIL_OP_LABELS, DETAIL_SEVERITIES,
  opNeedsOperand, opsForKind, scopeLabel,
  type DetailDefinition, type DetailKind, type DetailOp, type DetailRule, type DetailSeverity,
} from "@shared/record-details";

/** Scopes offered in the "applies to" picker. Record-specific types (a
 *  document's "contract") stay on a definition once set, and show too. */
export const SCOPE_CHOICES = [
  "*", "asset", "vehicle", "property", "investment", "account", "liability", "loan", "subscription",
  "person", "pet", "document", "obligation", "task", "event", "tracker", "habit", "goal", "expense", "artifact",
];

type DraftRule = { id: string; op: DetailOp; value: unknown; severity: DetailSeverity; message: string };

export function DefinitionEditor({
  open, onOpenChange, definition, onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create a new characteristic. */
  definition: DetailDefinition | null;
  onSaved?: (def: DetailDefinition) => void;
}) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<DetailKind>("text");
  const [optionsText, setOptionsText] = useState("");
  const [unit, setUnit] = useState("");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [scaleMax, setScaleMax] = useState("5");
  const [required, setRequired] = useState(false);
  const [appliesTo, setAppliesTo] = useState<string[]>(["*"]);
  const [description, setDescription] = useState("");
  const [rules, setRules] = useState<DraftRule[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const d = definition;
    setLabel(d?.label || "");
    setKind(d?.kind || "text");
    setOptionsText((d?.options || []).join("\n"));
    setUnit(d?.unit || "");
    setMin(d?.min !== undefined ? String(d.min) : "");
    setMax(d?.max !== undefined ? String(d.max) : "");
    setScaleMax(String(d?.scaleMax ?? 5));
    setRequired(!!d?.required);
    setAppliesTo(d?.appliesTo?.length ? d.appliesTo : ["*"]);
    setDescription(d?.description || "");
    setRules((d?.rules || []).map((r) => ({ id: r.id, op: r.op, value: r.value ?? "", severity: r.severity, message: r.message || "" })));
    setError(null);
    setSaving(false);
  }, [open, definition]);

  const options = useMemo(() => optionsText.split("\n").map((s) => s.trim()).filter(Boolean), [optionsText]);
  const needsOptions = kind === "select" || kind === "multiselect" || kind === "condition";
  const numeric = ["number", "currency", "percent", "rating"].includes(kind);

  // The definition as it would be saved — what rule operands are entered against.
  const preview: DetailDefinition = {
    id: definition?.id || "draft",
    label: label || "Value",
    kind,
    ...(needsOptions ? { options: options.length ? options : kind === "condition" ? [...DEFAULT_CONDITION_SCALE] : [] } : {}),
    ...(kind === "number" && unit ? { unit } : {}),
    ...(kind === "rating" ? { scaleMax: Number(scaleMax) || 5 } : {}),
    appliesTo,
    createdAt: "",
    updatedAt: "",
  };

  const scopeOptions = useMemo(() => [...new Set([...SCOPE_CHOICES, ...appliesTo])], [appliesTo]);

  const toggleScope = (s: string) => {
    if (s === "*") { setAppliesTo(["*"]); return; }
    const without = appliesTo.filter((x) => x !== "*" && x !== s);
    setAppliesTo(appliesTo.includes(s) ? (without.length ? without : ["*"]) : [...without, s]);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const input: Record<string, unknown> = {
        label: label.trim(),
        kind,
        appliesTo,
        required,
        description: description.trim(),
        rules: rules.map((r) => ({
          id: r.id, op: r.op, severity: r.severity,
          ...(opNeedsOperand(r.op) ? { value: r.value } : {}),
          ...(r.message.trim() ? { message: r.message.trim() } : {}),
        })),
      };
      if (needsOptions) input.options = preview.options;
      if (kind === "number") input.unit = unit.trim();
      if (numeric) { input.min = min.trim() === "" ? null : min; input.max = max.trim() === "" ? null : max; }
      if (kind === "rating") input.scaleMax = Number(scaleMax);
      // An option renamed in place (same slot) carries its records with it.
      const old = definition?.options || [];
      if (definition && needsOptions && old.length === options.length) {
        const renames: Record<string, string> = {};
        old.forEach((o, i) => { if (options[i] && options[i] !== o && !old.includes(options[i])) renames[o] = options[i]; });
        if (Object.keys(renames).length) input.renameOptions = renames;
      }
      const saved = await saveDefinition(definition?.id ?? null, input);
      onSaved?.(saved);
      onOpenChange(false);
    } catch (err) {
      setError(detailErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const updateRule = (i: number, patch: Partial<DraftRule>) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90dvh] overflow-y-auto" data-testid="definition-editor">
        <DialogHeader>
          <DialogTitle>{definition ? `Edit ${definition.label}` : "New characteristic"}</DialogTitle>
          <DialogDescription>One definition, used on every record it applies to.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="micro-label text-muted-foreground" htmlFor="def-label">Name</label>
              <Input id="def-label" value={label} onChange={(e) => setLabel(e.target.value)} className="h-8 text-xs" maxLength={60} data-testid="def-label" />
            </div>
            <div className="space-y-1.5">
              <span className="micro-label text-muted-foreground">Type</span>
              <Select value={kind} onValueChange={(v) => {
                setKind(v as DetailKind);
                setRules([]);
                if (v === "condition" && options.length === 0) setOptionsText(DEFAULT_CONDITION_SCALE.join("\n"));
              }}>
                <SelectTrigger className="h-8 text-xs" aria-label="Type" data-testid="def-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DETAIL_KINDS.map((k) => <SelectItem key={k} value={k} className="text-xs">{DETAIL_KIND_LABELS[k]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          {needsOptions && (
            <div className="space-y-1.5">
              <label className="micro-label text-muted-foreground" htmlFor="def-options">
                {kind === "condition" ? "Scale, best to worst (one per line)" : "Options (one per line)"}
              </label>
              <Textarea id="def-options" rows={4} value={optionsText} onChange={(e) => setOptionsText(e.target.value)} className="text-xs" data-testid="def-options" />
              {definition && <p className="text-[11px] text-muted-foreground">Renaming an option in place updates every record that uses it.</p>}
            </div>
          )}

          {(numeric || kind === "number") && (
            <div className="grid grid-cols-3 gap-2">
              {kind === "number" && (
                <div className="space-y-1.5">
                  <label className="micro-label text-muted-foreground" htmlFor="def-unit">Unit</label>
                  <Input id="def-unit" value={unit} onChange={(e) => setUnit(e.target.value)} className="h-8 text-xs" maxLength={16} />
                </div>
              )}
              {kind === "rating" ? (
                <div className="space-y-1.5">
                  <label className="micro-label text-muted-foreground" htmlFor="def-scale">Out of</label>
                  <Input id="def-scale" inputMode="numeric" value={scaleMax} onChange={(e) => setScaleMax(e.target.value)} className="h-8 text-xs" />
                </div>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <label className="micro-label text-muted-foreground" htmlFor="def-min">Min</label>
                    <Input id="def-min" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} className="h-8 text-xs" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="micro-label text-muted-foreground" htmlFor="def-max">Max</label>
                    <Input id="def-max" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} className="h-8 text-xs" />
                  </div>
                </>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <span className="micro-label text-muted-foreground">Applies to</span>
            <div className="flex flex-wrap gap-1" data-testid="def-scope">
              {scopeOptions.map((s) => {
                const on = appliesTo.includes(s);
                return (
                  <button key={s} type="button" aria-pressed={on} onClick={() => toggleScope(s)}
                    className={`h-6 rounded-full border px-2 text-[11px] ${on ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted"}`}
                    data-testid={`def-scope-${s === "*" ? "all" : s}`}>
                    {scopeLabel(s)}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2">
            <span className="text-xs">
              <span className="font-medium">Required</span>
              <span className="block text-[11px] text-muted-foreground">Flag records it applies to that don't have it yet</span>
            </span>
            <Switch checked={required} onCheckedChange={setRequired} data-testid="def-required" />
          </label>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="micro-label text-muted-foreground">Rules</span>
              <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 text-xs"
                disabled={rules.length >= 10}
                onClick={() => setRules((rs) => [...rs, { id: `r${Date.now().toString(36)}`, op: opsForKind(kind)[0], value: "", severity: "warning", message: "" }])}
                data-testid="def-add-rule">
                <Plus className="h-3.5 w-3.5" /> Add rule
              </Button>
            </div>
            {rules.length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                A rule raises a flag from the value — e.g. “Condition is at or worse than Fair → warning”, or “Renewal date is within 30 days”.
              </p>
            )}
            {rules.map((r, i) => (
              <div key={r.id} className="rounded-md border border-border/60 p-2 space-y-2" data-testid={`def-rule-${i}`}>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground shrink-0">When {label || "value"}</span>
                  <Select value={r.op} onValueChange={(v) => updateRule(i, { op: v as DetailOp, value: "" })}>
                    <SelectTrigger className="h-7 text-xs flex-1" aria-label="Comparison"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {opsForKind(kind).map((op) => <SelectItem key={op} value={op} className="text-xs">{DETAIL_OP_LABELS[op]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <button type="button" onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))} className="p-1 text-muted-foreground hover:text-destructive" aria-label="Remove rule">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                {opNeedsOperand(r.op) && (
                  r.op === "within_days" ? (
                    <Input inputMode="numeric" placeholder="Days" value={String(r.value ?? "")} onChange={(e) => updateRule(i, { value: e.target.value })} className="h-7 text-xs" />
                  ) : r.op === "any_of" ? (
                    <DetailInput
                      definition={{ ...preview, kind: "multiselect" }}
                      value={Array.isArray(r.value) ? r.value as string[] : []}
                      onChange={(v) => updateRule(i, { value: v })}
                      testId={`def-rule-${i}-value`}
                    />
                  ) : r.op === "contains" && kind !== "multiselect" ? (
                    <Input placeholder="Text" value={String(r.value ?? "")} onChange={(e) => updateRule(i, { value: e.target.value })} className="h-7 text-xs" />
                  ) : (
                    <DetailInput
                      definition={kind === "multiselect" ? { ...preview, kind: "select" } : preview}
                      value={(r.value === "" ? null : r.value) as any}
                      onChange={(v) => updateRule(i, { value: v })}
                      testId={`def-rule-${i}-value`}
                    />
                  )
                )}
                <div className="flex items-center gap-1.5">
                  <Select value={r.severity} onValueChange={(v) => updateRule(i, { severity: v as DetailSeverity })}>
                    <SelectTrigger className="h-7 text-xs w-28" aria-label="Severity"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {DETAIL_SEVERITIES.map((s) => <SelectItem key={s} value={s} className="text-xs capitalize">{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input placeholder="Message (optional)" value={r.message} onChange={(e) => updateRule(i, { message: e.target.value })} className="h-7 text-xs flex-1" maxLength={200} />
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-1.5">
            <label className="micro-label text-muted-foreground" htmlFor="def-desc">Description (optional)</label>
            <Input id="def-desc" value={description} onChange={(e) => setDescription(e.target.value)} className="h-8 text-xs" maxLength={280} />
          </div>

          {error && <p className="text-xs text-destructive" role="alert" data-testid="def-error">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Close</Button>
          <Button onClick={save} disabled={saving || !label.trim()} data-testid="def-save">
            {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            {definition ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type { DetailRule };
