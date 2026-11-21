// ── One input per value type ─────────────────────────────────────────────────
// The editor for a characteristic's value, chosen by the definition's kind
// (shared/record-details): a condition is a row of scale buttons, a rating is
// stars, yes/no is two pills, a dropdown is a Select, a date is a date picker.
// Free text never stands in for a structured type.
//
// `onChange` fires on every edit (the add dialog keeps a draft); `onCommit`
// fires when an edit is finished — at once for a tap, on blur/Enter for typed
// text — which is when the record panel saves.
import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { optionsFor, ratingMax, type DetailDefinition, type DetailValue } from "@shared/record-details";

export interface DetailInputProps {
  definition: Pick<DetailDefinition, "id" | "label" | "kind" | "options" | "unit" | "scaleMax">;
  value: DetailValue | null | undefined;
  onChange?: (raw: DetailValue | string) => void;
  onCommit?: (raw: DetailValue | string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  testId?: string;
}

/** The text shown in a typed input for a stored value. */
function asText(value: DetailValue | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

const PILL = "h-7 rounded-full border px-2.5 text-xs font-medium transition-colors disabled:opacity-50";
const PILL_ON = "border-primary bg-primary text-primary-foreground";
const PILL_OFF = "border-border bg-background text-foreground hover:bg-muted";

export function DetailInput({ definition: def, value, onChange, onCommit, disabled, autoFocus, testId }: DetailInputProps) {
  const tid = testId || `detail-input-${def.id}`;
  const pick = (v: DetailValue) => { onChange?.(v); onCommit?.(v); };

  if (def.kind === "condition" || (def.kind === "select" && optionsFor(def).length <= 6)) {
    const options = optionsFor(def);
    return (
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={def.label} data-testid={tid}>
        {options.map((o) => (
          <button
            key={o} type="button" role="radio" aria-checked={value === o} disabled={disabled}
            className={`${PILL} ${value === o ? PILL_ON : PILL_OFF}`}
            onClick={() => pick(o)}
            data-testid={`${tid}-${o}`}
          >{o}</button>
        ))}
      </div>
    );
  }

  if (def.kind === "select") {
    const options = optionsFor(def);
    return (
      <Select value={typeof value === "string" ? value : undefined} onValueChange={(v) => pick(v)} disabled={disabled}>
        <SelectTrigger className="h-8 text-xs" aria-label={def.label} data-testid={tid}>
          <SelectValue placeholder={`Choose ${def.label.toLowerCase()}`} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => <SelectItem key={o} value={o} className="text-xs">{o}</SelectItem>)}
        </SelectContent>
      </Select>
    );
  }

  if (def.kind === "multiselect") {
    const options = optionsFor(def);
    const chosen = Array.isArray(value) ? value : [];
    return (
      <div className="flex flex-wrap gap-1" role="group" aria-label={def.label} data-testid={tid}>
        {options.map((o) => {
          const on = chosen.includes(o);
          return (
            <button
              key={o} type="button" aria-pressed={on} disabled={disabled}
              className={`${PILL} ${on ? PILL_ON : PILL_OFF}`}
              onClick={() => {
                const next = on ? chosen.filter((x) => x !== o) : options.filter((x) => x === o || chosen.includes(x));
                if (next.length > 0) pick(next); else { onChange?.([]); }
              }}
              data-testid={`${tid}-${o}`}
            >{o}</button>
          );
        })}
      </div>
    );
  }

  if (def.kind === "boolean") {
    return (
      <div className="flex gap-1" role="radiogroup" aria-label={def.label} data-testid={tid}>
        {[true, false].map((b) => (
          <button
            key={String(b)} type="button" role="radio" aria-checked={value === b} disabled={disabled}
            className={`${PILL} ${value === b ? PILL_ON : PILL_OFF}`}
            onClick={() => pick(b)}
            data-testid={`${tid}-${b ? "yes" : "no"}`}
          >{b ? "Yes" : "No"}</button>
        ))}
      </div>
    );
  }

  if (def.kind === "rating") {
    const max = ratingMax(def);
    const current = typeof value === "number" ? value : 0;
    return (
      <div className="flex items-center gap-0.5" role="radiogroup" aria-label={def.label} data-testid={tid}>
        {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
          <button
            key={n} type="button" role="radio" aria-checked={current === n} aria-label={`${n} of ${max}`} disabled={disabled}
            className="p-0.5 rounded hover:bg-muted disabled:opacity-50"
            onClick={() => pick(n)}
            data-testid={`${tid}-${n}`}
          >
            <Star className={`h-4 w-4 ${n <= current ? "fill-amber-400 text-amber-400" : "text-muted-foreground"}`} />
          </button>
        ))}
      </div>
    );
  }

  return <TypedInput def={def} value={value} onChange={onChange} onCommit={onCommit} disabled={disabled} autoFocus={autoFocus} tid={tid} />;
}

/** Text, long text, number, money, percent, date and link: typed, saved when finished. */
function TypedInput({ def, value, onChange, onCommit, disabled, autoFocus, tid }: {
  def: DetailInputProps["definition"]; value: DetailValue | null | undefined;
  onChange?: (raw: string) => void; onCommit?: (raw: string) => void;
  disabled?: boolean; autoFocus?: boolean; tid: string;
}) {
  const [text, setText] = useState(asText(value));
  // A value saved elsewhere (another device, the chat) replaces the text —
  // but never while the user is mid-edit with a different draft.
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(asText(value)); }, [value, focused]);

  const commit = () => {
    setFocused(false);
    if (text.trim() === asText(value).trim()) return;
    onCommit?.(text);
  };
  const common = {
    value: text,
    disabled,
    autoFocus,
    "aria-label": def.label,
    "data-testid": tid,
    onFocus: () => setFocused(true),
    onBlur: commit,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setText(e.target.value); onChange?.(e.target.value); },
  };

  if (def.kind === "longtext") {
    return <Textarea {...common} rows={3} className="text-xs min-h-[64px]" placeholder={def.label} />;
  }
  const typeAttrs: Record<string, any> = def.kind === "date"
    ? { type: "date" }
    : def.kind === "url"
      ? { type: "url", inputMode: "url", placeholder: "https://…" }
      : ["number", "currency", "percent"].includes(def.kind)
        ? { inputMode: "decimal", placeholder: def.kind === "currency" ? "0.00" : def.kind === "percent" ? "0%" : def.unit ? `0 ${def.unit}` : "0" }
        : { placeholder: def.label };
  return (
    <div className="flex items-center gap-1.5">
      {def.kind === "currency" && <span className="text-xs text-muted-foreground">$</span>}
      <Input
        {...common}
        {...typeAttrs}
        className="h-8 text-xs"
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
      />
      {def.kind === "percent" && <span className="text-xs text-muted-foreground">%</span>}
      {def.kind === "number" && def.unit && <span className="text-xs text-muted-foreground whitespace-nowrap">{def.unit}</span>}
    </div>
  );
}
