// One proposed action, with the three decisions the user always gets:
// Keep · Change destination · Don't save.
//
// Three states, not a checkbox: "off" and "somewhere else" are different
// answers, and collapsing them into one tick is what made the old pane feel
// like it was refusing to be corrected rather than asking.
//
// The evidence — the raw extracted rows the action was inferred from — is one
// click away underneath. That is what makes a claim like "these five fields are
// one yearly bill" checkable instead of something to be taken on faith.

import { useState } from "react";
import { ChevronRight, AlertTriangle, Info, Ban } from "lucide-react";
import {
  DESTINATION_LABEL, type ExtractionDestination, type ExtractionItem,
} from "@shared/extraction-destinations";
import { OPERATION_LABEL, type ProposedAction } from "@shared/extraction-actions";

export interface ActionRowProps {
  action: ProposedAction;
  /** The raw rows this action cites, for the evidence drawer. */
  evidence: ExtractionItem[];
  onToggle: (id: string) => void;
  onDestinationChange: (id: string, destination: ExtractionDestination) => void;
  onValueChange: (itemId: string, value: string) => void;
}

function targetText(a: ProposedAction): string {
  const t = a.target;
  if (!t?.name) return "";
  const kind = t.profileType
    ? t.profileType.charAt(0).toUpperCase() + t.profileType.slice(1)
    : "";
  const base = kind ? `${kind}: ${t.name}` : t.name;
  return t.group ? `${base} · ${t.group}` : base;
}

export function ActionRow({
  action, evidence, onToggle, onDestinationChange, onValueChange,
}: ActionRowProps) {
  const [open, setOpen] = useState(false);
  const blocking = action.warnings.filter((w) => w.blocking);
  const advisory = action.warnings.filter((w) => !w.blocking);
  const isReference = action.operation === "NO_ACTION";
  // An inferred consequence with nowhere to go. It is shown, with its reason,
  // and Save is off — because "this is a refund and this app has no refund
  // record" is real information, and quietly filing it as income instead would
  // be a lie the user only discovers later.
  const unsavable = action.savable === false;

  return (
    <div
      className={`px-2.5 py-1.5 ${action.selected || isReference ? "" : "opacity-50"}`}
      data-testid={`action-${action.id}`}
    >
      <div className="flex items-start gap-2">
        {/* Keep / Don't save. A reference row has nothing to turn off — it is
            already the decision to write nothing — and neither does a row with
            no save destination. */}
        {unsavable && (
          <Ban
            className="h-3.5 w-3.5 mt-1 shrink-0 text-muted-foreground"
            aria-label="Cannot be saved"
          />
        )}
        {!isReference && !unsavable && (
          <button
            type="button"
            role="switch"
            aria-checked={action.selected}
            aria-label={action.selected ? "Don't save this" : "Save this"}
            onClick={() => onToggle(action.id)}
            className={`mt-0.5 h-4 w-7 shrink-0 rounded-full transition-colors ${
              action.selected ? "bg-primary" : "bg-muted-foreground/30"
            }`}
            data-testid={`action-toggle-${action.id}`}
          >
            <span
              className={`block h-3 w-3 rounded-full bg-background transition-transform ${
                action.selected ? "translate-x-3.5" : "translate-x-0.5"
              }`}
            />
          </button>
        )}

        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium leading-tight">
            {!isReference && !unsavable && (
              <span className="text-primary">{OPERATION_LABEL[action.operation]} </span>
            )}
            {action.title}
          </div>

          {unsavable && (
            <div
              className="text-[11px] leading-tight text-amber-700 dark:text-amber-400 mt-0.5"
              data-testid={`action-unsupported-${action.id}`}
            >
              <span className="font-medium">No save destination.</span>{" "}
              {action.unsupportedReason}
            </div>
          )}

          {/* Exactly what record changes, before Save is pressed. */}
          {action.writesLabel && !unsavable && !isReference && (
            <div
              className="text-[11px] text-muted-foreground leading-tight"
              data-testid={`action-writes-${action.id}`}
            >
              {action.writesLabel}
            </div>
          )}

          {targetText(action) && (
            <div className="text-[11px] text-muted-foreground leading-tight" data-testid={`action-target-${action.id}`}>
              → {targetText(action)}
            </div>
          )}
          {action.detail && (
            <div className="text-[11px] text-muted-foreground leading-tight">{action.detail}</div>
          )}

          {blocking.map((w, i) => (
            <div
              key={`b${i}`}
              className="flex items-start gap-1 text-[11px] leading-tight text-amber-700 dark:text-amber-400 mt-0.5"
              data-testid={`action-warning-${action.id}`}
            >
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
              <span>{w.message}</span>
            </div>
          ))}
          {advisory.map((w, i) => (
            <div
              key={`a${i}`}
              className="flex items-start gap-1 text-[11px] leading-tight text-muted-foreground mt-0.5"
            >
              <Info className="h-3 w-3 mt-0.5 shrink-0" />
              <span>{w.message}</span>
            </div>
          ))}

          {evidence.length > 0 && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground mt-0.5"
              data-testid={`action-evidence-toggle-${action.id}`}
            >
              <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />
              {open ? "Hide" : "Show"} the {evidence.length} field{evidence.length === 1 ? "" : "s"} this came from
            </button>
          )}

          {open && (
            <div className="mt-1 ml-3 space-y-0.5 border-l border-border/60 pl-2" data-testid={`action-evidence-${action.id}`}>
              {evidence.map((row) => (
                <div key={row.id} className="flex items-baseline gap-1.5">
                  <span className="text-[11px] text-muted-foreground shrink-0 min-w-0 truncate max-w-[45%]">
                    {row.label}
                  </span>
                  <input
                    type="text"
                    className="flex-1 min-w-0 bg-transparent text-[11px] text-foreground border-b border-dashed border-border/60 focus:outline-none focus:border-primary focus:bg-primary/5 px-0.5"
                    value={
                      typeof row.value === "object" && row.value !== null
                        ? JSON.stringify(row.value)
                        : String(row.value ?? "")
                    }
                    onChange={(e) => onValueChange(row.id, e.target.value)}
                    data-testid={`action-evidence-value-${row.id}`}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Change destination. */}
        {action.destinationOptions.length > 1 && !unsavable && (
          <select
            className="text-[11px] bg-background border border-border rounded px-1 py-0.5 text-foreground max-w-[130px] shrink-0 mt-0.5"
            value={action.destination}
            onChange={(e) => onDestinationChange(action.id, e.target.value as ExtractionDestination)}
            title="Change where this is saved"
            aria-label={`Where to save "${action.title}"`}
            data-testid={`action-destination-${action.id}`}
          >
            {action.destinationOptions.map((d) => (
              <option key={d} value={d}>{DESTINATION_LABEL[d]}</option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
